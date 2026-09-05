import {
  activityTime,
  accentColor,
  appendCatalogViewState,
  catalogViewControls,
  comparePluginEngagement,
  copyText,
  displayTaxonomyTag,
  engagementSummary,
  escapeHtml,
  formatStars,
  hidePendingEngagement,
  isRecentlyAdded,
  isRecentlyUpdated,
  listingTime,
  loadCatalog,
  matchesVerificationStatus,
  paginationState,
  pluginHeartButton,
  pluginVerificationState,
  publisherLogin,
  readCatalogViewState,
  setupControlTooltips,
  setupCopyButtons,
  setupThemeToggle,
  showToast,
  updateEngagementSummary,
  updatePluginHeart
} from "./shared.js?v=20260831-01";
import {
  engagementApiBaseUrl,
  hasPluginHeart,
  loadEngagementStats,
  recordPluginCopy,
  recordPluginHeart,
} from "./engagement.js?v=20260831-01";
import {
  appendSearchState,
  committedTermsFromDraft,
  completionTarget,
  createSearchTerm,
  currentSearchToken,
  foldSearchTerm,
  fuzzyScore,
  handleSearchEscape,
  hasFulltextSearchDraft,
  inlineSearchCompletionSuffix,
  matchesCommittedSearchTerm,
  matchesDirectSearch,
  matchesDraftSearchTerm,
  maximumSearchTerms,
  pluginKindKey,
  normalizeSearchTerm,
  parseSearchDraft,
  readSearchState,
  removeSearchTermTypeFromDraft,
  searchKeyAction,
  searchPhraseKey,
  searchTermDisplayValue,
  searchTermInputValue,
  searchTermKey,
  selectSearchCompletions,
} from "./search.js?v=20260831-01";
import { catalogCategoryTotals, matchesKidsTaxonomy } from "./taxonomy.js?v=20260831-01";

const pluginsPerPage = 9;
const hiddenCardTags = new Set([
  "bar",
  "bar-widget",
  "hyprland",
  "menu",
  "overlay",
  "panel",
  "quickshell",
  "service",
]);
const cardCategoryNames = new Map([
  ["Bar widgets", "Bars"],
  ["Bars", "Bars"],
  ["Developer Tools", "Dev"],
  ["Productivity", "Product"],
]);
function taxonomyKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/s$/, "");
}

function cardTaxonomyLabels(plugin) {
  const category = String(plugin.category || "").trim();
  const categoryKey = taxonomyKey(category);
  const specific = [];

  for (const tag of plugin.tags || []) {
    if (hiddenCardTags.has(tag)) continue;
    const label = displayTaxonomyTag(tag);
    const labelKey = taxonomyKey(label);
    if (labelKey === categoryKey || specific.some((value) => taxonomyKey(value) === labelKey)) continue;
    specific.push(label);
  }

  const displayCategory = category === "Widgets"
    ? ""
    : cardCategoryNames.get(category) || category;
  const labels = [displayCategory, ...specific].filter(Boolean).slice(0, 2);
  return labels.length ? labels : [category || "System"];
}

const engagementSorts = new Set(["views", "copies", "hearts"]);
const verificationFilters = new Set(["verified", "unverified"]);
const taxonomyFilterTags = ["ai", "games", "security"];
const sortOptions = {
  community: [
    ["added", "Recently added"],
    ["updated", "Recent activity"],
    ["stars", "Most starred"],
    ["views", "Most viewed"],
    ["copies", "Most copied"],
    ["hearts", "Most hearts"],
    ["name", "A–Z"],
    ["verified", "Verified"],
    ["unverified", "Unverified"]
  ],
  builtin: [
    ["name", "A–Z"],
    ["kind", "Plugin type"],
    ["views", "Most viewed"],
    ["copies", "Most copied"],
    ["hearts", "Most hearts"],
    ["verified", "Verified"],
    ["unverified", "Unverified"]
  ]
};

const state = {
  plugins: [],
  terms: [],
  query: "",
  source: "community",
  category: "all",
  sort: "added",
  page: 1,
  showAll: false,
  engagement: {},
  engagementAuthoritative: {},
  engagementEnabled: false,
  engagementLoaded: false
};

const grid = document.querySelector("#plugin-grid");
const catalogTitle = document.querySelector("#catalog-title");
const count = document.querySelector("#plugin-count");
const countLabel = document.querySelector("#plugin-count-label");
const empty = document.querySelector("#empty-state");
const sourcesRoot = document.querySelector("#source-filters");
const categoriesRoot = document.querySelector("#category-filters");
const search = document.querySelector("#search-input");
const searchTerms = document.querySelector("#search-terms");
const searchClear = document.querySelector("#search-clear");
const searchShortcut = document.querySelector("#search-shortcut");
const searchFishPreview = document.querySelector("#search-fish-preview");
const searchSuggestions = document.querySelector("#search-suggestions");
const searchSuggestionStatus = document.querySelector("#search-suggestion-status");
const sort = document.querySelector("#sort-select");
const pagination = document.querySelector("#catalog-pagination");
const previousPage = document.querySelector("#page-previous");
const nextPage = document.querySelector("#page-next");
const previousPageLabel = document.querySelector("#page-previous-label");
const nextPageLabel = document.querySelector("#page-next-label");
const pageSummary = document.querySelector("#page-summary");
const viewToggle = document.querySelector("#catalog-view-toggle");
const viewButton = document.querySelector("#catalog-view-button");
const viewLabel = document.querySelector("#catalog-view-label");
const viewDock = document.querySelector("#catalog-view-dock");
const viewDockButton = document.querySelector("#catalog-view-dock-button");
const viewDockStatus = document.querySelector("#catalog-view-dock-status");
const catalogResultStatus = document.querySelector("#catalog-result-status");
let viewScrollFrame = 0;
let searchCompletions = [];
let activeSuggestion = -1;
let searchBlurTimer = 0;

function sourcePlugins() {
  return state.plugins.filter((plugin) => (plugin.sourceType || "community") === state.source);
}

function pluginSearchText(plugin) {
  const publisher = publisherLogin(plugin);
  return foldSearchTerm([
    plugin.name,
    plugin.description,
    plugin.author,
    publisher,
    `@${publisher}`,
    plugin.id,
    plugin.category,
    plugin.kind,
    ...(plugin.tags || [])
  ].join(" "));
}

function pluginSearchContext(plugin) {
  return {
    publisher: publisherLogin(plugin),
    primaryText: [plugin.name, plugin.id, ...(plugin.tags || [])].join(" "),
    searchText: pluginSearchText(plugin),
  };
}

function pluginMatchesActiveSearch(plugin) {
  const { publisher, primaryText, searchText } = pluginSearchContext(plugin);
  const hasTerms = state.terms.length > 0;
  const draftTerms = parseSearchDraft(state.query);
  if (!hasTerms && !draftTerms.length) return true;
  const matchContext = {
    publisher,
    primaryText,
    searchText,
    tags: plugin.tags || [],
    pluginName: plugin.name,
    pluginId: plugin.id,
    pluginKind: plugin.kind,
  };
  const matchesTerm = state.terms.some((term) => term.type === "text"
    ? matchesDirectSearch(term.value, matchContext)
    : matchesCommittedSearchTerm(term, matchContext));
  const textDraftTerms = draftTerms.filter((term) => term.type === "text");
  const typedDraftTerms = draftTerms.filter((term) => term.type !== "text");
  const textDraft = textDraftTerms.map((term) => term.value).join(" ");
  const matchesTextDraft = Boolean(textDraft)
    && matchesDirectSearch(textDraft, matchContext);
  const matchesTypedDraft = typedDraftTerms.some((term) =>
    matchesDraftSearchTerm(term, matchContext)
  );
  return matchesTerm || matchesTextDraft || matchesTypedDraft;
}

