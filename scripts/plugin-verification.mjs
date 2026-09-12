import {
  CatalogVerificationProjectionError,
  isCommunityCatalogEntry,
  projectCatalogSourceVerification,
} from "./catalog-verification.mjs";
import { githubRepositoryKey, parseGitHubRepository } from "./github-repository.mjs";
import {
  listedSnapshotVerificationAction,
  standardInstallationVerificationAction,
  parseLegacyListedSnapshotVerificationIssue,
  parsePluginVerificationIssue,
  pluginVerificationAcknowledgment,
  PluginVerificationRequestError,
} from "./plugin-verification-request.mjs";
import { buildSecurityBaselineDetails } from "./security-baseline-report.mjs";
import { runSecurityBaseline } from "./security-baseline-scanner.mjs";
import {
  SecurityBaselineRecordError,
  toStoredSecurityBaselineRecord,
} from "./security-baseline-record.mjs";
import { sourceVerification } from "./verification-status.mjs";
import {
  createMaintainerVerificationReview,
  createMaintainerVerificationRevocation,
  MaintainerVerificationReviewError,
  matchesMaintainerVerificationExpectation,
  parseMaintainerVerificationRevocation,
  parseMaintainerVerificationReview,
  parseMaintainerVerificationReviewHistory,
  serializeMaintainerVerificationExpectation,
} from "./verification-review.mjs";
import {
  resolveListedSource,
  resolveVerificationSubject,
  VerificationSubjectError,
} from "./verification-subject.mjs";

export const verificationAcknowledgment = pluginVerificationAcknowledgment;
const reportMarker = "<!-- marketplace-plugin-verification -->";

export class PluginVerificationError extends Error {
  constructor(code, message, context = {}) {
    super(message);
    this.name = "PluginVerificationError";
    this.code = code;
    this.context = Object.freeze({ ...context });
  }
}

function mappedRequestCode(code) {
  return ({
    "request-fields-invalid": "verification-fields-invalid",
    "request-action-invalid": "verification-action-invalid",
    "request-plugin-id-invalid": "verification-plugin-id-invalid",
    "request-repository-invalid": "verification-repository-invalid",
    "request-commit-invalid": "verification-commit-invalid",
    "request-acknowledgment-missing": "verification-acknowledgment-missing",
    "request-standard-installation-acknowledgment-missing": "verification-standard-installation-acknowledgment-missing",
  })[code] || "verification-fields-invalid";
}

export function parseVerificationRequest(body) {
  try {
    const request = parsePluginVerificationIssue(body);
    if (![listedSnapshotVerificationAction, standardInstallationVerificationAction].includes(request.action)) {
      throw new PluginVerificationRequestError(
        "request-action-invalid",
        "Select a listed-snapshot verification action",
      );
    }
    return request;
  } catch (error) {
    if (!(error instanceof PluginVerificationRequestError)) throw error;
    if (error.code === "request-fields-invalid") {
      try {
        return parseLegacyListedSnapshotVerificationIssue(body);
      } catch (legacyError) {
        if (!(legacyError instanceof PluginVerificationRequestError)) throw legacyError;
        throw new PluginVerificationError(
          mappedRequestCode(legacyError.code),
          legacyError.message,
        );
      }
    }
    throw new PluginVerificationError(mappedRequestCode(error.code), error.message);
  }
}

function sourceRepository(source) {
  try {
    return parseGitHubRepository(source?.repo).slug.toLowerCase();
  } catch {
    return "";
  }
}

export function listedSourceForRequest(registry, request) {
  try {
    return resolveListedSource(registry, request);
  } catch (error) {
    if (!(error instanceof VerificationSubjectError)) throw error;
    throw new PluginVerificationError(error.code, error.message, error.context);
  }
}

function sourcePluginIds(source) {
  const ids = Object.keys(source?.plugins || {});
  if (source?.catalog?.id) ids.push(source.catalog.id);
  return ids.sort();
}

export function verificationBaselineRecord(baseline, source) {
  try {
    return toStoredSecurityBaselineRecord(baseline, {
      expectedRepository: sourceRepository(source),
      expectedCommit: source.listingValidatedCommit,
      pluginIds: sourcePluginIds(source),
    });
  } catch (error) {
    if (!(error instanceof SecurityBaselineRecordError)) throw error;
    throw new PluginVerificationError(
      "verification-baseline-invalid",
      "Automated baseline result is invalid or belongs to another listing",
    );
  }
}

