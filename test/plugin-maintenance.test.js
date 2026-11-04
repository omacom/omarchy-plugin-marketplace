import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  MaintenanceFactsError,
  carriedMaintenance,
  maintenanceActivityWindowDays,
  maintenanceCatalogFields,
  maintenanceFactsFromGraphql,
  maintenanceMergedPullRequestSample,
  maintenanceMinimumRepositoryAgeDays,
  maintenanceStatus,
  projectMaintenance,
  stripMaintenance,
} from "../scripts/plugin-maintenance.mjs";
import { catalogRefreshIdentityQuery, failedSourcePlugins, successfulState } from "../scripts/build-catalog.mjs";
import {
  maintenanceFactsLabel,
  maintenancePullRequestSample,
  matchesMaintenanceStatus,
  pluginMaintenanceState,
} from "../site/assets/js/shared.js";
import { detailTemplate } from "../site/assets/js/plugin.js";
import {
  appendSearchState,
  createSearchTerm,
  matchesSearchSelection,
  parseSearchDraft,
  pluginSearchContext,
  readSearchState,
  searchTermInputValue,
} from "../site/assets/js/search.js";

const dayMs = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-10-29T12:00:00Z");
const repositoryCreatedAt = "2026-03-01T00:00:00Z";

function user(login, createdAt = "2020-01-01T00:00:00Z") {
  return { __typename: "User", login, createdAt };
}

function pullRequest(author, { mergedAt = "2026-09-01T00:00:00Z", authorAssociation = "CONTRIBUTOR" } = {}) {
  return { mergedAt, authorAssociation, author };
}

function repository(nodes = [], overrides = {}) {
  return {
    createdAt: repositoryCreatedAt,
    mergedPullRequests: { totalCount: nodes.length, nodes },
    ...overrides,
  };
}

function facts(nodes = [], overrides = {}) {
  return maintenanceFactsFromGraphql(repository(nodes, overrides), {
    ownerLogin: "Owner",
    committedDate: "2026-10-20T00:00:00Z",
  });
}

test("maintenance facts count only outside human contributors whose accounts predate the repository", () => {
  const result = facts([
    pullRequest(user("owner")),
    pullRequest(user("OWNER")),
    pullRequest(user("helper")),
    pullRequest(user("helper")),
    pullRequest(user("second")),
    pullRequest(user("sockpuppet", "2026-06-01T00:00:00Z")),
    pullRequest({ __typename: "Bot", login: "dependabot" }),
    pullRequest(null),
  ]);
  assert.equal(result.externalContributors, 2);
  assert.equal(result.externalMergedPullRequests, 3);
  assert.equal(result.mergedPullRequests, 8);
  assert.equal(result.repositoryCreatedAt, "2026-03-01T00:00:00.000Z");
  assert.equal(result.repositoryCommittedAt, "2026-10-20T00:00:00.000Z");
  assert.ok(Object.isFrozen(result));
});

test("maintenance facts ignore organization members and owners of the repository", () => {
  const result = facts([
    pullRequest(user("teammate"), { authorAssociation: "MEMBER" }),
    pullRequest(user("founder"), { authorAssociation: "OWNER" }),
    pullRequest(user("collaborator"), { authorAssociation: "COLLABORATOR" }),
    pullRequest(user("newcomer"), { authorAssociation: "FIRST_TIME_CONTRIBUTOR" }),
  ]);
  assert.equal(result.externalContributors, 2);
  assert.equal(result.externalMergedPullRequests, 2);
});

test("maintenance facts skip authors with unexpected account data instead of failing", () => {
  const result = facts([
    pullRequest({ __typename: "User", login: "managed_user" }),
    pullRequest({ __typename: "User", login: "no-created-at" }),
    pullRequest({ __typename: "User", login: "bad-date", createdAt: "unknown" }),
    pullRequest(user("helper")),
  ]);
  assert.equal(result.externalContributors, 1);
  assert.equal(result.externalMergedPullRequests, 1);
});

