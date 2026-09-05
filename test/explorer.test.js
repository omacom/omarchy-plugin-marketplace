import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertCompleteGitHistory,
  assertGrowthContinuity,
} from "../scripts/explorer-growth-history.mjs";
import {
  matchesExplorerSearch,
  repositoryPublisher,
} from "../site/assets/js/explore-search.js";
import {
  inclusiveDayCount,
  inclusiveRangeStart,
} from "../site/assets/js/growth-range.js";

const catalog = JSON.parse(fs.readFileSync(new URL("../site/catalog.json", import.meta.url), "utf8"));
const explorer = JSON.parse(fs.readFileSync(new URL("../site/explorer-data.json", import.meta.url), "utf8"));
const page = fs.readFileSync(new URL("../site/explore.html", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../site/assets/css/explore.css", import.meta.url), "utf8");
const script = fs.readFileSync(new URL("../site/assets/js/explore.js", import.meta.url), "utf8");
const builder = fs.readFileSync(new URL("../scripts/build-explorer-data.mjs", import.meta.url), "utf8");
const approvalWorkflow = fs.readFileSync(new URL("../.github/workflows/approve-submission.yml", import.meta.url), "utf8");
const refreshWorkflow = fs.readFileSync(new URL("../.github/workflows/refresh-catalog.yml", import.meta.url), "utf8");
const verificationWorkflow = fs.readFileSync(new URL("../.github/workflows/verify-plugin.yml", import.meta.url), "utf8");
const deploymentWorkflow = fs.readFileSync(new URL("../.github/workflows/deploy-pages.yml", import.meta.url), "utf8");

function workflowJobSource(workflow, name, nextName = "") {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.ok(start > 0, `${name} job must exist`);
  const end = nextName ? workflow.indexOf(`\n  ${nextName}:\n`, start + 1) : -1;
  return end > start ? workflow.slice(start, end) : workflow.slice(start);
}

function createExplorerBuilderFixture(growth, plugins = [], {
  generatedAt = "2026-08-28T10:00:00.000Z",
  committedAt = "2026-08-28T09:00:00Z",
} = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "explorer-builder-history-"));
  fs.mkdirSync(path.join(directory, "scripts"));
  fs.mkdirSync(path.join(directory, "site", "assets", "js"), { recursive: true });
  fs.copyFileSync(new URL("../scripts/build-explorer-data.mjs", import.meta.url), path.join(directory, "scripts", "build-explorer-data.mjs"));
  fs.copyFileSync(new URL("../scripts/explorer-growth-history.mjs", import.meta.url), path.join(directory, "scripts", "explorer-growth-history.mjs"));
  fs.copyFileSync(new URL("../site/assets/js/taxonomy.js", import.meta.url), path.join(directory, "site", "assets", "js", "taxonomy.js"));
  fs.writeFileSync(path.join(directory, "site", "catalog.json"), JSON.stringify({
    generatedAt,
    plugins,
  }));
  fs.writeFileSync(path.join(directory, "site", "explorer-data.json"), JSON.stringify({
    generatedAt,
    growthMeta: { method: "git-catalog-snapshots" },
    growth,
  }));
  execFileSync("git", ["init", "--quiet"], { cwd: directory });
  execFileSync("git", ["add", "."], { cwd: directory });
  execFileSync("git", [
    "-c", "user.name=Explorer Test",
    "-c", "user.email=explorer-test@example.invalid",
    "commit", "--quiet", "-m", "Add Explorer fixture",
  ], {
    cwd: directory,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: committedAt,
      GIT_COMMITTER_DATE: committedAt,
    },
  });
  return directory;
}

test("explorer data covers the current community catalog", () => {
  const communityPlugins = catalog.plugins.filter((plugin) => plugin.sourceType === "community");
  assert.equal(explorer.scope, "community");
  assert.equal(explorer.nodes.length, communityPlugins.length);
  assert.deepEqual(new Set(explorer.nodes.map((node) => node.id)), new Set(communityPlugins.map((plugin) => plugin.id)));
  const pluginsById = new Map(communityPlugins.map((plugin) => [plugin.id, plugin]));
  assert.ok(explorer.nodes.every((node) => node.kind === pluginsById.get(node.id)?.kind));
  assert.ok(explorer.nodes.every((node) => node.accent === pluginsById.get(node.id)?.accent));
  assert.ok(explorer.nodes.every((node) => node.initials === pluginsById.get(node.id)?.initials));
  assert.ok(explorer.nodes.every((node) => node.previewThumbnail === pluginsById.get(node.id)?.previewThumbnail));
  assert.ok(explorer.nodes.every((node) => node.previewThumbnailWidth === pluginsById.get(node.id)?.previewThumbnailWidth));
  assert.ok(explorer.nodes.every((node) => node.previewThumbnailHeight === pluginsById.get(node.id)?.previewThumbnailHeight));
  const nodeCountByCluster = new Map();
  for (const node of explorer.nodes) {
    nodeCountByCluster.set(node.cluster, (nodeCountByCluster.get(node.cluster) || 0) + 1);
  }
  const publishedClusterIds = explorer.clusters.map((cluster) => cluster.id);
  assert.equal(new Set(publishedClusterIds).size, publishedClusterIds.length);
  assert.deepEqual(new Set(publishedClusterIds), new Set(nodeCountByCluster.keys()));
  for (const cluster of explorer.clusters) {
    assert.ok(cluster.count > 0);
    assert.equal(cluster.count, nodeCountByCluster.get(cluster.id));
  }
  assert.ok(explorer.edges.length > explorer.nodes.length);
  assert.equal(explorer.method, "Local TF-IDF similarity");
});

