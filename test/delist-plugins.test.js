import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyPluginDelisting,
  parsePluginIds,
  planPluginDelisting,
} from "../scripts/delist-plugins.mjs";

const previousGeneratedAt = "2026-08-28T10:00:00.000Z";
const nextGeneratedAt = "2026-08-28T11:00:00.000Z";

function source(repo, ids) {
  return {
    repo,
    type: "plugin-source",
    addedAt: "2026-08-28",
    listingValidatedCommit: "a".repeat(40),
    plugins: Object.fromEntries(ids.map((id) => [id, { category: "Desktop", tags: ["system"] }])),
  };
}

function plugin(id, repo, previewStem = id.replaceAll(".", "-")) {
  return {
    id,
    name: id,
    repo,
    sourceType: "community",
    previewImage: `assets/img/plugins/${previewStem}-detail.webp`,
    previewThumbnail: `assets/img/plugins/${previewStem}-card.webp`,
  };
}

function fixture() {
  const targetRepo = "https://github.com/example/target";
  const retainedRepo = "https://github.com/example/retained";
  const multiRepo = "https://github.com/example/multi";
  return {
    targetRepo,
    retainedRepo,
    multiRepo,
    registry: {
      builtInSources: [],
      placeholders: [],
      retiredPluginIds: ["example.retired"],
      sources: [
        source(targetRepo, ["example.target"]),
        source(retainedRepo, ["example.retained"]),
        source(multiRepo, ["example.multi-a", "example.multi-b"]),
      ],
    },
    catalog: {
      generatedAt: previousGeneratedAt,
      stateSchemaVersion: 2,
      mode: "production",
      plugins: [
        plugin("example.target", targetRepo),
        plugin("example.retained", retainedRepo),
        plugin("example.multi-a", multiRepo),
        plugin("example.multi-b", multiRepo),
      ],
      warnings: [
        `${targetRepo}: repository-unreachable`,
        `${retainedRepo}: manifest-invalid`,
      ],
    },
  };
}

test("delisting input requires unique bounded manifest plugin IDs", () => {
  assert.deepEqual(parsePluginIds("example.two, example.one\n"), ["example.one", "example.two"]);
  assert.throws(() => parsePluginIds(""), /at least one/);
  assert.throws(() => parsePluginIds("example.one example.one"), /must not be repeated/);
  assert.throws(() => parsePluginIds("Example.One"), /Invalid plugin ID/);
  assert.throws(() => parsePluginIds("example..one"), /Invalid plugin ID/);
  assert.throws(() => parsePluginIds(Array.from({ length: 21 }, (_, index) => `example.${index}`).join(" ")), /at most 20/);
});

test("a delisting plan retires one complete source without unrelated drift", () => {
  const value = fixture();
  const result = planPluginDelisting(value.registry, value.catalog, ["example.target"], {
    generatedAt: nextGeneratedAt,
    requestedBy: "HANCORE-linux",
  });

  assert.deepEqual(result.nextRegistry.sources, value.registry.sources.slice(1));
  assert.deepEqual(result.nextRegistry.retiredPluginIds, ["example.retired", "example.target"]);
  assert.deepEqual(result.nextCatalog.plugins, value.catalog.plugins.slice(1));
  assert.deepEqual(result.nextCatalog.warnings, [`${value.retainedRepo}: manifest-invalid`]);
  assert.equal(result.nextCatalog.generatedAt, nextGeneratedAt);
  assert.deepEqual(result.report, {
    schemaVersion: 1,
    requestedBy: "HANCORE-linux",
    generatedAt: nextGeneratedAt,
    pluginIds: ["example.target"],
    repositories: [value.targetRepo],
    removedPluginCount: 1,
    removedSourceCount: 1,
    removedWarningCount: 1,
    removedPreviewPaths: [
      "assets/img/plugins/example-target-card.webp",
      "assets/img/plugins/example-target-detail.webp",
    ],
    commitSubject: "Delist example.target",
  });
  assert.deepEqual(value.registry.retiredPluginIds, ["example.retired"]);
  assert.equal(value.catalog.plugins.length, 4);
});