test("maintenance facts fail closed on malformed GraphQL structures", () => {
  const cases = [
    () => maintenanceFactsFromGraphql(null, { ownerLogin: "owner", committedDate: "2026-10-20T00:00:00Z" }),
    () => maintenanceFactsFromGraphql(repository(), { ownerLogin: "", committedDate: "2026-10-20T00:00:00Z" }),
    () => maintenanceFactsFromGraphql(repository(), { ownerLogin: "owner", committedDate: "soon" }),
    () => facts([], { createdAt: "yesterday" }),
    () => facts([], { mergedPullRequests: null }),
    () => facts([], { mergedPullRequests: { totalCount: -1, nodes: [] } }),
    () => facts([], { mergedPullRequests: { totalCount: "3", nodes: [] } }),
    () => facts(Array.from({ length: maintenanceMergedPullRequestSample + 1 }, () => pullRequest(user("helper")))),
    () => facts([{ mergedAt: "2026-09-01T00:00:00Z", authorAssociation: "CONTRIBUTOR", author: "helper" }]),
    () => facts([{ mergedAt: "never", authorAssociation: "CONTRIBUTOR", author: user("helper") }]),
    () => facts([{ mergedAt: "2026-09-01T00:00:00Z", author: user("helper") }]),
    () => facts([pullRequest({ login: "helper", createdAt: "2020-01-01T00:00:00Z" })]),
  ];
  for (const run of cases) assert.throws(run, MaintenanceFactsError);
});

test("maintenance status requires age, recent commits, and an outside contributor", () => {
  const established = facts([pullRequest(user("helper"))]);
  assert.equal(maintenanceStatus(established, now), "maintained");

  const solo = facts([pullRequest(user("owner"))]);
  assert.equal(maintenanceStatus(solo, now), "unestablished");

  const young = maintenanceFactsFromGraphql(
    repository([pullRequest(user("helper"))], {
      createdAt: new Date(now - (maintenanceMinimumRepositoryAgeDays - 1) * dayMs).toISOString(),
    }),
    { ownerLogin: "owner", committedDate: "2026-10-20T00:00:00Z" },
  );
  assert.equal(maintenanceStatus(young, now), "unestablished");

  const stale = maintenanceFactsFromGraphql(
    repository([pullRequest(user("helper"))]),
    {
      ownerLogin: "owner",
      committedDate: new Date(now - (maintenanceActivityWindowDays + 1) * dayMs).toISOString(),
    },
  );
  assert.equal(maintenanceStatus(stale, now), "unestablished");
  assert.equal(maintenanceStatus(null, now), "unestablished");
  assert.equal(maintenanceStatus({ ...established, externalContributors: "1" }, now), "unestablished");
});

test("maintenance projection is flat, carried, and strippable", () => {
  const projected = projectMaintenance(facts([pullRequest(user("helper"))]), now);
  assert.deepEqual(Object.keys(projected).sort(), [...maintenanceCatalogFields].sort());
  assert.equal(projected.maintenanceStatus, "maintained");
  assert.equal(projected.maintenancePolicyVersion, 1);
  assert.deepEqual(carriedMaintenance({ ...projected, name: "x" }), projected);
  assert.deepEqual(carriedMaintenance({ name: "x" }), {});
  assert.deepEqual(stripMaintenance({ ...projected, name: "x" }), { name: "x" });
});

test("catalog refresh identity query requests the maintenance fields", () => {
  const request = catalogRefreshIdentityQuery([{ repo: "https://github.com/example/plugin" }]);
  assert.match(request.query, /createdAt defaultBranchRef\{name target\{\.\.\.CatalogRefreshCommit\}\}/);
  assert.match(request.query, new RegExp(`mergedPullRequests:pullRequests\\(states:MERGED,first:${maintenanceMergedPullRequestSample},orderBy:\\{field:UPDATED_AT,direction:DESC\\}\\)\\{totalCount nodes\\{mergedAt authorAssociation author\\{__typename login \\.\\.\\. on User\\{createdAt\\}\\}\\}\\}`));
  assert.match(request.query, /fragment CatalogRefreshCommit on Commit\{oid committedDate tree\{oid\}\}/);
});

const source = {
  repo: "https://github.com/example/plugin",
  type: "root-plugin",
  addedAt: "2026-03-02",
  listedAt: "2026-03-02T00:00:00.000Z",
  listingValidatedCommit: "a".repeat(40),
  listingValidatedAt: "2026-03-02T00:00:00.000Z",
  listingValidatedBranch: "main",
  plugins: { "example.plugin": {} },
};
const context = { commitSha: "b".repeat(40), branch: "main" };
const projected = projectMaintenance(facts([pullRequest(user("helper"))]), now);

