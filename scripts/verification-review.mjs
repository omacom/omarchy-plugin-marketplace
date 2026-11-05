import {
  isConsistentSecurityBaselineSummary,
  securityBaselineCapabilityIds,
  securityBaselineEligibleForMaintainerVerification,
  securityBaselineEligibleForVerifiedPublicationReview,
  securityBaselineFindingIds,
} from "./security-baseline-policy.mjs";
import { parseStoredSecurityBaselineRecord } from "./security-baseline-record.mjs";

export const maintainerVerificationReviewSchemaVersion = 1;
export const maintainerVerificationRevocationSchemaVersion = 1;
export const maintainerVerificationRevocationReason = "approval-applied-in-error";
export const maintainerVerificationLabel = "maintainer-verified";
export const standardInstallationApprovalLabel = "standard-installation-approved";
export const maintainerVerificationExpectationMarkerPrefix = "<!-- marketplace-maintainer-verification-expectation:v1 ";

export class MaintainerVerificationReviewError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MaintainerVerificationReviewError";
    this.code = code;
  }
}

function normalizedStrings(value) {
  if (
    !Array.isArray(value)
    || value.some((entry) => typeof entry !== "string" || !entry || entry !== entry.trim())
    || new Set(value).size !== value.length
  ) return null;
  return [...value];
}

