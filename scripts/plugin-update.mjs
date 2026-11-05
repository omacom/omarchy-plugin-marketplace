import {
  parsePluginVerificationIssue,
  pluginVerificationAcknowledgment,
  PluginVerificationRequestError,
  upstreamUpdateVerificationAction,
} from "./plugin-verification-request.mjs";
import { githubRepositoryKey } from "./github-repository.mjs";
import { repositoryEvidenceKeys } from "./repository-identity.mjs";
import { parseStoredSecurityBaselineRecord } from "./security-baseline-record.mjs";
import {
  isConsistentSecurityBaselineSummary,
  securityBaselineCapabilityIds,
  securityBaselineFindingIds,
} from "./security-baseline-policy.mjs";
import { sourceVerification } from "./verification-status.mjs";
import {
  parseListingValidationHistory,
  parseMaintainerVerificationReview,
  parseMaintainerVerificationReviewHistory,
  parseMaintainerVerificationReviewPair,
} from "./verification-review.mjs";
import {
  resolveConfiguredSource,
  VerificationSubjectError,
} from "./verification-subject.mjs";

export const pluginUpdateAcknowledgment = pluginVerificationAcknowledgment;

const fullCommitPattern = /^[a-f0-9]{40}$/i;

export class PluginUpdateError extends Error {
  constructor(code, message, context = {}) {
    super(message);
    this.name = "PluginUpdateError";
    this.code = code;
    this.context = Object.freeze({ ...context });
  }
}

function mappedRequestCode(code) {
  return ({
    "request-fields-invalid": "update-fields-invalid",
    "request-action-invalid": "update-action-invalid",
    "request-plugin-id-invalid": "update-plugin-id-invalid",
    "request-repository-invalid": "update-repository-invalid",
    "request-commit-invalid": "update-commit-invalid",
    "request-acknowledgment-missing": "update-acknowledgment-missing",
  })[code] || "update-fields-invalid";
}

export function parsePluginUpdateRequest(body) {
  try {
    return parsePluginVerificationIssue(body, {
      expectedAction: upstreamUpdateVerificationAction,
    });
  } catch (error) {
    if (!(error instanceof PluginVerificationRequestError)) throw error;
    throw new PluginUpdateError(mappedRequestCode(error.code), error.message);
  }
}

function mappedSubjectCode(code) {
  return ({
    "verification-plugin-not-listed": "update-plugin-not-listed",
    "verification-source-unsupported": "update-source-unsupported",
    "verification-repository-mismatch": "update-repository-mismatch",
  })[code] || "update-listing-invalid";
}

export function sourceForPluginUpdate(registry, request) {
  let source;
  try {
    source = resolveConfiguredSource(registry, request);
  } catch (error) {
    if (!(error instanceof VerificationSubjectError)) throw error;
    throw new PluginUpdateError(mappedSubjectCode(error.code), error.message, error.context);
  }
  assertPluginUpdateListingArchivable(source);
  return source;
}

function sortedPluginIds(value) {
  return [...new Set(value || [])].sort();
}

function sourcePluginIds(source) {
  return Object.keys(source?.plugins || {}).sort();
}

function legacyBaselineValid(source) {
  const baseline = source?.automatedSecurityBaseline;
  let expectedRepository;
  try {
    expectedRepository = githubRepositoryKey(source?.repo);
  } catch {
    return null;
  }
  const findings = securityBaselineFindingIds(baseline);
  const capabilities = securityBaselineCapabilityIds(baseline);
  const repository = String(baseline?.repository || "").toLowerCase();
  if (
    baseline?.version !== "2"
    || baseline?.enforcementMode !== "review-only"
    || !fullCommitPattern.test(baseline?.commit || "")
    || baseline.commit.toLowerCase() !== String(source?.listingValidatedCommit || "").toLowerCase()
    || (repository && repository !== expectedRepository)
    || !Number.isFinite(Date.parse(baseline?.checkedAt || ""))
    || !findings
    || !capabilities
    || !isConsistentSecurityBaselineSummary({
      outcome: baseline.outcome,
      enforcementMode: baseline.enforcementMode,
      findings,
      capabilities,
    })
  ) return null;
  return baseline;
}