export function verificationReviewRecord(baseline, reviewRequest) {
  try {
    return createMaintainerVerificationReview(baseline, reviewRequest);
  } catch (error) {
    if (!(error instanceof MaintainerVerificationReviewError)) throw error;
    throw new PluginVerificationError(
      error.code,
      "Maintainer review cannot verify this baseline result",
    );
  }
}

const standardInstallationNote = "Omarchy clones the current upstream repository, validates it locally, and only then installs and enables the plugin.";

function isValidManualInstallationOverride(installation) {
  return Boolean(
    installation
    && typeof installation === "object"
    && !Array.isArray(installation)
    && Object.getPrototypeOf(installation) === Object.prototype
    && installation.mode === "manual"
    && typeof installation.note === "string"
    && installation.note.trim()
    && JSON.stringify(Object.keys(installation).sort()) === JSON.stringify(["mode", "note"]),
  );
}

function sourceWithStandardInstallation(source, pluginId) {
  const pluginIds = Object.keys(source?.plugins || {});
  const plugin = source?.plugins?.[pluginId];
  if (
    pluginIds.length !== 1
    || !plugin
    || plugin.manifestPath !== "manifest.json"
    || !isValidManualInstallationOverride(plugin.installation)
  ) {
    throw new PluginVerificationError(
      "verification-standard-installation-ineligible",
      "Standard installation changes are limited to one listed root plugin with a valid manual installation override",
      { pluginId },
    );
  }
  const { installation: ignoredInstallation, ...withoutInstallation } = plugin;
  return {
    ...source,
    plugins: {
      ...source.plugins,
      [pluginId]: withoutInstallation,
    },
  };
}

function catalogPluginForStandardInstallation(catalog, source, pluginId) {
  const repository = githubRepositoryKey(source.repo);
  const matches = (catalog?.plugins || []).filter((plugin) => {
    try {
      return !plugin?.placeholder
        && !plugin?.builtIn
        && isCommunityCatalogEntry(plugin)
        && plugin.id === pluginId
        && githubRepositoryKey(plugin.repo) === repository;
    } catch {
      return false;
    }
  });
  if (matches.length !== 1) {
    throw new PluginVerificationError(
      "verification-catalog-listing-missing",
      "The existing catalog must contain exactly one matching community listing",
      { pluginId },
    );
  }
  const [plugin] = matches;
  if (plugin.manifestPath !== "manifest.json" || plugin.repositoryLayout !== "root-plugin") {
    throw new PluginVerificationError(
      "verification-standard-installation-catalog-mismatch",
      "The catalog listing does not describe the same root-plugin installation boundary",
      { pluginId },
    );
  }
  if (plugin.upstreamCheckStatus !== "passed") {
    throw new PluginVerificationError(
      "verification-standard-installation-compatibility-failed",
      "Standard installation requires a passing current upstream compatibility check",
      { pluginId },
    );
  }
  const manualNote = source.plugins?.[pluginId]?.installation?.note;
  if (
    plugin.installAvailable !== false
    || plugin.installCommand !== ""
    || plugin.installNote !== manualNote
    || plugin.status !== "Manual setup"
  ) {
    throw new PluginVerificationError(
      "verification-standard-installation-catalog-mismatch",
      "The catalog listing does not preserve the current manual installation boundary",
      { pluginId },
    );
  }
  return plugin;
}

function catalogWithStandardInstallation(catalog, source, pluginId) {
  const catalogPlugin = catalogPluginForStandardInstallation(catalog, source, pluginId);
  const repository = parseGitHubRepository(source.repo);
  const repositoryUrl = `https://github.com/${repository.owner}/${repository.repository}.git`;
  let changed = false;
  const plugins = catalog.plugins.map((plugin) => {
    if (plugin !== catalogPlugin) return plugin;
    const clonedFrom = plugin.clonedFrom || "";
    const next = {
      ...plugin,
      repositoryLayout: "root-plugin",
      installAvailable: true,
      installCommand: clonedFrom
        ? `omarchy plugin add ${repositoryUrl} --enable && omarchy restart shell`
        : `omarchy plugin add ${repositoryUrl} --enable`,
      installNote: clonedFrom
        ? `${standardInstallationNote} This replaces the built-in ${clonedFrom} service, so the shell needs a restart before the swap fully takes effect.`
        : standardInstallationNote,
      status: "Available",
    };
    changed ||= JSON.stringify(next) !== JSON.stringify(plugin);
    return next;
  });
  if (!changed) return catalog;
  return { ...catalog, plugins };
}

