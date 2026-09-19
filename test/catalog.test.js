import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyVersionState,
  assertRecoverableCatalogError,
  buildCatalog,
  CatalogBuildError,
  CatalogCheckError,
  catalogErrorCode,
  catalogRefreshFailureMessage,
  catalogSourcePlan,
  communityInstall,
  currentCatalogApiUsage,
  failedSourcePlugins,
  githubApiFailure,
  parseGitHubRepository,
  readLimitedBuffer,
  repositoryReleaseForRefresh,
  snapshotHttpErrorCode,
  successfulState,
  upstreamCheckErrorCodes,
  validateBeforeStagingPreview,
} from "../scripts/build-catalog.mjs";
import {
  securityBaselineEnforcementMode,
  securityBaselineVersion,
} from "../scripts/security-baseline-policy.mjs";
import { catalogVerificationFields } from "../scripts/catalog-verification.mjs";
import {
  activityTime,
  isRecentlyAdded,
  isRecentlyUpdated,
  listingCheckState,
  listingTime,
  paginationState,
  pluginVersionLabel,
} from "../site/assets/js/shared.js";

const catalog = JSON.parse(await readFile(new URL("../site/catalog.json", import.meta.url), "utf8"));
const registry = JSON.parse(await readFile(new URL("../registry.json", import.meta.url), "utf8"));
const shaPattern = /^[a-f0-9]{40}$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function assertCommunityPluginState(plugin) {
  assert.match(plugin.repo, /^https:\/\/github\.com\//);
  assert.match(plugin.addedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(plugin.listedAt, timestampPattern);
  assert.match(plugin.listingValidatedCommit, shaPattern);
  assert.match(plugin.listingValidatedAt, timestampPattern);
  assert.match(plugin.upstreamObservedCommit, shaPattern);
  assert.match(plugin.upstreamValidatedCommit, shaPattern);
  assert.match(plugin.upstreamCheckedAt, timestampPattern);
  assert.match(plugin.upstreamValidatedAt, timestampPattern);
  assert.ok(["passed", "failed", "unreachable"].includes(plugin.upstreamCheckStatus));

  if (plugin.upstreamCheckStatus === "passed") {
    assert.equal(plugin.upstreamObservedCommit, plugin.upstreamValidatedCommit);
    assert.equal(plugin.upstreamCheckError, undefined);
    if (plugin.repositoryLayout === "root-plugin") {
      if (plugin.installAvailable) {
        assert.ok(plugin.installCommand);
      } else {
        assert.equal(plugin.installCommand, "");
        assert.equal(plugin.status, "Manual setup");
      }
    } else {
      assert.equal(plugin.installAvailable, false);
      assert.equal(plugin.installCommand, "");
      assert.ok(["monorepo", "suite"].includes(plugin.repositoryLayout));
    }
  } else if (plugin.upstreamCheckStatus === "failed") {
    assert.ok(upstreamCheckErrorCodes.includes(plugin.upstreamCheckError));
    assert.notEqual(plugin.upstreamCheckError, "repository-unreachable");
    assert.equal(plugin.installAvailable, false);
    assert.equal(plugin.installCommand, "");
    assert.equal(plugin.status, "Compatibility failed");
  } else {
    assert.equal(plugin.upstreamCheckError, "repository-unreachable");
    assert.equal(plugin.status, "Status unknown");
    if (plugin.repositoryLayout === "root-plugin" && plugin.installAvailable) {
      assert.ok(plugin.installCommand);
    } else {
      assert.equal(plugin.installAvailable, false);
      assert.equal(plugin.installCommand, "");
    }
  }
}

test("catalog IDs are unique", () => {
  const ids = catalog.plugins.map((plugin) => plugin.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("generated catalog verification fields match deterministic registry status", () => {
  const sources = new Map(registry.sources.map((source) => [
    parseGitHubRepository(source.repo).slug.toLowerCase(),
    source,
  ]));
  for (const plugin of catalog.plugins) {
    if (plugin.builtIn || (plugin.sourceType || "community") !== "community") {
      assert.equal(plugin.verificationStatus, undefined);
      assert.equal(plugin.verificationCommit, undefined);
      continue;
    }
    const source = sources.get(parseGitHubRepository(plugin.repo).slug.toLowerCase());
    assert.ok(source, `registry source for ${plugin.id}`);
    assert.deepEqual(
      Object.fromEntries(Object.entries(plugin).filter(([key]) => key.startsWith("verification"))),
      catalogVerificationFields(source, plugin),
    );
  }
});

test("generated previews contain no missing or orphaned files", async () => {
  const files = (await readdir(new URL("../site/assets/img/plugins/", import.meta.url))).sort();
  const referenced = [...new Set(catalog.plugins.flatMap((plugin) => [
    plugin.previewImage,
    plugin.previewThumbnail,
  ]).filter(Boolean).map((value) => value.split("/").at(-1)))].sort();
  assert.deepEqual(files, referenced);
});

test("catalog has no manual featured ranking", () => {
  assert.equal(catalog.plugins.some((plugin) => Object.hasOwn(plugin, "featured")), false);
  assert.equal(catalog.plugins.some((plugin) => Object.hasOwn(plugin, "releaseTag")), false);
  assert.equal(catalog.plugins.some((plugin) => Object.hasOwn(plugin, "releaseUpdatedAt")), false);
  assert.equal(catalog.stateSchemaVersion, 2);
});

test("listing checks distinguish passed, failed, and unreachable snapshots", () => {
  const listingCommit = "a".repeat(40);
  const compatibleCommit = "b".repeat(40);
  const observedCommit = "c".repeat(40);
  const common = {
    listingValidatedCommit: listingCommit,
    upstreamObservedCommit: observedCommit,
    upstreamValidatedCommit: compatibleCommit,
    upstreamValidatedAt: "2026-07-28T11:00:00.000Z",
  };

  assert.deepEqual(listingCheckState({
    ...common,
    upstreamCheckStatus: "passed",
    upstreamObservedCommit: compatibleCommit,
  }), {
    statusLabel: "Passed",
    statusTone: "is-passed",
    commitLabel: "Checked commit",
    checkedCommit: compatibleCommit,
    comparison: "changed",
  });

  assert.deepEqual(listingCheckState({
    ...common,
    upstreamCheckStatus: "failed",
  }), {
    statusLabel: "Failed",
    statusTone: "is-failed",
    commitLabel: "Checked commit",
    checkedCommit: observedCommit,
    lastCompatibleCommit: compatibleCommit,
    comparison: "changed",
  });

  assert.deepEqual(listingCheckState({
    ...common,
    upstreamCheckStatus: "unreachable",
  }), {
    statusLabel: "Status unknown",
    statusTone: "is-caution",
    commitLabel: "Last compatible",
    checkedCommit: compatibleCommit,
    lastSuccessfulAt: "2026-07-28T11:00:00.000Z",
    comparison: "unknown",
  });
});

test("listing checks normalize and fail closed on stale commit metadata", () => {
  const listingCommit = "a".repeat(40);
  const changedCommit = "b".repeat(40);

  assert.deepEqual(listingCheckState({
    listingValidatedCommit: listingCommit.toUpperCase(),
    upstreamObservedCommit: listingCommit,
    upstreamValidatedCommit: changedCommit,
    upstreamCheckStatus: "passed",
  }), {
    statusLabel: "Passed",
    statusTone: "is-passed",
    commitLabel: "Checked commit",
    checkedCommit: listingCommit,
    comparison: "unchanged",
  });

  assert.deepEqual(listingCheckState({
    listingValidatedCommit: listingCommit,
    upstreamValidatedCommit: changedCommit,
    upstreamCheckStatus: "passed",
  }), {
    statusLabel: "Passed",
    statusTone: "is-passed",
    commitLabel: "Checked commit",
    checkedCommit: changedCommit,
    comparison: "changed",
  });

  assert.deepEqual(listingCheckState({
    listingValidatedCommit: listingCommit,
    upstreamObservedCommit: "malformed",
    upstreamValidatedCommit: changedCommit.toUpperCase(),
    upstreamCheckStatus: "passed",
  }), {
    statusLabel: "Passed",
    statusTone: "is-passed",
    commitLabel: "Checked commit",
    checkedCommit: changedCommit,
    comparison: "changed",
  });

  assert.deepEqual(listingCheckState({
    listingValidatedCommit: listingCommit,
    upstreamObservedCommit: "malformed",
    upstreamValidatedCommit: "also-malformed",
    upstreamCheckStatus: "passed",
  }), {
    statusLabel: "Passed",
    statusTone: "is-passed",
    commitLabel: "Checked commit",
    checkedCommit: "",
    comparison: "unknown",
  });
});

test("catalog pagination clamps pages and exposes stable boundaries", () => {
  assert.deepEqual(paginationState(9, 1), {
    page: 1,
    totalPages: 1,
    start: 0,
    end: 9,
    hasPrevious: false,
    hasNext: false,
  });
  assert.deepEqual(paginationState(33, 2), {
    page: 2,
    totalPages: 4,
    start: 9,
    end: 18,
    hasPrevious: true,
    hasNext: true,
  });
  assert.deepEqual(paginationState(33, 99), {
    page: 4,
    totalPages: 4,
    start: 27,
    end: 33,
    hasPrevious: true,
    hasNext: false,
  });
});

test("community plugins preserve the invariants of every upstream check state", () => {
  for (const plugin of catalog.plugins) {
    assert.match(plugin.repo, /^https:\/\/github\.com\//);
    if (!plugin.placeholder && !plugin.builtIn) {
      assertCommunityPluginState(plugin);
    }
  }
});

test("failed and unreachable catalog records satisfy their state invariants", () => {
  const common = {
    id: "example.weather",
    repo: "https://github.com/example/weather",
    addedAt: "2026-07-28",
    listedAt: "2026-07-28T10:00:00.000Z",
    listingValidatedCommit: "a".repeat(40),
    listingValidatedAt: "2026-07-28T10:00:00.000Z",
    listingValidatedBranch: "main",
    upstreamObservedCommit: "c".repeat(40),
    upstreamObservedBranch: "main",
    upstreamCheckedAt: "2026-07-28T13:00:00.000Z",
    upstreamValidatedCommit: "b".repeat(40),
    upstreamValidatedAt: "2026-07-28T11:00:00.000Z",
    repositoryLayout: "root-plugin",
  };
  assertCommunityPluginState({
    ...common,
    upstreamCheckStatus: "failed",
    upstreamCheckError: "entry-point-missing",
    installAvailable: false,
    installCommand: "",
    status: "Compatibility failed",
  });
  assertCommunityPluginState({
    ...common,
    upstreamCheckStatus: "unreachable",
    upstreamCheckError: "repository-unreachable",
    installAvailable: true,
    installCommand: "omarchy plugin add https://github.com/example/weather.git --enable",
    status: "Status unknown",
  });
});

test("manual installation overrides are explicit and restricted to root plugins", () => {
  const source = { repo: "https://github.com/example/native-plugin" };
  const note = "This plugin requires a matching native helper.";
  assert.deepEqual(
    communityInstall(source, "manifest.json", {
      installation: { mode: "manual", note },
    }),
    {
      repositoryLayout: "root-plugin",
      installAvailable: false,
      installCommand: "",
      installNote: note,
    },
  );
  assert.throws(
    () => communityInstall(source, "manifest.json", {
      installation: { mode: "script", note },
    }),
    /invalid manual installation override/,
  );
  assert.throws(
    () => communityInstall(source, "nested/manifest.json", {
      installation: { mode: "manual", note },
    }),
    /invalid manual installation override/,
  );
});

test("root plugins that clone a first-party service ask for a shell restart", () => {
  const source = { repo: "https://github.com/example/idle-swap" };
  const plain = communityInstall(source, "manifest.json", {});
  assert.equal(
    plain.installCommand,
    "omarchy plugin add https://github.com/example/idle-swap.git --enable",
  );
  assert.equal("clonedFrom" in plain, false);

  const swapped = communityInstall(source, "manifest.json", {}, "omarchy.idle");
  assert.equal(
    swapped.installCommand,
    "omarchy plugin add https://github.com/example/idle-swap.git --enable && omarchy restart shell",
  );
  assert.match(swapped.installNote, /replaces the built-in omarchy\.idle service/);
  assert.match(swapped.installNote, /shell needs a restart/);
  assert.equal(swapped.clonedFrom, "omarchy.idle");
});

test("a manual installation override is unaffected by clonedFrom", () => {
  const source = { repo: "https://github.com/example/native-plugin" };
  const note = "This plugin requires a matching native helper.";
  assert.deepEqual(
    communityInstall(source, "manifest.json", { installation: { mode: "manual", note } }, "omarchy.idle"),
    {
      repositoryLayout: "root-plugin",
      installAvailable: false,
      installCommand: "",
      installNote: note,
    },
  );
});

test("built-in plugins are separated from installable community plugins", () => {
  const builtIns = catalog.plugins.filter((plugin) => plugin.builtIn);
  assert.ok(builtIns.length > 20);
  for (const plugin of builtIns) {
    assert.equal(plugin.sourceType, "builtin");
    assert.equal(plugin.installCommand, "");
    assert.match(plugin.officialCommand, /^omarchy (?:bar plugin add|plugin enable) omarchy\./);
    assert.ok(["Add to bar", "Enable plugin"].includes(plugin.officialCommandLabel));
    assert.equal(plugin.addedAt, undefined);
    assert.match(plugin.id, /^omarchy\./);
    assert.equal(plugin.repo, "https://github.com/omacom/omarchy");
    assert.match(plugin.sourceUrl, /^https:\/\/github\.com\/omacom\/omarchy\/tree\/[a-f0-9]{40}\//);
  }
  assert.ok(catalog.plugins.find((plugin) => plugin.id === "omarchy.agents")?.tags.includes("ai"));
  assert.ok(catalog.plugins.find((plugin) => plugin.id === "omarchy.polkit")?.tags.includes("security"));
});

test("Taildrop is replaced by the built-in Tailscale panel", () => {
  assert.equal(catalog.plugins.some((plugin) => plugin.id === "taildrop"), false);
  const tailscale = catalog.plugins.find((plugin) => plugin.id === "omarchy.tailscale");
  assert.equal(tailscale?.builtIn, true);
  assert.equal(tailscale?.status, "Built in");
});

test("stars represent repository stars and are shared by plugins from the same repository", () => {
  const community = catalog.plugins.filter((plugin) => plugin.sourceType === "community" && !plugin.placeholder);
  const repositories = new Map();
  for (const plugin of community) {
    repositories.set(plugin.repo, [...(repositories.get(plugin.repo) || []), plugin]);
  }
  for (const plugins of repositories.values()) {
    assert.equal(new Set(plugins.map((plugin) => plugin.stars)).size, 1);
    assert.ok(Number.isInteger(plugins[0].stars));
    assert.ok(plugins[0].stars >= 0);
  }
});

test("root plugins default to Quattro while curated exceptions use manual setup", () => {
  const overview = catalog.plugins.find((plugin) => plugin.id === "omarchy-overview");
  assert.equal(
    overview?.installCommand,
    "omarchy plugin add https://github.com/AyushKr2003/omarchy-overview.git --enable",
  );

  const nearby = catalog.plugins.find((plugin) => plugin.id === "oma.nearby");
  assert.equal(nearby?.repositoryLayout, "root-plugin");
  assert.equal(nearby?.installAvailable, false);
  assert.equal(nearby?.installCommand, "");
  assert.equal(nearby?.status, "Manual setup");
  assert.equal(
    nearby?.installNote,
    "Nearby requires a version-matched native helper. Follow the upstream installation instructions to install the plugin and helper together.",
  );

  const typeFlow = catalog.plugins.find((plugin) => plugin.id === "hypr-type-flow");
  assert.equal(typeFlow?.repositoryLayout, "root-plugin");
  assert.equal(typeFlow?.installAvailable, false);
  assert.equal(typeFlow?.installCommand, "");
  assert.equal(typeFlow?.status, "Manual setup");
  assert.equal(
    typeFlow?.installNote,
    "This plugin requires additional setup before it can be enabled. Follow the upstream installation instructions.",
  );

  const ytdl = catalog.plugins.find((entry) => entry.id === "bibek.ytdl");
  assert.equal(ytdl?.repositoryLayout, "root-plugin");
  assert.equal(ytdl?.installAvailable, false);
  assert.equal(ytdl?.installCommand, "");
  assert.equal(ytdl?.status, "Manual setup");
  assert.equal(ytdl?.installNote, "This plugin requires additional setup before it can be enabled. Follow the upstream installation instructions.");
  const ytdlSource = registry.sources.find((source) => source.repo === "https://github.com/BibekBhusal0/omarchy-ytdl");
  assert.deepEqual(ytdlSource?.plugins?.["bibek.ytdl"]?.installation, {
    mode: "manual",
    note: "This plugin requires additional setup before it can be enabled. Follow the upstream installation instructions.",
  });

  for (const [id, repository] of [
    ["nille.emeet-pixy", "https://github.com/nille/omarchy-emeet-pixy.git"],
    ["ky.seerr-requests", "https://github.com/Kyrunner/omarchy-seerr-requests.git"],
    ["tmn73.calendar", "https://github.com/tmn73/omarchy-calendar.git"],
  ]) {
    const plugin = catalog.plugins.find((entry) => entry.id === id);
    assert.equal(plugin?.repositoryLayout, "root-plugin");
    assert.equal(plugin?.installAvailable, true);
    assert.equal(plugin?.installCommand, `omarchy plugin add ${repository} --enable`);
    assert.equal(plugin?.status, "Available");
  }

  for (const id of ["omni", "quickapps-hud", "cliamp"]) {
    const plugin = catalog.plugins.find((entry) => entry.id === id);
    assert.equal(plugin?.repositoryLayout, "monorepo");
    assert.equal(plugin?.installAvailable, false);
    assert.equal(plugin?.installCommand, "");
  }
  const lacuna = catalog.plugins.find((entry) => entry.id === "lacuna.shell-suite");
  assert.equal(lacuna?.repositoryLayout, "suite");
  assert.equal(lacuna?.installAvailable, false);
});

test("recently added badges use a 12-hour listing window", () => {
  const now = Date.parse("2026-07-28T12:00:00Z");
  assert.equal(isRecentlyAdded({ listedAt: "2026-07-28T00:00:00.001Z" }, now), true);
  assert.equal(isRecentlyAdded({ listedAt: "2026-07-28T00:00:00.000Z" }, now), false);
  assert.equal(isRecentlyAdded({ listedAt: "2026-07-28T12:00:00.001Z" }, now), false);
  assert.equal(isRecentlyAdded({ listedAt: "2026-07-28T11:00:00.000Z", placeholder: true }, now), false);
  assert.equal(isRecentlyAdded({ listedAt: "2026-07-28T11:00:00.000Z", builtIn: true }, now), false);
});

test("recently added ordering uses the exact listing time", () => {
  const plugins = [
    { name: "Alpha", addedAt: "2026-07-28", listedAt: "2026-07-28T08:00:00.000Z" },
    { name: "Zulu", addedAt: "2026-07-28", listedAt: "2026-07-28T11:00:00.000Z" },
  ];
  plugins.sort((left, right) => listingTime(right) - listingTime(left));
  assert.deepEqual(plugins.map((plugin) => plugin.name), ["Zulu", "Alpha"]);
});

test("recent activity uses the newest valid plugin timestamp", () => {
  assert.equal(
    activityTime({
      versionUpdatedAt: "2026-07-29T15:17:29.377Z",
      repositoryUpdatedAt: "2026-07-29T16:00:00.000Z",
    }),
    Date.parse("2026-07-29T16:00:00.000Z"),
  );
  assert.equal(
    activityTime({ versionUpdatedAt: "2026-07-29T15:17:29.377Z" }),
    Date.parse("2026-07-29T15:17:29.377Z"),
  );
  assert.equal(
    activityTime({ versionUpdatedAt: "invalid", repositoryUpdatedAt: "also-invalid" }),
    0,
  );
});

test("manifest version changes create a 12-hour updated state", () => {
  const detectedAt = "2026-07-28T12:00:00.000Z";
  const plugins = [
    { id: "new-plugin", version: "1.0.0" },
    { id: "updated-plugin", version: "2.0.0" },
    { id: "unchanged-plugin", version: "1.0.0" },
  ];
  const previous = [
    { id: "updated-plugin", version: "1.0.0" },
    {
      id: "unchanged-plugin",
      version: "1.0.0",
      versionUpdatedAt: "2026-07-27T09:00:00.000Z",
    },
  ];

  const result = applyVersionState(plugins, previous, detectedAt);
  assert.equal(result.find((plugin) => plugin.id === "new-plugin").versionUpdatedAt, undefined);
  assert.equal(result.find((plugin) => plugin.id === "updated-plugin").versionUpdatedAt, detectedAt);
  assert.equal(
    result.find((plugin) => plugin.id === "unchanged-plugin").versionUpdatedAt,
    "2026-07-27T09:00:00.000Z",
  );
  assert.equal(
    isRecentlyUpdated(
      result.find((plugin) => plugin.id === "updated-plugin"),
      Date.parse("2026-07-28T23:59:59.999Z"),
    ),
    true,
  );
  assert.equal(
    isRecentlyUpdated(
      result.find((plugin) => plugin.id === "updated-plugin"),
      Date.parse("2026-07-29T00:00:00.000Z"),
    ),
    false,
  );
});

test("catalog refresh failures identify the safe repository slug and error code", () => {
  assert.equal(
    catalogRefreshFailureMessage(
      "https://github.com/example/weather",
      new CatalogCheckError("repository-unreachable", "token and upstream detail stay private"),
    ),
    "Catalog source refresh failed for example/weather [repository-unreachable].",
  );
  assert.equal(
    catalogRefreshFailureMessage(
      "https://github.com/omacom-io/omarchy",
      new CatalogCheckError("manifest-invalid", "private detail"),
      { builtIn: true },
    ),
    "Built-in catalog refresh failed for omacom-io/omarchy [manifest-invalid].",
  );
});

test("approval catalog plans refresh only the exact approved source", () => {
  const registry = {
    sources: [
      { repo: "https://github.com/example/one" },
      { repo: "https://github.com/Example/Two.git" },
      { repo: "https://github.com/example/three" },
    ],
  };
  const full = catalogSourcePlan(registry);
  assert.equal(full.incremental, false);
  assert.deepEqual(full.refreshSources, registry.sources);

  const approved = catalogSourcePlan(registry, "example/two");
  assert.equal(approved.incremental, true);
  assert.equal(approved.approvedSource, registry.sources[1]);
  assert.deepEqual(approved.refreshSources, [registry.sources[1]]);
  assert.throws(
    () => catalogSourcePlan(registry, "example/missing"),
    /is not registered/,
  );
});

test("full refreshes preserve release metadata without optional GitHub API requests", async () => {
  const repository = "https://github.com/example/target";
  const release = {
    tag: "v1.2.3",
    url: "https://github.com/example/target/releases/tag/v1.2.3",
    publishedAt: "2026-08-15T09:30:00.000Z",
  };
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    throw new Error("Full refresh attempted an optional release request");
  };

  try {
    const result = await repositoryReleaseForRefresh(
      {},
      { repo: repository },
      [
        { repo: "https://github.com/example/foreign", repositoryRelease: { tag: "v9" } },
        { repo: repository, repositoryRelease: { ...release, ignored: "not preserved" } },
      ],
      false,
    );
    assert.deepEqual(result, release);
    assert.equal(requestCount, 0);
    assert.equal(
      await repositoryReleaseForRefresh({}, { repo: repository }, [], false),
      undefined,
    );
    assert.equal(
      await repositoryReleaseForRefresh(
        {},
        { repo: repository },
        [{
          repo: repository,
          repositoryRelease: {
            tag: "v1.2.3",
            url: "https://github.com/example/foreign/releases/tag/v1.2.3",
          },
        }],
        false,
      ),
      undefined,
    );
    assert.equal(
      await repositoryReleaseForRefresh(
        {},
        { repo: repository },
        [{
          repo: repository,
          repositoryRelease: {
            tag: "\ud800",
            url: "https://github.com/example/target/tree/invalid",
          },
        }],
        false,
      ),
      undefined,
    );
    const maximumTag = "a".repeat(256);
    assert.deepEqual(
      await repositoryReleaseForRefresh(
        {},
        { repo: repository },
        [{
          repo: repository,
          repositoryRelease: {
            tag: maximumTag,
            url: `https://github.com/example/target/tree/${maximumTag}`,
            publishedAt: `${"0".repeat(1_000)}2026-08-15T09:30:00Z`,
          },
        }],
        false,
      ),
      {
        tag: maximumTag,
        url: `https://github.com/example/target/tree/${maximumTag}`,
      },
    );
    assert.equal(
      await repositoryReleaseForRefresh(
        {},
        { repo: repository },
        [{
          repo: repository,
          repositoryRelease: {
            tag: "a".repeat(257),
            url: `https://github.com/example/target/tree/${"a".repeat(257)}`,
          },
        }],
        false,
      ),
      undefined,
    );
    const astralTag = "v1-😀";
    assert.deepEqual(
      await repositoryReleaseForRefresh(
        {},
        { repo: repository },
        [{
          repo: repository,
          repositoryRelease: {
            tag: astralTag,
            url: `https://github.com/example/target/tree/${encodeURIComponent(astralTag)}`,
          },
        }],
        false,
      ),
      {
        tag: astralTag,
        url: `https://github.com/example/target/tree/${encodeURIComponent(astralTag)}`,
      },
    );
    for (const bidiTag of ["v1-\u202e", "v1-\u2066"]) {
      assert.equal(
        await repositoryReleaseForRefresh(
          {},
          { repo: repository },
          [{
            repo: repository,
            repositoryRelease: {
              tag: bidiTag,
              url: `https://github.com/example/target/tree/${encodeURIComponent(bidiTag)}`,
            },
          }],
          false,
        ),
        undefined,
      );
    }
    assert.equal(requestCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("incremental release refreshes preserve safe metadata after temporary API failures", async () => {
  const repositoryUrl = "https://github.com/example/target";
  const source = { repo: repositoryUrl };
  const repository = parseGitHubRepository(repositoryUrl);
  const release = {
    tag: "v1.2.3",
    url: "https://github.com/example/target/releases/tag/v1.2.3",
    publishedAt: "2026-08-15T09:30:00Z",
  };
  const previousPlugins = [{ repo: repositoryUrl, repositoryRelease: release }];
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () => new Response(null, { status: 500 });
    assert.deepEqual(
      await repositoryReleaseForRefresh(
        { repository },
        source,
        previousPlugins,
        true,
      ),
      release,
    );

    globalThis.fetch = async () => new Response(null, {
      status: 403,
      headers: {
        "x-ratelimit-limit": "5000",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "1787723664",
      },
    });
    await assert.rejects(
      repositoryReleaseForRefresh({ repository }, source, previousPlugins, true),
      (error) => error instanceof CatalogBuildError && error.code === "rate-limit-exhausted",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("full catalog builds reserve GitHub API requests for exact snapshot checks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "marketplace-full-refresh-"));
  const registryPath = join(directory, "registry.json");
  const catalogPath = join(directory, "site/catalog.json");
  const previewDirectory = join(directory, "site/assets/img/plugins");
  const targetRepo = "https://github.com/example/target";
  const targetCommit = "a".repeat(40);
  const treeSha = "b".repeat(40);
  const release = {
    tag: "v1.2.3",
    url: "https://github.com/example/target/releases/tag/v1.2.3",
    publishedAt: "2026-08-15T09:30:00Z",
  };
  const source = {
    repo: targetRepo,
    type: "plugin-source",
    addedAt: "2026-08-15",
    listedAt: "2026-08-15T10:00:00.000Z",
    listingValidatedCommit: targetCommit,
    listingValidatedAt: "2026-08-15T10:00:00.000Z",
    listingValidatedBranch: "main",
    automatedSecurityBaseline: {
      version: securityBaselineVersion,
      commit: targetCommit,
      checkedAt: "2026-08-15T10:00:00.000Z",
      outcome: "passed",
      enforcementMode: securityBaselineEnforcementMode,
      findings: [],
      capabilities: [],
    },
    plugins: {
      "example.target": {
        category: "Desktop",
        tags: ["overlay"],
      },
    },
  };
  const previous = {
    generatedAt: "2026-08-15T09:00:00.000Z",
    stateSchemaVersion: 2,
    mode: "production",
    plugins: [{
      id: "example.target",
      repo: targetRepo,
      version: "1.0.0",
      repositoryRelease: release,
    }],
    warnings: [],
  };
  const manifest = {
    schemaVersion: 1,
    id: "example.target",
    name: "Target",
    version: "1.0.0",
    author: "Example",
    description: "Target plugin",
    license: "MIT",
    kinds: ["overlay"],
    entryPoints: { overlay: "Main.qml" },
  };
  const requestUrls = [];
  const originalFetch = globalThis.fetch;
  await mkdir(previewDirectory, { recursive: true });
  await writeFile(registryPath, `${JSON.stringify({
    sources: [source],
    builtInSources: [],
    placeholders: [],
  }, null, 2)}\n`);
  await writeFile(catalogPath, `${JSON.stringify(previous, null, 2)}\n`);
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    requestUrls.push(url);
    if (url === "https://api.github.com/graphql") {
      const request = JSON.parse(init.body);
      if (request.query.includes("CatalogRefreshBudget")) {
        return new Response(JSON.stringify({
          data: { rateLimit: { cost: 1, limit: 5000, remaining: 4999, resetAt: "2026-08-15T11:00:00Z" } },
        }), { status: 200 });
      }
      assert.match(request.query, /CatalogRefreshIdentities/);
      assert.deepEqual(request.variables, {
        owner0: "example",
        name0: "target",
        ref0: "refs/heads/__marketplace_default_branch_not_configured__",
      });
      return new Response(JSON.stringify({
        data: {
          r0: {
            id: "R_kgDOExample",
            databaseId: 123456789,
            nameWithOwner: "example/target",
            isArchived: false,
            isDisabled: false,
            isPrivate: false,
            stargazerCount: 7,
            pushedAt: "2026-08-15T09:30:00.000Z",
            updatedAt: "2026-08-15T09:30:00.000Z",
            defaultBranchRef: {
              name: "main",
              target: { oid: targetCommit, tree: { oid: treeSha } },
            },
            configuredRef: null,
          },
          rateLimit: { cost: 1, limit: 5000, remaining: 4998, resetAt: "2026-08-15T11:00:00Z" },
        },
      }), { status: 200 });
    }
    if (url === "https://api.github.com/rate_limit") {
      return new Response(JSON.stringify({
        resources: { core: { limit: 5000, remaining: 4998, reset: 1786788000 } },
      }), { status: 200 });
    }
    if (url === `https://api.github.com/repos/example/target/git/trees/${treeSha}?recursive=1`) {
      return new Response(JSON.stringify({
        truncated: false,
        tree: [
          { path: "README.md", type: "blob", mode: "100644", size: 10 },
          { path: "LICENSE", type: "blob", mode: "100644", size: 10 },
          { path: "manifest.json", type: "blob", mode: "100644", size: 200 },
          { path: "Main.qml", type: "blob", mode: "100644", size: 10 },
        ],
      }), { status: 200 });
    }
    if (url === `https://raw.githubusercontent.com/example/target/${targetCommit}/manifest.json`) {
      const body = JSON.stringify(manifest);
      return new Response(body, {
        status: 200,
        headers: { "content-length": String(Buffer.byteLength(body)) },
      });
    }
    throw new Error(`Unexpected fixture request: ${url}`);
  };

  try {
    await buildCatalog({ registryPath, catalogPath, previewDirectory });
    const result = JSON.parse(await readFile(catalogPath, "utf8"));
    const target = result.plugins.find((plugin) => plugin.id === "example.target");
    assert.equal(target?.upstreamObservedCommit, targetCommit);
    assert.equal(target?.upstreamValidatedCommit, targetCommit);
    assert.deepEqual(target?.repositoryRelease, release);
    assert.deepEqual(
      requestUrls.filter((url) => url.startsWith("https://api.github.com/")),
      [
        "https://api.github.com/graphql",
        "https://api.github.com/graphql",
        "https://api.github.com/rate_limit",
        `https://api.github.com/repos/example/target/git/trees/${treeSha}?recursive=1`,
      ],
    );
    assert.deepEqual(currentCatalogApiUsage(), {
      graphqlRequests: 2,
      graphqlPoints: 2,
      rawRequests: 1,
      restOtherRequests: 0,
      restRateLimitRequests: 1,
      restTreeRequests: 1,
    });
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("incremental approval builds preserve unrelated catalog and preview state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "marketplace-incremental-"));
  const registryPath = join(directory, "registry.json");
  const catalogPath = join(directory, "site/catalog.json");
  const previewDirectory = join(directory, "site/assets/img/plugins");
  const targetRepo = "https://github.com/example/target";
  const targetCommit = "a".repeat(40);
  const treeSha = "b".repeat(40);
  const foreignPlugin = {
    id: "example.foreign",
    name: "Foreign",
    repo: "https://github.com/example/foreign",
    sourceType: "community",
    verificationStatus: "unverified",
    verificationSnapshotStatus: "unverified",
    verificationCoverage: "unverified",
    previewImage: "assets/img/plugins/foreign-detail.webp",
    previewThumbnail: "assets/img/plugins/foreign-card.webp",
  };
  const registry = {
    sources: [
      {
        repo: foreignPlugin.repo,
        type: "plugin-source",
        plugins: { [foreignPlugin.id]: {} },
      },
      {
        repo: targetRepo,
        type: "plugin-source",
        addedAt: "2026-08-15",
        listedAt: "2026-08-15T10:00:00.000Z",
        listingValidatedCommit: targetCommit,
        listingValidatedAt: "2026-08-15T10:00:00.000Z",
        listingValidatedBranch: "main",
        automatedSecurityBaseline: {
          version: securityBaselineVersion,
          commit: targetCommit,
          checkedAt: "2026-08-15T10:00:00.000Z",
          outcome: "passed",
          enforcementMode: securityBaselineEnforcementMode,
          findings: [],
          capabilities: [],
        },
        plugins: {
          "example.target": {
            category: "Desktop",
            tags: ["overlay"],
          },
        },
      },
    ],
    builtInSources: [],
    placeholders: [],
  };
  const previous = {
    generatedAt: "2026-08-15T09:00:00.000Z",
    stateSchemaVersion: 1,
    mode: "production",
    plugins: [foreignPlugin],
    warnings: [
      "foreign warning remains byte-for-byte",
      `${targetRepo}: stale target warning`,
    ],
  };
  const manifest = {
    schemaVersion: 1,
    id: "example.target",
    name: "Target",
    version: "1.0.0",
    author: "Example",
    description: "Target plugin",
    license: "MIT",
    kinds: ["overlay"],
    entryPoints: { overlay: "Main.qml" },
  };
  const apiUrls = [];
  const originalFetch = globalThis.fetch;
  await mkdir(previewDirectory, { recursive: true });
  await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  await writeFile(catalogPath, `${JSON.stringify(previous, null, 2)}\n`);
  await writeFile(join(previewDirectory, "foreign-card.webp"), "foreign-card-bytes");
  await writeFile(join(previewDirectory, "foreign-detail.webp"), "foreign-detail-bytes");
  globalThis.fetch = async (input) => {
    const url = String(input);
    apiUrls.push(url);
    if (url === "https://api.github.com/repos/example/target") {
      return new Response(JSON.stringify({
        private: false,
        disabled: false,
        archived: false,
        default_branch: "main",
        stargazers_count: 7,
        pushed_at: "2026-08-15T09:30:00.000Z",
      }), { status: 200 });
    }
    if (url === `https://api.github.com/repos/example/target/commits/${targetCommit}`) {
      return new Response(JSON.stringify({
        sha: targetCommit,
        commit: { tree: { sha: treeSha } },
      }), { status: 200 });
    }
    if (url === `https://api.github.com/repos/example/target/git/trees/${treeSha}?recursive=1`) {
      return new Response(JSON.stringify({
        truncated: false,
        tree: [
          { path: "README.md", type: "blob", mode: "100644", size: 10 },
          { path: "LICENSE", type: "blob", mode: "100644", size: 10 },
          { path: "manifest.json", type: "blob", mode: "100644", size: 200 },
          { path: "Main.qml", type: "blob", mode: "100644", size: 10 },
        ],
      }), { status: 200 });
    }
    if (url === "https://api.github.com/repos/example/target/releases/latest") {
      return new Response("not found", { status: 404 });
    }
    if (url === "https://api.github.com/repos/example/target/tags?per_page=1") {
      return new Response(JSON.stringify([{ name: "v2.0.0" }]), { status: 200 });
    }
    if (url === `https://raw.githubusercontent.com/example/target/${targetCommit}/manifest.json`) {
      return new Response(JSON.stringify(manifest), {
        status: 200,
        headers: { "content-length": String(Buffer.byteLength(JSON.stringify(manifest))) },
      });
    }
    throw new Error(`Unexpected fixture request: ${url}`);
  };

  try {
    await buildCatalog({
      registryPath,
      catalogPath,
      previewDirectory,
      approvedRepository: "example/target",
      approvedCommit: targetCommit,
    });
    const result = JSON.parse(await readFile(catalogPath, "utf8"));
    assert.deepEqual(result.plugins.find((plugin) => plugin.id === foreignPlugin.id), foreignPlugin);
    const verifiedTarget = result.plugins.find((plugin) => plugin.id === "example.target");
    assert.equal(verifiedTarget?.repo, targetRepo);
    assert.equal(verifiedTarget?.verificationStatus, "verified");
    assert.equal(verifiedTarget?.verificationCommit, targetCommit);
    assert.deepEqual(verifiedTarget?.repositoryRelease, {
      tag: "v2.0.0",
      url: "https://github.com/example/target/tree/v2.0.0",
    });
    assert.deepEqual(result.warnings, ["foreign warning remains byte-for-byte"]);
    assert.equal(await readFile(join(previewDirectory, "foreign-card.webp"), "utf8"), "foreign-card-bytes");
    assert.equal(await readFile(join(previewDirectory, "foreign-detail.webp"), "utf8"), "foreign-detail-bytes");
    assert.equal(apiUrls.filter((url) => url.startsWith("https://api.github.com/")).length, 5);
    assert.ok(apiUrls.every((url) => !url.includes("example/foreign")));
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("GitHub API limits abort catalog builds instead of degrading sources", () => {
  const reset = "1786705200";
  const exhausted = githubApiFailure(new Response(null, {
    status: 403,
    headers: {
      "x-ratelimit-limit": "1000",
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": reset,
    },
  }));
  assert.ok(exhausted instanceof CatalogBuildError);
  assert.equal(exhausted.code, "rate-limit-exhausted");
  assert.match(exhausted.message, /limit 1000/);
  assert.match(exhausted.message, /remaining 0/);
  assert.match(exhausted.message, new RegExp(`reset ${reset}`));
  assert.equal(catalogErrorCode(exhausted), "rate-limit-exhausted");
  assert.equal(upstreamCheckErrorCodes.includes("rate-limit-exhausted"), false);
  assert.throws(() => assertRecoverableCatalogError(exhausted), (error) => error === exhausted);

  const throttled = githubApiFailure(new Response(null, {
    status: 429,
    headers: { "retry-after": "60" },
  }));
  assert.equal(throttled.code, "rate-limit-exhausted");
  assert.match(throttled.message, /retryAfter 60s/);

  const forbidden = githubApiFailure(new Response(null, {
    status: 403,
    headers: { "x-ratelimit-remaining": "42" },
  }));
  assert.equal(forbidden.code, "github-api-forbidden");
  assert.throws(() => assertRecoverableCatalogError(forbidden), (error) => error === forbidden);
  assert.equal(githubApiFailure(new Response(null, { status: 404 })), null);
});

test("upstream checks preserve last-known-good state across failures", () => {
  const source = {
    repo: "https://github.com/example/weather",
    listingValidatedCommit: "a".repeat(40),
    listingValidatedAt: "2026-07-28T10:00:00.000Z",
    listingValidatedBranch: "main",
  };
  const previous = {
    id: "example.weather",
    repo: source.repo,
    version: "1.0.0",
    repositoryLayout: "root-plugin",
    installAvailable: true,
    installCommand: "omarchy plugin add https://github.com/example/weather.git --enable",
    upstreamObservedCommit: "b".repeat(40),
    upstreamObservedBranch: "main",
    upstreamValidatedCommit: "b".repeat(40),
    upstreamValidatedAt: "2026-07-28T11:00:00.000Z",
    upstreamCheckStatus: "passed",
    verificationStatus: "verified",
    verificationBaselineVersion: securityBaselineVersion,
    verificationCommit: source.listingValidatedCommit,
    verificationCheckedAt: "2026-07-28T10:30:00.000Z",
    repositoryRelease: {
      tag: "v1.0.0",
      url: "https://github.com/example/foreign/releases/tag/v1.0.0",
    },
  };
  const failed = failedSourcePlugins(
    source,
    [previous],
    { commitSha: "c".repeat(40), branch: "main" },
    "2026-07-28T12:00:00.000Z",
    new CatalogCheckError("entry-point-missing", "missing"),
  )[0];
  assert.equal(failed.upstreamObservedCommit, "c".repeat(40));
  assert.equal(failed.upstreamValidatedCommit, "b".repeat(40));
  assert.equal(failed.upstreamCheckStatus, "failed");
  assert.equal(failed.installAvailable, false);
  assert.equal(failed.verificationStatus, "unverified");
  assert.equal(failed.verificationBaselineVersion, undefined);
  assert.equal(failed.verificationCommit, undefined);
  assert.equal(failed.verificationCheckedAt, undefined);
  assert.equal(failed.repositoryRelease, undefined);

  const unreachable = failedSourcePlugins(
    source,
    [failed],
    undefined,
    "2026-07-28T13:00:00.000Z",
    new CatalogCheckError("repository-unreachable", "offline"),
  )[0];
  assert.equal(unreachable.upstreamObservedCommit, "c".repeat(40));
  assert.equal(unreachable.upstreamValidatedCommit, "b".repeat(40));
  assert.equal(unreachable.upstreamCheckStatus, "unreachable");
  assert.equal(unreachable.installAvailable, true);
  assert.equal(unreachable.verificationStatus, "unverified");
  assert.equal(unreachable.verificationCommit, undefined);
  assert.equal(
    unreachable.installCommand,
    "omarchy plugin add https://github.com/example/weather.git --enable",
  );

  const manualNote = "This plugin requires a matching native helper.";
  const manualSource = {
    ...source,
    plugins: {
      "example.weather": {
        installation: { mode: "manual", note: manualNote },
      },
    },
  };
  const manualFailed = failedSourcePlugins(
    manualSource,
    [previous],
    { commitSha: "c".repeat(40), branch: "main" },
    "2026-07-28T12:00:00.000Z",
    new CatalogCheckError("entry-point-missing", "missing"),
  )[0];
  assert.equal(manualFailed.installAvailable, false);
  assert.equal(manualFailed.installCommand, "");
  assert.equal(manualFailed.installNote, manualNote);

  const manualUnreachable = failedSourcePlugins(
    manualSource,
    [previous],
    undefined,
    "2026-07-28T13:00:00.000Z",
    new CatalogCheckError("repository-unreachable", "offline"),
  )[0];
  assert.equal(manualUnreachable.installAvailable, false);
  assert.equal(manualUnreachable.installCommand, "");
  assert.equal(manualUnreachable.installNote, manualNote);
});

test("temporary raw GitHub responses are classified as unreachable", () => {
  assert.equal(snapshotHttpErrorCode(429, "manifest-invalid"), "repository-unreachable");
  assert.equal(snapshotHttpErrorCode(503, "preview-invalid"), "repository-unreachable");
  assert.equal(snapshotHttpErrorCode(404, "entry-point-missing"), "entry-point-missing");
});

test("interrupted snapshot bodies remain recoverable repository failures", async () => {
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.error(new Error("connection reset"));
    },
  }));
  await assert.rejects(
    readLimitedBuffer(response, 1024, "preview-invalid", "preview.png"),
    (error) => error instanceof CatalogCheckError
      && error.code === "repository-unreachable"
      && /connection reset/.test(error.message),
  );
});

test("previews are staged only after the complete source validates", async () => {
  const calls = [];
  const snapshot = { metadata: { previewImage: "preview.png" } };
  await assert.rejects(
    validateBeforeStagingPreview({
      loadPreview: async () => {
        calls.push("load");
        return snapshot;
      },
      validateSource: async () => {
        calls.push("validate");
        throw new CatalogCheckError("manifest-invalid", "invalid");
      },
      stagePreview: async () => calls.push("stage"),
    }),
    /invalid/,
  );
  assert.deepEqual(calls, ["load", "validate"]);

  calls.length = 0;
  const result = await validateBeforeStagingPreview({
    loadPreview: async () => {
      calls.push("load");
      return snapshot;
    },
    validateSource: async (preview) => {
      calls.push("validate");
      assert.equal(preview, snapshot.metadata);
      return ["plugin"];
    },
    stagePreview: async (loaded) => {
      calls.push("stage");
      assert.equal(loaded, snapshot);
    },
  });
  assert.deepEqual(result, ["plugin"]);
  assert.deepEqual(calls, ["load", "validate", "stage"]);
});

test("successful checks bind observed and validated state to one snapshot", () => {
  const sha = "d".repeat(40);
  const plugin = {
    id: "example.weather",
    repo: "https://github.com/example/weather",
    version: "2.0.0",
    installAvailable: true,
  };
  const source = {
    repo: plugin.repo,
    type: "plugin-source",
    listingValidatedCommit: "a".repeat(40),
    listingValidatedAt: "2026-07-28T10:00:00.000Z",
    listingValidatedBranch: "main",
    automatedSecurityBaseline: {
      schemaVersion: 1,
      version: securityBaselineVersion,
      repository: "example/weather",
      pluginIds: [plugin.id],
      commit: "a".repeat(40),
      checkedAt: "2026-07-28T10:30:00.000Z",
      outcome: "passed",
      enforcementMode: securityBaselineEnforcementMode,
      findings: [],
      capabilities: [],
    },
    plugins: { [plugin.id]: {} },
  };
  const result = successfulState(
    plugin,
    source,
    { commitSha: sha, branch: "main" },
    { ...plugin, version: "1.0.0" },
    "2026-07-28T12:00:00.000Z",
  );
  assert.equal(result.upstreamObservedCommit, sha);
  assert.equal(result.upstreamValidatedCommit, sha);
  assert.equal(result.upstreamCheckStatus, "passed");
  assert.equal(result.verificationStatus, "unverified");
  assert.equal(result.verificationSnapshotStatus, "verified");
  assert.equal(result.verificationCoverage, "update-unverified");
  assert.equal(result.verificationCommit, "a".repeat(40));
  assert.equal(result.versionUpdatedAt, "2026-07-28T12:00:00.000Z");
});

test("cards distinguish release tags from manifest versions", () => {
  assert.equal(pluginVersionLabel({ releaseTag: "v2.0.0", version: "1.0.0" }), "manifest v1.0.0");
  assert.equal(pluginVersionLabel({ version: "1.0.0" }), "manifest v1.0.0");
  assert.equal(pluginVersionLabel({ version: "v1.0.0" }), "manifest v1.0.0");
  assert.equal(pluginVersionLabel({ placeholder: true, version: "Preview" }), "");
});

test("SHIBUMI is listed once as a manual shell suite", () => {
  const matches = catalog.plugins.filter((plugin) => plugin.id === "hancore.shibumi");
  assert.equal(matches.length, 1);
  const [shibumi] = matches;
  assert.equal(shibumi.placeholder, undefined);
  assert.equal(shibumi.sourceType, "community");
  assert.equal(shibumi.repo, "https://github.com/HANCORE-linux/Shibumi-Shell");
  assert.equal(shibumi.version, "0.1.1-beta.4");
  assert.equal(shibumi.repositoryLayout, "suite");
  assert.equal(shibumi.installAvailable, false);
  assert.equal(shibumi.installCommand, "");
  assert.match(shibumi.previewImage, /^assets\/img\/plugins\/.*-detail\.webp$/);
  assert.match(shibumi.previewThumbnail, /^assets\/img\/plugins\/.*-card\.webp$/);
});
