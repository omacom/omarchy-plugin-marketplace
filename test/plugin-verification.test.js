import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  analyzeListedPluginVerification,
  buildVerificationReport,
  listedSourceForRequest,
  revokeMaintainerVerification,
  parseVerificationRequest,
  PluginVerificationError,
  updateCatalogVerification,
  verificationAcknowledgment,
  verificationBaselineRecord,
  verificationReviewRecord,
} from "../scripts/verify-listed-plugin.mjs";
import {
  securityBaselineEnforcementMode,
  securityBaselineVersion,
} from "../scripts/security-baseline-policy.mjs";
import { catalogVerificationFields } from "../scripts/catalog-verification.mjs";
import { sourceVerification } from "../scripts/verification-status.mjs";
import {
  legacyListedSnapshotAcknowledgment,
  listedSnapshotVerificationAction,
  standardInstallationAcknowledgment,
  standardInstallationVerificationAction,
} from "../scripts/plugin-verification-request.mjs";
import {
  maintainerVerificationRevocationReason,
  parseMaintainerVerificationExpectation,
} from "../scripts/verification-review.mjs";

const commit = "a".repeat(40);
const otherCommit = "b".repeat(40);
const reviewRequestEventId = 44001;
const reviewedBaselineCheckedAt = "2026-08-16T11:00:00.000Z";
const reviewRequestedAt = "2026-08-16T11:30:00.000Z";
const checkedAt = "2026-08-16T12:00:00.000Z";
const reviewedAt = "2026-08-16T13:00:00.000Z";
const execute = promisify(execFile);

function workflowStepScript(workflow, name) {
  const stepStart = workflow.indexOf(`      - name: ${name}\n`);
  assert.notEqual(stepStart, -1, `Missing workflow step: ${name}`);
  const runMarker = "        run: |\n";
  const scriptStart = workflow.indexOf(runMarker, stepStart) + runMarker.length;
  assert.ok(scriptStart >= runMarker.length, `Missing run script: ${name}`);
  const lines = [];
  for (const line of workflow.slice(scriptStart).split("\n")) {
    if (line.startsWith("          ")) lines.push(line.slice(10));
    else if (!line) lines.push("");
    else break;
  }
  return lines.join("\n");
}

function requestBody(overrides = {}) {
  return [
    "### Verification action",
    "",
    overrides.action || listedSnapshotVerificationAction,
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
    overrides.commitSha || commit,
    "",
    "### Verification acknowledgment",
    "",
    overrides.acknowledgment || `- [x] ${verificationAcknowledgment}`,
  ].join("\n");
}

function standardInstallationRequestBody(overrides = {}) {
  return [
    "### Verification action",
    "",
    standardInstallationVerificationAction,
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
    overrides.commitSha || commit,
    "",
    "### Verification acknowledgment",
    "",
    overrides.acknowledgment || `- [x] ${verificationAcknowledgment}`,
    "",
    "### Standard installation acknowledgment",
    "",
    overrides.standardAcknowledgment || `- [x] ${standardInstallationAcknowledgment}`,
  ].join("\n");
}

function legacyRequestBody() {
  return [
    "### Plugin ID",
    "",
    "example.plugin",
    "",
    "### Repository URL",
    "",
    "https://github.com/example/plugin",
    "",
    "### Listed commit",
    "",
    commit,
    "",
    "### Verification acknowledgment",
    "",
    `- [x] ${legacyListedSnapshotAcknowledgment}`,
  ].join("\n");
}

function source(overrides = {}) {
  return {
    repo: "https://github.com/example/plugin",
    type: "plugin-source",
    addedAt: "2026-08-01",
    listedAt: "2026-08-01T10:00:00.000Z",
    listingValidatedCommit: commit,
    listingValidatedAt: "2026-08-01T10:00:00.000Z",
    listingValidatedBranch: "main",
    plugins: { "example.plugin": { category: "System", tags: ["system"] } },
    ...overrides,
  };
}

function baseline(overrides = {}) {
  return {
    schemaVersion: 1,
    baselineVersion: securityBaselineVersion,
    repository: "example/plugin",
    repoUrl: "https://github.com/example/plugin",
    commitSha: commit,
    checkedAt,
    outcome: "passed",
    enforcementMode: securityBaselineEnforcementMode,
    blocksApproval: false,
    findings: [],
    capabilities: [],
    pluginIds: ["example.plugin"],
    ...overrides,
  };
}

function storedBaseline(overrides = {}) {
  return {
    schemaVersion: 1,
    version: securityBaselineVersion,
    repository: "example/plugin",
    pluginIds: ["example.plugin"],
    commit,
    checkedAt,
    outcome: "passed",
    enforcementMode: securityBaselineEnforcementMode,
    findings: [],
    capabilities: [],
    ...overrides,
  };
}

function storedReviewBaseline(overrides = {}) {
  return storedBaseline({
    outcome: "review-required",
    capabilities: ["privilege", "package-manager"],
    ...overrides,
  });
}

function reviewedBaseline(overrides = {}) {
  return storedReviewBaseline({ checkedAt: reviewedBaselineCheckedAt, ...overrides });
}

function storedReview(baselineRecord = storedReviewBaseline(), overrides = {}) {
  return {
    schemaVersion: 1,
    repository: baselineRecord.repository,
    pluginIds: baselineRecord.pluginIds,
    commit: baselineRecord.commit,
    baselineVersion: baselineRecord.version,
    enforcementMode: baselineRecord.enforcementMode,
    baselineCheckedAt: baselineRecord.checkedAt,
    baselineOutcome: baselineRecord.outcome,
    findings: baselineRecord.findings,
    capabilities: baselineRecord.capabilities,
    reviewedBaselineCheckedAt,
    requestEventId: reviewRequestEventId,
    requestedAt: reviewRequestedAt,
    reviewedAt,
    reviewer: "hancore",
    ...overrides,
  };
}

function standardInstallationApproval(overrides = {}) {
  return {
    reviewer: "hancore",
    requestEventId: 44002,
    requestedAt: reviewRequestedAt,
    ...overrides,
  };
}

function storedRevocation(review = storedReview(), overrides = {}) {
  return {
    schemaVersion: 1,
    repository: review.repository,
    pluginIds: review.pluginIds,
    commit: review.commit,
    requestEventId: review.requestEventId,
    revocationEventId: review.requestEventId + 100,
    revokedBy: "hancore",
    revokedAt: "2026-08-16T14:00:00.000Z",
    reason: maintainerVerificationRevocationReason,
    ...overrides,
  };
}

function catalog() {
  return {
    generatedAt: "2026-08-16T10:00:00.000Z",
    stateSchemaVersion: 1,
    mode: "production",
    plugins: [{
      id: "example.plugin",
      name: "Example",
      repo: "https://github.com/example/plugin",
      sourceType: "community",
      manifestPath: "manifest.json",
    }, {
      id: "other.plugin",
      name: "Other",
      repo: "https://github.com/other/plugin",
      sourceType: "community",
      verificationStatus: "unverified",
    }],
    warnings: [],
  };
}

test("verification status is derived only from current exact commit-bound evidence", () => {
  const verifiedSource = source({ automatedSecurityBaseline: storedBaseline() });
  assert.deepEqual(sourceVerification(verifiedSource), {
    status: "verified",
    method: "automated",
    baselineVersion: securityBaselineVersion,
    commit,
    checkedAt,
  });
  assert.deepEqual(sourceVerification(source({ automatedSecurityBaseline: {
    ...storedBaseline(),
    schemaVersion: undefined,
    repository: undefined,
    pluginIds: undefined,
  } })), {
    status: "verified",
    method: "automated",
    baselineVersion: securityBaselineVersion,
    commit,
    checkedAt,
  });
  assert.deepEqual(catalogVerificationFields(verifiedSource), {
    verificationStatus: "verified",
    verificationSnapshotStatus: "verified",
    verificationCoverage: "snapshot-verified",
    verificationBaselineVersion: securityBaselineVersion,
    verificationCommit: commit,
    verificationCheckedAt: checkedAt,
  });
  assert.deepEqual(catalogVerificationFields(verifiedSource, {
    upstreamObservedCommit: otherCommit,
  }), {
    verificationStatus: "unverified",
    verificationSnapshotStatus: "verified",
    verificationCoverage: "update-unverified",
    verificationBaselineVersion: securityBaselineVersion,
    verificationCommit: commit,
    verificationCheckedAt: checkedAt,
  });

  assert.deepEqual(sourceVerification(source({
    automatedSecurityBaseline: storedBaseline(),
    listingValidationHistory: [{}],
  })), { status: "unverified" });

  for (const automatedSecurityBaseline of [
    null,
    storedBaseline({ version: String(Number(securityBaselineVersion) - 1) }),
    storedBaseline({ enforcementMode: "review-only" }),
    storedBaseline({ outcome: "review-required", capabilities: ["service-management"] }),
    storedBaseline({ outcome: "needs-fixes", findings: ["curl-pipe-shell"] }),
    storedBaseline({ commit: otherCommit }),
    storedBaseline({ repository: undefined }),
    storedBaseline({ pluginIds: undefined }),
    storedBaseline({ repository: "other/plugin" }),
    storedBaseline({ pluginIds: ["other.plugin"] }),
    storedBaseline({ checkedAt: "not-a-date" }),
    storedBaseline({ findings: null }),
    storedBaseline({ capabilities: null }),
  ]) {
    assert.deepEqual(sourceVerification(source({ automatedSecurityBaseline })), {
      status: "unverified",
    });
  }
});