function replaceSource(registry, target, replacement) {
  return {
    ...registry,
    sources: (registry.sources || []).map((source) => source === target ? replacement : source),
  };
}

export function revokeMaintainerVerification({
  body,
  registry,
  catalog,
  revocation,
  reviewRequestEventId = 0,
  now = () => new Date().toISOString(),
}) {
  let request;
  let subject;
  if (Number.isSafeInteger(reviewRequestEventId) && reviewRequestEventId > 0) {
    const matches = (registry?.sources || []).filter((candidate) => (
      candidate?.type === "plugin-source"
      && candidate?.maintainerVerificationReview?.requestEventId === reviewRequestEventId
    ));
    if (matches.length !== 1) {
      throw new PluginVerificationError(
        "verification-revocation-source-mismatch",
        "The maintainer verification review event does not identify exactly one current source",
      );
    }
    const [candidate] = matches;
    const pluginIds = Object.keys(candidate.plugins || {}).sort();
    request = {
      action: listedSnapshotVerificationAction,
      pluginId: pluginIds[0] || "",
      repository: sourceRepository(candidate),
      repoUrl: candidate.repo,
      commitSha: String(candidate.listingValidatedCommit || "").toLowerCase(),
    };
  } else {
    request = parseVerificationRequest(body);
    if (request.action !== listedSnapshotVerificationAction) {
      throw new PluginVerificationError(
        "verification-revocation-action-invalid",
        "Maintainer verification revocation is limited to listed-snapshot verification issues",
      );
    }
  }
  try {
    subject = resolveVerificationSubject(registry, catalog, request);
  } catch (error) {
    if (!(error instanceof VerificationSubjectError)) throw error;
    throw new PluginVerificationError(error.code, error.message, error.context);
  }
  const source = subject.source;
  const review = parseMaintainerVerificationReview(
    source?.maintainerVerificationReview,
    source?.automatedSecurityBaseline,
  );
  if (!review) {
    throw new PluginVerificationError(
      "verification-revocation-ineligible",
      "Only a current exact commit-bound maintainer review can be revoked",
      { pluginId: request.pluginId },
    );
  }
  const currentRevocation = parseMaintainerVerificationRevocation(
    source?.maintainerVerificationRevocation,
    review,
  );
  if (currentRevocation) {
    if (currentRevocation.revocationEventId >= revocation?.revocationEventId) {
      return Object.freeze({
        status: "already-revoked",
        changed: false,
        request,
        subject,
        source,
        registry,
        catalog,
        baseline: source.automatedSecurityBaseline,
        verification: sourceVerification(source),
        revocation: currentRevocation,
      });
    }
    throw new PluginVerificationError(
      "verification-revocation-event-stale",
      "A newer maintainer-review revocation is already recorded",
      { pluginId: request.pluginId },
    );
  }
  let nextRevocation;
  try {
    nextRevocation = createMaintainerVerificationRevocation(review, revocation);
  } catch (error) {
    if (!(error instanceof MaintainerVerificationReviewError)) throw error;
    throw new PluginVerificationError(error.code, error.message);
  }
  const nextSource = {
    ...source,
    maintainerVerificationRevocation: nextRevocation,
  };
  const nextRegistry = replaceSource(registry, source, nextSource);
  const nextCatalog = updateCatalogVerification(catalog, nextSource, request.pluginId, {
    generatedAt: now(),
  });
  return Object.freeze({
    status: "revoked",
    changed: JSON.stringify(nextRegistry) !== JSON.stringify(registry)
      || JSON.stringify(nextCatalog) !== JSON.stringify(catalog),
    request,
    subject: Object.freeze({ ...subject, source: nextSource }),
    source: nextSource,
    registry: nextRegistry,
    catalog: nextCatalog,
    baseline: source.automatedSecurityBaseline,
    verification: sourceVerification(nextSource),
    revocation: nextRevocation,
    maintainerReviewRequested: false,
    installationChanged: false,
  });
}