test("growth series uses daily end-of-day catalog history snapshots", () => {
  assert.ok(explorer.growth.length > 1);
  assert.equal(explorer.growthMeta.method, "git-catalog-snapshots");
  assert.equal(explorer.growthMeta.historical, true);
  assert.equal(explorer.growthMeta.timezone, "UTC");
  assert.match(explorer.growthMeta.detail, /Earlier UTC days use the final committed catalog state\. The latest UTC day is provisional until a successful later-day build finalizes it\./);
  for (let index = 1; index < explorer.growth.length; index++) {
    const previous = explorer.growth[index - 1];
    const current = explorer.growth[index];
    assert.equal(Date.parse(`${current.date}T00:00:00Z`) - Date.parse(`${previous.date}T00:00:00Z`), 86_400_000);
    assert.equal(current.total, previous.total + current.added);
  }
  assert.equal(explorer.growth.at(-1).total, explorer.nodes.length);
  assert.equal(explorer.growth.at(-1).date, catalog.generatedAt.slice(0, 10));
  assert.match(builder, /assertCompleteGitHistory\(projectRoot\)[\s\S]*historicalCatalogGrowth\(\)/);
  assert.doesNotMatch(builder, /current-catalog-listing-dates|Explorer growth fallback/);
});

test("Explorer growth rejects shallow Git history", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "explorer-growth-history-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: directory });
    fs.writeFileSync(path.join(directory, "fixture.txt"), "fixture\n");
    execFileSync("git", ["add", "fixture.txt"], { cwd: directory });
    execFileSync("git", [
      "-c", "user.name=Explorer Test",
      "-c", "user.email=explorer-test@example.invalid",
      "commit", "--quiet", "-m", "Add fixture",
    ], { cwd: directory });
    assert.doesNotThrow(() => assertCompleteGitHistory(directory));
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).trim();
    fs.writeFileSync(path.join(directory, ".git", "shallow"), `${head}\n`);
    assert.throws(
      () => assertCompleteGitHistory(directory),
      /complete Git history \(shallow repository detected\)/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Explorer growth only changes its previously provisional day or appends valid later days", () => {
  const previous = {
    generatedAt: "2026-08-28T10:00:00.000Z",
    growthMeta: { method: "git-catalog-snapshots" },
    growth: [
      { date: "2026-08-27", total: 10, added: 10 },
      { date: "2026-08-28", total: 12, added: 2 },
    ],
  };
  const sameDay = [
    previous.growth[0],
    { date: "2026-08-28", total: 13, added: 3 },
  ];
  const nextDay = [
    ...previous.growth,
    { date: "2026-08-29", total: 11, added: -1 },
  ];

  assert.doesNotThrow(() => assertGrowthContinuity(previous, sameDay, "2026-08-28T18:00:00.000Z"));
  assert.doesNotThrow(() => assertGrowthContinuity(previous, nextDay, "2026-08-29T04:17:00.000Z"));
  assert.throws(
    () => assertGrowthContinuity(previous, [
      { date: "2026-08-28", total: 12, added: 12 },
      { date: "2026-08-29", total: 11, added: -1 },
    ], "2026-08-29T04:17:00.000Z"),
    /does not extend the committed historical series/,
  );
  assert.throws(
    () => assertGrowthContinuity(previous, [
      { date: "2026-08-27", total: 11, added: 11 },
      { date: "2026-08-28", total: 12, added: 1 },
      nextDay[2],
    ], "2026-08-29T04:17:00.000Z"),
    /changed or removed a completed UTC day/,
  );
  assert.throws(
    () => assertGrowthContinuity(previous, [...previous.growth, {
      date: "not-a-day", total: 12, added: 0,
    }, {
      date: "2026-08-30", total: 12, added: 0,
    }], "2026-08-30T04:17:00.000Z"),
    /invalid UTC day/,
  );
  assert.throws(
    () => assertGrowthContinuity(previous, [
      previous.growth[0],
      { ...previous.growth[1], note: "unexpected" },
    ], "2026-08-28T18:00:00.000Z"),
    /invalid historical point/,
  );
  assert.throws(
    () => assertGrowthContinuity(previous, previous.growth, "2026-08-27T18:00:00.000Z"),
    /does not extend the committed historical series/,
  );
});

test("Explorer finalizes only the last previous point across one or more UTC days", () => {
  const previous = {
    generatedAt: "2026-09-04T23:59:21.243Z",
    growthMeta: { method: "git-catalog-snapshots" },
    growth: [
      { date: "2026-09-03", total: 2159, added: 2159 },
      { date: "2026-09-04", total: 2369, added: 210 },
    ],
  };
  for (const total of [2368, 2369, 2370]) {
    const finalized = { date: "2026-09-04", total, added: total - 2159 };
    const next = [previous.growth[0], finalized, { date: "2026-09-05", total: 2371, added: 2371 - total }];
    assert.doesNotThrow(() => assertGrowthContinuity(previous, next, "2026-09-05T00:01:00.000Z"));
    // The corrected predecessor, not the old provisional total, determines added.
    assert.throws(() => assertGrowthContinuity(previous, [
      previous.growth[0], { ...finalized, added: finalized.added + 1 }, next[2],
    ], "2026-09-05T00:01:00.000Z"), /not a contiguous daily series/);
    assert.throws(() => assertGrowthContinuity(previous, [
      previous.growth[0], finalized, { ...next[2], added: next[2].added + 1 },
    ], "2026-09-05T00:01:00.000Z"), /not a contiguous daily series/);
    const gap = [...next, { date: "2026-09-06", total: 2371, added: 0 }, { date: "2026-09-07", total: 2372, added: 1 }];
    assert.doesNotThrow(() => assertGrowthContinuity(previous, gap, "2026-09-07T01:00:00.000Z"));
    const committedNext = { ...previous, growth: next, generatedAt: "2026-09-05T00:01:00.000Z" };
    const secondRollover = [previous.growth[0], finalized, { date: "2026-09-05", total: 2370, added: 2370 - total }, { date: "2026-09-06", total: 2373, added: 3 }];
    assert.doesNotThrow(() => assertGrowthContinuity(committedNext, secondRollover, "2026-09-06T01:00:00.000Z"));
    // Yesterday's finalized value cannot become mutable again on a later rollover.
    assert.throws(() => assertGrowthContinuity(committedNext, [
      previous.growth[0], { ...finalized, total: total + 1, added: finalized.added + 1 },
      { ...secondRollover[2], added: secondRollover[2].added - 1 }, secondRollover[3],
    ], "2026-09-06T01:00:00.000Z"), /changed or removed a completed UTC day/);
  }
});

