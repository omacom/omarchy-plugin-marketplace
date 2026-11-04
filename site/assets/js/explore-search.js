import {
  matchesSearchSelection,
  parseSearchDraft,
  pluginSearchContext,
  repositoryPublisher,
} from "./search.js?v=20261029-01";

export { repositoryPublisher };

// Graph nodes carry no verification, maintenance, or activity fields and the
// graph has no order, so terms for those are left out instead of matching
// nothing or, for `sort:`, everything.
const explorerSearchTermTypes = new Set(["text", "fulltext", "tag", "author", "plugin", "kind", "added"]);

export function createExplorerSearchMatcher(value) {
  const draftTerms = parseSearchDraft(value).filter((term) => explorerSearchTermTypes.has(term.type));
  if (!draftTerms.length) return () => false;
  return (node) => matchesSearchSelection(pluginSearchContext(node), { draftTerms });
}

export function matchesExplorerSearch(value, node) {
  return createExplorerSearchMatcher(value)(node);
}
