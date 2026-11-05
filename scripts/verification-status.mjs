import { githubRepositoryKey } from "./github-repository.mjs";
import { repositoryEvidenceKeys } from "./repository-identity.mjs";
import { parseStoredSecurityBaselineRecord } from "./security-baseline-record.mjs";
import {
  parseMaintainerVerificationRevocation,
  parseMaintainerVerificationReview,
  parseMaintainerVerificationReviewHistory,
  parseListingValidationHistory,
} from "./verification-review.mjs";

export const pluginVerificationStatuses = Object.freeze(["verified", "unverified"]);

function sourcePluginIds(source) {
  const ids = Object.keys(source?.plugins || {});
  if (source?.catalog?.id) ids.push(source.catalog.id);
  return ids.sort();
}

export function sourceVerification(source) {
  if (source?.type !== "plugin-source") return Object.freeze({ status: "unverified" });
  let repository;
  let allowedRepositories;
  let migrated = false;
  try {
    repository = githubRepositoryKey(source?.repo);
    allowedRepositories = repositoryEvidenceKeys(source);
    migrated = source?.repositoryIdentity !== undefined;
  } catch {
    return Object.freeze({ status: "unverified" });
  }
  const baseline = parseStoredSecurityBaselineRecord(source?.automatedSecurityBaseline, {
    expectedRepository: repository,
    allowedRepositories,
    allowLegacyRepositoryFallback: !migrated,
    expectedCommit: source?.listingValidatedCommit,
    pluginIds: sourcePluginIds(source),
  });
  if (!baseline) return Object.freeze({ status: "unverified" });
  const automatic = baseline.outcome === "passed"
    && baseline.findings.length === 0
    && baseline.capabilities.length === 0;
  const hasReview = Object.hasOwn(source || {}, "maintainerVerificationReview");
  const review = hasReview
    ? parseMaintainerVerificationReview(source?.maintainerVerificationReview, baseline)
    : null;
  const hasRevocation = Object.hasOwn(source || {}, "maintainerVerificationRevocation");
  const hasReviewHistory = Object.hasOwn(source || {}, "maintainerVerificationReviewHistory");
  const hasListingHistory = Object.hasOwn(source || {}, "listingValidationHistory");
  const listingHistory = hasListingHistory
    ? parseListingValidationHistory(source?.listingValidationHistory, {
      expectedRepository: repository,
      allowedRepositories,
      allowLegacyRepositoryFallback: !migrated,
      pluginIds: sourcePluginIds(source),
    })
    : [];
  const reviewHistory = hasReviewHistory
    ? parseMaintainerVerificationReviewHistory(source?.maintainerVerificationReviewHistory, {
      expectedRepository: repository,
      allowedRepositories,
      allowLegacyRepositoryFallback: !migrated,
      pluginIds: sourcePluginIds(source),
    })
    : [];
  const revocation = review
    ? parseMaintainerVerificationRevocation(source?.maintainerVerificationRevocation, review)
    : null;
  if (
    (hasReview && !review)
    || (!automatic && !review)
    || (hasRevocation && (!review || !revocation))
    || (hasReviewHistory && !reviewHistory)
    || (hasListingHistory && !listingHistory)
    || revocation
  ) return Object.freeze({ status: "unverified" });
  return Object.freeze({
    status: "verified",
    method: automatic ? "automated" : "maintainer-reviewed",
    baselineVersion: baseline.version,
    commit: baseline.commit,
    checkedAt: baseline.checkedAt,
    ...(review ? { reviewedAt: review.reviewedAt, reviewer: review.reviewer } : {}),
  });
}