function validReviewer(value) {
  return typeof value === "string"
    && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(value);
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function exactKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

export function parseMaintainerVerificationRevocation(revocation, review) {
  const pluginIds = normalizedStrings(revocation?.pluginIds);
  const reviewPluginIds = normalizedStrings(review?.pluginIds);
  if (
    !exactKeys(revocation, [
      "schemaVersion",
      "repository",
      "pluginIds",
      "commit",
      "requestEventId",
      "revocationEventId",
      "revokedBy",
      "revokedAt",
      "reason",
    ])
    || revocation.schemaVersion !== maintainerVerificationRevocationSchemaVersion
    || revocation.repository !== review?.repository
    || revocation.commit !== review?.commit
    || !pluginIds
    || !reviewPluginIds
    || JSON.stringify(pluginIds) !== JSON.stringify(reviewPluginIds)
    || !Number.isSafeInteger(revocation.requestEventId)
    || revocation.requestEventId < 1
    || revocation.requestEventId !== review?.requestEventId
    || !Number.isSafeInteger(revocation.revocationEventId)
    || revocation.revocationEventId <= revocation.requestEventId
    || !validReviewer(revocation.revokedBy)
    || !validTimestamp(revocation.revokedAt)
    || !validTimestamp(review?.requestedAt)
    || !validTimestamp(review?.reviewedAt)
    || Date.parse(revocation.revokedAt) < Date.parse(review.reviewedAt)
    || revocation.reason !== maintainerVerificationRevocationReason
  ) return null;
  return Object.freeze({
    schemaVersion: maintainerVerificationRevocationSchemaVersion,
    repository: revocation.repository,
    pluginIds: Object.freeze([...pluginIds]),
    commit: revocation.commit,
    requestEventId: revocation.requestEventId,
    revocationEventId: revocation.revocationEventId,
    revokedBy: revocation.revokedBy,
    revokedAt: revocation.revokedAt,
    reason: revocation.reason,
  });
}

export function createMaintainerVerificationRevocation(review, {
  revocationEventId,
  revokedBy,
  revokedAt,
} = {}) {
  const revocation = {
    schemaVersion: maintainerVerificationRevocationSchemaVersion,
    repository: review?.repository,
    pluginIds: review?.pluginIds,
    commit: review?.commit,
    requestEventId: review?.requestEventId,
    revocationEventId,
    revokedBy,
    revokedAt,
    reason: maintainerVerificationRevocationReason,
  };
  const parsed = parseMaintainerVerificationRevocation(revocation, review);
  if (!parsed) {
    throw new MaintainerVerificationReviewError(
      "verification-revocation-invalid",
      "Maintainer verification revocation is invalid or does not bind to the current review",
    );
  }
  return parsed;
}

export function parseMaintainerVerificationReviewPair(review, revocation, baseline) {
  const parsedReview = parseMaintainerVerificationReview(review, baseline);
  const parsedRevocation = parsedReview
    ? parseMaintainerVerificationRevocation(revocation, parsedReview)
    : null;
  if (!parsedReview || !parsedRevocation) return null;
  return Object.freeze({
    maintainerVerificationReview: parsedReview,
    maintainerVerificationRevocation: parsedRevocation,
  });
}

export function parseMaintainerVerificationReviewHistory(history, {
  expectedRepository = "",
  allowedRepositories,
  allowLegacyRepositoryFallback = true,
  pluginIds,
} = {}) {
  if (!Array.isArray(history)) return null;
  const parsed = [];
  for (const entry of history) {
    if (!exactKeys(entry, ["maintainerVerificationReview", "maintainerVerificationRevocation"])) return null;
    const review = entry.maintainerVerificationReview;
    const baseline = {
      version: review?.baselineVersion,
      repository: review?.repository,
      pluginIds: review?.pluginIds,
      commit: review?.commit,
      checkedAt: review?.baselineCheckedAt,
      outcome: review?.baselineOutcome,
      enforcementMode: review?.enforcementMode,
      findings: review?.findings,
      capabilities: review?.capabilities,
    };
    const parsedBaseline = parseStoredSecurityBaselineRecord(baseline, {
      expectedRepository,
      allowedRepositories,
      allowLegacyRepositoryFallback,
      pluginIds,
    });
    const pair = parseMaintainerVerificationReviewPair(
      review,
      entry.maintainerVerificationRevocation,
      parsedBaseline,
    );
    if (!pair) return null;
    parsed.push(pair);
  }
  return Object.freeze(parsed);
}

export function parseListingValidationHistory(history, {
  expectedRepository = "",
  allowedRepositories,
  allowLegacyRepositoryFallback = true,
  pluginIds,
} = {}) {
  if (!Array.isArray(history)) return null;
  const repositoryValues = allowedRepositories === undefined
    ? [expectedRepository].filter(Boolean)
    : allowedRepositories;
  if (
    !Array.isArray(repositoryValues)
    || repositoryValues.some((repository) => typeof repository !== "string" || !repository)
  ) return null;
  const repositoryKeys = new Set(repositoryValues.map((repository) => repository.toLowerCase()));
  if (expectedRepository && !repositoryKeys.has(expectedRepository.toLowerCase())) return null;
  for (const entry of history) {
    if (
      !entry
      || typeof entry !== "object"
      || Array.isArray(entry)
      || !/^[a-f0-9]{40}$/i.test(entry.commit || "")
      || !validTimestamp(entry.validatedAt)
      || !validTimestamp(entry.supersededAt)
      || typeof entry.branch !== "string"
      || !entry.branch
    ) return null;
    const hasBaseline = Object.hasOwn(entry, "automatedSecurityBaseline");
    const hasReview = Object.hasOwn(entry, "maintainerVerificationReview");
    const hasRevocation = Object.hasOwn(entry, "maintainerVerificationRevocation");
    const historicalBaseline = entry.automatedSecurityBaseline;
    const historicalCommit = String(historicalBaseline?.commit || "").toLowerCase();
    const historicalRepository = String(historicalBaseline?.repository || "").toLowerCase();
    if (
      hasBaseline
      && (
        historicalCommit !== String(entry.commit).toLowerCase()
        || (historicalRepository && repositoryKeys.size && !repositoryKeys.has(historicalRepository))
        || !validTimestamp(historicalBaseline?.checkedAt)
      )
    ) return null;
    if (hasRevocation && !hasReview) return null;
    const baseline = hasBaseline
      ? parseStoredSecurityBaselineRecord(historicalBaseline, {
        expectedRepository,
        allowedRepositories: repositoryValues,
        allowLegacyRepositoryFallback,
        expectedCommit: entry.commit,
        pluginIds,
      })
      : null;
    const findings = securityBaselineFindingIds(historicalBaseline);
    const capabilities = securityBaselineCapabilityIds(historicalBaseline);
    const legacyBaseline = hasBaseline
      && historicalBaseline?.version === "2"
      && historicalBaseline?.enforcementMode === "review-only"
      && (allowLegacyRepositoryFallback || Boolean(historicalRepository))
      && Boolean(findings)
      && Boolean(capabilities)
      && isConsistentSecurityBaselineSummary({
        outcome: historicalBaseline.outcome,
        enforcementMode: historicalBaseline.enforcementMode,
        findings,
        capabilities,
      });
    if (hasBaseline && !baseline && !legacyBaseline) return null;
    if ((hasReview || hasRevocation) && !baseline) return null;
    if (hasReview && !parseMaintainerVerificationReview(entry.maintainerVerificationReview, baseline)) return null;
    if (
      hasRevocation
      && !parseMaintainerVerificationReviewPair(
        entry.maintainerVerificationReview,
        entry.maintainerVerificationRevocation,
        baseline,
      )
    ) return null;
    if (
      Object.hasOwn(entry, "maintainerVerificationReviewHistory")
      && !parseMaintainerVerificationReviewHistory(entry.maintainerVerificationReviewHistory, {
        expectedRepository,
        allowedRepositories: repositoryValues,
        allowLegacyRepositoryFallback,
        pluginIds,
      })
    ) return null;
  }
  return Object.freeze(history);
}

export function serializeMaintainerVerificationExpectation(baseline) {
  const parsed = parseStoredSecurityBaselineRecord(baseline);
  if (!parsed || !securityBaselineEligibleForMaintainerVerification(parsed)) {
    throw new MaintainerVerificationReviewError(
      "verification-review-expectation-invalid",
      "Maintainer verification expectation is invalid or not eligible",
    );
  }
  const encoded = Buffer.from(JSON.stringify(parsed)).toString("base64url");
  return `${maintainerVerificationExpectationMarkerPrefix}${encoded} -->`;
}

export function parseMaintainerVerificationExpectation(body) {
  const escapedPrefix = maintainerVerificationExpectationMarkerPrefix
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...String(body || "").matchAll(
    new RegExp(`${escapedPrefix}([A-Za-z0-9_-]+) -->`, "g"),
  )];
  if (!matches.length) return null;
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(matches.at(-1)[1], "base64url").toString("utf8"));
  } catch {
    throw new MaintainerVerificationReviewError(
      "verification-review-expectation-invalid",
      "Maintainer verification expectation is malformed",
    );
  }
  const parsed = parseStoredSecurityBaselineRecord(decoded);
  if (!parsed || !securityBaselineEligibleForMaintainerVerification(parsed)) {
    throw new MaintainerVerificationReviewError(
      "verification-review-expectation-invalid",
      "Maintainer verification expectation is invalid or not eligible",
    );
  }
  return parsed;
}

