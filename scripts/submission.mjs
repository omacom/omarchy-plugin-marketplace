import { parseGitHubRepository } from "./github-repository.mjs";

export const submissionTitlePrefix = "[Plugin]:";

export const submissionChecklist = Object.freeze([
  "The repository is public and contains installation and removal instructions.",
  "I have documented the plugin license and any external dependencies.",
  "I confirm that I own or have permission to submit this plugin and its preview assets.",
  "The plugin does not overwrite user configuration without explicit consent.",
  "I understand that approval is for listing and is not a security review.",
]);

export const rightsStatement = submissionChecklist[2];
export const rightsConfirmationIntroducedAt = Date.parse("2026-07-28T10:58:48Z");
export const currentSubmissionIntroducedAt = Date.parse("2026-07-30T15:04:13Z");

export const allowedCategories = Object.freeze([
  "Appearance",
  "Desktop",
  "Developer Tools",
  "Hardware",
  "Kids",
  "Productivity",
  "System",
  "Widgets",
  "Other",
]);

export const allowedTags = Object.freeze([
  "ai",
  "bar",
  "education",
  "games",
  "hyprland",
  "kids",
  "launcher",
  "media",
  "power-management",
  "quickshell",
  "security",
  "system",
  "workspaces",
]);

export const maximumSubmissionTags = 3;

const tagAliases = new Map([
  ["autohide", "hyprland"],
  ["bar-widget", "bar"],
  ["battery", "power-management"],
  ["command-palette", "launcher"],
  ["coming-soon", null],
  ["dell", "system"],
  ["dev", "system"],
  ["firmware", "system"],
  ["hardware", "system"],
  ["hardware-control", "system"],
  ["laptop", "system"],
  ["llmman", "ai"],
  ["music", "media"],
  ["ollama", "ai"],
  ["omarchy", null],
  ["overlay", "quickshell"],
  ["overviews", "workspaces"],
  ["plugin", null],
  ["power-profiles", "power-management"],
  ["previews", "workspaces"],
  ["quickapps", "launcher"],
  ["search", "launcher"],
  ["screenshot", "quickshell"],
  ["shell-suite", "quickshell"],
  ["sidebar", "quickshell"],
  ["system-monitoring", "system"],
  ["updates", "system"],
  ["visualizer", "media"],
]);

const legacySubmissionHeadings = Object.freeze([
  "Repository URL",
  "Category",
  "Tags",
  "Maintainer notes",
  "Submission checklist",
]);
const submissionHeadings = Object.freeze([
  "Repository URL",
  "Category",
  "Tags",
  "Suggest a missing tag",
  "Maintainer notes",
  "Submission checklist",
]);
const submissionHeadingSet = new Set(submissionHeadings);

export class SubmissionFormatError extends Error {
  constructor(code, message, context = {}) {
    super(message);
    this.name = "SubmissionFormatError";
    this.code = code;
    this.context = Object.freeze({ ...context });
  }
}

