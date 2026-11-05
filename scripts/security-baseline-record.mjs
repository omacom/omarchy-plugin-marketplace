import { SecurityBaselineError } from "./security-baseline-error.mjs";
import {
  isConsistentSecurityBaselineSummary,
  securityBaselineCapabilityIds,
  securityBaselineEnforcementMode,
  securityBaselineErrorMarker,
  securityBaselineFindingIds,
  securityBaselineMarkerPrefix,
  securityBaselineVersion,
} from "./security-baseline-policy.mjs";

export const securityBaselineRecordSchemaVersion = 1;
const securityBaselineMarkerSchemaVersion = 2;

export class SecurityBaselineRecordError extends SecurityBaselineError {
  constructor(code, message) {
    super(code, message);
    this.name = "SecurityBaselineRecordError";
  }
}

function fullCommit(value) {
  const commit = String(value || "").toLowerCase();
  return /^[a-f0-9]{40}$/.test(commit) ? commit : "";
}

function normalizedPluginIds(pluginIds) {
  if (pluginIds === undefined) return undefined;
  if (
    !Array.isArray(pluginIds)
    || pluginIds.some((id) => typeof id !== "string" || !id || id !== id.trim())
    || new Set(pluginIds).size !== pluginIds.length
  ) return null;
  return [...pluginIds].sort();
}

function normalizedRepositories(repositories, expectedRepository) {
  const expected = String(expectedRepository || "").toLowerCase();
  if (repositories === undefined) return expected ? [expected] : [];
  if (
    !Array.isArray(repositories)
    || repositories.some((repository) => (
      typeof repository !== "string"
      || !repository
      || repository !== repository.trim()
    ))
  ) return null;
  const normalized = repositories.map((repository) => repository.toLowerCase());
  if (new Set(normalized).size !== normalized.length) return null;
  if (expected && !normalized.includes(expected)) return null;
  return normalized;
}

function normalizedResultSummary(result) {
  const findings = securityBaselineFindingIds(result);
  const capabilities = securityBaselineCapabilityIds(result);
  if (!findings || !capabilities) return null;
  const summary = {
    outcome: result?.outcome,
    enforcementMode: result?.enforcementMode,
    findings,
    capabilities,
  };
  return isConsistentSecurityBaselineSummary(summary) ? summary : null;
}

export function toStoredSecurityBaselineRecord(result, {
  expectedRepository = "",
  expectedCommit = "",
  pluginIds,
} = {}) {
  const summary = normalizedResultSummary(result);
  const commit = fullCommit(result?.commitSha);
  const repository = String(result?.repository || "").toLowerCase();
  const normalizedIds = normalizedPluginIds(pluginIds);
  const resultIds = normalizedPluginIds(result?.pluginIds);
  if (
    result?.baselineVersion !== securityBaselineVersion
    || result?.enforcementMode !== securityBaselineEnforcementMode
    || !summary
    || !commit
    || !repository
    || !Number.isFinite(Date.parse(result?.checkedAt || ""))
    || (expectedRepository && repository !== expectedRepository.toLowerCase())
    || (expectedCommit && commit !== fullCommit(expectedCommit))
    || !normalizedIds?.length
    || !resultIds?.length
    || JSON.stringify(resultIds) !== JSON.stringify(normalizedIds)
  ) {
    throw new SecurityBaselineRecordError(
      "security-baseline-record-invalid",
      "Automated security baseline metadata is invalid or belongs to another listing",
    );
  }
  return Object.freeze({
    schemaVersion: securityBaselineRecordSchemaVersion,
    version: result.baselineVersion,
    repository,
    pluginIds: Object.freeze(normalizedIds),
    commit,
    checkedAt: result.checkedAt,
    outcome: result.outcome,
    enforcementMode: result.enforcementMode,
    findings: Object.freeze([...summary.findings]),
    capabilities: Object.freeze([...summary.capabilities]),
  });
}

