import {
  allowedCategories,
  allowedTags,
  maximumSubmissionTags,
} from "../scripts/submission.mjs";
import { parseGitHubRepository } from "../scripts/github-repository.mjs";
import { normalizeSearchTerm } from "../site/assets/js/search.js";
import { MarketplaceMcpError } from "./errors.mjs";
import { fullCommitPattern, pluginIdPattern } from "./identifiers.mjs";

const toolAnnotations = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

const taxonomyProperties = Object.freeze({
  category: { type: "string", enum: allowedCategories },
  tags: {
    type: "array",
    items: { type: "string", enum: allowedTags },
    maxItems: maximumSubmissionTags,
    uniqueItems: true,
  },
});

export const toolDefinitions = Object.freeze([
  {
    name: "search_plugins",
    title: "Search marketplace plugins",
    description: "Search the current marketplace catalog by title, ID, description, author, category, tags, kind, verification state, and install availability.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", maxLength: 160 },
        ...taxonomyProperties,
        kind: { type: "string", maxLength: 64 },
        verificationStatus: { type: "string", enum: ["verified", "unverified"] },
        installAvailable: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 25, default: 10 },
      },
    },
    annotations: toolAnnotations,
  },
  {
    name: "get_plugin",
    title: "Get plugin details",
    description: "Return the complete public catalog record for one exact marketplace plugin ID, including install, verification, source, and preview metadata.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { pluginId: { type: "string", pattern: pluginIdPattern.source, maxLength: 128 } },
      required: ["pluginId"],
    },
    annotations: toolAnnotations,
  },
  {
    name: "find_similar_plugins",
    title: "Find duplicate or related plugins",
    description: "Check exact repository and plugin-ID conflicts, then rank advisory catalog similarities by title, description, taxonomy, and author.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        repository: { type: "string", format: "uri", maxLength: 300 },
        repositoryNodeId: { type: "string", maxLength: 200 },
        repositoryDatabaseId: { type: "integer", minimum: 1 },
        id: { type: "string", pattern: pluginIdPattern.source, maxLength: 128 },
        name: { type: "string", maxLength: 120 },
        description: { type: "string", maxLength: 500 },
        author: { type: "string", maxLength: 120 },
        ...taxonomyProperties,
        kind: { type: "string", maxLength: 64 },
        limit: { type: "integer", minimum: 1, maximum: 25, default: 8 },
      },
      anyOf: [
        { required: ["repository"] },
        { required: ["id"] },
        { required: ["name"] },
        { required: ["description"] },
      ],
    },
    annotations: toolAnnotations,
  },
  {
    name: "review_candidate",
    title: "Review a plugin candidate",
    description: "Inspect a public GitHub plugin repository at an exact resolved commit, validate metadata and documentation, and compare it with existing listings. Does not execute code or provide a security verdict.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        repository: { type: "string", format: "uri", maxLength: 300 },
        commit: { type: "string", pattern: fullCommitPattern.source },
        submissionTitle: { type: "string", maxLength: 160 },
        ...taxonomyProperties,
        similarityLimit: { type: "integer", minimum: 1, maximum: 25, default: 8 },
      },
      required: ["repository"],
    },
    annotations: { ...toolAnnotations, openWorldHint: true },
  },
  {
    name: "get_preview",
    title: "Get a plugin preview image",
    description: "Return an existing marketplace preview or an exact-commit candidate preview as MCP image content for visual inspection.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        pluginId: { type: "string", pattern: pluginIdPattern.source, maxLength: 128 },
        repository: { type: "string", format: "uri", maxLength: 300 },
        commit: { type: "string", pattern: fullCommitPattern.source },
      },
      oneOf: [
        { required: ["pluginId"] },
        { required: ["repository", "commit"] },
      ],
    },
    annotations: { ...toolAnnotations, openWorldHint: true },
  },
]);

function objectArguments(value, allowedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MarketplaceMcpError("invalid-arguments", "Tool arguments must be a JSON object.");
  }
  const unexpected = Object.keys(value).find((key) => !allowedKeys.includes(key));
  if (unexpected) {
    throw new MarketplaceMcpError("invalid-arguments", `Unexpected tool argument "${unexpected}".`);
  }
  return value;
}

function optionalString(value, field, maximum, { required = false } = {}) {
  if (value === undefined && !required) return "";
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new MarketplaceMcpError("invalid-arguments", `${field} must be a non-empty string up to ${maximum} characters.`);
  }
  return normalizeSearchTerm(value);
}

function optionalRepository(value, { required = false } = {}) {
  const repository = optionalString(value, "repository", 300, { required });
  if (!repository) return "";
  try {
    const parsed = parseGitHubRepository(repository);
    return `https://github.com/${parsed.slug}`;
  } catch {
    throw new MarketplaceMcpError(
      "invalid-arguments",
      "repository must be a public HTTPS GitHub repository root URL.",
    );
  }
}

function optionalEnum(value, field, allowed) {
  if (value === undefined) return "";
  if (!allowed.includes(value)) {
    throw new MarketplaceMcpError("invalid-arguments", `${field} must use a supported marketplace value.`);
  }
  return value;
}

