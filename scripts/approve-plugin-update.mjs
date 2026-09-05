import { appendFile, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  approvalDecisionForEvents,
  canApprove,
  createApprovedVerificationEvidence,
  githubApi,
  githubIssueComments,
  githubIssueEvents,
  latestSecurityBaselineComment,
} from "./approve-submission.mjs";
import { inspectListedPluginSource } from "./build-catalog.mjs";
import { parseGitHubRepository } from "./github-repository.mjs";
import {
  parsePluginUpdateRequest,
  PluginUpdateError,
  promotePluginUpdateSource,
  publicPluginUpdateFailure,
  replacePluginUpdateSource,
  resolvePluginUpdate,
  sourceForPluginUpdate,
} from "./plugin-update.mjs";
import { assertApprovalAllowed } from "./security-baseline-approval.mjs";
import { runSecurityBaseline } from "./security-baseline-scanner.mjs";

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function labelNames(issue) {
  return new Set((issue?.labels || []).map((label) => (
    typeof label === "string" ? label : label?.name
  )).filter(Boolean));
}

function assertIssueBody(currentBody, approvedBody) {
  if (typeof approvedBody !== "string" || String(currentBody || "") !== approvedBody) {
    throw new PluginUpdateError(
      "update-body-changed",
      "The plugin update issue changed after approval",
    );
  }
}

