// Maintenance signal for community listings.
//
// A listing is "maintained" when its repository has accepted work from
// someone other than its owner, has existed long enough to outlive a
// drive-by publish, and still receives commits. The facts come from the
// same GraphQL identity batch that the scheduled refresh already runs for
// every source, so computing the signal adds no REST requests. This is a
// collaboration and activity signal only; it says nothing about security.

export const maintenancePolicyVersion = 1;
export const maintenanceMinimumRepositoryAgeDays = 60;
export const maintenanceActivityWindowDays = 180;
export const maintenanceMergedPullRequestSample = 20;

const dayMs = 24 * 60 * 60 * 1000;
// Authors who belong to the repository side: its owner and, for an
// organization-owned repository, the organization's members.
const insiderAssociations = new Set(["OWNER", "MEMBER"]);

export const maintenanceCatalogFields = Object.freeze([
  "maintenanceStatus",
  "maintenancePolicyVersion",
  "repositoryCreatedAt",
  "repositoryCommittedAt",
  "mergedPullRequests",
  "externalMergedPullRequests",
  "externalContributors",
]);

function isTimestamp(value) {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isLogin(value) {
  return typeof value === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(value);
}

export class MaintenanceFactsError extends Error {
  constructor(message) {
    super(message);
    this.name = "MaintenanceFactsError";
  }
}

function invalid(message) {
  throw new MaintenanceFactsError(message);
}

/**
 * Validate the GraphQL repository fields that feed the maintenance signal
 * and reduce them to a small, frozen fact record. Throws
 * MaintenanceFactsError on any structural surprise so a schema drift fails
 * the refresh closed instead of silently publishing "maintained".
 */
export function maintenanceFactsFromGraphql(value, { ownerLogin, committedDate } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("repository is not an object");
  if (!isLogin(ownerLogin)) invalid("repository owner login is invalid");
  if (!isTimestamp(value.createdAt)) invalid("repository createdAt is invalid");
  if (!isTimestamp(committedDate)) invalid("selected branch committedDate is invalid");
  const pulls = value.mergedPullRequests;
  if (!pulls || typeof pulls !== "object" || Array.isArray(pulls)) invalid("mergedPullRequests is invalid");
  if (!isCount(pulls.totalCount)) invalid("mergedPullRequests.totalCount is invalid");
  if (!Array.isArray(pulls.nodes) || pulls.nodes.length > maintenanceMergedPullRequestSample) {
    invalid("mergedPullRequests.nodes is invalid");
  }
  const repositoryCreated = Date.parse(value.createdAt);
  const owner = ownerLogin.toLowerCase();
  const contributors = new Set();
  let externalMerged = 0;
  for (const node of pulls.nodes) {
    if (!node || typeof node !== "object" || Array.isArray(node)) invalid("merged pull request node is invalid");
    if (!isTimestamp(node.mergedAt)) invalid("merged pull request mergedAt is invalid");
    if (typeof node.authorAssociation !== "string") invalid("merged pull request authorAssociation is invalid");
    const author = node.author;
    // Deleted accounts arrive as null; they never count as an outside contributor.
    if (author === null) continue;
    if (!author || typeof author !== "object" || Array.isArray(author)) invalid("merged pull request author is invalid");
    if (typeof author.__typename !== "string") invalid("merged pull request author type is invalid");
    if (author.__typename !== "User") continue; // Bots, mannequins, organizations
    if (insiderAssociations.has(node.authorAssociation)) continue;
    // An account with an unexpected login or creation date is one author's
    // oddity, not schema drift, so it simply does not count instead of
    // failing the whole refresh.
    if (!isLogin(author.login) || !isTimestamp(author.createdAt)) continue;
    if (author.login.toLowerCase() === owner) continue;
    // Sock-puppet guard: the contributor account must predate the repository.
    if (Date.parse(author.createdAt) >= repositoryCreated) continue;
    externalMerged += 1;
    contributors.add(author.login.toLowerCase());
  }
  return Object.freeze({
    repositoryCreatedAt: new Date(repositoryCreated).toISOString(),
    repositoryCommittedAt: new Date(Date.parse(committedDate)).toISOString(),
    mergedPullRequests: pulls.totalCount,
    externalMergedPullRequests: externalMerged,
    externalContributors: contributors.size,
  });
}

export function maintenanceStatus(facts, now = Date.now()) {
  if (!facts || !isTimestamp(facts.repositoryCreatedAt) || !isTimestamp(facts.repositoryCommittedAt)) {
    return "unestablished";
  }
  const age = now - Date.parse(facts.repositoryCreatedAt);
  const sinceCommit = now - Date.parse(facts.repositoryCommittedAt);
  const established = age >= maintenanceMinimumRepositoryAgeDays * dayMs;
  const active = sinceCommit <= maintenanceActivityWindowDays * dayMs;
  const collaborative = isCount(facts.externalContributors) && facts.externalContributors >= 1;
  return established && active && collaborative ? "maintained" : "unestablished";
}

/**
 * Flat catalog projection of the maintenance facts, matching the existing
 * flat per-plugin field style in site/catalog.json.
 */
export function projectMaintenance(facts, now = Date.now()) {
  return {
    maintenanceStatus: maintenanceStatus(facts, now),
    maintenancePolicyVersion: maintenancePolicyVersion,
    repositoryCreatedAt: facts.repositoryCreatedAt,
    repositoryCommittedAt: facts.repositoryCommittedAt,
    mergedPullRequests: facts.mergedPullRequests,
    externalMergedPullRequests: facts.externalMergedPullRequests,
    externalContributors: facts.externalContributors,
  };
}

export function hasMaintenanceProjection(plugin) {
  return typeof plugin?.maintenanceStatus === "string";
}

/** Copy the maintenance fields from a prior catalog entry, if it has them. */
export function carriedMaintenance(prior) {
  if (!hasMaintenanceProjection(prior)) return {};
  const carried = {};
  for (const field of maintenanceCatalogFields) {
    if (Object.hasOwn(prior, field)) carried[field] = prior[field];
  }
  return carried;
}

export function stripMaintenance(plugin) {
  const next = { ...plugin };
  for (const field of maintenanceCatalogFields) delete next[field];
  return next;
}