export function matchesSecurityBaselineEvidence(expectation, baseline) {
  const parsedExpectation = parseStoredSecurityBaselineRecord(expectation);
  const parsedBaseline = parseStoredSecurityBaselineRecord(baseline);
  if (!parsedExpectation || !parsedBaseline) return false;
  return JSON.stringify({
    repository: parsedExpectation.repository,
    pluginIds: parsedExpectation.pluginIds,
    commit: parsedExpectation.commit,
    version: parsedExpectation.version,
    outcome: parsedExpectation.outcome,
    enforcementMode: parsedExpectation.enforcementMode,
    findings: parsedExpectation.findings,
    capabilities: parsedExpectation.capabilities,
  }) === JSON.stringify({
    repository: parsedBaseline.repository,
    pluginIds: parsedBaseline.pluginIds,
    commit: parsedBaseline.commit,
    version: parsedBaseline.version,
    outcome: parsedBaseline.outcome,
    enforcementMode: parsedBaseline.enforcementMode,
    findings: parsedBaseline.findings,
    capabilities: parsedBaseline.capabilities,
  });
}

export function matchesMaintainerVerificationExpectation(expectation, baseline) {
  return securityBaselineEligibleForMaintainerVerification(expectation)
    && securityBaselineEligibleForMaintainerVerification(baseline)
    && matchesSecurityBaselineEvidence(expectation, baseline);
}

export function matchesVerifiedPublicationReviewExpectation(expectation, baseline) {
  return securityBaselineEligibleForVerifiedPublicationReview(expectation)
    && securityBaselineEligibleForVerifiedPublicationReview(baseline)
    && matchesSecurityBaselineEvidence(expectation, baseline);
}