test("REST snapshot builds carry prior maintenance fields and full refreshes replace them", () => {
  const plugin = { id: "example.plugin", version: "1.0.0", repo: source.repo, installAvailable: true };
  const prior = { ...plugin, ...projected };
  const carried = successfulState(plugin, source, context, prior, "2026-10-29T00:00:00.000Z");
  assert.equal(carried.maintenanceStatus, "maintained");
  assert.equal(carried.externalContributors, 1);

  const fresh = successfulState(
    { ...plugin, ...projected, maintenanceStatus: "unestablished", externalContributors: 0 },
    source,
    context,
    prior,
    "2026-10-29T00:00:00.000Z",
  );
  assert.equal(fresh.maintenanceStatus, "unestablished");
  assert.equal(fresh.externalContributors, 0);

  const noPrior = successfulState(plugin, source, context, null, "2026-10-29T00:00:00.000Z");
  assert.equal(Object.hasOwn(noPrior, "maintenanceStatus"), false);
});

test("failed and unreachable sources do not keep a stale maintained state", () => {
  const previous = [{
    id: "example.plugin",
    repo: source.repo,
    repositoryLayout: "root-plugin",
    manifestPath: "manifest.json",
    ...projected,
  }];
  const checkedAt = "2026-10-29T00:00:00.000Z";
  const error = Object.assign(new Error("gone"), { code: "repository-unreachable" });
  const [unreachable] = failedSourcePlugins(source, previous, null, checkedAt, error);
  assert.equal(Object.hasOwn(unreachable, "maintenanceStatus"), false);
  assert.equal(Object.hasOwn(unreachable, "externalContributors"), false);

  const withIdentity = {
    ...context,
    metadata: { maintenance: facts([pullRequest(user("owner"))]) },
  };
  const [failed] = failedSourcePlugins(source, previous, withIdentity, checkedAt, error);
  assert.equal(failed.maintenanceStatus, "unestablished");
  assert.equal(failed.externalContributors, 0);
});

test("site helpers expose the maintained state without a security claim", () => {
  const plugin = { id: "example.plugin", ...projected };
  assert.equal(matchesMaintenanceStatus(plugin), true);
  assert.equal(matchesMaintenanceStatus({ ...plugin, builtIn: true }), false);
  assert.equal(matchesMaintenanceStatus({ ...plugin, placeholder: true }), false);
  assert.equal(matchesMaintenanceStatus({ ...plugin, maintenanceStatus: "unestablished" }), false);
  assert.equal(matchesMaintenanceStatus({}), false);
  assert.equal(pluginMaintenanceState({ ...plugin, maintenanceStatus: "unestablished" }), null);
  const state = pluginMaintenanceState(plugin);
  assert.equal(state.label, "Maintained");
  assert.match(state.explanation, /1 outside contributor, 1 of 1 merged pull request from outside/);
  assert.match(state.explanation, /not a security review/);
  assert.match(
    maintenanceFactsLabel({ externalContributors: 2, externalMergedPullRequests: 3, mergedPullRequests: 7 }),
    /^2 outside contributors, 3 of 7 merged pull requests from outside$/,
  );
  // Beyond the sample the label names the inspected window, not a repository total.
  assert.match(
    maintenanceFactsLabel({ externalContributors: 1, externalMergedPullRequests: 2, mergedPullRequests: 340 }),
    /^1 outside contributor, 2 of the last 20 merged pull requests from outside$/,
  );
  assert.match(maintenanceFactsLabel({ externalContributors: 0, externalMergedPullRequests: 0, mergedPullRequests: 0 }), /^0 outside contributors, no merged pull requests$/);
  assert.equal(maintenancePullRequestSample, maintenanceMergedPullRequestSample);
});

