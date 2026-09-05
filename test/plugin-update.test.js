import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { inspectListedPluginSource } from "../scripts/build-catalog.mjs";
import {
  assertPluginUpdateInspection,
  assertPluginUpdateListingArchivable,
  buildPluginUpdateValidationReport,
  listingValidationHistoryEntry,
  parsePluginUpdateRequest,
  pluginUpdateAcknowledgment,
  PluginUpdateError,
  promotePluginUpdateSource,
  publicPluginUpdateFailure,
  replacePluginUpdateSource,
  resolvePluginUpdate,
} from "../scripts/plugin-update.mjs";
import {
  securityBaselineEnforcementMode,
  securityBaselineVersion,
} from "../scripts/security-baseline-policy.mjs";
import { buildSecurityBaselineDetails } from "../scripts/security-baseline-report.mjs";
import { upstreamUpdateVerificationAction } from "../scripts/plugin-verification-request.mjs";
import { sourceVerification } from "../scripts/verification-status.mjs";

const oldCommit = "a".repeat(40);
const updateCommit = "b".repeat(40);
const oldCheckedAt = "2026-08-18T10:00:00.000Z";
const promotedAt = "2026-08-20T10:00:00.000Z";

function requestBody(overrides = {}) {
  return [
    "### Verification action",
    "",
    overrides.action || upstreamUpdateVerificationAction,
    "",
    "### Plugin ID",
    "",
    overrides.pluginId || "example.plugin",
    "",
    "### Repository URL",
    "",
    overrides.repoUrl || "https://github.com/example/plugin",
    "",
    "### Target commit",
    "",
    overrides.commitSha || updateCommit,
    "",
    "### Verification acknowledgment",
    "",
    overrides.acknowledgment || `- [x] ${pluginUpdateAcknowledgment}`,
  ].join("\n");
}

function storedBaseline(commit = oldCommit, overrides = {}) {
  return {
    schemaVersion: 1,
    version: securityBaselineVersion,
    repository: "example/plugin",
    pluginIds: ["example.plugin"],
    commit,
    checkedAt: commit === oldCommit ? oldCheckedAt : promotedAt,
    outcome: "passed",
    enforcementMode: securityBaselineEnforcementMode,
    findings: [],
    capabilities: [],
    ...overrides,
  };
}

function maintainerReview(overrides = {}) {
  return {
    schemaVersion: 1,
    repository: "example/plugin",
    pluginIds: ["example.plugin"],
    commit: oldCommit,
    baselineVersion: securityBaselineVersion,
    enforcementMode: securityBaselineEnforcementMode,
    baselineCheckedAt: oldCheckedAt,
    baselineOutcome: "review-required",
    findings: [],
    capabilities: ["privilege"],
    reviewedBaselineCheckedAt: "2026-08-18T08:00:00.000Z",
    requestEventId: 44001,
    requestedAt: "2026-08-18T09:00:00.000Z",
    reviewedAt: "2026-08-18T11:00:00.000Z",
    reviewer: "hancore",
    ...overrides,
  };
}

function listedSource(overrides = {}) {
  return {
    repo: "https://github.com/example/plugin",
    type: "plugin-source",
    addedAt: "2026-08-18",
    listedAt: "2026-08-18T10:00:00.000Z",
    listingValidatedCommit: oldCommit,
    listingValidatedAt: "2026-08-18T10:00:00.000Z",
    listingValidatedBranch: "main",
    automatedSecurityBaseline: storedBaseline(),
    plugins: {
      "example.plugin": { category: "System", tags: ["system"] },
    },
    ...overrides,
  };
}

function baselineLessListedSource(overrides = {}) {
  const source = listedSource(overrides);
  delete source.automatedSecurityBaseline;
  return source;
}