export function updateCatalogVerification(catalog, source, pluginId = "", options = {}) {
  try {
    return projectCatalogSourceVerification(catalog, source, {
      requiredPluginId: pluginId,
      generatedAt: options.generatedAt || "",
    });
  } catch (error) {
    if (!(error instanceof CatalogVerificationProjectionError)) throw error;
    throw new PluginVerificationError(error.code, error.message);
  }
}

export async function analyzeListedPluginVerification({
  body,
  registry,
  catalog,
  runBaseline = runSecurityBaseline,
  token,
  now = () => new Date().toISOString(),
  maintainerReview = null,
  standardInstallationApproval = null,
}) {
  const request = parseVerificationRequest(body);
  const standardInstallationRequested = request.action === standardInstallationVerificationAction;
  if (
    standardInstallationRequested
    && (
      !standardInstallationApproval
      || !Number.isSafeInteger(standardInstallationApproval.requestEventId)
      || standardInstallationApproval.requestEventId < 1
      || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(standardInstallationApproval.reviewer || "")
      || !Number.isFinite(Date.parse(standardInstallationApproval.requestedAt || ""))
    )
  ) {
    throw new PluginVerificationError(
      "verification-standard-installation-authorization-missing",
      "Standard installation changes require an authenticated maintainer approval label event",
    );
  }
  let subject;
  try {
    subject = resolveVerificationSubject(registry, catalog, request);
  } catch (error) {
    if (!(error instanceof VerificationSubjectError)) throw error;
    throw new PluginVerificationError(error.code, error.message, error.context);
  }
  const source = subject.source;
  if (standardInstallationRequested) sourceWithStandardInstallation(source, request.pluginId);
  const currentVerification = sourceVerification(source);
  if (currentVerification.status === "verified" && !maintainerReview && !standardInstallationRequested) {
    const nextCatalog = updateCatalogVerification(catalog, source, request.pluginId, {
      generatedAt: now(),
    });
    const changed = nextCatalog !== catalog;
    return Object.freeze({
      status: changed ? "verified" : "already-verified",
      changed,
      request,
      subject,
      source,
      registry,
      catalog: nextCatalog,
      baseline: source.automatedSecurityBaseline,
      verification: currentVerification,
      maintainerReviewRequested: Boolean(maintainerReview),
      installationChanged: false,
    });
  }

  const baseline = await runBaseline(source.repo, request.commitSha, {
    token,
    listedPlugins: subject.listedPlugins,
  });
  const record = verificationBaselineRecord(baseline, source);
  if (standardInstallationRequested && record.outcome !== "passed") {
    return Object.freeze({
      status: "unverified",
      changed: false,
      request,
      subject,
      source,
      registry,
      catalog,
      baseline: record,
      scanResult: baseline,
      maintainerReviewRequested: Boolean(maintainerReview),
      standardInstallationRejected: true,
      code: "verification-standard-installation-requires-passing",
      reason: "A passing automated baseline is required before removing a manual installation override.",
      installationChanged: false,
    });
  }
  let review = null;
  const hasStoredReview = Object.hasOwn(source || {}, "maintainerVerificationReview");
  const storedReview = hasStoredReview
    ? parseMaintainerVerificationReview(source.maintainerVerificationReview, source.automatedSecurityBaseline)
    : null;
  const reviewInvalid = hasStoredReview && !storedReview;
  const hasReviewHistory = Object.hasOwn(source || {}, "maintainerVerificationReviewHistory");
  const storedReviewHistory = hasReviewHistory
    ? parseMaintainerVerificationReviewHistory(source.maintainerVerificationReviewHistory, {
      expectedRepository: source.automatedSecurityBaseline?.repository,
      pluginIds: sourcePluginIds(source),
    })
    : [];
  const reviewHistoryInvalid = hasReviewHistory && !storedReviewHistory;
  const hasStoredRevocation = Object.hasOwn(source || {}, "maintainerVerificationRevocation");
  const storedRevocation = parseMaintainerVerificationRevocation(
    source?.maintainerVerificationRevocation,
    source?.maintainerVerificationReview,
  );
  const revocationInvalid = hasStoredRevocation && !storedRevocation;
  const revocationEventMismatch = Boolean(
    maintainerReview
    && hasStoredRevocation
    && (!storedRevocation || maintainerReview.requestEventId <= storedRevocation.revocationEventId),
  );
  const reviewExpectationMismatch = Boolean(
    maintainerReview
    && record.outcome === "review-required"
    && !matchesMaintainerVerificationExpectation(maintainerReview.expectation, record),
  );
  if (
    maintainerReview
    && record.outcome === "review-required"
    && !reviewExpectationMismatch
    && !revocationEventMismatch
  ) {
    review = verificationReviewRecord(record, {
      reviewedBaseline: maintainerReview.expectation,
      reviewer: maintainerReview.reviewer,
      requestEventId: maintainerReview.requestEventId,
      requestedAt: maintainerReview.requestedAt,
      reviewedAt: now(),
    });
  }
  if (reviewInvalid || reviewHistoryInvalid || revocationInvalid || revocationEventMismatch || (record.outcome !== "passed" && !review)) {
    return Object.freeze({
      status: "unverified",
      changed: false,
      request,
      subject,
      source,
      registry,
      catalog,
      baseline: record,
      scanResult: baseline,
      maintainerReviewRequested: Boolean(maintainerReview),
      reviewExpectationMismatch,
      reviewInvalid,
      reviewHistoryInvalid,
      revocationInvalid,
      revocationEventMismatch,
      installationChanged: false,
    });
  }

  const priorReviewHistory = storedReviewHistory;
  const nextReviewHistory = storedRevocation
    ? [
      ...priorReviewHistory,
      {
        maintainerVerificationReview: source.maintainerVerificationReview,
        maintainerVerificationRevocation: source.maintainerVerificationRevocation,
      },
    ]
    : priorReviewHistory;
  const publicationSource = standardInstallationRequested
    ? sourceWithStandardInstallation(source, request.pluginId)
    : source;
  const {
    maintainerVerificationReview: ignoredReview,
    maintainerVerificationRevocation: ignoredRevocation,
    ...sourceWithoutReview
  } = publicationSource;
  const nextSource = {
    ...sourceWithoutReview,
    automatedSecurityBaseline: record,
    ...(nextReviewHistory.length ? { maintainerVerificationReviewHistory: nextReviewHistory } : {}),
    ...(review ? { maintainerVerificationReview: review } : {}),
  };
  const verification = sourceVerification(nextSource);
  if (verification.status !== "verified") {
    throw new PluginVerificationError(
      "verification-review-invalid",
      "Verification evidence did not produce a valid commit-bound status",
    );
  }
  const nextRegistry = replaceSource(registry, source, nextSource);
  let nextCatalog = updateCatalogVerification(catalog, nextSource, request.pluginId, {
    generatedAt: record.checkedAt,
  });
  if (standardInstallationRequested) {
    nextCatalog = catalogWithStandardInstallation(nextCatalog, source, request.pluginId);
  }
  return Object.freeze({
    status: "verified",
    changed: JSON.stringify(nextRegistry) !== JSON.stringify(registry)
      || JSON.stringify(nextCatalog) !== JSON.stringify(catalog),
    request,
    subject: Object.freeze({ ...subject, source: nextSource }),
    source: nextSource,
    registry: nextRegistry,
    catalog: nextCatalog,
    baseline: record,
    scanResult: baseline,
    verification,
    maintainerReview: review,
    maintainerReviewRequested: Boolean(maintainerReview),
    revocationInvalid,
    revocationEventMismatch,
    installationChanged: standardInstallationRequested,
  });
}