export function parseMaintainerVerificationReview(review, baseline) {
  const pluginIds = normalizedStrings(review?.pluginIds);
  const findings = normalizedStrings(review?.findings);
  const capabilities = normalizedStrings(review?.capabilities);
  const baselinePluginIds = normalizedStrings(baseline?.pluginIds);
  const baselineFindings = normalizedStrings(baseline?.findings);
  const baselineCapabilities = normalizedStrings(baseline?.capabilities);
  if (
    !securityBaselineEligibleForVerifiedPublicationReview(baseline)
    || review?.schemaVersion !== maintainerVerificationReviewSchemaVersion
    || review.baselineOutcome !== baseline.outcome
    || review.repository !== baseline.repository
    || review.commit !== baseline.commit
    || review.baselineVersion !== baseline.version
    || review.enforcementMode !== baseline.enforcementMode
    || review.baselineCheckedAt !== baseline.checkedAt
    || !pluginIds
    || !baselinePluginIds
    || JSON.stringify(pluginIds) !== JSON.stringify(baselinePluginIds)
    || !findings
    || !baselineFindings
    || JSON.stringify(findings) !== JSON.stringify(baselineFindings)
    || !capabilities
    || !baselineCapabilities
    || JSON.stringify(capabilities) !== JSON.stringify(baselineCapabilities)
    || !Number.isSafeInteger(review.requestEventId)
    || review.requestEventId < 1
    || !validTimestamp(review.reviewedBaselineCheckedAt)
    || !validTimestamp(review.requestedAt)
    || !validTimestamp(review.reviewedAt)
    || Date.parse(review.reviewedBaselineCheckedAt) > Date.parse(review.requestedAt)
    || Date.parse(baseline.checkedAt) < Date.parse(review.requestedAt)
    || Date.parse(review.reviewedAt) < Date.parse(baseline.checkedAt)
    || Date.parse(review.reviewedAt) < Date.parse(review.requestedAt)
    || !validReviewer(review.reviewer)
  ) return null;
  return Object.freeze({
    schemaVersion: maintainerVerificationReviewSchemaVersion,
    repository: review.repository,
    pluginIds: Object.freeze([...pluginIds]),
    commit: review.commit,
    baselineVersion: review.baselineVersion,
    enforcementMode: review.enforcementMode,
    baselineCheckedAt: review.baselineCheckedAt,
    baselineOutcome: review.baselineOutcome,
    findings: Object.freeze([...findings]),
    capabilities: Object.freeze([...capabilities]),
    reviewedBaselineCheckedAt: review.reviewedBaselineCheckedAt,
    requestEventId: review.requestEventId,
    requestedAt: review.requestedAt,
    reviewedAt: review.reviewedAt,
    reviewer: review.reviewer,
  });
}

export function createMaintainerVerificationReview(baseline, {
  reviewedBaseline,
  reviewer,
  requestEventId,
  requestedAt,
  reviewedAt,
  verifiedPublication = false,
} = {}) {
  const matchesExpectation = verifiedPublication
    ? matchesVerifiedPublicationReviewExpectation(reviewedBaseline, baseline)
    : matchesMaintainerVerificationExpectation(reviewedBaseline, baseline);
  if (!matchesExpectation) {
    throw new MaintainerVerificationReviewError(
      "verification-review-expectation-mismatch",
      "Rescanned baseline does not match the maintainer-reviewed expectation",
    );
  }
  const review = {
    schemaVersion: maintainerVerificationReviewSchemaVersion,
    repository: baseline?.repository,
    pluginIds: baseline?.pluginIds,
    commit: baseline?.commit,
    baselineVersion: baseline?.version,
    enforcementMode: baseline?.enforcementMode,
    baselineCheckedAt: baseline?.checkedAt,
    baselineOutcome: baseline?.outcome,
    findings: baseline?.findings,
    capabilities: baseline?.capabilities,
    reviewedBaselineCheckedAt: reviewedBaseline?.checkedAt,
    requestEventId,
    requestedAt,
    reviewedAt,
    reviewer,
  };
  const parsed = parseMaintainerVerificationReview(review, baseline);
  if (!parsed) {
    throw new MaintainerVerificationReviewError(
      "verification-review-invalid",
      "Maintainer verification review is invalid or not eligible",
    );
  }
  return parsed;
}
