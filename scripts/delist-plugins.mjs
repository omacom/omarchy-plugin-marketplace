import {
  lstat,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const maximumBatchSize = 20;
const maximumPluginIdLength = 128;
const previewPrefix = "assets/img/plugins/";

function strictIsoTimestamp(value, field) {
  if (typeof value !== "string") throw new Error(`${field} must be an ISO timestamp`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error(`${field} must be an ISO timestamp`);
  }
  return timestamp;
}

function sourcePluginIds(source) {
  const ids = [
    ...(source?.catalog?.id ? [source.catalog.id] : []),
    ...Object.keys(source?.plugins || {}),
  ];
  if (!ids.length || new Set(ids).size !== ids.length) {
    throw new Error(`${source?.repo || "Registry source"} has an invalid plugin allowlist`);
  }
  return ids;
}

function normalizedPreviewPath(value) {
  if (value === undefined) return "";
  if (typeof value !== "string" || !value.startsWith(previewPrefix)) {
    throw new Error("Catalog preview paths must stay inside assets/img/plugins");
  }
  const filename = value.slice(previewPrefix.length);
  if (!filename || basename(filename) !== filename || filename.includes("..") || !filename.endsWith(".webp")) {
    throw new Error("Catalog preview paths must name one generated WebP file");
  }
  return value;
}

function serialized(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function parsePluginIds(value) {
  if (typeof value !== "string") throw new Error("Plugin IDs are required");
  const ids = value.split(/[\s,]+/).filter(Boolean);
  if (!ids.length) throw new Error("Enter at least one plugin ID");
  if (ids.length > maximumBatchSize) throw new Error(`Delist at most ${maximumBatchSize} plugins at once`);
  if (new Set(ids).size !== ids.length) throw new Error("Plugin IDs must not be repeated");
  for (const id of ids) {
    if (id.length > maximumPluginIdLength || !/^[a-z0-9][a-z0-9._-]*$/.test(id) || id.includes("..")) {
      throw new Error(`Invalid plugin ID: ${id}`);
    }
  }
  return ids.sort();
}

export function planPluginDelisting(registry, catalog, requestedPluginIds, options = {}) {
  if (!Array.isArray(registry?.sources)
    || !Array.isArray(registry?.retiredPluginIds)
    || !Array.isArray(catalog?.plugins)
    || !Array.isArray(catalog?.warnings)) {
    throw new Error("Registry and catalog must use the current production schema");
  }
  const pluginIds = parsePluginIds(requestedPluginIds.join("\n"));
  const requested = new Set(pluginIds);
  const retired = new Set(registry.retiredPluginIds);
  for (const id of pluginIds) {
    if (retired.has(id)) throw new Error(`Plugin is already retired: ${id}`);
  }

  const sourceByPluginId = new Map();
  const idsBySource = new Map();
  for (const source of registry.sources) {
    if (typeof source?.repo !== "string" || !source.repo.startsWith("https://github.com/")) {
      throw new Error("Registry sources must have canonical GitHub repository URLs");
    }
    const sourceIds = sourcePluginIds(source);
    idsBySource.set(source, sourceIds);
    for (const id of sourceIds) {
      if (sourceByPluginId.has(id) || retired.has(id)) {
        throw new Error(`Registry has an ambiguous active plugin ID: ${id}`);
      }
      sourceByPluginId.set(id, source);
    }
  }

  const selectedSources = new Set();
  for (const id of pluginIds) {
    const source = sourceByPluginId.get(id);
    if (!source) throw new Error(`Plugin is not an active registry listing: ${id}`);
    selectedSources.add(source);
  }
  for (const source of selectedSources) {
    const missingIds = idsBySource.get(source).filter((id) => !requested.has(id));
    if (missingIds.length) {
      throw new Error(`${source.repo} is a multi-plugin source; also select: ${missingIds.join(", ")}`);
    }
  }

  const catalogById = new Map();
  for (const plugin of catalog.plugins) {
    if (typeof plugin?.id !== "string" || catalogById.has(plugin.id)) {
      throw new Error(`Catalog has an ambiguous plugin ID: ${plugin?.id || "<missing>"}`);
    }
    catalogById.set(plugin.id, plugin);
  }

  const removedPlugins = pluginIds.map((id) => {
    const plugin = catalogById.get(id);
    const source = sourceByPluginId.get(id);
    if (!plugin || plugin.sourceType !== "community" || plugin.repo !== source.repo) {
      throw new Error(`Catalog listing does not match the active registry source: ${id}`);
    }
    return plugin;
  });

  const previewPaths = new Set();
  for (const plugin of removedPlugins) {
    for (const field of ["previewImage", "previewThumbnail"]) {
      const previewPath = normalizedPreviewPath(plugin[field]);
      if (previewPath) previewPaths.add(previewPath);
    }
  }
  const remainingPlugins = catalog.plugins.filter((plugin) => !requested.has(plugin.id));
  for (const plugin of remainingPlugins) {
    for (const field of ["previewImage", "previewThumbnail"]) {
      const previewPath = normalizedPreviewPath(plugin[field]);
      if (previewPath && previewPaths.has(previewPath)) {
        throw new Error(`Preview is shared with a retained plugin: ${previewPath}`);
      }
    }
  }

  const generatedAt = options.generatedAt || new Date().toISOString();
  const previousGeneratedAt = strictIsoTimestamp(catalog.generatedAt, "Catalog generatedAt");
  const nextGeneratedAt = strictIsoTimestamp(generatedAt, "Delisting generatedAt");
  if (nextGeneratedAt <= previousGeneratedAt) {
    throw new Error("Delisting generatedAt must be newer than the catalog");
  }

  const repositories = [...selectedSources].map((source) => source.repo).sort();
  const nextWarnings = catalog.warnings.filter((warning) => {
    if (typeof warning !== "string") throw new Error("Catalog warnings must be strings");
    return !repositories.some((repository) => warning.startsWith(`${repository}:`));
  });
  const nextRegistry = {
    ...registry,
    retiredPluginIds: [...registry.retiredPluginIds, ...pluginIds].sort(),
    sources: registry.sources.filter((source) => !selectedSources.has(source)),
  };
  const nextCatalog = {
    ...catalog,
    generatedAt,
    plugins: remainingPlugins,
    warnings: nextWarnings,
  };
  const report = {
    schemaVersion: 1,
    requestedBy: options.requestedBy || "",
    generatedAt,
    pluginIds,
    repositories,
    removedPluginCount: removedPlugins.length,
    removedSourceCount: selectedSources.size,
    removedWarningCount: catalog.warnings.length - nextWarnings.length,
    removedPreviewPaths: [...previewPaths].sort(),
    commitSubject: pluginIds.length === 1
      ? `Delist ${pluginIds[0]}`
      : `Delist ${pluginIds.length} marketplace plugins`,
  };
  return { nextRegistry, nextCatalog, report };
}

async function writeAtomic(filePath, content) {
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  try {
    await writeFile(temporaryPath, content, { flag: "wx" });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function applyPluginDelisting(options) {
  const previewDirectory = resolve(options.previewDirectory);
  const previewRootMetadata = await lstat(previewDirectory);
  if (!previewRootMetadata.isDirectory() || previewRootMetadata.isSymbolicLink()
    || await realpath(previewDirectory) !== previewDirectory) {
    throw new Error("Preview directory must be a real directory without symbolic links");
  }
  const registry = JSON.parse(await readFile(options.registryPath, "utf8"));
  const catalog = JSON.parse(await readFile(options.catalogPath, "utf8"));
  const result = planPluginDelisting(registry, catalog, options.pluginIds, {
    generatedAt: options.generatedAt,
    requestedBy: options.requestedBy,
  });

  for (const previewPath of result.report.removedPreviewPaths) {
    const filename = previewPath.slice(previewPrefix.length);
    const target = resolve(previewDirectory, filename);
    const metadata = await lstat(target);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Preview is not a regular file: ${previewPath}`);
    }
  }

  await writeAtomic(options.registryPath, serialized(result.nextRegistry));
  await writeAtomic(options.catalogPath, serialized(result.nextCatalog));
  await writeAtomic(options.reportPath, serialized(result.report));
  for (const previewPath of result.report.removedPreviewPaths) {
    await unlink(resolve(previewDirectory, previewPath.slice(previewPrefix.length)));
  }
  return result.report;
}

async function main() {
  const { values } = parseArgs({
    options: {
      registry: { type: "string", default: "registry.json" },
      catalog: { type: "string", default: "site/catalog.json" },
      "preview-dir": { type: "string", default: "site/assets/img/plugins" },
      report: { type: "string" },
    },
    strict: true,
  });
  if (!values.report) throw new Error("--report is required");
  const pluginIds = parsePluginIds(process.env.MARKETPLACE_DELIST_PLUGIN_IDS || "");
  const report = await applyPluginDelisting({
    registryPath: resolve(values.registry),
    catalogPath: resolve(values.catalog),
    previewDirectory: resolve(values["preview-dir"]),
    reportPath: resolve(values.report),
    pluginIds,
    generatedAt: process.env.MARKETPLACE_DELIST_GENERATED_AT || undefined,
    requestedBy: process.env.MARKETPLACE_DELIST_REQUESTED_BY || "",
  });
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