test("suite catalog IDs are delisted as complete registry sources", () => {
  const repo = "https://github.com/example/suite";
  const registry = {
    builtInSources: [],
    placeholders: [],
    retiredPluginIds: [],
    sources: [{
      repo,
      type: "suite",
      catalog: { id: "example.suite", category: "Desktop", tags: ["system"] },
    }],
  };
  const catalog = {
    generatedAt: previousGeneratedAt,
    stateSchemaVersion: 2,
    mode: "production",
    plugins: [plugin("example.suite", repo)],
    warnings: [],
  };
  const result = planPluginDelisting(registry, catalog, ["example.suite"], { generatedAt: nextGeneratedAt });
  assert.deepEqual(result.nextRegistry.sources, []);
  assert.deepEqual(result.nextRegistry.retiredPluginIds, ["example.suite"]);
  assert.deepEqual(result.nextCatalog.plugins, []);
});

test("multi-plugin sources must be retired as one complete source", () => {
  const value = fixture();
  assert.throws(
    () => planPluginDelisting(value.registry, value.catalog, ["example.multi-a"], { generatedAt: nextGeneratedAt }),
    /also select: example.multi-b/,
  );
  const result = planPluginDelisting(
    value.registry,
    value.catalog,
    ["example.multi-b", "example.multi-a"],
    { generatedAt: nextGeneratedAt },
  );
  assert.deepEqual(result.report.pluginIds, ["example.multi-a", "example.multi-b"]);
  assert.deepEqual(result.nextRegistry.sources.map(({ repo }) => repo), [value.targetRepo, value.retainedRepo]);
  assert.deepEqual(result.nextCatalog.plugins.map(({ id }) => id), ["example.target", "example.retained"]);
});

test("delisting fails closed on retired, missing, mismatched, shared, or stale state", () => {
  const value = fixture();
  assert.throws(
    () => planPluginDelisting(value.registry, value.catalog, ["example.retired"], { generatedAt: nextGeneratedAt }),
    /already retired/,
  );
  assert.throws(
    () => planPluginDelisting(value.registry, value.catalog, ["example.missing"], { generatedAt: nextGeneratedAt }),
    /not an active registry listing/,
  );
  assert.throws(
    () => planPluginDelisting(value.registry, {
      ...value.catalog,
      plugins: value.catalog.plugins.map((entry) => entry.id === "example.target" ? { ...entry, repo: value.retainedRepo } : entry),
    }, ["example.target"], { generatedAt: nextGeneratedAt }),
    /does not match the active registry source/,
  );
  assert.throws(
    () => planPluginDelisting(value.registry, {
      ...value.catalog,
      plugins: value.catalog.plugins.map((entry) => entry.id === "example.retained"
        ? { ...entry, previewImage: "assets/img/plugins/example-target-detail.webp" }
        : entry),
    }, ["example.target"], { generatedAt: nextGeneratedAt }),
    /Preview is shared/,
  );
  assert.throws(
    () => planPluginDelisting(value.registry, value.catalog, ["example.target"], { generatedAt: previousGeneratedAt }),
    /must be newer/,
  );
});

