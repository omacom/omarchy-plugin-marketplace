import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import {
  catalogVerificationFields,
  projectCatalogVerification,
  projectPluginVerification,
} from "./catalog-verification.mjs";
import { parseGitHubRepository } from "./github-repository.mjs";
import {
  manifestFieldLimits,
  maximumManifestVersionLength,
  validatePluginManifest,
} from "./plugin-manifest.mjs";
import {
  assertObservedRepositoryIdentity,
  sourceRepositoryPluginIds,
  validateRegistryRepositoryMigrations,
} from "./repository-identity.mjs";

export { parseGitHubRepository } from "./github-repository.mjs";
export { manifestFieldLimits, maximumManifestVersionLength } from "./plugin-manifest.mjs";

const root = resolve(import.meta.dirname, "..");
const registryPath = resolve(root, "registry.json");
const catalogPath = resolve(root, "site/catalog.json");
const previewDirectory = resolve(root, "site/assets/img/plugins");
const previewParent = dirname(previewDirectory);
export const previewByteLimit = 50 * 1024 * 1024;
export const previewPixelLimit = 40_000_000;
export const previewCardLimit = 720;
export const previewDetailLimit = 1600;
const fileLimit = 1024 * 1024;
const graphqlResponseByteLimit = 2 * 1024 * 1024;
const requestTimeout = 15_000;
export const catalogRefreshGraphqlBatchSize = 50;
export const catalogRefreshGraphqlBudgetReserve = 50;
export const catalogRefreshGraphqlPointsPerBatchReserve = 10;
const catalogRefreshGraphqlAttempts = 3;
export const catalogRefreshRestBudgetReserve = 500;
export const catalogSourceValidationVersion = 1;
const accents = ["lime", "amber", "coral", "cyan", "violet", "rose"];
const supportedPreviewFormats = new Set(["png", "jpeg", "webp", "avif", "heif"]);
const builtInTaxonomyTags = Object.freeze({
  "omarchy.agents": ["ai"],
  "omarchy.polkit": ["security"],
});
const defaultPreviewPattern = /^preview\.(?:png|jpe?g|webp|avif)$/i;
const errorCodes = new Set([
  "repository-unreachable",
  "manifest-invalid",
  "entry-point-missing",
  "reserved-plugin-id",
  "readme-missing",
  "license-missing",
  "preview-invalid",
  "unsupported-repository-layout",
]);

const fatalBuildErrorCodes = new Set([
  "rate-limit-exhausted",
  "github-api-forbidden",
  "github-graphql-invalid",
  "github-graphql-unavailable",
  "api-budget-insufficient",
]);

const catalogApiUsage = {
  graphqlRequests: 0,
  graphqlPoints: 0,
  rawRequests: 0,
  restOtherRequests: 0,
  restRateLimitRequests: 0,
  restTreeRequests: 0,
};

export function resetCatalogApiUsage() {
  for (const key of Object.keys(catalogApiUsage)) catalogApiUsage[key] = 0;
}

export function currentCatalogApiUsage() {
  return Object.freeze({ ...catalogApiUsage });
}

export function catalogApiUsageSummary() {
  const usage = currentCatalogApiUsage();
  const restRequests = usage.restOtherRequests
    + usage.restRateLimitRequests
    + usage.restTreeRequests;
  return `Catalog API usage: REST ${restRequests} (trees ${usage.restTreeRequests}, budget ${usage.restRateLimitRequests}, other ${usage.restOtherRequests}); GraphQL ${usage.graphqlRequests} requests / ${usage.graphqlPoints} points; raw ${usage.rawRequests}.`;
}

export const upstreamCheckErrorCodes = Object.freeze([...errorCodes]);

export class CatalogCheckError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CatalogCheckError";
    this.code = errorCodes.has(code) ? code : "manifest-invalid";
  }
}

export class CatalogBuildError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CatalogBuildError";
    this.code = fatalBuildErrorCodes.has(code) ? code : "internal-error";
    this.publicMessage = message;
  }
}

export function assertRecoverableCatalogError(error) {
  if (!(error instanceof CatalogCheckError)) throw error;
  return error;
}

function checkError(code, message) {
  throw new CatalogCheckError(code, message);
}

export function catalogErrorCode(error, fallback = "manifest-invalid") {
  return errorCodes.has(error?.code) || fatalBuildErrorCodes.has(error?.code)
    ? error.code
    : fallback;
}

export function catalogRefreshFailureMessage(repoUrl, error, options = {}) {
  const repository = parseGitHubRepository(repoUrl);
  const safeSegment = (value) => String(value).replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 100);
  const slug = `${safeSegment(repository.owner)}/${safeSegment(repository.repository)}`;
  const source = options.builtIn ? "Built-in catalog" : "Catalog source";
  return `${source} refresh failed for ${slug} [${catalogErrorCode(error)}].`;
}

function githubHeaders() {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "omarchy-plugin-marketplace-catalog-builder",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

async function fetchWithTimeout(url, options = {}) {
  try {
    return await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(requestTimeout),
    });
  } catch (error) {
    throw new CatalogCheckError(
      "repository-unreachable",
      `Network request failed for ${new URL(url).hostname}: ${error.message}`,
    );
  }
}

export function githubApiFailure(response) {
  const status = Number(response?.status || 0);
  const limit = response?.headers?.get("x-ratelimit-limit") || "unknown";
  const remaining = response?.headers?.get("x-ratelimit-remaining") || "unknown";
  const reset = response?.headers?.get("x-ratelimit-reset") || "";
  const retryAfter = response?.headers?.get("retry-after") || "";
  const resetMilliseconds = /^\d+$/.test(reset) ? Number(reset) * 1000 : Number.NaN;
  const resetDate = Number.isFinite(resetMilliseconds)
    && resetMilliseconds <= 8_640_000_000_000_000
    ? new Date(resetMilliseconds).toISOString()
    : "unknown";
  if (status === 429 || remaining === "0" || (status === 403 && retryAfter)) {
    return new CatalogBuildError(
      "rate-limit-exhausted",
      `GitHub API rate limit exhausted (status ${status}, limit ${limit}, remaining ${remaining}, reset ${reset || "unknown"}, resetAt ${resetDate}${retryAfter ? `, retryAfter ${retryAfter}s` : ""})`,
    );
  }
  if (status === 401 || status === 403) {
    return new CatalogBuildError(
      "github-api-forbidden",
      `GitHub API access was forbidden (status ${status}, limit ${limit}, remaining ${remaining}, reset ${reset || "unknown"}, resetAt ${resetDate})`,
    );
  }
  return null;
}

