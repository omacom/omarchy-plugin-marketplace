import {
  submissionChecklist,
  submissionTitlePrefix,
} from "../scripts/submission.mjs";
import {
  foldSearchTerm,
  matchesDirectSearch,
} from "../site/assets/js/search.js";
import {
  parsePluginArguments,
  parsePreviewArguments,
  parseReviewArguments,
  parseSearchArguments,
  parseSimilarityArguments,
} from "./contracts.mjs";
import { analyzeDuplicates } from "./duplicates.mjs";
import { MarketplaceMcpError } from "./errors.mjs";
import { createMarketplaceResources } from "./resources.mjs";
import { compactPlugin, detailedPlugin, pluginById } from "./state.mjs";

export { toolDefinitions } from "./contracts.mjs";

function textResult(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
    isError: false,
  };
}

function pluginSearchText(plugin) {
  return [
    plugin.name,
    plugin.id,
    plugin.description,
    plugin.author,
    plugin.category,
    plugin.kind,
    ...(plugin.tags || []),
  ].filter(Boolean).join(" ");
}

function searchRank(plugin, query) {
  const requested = foldSearchTerm(query);
  const name = foldSearchTerm(plugin.name);
  const id = foldSearchTerm(plugin.id);
  if (!requested) return 10;
  if (requested === id) return 0;
  if (requested === name) return 1;
  if (id.startsWith(requested)) return 2;
  if (name.startsWith(requested)) return 3;
  if (id.includes(requested) || name.includes(requested)) return 4;
  return 5;
}

function titleConsistency(title, manifestName) {
  if (!title) return { status: "not-provided", submitted: null, manifest: manifestName || null };
  const submitted = title.startsWith(submissionTitlePrefix)
    ? title.slice(submissionTitlePrefix.length).trim()
    : title.trim();
  return {
    status: foldSearchTerm(submitted) === foldSearchTerm(manifestName) ? "matches" : "differs",
    submitted,
    manifest: manifestName || null,
  };
}

function duplicateCandidate(inspection, args) {
  const manifest = inspection.manifest;
  return {
    repository: inspection.repository.url,
    repositoryNodeId: inspection.repository.nodeId,
    repositoryDatabaseId: inspection.repository.databaseId,
    id: manifest?.id || "",
    name: manifest?.name || args.submissionTitle.replace(/^\[Plugin\]:\s*/i, ""),
    description: manifest?.description || inspection.repository.description,
    author: manifest?.author || "",
    category: args.category || inspection.suggestedTaxonomy.category,
    tags: args.tags.length ? args.tags : inspection.suggestedTaxonomy.tags,
    kind: manifest?.kinds?.join(" ") || "",
  };
}

function metadataConsistency(inspection, args) {
  const manifest = inspection.manifest;
  return {
    title: titleConsistency(args.submissionTitle, manifest?.name || ""),
    description: {
      manifest: manifest?.description || null,
      repository: inspection.repository.description || null,
      sameNormalizedText: Boolean(
        manifest?.description
        && inspection.repository.description
        && foldSearchTerm(manifest.description) === foldSearchTerm(inspection.repository.description)
      ),
    },
    taxonomy: {
      submittedCategory: args.category || null,
      submittedTags: args.tags,
      suggested: inspection.suggestedTaxonomy,
      // Submitted values reach this report only after contract validation.
      categorySupported: true,
      tagsSupported: true,
    },
  };
}

function readinessStatus(inspection, duplicates, consistency) {
  if (inspection.checks.status === "needs-fixes" || duplicates.exactConflicts.length) {
    return "needs-fixes";
  }
  if (
    duplicates.conclusion === "manual-comparison-required"
    || inspection.checks.status === "review-required"
    || consistency.title.status === "differs"
  ) {
    return "review-required";
  }
  return "ready-for-owner-confirmation";
}