function reservedSections(body) {
  const text = String(body || "");
  const markers = [...text.matchAll(/^###\s+(.+?)\s*$/gm)]
    .filter((match) => submissionHeadingSet.has(match[1]))
    .map((match) => ({
      heading: match[1],
      start: match.index,
      contentStart: match.index + match[0].length,
    }));
  const sections = new Map();
  for (const [index, marker] of markers.entries()) {
    if (sections.has(marker.heading)) {
      throw new SubmissionFormatError(
        "submission-field-repeated",
        `Submission repeats the "${marker.heading}" field`,
        { heading: marker.heading },
      );
    }
    const end = markers[index + 1]?.start ?? text.length;
    sections.set(marker.heading, text.slice(marker.contentStart, end).trim());
  }
  return { markers, sections };
}

function section(body, heading) {
  const value = reservedSections(body).sections.get(heading);
  if (value === undefined) {
    throw new SubmissionFormatError(
      "submission-field-missing",
      `Submission is missing the "${heading}" field`,
      { heading },
    );
  }
  return value;
}

export function extractRepositoryUrl(issueBody) {
  const repository = section(issueBody, "Repository URL");
  const match = repository.match(
    /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/,
  );
  if (!match) {
    throw new SubmissionFormatError(
      "submission-repository-invalid",
      "Repository URL must be a public GitHub repository root URL",
    );
  }
  const parsed = parseGitHubRepository(match[0]);
  return `https://github.com/${parsed.owner}/${parsed.repository}`;
}

function checked(body, statement) {
  const escaped = statement.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^-\\s*\\[[xX]\\]\\s*${escaped}\\s*$`, "m").test(body);
}

function normalizeTag(tag) {
  return tag
    .trim()
    .replace(/^[-*+]\s+/, "")
    .replace(/^`(.+)`$/, "$1")
    .toLowerCase()
    .replace(/\s+/g, "-");
}

export function parseSubmissionBody(body) {
  const text = String(body || "");
  const repo = extractRepositoryUrl(text);
  const category = section(text, "Category");
  if (!allowedCategories.includes(category)) {
    throw new SubmissionFormatError(
      "submission-category-invalid",
      `Unsupported submission category "${category}"`,
    );
  }

  const submittedTags = section(text, "Tags")
    .split(/[,\n]/)
    .map(normalizeTag)
    .filter(Boolean);
  const uniqueSubmittedTags = [...new Set(submittedTags)];
  if (
    !uniqueSubmittedTags.length
    || uniqueSubmittedTags.length > maximumSubmissionTags
  ) {
    throw new SubmissionFormatError(
      "submission-tag-count-invalid",
      `Submissions require between one and ${maximumSubmissionTags} tags`,
    );
  }
  const unsupportedTags = [...new Set(
    uniqueSubmittedTags.filter((tag) => !allowedTags.includes(tag) && !tagAliases.has(tag)),
  )];
  if (unsupportedTags.length) {
    throw new SubmissionFormatError(
      "submission-tags-invalid",
      `Unsupported submission tags: ${unsupportedTags.join(", ")}. Choose from: ${allowedTags.join(", ")}`,
    );
  }
  const tags = [...new Set(
    uniqueSubmittedTags
      .map((tag) => tagAliases.has(tag) ? tagAliases.get(tag) : tag)
      .filter(Boolean),
  )];
  if (!tags.length) {
    throw new SubmissionFormatError(
      "submission-tag-count-invalid",
      `Submissions require between one and ${maximumSubmissionTags} tags`,
    );
  }

  return { repo, category, tags };
}

export function parseLegacySubmissionBody(body) {
  const text = String(body || "");
  const repo = extractRepositoryUrl(text);
  const category = section(text, "Category");
  if (!allowedCategories.includes(category)) {
    throw new SubmissionFormatError(
      "submission-category-invalid",
      `Unsupported submission category "${category}"`,
    );
  }

  const submittedTags = section(text, "Tags")
    .split(/[,\n]/)
    .map(normalizeTag)
    .filter(Boolean);
  const uniqueSubmittedTags = [...new Set(submittedTags)];
  if (!uniqueSubmittedTags.length || uniqueSubmittedTags.length > 5) {
    throw new SubmissionFormatError(
      "submission-tag-count-invalid",
      "Legacy submissions require between one and five tags",
    );
  }
  const unsupportedTags = uniqueSubmittedTags.filter(
    (tag) => !allowedTags.includes(tag) && !tagAliases.has(tag),
  );
  if (unsupportedTags.length) {
    throw new SubmissionFormatError(
      "submission-tags-invalid",
      `Unsupported legacy submission tags: ${unsupportedTags.join(", ")}`,
    );
  }
  const tags = [...new Set(
    uniqueSubmittedTags
      .map((tag) => tagAliases.has(tag) ? tagAliases.get(tag) : tag)
      .filter(Boolean),
  )].slice(0, maximumSubmissionTags);
  if (!tags.length) {
    throw new SubmissionFormatError(
      "submission-tags-invalid",
      "Legacy submission tags do not map to the current catalog vocabulary",
    );
  }

  return { repo, category, tags };
}

export function hasCheckedChecklistItem(body, statement) {
  try {
    return checked(section(body, "Submission checklist"), statement);
  } catch {
    return false;
  }
}

const legacyRightsStatement =
  "I have the right to distribute this plugin and its assets under the declared license.";

export function hasRightsConfirmation(issue) {
  return [rightsStatement, legacyRightsStatement].some((statement) =>
    hasCheckedChecklistItem(issue.body, statement)
  );
}

export function assertRightsConfirmation(issue) {
  if (!hasRightsConfirmation(issue) && !predatesRightsConfirmation(issue)) {
    throw new SubmissionFormatError(
      "submission-rights-unconfirmed",
      `The submitter has not confirmed: ${rightsStatement}`,
    );
  }
}

export function parseCurrentSubmission({ title, body }) {
  if (!/^\[Plugin\]:\s*\S/.test(String(title || ""))) {
    throw new SubmissionFormatError(
      "submission-title-invalid",
      `Submission title must begin with "${submissionTitlePrefix}" and include a plugin name`,
    );
  }

  const { markers } = reservedSections(body);
  const headings = markers.map((marker) => marker.heading);
  const hasCurrentFields = headings.length === submissionHeadings.length
    && headings.every((heading, index) => heading === submissionHeadings[index]);
  const hasLegacyFields = headings.length === legacySubmissionHeadings.length
    && headings.every((heading, index) => heading === legacySubmissionHeadings[index]);
  if (!hasCurrentFields && !hasLegacyFields) {
    throw new SubmissionFormatError(
      "submission-fields-invalid",
      `Submission fields must be: ${submissionHeadings.join(", ")}`,
    );
  }

  const submission = parseSubmissionBody(body);
  for (const statement of submissionChecklist) {
    if (!hasCheckedChecklistItem(body, statement)) {
      throw new SubmissionFormatError(
        "submission-checklist-unconfirmed",
        `Submission checklist item is not confirmed: ${statement}`,
        { statement },
      );
    }
  }

  return submission;
}

function issueCreatedAt(issue) {
  return Date.parse(issue.created_at || issue.createdAt || "");
}

export function predatesRightsConfirmation(issue) {
  const createdAt = issueCreatedAt(issue);
  return Number.isFinite(createdAt) && createdAt < rightsConfirmationIntroducedAt;
}

export function isLegacySubmission(issue) {
  const createdAt = issueCreatedAt(issue);
  return Number.isFinite(createdAt) && createdAt < currentSubmissionIntroducedAt;
}

export function parseIssueSubmission(issue) {
  const submission = isLegacySubmission(issue)
    ? parseLegacySubmissionBody(issue.body)
    : parseCurrentSubmission({ title: issue.title, body: issue.body });
  assertRightsConfirmation(issue);
  return submission;
}

export function classifySubmission({ title, body, hasSubmissionLabel = false }) {
  if (hasSubmissionLabel) return { shouldValidate: true, shouldLabel: false };
  try {
    parseCurrentSubmission({ title, body });
    return { shouldValidate: true, shouldLabel: true };
  } catch {
    const submissionCandidate = /^\[Plugin\]:/.test(String(title || ""));
    return { shouldValidate: submissionCandidate, shouldLabel: false };
  }
}
