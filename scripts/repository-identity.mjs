import { githubRepositoryKey, parseGitHubRepository } from "./github-repository.mjs";

export const repositoryIdentitySchemaVersion = 1;
export const repositoryMigrationSchemaVersion = 1;

const fullCommitPattern = /^[a-f0-9]{40}$/;
const nodeIdPattern = /^R_[A-Za-z0-9_-]{1,126}$/;
const pluginIdPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/;

function exactKeys(value, expected) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function normalizedTimestamp(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return "";
  return new Date(value).toISOString() === value ? value : "";
}

function normalizedSlug(value) {
  if (typeof value !== "string" || !value || value !== value.trim()) return "";
  try {
    const parsed = parseGitHubRepository(`https://github.com/${value}`);
    return parsed.slug;
  } catch {
    return "";
  }
}

function normalizedPluginIds(value) {
  if (
    !Array.isArray(value)
    || !value.length
    || value.some((id) => typeof id !== "string" || !pluginIdPattern.test(id))
    || new Set(value).size !== value.length
  ) return null;
  return [...value].sort();
}

export function sourceRepositoryPluginIds(source) {
  if (source?.type === "suite") {
    return source.catalog?.id ? [source.catalog.id] : [];
  }
  return Object.keys(source?.plugins || {}).sort();
}

export function parseRepositoryIdentity(value) {
  if (value === undefined) return null;
  if (!exactKeys(value, ["schemaVersion", "nodeId", "databaseId", "previousRepositories"])) {
    throw new Error("Repository identity has invalid fields");
  }
  if (
    value.schemaVersion !== repositoryIdentitySchemaVersion
    || typeof value.nodeId !== "string"
    || !nodeIdPattern.test(value.nodeId)
    || !Number.isSafeInteger(value.databaseId)
    || value.databaseId < 1
    || !Array.isArray(value.previousRepositories)
    || value.previousRepositories.some((entry) => !normalizedSlug(entry))
    || new Set(value.previousRepositories.map((entry) => entry.toLowerCase())).size
      !== value.previousRepositories.length
  ) {
    throw new Error("Repository identity is invalid");
  }
  return Object.freeze({
    schemaVersion: repositoryIdentitySchemaVersion,
    nodeId: value.nodeId,
    databaseId: value.databaseId,
    previousRepositories: Object.freeze([...value.previousRepositories]),
  });
}

export function parseRepositoryMigration(value) {
  const keys = [
    "schemaVersion",
    "fromRepository",
    "toRepository",
    "nodeId",
    "databaseId",
    "pluginIds",
    "listedCommit",
    "previousValidatedCommit",
    "observedHeadCommit",
    "observedBranch",
    "observedAt",
  ];
  if (!exactKeys(value, keys)) throw new Error("Repository migration has invalid fields");
  const fromRepository = normalizedSlug(value.fromRepository);
  const toRepository = normalizedSlug(value.toRepository);
  const pluginIds = normalizedPluginIds(value.pluginIds);
  if (
    value.schemaVersion !== repositoryMigrationSchemaVersion
    || !fromRepository
    || !toRepository
    || fromRepository.toLowerCase() === toRepository.toLowerCase()
    || typeof value.nodeId !== "string"
    || !nodeIdPattern.test(value.nodeId)
    || !Number.isSafeInteger(value.databaseId)
    || value.databaseId < 1
    || !pluginIds
    || typeof value.listedCommit !== "string"
    || !fullCommitPattern.test(value.listedCommit)
    || typeof value.previousValidatedCommit !== "string"
    || !fullCommitPattern.test(value.previousValidatedCommit)
    || typeof value.observedHeadCommit !== "string"
    || !fullCommitPattern.test(value.observedHeadCommit)
    || typeof value.observedBranch !== "string"
    || !value.observedBranch
    || value.observedBranch.length > 255
    || /[\u0000-\u001f\u007f]/u.test(value.observedBranch)
    || !normalizedTimestamp(value.observedAt)
  ) {
    throw new Error("Repository migration is invalid");
  }
  return Object.freeze({
    schemaVersion: repositoryMigrationSchemaVersion,
    fromRepository,
    toRepository,
    nodeId: value.nodeId,
    databaseId: value.databaseId,
    pluginIds: Object.freeze(pluginIds),
    listedCommit: value.listedCommit,
    previousValidatedCommit: value.previousValidatedCommit,
    observedHeadCommit: value.observedHeadCommit,
    observedBranch: value.observedBranch,
    observedAt: value.observedAt,
  });
}

