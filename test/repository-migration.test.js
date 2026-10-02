import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  assertRepositoryMigrationPreviousState,
  buildCatalog,
  catalogSourcePlan,
  resolveFullRefreshIdentities,
  resolveSnapshot,
} from "../scripts/build-catalog.mjs";
import {
  applyRepositoryMigrationPlan,
  assertMigrationOutputBoundary,
} from "../scripts/migrate-repositories.mjs";
import { githubRepositoryKey } from "../scripts/github-repository.mjs";
import { promotePluginUpdateSource } from "../scripts/plugin-update.mjs";
import {
  parseRepositoryIdentity,
  validateRegistryRepositoryMigrations,
} from "../scripts/repository-identity.mjs";
import { sourceVerification } from "../scripts/verification-status.mjs";
import { planPluginDelisting } from "../scripts/delist-plugins.mjs";

const oldRepository = "Example/old-plugin";
const newRepository = "Example/new-plugin";
const oldUrl = `https://github.com/${oldRepository}`;
const newUrl = `https://github.com/${newRepository}`;
const pluginId = "example.plugin";
const listedCommit = "1".repeat(40);
const headCommit = "2".repeat(40);
const treeSha = "3".repeat(40);
const checkedAt = "2026-08-29T10:00:00.000Z";

function baseline(overrides = {}) {
  return {
    schemaVersion: 1,
    version: "3",
    repository: oldRepository.toLowerCase(),
    pluginIds: [pluginId],
    commit: listedCommit,
    checkedAt,
    outcome: "passed",
    enforcementMode: "selective",
    findings: [],
    capabilities: [],
    ...overrides,
  };
}

function source(overrides = {}) {
  return {
    repo: oldUrl,
    type: "plugin-source",
    addedAt: "2026-08-20",
    listedAt: checkedAt,
    listingValidatedCommit: listedCommit,
    listingValidatedAt: checkedAt,
    listingValidatedBranch: "main",
    automatedSecurityBaseline: baseline(),
    plugins: {
      [pluginId]: { category: "Other", tags: [] },
    },
    ...overrides,
  };
}

function migration(overrides = {}) {
  return {
    schemaVersion: 1,
    fromRepository: oldRepository,
    toRepository: newRepository,
    nodeId: "R_kgDOExample",
    databaseId: 123456789,
    pluginIds: [pluginId],
    listedCommit,
    previousValidatedCommit: listedCommit,
    observedHeadCommit: headCommit,
    observedBranch: "main",
    observedAt: "2026-08-29T11:00:00.000Z",
    ...overrides,
  };
}

function plan(migrations = [migration()]) {
  return {
    schemaVersion: 1,
    baseCommit: "a".repeat(40),
    registrySha256: "b".repeat(64),
    catalogSha256: "c".repeat(64),
    explorerSha256: "d".repeat(64),
    previewTree: "e".repeat(40),
    migrations,
  };
}

function previousCatalog() {
  return {
    generatedAt: checkedAt,
    stateSchemaVersion: 2,
    mode: "production",
    plugins: [{
      id: pluginId,
      repo: oldUrl,
      upstreamValidatedCommit: listedCommit,
      untouched: "target-history",
    }, {
      id: "unrelated.plugin",
      repo: "https://github.com/Other/repository",
      untouched: "preserve-byte-for-byte",
    }],
    warnings: [
      `${oldUrl}: repository-unreachable`,
      "https://github.com/Other/repository: manifest-invalid",
    ],
  };
}

function migratedSource(overrides = {}) {
  return {
    ...source(),
    repo: newUrl,
    repositoryIdentity: {
      schemaVersion: 1,
      nodeId: "R_kgDOExample",
      databaseId: 123456789,
      previousRepositories: [oldRepository],
    },
    ...overrides,
  };
}

function migratedRegistry(overrides = {}) {
  return {
    retiredPluginIds: [],
    repositoryMigrations: [migration()],
    sources: [migratedSource()],
    builtInSources: [],
    placeholders: [],
    ...overrides,
  };
}