function safeMarkdownText(value) {
  return String(value)
    .replace(/[<>`\r\n]+/g, " ")
    .trim()
    .replaceAll("\\", "\\\\")
    .replace(/([*_\[\]()~|])/g, "\\$1")
    .replaceAll("@", "@\u200b");
}

function positiveInteger(value, name) {
  const result = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`${name} must be positive`);
  return result;
}

export async function recheckPluginUpdateApproval({
  repositoryName,
  issueNumber,
  token,
  approvedIssueBody,
  approvedIssueTitle,
  approver,
  expectedEventId,
  expectedRequestedAt,
  expectedTriggeredAt,
  expectedBaselineCommentId,
  expectedBaselineCommentUpdatedAt,
  allowCurrentCommit = false,
}) {
  const issue = await githubApi(
    `/repos/${repositoryName}/issues/${issueNumber}`,
    token,
  );
  if (issue.pull_request || issue.state !== "open") {
    throw new PluginUpdateError(
      "update-issue-closed",
      "Update approval requires an open issue",
    );
  }
  assertIssueBody(issue.body, approvedIssueBody);
  if (
    typeof approvedIssueTitle !== "string"
    || issue.title !== approvedIssueTitle
    || !issue.title.startsWith("[Verify]:")
  ) {
    throw new PluginUpdateError(
      "update-title-changed",
      "The plugin update title changed after approval",
    );
  }
  const request = parsePluginUpdateRequest(issue.body);
  const root = resolve(import.meta.dirname, "..");
  const registry = JSON.parse(await readFile(resolve(root, "registry.json"), "utf8"));
  const source = sourceForPluginUpdate(registry, request);
  const [inspection, comments, events, permission] = await Promise.all([
    inspectListedPluginSource(source),
    githubIssueComments(repositoryName, issueNumber, token),
    githubIssueEvents(repositoryName, issueNumber, token),
    githubApi(
      `/repos/${repositoryName}/collaborators/${encodeURIComponent(approver)}/permission`,
      token,
    ),
  ]);
  if (!canApprove(permission.permission)) {
    throw new PluginUpdateError(
      "update-permission-denied",
      `${approver} does not have write permission to approve plugin updates`,
    );
  }
  const labels = labelNames(issue);
  for (const required of ["plugin-update", "validated", "approved-and-verified"]) {
    if (!labels.has(required)) {
      throw new PluginUpdateError(
        "update-label-missing",
        `Plugin update issue is missing the ${required} label`,
      );
    }
  }
  const decision = approvalDecisionForEvents(events, {
    approver,
    expectedEventId,
    expectedRequestedAt,
    expectedTriggeredAt,
  });
  const baselineComment = latestSecurityBaselineComment(comments);
  if (Date.parse(baselineComment.updatedAt) >= Date.parse(decision.requestedAt)) {
    throw new PluginUpdateError(
      "update-security-baseline-changed",
      "The approval decision does not follow the latest bot-authored baseline report",
    );
  }
  if (
    (expectedBaselineCommentId !== undefined
      && baselineComment.commentId !== expectedBaselineCommentId)
    || (expectedBaselineCommentUpdatedAt !== undefined
      && baselineComment.updatedAt !== expectedBaselineCommentUpdatedAt)
  ) {
    throw new PluginUpdateError(
      "update-security-baseline-changed",
      "The bot-authored baseline report changed after update approval started",
    );
  }
  const subject = resolvePluginUpdate(registry, request, inspection, { allowCurrentCommit });
  assertApprovalAllowed(issue, baselineComment.baseline, inspection, request.repoUrl);
  return Object.freeze({
    issue,
    request,
    registry,
    source,
    subject,
    inspection,
    baseline: baselineComment.baseline,
    baselineComment,
    decision,
  });
}

async function approvePluginUpdate() {
  const token = requiredEnvironment("GITHUB_TOKEN");
  const repositoryName = requiredEnvironment("GITHUB_REPOSITORY");
  const approver = requiredEnvironment("APPROVER_LOGIN");
  const approvalTriggeredAt = requiredEnvironment("APPROVAL_TRIGGERED_AT");
  const issueNumber = positiveInteger(requiredEnvironment("ISSUE_NUMBER"), "ISSUE_NUMBER");
  const state = await recheckPluginUpdateApproval({
    repositoryName,
    issueNumber,
    token,
    approvedIssueBody: process.env.APPROVED_ISSUE_BODY,
    approvedIssueTitle: process.env.APPROVED_ISSUE_TITLE,
    approver,
    expectedRequestedAt: approvalTriggeredAt,
  });
  const pluginIds = state.subject.pluginIds;
  const recordOptions = {
    expectedRepository: parseGitHubRepository(state.request.repoUrl).slug.toLowerCase(),
    expectedCommit: state.inspection.commitSha,
    pluginIds,
  };
  const rescannedBaseline = await runSecurityBaseline(
    state.request.repoUrl,
    state.inspection.commitSha,
    {
      token,
      listedPlugins: state.inspection.manifests.map((manifest) => ({
        pluginId: manifest.id,
        manifestPathHint: manifest.path,
      })),
      requiredPaths: [...new Set(
        state.inspection.manifests.flatMap((manifest) => manifest.entryPoints || []),
      )].sort(),
    },
  );
  const promotedAt = new Date().toISOString();
  const evidence = createApprovedVerificationEvidence({
    reviewedBaseline: state.baseline,
    rescannedBaseline,
    recordOptions,
    reviewer: state.decision.reviewer,
    requestEventId: state.decision.eventId,
    requestedAt: state.decision.requestedAt,
    reviewedAt: promotedAt,
  });
  const nextSource = promotePluginUpdateSource(state.source, state.inspection, {
    automatedSecurityBaseline: evidence.automatedSecurityBaseline,
    maintainerVerificationReview: evidence.maintainerVerificationReview,
    promotedAt,
  });
  const nextRegistry = replacePluginUpdateSource(state.registry, state.source, nextSource);
  const registryPath = resolve(import.meta.dirname, "..", "registry.json");
  const temporary = `${registryPath}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(nextRegistry, null, 2)}\n`);
  await rename(temporary, registryPath);

  const plugin = state.inspection.manifests.find((manifest) => (
    manifest.id === state.request.pluginId
  )) || state.inspection.manifests[0];
  const safeName = String(plugin.name).replace(/[\r\n]+/g, " ").trim();
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `publication_kind=update\nplugin_id=${plugin.id}\nplugin_name=${safeName}\nplugin_name_markdown=${safeMarkdownText(safeName)}\nsubmission_repo_url=${state.request.repoUrl}\nsubmission_repository=${state.inspection.repository}\napproved_commit=${state.inspection.commitSha}\nverification_method=${evidence.verificationMethod}\napproval_event_id=${state.decision.eventId}\napproval_requested_at=${state.decision.requestedAt}\napproval_triggered_at=${approvalTriggeredAt}\nbaseline_comment_id=${state.baselineComment.commentId}\nbaseline_comment_updated_at=${state.baselineComment.updatedAt}\n`,
    );
  }
  console.log(
    `Approved and verified plugin update #${issueNumber}: promoted ${pluginIds.length} plugin manifest(s) from ${state.request.repoUrl}`,
  );
}