function completionMatches(value) {
  if (hasFulltextSearchDraft(value)) return [];
  const rawQuery = currentSearchToken(value);
  const query = foldSearchTerm(rawQuery.replace(/^@/, ""));
  if (!query) return [];
  const inputTokens = normalizeSearchTerm(value).split(" ");
  const pluginQueries = inputTokens.map((_, index) =>
    foldSearchTerm(inputTokens.slice(index).join(" "))
  );
  const plugins = searchScopePlugins();
  const normalizedValue = normalizeSearchTerm(value);
  const parsedDraft = parseSearchDraft(normalizedValue);
  const fulltextTerm = parsedDraft.length
    && parsedDraft.every((term) => term.type === "text")
    && !/(?:^|\s)(?:tag|author|plugin|kind):/i.test(normalizedValue)
    ? createSearchTerm("fulltext", normalizedValue)
    : null;
  const hasDirectPluginMatch = plugins.some((plugin) =>
    matchesDirectSearch(rawQuery, pluginSearchContext(plugin))
  );
  const matches = new Map();
  const addMatch = ({
    type,
    value: completionValue,
    label,
    insertValue,
    matchValue = "",
    detail = "",
    count = 1,
  }) => {
    if (rawQuery.startsWith("@") && type !== "author") return;
    const candidates = type === "author"
      ? [completionValue.replace(/^@/, "")]
      : [label, matchValue].filter(Boolean);
    const completionQueries = ["plugin", "kind"].includes(type) ? pluginQueries : [query];
    const score = Math.min(...completionQueries.flatMap((candidateQuery) =>
      candidates.map((candidate) => fuzzyScore(candidateQuery, candidate))
    ));
    if (!Number.isFinite(score) || (score >= 100 && hasDirectPluginMatch)) return;
    const key = `${type}:${foldSearchTerm(completionValue)}`;
    const suggestion = {
      type, value: completionValue, label, insertValue, matchValue, detail,
    };
    const target = completionTarget(suggestion);
    const rawTargets = [target, matchValue].filter(Boolean);
    const targets = rawTargets.map(foldSearchTerm);
    const targetKeys = rawTargets.map(searchPhraseKey).filter(Boolean);
    const prefix = completionQueries.some((candidateQuery) => {
      const candidateKey = searchPhraseKey(candidateQuery);
      return targets.some((candidate) => candidate.startsWith(candidateQuery))
        || (candidateKey && targetKeys.some((candidate) => candidate.startsWith(candidateKey)));
    });
    const normalizedInput = foldSearchTerm(value);
    const normalizedInputKey = searchPhraseKey(value);
    const fullPrefix = targets.some((candidate) => candidate.startsWith(normalizedInput))
      || (normalizedInputKey
        && targetKeys.some((candidate) => candidate.startsWith(normalizedInputKey)));
    const targetLength = Math.min(...targets.map((candidate) => candidate.length));
    const current = matches.get(key);
    if (current) {
      current.count += count;
      current.prefix ||= prefix;
      current.fullPrefix ||= fullPrefix;
    } else {
      matches.set(key, {
        ...suggestion, count, score, prefix, fullPrefix, targetLength,
      });
    }
  };

  const kinds = new Map();
  plugins.forEach((plugin) => {
    const key = pluginKindKey(plugin.kind);
    if (!key) return;
    const current = kinds.get(key);
    if (current) {
      current.count += 1;
      current.ambiguous ||= current.label !== plugin.kind;
    } else {
      kinds.set(key, { label: plugin.kind, count: 1, ambiguous: false });
    }
  });
  kinds.forEach(({ label, count: kindCount, ambiguous }, key) => {
    if (ambiguous) return;
    addMatch({
      type: "kind",
      value: key,
      label: `kind:${key}`,
      insertValue: `kind:${key}`,
      matchValue: label,
      detail: label,
      count: kindCount,
    });
  });
  if (fulltextTerm) {
    addMatch({
      type: "fulltext",
      value: fulltextTerm.value,
      label: fulltextTerm.value,
      insertValue: searchTermInputValue(fulltextTerm),
      detail: "broad search",
      count: plugins.filter((plugin) =>
        matchesDirectSearch(fulltextTerm.value, pluginSearchContext(plugin))
      ).length,
    });
  }
  plugins.forEach((plugin) => {
    const login = publisherLogin(plugin);
    if (login && state.source === "community") {
      addMatch({ type: "author", value: login, label: `@${login}` });
    }
    addMatch({
      type: "plugin",
      value: plugin.id,
      label: plugin.name,
      insertValue: plugin.name,
      detail: login ? `@${login}` : plugin.id,
    });
    (plugin.tags || []).forEach((tag) => {
      addMatch({ type: "tag", value: tag, label: tag });
    });
  });
  return selectSearchCompletions(matches.values());
}

function closeSearchSuggestions() {
  if (searchBlurTimer) window.clearTimeout(searchBlurTimer);
  searchBlurTimer = 0;
  searchCompletions = [];
  activeSuggestion = -1;
  searchSuggestions.hidden = true;
  search.setAttribute("aria-expanded", "false");
  search.removeAttribute("aria-activedescendant");
  searchSuggestionStatus.textContent = "";
  searchFishPreview.hidden = true;
}

function searchCaretAtEnd() {
  return search.selectionStart === search.value.length
    && search.selectionEnd === search.value.length;
}

function inlineSuggestionIndex() {
  if (activeSuggestion >= 0) {
    return inlineSearchCompletionSuffix(searchCompletions[activeSuggestion], search.value)
      ? activeSuggestion
      : -1;
  }
  return searchCompletions.findIndex((suggestion) =>
    inlineSearchCompletionSuffix(suggestion, search.value)
  );
}

function updateFishPreview() {
  const suggestionIndex = inlineSuggestionIndex();
  const completion = inlineSearchCompletionSuffix(
    searchCompletions[suggestionIndex],
    search.value,
  );
  if (!completion || !searchCaretAtEnd()) {
    searchFishPreview.hidden = true;
    return;
  }
  searchFishPreview.firstElementChild.textContent = search.value;
  searchFishPreview.lastElementChild.textContent = completion;
  searchFishPreview.hidden = false;
}

function setActiveSuggestion(index) {
  if (!searchCompletions.length) return;
  activeSuggestion = (index + searchCompletions.length) % searchCompletions.length;
  searchSuggestions.querySelectorAll("[data-search-completion]").forEach((option, optionIndex) => {
    const active = optionIndex === activeSuggestion;
    option.classList.toggle("active", active);
    option.setAttribute("aria-selected", String(active));
  });
  const activeOption = searchSuggestions.querySelectorAll("[data-search-completion]")[activeSuggestion];
  if (activeOption) search.setAttribute("aria-activedescendant", activeOption.id);
  updateFishPreview();
}

const searchTermTypeLabels = {
  text: "",
  fulltext: "TEXT",
  tag: "TAG",
  author: "AUTHOR",
  plugin: "PLUGIN",
  kind: "KIND",
};

function searchTermPresentation(term) {
  const normalized = createSearchTerm(term?.type, term?.value);
  if (!normalized) return null;
  const plugin = normalized.type === "plugin"
    ? state.plugins.find((item) => item.id === normalized.value)
    : null;
  const kind = normalized.type === "kind"
    ? state.plugins.find((item) => pluginKindKey(item.kind) === normalized.value)?.kind
    : null;
  const value = plugin?.name || kind || searchTermDisplayValue(normalized);
  return {
    term: normalized,
    value,
    typeLabel: searchTermTypeLabels[normalized.type],
  };
}