function graphqlRate() {
  return { cost: 1, limit: 5000, remaining: 4900, resetAt: "2026-08-29T12:00:00Z" };
}

function graphqlRepository(overrides = {}) {
  return {
    id: "R_kgDOExample",
    databaseId: 123456789,
    nameWithOwner: newRepository,
    isArchived: false,
    isDisabled: false,
    isPrivate: false,
    stargazerCount: 1,
    pushedAt: checkedAt,
    updatedAt: checkedAt,
    defaultBranchRef: {
      name: "main",
      target: { oid: headCommit, tree: { oid: treeSha } },
    },
    configuredRef: null,
    ...overrides,
  };
}

test("current registry and catalog contain complete active or retired repository migration chains", async () => {
  const registry = JSON.parse(await readFile(new URL("../registry.json", import.meta.url), "utf8"));
  const catalog = JSON.parse(await readFile(new URL("../site/catalog.json", import.meta.url), "utf8"));
  const migrations = validateRegistryRepositoryMigrations(registry);
  assert.equal(migrations.length, registry.repositoryMigrations.length);
  const identifiedSources = registry.sources.filter((entry) => entry.repositoryIdentity);
  const retired = new Set(registry.retiredPluginIds);
  const activeMigrations = migrations.filter((entry) => !entry.pluginIds.every((id) => retired.has(id)));
  const migratedIdentities = new Set(activeMigrations.map((entry) => `${entry.nodeId}:${entry.databaseId}`));
  assert.equal(identifiedSources.length, migratedIdentities.size);
  assert.ok(catalog.plugins.every((plugin) => !retired.has(plugin.id)));
  for (const source of identifiedSources) {
    const identity = parseRepositoryIdentity(source.repositoryIdentity);
    const pluginIds = sourceRepositoryIds(source);
    const chain = migrations.filter((migration) => (
      migration.nodeId === identity.nodeId
      && migration.databaseId === identity.databaseId
    ));
    assert.equal(chain.length, identity.previousRepositories.length);
    assert.ok(chain.every((migration) => (
      JSON.stringify(migration.pluginIds) === JSON.stringify(pluginIds)
    )));
    const plugins = catalog.plugins.filter((plugin) => pluginIds.includes(plugin.id));
    assert.equal(plugins.length, pluginIds.length);
    assert.ok(plugins.every((plugin) => plugin.repo.toLowerCase() === source.repo.toLowerCase()));
    assert.ok(plugins.every((plugin) => plugin.upstreamCheckStatus === "passed"));
    for (const previousRepository of identity.previousRepositories) {
      assert.equal(
        catalog.warnings.includes(`https://github.com/${previousRepository}: repository-unreachable`),
        false,
      );
    }
  }
  assert.deepEqual(
    identifiedSources.find((source) => (
      source.repo === "https://github.com/omarchy-QOL/omarchy-btop-activity"
    )).repositoryIdentity.previousRepositories,
    ["ilyaZar/btop-quattro-plugin", "ilyaZar/omarchy-btop-activity"],
  );
  assert.deepEqual(
    identifiedSources.find((source) => (
      source.repo === "https://github.com/omarchy-QOL/syncshell"
    )).repositoryIdentity.previousRepositories,
    ["ilyaZar/omarchy-syncthing", "ilyaZar/syncshell"],
  );
});

function sourceRepositoryIds(value) {
  return value.type === "suite" ? [value.catalog.id] : Object.keys(value.plugins).sort();
}