async function githubApi(path, { optional = false } = {}) {
  if (path === "/rate_limit") catalogApiUsage.restRateLimitRequests += 1;
  else if (/\/git\/trees\//.test(path)) catalogApiUsage.restTreeRequests += 1;
  else catalogApiUsage.restOtherRequests += 1;
  const response = await fetchWithTimeout(`https://api.github.com${path}`, {
    headers: githubHeaders(),
  });
  if (optional && response.status === 404) return null;
  if (!response.ok) {
    const fatal = githubApiFailure(response);
    if (fatal) throw fatal;
    throw new CatalogCheckError(
      "repository-unreachable",
      `GitHub API ${response.status}`,
    );
  }
  try {
    return await response.json();
  } catch (error) {
    throw new CatalogCheckError(
      "repository-unreachable",
      `GitHub API response body could not be read: ${error.message}`,
    );
  }
}

function assertGraphqlRateLimit(value) {
  const cost = value?.cost;
  const limit = value?.limit;
  const remaining = value?.remaining;
  const resetAt = value?.resetAt;
  if (
    typeof cost !== "number"
    || typeof limit !== "number"
    || typeof remaining !== "number"
    || !Number.isSafeInteger(cost)
    || cost < 1
    || !Number.isSafeInteger(limit)
    || limit < 1
    || !Number.isSafeInteger(remaining)
    || remaining < 0
    || remaining > limit
    || typeof resetAt !== "string"
    || !Number.isFinite(Date.parse(resetAt))
  ) {
    throw new CatalogBuildError(
      "github-graphql-invalid",
      "GitHub GraphQL returned invalid rate-limit metadata",
    );
  }
  return Object.freeze({ cost, limit, remaining, resetAt });
}

async function githubGraphql(query, variables = {}) {
  let response;
  let networkError;
  for (let attempt = 1; attempt <= catalogRefreshGraphqlAttempts; attempt += 1) {
    catalogApiUsage.graphqlRequests += 1;
    try {
      response = await fetchWithTimeout("https://api.github.com/graphql", {
        method: "POST",
        headers: {
          ...githubHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
      });
      networkError = undefined;
    } catch (error) {
      networkError = error;
      response = undefined;
    }
    const retryable = networkError || [500, 502, 503, 504].includes(response?.status);
    if (retryable && attempt < catalogRefreshGraphqlAttempts) {
      try {
        await response?.body?.cancel();
      } catch {
        // The bounded retry remains authoritative.
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 250));
      continue;
    }
    break;
  }
  if (networkError) {
    if (networkError instanceof CatalogBuildError) throw networkError;
    throw new CatalogBuildError(
      "github-graphql-unavailable",
      `GitHub GraphQL identity request failed: ${networkError.message}`,
    );
  }
  if (!response?.ok) {
    const fatal = githubApiFailure(response);
    try {
      await response?.body?.cancel();
    } catch {
      // The HTTP failure remains authoritative.
    }
    if (fatal) throw fatal;
    throw new CatalogBuildError(
      "github-graphql-unavailable",
      `GitHub GraphQL returned status ${response?.status || "unknown"}`,
    );
  }
  let buffer;
  try {
    buffer = await readLimitedBuffer(
      response,
      graphqlResponseByteLimit,
      "repository-unreachable",
      "GitHub GraphQL identity",
    );
  } catch (error) {
    throw new CatalogBuildError(
      "github-graphql-invalid",
      `GitHub GraphQL response could not be read safely: ${error.message}`,
    );
  }
  let payload;
  try {
    payload = JSON.parse(buffer.toString("utf8"));
  } catch (error) {
    throw new CatalogBuildError(
      "github-graphql-invalid",
      `GitHub GraphQL returned invalid JSON: ${error.message}`,
    );
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new CatalogBuildError(
      "github-graphql-invalid",
      "GitHub GraphQL returned an invalid response object",
    );
  }
  const rateLimit = assertGraphqlRateLimit(payload.data?.rateLimit);
  catalogApiUsage.graphqlPoints += rateLimit.cost;
  return Object.freeze({
    data: payload.data,
    errors: payload.errors,
    rateLimit,
  });
}

function assertGraphqlErrorsAbsent(errors, label) {
  if (errors === undefined) return;
  if (!Array.isArray(errors) || errors.length) {
    throw new CatalogBuildError(
      "github-graphql-invalid",
      `GitHub GraphQL returned errors during ${label}`,
    );
  }
}

function assertGraphqlBudget(rateLimit, required, label) {
  if (!Number.isSafeInteger(required) || required < 0) {
    throw new CatalogBuildError("internal-error", "GraphQL budget requirement is invalid");
  }
  if (rateLimit.remaining < required) {
    throw new CatalogBuildError(
      "api-budget-insufficient",
      `GitHub GraphQL budget is insufficient for ${label} (remaining ${rateLimit.remaining}, required ${required}, resetAt ${rateLimit.resetAt})`,
    );
  }
}

function configuredSourceBranch(source) {
  if (source.branch === undefined) return "";
  if (
    typeof source.branch !== "string"
    || !source.branch
    || source.branch.length > 255
    || /[\u0000-\u001f\u007f]/u.test(source.branch)
  ) {
    throw new CatalogBuildError(
      "github-graphql-invalid",
      "Catalog source branch metadata is invalid",
    );
  }
  return source.branch;
}

export function catalogRefreshIdentityQuery(sources) {
  if (!Array.isArray(sources) || !sources.length || sources.length > catalogRefreshGraphqlBatchSize) {
    throw new CatalogBuildError(
      "github-graphql-invalid",
      "Catalog refresh identity batch size is invalid",
    );
  }
  const declarations = [];
  const fields = [];
  const variables = {};
  const entries = sources.map((source, index) => {
    const repository = parseGitHubRepository(source.repo);
    if (repository.owner.length > 39 || repository.repository.length > 100) {
      throw new CatalogBuildError(
        "github-graphql-invalid",
        "Catalog source repository identity exceeds GitHub limits",
      );
    }
    const branch = configuredSourceBranch(source);
    const alias = `r${index}`;
    declarations.push(`$owner${index}:String!`, `$name${index}:String!`, `$ref${index}:String!`);
    fields.push(`${alias}:repository(owner:$owner${index},name:$name${index}){...CatalogRefreshRepository configuredRef:ref(qualifiedName:$ref${index}){name target{...CatalogRefreshCommit}}}`);
    variables[`owner${index}`] = repository.owner;
    variables[`name${index}`] = repository.repository;
    variables[`ref${index}`] = `refs/heads/${branch || "__marketplace_default_branch_not_configured__"}`;
    return Object.freeze({
      alias,
      branch,
      key: repository.slug.toLowerCase(),
      repository,
      source,
    });
  });
  const query = `query CatalogRefreshIdentities(${declarations.join(",")}){${fields.join(" ")} rateLimit{cost limit remaining resetAt}} fragment CatalogRefreshRepository on Repository{id databaseId nameWithOwner isArchived isDisabled isPrivate stargazerCount pushedAt updatedAt defaultBranchRef{name target{...CatalogRefreshCommit}}} fragment CatalogRefreshCommit on Commit{oid tree{oid}}`;
  return Object.freeze({ query, variables: Object.freeze(variables), entries: Object.freeze(entries) });
}

function assertGraphqlRepositoryRef(value, label) {
  if (value === null) return;
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || typeof value.name !== "string"
    || !value.name
    || !value.target
    || typeof value.target !== "object"
    || Array.isArray(value.target)
    || !/^[a-f0-9]{40}$/i.test(value.target.oid || "")
    || !value.target.tree
    || typeof value.target.tree !== "object"
    || Array.isArray(value.target.tree)
    || !/^[a-f0-9]{40}$/i.test(value.target.tree.oid || "")
  ) {
    throw new CatalogBuildError(
      "github-graphql-invalid",
      `GitHub GraphQL returned an invalid ${label} structure`,
    );
  }
}

function graphqlSourceIdentity(entry, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CatalogBuildError(
      "github-graphql-invalid",
      "GitHub GraphQL returned an invalid repository identity structure",
    );
  }
  if (
    typeof value.id !== "string"
    || !value.id
    || !Number.isSafeInteger(value.databaseId)
    || value.databaseId < 1
    || typeof value.nameWithOwner !== "string"
    || typeof value.isPrivate !== "boolean"
    || typeof value.isDisabled !== "boolean"
    || typeof value.isArchived !== "boolean"
    || typeof value.stargazerCount !== "number"
    || !Number.isSafeInteger(value.stargazerCount)
    || value.stargazerCount < 0
    || !(value.pushedAt === null || (
      typeof value.pushedAt === "string"
      && Number.isFinite(Date.parse(value.pushedAt))
    ))
    || typeof value.updatedAt !== "string"
    || !Number.isFinite(Date.parse(value.updatedAt))
    || !Object.hasOwn(value, "defaultBranchRef")
    || !Object.hasOwn(value, "configuredRef")
  ) {
    throw new CatalogBuildError(
      "github-graphql-invalid",
      "GitHub GraphQL returned invalid repository identity fields",
    );
  }
  assertGraphqlRepositoryRef(value.defaultBranchRef, "default branch");
  assertGraphqlRepositoryRef(value.configuredRef, "configured branch");
  assertObservedRepositoryIdentity(entry.source, {
    nodeId: value.id,
    databaseId: value.databaseId,
    nameWithOwner: value.nameWithOwner,
  });
  if (
    value.nameWithOwner.toLowerCase() !== entry.key
    || value.isPrivate
    || value.isDisabled
    || value.isArchived
  ) {
    checkError("repository-unreachable", `${entry.repository.slug}: repository must remain public, active, and unarchived`);
  }
  const selectedRef = entry.branch ? value.configuredRef : value.defaultBranchRef;
  if (selectedRef === null || (entry.branch && selectedRef.name !== entry.branch)) {
    checkError("repository-unreachable", `${entry.repository.slug}: configured branch is unavailable`);
  }
  const branch = selectedRef.name;
  const commitSha = selectedRef.target.oid;
  const treeSha = selectedRef.target.tree.oid;
  return Object.freeze({
    repository: entry.repository,
    metadata: Object.freeze({
      archived: value.isArchived,
      default_branch: value.defaultBranchRef?.name || branch,
      disabled: value.isDisabled,
      full_name: value.nameWithOwner,
      id: value.databaseId,
      node_id: value.id,
      private: value.isPrivate,
      pushed_at: value.pushedAt,
      stargazers_count: value.stargazerCount,
      updated_at: value.updatedAt,
    }),
    branch,
    commitSha: commitSha.toLowerCase(),
    treeSha: treeSha.toLowerCase(),
  });
}

function graphqlBatchSourceErrors(result, entries) {
  if (result.errors === undefined) return new Set();
  if (!Array.isArray(result.errors)) {
    throw new CatalogBuildError(
      "github-graphql-invalid",
      "GitHub GraphQL returned an invalid errors collection",
    );
  }
  const aliases = new Set(entries.map((entry) => entry.alias));
  const failed = new Set();
  for (const error of result.errors) {
    const path = error?.path;
    const alias = Array.isArray(path) && path.length === 1 ? path[0] : "";
    if (
      error?.type !== "NOT_FOUND"
      || typeof alias !== "string"
      || !aliases.has(alias)
      || !Object.hasOwn(result.data || {}, alias)
      || result.data[alias] !== null
    ) {
      throw new CatalogBuildError(
        "github-graphql-invalid",
        "GitHub GraphQL returned an ambiguous partial identity response",
      );
    }
    failed.add(alias);
  }
  return failed;
}