function updateSearchAffordances() {
  const active = state.terms.length > 0 || Boolean(state.query.trim());
  searchClear.hidden = !active;
  searchShortcut.hidden = active;
  search.placeholder = state.terms.length
    ? "Add search term…"
    : "Search plugins, tag:panel, text:bar, or @author…";
}

function removeSearchTerm(index) {
  const [removed] = state.terms.splice(index, 1);
  const presentation = searchTermPresentation(removed);
  if (!presentation) return;
  state.page = 1;
  closeSearchSuggestions();
  renderSearchTerms();
  render();
  search.focus();
  searchSuggestionStatus.textContent = searchResultMessage(
    `Removed ${presentation.term.type} search term ${presentation.value}`,
  );
}

function renderSearchTerms() {
  searchTerms.innerHTML = state.terms.map((term, index) => {
    const presentation = searchTermPresentation(term);
    if (!presentation) return "";
    const typeName = presentation.typeLabel
      ? `${presentation.term.type} search term`
      : "search term";
    return `
      <button class="search-term" type="button" data-search-term="${index}"
        data-search-term-type="${presentation.term.type}"
        aria-label="Remove ${typeName} ${escapeHtml(presentation.value)}">
        ${presentation.typeLabel
          ? `<span class="search-term-type">${presentation.typeLabel}</span>`
          : ""}
        <span class="search-term-value">${escapeHtml(presentation.value)}</span>
        <span class="search-term-remove" aria-hidden="true">×</span>
      </button>`;
  }).join("");
  searchTerms.querySelectorAll("[data-search-term]").forEach((button) => {
    button.addEventListener("click", () => removeSearchTerm(Number(button.dataset.searchTerm)));
  });
  updateSearchAffordances();
}

function commitSearchDraft(completion) {
  const draftedTerms = committedTermsFromDraft(search.value, completion);
  if (!draftedTerms.length) return false;
  const existing = new Set(state.terms.map(searchTermKey));
  const pending = [];
  draftedTerms.forEach((draftedTerm) => {
    const term = createSearchTerm(draftedTerm?.type, draftedTerm?.value);
    const key = searchTermKey(term);
    if (!term || !key || existing.has(key)) return;
    existing.add(key);
    pending.push(term);
  });
  if (state.terms.length + pending.length > maximumSearchTerms) {
    closeSearchSuggestions();
    searchSuggestionStatus.textContent = `A maximum of ${maximumSearchTerms} search terms is allowed`;
    return false;
  }
  state.terms.push(...pending);
  const added = pending.map((term) => searchTermPresentation(term)?.value || term.value);
  state.query = "";
  search.value = "";
  state.page = 1;
  closeSearchSuggestions();
  renderSearchTerms();
  render();
  searchSuggestionStatus.textContent = searchResultMessage(added.length
    ? `Added search term${added.length === 1 ? "" : "s"} ${added.join(", ")}`
    : "Those search terms are already active");
  return true;
}

function clearSearchTerms({ focus = true } = {}) {
  state.terms = [];
  state.query = "";
  search.value = "";
  state.page = 1;
  closeSearchSuggestions();
  renderSearchTerms();
  render();
  if (focus) search.focus();
  searchSuggestionStatus.textContent = searchResultMessage("Cleared all search terms");
}

function updateSearchSuggestions() {
  const rawQuery = search.value.trim();
  const token = currentSearchToken(search.value);
  if (!token.replace(/^@/, "")) {
    closeSearchSuggestions();
    return;
  }
  searchCompletions = completionMatches(search.value);
  activeSuggestion = -1;
  search.removeAttribute("aria-activedescendant");
  const resultCount = filteredPlugins().length;
  const summaryAction = state.terms.length ? "Add" : "Search for";
  searchSuggestions.innerHTML = `
    <div class="search-query-summary" role="presentation" aria-hidden="true">
      <span>${summaryAction} “${escapeHtml(rawQuery)}”</span>
      <small>${resultCount} result${resultCount === 1 ? "" : "s"} · Enter</small>
    </div>
    ${searchCompletions.map((completion, index) => `
      <button id="search-completion-${index}" class="search-suggestion" type="button" role="option"
        tabindex="-1" aria-selected="false" data-search-completion="${index}">
        <span>${escapeHtml(completion.label)}</span>
        <small>${completion.type === "fulltext" ? "text" : completion.type}${completion.detail ? ` · ${escapeHtml(completion.detail)}` : ""}${completion.count > 1 ? ` · ${completion.count}` : ""}</small>
      </button>`).join("")}`;
  searchSuggestions.hidden = false;
  search.setAttribute("aria-expanded", "true");
  const resultMessage = `${resultCount} search result${resultCount === 1 ? "" : "s"} with ${rawQuery}`;
  const inlineIndex = inlineSuggestionIndex();
  const inlineMessage = inlineIndex >= 0
    ? `. Press Right Arrow to add ${completionTarget(searchCompletions[inlineIndex])}`
    : "";
  searchSuggestionStatus.textContent = searchCompletions.length
    ? `${resultMessage}. ${searchCompletions.length} optional suggestion${searchCompletions.length === 1 ? "" : "s"} available${inlineMessage}`
    : resultMessage;
  searchSuggestions.querySelectorAll("[data-search-completion]").forEach((button) => {
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => {
      commitSearchDraft(searchCompletions[Number(button.dataset.searchCompletion)]);
    });
  });
  updateFishPreview();
}

function sourceDefaultSort(source = state.source) {
  return source === "builtin" ? "name" : "added";
}

function availableSortOptions(source = state.source) {
  return sortOptions[source].filter(([value]) => (
    state.engagementEnabled || !engagementSorts.has(value)
  ));
}

function allCategoryLabel() {
  return state.source === "builtin" ? "All built-ins" : "All plugins";
}

function matchesCatalogFilter(plugin, filter = state.category) {
  if (filter === "all") return true;
  if (filter === "Kids") return matchesKidsTaxonomy(plugin);
  if (filter.startsWith("tag:")) return (plugin.tags || []).includes(filter.slice(4));
  return plugin.category === filter;
}

function catalogFilterLabel(filter) {
  if (filter.startsWith("tag:")) return displayTaxonomyTag(filter.slice(4));
  return filter;
}

function searchScopePlugins() {
  return sourcePlugins().filter((plugin) => (
    matchesCatalogFilter(plugin)
    && (!verificationFilters.has(state.sort) || matchesVerificationStatus(plugin, state.sort))
  ));
}

function filteredPlugins() {
  const result = searchScopePlugins().filter((plugin) => pluginMatchesActiveSearch(plugin));

  const sorters = {
    added: (a, b) => listingTime(b) - listingTime(a) || a.name.localeCompare(b.name),
    updated: (a, b) => activityTime(b) - activityTime(a) || a.name.localeCompare(b.name),
    stars: (a, b) => (b.stars || 0) - (a.stars || 0) || a.name.localeCompare(b.name),
    views: (a, b) => comparePluginEngagement(a, b, state.engagement, "views"),
    copies: (a, b) => comparePluginEngagement(a, b, state.engagement, "copies"),
    hearts: (a, b) => comparePluginEngagement(a, b, state.engagement, "hearts"),
    name: (a, b) => a.name.localeCompare(b.name),
    kind: (a, b) => (a.kind || "").localeCompare(b.kind || "") || a.name.localeCompare(b.name)
  };

  return result.sort(sorters[state.sort] || sorters[sourceDefaultSort()]);
}

function pluginEngagement(plugin) {
  if (!state.engagementEnabled) return "";
  return engagementSummary(plugin, state.engagement[plugin.id], {
    pending: !state.engagementLoaded,
  });
}

