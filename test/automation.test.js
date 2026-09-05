import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import sharp from "sharp";
import {
  addRegistrySource,
  approvalDecisionForEvents,
  approvedAndVerifiedLabel,
  assertApprovedIssueBody,
  assertRightsConfirmation,
  canApprove,
  createApprovedSecurityBaseline,
  createApprovedVerificationEvidence,
  createRegistrySource,
  hasRightsConfirmation,
  isLegacySubmission,
  latestSecurityBaselineComment,
  legacyApprovalLabel,
  manualSetupNote,
  parseApprovableSubmission,
  parseManualSetupApproval,
  parseSubmissionBody,
  rightsStatement,
} from "../scripts/approve-submission.mjs";
import {
  assertRecoverableCatalogError,
  CatalogCheckError,
  discoveredPlugins,
  isListedPlugin,
  manifestFieldLimits,
  maximumManifestVersionLength,
  optimizePreviewBuffer,
  parseGitHubRepository,
  previewCardLimit,
  previewDetailLimit,
  previewFileBase,
  previewPixelLimit,
  validateManifest,
  validatePreviewMetadata,
} from "../scripts/build-catalog.mjs";
import {
  assertSubmissionIsUnlisted,
  extractRepositoryUrl,
} from "../scripts/validate-submission.mjs";
import { publicSubmissionFailure } from "../scripts/submission-feedback.mjs";
import { serializeSecurityBaselineMarker } from "../scripts/security-baseline.mjs";
import { sourceVerification } from "../scripts/verification-status.mjs";
import {
  allowedCategories,
  allowedTags,
  classifySubmission,
  maximumSubmissionTags,
  parseCurrentSubmission,
  parseIssueSubmission,
  predatesRightsConfirmation,
  submissionChecklist,
} from "../scripts/submission.mjs";
import {
  appendSearchState,
  applySearchCompletion,
  committedTermsFromDraft,
  createSearchTerm,
  currentSearchToken,
  fuzzyScore,
  handleSearchEscape,
  hasFulltextSearchDraft,
  inlineSearchCompletionSuffix,
  matchesCommittedSearchTerm,
  matchesDirectSearch,
  matchesDraftSearchTerm,
  matchesShortSearch,
  maximumSearchTermLength,
  parseSearchDraft,
  pluginKindKey,
  rankSearchCompletions,
  readSearchState,
  removeSearchTermTypeFromDraft,
  searchKeyAction,
  searchTermKey,
  searchTokens,
  selectSearchCompletions,
  uniqueSearchTerms,
} from "../site/assets/js/search.js";
import {
  appendCatalogViewState,
  catalogViewControls,
  findCopyLabel,
  matchesVerificationStatus,
  pluginVerificationDetailState,
  pluginVerificationState,
  readCatalogViewState,
  showCopiedState,
  writeClipboard,
} from "../site/assets/js/shared.js";
import {
  catalogCategoryTotals,
  matchesKidsTaxonomy,
} from "../site/assets/js/taxonomy.js";

