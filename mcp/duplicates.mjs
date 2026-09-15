import { githubRepositoryKey } from "../scripts/github-repository.mjs";
import { compactPlugin } from "./state.mjs";

const ignoredWords = new Set([
  "a", "an", "and", "for", "from", "in", "into", "of", "omarchy", "on",
  "plugin", "plugins", "the", "to", "with", "your",
]);

function phrase(value) {
  return String(value || "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function words(value) {
  return new Set(
    phrase(value)
      .split(" ")
      .filter((word) => word.length > 1 && !ignoredWords.has(word)),
  );
}

function intersection(left, right) {
  return [...left].filter((value) => right.has(value));
}

function jaccard(left, right) {
  if (!left.size || !right.size) return 0;
  const shared = intersection(left, right).length;
  return shared / (left.size + right.size - shared);
}

function trigrams(value) {
  const normalized = `  ${phrase(value)}  `;
  const result = new Set();
  for (let index = 0; index <= normalized.length - 3; index += 1) {
    result.add(normalized.slice(index, index + 3));
  }
  return result;
}

function dice(left, right) {
  if (!left.size || !right.size) return 0;
  return (2 * intersection(left, right).length) / (left.size + right.size);
}

function repositoryKey(value) {
  try {
    return githubRepositoryKey(value);
  } catch {
    return "";
  }
}

function candidateTags(candidate) {
  return new Set((candidate.tags || []).map(phrase).filter(Boolean));
}

function similarity(candidate, plugin) {
  const candidateName = phrase(candidate.name);
  const pluginName = phrase(plugin.name);
  const nameSimilarity = candidateName && candidateName === pluginName
    ? 1
    : Math.max(
      dice(trigrams(candidateName), trigrams(pluginName)),
      jaccard(words(candidateName), words(pluginName)),
    );
  const candidateDescriptionWords = words(candidate.description);
  const pluginDescriptionWords = words(plugin.description);
  const descriptionSimilarity = jaccard(candidateDescriptionWords, pluginDescriptionWords);
  const sharedDescriptionTerms = intersection(
    candidateDescriptionWords,
    pluginDescriptionWords,
  ).sort().slice(0, 8);
  const tags = candidateTags(candidate);
  const pluginTags = new Set((plugin.tags || []).map(phrase).filter(Boolean));
  const sharedTags = intersection(tags, pluginTags).sort();
  const taxonomySimilarity = Math.max(
    jaccard(tags, pluginTags),
    candidate.category && candidate.category === plugin.category ? 0.75 : 0,
    candidate.kind && phrase(candidate.kind) === phrase(plugin.kind) ? 0.5 : 0,
  );
  const sameAuthor = phrase(candidate.author) && phrase(candidate.author) === phrase(plugin.author);
  let score = (nameSimilarity * 0.5)
    + (descriptionSimilarity * 0.35)
    + (taxonomySimilarity * 0.1)
    + (sameAuthor ? 0.05 : 0);
  if (candidateName && candidateName === pluginName) score = Math.max(score, 0.82);
  const reasons = [];
  if (candidateName && candidateName === pluginName) reasons.push("same normalized title");
  else if (nameSimilarity >= 0.6) reasons.push("similar title");
  if (sharedDescriptionTerms.length >= 2) {
    reasons.push(`shared description terms: ${sharedDescriptionTerms.join(", ")}`);
  }
  if (sharedTags.length) reasons.push(`shared tags: ${sharedTags.join(", ")}`);
  if (candidate.category && candidate.category === plugin.category) {
    reasons.push(`same category: ${candidate.category}`);
  }
  if (sameAuthor) reasons.push("same author");
  return {
    score: Number(score.toFixed(3)),
    reasons,
    signals: {
      nameSimilarity: Number(nameSimilarity.toFixed(3)),
      descriptionSimilarity: Number(descriptionSimilarity.toFixed(3)),
      taxonomySimilarity: Number(taxonomySimilarity.toFixed(3)),
      sameAuthor: Boolean(sameAuthor),
    },
  };
}

export function analyzeDuplicates(state, candidate, { limit = 8 } = {}) {
  const exactConflicts = [];
  const candidateRepository = repositoryKey(candidate.repository);
  const matchingSources = state.sources.filter(({ source, aliases }) => (
    (candidateRepository && aliases.has(candidateRepository))
    || (
      candidate.repositoryNodeId
      && source.repositoryIdentity?.nodeId === candidate.repositoryNodeId
    )
    || (
      Number.isSafeInteger(candidate.repositoryDatabaseId)
      && source.repositoryIdentity?.databaseId === candidate.repositoryDatabaseId
    )
  ));
  for (const { source, pluginIds } of matchingSources) {
    exactConflicts.push({
      type: "repository-listed",
      repository: source.repo,
      pluginIds,
      message: "This GitHub repository or immutable repository identity is already listed.",
    });
  }
  if (candidate.id && state.registeredPluginSources.has(candidate.id)) {
    const plugin = state.pluginsById.get(candidate.id);
    const source = state.registeredPluginSources.get(candidate.id);
    exactConflicts.push({
      type: "plugin-id-listed",
      pluginId: candidate.id,
      repository: plugin?.repo || source.repo,
      message: `Plugin ID "${candidate.id}" is already listed.`,
    });
  }
  if (candidate.id && state.retiredPluginIds.has(candidate.id)) {
    exactConflicts.push({
      type: "plugin-id-retired",
      pluginId: candidate.id,
      message: `Plugin ID "${candidate.id}" belongs to a retired listing and cannot be reused.`,
    });
  }

  const exactRepositories = new Set(matchingSources.map(({ source }) => repositoryKey(source.repo)));
  const similarPlugins = state.plugins
    .filter((plugin) => (
      plugin.id !== candidate.id
      && !exactRepositories.has(repositoryKey(plugin.repo))
    ))
    .map((plugin) => ({ plugin, ...similarity(candidate, plugin) }))
    .filter((match) => match.score >= 0.24 && match.reasons.length)
    .sort((left, right) => (
      right.score - left.score
      || right.signals.nameSimilarity - left.signals.nameSimilarity
      || left.plugin.id.localeCompare(right.plugin.id)
    ))
    .slice(0, Math.max(1, Math.min(25, limit)))
    .map(({ plugin, score, reasons, signals }) => ({
      classification: score >= 0.62 ? "possible-duplicate" : "related",
      score,
      reasons,
      signals,
      plugin: compactPlugin(plugin),
      previewResourceUri: plugin.previewImage
        ? `marketplace://plugins/${encodeURIComponent(plugin.id)}/preview`
        : null,
    }));

  return {
    exactConflicts,
    similarPlugins,
    conclusion: exactConflicts.length
      ? "exact-conflict"
      : similarPlugins.some((entry) => entry.classification === "possible-duplicate")
        ? "manual-comparison-required"
        : "no-obvious-duplicate",
    advisory: "Similarity results help maintainers compare listings. They never approve, reject, or provide a security determination.",
  };
}