function pluginCardFocusToken(element = document.activeElement) {
  const card = element?.closest?.("[data-card-plugin]");
  if (!card || !grid.contains(card)) return null;
  let control = "details";
  if (element.matches?.("[data-plugin-heart]")) control = "heart";
  else if (element.matches?.("[data-verification-tooltip]")) control = "verification";
  else if (element.matches?.("[data-copy-command]")) control = "copy";
  else if (element.matches?.(".plugin-author button")) control = "author";
  else if (element.matches?.(".builtin-source-action")) control = "source";
  return { pluginId: card.dataset.cardPlugin, control };
}

function restorePluginCardFocus(token) {
  if (!token) return false;
  const card = [...grid.querySelectorAll("[data-card-plugin]")]
    .find((candidate) => candidate.dataset.cardPlugin === token.pluginId);
  if (!card) return false;
  const selectors = {
    author: ".plugin-author button",
    copy: "[data-copy-command]",
    details: ".plugin-card-link",
    heart: "[data-plugin-heart]",
    source: ".builtin-source-action",
    verification: "[data-verification-tooltip]",
  };
  const target = card.querySelector(selectors[token.control]) || card.querySelector(".plugin-card-link");
  target?.focus({ preventScroll: true });
  return Boolean(target);
}

function applyAuthoritativeEngagement(pluginId, result, {
  focusToken = null,
  sortMetric = "",
} = {}) {
  if (!result?.recorded || !result.stats) return;
  const current = state.engagementAuthoritative[pluginId]
    || state.engagement[pluginId]
    || { views: 0, copies: 0, hearts: 0 };
  const next = {
    views: Math.max(current.views, result.stats.views),
    copies: Math.max(current.copies, result.stats.copies),
    hearts: Math.max(current.hearts, result.stats.hearts),
  };
  state.engagementAuthoritative[pluginId] = next;
  state.engagement[pluginId] = next;
  updateEngagementSummary(document, pluginId, next);
  updatePluginHeart(document, pluginId, next, {
    hearted: hasPluginHeart(pluginId),
  });
  if (state.sort === sortMetric) {
    render();
    if (!restorePluginCardFocus(focusToken) && focusToken) focusCatalogResult();
  }
}

async function heartPlugin(button) {
  if (button.getAttribute("aria-disabled") === "true" || button.dataset.heartSubmitting === "true") return;
  const focusToken = pluginCardFocusToken(button);
  button.dataset.heartSubmitting = "true";
  button.setAttribute("aria-busy", "true");
  const pluginId = button.dataset.pluginHeart;
  const result = await recordPluginHeart(pluginId);
  delete button.dataset.heartSubmitting;
  button.removeAttribute("aria-busy");
  if (!result?.recorded) {
    showToast("Heart could not be sent. Try again.");
    return;
  }
  applyAuthoritativeEngagement(pluginId, result, {
    focusToken,
    sortMetric: "hearts",
  });
  updatePluginHeart(document, pluginId, result.stats, {
    animate: true,
    hearted: true,
  });
  showToast("Heart sent.");
}

async function copyPluginCommand(button) {
  const focusToken = pluginCardFocusToken(button);
  if (!await copyText(button.dataset.copyCommand, button)) return;
  const pluginId = button.dataset.pluginId;
  applyAuthoritativeEngagement(
    pluginId,
    await recordPluginCopy(pluginId),
    { focusToken, sortMetric: "copies" },
  );
}

function verificationBadge(plugin) {
  const verification = pluginVerificationState(plugin);
  if (!verification) return "";
  return `<span class="card-verification is-${verification.status}">
    <button class="card-verification-trigger" type="button" data-verification-tooltip aria-expanded="false" aria-label="${escapeHtml(`${verification.label}. ${verification.explanation}`)}">
      <span class="card-verification-marker">${escapeHtml(verification.label)}</span>
    </button>
    <span class="card-verification-tooltip" role="tooltip" aria-hidden="true">${escapeHtml(verification.explanation)}</span>
  </span>`;
}

function closeVerificationTooltips(except = null) {
  document.querySelectorAll("[data-verification-tooltip]").forEach((button) => {
    if (button === except) return;
    button.setAttribute("aria-expanded", "false");
    const container = button.closest(".card-verification");
    container?.classList.remove("is-open");
    container?.classList.add("is-dismissed");
  });
}

function pluginCard(plugin, { showNew = false } = {}) {
  const tags = cardTaxonomyLabels(plugin)
    .map((label) => `<span class="tag">${escapeHtml(label)}</span>`)
    .join("");
  const badge = plugin.builtIn
    ? '<span class="builtin-badge">Built-in</span>'
    : plugin.placeholder
      ? '<span class="status-badge">Coming soon</span>'
      : "";
  const activityState = showNew && isRecentlyUpdated(plugin)
    ? '<span class="card-activity-state is-updated">Updated</span>'
    : showNew && isRecentlyAdded(plugin)
      ? '<span class="card-activity-state is-new">New</span>'
      : "";
  const verificationState = verificationBadge(plugin);
  const cardStates = activityState || verificationState
    ? `<div class="card-status-line">${activityState}${verificationState}</div>`
    : "";
  const installAction = plugin.builtIn
    ? `<a class="card-install builtin-source-action" href="${escapeHtml(plugin.sourceUrl || plugin.repo)}" target="_blank" rel="noreferrer" aria-label="View source for ${escapeHtml(plugin.name)}">View source ↗</a>`
    : plugin.placeholder
      ? '<span class="card-install unavailable" aria-label="Installation not yet available"><span class="command-glyph" aria-hidden="true"></span> Preview only</span>'
      : !plugin.installAvailable
        ? `<span class="card-install unavailable" aria-label="Automatic installation unavailable"><span class="command-glyph" aria-hidden="true"></span> ${plugin.upstreamCheckStatus === "failed" ? "Unavailable" : "Manual"}</span>`
        : `<button class="card-install has-control-tooltip" type="button" data-copy-command="${escapeHtml(plugin.installCommand)}" data-plugin-id="${escapeHtml(plugin.id)}" aria-label="Copy install command for ${escapeHtml(plugin.name)}">
          <span class="command-glyph" aria-hidden="true"></span><span data-copy-label>Copy install</span>
          <span class="copy-icon" aria-hidden="true"></span>
          <span class="control-tooltip" role="tooltip" aria-hidden="true">Copy install command</span>
        </button>`;
  const previewSource = plugin.previewThumbnail || plugin.previewImage;
  const preview = previewSource
    ? `<div class="plugin-preview image-preview"><img src="${escapeHtml(previewSource)}" alt="" width="${Number(plugin.previewThumbnailWidth || plugin.previewWidth) || 720}" height="${Number(plugin.previewThumbnailHeight || plugin.previewHeight) || 405}" loading="lazy"></div>`
    : `<div class="plugin-preview" aria-hidden="true">
        <span class="plugin-preview-mark">${escapeHtml(plugin.initials)}</span>
      </div>`;
  const stars = plugin.builtIn ? "" : `<span class="card-stars has-control-tooltip" aria-label="${formatStars(plugin.stars)} repository stars"><svg class="social-glyph star-glyph" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 .5 8.9 4.6l4.6.6-3.35 3.15L11 13 7 10.75 3 13l.85-4.65L.5 5.2l4.6-.6Z"/></svg><span class="social-count" aria-hidden="true">${formatStars(plugin.stars)}</span><span class="control-tooltip" role="tooltip" aria-hidden="true">Repository stars</span></span>`;
  const hearted = hasPluginHeart(plugin.id);
  const heart = state.engagementEnabled
    ? pluginHeartButton(plugin, state.engagement[plugin.id], {
        hearted,
        pending: !state.engagementLoaded,
      })
    : "";
  const social = stars || heart ? `<div class="card-social">${stars}${heart}</div>` : "";
  const publisher = publisherLogin(plugin);
  const authorLine = publisher && !plugin.builtIn
    ? `<span class="plugin-author">by <button type="button" data-author="${escapeHtml(publisher)}" aria-label="Show all plugins by @${escapeHtml(publisher)}">@${escapeHtml(publisher)}</button> · ${escapeHtml(plugin.kind || plugin.category)}</span>`
    : `<span class="plugin-author">by ${escapeHtml(plugin.author)} · ${escapeHtml(plugin.kind || plugin.category)}</span>`;

  return `
    <article class="plugin-card${plugin.builtIn ? " built-in-card" : ""}" data-card-plugin="${escapeHtml(plugin.id)}" style="--card-accent:${accentColor(plugin.accent)}">
      <a class="plugin-card-link" href="plugin.html?id=${encodeURIComponent(plugin.id)}" aria-label="View ${escapeHtml(plugin.name)}"></a>
      ${preview}
      <div class="plugin-card-body">
        <div class="plugin-card-content">
          <div class="plugin-title-line">
            <h3>${escapeHtml(plugin.name)}</h3>
            ${badge}
            ${social}
          </div>
          ${authorLine}
          <p class="plugin-description">${escapeHtml(plugin.description)}</p>
        </div>
        ${cardStates}
        <div class="plugin-card-bottom">
          <div class="plugin-tags">${tags}</div>
          <div class="plugin-card-actions">
            ${pluginEngagement(plugin)}
            ${installAction}
          </div>
        </div>
      </div>
    </article>`;
}

