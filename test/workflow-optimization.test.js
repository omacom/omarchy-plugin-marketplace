import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  catalogWriteAdmission,
  fetchCatalogWriteQueue,
  parseCatalogWriteConcurrencyResponse,
} from "../scripts/check-catalog-write-admission.mjs";
import {
  securityBaselineErrorMarker,
  securityBaselineMarkerPrefix,
} from "../scripts/security-baseline-policy.mjs";

const root = new URL("../", import.meta.url);

function workflowJob(source, name, nextName = "") {
  const start = source.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `${name} job must exist`);
  const end = nextName ? source.indexOf(`\n  ${nextName}:\n`, start + 1) : -1;
  return end > start ? source.slice(start, end) : source.slice(start);
}

function workflowStep(source, name) {
  const stepMarker = `      - name: ${name}\n`;
  const stepStart = source.indexOf(stepMarker);
  assert.ok(stepStart >= 0, `${name} step must exist`);
  const searchStart = stepStart + stepMarker.length;
  const nextStep = source.indexOf("\n      - name: ", searchStart);
  const nextJobOffset = source.slice(searchStart).search(/\n  [a-z0-9-]+:\n/);
  const nextJob = nextJobOffset >= 0 ? searchStart + nextJobOffset : -1;
  const boundaries = [nextStep, nextJob].filter((boundary) => boundary >= 0);
  return source.slice(stepStart, boundaries.length > 0 ? Math.min(...boundaries) : undefined);
}

function workflowStepScript(source, name) {
  const step = workflowStep(source, name);
  const runMarker = "        run: |\n";
  const runStart = step.indexOf(runMarker);
  assert.ok(runStart >= 0, `${name} step must use a literal run block`);
  return step
    .slice(runStart + runMarker.length)
    .split("\n")
    .map((line) => line.startsWith("          ") ? line.slice(10) : line)
    .join("\n");
}

function runWorkflowScript(script, { cwd, env = {} }) {
  return spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail"], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    input: script,
  });
}

function initializeIssueMutationGuard(workflow, { cwd, env }) {
  const script = workflowStepScript(workflow, "Initialize live issue mutation guard");
  const result = runWorkflowScript(script, { cwd, env });
  assert.equal(result.status, 0, result.stderr);
}

function checksumLine(name, content) {
  const digest = createHash("sha256").update(content).digest("hex");
  return `${digest}  ${name}\n`;
}

async function createReportArtifact(directory, files) {
  await mkdir(directory, { recursive: true });
  let checksums = "";
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(directory, name), content);
    checksums += checksumLine(name, content);
  }
  await writeFile(join(directory, "SHA256SUMS"), checksums);
}

async function createIssueMutationStub(directory, issue) {
  const bin = join(directory, "bin");
  const state = join(directory, "issue.json");
  const calls = join(directory, "gh-calls.jsonl");
  await mkdir(bin);
  await writeFile(state, JSON.stringify({ ...issue, comments: [] }));
  await writeFile(join(bin, "gh"), `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.GH_CALLS, JSON.stringify(args) + "\\n");
const state = JSON.parse(readFileSync(process.env.GH_STATE, "utf8"));
if (args[0] === "api" && args.includes("--method") && args.includes("DELETE")) {
  const endpoint = args.find((arg) => arg.includes("/labels/"));
  if (endpoint) {
    const label = decodeURIComponent(endpoint.slice(endpoint.lastIndexOf("/") + 1));
    state.labels = state.labels.filter((item) => item.name !== label);
    writeFileSync(process.env.GH_STATE, JSON.stringify(state));
  }
  process.exit(0);
}
if (args[0] === "api" && args.includes("--paginate")) {
  process.exit(0);
}
if (args[0] === "api" && !args.includes("--method")) {
  process.stdout.write(JSON.stringify(state));
  process.exit(0);
}
if (args[0] === "issue" && args[1] === "edit") {
  const labelIndex = args.indexOf("--add-label");
  if (labelIndex < 0 || !args[labelIndex + 1]) process.exit(2);
  const label = args[labelIndex + 1];
  if (!state.labels.some((item) => item.name === label)) state.labels.push({ name: label });
  writeFileSync(process.env.GH_STATE, JSON.stringify(state));
  process.exit(0);
}
if (args[0] === "issue" && args[1] === "comment") {
  const bodyIndex = args.indexOf("--body-file");
  if (bodyIndex < 0) process.exit(2);
  state.comments.push(readFileSync(args[bodyIndex + 1], "utf8"));
  writeFileSync(process.env.GH_STATE, JSON.stringify(state));
  process.exit(0);
}
process.exit(2);
`);
  await chmod(join(bin, "gh"), 0o755);
  return { bin, calls, state };
}