export async function resolveFullRefreshIdentities(sources, options = {}) {
  if (!Array.isArray(sources)) {
    throw new CatalogBuildError("github-graphql-invalid", "Catalog refresh sources are invalid");
  }
  const batchSize = options.batchSize || catalogRefreshGraphqlBatchSize;
  const budgetReserve = options.budgetReserve ?? catalogRefreshGraphqlBudgetReserve;
  if (
    !Number.isSafeInteger(batchSize)
    || batchSize < 1
    || batchSize > catalogRefreshGraphqlBatchSize
    || !Number.isSafeInteger(budgetReserve)
    || budgetReserve < 0
  ) {
    throw new CatalogBuildError("github-graphql-invalid", "Catalog refresh GraphQL limits are invalid");
  }
  const keys = sources.map((source) => parseGitHubRepository(source.repo).slug.toLowerCase());
  if (new Set(keys).size !== keys.length) {
    throw new CatalogBuildError(
      "github-graphql-invalid",
      "Catalog refresh sources contain duplicate repositories",
    );
  }
  if (!sources.length) return new Map();

  const batchCount = Math.ceil(sources.length / batchSize);
  const preflight = await githubGraphql(
    "query CatalogRefreshBudget{rateLimit{cost limit remaining resetAt}}",
  );
  assertGraphqlErrorsAbsent(preflight.errors, "catalog refresh budget preflight");
  assertGraphqlBudget(
    preflight.rateLimit,
    batchCount * catalogRefreshGraphqlPointsPerBatchReserve + budgetReserve,
    "catalog refresh identity batches",
  );

  const identities = new Map();
  for (let offset = 0; offset < sources.length; offset += batchSize) {
    const batch = sources.slice(offset, offset + batchSize);
    const request = catalogRefreshIdentityQuery(batch);
    const result = await githubGraphql(request.query, request.variables);
    if (!result.data || typeof result.data !== "object" || Array.isArray(result.data)) {
      throw new CatalogBuildError(
        "github-graphql-invalid",
        "GitHub GraphQL returned no catalog identity data",
      );
    }
    const failedAliases = graphqlBatchSourceErrors(result, request.entries);
    for (const entry of request.entries) {
      if (!Object.hasOwn(result.data, entry.alias)) {
        throw new CatalogBuildError(
          "github-graphql-invalid",
          "GitHub GraphQL omitted a catalog source identity",
        );
      }
      if (failedAliases.has(entry.alias)) {
        identities.set(entry.key, Object.freeze({
          error: new CatalogCheckError(
            "repository-unreachable",
            `${entry.repository.slug}: repository identity is unavailable`,
          ),
        }));
        continue;
      }
      try {
        identities.set(entry.key, Object.freeze({
          context: graphqlSourceIdentity(entry, result.data[entry.alias]),
        }));
      } catch (error) {
        if (!(error instanceof CatalogCheckError)) throw error;
        identities.set(entry.key, Object.freeze({ error }));
      }
    }
    const completedBatches = Math.floor(offset / batchSize) + 1;
    const remainingBatches = batchCount - completedBatches;
    assertGraphqlBudget(
      result.rateLimit,
      remainingBatches * Math.max(
        catalogRefreshGraphqlPointsPerBatchReserve,
        result.rateLimit.cost,
      ) + budgetReserve,
      "remaining catalog refresh identity batches",
    );
  }
  return identities;
}

function responseBodyError(label, error) {
  return new CatalogCheckError(
    "repository-unreachable",
    `${label} response body could not be read: ${error.message}`,
  );
}

export async function readLimitedBuffer(response, limit, code, label) {
  const length = Number(response.headers.get("content-length") || 0);
  if (length > limit) checkError(code, `${label} exceeds the ${limit}-byte limit`);
  const reader = response.body?.getReader();
  if (!reader) {
    let arrayBuffer;
    try {
      arrayBuffer = await response.arrayBuffer();
    } catch (error) {
      throw responseBodyError(label, error);
    }
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length > limit) checkError(code, `${label} exceeds the ${limit}-byte limit`);
    return buffer;
  }
  const chunks = [];
  let size = 0;
  while (true) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (error) {
      throw responseBodyError(label, error);
    }
    const { done, value } = chunk;
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      try {
        await reader.cancel();
      } catch {
        // The content-size error below remains authoritative.
      }
      checkError(code, `${label} exceeds the ${limit}-byte limit`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size);
}

function rawUrl(repository, commitSha, path) {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `https://raw.githubusercontent.com/${repository.owner}/${repository.repository}/${commitSha}/${encodedPath}`;
}

async function readSnapshotBuffer(repository, path, commitSha, limit, code) {
  catalogApiUsage.rawRequests += 1;
  const response = await fetchWithTimeout(rawUrl(repository, commitSha, path), {
    headers: { "User-Agent": "omarchy-plugin-marketplace-catalog-builder" },
  });
  if (!response.ok) {
    checkError(
      snapshotHttpErrorCode(response.status, code),
      `Snapshot file download returned ${response.status}`,
    );
  }
  return readLimitedBuffer(response, limit, code, path);
}

export function snapshotHttpErrorCode(status, contentErrorCode) {
  return status === 429 || status >= 500
    ? "repository-unreachable"
    : contentErrorCode;
}

async function readSnapshotText(repository, path, commitSha) {
  const buffer = await readSnapshotBuffer(
    repository,
    path,
    commitSha,
    fileLimit,
    "manifest-invalid",
  );
  return buffer.toString("utf8");
}

function treeEntry(context, path) {
  return context.treeByPath.get(path);
}

function isBlob(entry) {
  return entry?.type === "blob" && entry.mode !== "120000";
}

export function validateManifest(manifest, manifestPath, { community = false } = {}) {
  return validatePluginManifest(manifest, manifestPath, {
    community,
    fail: checkError,
  });
}

function validateManifestFiles(manifest, manifestPath, context, { community = false } = {}) {
  validateManifest(manifest, manifestPath, { community });
  const pluginRoot = manifestPath.includes("/") ? dirname(manifestPath) : "";
  const prefix = pluginRoot ? `${pluginRoot}/` : "";
  const entries = context.tree.filter((entry) => !pluginRoot || entry.path.startsWith(prefix));
  if (entries.some((entry) => entry.mode === "120000")) {
    checkError("manifest-invalid", `${manifestPath}: symlinks are not allowed in plugin folders`);
  }
  for (const path of Object.values(manifest.entryPoints)) {
    if (!isBlob(treeEntry(context, `${prefix}${path}`))) {
      checkError("entry-point-missing", `${manifestPath}: declared entry point is missing`);
    }
  }
  return manifest;
}

function looksLikePluginManifest(manifest) {
  return manifest && (
    Object.hasOwn(manifest, "schemaVersion")
    || Object.hasOwn(manifest, "id")
  );
}

function validateRepositoryDocs(context) {
  const rootFiles = context.tree.filter((entry) => !entry.path.includes("/") && isBlob(entry));
  if (!rootFiles.some((entry) => /^readme(?:\.[^/]+)?$/i.test(entry.path))) {
    checkError("readme-missing", `${context.repository.slug}: a root README is required`);
  }
  if (!rootFiles.some((entry) => /^(?:licen[cs]e|copying)(?:\.[^/]+)?$/i.test(entry.path))) {
    checkError("license-missing", `${context.repository.slug}: a root license file is required`);
  }
}

export async function resolveSnapshotTree(identity) {
  if (
    !identity?.repository
    || !/^[a-f0-9]{40}$/i.test(identity.commitSha || "")
    || !/^[a-f0-9]{40}$/i.test(identity.treeSha || "")
  ) {
    throw new CatalogBuildError("internal-error", "Catalog snapshot identity is invalid");
  }
  const treeResponse = await githubApi(
    `/repos/${identity.repository.owner}/${identity.repository.repository}/git/trees/${identity.treeSha}?recursive=1`,
  );
  if (treeResponse.truncated) {
    checkError("unsupported-repository-layout", `${identity.repository.slug}: repository tree is too large`);
  }
  const tree = treeResponse.tree || [];
  if (!Array.isArray(tree)) {
    checkError("repository-unreachable", `${identity.repository.slug}: GitHub returned an invalid repository tree`);
  }
  return {
    ...identity,
    tree,
    treeByPath: new Map(tree.map((entry) => [entry.path, entry])),
  };
}

export async function resolveSnapshot(source) {
  const repository = parseGitHubRepository(source.repo);
  const metadata = await githubApi(`/repos/${repository.owner}/${repository.repository}`);
  assertObservedRepositoryIdentity(source, {
    nodeId: metadata?.node_id,
    databaseId: metadata?.id,
    nameWithOwner: metadata?.full_name,
  });
  if (metadata.private || metadata.disabled || metadata.archived) {
    checkError("repository-unreachable", `${repository.slug} must be public, active, and unarchived`);
  }
  const branch = source.branch || metadata.default_branch;
  const requestedCommit = source.snapshotCommit;
  if (requestedCommit !== undefined && !/^[a-f0-9]{40}$/i.test(requestedCommit)) {
    checkError("repository-unreachable", `${repository.slug}: snapshotCommit must be a full commit SHA`);
  }
  const commitRef = requestedCommit || branch;
  const commit = await githubApi(
    `/repos/${repository.owner}/${repository.repository}/commits/${encodeURIComponent(commitRef)}`,
  );
  const commitSha = commit.sha;
  const treeSha = commit.commit?.tree?.sha;
  if (!/^[a-f0-9]{40}$/i.test(commitSha || "") || !/^[a-f0-9]{40}$/i.test(treeSha || "")) {
    checkError("repository-unreachable", `${repository.slug}: GitHub returned an invalid snapshot`);
  }
  if (requestedCommit && commitSha.toLowerCase() !== requestedCommit.toLowerCase()) {
    checkError("repository-unreachable", `${repository.slug}: GitHub resolved a different snapshot commit`);
  }
  return resolveSnapshotTree({
    repository,
    metadata,
    branch,
    commitSha: commitSha.toLowerCase(),
    treeSha: treeSha.toLowerCase(),
  });
}

function normalizedReleaseTag(value) {
  if (
    typeof value !== "string"
    || !value
    || value.length > 256
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
    || /[\ud800-\udfff]/u.test(value)
    || /[\p{Bidi_Control}\p{Zl}\p{Zp}]/u.test(value)
  ) return null;
  return value;
}

function normalizedReleaseTimestamp(value) {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    || !Number.isFinite(Date.parse(value))
  ) return null;
  const canonicalTimestamp = new Date(value).toISOString();
  return value === canonicalTimestamp || value === canonicalTimestamp.replace(".000Z", "Z")
    ? value
    : null;
}