test("delisting a migrated repository preserves valid immutable migration history", () => {
  const registry = migratedRegistry();
  const catalog = previousCatalog();
  catalog.plugins = [{ ...catalog.plugins[0], repo: newUrl, sourceType: "community" }];
  catalog.warnings = [];
  const result = planPluginDelisting(registry, catalog, [pluginId], {
    generatedAt: "2026-08-30T10:00:00.000Z",
  });
  assert.deepEqual(result.nextRegistry.repositoryMigrations, registry.repositoryMigrations);
  assert.deepEqual(result.nextRegistry.retiredPluginIds, [pluginId]);
  assert.deepEqual(validateRegistryRepositoryMigrations(result.nextRegistry), [migration()]);
});

test("retired migration chains still reject missing retirement, active reuse, and inconsistent history", () => {
  const retired = migratedRegistry({ sources: [], retiredPluginIds: [pluginId] });
  assert.throws(() => validateRegistryRepositoryMigrations({ ...retired, retiredPluginIds: [] }));
  assert.throws(() => validateRegistryRepositoryMigrations({ ...retired, sources: [source()] }));
  assert.throws(() => validateRegistryRepositoryMigrations({
    ...retired, sources: [source({ repo: "https://github.com/Other/reuse" })],
  }));
  const second = migration({ fromRepository: newRepository, toRepository: "Example/final-plugin" });
  assert.equal(validateRegistryRepositoryMigrations({
    ...retired, repositoryMigrations: [migration(), second],
  }).length, 2);
  assert.throws(() => validateRegistryRepositoryMigrations({
    ...retired,
    retiredPluginIds: [pluginId, "example.extra"],
    repositoryMigrations: [migration(), { ...second, pluginIds: ["example.extra"] }],
  }));
  assert.throws(() => validateRegistryRepositoryMigrations({
    ...retired, repositoryMigrations: [migration({ pluginIds: [pluginId, "example.extra"] })],
  }));
  assert.throws(() => validateRegistryRepositoryMigrations({
    ...retired, repositoryMigrations: [migration(), { ...second, toRepository: oldRepository }],
  }));
});

test("source repository identities require global append-only migration evidence", () => {
  const registry = migratedRegistry();
  delete registry.repositoryMigrations;
  assert.throws(
    () => validateRegistryRepositoryMigrations(registry),
    /requires global migration evidence/,
  );
});

test("repository migration preserves historical evidence without rewriting its repository", () => {
  const registry = {
    retiredPluginIds: [],
    sources: [source()],
    builtInSources: [],
    placeholders: [],
  };
  const before = sourceVerification(registry.sources[0]);
  const result = applyRepositoryMigrationPlan(registry, previousCatalog(), plan());
  const migrated = result.registry.sources[0];
  assert.equal(migrated.repo, newUrl);
  assert.deepEqual(migrated.repositoryIdentity, {
    schemaVersion: 1,
    nodeId: "R_kgDOExample",
    databaseId: 123456789,
    previousRepositories: [oldRepository],
  });
  assert.equal(migrated.automatedSecurityBaseline.repository, oldRepository.toLowerCase());
  assert.deepEqual(sourceVerification(migrated), before);
  assert.deepEqual(result.registry.repositoryMigrations, [migration()]);
  assert.deepEqual(result.repositoryMigrationTargets, [oldRepository]);
  assert.equal(validateRegistryRepositoryMigrations(result.registry).length, 1);
});

test("legacy baselines are explicitly bound to the old repository before migration", () => {
  const legacy = baseline();
  delete legacy.schemaVersion;
  delete legacy.repository;
  delete legacy.pluginIds;
  const result = applyRepositoryMigrationPlan({
    retiredPluginIds: [],
    sources: [source({ automatedSecurityBaseline: legacy })],
    builtInSources: [],
    placeholders: [],
  }, previousCatalog(), plan());
  assert.deepEqual(result.registry.sources[0].automatedSecurityBaseline, baseline());

  const silentlyRebound = migratedSource({ automatedSecurityBaseline: legacy });
  assert.deepEqual(sourceVerification(silentlyRebound), { status: "unverified" });
});