test("the delisting writer removes only the planned preview files", async () => {
  const value = fixture();
  const directory = await mkdtemp(path.join(os.tmpdir(), "marketplace-delisting-"));
  const previewDirectory = path.join(directory, "site", "assets", "img", "plugins");
  const registryPath = path.join(directory, "registry.json");
  const catalogPath = path.join(directory, "site", "catalog.json");
  const reportPath = path.join(directory, "report.json");
  try {
    await mkdir(previewDirectory, { recursive: true });
    await writeFile(registryPath, `${JSON.stringify(value.registry, null, 2)}\n`);
    await writeFile(catalogPath, `${JSON.stringify(value.catalog, null, 2)}\n`);
    for (const entry of value.catalog.plugins) {
      await writeFile(path.join(directory, "site", entry.previewImage), `${entry.id} detail\n`);
      await writeFile(path.join(directory, "site", entry.previewThumbnail), `${entry.id} card\n`);
    }

    const report = await applyPluginDelisting({
      registryPath,
      catalogPath,
      previewDirectory,
      reportPath,
      pluginIds: ["example.target"],
      generatedAt: nextGeneratedAt,
      requestedBy: "HANCORE-linux",
    });
    const nextRegistry = JSON.parse(await readFile(registryPath, "utf8"));
    const nextCatalog = JSON.parse(await readFile(catalogPath, "utf8"));
    assert.deepEqual(JSON.parse(await readFile(reportPath, "utf8")), report);
    assert.equal(nextRegistry.sources.some(({ repo }) => repo === value.targetRepo), false);
    assert.equal(nextCatalog.plugins.some(({ id }) => id === "example.target"), false);
    assert.equal(existsSync(path.join(previewDirectory, "example-target-card.webp")), false);
    assert.equal(existsSync(path.join(previewDirectory, "example-target-detail.webp")), false);
    assert.equal(existsSync(path.join(previewDirectory, "example-retained-card.webp")), true);
    assert.equal(existsSync(path.join(previewDirectory, "example-retained-detail.webp")), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the delisting writer rejects symbolic-link preview boundaries", async () => {
  const value = fixture();
  const directory = await mkdtemp(path.join(os.tmpdir(), "marketplace-delisting-links-"));
  const realPreviewDirectory = path.join(directory, "real-previews");
  const linkedPreviewDirectory = path.join(directory, "linked-previews");
  const registryPath = path.join(directory, "registry.json");
  const catalogPath = path.join(directory, "catalog.json");
  try {
    await mkdir(realPreviewDirectory);
    await writeFile(registryPath, `${JSON.stringify(value.registry, null, 2)}\n`);
    await writeFile(catalogPath, `${JSON.stringify(value.catalog, null, 2)}\n`);
    await writeFile(path.join(realPreviewDirectory, "example-target-card.webp"), "card\n");
    await writeFile(path.join(realPreviewDirectory, "example-target-detail.webp"), "detail\n");
    await symlink(realPreviewDirectory, linkedPreviewDirectory, "dir");
    await assert.rejects(() => applyPluginDelisting({
      registryPath,
      catalogPath,
      previewDirectory: linkedPreviewDirectory,
      reportPath: path.join(directory, "linked-report.json"),
      pluginIds: ["example.target"],
      generatedAt: nextGeneratedAt,
    }), /real directory without symbolic links/);

    await rm(linkedPreviewDirectory);
    await rm(path.join(realPreviewDirectory, "example-target-detail.webp"));
    await symlink(path.join(realPreviewDirectory, "example-target-card.webp"), path.join(realPreviewDirectory, "example-target-detail.webp"));
    await assert.rejects(() => applyPluginDelisting({
      registryPath,
      catalogPath,
      previewDirectory: realPreviewDirectory,
      reportPath: path.join(directory, "target-report.json"),
      pluginIds: ["example.target"],
      generatedAt: nextGeneratedAt,
    }), /Preview is not a regular file/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the delisting CLI binds environment input to its report", async () => {
  const value = fixture();
  const directory = await mkdtemp(path.join(os.tmpdir(), "marketplace-delisting-cli-"));
  const previewDirectory = path.join(directory, "site", "assets", "img", "plugins");
  const registryPath = path.join(directory, "registry.json");
  const catalogPath = path.join(directory, "site", "catalog.json");
  const reportPath = path.join(directory, "report.json");
  try {
    await mkdir(previewDirectory, { recursive: true });
    await writeFile(registryPath, `${JSON.stringify(value.registry, null, 2)}\n`);
    await writeFile(catalogPath, `${JSON.stringify(value.catalog, null, 2)}\n`);
    for (const entry of value.catalog.plugins) {
      await writeFile(path.join(directory, "site", entry.previewImage), "detail\n");
      await writeFile(path.join(directory, "site", entry.previewThumbnail), "card\n");
    }
    execFileSync(process.execPath, [
      new URL("../scripts/delist-plugins.mjs", import.meta.url).pathname,
      `--registry=${registryPath}`,
      `--catalog=${catalogPath}`,
      `--preview-dir=${previewDirectory}`,
      `--report=${reportPath}`,
    ], {
      env: {
        ...process.env,
        MARKETPLACE_DELIST_PLUGIN_IDS: "example.target",
        MARKETPLACE_DELIST_GENERATED_AT: nextGeneratedAt,
        MARKETPLACE_DELIST_REQUESTED_BY: "HANCORE-linux",
      },
    });
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.deepEqual(report.pluginIds, ["example.target"]);
    assert.equal(report.requestedBy, "HANCORE-linux");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
