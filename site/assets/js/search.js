export function fuzzyScore(query, candidate) {
  const needle = foldSearchTerm(query);
  const haystack = foldSearchTerm(candidate);
  const contiguous = haystack.indexOf(needle);
  if (contiguous >= 0) return contiguous;
  let previous = -1;
  let gaps = 0;
  for (const character of needle) {
    const position = haystack.indexOf(character, previous + 1);
    if (position < 0) return Number.POSITIVE_INFINITY;
    if (previous >= 0) gaps += position - previous - 1;
    previous = position;
  }
  return 100 + gaps;
}

export function rankSearchCompletions(matches) {
  const typeOrder = { plugin: 0, kind: 1, author: 2, tag: 3, fulltext: 4 };
  return [...matches].sort((a, b) => (
    Number(Boolean(b.fullPrefix)) - Number(Boolean(a.fullPrefix))
    || Number(Boolean(b.prefix)) - Number(Boolean(a.prefix))
    || (a.prefix && b.prefix
      ? (a.targetLength ?? a.label.length) - (b.targetLength ?? b.label.length)
      : 0)
    || (typeOrder[a.type] ?? 99) - (typeOrder[b.type] ?? 99)
    || a.score - b.score
    || b.count - a.count
    || a.label.localeCompare(b.label)
  ));
}

export function selectSearchCompletions(matches, limit = 3) {
  const ranked = rankSearchCompletions(matches);
  const fulltext = ranked.find((match) => match.type === "fulltext");
  const kindMatches = ranked.filter((match) => match.type === "kind").slice(0, 2);
  const rankedCatalogMatches = ranked.filter((match) => (
    match !== fulltext && match.type !== "kind"
  ));
  const selected = [];
  ["plugin", "author", "tag"].forEach((type) => {
    const prefixMatch = rankedCatalogMatches.find((match) => match.type === type && match.prefix);
    if (prefixMatch) selected.push(prefixMatch);
  });
  rankedCatalogMatches.forEach((match) => {
    if (selected.length < limit && !selected.includes(match)) selected.push(match);
  });
  return [
    ...kindMatches,
    ...(fulltext ? [fulltext] : []),
    ...rankSearchCompletions(selected).slice(0, limit),
  ];
}

let lastTokensValue = null;
let lastTokens = [];

export function searchTokens(value) {
  const text = String(value || "");
  if (text === lastTokensValue) return lastTokens;
  lastTokensValue = text;
  lastTokens = foldSearchTerm(text).split(/\s+/).filter(Boolean);
  return lastTokens;
}

export function currentSearchToken(value) {
  return String(value || "").match(/(?:^|\s)(\S*)$/)?.[1] || "";
}

const searchTermTypeList = ["text", "fulltext", "tag", "author", "plugin", "kind"];
const searchTermTypes = new Set(searchTermTypeList);
const searchStateTermTypes = new Map([
  ["q", "text"],
  ["text", "fulltext"],
  ["tag", "tag"],
  ["author", "author"],
  ["plugin", "plugin"],
  ["kind", "kind"],
]);
export const maximumSearchTerms = 24;
export const maximumSearchTermLength = 160;

const foldCacheLimit = 20000;
const foldCache = new Map();

function remember(cache, key, compute) {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const value = compute();
  if (cache.size >= foldCacheLimit) cache.clear();
  cache.set(key, value);
  return value;
}

export function normalizeSearchTerm(value) {
  return String(value || "").normalize("NFC").trim().replace(/\s+/g, " ");
}

export function foldSearchTerm(value) {
  const text = String(value || "");
  if (text.length < 32) return normalizeSearchTerm(text).toLowerCase();
  return remember(foldCache, text, () => normalizeSearchTerm(text).toLowerCase());
}

