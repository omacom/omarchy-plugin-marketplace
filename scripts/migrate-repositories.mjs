import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { buildCatalog } from "./build-catalog.mjs";
import { githubRepositoryKey } from "./github-repository.mjs";
import {
  parseRepositoryIdentity,
  parseRepositoryMigration,
  repositoryEvidenceKeys,
  sourceRepositoryPluginIds,
  validateRegistryRepositoryMigrations,
} from "./repository-identity.mjs";
import { parseStoredSecurityBaselineRecord } from "./security-baseline-record.mjs";
import { sourceVerification } from "./verification-status.mjs";
import {
  parseListingValidationHistory,
  parseMaintainerVerificationReview,
  parseMaintainerVerificationReviewHistory,
  parseMaintainerVerificationReviewPair,
} from "./verification-review.mjs";

const execFileAsync = promisify(execFile);
const fullCommitPattern = /^[a-f0-9]{40}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const treePattern = /^[a-f0-9]{40}$/;

function exactKeys(value, expected) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function serialized(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function normalizedPlan(value) {
  const keys = [
    "schemaVersion",
    "baseCommit",
    "registrySha256",
    "catalogSha256",
    "explorerSha256",
    "previewTree",
    "migrations",
  ];
  if (
    !exactKeys(value, keys)
    || value.schemaVersion !== 1
    || typeof value.baseCommit !== "string"
    || !fullCommitPattern.test(value.baseCommit)
    || typeof value.registrySha256 !== "string"
    || !sha256Pattern.test(value.registrySha256)
    || typeof value.catalogSha256 !== "string"
    || !sha256Pattern.test(value.catalogSha256)
    || typeof value.explorerSha256 !== "string"
    || !sha256Pattern.test(value.explorerSha256)
    || typeof value.previewTree !== "string"
    || !treePattern.test(value.previewTree)
    || !Array.isArray(value.migrations)
    || !value.migrations.length
  ) throw new Error("Repository migration plan is invalid");
  const migrations = value.migrations.map(parseRepositoryMigration);
  if (
    new Set(migrations.map((entry) => entry.fromRepository.toLowerCase())).size
      !== migrations.length
    || new Set(migrations.map((entry) => entry.toRepository.toLowerCase())).size
      !== migrations.length
  ) throw new Error("Repository migration plan contains duplicate identities");
  return Object.freeze({ ...value, migrations: Object.freeze(migrations) });
}

function normalizeListingHistoryBaselines(history, repository, allowedRepositories, pluginIds) {
  return history.map((entry) => {
    const historical = entry.automatedSecurityBaseline;
    if (!historical || historical.schemaVersion !== undefined) return entry;
    const normalized = parseStoredSecurityBaselineRecord(historical, {
      expectedRepository: repository,
      allowedRepositories,
      allowLegacyRepositoryFallback: true,
      expectedCommit: entry.commit,
      pluginIds,
    });
    if (normalized) return { ...entry, automatedSecurityBaseline: normalized };
    return historical.version === "2" && !historical.repository
      ? {
          ...entry,
          automatedSecurityBaseline: { ...historical, repository },
        }
      : entry;
  });
}

function normalizeActiveBaseline(source, repository, pluginIds) {
  if (source.type !== "plugin-source") return source;
  const allowedRepositories = repositoryEvidenceKeys(source);
  const migrated = source.repositoryIdentity !== undefined;
  const hasBaseline = Object.hasOwn(source, "automatedSecurityBaseline");
  const baseline = hasBaseline
    ? parseStoredSecurityBaselineRecord(source.automatedSecurityBaseline, {
        expectedRepository: repository,
        allowedRepositories,
        allowLegacyRepositoryFallback: !migrated,
        expectedCommit: source.listingValidatedCommit,
        pluginIds,
      })
    : null;
  if (hasBaseline && !baseline) {
    throw new Error(`${source.repo}: active security baseline is invalid`);
  }
  if (
    Object.hasOwn(source, "maintainerVerificationReview")
    && (!baseline || !parseMaintainerVerificationReview(source.maintainerVerificationReview, baseline))
  ) throw new Error(`${source.repo}: maintainer review is invalid`);
  if (
    Object.hasOwn(source, "maintainerVerificationRevocation")
    && !parseMaintainerVerificationReviewPair(
      source.maintainerVerificationReview,
      source.maintainerVerificationRevocation,
      baseline,
    )
  ) throw new Error(`${source.repo}: maintainer review revocation is invalid`);
  if (
    Object.hasOwn(source, "maintainerVerificationReviewHistory")
    && !parseMaintainerVerificationReviewHistory(source.maintainerVerificationReviewHistory, {
      expectedRepository: repository,
      allowedRepositories,
      allowLegacyRepositoryFallback: !migrated,
      pluginIds,
    })
  ) throw new Error(`${source.repo}: maintainer review history is invalid`);
  const hasListingHistory = Object.hasOwn(source, "listingValidationHistory");
  if (
    hasListingHistory
    && !parseListingValidationHistory(source.listingValidationHistory, {
      expectedRepository: repository,
      allowedRepositories,
      allowLegacyRepositoryFallback: !migrated,
      pluginIds,
    })
  ) throw new Error(`${source.repo}: listing validation history is invalid`);
  return {
    ...source,
    ...(hasBaseline && source.automatedSecurityBaseline.schemaVersion === undefined
      ? { automatedSecurityBaseline: baseline }
      : {}),
    ...(hasListingHistory
      ? {
          listingValidationHistory: normalizeListingHistoryBaselines(
            source.listingValidationHistory,
            repository,
            allowedRepositories,
            pluginIds,
          ),
        }
      : {}),
  };
}

function migrateSource(source, migration) {
  const previousRepository = githubRepositoryKey(source.repo);
  if (previousRepository !== migration.fromRepository.toLowerCase()) {
    throw new Error("Repository migration source changed after evidence capture");
  }
  const pluginIds = sourceRepositoryPluginIds(source);
  const existingIdentity = parseRepositoryIdentity(source.repositoryIdentity);
  if (
    JSON.stringify(pluginIds) !== JSON.stringify(migration.pluginIds)
    || String(source.listingValidatedCommit || "").toLowerCase() !== migration.listedCommit
    || (existingIdentity && (
      existingIdentity.nodeId !== migration.nodeId
      || existingIdentity.databaseId !== migration.databaseId
    ))
  ) throw new Error("Repository migration source identity is ambiguous");
  const beforeVerification = sourceVerification(source);
  const normalized = normalizeActiveBaseline(source, previousRepository, pluginIds);
  const {
    repo: ignoredRepository,
    repositoryIdentity: ignoredIdentity,
    type,
    ...rest
  } = normalized;
  const previousRepositories = [
    ...(existingIdentity?.previousRepositories || []),
    migration.fromRepository,
  ];
  if (
    new Set(previousRepositories.map((repository) => repository.toLowerCase())).size
      !== previousRepositories.length
  ) throw new Error("Repository migration repeats historical repository identity");
  const migrated = {
    repo: `https://github.com/${migration.toRepository}`,
    repositoryIdentity: {
      schemaVersion: 1,
      nodeId: migration.nodeId,
      databaseId: migration.databaseId,
      previousRepositories,
    },
    type,
    ...rest,
  };
  if (migrated.type === "suite" && migrated.catalog) {
    const { installCommand: ignoredCommand, installNote: ignoredNote, ...catalog } = migrated.catalog;
    migrated.catalog = catalog;
  }
  const afterVerification = sourceVerification(migrated);
  if (JSON.stringify(afterVerification) !== JSON.stringify(beforeVerification)) {
    throw new Error("Repository migration changed historical verification status");
  }
  return migrated;
}

export function applyRepositoryMigrationPlan(registry, catalog, planValue) {
  const plan = normalizedPlan(planValue);
  validateRegistryRepositoryMigrations(registry);
  const priorMigrations = registry.repositoryMigrations || [];
  const existingFrom = new Set(priorMigrations.map((entry) => (
    String(entry.fromRepository || "").toLowerCase()
  )));
  const sourceByRepository = new Map((registry.sources || []).map((source) => [
    githubRepositoryKey(source.repo),
    source,
  ]));
  const targetRepositories = new Set(plan.migrations.map((entry) => entry.toRepository.toLowerCase()));
  if ((registry.sources || []).some((source) => targetRepositories.has(githubRepositoryKey(source.repo)))) {
    throw new Error("Canonical migration target is already registered");
  }
  const replacements = new Map();
  for (const migration of plan.migrations) {
    if (existingFrom.has(migration.fromRepository.toLowerCase())) {
      throw new Error("Repository migration was already recorded");
    }
    const source = sourceByRepository.get(migration.fromRepository.toLowerCase());
    if (!source) throw new Error("Repository migration source is missing");
    const previous = (catalog.plugins || []).filter((plugin) => (
      migration.pluginIds.includes(plugin.id)
    ));
    const oldUrl = `https://github.com/${migration.fromRepository}`;
    const warningCount = (catalog.warnings || []).filter((warning) => (
      warning === `${oldUrl}: repository-unreachable`
    )).length;
    const repeatedIdentityTransfer = parseRepositoryIdentity(source.repositoryIdentity) !== null;
    if (
      previous.length !== migration.pluginIds.length
      || previous.some((plugin) => plugin.repo.toLowerCase() !== oldUrl.toLowerCase())
      || previous.some((plugin) => (
        String(plugin.upstreamValidatedCommit || "").toLowerCase()
          !== migration.previousValidatedCommit
      ))
      || (warningCount !== 1 && !(repeatedIdentityTransfer && warningCount === 0))
    ) throw new Error("Repository migration catalog evidence is ambiguous");
    replacements.set(source, migrateSource(source, migration));
  }
  const { retiredPluginIds, repositoryMigrations: ignoredMigrations, sources, ...rest } = registry;
  const nextRegistry = {
    retiredPluginIds,
    repositoryMigrations: [...priorMigrations, ...plan.migrations],
    sources: sources.map((source) => replacements.get(source) || source),
    ...rest,
  };
  validateRegistryRepositoryMigrations(nextRegistry);
  return Object.freeze({
    plan,
    registry: nextRegistry,
    repositoryMigrationTargets: Object.freeze(
      plan.migrations.map((migration) => migration.fromRepository),
    ),
  });
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function previewChecksumLines(previewDirectory) {
  const entries = await readdir(previewDirectory, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile())) {
    throw new Error("Repository migration previews contain an unsupported file type");
  }
  const lines = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    lines.push(`${await sha256File(resolve(previewDirectory, entry.name))}  site/assets/img/plugins/${entry.name}`);
  }
  return lines;
}