function contrastRatio(first, second) {
  const luminance = (hex) => {
    const normalized = hex.slice(1).length === 3
      ? [...hex.slice(1)].map((value) => value.repeat(2)).join("")
      : hex.slice(1);
    const channels = [0, 2, 4].map((offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16) / 255)
      .map((value) => value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4);
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

function mixHex(foreground, background, foregroundWeight) {
  const channel = (hex, offset) => Number.parseInt(hex.slice(offset, offset + 2), 16);
  const mixed = [1, 3, 5].map((offset) => Math.round(
    channel(foreground, offset) * foregroundWeight
      + channel(background, offset) * (1 - foregroundWeight),
  ));
  return `#${mixed.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function submissionBody({
  repo = "https://github.com/example/omarchy-plugin.git",
  category = "Developer Tools",
  tags = "Launcher, Quickshell, Quickshell",
  suggestedTag = "_No response_",
  includeSuggestedTag = true,
  notes = "_No response_",
  checked = submissionChecklist,
} = {}) {
  return [
    "### Repository URL",
    "",
    repo,
    "",
    "### Category",
    "",
    category,
    "",
    "### Tags",
    "",
    tags,
    "",
    ...(includeSuggestedTag ? [
      "### Suggest a missing tag",
      "",
      suggestedTag,
      "",
    ] : []),
    "### Maintainer notes",
    "",
    notes,
    "",
    "### Submission checklist",
    "",
    ...submissionChecklist.map((statement) =>
      `- [${checked.includes(statement) ? "x" : " "}] ${statement}`
    ),
  ].join("\n");
}

function registryPluginEntries(registry) {
  return [
    ...registry.sources.flatMap((source) => [
      ...(source.catalog ? [[source.catalog.id, source.catalog]] : []),
      ...Object.entries(source.plugins || {}),
    ]),
    ...registry.placeholders.map((plugin) => [plugin?.id, plugin]),
  ];
}

function assertRetiredPluginIdsAreInactive(registry) {
  const activeIds = new Set(registryPluginEntries(registry).map(([pluginId]) => pluginId));
  assert.equal(new Set(registry.retiredPluginIds).size, registry.retiredPluginIds.length);
  assert.ok(
    registry.retiredPluginIds.every((pluginId) => !activeIds.has(pluginId)),
    "retired plugin IDs must not remain active registry entries",
  );
  return activeIds;
}

function taggedPluginIds(entries, tag, origin) {
  const allPluginIds = [];
  const taggedIds = [];
  for (const [pluginId, plugin] of entries) {
    assert.equal(typeof pluginId, "string", `${origin} plugin IDs must be strings`);
    assert.ok(
      pluginId.length <= manifestFieldLimits.id
        && /^[a-z0-9][a-z0-9._-]*$/.test(pluginId)
        && !pluginId.includes(".."),
      `${origin} plugin IDs must satisfy the community manifest identity rules`,
    );
    assert.ok(Array.isArray(plugin?.tags), `${origin} plugin tags must be arrays`);
    allPluginIds.push(pluginId);
    if (plugin.tags.includes(tag)) taggedIds.push(pluginId);
  }
  assert.equal(new Set(allPluginIds).size, allPluginIds.length, `${origin} plugin IDs must be unique`);
  return taggedIds.sort();
}

function assertTagProjectionMatchesRegistry(registry, catalog, tag) {
  assert.deepEqual(
    taggedPluginIds(catalog.plugins.map((plugin) => [plugin?.id, plugin]), tag, "catalog"),
    taggedPluginIds(registryPluginEntries(registry), tag, "registry"),
  );
}

test("GitHub repository URLs are normalized and restricted", () => {
  assert.deepEqual(
    parseGitHubRepository("https://github.com/example/omarchy-plugin.git"),
    { owner: "example", repository: "omarchy-plugin", slug: "example/omarchy-plugin" }
  );
  assert.throws(() => parseGitHubRepository("http://github.com/example/plugin"), /Only public HTTPS/);
  assert.throws(() => parseGitHubRepository("https://gitlab.com/example/plugin"), /Only public HTTPS/);
  assert.throws(() => parseGitHubRepository("https://github.com/example/plugin/tree/main"), /repository root/);
  assert.throws(() => parseGitHubRepository("https://user:secret@github.com/example/plugin"), /credentials/);
  assert.throws(() => parseGitHubRepository("https://github.com/example/plugin?redirect=1"), /queries/);
  assert.throws(() => parseGitHubRepository("https://github.com/example/plugin#fragment"), /fragments/);
  assert.throws(() => parseGitHubRepository("https://github.com/example/plugin;printf%20pwned"), /unsupported characters/);
});

test("search Escape closes suggestions before clearing the query", () => {
  const calls = [];
  const firstEvent = {
    key: "Escape",
    preventDefault: () => calls.push("prevent-first"),
  };
  assert.equal(handleSearchEscape(firstEvent, {
    hasSuggestions: true,
    closeSuggestions: () => calls.push("close"),
    clearSearch: () => calls.push("clear-first"),
  }), true);
  assert.deepEqual(calls, ["prevent-first", "close"]);

  const secondEvent = {
    key: "Escape",
    preventDefault: () => calls.push("prevent-second"),
  };
  assert.equal(handleSearchEscape(secondEvent, {
    hasSuggestions: false,
    closeSuggestions: () => calls.push("close-second"),
    clearSearch: () => calls.push("clear"),
  }), true);
  assert.deepEqual(calls, ["prevent-first", "close", "prevent-second", "clear"]);
});

test("plugin completions rank ahead of fuzzy tag matches", () => {
  const ranked = rankSearchCompletions([
    {
      type: "tag",
      value: "coming-soon",
      label: "coming-soon",
      count: 1,
      score: fuzzyScore("omi", "coming-soon"),
    },
    {
      type: "plugin",
      value: "Omni",
      label: "Omni",
      count: 1,
      score: fuzzyScore("omi", "Omni"),
    },
  ]);
  assert.deepEqual(ranked.map(({ label }) => label), ["Omni", "coming-soon"]);
});

test("completion selection preserves genuine prefixes across result types", () => {
  const selected = selectSearchCompletions([
    { type: "plugin", value: "Hardware", label: "Hardware", count: 1, score: 0, prefix: true },
    { type: "plugin", value: "Home", label: "Home", count: 1, score: 0, prefix: true },
    { type: "plugin", value: "Hypr Panel", label: "Hypr Panel", count: 1, score: 0, prefix: true },
    { type: "tag", value: "hyprland", label: "hyprland", count: 4, score: 0, prefix: true },
  ]);
  assert.equal(selected.length, 3);
  assert.ok(selected.some(({ type, value }) => type === "tag" && value === "hyprland"));
});

test("kind and full-text completions remain available beside catalog suggestions", () => {
  const selected = selectSearchCompletions([
    { type: "plugin", value: "bar-plugin", label: "Bar Plugin", count: 1, score: 0, prefix: true },
    { type: "author", value: "bar-author", label: "@bar-author", count: 1, score: 0, prefix: true },
    { type: "tag", value: "bar", label: "bar", count: 4, score: 0, prefix: true },
    {
      type: "kind", value: "bar", label: "kind:bar", count: 8, score: 0,
      prefix: true, fullPrefix: true, targetLength: 3,
    },
    {
      type: "kind", value: "bar-widget", label: "kind:bar-widget", count: 1351, score: 0,
      prefix: true, fullPrefix: true, targetLength: 10,
    },
    {
      type: "fulltext",
      value: "bar",
      label: "bar",
      insertValue: "text:bar",
      count: 12,
      score: 0,
      prefix: false,
    },
  ]);
  assert.equal(selected.length, 6);
  assert.deepEqual(selected.slice(0, 2).map(({ value }) => value), ["bar", "bar-widget"]);
  assert.equal(selected[2].type, "fulltext");
  assert.deepEqual(
    selected.slice(3).map(({ type }) => type).sort(),
    ["author", "plugin", "tag"],
  );
});

test("search tokens support multi-word matching and current-token completion", () => {
  assert.deepEqual(searchTokens("  AirVPN   system "), ["airvpn", "system"]);
  assert.deepEqual(searchTokens("  Expose\u0301   System "), ["exposé", "system"]);
  assert.equal(currentSearchToken("airvpn sys"), "sys");
  assert.equal(currentSearchToken("airvpn "), "");
  assert.equal(fuzzyScore("Expose\u0301", "Exposé"), 0);
});

test("direct search handles standalone punctuation in plugin names", () => {
  const pluginNames = [
    "Media Controls + Album Art",
    "System & Network",
    "1440 - Day Countdown",
    "OmaScribe — AI Meeting Notes",
  ];
  for (const pluginName of pluginNames) {
    assert.equal(matchesDirectSearch(pluginName, {
      primaryText: pluginName,
      searchText: pluginName,
    }), true, pluginName);
  }
  assert.equal(matchesDirectSearch("&", {
    primaryText: "System & Network",
    searchText: "System & Network",
  }), true);
  assert.equal(matchesDirectSearch("&", {
    primaryText: "System Network",
    searchText: "System Network",
  }), false);
  assert.equal(matchesDirectSearch("System + Network", {
    primaryText: "System & Network",
    searchText: "System & Network",
  }), false);
  assert.equal(matchesDirectSearch("@", {
    publisher: "jcnecio",
    primaryText: "System & Network",
    searchText: "System & Network jcnecio @jcnecio",
  }), false);
});

test("short searches use Unicode-aware word prefixes", () => {
  assert.equal(matchesDirectSearch("农历", {
    primaryText: "Lunar Calendar io.github.tuthan.omarchy-lunar-calendar",
    searchText: "East Asian Lunar Calendar (Lịch Âm / 农历)",
  }), true);
  assert.equal(matchesDirectSearch("全部", {
    primaryText: "Zenbu io.github.weedwhitesandwine.zenbu",
    searchText: "全部 — a theme-aware launcher for everything",
  }), true);
  assert.equal(matchesDirectSearch("調べ", {
    primaryText: "Shirabe ga-research.shirabe",
    searchText: "調べ — quick lookup overlay",
  }), true);
  assert.equal(matchesDirectSearch("农", {
    primaryText: "Lunar Calendar",
    searchText: "East Asian Lunar Calendar / 农历",
  }), true);
  assert.equal(matchesDirectSearch("历", {
    primaryText: "Lunar Calendar",
    searchText: "East Asian Lunar Calendar / 农历",
  }), false);
  assert.equal(matchesDirectSearch("中文插", {
    primaryText: "Example plugin",
    searchText: "Example description 中文插件",
  }), true);
  assert.equal(matchesDirectSearch("ar", {
    primaryText: "Example bar plugin",
    searchText: "Example bar plugin",
  }), false);
});

test("short searches find terms within plugin names and tags", () => {
  assert.equal(matchesShortSearch(
    "vpn",
    "AirVPN spacexrace.airvpn system bar",
    "AirVPN status and country selection",
  ), true);
  assert.equal(matchesShortSearch(
    "vpn",
    "OpenFortiVPN murphi.openfortivpn bar security",
    "FortiVPN client integration",
  ), true);
  assert.equal(matchesShortSearch(
    "vpn",
    "Unrelated plugin productivity launcher",
    "A command palette for applications",
  ), false);
});

test("inline completion accepts genuine plugin, tag, and author prefixes", () => {
  assert.equal(inlineSearchCompletionSuffix(
    { type: "plugin", value: "AirVPN" },
    "Air",
  ), "VPN");
  assert.equal(inlineSearchCompletionSuffix(
    { type: "tag", value: "quickshell" },
    "quicks",
  ), "hell");
  assert.equal(inlineSearchCompletionSuffix(
    { type: "author", value: "spaceXrace" },
    "@space",
  ), "Xrace");
  assert.equal(inlineSearchCompletionSuffix(
    { type: "plugin", value: "AirVPN" },
    "VPN",
  ), "");
  assert.equal(inlineSearchCompletionSuffix(
    { type: "author", value: "spaceXrace" },
    "space",
  ), "");
});

test("typed committed chips use exact field-specific matching", () => {
  const plugin = {
    publisher: "spaceXrace",
    primaryText: "Power Profiles power-management bar",
    searchText: "Power Profiles controls power profiles and a bar widget",
    tags: ["power-management", "bar"],
    pluginName: "Power Profiles",
    pluginId: "dizziee.power-profiles",
  };
  assert.equal(matchesCommittedSearchTerm(createSearchTerm("text", "Power Profiles"), plugin), true);
  assert.equal(matchesCommittedSearchTerm(createSearchTerm("text", "Power Other Profiles"), plugin), false);
  assert.equal(matchesCommittedSearchTerm(createSearchTerm("tag", "bar"), plugin), true);
  assert.equal(matchesCommittedSearchTerm(createSearchTerm("tag", "widget"), plugin), false);
  assert.equal(matchesCommittedSearchTerm(createSearchTerm("author", "@spaceXrace"), plugin), true);
  assert.equal(matchesCommittedSearchTerm(createSearchTerm("author", "space"), plugin), false);
  assert.equal(matchesCommittedSearchTerm(createSearchTerm("plugin", "Power Profiles"), plugin), true);
  assert.equal(matchesCommittedSearchTerm(createSearchTerm("plugin", "dizziee.power-profiles"), plugin), true);
  assert.equal(matchesDirectSearch("dark mode", {
    publisher: "spaceXrace",
    primaryText: "Power Profiles dizziee.power-profiles bar",
    searchText: "Power Profiles with a dark theme and selectable color mode",
  }), true);
  assert.equal(matchesCommittedSearchTerm(createSearchTerm("text", "dark mode"), {
    publisher: "spaceXrace",
    primaryText: "Power Profiles dizziee.power-profiles bar",
    searchText: "Power Profiles with a dark theme and selectable color mode",
  }), false);
  assert.equal(matchesDraftSearchTerm(createSearchTerm("tag", "pow"), plugin), true);
  assert.equal(matchesDraftSearchTerm(createSearchTerm("author", "space"), plugin), true);
  assert.equal(matchesDraftSearchTerm(createSearchTerm("plugin", "Power P"), plugin), true);
});

test("plain text stays broad while explicit plugin kinds match exactly", () => {
  const floatingBar = {
    pluginKind: "Bar",
    primaryText: "Floating Bar charlieras262.floating-bar bar hyprland quickshell",
    searchText: "Floating Bar full bar replacement appearance Bar bar hyprland quickshell",
  };
  const bongoCat = {
    pluginKind: "Bar widget",
    primaryText: "Bongo Cat io.github.chip-davis.omabongo bar",
    searchText: "Bongo Cat animated mascot Bar widget bar",
  };
  const combinedKindDescription = {
    pluginKind: "Service + Bar widget",
    primaryText: "Combined controls example.combined",
    searchText: "Combined service + bar widget controls and panel integration",
  };
  assert.equal(matchesDirectSearch("bar", floatingBar), true);
  assert.equal(matchesDirectSearch("bar", bongoCat), true);
  assert.equal(matchesCommittedSearchTerm(createSearchTerm("kind", "bar"), floatingBar), true);
  assert.equal(matchesCommittedSearchTerm(createSearchTerm("kind", "bar"), bongoCat), false);
  assert.equal(matchesCommittedSearchTerm(
    createSearchTerm("kind", "bar-widget"),
    bongoCat,
  ), true);
  assert.equal(matchesCommittedSearchTerm(
    createSearchTerm("kind", "service-bar-widget"),
    combinedKindDescription,
  ), true);
  assert.equal(matchesDraftSearchTerm(createSearchTerm("kind", "bar"), floatingBar), true);
  assert.equal(matchesDraftSearchTerm(createSearchTerm("kind", "bar"), bongoCat), false);
  assert.equal(matchesCommittedSearchTerm(
    createSearchTerm("fulltext", "panel"),
    combinedKindDescription,
  ), true);
  assert.equal(matchesDraftSearchTerm(
    createSearchTerm("fulltext", "panel"),
    combinedKindDescription,
  ), true);
  assert.equal(pluginKindKey("Menu + Bar widget"), "menu-bar-widget");
  assert.equal(pluginKindKey("  BAR widget  "), "bar-widget");
});

test("catalog plugin kinds have unique stable query keys", async () => {
  const catalog = JSON.parse(
    await readFile(new URL("../site/catalog.json", import.meta.url), "utf8"),
  );
  const kindsByKey = new Map();
  for (const plugin of catalog.plugins) {
    const key = pluginKindKey(plugin.kind);
    assert.ok(key, `missing kind key for ${plugin.id}`);
    const existing = kindsByKey.get(key);
    assert.ok(!existing || existing === plugin.kind, `${existing} collides with ${plugin.kind}`);
    kindsByKey.set(key, plugin.kind);
    assert.equal(matchesCommittedSearchTerm(
      createSearchTerm("kind", key),
      { pluginKind: plugin.kind },
    ), true, plugin.id);
  }
  assert.equal(kindsByKey.size, new Set(catalog.plugins.map((plugin) => plugin.kind)).size);
});

test("typed terms normalize, parse, and deduplicate by type and value", () => {
  assert.deepEqual(parseSearchDraft("vpn tag:bar author:@spaceXrace kind:bar-widget text:panel"), [
    { type: "text", value: "vpn" },
    { type: "tag", value: "bar" },
    { type: "author", value: "spaceXrace" },
    { type: "kind", value: "bar-widget" },
    { type: "fulltext", value: "panel" },
  ]);
  assert.deepEqual(parseSearchDraft("plugin:Power Profiles"), [
    { type: "plugin", value: "Power Profiles" },
  ]);
  assert.deepEqual(parseSearchDraft('plugin:Power Profiles text:"Floating Bar"'), [
    { type: "plugin", value: "Power Profiles" },
    { type: "fulltext", value: "Floating Bar" },
  ]);
  assert.deepEqual(parseSearchDraft('text:"Floating Bar" plugin:Power Profiles'), [
    { type: "fulltext", value: "Floating Bar" },
    { type: "plugin", value: "Power Profiles" },
  ]);
  assert.deepEqual(parseSearchDraft("plugin:Power Profiles tag:bar"), [
    { type: "plugin", value: "Power Profiles" },
    { type: "tag", value: "bar" },
  ]);
  assert.deepEqual(parseSearchDraft("plugin:Power Profiles kind:bar"), [
    { type: "plugin", value: "Power Profiles" },
    { type: "kind", value: "bar" },
  ]);
  assert.deepEqual(parseSearchDraft("kind:bar plugin:Power Profiles"), [
    { type: "kind", value: "bar" },
    { type: "plugin", value: "Power Profiles" },
  ]);
  assert.deepEqual(parseSearchDraft('text:"Floating Bar"'), [
    { type: "fulltext", value: "Floating Bar" },
  ]);
  assert.deepEqual(parseSearchDraft('tag:security text:"Floating Bar"'), [
    { type: "tag", value: "security" },
    { type: "fulltext", value: "Floating Bar" },
  ]);
  assert.deepEqual(parseSearchDraft('text:"Floating Bar" tag:security'), [
    { type: "fulltext", value: "Floating Bar" },
    { type: "tag", value: "security" },
  ]);
  assert.deepEqual(parseSearchDraft("text:"), []);
  assert.deepEqual(parseSearchDraft('text:"Floating Bar'), [
    { type: "text", value: 'text:"Floating' },
    { type: "text", value: "Bar" },
  ]);
  assert.equal(createSearchTerm("fulltext", 'invalid"quote'), null);
  assert.deepEqual(createSearchTerm("kind", "Service + Bar widget"), {
    type: "kind",
    value: "service-bar-widget",
  });
  assert.equal(createSearchTerm("kind", "---"), null);
  assert.equal(createSearchTerm("kind", "x".repeat(maximumSearchTermLength + 1)), null);
  assert.equal(pluginKindKey("Bär + Panel"), "bär-panel");
  assert.equal(hasFulltextSearchDraft("vpn text:panel"), true);
  assert.equal(hasFulltextSearchDraft("vpn panel"), false);
  assert.deepEqual(parseSearchDraft("tag: author: @bad_login @foo- @foo--bar"), [
    { type: "text", value: "tag:" },
    { type: "text", value: "author:" },
    { type: "text", value: "@bad_login" },
    { type: "author", value: "foo-" },
    { type: "text", value: "@foo--bar" },
  ]);
  assert.deepEqual(createSearchTerm("author", "Confined-"), {
    type: "author",
    value: "Confined-",
  });
  assert.equal(createSearchTerm("author", "-confined"), null);
  assert.equal(createSearchTerm("author", "confined--legacy"), null);
  assert.deepEqual(committedTermsFromDraft("@Confin", {
    type: "author",
    value: "Confined-",
    label: "@Confined-",
  }), [{ type: "author", value: "Confined-" }]);
  assert.equal(
    removeSearchTermTypeFromDraft("vpn tag:bar @spaceXrace", "author"),
    "vpn tag:bar",
  );
  assert.equal(
    removeSearchTermTypeFromDraft('text:"Floating Bar" @spaceXrace', "author"),
    'text:"Floating Bar"',
  );
  assert.deepEqual(uniqueSearchTerms([
    { type: "text", value: "bar" },
    { type: "fulltext", value: "bar" },
    { type: "tag", value: "bar" },
    { type: "tag", value: "BAR" },
    { type: "kind", value: "Bar widget" },
    { type: "kind", value: "bar-widget" },
  ]), [
    { type: "text", value: "bar" },
    { type: "fulltext", value: "bar" },
    { type: "tag", value: "bar" },
    { type: "kind", value: "bar-widget" },
  ]);
  assert.notEqual(
    searchTermKey({ type: "text", value: "bar" }),
    searchTermKey({ type: "tag", value: "bar" }),
  );
  assert.notEqual(
    searchTermKey({ type: "text", value: "bar" }),
    searchTermKey({ type: "fulltext", value: "bar" }),
  );
  assert.notEqual(
    searchTermKey({ type: "text", value: "bar" }),
    searchTermKey({ type: "kind", value: "bar" }),
  );
});

test("chip URL state preserves ordered typed terms and the live draft", () => {
  const terms = [
    { type: "text", value: "VPN" },
    { type: "tag", value: "bar" },
    { type: "author", value: "spaceXrace" },
    { type: "plugin", value: "jkoestinger.vpn" },
    { type: "kind", value: "bar-widget" },
    { type: "fulltext", value: "panel" },
    { type: "text", value: "bar" },
  ];
  const params = appendSearchState(new URLSearchParams(), { terms, draft: "@JJD" });
  assert.equal(params.toString(), "q=VPN&tag=bar&author=spaceXrace&plugin=jkoestinger.vpn&kind=bar-widget&text=panel&q=bar&draft=%40JJD");
  assert.deepEqual(readSearchState(params), { terms, draft: "@JJD" });
  assert.deepEqual(readSearchState(new URLSearchParams(
    "q=VPN&q=vpn&q=%40spaceXrace&q=tag%3Abar&tag=bar&kind=Bar+widget&unknown=x&fulltext=panel&draft=one&draft=two"
  )), {
    terms: [
      { type: "text", value: "VPN" },
      { type: "author", value: "spaceXrace" },
      { type: "text", value: "tag:bar" },
      { type: "tag", value: "bar" },
      { type: "kind", value: "bar-widget" },
    ],
    draft: "one",
  });
  const oversizedDraft = "x".repeat(maximumSearchTermLength + 1);
  const oversizedParams = appendSearchState(new URLSearchParams(), {
    terms: [],
    draft: oversizedDraft,
  });
  assert.equal(oversizedParams.has("draft"), false);
  assert.equal(readSearchState(new URLSearchParams(`draft=${oversizedDraft}`)).draft, "");
  assert.deepEqual(readSearchState(new URLSearchParams(`kind=${oversizedDraft}`)).terms, []);

  const legacyAuthorParams = appendSearchState(new URLSearchParams(), {
    terms: [{ type: "author", value: "Confined-" }],
    draft: "",
  });
  assert.equal(legacyAuthorParams.toString(), "author=Confined-");
  assert.deepEqual(readSearchState(legacyAuthorParams), {
    terms: [{ type: "author", value: "Confined-" }],
    draft: "",
  });
});

test("catalog all-view controls and URL state cover result boundaries", () => {
  for (const total of [0, 1, 9]) {
    assert.deepEqual(catalogViewControls(total, false, 9), {
      paginationHidden: true,
      browseAllHidden: true,
      dockHidden: true,
      reserveDockSpace: false,
    });
    assert.deepEqual(catalogViewControls(total, true, 9), {
      paginationHidden: true,
      browseAllHidden: true,
      dockHidden: false,
      reserveDockSpace: true,
    });
  }
  assert.deepEqual(catalogViewControls(10, false, 9), {
    paginationHidden: false,
    browseAllHidden: false,
    dockHidden: true,
    reserveDockSpace: false,
  });
  assert.deepEqual(catalogViewControls(10, true, 9), {
    paginationHidden: true,
    browseAllHidden: true,
    dockHidden: false,
    reserveDockSpace: true,
  });

  const allParams = appendCatalogViewState(new URLSearchParams("page=7"), {
    showAll: true,
    page: 7,
  });
  assert.equal(allParams.toString(), "view=all");
  assert.deepEqual(readCatalogViewState(new URLSearchParams("view=all&page=7")), {
    showAll: true,
    page: 1,
  });

  const paginatedParams = appendCatalogViewState(new URLSearchParams("view=all"), {
    showAll: false,
    page: 3,
  });
  assert.equal(paginatedParams.toString(), "page=3");
  assert.deepEqual(readCatalogViewState(paginatedParams), { showAll: false, page: 3 });
  assert.deepEqual(readCatalogViewState(new URLSearchParams("page=invalid")), {
    showAll: false,
    page: 1,
  });
});

test("Fish completion creates typed current-token and stable plugin terms", () => {
  const system = { type: "tag", value: "system", label: "system" };
  const powerProfiles = {
    type: "plugin",
    value: "dizziee.power-profiles",
    label: "Power Profiles",
    insertValue: "Power Profiles",
  };
  const openCodeUsage = {
    type: "plugin",
    value: "dizziee.opencode-model-usage",
    label: "OpenCode Usage",
    insertValue: "OpenCode Usage",
  };
  const fulltextBar = {
    type: "fulltext",
    value: "bar",
    label: "bar",
    insertValue: "text:bar",
  };
  const fulltextFloatingBar = {
    type: "fulltext",
    value: "Floating Bar",
    label: "Floating Bar",
    insertValue: 'text:"Floating Bar"',
  };
  const kindBar = {
    type: "kind",
    value: "bar",
    label: "kind:bar",
    insertValue: "kind:bar",
    matchValue: "Bar",
  };
  const kindBarWidget = {
    type: "kind",
    value: "bar-widget",
    label: "kind:bar-widget",
    insertValue: "kind:bar-widget",
    matchValue: "Bar widget",
  };
  const kindServiceBarWidget = {
    type: "kind",
    value: "service-bar-widget",
    label: "kind:service-bar-widget",
    insertValue: "kind:service-bar-widget",
    matchValue: "Service + Bar widget",
  };
  const kindMenuBarWidget = {
    type: "kind",
    value: "menu-bar-widget",
    label: "kind:menu-bar-widget",
    insertValue: "kind:menu-bar-widget",
    matchValue: "Menu + Bar widget",
  };
  const systemNetwork = {
    type: "plugin",
    value: "example.system-network",
    label: "System & Network",
    insertValue: "System & Network",
  };
  const exposePlugin = {
    type: "plugin",
    value: "example.expose",
    label: "Exposé Plugin",
    insertValue: "Exposé Plugin",
  };
  assert.equal(applySearchCompletion("airvpn sys", system), "airvpn system");
  assert.equal(inlineSearchCompletionSuffix(system, "airvpn sys"), "tem");
  assert.deepEqual(committedTermsFromDraft("airvpn sys", system), [
    { type: "text", value: "airvpn" },
    { type: "tag", value: "system" },
  ]);
  assert.equal(applySearchCompletion("Power P", powerProfiles), "Power Profiles");
  assert.equal(inlineSearchCompletionSuffix(powerProfiles, "Power P"), "rofiles");
  assert.equal(applySearchCompletion("plugin:Power P", powerProfiles), "plugin:Power Profiles");
  assert.equal(inlineSearchCompletionSuffix(powerProfiles, "plugin:Power P"), "rofiles");
  assert.equal(
    applySearchCompletion("plugin:AirVPN Power P", powerProfiles),
    "plugin:AirVPN Power Profiles",
  );
  assert.equal(
    applySearchCompletion("plugin:AirVPN P", powerProfiles),
    "plugin:AirVPN Power Profiles",
  );
  assert.deepEqual(committedTermsFromDraft("Power P", powerProfiles), [
    { type: "plugin", value: "dizziee.power-profiles" },
  ]);
  assert.deepEqual(committedTermsFromDraft("vpn Power P", powerProfiles), [
    { type: "text", value: "vpn" },
    { type: "plugin", value: "dizziee.power-profiles" },
  ]);
  assert.deepEqual(committedTermsFromDraft("plugin:Power P", powerProfiles), [
    { type: "plugin", value: "dizziee.power-profiles" },
  ]);
  assert.deepEqual(committedTermsFromDraft("vpn plugin:Power P", powerProfiles), [
    { type: "text", value: "vpn" },
    { type: "plugin", value: "dizziee.power-profiles" },
  ]);
  assert.equal(applySearchCompletion("vpn OpenCode U", openCodeUsage), "vpn OpenCode Usage");
  assert.deepEqual(committedTermsFromDraft("vpn OpenCode U", openCodeUsage), [
    { type: "text", value: "vpn" },
    { type: "plugin", value: "dizziee.opencode-model-usage" },
  ]);
  assert.deepEqual(committedTermsFromDraft("dark mode"), [
    { type: "text", value: "dark mode" },
  ]);
  assert.deepEqual(committedTermsFromDraft("vpn bar"), [
    { type: "text", value: "vpn bar" },
  ]);
  assert.deepEqual(committedTermsFromDraft("plugin:Power Profiles"), [
    { type: "plugin", value: "Power Profiles" },
  ]);
  assert.equal(applySearchCompletion("bar", kindBar), "kind:bar");
  assert.equal(applySearchCompletion("bar wid", kindBarWidget), "kind:bar-widget");
  assert.equal(applySearchCompletion("vpn bar", kindBar), "vpn kind:bar");
  assert.equal(
    inlineSearchCompletionSuffix(kindBarWidget, "kind:bar-w"),
    "idget",
  );
  assert.deepEqual(committedTermsFromDraft("bar", kindBar), [
    { type: "kind", value: "bar" },
  ]);
  assert.deepEqual(committedTermsFromDraft("bar wid", kindBarWidget), [
    { type: "kind", value: "bar-widget" },
  ]);
  assert.deepEqual(committedTermsFromDraft("vpn bar", kindBar), [
    { type: "text", value: "vpn" },
    { type: "kind", value: "bar" },
  ]);
  assert.equal(
    applySearchCompletion("Service Bar widget", kindServiceBarWidget),
    "kind:service-bar-widget",
  );
  assert.deepEqual(
    committedTermsFromDraft("Service Bar widget", kindServiceBarWidget),
    [{ type: "kind", value: "service-bar-widget" }],
  );
  assert.deepEqual(
    committedTermsFromDraft("vpn Service Bar widget", kindServiceBarWidget),
    [
      { type: "text", value: "vpn" },
      { type: "kind", value: "service-bar-widget" },
    ],
  );
  assert.deepEqual(
    committedTermsFromDraft("Menu Bar widget", kindMenuBarWidget),
    [{ type: "kind", value: "menu-bar-widget" }],
  );
  assert.equal(
    applySearchCompletion("System Network", systemNetwork),
    "System & Network",
  );
  assert.deepEqual(committedTermsFromDraft("System Network", systemNetwork), [
    { type: "plugin", value: "example.system-network" },
  ]);
  assert.equal(
    applySearchCompletion("Expose\u0301 P", exposePlugin),
    "Exposé Plugin",
  );
  assert.equal(
    inlineSearchCompletionSuffix(exposePlugin, "Expose\u0301 P"),
    "lugin",
  );
  assert.deepEqual(committedTermsFromDraft("Expose\u0301 P", exposePlugin), [
    { type: "plugin", value: "example.expose" },
  ]);
  assert.deepEqual(committedTermsFromDraft("kind:bar-widget"), [
    { type: "kind", value: "bar-widget" },
  ]);
  assert.equal(applySearchCompletion("bar", fulltextBar), "text:bar");
  assert.equal(inlineSearchCompletionSuffix(fulltextBar, "bar"), "");
  assert.deepEqual(committedTermsFromDraft("bar", fulltextBar), [
    { type: "fulltext", value: "bar" },
  ]);
  assert.equal(
    applySearchCompletion("Floating Bar", fulltextFloatingBar),
    'text:"Floating Bar"',
  );
  assert.deepEqual(committedTermsFromDraft("Floating Bar", fulltextFloatingBar), [
    { type: "fulltext", value: "Floating Bar" },
  ]);
  assert.deepEqual(committedTermsFromDraft("text:panel"), [
    { type: "fulltext", value: "panel" },
  ]);
  assert.deepEqual(committedTermsFromDraft('text:"Floating Bar"'), [
    { type: "fulltext", value: "Floating Bar" },
  ]);
  assert.equal(applySearchCompletion("text:bar", system), "text:bar");
  assert.equal(inlineSearchCompletionSuffix(system, "text:bar"), "");
  assert.deepEqual(committedTermsFromDraft("text:bar", system), [
    { type: "fulltext", value: "bar" },
  ]);
  assert.deepEqual(committedTermsFromDraft("tag:bar @spaceXrace"), [
    { type: "tag", value: "bar" },
    { type: "author", value: "spaceXrace" },
  ]);
});

test("search keeps the raw query until a completion is explicitly accepted", () => {
  const defaults = {
    completionCount: 3,
    activeSuggestion: -1,
    caretAtEnd: true,
    hasInlineCompletion: true,
  };
  assert.equal(searchKeyAction({ ...defaults, key: "Enter" }), "submit-query");
  assert.equal(searchKeyAction({ ...defaults, key: "Tab" }), "none");
  assert.equal(searchKeyAction({ ...defaults, key: "ArrowRight" }), "accept-inline-completion");
  assert.equal(searchKeyAction({
    ...defaults,
    key: "ArrowRight",
    hasInlineCompletion: false,
  }), "none");
  assert.equal(searchKeyAction({
    ...defaults,
    key: "Enter",
    activeSuggestion: 0,
  }), "accept-active-completion");
  assert.equal(searchKeyAction({ ...defaults, key: "ArrowDown" }), "next-completion");
  assert.equal(searchKeyAction({ ...defaults, key: "ArrowUp" }), "previous-completion");
});

test("plugin cards retain their existing verification display", () => {
  assert.deepEqual(pluginVerificationState({ verificationStatus: "verified" }), {
    status: "verified",
    label: "Verified",
    explanation: "Automated checks passed for the listed commit. This is not a security audit.",
  });
  assert.deepEqual(pluginVerificationState({
    verificationStatus: "verified",
    verificationMethod: "maintainer-reviewed",
  }), {
    status: "verified",
    label: "Verified",
    explanation: "A marketplace maintainer reviewed the reported capabilities for the listed commit. This is not a security audit.",
  });
  assert.deepEqual(pluginVerificationState({
    verificationStatus: "unverified",
    verificationSnapshotStatus: "verified",
    verificationCoverage: "update-unverified",
    verificationCommit: "a".repeat(40),
    upstreamObservedCommit: "b".repeat(40),
  }), {
    status: "unverified",
    label: "Unverified",
    explanation: "No current verification record is available for the listed commit. This does not mean the plugin is malicious.",
  });
  assert.equal(pluginVerificationState({ builtIn: true }), null);
});

test("plugin details distinguish exact snapshots from unverified updates", () => {
  const listingCommit = "a".repeat(40);
  assert.deepEqual(pluginVerificationDetailState({
    verificationStatus: "verified",
    verificationSnapshotStatus: "verified",
    verificationCommit: listingCommit,
    listingValidatedCommit: listingCommit,
    upstreamValidatedCommit: listingCommit,
  }), {
    status: "verified",
    coverage: "snapshot-verified",
    label: "Snapshot verified",
    markerLabels: ["Snapshot verified"],
    explanation: "Automated checks passed for this exact snapshot. The mutable upstream install command is not commit-bound. This is not a security audit.",
  });
  assert.deepEqual(pluginVerificationDetailState({
    verificationStatus: "verified",
    verificationSnapshotStatus: "verified",
    verificationCommit: listingCommit,
    listingValidatedCommit: listingCommit,
    upstreamValidatedCommit: listingCommit,
    verificationMethod: "maintainer-reviewed",
  }), {
    status: "verified",
    coverage: "snapshot-verified",
    label: "Snapshot verified",
    markerLabels: ["Snapshot verified"],
    explanation: "A marketplace maintainer reviewed the reported findings and capabilities for this exact snapshot. The mutable upstream install command is not commit-bound. This is not a security audit.",
  });
  assert.deepEqual(pluginVerificationDetailState({
    verificationStatus: "unverified",
    verificationSnapshotStatus: "verified",
    verificationCoverage: "update-unverified",
    verificationCommit: listingCommit,
    listingValidatedCommit: listingCommit,
    upstreamObservedCommit: "b".repeat(40),
  }), {
    status: "unverified",
    coverage: "update-unverified",
    label: "Snapshot verified. Update unverified",
    markerLabels: ["Snapshot verified", "Update unverified"],
    explanation: "The current upstream commit differs from the verified snapshot. The update and mutable upstream install command are not covered by that verification.",
  });
  assert.deepEqual(pluginVerificationDetailState({
    verificationStatus: "verified",
    verificationSnapshotStatus: "verified",
    verificationCommit: "b".repeat(40),
    listingValidatedCommit: listingCommit,
  }), {
    status: "unverified",
    coverage: "unverified",
    label: "Unverified",
    markerLabels: ["Unverified"],
    explanation: "No current verification record is available for the listed snapshot. This does not mean the plugin is malicious.",
  });
  assert.deepEqual(pluginVerificationDetailState({ verificationStatus: "unverified" }), {
    status: "unverified",
    coverage: "unverified",
    label: "Unverified",
    markerLabels: ["Unverified"],
    explanation: "No current verification record is available for the listed snapshot. This does not mean the plugin is malicious.",
  });
  assert.equal(pluginVerificationDetailState({ builtIn: true }), null);
  assert.equal(pluginVerificationDetailState({ repositoryLayout: "suite" }), null);
});

test("verification filters match only exact eligible catalog statuses", () => {
  assert.equal(matchesVerificationStatus({
    repositoryLayout: "root-plugin",
    verificationStatus: "verified",
  }, "verified"), true);
  assert.equal(matchesVerificationStatus({
    repositoryLayout: "root-plugin",
    verificationStatus: "unverified",
  }, "verified"), false);
  assert.equal(matchesVerificationStatus({
    repositoryLayout: "root-plugin",
    verificationStatus: "unverified",
    verificationSnapshotStatus: "verified",
    verificationCoverage: "update-unverified",
    verificationCommit: "a".repeat(40),
    upstreamObservedCommit: "b".repeat(40),
  }, "verified"), false);
  assert.equal(matchesVerificationStatus({
    repositoryLayout: "root-plugin",
    verificationStatus: "unverified",
    verificationSnapshotStatus: "verified",
    verificationCoverage: "update-unverified",
    verificationCommit: "a".repeat(40),
    upstreamObservedCommit: "b".repeat(40),
  }, "unverified"), true);
  assert.equal(matchesVerificationStatus({ repositoryLayout: "root-plugin" }, "unverified"), false);
  assert.equal(matchesVerificationStatus({
    repositoryLayout: "suite",
    verificationStatus: "unverified",
  }, "unverified"), false);
  assert.equal(matchesVerificationStatus({
    builtIn: true,
    verificationStatus: "unverified",
  }, "unverified"), false);
});

test("copy feedback targets the visible label instead of a decorative icon", () => {
  const explicitLabel = {};
  const explicitQueries = [];
  assert.equal(findCopyLabel({
    querySelector(selector) {
      explicitQueries.push(selector);
      return selector === "[data-copy-label]" ? explicitLabel : {};
    },
  }), explicitLabel);
  assert.deepEqual(explicitQueries, ["[data-copy-label]"]);

  const fallbackLabel = {};
  assert.equal(findCopyLabel({
    querySelector(selector) {
      return selector === "[data-copy-label]" ? null : fallbackLabel;
    },
  }), fallbackLabel);
});

test("repeated copy feedback restores the original label after the last click", async () => {
  const label = { textContent: "Copy" };
  const classes = new Set();
  const icon = {
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
    },
  };
  showCopiedState(label, icon, 80);
  assert.equal(label.textContent, "Copied");
  assert.equal(classes.has("is-copied"), true);

  await new Promise((resolve) => setTimeout(resolve, 20));
  showCopiedState(label, icon, 80);
  await new Promise((resolve) => setTimeout(resolve, 65));
  assert.equal(label.textContent, "Copied");
  assert.equal(classes.has("is-copied"), true);

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(label.textContent, "Copy");
  assert.equal(classes.has("is-copied"), false);
});

test("clipboard fallback reports the actual copy result", async () => {
  let removed = false;
  const area = {
    style: {},
    select() {},
    remove() { removed = true; },
  };
  const documentRef = {
    body: { append() {} },
    createElement: () => area,
    execCommand: () => false,
  };
  assert.equal(await writeClipboard("command", {
    clipboard: { writeText: async () => { throw new Error("blocked"); } },
    documentRef,
  }), false);
  assert.equal(removed, true);
  documentRef.execCommand = () => true;
  assert.equal(await writeClipboard("command", {
    clipboard: { writeText: async () => { throw new Error("blocked"); } },
    documentRef,
  }), true);
  assert.equal(await writeClipboard("command", {
    clipboard: { writeText: async () => {} },
    documentRef: undefined,
  }), true);
});

test("Kids catalog filtering uses only the exact controlled taxonomy", () => {
  for (const plugin of [
    { category: "Kids", tags: ["games"] },
    { category: "Other", tags: ["kids", "kids"] },
    { category: "Productivity", tags: ["education"] },
  ]) {
    assert.equal(matchesKidsTaxonomy(plugin), true);
  }
  for (const plugin of [
    undefined,
    {},
    { category: "Productivity" },
    { category: "kids", tags: ["quickshell"] },
    { category: "Kids ", tags: ["quickshell"] },
    { category: "Productivity", tags: ["Kids", "EDUCATION"] },
    { category: "Productivity", tags: "education", description: "Kids education reference" },
    { category: "Productivity", tags: ["quickshell"], description: "Kids education reference" },
  ]) {
    assert.equal(matchesKidsTaxonomy(plugin), false);
  }

  const totals = catalogCategoryTotals([
    { category: "Kids", tags: ["games"] },
    { category: "Kids", tags: ["education"] },
    { category: "Other", tags: ["education"] },
    { category: "Productivity", tags: ["quickshell"] },
  ]);
  assert.equal([...totals.keys()].filter((category) => category === "Kids").length, 1);
  assert.equal(totals.get("Kids"), 3);
  assert.equal(totals.get("Other"), 1);
  assert.equal(totals.get("Productivity"), 1);
  assert.equal(catalogCategoryTotals([{ category: "Other", tags: [] }]).has("Kids"), false);
});

test("entry modules and their shared dependency use one cache key", async () => {
  const root = new URL("../", import.meta.url);
  const files = {
    index: await readFile(new URL("site/index.html", root), "utf8"),
    plugin: await readFile(new URL("site/plugin.html", root), "utf8"),
    publish: await readFile(new URL("site/publish.html", root), "utf8"),
    develop: await readFile(new URL("site/develop.html", root), "utf8"),
    explore: await readFile(new URL("site/explore.html", root), "utf8"),
    app: await readFile(new URL("site/assets/js/app.js", root), "utf8"),
    style: await readFile(new URL("site/assets/css/style.css", root), "utf8"),
    engagementFont: await readFile(new URL("site/assets/fonts/engagement-icons.woff2", root)),
    engagementFontLicense: await readFile(new URL("site/assets/fonts/engagement-icons.OFL.txt", root), "utf8"),
    engagementJs: await readFile(new URL("site/assets/js/engagement.js", root), "utf8"),
    sharedJs: await readFile(new URL("site/assets/js/shared.js", root), "utf8"),
    searchJs: await readFile(new URL("site/assets/js/search.js", root), "utf8"),
    taxonomyJs: await readFile(new URL("site/assets/js/taxonomy.js", root), "utf8"),
    pluginJs: await readFile(new URL("site/assets/js/plugin.js", root), "utf8"),
    publishJs: await readFile(new URL("site/assets/js/publish.js", root), "utf8"),
    developJs: await readFile(new URL("site/assets/js/develop.js", root), "utf8"),
    exploreJs: await readFile(new URL("site/assets/js/explore.js", root), "utf8"),
    exploreSearchJs: await readFile(new URL("site/assets/js/explore-search.js", root), "utf8"),
    readme: await readFile(new URL("README.md", root), "utf8"),
    security: await readFile(new URL("SECURITY.md", root), "utf8"),
    license: await readFile(new URL("LICENSE", root), "utf8"),
    notice: await readFile(new URL("NOTICE.md", root), "utf8"),
    thirdPartyNotices: await readFile(new URL("THIRD_PARTY_NOTICES.md", root), "utf8"),
    rightsRequest: await readFile(new URL(".github/ISSUE_TEMPLATE/rights-request.yml", root), "utf8"),
    favicon: await readFile(new URL("site/favicon.svg", root), "utf8"),
  };
  const keys = [
    files.index.match(/app\.js\?v=([^"']+)/)?.[1],
    files.plugin.match(/plugin\.js\?v=([^"']+)/)?.[1],
    files.publish.match(/publish\.js\?v=([^"']+)/)?.[1],
    files.develop.match(/develop\.js\?v=([^"']+)/)?.[1],
    files.app.match(/shared\.js\?v=([^"']+)/)?.[1],
    files.app.match(/engagement\.js\?v=([^"']+)/)?.[1],
    files.app.match(/search\.js\?v=([^"']+)/)?.[1],
    files.app.match(/taxonomy\.js\?v=([^"']+)/)?.[1],
    files.pluginJs.match(/shared\.js\?v=([^"']+)/)?.[1],
    files.pluginJs.match(/engagement\.js\?v=([^"']+)/)?.[1],
    files.publishJs.match(/shared\.js\?v=([^"']+)/)?.[1],
    files.developJs.match(/shared\.js\?v=([^"']+)/)?.[1],
    files.exploreJs.match(/shared\.js\?v=([^"']+)/)?.[1],
    files.exploreSearchJs.match(/search\.js\?v=([^"']+)/)?.[1],
  ];
  assert.ok(keys.every(Boolean));
  assert.equal(new Set(keys).size, 1);
  assert.equal(keys[0], "20260831-01");
  assert.equal(files.explore.match(/explore\.js\?v=([^"']+)/)?.[1], "20260905-01");
  assert.equal(files.exploreJs.match(/explore-search\.js\?v=([^"']+)/)?.[1], "20260831-01");
  assert.equal(files.exploreJs.match(/growth-range\.js\?v=([^"']+)/)?.[1], "20260828-18");
  const styleKeys = [files.index, files.plugin, files.publish, files.develop, files.explore]
    .map((html) => html.match(/style\.css\?v=([^"']+)/)?.[1]);
  assert.ok(styleKeys.every(Boolean));
  assert.equal(new Set(styleKeys).size, 1);
  assert.equal(styleKeys[0], "20260820-22");
  const faviconKeys = [files.index, files.plugin, files.publish, files.develop, files.explore]
    .map((html) => html.match(/favicon\.svg\?v=([^"']+)/)?.[1]);
  assert.ok(faviconKeys.every(Boolean));
  assert.equal(new Set(faviconKeys).size, 1);
  assert.match(files.index, /<title>Browse Plugins \| Omarchy Plugins<\/title>/);
  assert.match(files.index, /Browse community-built plugins for <a href="https:\/\/github\.com\/omacom\/omarchy\/tree\/quattro"[^>]*>Omarchy Quattro<\/a>/);
  assert.equal((files.index.match(/href="develop\.html"/g) || []).length, 2);
  assert.equal((files.index.match(/href="explore\.html"/g) || []).length, 2);
  assert.match(files.index, /class="market-hero-actions"[\s\S]*Browse plugins[\s\S]*href="develop\.html">Develop a plugin[\s\S]*Publish a plugin/);
  assert.match(files.index, /class="mobile-bottom"[\s\S]*>Home<[\s\S]*>Browse<[\s\S]*href="explore\.html"[\s\S]*>Explore<[\s\S]*>Publish</);
  for (const page of [files.plugin, files.develop, files.publish]) assert.match(page, /class="sidebar-link" href="explore\.html">Explore plugins<\/a>/);
  assert.match(files.index, /class="market-nav"[\s\S]*href="#catalog" aria-label="Browse plugins" aria-current="page">Browse[\s\S]*href="explore\.html">Explore[\s\S]*href="develop\.html" aria-label="Develop a plugin">Develop[\s\S]*aria-label="Contribute a plugin">Contribute[\s\S]*href="publish\.html" aria-label="Publish a plugin">Publish/);
  assert.match(files.develop, /class="sidebar-link active" href="develop\.html" aria-current="page">Development guide<\/a>/);
  assert.match(files.develop, /<span class="status"><i class="status-dot" aria-hidden="true"><\/i>Stable<\/span>/);
  assert.match(files.develop, /<dt>Status<\/dt><dd><span class="status-label">Stable<\/span><\/dd>/);
  assert.doesNotMatch(files.develop, />Draft<|status(?:-label)? is-caution[^>]*>Stable/);
  assert.match(files.publish, /class="sidebar-link active" href="publish\.html" aria-current="page">Publishing guide<\/a>/);
  assert.match(files.index, /id="catalog-pagination"[\s\S]*id="page-previous"[\s\S]*id="page-summary"[\s\S]*id="page-next"/);
  assert.match(files.index, /<\/nav>\s*<div id="catalog-view-toggle" class="catalog-view-toggle" hidden>\s*<button id="catalog-view-button" class="catalog-view-button" type="button" aria-controls="plugin-grid" aria-expanded="false">[\s\S]*id="catalog-view-label">Browse all plugins<[\s\S]*<span id="catalog-result-status" class="sr-only" role="status" aria-live="polite"><\/span>/);
  assert.doesNotMatch(files.index, /id="plugin-grid"[^>]*aria-live|id="page-announcement"|id="catalog-view-announcement"/);
  assert.match(files.index, /<div id="catalog-view-dock" class="catalog-view-dock" hidden>\s*<button id="catalog-view-dock-button" type="button">\s*<span id="catalog-view-dock-status">Showing all plugins<\/span>\s*<span class="catalog-view-dock-action">Show 9 per page/);
  assert.match(files.index, /class="footer-status-link footer-maintainer"[\s\S]*<div class="footer-resource-links">[\s\S]*class="footer-status-link" href="https:\/\/github\.com\/omacom\/omarchy-plugin-marketplace\/blob\/main\/LICENSE"[\s\S]*MIT LICENSE[\s\S]*class="footer-status-link" href="https:\/\/github\.com\/omacom\/omarchy-plugin-marketplace"[\s\S]*GITHUB/);
  assert.match(files.readme, /## License\s+\[MIT License\]\(LICENSE\) · \[Marketplace and third-party rights notice\]\(NOTICE\.md\)\s*$/);
  assert.match(files.notice, /The \[MIT License\]\(LICENSE\) applies only to original source code and associated documentation authored for this marketplace/);
  assert.match(files.notice, /does not grant rights to plugin code, repositories, names, trademarks, logos, screenshots, previews, or other third-party content/);
  assert.match(files.notice, /The marketplace relies on each submitter's rights confirmation\. A listing does not transfer ownership, verify third-party rights, or imply endorsement/);
  assert.match(files.notice, /If you believe a listing or asset infringes your rights,[\s\S]*issues\/new\?template=rights-request\.yml/);
  assert.match(files.readme, /## Engagement Metrics[\s\S]*anonymous aggregate detail views, successful command copies, and hearts[\s\S]*not downloads, installations, unique people, verified votes, rankings, or security signals/);
  assert.match(files.engagementJs, /https:\/\/api\.omarchyplugins\.com\/v1/);
  assert.match(files.engagementJs, /cache: "no-store",\s*credentials: "omit"/);
  assert.doesNotMatch(files.engagementJs, /Authorization|Bearer|apiKey|apiToken/);
  assert.match(files.app, /<svg class="social-glyph star-glyph" viewBox="0 0 14 14" aria-hidden="true">/);
  assert.match(files.sharedJs, /<span class="engagement-glyph" aria-hidden="true"><\/span>/);
  assert.match(files.sharedJs, /<span class="social-glyph heart-glyph" data-heart-glyph aria-hidden="true"><\/span>/);
  assert.deepEqual(new Set(`${files.app}${files.sharedJs}`.match(/[-]/g)), new Set(["", ""]));
  assert.match(files.style, /@font-face \{[\s\S]*font-family: "Omarchy Engagement Icons";[\s\S]*engagement-icons\.woff2\?v=20260816-02/);
  assert.equal(files.engagementFont.subarray(0, 4).toString("ascii"), "wOF2");
  assert.ok(files.engagementFont.byteLength > 1000 && files.engagementFont.byteLength < 10_000);
  assert.match(files.engagementFontLicense, /SIL OPEN FONT LICENSE Version 1\.1/);
  assert.match(files.thirdPartyNotices, /JetBrains Mono Nerd Font subset[\s\S]*engagement-icons\.woff2[\s\S]*heart and eye glyphs[\s\S]*engagement-icons\.OFL\.txt/);
  assert.match(files.app, /data-copy-command="\$\{escapeHtml\(plugin\.installCommand\)\}" data-plugin-id="\$\{escapeHtml\(plugin\.id\)\}"/);
  assert.match(files.app, /if \(!await copyText\(button\.dataset\.copyCommand, button\)\) return;[\s\S]*recordPluginCopy\(pluginId\)/);
  assert.match(files.pluginJs, /if \(!await copyText\(command, copyButton\)\) return;[\s\S]*recordPluginCopy\(plugin\.id\)/);
  assert.doesNotMatch(`${files.app}${files.pluginJs}`, /recordEngagementEvent\([^)]*, "copy"\)/);
  assert.match(files.pluginJs, /recordPluginView\(plugin\.id\)\.then\(applyAuthoritativeEngagement\)/);
  assert.match(files.pluginJs, /catch\(\(reason\) => \{[\s\S]*if \(!engagementLoaded\) \{[\s\S]*hidePendingEngagement\(document\)/);
  assert.match(files.pluginJs, /recordPluginHeart\(plugin\.id\)[\s\S]*showToast\("Heart could not be sent\. Try again\."\)[\s\S]*showToast\("Heart sent\."\)/);
  assert.match(files.app, /recordPluginHeart\(pluginId\)[\s\S]*showToast\("Heart could not be sent\. Try again\."\)[\s\S]*showToast\("Heart sent\."\)/);
  assert.match(files.sharedJs, /aria-disabled="true"[\s\S]*button\.disabled = false/);
  assert.doesNotMatch(files.sharedJs, /hearted \? " disabled"/);
  assert.match(files.rightsRequest, /name: Rights or asset removal request[\s\S]*id: material[\s\S]*id: basis[\s\S]*id: action[\s\S]*made in good faith/);
  assert.match(files.rightsRequest, /Do not include private contact details, identity documents, or other sensitive information/);
  assert.equal((files.readme.match(/^## License$/gm) || []).length, 1);
  assert.doesNotMatch(files.readme, /^## Licensing and third-party content$/m);
  assert.doesNotMatch(files.readme, /Original marketplace source code and associated documentation are available under the \[MIT License\]\(LICENSE\)/);
  assert.match(files.license, /^MIT License\n\nCopyright \(c\) 2026 HANCORE/);
  assert.match(files.license, /Permission is hereby granted, free of charge/);
  assert.doesNotMatch(files.license, /plugin code|trademarks|third-party content|Marketplace license scope/);
  assert.match(files.thirdPartyNotices, /Lucide[\s\S]*ISC License[\s\S]*Copyright \(c\) 2026 Lucide Icons and Contributors[\s\S]*Permission to use, copy, modify, and\/or distribute/);
  assert.match(files.favicon, /Cable icon geometry from Lucide[\s\S]*Copyright \(c\) 2026 Lucide Icons and Contributors[\s\S]*Permission to use, copy, modify, and\/or distribute[\s\S]*THE SOFTWARE IS PROVIDED "AS IS"/);
  assert.match(files.index, />Search plugins, tags, text, or authors<\/label>/);
  assert.match(files.index, /placeholder="Search plugins, tag:panel, text:bar, or @author…"/);
  assert.match(files.index, /<option value="updated">Recent activity<\/option>/);
  assert.match(files.index, /<option value="stars">Most starred<\/option>[\s\S]*<option value="views">Most viewed<\/option>[\s\S]*<option value="copies">Most copied<\/option>[\s\S]*<option value="hearts">Most hearts<\/option>/);
  assert.match(files.index, /<span class="sr-only">Sort or filter plugins<\/span>[\s\S]*<select id="sort-select">[\s\S]*<option value="name">A–Z<\/option>[\s\S]*<option value="verified">Verified<\/option>[\s\S]*<option value="unverified">Unverified<\/option>/);
  assert.doesNotMatch(files.index, /verification-bar|verification-select/);
  assert.match(files.app, /const engagementSorts = new Set\(\["views", "copies", "hearts"\]\)/);
  assert.match(files.app, /views: \(a, b\) => comparePluginEngagement\(a, b, state\.engagement, "views"\)/);
  assert.match(files.app, /copies: \(a, b\) => comparePluginEngagement\(a, b, state\.engagement, "copies"\)/);
  assert.match(files.app, /hearts: \(a, b\) => comparePluginEngagement\(a, b, state\.engagement, "hearts"\)/);
  assert.match(files.app, /state\.engagementEnabled = false;[\s\S]*renderSortOptions\(\);[\s\S]*state\.sort !== previousSort/);
  assert.match(files.app, /data-card-plugin="\$\{escapeHtml\(plugin\.id\)\}"/);
  assert.match(files.app, /state\.sort === sortMetric[\s\S]*render\(\);[\s\S]*restorePluginCardFocus\(focusToken\)/);
  assert.match(files.app, /Engagement loaded\. Sorted plugins by/);
  assert.match(files.app, /is unavailable because engagement stats could not be loaded/);
  assert.match(files.index, /id="search-input"[^>]*role="combobox"[^>]*aria-autocomplete="both"/);
  assert.doesNotMatch(files.index, /id="author-filter"|id="author-select"/);
  assert.match(files.index, /id="search-clear"[^>]*aria-label="Clear all search terms"/);
  assert.match(files.index, /id="search-terms"[^>]*aria-label="Active search terms"/);
  assert.match(files.index, /id="search-suggestions"[\s\S]*role="listbox"/);
  assert.match(files.index, /id="search-fish-preview"/);
  const securityReportUrl = "https://github.com/omacom/omarchy-plugin-marketplace/security/advisories/new";
  const verificationRequestUrl = "https://github.com/omacom/omarchy-plugin-marketplace/issues/new?template=verify-plugin.yml";
  assert.ok(files.pluginJs.includes(`const securityReportUrl = "${securityReportUrl}";`));
  assert.ok(files.pluginJs.includes(`const verificationRequestUrl = "${verificationRequestUrl}";`));
  const longSecurityNoticeStart = "Community plugins are developed and maintained by independent third parties.";
  const expectedSecurityNotice = [
    "Community plugins are developed and maintained by independent third parties. They execute as unsandboxed code and may access or modify files, settings, credentials, network resources, or other parts of your system according to their implementation and permissions.",
    "The Marketplace performs limited automated checks on the identified plugin commit and may conduct manual review. These checks are not a security audit, certification, endorsement, or guarantee that a plugin is safe, secure, error-free, or suitable for a particular purpose. Upstream code may change after review unless the installed version is explicitly pinned to the reviewed commit. Current Omarchy marketplace install and update commands clone mutable upstream HEAD and are not verification-bound.",
    `Before installation, review the plugin’s source code, requested capabilities, dependencies, and installation and removal instructions. Report suspected malicious or compromised plugins immediately through the [private security report form](${securityReportUrl}). The Marketplace may suspend or remove listings while concerns are investigated.`,
    "Nothing in this notice excludes or limits liability where exclusion or limitation is prohibited by applicable law.",
  ].join(" ");
  const securityNoticeStart = files.readme.indexOf("## Security Notice");
  const creditsStart = files.readme.indexOf("## Credits");
  assert.ok(securityNoticeStart >= 0 && creditsStart > securityNoticeStart);
  const securityNotice = files.readme
    .slice(securityNoticeStart + "## Security Notice".length, creditsStart)
    .replace(/^>\s?/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  assert.equal(securityNotice, expectedSecurityNotice);
  assert.doesNotMatch(files.readme, /^## Disclaimer$|Omarchy Plugins is an independent community project and is not affiliated with, sponsored by, or endorsed by Omarchy or 37signals\./m);
  assert.doesNotMatch(files.readme, /report suspicious plugins ASAP/);
  assert.match(files.security, /private vulnerability reporting form[\s\S]*security\/advisories\/new[\s\S]*Do not disclose credentials, exploit details, personal information, or other sensitive material in a public issue[\s\S]*may suspend or remove a listing/);
  assert.match(files.plugin, /<title>Plugin Details \| Omarchy Plugins<\/title>/);
  assert.match(files.plugin, /class="skip-link" href="#plugin-detail"/);
  assert.match(files.plugin, /id="aside-verification-link" href="#verification" hidden>Verification status<\/a>[\s\S]*id="aside-security-link" href="#security" hidden>Security Notice<\/a>[\s\S]*href="#terms">Terms of Use<\/a>/);
  assert.match(files.plugin, /id="mobile-install-link" href="#install" data-section-ids="install verification security">Install<\/a>/);
  assert.doesNotMatch(files.plugin, /href="#trust"|Trust & source/);
  assert.match(files.pluginJs, /const securityContext = plugin\.upstreamCheckStatus === "failed"[\s\S]*compatibility has not been confirmed[\s\S]*command[\s\S]*clones the repository’s current HEAD[\s\S]*pluginStatus === "Manual setup"[\s\S]*Manual installation follows the upstream project’s instructions/);
  assert.match(files.pluginJs, /class="callout prominent-callout install-security-note"[\s\S]*<strong id="security-notice-title">Security Notice<\/strong>[\s\S]*\$\{securityContext\}[\s\S]*Third-party plugins run as unsandboxed code[\s\S]*not a security audit or guarantee[\s\S]*report suspicious plugins ASAP/);
  assert.match(files.pluginJs, /const verificationStatusSection = isThirdPartyListing[\s\S]*<section class="detail-section" id="verification"><h2>Verification status<\/h2><div class="placeholder-install verification-status-note"><ul class="verification-status-list">\$\{snapshotNotice\}\$\{updateNotice\}\$\{contributorAction\}<\/ul><\/div><\/section>/);
  assert.match(files.pluginJs, /snapshotNotice[\s\S]*verification-snapshot[\s\S]*Snapshot verified:<\/strong> Marketplace verification covers only the exact commit[\s\S]*verification-unverified[\s\S]*Snapshot unverified:<\/strong> This listed commit has not been verified/);
  assert.match(files.pluginJs, /updateNotice[\s\S]*verification-update[\s\S]*Update unverified:<\/strong> The latest upstream changes have not been verified/);
  assert.match(files.pluginJs, /contributorAction[\s\S]*Submit the new exact commit[\s\S]*Submit the exact listed commit[\s\S]*plugin verification form/);
  assert.match(files.pluginJs, /const securityNoticeSection = installSecurityNotice[\s\S]*<section class="detail-section security-notice-section" id="security" aria-labelledby="security-notice-title">\$\{installSecurityNotice\}<\/section>/);
  assert.match(files.pluginJs, /!installAvailable[\s\S]*class="placeholder-install"[\s\S]*: `\$\{commandPanel\}\$\{installNote\}`[\s\S]*id="install"[\s\S]*\$\{verificationStatusSection\}[\s\S]*\$\{securityNoticeSection\}[\s\S]*id="terms"/);
  assert.match(files.pluginJs, /class="detail-section\$\{isThirdPartyListing \? " detail-section-before-verification" : ""\}" id="install"/);
  assert.match(files.pluginJs, /#aside-verification-link[\s\S]*hidden = !content\.querySelector\("#verification"\)[\s\S]*#aside-security-link[\s\S]*hidden = !content\.querySelector\("#security"\)/);
  assert.doesNotMatch(files.pluginJs, /verification-action-prompt/);
  assert.match(files.pluginJs, /issues\/new\?template=verify-plugin\.yml/);
  assert.doesNotMatch(files.pluginJs, /update-plugin\.yml/);
  assert.match(files.pluginJs, /security\/advisories\/new/);
  assert.match(files.pluginJs, /const displayedInstallNote = installAvailable && plugin\.repositoryLayout === "root-plugin"\s*\? ""[\s\S]*const installNote = displayedInstallNote\s*\? `<p class="install-note">\$\{escapeHtml\(displayedInstallNote\)\}<\/p>`\s*:\s*""/);
  assert.doesNotMatch(files.pluginJs, /Mutable upstream installation|Omarchy clones the current upstream repository, validates it locally/);
  assert.match(files.pluginJs, /function safeGitHubWebUrl\(value\)[\s\S]*url\.protocol !== "https:"[\s\S]*url\.hostname !== "github\.com"[\s\S]*return url\.href/);
  assert.match(files.pluginJs, /const repositoryReleaseUrl = safeGitHubWebUrl\(plugin\.repositoryRelease\?\.url\)[\s\S]*plugin\.repositoryRelease\?\.tag && repositoryReleaseUrl[\s\S]*: "No release tag"/);
  assert.match(files.pluginJs, /<dt>Last checked<\/dt>[\s\S]*<dt>Last known release<\/dt><dd>\$\{repositoryRelease\}<\/dd>[\s\S]*\$\{check\.commitLabel\}/);
  assert.match(files.pluginJs, /<dt>\$\{snapshotVerified \? "Verified snapshot" : "Listing snapshot"\}[\s\S]*snapshotVerified \? "View verified snapshot" : "View listing snapshot"/);
  assert.doesNotMatch(files.pluginJs, /terms-source-note"><strong>Repository release|does not replace this plugin’s manifest version/);
  assert.match(files.pluginJs, /<section class="detail-section" id="terms"><h2>Terms of Use<\/h2>/);
  assert.match(files.pluginJs, /if \(currentHashId\(\) === "trust"\) \{[\s\S]*url\.hash = "terms";[\s\S]*history\.replaceState\(history\.state, "", url\)/);
  assert.match(files.pluginJs, /const targetId = currentHashId\(\);[\s\S]*let allowDeferredScroll = true;[\s\S]*currentHashId\(\) !== targetId[\s\S]*pointerdown[\s\S]*wheel[\s\S]*touchstart[\s\S]*keydown/);
  assert.equal(files.pluginJs.includes(longSecurityNoticeStart), false);
  assert.doesNotMatch(files.pluginJs, /id="trust"|Trust & source|trust-source-note|report suspicious plugins immediately/);
  assert.match(files.publish, /<title>Publish a Plugin \| Omarchy Plugins<\/title>/);
  assert.match(files.publish, /class="skip-link" href="#main-content"/);
  assert.match(files.publish, /href="develop\.html">Development guide<\/a>/);
  assert.match(files.develop, /<title>Develop a Plugin \| Omarchy Plugins<\/title>/);
  assert.match(files.develop, /class="skip-link" href="#main-content"/);
  assert.match(files.develop, /omarchy plugin clone omarchy\.clock --edit/);
  assert.doesNotMatch(files.develop, /id="requirements"|href="#requirements"|<h2>Requirements<\/h2>/);
  assert.doesNotMatch(files.develop, /id="share"|href="#share"|<h2>Prepare to Share<\/h2>/);
  assert.match(
    files.develop,
    /<h2>Clone a Built-in Plugin<\/h2>[\s\S]*Match the runtime contract[\s\S]*Expect an immediate switch[\s\S]*omarchy plugin clone omarchy\.clock --edit[\s\S]*On success, the command prints the new plugin ID/,
  );
  assert.match(
    files.develop,
    /<div class="callout"><strong>Keep the clone ID while developing\.<\/strong><p>Use the exact ID printed by the command, such as <code class="inline-code" translate="no">yourname\.clock<\/code>, in every development example below\. Saved changes reload automatically\. Force discovery only when needed:<\/p><code class="inline-code callout-command" translate="no" tabindex="0" role="region" aria-label="Plugin discovery command">omarchy-shell shell rescanPlugins<\/code><p>Choose the permanent namespaced ID before publishing\.<\/p><\/div>\s*<p class="official-reference">Browse the/,
  );
  assert.match(
    files.develop,
    /<h2>Define the Plugin Contract<\/h2>[\s\S]*class="kind-reference"[\s\S]*For this tutorial, keep[\s\S]*class="manifest-reference development-example"/,
  );
  assert.equal((files.develop.match(/class="kind-reference"/g) || []).length, 1);
  assert.equal((files.develop.match(/class="manifest-reference development-example"/g) || []).length, 3);
  assert.doesNotMatch(files.develop, /<details class="manifest-reference development-example" open/);
  assert.match(files.develop, /href="#contract">Contract<\/a>/);
  assert.match(files.develop, /<th scope="col">Plugin kind<\/th>[\s\S]*<th scope="col"><code>entryPoints<\/code> key<\/th>[\s\S]*<th scope="col">File loaded<\/th>/);
  assert.match(files.develop, /<td><code>bar-widget<\/code><\/td><td><code>barWidget<\/code><\/td><td><code>BarWidget\.qml<\/code><\/td>/);
  assert.match(files.develop, /<td><code>panel<\/code><\/td><td><code>panel<\/code><\/td><td><code>Panel\.qml<\/code><\/td>/);
  assert.equal((files.develop.match(/class="example-file-tree" role="group" aria-label="Finished custom clock repository files"/g) || []).length, 1);
  assert.equal((files.develop.match(/class="manifest-reference example-file"/g) || []).length, 5);
  assert.equal((files.develop.match(/<details class="manifest-reference/g) || []).length, 8);
  assert.equal((files.develop.match(/class="tree-branch" aria-hidden="true"><\/span>/g) || []).length, 5);
  assert.doesNotMatch(files.develop, /class="tree-branch"[^>]*>[├└]──/);
  assert.match(files.develop, /<h2>Implement the Bar and Panel<\/h2>/);
  assert.match(files.develop, /"omarchy"<\/span>: \{ <span class="syntax-key">"clonedFrom"<\/span>: <span class="syntax-string">"omarchy\.clock"<\/span> \}/);
  assert.doesNotMatch(files.develop, /panel alternative|yourname\.panel|Quickshell\.Wayland/);
  const decodeCopyValue = (value) => value
    .replaceAll("&#10;", "\n")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
  const copyButtons = [...files.develop.matchAll(/<button class="copy-button"[^>]*>/g)];
  assert.equal(copyButtons.length, 13);
  const copyButtonLabels = copyButtons.map((match) => match[0].match(/\baria-label="([^"]+)"/)?.[1]);
  assert.ok(copyButtonLabels.every((label) => label?.trim()));
  assert.equal(new Set(copyButtonLabels).size, copyButtonLabels.length);
  assert.deepEqual(copyButtonLabels, [
    "Copy clone command",
    "Copy development manifest.json",
    "Copy development BarWidget.qml",
    "Copy development Panel.qml",
    "Copy validation commands",
    "Copy plugin status command",
    "Copy panel open command",
    "Copy panel close command",
    "Copy finished manifest.json",
    "Copy finished BarWidget.qml",
    "Copy finished Panel.qml",
    "Copy finished README.md",
    "Copy finished LICENSE",
  ]);
  const copiedExample = (label) => decodeCopyValue(
    copyButtons.find((match) => match[0].includes(`aria-label="${label}"`))
      ?.[0].match(/data-copy='([^']*)'/)?.[1] || "",
  );
  const visibleCopiedExample = (label) => decodeCopyValue(
    files.develop.match(new RegExp(
      `aria-label="${label.replaceAll(".", "\\.")}"[^>]*>[\\s\\S]*?<\\/button><\\/div><pre><code>([\\s\\S]*?)<\\/code><\\/pre>`,
    ))?.[1].replace(/<[^>]+>/g, "").replace(/\n$/, "") || "",
  );
  const developmentManifest = copiedExample("Copy development manifest.json");
  const developmentBarWidget = copiedExample("Copy development BarWidget.qml");
  const developmentPanel = copiedExample("Copy development Panel.qml");
  assert.deepEqual(
    JSON.parse(visibleCopiedExample("Copy development manifest.json")),
    JSON.parse(developmentManifest),
  );
  assert.equal(visibleCopiedExample("Copy development BarWidget.qml"), developmentBarWidget);
  assert.equal(visibleCopiedExample("Copy development Panel.qml"), developmentPanel);
  const finished = files.develop.match(/<section class="docs-section" id="finished">([\s\S]*?)<section class="docs-section" id="troubleshooting">/)?.[1] || "";
  const exampleFileMatches = [...finished.matchAll(
    /<details class="manifest-reference example-file">[\s\S]*?<summary>[\s\S]*?<code>([^<]+)<\/code>[\s\S]*?<button class="copy-button"[^>]*data-copy='([^']*)'[\s\S]*?<pre><code>([\s\S]*?)<\/code><\/pre>[\s\S]*?<\/details>/g,
  )];
  const exampleFiles = Object.fromEntries(exampleFileMatches
    .map((match) => [match[1], decodeCopyValue(match[2])]));
  const visibleExampleFiles = Object.fromEntries(exampleFileMatches
    .map((match) => [match[1], decodeCopyValue(match[3].replace(/<[^>]+>/g, "").replace(/\n$/, ""))]));
  assert.deepEqual(Object.keys(exampleFiles).sort(), ["BarWidget.qml", "LICENSE", "Panel.qml", "README.md", "manifest.json"]);
  const exampleManifest = JSON.parse(exampleFiles["manifest.json"]);
  assert.deepEqual(JSON.parse(visibleExampleFiles["manifest.json"]), exampleManifest);
  for (const filename of ["BarWidget.qml", "Panel.qml", "README.md", "LICENSE"]) {
    assert.equal(visibleExampleFiles[filename], exampleFiles[filename]);
  }
  assert.deepEqual(exampleManifest.kinds, ["bar-widget"]);
  assert.deepEqual(exampleManifest.entryPoints, { barWidget: "BarWidget.qml" });
  assert.equal(exampleManifest.license, "MIT");
  assert.equal(Object.hasOwn(exampleManifest, "omarchy"), false);
  assert.match(exampleFiles["BarWidget.qml"], /moduleName: "io\.github\.yourname\.custom-clock"/);
  assert.match(exampleFiles["BarWidget.qml"], /source: Qt\.resolvedUrl\("Panel\.qml"\)/);
  const assertBarWidgetLifecycle = (source) => {
    assert.match(source, /readonly property bool opened:/);
    for (const method of ["open", "close", "toggle", "closeForPopoutSwitch"]) {
      assert.match(
        source,
        new RegExp(`function ${method}\\(\\) \\{\\s*if \\(panelLoader\\.item\\) panelLoader\\.item\\.${method}\\(\\)\\s*\\}`),
      );
    }
    assert.match(source, /onPressed: function\(buttonCode\) \{\s*if \(buttonCode === Qt\.LeftButton\) root\.toggle\(\)\s*\}/);
  };
  const assertPanelLifecycle = (source) => {
    assert.match(source, /^Panel \{/m);
    assert.match(source, /function open\(\) \{\s*root\.controller\.show\(\)\s*\}/);
    assert.match(source, /function close\(\) \{\s*root\.controller\.hide\(\)\s*\}/);
    assert.match(
      source,
      /function switchPanel\(direction\) \{\s*if \(root\.bar && typeof root\.bar\.switchPanelFrom === "function"\)\s*return root\.bar\.switchPanelFrom\(root\.hostWidget \|\| root, direction\)\s*return false\s*\}/,
    );
    assert.match(source, /onCloseRequested: root\.close\(\)/);
    assert.match(source, /onTabRequested: function\(direction\) \{ root\.switchPanel\(direction\) \}/);
  };
  assertBarWidgetLifecycle(developmentBarWidget);
  assertBarWidgetLifecycle(exampleFiles["BarWidget.qml"]);
  assertPanelLifecycle(developmentPanel);
  assertPanelLifecycle(exampleFiles["Panel.qml"]);
  assert.match(exampleFiles["Panel.qml"], /moduleName: "io\.github\.yourname\.custom-clock"/);
  assert.match(exampleFiles["README.md"], /omarchy plugin add https:\/\/github\.com\/yourname\/custom-clock\.git --enable/);
  assert.match(exampleFiles["README.md"], /Click the clock to open or close the details panel/);
  assert.match(exampleFiles["README.md"], /omarchy plugin remove io\.github\.yourname\.custom-clock/);
  assert.match(
    exampleFiles.LICENSE,
    /Copyright \(c\) David Heinemeier Hansson\nCopyright \(c\) 2026 Your name/,
  );
  const troubleshooting = files.develop.match(/<section class="docs-section" id="troubleshooting">([\s\S]*?)<\/section>/)?.[1] || "";
  assert.match(troubleshooting, /class="check-list troubleshooting-list"/);
  assert.doesNotMatch(troubleshooting, /<small>|<strong><code>/);
  assert.match(troubleshooting, /<code class="inline-code" translate="no">~\/\.config\/omarchy\/plugins\/<\/code>/);
  for (const [pageName, html] of [["develop", files.develop], ["publish", files.publish]]) {
    assert.doesNotMatch(html, /<span class="inline-code"/, `${pageName} legacy inline-code span`);
    const proseWithCode = [...html.matchAll(/<(p|small|strong)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g)]
      .map((match) => match[2])
      .filter((content) => content.includes("<code"));
    assert.ok(proseWithCode.length > 0, `${pageName} inline-code prose`);
    assert.ok(
      proseWithCode.every((content) => !/<code(?! class="inline-code" translate="no")/.test(content)),
      `${pageName} naked prose code`,
    );
  }
  assert.match(files.develop, /Both files belong to one <code class="inline-code" translate="no">bar-widget<\/code> plugin\./);
  assert.match(files.publish, /Valid <code class="inline-code" translate="no">manifest\.json<\/code> in the repository root/);
  assert.match(files.develop, /omarchy plugin validate/);
  assert.match(files.develop, /qs log -p/);
  assert.doesNotMatch(files.develop, /<script[^>]+src=["']https?:/);
  assert.match(files.index, /<h2 id="recent-title">RECENTLY ADDED<\/h2>/);
  assert.match(files.publish, /<span>3 min read<\/span>/);
  assert.equal((files.publish.match(/class="docs-section"/g) || []).length, 3);
  assert.match(files.publish, /<details class="manifest-reference">/);
  assert.doesNotMatch(files.publish, /id="review"|class="review-flow"|step-number">04/);
  assert.match(files.pluginJs, /document\.title = `\$\{plugin\.name\} \| Omarchy Plugins`/);
  assert.match(files.pluginJs, /<section class="listing-checks" aria-labelledby="listing-checks-title">/);
  assert.match(files.pluginJs, /sectionSelector: "#detail-content \.plugin-detail-article > \[id\]"/);
  assert.match(files.pluginJs, /Compatibility[\s\S]*Last checked[\s\S]*check\.commitLabel[\s\S]*snapshotVerified \? "Verified snapshot" : "Listing snapshot"[\s\S]*Branch[\s\S]*Upstream changes/);
  assert.match(files.pluginJs, /\/compare\/\$\{comparedCommits\.listingCommit\}\.\.\.\$\{comparedCommits\.upstreamCommit\}/);
  assert.doesNotMatch(files.pluginJs, /Listing provenance/);
  assert.match(files.index, /class="market-hero-ray"[\s\S]*<canvas width="400" height="300" aria-hidden="true"><\/canvas>/);
  assert.match(files.app, /function setupHeroRay\(\)/);
  assert.match(files.app, /!catalog \|\| !Array\.isArray\(catalog\.plugins\)/);
  assert.match(files.app, /sourcePointCount = 6000/);
  assert.match(files.app, /"ORIGINAL"[\s\S]*"COCOON"[\s\S]*"STORM"[\s\S]*"RAY"[\s\S]*"BIRD"[\s\S]*"WING"/);
  assert.match(files.app, /runVisibleAnimation\(frame, draw, 30\)/);
  assert.match(files.app, /const pluginsPerPage = 9/);
  assert.match(files.app, /\["updated", "Recent activity"\]/);
  assert.match(files.app, /updated: \(a, b\) => activityTime\(b\) - activityTime\(a\)/);
  assert.match(files.sharedJs, /export function publisherLogin\(plugin\)/);
  assert.doesNotMatch(files.app, /function publisherLogin\(plugin\)/);
  assert.match(files.app, /publisherLogin/);
  assert.doesNotMatch(files.app, /function exactPublisher\(value\)|state\.author/);
  assert.match(files.app, /function pluginSearchContext\(plugin\)/);
  assert.match(files.app, /function pluginMatchesActiveSearch\(plugin\)/);
  assert.match(files.app, /matchesDirectSearch\(term\.value, matchContext\)/);
  assert.match(files.app, /const verificationFilters = new Set\(\["verified", "unverified"\]\)/);
  assert.match(files.app, /function searchScopePlugins\(\) \{[\s\S]*matchesCatalogFilter\(plugin\)[\s\S]*!verificationFilters\.has\(state\.sort\) \|\| matchesVerificationStatus\(plugin, state\.sort\)/);
  assert.match(files.app, /function completionMatches\(value\) \{[\s\S]*const query = foldSearchTerm\([\s\S]*const plugins = searchScopePlugins\(\)/);
  assert.match(files.app, /type: "kind",[\s\S]*label: `kind:\$\{key\}`,[\s\S]*matchValue: label,[\s\S]*detail: label/);
  assert.match(files.app, /type: "fulltext",[\s\S]*insertValue: searchTermInputValue\(fulltextTerm\),[\s\S]*detail: "broad search"/);
  assert.match(files.app, /completion\.type === "fulltext" \? "text" : completion\.type/);
  assert.match(files.app, /"Search plugins, tag:panel, text:bar, or @author…"/);
  assert.match(files.app, /function filteredPlugins\(\) \{[\s\S]*searchScopePlugins\(\)\.filter\(\(plugin\) => pluginMatchesActiveSearch\(plugin\)\)/);
  assert.match(files.app, /const taxonomyFilterTags = \["ai", "games", "security"\]/);
  assert.match(files.app, /if \(filter === "Kids"\) return matchesKidsTaxonomy\(plugin\)/);
  assert.match(files.app, /const categoryTotals = catalogCategoryTotals\(plugins\)/);
  assert.match(files.taxonomyJs, /export function catalogCategoryTotals\(plugins\)/);
  assert.doesNotMatch(files.app, /taxonomyFilterTags = \[[^\]]*"kids"/);
  assert.match(files.app, /value: `tag:\$\{tag\}`/);
  assert.match(files.app, /return labels\.length \? labels : \[category \|\| "System"\]/);
  assert.match(files.sharedJs, /function matchesVerificationStatus\(plugin, status\) \{[\s\S]*!plugin\?\.builtIn[\s\S]*plugin\?\.repositoryLayout !== "suite"[\s\S]*plugin\?\.verificationStatus === status/);
  assert.match(files.searchJs, /function fuzzyScore\(query, candidate\)/);
  assert.match(files.searchJs, /function rankSearchCompletions\(matches\)/);
  assert.match(files.searchJs, /function selectSearchCompletions\(matches, limit = 3\)/);
  assert.match(files.searchJs, /function searchTokens\(value\)/);
  assert.match(files.searchJs, /function currentSearchToken\(value\)/);
  assert.match(files.searchJs, /function matchesShortSearch\(query, primaryText, searchText\)/);
  assert.match(files.searchJs, /function createSearchTerm\(type, value\)/);
  assert.match(files.searchJs, /function hasFulltextSearchDraft\(value\)/);
  assert.match(files.searchJs, /function parseSearchDraft\(value\)/);
  assert.match(files.searchJs, /function appendSearchState\(params, \{ terms, draft \}\)/);
  assert.match(files.searchJs, /function readSearchState\(params\)/);
  assert.match(files.searchJs, /function matchesCommittedSearchTerm\(term, \{/);
  assert.match(files.searchJs, /function matchesDirectSearch\(value, \{/);
  assert.match(files.searchJs, /function pluginKindKey\(value\)/);
  assert.match(files.searchJs, /normalized\.type === "kind"\) return pluginKindKey\(pluginKind\) === requested/);
  assert.doesNotMatch(files.searchJs, /exactPluginKindSearches|matchesTextSearch/);
  assert.match(files.searchJs, /function handleSearchEscape\(event,/);
  assert.match(files.searchJs, /function inlineSearchCompletionSuffix\(suggestion, value\) \{[\s\S]*const normalizedValue = normalizeSearchTerm\(value\);[\s\S]*foldSearchTerm\(completed\)/);
  assert.match(files.searchJs, /function searchPhraseKey\(value\)/);
  assert.match(files.searchJs, /function searchKeyAction\(\{/);
  assert.match(files.app, /function completionMatches\(value\) \{\s*if \(hasFulltextSearchDraft\(value\)\) return \[\]/);
  assert.match(files.app, /function updateSearchSuggestions\(\)/);
  assert.match(files.app, /searchCompletions = completionMatches\(search\.value\);\s*activeSuggestion = -1;\s*search\.removeAttribute\("aria-activedescendant"\)/);
  assert.match(files.app, /function inlineSuggestionIndex\(\)/);
  assert.match(files.app, /function updateFishPreview\(\)/);
  assert.match(files.app, /class="search-query-summary"/);
  assert.match(files.app, /tabindex="-1" aria-selected="false"/);
  assert.match(files.app, /\$\{visible\.length\} of \$\{categoryPlugins\.length\}/);
  assert.match(files.app, /const hasResultFilter = hasSearch \|\| verificationFilters\.has\(state\.sort\);[\s\S]*count\.textContent = hasResultFilter/);
  assert.match(files.app, /state\.terms\.some\(\(term\) =>[\s\S]*matchesCommittedSearchTerm\(term, matchContext\)/);
  assert.match(files.app, /typedDraftTerms\.some\(\(term\) =>[\s\S]*matchesDraftSearchTerm\(term, matchContext\)/);
  assert.match(files.app, /return matchesTerm \|\| matchesTextDraft \|\| matchesTypedDraft/);
  assert.match(files.app, /const action = searchKeyAction\(\{/);
  assert.doesNotMatch(files.app, /\["Tab", "Enter", "ArrowRight"\]/);
  assert.match(files.app, /data-author=/);
  assert.match(files.app, /appendSearchState\(params, \{ terms: state\.terms, draft: state\.query \}\)/);
  assert.match(files.app, /if \(state\.sort !== sourceDefaultSort\(\)\) params\.set\("sort", state\.sort\)/);
  assert.match(files.app, /readSearchState\(params\)/);
  assert.match(files.app, /const requestedSort = params\.get\("sort"\) \|\| sourceDefaultSort\(\);[\s\S]*availableSortOptions\(\)\.some\(\(\[value\]\) => value === requestedSort\)/);
  assert.match(files.app, /const searchTermTypeLabels = \{[\s\S]*fulltext: "TEXT"[\s\S]*kind: "KIND"/);
  assert.match(files.app, /class="search-term-type"/);
  assert.match(files.app, /function commitSearchDraft\(completion\)/);
  assert.match(files.app, /function clearSearchTerms\(\{ focus = true \} = \{\}\)/);
  assert.match(files.app, /function removeSearchTerm\(index\)/);
  assert.match(files.app, /function searchResultMessage\(action\) \{[\s\S]*`\$\{action\}\. \$\{totalItems\} search result/);
  assert.match(files.app, /function removeSearchTerm\(index\) \{[\s\S]*render\(\);[\s\S]*searchSuggestionStatus\.textContent = searchResultMessage/);
  assert.match(files.app, /function commitSearchDraft\(completion\) \{[\s\S]*render\(\);[\s\S]*searchSuggestionStatus\.textContent = searchResultMessage/);
  assert.match(files.app, /function clearSearchTerms\(\{ focus = true \} = \{\}\) \{[\s\S]*render\(\);[\s\S]*searchSuggestionStatus\.textContent = searchResultMessage/);
  assert.match(files.app, /const pagePlugins = state\.showAll\s*\? visible\s*: visible\.slice\(pageState\.start, pageState\.end\)/);
  assert.match(files.app, /const controls = catalogViewControls\(totalItems, state\.showAll, pluginsPerPage\)/);
  assert.match(files.app, /document\.body\.classList\.toggle\("catalog-show-all", controls\.reserveDockSpace\)/);
  assert.match(files.app, /pagination\.hidden = controls\.paginationHidden/);
  assert.match(files.app, /viewToggle\.hidden = controls\.browseAllHidden/);
  assert.match(files.app, /viewDock\.hidden = controls\.dockHidden/);
  assert.match(files.app, /viewLabel\.textContent = `Browse all \$\{totalItems\} \$\{sourceLabel\} plugin/);
  assert.match(files.app, /viewDockStatus\.textContent = totalItems === 0[\s\S]*`No \$\{sourceLabel\} plugins found`[\s\S]*`Showing all \$\{totalItems\}/);
  assert.match(files.app, /function placeViewDock\(\) \{[\s\S]*document\.querySelector\("#site-footer"\)\?\.before\(viewDock\)[\s\S]*grid\.insertBefore\(viewDock, cards\[pluginsPerPage\]\)/);
  assert.match(files.app, /appendCatalogViewState\(params, \{ showAll: state\.showAll, page: state\.page \}\)/);
  assert.match(files.app, /const viewState = readCatalogViewState\(params\);[\s\S]*state\.showAll = viewState\.showAll;[\s\S]*state\.page = viewState\.page/);
  assert.match(files.app, /function restoreViewScroll\(scrollTop\) \{[\s\S]*cancelViewScroll\(\);[\s\S]*if \(state\.showAll\) window\.scrollTo/);
  assert.match(files.app, /function focusCatalogResult\(\) \{[\s\S]*resultLinks\[pluginsPerPage\] \|\| resultLinks\[0\] \|\| viewDockButton[\s\S]*resultLinks\[0\] \|\| document\.querySelector\("#empty-reset"\)/);
  assert.match(files.app, /function catalogControlFocusToken\(active\) \{[\s\S]*active === searchClear[\s\S]*type: "search-clear"[\s\S]*type: "source"[\s\S]*type: "category"[\s\S]*type: "term"[\s\S]*searchTermKey/);
  assert.match(files.app, /function restoreCatalogControlFocus\(token\) \{[\s\S]*searchClear\.hidden \? search : searchClear[\s\S]*button\.dataset\.source === state\.source[\s\S]*button\.dataset\.category === state\.category[\s\S]*=== token\.key\)[\s\S]*\|\| search/);
  assert.match(files.app, /viewButton\.addEventListener\("click", \(\) => \{[\s\S]*state\.showAll = true;[\s\S]*resultLinks\[pluginsPerPage\]\?\.focus\(\{ preventScroll: true \}\);[\s\S]*restoreViewScroll\(previousScrollTop\)/);
  assert.match(files.app, /viewDockButton\.addEventListener\("click", \(\) => \{[\s\S]*state\.showAll = false;[\s\S]*focusCatalogResult\(\);[\s\S]*grid\.scrollIntoView/);
  assert.match(files.app, /history\[historyMode === "push" \? "pushState" : "replaceState"\]/);
  assert.match(files.app, /sort\.addEventListener\("change", \(\) => \{[\s\S]*state\.sort = sort\.value;[\s\S]*state\.page = 1;[\s\S]*render\(\{ announce: true \}\)/);
  assert.match(files.app, /function resetFilters\(\) \{[\s\S]*verificationFilters\.has\(state\.sort\)[\s\S]*state\.sort = sourceDefaultSort\(\);[\s\S]*renderSortOptions\(\)/);
  assert.match(files.app, /window\.addEventListener\("popstate", \(\) => \{[\s\S]*const controlFocus = catalogControlFocusToken\(active\);[\s\S]*const catalogHadFocus = Boolean\(controlFocus\)[\s\S]*restoreUrl\(\);[\s\S]*render\(\{ historyMode: "replace", announce: true \}\);[\s\S]*if \(!restoreCatalogControlFocus\(controlFocus\) && catalogHadFocus\) focusCatalogResult\(\)/);
  assert.match(files.app, /const removedAuthorSearch = removedAuthorTerms\.length \|\| removedAuthorDraft;[\s\S]*render\(\{ announce: !removedAuthorSearch \}\);[\s\S]*searchSuggestionStatus\.textContent = searchResultMessage/);
  assert.match(files.app, /firstResult\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(files.app, /new MutationObserver\(\(\) => \{[\s\S]*updateColors\(\);[\s\S]*if \(reducedMotion\) window\.requestAnimationFrame\(\(now\) => draw\(now\)\)/);
  assert.match(files.publishJs, /sectionSelector: "#overview, \.docs-section"/);
  assert.match(files.developJs, /sectionSelector: "#overview, \.docs-section"/);
  assert.doesNotMatch(files.plugin, /<div class="sidebar-group"><div class="sidebar-group-title">Plugin<\/div>/);
  assert.doesNotMatch(files.pluginJs, /install-nav-link|left-sidebar \.sidebar-link\[href\^='#'\]/);
  assert.match(files.pluginJs, /const versionLabel = pluginVersionLabel\(plugin\)/);
  assert.match(files.pluginJs, /versionLabel\.replace\(\/\^manifest\\s\+\//);
  assert.match(files.plugin, /<dt>Availability<\/dt><dd id="aside-status">—<\/dd>/);
  assert.match(files.plugin, /id="aside-verification-row"><dt>Verification<\/dt><dd id="aside-verification">—<\/dd>/);
  assert.match(files.pluginJs, /const verificationBadge = detailVerificationBadge\(plugin\)/);
  assert.match(files.pluginJs, /class="detail-status-meta">[\s\S]*\$\{verificationBadge\}<\/span><\/div>/);
  assert.match(files.pluginJs, /verificationRow\.hidden = !verification/);
  assert.match(files.pluginJs, /function asideVerificationBadge\(verification\)[\s\S]*label === "Snapshot verified" \? "" : " is-unverified"[\s\S]*class="aside-verification-marker status-label\$\{tone\}"/);
  assert.match(files.pluginJs, /innerHTML = asideVerificationBadge\(verification\);/);
  assert.doesNotMatch(files.pluginJs, /data-verification-tooltip|card-verification-tooltip|bindDetailVerificationTooltip/);
  assert.doesNotMatch(files.publishJs, /left-sidebar \.sidebar-link\[href\^='#'\]/);
  assert.match(files.publishJs, /markerRatio: 0\.25,[\s\S]*markerMax: 160,[\s\S]*activateLastAtPageEnd: true/);
  assert.match(files.publish, /href="#overview" data-section-ids="overview requirements">Guide<\/a>/);
  const sharedJs = await readFile(new URL("site/assets/js/shared.js", root), "utf8");
  assert.match(sharedJs, /markerRatio = 0\.55,[\s\S]*markerMax = Number\.POSITIVE_INFINITY,[\s\S]*activateLastAtPageEnd = true/);
  assert.match(sharedJs, /link\.dataset\.sectionIds[\s\S]*sectionIds\.includes\(id\)/);
  assert.match(sharedJs, /window\.scrollY \+ Math\.min\(markerMax, window\.innerHeight \* markerRatio\)/);
  assert.match(sharedJs, /section\.getBoundingClientRect\(\)\.top \+ window\.scrollY/);
  assert.match(sharedJs, /\$\{current\} theme active; switch to \$\{next\} theme/);
  assert.match(sharedJs, /Copy failed\. Select and copy manually\./);
  assert.match(files.pluginJs, /title: "Catalog unavailable"/);
  assert.match(files.pluginJs, /title: "Plugin not found"/);
  assert.match(files.pluginJs, /!catalog \|\| !Array\.isArray\(catalog\.plugins\)/);
  assert.match(files.pluginJs, /item\?\.id === id/);
  const styles = await readFile(new URL("site/assets/css/style.css", root), "utf8");
  assert.match(files.plugin, /<dialog class="preview-lightbox" id="preview-lightbox" aria-label="Plugin preview"><\/dialog>/);
  assert.match(files.pluginJs, /setupPreviewLightbox\(content, document\.querySelector\("#preview-lightbox"\)\)/);
  assert.doesNotMatch(files.pluginJs, /dialog\.innerHTML/);
  assert.match(styles, /\.preview-lightbox \{[\s\S]*overscroll-behavior: contain;/);
  assert.match(styles, /html:has\(\.preview-lightbox\[open\]\) \{ overflow: hidden; scrollbar-gutter: stable; \}/);
  assert.match(styles, /\.preview-lightbox\[open\] \{ display: flex;/);
  assert.match(styles, /top: calc\(16px \+ env\(safe-area-inset-top\)\);[\s\S]*right: calc\(16px \+ env\(safe-area-inset-right\)\);[\s\S]*width: 44px; height: 44px;/);
  assert.match(styles, /\.preview-lightbox \.lightbox-img \{[^}]*width: auto; height: auto; max-width: 92vw; max-height: 92vh;/);
  assert.doesNotMatch(files.app, /plugin-preview-(?:bar|meta)/);
  assert.match(styles, /\.plugin-card-body \.plugin-description \{[\s\S]*max-height: 21px;[\s\S]*text-overflow: clip; white-space: nowrap;[\s\S]*mask-image: linear-gradient/);
  assert.match(styles, /\.plugin-card-body \.plugin-description \{[\s\S]*margin: 4px 0 9px;/);
  assert.match(styles, /\.card-status-line \{[\s\S]*justify-content: space-between;/);
  assert.match(styles, /\.card-activity-state \{[^}]*border: 0;[^}]*font-size: 10px;/);
  assert.doesNotMatch(styles, /\.card-activity-state \{[^}]*border-left:/);
  assert.match(styles, /\.card-verification-trigger \{[\s\S]*min-width: 24px; height: 24px;[\s\S]*text-transform: none;/);
  assert.match(styles, /\.card-verification-marker \{[\s\S]*height: 21px;[\s\S]*background: var\(--code-bg\);/);
  assert.doesNotMatch(styles, /\.card-verification-marker \{[^}]*border-right:/);
  assert.match(styles, /\.card-verification\.is-unverified \.card-verification-trigger \{ color: var\(--accent\); \}/);
  assert.match(styles, /\.card-verification-tooltip \{[\s\S]*right: 0;[\s\S]*bottom: calc\(100% \+ 7px\);/);
  assert.match(styles, /\.card-verification-tooltip,\s*\.control-tooltip \{[\s\S]*padding: 5px 7px;[\s\S]*background: var\(--panel-2\);[\s\S]*font-size: 11px; font-weight: 600;[\s\S]*line-height: 1\.3;[\s\S]*text-rendering: auto;[\s\S]*transition: opacity 120ms ease;/);
  assert.doesNotMatch(styles, /\.card-verification-tooltip,\s*\.control-tooltip \{[^}]*(?:^|;)\s*transform:/m);
  assert.match(styles, /\.has-control-tooltip:hover:not\(\.is-tooltip-dismissed\) \.control-tooltip,[\s\S]*\.has-control-tooltip:focus-within:not\(\.is-tooltip-dismissed\) \.control-tooltip/);
  assert.match(styles, /\.card-verification-tooltip::after,[\s\S]*\.control-tooltip::after \{[\s\S]*height: 8px;/);
  assert.match(styles, /opacity: 1; visibility: visible; pointer-events: auto;/);
  assert.match(styles, /\.plugin-card-actions:has\(\.has-control-tooltip:hover\),[\s\S]*z-index: 5;/);
  assert.match(styles, /\.plugin-card:has\(\.has-control-tooltip:hover\),[\s\S]*overflow: visible;/);
  assert.match(styles, /\.control-tooltip \{[\s\S]*right: 0;[\s\S]*bottom: calc\(100% \+ 8px\); left: auto;/);
  assert.match(styles, /\.plugin-card-actions \{[\s\S]*position: relative; z-index: 3;/);
  const basePageMetaRule = styles.match(/\.page-meta\s*\{([^}]*)\}/)?.[1] || "";
  assert.match(basePageMetaRule, /flex-wrap: wrap;/);
  assert.match(styles, /\.page-meta \.manifest-version \{ min-width: 0; max-width: 100%; flex: none; \}/);
  assert.match(styles, /\.page-meta \.manifest-version > span\s*\{[^}]*max-width: 100%;[^}]*overflow: hidden;[^}]*overflow-wrap: normal;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/);
  assert.match(files.pluginJs, /class="manifest-version"><span>\$\{escapeHtml\(versionLabel\)\}<\/span><\/span>/);
  assert.match(styles, /\.plugin-detail-article \.page-meta \{ column-gap: 37px; \}/);
  assert.match(styles, /\.plugin-detail-article \.page-meta > span \{ position: relative; \}/);
  assert.match(styles, /\.plugin-detail-article \.page-meta > span \+ span::before\s*\{[^}]*position: absolute; right: calc\(100% \+ 15px\); margin-right: 0;/);
  assert.match(styles, /\.plugin-detail-article \.page-meta > \.is-line-start::before \{ display: none; \}/);
  assert.match(styles, /@media \(max-width: 760px\) \{[\s\S]*\.plugin-detail-article \.page-meta \{ column-gap: 12px; \}/);
  assert.match(styles, /\.page-meta \.detail-status-meta > \.detail-verification \{ margin-left: 15px; \}/);
  assert.match(styles, /\.page-meta \.detail-status-meta > \.detail-verification::before\s*\{[^}]*margin-right: 8px;[^}]*content: "\|";/);
  assert.match(styles, /\.aside-meta \.aside-verification\s*\{[^}]*display: flex; max-width: 100%; margin-left: auto; align-items: flex-end;[\s\S]*flex-direction: column; gap: 4px;/);
  assert.doesNotMatch(styles, /\.aside-meta div:has\(\.aside-verification\)|\.aside-meta \.aside-verification \.card-verification-tooltip|\.aside-verification \.card-verification-marker/);
  assert.match(styles, /\.detail-verification \.card-verification-marker\.is-snapshot \{ color: var\(--stable\); \}/);
  assert.match(styles, /\.detail-section-before-verification > \.command-panel:last-child \{ margin-bottom: 0; \}/);
  assert.match(styles, /\.detail-section#install \+ \.detail-section#verification \{ padding-top: 0; \}/);
  assert.match(styles, /\.detail-section#install \+ \.detail-section#verification::before \{ content: none; \}/);
  assert.match(styles, /\.verification-status-note \.verification-contributor-action strong \{ color: var\(--text\); \}/);
  assert.match(styles, /\.security-notice-section \.install-security-note \{ margin: 0; \}/);
  assert.match(styles, /\.verification-status-note \.verification-snapshot strong \{ color: var\(--stable\); \}/);
  assert.match(styles, /\.verification-status-note \.verification-update strong,[\s\S]*\.verification-status-note \.verification-unverified strong \{ color: var\(--accent\); \}/);
  assert.match(styles, /\.verification-status-list \{ padding: 0; margin: 0; list-style: none; \}/);
  assert.match(styles, /\.verification-status-list li\s*\{[^}]*position: relative; padding-left: 24px; margin: 8px 0;[^}]*font-size: 15px; line-height: 1\.72;/);
  assert.match(styles, /\.verification-status-list li::before\s*\{[^}]*top: \.62em; left: 8px; width: 6px; height: 6px;[\s\S]*background: var\(--accent\); content: "";/);
  assert.match(styles, /\.detail-verification \.card-verification-trigger\s*\{[^}]*height: auto; align-items: flex-start; flex-direction: column; gap: 4px;/);
  assert.match(styles, /\.detail-verification \.card-verification-marker \{ flex: none; \}/);
  assert.doesNotMatch(styles, /\.verification-contributor-action\s*\{[^}]*display: grid|\.verification-action-prompt/);
  assert.match(styles, /\.development-guide \.callout strong, \.development-guide \.callout p,[\s\S]*\.callout\.prominent-callout strong, \.callout\.prominent-callout p \{ font-size: 15px; \}/);
  assert.match(files.publish, /class="callout prominent-callout"><strong>The marketplace validates listings, not plugin security\.<\/strong><p>Plugins run unsandboxed\. You remain responsible for your code, assets, documentation, and license\.<\/p><\/div>/);
  const wideDetailStatusStart = styles.indexOf("@media (min-width: 1101px)");
  const narrowDetailStatusStart = styles.indexOf("@media (max-width: 1100px)");
  assert.ok(wideDetailStatusStart >= 0 && narrowDetailStatusStart > wideDetailStatusStart);
  const wideDetailStatusMedia = styles.slice(wideDetailStatusStart, narrowDetailStatusStart);
  assert.match(wideDetailStatusMedia, /\.plugin-detail-article \.page-meta > \.detail-status-meta \{ display: none; \}/);
  const nextResponsiveMedia = styles.indexOf("@media", narrowDetailStatusStart + 1);
  const narrowDetailStatusMedia = styles.slice(narrowDetailStatusStart, nextResponsiveMedia);
  assert.match(narrowDetailStatusMedia, /\.right-aside \{ display: none; \}/);
  assert.match(styles, /\.card-verification:hover:not\(\.is-dismissed\) \.card-verification-tooltip,[\s\S]*\.card-verification:focus-within:not\(\.is-dismissed\) \.card-verification-tooltip,[\s\S]*\.card-verification\.is-open \.card-verification-tooltip/);
  assert.match(files.app, /class="card-status-line">\$\{activityState\}\$\{verificationState\}/);
  assert.doesNotMatch(files.app, /verification-check|✓/);
  assert.match(files.app, /data-verification-tooltip aria-expanded="false" aria-label=/);
  assert.match(files.app, /class="card-install has-control-tooltip"[\s\S]*Copy install[\s\S]*class="control-tooltip" role="tooltip" aria-hidden="true">Copy install command/);
  assert.doesNotMatch(files.app, /Snapshot verified|Update unverified|Copy upstream|Not bound to the verified snapshot/);
  assert.match(files.pluginJs, /Snapshot verified/);
  assert.match(files.pluginJs, /Update unverified/);
  assert.match(files.app, /class="card-stars has-control-tooltip"[\s\S]*class="control-tooltip" role="tooltip" aria-hidden="true">Repository stars/);
  assert.match(sharedJs, /Marketplace detail views[\s\S]*Successful command copies[\s\S]*engagement-metric\$\{detail \? "" : " has-control-tooltip"\}/);
  assert.match(sharedJs, /plugin-heart\$\{detail \? " detail-heart" : " has-control-tooltip"\}[\s\S]*data-heart-tooltip/);
  assert.match(sharedJs, /button\.querySelector\("\[data-heart-tooltip\]"\)/);
  assert.match(sharedJs, /export function positionTooltip\(host, tooltip\)[\s\S]*documentElement\.clientWidth[\s\S]*const centered = \(hostRect\.width - tooltipWidth\) \/ 2[\s\S]*Math\.round/);
  assert.match(sharedJs, /tooltip\.textContent = action;\s*positionControlTooltip\(button\);/);
  assert.match(sharedJs, /event\.key !== "Escape"[\s\S]*classList\.add\("is-tooltip-dismissed"\)/);
  assert.match(sharedJs, /defaultView\?\.addEventListener\("resize"[\s\S]*forEach\(positionControlTooltip\)/);
  assert.match(files.app, /function bindCardActions\(root\) \{\s*setupControlTooltips\(root\);/);
  assert.match(files.pluginJs, /setupControlTooltips\(content\);\s*setupDetailMetaLineStarts\(content\);/);
  assert.match(files.pluginJs, /function setupDetailMetaLineStarts\(root\)[\s\S]*classList\.remove\("is-line-start"\)[\s\S]*Math\.abs\(center - lineCenter\) > 2[\s\S]*classList\.add\("is-line-start"\)[\s\S]*addEventListener\("resize", update\)/);
  assert.match(files.pluginJs, /class="copy-button has-control-tooltip"[\s\S]*class="control-tooltip" role="tooltip" aria-hidden="true">\$\{escapeHtml\(copyCommandLabel\)\}/);
  assert.match(files.app, /button\.addEventListener\("click", \(event\) => \{[\s\S]*classList\.toggle\("is-open", expanded\)/);
  assert.match(files.app, /event\.key !== "Escape"/);
  assert.match(files.app, /matches\?\.\("\[data-verification-tooltip\]"\)[\s\S]*control = "verification"/);
  assert.match(files.app, /verification: "\[data-verification-tooltip\]"/);
  assert.doesNotMatch(styles, /\.plugin-title-line \.new-badge/);
  assert.match(styles, /\.card-social \{[\s\S]*top: 13px;[\s\S]*height: 25px;/);
  assert.match(styles, /\.card-stars \{[\s\S]*width: 54px;[\s\S]*height: 25px;/);
  assert.match(styles, /\.plugin-card-actions \.engagement-metric \{[\s\S]*height: 25px;/);
  assert.match(styles, /\.plugin-heart\.is-celebrating \.heart-glyph \{[\s\S]*animation: heart-confirm 220ms/);
  assert.match(styles, /\.plugin-card-link:focus-visible \{ outline-offset: -2px; \}/);
  assert.match(styles, /\.page-header::before \{[\s\S]*linear-gradient\(90deg, transparent, var\(--line\) 12%, var\(--line\) 88%, transparent\)/);
  assert.doesNotMatch(styles, /\.page-header::after/);
  assert.match(styles, /\.detail-section::before \{[\s\S]*linear-gradient\(90deg, transparent, var\(--line\) 12%, var\(--line\) 88%, transparent\)/);
  assert.doesNotMatch(styles, /\.detail-section::after/);
  assert.doesNotMatch(styles, /\.docs-section \+ \.docs-section::(?:before|after)/);
  assert.match(styles, /\.manifest-reference summary \{/);
  assert.match(styles, /\.label, \.sidebar-group-title \{[\s\S]*color: var\(--sidebar-heading\);[\s\S]*font-size: 11px; font-weight: 400;[\s\S]*letter-spacing: \.18em;[\s\S]*-webkit-font-smoothing: antialiased;/);
  assert.match(styles, /\.development-guide \.docs-section > p \{[\s\S]*font-size: 16px;[\s\S]*line-height: 1\.75;/);
  assert.match(styles, /\.troubleshooting-list strong \{ font-family: var\(--sans\); font-size: 16px; \}/);
  assert.match(styles, /\.troubleshooting-list p \{[\s\S]*font-family: var\(--sans\); font-size: 16px;/);
  assert.match(styles, /\.kind-reference \{[\s\S]*overflow-x: auto;/);
  assert.match(styles, /\.kind-reference table \{[\s\S]*min-width: 620px;[\s\S]*border-collapse: collapse;/);
  assert.match(styles, /\.kind-reference th, \.kind-reference td \{[\s\S]*padding: 8px 12px;[\s\S]*border: 1px solid var\(--line\);/);
  assert.doesNotMatch(styles, /\.kind-reference tbody tr:nth-child/);
  assert.match(styles, /\.development-example \{[\s\S]*margin: 18px 0 30px;/);
  assert.match(styles, /\.development-example \.code-block \{ margin: 0; border: 0; \}/);
  assert.match(styles, /\.callout-command \{\s*display: block; max-width: 100%; padding: 7px 9px; margin: 9px 0 8px; overflow-x: auto;\s*font-size: 13px; line-height: 1\.4; white-space: nowrap;\s*\}/);
  assert.doesNotMatch(`${files.publish}\n${files.pluginJs}`, /class="hash"/);
  assert.doesNotMatch(styles, /\.section-title(?:\s|\.|\{)/);
  assert.match(styles, /\[data-theme="light"\] \.plugin-icon, \[data-theme="light"\] \.detail-icon \{ color: var\(--text\); \}/);
  assert.match(styles, /\.card-activity-state\.is-updated \{ color: var\(--updated\); \}/);
  assert.match(styles, /\[data-theme="light"\] \.aside-meta \.status-label\.is-caution \{[\s\S]*color: #965f00;/);
  assert.match(styles, /\.tree-branch::before, \.tree-branch::after \{[\s\S]*background: currentColor;/);
  assert.match(styles, /\.example-file:last-child \.tree-branch::before \{ bottom: 50%; \}/);
  assert.match(styles, /\.syntax-string \{ color: var\(--syntax-string\); \}/);
  assert.match(styles, /\.manifest-reference summary::after \{[\s\S]*border-top: 1px solid currentColor;[\s\S]*content: "";[\s\S]*transform: rotate\(45deg\)/);
  assert.match(styles, /\.manifest-reference\[open\] summary::after \{ transform: rotate\(135deg\); \}/);
  assert.match(styles, /\.aside-link \{[\s\S]*border-left: 2px solid var\(--line\)/);
  assert.match(styles, /\.listing-check-row \{[\s\S]*grid-template-columns: minmax\(130px, \.8fr\) minmax\(0, 1\.2fr\)/);
  assert.match(styles, /\.pagination-summary \{[\s\S]*color: var\(--muted\)/);
  assert.match(styles, /\.pagination-direction \{[\s\S]*color: var\(--muted\)/);
  assert.match(styles, /\.catalog-view-toggle \{ display: flex; margin-top: 16px; justify-content: center; \}/);
  assert.match(styles, /\.catalog-view-button \{[\s\S]*min-height: 44px;[\s\S]*font-family: var\(--mono\);[\s\S]*text-transform: uppercase/);
  assert.match(styles, /\.catalog-view-button:hover, \.catalog-view-button:focus-visible \{ color: var\(--accent\); \}/);
  assert.match(styles, /\.catalog-view-dock \{[\s\S]*position: fixed; z-index: 55;[\s\S]*bottom: calc\(20px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(styles, /\.catalog-view-dock button \{[\s\S]*min-height: 48px;[\s\S]*background: var\(--panel-2\);[\s\S]*text-transform: uppercase/);
  assert.match(styles, /\.catalog-show-all \.toast \{ bottom: calc\(88px \+ env\(safe-area-inset-bottom\)\); \}/);
  assert.match(styles, /\.catalog-show-all \.market-footer \{ padding-bottom: calc\(86px \+ env\(safe-area-inset-bottom\)\); \}/);
  assert.match(styles, /@media \(max-width: 760px\) \{[\s\S]*\.recent-grid, \.market-plugin-grid \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(styles, /@media \(max-width: 760px\) \{[\s\S]*\.catalog-view-dock \{[\s\S]*bottom: calc\(80px \+ env\(safe-area-inset-bottom\)\);[\s\S]*\.catalog-view-dock button \{ min-height: 52px;[\s\S]*\.catalog-show-all \.toast \{ bottom: calc\(148px \+ env\(safe-area-inset-bottom\)\); \}[\s\S]*\.catalog-show-all \.market-footer \{ padding-bottom: calc\(148px \+ env\(safe-area-inset-bottom\)\); \}/);
  assert.match(styles, /\.footer-resource-links \{ display: flex; justify-self: end; align-items: center; gap: 18px; \}/);
  assert.doesNotMatch(styles, /\.footer-license/);
  assert.doesNotMatch(styles, /\.author-bar|\.author-select-wrap/);
  assert.match(styles, /\.market-search input::-webkit-search-cancel-button/);
  assert.match(styles, /@media \(min-width: 761px\) and \(max-width: 1059px\) \{[\s\S]*\.market-nav-detail \{ display: none; \}[\s\S]*\.market-nav a \{ padding-right: 6px; padding-left: 6px; \}/);
  assert.match(styles, /@media \(min-width: 761px\) and \(max-width: 879px\) \{[\s\S]*\.market-brand span \{ display: none; \}/);
  assert.match(styles, /@media \(max-width: 760px\) \{[\s\S]*\.market-nav a \{ display: none; \}/);
  assert.doesNotMatch(styles, /\.marketplace-page \{ min-width: 320px; \}/);
  assert.match(styles, /env\(safe-area-inset-bottom\)/);
  assert.match(styles, /\.search-token-editor \{/);
  assert.match(styles, /\.search-term \{/);
  assert.match(styles, /\.search-clear \{/);
  assert.match(styles, /\.search-suggestions \{/);
  assert.match(styles, /\.search-fish-preview \{/);
  assert.match(styles, /\.search-fish-preview \{[\s\S]*font-size: 13px;[\s\S]*font-weight: 500; line-height: 1;/);
  assert.match(styles, /\.search-query-summary, \.search-suggestion \{[\s\S]*min-height: 38px/);
  assert.match(styles, /@media \(max-width: 700px\) \{[\s\S]*\.search-query-summary, \.search-suggestion \{ min-height: 44px; \}/);
  assert.match(styles, /\.search-query-summary > span, \.search-suggestion > span \{[\s\S]*min-width: 0;[\s\S]*text-overflow: ellipsis/);
  assert.match(styles, /\.market-plugin-grid \.plugin-card, \.recent-grid \.plugin-card \{[\s\S]*display: flex;[\s\S]*flex-direction: column; gap: 0;/);
  assert.match(styles, /\.plugin-preview \{[\s\S]*height: 175px; min-height: 0;[\s\S]*flex: 0 0 175px;/);
  assert.match(styles, /\.plugin-card-body \{[\s\S]*display: flex;[\s\S]*min-width: 0;[\s\S]*flex: 1; flex-direction: column;/);
  assert.match(files.app, /<div class="plugin-card-content">[\s\S]*class="plugin-title-line"[\s\S]*\$\{authorLine\}[\s\S]*class="plugin-description"[\s\S]*\$\{cardStates\}/);
  assert.match(styles, /\.plugin-card-bottom \{[\s\S]*margin-top: auto;/);
  assert.match(styles, /\.plugin-author button \{[\s\S]*z-index: 3/);
  assert.match(styles, /\.plugin-author button \{[\s\S]*min-height: 24px/);
  assert.match(styles, /\.plugin-author button:hover, \.plugin-author button:focus-visible \{ color: var\(--accent\); \}/);
  assert.match(files.index, /class="footer-status"/);
  assert.match(files.index, /HANCORE[\s\S]*OMARCHY PLUGIN MARKETPLACE[\s\S]*GITHUB/);
  assert.doesNotMatch(files.index, /Independent community project\. Not affiliated with, sponsored by, or endorsed by Omarchy or 37signals\./);
  assert.doesNotMatch(files.explore, /Independent community project\. Not affiliated with, sponsored by, or endorsed by Omarchy or 37signals\./);
  assert.doesNotMatch(files.index, /footer-tech-canvas|footer-project-canvas/);
  assert.doesNotMatch(files.app, /setupHancoreAsciiHover|setupFooterAsciiField/);
});

test("theme text and accent surfaces meet WCAG AA contrast", async () => {
  const styles = await readFile(
    new URL("../site/assets/css/style.css", import.meta.url),
    "utf8",
  );
  const darkBlock = styles.match(/^:root \{([\s\S]*?)\n\}/)?.[1] || "";
  const lightBlock = styles.match(/:root\[data-theme="light"\] \{([\s\S]*?)\n\}/)?.[1] || "";
  const value = (block, name) => block.match(new RegExp(`--${name}:\\s*(#[a-f0-9]+);`, "i"))?.[1];
  for (const [theme, block] of [["dark", darkBlock], ["light", lightBlock]]) {
    const themeValue = (name) => value(block, name);
    const background = themeValue("bg");
    const panel = themeValue("panel");
    const accent = themeValue("accent");
    for (const name of ["bg", "panel", "code-bg", "faint", "accent", "accent-contrast", "syntax-string", "sidebar-heading"]) {
      assert.ok(themeValue(name), `${theme} --${name}`);
    }
    for (const [foreground, surface] of [
      [themeValue("faint"), background],
      [themeValue("faint"), panel],
      [accent, background],
      [accent, panel],
      [themeValue("accent-contrast"), accent],
      [themeValue("syntax-string"), themeValue("code-bg")],
      [themeValue("sidebar-heading"), panel],
    ]) {
      assert.ok(contrastRatio(foreground, surface) >= 4.5, `${theme}: ${foreground} on ${surface}`);
    }
  }

  const lightText = value(lightBlock, "text");
  const lightPanel = value(lightBlock, "panel");
  for (const pluginAccent of ["#b7ef51", "#a78bfa", "#f4bd62", "#68d6e8", "#f18c75", "#e896ba"]) {
    const iconSurface = mixHex(pluginAccent, lightPanel, 0.1);
    assert.ok(contrastRatio(lightText, iconSurface) >= 4.5, `light detail icon: ${lightText} on ${iconSurface}`);
  }
  assert.ok(contrastRatio("#111", "#b4c96f") >= 4.5, "light new badge");
  assert.ok(contrastRatio("#111", "#ffb000") >= 4.5, "light updated badge");
  assert.ok(contrastRatio("#965f00", lightPanel) >= 4.5, "light caution status on sidebar");
});

test("mobile plugin card previews preserve complete images", async () => {
  const styles = await readFile(
    new URL("../site/assets/css/style.css", import.meta.url),
    "utf8",
  );
  const targetSelector = ".plugin-preview.image-preview img";
  const rules = [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((match) => ({
      selectors: match[1].split(",").map((selector) => selector.trim()),
      declarations: Object.fromEntries(
        [...match[2].matchAll(/([\w-]+)\s*:\s*([^;]+);/g)]
          .map((declaration) => [declaration[1], declaration[2].trim()]),
      ),
    }))
    .filter((rule) =>
      rule.selectors.some((selector) => selector.endsWith(targetSelector))
    );
  const [desktopRule, ...responsiveRules] = rules;
  const mobileRule = responsiveRules.find((rule) =>
    rule.selectors.includes(targetSelector)
    && rule.declarations["min-height"] === "0"
    && rule.declarations["object-fit"] === "contain"
  );

  assert.ok(desktopRule.selectors.includes(targetSelector));
  assert.equal(desktopRule.declarations["min-height"], undefined);
  assert.equal(desktopRule.declarations["object-fit"], "cover");
  assert.ok(mobileRule);
  for (const rule of responsiveRules) {
    if (rule.declarations["min-height"]) {
      assert.equal(rule.declarations["min-height"], "0");
    }
    if (rule.declarations["object-fit"]) {
      assert.equal(rule.declarations["object-fit"], "contain");
    }
  }
  assert.match(
    styles,
    /\.plugin-preview \{\s*height: clamp\(160px, 30vw, 220px\); flex-basis: clamp\(160px, 30vw, 220px\);\s*\}/,
  );
});

test("automation deploys refreshed catalogs and uses listing-specific approval", async () => {
  const root = new URL("../", import.meta.url);
  const approve = await readFile(
    new URL(".github/workflows/approve-submission.yml", root),
    "utf8",
  );
  const approvalScript = await readFile(
    new URL("scripts/approve-submission.mjs", root),
    "utf8",
  );
  const refresh = await readFile(
    new URL(".github/workflows/refresh-catalog.yml", root),
    "utf8",
  );
  const deploy = await readFile(
    new URL(".github/workflows/deploy-pages.yml", root),
    "utf8",
  );
  const validate = await readFile(
    new URL(".github/workflows/validate-submission.yml", root),
    "utf8",
  );
  const issueRouter = await readFile(
    new URL(".github/workflows/route-issue-automation.yml", root),
    "utf8",
  );
  const verify = await readFile(
    new URL(".github/workflows/verify.yml", root),
    "utf8",
  );
  const provisionLabels = await readFile(
    new URL(".github/workflows/provision-labels.yml", root),
    "utf8",
  );
  assert.match(approve, /approved-and-verified/);
  assert.doesNotMatch(approve, /approved-for-listing/);
  assert.doesNotMatch(approve, /label\.name == 'approved'/);
  assert.match(
    approve,
    /MANUAL_SETUP:\s+\$\{\{ contains\(github\.event\.issue\.labels\.\*\.name, 'manual-setup'\) \}\}/,
  );
  assert.match(approvalScript, /parseManualSetupApproval\(requiredEnvironment\("MANUAL_SETUP"\)\)/);
  assert.match(approve, /APPROVED_ISSUE_BODY:\s+\$\{\{ github\.event\.issue\.body \}\}/);
  assert.match(
    approve,
    /name: Detect registry change[\s\S]*git diff --quiet -- registry\.json[\s\S]*changed=false[\s\S]*changed=true/,
  );
  assert.match(approve, /name: Build approved repository only/);
  assert.match(approve, /MARKETPLACE_APPROVED_REPOSITORY:/);
  assert.match(approve, /MARKETPLACE_APPROVED_COMMIT:/);
  assert.equal((approve.match(/run: npm run build/g) || []).length, 1);
  assert.equal((refresh.match(/run: npm run build/g) || []).length, 1);
  assert.equal((deploy.match(/run: npm run build/g) || []).length, 0);
  assert.match(approve, /name: Recheck approval, evidence, and exact upstream commit/);
  assert.match(approve, /--verify-current/);
  assert.equal((approve.match(/MANUAL_SETUP:/g) || []).length, 3);
  assert.match(approvalScript, /submission_repository=\$\{inspection\.repository\}/);
  assert.match(approvalScript, /approved_commit=\$\{inspection\.commitSha\}/);

  assert.match(
    approve,
    /github\.event\.label\.name == 'approved-and-verified'[\s\S]*'plugin-catalog-writes'[\s\S]*ignored-label-/,
  );
  assert.match(approve, /github\.run_attempt == 1/);
  assert.match(approvalScript, /requestedAt: latest\.created_at/);
  assert.match(
    refresh,
    /group: plugin-catalog-writes\s+cancel-in-progress: false\s+queue: max/,
  );
  for (const workflow of [approve, refresh]) {
    assert.match(workflow, /actions\/upload-artifact@[a-f0-9]{40}/);
    assert.match(workflow, /actions\/download-artifact@[a-f0-9]{40}/);
    assert.match(workflow, /actions\/upload-pages-artifact@[a-f0-9]{40}/);
    assert.match(workflow, /actions\/deploy-pages@[a-f0-9]{40}/);
    assert.doesNotMatch(workflow, /git pull --rebase|for attempt in 1 2 3/);
    assert.match(workflow, /main changed after the tested [^\n]+; refusing to rebase/);
    assert.match(workflow, /sha256sum --check SHA256SUMS/);
    assert.match(workflow, /publication_artifact_name: \$\{\{ steps\.artifacts\.outputs\.publication_name \}\}/);
    assert.match(workflow, /pages_artifact_name: \$\{\{ steps\.artifacts\.outputs\.pages_name \}\}/);
    assert.match(workflow, /name: \$\{\{ needs\.(?:approve|refresh)\.outputs\.publication_artifact_name \}\}/);
    assert.match(workflow, /artifact_name: \$\{\{ needs\.(?:approve|refresh)\.outputs\.pages_artifact_name \}\}/);
    assert.match(workflow, /retention-days: 7/);
    assert.match(workflow, /fetch-depth: 0/);
    assert.match(workflow, /persist-credentials: false/);
  }
  for (const workflow of [approve, refresh, deploy]) {
    assert.match(
      workflow,
      /group: github-pages-deployments\s+cancel-in-progress: false\s+queue: max/,
    );
  }

  const jobSource = (workflow, name, nextName = "") => {
    const start = workflow.indexOf(`\n  ${name}:\n`);
    assert.ok(start > 0, `${name} job must exist`);
    const end = nextName ? workflow.indexOf(`\n  ${nextName}:\n`, start + 1) : -1;
    return end > start ? workflow.slice(start, end) : workflow.slice(start);
  };
  const stepSource = (job, name, nextName = "") => {
    const start = job.indexOf(`\n      - name: ${name}\n`);
    assert.ok(start > 0, `${name} step must exist`);
    const end = nextName ? job.indexOf(`\n      - name: ${nextName}\n`, start + 1) : -1;
    return end > start ? job.slice(start, end) : job.slice(start);
  };
  const approveJob = jobSource(approve, "approve", "publish");
  const approvalPublishJob = jobSource(approve, "publish", "deploy");
  const approvalFinalPushStep = stepSource(
    approvalPublishJob,
    "Recheck mutable approval state and push tested plugin publication",
    "Record publication failure",
  );
  const approvalDeployJob = jobSource(approve, "deploy", "finalize");
  const validationAnalyzeJob = jobSource(validate, "validate", "mutation-route");
  const validationMutationRouteJob = jobSource(validate, "mutation-route", "publish");
  const validationPublishJob = jobSource(validate, "publish", "publish-fallback");
  const validationFallbackJob = jobSource(validate, "publish-fallback");
  assert.match(approveJob, /permissions:\s+contents: read\s+issues: read/);
  assert.doesNotMatch(approveJob, /contents: write|pages: write|id-token: write/);
  assert.doesNotMatch(approveJob, /APPROVAL_REQUESTED_AT: \$\{\{ github\.event\.issue\.updated_at \}\}/);
  assert.ok(approveJob.indexOf("run: npm run build") < approveJob.indexOf("run: npm test"));
  assert.ok(approveJob.indexOf("run: npm test") < approveJob.indexOf("actions/upload-pages-artifact@"));
  assert.ok(approveJob.indexOf("actions/upload-pages-artifact@") < approveJob.indexOf("name: Recheck approval"));
  assert.match(approvalPublishJob, /permissions:\s+contents: write\s+issues: read/);
  assert.ok(
    approvalPublishJob.indexOf("name: Prepare tested plugin publication")
      < approvalPublishJob.indexOf("name: Recheck mutable approval state and push tested plugin publication"),
  );
  assert.match(approvalFinalPushStep, /gh api "repos\/\$\{GITHUB_REPOSITORY\}\/issues\/\$\{ISSUE_NUMBER\}"/);
  assert.match(approvalFinalPushStep, /blocking_label in needs-fixes security-needs-fixes/);
  assert.match(approvalFinalPushStep, /approved-and-verified[\s\S]*APPROVAL_EVENT_ID/);
  assert.match(approvalFinalPushStep, /BASELINE_COMMENT_ID:[\s\S]*marketplace-security-baseline:v\[0-9\]/);
  assert.match(approvalFinalPushStep, /collaborators\/\$\{APPROVER_LOGIN\}\/permission/);
  assert.match(approvalFinalPushStep, /commits\/HEAD[\s\S]*APPROVED_COMMIT/);
  assert.match(approvalFinalPushStep, /commits\/HEAD[\s\S]*push origin HEAD:main/);
  assert.doesNotMatch(approvalFinalPushStep, /git add|git commit|git fetch/);
  assert.doesNotMatch(approvalPublishJob, /npm ci|npm run build|npm test|setup-node/);
  assert.match(approvalPublishJob, /git fetch origin main[\s\S]*remote_main[\s\S]*EXPECTED_BASE_COMMIT/);
  assert.match(validationAnalyzeJob, /permissions:\s+contents: read\s+issues: read/);
  assert.doesNotMatch(validate, /^concurrency:/m);
  assert.match(
    validationAnalyzeJob,
    /concurrency:\s+group: issue-validation-\$\{\{ github\.event\.issue\.number \}\}\s+cancel-in-progress: false\s+queue: max/,
  );
  assert.doesNotMatch(validationAnalyzeJob, /group: plugin-catalog-writes/);
  assert.match(
    validationPublishJob,
    /concurrency:\s+group: \$\{\{ needs\.mutation-route\.outputs\.group == format\('issue-validation-\{0\}'[\s\S]*'plugin-catalog-writes' \}\}\s+cancel-in-progress: false\s+queue: max/,
  );
  assert.match(validationMutationRouteJob, /permissions:\s+issues: read/);
  assert.match(validationMutationRouteJob, /group=issue-validation-\$\{ISSUE_NUMBER\}/);
  assert.match(validationFallbackJob, /group: plugin-catalog-writes[\s\S]*steps: \*submission-mutation-steps/);
  assert.match(validationAnalyzeJob, /startsWith\(github\.event\.issue\.title, '\[Plugin\]:'\)[\s\S]*contains\(github\.event\.issue\.labels\.\*\.name, 'submission'\)/);
  assert.match(validationAnalyzeJob, /npm ci[\s\S]*scripts\/validate-submission\.mjs[\s\S]*scripts\/security-baseline\.mjs/);
  assert.doesNotMatch(validationAnalyzeJob, /issues: write|gh issue edit|gh issue comment|--method PATCH/);
  assert.match(validationAnalyzeJob, /actions\/upload-artifact@[a-f0-9]{40}/);
  assert.match(validationAnalyzeJob, /name: Bundle analyzed validation reports[\s\S]*sha256sum > SHA256SUMS/);
  assert.match(validationPublishJob, /permissions:\s+actions: read\s+issues: write/);
  assert.match(validationPublishJob, /GH_REPO: \$\{\{ github\.repository \}\}/);
  assert.match(validationPublishJob, /actions\/download-artifact@[a-f0-9]{40}/);
  assert.match(validationPublishJob, /symbolic link[\s\S]*expected_files[\s\S]*sha256sum --check SHA256SUMS/);
  assert.doesNotMatch(validationPublishJob, /actions\/checkout|setup-node|npm ci|npm run|node scripts\//);
  assert.match(validationPublishJob, /Confirm failed run still matches the submission[\s\S]*skipping stale failure mutations/);
  assert.match(validationPublishJob, /guard-issue-mutation/);
  assert.match(validationPublishJob, /requires_global_fallback/);
  assert.match(validationPublishJob, /env\.MUTATION_CONCURRENCY_GROUP == 'plugin-catalog-writes'/);
  assert.doesNotMatch(validationPublishJob, /result == 'cancelled'/);
  assert.match(approvalPublishJob, /push origin HEAD:main/);
  assert.match(approvalDeployJob, /needs: \[approve, publish\]/);
  assert.doesNotMatch(approvalDeployJob, /actions\/checkout|npm ci|npm run build|npm test|upload-pages-artifact/);
  assert.match(approvalDeployJob, /git ls-remote[\s\S]*EXPECTED_COMMIT/);
  assert.match(approvalDeployJob, /actions\/deploy-pages@[a-f0-9]{40}/);

  const refreshJob = jobSource(refresh, "refresh", "publish");
  const refreshPublishJob = jobSource(refresh, "publish", "deploy");
  const refreshDeployJob = jobSource(refresh, "deploy", "alert");
  const refreshAlertJob = jobSource(refresh, "alert");
  assert.match(refreshJob, /^    timeout-minutes:[ \t]+90[ \t]*$/m);
  assert.match(refreshJob, /permissions:\s+contents: read/);
  assert.ok(refreshJob.indexOf("run: npm run build") < refreshJob.indexOf("run: npm test"));
  assert.doesNotMatch(refreshPublishJob, /npm ci|npm run build|npm test|setup-node/);
  assert.doesNotMatch(refreshDeployJob, /actions\/checkout|npm ci|npm run build|npm test|upload-pages-artifact/);
  assert.match(refreshAlertJob, /if: always\(\)[\s\S]*permissions:\s+issues: write/);
  assert.match(refreshAlertJob, /Marketplace catalog refresh failure/);
  assert.match(refreshAlertJob, /github-actions\[bot\]/);
  assert.doesNotMatch(refreshAlertJob, /--add-label|--remove-label|labels\//);

  const pushPrepareJob = jobSource(deploy, "prepare", "deploy");
  const pushDeployJob = jobSource(deploy, "deploy");
  assert.match(pushPrepareJob, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(pushPrepareJob, /Test committed marketplace[\s\S]*run: npm test/);
  assert.doesNotMatch(pushPrepareJob, /npm run build/);
  assert.match(pushPrepareJob, /pages_artifact_name: \$\{\{ steps\.identity\.outputs\.pages_name \}\}/);
  assert.match(pushPrepareJob, /actions\/upload-pages-artifact@[a-f0-9]{40}/);
  assert.doesNotMatch(pushDeployJob, /actions\/checkout|npm ci|npm run build|npm test|upload-pages-artifact/);
  assert.match(pushDeployJob, /git ls-remote[\s\S]*EXPECTED_COMMIT/);
  assert.match(pushDeployJob, /artifact_name: \$\{\{ needs\.prepare\.outputs\.pages_artifact_name \}\}/);
  assert.match(pushDeployJob, /actions\/deploy-pages@[a-f0-9]{40}/);

  for (const deployJob of [approvalDeployJob, refreshDeployJob, pushDeployJob]) {
    assert.ok(deployJob.indexOf("actions/configure-pages@") < deployJob.indexOf("name: Verify tested commit is still current"));
    assert.ok(deployJob.indexOf("name: Verify tested commit is still current") < deployJob.indexOf("actions/deploy-pages@"));
    assert.match(deployJob, /timeout-minutes: 20/);
    assert.match(deployJob, /continue-on-error: true/);
    assert.match(deployJob, /timeout: 300000/);
    assert.match(deployJob, /Confirm deployed catalog and Explorer data after Pages timeout/);
    assert.match(deployJob, /EXPECTED_DEPLOYMENT_ID:/);
    assert.match(deployJob, /deployment-id\.txt/);
    assert.match(deployJob, /live_id == "\$EXPECTED_DEPLOYMENT_ID"/);
    assert.match(deployJob, /sha256sum "\$live_catalog"/);
    assert.doesNotMatch(deployJob, /timeout:\s+1200000/);
  }
  assert.match(approve, /name: Record approval failure\s+id: failure\s+if: failure\(\)/);
  assert.match(approve, /ARTIFACT_IDENTITIES_OUTCOME:[\s\S]*BUNDLE_OUTCOME:/);
  assert.match(approve, /name: Record publication failure\s+id: failure\s+if: failure\(\)/);
  assert.match(approve, /name: Record deployment failure\s+id: failure\s+if: failure\(\)/);
  assert.match(approve, /name: Record finalization failure\s+id: failure\s+if: failure\(\)/);
  assert.match(approve, /name: Report actionable snapshot publication failure/);
  assert.match(approve, /needs\.publish\.result == 'cancelled'/);
  assert.match(approve, /<!-- marketplace-publication-status -->/);
  assert.match(approve, /<!-- marketplace-publication -->/);
  assert.match(approve, /contains\("<!-- marketplace-publication -->"\)[\s\S]*issues\/comments\/\$\{comment_id\}/);
  assert.doesNotMatch(approve, /Clear stale publication failure status|CLEAR_STATUS_OUTCOME|--method DELETE/);
  assert.match(approve, /state=lookup-failed[\s\S]*state=stale/);
  assert.match(approve, /CURRENT_STATE: \$\{\{ steps\.current\.outputs\.state \}\}/);
  assert.match(approve, /Do not reapply \\`approved-and-verified\\`/);
  assert.equal((approve.match(/labels\/approved-and-verified/g) || []).length, 0);
  assert.equal((approve.match(/approved-for-listing/g) || []).length, 0);

  assert.match(
    validationAnalyzeJob,
    /github\.event\.action != 'labeled'[\s\S]*github\.event\.label\.name == 'submission'[\s\S]*queue: max/,
  );
  assert.match(approve, /'plugin-catalog-writes'/);
  assert.match(issueRouter, /types: \[opened, edited, reopened, labeled, unlabeled\]/);
  assert.match(validate, /workflow_call:/);
  assert.match(validate, /github\.event\.label\.name == 'submission'/);
  assert.doesNotMatch(validate, /gh label create/);
  assert.match(provisionLabels, /workflow_dispatch:/);
  assert.equal((provisionLabels.match(/gh label create/g) || []).length, 12);
  assert.match(provisionLabels, /gh label create submission[\s\S]*gh label create plugin-update[\s\S]*gh label create maintainer-verified[\s\S]*gh label create standard-installation-approved[\s\S]*gh label create approved-and-verified[\s\S]*gh label create approved-for-listing[\s\S]*gh label create listed/);
  assert.doesNotMatch(provisionLabels, /actions\/checkout|npm ci|npm run/);
  assert.match(validate, /Check out repository without persisted credentials[\s\S]*persist-credentials: false/);
  assert.match(validate, /set -euo pipefail[\s\S]*gh api --paginate[\s\S]*tail -n 1/);
  assert.match(validate, /node scripts\/intake-submission\.mjs/);
  assert.match(validate, /needs\.validate\.outputs\.should_label == 'true'/);
  assert.match(validate, /needs\.validate\.outputs\.should_validate == 'true'/);
  assert.match(validate, /name: Confirm submission is still open and unlisted/);
  assert.match(validate, /!github\.event\.issue\.pull_request/);
  assert.match(validate, /\(\.pull_request \| not\)/);
  assert.match(validate, /any\(\.name == "listed"\)/);
  assert.match(validate, /name: Record validation workflow failure\s+id: failure\s+if: failure\(\)/);
  assert.match(
    validate,
    /name: Record validation publication failure\s+id: failure\s+if: >-[\s\S]*steps\.initialize\.outcome == 'failure'/,
  );
  assert.match(validate, /steps\.failure\.outcome == 'success'/);
  assert.match(validate, /name: Report validation workflow failure/);
  assert.match(validate, /always\(\)[\s\S]*needs\.validate\.result == 'failure'[\s\S]*needs\.validate\.result == 'success'/);
  assert.match(validate, /status=\$\?[\s\S]*"\$status" -eq 1[\s\S]*exit "\$status"/);
  assert.match(validate, /failure_reason: \$\{\{ steps\.failure\.outputs\.reason \}\}/);
  assert.match(validate, /ISSUE_TITLE:\s+\$\{\{ github\.event\.issue\.title \}\}/);
  assert.match(validate, /ISSUE_CREATED_AT:\s+\$\{\{ github\.event\.issue\.created_at \}\}/);
  assert.match(validate, /VALIDATION_METADATA_PATH: validation-metadata\.json/);
  assert.match(validate, /node scripts\/security-baseline\.mjs/);
  assert.match(validate, /--metadata=validation-metadata\.json/);
  assert.match(validate, /--json=security-baseline\.json/);
  assert.match(validate, /disposition="\$\(jq -r '\.verifiedPublicationDisposition' security-baseline\.json\)"/);
  assert.match(validate, /marketplace-security-baseline:v\[0-9\]\+/);
  assert.match(validate, /marketplace-security-baseline-error:v\[0-9\]\+/);
  assert.match(validate, /add_label security-needs-fixes/);
  assert.match(validate, /add_label security-review-required/);
  assert.match(validate, /verifiedPublicationDisposition/);
  assert.match(validate, /clear\|review-required\|needs-fixes/);
  assert.match(validate, /BASELINE_DISPOSITION: \$\{\{ needs\.validate\.outputs\.baseline_disposition \}\}/);
  assert.match(
    validate,
    /case "\$BASELINE_DISPOSITION"[\s\S]*clear\)[\s\S]*review-required\)[\s\S]*needs-fixes\)/,
  );
  assert.doesNotMatch(validate, /BASELINE_BLOCKS_APPROVAL|baseline_blocks_approval/);
  assert.match(validate, /name: Clear stale approval state after workflow failure/);
  assert.match(validate, /steps\.failure-current\.outputs\.matches == 'true'/);
  assert.match(validate, /labels\/\$\{label\}/);
  assert.match(validate, /remove_issue_label approved-and-verified[\s\S]*remove_issue_label approved-for-listing/);
  assert.match(approvalScript, /findLatestSecurityBaseline\(\[latest\]\)/);
  assert.match(approvalScript, /assertApprovalAllowed\(issue, baselineComment\.baseline, inspection, repoUrl\)/);
  assert.match(approvalScript, /runSecurityBaseline[\s\S]*listedPlugins: inspection\.manifests\.map[\s\S]*pluginId: manifest\.id[\s\S]*manifestPathHint: manifest\.path[\s\S]*createApprovedVerificationEvidence/);
  assert.match(approvalScript, /createMaintainerVerificationReview/);
  assert.match(approvalScript, /sourceVerification\(source\)\.status !== "verified"/);
  assert.doesNotMatch(validate, /openai|anthropic|github models|models: read/i);
  assert.doesNotMatch(validate, /github\.event\.label\.name == 'approved-and-verified'/);
  assert.doesNotMatch(validate, /github\.event\.label\.name == 'approved-for-listing'/);
  assert.match(verify, /pull_request:/);
  assert.match(verify, /permissions:\s+contents: read/);
  assert.match(verify, /fetch-depth: 0\s+persist-credentials: false/);
  assert.match(verify, /run: npm ci/);
  assert.match(verify, /run: npm test/);
  assert.match(verify, /git diff --check/);
  assert.match(validate, /timeout-minutes:/);
  assert.match(validate, /marketplace-validation/);
  assert.match(validate, /issues\/comments\/\$\{comment_id\}/);
  assert.doesNotMatch(validate, /--edit-last/);
  for (const workflow of [approve, refresh, deploy, validate, verify]) {
    const actionUses = [...workflow.matchAll(/uses:\s+([^\s#]+)/g)].map((match) => match[1]);
    assert.ok(actionUses.length > 0);
    assert.ok(actionUses.every((action) => /@[a-f0-9]{40}$/.test(action)));
  }
  for (const workflow of [approve, refresh, deploy, validate, verify]) {
    assert.match(workflow, /run: npm ci/);
  }
});

test("submission issue bodies yield a normalized repository URL", () => {
  const body = submissionBody();
  assert.equal(extractRepositoryUrl(body), "https://github.com/example/omarchy-plugin");
  assert.throws(
    () => extractRepositoryUrl("No repository supplied"),
    /missing the "Repository URL" field/,
  );
});

test("approval fields are parsed from the submission issue", () => {
  const body = submissionBody();

  assert.deepEqual(parseSubmissionBody(body), {
    repo: "https://github.com/example/omarchy-plugin",
    category: "Developer Tools",
    tags: ["launcher", "quickshell"],
  });
  assert.throws(
    () => parseSubmissionBody(body.replace("Developer Tools", "Unlisted")),
    /Unsupported submission category/,
  );
});

test("submission tags use the curated vocabulary across web and CLI formats", () => {
  assert.deepEqual(
    parseSubmissionBody(submissionBody({
      tags: "- Bar\n- Power management\n- Quickshell",
      suggestedTag: "weather",
    })).tags,
    ["bar", "power-management", "quickshell"],
  );
  assert.deepEqual(
    parseSubmissionBody(submissionBody({
      tags: "bar-widget, power-profiles, quickapps",
      includeSuggestedTag: false,
    })).tags,
    ["bar", "power-management", "launcher"],
  );
  assert.deepEqual(
    parseSubmissionBody(submissionBody({
      tags: "command-palette, search, ai",
      includeSuggestedTag: false,
    })).tags,
    ["launcher", "ai"],
  );
  assert.deepEqual(
    parseSubmissionBody(submissionBody({
      tags: "Games, Media",
      includeSuggestedTag: false,
    })).tags,
    ["games", "media"],
  );
  assert.deepEqual(
    parseSubmissionBody(submissionBody({
      category: "Kids",
      tags: "Education, Games, Kids",
    })),
    {
      repo: "https://github.com/example/omarchy-plugin",
      category: "Kids",
      tags: ["education", "games", "kids"],
    },
  );
  assert.throws(
    () => parseSubmissionBody(submissionBody({
      category: "kids",
      tags: "education, kids",
    })),
    /Unsupported submission category "kids"/,
  );
  assert.throws(
    () => parseSubmissionBody(submissionBody({ tags: "education, child" })),
    /Unsupported submission tags: child/,
  );
  assert.throws(
    () => parseSubmissionBody(submissionBody({
      tags: "command-palette, search, quickapps, ai",
      includeSuggestedTag: false,
    })),
    /between one and 3 tags/,
  );
  assert.throws(
    () => parseSubmissionBody(submissionBody({ tags: "bar, weather" })),
    /Unsupported submission tags: weather/,
  );
  assert.throws(
    () => parseSubmissionBody(submissionBody({
      tags: allowedTags.slice(0, maximumSubmissionTags + 1).join(", "),
    })),
    /between one and 3 tags/,
  );
});

test("CLI submissions require the complete issue-form structure", () => {
  const body = submissionBody();
  assert.deepEqual(
    classifySubmission({ title: "[Plugin]: Example", body }),
    { shouldValidate: true, shouldLabel: true },
  );
  assert.deepEqual(
    classifySubmission({
      title: "[Plugin]: Legacy CLI",
      body: submissionBody({ includeSuggestedTag: false }),
    }),
    { shouldValidate: true, shouldLabel: true },
  );
  assert.deepEqual(
    classifySubmission({ title: "General question", body }),
    { shouldValidate: false, shouldLabel: false },
  );
  assert.deepEqual(
    classifySubmission({
      title: "[Plugin]: Example",
      body: submissionBody({ checked: submissionChecklist.slice(0, -1) }),
    }),
    { shouldValidate: true, shouldLabel: false },
  );
  assert.deepEqual(
    classifySubmission({
      title: "Malformed labeled submission",
      body: "missing fields",
      hasSubmissionLabel: true,
    }),
    { shouldValidate: true, shouldLabel: false },
  );
  assert.throws(
    () => parseCurrentSubmission({
      title: "[Plugin]: Example",
      body: submissionBody({ checked: submissionChecklist.slice(0, -1) }),
    }),
    /checklist item is not confirmed/,
  );
  assert.deepEqual(
    classifySubmission({ title: "[Plugin]:", body }),
    { shouldValidate: true, shouldLabel: false },
  );
});

test("submission failures provide concise safe and actionable public feedback", async () => {
  let checklistError;
  try {
    parseCurrentSubmission({
      title: "[Plugin]: OpenRouter Usage",
      body: submissionBody({ checked: submissionChecklist.slice(0, -1) }),
    });
  } catch (error) {
    checklistError = error;
  }
  const checklistFailure = publicSubmissionFailure(checklistError);
  assert.equal(checklistFailure.code, "submission-checklist-unconfirmed");
  assert.equal(
    checklistFailure.reason,
    "A required submission checklist item is not confirmed: “I understand that approval is for listing and is not a security review.”",
  );
  assert.equal(
    checklistFailure.action,
    "Check this item and edit the issue to run validation again.",
  );

  const catalogCodes = [
    "repository-unreachable",
    "manifest-invalid",
    "entry-point-missing",
    "reserved-plugin-id",
    "readme-missing",
    "license-missing",
    "preview-invalid",
    "unsupported-repository-layout",
  ];
  for (const code of catalogCodes) {
    const result = publicSubmissionFailure(new CatalogCheckError(code, "secret @maintainer raw failure"));
    assert.equal(result.code, code);
    assert.ok(result.reason.length > 10 && result.reason.length <= 500);
    assert.ok(result.action.length > 10 && result.action.length <= 500);
    assert.doesNotMatch(`${result.reason} ${result.action}`, /secret|@maintainer|\r|\n/);
  }

  const expectedUnknown = {
    code: "approval-service-error",
    reason: "The approval service could not complete the submission checks.",
    action: "A maintainer must review the workflow before reapplying `approved-and-verified`.",
  };
  const unknown = new Error("ghp_example_secret @owner /home/runner/private");
  assert.deepEqual(publicSubmissionFailure(unknown, { phase: "approval" }), expectedUnknown);
  for (const inheritedCode of ["constructor", "toString", "__proto__"]) {
    unknown.code = inheritedCode;
    assert.deepEqual(publicSubmissionFailure(unknown, { phase: "approval" }), expectedUnknown);
  }
  unknown.code = "plugin-id-listed";
  unknown.context = { pluginId: "invalid\n@owner" };
  assert.deepEqual(publicSubmissionFailure(unknown, { phase: "approval" }), expectedUnknown);
  assert.deepEqual(publicSubmissionFailure({
    code: "submission-repository-listed",
  }, { phase: "approval" }), {
    code: "submission-repository-listed",
    reason: "This repository is already listed in the marketplace.",
    action: "Use the existing listing instead of opening a duplicate submission.",
  });
  assert.deepEqual(publicSubmissionFailure({
    code: "approval-metadata-changed",
  }, { phase: "approval" }), {
    code: "approval-metadata-changed",
    reason: "The repository is already registered with different listing metadata.",
    action: "Review the existing listing and approval labels before reapplying `approved-and-verified`.",
  });
  assert.deepEqual(publicSubmissionFailure({
    code: "approval-upstream-changed",
  }, { phase: "approval" }), {
    code: "approval-upstream-changed",
    reason: "The upstream repository changed after the automated security baseline was recorded.",
    action: "Edit the submission issue to validate the new commit before reapplying `approved-and-verified`.",
  });
  for (const script of [
    "approve-submission.mjs",
    "build-catalog.mjs",
    "security-baseline.mjs",
    "validate-submission.mjs",
  ]) {
    const source = await readFile(new URL(`../scripts/${script}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /console\.error\([^\n]*error\.message/);
  }
});

test("validation rejects repositories and plugin IDs that are already listed", () => {
  const catalog = {
    plugins: [{
      id: "omarchy-overview",
      repo: "https://github.com/AyushKr2003/omarchy-overview",
    }],
  };
  assert.doesNotThrow(() => assertSubmissionIsUnlisted({
    repository: "example/new-plugin",
    manifests: [{ id: "example.new-plugin" }],
  }, catalog));

  let duplicateId;
  try {
    assertSubmissionIsUnlisted({
      repository: "sanjyay/omarchy-overview",
      manifests: [{ id: "omarchy-overview" }],
    }, catalog);
  } catch (error) {
    duplicateId = error;
  }
  assert.deepEqual(publicSubmissionFailure(duplicateId), {
    code: "plugin-id-listed",
    reason: "Plugin ID `omarchy-overview` is already listed.",
    action: "Choose a globally unique plugin ID and edit the issue to run validation again.",
  });
  assert.throws(
    () => assertSubmissionIsUnlisted({
      repository: "ayushkr2003/omarchy-overview",
      manifests: [{ id: "another-id" }],
    }, catalog),
    /already listed/,
  );

  let retiredId;
  try {
    assertSubmissionIsUnlisted({
      repository: "example/retired-id",
      manifests: [{ id: "taildrop" }],
    }, catalog, ["agent-bar.usage", "taildrop"]);
  } catch (error) {
    retiredId = error;
  }
  assert.deepEqual(publicSubmissionFailure(retiredId), {
    code: "plugin-id-retired",
    reason: "Plugin ID `taildrop` was used by a previous marketplace listing and cannot be reused.",
    action: "Choose a new globally unique plugin ID and edit the issue to run validation again.",
  });
});

test("approval failures retain safe reasons and approval-specific recovery", () => {
  const source = {
    repo: "https://github.com/example/plugin",
    plugins: { "omarchy-overview": { category: "Desktop", tags: ["workspaces"] } },
  };
  let duplicateError;
  try {
    addRegistrySource({ sources: [] }, source, ["omarchy-overview"]);
  } catch (error) {
    duplicateError = error;
  }
  assert.deepEqual(publicSubmissionFailure(duplicateError, { phase: "approval" }), {
    code: "plugin-id-listed",
    reason: "Plugin ID `omarchy-overview` is already listed.",
    action: "Choose a globally unique plugin ID. Then reapply `approved-and-verified` after validation passes.",
  });

  let retiredError;
  try {
    addRegistrySource({ sources: [] }, source, [], ["omarchy-overview"]);
  } catch (error) {
    retiredError = error;
  }
  assert.deepEqual(publicSubmissionFailure(retiredError, { phase: "approval" }), {
    code: "plugin-id-retired",
    reason: "Plugin ID `omarchy-overview` was used by a previous marketplace listing and cannot be reused.",
    action: "Choose a new globally unique plugin ID. Then reapply `approved-and-verified` after validation passes.",
  });
  assert.deepEqual(publicSubmissionFailure({ code: "approval-security-needs-fixes" }, { phase: "approval" }), {
    code: "approval-security-needs-fixes",
    reason: "The automated security baseline has selectively blocking findings that prevent a verified initial listing.",
    action: "Fix every selectively blocking finding and edit the submission issue to validate a new commit before reapplying `approved-and-verified`.",
  });
});

test("CLI checklist confirmation is limited to the checklist section", () => {
  const checkedInNotes = submissionChecklist.map((statement) => `- [x] ${statement}`).join("\n");
  const body = submissionBody({ notes: checkedInNotes, checked: [] });
  assert.deepEqual(
    classifySubmission({ title: "[Plugin]: Example", body }),
    { shouldValidate: true, shouldLabel: false },
  );
  assert.equal(
    hasRightsConfirmation({ user: { login: "plugin-author" }, body }),
    false,
  );
});

test("maintainer notes may contain their own Markdown headings", () => {
  const body = submissionBody({
    notes: "Installation details\n\n### Dependencies\n\nRequires jq.",
  });
  assert.deepEqual(
    classifySubmission({ title: "[Plugin]: Example", body }),
    { shouldValidate: true, shouldLabel: true },
  );
  assert.deepEqual(parseSubmissionBody(body), {
    repo: "https://github.com/example/omarchy-plugin",
    category: "Developer Tools",
    tags: ["launcher", "quickshell"],
  });
});

test("shared submission rules stay aligned with the public issue form", async () => {
  const form = await readFile(
    new URL("../.github/ISSUE_TEMPLATE/submit-plugin.yml", import.meta.url),
    "utf8",
  );
  for (const heading of [
    "Repository URL",
    "Category",
    "Tags",
    "Suggest a missing tag",
    "Maintainer notes",
    "Submission checklist",
  ]) {
    assert.match(form, new RegExp(`label: ${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  }
  for (const statement of submissionChecklist) {
    assert.ok(form.includes(`- label: ${statement}`));
  }
  assert.equal((form.match(/required: true/g) || []).length, 8);
  const categoryField = form.match(
    /- type: dropdown\s+id: category([\s\S]*?)\n  - type: dropdown\s+id: tags/,
  )?.[1];
  assert.ok(categoryField);
  const formCategories = [...categoryField.matchAll(/^\s+- ([A-Za-z][A-Za-z ]+)$/gm)]
    .map((match) => match[1]);
  assert.deepEqual(formCategories, allowedCategories);
  const tagField = form.match(
    /- type: dropdown\s+id: tags([\s\S]*?)\n  - type: input\s+id: suggested-tag/,
  )?.[1];
  assert.ok(tagField);
  assert.match(tagField, /multiple: true/);
  const formTags = [...tagField.matchAll(/^\s+- ([A-Za-z][A-Za-z ]+)$/gm)]
    .map((match) => match[1].toLowerCase().replace(/\s+/g, "-"));
  assert.deepEqual(formTags, allowedTags);
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.match(
    readme,
    /\[CLI and AI submission guide\]\(SUBMISSION\.md\)/,
  );
  assert.match(readme, /Choose a category and one to three tags/);
  assert.match(readme, /\[security policy and baseline\]\(SECURITY\.md#automated-security-baseline\)/i);
  assert.match(
    readme,
    /Interface design inspired by \[bjarneo\][\s\S]*\[ContextOwl developer documentation\]\(https:\/\/developer\.contextowl\.co\/docs\/platform\/cli\)/,
  );

  const guide = await readFile(new URL("../SUBMISSION.md", import.meta.url), "utf8");
  const guideCategoryList = guide.match(
    /Choose one category:\n\n([\s\S]*?)\n\nChoose one to three tags:/,
  )?.[1];
  assert.ok(guideCategoryList);
  const guideCategories = [...guideCategoryList.matchAll(/^- `([^`]+)`$/gm)]
    .map((match) => match[1]);
  assert.deepEqual(guideCategories, allowedCategories);
  const guideTagList = guide.match(
    /Choose one to three tags:\n\n([\s\S]*?)\n\nCopy category and tag values/,
  )?.[1];
  assert.ok(guideTagList);
  const guideTags = [...guideTagList.matchAll(/^- `([^`]+)`$/gm)]
    .map((match) => match[1]);
  assert.deepEqual(guideTags, allowedTags);
  const template = guide.match(
    /cat > \/tmp\/omarchy-plugin-submission\.md <<'EOF'\n([\s\S]*?)\nEOF/,
  )?.[1];
  assert.ok(template);
  const body = template
    .replace(
      "https://github.com/your_github_name/your_plugin_repository",
      "https://github.com/example/omarchy-plugin",
    )
    .replace("selected_category", "Widgets")
    .replace("selected_tag, another_selected_tag", "quickshell, bar");
  assert.deepEqual(
    parseCurrentSubmission({ title: "[Plugin]: Example", body }),
    {
      repo: "https://github.com/example/omarchy-plugin",
      category: "Widgets",
      tags: ["quickshell", "bar"],
    },
  );
  assert.match(guide, /unique across all repositories/);
  assert.match(guide, /retired or renamed listings remain unavailable/);
  assert.match(guide, /io\.github\.yourname\.plugin-name/);
  assert.match(guide, /## Respond to validation and publication feedback/);
  assert.match(guide, /failed status includes a concise reason and the next action/);
  assert.match(guide, /Rerunning the old failed workflow does not create a new request/);
  assert.match(guide, /failure handler leaves `approved-and-verified` unchanged/);
  assert.match(guide, /\[security policy and baseline\]\(SECURITY\.md#automated-security-baseline\)/i);

  const baselineGuide = await readFile(new URL("../SECURITY.md", import.meta.url), "utf8");
  for (const requirement of [
    "This is not a security audit, certification, warranty, or endorsement.",
    "passed",
    "review-required",
    "needs-fixes",
    "security-review-required",
    "curl-pipe-shell",
    "cargo-git-unpinned",
    "remote-git-execution-unpinned",
    "sudoers-dangerous-passwordless-command",
    "privileged-process-control-from-shared-temp",
    "sudoers-modification",
    "selective",
    "1,000",
    "8 MiB",
    "exact full commit SHA",
    "Snapshot check and upstream drift",
  ]) {
    assert.ok(baselineGuide.includes(requirement));
  }
  assert.match(baselineGuide, /^## Automated Security Baseline$/m);
  assert.match(baselineGuide, /does not execute plugin code/i);
  assert.match(baselineGuide, /written to a file that a later command executes without verification/i);
  assert.match(baselineGuide, /must not use AI/i);
  assert.match(baselineGuide, /root-owned purpose-built helper with a fixed command surface/i);
  assert.match(baselineGuide, /non-selectively-blocking findings[\s\S]*`approved-and-verified`/i);
  assert.match(baselineGuide, /selectively blocking `needs-fixes` disposition[\s\S]*must be fixed[\s\S]*before publication/i);
  assert.match(baselineGuide, /scan errors[\s\S]*selectively blocking findings[\s\S]*no verification bypass/i);
  assert.match(baselineGuide, /maintainer-reviewed verification is stored separately as a canonical attestation/i);
  assert.match(baselineGuide, /not a freely editable verification flag/i);
  assert.doesNotMatch(`${guide}\n${baselineGuide}`, /Automated Security Baseline V1|shadow mode|shadow period/i);
});

test("distribution rights require a checked issue-body statement", () => {
  const issue = {
    user: { login: "plugin-author" },
    body: submissionBody({
      checked: submissionChecklist.filter((statement) => statement !== rightsStatement),
    }),
  };
  assert.equal(hasRightsConfirmation(issue), false);
  assert.equal(hasRightsConfirmation({ ...issue, body: submissionBody() }), true);
  assert.equal(
    hasRightsConfirmation({
      ...issue,
      body: submissionBody().replace(
        rightsStatement,
        "I have the right to distribute this plugin and its assets under the declared license.",
      ),
    }),
    true,
  );
});

test("only maintainers with write access can approve submissions", () => {
  for (const permission of ["write", "maintain", "admin"]) {
    assert.equal(canApprove(permission), true);
  }
  for (const permission of ["read", "triage", "none", undefined]) {
    assert.equal(canApprove(permission), false);
  }
});

test("approval processes exactly the issue body seen when the label was applied", () => {
  const approved = "### Repository URL\n\nhttps://github.com/example/plugin\n";
  assert.doesNotThrow(() => assertApprovedIssueBody(approved, approved));
  assert.throws(
    () => assertApprovedIssueBody(
      approved.replace("example/plugin", "attacker/replacement"),
      approved,
    ),
    /changed after approval/,
  );
  assert.throws(
    () => assertApprovedIssueBody(`${approved}\n`, approved),
    /changed after approval/,
  );
  assert.throws(
    () => assertApprovedIssueBody(approved, undefined),
    /APPROVED_ISSUE_BODY is required/,
  );
});

test("approval revalidates the complete current submission", () => {
  const currentIssue = {
    created_at: "2026-08-07T00:00:00Z",
    title: "[Plugin]: Example",
    body: submissionBody({ checked: submissionChecklist.slice(0, -1) }),
  };
  assert.throws(
    () => parseApprovableSubmission(currentIssue),
    /checklist item is not confirmed/,
  );
  assert.deepEqual(
    parseApprovableSubmission({ ...currentIssue, body: submissionBody() }),
    {
      repo: "https://github.com/example/omarchy-plugin",
      category: "Developer Tools",
      tags: ["launcher", "quickshell"],
    },
  );
});

test("only submissions predating the current form receive legacy handling", () => {
  const legacyIssue = {
    created_at: "2026-07-28T10:48:58Z",
    title: "[Plugin]: Omarchy Overview",
    body: [
      "### Repository URL",
      "",
      "https://github.com/AyushKr2003/omarchy-overview",
      "",
      "### Category",
      "",
      "Appearance",
      "",
      "### Tags",
      "",
      "overviews, workspaces, previews",
      "",
      "### Maintainer notes",
      "",
      "A Hyprland workspace overview plugin.",
      "",
      "### Submission checklist",
      "",
      "- [x] The repository is public and contains installation and removal instructions.",
      "- [x] I have documented the plugin license and any external dependencies.",
      "- [x] The plugin does not overwrite user configuration without explicit consent.",
      "- [x] I understand that submissions are reviewed before publication.",
    ].join("\n"),
  };
  assert.equal(isLegacySubmission(legacyIssue), true);
  assert.equal(predatesRightsConfirmation(legacyIssue), true);
  assert.doesNotThrow(() => assertRightsConfirmation(legacyIssue));
  const expected = {
    repo: "https://github.com/AyushKr2003/omarchy-overview",
    category: "Appearance",
    tags: ["workspaces"],
  };
  assert.deepEqual(parseSubmissionBody(legacyIssue.body), expected);
  assert.deepEqual(parseIssueSubmission(legacyIssue), expected);
  const intermediateIssue = {
    ...legacyIssue,
    created_at: "2026-07-28T12:00:00Z",
    body: legacyIssue.body.replace(
      "- [x] The plugin does not overwrite user configuration without explicit consent.",
      `- [x] ${rightsStatement}\n- [x] The plugin does not overwrite user configuration without explicit consent.`,
    ),
  };
  assert.equal(isLegacySubmission(intermediateIssue), true);
  assert.equal(predatesRightsConfirmation(intermediateIssue), false);
  assert.doesNotThrow(() => assertRightsConfirmation(intermediateIssue));
  assert.deepEqual(parseIssueSubmission(intermediateIssue), expected);
  const freeTagIssue = {
    ...intermediateIssue,
    created_at: "2026-07-29T12:00:00Z",
    body: intermediateIssue.body.replace(
      "overviews, workspaces, previews",
      "bar, quickshell, system, ai",
    ),
  };
  assert.deepEqual(parseIssueSubmission(freeTagIssue).tags, ["bar", "quickshell", "system"]);
  const batteryIssue = {
    ...intermediateIssue,
    created_at: "2026-07-29T14:10:34Z",
    body: intermediateIssue.body.replace(
      "overviews, workspaces, previews",
      "dell, power-profiles, firmware, laptop, battery",
    ),
  };
  assert.deepEqual(parseIssueSubmission(batteryIssue).tags, ["system", "power-management"]);
  const screenshotIssue = {
    ...intermediateIssue,
    created_at: "2026-07-30T14:46:45Z",
    body: intermediateIssue.body.replace(
      "overviews, workspaces, previews",
      "screenshot",
    ),
  };
  assert.deepEqual(parseIssueSubmission(screenshotIssue).tags, ["quickshell"]);
  const unconfirmedFreeTagIssue = {
    ...freeTagIssue,
    body: freeTagIssue.body.replace(`- [x] ${rightsStatement}\n`, ""),
  };
  assert.equal(hasRightsConfirmation(unconfirmedFreeTagIssue), false);
  assert.throws(
    () => assertRightsConfirmation(unconfirmedFreeTagIssue),
    /has not confirmed/,
  );
  assert.throws(
    () => parseIssueSubmission(unconfirmedFreeTagIssue),
    /has not confirmed/,
  );
  assert.equal(isLegacySubmission({ created_at: "2026-07-30T15:04:13Z" }), false);
  assert.equal(isLegacySubmission({}), false);
});

test("approved submissions become registry sources without duplicates", () => {
  const source = createRegistrySource({
    submission: {
      repo: "https://github.com/Example/omarchy-plugin",
      category: "Desktop",
      tags: ["hyprland", "workspaces"],
    },
    manifests: [
      { id: "example.overview", name: "Overview", path: "overview/manifest.json" },
      { id: "example.switcher", name: "Switcher", path: "switcher/manifest.json" },
    ],
    addedAt: "2026-07-28",
    listedAt: "2026-07-28T11:17:52.000Z",
    listingValidatedCommit: "a".repeat(40),
    listingValidatedAt: "2026-07-28T11:17:52.000Z",
    listingValidatedBranch: "main",
  });

  assert.deepEqual(source, {
    repo: "https://github.com/Example/omarchy-plugin",
    type: "plugin-source",
    addedAt: "2026-07-28",
    listedAt: "2026-07-28T11:17:52.000Z",
    listingValidatedCommit: "a".repeat(40),
    listingValidatedAt: "2026-07-28T11:17:52.000Z",
    listingValidatedBranch: "main",
    plugins: {
      "example.overview": {
        category: "Desktop",
        tags: ["hyprland", "workspaces"],
        manifestPath: "overview/manifest.json",
      },
      "example.switcher": {
        category: "Desktop",
        tags: ["hyprland", "workspaces"],
        manifestPath: "switcher/manifest.json",
      },
    },
  });
  const baselineRecord = createApprovedSecurityBaseline({
    baselineVersion: "3",
    repository: "example/plugin",
    commitSha: "c".repeat(40),
    checkedAt: "2026-07-28T11:00:00.000Z",
    outcome: "review-required",
    enforcementMode: "selective",
    findings: [],
    capabilities: ["service-management"],
    pluginIds: ["example.plugin"],
  }, { pluginIds: ["example.plugin"] });
  assert.deepEqual(baselineRecord, {
    schemaVersion: 1,
    version: "3",
    repository: "example/plugin",
    pluginIds: ["example.plugin"],
    commit: "c".repeat(40),
    checkedAt: "2026-07-28T11:00:00.000Z",
    outcome: "review-required",
    enforcementMode: "selective",
    findings: [],
    capabilities: ["service-management"],
  });
  assert.equal(approvedAndVerifiedLabel, "approved-and-verified");
  assert.equal(legacyApprovalLabel, "approved-for-listing");
  const approvalDecision = approvalDecisionForEvents([
    {
      id: 44001,
      event: "labeled",
      label: { name: approvedAndVerifiedLabel },
      actor: { login: "maintainer" },
      created_at: "2026-07-28T12:00:00.000Z",
    },
  ], {
    approver: "maintainer",
    expectedRequestedAt: "2026-07-28T12:00:00.000Z",
  });
  assert.deepEqual(approvalDecision, {
    eventId: 44001,
    requestedAt: "2026-07-28T12:00:00.000Z",
    reviewer: "maintainer",
  });
  const baselineComment = latestSecurityBaselineComment([{
    id: 33001,
    user: { login: "github-actions[bot]" },
    updated_at: "2026-07-28T11:01:00.000Z",
    body: serializeSecurityBaselineMarker({
      baselineVersion: "3",
      repository: "example/plugin",
      commitSha: "c".repeat(40),
      checkedAt: "2026-07-28T11:00:00.000Z",
      outcome: "review-required",
      enforcementMode: "selective",
      findings: [],
      capabilities: ["service-management"],
      pluginIds: ["example.plugin"],
    }),
  }]);
  assert.equal(baselineComment.commentId, 33001);
  assert.equal(baselineComment.baseline.commitSha, "c".repeat(40));
  assert.throws(
    () => approvalDecisionForEvents([
      {
        id: 44001,
        event: "labeled",
        label: { name: approvedAndVerifiedLabel },
        actor: { login: "other-maintainer" },
        created_at: "2026-07-28T12:00:00.000Z",
      },
    ], {
      approver: "maintainer",
      expectedRequestedAt: "2026-07-28T12:00:00.000Z",
    }),
    (error) => error.code === "approval-event-invalid",
  );
  assert.throws(
    () => approvalDecisionForEvents([{
      id: 44001,
      event: "labeled",
      label: { name: approvedAndVerifiedLabel },
      actor: { login: "maintainer" },
      created_at: "2026-07-28T12:00:00.000Z",
    }], {
      approver: "maintainer",
      expectedEventId: 44001,
      expectedRequestedAt: "2026-07-28T12:00:01.000Z",
    }),
    (error) => error.code === "approval-event-invalid",
  );
  const reviewEvidence = createApprovedVerificationEvidence({
    reviewedBaseline: {
      baselineVersion: "3",
      repository: "example/plugin",
      commitSha: "c".repeat(40),
      checkedAt: "2026-07-28T11:00:00.000Z",
      outcome: "review-required",
      enforcementMode: "selective",
      findings: [],
      capabilities: ["service-management"],
      pluginIds: ["example.plugin"],
    },
    rescannedBaseline: {
      baselineVersion: "3",
      repository: "example/plugin",
      commitSha: "c".repeat(40),
      checkedAt: "2026-07-28T12:01:00.000Z",
      outcome: "review-required",
      enforcementMode: "selective",
      findings: [],
      capabilities: ["service-management"],
      pluginIds: ["example.plugin"],
    },
    recordOptions: {
      expectedRepository: "example/plugin",
      expectedCommit: "c".repeat(40),
      pluginIds: ["example.plugin"],
    },
    reviewer: "maintainer",
    requestEventId: 44001,
    requestedAt: "2026-07-28T12:00:00.000Z",
    reviewedAt: "2026-07-28T12:02:00.000Z",
  });
  assert.equal(reviewEvidence.verificationMethod, "maintainer-reviewed");
  assert.equal(reviewEvidence.maintainerVerificationReview.requestEventId, 44001);
  const verifiedSource = createRegistrySource({
    submission: {
      repo: "https://github.com/example/plugin",
      category: "System",
      tags: ["system"],
    },
    manifests: [{ id: "example.plugin", name: "Example" }],
    addedAt: "2026-07-28",
    listedAt: "2026-07-28T12:02:00.000Z",
    listingValidatedCommit: "c".repeat(40),
    listingValidatedAt: "2026-07-28T12:02:00.000Z",
    listingValidatedBranch: "main",
    automatedSecurityBaseline: reviewEvidence.automatedSecurityBaseline,
    maintainerVerificationReview: reviewEvidence.maintainerVerificationReview,
  });
  assert.equal(sourceVerification(verifiedSource).status, "verified");
  assert.equal(sourceVerification(verifiedSource).method, "maintainer-reviewed");
  const findingEvidence = createApprovedVerificationEvidence({
    reviewedBaseline: {
      baselineVersion: "3",
      repository: "example/selective",
      commitSha: "d".repeat(40),
      checkedAt: "2026-07-28T11:00:00.000Z",
      outcome: "needs-fixes",
      enforcementMode: "selective",
      findings: ["curl-pipe-shell"],
      capabilities: [],
      pluginIds: ["example.selective"],
    },
    rescannedBaseline: {
      baselineVersion: "3",
      repository: "example/selective",
      commitSha: "d".repeat(40),
      checkedAt: "2026-07-28T12:01:00.000Z",
      outcome: "needs-fixes",
      enforcementMode: "selective",
      findings: ["curl-pipe-shell"],
      capabilities: [],
      pluginIds: ["example.selective"],
    },
    recordOptions: {
      expectedRepository: "example/selective",
      expectedCommit: "d".repeat(40),
      pluginIds: ["example.selective"],
    },
    reviewer: "maintainer",
    requestEventId: 44002,
    requestedAt: "2026-07-28T12:00:00.000Z",
    reviewedAt: "2026-07-28T12:02:00.000Z",
  });
  assert.equal(findingEvidence.verificationMethod, "maintainer-reviewed");
  assert.equal(findingEvidence.maintainerVerificationReview.baselineOutcome, "needs-fixes");
  assert.deepEqual(findingEvidence.maintainerVerificationReview.findings, ["curl-pipe-shell"]);
  const selectivelyVerifiedSource = createRegistrySource({
    submission: {
      repo: "https://github.com/example/selective",
      category: "System",
      tags: ["system"],
    },
    manifests: [{ id: "example.selective", name: "Selective" }],
    addedAt: "2026-07-28",
    listedAt: "2026-07-28T12:02:00.000Z",
    listingValidatedCommit: "d".repeat(40),
    listingValidatedAt: "2026-07-28T12:02:00.000Z",
    listingValidatedBranch: "main",
    automatedSecurityBaseline: findingEvidence.automatedSecurityBaseline,
    maintainerVerificationReview: findingEvidence.maintainerVerificationReview,
  });
  assert.equal(sourceVerification(selectivelyVerifiedSource).status, "verified");
  assert.equal(sourceVerification(selectivelyVerifiedSource).method, "maintainer-reviewed");
  assert.throws(
    () => createApprovedVerificationEvidence({
      reviewedBaseline: {
        baselineVersion: "3",
        repository: "example/plugin",
        commitSha: "c".repeat(40),
        checkedAt: "2026-07-28T11:00:00.000Z",
        outcome: "review-required",
        enforcementMode: "selective",
        findings: [],
        capabilities: ["service-management"],
        pluginIds: ["example.plugin"],
      },
      rescannedBaseline: {
        baselineVersion: "3",
        repository: "example/plugin",
        commitSha: "c".repeat(40),
        checkedAt: "2026-07-28T12:01:00.000Z",
        outcome: "review-required",
        enforcementMode: "selective",
        findings: [],
        capabilities: ["installer"],
        pluginIds: ["example.plugin"],
      },
      recordOptions: {
        expectedRepository: "example/plugin",
        expectedCommit: "c".repeat(40),
        pluginIds: ["example.plugin"],
      },
      reviewer: "maintainer",
      requestEventId: 44001,
      requestedAt: "2026-07-28T12:00:00.000Z",
      reviewedAt: "2026-07-28T12:02:00.000Z",
    }),
    (error) => error.code === "approval-security-baseline-changed",
  );
  const automaticEvidence = createApprovedVerificationEvidence({
    reviewedBaseline: {
      baselineVersion: "3",
      repository: "example/automatic",
      commitSha: "f".repeat(40),
      checkedAt: "2026-07-28T11:00:00.000Z",
      outcome: "passed",
      enforcementMode: "selective",
      findings: [],
      capabilities: [],
      pluginIds: ["example.automatic"],
    },
    rescannedBaseline: {
      baselineVersion: "3",
      repository: "example/automatic",
      commitSha: "f".repeat(40),
      checkedAt: "2026-07-28T12:01:00.000Z",
      outcome: "passed",
      enforcementMode: "selective",
      findings: [],
      capabilities: [],
      pluginIds: ["example.automatic"],
    },
    recordOptions: {
      expectedRepository: "example/automatic",
      expectedCommit: "f".repeat(40),
      pluginIds: ["example.automatic"],
    },
    reviewer: "maintainer",
    requestEventId: 44001,
    requestedAt: "2026-07-28T12:00:00.000Z",
    reviewedAt: "2026-07-28T12:02:00.000Z",
  });
  assert.equal(automaticEvidence.verificationMethod, "automated");
  assert.equal(automaticEvidence.maintainerVerificationReview, null);
  assert.equal(automaticEvidence.automatedSecurityBaseline.checkedAt, "2026-07-28T12:01:00.000Z");
  const manualSource = createRegistrySource({
    submission: {
      repo: "https://github.com/Example/native-plugin",
      category: "System",
      tags: ["system"],
    },
    manifests: [{ id: "example.native", name: "Native" }],
    addedAt: "2026-07-28",
    listedAt: "2026-07-28T11:17:52.000Z",
    listingValidatedCommit: "b".repeat(40),
    listingValidatedAt: "2026-07-28T11:17:52.000Z",
    listingValidatedBranch: "main",
    automatedSecurityBaseline: baselineRecord,
    manualSetup: true,
  });
  assert.deepEqual(manualSource.automatedSecurityBaseline, baselineRecord);
  assert.deepEqual(manualSource.plugins["example.native"].installation, {
    mode: "manual",
    note: manualSetupNote,
  });
  const selectiveReviewRecord = createApprovedSecurityBaseline({
    baselineVersion: "3",
    repository: "example/plugin",
    commitSha: "d".repeat(40),
    checkedAt: "2026-07-28T11:00:00.000Z",
    outcome: "needs-fixes",
    enforcementMode: "selective",
    findings: ["remote-git-execution-unpinned"],
    capabilities: ["remote-build"],
    pluginIds: ["example.plugin"],
  }, { pluginIds: ["example.plugin"] });
  assert.equal(selectiveReviewRecord.outcome, "needs-fixes");
  assert.deepEqual(selectiveReviewRecord.findings, ["remote-git-execution-unpinned"]);
  assert.equal(Object.hasOwn(selectiveReviewRecord, "reviewedBy"), false);
  assert.equal(Object.hasOwn(selectiveReviewRecord, "reviewedAt"), false);
  assert.throws(
    () => createApprovedSecurityBaseline({
      baselineVersion: "3",
      repository: "example/plugin",
      commitSha: "e".repeat(40),
      checkedAt: "2026-07-28T11:00:00.000Z",
      outcome: "passed",
      enforcementMode: "selective",
      findings: ["curl-pipe-shell"],
      capabilities: [],
      pluginIds: ["example.plugin"],
    }, { pluginIds: ["example.plugin"] }),
    (error) => error.code === "approval-security-baseline-invalid",
  );
  assert.equal(parseManualSetupApproval("true"), true);
  assert.equal(parseManualSetupApproval("false"), false);
  assert.throws(() => parseManualSetupApproval("TRUE"), /must be true or false/);
  assert.throws(
    () => createRegistrySource({
      submission: { repo: "https://github.com/Example/invalid", category: "Other", tags: ["system"] },
      manifests: [],
      manualSetup: "yes",
    }),
    /manualSetup must be a boolean/,
  );

  assert.deepEqual(addRegistrySource({ sources: [] }, source), { sources: [source] });
  assert.deepEqual(addRegistrySource({ sources: [source] }, source), { sources: [source] });
  assert.throws(
    () => addRegistrySource(
      { sources: [source] },
      {
        ...source,
        plugins: {
          ...source.plugins,
          "example.extra": { category: "Desktop", tags: ["overlay"] },
        },
      },
    ),
    /different plugin set/,
  );
  assert.throws(
    () => addRegistrySource(
      { sources: [source] },
      {
        ...source,
        plugins: {
          ...source.plugins,
          "example.overview": {
            ...source.plugins["example.overview"],
            installation: { mode: "manual", note: manualSetupNote },
          },
        },
      },
    ),
    /different listing metadata/,
  );
  assert.throws(
    () => addRegistrySource({ sources: [] }, source, ["example.overview"]),
    /already listed/,
  );
});

test("registry plugin IDs are an explicit publication allowlist", async () => {
  const source = {
    plugins: {
      "example.approved": { category: "Desktop", tags: ["approved"] },
    },
  };
  assert.equal(isListedPlugin(source, "example.approved"), true);
  assert.equal(isListedPlugin(source, "example.added-later"), false);
  assert.equal(isListedPlugin({}, "example.added-later"), false);

  const registry = JSON.parse(
    await readFile(new URL("../registry.json", import.meta.url), "utf8"),
  );
  const establishedRetiredPluginIds = [
    "agent-bar.usage",
    "io.github.percius04.omafiles",
    "mathew.breathe",
    "murphi.openfortivpn",
    "taildrop",
    "tenzin.animechy",
    "tenzin.omamovie",
    "ucmz851.omatorrent",
  ];
  assert.ok(establishedRetiredPluginIds.every((pluginId) => registry.retiredPluginIds.includes(pluginId)));
  assert.ok(registry.retiredPluginIds.every((pluginId) => (
    typeof pluginId === "string"
      && pluginId.length <= manifestFieldLimits.id
      && /^[a-z0-9][a-z0-9._-]*$/.test(pluginId)
      && !pluginId.includes("..")
  )));
  const activeIds = assertRetiredPluginIdsAreInactive(registry);
  assert.ok(activeIds.has("lacuna.shell-suite"));
  assert.ok(registry.placeholders.every(({ id }) => activeIds.has(id)));
  assert.throws(() => assertRetiredPluginIdsAreInactive({
    sources: [{ catalog: { id: "example.retired-suite" } }],
    placeholders: [],
    retiredPluginIds: ["example.retired-suite"],
  }), /must not remain active/);
  assert.throws(() => assertRetiredPluginIdsAreInactive({
    sources: [],
    placeholders: [{ id: "example.retired-placeholder" }],
    retiredPluginIds: ["example.retired-placeholder"],
  }), /must not remain active/);
  assert.equal(
    registry.sources.some((entry) => entry.repo.toLowerCase() === "https://github.com/percius04/omafiles".toLowerCase()),
    false,
  );
  assert.equal(
    registry.sources.some((entry) => entry.repo.toLowerCase() === "https://github.com/setiapam/omarchy-openfortivpn".toLowerCase()),
    false,
  );
  assert.equal(
    registry.sources.some((entry) => entry.repo.toLowerCase() === "https://github.com/ucmz851/omatorrent".toLowerCase()),
    false,
  );
  const bjarneoSource = registry.sources.find(
    (entry) => entry.repo === "https://github.com/bjarneo/omarchy-shell-plugins",
  );
  assert.deepEqual(Object.keys(bjarneoSource.plugins).sort(), ["cliamp", "omni", "quickapps-hud"]);

  const omabreathe = registry.sources.find(
    (entry) => entry.repo === "https://github.com/matiacone/omarchy-breathe",
  );
  assert.deepEqual(Object.keys(omabreathe.plugins), ["omabreathe"]);
  const listedCommit = omabreathe.listingValidatedCommit;
  assert.match(listedCommit, /^[a-f0-9]{40}$/);

  const catalog = JSON.parse(
    await readFile(new URL("../site/catalog.json", import.meta.url), "utf8"),
  );
  assert.equal(catalog.plugins.some((plugin) => plugin.id === "mathew.breathe"), false);
  assert.equal(catalog.plugins.some((plugin) => plugin.id === "io.github.percius04.omafiles"), false);
  assert.equal(catalog.plugins.some((plugin) => plugin.id === "murphi.openfortivpn"), false);
  assert.equal(catalog.plugins.some((plugin) => plugin.id === "ucmz851.omatorrent"), false);
  assert.equal(catalog.warnings.some((warning) => /percius04\/omafiles/i.test(warning)), false);
  assert.equal(catalog.warnings.some((warning) => /setiapam\/omarchy-openfortivpn/i.test(warning)), false);
  assert.equal(catalog.warnings.some((warning) => /ucmz851\/omatorrent/i.test(warning)), false);
  const catalogEntries = catalog.plugins.filter((plugin) => plugin.id === "omabreathe");
  assert.equal(catalogEntries.length, 1);
  assert.equal(catalogEntries[0].listingValidatedCommit, listedCommit);
  assert.match(catalogEntries[0].upstreamObservedCommit, /^[a-f0-9]{40}$/);
  assert.match(catalogEntries[0].upstreamValidatedCommit, /^[a-f0-9]{40}$/);
  assert.ok(["passed", "failed", "unreachable"].includes(catalogEntries[0].upstreamCheckStatus));
});

test("registry tag projections accept new entries without a static ID allowlist", () => {
  const registry = {
    sources: [
      {
        catalog: { id: "example.game-suite", tags: ["games"] },
      },
      {
        plugins: {
          "example.game": { tags: ["games", "quickshell"] },
          "example.utility": { tags: ["system"] },
        },
      },
    ],
    placeholders: [
      { id: "example.upcoming-game", tags: ["games"] },
    ],
  };
  const catalog = {
    plugins: [
      { id: "example.utility", tags: ["system"] },
      { id: "example.upcoming-game", tags: ["games"] },
      { id: "example.game", tags: ["games", "quickshell"] },
      { id: "example.game-suite", tags: ["games"] },
    ],
  };

  assert.doesNotThrow(() => assertTagProjectionMatchesRegistry(registry, catalog, "games"));
});

test("registry tag projections reject missing, extra, and duplicate IDs", () => {
  const registry = {
    sources: [{ plugins: { "example.game": { tags: ["games"] } } }],
    placeholders: [],
  };
  const matchingPlugin = { id: "example.game", tags: ["games"] };
  const assertionError = (error) => error?.code === "ERR_ASSERTION";

  assert.throws(
    () => assertTagProjectionMatchesRegistry(registry, { plugins: [] }, "games"),
    assertionError,
  );
  assert.throws(
    () => assertTagProjectionMatchesRegistry(registry, {
      plugins: [matchingPlugin, { id: "example.extra-game", tags: ["games"] }],
    }, "games"),
    assertionError,
  );
  assert.throws(
    () => assertTagProjectionMatchesRegistry(registry, {
      plugins: [matchingPlugin, { ...matchingPlugin }],
    }, "games"),
    assertionError,
  );
  assert.throws(
    () => assertTagProjectionMatchesRegistry(registry, {
      plugins: [matchingPlugin, { id: matchingPlugin.id, tags: ["system"] }],
    }, "games"),
    assertionError,
  );
  for (const duplicateRegistry of [
    {
      sources: [{
        catalog: { id: "example.game", tags: ["games"] },
        plugins: { "example.game": { tags: ["games"] } },
      }],
      placeholders: [],
    },
    {
      sources: [{ plugins: { "example.game": { tags: ["games"] } } }],
      placeholders: [{ id: "example.game", tags: ["system"] }],
    },
  ]) {
    assert.throws(
      () => taggedPluginIds(registryPluginEntries(duplicateRegistry), "games", "registry"),
      assertionError,
    );
  }
});

test("registry tag projections reject malformed IDs and tags", () => {
  const malformedRegistries = [
    { sources: [{ catalog: { id: "", tags: ["games"] } }], placeholders: [] },
    { sources: [{ catalog: { tags: ["games"] } }], placeholders: [] },
    { sources: [{ catalog: { id: "example.game-suite", tags: "games" } }], placeholders: [] },
    { sources: [{ plugins: { "": { tags: ["games"] } } }], placeholders: [] },
    { sources: [{ plugins: { "example.game": { tags: "games" } } }], placeholders: [] },
    ...["example game", ".example", "example..game", "Example.game", "💣"].map((pluginId) => ({
      sources: [{ plugins: { [pluginId]: { tags: ["games"] } } }],
      placeholders: [],
    })),
    { sources: [], placeholders: [{ id: "", tags: ["games"] }] },
    { sources: [], placeholders: [{ tags: ["games"] }] },
    { sources: [], placeholders: [{ id: "example.upcoming-game", tags: "games" }] },
  ];
  const assertionError = (error) => error?.code === "ERR_ASSERTION";

  for (const registry of malformedRegistries) {
    assert.throws(
      () => taggedPluginIds(registryPluginEntries(registry), "games", "registry"),
      assertionError,
    );
  }
  for (const plugin of [
    { id: "", tags: ["games"] },
    { tags: ["games"] },
    { id: "example.game", tags: "games" },
    ...["example game", ".example", "example..game", "Example.game", "💣"].map((id) => ({
      id,
      tags: ["games"],
    })),
  ]) {
    assert.throws(
      () => taggedPluginIds([[plugin.id, plugin]], "games", "catalog"),
      assertionError,
    );
  }
});

test("registry community tags use the curated vocabulary and selection limit", async () => {
  const registry = JSON.parse(
    await readFile(new URL("../registry.json", import.meta.url), "utf8"),
  );
  const entries = [
    ...registry.sources.flatMap((source) => [
      ...(source.catalog ? [source.catalog] : []),
      ...Object.values(source.plugins || {}),
    ]),
    ...registry.placeholders,
  ];
  for (const entry of entries) {
    assert.ok(entry.tags.length >= 1 && entry.tags.length <= maximumSubmissionTags);
    assert.ok(entry.tags.every((tag) => allowedTags.includes(tag)));
    assert.equal(new Set(entry.tags).size, entry.tags.length);
  }
  const catalog = JSON.parse(
    await readFile(new URL("../site/catalog.json", import.meta.url), "utf8"),
  );
  assertTagProjectionMatchesRegistry(registry, catalog, "games");
  const liveLock = catalog.plugins.find((plugin) => plugin.id === "io.github.sumdahl.lock");
  assert.ok(liveLock);
  assert.equal(liveLock.tags.includes("security"), false);
});

test("catalog discovery ignores manifests added after listing approval", async () => {
  const approved = {
    schemaVersion: 1,
    id: "example.approved",
    name: "Approved",
    version: "1.0.0",
    author: "Example",
    description: "The plugin approved for marketplace listing.",
    kinds: ["overlay"],
    entryPoints: { overlay: "Main.qml" },
  };
  const addedLater = {
    ...approved,
    id: "example.added-later",
    name: "Added later",
  };
  const tree = [
    { path: "manifest.json", type: "blob", mode: "100644" },
    { path: "Main.qml", type: "blob", mode: "100644" },
    { path: "extra/manifest.json", type: "blob", mode: "100644" },
    { path: "extra/Main.qml", type: "blob", mode: "100644" },
  ];
  const context = {
    repository: { owner: "example", repository: "plugins", slug: "example/plugins" },
    commitSha: "a".repeat(40),
    tree,
    treeByPath: new Map(tree.map((entry) => [entry.path, entry])),
    metadata: {},
  };
  const source = {
    repo: "https://github.com/example/plugins",
    addedAt: "2026-07-28",
    listedAt: "2026-07-28T12:00:00.000Z",
    plugins: {
      "example.approved": { category: "Desktop", tags: ["approved"] },
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => new Response(
    JSON.stringify(String(url).includes("/extra/") ? addedLater : approved),
    { status: 200 },
  );
  try {
    const result = await discoveredPlugins(source, context, null);
    assert.deepEqual(result.map((plugin) => plugin.id), ["example.approved"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("plugin manifests require stable marketplace identity fields", () => {
  const manifest = {
    schemaVersion: 1,
    id: "example.weather",
    name: "Weather",
    version: "1.0.0",
    author: "Example",
    description: "Weather in the Omarchy bar.",
    kinds: ["bar-widget"],
    entryPoints: { barWidget: "Widget.qml" }
  };
  assert.equal(validateManifest(manifest, "manifest.json"), manifest);
  for (const defaultSection of ["left", "center", "right"]) {
    const withDefaultSection = {
      ...manifest,
      barWidget: { defaultSection },
    };
    assert.equal(validateManifest(withDefaultSection, "manifest.json"), withDefaultSection);
  }
  assert.throws(
    () => validateManifest(
      { ...manifest, barWidget: { defaultSection: "bottom" } },
      "manifest.json",
    ),
    /defaultSection.*left, center, or right/,
  );
  assert.throws(
    () => validateManifest(
      { ...manifest, barWidget: { defaultSection: 1 } },
      "manifest.json",
    ),
    /defaultSection.*left, center, or right/,
  );
  assert.throws(
    () => validateManifest({ ...manifest, description: "" }, "manifest.json"),
    /description/
  );
  assert.throws(
    () => validateManifest(
      {
        ...manifest,
        version: "v".repeat(maximumManifestVersionLength + 1),
      },
      "manifest.json",
      { community: true },
    ),
    /version.*must not exceed 64 characters/
  );
  const maximumCommunityVersion = {
    ...manifest,
    version: "v".repeat(maximumManifestVersionLength),
  };
  assert.equal(
    validateManifest(maximumCommunityVersion, "manifest.json", { community: true }),
    maximumCommunityVersion,
  );
  const longerBuiltInVersion = {
    ...manifest,
    version: "v".repeat(maximumManifestVersionLength + 1),
  };
  assert.equal(
    validateManifest(longerBuiltInVersion, "manifest.json"),
    longerBuiltInVersion,
  );
  assert.throws(
    () => validateManifest({ ...manifest, kinds: "overlay" }, "manifest.json"),
    /unsupported values/
  );
  assert.throws(
    () => validateManifest({ ...manifest, schemaVersion: 0 }, "manifest.json"),
    /exactly 1/
  );
  assert.throws(
    () => validateManifest({ ...manifest, entryPoints: { barWidget: "../Outside.qml" } }, "manifest.json"),
    /safe relative paths/
  );
  assert.throws(
    () => validateManifest({ ...manifest, id: "omarchy.fake" }, "manifest.json", { community: true }),
    /reserved/
  );
  assert.throws(
    () => validateManifest({ ...manifest, entryPoints: {} }, "manifest.json"),
    /entry point/
  );
});

test("community manifest text is normalized and bounded", () => {
  const manifest = {
    schemaVersion: 1,
    id: "example.weather",
    name: "  Weather  ",
    version: "  1.0.0  ",
    author: "  Example  ",
    description: "  Weather in the Omarchy bar.  ",
    license: "  MIT  ",
    kinds: ["bar-widget"],
    entryPoints: { barWidget: "Widget.qml" },
  };
  const normalized = validateManifest(manifest, "manifest.json", { community: true });
  assert.equal(normalized.name, "Weather");
  assert.equal(normalized.version, "1.0.0");
  assert.equal(normalized.author, "Example");
  assert.equal(normalized.description, "Weather in the Omarchy bar.");
  assert.equal(normalized.license, "MIT");
  assert.throws(
    () => validateManifest({ ...manifest, id: " example.weather " }, "manifest.json", { community: true }),
    /id.*leading or trailing whitespace/,
  );
  assert.throws(
    () => validateManifest({ ...manifest, id: "Omarchy.fake" }, "manifest.json", { community: true }),
    /lowercase/,
  );
  assert.throws(
    () => validateManifest({ ...manifest, id: "a".repeat(manifestFieldLimits.id + 1) }, "manifest.json", { community: true }),
    /must not exceed 128 characters/,
  );
  assert.throws(
    () => validateManifest({ ...manifest, name: "Bad\u0000Name" }, "manifest.json", { community: true }),
    /control characters/,
  );
  const paddedVersion = validateManifest(
    { ...manifest, version: `${" ".repeat(1000)}1.0.0${" ".repeat(1000)}` },
    "manifest.json",
    { community: true },
  );
  assert.equal(paddedVersion.version, "1.0.0");
});

test("only catalog check errors are recoverable source failures", () => {
  const expected = new CatalogCheckError("repository-unreachable", "offline");
  assert.equal(assertRecoverableCatalogError(expected), expected);
  assert.throws(
    () => assertRecoverableCatalogError(new TypeError("internal bug")),
    /internal bug/,
  );
});

test("preview file names remain unique for ambiguous repository slugs", () => {
  assert.notEqual(
    previewFileBase({ owner: "foo-bar", repository: "baz" }),
    previewFileBase({ owner: "foo", repository: "bar-baz" }),
  );
});

test("preview images are bounded and converted into optimized WebP variants", async () => {
  const input = await sharp({
    create: {
      width: 1920,
      height: 1080,
      channels: 4,
      background: { r: 20, g: 40, b: 60, alpha: 1 },
    },
  }).png().toBuffer();
  const optimized = await optimizePreviewBuffer(input, {
    owner: "example",
    repository: "plugin",
    slug: "example/plugin",
  });
  assert.equal(optimized.fileBase, "7-example-plugin");
  assert.deepEqual(
    optimized.outputs.map((output) => output.fileName),
    ["7-example-plugin-card.webp", "7-example-plugin-detail.webp"],
  );
  const card = await sharp(optimized.outputs[0].buffer).metadata();
  const detail = await sharp(optimized.outputs[1].buffer).metadata();
  assert.equal(card.format, "webp");
  assert.equal(card.width, previewCardLimit);
  assert.equal(card.height, 405);
  assert.equal(detail.format, "webp");
  assert.equal(detail.width, previewDetailLimit);
  assert.equal(detail.height, 900);
  assert.equal(optimized.metadata.previewThumbnailWidth, previewCardLimit);
  assert.equal(optimized.metadata.previewWidth, previewDetailLimit);
  assert.doesNotThrow(() => validatePreviewMetadata({ format: "heif", width: 10, height: 10 }));
  assert.throws(
    () => validatePreviewMetadata({
      format: "png",
      width: previewPixelLimit,
      height: 2,
    }),
    /pixel limit/,
  );
});

test("generated source plugins retain manifest paths and local preview assets", async () => {
  const catalog = JSON.parse(await readFile(new URL("../site/catalog.json", import.meta.url), "utf8"));
  const omni = catalog.plugins.find((plugin) => plugin.id === "omni");
  const lacuna = catalog.plugins.find((plugin) => plugin.id === "lacuna.shell-suite");
  assert.equal(omni.manifestPath, "omni/manifest.json");
  assert.match(lacuna.previewImage, /^assets\/img\/plugins\/.*-detail\.webp$/);
  assert.match(lacuna.previewThumbnail, /^assets\/img\/plugins\/.*-card\.webp$/);
});