test("plugin detail renders the maintenance row only when the catalog carries it", () => {
  const base = {
    id: "example.plugin",
    name: "Example",
    description: "Example plugin",
    author: "example",
    version: "1.0.0",
    category: "Desktop",
    tags: [],
    accent: "lime",
    initials: "EX",
    kind: "Panel",
    status: "Available",
    sourceType: "community",
    repositoryLayout: "root-plugin",
    installAvailable: true,
    installCommand: "omarchy plugin add https://github.com/example/plugin.git --enable",
    installNote: "",
    verificationStatus: "unverified",
    verificationSnapshotStatus: "unverified",
    verificationCoverage: "unverified",
    repo: source.repo,
    listingValidatedCommit: source.listingValidatedCommit,
    listingValidatedAt: source.listingValidatedAt,
    listingValidatedBranch: "main",
    upstreamObservedCommit: source.listingValidatedCommit,
    upstreamCheckedAt: "2026-10-29T00:00:00.000Z",
    upstreamCheckStatus: "passed",
  };
  const engagement = { views: 0, copies: 0, hearts: 0 };
  const without = detailTemplate(base, engagement);
  assert.doesNotMatch(without, /<dt>Maintenance<\/dt>/);

  const maintained = detailTemplate({ ...base, ...projected }, engagement);
  assert.match(maintained, /<dt>Maintenance<\/dt><dd><span class="listing-check-status is-passed">Maintained<\/span><small>1 outside contributor, 1 of 1 merged pull request from outside, repository since /);

  const unestablished = detailTemplate({ ...base, ...projected, maintenanceStatus: "unestablished" }, engagement);
  assert.match(unestablished, /<span class="listing-check-status is-neutral">Not established<\/span>/);
});