async function assertBaseGuard(root, plan) {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const previewTree = execFileSync(
    "git",
    ["rev-parse", "HEAD:site/assets/img/plugins"],
    { cwd: root, encoding: "utf8" },
  ).trim();
  const guards = [
    [head, plan.baseCommit, "base commit"],
    [await sha256File(resolve(root, "registry.json")), plan.registrySha256, "registry"],
    [await sha256File(resolve(root, "site/catalog.json")), plan.catalogSha256, "catalog"],
    [await sha256File(resolve(root, "site/explorer-data.json")), plan.explorerSha256, "Explorer"],
    [previewTree, plan.previewTree, "preview tree"],
  ];
  for (const [actual, expected, label] of guards) {
    if (actual !== expected) throw new Error(`Repository migration ${label} guard failed`);
  }
}

function gitBlob(root, commit, path) {
  return execFileSync("git", ["show", `${commit}:${path}`], {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
  });
}

async function materializeBasePreviews(root, output, commit) {
  const archive = resolve(output, ".base-previews.tar");
  execFileSync(
    "git",
    ["archive", "--format=tar", `--output=${archive}`, commit, "site/assets/img/plugins"],
    { cwd: root, maxBuffer: 1024 * 1024 },
  );
  try {
    execFileSync("tar", ["-xf", archive, "-C", output], { maxBuffer: 1024 * 1024 });
  } finally {
    await rm(archive, { force: true });
  }
}