function normalizedRepositoryRelease(repository, tagValue, path, publishedAt) {
  const tag = normalizedReleaseTag(tagValue);
  if (!tag || !["releases/tag", "tree"].includes(path)) return null;
  const release = {
    tag,
    url: `https://github.com/${repository.slug}/${path}/${encodeURIComponent(tag)}`,
  };
  const timestamp = normalizedReleaseTimestamp(publishedAt);
  if (timestamp) release.publishedAt = timestamp;
  return release;
}

async function optionalRepositoryRelease(context, fallback) {
  try {
    const release = await githubApi(
      `/repos/${context.repository.owner}/${context.repository.repository}/releases/latest`,
      { optional: true },
    );
    if (release?.tag_name && !release.draft) {
      const normalized = normalizedRepositoryRelease(
        context.repository,
        release.tag_name,
        "releases/tag",
        release.published_at || release.created_at,
      );
      if (normalized) return normalized;
    }
    const tags = await githubApi(
      `/repos/${context.repository.owner}/${context.repository.repository}/tags?per_page=1`,
    );
    if (!tags[0]?.name) return null;
    return normalizedRepositoryRelease(context.repository, tags[0].name, "tree");
  } catch (error) {
    assertRecoverableCatalogError(error);
    return fallback;
  }
}

function preservedRepositoryRelease(source, previousPlugins) {
  const release = previousPlugins.find((plugin) => (
    plugin.repo === source.repo && plugin.repositoryRelease
  ))?.repositoryRelease;
  if (!release || typeof release !== "object" || Array.isArray(release)) return undefined;

  const repository = parseGitHubRepository(source.repo);
  for (const path of ["releases/tag", "tree"]) {
    const normalized = normalizedRepositoryRelease(
      repository,
      release.tag,
      path,
      release.publishedAt,
    );
    if (normalized?.url === release.url) return normalized;
  }
  return undefined;
}

export async function repositoryReleaseForRefresh(
  context,
  source,
  previousPlugins,
  incremental,
) {
  const preserved = preservedRepositoryRelease(source, previousPlugins);
  if (incremental) return optionalRepositoryRelease(context, preserved);
  // Keep the authenticated API budget for exact snapshot checks during full refreshes.
  return preserved;
}

function previewPathFor(source, context) {
  if (source.previewPath) return source.previewPath.replace(/^\/+/, "");
  if (source.previewImage) {
    const parsed = new URL(source.previewImage);
    const prefix = `/${context.repository.owner}/${context.repository.repository}/`;
    if (parsed.hostname !== "raw.githubusercontent.com" || !parsed.pathname.startsWith(prefix)) {
      checkError("preview-invalid", `${context.repository.slug}: preview must come from the listed repository`);
    }
    const rest = parsed.pathname.slice(prefix.length).split("/");
    rest.shift();
    return rest.join("/");
  }
  const candidates = context.tree
    .filter((entry) => !entry.path.includes("/") && isBlob(entry) && defaultPreviewPattern.test(entry.path))
    .map((entry) => entry.path);
  const priority = ["preview.png", "preview.webp", "preview.jpg", "preview.jpeg", "preview.avif"];
  return candidates.sort((left, right) => {
    const leftIndex = priority.indexOf(left.toLowerCase());
    const rightIndex = priority.indexOf(right.toLowerCase());
    return leftIndex - rightIndex || left.localeCompare(right);
  })[0] || "";
}

function previewExtension(path) {
  const extension = extname(path).toLowerCase();
  if ([".png", ".webp", ".jpg", ".jpeg", ".avif"].includes(extension)) return extension;
  checkError("preview-invalid", `Unsupported preview image extension: ${extension || "none"}`);
}

export function previewFileBase(repository) {
  const owner = repository.owner.toLowerCase();
  const name = repository.repository.toLowerCase();
  return `${owner.length}-${owner}-${name}`;
}

export function validatePreviewMetadata(metadata, label = "Preview") {
  if (
    !supportedPreviewFormats.has(metadata?.format)
    || !Number.isSafeInteger(metadata.width)
    || !Number.isSafeInteger(metadata.height)
    || metadata.width < 1
    || metadata.height < 1
    || metadata.width > previewPixelLimit / metadata.height
  ) {
    checkError(
      "preview-invalid",
      `${label} must be a valid PNG, JPEG, WebP, or AVIF image within the ${previewPixelLimit}-pixel limit`,
    );
  }
  return metadata;
}

export async function optimizePreviewBuffer(buffer, repository) {
  try {
    const image = sharp(buffer, {
      failOn: "error",
      limitInputPixels: previewPixelLimit,
    });
    const metadata = validatePreviewMetadata(
      await image.metadata(),
      `${repository.slug} preview`,
    );
    const card = await image
      .clone()
      .rotate()
      .resize({
        width: previewCardLimit,
        height: previewCardLimit,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 78, alphaQuality: 85, effort: 4, smartSubsample: true })
      .toBuffer({ resolveWithObject: true });
    const detail = await image
      .clone()
      .rotate()
      .resize({
        width: previewDetailLimit,
        height: previewDetailLimit,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 82, alphaQuality: 90, effort: 4, smartSubsample: true })
      .toBuffer({ resolveWithObject: true });
    const fileBase = previewFileBase(repository);
    const cardFileName = `${fileBase}-card.webp`;
    const detailFileName = `${fileBase}-detail.webp`;
    return {
      fileBase,
      outputs: [
        { fileName: cardFileName, buffer: card.data },
        { fileName: detailFileName, buffer: detail.data },
      ],
      metadata: {
        previewImage: `assets/img/plugins/${detailFileName}`,
        previewWidth: detail.info.width,
        previewHeight: detail.info.height,
        previewThumbnail: `assets/img/plugins/${cardFileName}`,
        previewThumbnailWidth: card.info.width,
        previewThumbnailHeight: card.info.height,
        previewSourceWidth: metadata.width,
        previewSourceHeight: metadata.height,
      },
    };
  } catch (error) {
    if (error instanceof CatalogCheckError) throw error;
    checkError("preview-invalid", `${repository.slug}: preview could not be decoded safely`);
  }
}

async function loadSnapshotPreview(source, context) {
  const path = previewPathFor(source, context);
  if (!path) return null;
  const entry = treeEntry(context, path);
  if (!isBlob(entry) || !Number.isFinite(entry.size) || entry.size < 1 || entry.size > previewByteLimit) {
    checkError("preview-invalid", `${context.repository.slug}: preview is missing, linked, or too large`);
  }
  previewExtension(path);
  const buffer = await readSnapshotBuffer(
    context.repository,
    path,
    context.commitSha,
    previewByteLimit,
    "preview-invalid",
  );
  return optimizePreviewBuffer(buffer, context.repository);
}

async function stageSnapshotPreview(snapshot, stageDirectory) {
  if (!snapshot) return;
  for (const output of snapshot.outputs) {
    await writeFile(resolve(stageDirectory, output.fileName), output.buffer);
  }
}

export async function validateBeforeStagingPreview({
  loadPreview,
  validateSource,
  stagePreview,
}) {
  const snapshot = await loadPreview();
  const result = await validateSource(snapshot?.metadata || null);
  if (snapshot) await stagePreview(snapshot);
  return result;
}

function canonicalCatalogValue(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalCatalogValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalCatalogValue(value[key])]),
    );
  }
  throw new Error("Catalog source contains a value that cannot be fingerprinted");
}

export function catalogSourceFingerprint(source) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalCatalogValue(source)))
    .digest("hex");
}

function sourceCatalogPluginIds(source) {
  if (source?.type === "suite") return source.catalog?.id ? [source.catalog.id] : [];
  return Object.keys(source?.plugins || {}).sort();
}

function previousCatalogSourcePlugins(source, previousPlugins) {
  const repositoryKey = parseGitHubRepository(source.repo).slug.toLowerCase();
  return (previousPlugins || []).filter((plugin) => {
    if (plugin?.builtIn || plugin?.placeholder || (plugin.sourceType || "community") !== "community") {
      return false;
    }
    try {
      return parseGitHubRepository(plugin.repo).slug.toLowerCase() === repositoryKey;
    } catch {
      return false;
    }
  });
}

export function canReuseFullRefreshSource(source, identity, previousPlugins) {
  if (!identity || !/^[a-f0-9]{40}$/.test(identity.commitSha || "")) return false;
  const expectedIds = sourceCatalogPluginIds(source);
  const previous = previousCatalogSourcePlugins(source, previousPlugins);
  if (
    !expectedIds.length
    || JSON.stringify(previous.map((plugin) => plugin.id).sort()) !== JSON.stringify(expectedIds)
  ) return false;
  const fingerprint = catalogSourceFingerprint(source);
  return previous.every((plugin) => (
    plugin.upstreamCheckStatus === "passed"
    && plugin.upstreamValidationVersion === catalogSourceValidationVersion
    && plugin.upstreamSourceFingerprint === fingerprint
    && String(plugin.upstreamObservedCommit || "").toLowerCase() === identity.commitSha
    && String(plugin.upstreamValidatedCommit || "").toLowerCase() === identity.commitSha
    && plugin.upstreamObservedBranch === identity.branch
    && Number.isFinite(Date.parse(plugin.upstreamValidatedAt || ""))
  ));
}

export function reusableFullRefreshPlugins(source, identity, previousPlugins, checkedAt) {
  if (!canReuseFullRefreshSource(source, identity, previousPlugins)) return null;
  return previousCatalogSourcePlugins(source, previousPlugins).map((plugin) => {
    const next = {
      ...plugin,
      ...requireListingProvenance(source),
      ...repositoryMetadata(identity.metadata),
      upstreamObservedCommit: identity.commitSha,
      upstreamObservedBranch: identity.branch,
      upstreamCheckedAt: checkedAt,
      upstreamCheckStatus: "passed",
      upstreamValidationVersion: catalogSourceValidationVersion,
      upstreamSourceFingerprint: catalogSourceFingerprint(source),
    };
    delete next.upstreamCheckError;
    return projectPluginVerification(next, source);
  });
}