test("baseline-less legacy sources migrate without inventing trust evidence", () => {
  const legacy = source();
  delete legacy.automatedSecurityBaseline;
  const before = sourceVerification(legacy);
  const result = applyRepositoryMigrationPlan({
    retiredPluginIds: [],
    sources: [legacy],
    builtInSources: [],
    placeholders: [],
  }, previousCatalog(), plan());
  const migrated = result.registry.sources[0];
  assert.deepEqual(before, { status: "unverified" });
  assert.deepEqual(sourceVerification(migrated), before);
  assert.equal(Object.hasOwn(migrated, "automatedSecurityBaseline"), false);
  assert.equal(Object.hasOwn(migrated, "maintainerVerificationReview"), false);

  for (const invalid of [
    source({ automatedSecurityBaseline: null }),
    (() => {
      const value = source({ maintainerVerificationReview: {} });
      delete value.automatedSecurityBaseline;
      return value;
    })(),
  ]) {
    assert.throws(
      () => applyRepositoryMigrationPlan({
        retiredPluginIds: [],
        sources: [invalid],
        builtInSources: [],
        placeholders: [],
      }, previousCatalog(), plan()),
      /active security baseline is invalid|maintainer review is invalid/,
    );
  }
});

test("legacy listing history is bound to its historical repository before migration", () => {
  const historicalCommit = "0".repeat(40);
  const currentLegacy = baseline({
    commit: historicalCommit,
    checkedAt: "2026-08-20T10:00:00.000Z",
  });
  delete currentLegacy.schemaVersion;
  delete currentLegacy.repository;
  delete currentLegacy.pluginIds;
  const reviewOnlyLegacy = {
    version: "2",
    commit: historicalCommit,
    checkedAt: "2026-08-20T10:00:00.000Z",
    outcome: "passed",
    enforcementMode: "review-only",
    findings: [],
    capabilities: [],
  };
  for (const historicalBaseline of [currentLegacy, reviewOnlyLegacy]) {
    const listed = source({
      listingValidationHistory: [{
        commit: historicalCommit,
        validatedAt: "2026-08-20T10:00:00.000Z",
        branch: "main",
        supersededAt: checkedAt,
        automatedSecurityBaseline: historicalBaseline,
      }],
    });
    const before = sourceVerification(listed);
    const result = applyRepositoryMigrationPlan({
      retiredPluginIds: [],
      sources: [listed],
      builtInSources: [],
      placeholders: [],
    }, previousCatalog(), plan());
    const normalized = result.registry.sources[0].listingValidationHistory[0]
      .automatedSecurityBaseline;
    assert.equal(normalized.repository, oldRepository.toLowerCase());
    if (historicalBaseline.version === "3") {
      assert.equal(normalized.schemaVersion, 1);
      assert.deepEqual(normalized.pluginIds, [pluginId]);
    } else {
      assert.equal(normalized.schemaVersion, undefined);
      assert.equal(normalized.pluginIds, undefined);
    }
    assert.deepEqual(sourceVerification(result.registry.sources[0]), before);
  }
});

test("a migrated source remains valid after a regular verified plugin update", () => {
  const sourceValue = migratedSource();
  const promotedCommit = "5".repeat(40);
  const nextSource = promotePluginUpdateSource(sourceValue, {
    commitSha: promotedCommit,
    defaultBranch: "main",
  }, {
    automatedSecurityBaseline: baseline({
      repository: newRepository.toLowerCase(),
      commit: promotedCommit,
      checkedAt: "2026-08-29T12:00:00.000Z",
    }),
    promotedAt: "2026-08-29T12:00:00.000Z",
  });
  const registry = migratedRegistry({ sources: [nextSource] });
  assert.equal(validateRegistryRepositoryMigrations(registry).length, 1);
  assert.equal(sourceVerification(nextSource).status, "verified");
  assert.equal(nextSource.listingValidationHistory.at(-1).commit, listedCommit);
  assert.equal(nextSource.listingValidationHistory.at(-1).automatedSecurityBaseline.repository, oldRepository.toLowerCase());
});