test("validation feedback uses live per-issue routing with one global fallback", async () => {
  const workflows = [
    {
      name: "validate-submission.yml",
      analyze: "validate",
      anchor: "submission-mutation-steps",
      mutationSteps: [
        "Publish validation report",
        "Update validation labels",
        "Report validation workflow failure",
      ],
      failureSteps: [
        "Clear stale approval state after workflow failure",
        "Report validation workflow failure",
      ],
    },
    {
      name: "validate-plugin-update.yml",
      analyze: "analyze",
      anchor: "update-mutation-steps",
      mutationSteps: [
        "Publish update validation report",
        "Update plugin update labels",
        "Report plugin update workflow failure",
      ],
      failureSteps: [
        "Clear stale update approval state",
        "Report plugin update workflow failure",
      ],
    },
  ];

  for (const workflow of workflows) {
    const source = await readFile(new URL(`.github/workflows/${workflow.name}`, root), "utf8");
    const analyze = workflowJob(source, workflow.analyze, "mutation-route");
    const route = workflowJob(source, "mutation-route", "publish");
    const mutation = workflowJob(source, "publish", "publish-fallback");
    const fallback = workflowJob(source, "publish-fallback");
    assert.doesNotMatch(source, /^concurrency:/m, workflow.name);
    assert.match(
      analyze,
      /group: issue-validation-\$\{\{ github\.event\.issue\.number \}\}[\s\S]*queue: max/,
      workflow.name,
    );
    assert.doesNotMatch(source, /queue: single/, workflow.name);
    assert.doesNotMatch(source, /\n  report-failure:\n/, workflow.name);
    assert.doesNotMatch(analyze, /issues: write|gh issue edit|gh issue comment|--method PATCH/);
    assert.match(route, /permissions:\s+issues: read/);
    assert.match(route, /group=issue-validation-\$\{ISSUE_NUMBER\}/);
    assert.match(route, /group=\$\{global_group\}/);
    assert.match(route, /approved-and-verified[\s\S]*maintainer-verified/);
    assert.match(
      mutation,
      /group: \$\{\{ needs\.mutation-route\.outputs\.group == format\('issue-validation-\{0\}'[\s\S]*'plugin-catalog-writes' \}\}[\s\S]*queue: max/,
      workflow.name,
    );
    assert.match(mutation, new RegExp(`steps: &${workflow.anchor}`));
    assert.match(mutation, /requires_global_fallback/);
    assert.match(mutation, /guard-issue-mutation[\s\S]*approved-and-verified/);
    assert.match(mutation, /sha256sum --check SHA256SUMS/);
    assert.doesNotMatch(
      mutation,
      /failure\(\)/,
      `${workflow.name}: mutation failure handling must not inherit an ancestor failure`,
    );
    assert.match(mutation, /steps\.failure\.outcome == 'success'/);
    assert.match(fallback, /group: plugin-catalog-writes[\s\S]*queue: max/);
    assert.match(fallback, new RegExp(`steps: \\*${workflow.anchor}`));
    assert.match(fallback, /needs\.publish\.outputs\.requires_global_fallback/);
    assert.doesNotMatch(fallback, /actions\/checkout|setup-node|npm ci|node scripts\//);
    for (const stepName of workflow.failureSteps) {
      const step = workflowStep(mutation, stepName);
      assert.match(step, /env\.MUTATION_CONCURRENCY_GROUP == 'plugin-catalog-writes'/);
    }
    for (const stepName of workflow.mutationSteps) {
      const step = workflowStep(mutation, stepName);
      assert.match(step, /issue-mutation-helpers|require_issue_mutation/,
        `${workflow.name}: ${stepName}`);
    }
  }
});

test("live mutation routing fails closed to exactly one of two concurrency groups", async () => {
  const scenarios = [
    {
      workflow: "validate-submission.yml",
      step: "Select live validation mutation group",
      analysisEnv: { ANALYSIS_RESULT: "success" },
      title: "[Plugin]: Example",
      typeLabel: "submission",
      conflictLabel: "plugin-update",
    },
    {
      workflow: "validate-plugin-update.yml",
      step: "Select live update mutation group",
      analysisEnv: { ROUTE_RESULT: "success", ANALYSIS_RESULT: "success" },
      title: "[Verify]: Example",
      typeLabel: "plugin-update",
      conflictLabel: "submission",
    },
  ];

  for (const scenario of scenarios) {
    const workflow = await readFile(
      new URL(`.github/workflows/${scenario.workflow}`, root),
      "utf8",
    );
    const script = workflowStepScript(workflow, scenario.step);
    for (const item of [
      { name: "ordinary", labels: [scenario.typeLabel], expected: "issue-validation-42" },
      {
        name: "approved",
        labels: [scenario.typeLabel, "validated", "approved-and-verified"],
        expected: "plugin-catalog-writes",
      },
      {
        name: "review-sensitive",
        labels: [scenario.typeLabel, "maintainer-verified"],
        expected: "plugin-catalog-writes",
      },
      {
        name: "conflicting type",
        labels: [scenario.typeLabel, scenario.conflictLabel],
        expected: "plugin-catalog-writes",
      },
      {
        name: "validated and needs fixes",
        labels: [scenario.typeLabel, "validated", "needs-fixes"],
        expected: "plugin-catalog-writes",
      },
      {
        name: "conflicting security dispositions",
        labels: [
          scenario.typeLabel,
          "validated",
          "security-needs-fixes",
          "security-review-required",
        ],
        expected: "plugin-catalog-writes",
      },
      {
        name: "orphaned security needs fixes",
        labels: [scenario.typeLabel, "security-needs-fixes"],
        expected: "plugin-catalog-writes",
      },
      {
        name: "orphaned security review",
        labels: [scenario.typeLabel, "security-review-required"],
        expected: "plugin-catalog-writes",
      },
    ]) {
      const directory = await mkdtemp(join(tmpdir(), "marketplace-mutation-route-"));
      try {
        const stub = await createIssueMutationStub(directory, {
          state: "open",
          title: scenario.title,
          body: "Issue body",
          labels: item.labels.map((name) => ({ name })),
        });
        const output = join(directory, "output");
        const result = runWorkflowScript(script, {
          cwd: directory,
          env: {
            ...scenario.analysisEnv,
            GH_CALLS: stub.calls,
            GH_STATE: stub.state,
            GITHUB_OUTPUT: output,
            GITHUB_REPOSITORY: "example/marketplace",
            ISSUE_NUMBER: "42",
            PATH: `${stub.bin}:${process.env.PATH}`,
            RUNNER_TEMP: directory,
          },
        });
        assert.equal(result.status, 0, `${scenario.workflow}, ${item.name}: ${result.stderr}`);
        assert.equal(await readFile(output, "utf8"), `group=${item.expected}\n`);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }

    for (const item of [
      { name: "malformed labels", issue: { state: "open", title: scenario.title, body: "Issue body", labels: "bad" } },
      { name: "duplicate labels", issue: { state: "open", title: scenario.title, body: "Issue body", labels: [{ name: scenario.typeLabel }, { name: scenario.typeLabel }] } },
    ]) {
      const directory = await mkdtemp(join(tmpdir(), "marketplace-mutation-route-malformed-"));
      try {
        const stub = await createIssueMutationStub(directory, item.issue);
        const output = join(directory, "output");
        const result = runWorkflowScript(script, {
          cwd: directory,
          env: {
            ...scenario.analysisEnv,
            GH_CALLS: stub.calls,
            GH_STATE: stub.state,
            GITHUB_OUTPUT: output,
            GITHUB_REPOSITORY: "example/marketplace",
            ISSUE_NUMBER: "42",
            PATH: `${stub.bin}:${process.env.PATH}`,
            RUNNER_TEMP: directory,
          },
        });
        assert.equal(result.status, 0, `${scenario.workflow}, ${item.name}: ${result.stderr}`);
        assert.equal(await readFile(output, "utf8"), "group=plugin-catalog-writes\n");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
});

test("approval interleavings stop per-issue writes and replay labels globally", async () => {
  const scenarios = [
    {
      workflow: "validate-submission.yml",
      labelsStep: "Update validation labels",
      postflightStep: "Recheck issue trust state after validation mutations",
      title: "[Plugin]: Example",
      typeLabel: "submission",
      staleTrust: [],
    },
    {
      workflow: "validate-plugin-update.yml",
      labelsStep: "Update plugin update labels",
      postflightStep: "Recheck issue trust state after update mutations",
      title: "[Verify]: Example",
      typeLabel: "plugin-update",
      staleTrust: ["maintainer-verified"],
    },
  ];

  for (const scenario of scenarios) {
    const workflow = await readFile(
      new URL(`.github/workflows/${scenario.workflow}`, root),
      "utf8",
    );
    const labelsScript = workflowStepScript(workflow, scenario.labelsStep);
    const postflightScript = workflowStepScript(workflow, scenario.postflightStep);
    const directory = await mkdtemp(join(tmpdir(), "marketplace-approval-interleaving-"));
    try {
      const initialLabels = [
        scenario.typeLabel,
        "validated",
        "approved-and-verified",
        ...scenario.staleTrust,
      ];
      const stub = await createIssueMutationStub(directory, {
        state: "open",
        title: scenario.title,
        body: "Issue body",
        labels: initialLabels.map((name) => ({ name })),
      });
      const common = {
        BASELINE_DISPOSITION: "clear",
        BASELINE_RESULT: "passed",
        EXPECTED_BODY: "Issue body",
        EXPECTED_TITLE: scenario.title,
        EXPECTED_TYPE_LABEL: scenario.typeLabel,
        GH_CALLS: stub.calls,
        GH_STATE: stub.state,
        GITHUB_REPOSITORY: "example/marketplace",
        ISSUE_NUMBER: "42",
        PATH: `${stub.bin}:${process.env.PATH}`,
        RESULT: "validated",
      };

      const primary = join(directory, "primary");
      await mkdir(primary);
      const primaryEnv = {
        ...common,
        MUTATION_CONCURRENCY_GROUP: "issue-validation-42",
        RUNNER_TEMP: primary,
      };
      initializeIssueMutationGuard(workflow, { cwd: directory, env: primaryEnv });
      const deferred = runWorkflowScript(labelsScript, { cwd: directory, env: primaryEnv });
      assert.equal(deferred.status, 0, `${scenario.workflow}: ${deferred.stderr}`);
      assert.equal(await readFile(join(primary, "issue-mutation-stop"), "utf8"), "fallback\n");
      assert.deepEqual(
        JSON.parse(await readFile(stub.state, "utf8")).labels.map(({ name }) => name),
        initialLabels,
        `${scenario.workflow}: per-issue trust labels must remain untouched`,
      );

      const fallback = join(directory, "fallback");
      await mkdir(fallback);
      const fallbackEnv = {
        ...common,
        MUTATION_CONCURRENCY_GROUP: "plugin-catalog-writes",
        RUNNER_TEMP: fallback,
      };
      initializeIssueMutationGuard(workflow, { cwd: directory, env: fallbackEnv });
      const replayed = runWorkflowScript(labelsScript, { cwd: directory, env: fallbackEnv });
      assert.equal(replayed.status, 0, `${scenario.workflow}: ${replayed.stderr}`);
      assert.deepEqual(
        JSON.parse(await readFile(stub.state, "utf8")).labels.map(({ name }) => name).sort(),
        [scenario.typeLabel, "validated"].sort(),
        `${scenario.workflow}: global replay must converge idempotently`,
      );

      for (const orphanLabel of ["security-needs-fixes", "security-review-required"]) {
        const orphanDirectory = join(directory, `orphan-${orphanLabel}`);
        await mkdir(orphanDirectory);
        const orphanEnv = {
          ...common,
          MUTATION_CONCURRENCY_GROUP: "issue-validation-42",
          RUNNER_TEMP: orphanDirectory,
        };
        const orphanState = JSON.parse(await readFile(stub.state, "utf8"));
        orphanState.labels = orphanState.labels
          .filter(({ name }) => name !== "validated")
          .concat({ name: orphanLabel });
        await writeFile(stub.state, JSON.stringify(orphanState));
        initializeIssueMutationGuard(workflow, { cwd: directory, env: orphanEnv });
        const orphanPostflight = runWorkflowScript(postflightScript, {
          cwd: directory,
          env: orphanEnv,
        });
        assert.equal(orphanPostflight.status, 0, `${scenario.workflow}: ${orphanPostflight.stderr}`);
        assert.equal(
          await readFile(join(orphanDirectory, "issue-mutation-stop"), "utf8"),
          "fallback\n",
        );
        orphanState.labels = orphanState.labels
          .filter(({ name }) => name !== orphanLabel)
          .concat({ name: "validated" });
        await writeFile(stub.state, JSON.stringify(orphanState));
      }

      const ambiguous = join(directory, "ambiguous");
      await mkdir(ambiguous);
      const ambiguousEnv = {
        ...common,
        MUTATION_CONCURRENCY_GROUP: "issue-validation-42",
        RUNNER_TEMP: ambiguous,
      };
      let state = JSON.parse(await readFile(stub.state, "utf8"));
      state.labels.push({ name: "needs-fixes" });
      await writeFile(stub.state, JSON.stringify(state));
      initializeIssueMutationGuard(workflow, { cwd: directory, env: ambiguousEnv });
      const ambiguousPostflight = runWorkflowScript(postflightScript, {
        cwd: directory,
        env: ambiguousEnv,
      });
      assert.equal(ambiguousPostflight.status, 0, `${scenario.workflow}: ${ambiguousPostflight.stderr}`);
      assert.equal(await readFile(join(ambiguous, "issue-mutation-stop"), "utf8"), "fallback\n");
      state.labels = state.labels.filter(({ name }) => name !== "needs-fixes");
      await writeFile(stub.state, JSON.stringify(state));

      const afterLastGuard = join(directory, "after-last-guard");
      await mkdir(afterLastGuard);
      const afterLastGuardEnv = {
        ...common,
        MUTATION_CONCURRENCY_GROUP: "issue-validation-42",
        RUNNER_TEMP: afterLastGuard,
      };
      initializeIssueMutationGuard(workflow, { cwd: directory, env: afterLastGuardEnv });
      await writeFile(join(afterLastGuard, "issue-mutation-performed"), "");
      state = JSON.parse(await readFile(stub.state, "utf8"));
      state.labels.push({ name: "approved-and-verified" });
      await writeFile(stub.state, JSON.stringify(state));
      const postflight = runWorkflowScript(postflightScript, { cwd: directory, env: afterLastGuardEnv });
      assert.equal(postflight.status, 0, `${scenario.workflow}: ${postflight.stderr}`);
      assert.equal(
        await readFile(join(afterLastGuard, "issue-mutation-stop"), "utf8"),
        "fallback\n",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("npm dependency fetches use the bounded retry policy", async () => {
  const npmrc = await readFile(new URL(".npmrc", root), "utf8");
  assert.equal(
    npmrc,
    [
      "fetch-timeout=60000",
      "fetch-retries=2",
      "fetch-retry-mintimeout=5000",
      "fetch-retry-maxtimeout=15000",
      "",
    ].join("\n"),
  );
  const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  assert.equal(
    packageJson.scripts["check:catalog-write-admission"],
    "node scripts/check-catalog-write-admission.mjs",
  );
});

test("catalog write admission accepts only complete bounded live queue state", async () => {
  assert.deepEqual(
    parseCatalogWriteConcurrencyResponse(404, ""),
    { group: "plugin-catalog-writes", depth: 0, members: [] },
  );
  const response = (count) => JSON.stringify({
    group_name: "plugin-catalog-writes",
    total_count: count,
    group_members: Array.from({ length: count }, (_, index) => ({
      run_id: index + 1,
      run_name: `run-${index + 1}`,
      status: index === 0 ? "in_progress" : "pending",
    })),
  });
  assert.equal(catalogWriteAdmission(parseCatalogWriteConcurrencyResponse(200, response(10))).admitted, true);
  assert.equal(catalogWriteAdmission(parseCatalogWriteConcurrencyResponse(200, response(11))).admitted, false);
  for (const [name, status, body] of [
    ["server error", 500, "{}"],
    ["malformed JSON", 200, "{"],
    ["wrong group", 200, response(1).replace("plugin-catalog-writes", "other")],
    ["incomplete members", 200, JSON.stringify({ group_name: "plugin-catalog-writes", total_count: 2, group_members: [] })],
    ["unknown status", 200, response(1).replace("in_progress", "queued")],
    ["duplicate member", 200, JSON.stringify({ group_name: "plugin-catalog-writes", total_count: 2, group_members: [
      { run_id: 1, run_name: "one", status: "pending" },
      { run_id: 1, run_name: "one", status: "pending" },
    ] })],
  ]) {
    assert.throws(() => parseCatalogWriteConcurrencyResponse(status, body), undefined, name);
  }

  let declaredCancelled = false;
  const declaredOversizedStream = new ReadableStream({
    pull(controller) {
      controller.enqueue(new Uint8Array([1]));
    },
    cancel() {
      declaredCancelled = true;
    },
  });
  await assert.rejects(
    fetchCatalogWriteQueue({
      repository: "omacom/omarchy-plugin-marketplace",
      token: "token",
      fetchImpl: async () => new Response(declaredOversizedStream, {
        status: 200,
        headers: { "content-length": String(1024 * 1024 + 1) },
      }),
    }),
    /Content-Length is invalid or too large/,
  );
  assert.equal(declaredCancelled, true);

  for (const malformedLength of ["-1", "1.0", "1e3"]) {
    await assert.rejects(
      fetchCatalogWriteQueue({
        repository: "omacom/omarchy-plugin-marketplace",
        token: "token",
        fetchImpl: async () => new Response("x", {
          status: 200,
          headers: { "content-length": malformedLength },
        }),
      }),
      /Content-Length is invalid or too large/,
      malformedLength,
    );
  }

  const exactLimitBody = response(1).padEnd(1024 * 1024, " ");
  assert.equal(
    (await fetchCatalogWriteQueue({
      repository: "omacom/omarchy-plugin-marketplace",
      token: "token",
      fetchImpl: async () => new Response(exactLimitBody, {
        status: 200,
        headers: { "content-length": String(1024 * 1024) },
      }),
    })).depth,
    1,
  );
  assert.equal(
    (await fetchCatalogWriteQueue({
      repository: "omacom/omarchy-plugin-marketplace",
      token: "token",
      fetchImpl: async () => new Response(response(1), { status: 200 }),
    })).depth,
    1,
  );
  let requestedUrl = "";
  let requestedOptions;
  assert.equal(
    (await fetchCatalogWriteQueue({
      repository: "omacom/omarchy-plugin-marketplace",
      token: "token",
      fetchImpl: async (url, options) => {
        requestedUrl = url;
        requestedOptions = options;
        return new Response("", { status: 404 });
      },
    })).depth,
    0,
  );
  assert.equal(
    requestedUrl,
    "https://api.github.com/repos/omacom/omarchy-plugin-marketplace/actions/concurrency_groups/plugin-catalog-writes",
  );
  assert.equal(requestedOptions.redirect, "error");
  assert.ok(requestedOptions.signal instanceof AbortSignal);
  assert.equal(requestedOptions.headers.authorization, "Bearer token");
  for (const timeoutMilliseconds of [0, 15_001, 1.5]) {
    await assert.rejects(
      fetchCatalogWriteQueue({
        repository: "omacom/omarchy-plugin-marketplace",
        token: "token",
        timeoutMilliseconds,
      }),
      /request timeout is invalid/,
    );
  }

  let redirectedTargetRequests = 0;
  const server = createServer((request, serverResponse) => {
    if (request.url === "/redirect") {
      serverResponse.writeHead(302, { location: "/target" });
      serverResponse.end();
    } else if (request.url === "/target") {
      redirectedTargetRequests += 1;
      serverResponse.writeHead(200, { "content-type": "application/json" });
      serverResponse.end(response(1));
    } else if (request.url === "/slow") {
      // Intentionally remain silent until the bounded client aborts.
    } else {
      serverResponse.writeHead(404);
      serverResponse.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const localOrigin = `http://127.0.0.1:${address.port}`;
  try {
    await assert.rejects(
      fetchCatalogWriteQueue({
        repository: "omacom/omarchy-plugin-marketplace",
        token: "token",
        timeoutMilliseconds: 2_000,
        fetchImpl: (_url, options) => fetch(`${localOrigin}/redirect`, options),
      }),
      /fetch failed/,
    );
    assert.equal(redirectedTargetRequests, 0);
    await assert.rejects(
      fetchCatalogWriteQueue({
        repository: "omacom/omarchy-plugin-marketplace",
        token: "token",
        timeoutMilliseconds: 20,
        fetchImpl: (_url, options) => fetch(`${localOrigin}/slow`, options),
      }),
      (error) => error?.name === "TimeoutError",
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await assert.rejects(
    fetchCatalogWriteQueue({
      repository: "omacom/omarchy-plugin-marketplace",
      token: "token",
      fetchImpl: async () => new Response(new Uint8Array([0xc3, 0x28]), { status: 200 }),
    }),
    /not valid UTF-8/,
  );
  await assert.rejects(
    fetchCatalogWriteQueue({
      repository: "example/marketplace",
      token: "token",
      fetchImpl: async () => new Response("", { status: 404 }),
    }),
    /must be omacom\/omarchy-plugin-marketplace/,
  );

  let cancelled = false;
  let reads = 0;
  const oversizedStream = new ReadableStream({
    pull(controller) {
      reads += 1;
      controller.enqueue(new Uint8Array(600 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    fetchCatalogWriteQueue({
      repository: "omacom/omarchy-plugin-marketplace",
      token: "token",
      fetchImpl: async () => new Response(oversizedStream, { status: 200 }),
    }),
    /exceeds the one MiB limit/,
  );
  assert.ok(reads >= 2);
  assert.equal(cancelled, true);
});

test("refresh failures reconcile one unlabeled structured operational alert", async () => {
  const workflow = await readFile(new URL(".github/workflows/refresh-catalog.yml", root), "utf8");
  const script = workflowStepScript(workflow, "Reconcile catalog refresh failure alert");
  const directory = await mkdtemp(join(tmpdir(), "marketplace-refresh-alert-"));
  const bin = join(directory, "bin");
  const statePath = join(directory, "alerts.json");
  const callsPath = join(directory, "alert-calls.jsonl");
  await mkdir(bin);
  await writeFile(statePath, JSON.stringify({ issues: [], nextNumber: 1 }));
  await writeFile(join(bin, "gh"), `#!/usr/bin/env node
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.GH_CALLS, JSON.stringify(args) + "\\n");
const state = JSON.parse(readFileSync(process.env.GH_STATE, "utf8"));
if (args[0] !== "api") process.exit(2);
if (args.includes("--paginate")) {
  for (const issue of state.issues) {
    if (issue.state === "open" && issue.title === "Marketplace catalog refresh failure" && issue.user.login === "github-actions[bot]") {
      process.stdout.write(String(issue.number) + "\\n");
    }
  }
  process.exit(0);
}
const methodIndex = args.indexOf("--method");
const method = methodIndex >= 0 ? args[methodIndex + 1] : "GET";
const inputIndex = args.indexOf("--input");
const payload = inputIndex >= 0 ? JSON.parse(readFileSync(args[inputIndex + 1], "utf8")) : {};
const endpoint = args.find((arg) => arg.startsWith("repos/"));
if (method === "POST" && endpoint.endsWith("/issues")) {
  state.issues.push({
    number: state.nextNumber++,
    state: "open",
    title: payload.title,
    body: payload.body,
    labels: [],
    user: { login: "github-actions[bot]" },
  });
  writeFileSync(process.env.GH_STATE, JSON.stringify(state));
  process.exit(0);
}
if (method === "PATCH") {
  const number = Number(endpoint.slice(endpoint.lastIndexOf("/") + 1));
  const issue = state.issues.find((item) => item.number === number);
  if (!issue) process.exit(1);
  Object.assign(issue, payload);
  writeFileSync(process.env.GH_STATE, JSON.stringify(state));
  process.exit(0);
}
process.exit(2);
`);
  await chmod(join(bin, "gh"), 0o755);
  const run = (results) => runWorkflowScript(script, {
    cwd: directory,
    env: {
      GH_CALLS: callsPath,
      GH_STATE: statePath,
      GITHUB_REPOSITORY: "example/marketplace",
      PATH: `${bin}:${process.env.PATH}`,
      REFRESH_RESULT: results[0],
      PUBLISH_RESULT: results[1],
      DEPLOY_RESULT: results[2],
      RUNNER_TEMP: directory,
      RUN_URL: "https://github.test/actions/runs/123",
      TRIGGER_EVENT: "schedule",
    },
  });
  try {
    const first = run(["failure", "skipped", "skipped"]);
    assert.equal(first.status, 0, first.stderr);
    let state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.issues.length, 1);
    assert.equal(state.issues[0].state, "open");
    assert.deepEqual(state.issues[0].labels, []);
    assert.match(state.issues[0].body, /State: \*\*active\*\*/);
    assert.match(state.issues[0].body, /Refresh: `failure`/);

    state.issues[0].labels = [{ name: "submission" }];
    await writeFile(statePath, JSON.stringify(state));
    const second = run(["success", "failure", "skipped"]);
    assert.equal(second.status, 0, second.stderr);
    state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.issues.length, 1, "a second failure must update the same alert");
    assert.match(state.issues[0].body, /Publish: `failure`/);
    assert.deepEqual(state.issues[0].labels, []);

    const incomplete = run(["success", "skipped", "skipped"]);
    assert.equal(incomplete.status, 0, incomplete.stderr);
    state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.issues[0].state, "open");
    assert.match(state.issues[0].body, /State: \*\*active\*\*/);

    const recovered = run(["success", "success", "success"]);
    assert.equal(recovered.status, 0, recovered.stderr);
    state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.issues[0].state, "closed");
    assert.equal(state.issues[0].state_reason, "completed");
    assert.match(state.issues[0].body, /State: \*\*resolved\*\*/);
    assert.deepEqual(state.issues[0].labels, []);

    state.issues.push(
      {
        number: state.nextNumber++, state: "open", title: "Marketplace catalog refresh failure",
        body: "first duplicate", labels: [], user: { login: "github-actions[bot]" },
      },
      {
        number: state.nextNumber++, state: "open", title: "Marketplace catalog refresh failure",
        body: "second duplicate", labels: [], user: { login: "github-actions[bot]" },
      },
    );
    await writeFile(statePath, JSON.stringify(state));
    const duplicate = run(["failure", "skipped", "skipped"]);
    assert.notEqual(duplicate.status, 0);
    assert.match(duplicate.stderr, /Multiple open catalog refresh alerts exist/);
    state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.issues.filter((issue) => issue.state === "open").length, 2);

    const calls = await readFile(callsPath, "utf8");
    assert.doesNotMatch(calls, /add-label|remove-label|labels\//);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("security scan limits produce a publishable error state while other baseline failures stay hard", async () => {
  const scenarios = [
    {
      workflow: "validate-submission.yml",
      report: "security-baseline-report.md",
      json: "security-baseline.json",
    },
    {
      workflow: "validate-plugin-update.yml",
      report: "update-security-baseline-report.md",
      json: "update-security-baseline.json",
    },
  ];
  const cases = [
    {
      name: "complete baseline",
      mode: "success",
      expectedStatus: 0,
      expectedOutput: "result=passed\ndisposition=clear\n",
    },
    {
      name: "scan limit",
      mode: "scan-limit",
      expectedStatus: 0,
      expectedOutput: "result=scan-error\ndisposition=\n",
    },
    {
      name: "unavailable snapshot",
      mode: "unavailable",
      expectedStatus: 2,
      expectedOutput: "",
    },
    {
      name: "scan limit with a success marker",
      mode: "wrong-marker",
      expectedStatus: 1,
      expectedOutput: "",
    },
    {
      name: "scan limit with legacy v1 error marker",
      mode: "legacy-v1-marker",
      expectedStatus: 1,
      expectedOutput: "",
    },
    {
      name: "scan limit with legacy v3 error marker",
      mode: "legacy-v3-marker",
      expectedStatus: 1,
      expectedOutput: "",
    },
    {
      name: "scan limit with unknown future error marker",
      mode: "future-marker",
      expectedStatus: 1,
      expectedOutput: "",
    },
    {
      name: "scan limit with a canonical result file",
      mode: "unexpected-json",
      expectedStatus: 1,
      expectedOutput: "",
    },
  ];

  for (const scenario of scenarios) {
    const workflow = await readFile(
      new URL(`.github/workflows/${scenario.workflow}`, root),
      "utf8",
    );
    const script = workflowStepScript(workflow, "Run automated security baseline");
    for (const item of cases) {
      const directory = await mkdtemp(join(tmpdir(), "marketplace-baseline-exit-"));
      const bin = join(directory, "bin");
      const output = join(directory, "output");
      await mkdir(bin);
      await writeFile(join(bin, "node"), `#!/bin/sh
set -eu
json=""
for argument in "$@"; do
  case "$argument" in
    --json=*) json="\${argument#--json=}" ;;
  esac
done
test -n "$json"
case "$FAKE_BASELINE_MODE" in
  success)
    printf '%s\\n' '{"outcome":"passed","verifiedPublicationDisposition":"clear"}' > "$json"
    printf '%s\\n' '${securityBaselineMarkerPrefix}e30 -->' 'Complete report'
    exit 0
    ;;
  scan-limit)
    rm -f "$json"
    printf '%s\\n' '${securityBaselineErrorMarker}' 'dist/runtime.js exceeds the limit'
    exit 3
    ;;
  unavailable)
    rm -f "$json"
    printf '%s\\n' '${securityBaselineErrorMarker}' 'Snapshot unavailable'
    exit 2
    ;;
  wrong-marker)
    rm -f "$json"
    printf '%s\\n' '${securityBaselineMarkerPrefix}e30 -->' 'Wrong report'
    exit 3
    ;;
  legacy-v1-marker)
    rm -f "$json"
    printf '%s\\n' '<!-- marketplace-security-baseline-error:v1 -->' 'Outdated report'
    exit 3
    ;;
  legacy-v3-marker)
    rm -f "$json"
    printf '%s\\n' '<!-- marketplace-security-baseline-error:v3 -->' 'Outdated report'
    exit 3
    ;;
  future-marker)
    rm -f "$json"
    printf '%s\\n' '<!-- marketplace-security-baseline-error:v99 -->' 'Unknown report'
    exit 3
    ;;
  unexpected-json)
    printf '%s\\n' '{}' > "$json"
    printf '%s\\n' '${securityBaselineErrorMarker}' 'Unexpected result file'
    exit 3
    ;;
  *) exit 99 ;;
esac
`);
      await chmod(join(bin, "node"), 0o755);
      try {
        const execution = runWorkflowScript(script, {
          cwd: directory,
          env: {
            FAKE_BASELINE_MODE: item.mode,
            GITHUB_OUTPUT: output,
            PATH: `${bin}:${process.env.PATH}`,
          },
        });
        assert.equal(
          execution.status,
          item.expectedStatus,
          `${scenario.workflow}, ${item.name}: ${execution.stderr}`,
        );
        const actualOutput = await readFile(output, "utf8").catch(() => "");
        assert.equal(actualOutput, item.expectedOutput, `${scenario.workflow}, ${item.name}`);
        assert.equal(
          await readFile(join(directory, scenario.report), "utf8").then(() => true, () => false),
          true,
          `${scenario.workflow}, ${item.name}`,
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
});

test("security scan-limit reports publish fail-closed without retaining trust labels", async () => {
  const scenarios = [
    {
      workflow: "validate-submission.yml",
      verifyStep: "Verify analyzed validation reports",
      publishStep: "Publish automated security baseline",
      labelsStep: "Update validation labels",
      reportsDirectory: "validation-reports",
      validationReport: "validation-report.md",
      baselineReport: "security-baseline-report.md",
      title: "[Plugin]: Example",
      body: "Submission body",
      retainedLabel: "submission",
      extraTrustLabels: [],
    },
    {
      workflow: "validate-plugin-update.yml",
      verifyStep: "Verify analyzed update reports",
      publishStep: "Publish update security baseline",
      labelsStep: "Update plugin update labels",
      reportsDirectory: "plugin-update-reports",
      validationReport: "update-validation-report.md",
      baselineReport: "update-security-baseline-report.md",
      title: "[Verify]: Example",
      body: "Update body",
      retainedLabel: "plugin-update",
      extraTrustLabels: ["maintainer-verified"],
    },
  ];

  for (const scenario of scenarios) {
    const workflow = await readFile(
      new URL(`.github/workflows/${scenario.workflow}`, root),
      "utf8",
    );
    const verifyScript = workflowStepScript(workflow, scenario.verifyStep);
    const publishScript = workflowStepScript(workflow, scenario.publishStep);
    const labelsScript = workflowStepScript(workflow, scenario.labelsStep);
    const directory = await mkdtemp(join(tmpdir(), "marketplace-baseline-publication-"));
    const reports = join(directory, scenario.reportsDirectory);
    const baselineReport = [
      securityBaselineErrorMarker,
      "## Automated security baseline",
      "",
      "The static scan could not safely process `dist/runtime.js` within its configured limits.",
      "",
    ].join("\n");
    try {
      await createReportArtifact(reports, {
        [scenario.validationReport]: "Validation passed.\n",
        [scenario.baselineReport]: baselineReport,
      });
      const verify = runWorkflowScript(verifyScript, {
        cwd: directory,
        env: {
          BASELINE_DISPOSITION: "",
          BASELINE_RESULT: "scan-error",
          RUNNER_TEMP: directory,
          VALIDATION_RESULT: "validated",
        },
      });
      assert.equal(verify.status, 0, `${scenario.workflow}: ${verify.stderr}`);

      const staleLabels = [
        scenario.retainedLabel,
        "validated",
        "approved-and-verified",
        "approved-for-listing",
        ...scenario.extraTrustLabels,
        "security-needs-fixes",
        "security-review-required",
      ];
      const stub = await createIssueMutationStub(directory, {
        state: "open",
        title: scenario.title,
        body: scenario.body,
        labels: staleLabels.map((name) => ({ name })),
      });
      const mutationEnv = {
        BASELINE_DISPOSITION: "",
        BASELINE_RESULT: "scan-error",
        EXPECTED_BODY: scenario.body,
        EXPECTED_TITLE: scenario.title,
        EXPECTED_TYPE_LABEL: scenario.retainedLabel,
        GH_CALLS: stub.calls,
        GH_STATE: stub.state,
        GITHUB_REPOSITORY: "example/marketplace",
        ISSUE_NUMBER: "42",
        MUTATION_CONCURRENCY_GROUP: "plugin-catalog-writes",
        PATH: `${stub.bin}:${process.env.PATH}`,
        RESULT: "validated",
        RUNNER_TEMP: directory,
      };
      initializeIssueMutationGuard(workflow, { cwd: directory, env: mutationEnv });
      const publish = runWorkflowScript(publishScript, { cwd: directory, env: mutationEnv });
      assert.equal(publish.status, 0, `${scenario.workflow}: ${publish.stderr}`);
      const labels = runWorkflowScript(labelsScript, { cwd: directory, env: mutationEnv });
      assert.equal(labels.status, 0, `${scenario.workflow}: ${labels.stderr}`);

      const state = JSON.parse(await readFile(stub.state, "utf8"));
      assert.deepEqual(
        state.labels.map(({ name }) => name).sort(),
        [scenario.retainedLabel, "needs-fixes"].sort(),
        scenario.workflow,
      );
      assert.equal(state.comments.length, 1, scenario.workflow);
      assert.equal(state.comments[0], baselineReport, scenario.workflow);
      assert.match(state.comments[0], /dist\/runtime\.js/);
      assert.doesNotMatch(state.comments[0], /marketplace-security-baseline:v[0-9]+ /);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("hard analysis failures clear stale trust and publish one guarded report", async () => {
  const scenarios = [
    {
      workflow: "validate-submission.yml",
      clearStep: "Clear stale approval state after workflow failure",
      reportStep: "Report validation workflow failure",
      retainedLabel: "submission",
      staleLabels: [
        "validated",
        "approved-and-verified",
        "approved-for-listing",
        "security-needs-fixes",
        "security-review-required",
      ],
      marker: "<!-- marketplace-validation -->",
      reason: "The automated security baseline did not complete.",
      action: "A maintainer must review the workflow.",
    },
    {
      workflow: "validate-plugin-update.yml",
      clearStep: "Clear stale update approval state",
      reportStep: "Report plugin update workflow failure",
      retainedLabel: "plugin-update",
      staleLabels: [
        "validated",
        "needs-fixes",
        "approved-and-verified",
        "approved-for-listing",
        "maintainer-verified",
        "security-needs-fixes",
        "security-review-required",
      ],
      marker: "<!-- marketplace-update-workflow-status -->",
      reason: "The automated security baseline did not complete.",
      action: "",
    },
  ];

  for (const scenario of scenarios) {
    const workflow = await readFile(
      new URL(`.github/workflows/${scenario.workflow}`, root),
      "utf8",
    );
    const clearScript = workflowStepScript(workflow, scenario.clearStep);
    const reportScript = workflowStepScript(workflow, scenario.reportStep);
    const directory = await mkdtemp(join(tmpdir(), "marketplace-hard-failure-"));
    try {
      const title = scenario.retainedLabel === "submission" ? "[Plugin]: Example" : "[Verify]: Example";
      const body = "Failure body";
      const stub = await createIssueMutationStub(directory, {
        state: "open",
        title,
        body,
        labels: [scenario.retainedLabel, ...scenario.staleLabels].map((name) => ({ name })),
      });
      const env = {
        EXPECTED_BODY: body,
        EXPECTED_TITLE: title,
        EXPECTED_TYPE_LABEL: scenario.retainedLabel,
        FAILURE_ACTION: scenario.action,
        FAILURE_REASON: scenario.reason,
        GH_CALLS: stub.calls,
        GH_STATE: stub.state,
        GITHUB_REPOSITORY: "example/marketplace",
        ISSUE_NUMBER: "42",
        MUTATION_CONCURRENCY_GROUP: "plugin-catalog-writes",
        PATH: `${stub.bin}:${process.env.PATH}`,
        RUNNER_TEMP: directory,
        RUN_URL: "https://github.test/actions/runs/123",
      };
      initializeIssueMutationGuard(workflow, { cwd: directory, env });
      const clear = runWorkflowScript(clearScript, { cwd: directory, env });
      assert.equal(clear.status, 0, `${scenario.workflow}: ${clear.stderr}`);
      const report = runWorkflowScript(reportScript, { cwd: directory, env });
      assert.equal(report.status, 0, `${scenario.workflow}: ${report.stderr}`);

      const state = JSON.parse(await readFile(stub.state, "utf8"));
      assert.deepEqual(state.labels, [{ name: scenario.retainedLabel }], scenario.workflow);
      assert.equal(state.comments.length, 1, scenario.workflow);
      assert.match(state.comments[0], new RegExp(scenario.marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(state.comments[0], new RegExp(scenario.reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      const calls = (await readFile(stub.calls, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(
        calls.filter((args) => args[0] === "issue" && args[1] === "comment").length,
        1,
        scenario.workflow,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("plugin update failure guard rejects a changed current issue", async () => {
  const workflow = await readFile(
    new URL(".github/workflows/validate-plugin-update.yml", root),
    "utf8",
  );
  const script = workflowStepScript(workflow, "Confirm failed run still matches the issue");
  for (const [name, issue, matches] of [
    ["current", { state: "open", title: "[Verify]: Example", body: "Update body" }, true],
    ["edited", { state: "open", title: "[Verify]: Example", body: "Changed" }, false],
    ["closed", { state: "closed", title: "[Verify]: Example", body: "Update body" }, false],
    [
      "pull request",
      {
        state: "open",
        title: "[Verify]: Example",
        body: "Update body",
        pull_request: { url: "https://api.github.test/pulls/1" },
      },
      false,
    ],
  ]) {
    const directory = await mkdtemp(join(tmpdir(), "marketplace-update-failure-guard-"));
    const bin = join(directory, "bin");
    const issuePath = join(directory, "issue.json");
    const outputPath = join(directory, "output");
    await mkdir(bin);
    await writeFile(issuePath, JSON.stringify(issue));
    await writeFile(join(bin, "gh"), "#!/bin/sh\ncat \"$ISSUE_JSON\"\n");
    await chmod(join(bin, "gh"), 0o755);
    try {
      const execution = runWorkflowScript(script, {
        cwd: directory,
        env: {
          EXPECTED_BODY: "Update body",
          EXPECTED_TITLE: "[Verify]: Example",
          GITHUB_OUTPUT: outputPath,
          GITHUB_REPOSITORY: "example/marketplace",
          ISSUE_JSON: issuePath,
          ISSUE_NUMBER: "42",
          PATH: `${bin}:${process.env.PATH}`,
        },
      });
      assert.equal(execution.status, 0, `${name}: ${execution.stderr}`);
      assert.equal(await readFile(outputPath, "utf8"), `matches=${matches}\n`, name);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("submission report producer creates an exact checksummed artifact", async () => {
  const workflow = await readFile(
    new URL(".github/workflows/validate-submission.yml", root),
    "utf8",
  );
  const script = workflowStepScript(workflow, "Bundle analyzed validation reports");

  for (const files of [
    { "validation-report.md": "validation\n" },
    {
      "validation-report.md": "validation\n",
      "security-baseline-report.md": "baseline\n",
    },
  ]) {
    const directory = await mkdtemp(join(tmpdir(), "marketplace-validation-bundle-"));
    const work = join(directory, "work");
    const runnerTemp = join(directory, "runner");
    await mkdir(work);
    await mkdir(runnerTemp);
    try {
      for (const [name, content] of Object.entries(files)) {
        await writeFile(join(work, name), content);
      }
      const result = runWorkflowScript(script, {
        cwd: work,
        env: { RUNNER_TEMP: runnerTemp },
      });
      assert.equal(result.status, 0, result.stderr);
      const bundle = join(runnerTemp, "validation-reports");
      assert.deepEqual(
        (await readdir(bundle)).sort(),
        ["SHA256SUMS", ...Object.keys(files)].sort(),
      );
      const check = spawnSync("sha256sum", ["--check", "SHA256SUMS"], {
        cwd: bundle,
        encoding: "utf8",
      });
      assert.equal(check.status, 0, check.stderr);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("submission report consumer rejects tampering, links, and unexpected files", async () => {
  const workflow = await readFile(
    new URL(".github/workflows/validate-submission.yml", root),
    "utf8",
  );
  const script = workflowStepScript(workflow, "Verify analyzed validation reports");

  const cases = [
    {
      name: "valid rejected submission",
      files: { "validation-report.md": "validation\n" },
      result: "needs-fixes",
      baseline: "",
      disposition: "",
      expectedStatus: 0,
    },
    {
      name: "valid accepted submission",
      files: {
        "validation-report.md": "validation\n",
        "security-baseline-report.md": `${securityBaselineMarkerPrefix}e30 -->\nbaseline\n`,
      },
      result: "validated",
      baseline: "passed",
      disposition: "clear",
      expectedStatus: 0,
    },
    {
      name: "valid scan-limit report",
      files: {
        "validation-report.md": "validation\n",
        "security-baseline-report.md": `${securityBaselineErrorMarker}\nscan limit\n`,
      },
      result: "validated",
      baseline: "scan-error",
      disposition: "",
      expectedStatus: 0,
    },
    {
      name: "scan-limit result with success marker",
      files: {
        "validation-report.md": "validation\n",
        "security-baseline-report.md": `${securityBaselineMarkerPrefix}e30 -->\nbaseline\n`,
      },
      result: "validated",
      baseline: "scan-error",
      disposition: "",
      expectedStatus: 1,
    },
    {
      name: "success result with scan-limit marker",
      files: {
        "validation-report.md": "validation\n",
        "security-baseline-report.md": `${securityBaselineErrorMarker}\nscan limit\n`,
      },
      result: "validated",
      baseline: "passed",
      disposition: "clear",
      expectedStatus: 1,
    },
    ...["v1", "v3", "v99"].map((version) => ({
      name: `scan-limit result with unsupported ${version} marker`,
      files: {
        "validation-report.md": "validation\n",
        "security-baseline-report.md": `<!-- marketplace-security-baseline-error:${version} -->\nscan limit\n`,
      },
      result: "validated",
      baseline: "scan-error",
      disposition: "",
      expectedStatus: 1,
    })),
    {
      name: "missing baseline",
      files: { "validation-report.md": "validation\n" },
      result: "validated",
      baseline: "passed",
      disposition: "clear",
      expectedStatus: 1,
    },
    {
      name: "unexpected file",
      files: {
        "validation-report.md": "validation\n",
        "unexpected.txt": "unexpected\n",
      },
      result: "needs-fixes",
      baseline: "",
      disposition: "",
      expectedStatus: 1,
    },
  ];

  for (const item of cases) {
    const directory = await mkdtemp(join(tmpdir(), "marketplace-validation-reports-"));
    const reports = join(directory, "validation-reports");
    try {
      await createReportArtifact(reports, item.files);
      const execution = runWorkflowScript(script, {
        cwd: directory,
        env: {
          RUNNER_TEMP: directory,
          VALIDATION_RESULT: item.result,
          BASELINE_RESULT: item.baseline,
          BASELINE_DISPOSITION: item.disposition,
        },
      });
      assert.equal(execution.status, item.expectedStatus, `${item.name}: ${execution.stderr}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  const tamperedDirectory = await mkdtemp(join(tmpdir(), "marketplace-validation-tampered-"));
  try {
    const reports = join(tamperedDirectory, "validation-reports");
    await createReportArtifact(reports, { "validation-report.md": "original\n" });
    await writeFile(join(reports, "validation-report.md"), "tampered\n");
    const execution = runWorkflowScript(script, {
      cwd: tamperedDirectory,
      env: {
        RUNNER_TEMP: tamperedDirectory,
        VALIDATION_RESULT: "needs-fixes",
        BASELINE_RESULT: "",
        BASELINE_DISPOSITION: "",
      },
    });
    assert.notEqual(execution.status, 0);
  } finally {
    await rm(tamperedDirectory, { recursive: true, force: true });
  }

  const linkedDirectory = await mkdtemp(join(tmpdir(), "marketplace-validation-linked-"));
  try {
    const reports = join(linkedDirectory, "validation-reports");
    await createReportArtifact(reports, { "validation-report.md": "validation\n" });
    await symlink("validation-report.md", join(reports, "report-link.md"));
    const execution = runWorkflowScript(script, {
      cwd: linkedDirectory,
      env: {
        RUNNER_TEMP: linkedDirectory,
        VALIDATION_RESULT: "needs-fixes",
        BASELINE_RESULT: "",
        BASELINE_DISPOSITION: "",
      },
    });
    assert.notEqual(execution.status, 0);
    assert.match(execution.stderr, /symbolic link/);
  } finally {
    await rm(linkedDirectory, { recursive: true, force: true });
  }
});

test("submission failure guard permits only the unchanged current issue", async () => {
  const workflow = await readFile(
    new URL(".github/workflows/validate-submission.yml", root),
    "utf8",
  );
  const script = workflowStepScript(workflow, "Confirm failed run still matches the submission");
  const expectedTitle = "[Plugin]: Example";
  const expectedBody = "Submission body";
  const cases = [
    {
      name: "current issue",
      issue: { state: "open", title: expectedTitle, body: expectedBody, labels: [] },
      matches: true,
    },
    {
      name: "legacy submission with current label",
      expectedTitle: "Legacy submission",
      issue: {
        state: "open",
        title: "Legacy submission",
        body: expectedBody,
        labels: [{ name: "submission" }],
      },
      matches: true,
    },
    {
      name: "legacy submission after label removal",
      expectedTitle: "Legacy submission",
      issue: { state: "open", title: "Legacy submission", body: expectedBody, labels: [] },
      matches: false,
    },
    {
      name: "edited issue",
      issue: { state: "open", title: expectedTitle, body: "Edited", labels: [] },
      matches: false,
    },
    {
      name: "pull request",
      issue: {
        state: "open",
        title: expectedTitle,
        body: expectedBody,
        labels: [],
        pull_request: { url: "https://api.github.test/pulls/1" },
      },
      matches: false,
    },
    {
      name: "listed issue",
      issue: {
        state: "open",
        title: expectedTitle,
        body: expectedBody,
        labels: [{ name: "listed" }],
      },
      matches: false,
    },
  ];

  for (const item of cases) {
    const directory = await mkdtemp(join(tmpdir(), "marketplace-validation-guard-"));
    const bin = join(directory, "bin");
    const issuePath = join(directory, "issue.json");
    const outputPath = join(directory, "output");
    await mkdir(bin);
    await writeFile(issuePath, JSON.stringify(item.issue));
    await writeFile(join(bin, "gh"), "#!/bin/sh\ncat \"$ISSUE_JSON\"\n");
    await chmod(join(bin, "gh"), 0o755);
    try {
      const execution = runWorkflowScript(script, {
        cwd: directory,
        env: {
          EXPECTED_BODY: expectedBody,
          EXPECTED_TITLE: item.expectedTitle || expectedTitle,
          GITHUB_OUTPUT: outputPath,
          GITHUB_REPOSITORY: "example/marketplace",
          ISSUE_JSON: issuePath,
          ISSUE_NUMBER: "1",
          PATH: `${bin}:${process.env.PATH}`,
        },
      });
      assert.equal(execution.status, 0, `${item.name}: ${execution.stderr}`);
      assert.equal(await readFile(outputPath, "utf8"), `matches=${item.matches}\n`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  const unavailableDirectory = await mkdtemp(join(tmpdir(), "marketplace-validation-guard-error-"));
  const bin = join(unavailableDirectory, "bin");
  const outputPath = join(unavailableDirectory, "output");
  await mkdir(bin);
  await writeFile(join(bin, "gh"), "#!/bin/sh\nexit 1\n");
  await chmod(join(bin, "gh"), 0o755);
  try {
    const execution = runWorkflowScript(script, {
      cwd: unavailableDirectory,
      env: {
        EXPECTED_BODY: expectedBody,
        EXPECTED_TITLE: expectedTitle,
        GITHUB_OUTPUT: outputPath,
        GITHUB_REPOSITORY: "example/marketplace",
        ISSUE_NUMBER: "1",
        PATH: `${bin}:${process.env.PATH}`,
      },
    });
    assert.notEqual(execution.status, 0);
  } finally {
    await rm(unavailableDirectory, { recursive: true, force: true });
  }
});

test("submission publication guard rejects stale current state", async () => {
  const workflow = await readFile(
    new URL(".github/workflows/validate-submission.yml", root),
    "utf8",
  );
  const script = workflowStepScript(workflow, "Confirm analyzed issue state is still current");
  const expectedBody = "Submission body";
  const cases = [
    {
      name: "current titled submission",
      expectedTitle: "[Plugin]: Example",
      issue: { state: "open", title: "[Plugin]: Example", body: expectedBody, labels: [] },
      shouldPublish: true,
    },
    {
      name: "current legacy submission",
      expectedTitle: "Legacy submission",
      issue: {
        state: "open",
        title: "Legacy submission",
        body: expectedBody,
        labels: [{ name: "submission" }],
      },
      shouldPublish: true,
    },
    {
      name: "removed legacy submission label",
      expectedTitle: "Legacy submission",
      issue: { state: "open", title: "Legacy submission", body: expectedBody, labels: [] },
      shouldPublish: false,
    },
    {
      name: "listed submission",
      expectedTitle: "[Plugin]: Example",
      issue: {
        state: "open",
        title: "[Plugin]: Example",
        body: expectedBody,
        labels: [{ name: "listed" }],
      },
      shouldPublish: false,
    },
  ];

  for (const item of cases) {
    const directory = await mkdtemp(join(tmpdir(), "marketplace-validation-publish-guard-"));
    const bin = join(directory, "bin");
    const issuePath = join(directory, "issue.json");
    const outputPath = join(directory, "output");
    await mkdir(bin);
    await writeFile(issuePath, JSON.stringify(item.issue));
    await writeFile(join(bin, "gh"), "#!/bin/sh\ncat \"$ISSUE_JSON\"\n");
    await chmod(join(bin, "gh"), 0o755);
    try {
      const env = {
        EXPECTED_BODY: expectedBody,
        EXPECTED_TITLE: item.expectedTitle,
        EXPECTED_TYPE_LABEL: "submission",
        GITHUB_OUTPUT: outputPath,
        GITHUB_REPOSITORY: "example/marketplace",
        ISSUE_JSON: issuePath,
        ISSUE_NUMBER: "1",
        MUTATION_CONCURRENCY_GROUP: "plugin-catalog-writes",
        PATH: `${bin}:${process.env.PATH}`,
        RUNNER_TEMP: directory,
      };
      initializeIssueMutationGuard(workflow, { cwd: directory, env });
      const execution = runWorkflowScript(script, { cwd: directory, env });
      assert.equal(execution.status, 0, `${item.name}: ${execution.stderr}`);
      assert.equal(
        await readFile(outputPath, "utf8"),
        `should_publish=${item.shouldPublish}\n`,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  const unavailableDirectory = await mkdtemp(join(tmpdir(), "marketplace-publish-guard-error-"));
  const bin = join(unavailableDirectory, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "gh"), "#!/bin/sh\nexit 1\n");
  await chmod(join(bin, "gh"), 0o755);
  try {
    const env = {
      EXPECTED_BODY: expectedBody,
      EXPECTED_TITLE: "[Plugin]: Example",
      EXPECTED_TYPE_LABEL: "submission",
      GITHUB_OUTPUT: join(unavailableDirectory, "output"),
      GITHUB_REPOSITORY: "example/marketplace",
      ISSUE_NUMBER: "1",
      MUTATION_CONCURRENCY_GROUP: "plugin-catalog-writes",
      PATH: `${bin}:${process.env.PATH}`,
      RUNNER_TEMP: unavailableDirectory,
    };
    initializeIssueMutationGuard(workflow, { cwd: unavailableDirectory, env });
    const execution = runWorkflowScript(script, { cwd: unavailableDirectory, env });
    assert.notEqual(execution.status, 0);
  } finally {
    await rm(unavailableDirectory, { recursive: true, force: true });
  }
});