export function searchPhraseKey(value) {
  return foldSearchTerm(value)
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function pluginKindKey(value) {
  return searchPhraseKey(value).replace(/ /g, "-");
}

const compactCache = new Map();

export function compactSearchKey(value) {
  const text = String(value || "");
  if (text.length < 32) return foldSearchTerm(text).replace(/[^\p{L}\p{M}\p{N}]+/gu, "");
  return remember(compactCache, text, () => foldSearchTerm(text).replace(/[^\p{L}\p{M}\p{N}]+/gu, ""));
}

function matchesCompactSearch(token, searchText) {
  if (!/^[\p{L}\p{M}\p{N}]+(?:-[\p{L}\p{M}\p{N}]+)*$/u.test(token)) return false;
  const compactToken = compactSearchKey(token);
  return compactToken.length > 3 && compactSearchKey(searchText).includes(compactToken);
}

export function createSearchTerm(type, value) {
  const normalizedType = searchTermTypes.has(type) ? type : "text";
  let normalizedValue = normalizeSearchTerm(value);
  if (!normalizedValue || normalizedValue.length > maximumSearchTermLength) return null;
  if (normalizedType === "author") {
    normalizedValue = normalizedValue.replace(/^@/, "");
    if (!validGitHubLogin(normalizedValue)) return null;
  }
  if (normalizedType === "kind") normalizedValue = pluginKindKey(normalizedValue);
  if (normalizedType === "fulltext" && normalizedValue.includes("\"")) return null;
  if (!normalizedValue) return null;
  return { type: normalizedType, value: normalizedValue };
}

export function searchTermKey(term) {
  const normalized = createSearchTerm(term?.type, term?.value);
  return normalized ? `${normalized.type}:${foldSearchTerm(normalized.value)}` : "";
}

export function searchTermDisplayValue(term) {
  const normalized = createSearchTerm(term?.type, term?.value);
  if (!normalized) return "";
  return normalized.type === "author" ? `@${normalized.value}` : normalized.value;
}

export function searchTermInputValue(term) {
  const normalized = createSearchTerm(term?.type, term?.value);
  if (!normalized) return "";
  if (normalized.type === "text") return normalized.value;
  if (normalized.type === "fulltext") {
    return normalized.value.includes(" ")
      ? `text:"${normalized.value}"`
      : `text:${normalized.value}`;
  }
  if (normalized.type === "author") return `@${normalized.value}`;
  return `${normalized.type}:${normalized.value}`;
}

export function uniqueSearchTerms(values) {
  const seen = new Set();
  const terms = [];
  for (const value of values) {
    const term = typeof value === "string"
      ? createSearchTerm("text", value)
      : createSearchTerm(value?.type, value?.value);
    const key = searchTermKey(term);
    if (!term || !key || seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length === maximumSearchTerms) break;
  }
  return terms;
}

function validGitHubLogin(value) {
  return /^[a-z\d](?:[a-z\d]|-(?=[a-z\d]|$)){0,38}$/i.test(value);
}

export function hasFulltextSearchDraft(value) {
  return /(?:^|\s)text:/i.test(normalizeSearchTerm(value));
}

export function parseSearchDraft(value) {
  const draft = normalizeSearchTerm(value);
  if (!draft) return [];
  const parts = [...draft.matchAll(/(?:^|\s)(?:text:"([^"]*)"(?=$|\s)|(\S+))/gi)]
    .map((match) => match[1] !== undefined
      ? { type: "fulltext", value: match[1] }
      : { type: "token", value: match[2] });
  const isTypedBoundary = (part) => part.type === "fulltext"
    || /^(?:tag|author|text|plugin|kind):/i.test(part.value)
    || (part.value.startsWith("@") && validGitHubLogin(part.value.slice(1)));
  const terms = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part.type === "fulltext") {
      const fulltext = createSearchTerm("fulltext", part.value);
      if (fulltext) terms.push(fulltext);
      continue;
    }
    const token = part.value;
    const pluginExpression = token.match(/^plugin:(.*)$/i);
    if (pluginExpression) {
      const pluginValue = [pluginExpression[1]];
      while (parts[index + 1] && !isTypedBoundary(parts[index + 1])) {
        pluginValue.push(parts[index + 1].value);
        index += 1;
      }
      const plugin = createSearchTerm("plugin", pluginValue.join(" "));
      terms.push(plugin || createSearchTerm("text", token));
      continue;
    }
    if (/^text:$/i.test(token)) continue;
    const typed = token.match(/^(tag|author|text|kind):(.+)$/i);
    if (typed) {
      if (typed[1].toLowerCase() === "text" && typed[2].includes("\"")) {
        terms.push(createSearchTerm("text", token));
        continue;
      }
      const type = typed[1].toLowerCase() === "text" ? "fulltext" : typed[1].toLowerCase();
      terms.push(createSearchTerm(type, typed[2]) || createSearchTerm("text", token));
      continue;
    }
    if (token.startsWith("@") && validGitHubLogin(token.slice(1))) {
      terms.push(createSearchTerm("author", token));
      continue;
    }
    terms.push(createSearchTerm("text", token));
  }
  return terms.filter(Boolean);
}

