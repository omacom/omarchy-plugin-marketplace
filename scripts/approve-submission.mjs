import { appendFile, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inspectSubmission } from "./build-catalog.mjs";
import { parseGitHubRepository } from "./github-repository.mjs";
import {
  assertRightsConfirmation,
  hasRightsConfirmation,
  isLegacySubmission,
  parseIssueSubmission,
  parseSubmissionBody,
  rightsStatement,
} from "./submission.mjs";
import { publicSubmissionFailure } from "./submission-feedback.mjs";
import { assertApprovalAllowed } from "./security-baseline-approval.mjs";
import {
  findLatestSecurityBaseline,
  SecurityBaselineRecordError,
  toStoredSecurityBaselineRecord,
} from "./security-baseline-record.mjs";
import {
  securityBaselineEligibleForVerifiedPublicationReview,
  securityBaselineErrorMarker,
  securityBaselineMarkerPrefix,
} from "./security-baseline-policy.mjs";
import { runSecurityBaseline } from "./security-baseline-scanner.mjs";
import { sourceVerification } from "./verification-status.mjs";
import {
  createMaintainerVerificationReview,
  MaintainerVerificationReviewError,
  matchesSecurityBaselineEvidence,
} from "./verification-review.mjs";

export {
  assertRightsConfirmation,
  hasRightsConfirmation,
  isLegacySubmission,
  parseSubmissionBody,
  rightsStatement,
};

export const approvedAndVerifiedLabel = "approved-and-verified";
export const legacyApprovalLabel = "approved-for-listing";
export const manualSetupNote = "This plugin requires additional setup before it can be enabled. Follow the upstream installation instructions.";

export class SubmissionApprovalError extends Error {
  constructor(code, message, context = {}) {
    super(message);
    this.name = "SubmissionApprovalError";
    this.code = code;
    this.context = Object.freeze({ ...context });
  }
}

export function canApprove(permission) {
  return new Set(["admin", "maintain", "write"]).has(String(permission || "").toLowerCase());
}

export function assertApprovedIssueBody(currentBody, approvedBody) {
  if (typeof approvedBody !== "string") {
    throw new SubmissionApprovalError(
      "approval-body-changed",
      "APPROVED_ISSUE_BODY is required",
    );
  }
  if (String(currentBody || "") !== approvedBody) {
    throw new SubmissionApprovalError(
      "approval-body-changed",
      "The submission changed after approval; review it again before reapplying approved-and-verified",
    );
  }
}

export function parseApprovableSubmission(issue) {
  return parseIssueSubmission(issue);
}

export function assertApprovedIssueTitle(currentTitle, approvedTitle) {
  if (typeof approvedTitle !== "string" || currentTitle !== approvedTitle) {
    throw new SubmissionApprovalError(
      "approval-body-changed",
      "The submission title changed after approval; review it again before reapplying approved-and-verified",
    );
  }
}

export function parseApprovedSubmissionSnapshot(issue, approvedIssueBody, approvedIssueTitle) {
  assertApprovedIssueBody(issue?.body, approvedIssueBody);
  assertApprovedIssueTitle(issue?.title, approvedIssueTitle);
  return parseApprovableSubmission(issue);
}

export function createRegistrySource({
  submission,
  manifests,
  addedAt,
  listedAt,
  listingValidatedCommit,
  listingValidatedAt,
  listingValidatedBranch,
  automatedSecurityBaseline = null,
  maintainerVerificationReview = null,
  manualSetup = false,
}) {
  if (typeof manualSetup !== "boolean") throw new TypeError("manualSetup must be a boolean");
  if (automatedSecurityBaseline !== null && typeof automatedSecurityBaseline !== "object") {
    throw new TypeError("automatedSecurityBaseline must be an object or null");
  }
  if (maintainerVerificationReview !== null && typeof maintainerVerificationReview !== "object") {
    throw new TypeError("maintainerVerificationReview must be an object or null");
  }
  const plugins = Object.fromEntries(
    manifests.map((manifest) => [
      manifest.id,
      {
        category: submission.category,
        tags: submission.tags,
        ...(manifest.path ? { manifestPath: manifest.path } : {}),
        ...(manualSetup
          ? {
              installation: {
                mode: "manual",
                note: manualSetupNote,
              },
            }
          : {}),
      },
    ]),
  );

  return {
    repo: submission.repo,
    type: "plugin-source",
    addedAt,
    listedAt,
    listingValidatedCommit,
    listingValidatedAt,
    listingValidatedBranch,
    ...(automatedSecurityBaseline ? { automatedSecurityBaseline } : {}),
    ...(maintainerVerificationReview ? { maintainerVerificationReview } : {}),
    plugins,
  };
}