function repositoryMetadata(metadata) {
  return {
    stars: metadata.stargazers_count || 0,
    repositoryUpdatedAt: metadata.pushed_at || metadata.updated_at,
  };
}

function listingDate(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label}: addedAt must use YYYY-MM-DD`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label}: addedAt is not a valid calendar date`);
  }
  return value;
}

function listingTimestamp(value, addedAt, label) {
  const timestamp = value || `${addedAt}T00:00:00.000Z`;
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== timestamp) {
    throw new Error(`${label}: listedAt must be a UTC ISO timestamp`);
  }
  return timestamp;
}

function requireListingProvenance(source) {
  if (
    !/^[a-f0-9]{40}$/i.test(source.listingValidatedCommit || "")
    || !source.listingValidatedAt
    || !source.listingValidatedBranch
  ) {
    throw new Error(`${source.repo}: immutable listing validation provenance is missing`);
  }
  return {
    listingValidatedCommit: source.listingValidatedCommit,
    listingValidatedAt: source.listingValidatedAt,
    listingValidatedBranch: source.listingValidatedBranch,
  };
}

function initials(name) {
  return String(name)
    .split(/[\s_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function accentFor(id) {
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return accents[hash % accents.length];
}

function kindFor(kinds = []) {
  if (kinds.includes("bar-widget")) return "Bar widget";
  if (kinds.includes("overlay")) return "Overlay";
  if (kinds.includes("panel")) return "Panel";
  if (kinds.includes("bar")) return "Bar";
  if (kinds.includes("service")) return "Service";
  return "Plugin";
}

function categoryFor(kinds = []) {
  if (kinds.includes("bar-widget")) return "Widgets";
  if (kinds.includes("overlay") || kinds.includes("panel") || kinds.includes("bar")) return "Desktop";
  if (kinds.includes("service")) return "System";
  return "Other";
}

function registryPresentation(overrides = {}) {
  const allowed = ["category", "tags", "accent", "initials", "kind"];
  return Object.fromEntries(
    allowed
      .filter((field) => overrides[field] !== undefined)
      .map((field) => [field, overrides[field]]),
  );
}

function repositoryGitUrl(repo) {
  return repo.endsWith(".git") ? repo : `${repo}.git`;
}

export function communityInstall(source, manifestPath, overrides = {}) {
  const installation = overrides.installation;
  if (installation !== undefined) {
    if (
      manifestPath !== "manifest.json"
      || !installation
      || typeof installation !== "object"
      || Array.isArray(installation)
      || installation.mode !== "manual"
      || typeof installation.note !== "string"
      || !installation.note.trim()
      || Object.keys(installation).some((field) => !["mode", "note"].includes(field))
    ) {
      throw new Error(`${source.repo}: invalid manual installation override`);
    }
    return {
      repositoryLayout: "root-plugin",
      installAvailable: false,
      installCommand: "",
      installNote: installation.note,
    };
  }
  if (manifestPath === "manifest.json") {
    return {
      repositoryLayout: "root-plugin",
      installAvailable: true,
      installCommand: `omarchy plugin add ${repositoryGitUrl(source.repo)} --enable`,
      installNote: "Omarchy clones the current upstream repository, validates it locally, and only then installs and enables the plugin.",
    };
  }
  return {
    repositoryLayout: "monorepo",
    installAvailable: false,
    installCommand: "",
    installNote: "Automatic installation is unavailable because this plugin is stored inside a multi-plugin repository without a transactional Omarchy update path.",
  };
}

export function isListedPlugin(source, pluginId) {
  return Object.hasOwn(source.plugins || {}, pluginId);
}

export function successfulState(plugin, source, context, previous, checkedAt) {
  const prior = previous?.id === plugin.id ? previous : null;
  const changedVersion = prior && prior.version !== plugin.version;
  const next = {
    ...plugin,
    ...requireListingProvenance(source),
    upstreamObservedCommit: context.commitSha,
    upstreamObservedBranch: context.branch,
    upstreamCheckedAt: checkedAt,
    upstreamCheckStatus: "passed",
    upstreamValidatedCommit: context.commitSha,
    upstreamValidatedAt: checkedAt,
    upstreamValidationVersion: catalogSourceValidationVersion,
    upstreamSourceFingerprint: catalogSourceFingerprint(source),
    ...(changedVersion
      ? { versionUpdatedAt: checkedAt }
      : prior?.versionUpdatedAt
        ? { versionUpdatedAt: prior.versionUpdatedAt }
        : {}),
    status: plugin.installAvailable ? "Available" : "Manual setup",
  };
  return projectPluginVerification(next, source);
}

export function applyVersionState(plugins, previousPlugins, checkedAt) {
  const previousById = new Map((previousPlugins || []).map((plugin) => [plugin.id, plugin]));
  return plugins.map((plugin) => {
    const previous = previousById.get(plugin.id);
    if (!previous || previous.version === plugin.version) {
      return previous?.versionUpdatedAt
        ? { ...plugin, versionUpdatedAt: previous.versionUpdatedAt }
        : plugin;
    }
    return { ...plugin, versionUpdatedAt: checkedAt };
  });
}

function suitePlugin(source, context, preview) {
  if (!source.catalog?.id || !source.catalog?.name) {
    checkError("unsupported-repository-layout", `${context.repository.slug}: suite metadata is incomplete`);
  }
  const addedAt = listingDate(source.catalog.addedAt || source.addedAt, context.repository.slug);
  return {
    ...source.catalog,
    repo: source.repo,
    sourceType: "community",
    ...catalogVerificationFields(source),
    addedAt,
    listedAt: listingTimestamp(
      source.catalog.listedAt || source.listedAt,
      addedAt,
      context.repository.slug,
    ),
    repositoryLayout: "suite",
    installAvailable: false,
    installCommand: "",
    installNote: "This repository is a shell suite with its own installer, not an installable Omarchy Quattro plugin repository.",
    license: "See repository",
    ...repositoryMetadata(context.metadata),
    ...(context.repositoryRelease ? { repositoryRelease: context.repositoryRelease } : {}),
    ...(preview || {}),
  };
}

export async function discoveredPlugins(source, context, preview) {
  const manifestPaths = context.tree
    .filter((entry) => isBlob(entry) && /^(?:[^/]+\/)?manifest\.json$/i.test(entry.path))
    .map((entry) => entry.path)
    .sort();
  if (!manifestPaths.length) {
    checkError("unsupported-repository-layout", `${context.repository.slug}: no supported plugin manifests found`);
  }
  const configuredOrder = new Map(
    Object.keys(source.plugins || {}).map((id, index) => [id, index]),
  );
  const plugins = [];
  const seenIds = new Set();
  for (const manifestPath of manifestPaths) {
    let manifest;
    try {
      manifest = JSON.parse(
        await readSnapshotText(context.repository, manifestPath, context.commitSha),
      );
    } catch (error) {
      if (error instanceof CatalogCheckError) throw error;
      checkError("manifest-invalid", `${context.repository.slug}/${manifestPath}: invalid JSON`);
    }
    if (!looksLikePluginManifest(manifest)) continue;
    const candidateId = typeof manifest.id === "string" ? manifest.id.trim() : manifest.id;
    if (!isListedPlugin(source, candidateId)) continue;
    validateManifestFiles(manifest, manifestPath, context, { community: true });
    if (seenIds.has(manifest.id)) {
      checkError("manifest-invalid", `${context.repository.slug}: duplicate plugin id`);
    }
    seenIds.add(manifest.id);
    const kinds = manifest.kinds.map(String);
    const overrides = source.plugins?.[manifest.id] || {};
    const addedAt = listingDate(
      overrides.addedAt || source.addedAt,
      `${context.repository.slug}/${manifest.id}`,
    );
    plugins.push({
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      author: manifest.author,
      version: manifest.version,
      repo: source.repo,
      sourceType: "community",
      ...catalogVerificationFields(source),
      manifestPath,
      addedAt,
      listedAt: listingTimestamp(
        overrides.listedAt || source.listedAt,
        addedAt,
        `${context.repository.slug}/${manifest.id}`,
      ),
      ...communityInstall(source, manifestPath, overrides),
      category: categoryFor(kinds),
      tags: kinds.slice(0, 3).map((kind) => kind.toLowerCase()),
      license: manifest.license || "See repository",
      ...repositoryMetadata(context.metadata),
      ...(context.repositoryRelease ? { repositoryRelease: context.repositoryRelease } : {}),
      accent: accentFor(manifest.id),
      initials: initials(manifest.name),
      kind: kindFor(kinds),
      ...(preview || {}),
      ...registryPresentation(overrides),
    });
  }
  if (!plugins.length) {
    checkError("manifest-invalid", `${context.repository.slug}: no valid plugin manifests found`);
  }
  for (const configuredId of Object.keys(source.plugins || {})) {
    if (!seenIds.has(configuredId)) {
      checkError("manifest-invalid", `${context.repository.slug}: configured plugin is missing`);
    }
  }
  return plugins.sort((left, right) => {
    const leftOrder = configuredOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = configuredOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || left.name.localeCompare(right.name);
  });
}

export function failedSourcePlugins(source, previousPlugins, context, checkedAt, error) {
  const previous = previousPlugins.filter((plugin) => plugin.repo === source.repo);
  if (!previous.length) throw error;
  const code = catalogErrorCode(error);
  const unreachable = code === "repository-unreachable";
  const repositoryRelease = preservedRepositoryRelease(source, previous);
  return previous.map((plugin) => {
    const rootInstall = plugin.repositoryLayout === "root-plugin"
      ? communityInstall(
          source,
          plugin.manifestPath || "manifest.json",
          source.plugins?.[plugin.id] || {},
        )
      : null;
    const next = {
      ...plugin,
      upstreamCheckedAt: checkedAt,
      upstreamCheckStatus: unreachable ? "unreachable" : "failed",
      upstreamCheckError: code,
      ...(context && /^[a-f0-9]{40}$/i.test(context.commitSha || "") && context.branch
        ? {
            upstreamObservedCommit: context.commitSha.toLowerCase(),
            upstreamObservedBranch: context.branch,
          }
        : {}),
      ...(rootInstall || {}),
      installAvailable: Boolean(unreachable && rootInstall?.installAvailable),
      installCommand: unreachable && rootInstall ? rootInstall.installCommand : "",
      status: unreachable ? "Status unknown" : "Compatibility failed",
    };
    if (repositoryRelease) next.repositoryRelease = repositoryRelease;
    else delete next.repositoryRelease;
    return projectPluginVerification(next, source);
  });
}

function builtInCategory(kinds) {
  const labels = {
    bar: "Bars",
    "bar-widget": "Bar widgets",
    overlay: "Overlays",
    service: "Services",
    panel: "Panels",
    menu: "Menus",
  };
  return labels[kinds[0]] || "Other";
}

function builtInKind(kinds) {
  const labels = {
    bar: "Bar",
    "bar-widget": "Bar widget",
    overlay: "Overlay",
    service: "Service",
    panel: "Panel",
    menu: "Menu",
  };
  return kinds.map((kind) => labels[kind] || kind).join(" + ");
}

function builtInCommand(id, kinds) {
  if (kinds.includes("bar-widget")) {
    return { command: `omarchy bar plugin add ${id}`, label: "Add to bar" };
  }
  return { command: `omarchy plugin enable ${id}`, label: "Enable plugin" };
}

async function discoveredBuiltIns(source, context) {
  const manifestRoot = String(source.manifestRoot || "shell/plugins").replace(/^\/|\/$/g, "");
  const prefix = `${manifestRoot}/`;
  const excluded = new Set(source.exclude || []);
  const manifestPaths = context.tree
    .filter((entry) => (
      isBlob(entry)
      && entry.path.startsWith(prefix)
      && /(?:^|\/)(?:manifest|[^/]+\.manifest)\.json$/i.test(entry.path)
    ))
    .map((entry) => entry.path)
    .sort();
  if (!manifestPaths.length) {
    checkError("unsupported-repository-layout", `${context.repository.slug}: no built-in manifests found`);
  }
  const metadata = repositoryMetadata(context.metadata);
  const plugins = await Promise.all(manifestPaths.map(async (manifestPath) => {
    let sourceManifest;
    try {
      sourceManifest = JSON.parse(
        await readSnapshotText(context.repository, manifestPath, context.commitSha),
      );
    } catch (error) {
      if (error instanceof CatalogCheckError) throw error;
      checkError("manifest-invalid", `${context.repository.slug}/${manifestPath}: invalid JSON`);
    }
    const manifest = {
      author: "Omarchy",
      description: `Built-in ${sourceManifest.name || sourceManifest.id || "Omarchy"} plugin`,
      ...sourceManifest,
    };
    validateManifestFiles(manifest, manifestPath, context);
    if (excluded.has(manifest.id)) return null;
    const kinds = manifest.kinds.map(String);
    const officialCommand = builtInCommand(manifest.id, kinds);
    const sourceDirectory = dirname(manifestPath);
    return {
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      author: manifest.author,
      version: manifest.version,
      repo: source.repo,
      sourceUrl: `${source.repo}/tree/${context.commitSha}/${sourceDirectory}`,
      sourceType: "builtin",
      builtIn: true,
      manifestPath,
      installCommand: "",
      officialCommand: officialCommand.command,
      officialCommandLabel: officialCommand.label,
      installNote: "Included with Omarchy Quattro. No marketplace installation is required.",
      category: builtInCategory(kinds),
      tags: [...kinds, ...(builtInTaxonomyTags[manifest.id] || [])],
      license: "See repository",
      repositoryUpdatedAt: metadata.repositoryUpdatedAt,
      accent: accentFor(manifest.id),
      initials: initials(manifest.name),
      kind: builtInKind(kinds),
      status: "Built in",
    };
  }));
  const visible = plugins.filter(Boolean);
  if (new Set(visible.map((plugin) => plugin.id)).size !== visible.length) {
    checkError("manifest-invalid", `${context.repository.slug}: duplicate built-in plugin IDs`);
  }
  return visible.sort((left, right) => left.name.localeCompare(right.name));
}

async function inspectPluginManifests(context, { submission = false } = {}) {
  const manifestPaths = context.tree
    .filter((entry) => isBlob(entry) && /^(?:[^/]+\/)?manifest\.json$/i.test(entry.path))
    .map((entry) => entry.path)
    .sort();
  if (submission && (manifestPaths.length !== 1 || manifestPaths[0] !== "manifest.json")) {
    checkError(
      "unsupported-repository-layout",
      "New submissions require exactly one plugin manifest at the repository root",
    );
  }
  const manifests = [];
  const ids = new Set();
  for (const manifestPath of manifestPaths) {
    let manifest;
    try {
      manifest = JSON.parse(
        await readSnapshotText(context.repository, manifestPath, context.commitSha),
      );
    } catch (error) {
      if (error instanceof CatalogCheckError) throw error;
      checkError("manifest-invalid", `${manifestPath}: invalid JSON`);
    }
    if (!looksLikePluginManifest(manifest)) continue;
    validateManifestFiles(manifest, manifestPath, context, { community: true });
    if (ids.has(manifest.id)) checkError("manifest-invalid", "Duplicate plugin id");
    ids.add(manifest.id);
    manifests.push({
      path: manifestPath,
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      entryPoints: Object.values(manifest.entryPoints),
    });
  }
  if (!manifests.length) checkError("manifest-invalid", "No valid plugin manifests found");
  return manifests;
}

export async function inspectSubmission(repoUrl) {
  const source = { repo: repoUrl };
  const context = await resolveSnapshot(source);
  validateRepositoryDocs(context);
  const manifests = await inspectPluginManifests(context, { submission: true });
  const preview = await loadSnapshotPreview(source, context);
  return {
    repository: context.repository.slug,
    defaultBranch: context.branch,
    commitSha: context.commitSha,
    treeSha: context.treeSha,
    description: context.metadata.description || "",
    license: "repository-file",
    preview: Boolean(preview),
    manifests,
  };
}

export async function inspectListedPluginSource(source) {
  if (source?.type !== "plugin-source") {
    checkError("unsupported-repository-layout", "Plugin updates require a plugin-source listing");
  }
  const context = await resolveSnapshot({
    ...source,
    branch: undefined,
    listingValidatedBranch: undefined,
  });
  const manifests = await inspectPluginManifests(context);
  return {
    repository: context.repository.slug,
    defaultBranch: context.branch,
    commitSha: context.commitSha,
    treeSha: context.treeSha,
    description: context.metadata.description || "",
    license: "repository-file",
    preview: false,
    manifests,
  };
}

async function seedPreviewStage(stageDirectory, sourceDirectory = previewDirectory) {
  await mkdir(stageDirectory, { recursive: true });
  try {
    for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
      if (entry.isFile()) {
        await copyFile(resolve(sourceDirectory, entry.name), resolve(stageDirectory, entry.name));
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function prunePreviewStage(stageDirectory, plugins) {
  const referenced = new Set();
  for (const plugin of plugins) {
    for (const field of ["previewImage", "previewThumbnail"]) {
      const value = plugin[field];
      if (typeof value === "string" && value.startsWith("assets/img/plugins/")) {
        referenced.add(value.slice("assets/img/plugins/".length));
      }
    }
  }
  for (const existing of await readdir(stageDirectory)) {
    if (!referenced.has(existing)) await unlink(resolve(stageDirectory, existing));
  }
}

async function commitGeneratedFiles(stageDirectory, serializedCatalog, options = {}) {
  const targetCatalogPath = options.catalogPath || catalogPath;
  const targetPreviewDirectory = options.previewDirectory || previewDirectory;
  const catalogTemp = `${targetCatalogPath}.tmp-${process.pid}`;
  const previewBackup = `${targetPreviewDirectory}.backup-${process.pid}`;
  await writeFile(catalogTemp, serializedCatalog);
  let movedPreview = false;
  try {
    await rm(previewBackup, { recursive: true, force: true });
    try {
      await rename(targetPreviewDirectory, previewBackup);
      movedPreview = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await rename(stageDirectory, targetPreviewDirectory);
    await rename(catalogTemp, targetCatalogPath);
    await rm(previewBackup, { recursive: true, force: true });
  } catch (error) {
    await rm(catalogTemp, { force: true });
    await rm(targetPreviewDirectory, { recursive: true, force: true });
    if (movedPreview) await rename(previewBackup, targetPreviewDirectory);
    throw error;
  }
}

export function catalogSourcePlan(
  registry,
  approvedRepository = "",
  repositoryMigrationTargets = [],
) {
  const sources = registry.sources || [];
  if (!Array.isArray(repositoryMigrationTargets)) {
    throw new Error("Repository migration targets must be an array");
  }
  if (approvedRepository && repositoryMigrationTargets.length) {
    throw new Error("Approval and repository migration modes are mutually exclusive");
  }
  if (repositoryMigrationTargets.length) {
    if (
      repositoryMigrationTargets.some((repository) => (
        typeof repository !== "string" || !repository || repository !== repository.trim()
      ))
      || new Set(repositoryMigrationTargets.map((repository) => repository.toLowerCase())).size
        !== repositoryMigrationTargets.length
    ) {
      throw new Error("Repository migration targets are invalid or duplicated");
    }
    const migrations = validateRegistryRepositoryMigrations(registry);
    const requested = new Set(repositoryMigrationTargets.map((repository) => repository.toLowerCase()));
    const selectedMigrations = migrations.filter((migration) => (
      requested.has(migration.fromRepository.toLowerCase())
    ));
    if (selectedMigrations.length !== requested.size) {
      throw new Error("Repository migration target evidence is incomplete");
    }
    const sourceByRepository = new Map(sources.map((source) => [
      parseGitHubRepository(source.repo).slug.toLowerCase(),
      source,
    ]));
    const refreshSources = selectedMigrations.map((migration) => {
      const source = sourceByRepository.get(migration.toRepository.toLowerCase());
      if (!source) throw new Error("Repository migration source is missing");
      return source;
    });
    return {
      incremental: true,
      migration: true,
      approvedSource: null,
      migrations: selectedMigrations,
      refreshSources,
      repeatedMigrationSources: repeatedRepositoryMigrationSources(migrations),
    };
  }
  if (!approvedRepository) {
    return {
      incremental: false,
      migration: false,
      approvedSource: null,
      migrations: [],
      refreshSources: sources,
    };
  }
  const approvedRepositoryKey = approvedRepository.toLowerCase();
  const approvedSource = sources.find((source) => (
    parseGitHubRepository(source.repo).slug.toLowerCase() === approvedRepositoryKey
  ));
  if (!approvedSource) {
    throw new Error(`Approved repository ${approvedRepository} is not registered`);
  }
  return {
    incremental: true,
    migration: false,
    approvedSource,
    migrations: [],
    refreshSources: [approvedSource],
  };
}

function repositoryUrlFromSlug(slug) {
  return `https://github.com/${slug}`;
}

function repeatedRepositoryMigrationSources(migrations) {
  const priorTargets = new Set();
  const repeatedSources = new Set();
  for (const migration of migrations) {
    const from = migration.fromRepository.toLowerCase();
    if (priorTargets.has(from)) repeatedSources.add(from);
    priorTargets.add(migration.toRepository.toLowerCase());
  }
  return repeatedSources;
}

export function assertRepositoryMigrationPreviousState(sourcePlan, previous) {
  if (!sourcePlan.migration) return new Map();
  const plugins = previous?.plugins || [];
  const warnings = previous?.warnings || [];
  const byCurrentRepository = new Map();
  for (const migration of sourcePlan.migrations) {
    const source = sourcePlan.refreshSources.find((candidate) => (
      parseGitHubRepository(candidate.repo).slug.toLowerCase()
        === migration.toRepository.toLowerCase()
    ));
    if (!source) throw new Error("Repository migration source plan is incomplete");
    const expectedIds = sourceRepositoryPluginIds(source);
    if (JSON.stringify(expectedIds) !== JSON.stringify(migration.pluginIds)) {
      throw new Error("Repository migration plugin set changed after evidence capture");
    }
    const oldRepository = repositoryUrlFromSlug(migration.fromRepository);
    const previousPlugins = plugins.filter((plugin) => migration.pluginIds.includes(plugin.id));
    if (
      previousPlugins.length !== migration.pluginIds.length
      || previousPlugins.some((plugin) => plugin.repo.toLowerCase() !== oldRepository.toLowerCase())
      || previousPlugins.some((plugin) => (
        String(plugin.upstreamValidatedCommit || "").toLowerCase()
          !== migration.previousValidatedCommit
      ))
    ) {
      throw new Error("Repository migration previous catalog state is ambiguous");
    }
    const warning = `${oldRepository}: repository-unreachable`;
    const warningCount = warnings.filter((value) => value === warning).length;
    const repeatedIdentityTransfer = sourcePlan.repeatedMigrationSources.has(
      migration.fromRepository.toLowerCase(),
    );
    if (warningCount !== 1 && !(repeatedIdentityTransfer && warningCount === 0)) {
      throw new Error("Repository migration warning state is ambiguous");
    }
    byCurrentRepository.set(
      parseGitHubRepository(source.repo).slug.toLowerCase(),
      Object.freeze({ migration, previousPlugins: Object.freeze(previousPlugins) }),
    );
  }
  return byCurrentRepository;
}

export async function assertFullRefreshRestBudget(requiredTreeRequests, options = {}) {
  const reserve = options.reserve ?? catalogRefreshRestBudgetReserve;
  if (
    !Number.isSafeInteger(requiredTreeRequests)
    || requiredTreeRequests < 0
    || !Number.isSafeInteger(reserve)
    || reserve < 0
  ) {
    throw new CatalogBuildError("internal-error", "Catalog refresh REST budget requirement is invalid");
  }
  if (!requiredTreeRequests) return Object.freeze({ limit: 0, remaining: 0, resetAt: "" });
  const rateLimit = await githubApi("/rate_limit");
  const core = rateLimit?.resources?.core;
  const limit = Number(core?.limit);
  const remaining = Number(core?.remaining);
  const reset = Number(core?.reset);
  const resetMilliseconds = reset * 1000;
  const resetAt = Number.isSafeInteger(reset)
    && reset > 0
    && Number.isSafeInteger(resetMilliseconds)
    && resetMilliseconds <= 8_640_000_000_000_000
    ? new Date(resetMilliseconds).toISOString()
    : "";
  if (
    !Number.isSafeInteger(limit)
    || limit < 1
    || !Number.isSafeInteger(remaining)
    || remaining < 0
    || remaining > limit
    || !resetAt
  ) {
    throw new CatalogBuildError(
      "api-budget-insufficient",
      "GitHub REST core budget metadata is missing or invalid",
    );
  }
  const required = requiredTreeRequests + reserve;
  if (remaining < required) {
    throw new CatalogBuildError(
      "api-budget-insufficient",
      `GitHub REST core budget is insufficient for catalog trees (remaining ${remaining}, trees ${requiredTreeRequests}, reserve ${reserve}, resetAt ${resetAt})`,
    );
  }
  console.log(
    `Catalog refresh REST plan: ${requiredTreeRequests} trees, ${remaining} remaining, ${reserve} reserved.`,
  );
  return Object.freeze({ limit, remaining, resetAt });
}

async function buildCatalogInternal(options = {}) {
  const activeRegistryPath = options.registryPath || registryPath;
  const activeCatalogPath = options.catalogPath || catalogPath;
  const activePreviewDirectory = options.previewDirectory || previewDirectory;
  const activePreviewParent = dirname(activePreviewDirectory);
  const registry = JSON.parse(await readFile(activeRegistryPath, "utf8"));
  validateRegistryRepositoryMigrations(registry);
  const approvedRepository = options.approvedRepository
    ?? process.env.MARKETPLACE_APPROVED_REPOSITORY
    ?? "";
  const approvedCommit = options.approvedCommit
    ?? process.env.MARKETPLACE_APPROVED_COMMIT
    ?? "";
  const repositoryMigrationTargets = options.repositoryMigrationTargets || [];
  if (Boolean(approvedRepository) !== Boolean(approvedCommit)) {
    throw new Error("Approved repository and commit must be supplied together");
  }
  if (approvedCommit && !/^[a-f0-9]{40}$/i.test(approvedCommit)) {
    throw new Error("Approved commit must be a full commit SHA");
  }
  let approvedSnapshotUsed = false;
  const migrationSourcesUsed = new Set();
  const sourcePlan = catalogSourcePlan(
    registry,
    approvedRepository,
    repositoryMigrationTargets,
  );
  const refreshSourceRepositories = new Set(sourcePlan.refreshSources.map((source) => source.repo));
  const previous = JSON.parse(await readFile(activeCatalogPath, "utf8"));
  const migrationPreviousState = assertRepositoryMigrationPreviousState(sourcePlan, previous);
  const previousPlugins = previous.plugins || [];
  const previousById = new Map(previousPlugins.map((plugin) => [plugin.id, plugin]));
  const plugins = [];
  const migrationWarnings = new Set(sourcePlan.migrations.map((migration) => (
    `${repositoryUrlFromSlug(migration.fromRepository)}: repository-unreachable`
  )));
  const warnings = sourcePlan.approvedSource
    ? (previous.warnings || []).filter((warning) => !warning.startsWith(`${sourcePlan.approvedSource.repo}:`))
    : sourcePlan.migration
      ? (previous.warnings || []).filter((warning) => !migrationWarnings.has(warning))
      : [];
  const checkedAt = new Date().toISOString();
  let fullRefreshIdentities = null;
  let migrationIdentities = null;
  if (!sourcePlan.incremental) {
    const identitySources = [
      ...(registry.sources || []),
      ...(registry.builtInSources || []),
    ];
    fullRefreshIdentities = await resolveFullRefreshIdentities(identitySources, {
      ...(options.graphqlBatchSize ? { batchSize: options.graphqlBatchSize } : {}),
      ...(options.graphqlBudgetReserve !== undefined
        ? { budgetReserve: options.graphqlBudgetReserve }
        : {}),
    });
    const requiredCommunityTrees = (registry.sources || []).filter((source) => {
      const key = parseGitHubRepository(source.repo).slug.toLowerCase();
      const identity = fullRefreshIdentities.get(key);
      if (!identity) {
        throw new CatalogBuildError(
          "github-graphql-invalid",
          "Catalog refresh identity map is incomplete",
        );
      }
      return identity.context
        && !canReuseFullRefreshSource(source, identity.context, previousPlugins);
    }).length;
    const requiredBuiltInTrees = (registry.builtInSources || []).filter((source) => {
      const key = parseGitHubRepository(source.repo).slug.toLowerCase();
      const identity = fullRefreshIdentities.get(key);
      if (!identity) {
        throw new CatalogBuildError(
          "github-graphql-invalid",
          "Built-in refresh identity map is incomplete",
        );
      }
      return Boolean(identity.context);
    }).length;
    await assertFullRefreshRestBudget(
      requiredCommunityTrees + requiredBuiltInTrees,
      options.restBudgetReserve === undefined ? {} : { reserve: options.restBudgetReserve },
    );
  } else if (sourcePlan.migration) {
    migrationIdentities = await resolveFullRefreshIdentities(sourcePlan.refreshSources, {
      ...(options.graphqlBatchSize ? { batchSize: options.graphqlBatchSize } : {}),
      ...(options.graphqlBudgetReserve !== undefined
        ? { budgetReserve: options.graphqlBudgetReserve }
        : {}),
    });
    for (const source of sourcePlan.refreshSources) {
      const key = parseGitHubRepository(source.repo).slug.toLowerCase();
      const identity = migrationIdentities.get(key);
      const migration = migrationPreviousState.get(key)?.migration;
      if (!identity || identity.error || !identity.context || !migration) {
        throw identity?.error || new Error("Repository migration identity is unavailable");
      }
      if (
        identity.context.commitSha !== migration.observedHeadCommit
        || identity.context.branch !== migration.observedBranch
      ) {
        throw new Error("Repository migration HEAD changed after evidence capture");
      }
    }
    await assertFullRefreshRestBudget(
      sourcePlan.refreshSources.length,
      options.restBudgetReserve === undefined ? {} : { reserve: options.restBudgetReserve },
    );
  }
  await mkdir(activePreviewParent, { recursive: true });
  const stageDirectory = await mkdtemp(resolve(activePreviewParent, ".plugins-stage-"));
  await seedPreviewStage(stageDirectory, activePreviewDirectory);

  try {
    for (const source of registry.sources || []) {
      const migrateThisSource = sourcePlan.migration && refreshSourceRepositories.has(source.repo);
      const pinThisSource = sourcePlan.incremental
        && !sourcePlan.migration
        && refreshSourceRepositories.has(source.repo);
      if (sourcePlan.incremental && !pinThisSource && !migrateThisSource) {
        const preserved = previousPlugins.filter((plugin) => (
          !plugin.builtIn
          && !plugin.placeholder
          && plugin.repo === source.repo
        ));
        if (!preserved.length) {
          throw new Error(`${source.repo}: incremental build has no previous catalog state`);
        }
        plugins.push(...preserved);
        continue;
      }
      let context;
      try {
        if (migrateThisSource) {
          const identityKey = parseGitHubRepository(source.repo).slug.toLowerCase();
          const identity = migrationIdentities?.get(identityKey);
          if (!identity?.context) {
            throw new Error("Repository migration source identity is missing");
          }
          context = await resolveSnapshotTree(identity.context);
        } else if (pinThisSource) {
          context = await resolveSnapshot({ ...source, snapshotCommit: approvedCommit });
        } else {
          const identityKey = parseGitHubRepository(source.repo).slug.toLowerCase();
          const identity = fullRefreshIdentities?.get(identityKey);
          if (!identity) {
            throw new CatalogBuildError(
              "github-graphql-invalid",
              "Catalog refresh source identity is missing",
            );
          }
          if (identity.error) throw identity.error;
          const reused = reusableFullRefreshPlugins(
            source,
            identity.context,
            previousPlugins,
            checkedAt,
          );
          if (reused) {
            plugins.push(...reused);
            continue;
          }
          context = identity.context;
          context = await resolveSnapshotTree(context);
        }
        if (pinThisSource) {
          if (
            source.listingValidatedCommit !== approvedCommit
            || source.automatedSecurityBaseline?.commit !== approvedCommit
            || context.commitSha.toLowerCase() !== approvedCommit.toLowerCase()
          ) {
            throw new Error(`${source.repo}: approved snapshot commit mismatch`);
          }
        }
        context.repositoryRelease = await repositoryReleaseForRefresh(
          context,
          source,
          previousPlugins,
          sourcePlan.incremental,
        );
        validateRepositoryDocs(context);
        const discovered = await validateBeforeStagingPreview({
          loadPreview: () => loadSnapshotPreview(source, context),
          validateSource: (preview) => (
            source.type === "suite"
              ? [suitePlugin(source, context, preview)]
              : source.type === "plugin-source"
                ? discoveredPlugins(source, context, preview)
                : checkError("unsupported-repository-layout", `${source.repo}: unsupported source type`)
          ),
          stagePreview: (snapshot) => stageSnapshotPreview(snapshot, stageDirectory),
        });
        plugins.push(...discovered.map((plugin) => successfulState(
          plugin,
          source,
          context,
          previousById.get(plugin.id),
          checkedAt,
        )));
        if (pinThisSource) approvedSnapshotUsed = true;
        if (migrateThisSource) {
          migrationSourcesUsed.add(parseGitHubRepository(source.repo).slug.toLowerCase());
        }
      } catch (error) {
        if (pinThisSource || migrateThisSource) throw error;
        assertRecoverableCatalogError(error);
        const preserved = failedSourcePlugins(source, previousPlugins, context, checkedAt, error);
        plugins.push(...preserved);
        const code = catalogErrorCode(error);
        warnings.push(`${source.repo}: ${code}`);
        console.error(catalogRefreshFailureMessage(source.repo, error));
      }
    }

    if (approvedRepository && !approvedSnapshotUsed) {
      throw new Error(`Approved repository ${approvedRepository} was not built`);
    }
    if (sourcePlan.migration && migrationSourcesUsed.size !== sourcePlan.refreshSources.length) {
      throw new Error("Repository migration did not build every requested source");
    }

    if (sourcePlan.incremental) {
      const preservedBuiltIns = previousPlugins.filter((plugin) => plugin.builtIn);
      if ((registry.builtInSources || []).length && !preservedBuiltIns.length) {
        throw new Error("Incremental build has no previous built-in catalog state");
      }
      plugins.push(...preservedBuiltIns);
    } else {
      for (const source of registry.builtInSources || []) {
        try {
          const identityKey = parseGitHubRepository(source.repo).slug.toLowerCase();
          const identity = fullRefreshIdentities?.get(identityKey);
          if (!identity) {
            throw new CatalogBuildError(
              "github-graphql-invalid",
              "Built-in catalog refresh identity is missing",
            );
          }
          if (identity.error) throw identity.error;
          const context = await resolveSnapshotTree(identity.context);
          plugins.push(...await discoveredBuiltIns(source, context));
        } catch (error) {
          assertRecoverableCatalogError(error);
          const preserved = previousPlugins.filter(
            (plugin) => plugin.builtIn && plugin.repo === source.repo,
          );
          if (!preserved.length) throw error;
          plugins.push(...preserved);
          warnings.push(`${source.repo}: built-in catalog refresh unavailable`);
          console.error(catalogRefreshFailureMessage(source.repo, error, { builtIn: true }));
        }
      }
    }

    for (const placeholder of registry.placeholders || []) {
      plugins.push({
        ...placeholder,
        sourceType: "community",
        placeholder: true,
        verificationStatus: "unverified",
      });
      const warning = `${placeholder.name} is intentionally displayed as a placeholder.`;
      if (!warnings.includes(warning)) warnings.push(warning);
    }

    if (new Set(plugins.map((plugin) => plugin.id)).size !== plugins.length) {
      throw new Error("Catalog contains duplicate plugin IDs");
    }
    await prunePreviewStage(stageDirectory, plugins);
    const projectedCatalog = projectCatalogVerification(registry, { plugins });
    const nextContent = {
      stateSchemaVersion: 2,
      mode: "production",
      plugins: projectedCatalog.plugins,
      warnings,
    };
    const previousContent = {
      stateSchemaVersion: previous.stateSchemaVersion,
      mode: previous.mode,
      plugins: previous.plugins,
      warnings: previous.warnings,
    };
    const changed = JSON.stringify(nextContent) !== JSON.stringify(previousContent);
    const next = {
      generatedAt: changed ? checkedAt : previous.generatedAt,
      ...nextContent,
    };
    const serialized = `${JSON.stringify(next, null, 2)}\n`;
    await commitGeneratedFiles(stageDirectory, serialized, {
      catalogPath: activeCatalogPath,
      previewDirectory: activePreviewDirectory,
    });
    console.log(
      `${changed ? "Updated" : "Validated"} ${plugins.length} plugins from ${
        (registry.sources || []).length + (registry.builtInSources || []).length
      } registered sources (${
        sourcePlan.migration
          ? `${sourcePlan.refreshSources.length} repository migrations refreshed`
          : approvedRepository
            ? "1 source refreshed"
            : "full refresh"
      }).`,
    );
  } catch (error) {
    await rm(stageDirectory, { recursive: true, force: true });
    throw error;
  }
}

export async function buildCatalog(options = {}) {
  resetCatalogApiUsage();
  try {
    return await buildCatalogInternal(options);
  } finally {
    console.log(catalogApiUsageSummary());
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  buildCatalog().catch((error) => {
    console.error(`Catalog build failed [${catalogErrorCode(error, "internal-error")}].`);
    if (error instanceof CatalogBuildError) console.error(error.publicMessage);
    process.exitCode = 1;
  });
}