function updateInspection(overrides = {}) {
  return {
    repository: "example/plugin",
    defaultBranch: "main",
    commitSha: updateCommit,
    treeSha: "c".repeat(40),
    manifests: [{
      path: "manifest.json",
      id: "example.plugin",
      name: "Example Plugin",
      version: "2.0.0",
      entryPoints: ["Main.qml"],
    }],
    ...overrides,
  };
}

test("plugin update requests require the exact issue-form contract", () => {
  assert.deepEqual(parsePluginUpdateRequest(requestBody()), {
    action: upstreamUpdateVerificationAction,
    pluginId: "example.plugin",
    repository: "example/plugin",
    repoUrl: "https://github.com/example/plugin",
    commitSha: updateCommit,
  });
  assert.throws(
    () => parsePluginUpdateRequest(requestBody({ commitSha: "abc" })),
    (error) => error instanceof PluginUpdateError && error.code === "update-commit-invalid",
  );
  assert.throws(
    () => parsePluginUpdateRequest(requestBody({ acknowledgment: "- [ ] no" })),
    (error) => error instanceof PluginUpdateError
      && error.code === "update-acknowledgment-missing",
  );
  assert.throws(
    () => parsePluginUpdateRequest(requestBody().replace("### Target commit", "### Commit")),
    (error) => error instanceof PluginUpdateError && error.code === "update-fields-invalid",
  );
  assert.throws(
    () => parsePluginUpdateRequest(requestBody({ action: "Verify the currently listed snapshot" })),
    (error) => error instanceof PluginUpdateError && error.code === "update-action-invalid",
  );
});

test("plugin updates bind repository HEAD and the complete configured plugin set", () => {
  const request = parsePluginUpdateRequest(requestBody());
  const source = listedSource();
  const registry = { sources: [source] };
  const subject = resolvePluginUpdate(registry, request, updateInspection());
  assert.equal(subject.source, source);
  assert.deepEqual(subject.pluginIds, ["example.plugin"]);
  assert.throws(
    () => assertPluginUpdateInspection(
      request,
      source,
      updateInspection({ commitSha: "d".repeat(40) }),
    ),
    (error) => error.code === "update-upstream-changed",
  );
  assert.throws(
    () => assertPluginUpdateInspection(
      request,
      source,
      updateInspection({ manifests: [
        ...updateInspection().manifests,
        { id: "example.extra", path: "extra/manifest.json" },
      ] }),
    ),
    (error) => error.code === "update-plugin-set-changed",
  );
  assert.throws(
    () => resolvePluginUpdate(
      { sources: [listedSource({
        listingValidatedCommit: updateCommit,
        automatedSecurityBaseline: storedBaseline(updateCommit),
      })] },
      request,
      updateInspection(),
    ),
    (error) => error.code === "update-already-current",
  );
});

test("baseline-less legacy listings validate and promote without invented history evidence", () => {
  const source = baselineLessListedSource();
  const request = parsePluginUpdateRequest(requestBody());
  const subject = resolvePluginUpdate({ sources: [source] }, request, updateInspection());
  assert.equal(subject.source, source);
  assert.equal(sourceVerification(source).status, "unverified");

  const historyEntry = listingValidationHistoryEntry(source, promotedAt);
  assert.deepEqual(historyEntry, {
    commit: oldCommit,
    validatedAt: oldCheckedAt,
    branch: "main",
    supersededAt: promotedAt,
  });
  assert.equal(Object.hasOwn(historyEntry, "automatedSecurityBaseline"), false);

  const nextSource = promotePluginUpdateSource(source, updateInspection(), {
    automatedSecurityBaseline: storedBaseline(updateCommit),
    promotedAt,
  });
  assert.deepEqual(nextSource.listingValidationHistory, [historyEntry]);
  assert.equal(nextSource.automatedSecurityBaseline.commit, updateCommit);
  assert.equal(sourceVerification(nextSource).status, "verified");
  assert.equal(Object.hasOwn(source, "automatedSecurityBaseline"), false);
});