function sourceEvidenceValid(source) {
  let expectedRepository;
  let allowedRepositories;
  let migrated = false;
  try {
    expectedRepository = githubRepositoryKey(source?.repo);
    allowedRepositories = repositoryEvidenceKeys(source);
    migrated = source?.repositoryIdentity !== undefined;
  } catch {
    return false;
  }
  // A missing baseline denotes a legacy unverified snapshot. Once the field is
  // present, it is trust evidence and must remain exact and fully parseable.
  const hasBaseline = Object.hasOwn(source || {}, "automatedSecurityBaseline");
  const baseline = hasBaseline
    ? parseStoredSecurityBaselineRecord(source.automatedSecurityBaseline, {
      expectedRepository,
      allowedRepositories,
      allowLegacyRepositoryFallback: !migrated,
      expectedCommit: source?.listingValidatedCommit,
      pluginIds: sourcePluginIds(source),
    }) || (!migrated ? legacyBaselineValid(source) : null)
    : null;
  if (hasBaseline && !baseline) return false;
  const hasReview = Object.hasOwn(source || {}, "maintainerVerificationReview");
  const hasRevocation = Object.hasOwn(source || {}, "maintainerVerificationRevocation");
  if ((hasReview || hasRevocation) && !baseline) return false;
  if (hasRevocation && !hasReview) return false;
  if (hasReview && !parseMaintainerVerificationReview(source.maintainerVerificationReview, baseline)) return false;
  if (
    hasRevocation
    && !parseMaintainerVerificationReviewPair(
      source.maintainerVerificationReview,
      source.maintainerVerificationRevocation,
      baseline,
    )
  ) return false;
  if (
    Object.hasOwn(source || {}, "maintainerVerificationReviewHistory")
    && !parseMaintainerVerificationReviewHistory(source.maintainerVerificationReviewHistory, {
      expectedRepository,
      allowedRepositories,
      allowLegacyRepositoryFallback: !migrated,
      pluginIds: sourcePluginIds(source),
    })
  ) return false;
  return !Object.hasOwn(source || {}, "listingValidationHistory")
    || parseListingValidationHistory(source.listingValidationHistory, {
      expectedRepository,
      allowedRepositories,
      allowLegacyRepositoryFallback: !migrated,
      pluginIds: sourcePluginIds(source),
    });
}

export function assertPluginUpdateListingArchivable(source) {
  if (
    source?.type !== "plugin-source"
    || !sourcePluginIds(source).length
    || !sourceEvidenceValid(source)
  ) {
    throw new PluginUpdateError(
      "update-listing-invalid",
      "The current listing evidence cannot be archived safely",
    );
  }
  if (
    !fullCommitPattern.test(source.listingValidatedCommit || "")
    || !Number.isFinite(Date.parse(source.listingValidatedAt || ""))
    || typeof source.listingValidatedBranch !== "string"
    || !source.listingValidatedBranch
  ) {
    throw new PluginUpdateError(
      "update-listing-invalid",
      "The current listing provenance cannot be archived safely",
    );
  }
  return source;
}

export function assertPluginUpdateInspection(request, source, inspection, {
  allowCurrentCommit = false,
} = {}) {
  if (
    !inspection
    || String(inspection.repository || "").toLowerCase() !== request.repository
    || String(inspection.commitSha || "").toLowerCase() !== request.commitSha
  ) {
    throw new PluginUpdateError(
      "update-upstream-changed",
      "The repository HEAD no longer matches the requested update commit",
    );
  }
  const configuredPluginIds = Object.keys(source?.plugins || {}).sort();
  const inspectedPluginIds = sortedPluginIds(
    (inspection.manifests || []).map((manifest) => manifest.id),
  );
  if (
    !configuredPluginIds.length
    || JSON.stringify(configuredPluginIds) !== JSON.stringify(inspectedPluginIds)
  ) {
    throw new PluginUpdateError(
      "update-plugin-set-changed",
      "The update commit does not contain the exact configured plugin set",
    );
  }
  if (
    !allowCurrentCommit
    && String(source.listingValidatedCommit || "").toLowerCase() === request.commitSha
  ) {
    throw new PluginUpdateError(
      "update-already-current",
      "The requested commit is already the marketplace listing snapshot",
    );
  }
  return Object.freeze({
    source,
    pluginIds: Object.freeze(configuredPluginIds),
    manifests: Object.freeze([...(inspection.manifests || [])]),
    inspection,
  });
}