function safeInline(value) {
  return String(value || "")
    .replace(/[^A-Za-z0-9._/@:-]+/g, " ")
    .replaceAll("@", "@\u200b")
    .trim()
    .slice(0, 200);
}

export function buildVerificationReport(result) {
  const pluginId = safeInline(result?.request?.pluginId || "plugin");
  const commit = safeInline(result?.request?.commitSha || "").slice(0, 7);
  const method = result?.verification?.method
    || (result?.maintainerReview ? "maintainer-reviewed" : "automated");
  const expectationMarker = result?.status === "unverified"
    && result?.baseline?.outcome === "review-required"
    ? serializeMaintainerVerificationExpectation(result.baseline)
    : "";
  const lines = [
    reportMarker,
    ...(expectationMarker ? [expectationMarker] : []),
    "## Plugin verification",
    "",
  ];
  if (["verified", "already-verified"].includes(result?.status)) {
    lines.push(`✅ **Verified** \`${pluginId}\` at listed commit \`${commit}…\`.`, "");
    if (method === "maintainer-reviewed") {
      const review = result.maintainerReview || {
        reviewer: result.verification?.reviewer,
        reviewedAt: result.verification?.reviewedAt,
        findings: result.baseline?.findings,
        capabilities: result.baseline?.capabilities,
      };
      const findings = (review.findings || [])
        .map((id) => `\`${safeInline(id)}\``)
        .join(", ") || "none";
      const capabilities = (review.capabilities || [])
        .map((id) => `\`${safeInline(id)}\``)
        .join(", ") || "none";
      lines.push(
        result.status === "already-verified"
          ? "A current commit-bound maintainer review was already recorded."
          : "A marketplace maintainer reviewed and accepted the reported findings and capabilities for this exact commit.",
        "",
        `Review basis: \`maintainer-reviewed\` by \`${safeInline(review.reviewer)}\` at \`${safeInline(review.reviewedAt)}\`.`,
        `Accepted findings: ${findings}.`,
        `Accepted capabilities: ${capabilities}.`,
      );
    } else {
      lines.push(result.status === "already-verified"
        ? "A current passing automated baseline was already recorded."
        : "Automated checks passed and the commit-bound verification record is ready for publication.");
    }
    if (result?.installationChanged) {
      lines.push(
        "",
        "The manual installation override was removed for this listed root plugin. The catalog now provides the standard mutable upstream installation command.",
      );
    }
  } else if (["revoked", "already-revoked"].includes(result?.status)) {
    lines.push(
      `⚪ **Maintainer verification revoked** \`${pluginId}\` at listed commit \`${commit}…\`.`,
      "",
      "The maintainer verification label was removed by an authorized maintainer. The exact review evidence remains preserved, but this snapshot is now Unverified until a fresh review is completed.",
    );
  } else if (result?.status === "unverified") {
    lines.push(
      `⚪ **Unverified** \`${pluginId}\` at listed commit \`${commit}…\`.`,
      "",
      result.baseline?.outcome === "review-required"
        ? "The automated baseline result was `review-required`. Verification requires either a passing result or an eligible commit-bound maintainer review."
        : `The automated baseline result was \`${safeInline(result.baseline?.outcome)}\`. A passing result is required for verification.`,
    );
    if (result.standardInstallationRejected) {
      lines.push(
        "",
        "Standard installation changes require a passing automated baseline. A review-required result cannot remove a manual installation override.",
      );
    } else if (result.reviewInvalid) {
      lines.push(
        "",
        "Stored maintainer-review evidence is malformed. No verification publication is allowed until the exact record is repaired.",
      );
    } else if (result.reviewHistoryInvalid) {
      lines.push(
        "",
        "Stored maintainer-review history is malformed. No verification publication is allowed until the exact record is repaired.",
      );
    } else if (result.revocationInvalid) {
      lines.push(
        "",
        "Stored maintainer-review revocation evidence is malformed. No verification publication is allowed until the exact record is repaired.",
      );
    } else if (result.revocationEventMismatch) {
      lines.push(
        "",
        "The previous maintainer review was revoked. A fresh eligible report and a new `maintainer-verified` label event after the revocation are required.",
      );
    } else if (result.reviewExpectationMismatch) {
      lines.push(
        "",
        "The rescanned capability evidence differs from the report that was approved. Review this updated report, then remove and reapply `maintainer-verified` to make a new decision.",
      );
    } else if (result.maintainerReviewRequested && result.baseline?.outcome !== "review-required") {
      lines.push(
        "",
        "Maintainer verification is not available for findings, scan failures, or any outcome other than `review-required`.",
      );
    }
    if (result.scanResult) {
      lines.push(
        "",
        buildSecurityBaselineDetails(result.scanResult, {
          headingLevel: 3,
          context: "verification",
        }),
      );
    }
  } else {
    lines.push(
      "⚠️ **Verification could not complete.**",
      "",
      safeInline(result?.reason || "The request or static scan could not be verified."),
    );
  }
  if (
    result?.maintainerReviewRequested
    && !["verified", "already-verified"].includes(result?.status)
  ) {
    lines.push(
      "",
      expectationMarker
        ? "To retry maintainer review, review this updated report, then remove and reapply the `maintainer-verified` label."
        : "To retry, edit the open issue or reopen it to run normal verification. Only after the bot publishes a new eligible `review-required` report, remove and reapply the `maintainer-verified` label.",
    );
  }
  if ((result?.subject?.pluginIds || []).length > 1) {
    lines.push(
      "",
      `This source-wide result applies to: ${result.subject.pluginIds.map((id) => `\`${safeInline(id)}\``).join(", ")}.`,
    );
  }
  lines.push(
    "",
    "Verification applies only to the exact listed commit. It is not a security audit, certification, warranty, or endorsement.",
  );
  return `${lines.join("\n")}\n`;
}

export function publicVerificationFailure(error) {
  const code = String(error?.code || "verification-internal-error");
  const reasons = {
    "verification-fields-invalid": "Use the verification issue form without changing its headings.",
    "verification-action-invalid": "Select the currently listed snapshot action in the verification form.",
    "verification-plugin-id-invalid": "Enter the exact existing plugin ID.",
    "verification-repository-invalid": "Enter the existing public GitHub repository root URL.",
    "verification-commit-invalid": "Enter the full 40-character listed commit SHA.",
    "verification-acknowledgment-missing": "Confirm the verification acknowledgment.",
    "verification-standard-installation-acknowledgment-missing": "Confirm that the listed root plugin supports standard installation.",
    "verification-standard-installation-ineligible": "Standard installation changes are limited to one listed root plugin with a valid manual installation override.",
    "verification-standard-installation-catalog-mismatch": "The catalog does not describe the same root-plugin installation boundary as the listing.",
    "verification-standard-installation-compatibility-failed": "Standard installation remains unavailable while the current upstream compatibility check is failed.",
    "verification-standard-installation-requires-passing": "A passing automated baseline is required before removing a manual installation override.",
    "verification-standard-installation-authorization-missing": "Standard installation changes require an authenticated maintainer approval label event.",
    "verification-revocation-action-invalid": "Maintainer verification revocation is limited to listed-snapshot verification issues.",
    "verification-revocation-ineligible": "Only a current exact commit-bound maintainer review can be revoked.",
    "verification-revocation-event-stale": "A newer maintainer-review revocation is already recorded.",
    "verification-revocation-invalid": "The revocation event could not be bound to the current maintainer review.",
    "verification-plugin-not-listed": "The plugin ID does not identify an existing community listing.",
    "verification-source-unsupported": "This first verification workflow supports plugin-source listings, not shell suites.",
    "verification-repository-mismatch": "The repository does not match the existing listing.",
    "verification-commit-mismatch": "Only the existing listed commit can be verified in this workflow.",
    "verification-catalog-listing-missing": "The existing listing is missing from the generated catalog.",
    "verification-catalog-plugin-set-mismatch": "The catalog plugin set does not match the registry source.",
    "verification-baseline-invalid": "The static result could not be bound to the existing listing.",
    "verification-review-invalid": "Maintainer review is unavailable because the exact baseline is not eligible or the review evidence is invalid.",
    "verification-review-expectation-invalid": "The prior bot-authored review report is missing or invalid. Run verification again before requesting maintainer review.",
    "security-baseline-unavailable": "The exact listed commit could not be scanned completely.",
    "security-baseline-scan-limit": "The exact listed commit exceeds a deterministic scan limit.",
  };
  return {
    status: "error",
    changed: false,
    code: Object.hasOwn(reasons, code) ? code : "verification-internal-error",
    reason: reasons[code] || "The verification service could not complete safely.",
  };
}
