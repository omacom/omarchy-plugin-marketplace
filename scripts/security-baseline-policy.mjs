export const securityBaselineVersion = "3";
export const securityBaselineEnforcementMode = "selective";
export const securityBaselineMarkerProtocolVersion = "4";
export const securityBaselineMarkerPrefix = `<!-- marketplace-security-baseline:v${securityBaselineMarkerProtocolVersion} `;
export const securityBaselineErrorMarker = `<!-- marketplace-security-baseline-error:v${securityBaselineMarkerProtocolVersion} -->`;

export const securityBaselineOutcomes = Object.freeze([
  "passed",
  "review-required",
  "needs-fixes",
]);
export const securityBaselineEnforcementModes = Object.freeze([
  "review-only",
  "selective",
  "enforced",
]);
export const securityBaselineDispositions = Object.freeze([
  "clear",
  "review-required",
  "needs-fixes",
]);
export const securityBaselineSelectivelyBlockingRules = Object.freeze([
  "sudoers-dangerous-passwordless-command",
  "privileged-process-control-from-shared-temp",
]);

export const securityBaselineRuleCatalog = Object.freeze({
  "curl-pipe-shell": Object.freeze({
    title: "Downloaded content is passed directly to a shell",
    why: "The remote response is executed immediately and is not bound to the commit reviewed for this submission.",
    actions: Object.freeze([
      "Remove the download-and-execute installation path.",
      "Use a trusted package manager or another installation path that does not execute downloaded content.",
    ]),
  }),
  "cargo-git-unpinned": Object.freeze({
    title: "Cargo builds an unpinned Git repository",
    why: "`--locked` fixes Cargo dependencies but not the Git repository itself, so the executed source can change after review.",
    actions: Object.freeze([
      "Add `--rev` with a full 40-character commit SHA.",
      "Update that SHA in a new plugin commit whenever the dependency is intentionally updated.",
    ]),
  }),
  "remote-git-execution-unpinned": Object.freeze({
    title: "Remote Git source is executed without a fixed commit",
    why: "A branch or tag can move after review, causing users to execute source that was not part of the reviewed snapshot.",
    actions: Object.freeze([
      "Require a full 40-character commit SHA before fetching or building.",
      "Check out that exact commit in detached mode before executing the downloaded source.",
      "Remove the remote source-build path if an exact commit cannot be required.",
    ]),
  }),
  "sudoers-dangerous-passwordless-command": Object.freeze({
    title: "A passwordless sudo rule grants a dangerous command surface",
    why: "The rule allows a direct high-risk system command without interactive authentication, so any process running as the user can invoke it as root.",
    actions: Object.freeze([
      "Remove the direct passwordless command allowance.",
      "Require explicit administrator authentication, or use a root-owned purpose-built helper with a fixed command surface and strict input validation.",
      "Remove broad wildcards and user-controlled command, configuration, or path arguments.",
    ]),
  }),
  "privileged-process-control-from-shared-temp": Object.freeze({
    title: "Privileged process control trusts predictable shared temporary state",
    why: "A PID read from a predictable shared temporary path can be replaced before a privileged signal is sent, allowing an unintended root process to be targeted.",
    actions: Object.freeze([
      "Store runtime state in an owner-only directory such as $XDG_RUNTIME_DIR.",
      "Do not pass a PID from a shared temporary file to sudo, pkexec, or another privileged wrapper.",
      "Verify process ownership and executable identity immediately before signaling it.",
    ]),
  }),
});

export const securityBaselineCapabilityCatalog = Object.freeze({
  installer: Object.freeze({
    title: "Installer or setup path",
    why: "Installer code can modify the user environment and needs a maintainer to confirm its documented scope.",
  }),
  "package-manager": Object.freeze({
    title: "Package management",
    why: "The plugin can install, upgrade, or remove software outside its own checkout.",
  }),
  privilege: Object.freeze({
    title: "Privilege request",
    why: "The plugin or its instructions invoke an explicit privilege boundary such as `sudo` or `pkexec`.",
  }),
  "remote-build": Object.freeze({
    title: "Remote source build",
    why: "The installation path builds, installs, or directly executes source obtained from a remote repository.",
  }),
  "bundled-executable-binary": Object.freeze({
    title: "Bundled executable binary",
    why: "The repository includes an executable binary that this deterministic source scan cannot inspect.",
  }),
  "service-management": Object.freeze({
    title: "Service management",
    why: "The plugin can inspect or change a system or user service lifecycle.",
  }),
  "sudoers-modification": Object.freeze({
    title: "Sudoers policy modification",
    why: "The plugin installs, documents, validates, or removes a sudoers policy and requires review of the complete root command surface.",
  }),
});

const outcomes = new Set(securityBaselineOutcomes);
const enforcementModes = new Set(securityBaselineEnforcementModes);
const selectivelyBlockingRules = new Set(securityBaselineSelectivelyBlockingRules);