test("legacy archival rejects malformed or orphaned trust evidence", () => {
  const request = parsePluginUpdateRequest(requestBody());
  const malformedSources = [
    listedSource({ automatedSecurityBaseline: null }),
    listedSource({ automatedSecurityBaseline: {} }),
    listedSource({
      automatedSecurityBaseline: { ...storedBaseline(), commit: updateCommit },
    }),
    baselineLessListedSource({ maintainerVerificationReview: maintainerReview() }),
    baselineLessListedSource({ maintainerVerificationRevocation: {} }),
    baselineLessListedSource({ maintainerVerificationReviewHistory: [{}] }),
  ];
  for (const source of malformedSources) {
    assert.throws(
      () => resolvePluginUpdate({ sources: [source] }, request, updateInspection()),
      (error) => error.code === "update-listing-invalid",
    );
    assert.throws(
      () => listingValidationHistoryEntry(source, promotedAt),
      (error) => error.code === "update-listing-invalid",
    );
  }
});

test("legacy archival requires complete existing listing provenance before validation", () => {
  for (const source of [
    baselineLessListedSource({ listingValidatedCommit: "abc" }),
    baselineLessListedSource({ listingValidatedAt: "not-a-date" }),
    baselineLessListedSource({ listingValidatedBranch: "" }),
    baselineLessListedSource({ plugins: {} }),
  ]) {
    assert.throws(
      () => assertPluginUpdateListingArchivable(source),
      (error) => error.code === "update-listing-invalid",
    );
  }
});

test("current baseline-less legacy sources are archivable as unverified provenance", async () => {
  const registry = JSON.parse(await readFile(new URL("../registry.json", import.meta.url), "utf8"));
  const sources = registry.sources.filter((source) => (
    source.type === "plugin-source"
    && !Object.hasOwn(source, "automatedSecurityBaseline")
  ));
  for (const source of sources) {
    assert.doesNotThrow(() => assertPluginUpdateListingArchivable(source), source.repo);
    const entry = listingValidationHistoryEntry(source, promotedAt);
    assert.equal(Object.hasOwn(entry, "automatedSecurityBaseline"), false, source.repo);
    assert.equal(Object.hasOwn(entry, "maintainerVerificationReview"), false, source.repo);
    assert.equal(Object.hasOwn(entry, "maintainerVerificationRevocation"), false, source.repo);
  }
});

test("verified update promotion preserves prior evidence and atomically replaces the snapshot", () => {
  const source = listedSource();
  const nextSource = promotePluginUpdateSource(source, updateInspection(), {
    automatedSecurityBaseline: storedBaseline(updateCommit),
    promotedAt,
  });
  assert.equal(nextSource.listingValidatedCommit, updateCommit);
  assert.equal(nextSource.listingValidatedAt, promotedAt);
  assert.equal(nextSource.listingValidatedBranch, "main");
  assert.equal(nextSource.automatedSecurityBaseline.commit, updateCommit);
  assert.equal(nextSource.maintainerVerificationReview, undefined);
  assert.deepEqual(nextSource.listingValidationHistory, [
    listingValidationHistoryEntry(source, promotedAt),
  ]);
  assert.equal(
    nextSource.listingValidationHistory[0].automatedSecurityBaseline,
    source.automatedSecurityBaseline,
  );
  assert.equal(sourceVerification(nextSource).status, "verified");

  const registry = { sources: [source], retiredPluginIds: [] };
  const nextRegistry = replacePluginUpdateSource(registry, source, nextSource);
  assert.equal(nextRegistry.sources[0], nextSource);
  assert.deepEqual(nextRegistry.retiredPluginIds, []);
  assert.equal(registry.sources[0], source);
});

