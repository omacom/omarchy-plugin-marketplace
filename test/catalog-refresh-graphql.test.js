import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertFullRefreshRestBudget,
  buildCatalog,
  canReuseFullRefreshSource,
  catalogRefreshGraphqlBatchSize,
  catalogRefreshGraphqlBudgetReserve,
  catalogRefreshGraphqlPointsPerBatchReserve,
  catalogRefreshIdentityQuery,
  catalogRefreshRestBudgetReserve,
  catalogSourceFingerprint,
  catalogSourceValidationVersion,
  CatalogBuildError,
  CatalogCheckError,
  currentCatalogApiUsage,
  failedSourcePlugins,
  resetCatalogApiUsage,
  resolveFullRefreshIdentities,
  reusableFullRefreshPlugins,
} from "../scripts/build-catalog.mjs";
import {
  securityBaselineEnforcementMode,
  securityBaselineVersion,
} from "../scripts/security-baseline-policy.mjs";

const commit = "a".repeat(40);
const tree = "b".repeat(40);
const checkedAt = "2026-08-29T09:00:00.000Z";
const validatedAt = "2026-08-28T09:00:00.000Z";

function source(overrides = {}) {
  return {
    repo: "https://github.com/example/plugin",
    type: "plugin-source",
    addedAt: "2026-08-28",
    listedAt: "2026-08-28T08:00:00.000Z",
    listingValidatedCommit: "c".repeat(40),
    listingValidatedAt: "2026-08-28T08:00:00.000Z",
    listingValidatedBranch: "main",
    plugins: {
      "example.plugin": {
        category: "Desktop",
        tags: ["overlay"],
      },
    },
    ...overrides,
  };
}

function verifiedSource(overrides = {}) {
  const activeSource = source();
  return {
    ...activeSource,
    automatedSecurityBaseline: {
      schemaVersion: 1,
      version: securityBaselineVersion,
      repository: "example/plugin",
      pluginIds: ["example.plugin"],
      commit: activeSource.listingValidatedCommit,
      checkedAt: activeSource.listingValidatedAt,
      outcome: "passed",
      enforcementMode: securityBaselineEnforcementMode,
      findings: [],
      capabilities: [],
    },
    ...overrides,
  };
}

function identity(overrides = {}) {
  return {
    repository: { owner: "example", repository: "plugin", slug: "example/plugin" },
    metadata: {
      archived: false,
      default_branch: "main",
      disabled: false,
      private: false,
      pushed_at: "2026-08-29T08:30:00Z",
      stargazers_count: 12,
      updated_at: "2026-08-29T08:30:00Z",
    },
    branch: "main",
    commitSha: commit,
    treeSha: tree,
    ...overrides,
  };
}

function priorPlugin(activeSource = source(), overrides = {}) {
  return {
    id: "example.plugin",
    name: "Example",
    repo: activeSource.repo,
    sourceType: "community",
    version: "1.0.0",
    stars: 5,
    repositoryUpdatedAt: "2026-08-28T08:00:00Z",
    listingValidatedCommit: activeSource.listingValidatedCommit,
    listingValidatedAt: activeSource.listingValidatedAt,
    listingValidatedBranch: activeSource.listingValidatedBranch,
    upstreamObservedCommit: commit,
    upstreamObservedBranch: "main",
    upstreamCheckedAt: validatedAt,
    upstreamCheckStatus: "passed",
    upstreamValidatedCommit: commit,
    upstreamValidatedAt: validatedAt,
    upstreamValidationVersion: catalogSourceValidationVersion,
    upstreamSourceFingerprint: catalogSourceFingerprint(activeSource),
    ...overrides,
  };
}

function graphqlRate(remaining = 4900, cost = 1) {
  return { cost, limit: 5000, remaining, resetAt: "2026-08-29T10:00:00Z" };
}

function graphqlRepository({
  nameWithOwner = "example/plugin",
  branch = "main",
  commitSha = commit,
  treeSha = tree,
} = {}) {
  return {
    id: "R_kgDOExample",
    databaseId: 123456789,
    nameWithOwner,
    isArchived: false,
    isDisabled: false,
    isPrivate: false,
    stargazerCount: 12,
    pushedAt: "2026-08-29T08:30:00Z",
    updatedAt: "2026-08-29T08:30:00Z",
    defaultBranchRef: {
      name: branch,
      target: { oid: commitSha, tree: { oid: treeSha } },
    },
    configuredRef: null,
  };
}

function jsonResponse(value, options = {}) {
  const body = JSON.stringify(value);
  return new Response(body, {
    status: options.status || 200,
    headers: { "content-length": String(Buffer.byteLength(body)), ...(options.headers || {}) },
  });
}