function evidenceIds(entries, key) {
  if (!Array.isArray(entries)) return null;
  const ids = entries.map((entry) => typeof entry === "string" ? entry : entry?.[key]);
  return ids.every((id) => typeof id === "string" && id) ? ids : null;
}

export function securityBaselineFindingIds(value) {
  return evidenceIds(value?.findings, "ruleId");
}

export function securityBaselineCapabilityIds(value) {
  return evidenceIds(value?.capabilities, "id");
}

export function securityBaselineOutcome(findings, capabilities) {
  return findings.length
    ? "needs-fixes"
    : capabilities.length
      ? "review-required"
      : "passed";
}

export function securityBaselineBlocksApproval(value) {
  if (value?.outcome !== "needs-fixes") return false;
  if (value.enforcementMode === "enforced") return true;
  if (value.enforcementMode !== "selective") return false;
  const findings = securityBaselineFindingIds(value);
  return Boolean(findings?.some((ruleId) => selectivelyBlockingRules.has(ruleId)));
}

export function isConsistentSecurityBaselineSummary(value) {
  const findings = securityBaselineFindingIds(value);
  const capabilities = securityBaselineCapabilityIds(value);
  if (
    !outcomes.has(value?.outcome)
    || !enforcementModes.has(value?.enforcementMode || securityBaselineEnforcementMode)
    || !findings
    || !capabilities
    || findings.some((id) => !Object.hasOwn(securityBaselineRuleCatalog, id))
    || capabilities.some((id) => !Object.hasOwn(securityBaselineCapabilityCatalog, id))
    || new Set(findings).size !== findings.length
    || new Set(capabilities).size !== capabilities.length
  ) return false;
  return value.outcome === securityBaselineOutcome(findings, capabilities);
}

export function securityBaselineDisposition(value) {
  if (!isConsistentSecurityBaselineSummary(value)) return null;
  if (value.outcome === "passed") return "clear";
  return securityBaselineBlocksApproval(value) ? "needs-fixes" : "review-required";
}

export function securityBaselineEligibleForMaintainerVerification(value) {
  const version = value?.version ?? value?.baselineVersion;
  const findings = securityBaselineFindingIds(value);
  const capabilities = securityBaselineCapabilityIds(value);
  return version === securityBaselineVersion
    && value?.enforcementMode === securityBaselineEnforcementMode
    && value?.outcome === "review-required"
    && isConsistentSecurityBaselineSummary(value)
    && findings?.length === 0
    && capabilities?.length > 0;
}

export function securityBaselineEligibleForVerifiedPublicationReview(value) {
  const version = value?.version ?? value?.baselineVersion;
  const findings = securityBaselineFindingIds(value);
  const capabilities = securityBaselineCapabilityIds(value);
  return version === securityBaselineVersion
    && value?.enforcementMode === securityBaselineEnforcementMode
    && isConsistentSecurityBaselineSummary(value)
    && securityBaselineDisposition(value) === "review-required"
    && Boolean(findings?.length || capabilities?.length);
}

export function securityBaselineEligibleForVerifiedListing(value) {
  const version = value?.version ?? value?.baselineVersion;
  const findings = securityBaselineFindingIds(value);
  const capabilities = securityBaselineCapabilityIds(value);
  if (
    version !== securityBaselineVersion
    || value?.enforcementMode !== securityBaselineEnforcementMode
    || !isConsistentSecurityBaselineSummary(value)
  ) return false;
  return value.outcome === "passed"
    ? findings?.length === 0 && capabilities?.length === 0
    : securityBaselineEligibleForVerifiedPublicationReview(value);
}

export function verifiedPublicationDisposition(value) {
  const version = value?.version ?? value?.baselineVersion;
  if (
    version !== securityBaselineVersion
    || value?.enforcementMode !== securityBaselineEnforcementMode
    || !isConsistentSecurityBaselineSummary(value)
  ) return null;
  return securityBaselineDisposition(value);
}

export const securityBaselineBlockingLabels = Object.freeze([
  "needs-fixes",
  ...(securityBaselineEnforcementMode === "review-only" ? [] : ["security-needs-fixes"]),
]);

export const currentSecurityBaselinePolicy = Object.freeze({
  version: securityBaselineVersion,
  enforcementMode: securityBaselineEnforcementMode,
  markerProtocolVersion: securityBaselineMarkerProtocolVersion,
  outcomes: securityBaselineOutcomes,
  enforcementModes: securityBaselineEnforcementModes,
  dispositions: securityBaselineDispositions,
  maintainerVerificationOutcome: "review-required",
  verifiedListingRequired: true,
  selectivelyBlockingRules: securityBaselineSelectivelyBlockingRules,
  rules: securityBaselineRuleCatalog,
  capabilities: securityBaselineCapabilityCatalog,
});

// Standard installation may reuse only an installer-only manual verification.
export function securityBaselineEligibleForReviewedStandardInstallation(value) {
  const capabilities = securityBaselineCapabilityIds(value);
  return securityBaselineEligibleForMaintainerVerification(value)
    && capabilities.length === 1 && capabilities[0] === "installer";
}