test("the migration writer applies a second rename without an impossible warning", () => {
  const first = applyRepositoryMigrationPlan({
    retiredPluginIds: [],
    sources: [source()],
    builtInSources: [],
    placeholders: [],
  }, previousCatalog(), plan());
  const middleCatalog = previousCatalog();
  middleCatalog.plugins[0] = {
    ...middleCatalog.plugins[0],
    repo: newUrl,
    upstreamValidatedCommit: headCommit,
  };
  middleCatalog.warnings = ["https://github.com/Other/repository: manifest-invalid"];
  const finalRepository = "Example/final-plugin";
  const nextHead = "5".repeat(40);
  const secondMigration = migration({
    fromRepository: newRepository,
    toRepository: finalRepository,
    previousValidatedCommit: headCommit,
    observedHeadCommit: nextHead,
    observedAt: "2026-08-30T11:00:00.000Z",
  });
  const second = applyRepositoryMigrationPlan(
    first.registry,
    middleCatalog,
    plan([secondMigration]),
  );
  assert.equal(second.registry.repositoryMigrations.length, 2);
  assert.equal(second.registry.sources[0].repo, `https://github.com/${finalRepository}`);
  assert.deepEqual(second.registry.sources[0].repositoryIdentity.previousRepositories, [
    oldRepository,
    newRepository,
  ]);
  assert.equal(second.registry.sources[0].automatedSecurityBaseline.repository, oldRepository.toLowerCase());
  assert.equal(validateRegistryRepositoryMigrations(second.registry).length, 2);
  const sourcePlan = catalogSourcePlan(second.registry, "", [newRepository]);
  const state = assertRepositoryMigrationPreviousState(sourcePlan, middleCatalog);
  assert.equal(state.get(finalRepository.toLowerCase()).migration.nodeId, "R_kgDOExample");
});

test("repository migration history supports append-only chains and rejects cycles or branches", () => {
  const middleRepository = "Example/middle-plugin";
  const finalRepository = "Example/final-plugin";
  const promotedCommit = "5".repeat(40);
  const second = migration({
    fromRepository: middleRepository,
    toRepository: finalRepository,
    listedCommit: promotedCommit,
    previousValidatedCommit: promotedCommit,
    observedHeadCommit: promotedCommit,
    observedAt: "2026-08-30T11:00:00.000Z",
  });
  const first = migration({ toRepository: middleRepository });
  const active = {
    ...source(),
    repo: `https://github.com/${finalRepository}`,
    listingValidatedCommit: promotedCommit,
    repositoryIdentity: {
      schemaVersion: 1,
      nodeId: "R_kgDOExample",
      databaseId: 123456789,
      previousRepositories: [oldRepository, middleRepository],
    },
    listingValidationHistory: [{
      commit: listedCommit,
      validatedAt: checkedAt,
      branch: "main",
      supersededAt: "2026-08-30T10:00:00.000Z",
    }],
  };
  const chained = {
    retiredPluginIds: [],
    repositoryMigrations: [first, second],
    sources: [active],
  };
  assert.equal(validateRegistryRepositoryMigrations(chained).length, 2);
  assert.throws(
    () => validateRegistryRepositoryMigrations({
      ...chained,
      repositoryMigrations: [
        first,
        second,
        migration({
          fromRepository: finalRepository,
          toRepository: oldRepository,
          listedCommit: promotedCommit,
          observedAt: "2026-08-31T11:00:00.000Z",
        }),
      ],
    }),
    /cycle/,
  );
  assert.throws(
    () => validateRegistryRepositoryMigrations({
      ...chained,
      repositoryMigrations: [
        first,
        migration({ toRepository: "Example/other-plugin" }),
      ],
    }),
    /branches or converges/,
  );
});