async function verifyCurrentPluginUpdate() {
  const token = requiredEnvironment("GITHUB_TOKEN");
  const repositoryName = requiredEnvironment("GITHUB_REPOSITORY");
  const approver = requiredEnvironment("APPROVER_LOGIN");
  const approvalTriggeredAt = requiredEnvironment("APPROVAL_TRIGGERED_AT");
  const issueNumber = positiveInteger(requiredEnvironment("ISSUE_NUMBER"), "ISSUE_NUMBER");
  await recheckPluginUpdateApproval({
    repositoryName,
    issueNumber,
    token,
    approvedIssueBody: process.env.APPROVED_ISSUE_BODY,
    approvedIssueTitle: process.env.APPROVED_ISSUE_TITLE,
    approver,
    expectedEventId: positiveInteger(requiredEnvironment("APPROVAL_EVENT_ID"), "APPROVAL_EVENT_ID"),
    expectedRequestedAt: requiredEnvironment("APPROVAL_REQUESTED_AT"),
    expectedTriggeredAt: approvalTriggeredAt,
    expectedBaselineCommentId: positiveInteger(
      requiredEnvironment("BASELINE_COMMENT_ID"),
      "BASELINE_COMMENT_ID",
    ),
    expectedBaselineCommentUpdatedAt: requiredEnvironment("BASELINE_COMMENT_UPDATED_AT"),
    allowCurrentCommit: true,
  });
  console.log(`Plugin update approval state for issue #${issueNumber} is still current.`);
}

export function publicPluginUpdateApprovalFailure(error) {
  const updateFailure = publicPluginUpdateFailure(error);
  if (updateFailure.code !== "update-internal-error") return updateFailure;
  const code = String(error?.code || "update-approval-internal-error");
  const reasons = {
    "update-body-changed": "The plugin update issue body changed after approval.",
    "update-title-changed": "The plugin update issue title changed after approval.",
    "update-issue-closed": "Plugin update approval requires an open issue.",
    "update-permission-denied": "The approval actor no longer has write permission.",
    "update-label-missing": "The plugin update approval labels changed.",
    "update-security-baseline-changed": "The bot-authored update baseline changed after approval.",
    "approval-event-invalid": "The approved-and-verified label event is missing, stale, or does not match this workflow request.",
    "approval-security-baseline-missing": "The current bot-authored security baseline report is missing.",
    "approval-security-baseline-invalid": "The current security baseline does not match this plugin update.",
    "approval-security-baseline-changed": "The fresh baseline differs from the report approved by the maintainer.",
    "approval-security-needs-fixes": "The plugin update has findings or is not eligible for verified publication.",
    "approval-upstream-changed": "The upstream repository changed after update validation.",
    "approval-blocking-label": "A blocking security label prevents plugin update publication.",
  };
  return Object.freeze({
    code: Object.hasOwn(reasons, code) ? code : "update-approval-internal-error",
    reason: reasons[code] || "The plugin update approval service could not complete safely.",
  });
}

export async function recordPluginUpdateApprovalFailure(
  error,
  output = process.env.GITHUB_OUTPUT,
) {
  const failure = publicPluginUpdateApprovalFailure(error);
  const action = "Review the current update report, then remove and reapply `approved-and-verified`.";
  if (output) {
    await appendFile(
      output,
      `failure_code=${failure.code}\nfailure_reason=${failure.reason}\nfailure_action=${action}\n`,
    );
  }
  return Object.freeze({ ...failure, action });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const command = process.argv.includes("--verify-current")
    ? verifyCurrentPluginUpdate
    : approvePluginUpdate;
  command().catch(async (error) => {
    const failure = await recordPluginUpdateApprovalFailure(error).catch(() => ({
      code: "update-approval-internal-error",
    }));
    console.error(`Plugin update approval failed [${failure.code}]`);
    process.exitCode = 1;
  });
}