export function appendSearchState(params, { terms, draft }) {
  uniqueSearchTerms(terms).forEach((term) => {
    const key = term.type === "text" ? "q" : term.type === "fulltext" ? "text" : term.type;
    params.append(key, term.value);
  });
  const normalizedDraft = normalizeSearchTerm(draft);
  if (normalizedDraft && normalizedDraft.length <= maximumSearchTermLength) {
    params.set("draft", normalizedDraft);
  }
  return params;
}

export function readSearchState(params) {
  const terms = [];
  const seen = new Set();
  let draft = "";
  for (const [key, value] of params.entries()) {
    if (key === "draft") {
      const candidate = normalizeSearchTerm(value);
      if (!draft && candidate.length <= maximumSearchTermLength) draft = candidate;
      continue;
    }
    const type = searchStateTermTypes.get(key);
    if (!type || terms.length >= maximumSearchTerms) continue;
    const term = key === "q" && value.startsWith("@") && validGitHubLogin(value.slice(1))
      ? createSearchTerm("author", value)
      : createSearchTerm(type, value);
    const termKey = searchTermKey(term);
    if (!term || !termKey || seen.has(termKey)) continue;
    seen.add(termKey);
    terms.push(term);
  }
  return { terms, draft };
}

export function removeSearchTermTypeFromDraft(value, type) {
  return parseSearchDraft(value)
    .filter((term) => term.type !== type)
    .map(searchTermInputValue)
    .join(" ");
}

const pluginIdHostSegments = new Set(["io", "com", "org", "net", "dev", "github", "gitlab", "codeberg"]);

export function repositoryPublisher(repo) {
  try {
    const url = new URL(repo);
    if (url.hostname.toLowerCase() !== "github.com") return "";
    return url.pathname.split("/").filter(Boolean)[0] || "";
  } catch {
    return "";
  }
}

export function localPluginId(pluginId) {
  return String(pluginId || "").split(".").at(-1) || "";
}

export function searchablePluginId(pluginId) {
  return String(pluginId || "")
    .split(".")
    .filter((segment) => !pluginIdHostSegments.has(segment.toLowerCase()))
    .join(".");
}

const contextCache = new WeakMap();

export function pluginSearchContext(plugin) {
  if (!plugin || typeof plugin !== "object") return buildPluginSearchContext(plugin);
  const cached = contextCache.get(plugin);
  if (cached) return cached;
  const context = buildPluginSearchContext(plugin);
  contextCache.set(plugin, context);
  return context;
}

function buildPluginSearchContext(plugin) {
  const publisher = repositoryPublisher(plugin?.repo);
  const tags = Array.isArray(plugin?.tags) ? plugin.tags : [];
  return {
    publisher,
    primaryText: [plugin?.name, localPluginId(plugin?.id), ...tags].join(" "),
    searchText: foldSearchTerm([
      plugin?.name,
      plugin?.description,
      plugin?.author,
      publisher,
      `@${publisher}`,
      searchablePluginId(plugin?.id),
      plugin?.category,
      plugin?.kind,
      ...tags,
    ].join(" ")),
    tags,
    pluginName: plugin?.name,
    pluginId: plugin?.id,
    pluginKind: plugin?.kind,
  };
}

export function matchesSearchSelection(context, { terms = [], draftTerms = [] } = {}) {
  const matchesTerms = terms.every((term) => (term.type === "text"
    ? matchesDirectSearch(term.value, context)
    : matchesCommittedSearchTerm(term, context)));
  const textDraft = draftTerms
    .filter((term) => term.type === "text")
    .map((term) => term.value)
    .join(" ");
  const matchesTextDraft = !textDraft || matchesDirectSearch(textDraft, context);
  const matchesTypedDraft = draftTerms
    .filter((term) => term.type !== "text")
    .every((term) => matchesDraftSearchTerm(term, context));
  return matchesTerms && matchesTextDraft && matchesTypedDraft;
}