export function parseStoredSecurityBaselineRecord(record, {
  expectedRepository = "",
  allowedRepositories,
  allowLegacyRepositoryFallback = true,
  expectedCommit = "",
  pluginIds,
} = {}) {
  const normalizedIds = normalizedPluginIds(pluginIds);
  const storedIds = normalizedPluginIds(record?.pluginIds);
  const commit = fullCommit(record?.commit);
  const summary = {
    outcome: record?.outcome,
    enforcementMode: record?.enforcementMode,
    findings: record?.findings,
    capabilities: record?.capabilities,
  };
  const repository = String(record?.repository || "").toLowerCase();
  const expectedRepositoryKey = String(expectedRepository || "").toLowerCase();
  const allowedRepositoryKeys = normalizedRepositories(allowedRepositories, expectedRepositoryKey);
  const currentSchema = record?.schemaVersion === securityBaselineRecordSchemaVersion;
  const legacySchema = record?.schemaVersion === undefined;
  if (
    !record
    || ![undefined, securityBaselineRecordSchemaVersion].includes(record.schemaVersion)
    || (currentSchema && (!repository || !storedIds?.length))
    || (legacySchema && (
      !allowLegacyRepositoryFallback
      || !expectedRepositoryKey
      || !normalizedIds?.length
    ))
    || record.version !== securityBaselineVersion
    || record.enforcementMode !== securityBaselineEnforcementMode
    || !commit
    || !Number.isFinite(Date.parse(record.checkedAt || ""))
    || !isConsistentSecurityBaselineSummary(summary)
    || (expectedCommit && commit !== fullCommit(expectedCommit))
    || allowedRepositoryKeys === null
    || (repository && allowedRepositoryKeys.length && !allowedRepositoryKeys.includes(repository))
    || normalizedIds === null
    || storedIds === null
    || (normalizedIds && storedIds && JSON.stringify(normalizedIds) !== JSON.stringify(storedIds))
  ) return null;
  const resolvedRepository = repository || expectedRepositoryKey;
  const resolvedPluginIds = storedIds || normalizedIds;
  return Object.freeze({
    schemaVersion: securityBaselineRecordSchemaVersion,
    version: record.version,
    repository: resolvedRepository,
    pluginIds: Object.freeze(resolvedPluginIds),
    commit,
    checkedAt: record.checkedAt,
    outcome: record.outcome,
    enforcementMode: record.enforcementMode,
    findings: Object.freeze([...record.findings]),
    capabilities: Object.freeze([...record.capabilities]),
  });
}

function markerPayload(result) {
  const summary = normalizedResultSummary(result);
  const commitSha = fullCommit(result?.commitSha);
  const pluginIds = normalizedPluginIds(result?.pluginIds);
  if (
    !summary
    || result?.baselineVersion !== securityBaselineVersion
    || !commitSha
    || !pluginIds?.length
    || !Number.isFinite(Date.parse(result?.checkedAt || ""))
  ) {
    throw new SecurityBaselineRecordError(
      "security-baseline-marker-invalid",
      "Security baseline metadata is invalid",
    );
  }
  return {
    schemaVersion: securityBaselineMarkerSchemaVersion,
    baselineVersion: result.baselineVersion,
    repository: result.repository,
    pluginIds,
    commitSha,
    checkedAt: result.checkedAt,
    outcome: result.outcome,
    enforcementMode: result.enforcementMode,
    findings: summary.findings,
    capabilities: summary.capabilities,
  };
}

export function serializeSecurityBaselineMarker(result) {
  const encoded = Buffer.from(JSON.stringify(markerPayload(result))).toString("base64url");
  return `${securityBaselineMarkerPrefix}${encoded} -->`;
}

export function parseSecurityBaselineMarker(body) {
  const escapedPrefix = securityBaselineMarkerPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`${escapedPrefix}([A-Za-z0-9_-]+) -->`, "g");
  const matches = [...String(body || "").matchAll(pattern)];
  if (!matches.length) return null;
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(matches.at(-1)[1], "base64url").toString("utf8"));
  } catch {
    throw new SecurityBaselineRecordError(
      "approval-security-baseline-invalid",
      "Security baseline metadata is invalid",
    );
  }
  const pluginIds = normalizedPluginIds(parsed?.pluginIds);
  if (
    parsed?.schemaVersion !== securityBaselineMarkerSchemaVersion
    || parsed.baselineVersion !== securityBaselineVersion
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(parsed.repository || "")
    || !pluginIds?.length
    || !fullCommit(parsed.commitSha)
    || !Number.isFinite(Date.parse(parsed.checkedAt || ""))
    || !normalizedResultSummary(parsed)
  ) {
    throw new SecurityBaselineRecordError(
      "approval-security-baseline-invalid",
      "Security baseline metadata is invalid",
    );
  }
  return Object.freeze({
    ...parsed,
    pluginIds: Object.freeze(pluginIds),
    commitSha: fullCommit(parsed.commitSha),
  });
}

export function findLatestSecurityBaseline(comments) {
  const botComments = (comments || []).filter((comment) => {
    const body = String(comment.body || "");
    return comment?.user?.login === "github-actions[bot]"
      && (body.includes(securityBaselineMarkerPrefix) || body.includes(securityBaselineErrorMarker));
  });
  if (!botComments.length) return null;
  const latest = botComments.at(-1).body;
  if (latest.includes(securityBaselineErrorMarker)) {
    throw new SecurityBaselineRecordError(
      "approval-security-baseline-missing",
      "The latest automated security baseline did not complete",
    );
  }
  return parseSecurityBaselineMarker(latest);
}