export function resolvePluginUpdate(registry, request, inspection, options = {}) {
  const source = sourceForPluginUpdate(registry, request);
  return assertPluginUpdateInspection(request, source, inspection, options);
}

export function listingValidationHistoryEntry(source, supersededAt) {
  assertPluginUpdateListingArchivable(source);
  const expectedRepository = githubRepositoryKey(source.repo);
  const allowedRepositories = repositoryEvidenceKeys(source);
  if (Object.hasOwn(source || {}, "maintainerVerificationRevocation")) {
    if (!parseMaintainerVerificationReviewPair(
      source?.maintainerVerificationReview,
      source?.maintainerVerificationRevocation,
      source?.automatedSecurityBaseline,
    )) {
      throw new PluginUpdateError(
        "update-listing-invalid",
        "The current maintainer review revocation cannot be archived safely",
      );
    }
  }
  if (
    Object.hasOwn(source || {}, "maintainerVerificationReviewHistory")
    && !parseMaintainerVerificationReviewHistory(source.maintainerVerificationReviewHistory, {
      expectedRepository,
      allowedRepositories,
      allowLegacyRepositoryFallback: source.repositoryIdentity === undefined,
      pluginIds: sourcePluginIds(source),
    })
  ) {
    throw new PluginUpdateError(
      "update-listing-invalid",
      "The current maintainer review history cannot be archived safely",
    );
  }
  const entry = {
    commit: source?.listingValidatedCommit,
    validatedAt: source?.listingValidatedAt,
    branch: source?.listingValidatedBranch,
    supersededAt,
    ...(source?.automatedSecurityBaseline
      ? { automatedSecurityBaseline: source.automatedSecurityBaseline }
      : {}),
    ...(source?.maintainerVerificationReview
      ? { maintainerVerificationReview: source.maintainerVerificationReview }
      : {}),
    ...(source?.maintainerVerificationRevocation
      ? { maintainerVerificationRevocation: source.maintainerVerificationRevocation }
      : {}),
    ...(source?.maintainerVerificationReviewHistory
      ? { maintainerVerificationReviewHistory: source.maintainerVerificationReviewHistory }
      : {}),
  };
  if (
    !fullCommitPattern.test(entry.commit || "")
    || !Number.isFinite(Date.parse(entry.validatedAt || ""))
    || !Number.isFinite(Date.parse(entry.supersededAt || ""))
    || typeof entry.branch !== "string"
    || !entry.branch
  ) {
    throw new PluginUpdateError(
      "update-listing-invalid",
      "The current listing provenance cannot be archived safely",
    );
  }
  return Object.freeze(entry);
}

export function promotePluginUpdateSource(source, inspection, {
  automatedSecurityBaseline,
  maintainerVerificationReview = null,
  promotedAt,
}) {
  if (!automatedSecurityBaseline || typeof automatedSecurityBaseline !== "object") {
    throw new PluginUpdateError(
      "update-security-baseline-invalid",
      "A complete update security baseline is required",
    );
  }
  if (!Number.isFinite(Date.parse(promotedAt || ""))) {
    throw new PluginUpdateError("update-time-invalid", "Update promotion time is invalid");
  }
  const currentCommit = String(source?.listingValidatedCommit || "").toLowerCase();
  const promotedCommit = String(inspection?.commitSha || "").toLowerCase();
  if (!fullCommitPattern.test(promotedCommit) || currentCommit === promotedCommit) {
    throw new PluginUpdateError(
      "update-already-current",
      "Update promotion requires a new exact commit",
    );
  }
  if (
    Object.hasOwn(source || {}, "listingValidationHistory")
    && !Array.isArray(source.listingValidationHistory)
  ) {
    throw new PluginUpdateError(
      "update-history-invalid",
      "Listing validation history is invalid",
    );
  }
  let expectedRepository;
  let allowedRepositories;
  try {
    expectedRepository = githubRepositoryKey(source.repo);
    allowedRepositories = repositoryEvidenceKeys(source);
  } catch {
    throw new PluginUpdateError(
      "update-history-invalid",
      "Repository migration history evidence is invalid",
    );
  }
  if (
    !parseListingValidationHistory(source.listingValidationHistory || [], {
      expectedRepository,
      allowedRepositories,
      allowLegacyRepositoryFallback: source.repositoryIdentity === undefined,
      pluginIds: sourcePluginIds(source),
    })
  ) {
    throw new PluginUpdateError(
      "update-history-invalid",
      "Listing validation history evidence is invalid",
    );
  }
  const {
    maintainerVerificationReview: ignoredReview,
    maintainerVerificationRevocation: ignoredRevocation,
    ...sourceWithoutReview
  } = source;
  const nextSource = {
    ...sourceWithoutReview,
    listingValidatedCommit: promotedCommit,
    listingValidatedAt: promotedAt,
    listingValidatedBranch: inspection.defaultBranch,
    automatedSecurityBaseline,
    ...(maintainerVerificationReview ? { maintainerVerificationReview } : {}),
    listingValidationHistory: [
      ...(source.listingValidationHistory || []),
      listingValidationHistoryEntry(source, promotedAt),
    ],
  };
  if (sourceVerification(nextSource).status !== "verified") {
    throw new PluginUpdateError(
      "update-verification-invalid",
      "Promoted update evidence did not produce a commit-bound Verified snapshot",
    );
  }
  return Object.freeze(nextSource);
}

