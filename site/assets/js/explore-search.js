import {
  matchesDirectSearch,
  matchesDraftSearchTerm,
  parseSearchDraft,
} from "./search.js?v=20260906-01";
import { repositoryPublisher } from "./shared.js?v=20260906-01";

export { repositoryPublisher };

function explorerSearchContext(node) {
  const publisher = repositoryPublisher(node.repo);
  return {
    publisher,
    primaryText: [node.name, node.id, ...(node.tags || [])].join(" "),
    searchText: [
      node.name,
      node.description,
      node.author,
      publisher,
      `@${publisher}`,
      node.id,
      node.category,
      node.kind,
      ...(node.tags || []),
    ].join(" "),
    tags: node.tags || [],
    pluginName: node.name,
    pluginId: node.id,
    pluginKind: node.kind,
  };
}

export function createExplorerSearchMatcher(value) {
  const draftTerms = parseSearchDraft(value);
  if (!draftTerms.length) return () => false;
  const textDraft = draftTerms
    .filter((term) => term.type === "text")
    .map((term) => term.value)
    .join(" ");
  const typedDraftTerms = draftTerms.filter((term) => term.type !== "text");

  return (node) => {
    const context = explorerSearchContext(node);
    const matchesTextDraft = Boolean(textDraft)
      && matchesDirectSearch(textDraft, context);
    const matchesTypedDraft = typedDraftTerms.some((term) =>
      matchesDraftSearchTerm(term, context)
    );
    return matchesTextDraft || matchesTypedDraft;
  };
}

export function matchesExplorerSearch(value, node) {
  return createExplorerSearchMatcher(value)(node);
}