function isWithin(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

export async function assertMigrationOutputBoundary(root, output) {
  const outputPath = resolve(output);
  const parentPath = dirname(outputPath);
  const parentMetadata = await lstat(parentPath);
  if (!parentMetadata.isDirectory() && !parentMetadata.isSymbolicLink()) {
    throw new Error("Repository migration output parent is not a directory");
  }
  const rootPath = await realpath(root);
  const parentRealPath = await realpath(parentPath);
  const candidateRealPath = resolve(parentRealPath, basename(outputPath));
  if (isWithin(rootPath, candidateRealPath)) {
    throw new Error("Repository migration output must stay outside the project worktree");
  }
  return outputPath;
}

async function previewHashMap(previewDirectory) {
  const entries = await readdir(previewDirectory, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile())) {
    throw new Error("Repository migration previews contain an unsupported file type");
  }
  return new Map(await Promise.all(entries.map(async (entry) => [
    entry.name,
    await sha256File(resolve(previewDirectory, entry.name)),
  ])));
}

function catalogPreviewPaths(catalog, pluginIds) {
  const ids = new Set(pluginIds);
  return new Set((catalog.plugins || [])
    .filter((plugin) => ids.has(plugin.id))
    .flatMap((plugin) => [plugin.previewThumbnail, plugin.previewImage])
    .filter(Boolean)
    .map((path) => path.replace(/^assets\/img\/plugins\//, "")));
}

function assertUnrelatedPreviewsPreserved(before, after, previousCatalog, nextCatalog, migrations) {
  const pluginIds = migrations.flatMap((migration) => migration.pluginIds);
  const previousTargetPaths = catalogPreviewPaths(previousCatalog, pluginIds);
  const nextTargetPaths = catalogPreviewPaths(nextCatalog, pluginIds);
  for (const [path, hash] of before) {
    if (!previousTargetPaths.has(path) && after.get(path) !== hash) {
      throw new Error(`Repository migration changed unrelated preview ${path}`);
    }
    if (previousTargetPaths.has(path) && !nextTargetPaths.has(path) && after.has(path)) {
      throw new Error(`Repository migration retained stale preview ${path}`);
    }
  }
  for (const [path, hash] of after) {
    if (!nextTargetPaths.has(path) && before.get(path) !== hash) {
      throw new Error(`Repository migration added unrelated preview ${path}`);
    }
    if (nextTargetPaths.has(path) && !before.has(path) && !hash) {
      throw new Error(`Repository migration target preview ${path} is invalid`);
    }
  }
}

function assertUnrelatedCatalogPreserved(previous, next, migrations) {
  const migratedIds = new Set(migrations.flatMap((migration) => migration.pluginIds));
  const previousUnrelated = previous.plugins.filter((plugin) => !migratedIds.has(plugin.id));
  const nextUnrelated = next.plugins.filter((plugin) => !migratedIds.has(plugin.id));
  if (JSON.stringify(previousUnrelated) !== JSON.stringify(nextUnrelated)) {
    throw new Error("Repository migration changed unrelated catalog plugins");
  }
  const removedWarnings = new Set(migrations.map((migration) => (
    `https://github.com/${migration.fromRepository}: repository-unreachable`
  )));
  const expectedWarnings = previous.warnings.filter((warning) => !removedWarnings.has(warning));
  if (JSON.stringify(expectedWarnings) !== JSON.stringify(next.warnings)) {
    throw new Error("Repository migration changed unrelated catalog warnings");
  }
  if (
    next.plugins.length !== previous.plugins.length
    || new Set(next.plugins.map((plugin) => plugin.id)).size !== next.plugins.length
  ) throw new Error("Repository migration changed the catalog plugin identity set");
}

async function main() {
  const { values } = parseArgs({
    options: {
      plan: { type: "string" },
      output: { type: "string" },
    },
  });
  if (!values.plan || !values.output) throw new Error("--plan and --output are required");
  const root = resolve(import.meta.dirname, "..");
  const output = await assertMigrationOutputBoundary(root, values.output);
  try {
    await stat(output);
    throw new Error("Repository migration output already exists");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const plan = normalizedPlan(JSON.parse(await readFile(resolve(values.plan), "utf8")));
  await assertBaseGuard(root, plan);
  const registryContent = gitBlob(root, plan.baseCommit, "registry.json");
  const catalogContent = gitBlob(root, plan.baseCommit, "site/catalog.json");
  const explorerContent = gitBlob(root, plan.baseCommit, "site/explorer-data.json");
  const registry = JSON.parse(registryContent);
  const catalog = JSON.parse(catalogContent);
  const baseExplorer = JSON.parse(explorerContent);
  const projected = applyRepositoryMigrationPlan(registry, catalog, plan);
  await mkdir(output);
  await materializeBasePreviews(root, output, plan.baseCommit);
  const site = resolve(output, "site");
  const previews = resolve(site, "assets/img/plugins");
  const basePreviewHashes = await previewHashMap(previews);
  await writeFile(resolve(output, "registry.json"), serialized(projected.registry));
  await writeFile(resolve(site, "catalog.json"), catalogContent);
  await buildCatalog({
    registryPath: resolve(output, "registry.json"),
    catalogPath: resolve(site, "catalog.json"),
    previewDirectory: previews,
    repositoryMigrationTargets: projected.repositoryMigrationTargets,
  });
  const nextCatalog = JSON.parse(await readFile(resolve(site, "catalog.json"), "utf8"));
  assertUnrelatedCatalogPreserved(catalog, nextCatalog, plan.migrations);
  assertUnrelatedPreviewsPreserved(
    basePreviewHashes,
    await previewHashMap(previews),
    catalog,
    nextCatalog,
    plan.migrations,
  );
  const explorerPath = resolve(site, "explorer-data.json");
  await execFileAsync(process.execPath, [resolve(root, "scripts/build-explorer-data.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      MARKETPLACE_EXPLORER_CATALOG_PATH: resolve(site, "catalog.json"),
      MARKETPLACE_EXPLORER_OUTPUT_PATH: explorerPath,
    },
    maxBuffer: 64 * 1024 * 1024,
  });
  const explorer = JSON.parse(await readFile(explorerPath, "utf8"));
  if (
    explorer.nodes.length !== baseExplorer.nodes.length
    || new Set(explorer.nodes.map((node) => node.id)).size !== explorer.nodes.length
  ) throw new Error("Repository migration changed Explorer plugin identities");
  const finalHead = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  if (finalHead !== plan.baseCommit) {
    throw new Error("Repository migration base changed during generation");
  }
  const previewChecksums = await previewChecksumLines(previews);
  const previewManifestSha256 = createHash("sha256")
    .update(`${previewChecksums.join("\n")}\n`)
    .digest("hex");
  const report = {
    schemaVersion: 1,
    baseCommit: plan.baseCommit,
    generatedAt: nextCatalog.generatedAt,
    migrations: plan.migrations,
    registrySha256: await sha256File(resolve(output, "registry.json")),
    catalogSha256: await sha256File(resolve(site, "catalog.json")),
    explorerSha256: await sha256File(explorerPath),
    previewFileCount: previewChecksums.length,
    previewManifestSha256,
  };
  await writeFile(resolve(output, "repository-migration-report.json"), serialized(report));
  await writeFile(resolve(output, "SHA256SUMS"), [
    `${report.registrySha256}  registry.json`,
    `${report.catalogSha256}  site/catalog.json`,
    `${report.explorerSha256}  site/explorer-data.json`,
    `${await sha256File(resolve(output, "repository-migration-report.json"))}  repository-migration-report.json`,
    ...previewChecksums,
  ].join("\n") + "\n");
  process.stdout.write(serialized(report));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