function optionalTags(value) {
  if (value === undefined) return [];
  if (
    !Array.isArray(value)
    || value.length > maximumSubmissionTags
    || new Set(value).size !== value.length
    || value.some((tag) => !allowedTags.includes(tag))
  ) {
    throw new MarketplaceMcpError(
      "invalid-arguments",
      `tags must contain up to ${maximumSubmissionTags} unique marketplace tags.`,
    );
  }
  return value;
}

function boundedLimit(value, fallback, field = "limit") {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > 25) {
    throw new MarketplaceMcpError("invalid-arguments", `${field} must be an integer from 1 through 25.`);
  }
  return value;
}

export function parseSearchArguments(value) {
  const args = objectArguments(value, [
    "query", "category", "tags", "kind", "verificationStatus", "installAvailable", "limit",
  ]);
  if (args.installAvailable !== undefined && typeof args.installAvailable !== "boolean") {
    throw new MarketplaceMcpError("invalid-arguments", "installAvailable must be a boolean.");
  }
  return {
    query: args.query === undefined ? "" : optionalString(args.query, "query", 160),
    category: optionalEnum(args.category, "category", allowedCategories),
    tags: optionalTags(args.tags),
    kind: optionalString(args.kind, "kind", 64),
    verificationStatus: optionalEnum(
      args.verificationStatus,
      "verificationStatus",
      ["verified", "unverified"],
    ),
    installAvailable: args.installAvailable,
    limit: boundedLimit(args.limit, 10),
  };
}

export function parsePluginArguments(value) {
  const args = objectArguments(value, ["pluginId"]);
  const pluginId = optionalString(args.pluginId, "pluginId", 128, { required: true });
  if (!pluginIdPattern.test(pluginId)) {
    throw new MarketplaceMcpError("invalid-arguments", "pluginId is not a valid marketplace plugin ID.");
  }
  return { pluginId };
}

export function parseSimilarityArguments(value) {
  const args = objectArguments(value, [
    "repository", "repositoryNodeId", "repositoryDatabaseId", "id", "name", "description",
    "author", "category", "tags", "kind", "limit",
  ]);
  const candidate = {
    repository: optionalRepository(args.repository),
    repositoryNodeId: optionalString(args.repositoryNodeId, "repositoryNodeId", 200),
    repositoryDatabaseId: args.repositoryDatabaseId,
    id: optionalString(args.id, "id", 128),
    name: optionalString(args.name, "name", 120),
    description: optionalString(args.description, "description", 500),
    author: optionalString(args.author, "author", 120),
    category: optionalEnum(args.category, "category", allowedCategories),
    tags: optionalTags(args.tags),
    kind: optionalString(args.kind, "kind", 64),
  };
  if (candidate.id && !pluginIdPattern.test(candidate.id)) {
    throw new MarketplaceMcpError("invalid-arguments", "id is not a valid marketplace plugin ID.");
  }
  if (
    candidate.repositoryDatabaseId !== undefined
    && (!Number.isSafeInteger(candidate.repositoryDatabaseId) || candidate.repositoryDatabaseId < 1)
  ) {
    throw new MarketplaceMcpError("invalid-arguments", "repositoryDatabaseId must be a positive integer.");
  }
  if (!candidate.repository && !candidate.id && !candidate.name && !candidate.description) {
    throw new MarketplaceMcpError("invalid-arguments", "Provide a repository, plugin ID, name, or description.");
  }
  return { candidate, limit: boundedLimit(args.limit, 8) };
}

export function parseReviewArguments(value) {
  const args = objectArguments(value, [
    "repository", "commit", "submissionTitle", "category", "tags", "similarityLimit",
  ]);
  const commit = optionalString(args.commit, "commit", 40);
  if (commit && !fullCommitPattern.test(commit)) {
    throw new MarketplaceMcpError("invalid-arguments", "commit must be a full 40-character SHA.");
  }
  return {
    repository: optionalRepository(args.repository, { required: true }),
    commit,
    submissionTitle: optionalString(args.submissionTitle, "submissionTitle", 160),
    category: optionalEnum(args.category, "category", allowedCategories),
    tags: optionalTags(args.tags),
    similarityLimit: boundedLimit(args.similarityLimit, 8, "similarityLimit"),
  };
}

export function parsePreviewArguments(value) {
  const args = objectArguments(value, ["pluginId", "repository", "commit"]);
  const pluginId = optionalString(args.pluginId, "pluginId", 128);
  const repository = optionalRepository(args.repository);
  const commit = optionalString(args.commit, "commit", 40);
  if (pluginId && (repository || commit)) {
    throw new MarketplaceMcpError("invalid-arguments", "Use either pluginId or repository with commit, not both.");
  }
  if (pluginId) {
    if (!pluginIdPattern.test(pluginId)) {
      throw new MarketplaceMcpError("invalid-arguments", "pluginId is not a valid marketplace plugin ID.");
    }
    return { pluginId, repository: "", commit: "" };
  }
  if (!repository || !fullCommitPattern.test(commit)) {
    throw new MarketplaceMcpError(
      "invalid-arguments",
      "Candidate previews require repository and a full 40-character commit SHA.",
    );
  }
  return { pluginId: "", repository, commit };
}