function bindCardActions(root) {
  setupControlTooltips(root);
  root.querySelectorAll("[data-verification-tooltip]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const expanded = button.getAttribute("aria-expanded") !== "true";
      closeVerificationTooltips(button);
      button.setAttribute("aria-expanded", String(expanded));
      const container = button.closest(".card-verification");
      container?.classList.toggle("is-open", expanded);
      container?.classList.toggle("is-dismissed", !expanded);
    });
    button.addEventListener("focus", () => {
      button.closest(".card-verification")?.classList.remove("is-dismissed");
    });
    button.addEventListener("pointerenter", () => {
      button.closest(".card-verification")?.classList.remove("is-dismissed");
    });
    button.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      button.setAttribute("aria-expanded", "false");
      const container = button.closest(".card-verification");
      container?.classList.remove("is-open");
      container?.classList.add("is-dismissed");
      event.stopPropagation();
    });
  });
  root.querySelectorAll("[data-plugin-heart]").forEach((button) => {
    button.addEventListener("click", () => heartPlugin(button));
  });
  root.querySelectorAll("[data-copy-command]").forEach((button) => {
    button.addEventListener("click", () => copyPluginCommand(button));
  });
  root.querySelectorAll("[data-author]").forEach((button) => {
    button.addEventListener("click", () => {
      const publisher = button.dataset.author;
      state.source = "community";
      state.terms = [createSearchTerm("author", publisher)].filter(Boolean);
      state.query = "";
      state.category = "all";
      state.sort = sourceDefaultSort("community");
      state.page = 1;
      search.value = "";
      closeSearchSuggestions();
      renderSearchTerms();
      renderSourceFilters();
      renderSortOptions();
      renderCategories();
      render();
      searchSuggestionStatus.textContent = `Showing all plugins by @${publisher}`;
      document.querySelector("#catalog")?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "start"
      });
    });
  });
}

function renderRecentlyAdded() {
  const section = document.querySelector("#recent-section");
  const root = document.querySelector("#recent-grid");
  if (!section || !root) return;

  const recent = state.plugins
    .filter((plugin) => (plugin.sourceType || "community") === "community" && isRecentlyAdded(plugin))
    .sort((a, b) => listingTime(b) - listingTime(a) || a.name.localeCompare(b.name))
    .slice(0, 3);

  section.hidden = recent.length === 0;
  root.innerHTML = recent.map((plugin) => pluginCard(plugin, { showNew: true })).join("");
  bindCardActions(root);
}

function renderPagination(totalItems, pageState) {
  const controls = catalogViewControls(totalItems, state.showAll, pluginsPerPage);
  document.body.classList.toggle("catalog-show-all", controls.reserveDockSpace);
  pagination.hidden = controls.paginationHidden;
  viewToggle.hidden = controls.browseAllHidden;
  viewDock.hidden = controls.dockHidden;
  const sourceLabel = state.source === "builtin" ? "built-in" : "community";
  viewLabel.textContent = `Browse all ${totalItems} ${sourceLabel} plugin${totalItems === 1 ? "" : "s"}`;
  viewDockStatus.textContent = totalItems === 0
    ? `No ${sourceLabel} plugins found`
    : `Showing all ${totalItems} ${sourceLabel} plugin${totalItems === 1 ? "" : "s"}`;
  viewButton.setAttribute("aria-expanded", "false");
  previousPage.disabled = !pageState.hasPrevious;
  nextPage.disabled = !pageState.hasNext;
  previousPageLabel.textContent = pageState.hasPrevious ? `Page ${pageState.page - 1}` : "First page";
  nextPageLabel.textContent = pageState.hasNext ? `Page ${pageState.page + 1}` : "Last page";
  pageSummary.textContent = `${pageState.page} / ${pageState.totalPages}`;
  previousPage.setAttribute("aria-label", pageState.hasPrevious
    ? `Go to plugin page ${pageState.page - 1}`
    : "No previous plugin page");
  nextPage.setAttribute("aria-label", pageState.hasNext
    ? `Go to plugin page ${pageState.page + 1}`
    : "No next plugin page");
}

function placeViewDock() {
  if (!state.showAll) {
    document.querySelector("#site-footer")?.before(viewDock);
    return;
  }
  const cards = grid.querySelectorAll(".plugin-card");
  if (cards.length > pluginsPerPage) grid.insertBefore(viewDock, cards[pluginsPerPage]);
  else grid.after(viewDock);
}

function cancelViewScroll() {
  if (!viewScrollFrame) return;
  window.cancelAnimationFrame(viewScrollFrame);
  viewScrollFrame = 0;
}

function restoreViewScroll(scrollTop) {
  cancelViewScroll();
  window.scrollTo({ top: scrollTop, behavior: "auto" });
  viewScrollFrame = window.requestAnimationFrame(() => {
    viewScrollFrame = window.requestAnimationFrame(() => {
      viewScrollFrame = 0;
      if (state.showAll) window.scrollTo({ top: scrollTop, behavior: "auto" });
    });
  });
}

function searchResultMessage(action) {
  const totalItems = filteredPlugins().length;
  return `${action}. ${totalItems} search result${totalItems === 1 ? "" : "s"}`;
}

function catalogResultMessage(totalItems, pageState) {
  const sourceLabel = state.source === "builtin" ? "built-in" : "community";
  if (totalItems === 0) return `No ${sourceLabel} plugins found`;
  if (state.showAll) return `Showing all ${totalItems} ${sourceLabel} plugin${totalItems === 1 ? "" : "s"}`;
  const shown = Math.min(pluginsPerPage, totalItems - pageState.start);
  return `Showing ${shown} of ${totalItems} ${sourceLabel} plugins, page ${pageState.page} of ${pageState.totalPages}`;
}

function focusCatalogResult() {
  const resultLinks = grid.querySelectorAll(".plugin-card-link");
  const target = state.showAll
    ? resultLinks[pluginsPerPage] || resultLinks[0] || viewDockButton
    : resultLinks[0] || document.querySelector("#empty-reset");
  target?.focus({ preventScroll: true });
}