test("plugin update history preserves revoked review evidence and clears it from the active snapshot", () => {
  const review = maintainerReview();
  const revocation = {
    schemaVersion: 1,
    repository: review.repository,
    pluginIds: review.pluginIds,
    commit: review.commit,
    requestEventId: review.requestEventId,
    revocationEventId: 44002,
    revokedBy: "hancore",
    revokedAt: "2026-08-18T12:00:00.000Z",
    reason: "approval-applied-in-error",
  };
  const source = listedSource({
    automatedSecurityBaseline: storedBaseline(oldCommit, {
      outcome: "review-required",
      capabilities: ["privilege"],
    }),
    maintainerVerificationReview: review,
    maintainerVerificationRevocation: revocation,
  });
  const nextSource = promotePluginUpdateSource(source, updateInspection(), {
    automatedSecurityBaseline: storedBaseline(updateCommit),
    promotedAt,
  });
  assert.equal(nextSource.maintainerVerificationReview, undefined);
  assert.equal(nextSource.maintainerVerificationRevocation, undefined);
  assert.deepEqual(nextSource.listingValidationHistory, [
    listingValidationHistoryEntry(source, promotedAt),
  ]);
  assert.deepEqual(nextSource.listingValidationHistory[0].maintainerVerificationReview, review);
  assert.deepEqual(nextSource.listingValidationHistory[0].maintainerVerificationRevocation, revocation);
  assert.throws(
    () => listingValidationHistoryEntry({
      ...source,
      maintainerVerificationRevocation: { ...revocation, revocationEventId: 0 },
    }, promotedAt),
    (error) => error.code === "update-listing-invalid",
  );
  assert.throws(
    () => listingValidationHistoryEntry({
      ...source,
      maintainerVerificationReview: undefined,
    }, promotedAt),
    (error) => error.code === "update-listing-invalid",
  );
  const validHistoryEntry = listingValidationHistoryEntry(source, promotedAt);
  assert.throws(
    () => promotePluginUpdateSource({
      ...source,
      listingValidationHistory: [{
        ...validHistoryEntry,
        automatedSecurityBaseline: { ...storedBaseline(oldCommit), commit: updateCommit },
      }],
    }, updateInspection(), {
      automatedSecurityBaseline: storedBaseline(updateCommit),
      promotedAt,
    }),
    (error) => error.code === "update-history-invalid",
  );
});

test("plugin updates preserve legacy baseline history while requiring current replacement evidence", () => {
  const legacySource = listedSource({
    automatedSecurityBaseline: {
      version: "2",
      commit: oldCommit,
      checkedAt: oldCheckedAt,
      outcome: "passed",
      enforcementMode: "review-only",
      findings: [],
      capabilities: [],
    },
  });
  const nextSource = promotePluginUpdateSource(legacySource, updateInspection(), {
    automatedSecurityBaseline: storedBaseline(updateCommit),
    promotedAt,
  });
  assert.equal(nextSource.listingValidationHistory[0].automatedSecurityBaseline.version, "2");
  assert.equal(sourceVerification(nextSource).status, "verified");
});

test("plugin update promotion rejects unverified or same-commit evidence", () => {
  assert.throws(
    () => promotePluginUpdateSource(listedSource(), updateInspection(), {
      automatedSecurityBaseline: storedBaseline(updateCommit, {
        outcome: "needs-fixes",
        findings: ["remote-download-execution"],
      }),
      promotedAt,
    }),
    (error) => error.code === "update-verification-invalid",
  );
  assert.throws(
    () => promotePluginUpdateSource(
      listedSource({ listingValidatedCommit: updateCommit }),
      updateInspection(),
      { automatedSecurityBaseline: storedBaseline(updateCommit), promotedAt },
    ),
    (error) => error.code === "update-already-current",
  );
});