test("maintainer verification is exact-review-bound and limited to review-required", () => {
  const reviewBaseline = storedReviewBaseline();
  const review = verificationReviewRecord(reviewBaseline, {
    reviewedBaseline: reviewedBaseline(),
    reviewer: "hancore",
    requestEventId: reviewRequestEventId,
    requestedAt: reviewRequestedAt,
    reviewedAt,
  });
  assert.deepEqual(review, storedReview(reviewBaseline));
  const reviewedSource = source({
    automatedSecurityBaseline: reviewBaseline,
    maintainerVerificationReview: review,
  });
  assert.deepEqual(sourceVerification(reviewedSource), {
    status: "verified",
    method: "maintainer-reviewed",
    baselineVersion: securityBaselineVersion,
    commit,
    checkedAt,
    reviewedAt,
    reviewer: "hancore",
  });
  assert.deepEqual(catalogVerificationFields(reviewedSource), {
    verificationStatus: "verified",
    verificationSnapshotStatus: "verified",
    verificationCoverage: "snapshot-verified",
    verificationBaselineVersion: securityBaselineVersion,
    verificationCommit: commit,
    verificationCheckedAt: checkedAt,
    verificationMethod: "maintainer-reviewed",
    verificationReviewedAt: reviewedAt,
    verificationReviewedBy: "hancore",
  });

  for (const maintainerVerificationReview of [
    null,
    storedReview(reviewBaseline, { schemaVersion: 2 }),
    storedReview(reviewBaseline, { repository: "other/plugin" }),
    storedReview(reviewBaseline, { pluginIds: ["other.plugin"] }),
    storedReview(reviewBaseline, { commit: otherCommit }),
    storedReview(reviewBaseline, { baselineVersion: "999" }),
    storedReview(reviewBaseline, { enforcementMode: "review-only" }),
    storedReview(reviewBaseline, { baselineCheckedAt: reviewedAt }),
    storedReview(reviewBaseline, { baselineOutcome: "passed" }),
    storedReview(reviewBaseline, { findings: ["curl-pipe-shell"] }),
    storedReview(reviewBaseline, { capabilities: ["privilege"] }),
    storedReview(reviewBaseline, { reviewedBaselineCheckedAt: reviewedAt }),
    storedReview(reviewBaseline, { requestEventId: 0 }),
    storedReview(reviewBaseline, { requestEventId: "44001" }),
    storedReview(reviewBaseline, { requestedAt: "not-a-date" }),
    storedReview(reviewBaseline, { requestedAt: "2026-08-16T13:00:00.001Z" }),
    storedReview(reviewBaseline, { reviewedAt: "2026-08-16T11:59:59.999Z" }),
    storedReview(reviewBaseline, { reviewer: "not a login" }),
  ]) {
    assert.deepEqual(sourceVerification(source({
      automatedSecurityBaseline: reviewBaseline,
      maintainerVerificationReview,
    })), { status: "unverified" });
  }

  for (const ineligible of [
    storedBaseline(),
    storedBaseline({ outcome: "needs-fixes", findings: ["curl-pipe-shell"] }),
    storedReviewBaseline({ checkedAt: "2026-08-16T11:15:00.000Z" }),
  ]) {
    assert.throws(
      () => verificationReviewRecord(ineligible, {
        reviewedBaseline: reviewedBaseline(),
        reviewer: "hancore",
        requestEventId: reviewRequestEventId,
        requestedAt: reviewRequestedAt,
        reviewedAt,
      }),
      (error) => new Set([
        "verification-review-invalid",
        "verification-review-expectation-mismatch",
      ]).has(error.code),
    );
  }
});

test("revoked maintainer reviews fail closed and require a later label event", async () => {
  const reviewBaseline = storedReviewBaseline();
  const review = storedReview(reviewBaseline);
  const revocation = storedRevocation(review);
  const revokedSource = source({
    automatedSecurityBaseline: reviewBaseline,
    maintainerVerificationReview: review,
    maintainerVerificationRevocation: revocation,
  });
  assert.deepEqual(sourceVerification(revokedSource), { status: "unverified" });
  assert.deepEqual(catalogVerificationFields(revokedSource), {
    verificationStatus: "unverified",
    verificationSnapshotStatus: "unverified",
    verificationCoverage: "unverified",
  });
  assert.deepEqual(sourceVerification({
    ...source({
      automatedSecurityBaseline: reviewBaseline,
      maintainerVerificationReview: review,
    }),
    maintainerVerificationReviewHistory: [{}],
  }), { status: "unverified" });

  for (const invalidRevocation of [
    null,
    { ...revocation, schemaVersion: 2 },
    { ...revocation, repository: "other/plugin" },
    { ...revocation, pluginIds: ["other.plugin"] },
    { ...revocation, commit: otherCommit },
    { ...revocation, requestEventId: reviewRequestEventId + 1 },
    { ...revocation, revocationEventId: reviewRequestEventId },
    { ...revocation, revokedBy: "not a login" },
    { ...revocation, revokedAt: reviewedAt },
    { ...revocation, reason: "wrong-reason" },
    { ...revocation, extra: true },
  ]) {
    assert.deepEqual(sourceVerification({
      ...revokedSource,
      maintainerVerificationRevocation: invalidRevocation,
    }), { status: "unverified" });
  }

  const staleReview = await analyzeListedPluginVerification({
    body: requestBody(),
    registry: { sources: [revokedSource] },
    catalog: catalog(),
    maintainerReview: {
      reviewer: "hancore",
      requestEventId: reviewRequestEventId,
      requestedAt: reviewRequestedAt,
      expectation: reviewedBaseline(),
    },
    runBaseline: async () => baseline({
      outcome: "review-required",
      capabilities: [
        { id: "privilege", evidence: [{ path: "README.md", line: 26 }] },
        { id: "package-manager", evidence: [{ path: "README.md", line: 26 }] },
      ],
    }),
  });
  assert.equal(staleReview.status, "unverified");
  assert.equal(staleReview.revocationEventMismatch, true);
  assert.match(buildVerificationReport(staleReview), /previous maintainer review was revoked/);

  const malformedRevocationSource = {
    ...revokedSource,
    maintainerVerificationRevocation: { ...revocation, revocationEventId: 0 },
  };
  const malformedRescan = await analyzeListedPluginVerification({
    body: requestBody(),
    registry: { sources: [malformedRevocationSource] },
    catalog: catalog(),
    runBaseline: async () => baseline(),
  });
  assert.equal(malformedRescan.status, "unverified");
  assert.equal(malformedRescan.revocationInvalid, true);
  assert.equal(malformedRescan.changed, false);
  assert.equal(malformedRescan.registry.sources[0], malformedRevocationSource);

  const malformedReviewSource = source({
    automatedSecurityBaseline: storedBaseline(),
    maintainerVerificationReview: {},
  });
  const malformedReviewRescan = await analyzeListedPluginVerification({
    body: requestBody(),
    registry: { sources: [malformedReviewSource] },
    catalog: catalog(),
    runBaseline: async () => baseline(),
  });
  assert.equal(malformedReviewRescan.status, "unverified");
  assert.equal(malformedReviewRescan.reviewInvalid, true);
  assert.equal(malformedReviewRescan.changed, false);

  const malformedHistorySource = {
    ...revokedSource,
    maintainerVerificationReviewHistory: null,
  };
  const malformedHistoryReplacement = await analyzeListedPluginVerification({
    body: requestBody(),
    registry: { sources: [malformedHistorySource] },
    catalog: catalog(),
    maintainerReview: {
      reviewer: "hancore",
      requestEventId: revocation.revocationEventId + 1,
      requestedAt: "2026-08-16T14:30:00.000Z",
      expectation: reviewedBaseline({ checkedAt: "2026-08-16T14:00:00.000Z" }),
    },
    now: () => "2026-08-16T15:00:00.000Z",
    runBaseline: async () => baseline({
      checkedAt: "2026-08-16T14:45:00.000Z",
      outcome: "review-required",
      capabilities: [
        { id: "privilege", evidence: [{ path: "README.md", line: 26 }] },
        { id: "package-manager", evidence: [{ path: "README.md", line: 26 }] },
      ],
    }),
  });
  assert.equal(malformedHistoryReplacement.status, "unverified");
  assert.equal(malformedHistoryReplacement.reviewHistoryInvalid, true);
  assert.equal(malformedHistoryReplacement.changed, false);

  const replacement = await analyzeListedPluginVerification({
    body: requestBody(),
    registry: { sources: [revokedSource] },
    catalog: catalog(),
    maintainerReview: {
      reviewer: "hancore",
      requestEventId: revocation.revocationEventId + 1,
      requestedAt: "2026-08-16T14:30:00.000Z",
      expectation: reviewedBaseline({ checkedAt: "2026-08-16T14:00:00.000Z" }),
    },
    now: () => "2026-08-16T15:00:00.000Z",
    runBaseline: async () => baseline({
      checkedAt: "2026-08-16T14:45:00.000Z",
      outcome: "review-required",
      capabilities: [
        { id: "privilege", evidence: [{ path: "README.md", line: 26 }] },
        { id: "package-manager", evidence: [{ path: "README.md", line: 26 }] },
      ],
    }),
  });
  assert.equal(replacement.status, "verified");
  assert.equal(replacement.verification.method, "maintainer-reviewed");
  assert.equal(Object.hasOwn(replacement.source, "maintainerVerificationRevocation"), false);
  assert.equal(replacement.source.maintainerVerificationReview.requestEventId, revocation.revocationEventId + 1);
  assert.deepEqual(replacement.source.maintainerVerificationReviewHistory, [{
    maintainerVerificationReview: review,
    maintainerVerificationRevocation: revocation,
  }]);
});