test("repository migration node and database IDs remain globally bijective", () => {
  const otherCommit = "6".repeat(40);
  const otherSource = (nodeId, databaseId) => ({
    repo: "https://github.com/Other/new-plugin",
    repositoryIdentity: {
      schemaVersion: 1,
      nodeId,
      databaseId,
      previousRepositories: ["Other/old-plugin"],
    },
    type: "suite",
    addedAt: "2026-08-20",
    listingValidatedCommit: otherCommit,
    listingValidatedAt: checkedAt,
    listingValidatedBranch: "main",
    catalog: { id: "other.plugin", name: "Other plugin" },
  });
  const otherMigration = (nodeId, databaseId) => ({
    ...migration(),
    fromRepository: "Other/old-plugin",
    toRepository: "Other/new-plugin",
    nodeId,
    databaseId,
    pluginIds: ["other.plugin"],
    listedCommit: otherCommit,
    previousValidatedCommit: otherCommit,
    observedHeadCommit: otherCommit,
  });
  for (const [nodeId, databaseId] of [
    ["R_kgDOExample", 987654321],
    ["R_kgDOOther", 123456789],
  ]) {
    assert.throws(
      () => validateRegistryRepositoryMigrations({
        retiredPluginIds: [],
        repositoryMigrations: [migration(), otherMigration(nodeId, databaseId)],
        sources: [migratedSource(), otherSource(nodeId, databaseId)],
      }),
      /not globally bijective/,
    );
  }
});

test("repository migration planning rejects ambiguous identity, catalog, and evidence state", () => {
  assert.throws(
    () => parseRepositoryIdentity({
      schemaVersion: 1,
      nodeId: "R_kgDOExample",
      databaseId: "123456789",
      previousRepositories: [oldRepository],
    }),
    /identity is invalid/,
  );
  assert.throws(
    () => applyRepositoryMigrationPlan({
      retiredPluginIds: [],
      sources: [source()],
      builtInSources: [],
      placeholders: [],
    }, previousCatalog(), plan([migration({ pluginIds: ["other.plugin"] })])),
    /plugin set|source identity|catalog evidence is ambiguous/i,
  );
  const duplicatedWarning = previousCatalog();
  duplicatedWarning.warnings.push(`${oldUrl}: repository-unreachable`);
  for (const catalog of [
    { ...previousCatalog(), warnings: [] },
    duplicatedWarning,
  ]) {
    assert.throws(
      () => applyRepositoryMigrationPlan({
        retiredPluginIds: [],
        sources: [source()],
        builtInSources: [],
        placeholders: [],
      }, catalog, plan()),
      /catalog evidence is ambiguous/,
    );
  }
  assert.throws(
    () => validateRegistryRepositoryMigrations(migratedRegistry({
      sources: [migratedSource({
        repositoryIdentity: {
          schemaVersion: 1,
          nodeId: "R_different",
          databaseId: 123456789,
          previousRepositories: [oldRepository],
        },
      })],
    })),
    /does not match/,
  );
});

test("migration source plans require exact recorded targets and previous catalog state", () => {
  const registry = migratedRegistry();
  const sourcePlan = catalogSourcePlan(registry, "", [oldRepository]);
  assert.equal(sourcePlan.migration, true);
  assert.deepEqual(sourcePlan.refreshSources, registry.sources);
  const state = assertRepositoryMigrationPreviousState(sourcePlan, previousCatalog());
  assert.equal(state.get(newRepository.toLowerCase()).migration.nodeId, "R_kgDOExample");
  assert.throws(
    () => catalogSourcePlan(registry, "", ["Other/missing"]),
    /evidence is incomplete/,
  );
  const changed = previousCatalog();
  changed.plugins[0].upstreamValidatedCommit = headCommit;
  assert.throws(
    () => assertRepositoryMigrationPreviousState(sourcePlan, changed),
    /previous catalog state is ambiguous/,
  );
});