test("listed-source inspection reads current HEAD without executing community code", async () => {
  const source = listedSource();
  const treeSha = "c".repeat(40);
  const manifest = {
    schemaVersion: 1,
    id: "example.plugin",
    name: "Example Plugin",
    version: "2.0.0",
    author: "Example",
    description: "Example update",
    license: "MIT",
    kinds: ["service"],
    entryPoints: { service: "Main.qml" },
  };
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url === "https://api.github.com/repos/example/plugin") {
      return new Response(JSON.stringify({
        private: false,
        disabled: false,
        archived: false,
        default_branch: "main",
      }), { status: 200 });
    }
    if (url === "https://api.github.com/repos/example/plugin/commits/main") {
      return new Response(JSON.stringify({
        sha: updateCommit,
        commit: { tree: { sha: treeSha } },
      }), { status: 200 });
    }
    if (url === `https://api.github.com/repos/example/plugin/git/trees/${treeSha}?recursive=1`) {
      return new Response(JSON.stringify({
        truncated: false,
        tree: [
          { path: "manifest.json", type: "blob", mode: "100644", size: 300 },
          { path: "Main.qml", type: "blob", mode: "100644", size: 20 },
        ],
      }), { status: 200 });
    }
    if (url === `https://raw.githubusercontent.com/example/plugin/${updateCommit}/manifest.json`) {
      return new Response(JSON.stringify(manifest), {
        status: 200,
        headers: { "content-length": String(Buffer.byteLength(JSON.stringify(manifest))) },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    const inspection = await inspectListedPluginSource(source);
    assert.equal(inspection.commitSha, updateCommit);
    assert.deepEqual(inspection.manifests.map((item) => item.id), ["example.plugin"]);
    assert.equal(requests.some((url) => url.includes("actions") || url.includes("workflows")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("plugin update reports are exact-commit, actionable, and fail closed", () => {
  const request = parsePluginUpdateRequest(requestBody());
  const report = buildPluginUpdateValidationReport({
    ...assertPluginUpdateInspection(request, listedSource(), updateInspection()),
    request,
  });
  assert.match(report, /marketplace-update-validation/);
  assert.match(report, /Ready for verified update review/);
  assert.match(report, new RegExp(updateCommit.slice(0, 7)));
  assert.match(
    buildSecurityBaselineDetails({
      commitSha: updateCommit,
      outcome: "needs-fixes",
      findings: [{
        title: "Finding",
        ruleId: "finding",
        why: "Why",
        evidence: [{ path: "Main.qml", line: 1, snippet: "bad" }],
        actions: ["Fix it"],
      }],
    }, { context: "update" }),
    /selectively blocking findings that cannot be accepted through `approved-and-verified`/,
  );
  assert.equal(
    publicPluginUpdateFailure({ code: "update-plugin-set-changed" }).code,
    "update-plugin-set-changed",
  );
});

test("plugin update workflows preserve read-only analysis and atomic publication boundaries", async () => {
  const root = new URL("../", import.meta.url);
  const [validation, approval, issueRouter, updateScript, validationScript, baselineCli, issueForm] = await Promise.all([
    readFile(new URL(".github/workflows/validate-plugin-update.yml", root), "utf8"),
    readFile(new URL(".github/workflows/approve-submission.yml", root), "utf8"),
    readFile(new URL(".github/workflows/route-issue-automation.yml", root), "utf8"),
    readFile(new URL("scripts/approve-plugin-update.mjs", root), "utf8"),
    readFile(new URL("scripts/validate-plugin-update.mjs", root), "utf8"),
    readFile(new URL("scripts/security-baseline.mjs", root), "utf8"),
    readFile(new URL(".github/ISSUE_TEMPLATE/verify-plugin.yml", root), "utf8"),
  ]);
  assert.match(issueRouter, /types: \[opened, edited, reopened, labeled, unlabeled\]/);
  assert.match(validation, /workflow_call:/);
  assert.match(validation, /startsWith\(github\.event\.issue\.title, '\[Verify\]:'\)/);
  assert.match(validation, /name: Route exact verification action[\s\S]*\^### Verification action[\s\S]*Verify and publish a newer upstream commit[\s\S]*action=\$\{action\}/);
  assert.match(validation, /analyze:[\s\S]*if: needs\.route\.outputs\.action == 'update'[\s\S]*needs: route/);
  assert.doesNotMatch(validation, /^concurrency:/m);
  assert.match(validation, /analyze:[\s\S]*group: issue-validation-\$\{\{ github\.event\.issue\.number \}\}[\s\S]*queue: max/);
  assert.match(validation, /publish:[\s\S]*needs\.mutation-route\.outputs\.group == format\('issue-validation-\{0\}'[\s\S]*queue: max/);
  assert.match(validation, /publish-fallback:[\s\S]*group: plugin-catalog-writes[\s\S]*steps: \*update-mutation-steps/);
  assert.doesNotMatch(validation, /\n  report-failure:\n/);
  assert.match(validation, /permissions:\s+contents: read\s+issues: read/);
  assert.match(validation, /npm ci[\s\S]*validate-plugin-update\.mjs[\s\S]*security-baseline\.mjs/);
  assert.ok(
    validationScript.indexOf("const source = sourceForPluginUpdate(registry, request);")
      < validationScript.indexOf("inspection = await inspectListedPluginSource(source);"),
    "legacy listing archival must be prechecked before upstream inspection",
  );
  assert.match(validation, /actions\/upload-artifact@[a-f0-9]{40}/);
  assert.match(validation, /actions\/download-artifact@[a-f0-9]{40}/);
  assert.equal((validation.match(/GH_REPO: \$\{\{ github\.repository \}\}/g) || []).length, 2);
  assert.match(validation, /sha256sum --check SHA256SUMS/);
  assert.match(validation, /remove_issue_label approved-and-verified/);
  assert.match(validation, /remove_issue_label maintainer-verified/);
  assert.match(validation, /Confirm failed run still matches the issue[\s\S]*skipping stale failure mutations/);
  const publishJob = validation.slice(
    validation.indexOf("\n  publish:\n"),
    validation.indexOf("\n  publish-fallback:\n"),
  );
  assert.match(publishJob, /guard-issue-mutation[\s\S]*approved-and-verified/);
  assert.match(publishJob, /requires_global_fallback/);
  assert.match(publishJob, /env\.MUTATION_CONCURRENCY_GROUP == 'plugin-catalog-writes'/);
  assert.doesNotMatch(publishJob, /result == 'cancelled'/);
  assert.match(validation, /\.title == \$title[\s\S]*\(\.body \/\/ ""\) == \$body/);
  assert.match(validation, /\.verifiedPublicationDisposition/);
  assert.doesNotMatch(validation, /contents: write|push origin/);

  assert.match(approval, /contains\(github\.event\.issue\.labels\.\*\.name, 'plugin-update'\)/);
  assert.match(approval, /node scripts\/approve-plugin-update\.mjs/);
  assert.match(approval, /PUBLICATION_KIND[\s\S]*Update \$\{PLUGIN_NAME\} plugin/);
  assert.match(approval, /required_type_label=plugin-update/);
  assert.match(updateScript, /runSecurityBaseline[\s\S]*listedPlugins:[\s\S]*manifestPathHint: manifest\.path[\s\S]*createApprovedVerificationEvidence/);
  assert.match(validationScript, /listedPlugins:[\s\S]*pluginId: manifest\.id[\s\S]*manifestPathHint: manifest\.path/);
  assert.match(baselineCli, /listedPlugins: metadata\.listedPlugins/);
  assert.match(updateScript, /promotePluginUpdateSource[\s\S]*replacePluginUpdateSource/);
  assert.match(updateScript, /expectedBaselineCommentId[\s\S]*allowCurrentCommit: true/);
  assert.doesNotMatch(updateScript, /child_process|exec\(|spawn\(|shell:/);

  assert.match(issueForm, /title: "\[Verify\]: "/);
  assert.match(issueForm, /label: Verification action[\s\S]*Verify the currently listed snapshot[\s\S]*Verify and publish a newer upstream commit/);
  assert.match(issueForm, /label: Target commit/);
  assert.match(issueForm, new RegExp(pluginUpdateAcknowledgment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