export function createMarketplaceService({ loadState, inspector, previewProvider }) {
  if (typeof loadState !== "function" || !inspector || !previewProvider) {
    throw new MarketplaceMcpError("configuration-invalid", "Marketplace MCP service adapters are incomplete.");
  }

  async function searchPlugins(value) {
    const args = parseSearchArguments(value);
    const state = await loadState();
    const matches = state.plugins.filter((plugin) => (
      (!args.query || matchesDirectSearch(args.query, {
        publisher: plugin.author,
        primaryText: `${plugin.name} ${plugin.id}`,
        searchText: pluginSearchText(plugin),
      }))
      && (!args.category || plugin.category === args.category)
      && (!args.tags.length || args.tags.every((tag) => (plugin.tags || []).includes(tag)))
      && (!args.kind || foldSearchTerm(plugin.kind) === foldSearchTerm(args.kind))
      && (!args.verificationStatus || plugin.verificationStatus === args.verificationStatus)
      && (
        args.installAvailable === undefined
        || Boolean(plugin.installAvailable) === args.installAvailable
      )
    ));
    const results = matches
      .sort((left, right) => (
        searchRank(left, args.query) - searchRank(right, args.query)
        || Number(right.verificationStatus === "verified") - Number(left.verificationStatus === "verified")
        || (right.stars || 0) - (left.stars || 0)
        || left.name.localeCompare(right.name)
        || left.id.localeCompare(right.id)
      ))
      .slice(0, args.limit)
      .map(compactPlugin);
    return textResult({
      query: args.query,
      filters: {
        category: args.category || null,
        tags: args.tags,
        kind: args.kind || null,
        verificationStatus: args.verificationStatus || null,
        installAvailable: args.installAvailable ?? null,
      },
      totalMatches: matches.length,
      returned: results.length,
      catalogGeneratedAt: state.catalog.generatedAt || null,
      results,
    });
  }

  async function getPlugin(value) {
    const { pluginId } = parsePluginArguments(value);
    const state = await loadState();
    const plugin = pluginById(state, pluginId);
    if (!plugin) throw new MarketplaceMcpError("plugin-not-found", `Plugin "${pluginId}" is not listed.`);
    return textResult(detailedPlugin(plugin));
  }

  async function findSimilarPlugins(value) {
    const args = parseSimilarityArguments(value);
    const state = await loadState();
    return textResult(analyzeDuplicates(state, args.candidate, { limit: args.limit }));
  }

  async function reviewCandidate(value) {
    const args = parseReviewArguments(value);
    const inspection = await inspector.inspect({
      repository: args.repository,
      commit: args.commit,
    });
    const state = await loadState();
    const duplicates = analyzeDuplicates(state, duplicateCandidate(inspection, args), {
      limit: args.similarityLimit,
    });
    const consistency = metadataConsistency(inspection, args);
    return textResult({
      ...inspection,
      metadataConsistency: consistency,
      duplicateAnalysis: duplicates,
      submissionReadiness: {
        status: readinessStatus(inspection, duplicates, consistency),
        ownerConfirmationRequired: submissionChecklist,
        note: "An agent must show the completed submission to the owner and receive explicit approval before creating an issue.",
      },
    });
  }

  async function getPreview(value) {
    const args = parsePreviewArguments(value);
    let preview;
    if (args.pluginId) {
      const state = await loadState();
      const plugin = pluginById(state, args.pluginId);
      if (!plugin) {
        throw new MarketplaceMcpError("plugin-not-found", `Plugin "${args.pluginId}" is not listed.`);
      }
      preview = await previewProvider.listed(plugin);
    } else {
      preview = await previewProvider.candidate({
        repository: args.repository,
        commit: args.commit,
      });
    }
    return {
      content: [
        { type: "text", text: JSON.stringify(preview.metadata, null, 2) },
        { type: "image", data: preview.data, mimeType: preview.mimeType },
      ],
      structuredContent: preview.metadata,
      isError: false,
    };
  }

  const handlers = Object.freeze({
    search_plugins: searchPlugins,
    get_plugin: getPlugin,
    find_similar_plugins: findSimilarPlugins,
    review_candidate: reviewCandidate,
    get_preview: getPreview,
  });
  const resources = createMarketplaceResources({ loadState, previewProvider });

  return Object.freeze({
    async callTool(name, args = {}) {
      const handler = handlers[name];
      if (!handler) {
        throw new MarketplaceMcpError("tool-not-found", `Unknown marketplace tool "${name}".`);
      }
      return handler(args);
    },
    ...resources,
  });
}