test("catalog refresh GraphQL queries keep repository and branch values in variables", () => {
  const configured = source({
    repo: "https://github.com/Example/Plugin.git",
    branch: "feature/quoted-\"-branch",
  });
  const request = catalogRefreshIdentityQuery([configured]);
  assert.match(request.query, /r0:repository\(owner:\$owner0,name:\$name0\)/);
  assert.match(request.query, /Repository\{id databaseId nameWithOwner/);
  assert.doesNotMatch(request.query, /Example|Plugin|quoted/);
  assert.deepEqual(request.variables, {
    owner0: "Example",
    name0: "Plugin",
    ref0: "refs/heads/feature/quoted-\"-branch",
  });
  assert.equal(request.entries[0].key, "example/plugin");
  assert.throws(
    () => catalogRefreshIdentityQuery(Array.from({ length: catalogRefreshGraphqlBatchSize + 1 }, () => configured)),
    /batch size is invalid/,
  );
});

test("source fingerprints are canonical and bind registry configuration", () => {
  const first = source({ plugins: { "example.plugin": { tags: ["overlay"], category: "Desktop" } } });
  const reordered = {
    plugins: { "example.plugin": { category: "Desktop", tags: ["overlay"] } },
    listingValidatedBranch: first.listingValidatedBranch,
    listingValidatedAt: first.listingValidatedAt,
    listingValidatedCommit: first.listingValidatedCommit,
    listedAt: first.listedAt,
    addedAt: first.addedAt,
    type: first.type,
    repo: first.repo,
  };
  assert.equal(catalogSourceFingerprint(first), catalogSourceFingerprint(reordered));
  assert.notEqual(
    catalogSourceFingerprint(first),
    catalogSourceFingerprint(source({ plugins: { "example.plugin": { category: "System", tags: ["overlay"] } } })),
  );
});

test("full refresh reuse requires exact passed commit, branch, policy, fingerprint, and plugin set", () => {
  const activeSource = source();
  const currentIdentity = identity();
  const previous = [priorPlugin(activeSource)];
  assert.equal(canReuseFullRefreshSource(activeSource, currentIdentity, previous), true);

  const reused = reusableFullRefreshPlugins(activeSource, currentIdentity, previous, checkedAt);
  assert.equal(reused.length, 1);
  assert.equal(reused[0].upstreamCheckedAt, checkedAt);
  assert.equal(reused[0].upstreamValidatedAt, validatedAt);
  assert.equal(reused[0].stars, 12);
  assert.equal(reused[0].repositoryUpdatedAt, "2026-08-29T08:30:00Z");

  for (const invalid of [
    [activeSource, identity({ commitSha: "d".repeat(40) }), previous],
    [activeSource, identity({ branch: "next" }), previous],
    [activeSource, currentIdentity, [priorPlugin(activeSource, { upstreamCheckStatus: "failed" })]],
    [activeSource, currentIdentity, [priorPlugin(activeSource, { upstreamValidationVersion: 0 })]],
    [activeSource, currentIdentity, [priorPlugin(activeSource, { upstreamSourceFingerprint: "0".repeat(64) })]],
    [activeSource, currentIdentity, [...previous, { ...previous[0], id: "example.extra" }]],
  ]) {
    assert.equal(canReuseFullRefreshSource(...invalid), false);
    assert.equal(reusableFullRefreshPlugins(...invalid, checkedAt), null);
  }
});

test("a confirmed new identity remains update-unverified across later network failures", () => {
  const activeSource = verifiedSource();
  const oldCommit = activeSource.listingValidatedCommit;
  const previous = priorPlugin(activeSource, {
    repositoryLayout: "root-plugin",
    installAvailable: true,
    installCommand: "omarchy plugin add https://github.com/example/plugin.git --enable",
    status: "Available",
    upstreamObservedCommit: oldCommit,
    upstreamValidatedCommit: oldCommit,
  });
  const failed = failedSourcePlugins(
    activeSource,
    [previous],
    identity(),
    checkedAt,
    new CatalogCheckError("repository-unreachable", "tree or raw transport failed"),
  )[0];
  assert.equal(failed.upstreamObservedCommit, commit);
  assert.equal(failed.upstreamValidatedCommit, oldCommit);
  assert.equal(failed.upstreamCheckStatus, "unreachable");
  assert.equal(failed.verificationStatus, "unverified");
  assert.equal(failed.verificationSnapshotStatus, "verified");
  assert.equal(failed.verificationCoverage, "update-unverified");

  const notFound = failedSourcePlugins(
    activeSource,
    [previous],
    undefined,
    checkedAt,
    new CatalogCheckError("repository-unreachable", "identity unavailable"),
  )[0];
  assert.equal(notFound.upstreamObservedCommit, oldCommit);
  assert.equal(notFound.verificationCoverage, "snapshot-verified");
});

test("GraphQL identity batches accept exact data and isolate only explicit repository-not-found errors", async () => {
  const sources = [
    source(),
    source({ repo: "https://github.com/example/missing", plugins: { "example.missing": {} } }),
  ];
  const originalFetch = globalThis.fetch;
  let identityCall = 0;
  resetCatalogApiUsage();
  globalThis.fetch = async (input, init = {}) => {
    assert.equal(String(input), "https://api.github.com/graphql");
    const request = JSON.parse(init.body);
    if (request.query.includes("CatalogRefreshBudget")) {
      return jsonResponse({ data: { rateLimit: graphqlRate(4999) } });
    }
    identityCall += 1;
    if (identityCall === 1) {
      return jsonResponse({
        data: { r0: graphqlRepository(), rateLimit: graphqlRate(4998) },
      });
    }
    return jsonResponse({
      data: { r0: null, rateLimit: graphqlRate(4997) },
      errors: [{ type: "NOT_FOUND", path: ["r0"], message: "untrusted detail" }],
    });
  };

  try {
    const result = await resolveFullRefreshIdentities(sources, {
      batchSize: 1,
      budgetReserve: 0,
    });
    assert.equal(result.get("example/plugin").context.commitSha, commit);
    assert.equal(result.get("example/missing").error.code, "repository-unreachable");
    assert.deepEqual(currentCatalogApiUsage(), {
      graphqlRequests: 3,
      graphqlPoints: 3,
      rawRequests: 0,
      restOtherRequests: 0,
      restRateLimitRequests: 0,
      restTreeRequests: 0,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GraphQL identity acquisition crosses its batch boundary only with sufficient live budget", async () => {
  const sources = Array.from(
    { length: catalogRefreshGraphqlBatchSize + 1 },
    (_, index) => source({
      repo: `https://github.com/example/plugin-${index}`,
      plugins: { [`example.plugin-${index}`]: {} },
    }),
  );
  const expectedBatchCount = Math.ceil(sources.length / catalogRefreshGraphqlBatchSize);
  const preflightRequired =
    expectedBatchCount * catalogRefreshGraphqlPointsPerBatchReserve
    + catalogRefreshGraphqlBudgetReserve;
  const originalFetch = globalThis.fetch;
  let preflightRemaining = preflightRequired - 1;
  let identityBudgetAdjustment = 0;
  const identityBatchSizes = [];
  globalThis.fetch = async (_input, init = {}) => {
    const request = JSON.parse(init.body);
    if (request.query.includes("CatalogRefreshBudget")) {
      return jsonResponse({ data: { rateLimit: graphqlRate(preflightRemaining) } });
    }
    const batchSize = Object.keys(request.variables)
      .filter((key) => key.startsWith("owner"))
      .length;
    identityBatchSizes.push(batchSize);
    const remainingBatchCount = expectedBatchCount - identityBatchSizes.length;
    const data = {
      rateLimit: graphqlRate(
        remainingBatchCount * catalogRefreshGraphqlPointsPerBatchReserve
          + catalogRefreshGraphqlBudgetReserve
          + identityBudgetAdjustment,
      ),
    };
    for (let index = 0; index < batchSize; index += 1) {
      data[`r${index}`] = graphqlRepository({
        nameWithOwner: `${request.variables[`owner${index}`]}/${request.variables[`name${index}`]}`,
      });
    }
    return jsonResponse({ data });
  };

  try {
    await assert.rejects(
      resolveFullRefreshIdentities(sources),
      (error) => error instanceof CatalogBuildError
        && error.code === "api-budget-insufficient"
        && error.message.includes(
          `remaining ${preflightRequired - 1}, required ${preflightRequired}`,
        ),
    );
    assert.deepEqual(identityBatchSizes, []);

    preflightRemaining = preflightRequired;
    identityBudgetAdjustment = -1;
    const remainingBatchRequired =
      catalogRefreshGraphqlPointsPerBatchReserve
      + catalogRefreshGraphqlBudgetReserve;
    await assert.rejects(
      resolveFullRefreshIdentities(sources),
      (error) => error instanceof CatalogBuildError
        && error.code === "api-budget-insufficient"
        && error.message.includes(
          `remaining ${remainingBatchRequired - 1}, required ${remainingBatchRequired}`,
        ),
    );
    assert.deepEqual(identityBatchSizes, [catalogRefreshGraphqlBatchSize]);

    identityBatchSizes.length = 0;
    identityBudgetAdjustment = 0;
    const result = await resolveFullRefreshIdentities(sources);
    assert.equal(result.size, catalogRefreshGraphqlBatchSize + 1);
    assert.equal(result.get("example/plugin-50").context.commitSha, commit);
    assert.deepEqual(identityBatchSizes, [catalogRefreshGraphqlBatchSize, 1]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GraphQL identity acquisition rejects ambiguous partial data and insufficient budget globally", async () => {
  const originalFetch = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = async (_input, init = {}) => {
      const request = JSON.parse(init.body);
      if (request.query.includes("CatalogRefreshBudget")) {
        return jsonResponse({ data: { rateLimit: graphqlRate(4999) } });
      }
      calls += 1;
      return jsonResponse({
        data: { r0: null, rateLimit: graphqlRate(4998) },
        errors: [{ type: "INTERNAL", path: ["r0"], message: "do not downgrade" }],
      });
    };
    await assert.rejects(
      resolveFullRefreshIdentities([source()], { budgetReserve: 0 }),
      (error) => error instanceof CatalogBuildError && error.code === "github-graphql-invalid",
    );
    assert.equal(calls, 1);

    globalThis.fetch = async () => jsonResponse({
      data: { rateLimit: graphqlRate(9) },
    });
    await assert.rejects(
      resolveFullRefreshIdentities([source()], { budgetReserve: 0 }),
      (error) => error instanceof CatalogBuildError
        && error.code === "api-budget-insufficient"
        && /remaining 9/.test(error.message),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GraphQL identity structure and rate scalars fail globally when malformed", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const malformed of [
      null,
      (() => {
        const value = graphqlRepository();
        delete value.isPrivate;
        return value;
      })(),
      (() => {
        const value = graphqlRepository();
        delete value.id;
        return value;
      })(),
      { ...graphqlRepository(), databaseId: "123456789" },
      { ...graphqlRepository(), databaseId: Number.MAX_SAFE_INTEGER + 1 },
      { ...graphqlRepository(), databaseId: 0 },
      { ...graphqlRepository(), isDisabled: "false" },
      { ...graphqlRepository(), stargazerCount: "12" },
      { ...graphqlRepository(), defaultBranchRef: undefined },
      { ...graphqlRepository(), defaultBranchRef: { name: "main", target: { oid: commit } } },
    ]) {
      globalThis.fetch = async (_input, init = {}) => {
        const request = JSON.parse(init.body);
        if (request.query.includes("CatalogRefreshBudget")) {
          return jsonResponse({ data: { rateLimit: graphqlRate(4999) } });
        }
        return jsonResponse({
          data: { r0: malformed, rateLimit: graphqlRate(4998) },
        });
      };
      await assert.rejects(
        resolveFullRefreshIdentities([source()], { budgetReserve: 0 }),
        (error) => error instanceof CatalogBuildError && error.code === "github-graphql-invalid",
      );
    }

    globalThis.fetch = async () => jsonResponse({
      data: {
        rateLimit: { ...graphqlRate(4999), remaining: "4999" },
      },
    });
    await assert.rejects(
      resolveFullRefreshIdentities([source()], { budgetReserve: 0 }),
      (error) => error instanceof CatalogBuildError && error.code === "github-graphql-invalid",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("GraphQL identity acquisition retries only bounded transient transport failures", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let cancelledBodies = 0;
  resetCatalogApiUsage();
  globalThis.fetch = async (_input, init = {}) => {
    calls += 1;
    const request = JSON.parse(init.body);
    if (request.query.includes("CatalogRefreshBudget") && calls < 3) {
      return new Response(new ReadableStream({
        cancel() {
          cancelledBodies += 1;
        },
      }), { status: 502 });
    }
    if (request.query.includes("CatalogRefreshBudget")) {
      return jsonResponse({ data: { rateLimit: graphqlRate(4999) } });
    }
    return jsonResponse({
      data: { r0: graphqlRepository(), rateLimit: graphqlRate(4998) },
    });
  };
  try {
    const result = await resolveFullRefreshIdentities([source()], { budgetReserve: 0 });
    assert.equal(result.get("example/plugin").context.commitSha, commit);
    assert.equal(calls, 4);
    assert.equal(cancelledBodies, 2);
    assert.equal(currentCatalogApiUsage().graphqlRequests, 4);
    assert.equal(currentCatalogApiUsage().graphqlPoints, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("REST tree budget is explicit, bounded, and fail-closed", async () => {
  const originalFetch = globalThis.fetch;
  try {
    resetCatalogApiUsage();
    globalThis.fetch = async (input) => {
      assert.equal(String(input), "https://api.github.com/rate_limit");
      return jsonResponse({
        resources: { core: { limit: 5000, remaining: 700, reset: 1787997600 } },
      });
    };
    await assert.rejects(
      assertFullRefreshRestBudget(250),
      (error) => error instanceof CatalogBuildError
        && error.code === "api-budget-insufficient"
        && /trees 250, reserve 500/.test(error.message),
    );

    globalThis.fetch = async () => jsonResponse({
      resources: { core: { limit: 5000, remaining: 751, reset: 1787997600 } },
    });
    const accepted = await assertFullRefreshRestBudget(250);
    assert.equal(accepted.remaining, 751);
    assert.equal(currentCatalogApiUsage().restRateLimitRequests, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("REST tree budget retries transient failures and reports the final cause", async () => {
  const originalFetch = globalThis.fetch;
  try {
    resetCatalogApiUsage();
    let calls = 0;
    globalThis.fetch = async (input) => {
      assert.equal(String(input), "https://api.github.com/rate_limit");
      calls += 1;
      if (calls === 1) return new Response("unavailable", { status: 502 });
      if (calls === 2) throw new TypeError("fetch failed");
      return jsonResponse({
        resources: { core: { limit: 5000, remaining: 4000, reset: 1787997600 } },
      });
    };
    const accepted = await assertFullRefreshRestBudget(250);
    assert.equal(accepted.remaining, 4000);
    assert.equal(currentCatalogApiUsage().restRateLimitRequests, 3);

    globalThis.fetch = async () => new Response("unavailable", { status: 503 });
    await assert.rejects(
      assertFullRefreshRestBudget(250),
      (error) => error instanceof CatalogBuildError
        && error.code === "api-budget-insufficient"
        && error.publicMessage === "GitHub REST core budget request failed: GitHub API 503",
    );

    globalThis.fetch = async () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
      });
    };
    await assert.rejects(
      assertFullRefreshRestBudget(250),
      (error) => error instanceof CatalogBuildError
        && error.publicMessage === "GitHub REST core budget request failed: Network request failed for api.github.com: TypeError: fetch failed (ECONNRESET)",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("tree and raw failures preserve a GraphQL-observed newer commit", async () => {
  for (const failurePoint of ["tree", "raw"]) {
    const directory = await mkdtemp(join(tmpdir(), `marketplace-observed-${failurePoint}-`));
    const registryPath = join(directory, "registry.json");
    const catalogPath = join(directory, "site/catalog.json");
    const previewDirectory = join(directory, "site/assets/img/plugins");
    const activeSource = verifiedSource();
    const oldCommit = activeSource.listingValidatedCommit;
    const previousPlugin = priorPlugin(activeSource, {
      addedAt: activeSource.addedAt,
      listedAt: activeSource.listedAt,
      repositoryLayout: "root-plugin",
      installAvailable: true,
      installCommand: "omarchy plugin add https://github.com/example/plugin.git --enable",
      status: "Available",
      upstreamObservedCommit: oldCommit,
      upstreamValidatedCommit: oldCommit,
    });
    const originalFetch = globalThis.fetch;
    await mkdir(previewDirectory, { recursive: true });
    await writeFile(registryPath, `${JSON.stringify({
      sources: [activeSource],
      builtInSources: [],
      placeholders: [],
    }, null, 2)}\n`);
    await writeFile(catalogPath, `${JSON.stringify({
      generatedAt: validatedAt,
      stateSchemaVersion: 2,
      mode: "production",
      plugins: [previousPlugin],
      warnings: [],
    }, null, 2)}\n`);

    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      if (url === "https://api.github.com/graphql") {
        const request = JSON.parse(init.body);
        if (request.query.includes("CatalogRefreshBudget")) {
          return jsonResponse({ data: { rateLimit: graphqlRate(4999) } });
        }
        return jsonResponse({
          data: { r0: graphqlRepository(), rateLimit: graphqlRate(4998) },
        });
      }
      if (url === "https://api.github.com/rate_limit") {
        return jsonResponse({
          resources: { core: { limit: 5000, remaining: 4998, reset: 1787997600 } },
        });
      }
      if (url === `https://api.github.com/repos/example/plugin/git/trees/${tree}?recursive=1`) {
        if (failurePoint === "tree") return new Response("temporary", { status: 503 });
        return jsonResponse({
          truncated: false,
          tree: [
            { path: "README.md", type: "blob", mode: "100644", size: 10 },
            { path: "LICENSE", type: "blob", mode: "100644", size: 10 },
            { path: "manifest.json", type: "blob", mode: "100644", size: 200 },
            { path: "Main.qml", type: "blob", mode: "100644", size: 10 },
          ],
        });
      }
      if (url === `https://raw.githubusercontent.com/example/plugin/${commit}/manifest.json`) {
        assert.equal(failurePoint, "raw");
        return new Response("temporary", { status: 503 });
      }
      throw new Error(`Unexpected fixture request: ${url}`);
    };

    try {
      await buildCatalog({
        registryPath,
        catalogPath,
        previewDirectory,
        graphqlBudgetReserve: 0,
      });
      const result = JSON.parse(await readFile(catalogPath, "utf8"));
      const plugin = result.plugins[0];
      assert.equal(plugin.upstreamObservedCommit, commit, failurePoint);
      assert.equal(plugin.upstreamValidatedCommit, oldCommit, failurePoint);
      assert.equal(plugin.upstreamCheckStatus, "unreachable", failurePoint);
      assert.equal(plugin.verificationCoverage, "update-unverified", failurePoint);
      assert.deepEqual(result.warnings, [
        `${activeSource.repo}: repository-unreachable`,
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(directory, { recursive: true, force: true });
    }
  }
});

async function refreshManualSetupSource({ manifestDirectories, installation }) {
  const directory = await mkdtemp(join(tmpdir(), "marketplace-manual-setup-"));
  const registryPath = join(directory, "registry.json");
  const catalogPath = join(directory, "site/catalog.json");
  const previewDirectory = join(directory, "site/assets/img/plugins");
  const note = "This plugin requires a matching native helper.";
  const activeSource = source({
    plugins: {
      "example.plugin": {
        category: "Desktop",
        tags: ["overlay"],
        installation: installation || { mode: "manual", note },
      },
    },
  });
  const oldCommit = activeSource.listingValidatedCommit;
  const previousPlugin = priorPlugin(activeSource, {
    addedAt: activeSource.addedAt,
    listedAt: activeSource.listedAt,
    manifestPath: "manifest.json",
    repositoryLayout: "root-plugin",
    installAvailable: false,
    installCommand: "",
    installNote: note,
    status: "Manual setup",
    upstreamObservedCommit: oldCommit,
    upstreamValidatedCommit: oldCommit,
  });
  const manifest = JSON.stringify({
    schemaVersion: 1,
    id: "example.plugin",
    name: "Example",
    version: "1.0.0",
    author: "Example",
    description: "Example plugin",
    license: "MIT",
    kinds: ["overlay"],
    entryPoints: { overlay: "Main.qml" },
  });
  const prefixes = manifestDirectories.map((name) => (name ? `${name}/` : ""));
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const errors = [];
  await mkdir(previewDirectory, { recursive: true });
  await writeFile(registryPath, `${JSON.stringify({
    sources: [activeSource],
    builtInSources: [],
    placeholders: [],
  }, null, 2)}\n`);
  await writeFile(catalogPath, `${JSON.stringify({
    generatedAt: validatedAt,
    stateSchemaVersion: 2,
    mode: "production",
    plugins: [previousPlugin],
    warnings: [],
  }, null, 2)}\n`);

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === "https://api.github.com/graphql") {
      const request = JSON.parse(init.body);
      if (request.query.includes("CatalogRefreshBudget")) {
        return jsonResponse({ data: { rateLimit: graphqlRate(4999) } });
      }
      return jsonResponse({
        data: { r0: graphqlRepository(), rateLimit: graphqlRate(4998) },
      });
    }
    if (url === "https://api.github.com/rate_limit") {
      return jsonResponse({
        resources: { core: { limit: 5000, remaining: 4998, reset: 1787997600 } },
      });
    }
    if (url === `https://api.github.com/repos/example/plugin/git/trees/${tree}?recursive=1`) {
      return jsonResponse({
        truncated: false,
        tree: [
          { path: "README.md", type: "blob", mode: "100644", size: 10 },
          { path: "LICENSE", type: "blob", mode: "100644", size: 10 },
          ...prefixes.flatMap((prefix) => [
            { path: `${prefix}manifest.json`, type: "blob", mode: "100644", size: 200 },
            { path: `${prefix}Main.qml`, type: "blob", mode: "100644", size: 10 },
          ]),
        ],
      });
    }
    if (prefixes.some((prefix) => url === `https://raw.githubusercontent.com/example/plugin/${commit}/${prefix}manifest.json`)) {
      return new Response(manifest, {
        status: 200,
        headers: { "content-length": String(Buffer.byteLength(manifest)) },
      });
    }
    throw new Error(`Unexpected fixture request: ${url}`);
  };
  console.error = (...args) => errors.push(args.join(" "));

  try {
    await buildCatalog({
      registryPath,
      catalogPath,
      previewDirectory,
      graphqlBudgetReserve: 0,
    });
    const result = JSON.parse(await readFile(catalogPath, "utf8"));
    return { result, errors, note, oldCommit, repo: activeSource.repo };
  } catch (error) {
    return { error, errors };
  } finally {
    console.error = originalError;
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
}

test("a manual-setup source with a duplicate nested manifest fails alone with a precise reason", async () => {
  const { result, errors, note, oldCommit, repo } = await refreshManualSetupSource({
    manifestDirectories: ["", "companion"],
  });
  const plugin = result.plugins[0];
  assert.equal(plugin.upstreamCheckStatus, "failed");
  assert.equal(plugin.upstreamCheckError, "manifest-invalid");
  assert.equal(plugin.upstreamObservedCommit, commit);
  assert.equal(plugin.upstreamValidatedCommit, oldCommit);
  assert.equal(plugin.installAvailable, false);
  assert.equal(plugin.installCommand, "");
  assert.equal(plugin.installNote, note);
  assert.deepEqual(result.warnings, [`${repo}: manifest-invalid`]);
  assert.ok(errors.includes("Catalog source refresh failed for example/plugin [manifest-invalid]."));
  assert.ok(!errors.some((line) => line.includes("aborted")));
});

test("a manual-setup source whose only manifest moved below the root fails alone", async () => {
  const { result, note, repo } = await refreshManualSetupSource({
    manifestDirectories: ["companion"],
  });
  const plugin = result.plugins[0];
  assert.equal(plugin.upstreamCheckStatus, "failed");
  assert.equal(plugin.upstreamCheckError, "unsupported-repository-layout");
  assert.equal(plugin.installAvailable, false);
  assert.equal(plugin.installCommand, "");
  assert.equal(plugin.installNote, note);
  assert.deepEqual(result.warnings, [`${repo}: unsupported-repository-layout`]);
});

test("an invalid registry installation override still aborts the refresh and names the source", async () => {
  for (const manifestDirectories of [[""], ["", "companion"]]) {
    const { error, errors } = await refreshManualSetupSource({
      manifestDirectories,
      installation: { mode: "script", note: "Run the installer." },
    });
    assert.match(error?.message || "", /invalid manual installation override/, manifestDirectories.join(","));
    assert.ok(
      errors.includes("Catalog source refresh aborted for example/plugin [internal-error: Error]."),
      manifestDirectories.join(","),
    );
  }
});

test("a built-in source without previous catalog state aborts the refresh and names the source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "marketplace-built-in-abort-"));
  const registryPath = join(directory, "registry.json");
  const catalogPath = join(directory, "site/catalog.json");
  const previewDirectory = join(directory, "site/assets/img/plugins");
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const errors = [];
  await mkdir(previewDirectory, { recursive: true });
  await writeFile(registryPath, `${JSON.stringify({
    sources: [],
    builtInSources: [{
      repo: "https://github.com/example/built-in",
      branch: "main",
      manifestRoot: "shell/plugins",
      exclude: [],
    }],
    placeholders: [],
  }, null, 2)}\n`);
  await writeFile(catalogPath, `${JSON.stringify({
    generatedAt: validatedAt,
    stateSchemaVersion: 2,
    mode: "production",
    plugins: [],
    warnings: [],
  }, null, 2)}\n`);

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === "https://api.github.com/rate_limit") {
      return jsonResponse({
        resources: { core: { limit: 5000, remaining: 4998, reset: 1787997600 } },
      });
    }
    assert.equal(url, "https://api.github.com/graphql");
    const request = JSON.parse(init.body);
    if (request.query.includes("CatalogRefreshBudget")) {
      return jsonResponse({ data: { rateLimit: graphqlRate(4999) } });
    }
    return jsonResponse({
      data: { r0: null, rateLimit: graphqlRate(4998) },
      errors: [{ type: "NOT_FOUND", path: ["r0"], message: "untrusted detail" }],
    });
  };
  console.error = (...args) => errors.push(args.join(" "));

  try {
    await assert.rejects(buildCatalog({
      registryPath,
      catalogPath,
      previewDirectory,
      graphqlBudgetReserve: 0,
    }));
  } finally {
    console.error = originalError;
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
  assert.ok(errors.includes("Built-in catalog refresh aborted for example/built-in [repository-unreachable]."), errors.join("\n"));
});

test("a built-in bar widget is listed with the plugin enable command", async () => {
  const directory = await mkdtemp(join(tmpdir(), "marketplace-built-in-command-"));
  const registryPath = join(directory, "registry.json");
  const catalogPath = join(directory, "site/catalog.json");
  const previewDirectory = join(directory, "site/assets/img/plugins");
  const manifest = JSON.stringify({
    schemaVersion: 1,
    id: "omarchy.clock",
    name: "Clock",
    version: "1.0.0",
    kinds: ["bar-widget"],
    entryPoints: { barWidget: "Widget.qml" },
  });
  const originalFetch = globalThis.fetch;
  await mkdir(previewDirectory, { recursive: true });
  await writeFile(registryPath, `${JSON.stringify({
    sources: [],
    builtInSources: [{
      repo: "https://github.com/example/built-in",
      branch: "main",
      manifestRoot: "shell/plugins",
      exclude: [],
    }],
    placeholders: [],
  }, null, 2)}\n`);
  await writeFile(catalogPath, `${JSON.stringify({
    generatedAt: validatedAt,
    stateSchemaVersion: 2,
    mode: "production",
    plugins: [],
    warnings: [],
  }, null, 2)}\n`);

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === "https://api.github.com/graphql") {
      const request = JSON.parse(init.body);
      if (request.query.includes("CatalogRefreshBudget")) {
        return jsonResponse({ data: { rateLimit: graphqlRate(4999) } });
      }
      return jsonResponse({
        data: {
          r0: {
            ...graphqlRepository({ nameWithOwner: "example/built-in" }),
            configuredRef: { name: "main", target: { oid: commit, tree: { oid: tree } } },
          },
          rateLimit: graphqlRate(4998),
        },
      });
    }
    if (url === "https://api.github.com/rate_limit") {
      return jsonResponse({
        resources: { core: { limit: 5000, remaining: 4998, reset: 1787997600 } },
      });
    }
    if (url === `https://api.github.com/repos/example/built-in/git/trees/${tree}?recursive=1`) {
      return jsonResponse({
        truncated: false,
        tree: [
          { path: "shell/plugins/clock/manifest.json", type: "blob", mode: "100644", size: 200 },
          { path: "shell/plugins/clock/Widget.qml", type: "blob", mode: "100644", size: 10 },
        ],
      });
    }
    if (url === `https://raw.githubusercontent.com/example/built-in/${commit}/shell/plugins/clock/manifest.json`) {
      return new Response(manifest, {
        status: 200,
        headers: { "content-length": String(Buffer.byteLength(manifest)) },
      });
    }
    throw new Error(`Unexpected fixture request: ${url}`);
  };

  try {
    await buildCatalog({
      registryPath,
      catalogPath,
      previewDirectory,
      graphqlBudgetReserve: 0,
    });
    const { plugins } = JSON.parse(await readFile(catalogPath, "utf8"));
    const plugin = plugins.find((entry) => entry.id === "omarchy.clock");
    assert.equal(plugin?.builtIn, true);
    assert.equal(plugin.officialCommand, "omarchy plugin enable omarchy.clock");
    assert.equal(plugin.officialCommandLabel, "Enable plugin");
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("an unchanged full refresh skips REST trees and raw files without refreshing validation time", async () => {
  const directory = await mkdtemp(join(tmpdir(), "marketplace-graphql-fast-path-"));
  const registryPath = join(directory, "registry.json");
  const catalogPath = join(directory, "site/catalog.json");
  const previewDirectory = join(directory, "site/assets/img/plugins");
  const activeSource = source();
  const previousPlugin = priorPlugin(activeSource);
  const previous = {
    generatedAt: "2026-08-28T09:00:00.000Z",
    stateSchemaVersion: 2,
    mode: "production",
    plugins: [previousPlugin],
    warnings: [],
  };
  const originalFetch = globalThis.fetch;
  const urls = [];
  await mkdir(previewDirectory, { recursive: true });
  await writeFile(registryPath, `${JSON.stringify({
    sources: [activeSource],
    builtInSources: [],
    placeholders: [],
  }, null, 2)}\n`);
  await writeFile(catalogPath, `${JSON.stringify(previous, null, 2)}\n`);

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    urls.push(url);
    assert.equal(url, "https://api.github.com/graphql");
    const request = JSON.parse(init.body);
    if (request.query.includes("CatalogRefreshBudget")) {
      return jsonResponse({ data: { rateLimit: graphqlRate(4999) } });
    }
    return jsonResponse({
      data: { r0: graphqlRepository(), rateLimit: graphqlRate(4998) },
    });
  };

  try {
    await buildCatalog({
      registryPath,
      catalogPath,
      previewDirectory,
      graphqlBudgetReserve: 0,
    });
    const result = JSON.parse(await readFile(catalogPath, "utf8"));
    const plugin = result.plugins[0];
    assert.equal(plugin.upstreamValidatedAt, validatedAt);
    assert.notEqual(plugin.upstreamCheckedAt, validatedAt);
    assert.equal(plugin.upstreamValidationVersion, catalogSourceValidationVersion);
    assert.equal(plugin.upstreamSourceFingerprint, catalogSourceFingerprint(activeSource));
    assert.equal(plugin.stars, 12);
    assert.equal(urls.length, 2);
    assert.deepEqual(currentCatalogApiUsage(), {
      graphqlRequests: 2,
      graphqlPoints: 2,
      rawRequests: 0,
      restOtherRequests: 0,
      restRateLimitRequests: 0,
      restTreeRequests: 0,
    });
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("the current registry fits a complete policy revalidation inside the reserved REST budget", async () => {
  const registry = JSON.parse(await readFile(new URL("../registry.json", import.meta.url), "utf8"));
  const sourceCount = (registry.sources || []).length + (registry.builtInSources || []).length;
  assert.ok(sourceCount > 1_600);
  assert.ok(sourceCount + catalogRefreshRestBudgetReserve < 5_000);
});