export function matchesShortSearch(query, primaryText, searchText) {
  const normalized = foldSearchTerm(String(query || "").replace(/^@/, ""));
  if (!normalized) return true;
  const normalizedSearchText = foldSearchTerm(searchText);
  if (!/[\p{L}\p{M}\p{N}]/u.test(normalized)) {
    return normalizedSearchText.includes(normalized);
  }
  if (
    normalized.length >= 3
    && foldSearchTerm(primaryText).includes(normalized)
  ) {
    return true;
  }
  const wordPrefix = searchPhraseKey(normalized);
  if (!wordPrefix) return normalizedSearchText.includes(normalized);
  const words = normalizedSearchText.match(/[\p{L}\p{M}\p{N}]+/gu) || [];
  return words.some((word) => word.startsWith(wordPrefix));
}

export function matchesDirectSearch(value, {
  publisher = "",
  primaryText = "",
  searchText = "",
} = {}) {
  const tokens = searchTokens(value);
  return tokens.length === 0 || tokens.every((token) => {
    if (token.startsWith("@")) {
      const requestedPublisher = token.slice(1);
      return Boolean(requestedPublisher)
        && foldSearchTerm(publisher).startsWith(requestedPublisher);
    }
    const normalizedText = foldSearchTerm(searchText);
    if (token.length > 3) {
      return normalizedText.includes(token) || matchesCompactSearch(token, searchText);
    }
    return matchesShortSearch(token, primaryText, searchText);
  });
}

export function matchesCommittedSearchTerm(term, {
  publisher,
  primaryText,
  searchText,
  tags = [],
  pluginName,
  pluginId,
  pluginKind,
}) {
  const normalized = createSearchTerm(term?.type, term?.value);
  if (!normalized) return false;
  const requested = foldSearchTerm(normalized.value);
  if (normalized.type === "fulltext") {
    return matchesDirectSearch(normalized.value, { publisher, primaryText, searchText });
  }
  if (normalized.type === "author") return foldSearchTerm(publisher).startsWith(requested);
  if (normalized.type === "tag") {
    return tags.some((tag) => foldSearchTerm(tag) === requested);
  }
  if (normalized.type === "plugin") {
    return foldSearchTerm(pluginName) === requested || foldSearchTerm(pluginId) === requested;
  }
  if (normalized.type === "kind") return pluginKindKey(pluginKind) === requested;
  if (requested.length > 3 || requested.includes(" ")) {
    return foldSearchTerm(searchText).includes(requested);
  }
  return matchesShortSearch(requested, primaryText, searchText);
}

export function matchesDraftSearchTerm(term, {
  publisher,
  primaryText,
  searchText,
  tags = [],
  pluginName,
  pluginId,
  pluginKind,
}) {
  const normalized = createSearchTerm(term?.type, term?.value);
  if (!normalized || normalized.type === "text") return false;
  const requested = foldSearchTerm(normalized.value);
  if (normalized.type === "fulltext") {
    return matchesDirectSearch(normalized.value, { publisher, primaryText, searchText });
  }
  if (normalized.type === "author") return foldSearchTerm(publisher).startsWith(requested);
  if (normalized.type === "tag") {
    return tags.some((tag) => foldSearchTerm(tag).startsWith(requested));
  }
  if (normalized.type === "kind") return pluginKindKey(pluginKind) === requested;
  return foldSearchTerm(pluginName).startsWith(requested)
    || foldSearchTerm(pluginId).startsWith(requested);
}

export function completionTarget(suggestion) {
  if (!suggestion) return "";
  if (suggestion.type === "author") return `@${suggestion.value}`;
  return suggestion.insertValue || suggestion.label || suggestion.value;
}