function fixturePlugins(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `fixture.plugin-${index}`, name: `Fixture ${index}`, sourceType: "community",
    description: "Inert test metadata", category: "Other", tags: [],
  }));
}

function writeFixtureCatalog(directory, generatedAt, count) {
  fs.writeFileSync(path.join(directory, "site", "catalog.json"), JSON.stringify({ generatedAt, plugins: fixturePlugins(count) }));
}

function buildFixtureExplorer(directory, success = true) {
  const output = path.join(directory, "site", "explorer-data.json");
  const before = fs.readFileSync(output);
  const result = spawnSync(process.execPath, ["scripts/build-explorer-data.mjs"], {
    cwd: directory, encoding: "utf8", timeout: 30_000,
    env: { ...process.env, MARKETPLACE_EXPLORER_CATALOG_PATH: path.join(directory, "site", "catalog.json"), MARKETPLACE_EXPLORER_OUTPUT_PATH: output },
  });
  if (success) assert.equal(result.status, 0, result.stderr);
  else {
    assert.notEqual(result.status, 0);
    assert.equal(result.error, undefined);
    assert.deepEqual(fs.readFileSync(output), before, "Rejected builds must leave output bytes unchanged");
    return result;
  }
  return JSON.parse(fs.readFileSync(output, "utf8"));
}

function commitFixtureSnapshot(directory, committedAt, authoredAt = committedAt) {
  execFileSync("git", ["add", "site"], { cwd: directory });
  execFileSync("git", ["-c", "user.name=Explorer Test", "-c", "user.email=explorer-test@example.invalid", "commit", "--quiet", "-m", "Record inert catalog snapshot"], {
    cwd: directory, env: { ...process.env, GIT_AUTHOR_DATE: authoredAt, GIT_COMMITTER_DATE: committedAt },
  });
}