export function createApprovedSecurityBaseline(baseline, options = {}) {
  try {
    return toStoredSecurityBaselineRecord(baseline, options);
  } catch (error) {
    if (!(error instanceof SecurityBaselineRecordError)) throw error;
    throw new SubmissionApprovalError(
      "approval-security-baseline-invalid",
      "The automated security baseline metadata is invalid",
    );
  }
}

export function createApprovedVerificationEvidence({
  reviewedBaseline,
  rescannedBaseline,
  recordOptions,
  reviewer,
  requestEventId,
  requestedAt,
  reviewedAt,
}) {
  const reviewedRecord = createApprovedSecurityBaseline(reviewedBaseline, recordOptions);
  const rescannedRecord = createApprovedSecurityBaseline(rescannedBaseline, recordOptions);
  if (!matchesSecurityBaselineEvidence(reviewedRecord, rescannedRecord)) {
    throw new SubmissionApprovalError(
      "approval-security-baseline-changed",
      "The fresh security baseline does not match the report approved by the maintainer",
    );
  }
  if (rescannedRecord.outcome === "passed") {
    return Object.freeze({
      automatedSecurityBaseline: rescannedRecord,
      maintainerVerificationReview: null,
      verificationMethod: "automated",
    });
  }
  if (!securityBaselineEligibleForVerifiedPublicationReview(rescannedRecord)) {
    throw new SubmissionApprovalError(
      "approval-security-needs-fixes",
      "Verified snapshots cannot be published while the security baseline has blocking findings",
    );
  }
  let review;
  try {
    review = createMaintainerVerificationReview(rescannedRecord, {
      reviewedBaseline: reviewedRecord,
      reviewer,
      requestEventId,
      requestedAt,
      reviewedAt,
      verifiedPublication: true,
    });
  } catch (error) {
    if (!(error instanceof MaintainerVerificationReviewError)) throw error;
    throw new SubmissionApprovalError(
      error.code,
      "The approved selective review is invalid or no longer matches the fresh scan",
    );
  }
  return Object.freeze({
    automatedSecurityBaseline: rescannedRecord,
    maintainerVerificationReview: review,
    verificationMethod: "maintainer-reviewed",
  });
}

function approvalPluginMetadata(plugins = {}) {
  return Object.fromEntries(
    Object.entries(plugins)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, plugin]) => [
        id,
        {
          category: plugin.category,
          tags: plugin.tags,
          ...(Object.hasOwn(plugin, "installation")
            ? { installation: plugin.installation }
            : {}),
        },
      ]),
  );
}

export function addRegistrySource(
  registry,
  source,
  existingPluginIds = [],
  retiredPluginIds = [],
) {
  const sources = Array.isArray(registry.sources) ? registry.sources : [];
  const candidate = parseGitHubRepository(source.repo).slug.toLowerCase();
  const existingSource = sources.find(
    (entry) => parseGitHubRepository(entry.repo).slug.toLowerCase() === candidate,
  );
  if (existingSource) {
    const existingIds = Object.keys(existingSource.plugins || {}).sort();
    const candidateIds = Object.keys(source.plugins || {}).sort();
    if (JSON.stringify(existingIds) !== JSON.stringify(candidateIds)) {
      throw new SubmissionApprovalError(
        "approval-source-changed",
        `${source.repo} is already registered with a different plugin set`,
      );
    }
    if (
      JSON.stringify(approvalPluginMetadata(existingSource.plugins))
      === JSON.stringify(approvalPluginMetadata(source.plugins))
    ) {
      return registry;
    }
    throw new SubmissionApprovalError(
      "approval-metadata-changed",
      `${source.repo} is already registered with different listing metadata`,
    );
  }

  const existing = new Set(existingPluginIds);
  const retired = new Set(retiredPluginIds);
  for (const pluginId of Object.keys(source.plugins)) {
    if (retired.has(pluginId)) {
      throw new SubmissionApprovalError(
        "plugin-id-retired",
        `Plugin ID "${pluginId}" was used by a previous listing`,
        { pluginId },
      );
    }
    if (existing.has(pluginId)) {
      throw new SubmissionApprovalError(
        "plugin-id-listed",
        `Plugin ID "${pluginId}" is already listed`,
        { pluginId },
      );
    }
  }

  return { ...registry, sources: [...sources, source] };
}