test("removing maintainer verification creates an exact event-bound revocation", () => {
  const reviewBaseline = storedReviewBaseline();
  const review = storedReview(reviewBaseline);
  const reviewedSource = source({
    automatedSecurityBaseline: reviewBaseline,
    maintainerVerificationReview: review,
  });
  const result = revokeMaintainerVerification({
    body: "edited by issue author",
    registry: { sources: [reviewedSource] },
    catalog: catalog(),
    reviewRequestEventId,
    revocation: {
      revocationEventId: reviewRequestEventId + 100,
      revokedBy: "hancore",
      revokedAt: "2026-08-16T14:00:00.000Z",
    },
    now: () => "2026-08-16T14:00:01.000Z",
  });
  assert.equal(result.status, "revoked");
  assert.equal(result.changed, true);
  assert.equal(result.source.maintainerVerificationRevocation.revocationEventId, reviewRequestEventId + 100);
  assert.deepEqual(sourceVerification(result.source), { status: "unverified" });
  assert.equal(result.catalog.plugins[0].verificationStatus, "unverified");

  const replay = revokeMaintainerVerification({
    body: "different edited body",
    registry: result.registry,
    catalog: result.catalog,
    reviewRequestEventId,
    revocation: {
      revocationEventId: reviewRequestEventId + 100,
      revokedBy: "hancore",
      revokedAt: "2026-08-16T14:00:00.000Z",
    },
  });
  assert.equal(replay.status, "already-revoked");
  assert.equal(replay.changed, false);
});

test("verification requests require the exact issue-form contract", () => {
  assert.deepEqual(parseVerificationRequest(requestBody()), {
    action: listedSnapshotVerificationAction,
    pluginId: "example.plugin",
    repository: "example/plugin",
    repoUrl: "https://github.com/example/plugin",
    commitSha: commit,
  });
  assert.throws(
    () => parseVerificationRequest(requestBody({ pluginId: "Example Plugin" })),
    (error) => error instanceof PluginVerificationError
      && error.code === "verification-plugin-id-invalid",
  );
  assert.throws(
    () => parseVerificationRequest(requestBody({ repoUrl: "https://example.com/plugin" })),
    (error) => error.code === "verification-repository-invalid",
  );
  assert.throws(
    () => parseVerificationRequest(requestBody({ commitSha: "abc123" })),
    (error) => error.code === "verification-commit-invalid",
  );
  assert.throws(
    () => parseVerificationRequest(requestBody({ acknowledgment: `- [ ] ${verificationAcknowledgment}` })),
    (error) => error.code === "verification-acknowledgment-missing",
  );
  assert.throws(
    () => parseVerificationRequest(requestBody().replace("### Repository URL", "### Repository")),
    (error) => error.code === "verification-fields-invalid",
  );
  assert.throws(
    () => parseVerificationRequest(requestBody({ action: "Verify and publish a newer upstream commit" })),
    (error) => error.code === "verification-action-invalid",
  );
  assert.deepEqual(parseVerificationRequest(legacyRequestBody()), {
    action: listedSnapshotVerificationAction,
    pluginId: "example.plugin",
    repository: "example/plugin",
    repoUrl: "https://github.com/example/plugin",
    commitSha: commit,
  });
  assert.deepEqual(parseVerificationRequest(standardInstallationRequestBody()), {
    action: standardInstallationVerificationAction,
    pluginId: "example.plugin",
    repository: "example/plugin",
    repoUrl: "https://github.com/example/plugin",
    commitSha: commit,
  });
  assert.throws(
    () => parseVerificationRequest(standardInstallationRequestBody({ standardAcknowledgment: "- [ ] not confirmed" })),
    (error) => error.code === "verification-standard-installation-acknowledgment-missing",
  );
});

test("standard installation verification removes only an eligible manual root override", async () => {
  const manualSource = source({
    plugins: {
      "example.plugin": {
        category: "System",
        tags: ["system"],
        manifestPath: "manifest.json",
        installation: { mode: "manual", note: "Requires extra setup." },
      },
    },
  });
  const manualCatalog = catalog();
  manualCatalog.plugins[0] = {
    ...manualCatalog.plugins[0],
    repositoryLayout: "root-plugin",
    upstreamCheckStatus: "passed",
    installAvailable: false,
    installCommand: "",
    installNote: "Requires extra setup.",
    status: "Manual setup",
  };
  await assert.rejects(
    analyzeListedPluginVerification({
      body: standardInstallationRequestBody(),
      registry: { sources: [manualSource] },
      catalog: manualCatalog,
      runBaseline: async () => assert.fail("unauthorized standard installation must fail before scanning"),
    }),
    (error) => error.code === "verification-standard-installation-authorization-missing",
  );
  const result = await analyzeListedPluginVerification({
    body: standardInstallationRequestBody(),
    registry: { sources: [manualSource] },
    catalog: manualCatalog,
    runBaseline: async () => baseline(),
    standardInstallationApproval: standardInstallationApproval(),
  });
  assert.equal(result.status, "verified");
  assert.equal(result.installationChanged, true);
  assert.equal(result.registry.sources[0].plugins["example.plugin"].installation, undefined);
  assert.equal(result.catalog.plugins[0].installAvailable, true);
  assert.equal(result.catalog.plugins[0].installCommand, "omarchy plugin add https://github.com/example/plugin.git --enable");
  assert.equal(result.catalog.plugins[0].status, "Available");
  assert.match(result.catalog.plugins[0].installNote, /clones the current upstream repository/);
  assert.match(buildVerificationReport(result), /manual installation override was removed/);
});

test("standard installation does not rewrite a duplicate ID from another repository", async () => {
  const manualSource = source({
    plugins: {
      "example.plugin": {
        category: "System",
        tags: ["system"],
        manifestPath: "manifest.json",
        installation: { mode: "manual", note: "Requires extra setup." },
      },
    },
  });
  const manualCatalog = catalog();
  manualCatalog.plugins[0] = {
    ...manualCatalog.plugins[0],
    repositoryLayout: "root-plugin",
    upstreamCheckStatus: "passed",
    installAvailable: false,
    installCommand: "",
    installNote: "Requires extra setup.",
    status: "Manual setup",
  };
  const unrelated = {
    ...manualCatalog.plugins[0],
    repo: "https://github.com/other/plugin",
    installAvailable: false,
    installCommand: "",
    installNote: "Unrelated manual setup.",
    status: "Manual setup",
  };
  manualCatalog.plugins.push(unrelated);
  const result = await analyzeListedPluginVerification({
    body: standardInstallationRequestBody(),
    registry: { sources: [manualSource] },
    catalog: manualCatalog,
    runBaseline: async () => baseline(),
    standardInstallationApproval: standardInstallationApproval(),
  });
  assert.equal(result.status, "verified");
  assert.equal(result.catalog.plugins[0].installAvailable, true);
  assert.deepEqual(result.catalog.plugins.at(-1), unrelated);
});

test("standard installation verification fails closed for non-passing or ineligible requests", async () => {
  const manualSource = source({
    plugins: {
      "example.plugin": {
        category: "System",
        tags: ["system"],
        manifestPath: "manifest.json",
        installation: { mode: "manual", note: "Requires extra setup." },
      },
    },
  });
  const manualCatalog = catalog();
  const rejected = await analyzeListedPluginVerification({
    body: standardInstallationRequestBody(),
    registry: { sources: [manualSource] },
    catalog: manualCatalog,
    runBaseline: async () => baseline({
      outcome: "review-required",
      capabilities: [{ id: "installer" }],
    }),
    standardInstallationApproval: standardInstallationApproval(),
  });
  assert.equal(rejected.status, "unverified");
  assert.equal(rejected.standardInstallationRejected, true);
  assert.equal(rejected.code, "verification-standard-installation-evidence-required");
  await assert.rejects(
    analyzeListedPluginVerification({
      body: standardInstallationRequestBody(),
      registry: { sources: [source()] },
      catalog: catalog(),
      runBaseline: async () => assert.fail("ineligible request must fail before scanning"),
      standardInstallationApproval: standardInstallationApproval(),
    }),
    (error) => error.code === "verification-standard-installation-ineligible",
  );
  for (const installation of [
    { mode: "manual" },
    { mode: "manual", note: "" },
    { mode: "manual", note: "valid", extra: true },
  ]) {
    const malformedSource = source({
      plugins: {
        "example.plugin": {
          category: "System",
          tags: ["system"],
          manifestPath: "manifest.json",
          installation,
        },
      },
    });
    await assert.rejects(
      analyzeListedPluginVerification({
        body: standardInstallationRequestBody(),
        registry: { sources: [malformedSource] },
        catalog: catalog(),
        runBaseline: async () => assert.fail("malformed override must fail before scanning"),
        standardInstallationApproval: standardInstallationApproval(),
      }),
      (error) => error.code === "verification-standard-installation-ineligible",
    );
  }
  const failedCompatibilityCatalog = catalog();
  failedCompatibilityCatalog.plugins[0] = {
    ...failedCompatibilityCatalog.plugins[0],
    repositoryLayout: "root-plugin",
    upstreamCheckStatus: "failed",
    status: "Compatibility failed",
  };
  await assert.rejects(
    analyzeListedPluginVerification({
      body: standardInstallationRequestBody(),
      registry: { sources: [manualSource] },
      catalog: failedCompatibilityCatalog,
      runBaseline: async () => baseline(),
      standardInstallationApproval: standardInstallationApproval(),
    }),
    (error) => error.code === "verification-standard-installation-compatibility-failed",
  );
  const nestedCatalog = catalog();
  nestedCatalog.plugins[0] = {
    ...nestedCatalog.plugins[0],
    manifestPath: "nested/manifest.json",
    repositoryLayout: "root-plugin",
    upstreamCheckStatus: "passed",
    installAvailable: false,
    installCommand: "",
    installNote: "Requires extra setup.",
    status: "Manual setup",
  };
  await assert.rejects(
    analyzeListedPluginVerification({
      body: standardInstallationRequestBody(),
      registry: { sources: [manualSource] },
      catalog: nestedCatalog,
      runBaseline: async () => baseline(),
      standardInstallationApproval: standardInstallationApproval(),
    }),
    (error) => error.code === "verification-standard-installation-catalog-mismatch",
  );
});