test("Explorer builder reproduces the 2369-to-2368 midnight incident using committer UTC time", () => {
  const directory = createExplorerBuilderFixture([{ date: "2026-09-03", total: 2159, added: 2159 }], fixturePlugins(2159), {
    generatedAt: "2026-09-03T12:00:00.000Z", committedAt: "2026-09-03T12:01:00Z",
  });
  try {
    writeFixtureCatalog(directory, "2026-09-04T23:57:06.641Z", 2368);
    buildFixtureExplorer(directory);
    commitFixtureSnapshot(directory, "2026-09-04T23:58:06Z");
    writeFixtureCatalog(directory, "2026-09-04T23:59:21.243Z", 2369);
    const provisional = buildFixtureExplorer(directory);
    assert.deepEqual(provisional.growth.at(-1), { date: "2026-09-04", total: 2369, added: 210 });
    commitFixtureSnapshot(directory, "2026-09-05T00:00:19Z", "2026-09-04T23:59:21Z");
    // A standalone/no-op rebuild must not advance the logical day just because
    // this catalog was committed on a later UTC day than its generatedAt.
    const noOp = buildFixtureExplorer(directory);
    assert.deepEqual(noOp, provisional);
    writeFixtureCatalog(directory, "2026-09-05T00:01:00.000Z", 2369);
    const next = buildFixtureExplorer(directory);
    assert.deepEqual(next.growth, [
      { date: "2026-09-03", total: 2159, added: 2159 },
      { date: "2026-09-04", total: 2368, added: 209 },
      { date: "2026-09-05", total: 2369, added: 1 },
    ]);
    assert.equal(next.nodes.length, 2369);
    assert.match(next.growthMeta.detail, /latest UTC day is provisional/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Explorer builder finalizes at exact midnight, across offsets, gaps and successive rollovers", () => {
  for (const midnight of ["2026-09-05T00:00:00Z", "2026-09-05T02:00:00+02:00", "2026-09-04T20:00:00-04:00"]) {
    const directory = createExplorerBuilderFixture([{ date: "2026-09-03", total: 2, added: 2 }], fixturePlugins(2), {
      generatedAt: "2026-09-03T12:00:00.000Z", committedAt: "2026-09-03T12:01:00Z",
    });
    try {
      writeFixtureCatalog(directory, "2026-09-04T20:00:00.000Z", 3);
      buildFixtureExplorer(directory);
      commitFixtureSnapshot(directory, "2026-09-04T20:01:00Z");
      writeFixtureCatalog(directory, "2026-09-04T23:59:21.243Z", 4);
      buildFixtureExplorer(directory);
      commitFixtureSnapshot(directory, midnight, "2026-09-04T23:59:21Z");
      writeFixtureCatalog(directory, "2026-09-05T12:00:00.000Z", 5);
      const next = buildFixtureExplorer(directory);
      assert.deepEqual(next.growth.slice(-2), [{ date: "2026-09-04", total: 3, added: 1 }, { date: "2026-09-05", total: 5, added: 2 }]);
      // The next day's open value is itself committed over another UTC boundary.
      commitFixtureSnapshot(directory, "2026-09-06T00:00:00Z");
      writeFixtureCatalog(directory, "2026-09-06T12:00:00.000Z", 6);
      const second = buildFixtureExplorer(directory);
      assert.deepEqual(second.growth.slice(-3), [{ date: "2026-09-04", total: 3, added: 1 }, { date: "2026-09-05", total: 4, added: 1 }, { date: "2026-09-06", total: 6, added: 2 }]);
      assert.deepEqual(second.growth.slice(0, -2), next.growth.slice(0, -1));
      commitFixtureSnapshot(directory, "2026-09-06T12:01:00Z");
      writeFixtureCatalog(directory, "2026-09-09T12:00:00.000Z", 7);
      const gap = buildFixtureExplorer(directory);
      assert.deepEqual(gap.growth.slice(-4), [
        { date: "2026-09-06", total: 6, added: 2 }, { date: "2026-09-07", total: 6, added: 0 },
        { date: "2026-09-08", total: 6, added: 0 }, { date: "2026-09-09", total: 7, added: 1 },
      ]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("Explorer builder rejects older history changes without replacing output", () => {
  const directory = createExplorerBuilderFixture([
    { date: "2026-09-03", total: 2, added: 2 },
  ], fixturePlugins(2), { generatedAt: "2026-09-03T12:00:00.000Z", committedAt: "2026-09-03T12:01:00Z" });
  try {
    writeFixtureCatalog(directory, "2026-09-04T12:00:00.000Z", 3);
    const valid = buildFixtureExplorer(directory);
    // Preserve contiguity and arithmetic while corrupting an older finalized point.
    const corrupt = { ...valid, growth: [{ date: "2026-09-03", total: 1, added: 1 }, { date: "2026-09-04", total: 3, added: 2 }] };
    fs.writeFileSync(path.join(directory, "site", "explorer-data.json"), JSON.stringify(corrupt));
    commitFixtureSnapshot(directory, "2026-09-04T12:01:00Z");
    writeFixtureCatalog(directory, "2026-09-05T12:00:00.000Z", 4);
    assert.match(buildFixtureExplorer(directory, false).stderr, /changed or removed a completed UTC day/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Kids taxonomy activates its graph community without publishing empty clusters", () => {
  const directory = createExplorerBuilderFixture(
    [{ date: "2026-08-28", total: 7, added: 7 }],
    [
      {
        id: "example.kids-category",
        name: "Category Example",
        author: "Example",
        description: "Activities.",
        category: "Kids",
        tags: ["games"],
        sourceType: "community",
      },
      {
        id: "example.kids-tag",
        name: "Tag Example",
        author: "Example",
        description: "Activities.",
        category: "Developer Tools",
        tags: ["kids"],
        sourceType: "community",
      },
      {
        id: "example.education-tag",
        name: "Education Tag Example",
        author: "Example",
        description: "Activities.",
        category: "Productivity",
        tags: ["education"],
        sourceType: "community",
      },
      {
        id: "example.system-monitor",
        name: "System Monitor",
        author: "Example",
        description: "System resource monitor.",
        category: "System",
        tags: ["system"],
        sourceType: "community",
      },
      {
        id: "example.description-neighbor",
        name: "Reference Notes",
        author: "Example",
        description: "Kids education reference without curated taxonomy.",
        category: "Productivity",
        tags: ["quickshell"],
        sourceType: "community",
      },
      {
        id: "example.case-neighbor",
        name: "Case Neighbor",
        author: "Example",
        description: "Activities.",
        category: "Productivity",
        tags: ["Kids", "EDUCATION"],
        sourceType: "community",
      },
      {
        id: "example.category-case-neighbor",
        name: "Category Case Neighbor",
        author: "Example",
        description: "Activities.",
        category: "kids",
        tags: ["quickshell"],
        sourceType: "community",
      },
    ],
  );
  try {
    const result = spawnSync(process.execPath, ["scripts/build-explorer-data.mjs"], {
      cwd: directory,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(fs.readFileSync(path.join(directory, "site", "explorer-data.json"), "utf8"));
    assert.deepEqual(
      output.clusters.map(({ id, label, count }) => ({ id, label, count })),
      [
        { id: "kids", label: "Kids & Education", count: 3 },
        { id: "productivity", label: "Productivity", count: 2 },
        { id: "system", label: "System & Monitoring", count: 1 },
        { id: "other", label: "Other", count: 1 },
      ],
    );
    for (const id of ["example.kids-category", "example.kids-tag", "example.education-tag"]) {
      assert.equal(output.nodes.find((node) => node.id === id)?.cluster, "kids");
    }
    for (const id of ["example.description-neighbor", "example.case-neighbor", "example.category-case-neighbor"]) {
      assert.notEqual(output.nodes.find((node) => node.id === id)?.cluster, "kids");
    }
    assert.ok(output.clusters.every((cluster) => cluster.count > 0));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Explorer builder fails closed for shallow and truncated repositories", () => {
  const complete = createExplorerBuilderFixture([
    { date: "2026-08-28", total: 0, added: 0 },
  ]);
  const truncated = createExplorerBuilderFixture([
    { date: "2026-08-27", total: 0, added: 0 },
    { date: "2026-08-28", total: 0, added: 0 },
  ]);
  try {
    const completeResult = spawnSync(process.execPath, ["scripts/build-explorer-data.mjs"], {
      cwd: complete,
      encoding: "utf8",
    });
    assert.equal(completeResult.status, 0, completeResult.stderr);

    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: complete, encoding: "utf8" }).trim();
    fs.writeFileSync(path.join(complete, ".git", "shallow"), `${head}\n`);
    const beforeShallow = fs.readFileSync(path.join(complete, "site", "explorer-data.json"));
    const shallowResult = spawnSync(process.execPath, ["scripts/build-explorer-data.mjs"], {
      cwd: complete,
      encoding: "utf8",
    });
    assert.notEqual(shallowResult.status, 0);
    assert.match(shallowResult.stderr, /complete Git history \(shallow repository detected\)/);
    assert.deepEqual(fs.readFileSync(path.join(complete, "site", "explorer-data.json")), beforeShallow);

    const previousOutput = fs.readFileSync(path.join(truncated, "site", "explorer-data.json"), "utf8");
    const truncatedResult = spawnSync(process.execPath, ["scripts/build-explorer-data.mjs"], {
      cwd: truncated,
      encoding: "utf8",
    });
    assert.notEqual(truncatedResult.status, 0);
    assert.match(truncatedResult.stderr, /does not extend the committed historical series/);
    assert.equal(fs.readFileSync(path.join(truncated, "site", "explorer-data.json"), "utf8"), previousOutput);
  } finally {
    fs.rmSync(complete, { recursive: true, force: true });
    fs.rmSync(truncated, { recursive: true, force: true });
  }
});

test("explore page exposes graph and date-filtered growth views", () => {
  assert.match(page, /<span class="page-eyebrow">Community registry<\/span>/);
  assert.match(page, /role="tab"[^>]+aria-controls="graph-view"/);
  assert.match(page, /role="tab"[^>]+aria-controls="growth-view"/);
  assert.match(page, /id="growth-from" type="text"[^>]+readonly[^>]+aria-controls="growth-calendar"/);
  assert.match(page, /id="growth-to" type="text"[^>]+readonly[^>]+aria-controls="growth-calendar"/);
  assert.equal((page.match(/class="date-input-shell"/g) || []).length, 2);
  assert.match(page, /id="growth-calendar"[^>]+role="dialog"[\s\S]*id="growth-calendar-grid"[^>]+role="grid"/);
  assert.match(page, /assets\/js\/explore\.js\?v=\d{8}-\d+/);
});

test("growth view preserves the source graphic's presentation hierarchy", () => {
  assert.match(page, /class="growth-poster"/);
  assert.match(page, /Community Registry[\s\S]*<h2>community plugins<\/h2>/);
  assert.match(page, /class="growth-summary"[\s\S]*id="growth-delta"[^>]+class="growth-delta"[\s\S]*plugins[\s\S]*id="growth-start-total"[\s\S]*id="growth-end-total"[\s\S]*Period/);
  assert.match(page, /id="growth-rate"[\s\S]*id="growth-trend-arrow"[\s\S]*id="growth-rate-value"/);
  assert.match(script, /growthDelta\.querySelector\("strong"\)\.textContent = `\$\{change > 0 \? "\+" : ""\}\$\{number\.format\(change\)\}`[\s\S]*plugin\$\{absoluteChange === 1 \? "" : "s"\} \$\{trendWord\} over the selected period/);
  assert.match(page, /class="growth-plot-meta"[\s\S]*Plugin Count[\s\S]*class="growth-plot-frame"[\s\S]*viewBox="0 0 1728 620"/);
  assert.match(page, /id="growth-chart"[^>]+aria-label="Community plugin growth"[^>]+aria-describedby="growth-chart-description"/);
  assert.match(page, /<p id="growth-finality-copy">Earlier UTC days are final\. The latest day is provisional until a successful later-day build finalizes it\.<\/p>/);
  assert.match(script, /querySelector\("#growth-finality-copy"\)\.textContent = `Earlier UTC days are final\. The latest day \(\$\{maximum\}, UTC\) is provisional/);
  assert.match(script, /end\.date === explorer\.growth\.at\(-1\)\.date[\s\S]*latest UTC day in this range is provisional[\s\S]*All UTC days in this range are final/);
  assert.match(script, /querySelector\("#growth-chart-description"\)\.textContent = .*\$\{finalityDescription\}/);
  assert.doesNotMatch(page, /<title id="growth-chart-title">/);
  assert.doesNotMatch(script, /\.title\s*=\s*growthMeta\.detail/);
  assert.match(page, /class="explore-freshness"[\s\S]*Data updated[\s\S]*id="explorer-updated"[\s\S]*Daily refresh start[\s\S]*id="explorer-refresh-time"/);
  assert.match(page, /End-of-day Git catalog snapshots \(UTC\)[\s\S]*Active community listings[\s\S]*Omarchy Quattro v4\.0\.0 release[\s\S]*class="growth-source">Source[\s\S]*id="growth-source"/);
  assert.match(script, /releaseBoxWidth = 340[\s\S]*releaseBoxHeight = 60[\s\S]*OMARCHY QUATTRO v4\.0\.0[\s\S]*release-label-meta[\s\S]*`\$\{releaseDate\} · RELEASE`/);
  assert.match(styles, /\.release-label\s*\{[^}]*font:\s*700 20px var\(--mono\)[^}]*\}[\s\S]*\.release-label-meta\s*\{[^}]*fill:\s*var\(--growth-muted\)[^}]*font:\s*600 16px var\(--mono\)/);
  assert.equal((page.match(/Data updated/g) || []).length, 1);
  assert.equal((page.match(/Daily refresh start/g) || []).length, 1);
});

test("explore UI follows marketplace geometry, readable type, and complete theme states", () => {
  assert.match(styles, /\.explore-main\s*\{[\s\S]*width:\s*min\(1104px,/);
  assert.doesNotMatch(styles, /font-size:\s*8px/);
  assert.match(styles, /box-shadow:\s*inset 0 0 0 1px var\(--accent\)/);
  assert.doesNotMatch(styles, /box-shadow:\s*inset 0 -3px var\(--accent\)/);
  assert.match(styles, /\.date-range label\.is-open\s*\{\s*border-color:\s*var\(--accent\);\s*box-shadow:\s*none;/);
  assert.match(styles, /\.date-input-shell svg[\s\S]*stroke:\s*var\(--muted\)/);
  assert.match(styles, /\[data-theme="light"\] \.growth-poster[\s\S]*--growth-bg:\s*#f8f8f6[\s\S]*--growth-accent:\s*#c6371c/);
  assert.match(styles, /\[data-chart-line\]\s*\{\s*stroke:\s*var\(--growth-accent\)/);
  assert.match(styles, /\.growth-summary > div\s*\{[^}]*padding:\s*0 16px[^}]*grid-template-rows:\s*49% 51%[^}]*gap:\s*0/);
  assert.match(styles, /\.growth-total > strong[\s\S]*grid-template-columns:\s*minmax\(60px, 1fr\) 18px minmax\(60px, 1fr\)/);
  assert.match(styles, /\.growth-period\s*\{[^}]*justify-items:\s*center;[^}]*text-align:\s*center/);
  assert.match(styles, /\.growth-period > span, \.growth-period > strong\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center/);
  assert.match(page, /id="growth-rate" class="growth-rate"/);
  assert.match(styles, /\.growth-rate[\s\S]*width:\s*68px[\s\S]*flex:\s*0 0 68px[\s\S]*grid-template-columns:\s*16px 1fr[\s\S]*font-size:\s*11px/);
  assert.match(styles, /\.growth-rate i\s*\{\s*font-size:\s*12px/);
  assert.match(styles, /\.growth-delta\s*\{[\s\S]*gap:\s*5px[\s\S]*white-space:\s*nowrap[\s\S]*\.growth-delta strong\s*\{[^}]*color:\s*var\(--growth-accent\)[^}]*font-size:\s*11px/);
  assert.match(styles, /@media \(max-width:\s*400px\)[\s\S]*\.growth-summary\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\) 84px[\s\S]*\.growth-rate\s*\{[^}]*width:\s*62px/);
  assert.match(styles, /\.explore-freshness[\s\S]*font-size:\s*10px[\s\S]*letter-spacing:\s*\.09em/);
  assert.match(styles, /\.explore-freshness time, \.explore-freshness strong[\s\S]*color:\s*var\(--accent\)/);
  assert.match(styles, /\.growth-source strong[\s\S]*color:\s*var\(--growth-accent\)/);
  assert.match(styles, /\.growth-poster-footer::before, \.growth-poster-footer::after[\s\S]*top:\s*-12px[\s\S]*height:\s*12px/);
  assert.match(styles, /@media \(min-width:\s*1101px\)[\s\S]*\.growth-plot-frame\s*\{\s*border-bottom:\s*0/);
  assert.match(styles, /@media \(max-width:\s*1100px\)[\s\S]*\.growth-poster-footer\s*\{\s*border-top:\s*0/);
  assert.match(styles, /\.growth-plot-scroll[\s\S]*flex-shrink:\s*0/);
  assert.match(styles, /\.growth-chart text\s*\{\s*text-rendering:\s*geometricPrecision/);
  assert.match(styles, /\.chart-axis-label[\s\S]*font:\s*500 18px var\(--mono\)/);
  assert.match(script, /new Intl\.DateTimeFormat\("en-GB"[\s\S]*timeZoneName:\s*"short"/);
  assert.match(script, /nextDailyRefresh[\s\S]*Date\.UTC[\s\S]*4, 17/);
  assert.match(script, /setupDataFreshness[\s\S]*explorer-refresh-time[\s\S]*localTimeLabel\(nextDailyRefresh\(\)\)[\s\S]*04:17 UTC/);
  assert.doesNotMatch(script, /navigator\.geolocation/);
});

test("all semantic communities remain available in a compact labeled rail", () => {
  assert.match(page, /id="graph-match-count"[\s\S]*id="graph-analysis"[^>]+aria-label="Plugin landscape community filters"[\s\S]*id="community-list"/);
  assert.doesNotMatch(page, /id="landscape-title"|id="community-toggle"|id="anchor-list"/);
  assert.match(script, /const leadingClusters = \[\.\.\.explorer\.clusters\][\s\S]*button\.setAttribute\("aria-label", `\$\{cluster\.label\}[\s\S]*community-name/);
  assert.match(styles, /\.graph-analysis\s*\{[\s\S]*bottom:\s*0[\s\S]*width:\s*102px/);
  assert.match(page, /id="community-scroll-fade"[^>]+aria-hidden="true"/);
  assert.doesNotMatch(page, /community-scroll-hint|>↓</);
  assert.match(styles, /\.community-list\s*\{[\s\S]*overflow-y:\s*auto[\s\S]*scrollbar-width:\s*none/);
  assert.match(styles, /\.community-list::\-webkit-scrollbar\s*\{\s*display:\s*none/);
  assert.match(styles, /\.community-scroll-fade\s*\{[\s\S]*pointer-events:\s*none[\s\S]*linear-gradient[\s\S]*opacity:\s*\.48/);
  assert.match(script, /syncCommunityScrollFade = \(\) =>[\s\S]*remaining <= 2/);
  assert.doesNotMatch(script, /communityScrollHint|communityScrollFade\.addEventListener\("click"/);
  assert.match(styles, /\.community-name\s*\{[\s\S]*font-size:\s*10px[\s\S]*line-height:\s*1\.25/);
  assert.match(script, /graphMatchCount\.textContent = query \? `\$\{number\.format\(matches\.size\)\} match/);
  assert.match(script, /rankedNodes\[Math\.min\(24, lastRankedIndex\)\]\?\.influence/);
  assert.match(script, /rankedNodes\[Math\.min\(80, lastRankedIndex\)\]\?\.influence/);
  assert.doesNotMatch(script, /rankedNodes\[(?:24|80)\]\.influence/);
  assert.match(script, /function drawCanvasLabel[\s\S]*context\.strokeText\(text, x, y\)[\s\S]*context\.fillText\(text, x, y\)/);
  assert.match(script, /const clusterLabels = \[\][\s\S]*clusterLabels\.push\([\s\S]*for \(const node of explorer\.nodes\)[\s\S]*for \(const label of clusterLabels\) drawCanvasLabel\(label\)/);
  assert.match(script, /opacity:\s*focus \? 1 : lightTheme \? \.72 : \.65/);
  assert.doesNotMatch(styles, /\.anchor-list|\.anchor-row|\.anchor-dot/);
  assert.match(page, /id="graph-method" class="status-method">Local TF-IDF similarity<\/span>/);
  assert.match(script, /document\.querySelector\("#graph-method"\)\.setAttribute\("aria-label", explorer\.method/);
  assert.match(script, /createExplorerSearchMatcher\(query\)/);
  assert.match(script, /graphReset\.addEventListener[\s\S]*allCommunities\.setAttribute\("aria-pressed", "true"\)[\s\S]*button\.setAttribute\("aria-pressed", "false"\)/);
  assert.match(styles, /\.detail-actions \.button\s*\{\s*justify-content:\s*center;\s*\}/);
  assert.doesNotMatch(styles, /\.explore-tabs button, \.explore-toolbar button\s*\{\s*transition:\s*none/);
});

test("selected plugins use a compact marketplace card hierarchy", () => {
  assert.match(page, /id="plugin-detail"[\s\S]*class="detail-card-header"[\s\S]*class="detail-card-preview"[\s\S]*class="detail-publisher"/);
  assert.match(page, /class="detail-card-context"[\s\S]*data-detail="community"[\s\S]*class="detail-stars"[\s\S]*data-detail="stars"/);
  assert.match(page, /class="detail-metrics"[\s\S]*Influence[\s\S]*Listed/);
  assert.doesNotMatch(page, /<dt>Stars<\/dt>|Nearest semantic neighbors/);
  assert.match(styles, /\.detail-card-preview\s*\{[\s\S]*width:\s*72px;\s*height:\s*48px[\s\S]*--detail-accent/);
  assert.match(styles, /\.detail-description\s*\{[\s\S]*font-size:\s*13px[\s\S]*-webkit-line-clamp:\s*2/);
  assert.match(styles, /\.detail-metrics\s*\{[\s\S]*grid-template-columns:\s*repeat\(2, 1fr\)/);
  assert.match(styles, /\.neighbor-list\s*\{[^}]*gap:\s*0/);
  assert.match(styles, /\.neighbor-row\s*\{[\s\S]*display:\s*grid[\s\S]*background:\s*transparent[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) auto/);
  assert.match(styles, /@media \(max-width:\s*760px\)[\s\S]*\.detail-close\s*\{[^}]*width:\s*44px;\s*height:\s*44px[\s\S]*\.detail-actions \.button, \.neighbor-row\s*\{\s*min-height:\s*44px/);
  assert.match(script, /function safePluginPreview[\s\S]*function pluginInitials/);
  assert.match(script, /previewImage\.onload[\s\S]*previewImage\.onerror[\s\S]*node\.tags\.slice\(0, 3\)/);
  assert.match(script, /Select related plugin \$\{candidate\.name\}, \$\{similarity\}% similarity/);
});

test("graph search uses catalog matching semantics", () => {
  const publisherNode = {
    id: "confined.ember",
    name: "Ember Tray",
    author: "Confined",
    description: "A floating status bar for Ember.",
    category: "Desktop",
    kind: "Bar widget",
    repo: "https://github.com/Confined-/Ember-Tray",
    tags: ["bar", "status"],
  };
  const unicodeNode = {
    id: "example.expose",
    name: "Exposé",
    author: "Example",
    description: "System & Network controls.",
    category: "System",
    kind: "Menu + Bar widget",
    repo: "https://github.com/example/expose",
    tags: ["network"],
  };

  assert.equal(repositoryPublisher(publisherNode.repo), "Confined-");
  assert.equal(matchesExplorerSearch("@", publisherNode), false);
  assert.equal(matchesExplorerSearch("@Confined-", publisherNode), true);
  assert.equal(matchesExplorerSearch("floating bar", publisherNode), true);
  assert.equal(matchesExplorerSearch("Expose\u0301", unicodeNode), true);
  assert.equal(matchesExplorerSearch("&", unicodeNode), true);
  assert.equal(matchesExplorerSearch("/", unicodeNode), false);
  assert.equal(matchesExplorerSearch("text:bar", publisherNode), true);
  assert.equal(matchesExplorerSearch("kind:bar-widget", publisherNode), true);
  assert.equal(matchesExplorerSearch("kind:menu-bar-widget", unicodeNode), true);
  assert.equal(matchesExplorerSearch("kind:bar-widget", unicodeNode), false);
});

test("growth presets count calendar days inclusively", () => {
  assert.equal(inclusiveRangeStart("2026-08-28", 7), "2026-08-22");
  assert.equal(inclusiveRangeStart("2026-08-28", 14), "2026-08-15");
  assert.equal(inclusiveDayCount("2026-08-22", "2026-08-28"), 7);
  assert.equal(inclusiveDayCount("2026-08-15", "2026-08-28"), 14);
  assert.match(script, /fromInput\.value = growthPresetFrom\(preset\)/);
  assert.match(script, /from === growthPresetFrom\(14\)/);
});

test("catalog writers publish catalog and Explorer data as one checksummed transaction", () => {
  const writers = [
    {
      name: "approval",
      workflow: approvalWorkflow,
      producer: workflowJobSource(approvalWorkflow, "approve", "publish"),
      consumer: workflowJobSource(approvalWorkflow, "publish", "deploy"),
    },
    {
      name: "refresh",
      workflow: refreshWorkflow,
      producer: workflowJobSource(refreshWorkflow, "refresh", "publish"),
      consumer: workflowJobSource(refreshWorkflow, "publish", "deploy"),
    },
    {
      name: "verification",
      workflow: verificationWorkflow,
      producer: workflowJobSource(verificationWorkflow, "analyze", "publish"),
      consumer: workflowJobSource(verificationWorkflow, "publish", "deploy"),
    },
  ];

  for (const { name, workflow, producer, consumer } of writers) {
    assert.match(producer, /fetch-depth: 0/, `${name} must check out complete catalog history`);
    assert.match(workflow, /explorer_sha:\s+\$\{\{ steps\.(?:bundle|catalog)\.outputs\.explorer_sha \}\}/, `${name} must expose the tested Explorer hash`);
    assert.match(producer, /cp site\/explorer-data\.json "\$bundle\/site\/explorer-data\.json"/, `${name} bundle must contain Explorer data`);
    assert.match(producer, /(?:find|sha256sum)[^\n]*site\/explorer-data\.json[^\n]*(?:\\\n[\s\S]*xargs -0 sha256sum|> SHA256SUMS)/, `${name} manifest must checksum Explorer data`);
    assert.match(producer, /read -r explorer_sha _ < <\(sha256sum site\/explorer-data\.json\)/, `${name} must record the Explorer hash`);
    assert.match(consumer, /EXPECTED_EXPLORER_SHA:\s+\$\{\{ needs\.(?:approve|refresh|analyze)\.outputs\.explorer_sha \}\}/, `${name} must carry the Explorer hash across jobs`);
    assert.match(consumer, /expected_files=[\s\S]*site\/explorer-data\.json/, `${name} exact file check must include Explorer data`);
    assert.match(consumer, /find "\$bundle" -type l -print -quit[\s\S]*unexpected symbolic link/, `${name} must reject symbolic links`);
    assert.match(consumer, /unsupported file type/, `${name} must reject non-regular artifact entries`);
    assert.match(consumer, /sha256sum --check SHA256SUMS/, `${name} must verify the publication manifest`);
    assert.match(consumer, /sha256sum "\$bundle\/site\/explorer-data\.json"[\s\S]*EXPECTED_EXPLORER_SHA/, `${name} must verify the tested Explorer hash`);
    assert.match(consumer, /cp "\$bundle\/site\/explorer-data\.json" site\/explorer-data\.json/, `${name} must apply Explorer data`);
    const catalogStageLines = workflow.match(/git add[^\n]*site\/catalog\.json[^\n]*/g) || [];
    assert.ok(catalogStageLines.length > 0, `${name} must stage the catalog`);
    assert.ok(catalogStageLines.every((line) => line.includes("site/explorer-data.json")), `${name} must stage catalog and Explorer data together`);
  }

  assert.match(approvalWorkflow, /find registry\.json site\/catalog\.json site\/explorer-data\.json site\/assets\/img\/plugins -type f/);
  assert.match(refreshWorkflow, /find site\/catalog\.json site\/explorer-data\.json site\/assets\/img\/plugins -type f/);
  const verificationProducer = workflowJobSource(verificationWorkflow, "analyze", "publish");
  assert.ok(verificationProducer.indexOf("node scripts/verify-listed-plugin.mjs") < verificationProducer.indexOf("run: npm run build:explorer"));
  assert.ok(verificationProducer.indexOf("run: npm run build:explorer") < verificationProducer.indexOf("run: npm test"));
  assert.match(workflowJobSource(verificationWorkflow, "publish", "deploy"), /git diff --exit-code -- \. ':!registry\.json' ':!site\/catalog\.json' ':!site\/explorer-data\.json'/);
});

test("all four Pages timeout paths require deployment, catalog, and Explorer identities", () => {
  const deployJobs = [
    workflowJobSource(approvalWorkflow, "deploy", "finalize"),
    workflowJobSource(refreshWorkflow, "deploy"),
    workflowJobSource(verificationWorkflow, "deploy", "report"),
    workflowJobSource(deploymentWorkflow, "deploy"),
  ];

  for (const deployJob of deployJobs) {
    assert.match(deployJob, /EXPECTED_DEPLOYMENT_ID:/);
    assert.match(deployJob, /EXPECTED_CATALOG_SHA:/);
    assert.match(deployJob, /EXPECTED_EXPLORER_SHA:/);
    assert.match(deployJob, /explorer-data\.json\?(?:deployment|verification)-check=/);
    assert.match(deployJob, /sha256sum "\$live_catalog"/);
    assert.match(deployJob, /sha256sum "\$live_explorer"/);
    assert.match(deployJob, /live_id == "\$EXPECTED_DEPLOYMENT_ID"[\s\S]*live_catalog_sha == "\$EXPECTED_CATALOG_SHA"[\s\S]*live_explorer_sha == "\$EXPECTED_EXPLORER_SHA"/);
    assert.match(deployJob, /expected catalog and Explorer data are live despite the Pages action timeout/);
  }

  assert.match(deploymentWorkflow, /explorer_sha:\s+\$\{\{ steps\.catalog\.outputs\.explorer_sha \}\}/);
  assert.match(deploymentWorkflow, /read -r explorer_sha _ < <\(sha256sum site\/explorer-data\.json\)/);
});

test("custom growth calendar follows the site theme and supports keyboard date navigation", () => {
  assert.match(styles, /\.growth-calendar\s*\{[\s\S]*border:\s*1px solid var\(--line-strong\)[\s\S]*background:\s*var\(--panel-2\)/);
  assert.doesNotMatch(styles, /\.growth-calendar\s*\{[\s\S]*border-left:\s*2px solid var\(--accent\)/);
  assert.match(styles, /\.growth-calendar-day\.is-selected[\s\S]*background:\s*var\(--accent\)[\s\S]*color:\s*var\(--accent-contrast\)/);
  assert.match(script, /function setupGrowthCalendar[\s\S]*ArrowLeft[\s\S]*ArrowRight[\s\S]*PageUp[\s\S]*PageDown[\s\S]*Escape/);
});

test("growth hover scrubs exact daily totals and dates inside the plot", () => {
  assert.match(page, /data-chart-hover-guide[\s\S]*class="chart-hover-line"[\s\S]*class="chart-hover-point"[\s\S]*class="chart-hover-box"[\s\S]*class="chart-hover-value"[\s\S]*class="chart-hover-date"/);
  assert.match(script, /function setupGrowthGuide[\s\S]*pointerX < chart\.left[\s\S]*pointerY < chart\.top[\s\S]*Math\.round\(ratio \* \(points\.length - 1\)\)/);
  assert.match(script, /guideValue\.textContent = `\$\{number\.format\(point\.total\)\} plugins`[\s\S]*guideDate\.textContent = posterDate\.format/);
  assert.match(script, /boxX = pointX \+ boxWidth \+ 16 > chart\.right[\s\S]*boxY = Math\.max\(chart\.top \+ 8/);
  assert.match(script, /data-chart-end-value[\s\S]*lineOverlapsEndValue[\s\S]*badgeOverlapsEndValue[\s\S]*classList\.toggle\("is-obscured"/);
  assert.match(styles, /\.chart-end-value\.is-obscured\s*\{\s*visibility:\s*hidden/);
});