function catalogControlFocusToken(active) {
  if (active === searchClear) return { type: "search-clear" };
  const sourceButton = active?.closest?.("[data-source]");
  if (sourceButton && sourcesRoot.contains(sourceButton)) return { type: "source" };
  const categoryButton = active?.closest?.("[data-category]");
  if (categoryButton && categoriesRoot.contains(categoryButton)) return { type: "category" };
  const termButton = active?.closest?.("[data-search-term]");
  if (!termButton || !searchTerms.contains(termButton)) return null;
  return {
    type: "term",
    key: searchTermKey(state.terms[Number(termButton.dataset.searchTerm)]),
  };
}

function restoreCatalogControlFocus(token) {
  let target = null;
  if (token?.type === "search-clear") {
    target = searchClear.hidden ? search : searchClear;
  } else if (token?.type === "source") {
    target = [...sourcesRoot.querySelectorAll("[data-source]")]
      .find((button) => button.dataset.source === state.source);
  } else if (token?.type === "category") {
    target = [...categoriesRoot.querySelectorAll("[data-category]")]
      .find((button) => button.dataset.category === state.category);
  } else if (token?.type === "term") {
    target = [...searchTerms.querySelectorAll("[data-search-term]")]
      .find((button) => searchTermKey(state.terms[Number(button.dataset.searchTerm)]) === token.key)
      || search;
  }
  target?.focus({ preventScroll: true });
  return Boolean(target);
}

function render({ historyMode = "replace", announce = false } = {}) {
  cancelViewScroll();
  const visible = filteredPlugins();
  const pageState = paginationState(visible.length, state.page, pluginsPerPage);
  state.page = state.showAll ? 1 : pageState.page;
  const pagePlugins = state.showAll
    ? visible
    : visible.slice(pageState.start, pageState.end);
  const categoryPlugins = sourcePlugins().filter((plugin) => matchesCatalogFilter(plugin));
  const hasSearch = state.terms.length > 0 || Boolean(state.query.trim());
  const hasResultFilter = hasSearch || verificationFilters.has(state.sort);
  const authorTerm = state.terms.find((term) => term.type === "author");
  catalogTitle.textContent = authorTerm ? `plugins by @${authorTerm.value}` : "browse all plugins";
  count.textContent = hasResultFilter
    ? `${visible.length} of ${categoryPlugins.length}`
    : String(categoryPlugins.length);
  countLabel.textContent = state.category === "all"
    ? (state.source === "builtin" ? "built-in plugins" : "community plugins")
    : `${state.source === "builtin" ? "built-in plugins" : "plugins"} in ${catalogFilterLabel(state.category)}`;
  grid.innerHTML = pagePlugins.map((plugin) => pluginCard(plugin, { showNew: true })).join("");
  bindCardActions(grid);
  grid.hidden = visible.length === 0;
  empty.hidden = visible.length !== 0;
  renderPagination(visible.length, pageState);
  placeViewDock();
  updateUrl(historyMode);
  if (announce) catalogResultStatus.textContent = catalogResultMessage(visible.length, pageState);
}

function renderSourceFilters() {
  const totals = {
    community: state.plugins.filter((plugin) => (plugin.sourceType || "community") === "community").length,
    builtin: state.plugins.filter((plugin) => plugin.sourceType === "builtin").length
  };

  sourcesRoot.innerHTML = [
    ["community", "Community"],
    ["builtin", "Built-in"]
  ].map(([source, label]) => `
    <button class="source-button${state.source === source ? " active" : ""}" type="button" data-source="${source}" aria-pressed="${state.source === source}">
      <span>${label}</span><span>${totals[source]}</span>
    </button>`).join("");

  sourcesRoot.querySelectorAll("[data-source]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.source === state.source) return;
      state.source = button.dataset.source;
      const removedAuthorTerms = state.source === "builtin"
        ? state.terms.filter((term) => term.type === "author")
        : [];
      const authorFreeDraft = state.source === "builtin"
        ? removeSearchTermTypeFromDraft(state.query, "author")
        : state.query;
      const removedAuthorDraft = authorFreeDraft !== normalizeSearchTerm(state.query);
      if (state.source === "builtin") {
        state.terms = state.terms.filter((term) => term.type !== "author");
        state.query = authorFreeDraft;
        search.value = state.query;
      }
      state.category = "all";
      state.sort = sourceDefaultSort();
      state.page = 1;
      closeSearchSuggestions();
      renderSearchTerms();
      renderSourceFilters();
      renderSortOptions();
      renderCategories();
      const removedAuthorSearch = removedAuthorTerms.length || removedAuthorDraft;
      render({ announce: !removedAuthorSearch });
      if (removedAuthorSearch) {
        searchSuggestionStatus.textContent = searchResultMessage(
          "Removed author search terms because they are unavailable for built-in plugins",
        );
      }
    });
  });
}

function renderSortOptions() {
  const options = availableSortOptions();
  sort.innerHTML = options
    .map(([value, label]) => `<option value="${value}">${label}</option>`)
    .join("");
  if (!options.some(([value]) => value === state.sort)) state.sort = sourceDefaultSort();
  sort.value = state.sort;
}

function renderCategories() {
  const plugins = sourcePlugins();
  const categoryTotals = catalogCategoryTotals(plugins);
  const categoryFilters = [...categoryTotals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([value, total]) => ({ value, label: value, total }));
  const tagFilters = taxonomyFilterTags
    .map((tag) => ({
      value: `tag:${tag}`,
      label: displayTaxonomyTag(tag),
      total: plugins.filter((plugin) => (plugin.tags || []).includes(tag)).length,
    }))
    .filter(({ total }) => total > 0);
  const filters = [
    { value: "all", label: allCategoryLabel(), total: plugins.length },
    ...categoryFilters,
    ...tagFilters,
  ];

  categoriesRoot.innerHTML = filters.map(({ value, label, total }) => `
    <button class="category-button${state.category === value ? " active" : ""}" type="button" data-category="${escapeHtml(value)}" aria-pressed="${state.category === value}">
      <span>${escapeHtml(label)}</span><span>${total}</span>
    </button>`).join("");

  categoriesRoot.querySelectorAll("[data-category]").forEach((button) => {
    button.addEventListener("click", () => {
      state.category = button.dataset.category;
      state.page = 1;
      renderCategories();
      render({ announce: true });
    });
  });
}

function resetFilters() {
  state.terms = [];
  state.query = "";
  state.category = "all";
  state.page = 1;
  search.value = "";
  closeSearchSuggestions();
  renderSearchTerms();
  if (verificationFilters.has(state.sort)) {
    state.sort = sourceDefaultSort();
    renderSortOptions();
  }
  renderCategories();
  render({ announce: true });
}

function updateUrl(historyMode = "replace") {
  const params = new URLSearchParams();
  if (state.source === "builtin") params.set("source", "builtin");
  appendSearchState(params, { terms: state.terms, draft: state.query });
  if (state.category !== "all") params.set("category", state.category);
  if (state.sort !== sourceDefaultSort()) params.set("sort", state.sort);
  appendCatalogViewState(params, { showAll: state.showAll, page: state.page });
  const next = `${location.pathname}${params.size ? `?${params}` : ""}${location.hash}`;
  if (historyMode === "none" || next === `${location.pathname}${location.search}${location.hash}`) return;
  history[historyMode === "push" ? "pushState" : "replaceState"](null, "", next);
}

