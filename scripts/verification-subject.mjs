import { isCommunityCatalogEntry } from "./catalog-verification.mjs";
import { githubRepositoryKey } from "./github-repository.mjs";
import { parseRepositoryIdentity } from "./repository-identity.mjs";

const fullCommitPattern = /^[a-f0-9]{40}$/i;

export class VerificationSubjectError extends Error {
  constructor(code, message, context = {}) {
    super(message);
    this.name = "VerificationSubjectError";
    this.code = code;
    this.context = Object.freeze({ ...context });
  }
}

function sourceContainsPlugin(source, pluginId) {
  return Object.hasOwn(source?.plugins || {}, pluginId) || source?.catalog?.id === pluginId;
}

export function canonicalRepositoryRequest(registry, request) {
  const matches = (registry?.sources || []).filter((source) => (
    sourceContainsPlugin(source, request?.pluginId)
  ));
  if (matches.length !== 1) return request;
  const [source] = matches;
  let canonicalRepository;
  let identity;
  try {
    canonicalRepository = githubRepositoryKey(source.repo);
    identity = parseRepositoryIdentity(source.repositoryIdentity);
  } catch {
    return request;
  }
  if (!identity || request.repository === canonicalRepository) return request;
  const formerRepositories = new Set(identity.previousRepositories.map((repository) => (
    repository.toLowerCase()
  )));
  if (!formerRepositories.has(request.repository)) return request;
  return Object.freeze({ ...request, repository: canonicalRepository, repoUrl: source.repo });
}

export function resolveConfiguredSource(registry, request) {
  const matches = (registry?.sources || []).filter((source) => (
    sourceContainsPlugin(source, request.pluginId)
  ));
  if (matches.length !== 1) {
    throw new VerificationSubjectError(
      "verification-plugin-not-listed",
      "Plugin ID does not identify one existing community listing",
      { pluginId: request.pluginId },
    );
  }
  const source = matches[0];
  if (source.type !== "plugin-source") {
    throw new VerificationSubjectError(
      "verification-source-unsupported",
      "Automated verification currently supports plugin-source listings only",
      { pluginId: request.pluginId, sourceType: source.type || "unknown" },
    );
  }
  if (githubRepositoryKey(source.repo) !== request.repository) {
    throw new VerificationSubjectError(
      "verification-repository-mismatch",
      "Repository does not match the existing listing",
      { pluginId: request.pluginId },
    );
  }
  return source;
}

export function resolveListedSource(registry, request) {
  const source = resolveConfiguredSource(registry, request);
  if (
    !fullCommitPattern.test(source.listingValidatedCommit || "")
    || source.listingValidatedCommit.toLowerCase() !== request.commitSha
  ) {
    throw new VerificationSubjectError(
      "verification-commit-mismatch",
      "Commit does not match the existing listed commit",
      { pluginId: request.pluginId },
    );
  }
  return source;
}

export function resolveVerificationSubject(registry, catalog, request) {
  const source = resolveListedSource(registry, request);
  const repository = githubRepositoryKey(source.repo);
  const pluginIds = Object.keys(source.plugins || {}).sort();
  if (!pluginIds.length || !pluginIds.includes(request.pluginId)) {
    throw new VerificationSubjectError(
      "verification-plugin-not-listed",
      "Plugin ID does not identify a configured plugin-source listing",
      { pluginId: request.pluginId },
    );
  }
  const listedPlugins = pluginIds.map((pluginId) => {
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
      throw new VerificationSubjectError(
        "verification-catalog-listing-missing",
        "A configured plugin is missing from the generated catalog",
        { pluginId },
      );
    }
    const immutablePath = source.plugins?.[pluginId]?.manifestPath;
    const catalogHint = matches[0].manifestPath;
    const manifestPathHint = [immutablePath, catalogHint].find((path) => (
      /^(?:[^/]+\/)?manifest\.json$/i.test(path || "")
    )) || "";
    return Object.freeze({ pluginId, manifestPathHint });
  });
  return Object.freeze({
    type: "plugin-source",
    repository,
    commitSha: request.commitSha,
    requestedPluginId: request.pluginId,
    pluginIds: Object.freeze(pluginIds),
    listedPlugins: Object.freeze(listedPlugins),
    source,
  });
}