export async function githubApi(path, token) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "omarchy-plugin-marketplace-approval",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API returned ${response.status} for ${path}`);
  }
  return response.json();
}

export async function githubIssueComments(repositoryName, issueNumber, token) {
  const comments = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await githubApi(
      `/repos/${repositoryName}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
      token,
    );
    if (!Array.isArray(batch) || batch.length > 100) {
      throw new SubmissionApprovalError(
        "approval-security-baseline-invalid",
        "GitHub returned an invalid or oversized issue comment page",
      );
    }
    comments.push(...batch);
    if (batch.length < 100) return comments;
  }
  throw new SubmissionApprovalError(
    "approval-security-baseline-invalid",
    "The submission has too many comments to locate its security baseline safely",
  );
}

export async function githubIssueEvents(repositoryName, issueNumber, token) {
  const events = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await githubApi(
      `/repos/${repositoryName}/issues/${issueNumber}/events?per_page=100&page=${page}`,
      token,
    );
    if (!Array.isArray(batch) || batch.length > 100) {
      throw new SubmissionApprovalError(
        "approval-event-invalid",
        "GitHub returned an invalid or oversized issue event page",
      );
    }
    events.push(...batch);
    if (batch.length < 100) return events;
  }
  throw new SubmissionApprovalError(
    "approval-event-invalid",
    "The submission has too many events to locate its approval decision safely",
  );
}

function approvalTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.000)?Z$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().replace(".000Z", "Z") === value.replace(".000Z", "Z")
    ? time
    : null;
}

export function approvalDecisionForEvents(events, {
  approver,
  expectedEventId,
  expectedRequestedAt,
  expectedTriggeredAt,
} = {}) {
  const requestedAt = approvalTimestamp(expectedRequestedAt);
  const triggeredAt = approvalTimestamp(
    expectedEventId === undefined ? expectedRequestedAt : expectedTriggeredAt,
  );
  const invalid = () => {
    throw new SubmissionApprovalError(
      "approval-event-invalid",
      "The approval trigger is missing, ambiguous, or no longer current",
    );
  };
  if (
    !Array.isArray(events)
    || typeof approver !== "string" || !approver
    || requestedAt === null
    || triggeredAt === null
    || (expectedEventId !== undefined && (!Number.isSafeInteger(expectedEventId) || expectedEventId < 1))
  ) invalid();

  const transitions = [];
  const ids = new Set();
  for (const event of events) {
    if (!event || typeof event !== "object" || typeof event.event !== "string") invalid();
    if (!["labeled", "unlabeled"].includes(event.event)) continue;
    if (typeof event.label?.name !== "string") invalid();
    if (event.label.name !== approvedAndVerifiedLabel) continue;
    if (
      !Number.isSafeInteger(event.id) || event.id < 1 || ids.has(event.id)
      || approvalTimestamp(event.created_at) === null
      || typeof event.actor?.login !== "string" || !event.actor.login
    ) invalid();
    ids.add(event.id);
    transitions.push(event);
  }
  transitions.sort((left, right) => (
    approvalTimestamp(left.created_at) - approvalTimestamp(right.created_at)
    || left.id - right.id
  ));
  // The issues webhook has no timeline event ID. On initial admission only, accept
  // GitHub's observed event timestamp as either equal to issue.updated_at or exactly
  // one second earlier. Count every approval transition in those two UTC seconds
  // before checking actor or action, and fail closed on ambiguity. Once selected,
  // later checks must retain the exact event ID and its actual timestamp while
  // confirming that no delayed transition made the original window ambiguous.
  const initialTimes = new Set([triggeredAt, triggeredAt - 1_000]);
  const candidates = transitions.filter((event) => (
    initialTimes.has(approvalTimestamp(event.created_at))
  ));
  if (candidates.length !== 1) invalid();
  const resolvedEventId = expectedEventId ?? candidates[0].id;
  if (candidates[0].id !== resolvedEventId) invalid();
  const latest = transitions.at(-1);
  if (
    !latest
    || latest.id !== resolvedEventId
    || latest.event !== "labeled"
    || latest.actor.login !== approver
    || (expectedEventId !== undefined && approvalTimestamp(latest.created_at) !== requestedAt)
  ) {
    throw new SubmissionApprovalError(
      "approval-event-invalid",
      "The approved-and-verified label event does not match this workflow request",
    );
  }
  return Object.freeze({
    eventId: latest.id,
    requestedAt: latest.created_at,
    reviewer: latest.actor.login,
  });
}