test("verification requests must match one existing registry source exactly", () => {
  const registry = { sources: [source()] };
  const request = parseVerificationRequest(requestBody());
  assert.equal(listedSourceForRequest(registry, request), registry.sources[0]);
  const suite = source({ type: "suite", plugins: {}, catalog: { id: "example.plugin" } });
  assert.throws(
    () => listedSourceForRequest({ sources: [suite] }, request),
    (error) => error.code === "verification-source-unsupported",
  );
  assert.throws(
    () => listedSourceForRequest(registry, { ...request, pluginId: "missing.plugin" }),
    (error) => error.code === "verification-plugin-not-listed",
  );
  assert.throws(
    () => listedSourceForRequest(registry, { ...request, repository: "other/plugin" }),
    (error) => error.code === "verification-repository-mismatch",
  );
  assert.throws(
    () => listedSourceForRequest(registry, { ...request, commitSha: otherCommit }),
    (error) => error.code === "verification-commit-mismatch",
  );
});

test("verification fails closed for a non-community catalog entry", async () => {
  for (const sourceType of ["suite", null, "", false]) {
    const nonCommunityCatalog = catalog();
    nonCommunityCatalog.plugins[0] = {
      ...nonCommunityCatalog.plugins[0],
      sourceType,
    };
    await assert.rejects(
      analyzeListedPluginVerification({
        body: requestBody(),
        registry: { sources: [source()] },
        catalog: nonCommunityCatalog,
        runBaseline: async () => assert.fail("non-community catalog entries must not be scanned"),
      }),
      (error) => error.code === "verification-catalog-listing-missing",
    );
  }
});

test("shell suites are explicitly outside the first plugin-source verification workflow", async () => {
  const suite = source({ type: "suite", plugins: {}, catalog: { id: "example.plugin" } });
  await assert.rejects(
    analyzeListedPluginVerification({
      body: requestBody(),
      registry: { sources: [suite] },
      catalog: catalog(),
      runBaseline: async () => assert.fail("unsupported suites must not be scanned"),
    }),
    (error) => error.code === "verification-source-unsupported",
  );
});