export function repositoryEvidenceKeys(source) {
  const current = githubRepositoryKey(source?.repo);
  const identity = parseRepositoryIdentity(source?.repositoryIdentity);
  if (!identity) return Object.freeze([current]);
  const previous = identity.previousRepositories.map((repository) => (
    githubRepositoryKey(`https://github.com/${repository}`)
  ));
  return Object.freeze([...new Set([current, ...previous])]);
}

export function assertObservedRepositoryIdentity(source, observed) {
  const identity = parseRepositoryIdentity(source?.repositoryIdentity);
  if (!identity) return;
  const expectedName = parseGitHubRepository(source.repo).slug.toLowerCase();
  if (
    !observed
    || observed.nodeId !== identity.nodeId
    || observed.databaseId !== identity.databaseId
    || typeof observed.nameWithOwner !== "string"
    || observed.nameWithOwner.toLowerCase() !== expectedName
  ) {
    throw new Error(`Immutable repository identity mismatch for ${source.repo}`);
  }
}

export function validateRegistryRepositoryMigrations(registry) {
  const migrationsValue = registry?.repositoryMigrations;
  if (migrationsValue === undefined) {
    for (const source of registry?.sources || []) {
      if (parseRepositoryIdentity(source.repositoryIdentity)) {
        throw new Error("Repository identity requires global migration evidence");
      }
    }
    return Object.freeze([]);
  }
  if (!Array.isArray(migrationsValue)) throw new Error("Registry repository migrations must be an array");
  const migrations = migrationsValue.map(parseRepositoryMigration);
  const sources = registry?.sources || [];
  const sourceByRepository = new Map();
  for (const source of sources) {
    const key = githubRepositoryKey(source.repo);
    if (sourceByRepository.has(key)) throw new Error("Registry contains duplicate repository sources");
    sourceByRepository.set(key, source);
    parseRepositoryIdentity(source.repositoryIdentity);
  }

  const groups = new Map();
  const repositoryIdentities = new Map();
  const databaseIdByNodeId = new Map();
  const nodeIdByDatabaseId = new Map();
  migrations.forEach((migration, index) => {
    const knownDatabaseId = databaseIdByNodeId.get(migration.nodeId);
    const knownNodeId = nodeIdByDatabaseId.get(migration.databaseId);
    if (
      (knownDatabaseId !== undefined && knownDatabaseId !== migration.databaseId)
      || (knownNodeId !== undefined && knownNodeId !== migration.nodeId)
    ) {
      throw new Error("Repository migration immutable IDs are not globally bijective");
    }
    databaseIdByNodeId.set(migration.nodeId, migration.databaseId);
    nodeIdByDatabaseId.set(migration.databaseId, migration.nodeId);
    const identityKey = `${migration.nodeId}:${migration.databaseId}`;
    const entries = groups.get(identityKey) || [];
    entries.push(Object.freeze({ migration, index }));
    groups.set(identityKey, entries);
    for (const repository of [migration.fromRepository, migration.toRepository]) {
      const key = repository.toLowerCase();
      const previousIdentity = repositoryIdentities.get(key);
      if (previousIdentity && previousIdentity !== identityKey) {
        throw new Error("Repository migration names cross immutable identities");
      }
      repositoryIdentities.set(key, identityKey);
    }
  });

  const activeIdentityRepositories = new Set();
  for (const entries of groups.values()) {
    const from = new Map();
    const to = new Map();
    for (const entry of entries) {
      const fromKey = entry.migration.fromRepository.toLowerCase();
      const toKey = entry.migration.toRepository.toLowerCase();
      if (from.has(fromKey) || to.has(toKey)) {
        throw new Error("Repository migration history branches or converges");
      }
      from.set(fromKey, entry);
      to.set(toKey, entry);
    }
    const roots = [...from.keys()].filter((repository) => !to.has(repository));
    const tails = [...to.keys()].filter((repository) => !from.has(repository));
    if (roots.length !== 1 || tails.length !== 1) {
      throw new Error("Repository migration history contains a cycle");
    }
    const chain = [];
    const visited = new Set();
    let repository = roots[0];
    while (from.has(repository)) {
      if (visited.has(repository)) throw new Error("Repository migration history contains a cycle");
      visited.add(repository);
      const entry = from.get(repository);
      chain.push(entry);
      repository = entry.migration.toRepository.toLowerCase();
    }
    if (
      repository !== tails[0]
      || chain.length !== entries.length
      || chain.some((entry, index) => index > 0 && entry.index <= chain[index - 1].index)
      || chain.some((entry, index) => index > 0 && (
        Date.parse(entry.migration.observedAt)
          < Date.parse(chain[index - 1].migration.observedAt)
      ))
    ) {
      throw new Error("Repository migration history is not one append-only chain");
    }

    const first = chain[0].migration;
    const source = sourceByRepository.get(tails[0]);
    if (!source) {
      const retired = new Set(registry.retiredPluginIds || []);
      const activePluginIds = new Set(sources.flatMap(sourceRepositoryPluginIds));
      if (
        !first.pluginIds.every((id) => retired.has(id) && !activePluginIds.has(id))
        || chain.some(({ migration }) => (
          JSON.stringify(migration.pluginIds) !== JSON.stringify(first.pluginIds)
          || sourceByRepository.has(migration.fromRepository.toLowerCase())
          || sourceByRepository.has(migration.toRepository.toLowerCase())
        ))
      ) {
        throw new Error("Repository migration chain does not end at an active source or fully retired plugins");
      }
      continue;
    }
    const identity = parseRepositoryIdentity(source.repositoryIdentity);
    const expectedPrevious = new Set(chain.map((entry) => (
      entry.migration.fromRepository.toLowerCase()
    )));
    const actualPrevious = new Set(identity?.previousRepositories.map((entry) => entry.toLowerCase()) || []);
    const history = source.listingValidationHistory;
    if (history !== undefined && !Array.isArray(history)) {
      throw new Error("Repository migration source listing history is invalid");
    }
    const listingCommits = new Set([
      String(source.listingValidatedCommit || "").toLowerCase(),
      ...(history || []).map((entry) => String(entry?.commit || "").toLowerCase()),
    ]);
    if (
      !identity
      || identity.nodeId !== first.nodeId
      || identity.databaseId !== first.databaseId
      || JSON.stringify([...actualPrevious].sort()) !== JSON.stringify([...expectedPrevious].sort())
      || JSON.stringify(sourceRepositoryPluginIds(source)) !== JSON.stringify(first.pluginIds)
      || chain.some((entry) => (
        entry.migration.nodeId !== first.nodeId
        || entry.migration.databaseId !== first.databaseId
        || JSON.stringify(entry.migration.pluginIds) !== JSON.stringify(first.pluginIds)
        || !listingCommits.has(entry.migration.listedCommit)
      ))
    ) {
      throw new Error("Repository migration does not match its active source identity");
    }
    for (const previous of expectedPrevious) {
      if (sourceByRepository.has(previous)) {
        throw new Error("A migrated repository remains an active registry source");
      }
    }
    activeIdentityRepositories.add(tails[0]);
  }

  for (const source of sources) {
    const identity = parseRepositoryIdentity(source.repositoryIdentity);
    if (identity && !activeIdentityRepositories.has(githubRepositoryKey(source.repo))) {
      throw new Error("Repository identity references missing migration evidence");
    }
  }
  return Object.freeze(migrations);
}