function completionTargetForInput(value, suggestion) {
  const target = completionTarget(suggestion);
  const tokens = normalizeSearchTerm(value).split(" ").filter(Boolean);
  const pluginIndex = tokens.findLastIndex((token) => /^plugin:/i.test(token));
  if (suggestion?.type !== "plugin" || pluginIndex < 0) return target;
  const pluginDraft = tokens.slice(pluginIndex).join(" ");
  const pluginTarget = `plugin:${target}`;
  return foldSearchTerm(pluginTarget).startsWith(foldSearchTerm(pluginDraft))
    ? pluginTarget
    : target;
}

function completionReplacementStart(value, target, suggestion) {
  const tokens = normalizeSearchTerm(value).split(" ").filter(Boolean);
  const rawCandidates = [target, suggestion?.matchValue].filter(Boolean);
  const foldedCandidates = rawCandidates.map(foldSearchTerm);
  const phraseCandidates = rawCandidates.map(searchPhraseKey).filter(Boolean);
  for (let index = 0; index < tokens.length; index += 1) {
    const tokenSuffix = tokens.slice(index).join(" ");
    const foldedSuffix = foldSearchTerm(tokenSuffix);
    const phraseSuffix = searchPhraseKey(tokenSuffix);
    if (
      foldedCandidates.some((candidate) => candidate.startsWith(foldedSuffix))
      || (phraseSuffix && phraseCandidates.some((candidate) => candidate.startsWith(phraseSuffix)))
    ) return index;
  }
  return Math.max(0, tokens.length - 1);
}

export function applySearchCompletion(value, suggestion) {
  if (hasFulltextSearchDraft(value)) return normalizeSearchTerm(value);
  const target = completionTargetForInput(value, suggestion);
  if (suggestion?.type === "fulltext") return target;
  const tokens = normalizeSearchTerm(value).split(" ").filter(Boolean);
  const replacementStart = completionReplacementStart(value, target, suggestion);
  return [...tokens.slice(0, replacementStart), target].join(" ");
}

export function inlineSearchCompletionSuffix(suggestion, value) {
  if (!suggestion || !value) return "";
  const completed = applySearchCompletion(value, suggestion);
  const normalizedValue = normalizeSearchTerm(value);
  if (!foldSearchTerm(completed).startsWith(foldSearchTerm(normalizedValue))) return "";
  return completed.length > normalizedValue.length ? completed.slice(normalizedValue.length) : "";
}

export function committedTermsFromDraft(value, suggestion) {
  const draft = normalizeSearchTerm(value);
  if (!draft) return [];
  const parsed = parseSearchDraft(draft);
  if (!suggestion) {
    const allText = parsed.every((term) => term.type === "text");
    return parsed.length === 1 || !allText
      ? parsed
      : [createSearchTerm("text", draft)].filter(Boolean);
  }
  if (hasFulltextSearchDraft(draft)) return parsed;
  const selected = createSearchTerm(suggestion.type, suggestion.value);
  if (!selected) return [];
  if (selected.type === "fulltext") return [selected];
  const target = completionTargetForInput(draft, suggestion);
  if (foldSearchTerm(target).startsWith(foldSearchTerm(draft))) return [selected];
  const tokens = draft.split(" ");
  const replacementStart = completionReplacementStart(draft, target, suggestion);
  return [...parseSearchDraft(tokens.slice(0, replacementStart).join(" ")), selected];
}

export function handleSearchEscape(event, {
  hasSuggestions,
  closeSuggestions,
  clearSearch,
}) {
  if (event.key !== "Escape") return false;
  event.preventDefault();
  if (hasSuggestions) {
    closeSuggestions();
  } else {
    clearSearch();
  }
  return true;
}

export function searchKeyAction({
  key,
  completionCount,
  activeSuggestion,
  caretAtEnd,
  hasInlineCompletion,
}) {
  if (completionCount > 0 && key === "ArrowDown") return "next-completion";
  if (completionCount > 0 && key === "ArrowUp") return "previous-completion";
  if (key === "Enter") {
    return activeSuggestion >= 0 ? "accept-active-completion" : "submit-query";
  }
  if (
    completionCount > 0
    && key === "ArrowRight"
    && caretAtEnd
    && hasInlineCompletion
  ) {
    return "accept-inline-completion";
  }
  return "none";
}