test("a passing baseline updates only the matching source and catalog plugins", async () => {
  const originalSource = source();
  const registry = {
    sources: [originalSource, source({
      repo: "https://github.com/other/plugin",
      listingValidatedCommit: otherCommit,
      plugins: { "other.plugin": { category: "Other", tags: ["system"] } },
    })],
  };
  const originalCatalog = catalog();
  let calls = 0;
  const result = await analyzeListedPluginVerification({
    body: requestBody(),
    registry,
    catalog: originalCatalog,
    token: "test-token",
    runBaseline: async (repoUrl, commitSha, options) => {
      calls++;
      assert.equal(repoUrl, originalSource.repo);
      assert.equal(commitSha, commit);
      assert.equal(options.token, "test-token");
      assert.deepEqual(options.listedPlugins, [{
        pluginId: "example.plugin",
        manifestPathHint: "manifest.json",
      }]);
      return baseline();
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.status, "verified");
  assert.equal(result.changed, true);
  assert.deepEqual(result.registry.sources[0].automatedSecurityBaseline, storedBaseline());
  assert.equal(result.registry.sources[1], registry.sources[1]);
  assert.equal(result.catalog.generatedAt, checkedAt);
  assert.deepEqual(result.catalog.plugins[0], {
    ...originalCatalog.plugins[0],
    verificationStatus: "verified",
    verificationSnapshotStatus: "verified",
    verificationCoverage: "snapshot-verified",
    verificationBaselineVersion: securityBaselineVersion,
    verificationCommit: commit,
    verificationCheckedAt: checkedAt,
  });
  assert.equal(result.catalog.plugins[1], originalCatalog.plugins[1]);

  await assert.rejects(
    analyzeListedPluginVerification({
      body: requestBody(),
      registry,
      catalog: {
        ...originalCatalog,
        plugins: originalCatalog.plugins.filter((plugin) => plugin.id !== "example.plugin"),
      },
      runBaseline: async () => baseline(),
    }),
    (error) => error.code === "verification-catalog-listing-missing",
  );
});

test("non-passing baselines stay unchanged and current baselines repair stale catalogs", async () => {
  const registry = { sources: [source()] };
  const originalCatalog = catalog();
  const reviewResult = await analyzeListedPluginVerification({
    body: requestBody(),
    registry,
    catalog: originalCatalog,
    runBaseline: async () => baseline({
      outcome: "review-required",
      capabilities: [{ id: "service-management" }],
    }),
  });
  assert.equal(reviewResult.status, "unverified");
  assert.equal(reviewResult.changed, false);
  assert.equal(reviewResult.registry, registry);
  assert.equal(reviewResult.catalog, originalCatalog);

  const accepted = await analyzeListedPluginVerification({
    body: requestBody(),
    registry,
    catalog: originalCatalog,
    maintainerReview: {
      reviewer: "hancore",
      requestEventId: reviewRequestEventId,
      requestedAt: reviewRequestedAt,
      expectation: reviewedBaseline(),
    },
    now: () => reviewedAt,
    runBaseline: async () => baseline({
      outcome: "review-required",
      capabilities: [
        { id: "privilege", evidence: [{ path: "README.md", line: 26 }] },
        { id: "package-manager", evidence: [{ path: "README.md", line: 26 }] },
      ],
    }),
  });
  assert.equal(accepted.status, "verified");
  assert.equal(accepted.changed, true);
  assert.equal(accepted.verification.method, "maintainer-reviewed");
  assert.deepEqual(accepted.registry.sources[0].automatedSecurityBaseline, storedReviewBaseline());
  assert.deepEqual(
    accepted.registry.sources[0].maintainerVerificationReview,
    storedReview(),
  );
  assert.deepEqual(accepted.catalog.plugins[0], {
    ...originalCatalog.plugins[0],
    verificationStatus: "verified",
    verificationSnapshotStatus: "verified",
    verificationCoverage: "snapshot-verified",
    verificationBaselineVersion: securityBaselineVersion,
    verificationCommit: commit,
    verificationCheckedAt: checkedAt,
    verificationMethod: "maintainer-reviewed",
    verificationReviewedAt: reviewedAt,
    verificationReviewedBy: "hancore",
  });

  const mismatchedCapabilities = await analyzeListedPluginVerification({
    body: requestBody(),
    registry,
    catalog: originalCatalog,
    maintainerReview: {
      reviewer: "hancore",
      requestEventId: reviewRequestEventId,
      requestedAt: reviewRequestedAt,
      expectation: reviewedBaseline({ capabilities: ["privilege"] }),
    },
    now: () => reviewedAt,
    runBaseline: async () => baseline({
      outcome: "review-required",
      capabilities: [{
        id: "privilege",
        title: "Privilege request",
        why: "The instructions use sudo.",
        evidence: [{ path: "README.md", line: 26, snippet: "sudo pacman -S example" }],
      }, {
        id: "package-manager",
        title: "Package management",
        why: "The instructions use pacman.",
        evidence: [{ path: "README.md", line: 26, snippet: "sudo pacman -S example" }],
      }],
    }),
  });
  assert.equal(mismatchedCapabilities.status, "unverified");
  assert.equal(mismatchedCapabilities.changed, false);
  assert.equal(mismatchedCapabilities.reviewExpectationMismatch, true);
  const mismatchReport = buildVerificationReport(mismatchedCapabilities);
  assert.match(mismatchReport, /differs from the report that was approved/);
  assert.match(mismatchReport, /review this updated report, then remove and reapply/);
  assert.doesNotMatch(mismatchReport, /edit the open issue or reopen it/);
  assert.deepEqual(
    parseMaintainerVerificationExpectation(mismatchReport).capabilities,
    ["privilege", "package-manager"],
  );

  const rejectedFinding = await analyzeListedPluginVerification({
    body: requestBody(),
    registry,
    catalog: originalCatalog,
    maintainerReview: {
      reviewer: "hancore",
      requestEventId: reviewRequestEventId,
      requestedAt: reviewRequestedAt,
      expectation: reviewedBaseline(),
    },
    now: () => reviewedAt,
    runBaseline: async () => baseline({
      outcome: "needs-fixes",
      findings: [{
        ruleId: "curl-pipe-shell",
        title: "Remote script execution",
        why: "A downloaded script is piped directly into a shell.",
        evidence: [{ path: "install.sh", line: 12, snippet: "curl https://example.test/install.sh | bash" }],
        actions: ["Download and verify the script before execution."],
      }],
    }),
  });
  assert.equal(rejectedFinding.status, "unverified");
  assert.equal(rejectedFinding.changed, false);
  assert.equal(rejectedFinding.maintainerReviewRequested, true);
  assert.equal(rejectedFinding.registry, registry);
  assert.equal(rejectedFinding.catalog, originalCatalog);
  const rejectedReport = buildVerificationReport(rejectedFinding);
  assert.doesNotMatch(rejectedReport, /marketplace-maintainer-verification-expectation:v1/);
  assert.match(rejectedReport, /edit the open issue or reopen it to run normal verification/);
  assert.match(rejectedReport, /Only after the bot publishes a new eligible `review-required` report/);

  const staleReviewSource = source({
    automatedSecurityBaseline: storedReviewBaseline(),
    maintainerVerificationReview: storedReview(storedReviewBaseline(), { commit: otherCommit }),
  });
  const replacedReview = await analyzeListedPluginVerification({
    body: requestBody(),
    registry: { sources: [staleReviewSource] },
    catalog: originalCatalog,
    runBaseline: async () => baseline(),
  });
  assert.equal(replacedReview.status, "unverified");
  assert.equal(replacedReview.reviewInvalid, true);
  assert.equal(replacedReview.changed, false);
  assert.equal(replacedReview.registry.sources[0], staleReviewSource);
  assert.equal(
    Object.hasOwn(replacedReview.registry.sources[0], "maintainerVerificationReview"),
    true,
  );

  const verifiedRegistry = {
    sources: [source({ automatedSecurityBaseline: storedBaseline() })],
  };
  const repaired = await analyzeListedPluginVerification({
    body: requestBody(),
    registry: verifiedRegistry,
    catalog: originalCatalog,
    runBaseline: async () => assert.fail("an already verified source must not be fetched"),
    now: () => checkedAt,
  });
  assert.equal(repaired.status, "verified");
  assert.equal(repaired.changed, true);
  assert.equal(repaired.registry, verifiedRegistry);
  assert.equal(repaired.catalog.generatedAt, checkedAt);
  assert.deepEqual(repaired.catalog.plugins[0], {
    ...originalCatalog.plugins[0],
    verificationStatus: "verified",
    verificationSnapshotStatus: "verified",
    verificationCoverage: "snapshot-verified",
    verificationBaselineVersion: securityBaselineVersion,
    verificationCommit: commit,
    verificationCheckedAt: checkedAt,
  });

  const buildOrderedCatalog = catalog();
  buildOrderedCatalog.plugins[0] = {
    id: "example.plugin",
    name: "Example",
    repo: "https://github.com/example/plugin",
    sourceType: "community",
    ...catalogVerificationFields(verifiedRegistry.sources[0]),
    manifestPath: "manifest.json",
  };
  const current = await analyzeListedPluginVerification({
    body: requestBody(),
    registry: verifiedRegistry,
    catalog: buildOrderedCatalog,
    runBaseline: async () => assert.fail("an already verified source must not be fetched"),
  });
  assert.equal(current.status, "already-verified");
  assert.equal(current.changed, false);
  assert.equal(current.catalog, buildOrderedCatalog);
});

test("baseline records reject repository, commit, version, and summary tampering", () => {
  const listedSource = source();
  assert.deepEqual(verificationBaselineRecord(baseline(), listedSource), storedBaseline());
  for (const invalid of [
    baseline({ repository: "other/plugin" }),
    baseline({ commitSha: otherCommit }),
    baseline({ baselineVersion: "999" }),
    baseline({ checkedAt: "invalid" }),
    baseline({ outcome: "passed", findings: [{ ruleId: "curl-pipe-shell" }] }),
    baseline({ findings: [{}] }),
    baseline({ findings: [null] }),
    baseline({ findings: null }),
    baseline({ capabilities: {} }),
    baseline({ capabilities: [{ id: "" }] }),
    baseline({ capabilities: [{ id: " service-management" }] }),
    baseline({ pluginIds: [] }),
    baseline({ pluginIds: ["other.plugin"] }),
  ]) {
    assert.throws(
      () => verificationBaselineRecord(invalid, listedSource),
      (error) => error.code === "verification-baseline-invalid",
    );
  }
});

test("catalog verification refresh removes stale derived fields", () => {
  const staleCatalog = catalog();
  staleCatalog.plugins[0] = {
    ...staleCatalog.plugins[0],
    verificationStatus: "verified",
    verificationBaselineVersion: "1",
    verificationCommit: otherCommit,
    verificationCheckedAt: checkedAt,
    verificationMethod: "maintainer-reviewed",
    verificationReviewedAt: reviewedAt,
    verificationReviewedBy: "other",
  };
  const updated = updateCatalogVerification(staleCatalog, source());
  assert.deepEqual(updated.plugins[0], {
    id: "example.plugin",
    name: "Example",
    repo: "https://github.com/example/plugin",
    sourceType: "community",
    manifestPath: "manifest.json",
    verificationStatus: "unverified",
    verificationSnapshotStatus: "unverified",
    verificationCoverage: "unverified",
  });

  assert.throws(
    () => updateCatalogVerification({
      ...staleCatalog,
      plugins: [
        ...staleCatalog.plugins,
        {
          id: "example.stale",
          repo: "https://github.com/example/plugin",
          sourceType: "community",
          manifestPath: "stale/manifest.json",
        },
      ],
    }, source()),
    (error) => error.code === "verification-catalog-plugin-set-mismatch",
  );
});

test("multi-plugin repositories use one explicit source-wide verification subject", async () => {
  const multiSource = source({
    plugins: {
      "example.plugin": { category: "Desktop", tags: ["overlay"], manifestPath: "manifest.json" },
      "example.second": { category: "System", tags: ["system"], manifestPath: "second/manifest.json" },
    },
  });
  const multiCatalog = {
    ...catalog(),
    plugins: [
      catalog().plugins[0],
      {
        id: "example.second",
        name: "Second",
        repo: multiSource.repo,
        sourceType: "community",
        manifestPath: "current-second/manifest.json",
      },
    ],
  };
  const result = await analyzeListedPluginVerification({
    body: requestBody(),
    registry: { sources: [multiSource] },
    catalog: multiCatalog,
    runBaseline: async (repoUrl, commitSha, options) => {
      assert.deepEqual(options.listedPlugins, [
        { pluginId: "example.plugin", manifestPathHint: "manifest.json" },
        { pluginId: "example.second", manifestPathHint: "second/manifest.json" },
      ]);
      return baseline({ pluginIds: ["example.plugin", "example.second"] });
    },
  });
  assert.deepEqual(result.subject.pluginIds, ["example.plugin", "example.second"]);
  assert.ok(result.catalog.plugins.every((plugin) => plugin.verificationStatus === "verified"));
  assert.match(buildVerificationReport(result), /source-wide result applies to: `example\.plugin`, `example\.second`/);
});

test("verification reports preserve finding evidence and accepted remediation", () => {
  const request = parseVerificationRequest(requestBody());
  const report = buildVerificationReport({
    status: "unverified",
    request,
    baseline: storedBaseline({
      outcome: "needs-fixes",
      findings: ["curl-pipe-shell"],
    }),
    scanResult: baseline({
      outcome: "needs-fixes",
      findings: [{
        ruleId: "curl-pipe-shell",
        title: "Downloaded content is passed directly to a shell",
        why: "Downloaded source is executed immediately.",
        actions: ["Remove the download-and-execute path."],
        evidence: [{ path: "install.sh", line: 4, snippet: "curl example.test | sh" }],
      }],
    }),
  });
  assert.match(report, /curl-pipe-shell/);
  assert.match(report, /install\.sh:4/);
  assert.match(report, /Downloaded source is executed immediately/);
  assert.match(report, /Remove the download-and-execute path/);
  assert.match(report, /Only a later `passed` baseline can produce `Verified`/);
  assert.equal(parseMaintainerVerificationExpectation(report), null);
  assert.doesNotMatch(report, /\bapproval\b|\bapprove\b|maintainer review/i);

  const capabilityReport = buildVerificationReport({
    status: "unverified",
    request,
    baseline: storedBaseline({
      outcome: "review-required",
      capabilities: ["service-management"],
    }),
    scanResult: baseline({
      outcome: "review-required",
      capabilities: [{
        id: "service-management",
        title: "Service management",
        why: "The plugin controls a service.",
        evidence: [{ path: "service.sh", line: 2, snippet: "systemctl --user restart example" }],
      }],
    }),
  });
  assert.match(capabilityReport, /authorized marketplace maintainer may accept these capabilities/);
  assert.deepEqual(
    parseMaintainerVerificationExpectation(capabilityReport).capabilities,
    ["service-management"],
  );
  assert.doesNotMatch(capabilityReport, /\bapproval\b|\bapprove\b/i);
});

test("verification reports state the exact-commit boundary and required disclaimer", () => {
  const request = parseVerificationRequest(requestBody());
  const verified = buildVerificationReport({
    status: "verified",
    request,
    baseline: storedBaseline(),
  });
  assert.match(verified, /✅ \*\*Verified\*\*/);
  assert.match(verified, /exact listed commit/);
  assert.match(verified, /not a security audit, certification, warranty, or endorsement/);

  const maintainerReviewed = buildVerificationReport({
    status: "verified",
    request,
    baseline: storedReviewBaseline(),
    maintainerReview: storedReview(),
    verification: {
      status: "verified",
      method: "maintainer-reviewed",
      reviewer: "hancore",
      reviewedAt,
    },
  });
  assert.match(maintainerReviewed, /marketplace maintainer reviewed and accepted/);
  assert.match(maintainerReviewed, /Review basis: `maintainer-reviewed` by `hancore`/);
  assert.match(maintainerReviewed, /Accepted findings: none/);
  assert.match(maintainerReviewed, /Accepted capabilities: `privilege`, `package-manager`/);
  assert.match(maintainerReviewed, /exact listed commit/);

  const selectivelyReviewed = buildVerificationReport({
    status: "already-verified",
    request,
    baseline: storedReviewBaseline({
      outcome: "needs-fixes",
      findings: ["curl-pipe-shell"],
      capabilities: [],
    }),
    verification: {
      status: "verified",
      method: "maintainer-reviewed",
      reviewer: "hancore",
      reviewedAt,
    },
  });
  assert.match(selectivelyReviewed, /Accepted findings: `curl-pipe-shell`/);
  assert.match(selectivelyReviewed, /Accepted capabilities: none/);

  const unverified = buildVerificationReport({
    status: "unverified",
    request,
    baseline: storedBaseline({ outcome: "review-required", capabilities: ["service-management"] }),
  });
  assert.match(unverified, /⚪ \*\*Unverified\*\*/);
  assert.match(unverified, /review-required/);
});

test("queued already-verified reports preserve completed and failed workflow state", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/verify-plugin.yml", import.meta.url),
    "utf8",
  );
  const script = workflowStepScript(workflow, "Publish verification result");
  const directory = await mkdtemp(join(tmpdir(), "plugin-verification-report-race-"));
  const issuePath = join(directory, "issue.json");
  const commentsPath = join(directory, "comments.json");
  const statusIdsPath = join(directory, "status-ids.txt");
  const ghPath = join(directory, "gh");
  const title = "[Verify]: Example";
  const body = requestBody();
  await writeFile(ghPath, [
    "#!/bin/sh",
    "case \"$*\" in",
    "  *--slurp*comments*) cat \"$FAKE_COMMENTS_PATH\" ;;",
    "  *comments*) cat \"$FAKE_STATUS_IDS_PATH\" ;;",
    "  *) cat \"$FAKE_ISSUE_PATH\" ;;",
    "esac",
    "",
  ].join("\n"));
  await chmod(ghPath, 0o755);

  const run = (result) => execute("bash", ["-c", script], {
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      FAKE_ISSUE_PATH: issuePath,
      FAKE_COMMENTS_PATH: commentsPath,
      FAKE_STATUS_IDS_PATH: statusIdsPath,
      GITHUB_REPOSITORY: "example/marketplace",
      ISSUE_NUMBER: "1",
      RESULT: result,
      PLUGIN_ID: "example.plugin",
      COMMIT_SHA: commit,
      EXPECTED_TITLE: title,
      EXPECTED_BODY: body,
      REVOCATION_REQUESTED: "false",
      RUNNER_TEMP: directory,
    },
  });

  const closedIssue = (closedBy = "github-actions[bot]") => ({
    state: "closed",
    state_reason: "completed",
    closed_by: { login: closedBy },
    title,
    body,
  });
  const verifiedComment = {
    id: 101,
    created_at: "2026-08-16T12:01:00.000Z",
    user: { login: "github-actions[bot]" },
    body: `<!-- marketplace-plugin-verification -->\n✅ **Verified** \`example.plugin\` at listed commit \`${commit.slice(0, 7)}…\`.`,
  };

  try {
    await writeFile(statusIdsPath, "");
    await writeFile(issuePath, JSON.stringify(closedIssue()));
    await writeFile(commentsPath, JSON.stringify([[verifiedComment]]));
    const duplicate = await run("already-verified");
    assert.match(duplicate.stdout, /closed by an earlier completed run; skipping duplicate reporting/);

    await writeFile(issuePath, JSON.stringify(closedIssue("example-user")));
    await assert.rejects(
      run("already-verified"),
      (error) => error.code === 1
        && /Verification issue is no longer open/.test(error.stderr),
    );

    await writeFile(issuePath, JSON.stringify(closedIssue()));
    await writeFile(commentsPath, "[[]]");
    await assert.rejects(
      run("already-verified"),
      (error) => error.code === 1
        && /no matching completed bot report/.test(error.stderr),
    );

    await writeFile(issuePath, JSON.stringify({
      ...closedIssue(),
      body: `${body}\nchanged`,
    }));
    await assert.rejects(
      run("already-verified"),
      (error) => error.code === 1
        && /Verification issue body changed before reporting/.test(error.stderr),
    );

    await writeFile(issuePath, JSON.stringify({ state: "open", title, body }));
    await writeFile(statusIdsPath, "9001\n");
    const priorFailure = await run("already-verified");
    assert.match(priorFailure.stdout, /preserving its status and leaving the issue open/);
    const revokedRetry = await run("already-revoked");
    assert.match(revokedRetry.stdout, /preserving its status and leaving the issue open/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function revokedReviewEvidence(source, revocationEventId) {
  const historicalEntries = [
    ...(source.listingValidationHistory || []),
    ...(source.maintainerVerificationReviewHistory || []),
  ];
  const historicalEntry = historicalEntries.find((entry) => (
    entry.maintainerVerificationRevocation?.revocationEventId === revocationEventId
  ));
  const evidence = historicalEntry || source;
  return {
    review: evidence.maintainerVerificationReview,
    revocation: evidence.maintainerVerificationRevocation,
  };
}

test("archived revocation evidence remains paired after a fresh review", () => {
  const archivedReview = { requestEventId: 100 };
  const archivedRevocation = { requestEventId: 100, revocationEventId: 200 };
  const evidence = revokedReviewEvidence({
    maintainerVerificationReview: { requestEventId: 300 },
    maintainerVerificationReviewHistory: [{
      maintainerVerificationReview: archivedReview,
      maintainerVerificationRevocation: archivedRevocation,
    }],
  }, 200);
  assert.equal(evidence.review, archivedReview);
  assert.equal(evidence.revocation, archivedRevocation);
});

test("automatic update supersedes an archived revocation", () => {
  const archivedBaseline = storedReviewBaseline();
  const archivedReview = storedReview(archivedBaseline);
  const archivedRevocation = storedRevocation(archivedReview);
  const updatedCheckedAt = "2026-08-16T16:00:00.000Z";
  const updatedSource = source({
    listingValidatedCommit: otherCommit,
    listingValidatedAt: "2026-08-16T15:00:00.000Z",
    automatedSecurityBaseline: storedBaseline({
      commit: otherCommit,
      checkedAt: updatedCheckedAt,
    }),
    listingValidationHistory: [{
      commit,
      validatedAt: "2026-08-01T10:00:00.000Z",
      branch: "main",
      supersededAt: "2026-08-16T15:00:00.000Z",
      automatedSecurityBaseline: archivedBaseline,
      maintainerVerificationReview: archivedReview,
      maintainerVerificationRevocation: archivedRevocation,
    }],
  });
  assert.deepEqual(sourceVerification(updatedSource), {
    status: "verified",
    method: "automated",
    baselineVersion: securityBaselineVersion,
    commit: otherCommit,
    checkedAt: updatedCheckedAt,
  });
  assert.deepEqual(catalogVerificationFields(updatedSource, {
    upstreamObservedCommit: otherCommit,
  }), {
    verificationStatus: "verified",
    verificationSnapshotStatus: "verified",
    verificationCoverage: "snapshot-verified",
    verificationBaselineVersion: securityBaselineVersion,
    verificationCommit: otherCommit,
    verificationCheckedAt: updatedCheckedAt,
  });
});

test("fresh maintainer review preserves update-unverified status after archived revocation", () => {
  const archivedBaseline = storedReviewBaseline();
  const archivedReview = storedReview(archivedBaseline, {
    requestEventId: 44000,
    requestedAt: "2026-08-16T11:30:00.000Z",
    reviewedAt: "2026-08-16T13:00:00.000Z",
  });
  const archivedRevocation = storedRevocation(archivedReview, {
    revocationEventId: 44002,
    revokedAt: "2026-08-16T14:00:00.000Z",
  });
  const freshBaseline = storedReviewBaseline({ checkedAt: "2026-08-16T16:00:00.000Z" });
  const freshReview = storedReview(freshBaseline, {
    reviewedBaselineCheckedAt: "2026-08-16T14:30:00.000Z",
    requestEventId: 44003,
    requestedAt: "2026-08-16T15:00:00.000Z",
    reviewedAt: "2026-08-16T17:00:00.000Z",
  });
  const reviewedSource = source({
    automatedSecurityBaseline: freshBaseline,
    maintainerVerificationReview: freshReview,
    maintainerVerificationReviewHistory: [{
      maintainerVerificationReview: archivedReview,
      maintainerVerificationRevocation: archivedRevocation,
    }],
  });
  assert.ok(freshReview.requestEventId > archivedRevocation.revocationEventId);
  assert.ok(Date.parse(freshReview.reviewedBaselineCheckedAt) > Date.parse(archivedRevocation.revokedAt));
  assert.ok(Date.parse(freshReview.reviewedBaselineCheckedAt) < Date.parse(freshReview.requestedAt));
  assert.equal(sourceVerification(reviewedSource).status, "verified");
  assert.deepEqual(catalogVerificationFields(reviewedSource, {
    upstreamObservedCommit: otherCommit,
  }), {
    verificationStatus: "unverified",
    verificationSnapshotStatus: "verified",
    verificationCoverage: "update-unverified",
    verificationBaselineVersion: securityBaselineVersion,
    verificationCommit: commit,
    verificationCheckedAt: freshBaseline.checkedAt,
    verificationMethod: "maintainer-reviewed",
    verificationReviewedAt: freshReview.reviewedAt,
    verificationReviewedBy: freshReview.reviewer,
  });
});

test("the four accidental maintainer reviews are explicitly revoked", async () => {
  const registry = JSON.parse(await readFile(new URL("../registry.json", import.meta.url), "utf8"));
  const catalog = JSON.parse(await readFile(new URL("../site/catalog.json", import.meta.url), "utf8"));
  const expected = new Map([
    ["im0001gt.hw-tooltip", { revocationEventId: 29801291060, activeStatus: "unverified" }],
    ["im0001gt.screens", { revocationEventId: 29801292367, activeStatus: "verified" }],
    ["mateusfl.todoist", { revocationEventId: 29801293608, activeStatus: "unverified" }],
    ["nosignal.quattro-command", { revocationEventId: 29801294912, activeStatus: "unverified" }],
  ]);
  const sources = registry.sources.filter((entry) => (
    Object.keys(entry.plugins || {}).some((pluginId) => expected.has(pluginId))
  ));
  assert.equal(sources.length, expected.size);
  for (const source of sources) {
    const pluginId = Object.keys(source.plugins).find((id) => expected.has(id));
    const expectedEvidence = expected.get(pluginId);
    const { review, revocation } = revokedReviewEvidence(source, expectedEvidence.revocationEventId);
    assert.ok(review);
    assert.ok(revocation);
    assert.equal(revocation.repository, review.repository);
    assert.deepEqual(revocation.pluginIds, review.pluginIds);
    assert.equal(revocation.commit, review.commit);
    assert.equal(revocation.requestEventId, review.requestEventId);
    assert.equal(revocation.revocationEventId, expectedEvidence.revocationEventId);
    assert.equal(revocation.revokedBy, "HANCORE-linux");
    assert.equal(revocation.reason, maintainerVerificationRevocationReason);
    const verification = sourceVerification(source);
    // A verification workflow may have archived the revoked evidence after
    // either a fresh review of the same snapshot or a verified newer listing.
    const hasFreshReview = source.maintainerVerificationReview?.requestEventId > revocation.revocationEventId;
    const hasSupersedingListing = source.listingValidatedCommit.toLowerCase() !== revocation.commit.toLowerCase();
    const expectedStatus = hasFreshReview || hasSupersedingListing
      ? "verified"
      : expectedEvidence.activeStatus;
    assert.equal(verification.status, expectedStatus);
    if (expectedStatus === "unverified") assert.deepEqual(verification, { status: "unverified" });
    const listed = catalog.plugins.filter((plugin) => plugin.id === pluginId);
    assert.equal(listed.length, 1);
    const catalogFields = catalogVerificationFields(source, listed[0]);
    if (expectedStatus === "unverified") {
      assert.deepEqual(catalogFields, {
        verificationStatus: "unverified",
        verificationSnapshotStatus: "unverified",
        verificationCoverage: "unverified",
      });
    } else {
      const observedCommit = String(
        listed[0].upstreamObservedCommit || listed[0].upstreamValidatedCommit || "",
      ).toLowerCase();
      const updateUnverified = /^[a-f0-9]{40}$/.test(observedCommit)
        && observedCommit !== verification.commit.toLowerCase();
      assert.equal(catalogFields.verificationStatus, updateUnverified ? "unverified" : "verified");
      assert.equal(catalogFields.verificationSnapshotStatus, "verified");
      assert.equal(
        catalogFields.verificationCoverage,
        updateUnverified ? "update-unverified" : "snapshot-verified",
      );
      assert.equal(catalogFields.verificationCommit, source.listingValidatedCommit);
    }
  }
});

test("verification issue, workflow, and documentation preserve automatic publication safeguards", async () => {
  const root = new URL("../", import.meta.url);
  const [form, workflow, issueRouter, guide, policy, readme, submissionGuide] = await Promise.all([
    readFile(new URL(".github/ISSUE_TEMPLATE/verify-plugin.yml", root), "utf8"),
    readFile(new URL(".github/workflows/verify-plugin.yml", root), "utf8"),
    readFile(new URL(".github/workflows/route-issue-automation.yml", root), "utf8"),
    readFile(new URL("VERIFICATION.md", root), "utf8"),
    readFile(new URL("SECURITY.md", root), "utf8"),
    readFile(new URL("README.md", root), "utf8"),
    readFile(new URL("SUBMISSION.md", root), "utf8"),
  ]);
  const readmeNavSpecs = [
    { name: "develop.png", sourceWidth: 416, sourceHeight: 160, displayWidth: 104 },
    { name: "submit.png", sourceWidth: 704, sourceHeight: 160, displayWidth: 176 },
    { name: "verify.png", sourceWidth: 1360, sourceHeight: 160, displayWidth: 340 },
  ];
  const readmeNavAssets = await Promise.all(readmeNavSpecs.map(({ name }) => (
    readFile(new URL(`site/assets/img/readme-nav/${name}`, root))
  )));
  const readmeTagline = await readFile(new URL("site/assets/img/readme-tagline.png", root));
  const readmePreview = await readFile(new URL("preview.png", root));

  for (const asset of [...readmeNavAssets, readmeTagline, readmePreview]) {
    assert.equal(asset.subarray(1, 4).toString("ascii"), "PNG");
  }
  for (const [index, asset] of readmeNavAssets.entries()) {
    const spec = readmeNavSpecs[index];
    assert.deepEqual(
      [asset.readUInt32BE(16), asset.readUInt32BE(20)],
      [spec.sourceWidth, spec.sourceHeight],
      spec.name,
    );
    assert.match(
      readme,
      new RegExp(`readme-nav/${spec.name.replace(".", "\\.")}"[^>]*width="${spec.displayWidth}"`),
      spec.name,
    );
  }
  assert.deepEqual(
    [readmeTagline.readUInt32BE(16), readmeTagline.readUInt32BE(20)],
    [1320, 72],
  );
  assert.deepEqual(
    [readmePreview.readUInt32BE(16), readmePreview.readUInt32BE(20)],
    [1153, 699],
  );

  assert.match(form, /name: Verify or update a listed plugin/);
  assert.match(form, /label: Verification action[\s\S]*Verify the currently listed snapshot[\s\S]*Verify the listed snapshot and enable standard installation[\s\S]*Verify and publish a newer upstream commit/);
  assert.match(form, /label: Plugin ID[\s\S]*label: Repository URL[\s\S]*label: Target commit/);
  assert.match(form, new RegExp(verificationAcknowledgment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(form, new RegExp(standardInstallationAcknowledgment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  assert.match(issueRouter, /types: \[opened, edited, reopened, labeled, unlabeled\]/);
  assert.match(workflow, /workflow_call:/);
  assert.match(workflow, /name: Route exact verification action[\s\S]*Verify the listed snapshot and enable standard installation[\s\S]*action=\$\{action\}/);
  assert.match(workflow, /analyze:[\s\S]*if: needs\.route\.outputs\.action == 'listed' \|\| needs\.route\.outputs\.action == 'installation' \|\| needs\.route\.outputs\.action == 'revocation'[\s\S]*needs: route/);
  assert.ok((workflow.match(/github\.run_attempt == 1/g) || []).length >= 4);
  assert.match(workflow, /group: >-[\s\S]*maintainer-verified[\s\S]*'plugin-catalog-writes'/);
  assert.match(workflow, /name: Authorize maintainer verification review[\s\S]*collaborators\/\$\{REVIEWER\}\/permission[\s\S]*admin\|maintain\|write/);
  assert.match(workflow, /MAINTAINER_REVIEW_REQUESTED:[\s\S]*MAINTAINER_REVIEWER:[\s\S]*MAINTAINER_REVIEW_REQUESTED_AT:[\s\S]*MAINTAINER_REVIEW_REPORT_PATH:/);
  assert.match(workflow, /marketplace-maintainer-verification-expectation:v1/);
  assert.match(workflow, /comments\?per_page=100/);
  assert.doesNotMatch(workflow, /--slurp[\s\S]{0,180}--jq/);
  assert.ok((workflow.match(/\| jq -[cr]/g) || []).length >= 5);
  assert.match(workflow, /review_comment_updated_at[\s\S]*REVIEW_REQUESTED_AT/);
  assert.match(workflow, /known_revocation_event_ids[\s\S]*maintainerVerificationRevocation/);
  assert.match(workflow, /latest_revocation_time[\s\S]*unlabeled[\s\S]*maintainer-verified/);
  assert.match(workflow, /report_checked_at[\s\S]*Buffer\.from\(encoded, "base64url"\)/);
  assert.match(workflow, /A maintainer review after a revocation requires a fresh bot verification report/);
  assert.match(workflow, /jq -n -e --arg report_time \"\$report_checked_at\"/);
  assert.match(workflow, /report_time > \$revocation_time/);
  assert.match(workflow, /verification_method:[\s\S]*maintainer_review_requested:[\s\S]*installation_changed:/);
  assert.match(workflow, /INSTALLATION_CHANGED:[\s\S]*Enable standard installation for/);
  assert.match(workflow, /github\.event\.issue\.updated_at/);
  assert.ok((workflow.match(/events\?per_page=100/g) || []).length >= 4);
  assert.ok((workflow.match(/sort_by\(\.created_at, \.id\)/g) || []).length >= 7);
  assert.equal((workflow.match(/expected_review_transition=/g) || []).length, 3);
  assert.match(workflow, /maintainer_review_event_id: \$\{\{ steps\.review-authorization\.outputs\.event_id \}\}/);
  assert.match(workflow, /standard_installation_approval_event_id: \$\{\{ steps\.standard-installation-authorization\.outputs\.event_id \}\}/);
  assert.match(workflow, /revocation_event_id: \$\{\{ steps\.revocation-authorization\.outputs\.event_id \}\}/);
  assert.match(workflow, /standard-installation-approved/);
  assert.match(workflow, /name: Authorize maintainer verification revocation[\s\S]*event == "unlabeled"[\s\S]*collaborators\/\$\{REVIEWER\}\/permission/);
  assert.match(workflow, /MAINTAINER_REVIEW_EVENT_ID:/);
  assert.match(workflow, /any\(\.labels\[\]\?; \.name == "maintainer-verified"\)/);
  assert.match(workflow, /Verify \$\{PLUGIN_ID\} after maintainer review/);
  assert.match(workflow, /permissions:\s+contents: read\s+issues: read/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /npm ci[\s\S]*node scripts\/verify-listed-plugin\.mjs/);
  assert.equal((workflow.match(/run: npm test/g) || []).length, 1);
  assert.match(workflow, /npm test[\s\S]*actions\/upload-pages-artifact@[a-f0-9]{40}/);
  assert.match(workflow, /actions\/upload-artifact@[a-f0-9]{40}/);
  assert.match(workflow, /actions\/download-artifact@[a-f0-9]{40}/);
  assert.match(workflow, /sha256sum --check SHA256SUMS/);
  assert.match(workflow, /permissions:\s+actions: read\s+contents: write\s+issues: read/);
  const publishJob = workflow.slice(workflow.indexOf("\n  publish:\n"), workflow.indexOf("\n  deploy:\n"));
  assert.doesNotMatch(publishJob, /setup-node|npm ci|npm test|node scripts\//);
  assert.match(publishJob, /git fetch origin main[\s\S]*EXPECTED_BASE_COMMIT/);
  assert.match(publishJob, /main changed after the tested verification; refusing to rebase/);
  assert.match(publishJob, /git fetch origin main[\s\S]*events\?per_page=100[\s\S]*collaborators\/\$\{MAINTAINER_REVIEWER\}\/permission[\s\S]*push origin HEAD:main/);
  assert.match(publishJob, /github\.event\.action != 'labeled' \|\| github\.run_attempt == 1/);
  assert.match(workflow, /needs\.analyze\.outputs\.changed != 'true' \|\| needs\.publish\.result == 'success'/);
  assert.match(workflow, /git ls-remote[\s\S]*refusing to deploy an older verification artifact/);
  assert.match(workflow, /<!-- marketplace-plugin-verification -->/);
  const reportJob = workflow.slice(workflow.indexOf("\n  report:\n"), workflow.indexOf("\n  report-failure:\n"));
  const reportFailureJob = workflow.slice(workflow.indexOf("\n  report-failure:\n"));
  assert.match(
    reportJob,
    /\[ "\$RESULT" = "already-verified" \][\s\S]*\.state == "closed" and \(\.pull_request \| not\)[\s\S]*\.state_reason == "completed"[\s\S]*\.closed_by\.login == "github-actions\[bot\]"[\s\S]*marketplace-plugin-verification[\s\S]*✅ \*\*Verified\*\*[\s\S]*skipping duplicate reporting[\s\S]*exit 0/,
  );
  assert.ok(
    reportJob.indexOf("skipping duplicate reporting")
      < reportJob.indexOf("Verification issue is no longer open."),
  );
  assert.match(
    reportJob,
    /status_ids=[\s\S]*\(\[ "\$RESULT" = "already-verified" \] \|\| \[ "\$RESULT" = "already-revoked" \]\) && \[ -n "\$status_ids" \][\s\S]*preserving its status and leaving the issue open[\s\S]*exit 0/,
  );
  assert.ok(
    reportJob.indexOf("preserving its status and leaving the issue open")
      < reportJob.indexOf("report=\"$RUNNER_TEMP/plugin-verification-report/verification-report.md\""),
  );
  for (const source of [reportJob, reportFailureJob]) {
    assert.match(source, /GH_REPO: \$\{\{ github\.repository \}\}/);
    assert.doesNotMatch(source, /actions\/checkout/);
    assert.doesNotMatch(source, /remove-label maintainer-verified|labels\/maintainer-verified/);
  }
  assert.doesNotMatch(workflow, /personal access token|\bPAT\b/);

  for (const document of [guide, policy]) {
    assert.match(document, /exact (?:listed commit|`listingValidatedCommit`)/i);
    assert.match(document, /not a security audit/i);
    assert.match(document, /Unverified/);
  }
  const requestUrl = "https://github.com/omacom/omarchy-plugin-marketplace/issues/new?template=verify-plugin.yml";
  assert.match(guide, new RegExp(requestUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(readme, new RegExp(requestUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(submissionGuide, new RegExp(requestUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(submissionGuide, /maintainer-verified/);
  assert.match(submissionGuide, /exact match between that report and a fresh scan/);
  assert.doesNotMatch(submissionGuide, /publishes `Verified` only after a complete `passed` result/);
  assert.match(readme, /<p><a[\s\S]*readme-tagline\.png[\s\S]*<\/a><\/p>/);
  assert.doesNotMatch(readme, /<h1>|readme-header\.png|omarchy-wordmark\.png|<img[^>]+\sheight="/);
  assert.match(readme, /readme-tagline\.png" alt="Browse and discover community plugins for Omarchy at omarchyplugins\.com" width="660"/);
  assert.match(readme, /readme-nav\/develop\.png[\s\S]*readme-nav\/submit\.png[\s\S]*readme-nav\/verify\.png/);
  assert.doesNotMatch(readme, /readme-nav\/(?:browse|contribute)\.png|<kbd>/);
  assert.match(readme, /issues\/new\?template=submit-plugin\.yml/);
  assert.match(readme, /^## Verify or Update a Listed Plugin$/m);
  assert.doesNotMatch(readme, /neur0map|ryoku-arch/i);
  assert.match(guide, /maintainer-verified/);
  assert.match(guide, /review-required/);
  assert.match(guide, /`Update unverified`/);
  assert.match(guide, /current Omarchy command clones the repository's mutable current HEAD/);
  assert.match(guide, /not verification-bound/);
});

function reviewedInstallationFixture() {
  const record = storedReviewBaseline({ capabilities: ["installer"] });
  const reviewedSource = source({
    automatedSecurityBaseline: record,
    maintainerVerificationReview: storedReview(record),
    plugins: { "example.plugin": {
      category: "System", tags: ["system"], manifestPath: "manifest.json",
      installation: { mode: "manual", note: "Requires extra setup." },
    } },
  });
  const manualCatalog = catalog();
  Object.assign(manualCatalog.plugins[0], {
    repositoryLayout: "root-plugin", upstreamCheckStatus: "passed",
    installAvailable: false, installCommand: "", installNote: "Requires extra setup.", status: "Manual setup",
  });
  return {
    body: standardInstallationRequestBody(), registry: { sources: [reviewedSource] }, catalog: manualCatalog,
    standardInstallationApproval: standardInstallationApproval({ requestedAt: "2026-08-16T14:00:00.000Z" }),
    runBaseline: async () => baseline({ outcome: "review-required", capabilities: [{ id: "installer" }], checkedAt: "2026-08-16T15:00:00.000Z" }),
  };
}

test("standard installation reuses the exact installer review without minting or retiming an attestation", async () => {
  const fixture = reviewedInstallationFixture();
  const original = structuredClone(fixture.registry);
  const result = await analyzeListedPluginVerification(fixture);
  assert.equal(result.status, "verified");
  assert.equal(result.verification.method, "maintainer-reviewed");
  assert.equal(result.maintainerReviewRequested, false);
  assert.equal(result.installationChanged, true);
  assert.equal(result.catalog.plugins[0].installAvailable, true);
  assert.equal(result.source.plugins["example.plugin"].installation, undefined);
  assert.deepEqual(result.source.maintainerVerificationReview, original.sources[0].maintainerVerificationReview);
  assert.deepEqual(result.source.automatedSecurityBaseline, original.sources[0].automatedSecurityBaseline);
  assert.equal(result.scanResult.checkedAt, "2026-08-16T15:00:00.000Z");
  assert.deepEqual(fixture.registry, original);
});

test("standard installation rejects missing, revoked, stale, or mismatched installer reviews", async () => {
  const mutations = [
    (f, s) => { delete s.maintainerVerificationReview; },
    (f, s) => { s.maintainerVerificationReview.commit = otherCommit; },
    (f, s) => { s.maintainerVerificationReview.repository = "other/plugin"; },
    (f, s) => { s.maintainerVerificationReview.pluginIds = ["other.plugin"]; },
    (f, s) => { s.maintainerVerificationReview.baselineVersion = "0"; },
    (f, s) => { s.maintainerVerificationReviewHistory = [{}]; },
    (f, s) => { s.maintainerVerificationRevocation = {
      schemaVersion: 1, repository: "example/plugin", pluginIds: ["example.plugin"], commit,
      requestEventId: reviewRequestEventId, revocationEventId: reviewRequestEventId + 1,
      revokedBy: "hancore", revokedAt: "2026-08-16T13:30:00.000Z", reason: maintainerVerificationRevocationReason,
    }; },
    (f) => { f.standardInstallationApproval.requestedAt = reviewedAt; },
    (f) => { f.standardInstallationApproval = null; },
    (f) => { f.body = standardInstallationRequestBody({ commitSha: otherCommit }); },
    (f) => { f.runBaseline = async () => baseline({ outcome: "review-required", capabilities: [{ id: "installer" }], checkedAt }); },
    (f, s) => {
      s.automatedSecurityBaseline.capabilities.push("privilege");
      s.maintainerVerificationReview = storedReview(s.automatedSecurityBaseline);
      f.runBaseline = async () => baseline({ outcome: "review-required", capabilities: [{ id: "installer" }, { id: "privilege" }], checkedAt: "2026-08-16T15:00:00.000Z" });
    },
    (f) => { f.runBaseline = async () => baseline({ outcome: "needs-fixes", findings: [{ ruleId: "curl-pipe-shell" }], capabilities: [{ id: "installer" }] }); },
    (f) => { f.runBaseline = async () => { throw new Error("scan failed"); }; },
  ];
  for (const mutate of mutations) {
    const fixture = reviewedInstallationFixture();
    mutate(fixture, fixture.registry.sources[0]);
    const original = structuredClone({ registry: fixture.registry, catalog: fixture.catalog });
    let result;
    try { result = await analyzeListedPluginVerification(fixture); }
    catch (error) { assert.ok(error instanceof PluginVerificationError || error.message === "scan failed"); }
    if (result) {
      assert.equal(result.status, "unverified");
      assert.equal(result.changed, false);
      assert.equal(result.installationChanged, false);
    }
    assert.deepEqual({ registry: fixture.registry, catalog: fixture.catalog }, original);
  }
});