test("GraphQL immutable repository ID mismatches are globally fatal", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "test-token";
  let calls = 0;
  let malformed = {};
  globalThis.fetch = async (_input, init = {}) => {
    calls += 1;
    const request = JSON.parse(init.body);
    if (request.query.includes("CatalogRefreshBudget")) {
      return Response.json({ data: { rateLimit: graphqlRate() } });
    }
    return Response.json({
      data: {
        r0: graphqlRepository(malformed),
        rateLimit: graphqlRate(),
      },
    });
  };
  try {
    for (const value of [
      { id: "R_wrong" },
      { databaseId: 987654321 },
      { nameWithOwner: "Example/third-name" },
    ]) {
      malformed = value;
      await assert.rejects(
        resolveFullRefreshIdentities([migratedSource()]),
        /Immutable repository identity mismatch/,
      );
    }
    assert.equal(calls, 6);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalToken;
  }
});

async function withTargetedMigrationBuild(manifestId, callback) {
  const directory = await mkdtemp(resolve(tmpdir(), "repository-migration-build-"));
  const registryPath = resolve(directory, "registry.json");
  const catalogPath = resolve(directory, "catalog.json");
  const previewDirectory = resolve(directory, "plugins");
  const unrelatedSource = {
    repo: "https://github.com/Other/repository",
    type: "suite",
    addedAt: "2026-08-20",
    listingValidatedCommit: "4".repeat(40),
    listingValidatedAt: checkedAt,
    listingValidatedBranch: "main",
    catalog: { id: "unrelated.plugin", name: "Unrelated" },
  };
  const target = migratedSource();
  const registry = migratedRegistry({ sources: [target, unrelatedSource] });
  const unrelatedPlugin = {
    id: "unrelated.plugin",
    name: "Unrelated",
    repo: unrelatedSource.repo,
    sourceType: "community",
    verificationStatus: "unverified",
    verificationSnapshotStatus: "unverified",
    verificationCoverage: "unverified",
    untouched: "preserve-byte-for-byte",
  };
  const previous = {
    generatedAt: checkedAt,
    stateSchemaVersion: 2,
    mode: "production",
    plugins: [{
      id: pluginId,
      name: "Old plugin",
      version: "0.9.0",
      repo: oldUrl,
      sourceType: "community",
      upstreamValidatedCommit: listedCommit,
      upstreamCheckStatus: "unreachable",
    }, unrelatedPlugin],
    warnings: [
      `${oldUrl}: repository-unreachable`,
      "https://github.com/Other/repository: manifest-invalid",
    ],
  };
  await mkdir(previewDirectory, { recursive: true });
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  await writeFile(catalogPath, `${JSON.stringify(previous, null, 2)}\n`);

  const manifest = {
    schemaVersion: 1,
    id: manifestId,
    name: "Current plugin",
    version: "1.0.0",
    author: "Example",
    description: "A bounded migration fixture.",
    license: "MIT",
    kinds: ["overlay"],
    entryPoints: { overlay: "Main.qml" },
  };
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "test-token";
  const urls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    urls.push(url);
    if (url === "https://api.github.com/graphql") {
      const request = JSON.parse(init.body);
      if (request.query.includes("CatalogRefreshBudget")) {
        return Response.json({ data: { rateLimit: graphqlRate() } });
      }
      return Response.json({
        data: { r0: graphqlRepository(), rateLimit: graphqlRate() },
      });
    }
    if (url === "https://api.github.com/rate_limit") {
      return Response.json({
        resources: { core: { limit: 5000, remaining: 4999, reset: 1788012000 } },
      });
    }
    if (url === `https://api.github.com/repos/${newRepository}/git/trees/${treeSha}?recursive=1`) {
      return Response.json({
        truncated: false,
        tree: [
          { path: "README.md", type: "blob", mode: "100644", size: 10 },
          { path: "LICENSE", type: "blob", mode: "100644", size: 10 },
          { path: "manifest.json", type: "blob", mode: "100644", size: 400 },
          { path: "Main.qml", type: "blob", mode: "100644", size: 10 },
        ],
      });
    }
    if (url === `https://api.github.com/repos/${newRepository}/releases/latest`) {
      return Response.json({ message: "Not Found" }, { status: 404 });
    }
    if (url === `https://api.github.com/repos/${newRepository}/tags?per_page=1`) {
      return Response.json([]);
    }
    if (url === `https://raw.githubusercontent.com/${newRepository}/${headCommit}/manifest.json`) {
      return Response.json(manifest);
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    await callback({
      registryPath,
      catalogPath,
      previewDirectory,
      previous,
      unrelatedPlugin,
      urls,
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalToken;
    await rm(directory, { recursive: true, force: true });
  }
}

test("targeted migration refreshes only exact sources and preserves unrelated state", async () => {
  await withTargetedMigrationBuild(pluginId, async ({
    registryPath,
    catalogPath,
    previewDirectory,
    unrelatedPlugin,
    urls,
  }) => {
    await buildCatalog({
      registryPath,
      catalogPath,
      previewDirectory,
      repositoryMigrationTargets: [oldRepository],
      graphqlBudgetReserve: 0,
      restBudgetReserve: 0,
    });
    const next = JSON.parse(await readFile(catalogPath, "utf8"));
    assert.equal(next.plugins.length, 2);
    assert.deepEqual(next.plugins[1], unrelatedPlugin);
    assert.deepEqual(next.warnings, ["https://github.com/Other/repository: manifest-invalid"]);
    assert.equal(next.plugins[0].repo, newUrl);
    assert.equal(next.plugins[0].upstreamCheckStatus, "passed");
    assert.equal(next.plugins[0].upstreamValidatedCommit, headCommit);
    assert.equal(next.plugins[0].verificationCoverage, "update-unverified");
    assert.deepEqual(await readdir(previewDirectory), []);
    assert.equal(urls.filter((url) => url.includes("/git/trees/")).length, 1);
    assert.equal(urls.some((url) => url.includes("Other/repository")), false);
  });
});

test("targeted migration failures leave catalog and previews unchanged", async () => {
  await withTargetedMigrationBuild("other.plugin", async ({
    registryPath,
    catalogPath,
    previewDirectory,
  }) => {
    const before = await readFile(catalogPath);
    await writeFile(resolve(previewDirectory, "keep.webp"), "unchanged");
    await assert.rejects(
      buildCatalog({
        registryPath,
        catalogPath,
        previewDirectory,
        repositoryMigrationTargets: [oldRepository],
        graphqlBudgetReserve: 0,
        restBudgetReserve: 0,
      }),
      /configured plugin is missing|no valid plugin manifests found/,
    );
    assert.deepEqual(await readFile(catalogPath), before);
    assert.deepEqual(await readdir(previewDirectory), ["keep.webp"]);
    assert.equal(await readFile(resolve(previewDirectory, "keep.webp"), "utf8"), "unchanged");
  });
});

test("migration output rejects a symlink ancestor that resolves into the worktree", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "repository-migration-output-boundary-"));
  const root = resolve(import.meta.dirname, "..");
  const link = resolve(directory, "worktree-link");
  await symlink(root, link, "dir");
  try {
    await assert.rejects(
      assertMigrationOutputBoundary(root, resolve(link, "output")),
      /outside the project worktree/,
    );
    assert.equal(
      await assertMigrationOutputBoundary(root, resolve(directory, "safe-output")),
      resolve(directory, "safe-output"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("REST immutable repository ID mismatches fail before commit or tree acquisition", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "test-token";
  const urls = [];
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    return Response.json({
      id: 999,
      node_id: "R_wrong",
      full_name: newRepository,
      private: false,
      disabled: false,
      archived: false,
      default_branch: "main",
    });
  };
  try {
    await assert.rejects(resolveSnapshot(migratedSource()), /Immutable repository identity mismatch/);
    assert.deepEqual(urls, [`https://api.github.com/repos/${newRepository}`]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalToken;
  }
});
