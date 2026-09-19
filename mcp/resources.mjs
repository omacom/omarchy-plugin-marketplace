import {
  allowedCategories,
  allowedTags,
  maximumSubmissionTags,
  submissionChecklist,
  submissionTitlePrefix,
} from "../scripts/submission.mjs";
import { MarketplaceMcpError } from "./errors.mjs";
import { pluginIdPattern } from "./identifiers.mjs";
import { detailedPlugin, pluginById } from "./state.mjs";

const staticResources = Object.freeze([
  {
    uri: "marketplace://catalog/summary",
    name: "Marketplace catalog summary",
    description: "Current catalog size, generation time, warnings, and taxonomy.",
    mimeType: "application/json",
  },
  {
    uri: "marketplace://submission/policy",
    name: "Plugin submission policy",
    description: "Agent-facing submission values, checklist, and trust boundary.",
    mimeType: "application/json",
  },
]);

const resourceTemplates = Object.freeze([
  {
    uriTemplate: "marketplace://plugins/{pluginId}",
    name: "Marketplace plugin record",
    description: "Complete public catalog record for an exact plugin ID.",
    mimeType: "application/json",
  },
  {
    uriTemplate: "marketplace://plugins/{pluginId}/preview",
    name: "Marketplace plugin preview",
    description: "Optimized preview image for an exact plugin ID.",
    mimeType: "image/webp",
  },
]);

function jsonResource(uri, data) {
  return [{ uri, mimeType: "application/json", text: JSON.stringify(data, null, 2) }];
}

function pluginResourceRequest(uri) {
  const match = uri.match(/^marketplace:\/\/plugins\/([^/]+)(\/preview)?$/);
  if (!match) {
    throw new MarketplaceMcpError("resource-not-found", `Unknown marketplace resource "${uri}".`);
  }
  let pluginId;
  try {
    pluginId = decodeURIComponent(match[1]);
  } catch {
    throw new MarketplaceMcpError("resource-not-found", "Marketplace resource contains an invalid plugin ID.");
  }
  if (!pluginIdPattern.test(pluginId)) {
    throw new MarketplaceMcpError("resource-not-found", "Marketplace resource contains an invalid plugin ID.");
  }
  return { pluginId, preview: Boolean(match[2]) };
}

export function createMarketplaceResources({ loadState, previewProvider }) {
  return Object.freeze({
    async listResources() {
      return staticResources;
    },

    async listResourceTemplates() {
      return resourceTemplates;
    },

    async readResource(uri) {
      if (uri === "marketplace://catalog/summary") {
        const state = await loadState();
        return jsonResource(uri, {
          generatedAt: state.catalog.generatedAt || null,
          pluginCount: state.plugins.length,
          sourceCount: state.registry.sources.length,
          retiredPluginIdCount: state.retiredPluginIds.size,
          warnings: state.catalog.warnings || [],
          categories: allowedCategories,
          tags: allowedTags,
        });
      }
      if (uri === "marketplace://submission/policy") {
        return jsonResource(uri, {
          titlePrefix: submissionTitlePrefix,
          categories: allowedCategories,
          tags: allowedTags,
          maximumTags: maximumSubmissionTags,
          checklist: submissionChecklist,
          disclaimer: "Marketplace validation and MCP inspection are not a security review, certification, warranty, or endorsement.",
        });
      }

      const request = pluginResourceRequest(uri);
      const state = await loadState();
      const plugin = pluginById(state, request.pluginId);
      if (!plugin) {
        throw new MarketplaceMcpError("plugin-not-found", `Plugin "${request.pluginId}" is not listed.`);
      }
      if (!request.preview) return jsonResource(uri, detailedPlugin(plugin));

      const preview = await previewProvider.listed(plugin);
      return [{ uri, mimeType: preview.mimeType, blob: preview.data }];
    },
  });
}