export function latestSecurityBaselineComment(comments) {
  const candidates = (comments || [])
    .filter((comment) => {
      const body = String(comment?.body || "");
      return comment?.user?.login === "github-actions[bot]"
        && (body.includes(securityBaselineMarkerPrefix) || body.includes(securityBaselineErrorMarker));
    })
    .sort((left, right) => (
      String(left.created_at).localeCompare(String(right.created_at))
      || Number(left.id) - Number(right.id)
    ));
  const latest = candidates.at(-1);
  const baseline = latest ? findLatestSecurityBaseline([latest]) : null;
  if (
    !latest
    || !Number.isSafeInteger(latest.id)
    || latest.id < 1
    || !Number.isFinite(Date.parse(latest.updated_at || ""))
    || !baseline
  ) {
    throw new SubmissionApprovalError(
      "approval-security-baseline-invalid",
      "The latest bot-authored security baseline report is missing or invalid",
    );
  }
  return Object.freeze({
    commentId: latest.id,
    updatedAt: latest.updated_at,
    baseline,
  });
}

function safeMarkdownText(value) {
  return String(value)
    .replace(/[<>`\r\n]+/g, " ")
    .trim()
    .replaceAll("\\", "\\\\")
    .replace(/([*_\[\]()~|])/g, "\\$1")
    .replaceAll("@", "@\u200b");
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function parseManualSetupApproval(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("MANUAL_SETUP must be true or false");
}

export async function recheckApprovalState({
  repositoryName,
  issueNumber,
  token,
  approvedIssueBody,
  approvedIssueTitle,
  repoUrl,
  approver,
  expectedEventId,
  expectedRequestedAt,
  expectedTriggeredAt,
  expectedBaselineCommentId,
  expectedBaselineCommentUpdatedAt,
  expectedManualSetup,
}) {
  const [issue, inspection, comments, events, permission] = await Promise.all([
    githubApi(`/repos/${repositoryName}/issues/${issueNumber}`, token),
    inspectSubmission(repoUrl),
    githubIssueComments(repositoryName, issueNumber, token),
    githubIssueEvents(repositoryName, issueNumber, token),
    githubApi(
      `/repos/${repositoryName}/collaborators/${encodeURIComponent(approver)}/permission`,
      token,
    ),
  ]);
  if (issue.pull_request || issue.state !== "open") {
    throw new SubmissionApprovalError(
      "approval-issue-closed",
      "Approval requires an open submission issue",
    );
  }
  if (!canApprove(permission.permission)) {
    throw new SubmissionApprovalError(
      "approval-permission-denied",
      `${approver} does not have write permission to approve submissions`,
    );
  }
  assertApprovedIssueBody(issue.body, approvedIssueBody);
  assertApprovedIssueTitle(issue.title, approvedIssueTitle);
  const labels = new Set((issue.labels || []).map((label) => typeof label === "string" ? label : label.name));
  for (const required of ["submission", "validated", approvedAndVerifiedLabel]) {
    if (!labels.has(required)) {
      throw new SubmissionApprovalError(
        "approval-label-missing",
        `Issue #${issueNumber} is missing the "${required}" label`,
      );
    }
  }
  if (
    typeof expectedManualSetup === "boolean"
    && labels.has("manual-setup") !== expectedManualSetup
  ) {
    throw new SubmissionApprovalError(
      "approval-label-changed",
      "The manual-setup label changed after approval started",
    );
  }
  const decision = approvalDecisionForEvents(events, {
    approver,
    expectedEventId,
    expectedRequestedAt,
    expectedTriggeredAt,
  });
  const baselineComment = latestSecurityBaselineComment(comments);
  if (Date.parse(baselineComment.updatedAt) >= Date.parse(decision.requestedAt)) {
    throw new SubmissionApprovalError(
      "approval-security-baseline-changed",
      "The approved-and-verified decision does not follow the latest bot-authored baseline report",
    );
  }
  if (
    (expectedBaselineCommentId !== undefined
      && baselineComment.commentId !== expectedBaselineCommentId)
    || (expectedBaselineCommentUpdatedAt !== undefined
      && baselineComment.updatedAt !== expectedBaselineCommentUpdatedAt)
  ) {
    throw new SubmissionApprovalError(
      "approval-security-baseline-changed",
      "The bot-authored security baseline report changed after approval started",
    );
  }
  assertApprovalAllowed(issue, baselineComment.baseline, inspection, repoUrl);
  return {
    issue,
    inspection,
    baseline: baselineComment.baseline,
    baselineComment,
    decision,
  };
}