export function replacePluginUpdateSource(registry, source, nextSource) {
  return {
    ...registry,
    sources: (registry?.sources || []).map((candidate) => (
      candidate === source ? nextSource : candidate
    )),
  };
}

function safeInline(value) {
  return String(value || "")
    .replace(/[^A-Za-z0-9._/@:-]+/g, " ")
    .replaceAll("@", "@\u200b")
    .trim()
    .slice(0, 200);
}

export function buildPluginUpdateValidationReport(result) {
  const pluginIds = result.pluginIds.map((id) => `\`${safeInline(id)}\``).join(", ");
  return `<!-- marketplace-update-validation -->
## Plugin update validation

✅ Existing plugin source confirmed: [${safeInline(result.request.repository)}](${result.request.repoUrl})
✅ Exact configured plugin set confirmed: ${pluginIds}
✅ Quattro compatibility passed at update commit \`${safeInline(result.request.commitSha.slice(0, 7))}…\`

**Ready for verified update review.** The automated security baseline must complete before a maintainer applies \`approved-and-verified\`. The current marketplace snapshot remains unchanged until publication succeeds.
`;
}

export function publicPluginUpdateFailure(error) {
  const code = String(error?.code || "update-internal-error");
  const reasons = {
    "update-fields-invalid": "Use the plugin verification issue form without changing its headings.",
    "update-action-invalid": "Select the newer upstream commit action in the plugin verification form.",
    "update-plugin-id-invalid": "Enter the exact existing plugin ID.",
    "update-repository-invalid": "Enter the existing public GitHub repository root URL.",
    "update-commit-invalid": "Enter the full 40-character update commit SHA.",
    "update-acknowledgment-missing": "Confirm the plugin update acknowledgment.",
    "update-plugin-not-listed": "The plugin ID does not identify an existing community listing.",
    "update-source-unsupported": "This update workflow supports plugin-source listings, not shell suites.",
    "update-repository-mismatch": "The repository does not match the existing listing.",
    "update-upstream-changed": "The repository HEAD changed or does not match the requested update commit. Update the issue to the current full SHA.",
    "update-plugin-set-changed": "Plugin updates cannot add, remove, or rename configured plugin IDs.",
    "update-compatibility-invalid": "The update commit did not pass marketplace compatibility validation.",
    "update-already-current": "The requested commit is already the marketplace listing snapshot.",
    "update-listing-invalid": "The current marketplace listing cannot be updated safely.",
    "update-security-baseline-invalid": "The update security baseline is missing, stale, or belongs to another snapshot.",
    "update-verification-invalid": "The update evidence did not produce a valid verified snapshot.",
    "security-baseline-unavailable": "The exact update commit could not be scanned completely.",
    "security-baseline-scan-limit": "The exact update commit exceeds a deterministic scan limit.",
  };
  return Object.freeze({
    code: Object.hasOwn(reasons, code) ? code : "update-internal-error",
    reason: reasons[code] || "The plugin update service could not complete safely.",
  });
}