function restoreUrl() {
  const params = new URLSearchParams(location.search);
  state.source = params.get("source") === "builtin" ? "builtin" : "community";
  const restoredSearch = readSearchState(params);
  state.terms = state.source === "builtin"
    ? restoredSearch.terms.filter((term) => term.type !== "author")
    : restoredSearch.terms;
  state.query = state.source === "builtin"
    ? removeSearchTermTypeFromDraft(restoredSearch.draft, "author")
    : restoredSearch.draft;
  const requestedCategory = params.get("category") || "all";
  state.category = requestedCategory === "all" || sourcePlugins().some(
    (plugin) => matchesCatalogFilter(plugin, requestedCategory),
  ) ? requestedCategory : "all";
  const viewState = readCatalogViewState(params);
  state.showAll = viewState.showAll;
  state.page = viewState.page;
  const requestedSort = params.get("sort") || sourceDefaultSort();
  state.sort = availableSortOptions().some(([value]) => value === requestedSort)
    ? requestedSort
    : sourceDefaultSort();
  search.value = state.query;
}

function runVisibleAnimation(element, draw, framesPerSecond = 60) {
  let frame = 0;
  let visible = false;
  let nextDrawAt = 0;
  const frameInterval = 1000 / framesPerSecond;
  const active = () => visible && document.visibilityState === "visible";
  const tick = (now) => {
    frame = 0;
    if (!active()) return;
    if (!nextDrawAt || now >= nextDrawAt) {
      nextDrawAt = now + frameInterval - 1;
      draw(now);
    }
    frame = window.requestAnimationFrame(tick);
  };
  const sync = () => {
    if (active() && !frame) frame = window.requestAnimationFrame(tick);
    if (!active() && frame) {
      window.cancelAnimationFrame(frame);
      frame = 0;
    }
  };
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    sync();
  }).observe(element);
  document.addEventListener("visibilitychange", sync);
}

function setupHeroRay() {
  const frame = document.querySelector(".market-hero-ray");
  const canvas = frame?.querySelector("canvas");
  const label = frame?.querySelector(".market-hero-ray-label");
  if (!frame || !canvas || !label) return;

  const context = canvas.getContext("2d");
  if (!context) return;

  const base = {
    AMP: 4, WIND: 35, VS: 7, VO: 13, QA: 2, QF: 3, SP: 35, TH: 9,
    ORB: 40, YS: 35, PD: 9, PSP: 2, WV: 9, WSP: 2, DOF: 4,
    RF: 9, DPH: 2, CX: 200, CY: 0, DENS: 235,
  };
  const presets = [
    { name: "ORIGINAL", zoom: 1.08, offsetY: -45, values: {} },
    { name: "COCOON", zoom: 1.04, offsetY: -105, values: { WIND: 14.5, AMP: 2.6, TH: 14.2, SP: 70, ORB: 22, YS: 52, RF: 4.2, DENS: 150 } },
    { name: "STORM", zoom: .92, values: { PD: 2.4, PSP: 4.2, WV: 2.8, RF: 19, DPH: -3.4, WIND: 48, DENS: 110 } },
    { name: "RAY", zoom: 1.18, values: { AMP: 8.69, WIND: 38.26, VS: 16.38, VO: 11.75, QA: 1.65, QF: 3.47, SP: 38.62, TH: 9.63, ORB: 47.63, YS: 7.34, PD: 10.77, PSP: 2.73, WV: 7.21, WSP: 3.79, DOF: 5.98, RF: 3.04, DPH: 3.18, CX: 201, CY: 161 } },
    { name: "BIRD", zoom: 1.08, values: { AMP: 9.07, WIND: 73.68, VS: 15.45, VO: 25.38, QA: 4.98, QF: 5.32, SP: 44.61, TH: 9.37, ORB: 16.84, YS: 21.85, PD: 12.64, PSP: 3.52, WV: 10.31, WSP: 2, DOF: 3.3, RF: 10.2, DPH: 2.76, CX: 200, CY: -261 } },
    { name: "WING", zoom: 1.18, values: { AMP: 7.18, WIND: 47.39, VS: 16.24, VO: 28.23, QA: 3.58, QF: 5.84, SP: 38.57, TH: 12.2, ORB: 25.09, YS: 10.8, PD: 15.4, PSP: 3.23, WV: 12.94, WSP: 1.19, DOF: 8.59, RF: 10.94, DPH: .79, CX: 205, CY: -5 } },
  ].map((preset) => ({ ...preset, values: { ...base, ...preset.values } }));

  const pointCount = 3600;
  const sourcePointCount = 6000;
  const sourceIndices = new Float32Array(pointCount);
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let width = 0;
  let height = 0;
  let presetIndex = 3;
  let animationStartedAt = performance.now();
  let accent = "#ff5a36";
  let text = "#d7d7d9";

  for (let index = 0; index < pointCount; index += 1) {
    sourceIndices[index] = index * (sourcePointCount / pointCount);
  }

  const updateColors = () => {
    const styles = getComputedStyle(document.documentElement);
    accent = styles.getPropertyValue("--accent").trim() || accent;
    text = styles.getPropertyValue("--text").trim() || text;
  };

  const resize = () => {
    const bounds = frame.getBoundingClientRect();
    const density = Math.min(window.devicePixelRatio || 1, 2);
    width = Math.max(1, bounds.width);
    height = Math.max(1, bounds.height);
    canvas.width = Math.round(width * density);
    canvas.height = Math.round(height * density);
    context.setTransform(density, 0, 0, density, 0, 0);
  };

  new ResizeObserver(() => {
    resize();
    if (reducedMotion) window.requestAnimationFrame((now) => draw(now));
  }).observe(frame);

  updateColors();
  resize();

  const draw = (now) => {
    context.clearRect(0, 0, width, height);
    const preset = presets[presetIndex];
    const values = preset.values;
    const time = (now - animationStartedAt) * .00105;
    const scale = Math.min(width / 400, height / 400) * preset.zoom;
    const originX = (width - 400 * scale) / 2;
    const originY = (height - 400 * scale) / 2;

    for (let index = pointCount; index--;) {
      const sourceIndex = sourceIndices[index];
      const y = sourceIndex / values.DENS;
      const k = (values.AMP + Math.cos(sourceIndex / values.PD - time * values.PSP))
        * Math.cos(sourceIndex / values.WIND);
      const e = y / values.VS - values.VO;
      const distance = Math.hypot(k, e)
        + Math.sin(e / values.WV + time / values.WSP) - values.DOF;
      const q = values.QA * Math.sin(k * values.QF)
        - y / values.SP * k
          * (values.TH + k
            * Math.sin(Math.cos(e) * values.RF - distance * values.DPH + time));
      const angle = distance - time;
      const sourceX = q + values.ORB * Math.cos(angle) + values.CX;
      const sourceY = q * Math.sin(angle) + distance * values.YS + values.CY;
      const x = originX + sourceX * scale;
      const pointY = originY + (sourceY + (preset.offsetY || 0)) * scale;

      if (x < 0 || x > width || pointY < 0 || pointY > height) continue;
      context.globalAlpha = index % 13 === 0 ? .48 : .27;
      context.fillStyle = index % 19 === 0 ? accent : text;
      const size = index % 29 === 0 ? 1.3 : .8;
      context.fillRect(x, pointY, size, size);
    }

    context.globalAlpha = 1;
  };

  new MutationObserver(() => {
    updateColors();
    if (reducedMotion) window.requestAnimationFrame((now) => draw(now));
  }).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });

  const updatePreset = () => {
    const preset = presets[presetIndex];
    label.textContent = `${preset.name} ${String(presetIndex + 1).padStart(2, "0")}/${String(presets.length).padStart(2, "0")}`;
    frame.setAttribute("aria-label", `Show next parametric animation. Current: ${preset.name.toLowerCase()}`);
  };

  frame.addEventListener("click", () => {
    presetIndex = (presetIndex + 1) % presets.length;
    animationStartedAt = performance.now();
    updatePreset();
    if (!reducedMotion) {
      canvas.animate?.([{ opacity: .25 }, { opacity: .84 }], { duration: 220, easing: "ease-out" });
    } else {
      draw(animationStartedAt);
    }
  });

  updatePreset();
  if (reducedMotion) {
    draw(animationStartedAt);
  } else {
    runVisibleAnimation(frame, draw, 30);
  }
}

