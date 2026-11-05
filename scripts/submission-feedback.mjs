import { submissionChecklist } from "./submission.mjs";

const submissionHeadings = new Set([
  "Repository URL",
  "Category",
  "Tags",
  "Suggest a missing tag",
  "Maintainer notes",
  "Submission checklist",
]);
const checklistStatements = new Set(submissionChecklist);
const safePluginId = /^[a-z0-9][a-z0-9._-]{0,127}$/;

const feedback = Object.freeze({
  "submission-title-invalid": {
    reason: "The issue title must start with `[Plugin]:` and include the plugin name.",
    action: "Correct the title and edit the issue to run validation again.",
  },
  "submission-fields-invalid": {
    reason: "The submission fields are missing, reordered, or malformed.",
    action: "Restore all six headings in the order shown in `SUBMISSION.md`, then edit the issue to retry.",
  },
  "submission-repository-invalid": {
    reason: "The repository URL must be a public GitHub repository root URL.",
    action: "Use `https://github.com/owner/repository` without a branch or file path, then edit the issue to retry.",
  },
  "submission-category-invalid": {
    reason: "The selected category is not supported.",
    action: "Choose one category listed in the submission form, then edit the issue to retry.",
  },
  "submission-tag-count-invalid": {
    reason: "The submission must contain between one and three supported tags.",
    action: "Update the Tags field and edit the issue to retry.",
  },
  "submission-tags-invalid": {
    reason: "The submission contains an unsupported tag.",
    action: "Choose tags listed in the submission form and edit the issue to retry.",
  },
  "submission-rights-unconfirmed": {
    reason: "The plugin distribution-rights confirmation is missing.",
    action: "Confirm the ownership checklist item and edit the issue to retry.",
  },
  "repository-unreachable": {
    reason: "The repository could not be reached.",
    action: "Confirm that it is public and available, then edit the issue to retry.",
  },
  "manifest-invalid": {
    reason: "The plugin manifest does not match the supported Quattro contract.",
    action: "Correct the root `manifest.json` and edit the issue to retry.",
  },
  "entry-point-missing": {
    reason: "A file declared as a plugin entry point is missing.",
    action: "Add or correct the declared entry-point file and edit the issue to retry.",
  },
  "reserved-plugin-id": {
    reason: "The plugin ID uses the reserved `omarchy.*` namespace.",
    action: "Choose a globally unique, non-reserved plugin ID and edit the issue to retry.",
  },
  "readme-missing": {
    reason: "A README file is required in the repository root.",
    action: "Add the root README and edit the issue to retry.",
  },
  "license-missing": {
    reason: "A license file is required in the repository root.",
    action: "Add the root license file and edit the issue to retry.",
  },
  "preview-invalid": {
    reason: "The optional preview image is invalid or exceeds the supported limits.",
    action: "Replace or remove the root preview and edit the issue to retry.",
  },
  "unsupported-repository-layout": {
    reason: "New submissions require one plugin with `manifest.json` in the repository root.",
    action: "Move the plugin to the supported repository layout and edit the issue to retry.",
  },
  "submission-repository-listed": {
    reason: "This repository is already listed in the marketplace.",
    action: "Use the existing listing instead of opening a duplicate submission.",
  },
  "approval-body-changed": {
    reason: "The submission changed after the approval label was applied.",
    action: "Review the updated issue and reapply `approved-and-verified` after validation passes.",
  },
  "approval-permission-denied": {
    reason: "The account applying the approval label does not have write permission.",
    action: "A marketplace maintainer must review and approve the submission.",
  },
  "approval-event-invalid": {
    reason: "The approved-and-verified trigger is missing, ambiguous, or superseded by another label event.",
    action: "Review the current report, then remove and reapply `approved-and-verified`.",
  },
  "approval-issue-closed": {
    reason: "Approval requires an open submission issue.",
    action: "Reopen and review the issue before reapplying `approved-and-verified`.",
  },
  "approval-label-missing": {
    reason: "A required submission or approval label is missing.",
    action: "Check whether approval was withdrawn. Do not restore it while blockers remain. A new approval requires review of the current evidence; do not rerun this workflow.",
  },
  "approval-label-changed": {
    reason: "The manual-setup label differs from the state captured when approval was requested.",
    action: "Review and finalize setup labels first. Then remove any remaining `approved-and-verified` label and set it last to request approval again.",
  },
  "approval-source-changed": {
    reason: "The repository is already registered with a different plugin set.",
    action: "Review the existing listing and current manifests before reapplying `approved-and-verified`.",
  },
  "approval-metadata-changed": {
    reason: "The repository is already registered with different listing metadata.",
    action: "Review the existing listing and approval labels before reapplying `approved-and-verified`.",
  },
  "approval-blocking-label": {
    reason: "The submission still has an unresolved blocking label.",
    action: "Resolve the reported issue and remove its blocking label before reapplying `approved-and-verified`.",
  },
  "approval-security-baseline-missing": {
    reason: "The submission has no automated security baseline result.",
    action: "Edit the submission issue to run validation, then reapply `approved-and-verified` after the baseline completes.",
  },
  "approval-security-baseline-invalid": {
    reason: "The automated security baseline metadata is invalid or belongs to another repository.",
    action: "Edit the submission issue to generate a new baseline before reapplying `approved-and-verified`.",
  },
  "approval-security-baseline-changed": {
    reason: "The fresh exact-commit scan does not match the bot report approved by the maintainer.",
    action: "Edit the submission issue to publish a current report, review it, then reapply `approved-and-verified`.",
  },
  "approval-security-needs-fixes": {
    reason: "The automated security baseline has selectively blocking findings that prevent a verified initial listing.",
    action: "Fix every selectively blocking finding and edit the submission issue to validate a new commit before reapplying `approved-and-verified`.",
  },
  "approval-upstream-changed": {
    reason: "The upstream repository changed after the automated security baseline was recorded.",
    action: "Edit the submission issue to validate the new commit before reapplying `approved-and-verified`.",
  },
  "approval-verification-invalid": {
    reason: "The approved exact-commit evidence did not produce a valid Verified listing.",
    action: "A maintainer must review the workflow and evidence before retrying approval.",
  },
  "verification-review-expectation-mismatch": {
    reason: "The fresh baseline evidence does not match the report approved by the maintainer.",
    action: "Edit the submission issue to publish a current report, review it, then reapply `approved-and-verified`.",
  },
  "verification-review-invalid": {
    reason: "The maintainer-review evidence is invalid or no longer eligible.",
    action: "Edit the submission issue to publish a current report before retrying approval.",
  },
  "security-baseline-unavailable": {
    reason: "The exact submitted commit could not be scanned completely during approval.",
    action: "Retry validation after GitHub access recovers, then review the new report before approval.",
  },
  "security-baseline-scan-limit": {
    reason: "The exact submitted commit exceeds a deterministic security scan limit.",
    action: "Reduce the relevant source scope and edit the submission issue to validate a new commit.",
  },
  "approval-service-error": {
    reason: "The approval service could not complete the submission checks.",
    action: "A maintainer must review the workflow before reapplying `approved-and-verified`.",
  },
  "validation-internal-error": {
    reason: "Marketplace validation could not complete safely.",
    action: "A maintainer must review the workflow before validation is retried.",
  },
});