async function main() {
  const token = requiredEnvironment("GITHUB_TOKEN");
  const repositoryName = requiredEnvironment("GITHUB_REPOSITORY");
  const approver = requiredEnvironment("APPROVER_LOGIN");
  const approvalTriggeredAt = requiredEnvironment("APPROVAL_TRIGGERED_AT");
  const issueNumber = Number.parseInt(requiredEnvironment("ISSUE_NUMBER"), 10);
  const approvedIssueBody = process.env.APPROVED_ISSUE_BODY;
  const approvedIssueTitle = process.env.APPROVED_ISSUE_TITLE;
  const manualSetup = parseManualSetupApproval(requiredEnvironment("MANUAL_SETUP"));
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) throw new Error("ISSUE_NUMBER must be positive");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repositoryName)) {
    throw new Error("GITHUB_REPOSITORY is invalid");
  }

  const initialIssue = await githubApi(`/repos/${repositoryName}/issues/${issueNumber}`, token);
  const submission = parseApprovedSubmissionSnapshot(
    initialIssue,
    approvedIssueBody,
    approvedIssueTitle,
  );
  const {
    issue,
    inspection,
    baseline: reviewedSecurityBaseline,
    baselineComment,
    decision,
  } = await recheckApprovalState({
    repositoryName,
    issueNumber,
    token,
    approvedIssueBody,
    approvedIssueTitle,
    repoUrl: submission.repo,
    approver,
    expectedRequestedAt: approvalTriggeredAt,
    expectedManualSetup: manualSetup,
  });
  const pluginIds = inspection.manifests.map((manifest) => manifest.id);
  const recordOptions = {
    expectedRepository: parseGitHubRepository(submission.repo).slug.toLowerCase(),
    expectedCommit: inspection.commitSha,
    pluginIds,
  };
  const rescannedSecurityBaseline = await runSecurityBaseline(
    submission.repo,
    inspection.commitSha,
    {
      token,
      listedPlugins: inspection.manifests.map((manifest) => ({
        pluginId: manifest.id,
        manifestPathHint: manifest.path,
      })),
      requiredPaths: [...new Set(
        inspection.manifests.flatMap((manifest) => manifest.entryPoints || []),
      )].sort(),
    },
  );
  const verificationEvidence = createApprovedVerificationEvidence({
    reviewedBaseline: reviewedSecurityBaseline,
    rescannedBaseline: rescannedSecurityBaseline,
    recordOptions,
    reviewer: decision.reviewer,
    requestEventId: decision.eventId,
    requestedAt: decision.requestedAt,
    reviewedAt: new Date().toISOString(),
  });
  const root = resolve(import.meta.dirname, "..");
  const registryPath = resolve(root, "registry.json");
  const catalogPath = resolve(root, "site/catalog.json");
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  const listedAt = new Date().toISOString();
  const addedAt = listedAt.slice(0, 10);
  const source = createRegistrySource({
    submission,
    manifests: inspection.manifests,
    addedAt,
    listedAt,
    listingValidatedCommit: inspection.commitSha,
    listingValidatedAt: listedAt,
    listingValidatedBranch: inspection.defaultBranch,
    automatedSecurityBaseline: verificationEvidence.automatedSecurityBaseline,
    maintainerVerificationReview: verificationEvidence.maintainerVerificationReview,
    manualSetup,
  });
  if (sourceVerification(source).status !== "verified") {
    throw new SubmissionApprovalError(
      "approval-verification-invalid",
      "Approved listing evidence did not produce a commit-bound Verified status",
    );
  }
  const nextRegistry = addRegistrySource(
    registry,
    source,
    (catalog.plugins || []).map((plugin) => plugin.id),
    registry.retiredPluginIds,
  );

  if (JSON.stringify(nextRegistry) !== JSON.stringify(registry)) {
    const registryTemp = `${registryPath}.tmp-${process.pid}`;
    await writeFile(registryTemp, `${JSON.stringify(nextRegistry, null, 2)}\n`);
    await rename(registryTemp, registryPath);
  }

  const firstPlugin = inspection.manifests[0];
  const output = process.env.GITHUB_OUTPUT;
  if (output) {
    const safeName = String(firstPlugin.name).replace(/[\r\n]+/g, " ").trim();
    await appendFile(
      output,
      `publication_kind=listing\nplugin_id=${firstPlugin.id}\nplugin_name=${safeName}\nplugin_name_markdown=${safeMarkdownText(safeName)}\nsubmission_repo_url=${submission.repo}\nsubmission_repository=${inspection.repository}\napproved_commit=${inspection.commitSha}\nverification_method=${verificationEvidence.verificationMethod}\napproval_event_id=${decision.eventId}\napproval_requested_at=${decision.requestedAt}\napproval_triggered_at=${approvalTriggeredAt}\nbaseline_comment_id=${baselineComment.commentId}\nbaseline_comment_updated_at=${baselineComment.updatedAt}\n`,
    );
  }
  console.log(
    `Approved and verified issue #${issueNumber}: added ${inspection.manifests.length} plugin manifest(s) from ${submission.repo}`,
  );
}