test("browse page offers the Maintained filter next to the verification filters", async () => {
  const index = await readFile(new URL("../site/index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../site/assets/js/app.js", import.meta.url), "utf8");
  assert.match(index, /<option value="name">A–Z<\/option>\s*<option value="maintained">Maintained<\/option>\s*<option value="verified">Verified<\/option>/);
  assert.match(app, /\["maintained", "Maintained"\],\s*\["verified", "Verified"\]/);
  assert.match(app, /const filterShortcuts = new Map\(\[\s*\["maintained", "contributors:1\+ age:60d\+ committed:180d"\],\s*\["verified", "is:verified"\],\s*\["unverified", "is:unverified"\],\s*\]\);/);
  assert.match(app, /const shortcut = filterShortcuts\.get\(sort\.value\);\s*if \(shortcut\) \{\s*applySearchShortcut\(shortcut\);\s*return;\s*\}\s*applySortTerm\(sort\.value\);/);
  assert.match(app, /function applySearchShortcut\(shortcut\) \{\s*appendShortcutTerms\(shortcut\);\s*search\.value = state\.query;/);
  assert.match(app, /if \(shortcut\) appendShortcutTerms\(shortcut\);/);
  assert.doesNotMatch(app, /maintenanceFilters/);
  assert.match(app, /class="card-verification is-maintained"/);
});

test("the Maintained shortcut spells out the exact maintenance policy thresholds", async () => {
  const app = await readFile(new URL("../site/assets/js/app.js", import.meta.url), "utf8");
  const shortcut = app.match(/\["maintained", "([^"]+)"\]/)?.[1];
  assert.equal(
    shortcut,
    `contributors:1+ age:${maintenanceMinimumRepositoryAgeDays}d+ committed:${maintenanceActivityWindowDays}d`,
  );
  const terms = parseSearchDraft(shortcut);
  assert.deepEqual(terms, [
    { type: "contributors", value: "1+" },
    { type: "age", value: `${maintenanceMinimumRepositoryAgeDays}d+` },
    { type: "committed", value: `${maintenanceActivityWindowDays}d` },
  ]);
  const base = { id: "example.plugin", name: "Example", repo: "https://github.com/example/plugin", tags: [] };
  const cases = [
    ["2026-01-01T00:00:00Z", "2026-10-20T00:00:00Z", 1],
    ["2026-01-01T00:00:00Z", "2026-10-20T00:00:00Z", 0],
    ["2026-01-01T00:00:00Z", "2026-10-20T00:00:00Z", 3],
    [new Date(now - maintenanceMinimumRepositoryAgeDays * dayMs).toISOString(), "2026-10-20T00:00:00Z", 1],
    [new Date(now - maintenanceMinimumRepositoryAgeDays * dayMs + 1).toISOString(), "2026-10-20T00:00:00Z", 1],
    ["2026-01-01T00:00:00Z", new Date(now - maintenanceActivityWindowDays * dayMs).toISOString(), 1],
    ["2026-01-01T00:00:00Z", new Date(now - maintenanceActivityWindowDays * dayMs - 1).toISOString(), 1],
    ["2026-01-01T00:00:00Z", "2026-11-05T00:00:00Z", 1],
  ];
  for (const [repositoryCreatedAt, repositoryCommittedAt, externalContributors] of cases) {
    const factsValue = { repositoryCreatedAt, repositoryCommittedAt, externalContributors };
    const plugin = { ...base, ...factsValue };
    const expected = maintenanceStatus(factsValue, now) === "maintained";
    const context = pluginSearchContext(plugin);
    assert.equal(matchesSearchSelection(context, { terms, now }), expected, JSON.stringify(factsValue));
    assert.equal(matchesSearchSelection(context, { terms: [], draftTerms: terms, now }), expected);
  }
  const facts = { repositoryCreatedAt: "2026-01-01T00:00:00Z", repositoryCommittedAt: "2026-10-20T00:00:00Z", externalContributors: 2 };
  assert.equal(matchesSearchSelection(pluginSearchContext({ ...base, ...facts, builtIn: true }), { terms, now }), false);
  assert.equal(matchesSearchSelection(pluginSearchContext({ ...base, ...facts, placeholder: true }), { terms, now }), false);
  assert.equal(matchesSearchSelection(pluginSearchContext(base), { terms, now }), false);
  assert.equal(matchesSearchSelection(pluginSearchContext({ ...base, ...facts }), { terms: parseSearchDraft("contributors:3+"), now }), false);
  assert.equal(matchesSearchSelection(pluginSearchContext({ ...base, ...facts }), { terms: parseSearchDraft("age:2w"), now }), true);
  assert.equal(matchesSearchSelection(pluginSearchContext({ ...base, ...facts }), { terms: parseSearchDraft("committed:7d"), now }), false);
});

test("maintenance criteria terms normalize, reject invalid values, and round-trip through URL state", () => {
  assert.deepEqual(parseSearchDraft("contributors:2 age:8W committed:2w"), [
    { type: "contributors", value: "2+" },
    { type: "age", value: "8w+" },
    { type: "committed", value: "2w" },
  ]);
  assert.deepEqual(parseSearchDraft("contributors:0 contributors:x age:0d age:soon committed:180d+"), [
    { type: "text", value: "contributors:0" },
    { type: "text", value: "contributors:x" },
    { type: "text", value: "age:0d" },
    { type: "text", value: "age:soon" },
    { type: "text", value: "committed:180d+" },
  ]);
  assert.equal(searchTermInputValue(createSearchTerm("age", "60d")), "age:60d+");
  const terms = parseSearchDraft("contributors:1+ age:60d+ committed:180d");
  const params = appendSearchState(new URLSearchParams(), { terms, draft: "" });
  assert.equal(params.toString(), "contributors=1%2B&age=60d%2B&committed=180d");
  assert.deepEqual(readSearchState(params).terms, terms);
});

test("is:maintained search term composes with other terms and round-trips through URL state", () => {
  assert.deepEqual(parseSearchDraft("is:maintained tag:bar"), [
    { type: "is", value: "maintained" },
    { type: "tag", value: "bar" },
  ]);
  assert.deepEqual(parseSearchDraft("IS:Maintained"), [{ type: "is", value: "maintained" }]);
  assert.deepEqual(parseSearchDraft("is:verified"), [{ type: "is", value: "verified" }]);
  assert.equal(createSearchTerm("is", "popular"), null);
  assert.equal(searchTermInputValue(createSearchTerm("is", "maintained")), "is:maintained");

  const maintained = { id: "example.plugin", name: "Example", repo: "https://github.com/example/plugin", tags: ["bar"], ...projected };
  const solo = { ...maintained, id: "solo.plugin", name: "Solo", maintenanceStatus: "unestablished" };
  const builtIn = { ...maintained, id: "omarchy.builtin", builtIn: true };
  const terms = parseSearchDraft("is:maintained tag:bar");
  assert.equal(matchesSearchSelection(pluginSearchContext(maintained), { terms }), true);
  assert.equal(matchesSearchSelection(pluginSearchContext(solo), { terms }), false);
  assert.equal(matchesSearchSelection(pluginSearchContext(builtIn), { terms }), false);
  assert.equal(matchesSearchSelection(pluginSearchContext(maintained), { terms: [], draftTerms: terms }), true);
  assert.equal(matchesSearchSelection(pluginSearchContext(solo), { terms: [], draftTerms: terms }), false);

  const params = appendSearchState(new URLSearchParams(), { terms, draft: "" });
  assert.equal(params.toString(), "is=maintained&tag=bar");
  assert.deepEqual(readSearchState(params).terms, terms);
  assert.deepEqual(readSearchState(new URLSearchParams("is=anything")).terms, []);
});