function sentence(value, fallback) {
  const text = String(value || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
  if (!text) return fallback;
  return /[.!?](?:[”"'`])?$/.test(text) ? text : `${text}.`;
}

function contextualFeedback(error) {
  const code = String(error?.code || "");
  if (code === "submission-field-missing" || code === "submission-field-repeated") {
    const heading = error?.context?.heading;
    if (!submissionHeadings.has(heading)) return null;
    return code === "submission-field-missing"
      ? {
          reason: `The submission is missing the required “${heading}” field.`,
          action: "Restore the field in the order shown in `SUBMISSION.md`, then edit the issue to retry.",
        }
      : {
          reason: `The submission repeats the “${heading}” field.`,
          action: "Keep each required field once, then edit the issue to retry.",
        };
  }
  if (code === "submission-checklist-unconfirmed") {
    const statement = error?.context?.statement;
    if (!checklistStatements.has(statement)) return null;
    return {
      reason: `A required submission checklist item is not confirmed: “${statement}”`,
      action: "Check this item and edit the issue to run validation again.",
    };
  }
  if (code === "plugin-id-listed" || code === "plugin-id-retired") {
    const pluginId = error?.context?.pluginId;
    if (!safePluginId.test(pluginId || "")) return null;
    return code === "plugin-id-retired"
      ? {
          reason: `Plugin ID \`${pluginId}\` was used by a previous marketplace listing and cannot be reused.`,
          action: "Choose a new globally unique plugin ID and edit the issue to run validation again.",
        }
      : {
          reason: `Plugin ID \`${pluginId}\` is already listed.`,
          action: "Choose a globally unique plugin ID and edit the issue to run validation again.",
        };
  }
  return null;
}

export function publicSubmissionFailure(error, { phase = "validation" } = {}) {
  const contextual = contextualFeedback(error);
  const staticFeedback = Object.hasOwn(feedback, error?.code) ? feedback[error.code] : null;
  const known = contextual || staticFeedback;
  const fallbackCode = phase === "approval" ? "approval-service-error" : "validation-internal-error";
  const selected = known || feedback[fallbackCode];
  let action = selected.action;
  if (
    phase === "approval"
    && known
    && String(error?.code || "").startsWith("submission-")
    && error.code !== "submission-repository-listed"
  ) {
    const prerequisite = selected.action
      .replace(/[,;]?\s+(?:(?:and|then)\s+)?edit the issue to (?:run validation again|retry)\.?$/i, "")
      .replace(/[.!?]+$/, "")
      .trim();
    action = `${prerequisite}. Then reapply \`approved-and-verified\` after validation passes.`;
  } else if (phase === "approval" && known && [
    "repository-unreachable",
    "manifest-invalid",
    "entry-point-missing",
    "reserved-plugin-id",
    "readme-missing",
    "license-missing",
    "preview-invalid",
    "unsupported-repository-layout",
    "plugin-id-listed",
    "plugin-id-retired",
  ].includes(error?.code)) {
    const prerequisite = selected.action
      .replace(/[,;]?\s+(?:(?:and|then)\s+)?edit the issue to (?:run validation again|retry)\.?$/i, "")
      .replace(/[.!?]+$/, "")
      .trim();
    action = `${prerequisite}. Then reapply \`approved-and-verified\` after validation passes.`;
  }
  return {
    code: known ? error.code : fallbackCode,
    reason: sentence(selected.reason, feedback[fallbackCode].reason),
    action: sentence(action, feedback[fallbackCode].action),
  };
}
