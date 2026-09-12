import { githubRepositoryKey } from "../scripts/github-repository.mjs";
import { MarketplaceMcpError } from "./errors.mjs";
import { isPluginId } from "./identifiers.mjs";

function validPlugin(plugin) {
  return plugin
    && typeof plugin === "object"
    && !Array.isArray(plugin)
    && isPluginId(plugin.id);
}

function repositoryKey(value) {
  try {
    return githubRepositoryKey(value);
  } catch {
    return "";
  }
}

export function createMarketplaceState(catalog, registry) {
  if (!catalog || !Array.isArray(catalog.plugins)) {
    throw new MarketplaceMcpError("catalog-invalid", "Marketplace catalog data is invalid.");
  }
  if (!registry || !Array.isArray(registry.sources) || !Array.isArray(registry.retiredPluginIds)) {
    throw new MarketplaceMcpError("registry-invalid", "Marketplace registry data is invalid.");
  }
  if (
    registry.retiredPluginIds.some((pluginId) => !isPluginId(pluginId))
    || new Set(registry.retiredPluginIds).size !== registry.retiredPluginIds.length
  ) {
    throw new MarketplaceMcpError("registry-invalid", "Marketplace registry contains invalid retired plugin IDs.");
  }
  const plugins = catalog.plugins.filter(validPlugin);
  if (plugins.length !== catalog.plugins.length) {
    throw new MarketplaceMcpError("catalog-invalid", "Marketplace catalog contains an invalid plugin record.");
  }
  const pluginsById = new Map();
  for (const plugin of plugins) {
    if (pluginsById.has(plugin.id)) {
      throw new MarketplaceMcpError("catalog-invalid", `Marketplace catalog repeats plugin ID "${plugin.id}".`);
    }
    pluginsById.set(plugin.id, plugin);
  }
  const registeredPluginSources = new Map();
  const sources = registry.sources.map((source) => {
    if (
      !source
      || typeof source !== "object"
      || Array.isArray(source)
      || !["plugin-source", "suite"].includes(source.type)
      || !repositoryKey(source.repo)
    ) {
      throw new MarketplaceMcpError("registry-invalid", "Marketplace registry contains an invalid source.");
    }
    const previousRepositories = source.repositoryIdentity?.previousRepositories;
    if (
      previousRepositories !== undefined
      && (
        !Array.isArray(previousRepositories)
        || previousRepositories.some((slug) => (
          typeof slug !== "string"
          || !repositoryKey(`https://github.com/${slug}`)
        ))
      )
    ) {
      throw new MarketplaceMcpError("registry-invalid", "Marketplace registry source aliases are invalid.");
    }
    const aliases = new Set([
      repositoryKey(source.repo),
      ...(previousRepositories || []).map((slug) => (
        repositoryKey(`https://github.com/${slug}`)
      )),
    ].filter(Boolean));
    const pluginIds = source.type === "suite"
      ? [source.catalog?.id].filter(Boolean)
      : source.plugins && typeof source.plugins === "object" && !Array.isArray(source.plugins)
        ? Object.keys(source.plugins)
        : [];
    if (!pluginIds.length || pluginIds.some((pluginId) => !isPluginId(pluginId))) {
      throw new MarketplaceMcpError("registry-invalid", `Marketplace registry source "${source.repo}" has invalid plugin IDs.`);
    }
    for (const pluginId of pluginIds) {
      if (registeredPluginSources.has(pluginId)) {
        throw new MarketplaceMcpError("registry-invalid", `Marketplace registry repeats plugin ID "${pluginId}".`);
      }
      registeredPluginSources.set(pluginId, source);
    }
    return Object.freeze({ source, aliases, pluginIds: Object.freeze(pluginIds.sort()) });
  });
  return Object.freeze({
    catalog,
    registry,
    plugins,
    pluginsById,
    sources,
    registeredPluginSources,
    retiredPluginIds: new Set(registry.retiredPluginIds),
  });
}

export function pluginById(state, pluginId) {
  return state.pluginsById.get(pluginId) || null;
}

export function compactPlugin(plugin) {
  return {
    id: plugin.id,
    name: plugin.name,
    description: plugin.description,
    author: plugin.author,
    version: plugin.version,
    category: plugin.category,
    tags: plugin.tags || [],
    kind: plugin.kind,
    repo: plugin.repo,
    sourceType: plugin.sourceType,
    status: plugin.status,
    verificationStatus: plugin.verificationStatus,
    installAvailable: Boolean(plugin.installAvailable),
    previewAvailable: Boolean(plugin.previewImage),
    stars: Number.isSafeInteger(plugin.stars) ? plugin.stars : 0,
  };
}

export function detailedPlugin(plugin) {
  return {
    ...plugin,
    detailUrl: `https://omarchyplugins.com/plugin.html?id=${encodeURIComponent(plugin.id)}`,
    previewResourceUri: plugin.previewImage
      ? `marketplace://plugins/${encodeURIComponent(plugin.id)}/preview`
      : null,
  };
}