async function init() {
  setupThemeToggle();
  setupCopyButtons();
  setupHeroRay();
  document.addEventListener("click", () => closeVerificationTooltips());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeVerificationTooltips();
  });

  try {
    const catalog = await loadCatalog();
    if (!catalog || !Array.isArray(catalog.plugins)) {
      throw new Error("Catalog response is invalid");
    }
    state.plugins = catalog.plugins;
    state.engagementEnabled = Boolean(engagementApiBaseUrl());
    restoreUrl();
    renderSearchTerms();
    renderRecentlyAdded();
    renderSourceFilters();
    renderSortOptions();
    renderCategories();
    render();
    if (state.engagementEnabled) {
      loadEngagementStats().then((stats) => {
        state.engagement = { ...stats, ...state.engagementAuthoritative };
        state.engagementLoaded = true;
        document.querySelectorAll("[data-plugin-engagement]").forEach((summary) => {
          const pluginId = summary.dataset.pluginEngagement;
          const pluginStats = state.engagement[pluginId] || { views: 0, copies: 0, hearts: 0 };
          updateEngagementSummary(document, pluginId, pluginStats);
          updatePluginHeart(document, pluginId, pluginStats, {
            hearted: hasPluginHeart(pluginId),
          });
        });
        if (engagementSorts.has(state.sort)) {
          const focusToken = pluginCardFocusToken();
          render();
          if (!restorePluginCardFocus(focusToken) && focusToken) focusCatalogResult();
          const label = availableSortOptions().find(([value]) => value === state.sort)?.[1] || state.sort;
          catalogResultStatus.textContent = `Engagement loaded. Sorted plugins by ${label.toLowerCase()}.`;
        }
      }).catch((reason) => {
        console.warn("Engagement stats unavailable", reason);
        const focusToken = pluginCardFocusToken();
        state.engagementEnabled = false;
        hidePendingEngagement(document);
        const previousSort = state.sort;
        const previousLabel = sortOptions[state.source]
          .find(([value]) => value === previousSort)?.[1] || previousSort;
        renderSortOptions();
        if (state.sort !== previousSort) {
          state.page = 1;
          render();
          if (!restorePluginCardFocus(focusToken) && focusToken) focusCatalogResult();
          const fallbackLabel = availableSortOptions()
            .find(([value]) => value === state.sort)?.[1] || state.sort;
          catalogResultStatus.textContent = `${previousLabel} is unavailable because engagement stats could not be loaded. Showing ${fallbackLabel.toLowerCase()}.`;
        }
      });
    }
  } catch (error) {
    console.error(error);
    grid.hidden = true;
    empty.hidden = false;
    empty.querySelector("h3").textContent = "Catalog unavailable";
    empty.querySelector("p").textContent = "The plugin catalog could not be loaded. Please try again.";
  }

  search.addEventListener("input", () => {
    state.query = search.value;
    state.page = 1;
    updateSearchAffordances();
    updateSearchSuggestions();
    render();
  });

  search.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (handleSearchEscape(event, {
      hasSuggestions: !searchSuggestions.hidden,
      closeSuggestions: closeSearchSuggestions,
      clearSearch: () => {
        search.value = "";
        state.query = "";
        state.page = 1;
        updateSearchAffordances();
        render({ announce: true });
        search.blur();
      },
    })) return;
    if (event.key === "Tab") {
      closeSearchSuggestions();
      return;
    }
    if (event.key === "Backspace" && !search.value && state.terms.length) {
      event.preventDefault();
      removeSearchTerm(state.terms.length - 1);
      return;
    }

    const inlineIndex = inlineSuggestionIndex();
    const action = searchKeyAction({
      key: event.key,
      completionCount: searchCompletions.length,
      activeSuggestion,
      caretAtEnd: searchCaretAtEnd(),
      hasInlineCompletion: inlineIndex >= 0,
    });
    if (action === "next-completion" || action === "previous-completion") {
      event.preventDefault();
      const offset = action === "next-completion" ? 1 : -1;
      const nextIndex = activeSuggestion < 0
        ? (offset > 0 ? 0 : searchCompletions.length - 1)
        : activeSuggestion + offset;
      setActiveSuggestion(nextIndex);
      return;
    }
    if (action === "submit-query") {
      event.preventDefault();
      commitSearchDraft();
      return;
    }
    if (action === "accept-active-completion") {
      event.preventDefault();
      commitSearchDraft(searchCompletions[activeSuggestion]);
      return;
    }
    if (action === "accept-inline-completion") {
      event.preventDefault();
      commitSearchDraft(searchCompletions[inlineIndex]);
    }
  });
  search.addEventListener("focus", () => {
    if (searchBlurTimer) window.clearTimeout(searchBlurTimer);
    searchBlurTimer = 0;
    updateSearchSuggestions();
  });
  search.addEventListener("blur", () => {
    searchBlurTimer = window.setTimeout(closeSearchSuggestions, 100);
  });
  document.addEventListener("selectionchange", () => {
    if (document.activeElement === search) updateFishPreview();
  });

  document.addEventListener("keydown", (event) => {
    if ((event.key === "/" || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k")) && document.activeElement !== search) {
      event.preventDefault();
      search.focus();
    }
  });

  searchClear.addEventListener("click", () => clearSearchTerms());

  sort.addEventListener("change", () => {
    state.sort = sort.value;
    state.page = 1;
    render({ announce: true });
  });

  const changePage = (offset) => {
    state.page += offset;
    render({ historyMode: "push", announce: true });
    const firstResult = grid.querySelector(".plugin-card-link");
    firstResult?.focus({ preventScroll: true });
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    grid.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
  };
  previousPage.addEventListener("click", () => {
    if (!previousPage.disabled) changePage(-1);
  });
  nextPage.addEventListener("click", () => {
    if (!nextPage.disabled) changePage(1);
  });
  viewButton.addEventListener("click", () => {
    const previousScrollTop = window.scrollY;
    state.showAll = true;
    state.page = 1;
    render({ historyMode: "push", announce: true });
    const resultLinks = grid.querySelectorAll(".plugin-card-link");
    resultLinks[pluginsPerPage]?.focus({ preventScroll: true });
    restoreViewScroll(previousScrollTop);
  });
  viewDockButton.addEventListener("click", () => {
    state.showAll = false;
    state.page = 1;
    render({ historyMode: "push", announce: true });
    focusCatalogResult();
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    grid.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
  });
  window.addEventListener("popstate", () => {
    const active = document.activeElement;
    const controlFocus = catalogControlFocusToken(active);
    const catalogHadFocus = Boolean(controlFocus)
      || grid.contains(active)
      || empty.contains(active)
      || pagination.contains(active)
      || viewToggle.contains(active)
      || viewDock.contains(active);
    closeSearchSuggestions();
    restoreUrl();
    renderSearchTerms();
    renderSourceFilters();
    renderSortOptions();
    renderCategories();
    render({ historyMode: "replace", announce: true });
    if (!restoreCatalogControlFocus(controlFocus) && catalogHadFocus) focusCatalogResult();
  });

  document.querySelector("#clear-filters").addEventListener("click", resetFilters);
  document.querySelector("#empty-reset").addEventListener("click", resetFilters);
}

init();