async function verifyMain() {
  const token = requiredEnvironment("GITHUB_TOKEN");
  const repositoryName = requiredEnvironment("GITHUB_REPOSITORY");
  const approver = requiredEnvironment("APPROVER_LOGIN");
  const requestedAt = requiredEnvironment("APPROVAL_REQUESTED_AT");
  const triggeredAt = requiredEnvironment("APPROVAL_TRIGGERED_AT");
  const issueNumber = Number.parseInt(requiredEnvironment("ISSUE_NUMBER"), 10);
  const expectedEventId = Number.parseInt(requiredEnvironment("APPROVAL_EVENT_ID"), 10);
  const expectedBaselineCommentId = Number.parseInt(
    requiredEnvironment("BASELINE_COMMENT_ID"),
    10,
  );
  const expectedBaselineCommentUpdatedAt = requiredEnvironment(
    "BASELINE_COMMENT_UPDATED_AT",
  );
  const approvedIssueBody = process.env.APPROVED_ISSUE_BODY;
  const approvedIssueTitle = process.env.APPROVED_ISSUE_TITLE;
  const repoUrl = requiredEnvironment("SUBMISSION_REPO_URL");
  const expectedManualSetup = parseManualSetupApproval(
    requiredEnvironment("MANUAL_SETUP"),
  );
  if (
    !Number.isSafeInteger(expectedEventId)
    || expectedEventId < 1
    || !Number.isSafeInteger(expectedBaselineCommentId)
    || expectedBaselineCommentId < 1
  ) {
    throw new Error("Approval event and baseline comment IDs must be positive integers");
  }
  await recheckApprovalState({
    repositoryName,
    issueNumber,
    token,
    approvedIssueBody,
    approvedIssueTitle,
    repoUrl,
    approver,
    expectedEventId,
    expectedRequestedAt: requestedAt,
    expectedTriggeredAt: triggeredAt,
    expectedBaselineCommentId,
    expectedBaselineCommentUpdatedAt,
    expectedManualSetup,
  });
  console.log(`Approval and verification state for issue #${issueNumber} is still current.`);
}

export async function recordApprovalFailure(error, output = process.env.GITHUB_OUTPUT) {
  const failure = publicSubmissionFailure(error, { phase: "approval" });
  if (output) {
    await appendFile(
      output,
      `failure_code=${failure.code}\nfailure_reason=${failure.reason}\nfailure_action=${failure.action}\n`,
    );
  }
  return failure;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const command = process.argv.includes("--verify-current") ? verifyMain : main;
  command().catch(async (error) => {
    const failure = await recordApprovalFailure(error).catch(() => ({
      code: "approval-service-error",
      reason: "The approval service could not complete the submission checks.",
    }));
    console.error(`Approval failed [${failure.code}]`);
    process.exitCode = 1;
  });
}
