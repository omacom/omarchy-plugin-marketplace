import { encodeBase64, readBoundedResponse } from "./bounded-response.mjs";
import { MarketplaceMcpError } from "./errors.mjs";
import { createMarketplaceState } from "./state.mjs";

const defaultCatalogUrl = "https://omarchyplugins.com/catalog.json";
const defaultRegistryUrl = "https://raw.githubusercontent.com/HANCORE-linux/omarchy-plugin-marketplace/main/registry.json";
const stateByteLimit = 32 * 1024 * 1024;
const previewByteLimit = 4 * 1024 * 1024;
const cacheLifetime = 5 * 60 * 1000;
let stateCache = { key: "", expiresAt: 0, state: null };

function configuredUrl(value, fallback, allowedHosts) {
  let url;
  try {
    url = new URL(value || fallback);
  } catch {
    throw new MarketplaceMcpError("configuration-invalid", "Marketplace MCP data URL is invalid.");
  }
  const local = ["127.0.0.1", "localhost"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(local && url.protocol === "http:"))
    || (!local && !allowedHosts.includes(url.hostname))
    || url.username
    || url.password
  ) {
    throw new MarketplaceMcpError("configuration-invalid", "Marketplace MCP data URL is not allowed.");
  }
  return url;
}

async function fetchJson(fetchImpl, url, label) {
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json", "User-Agent": "omarchy-plugin-marketplace-mcp" },
  });
  if (!response.ok) {
    throw new MarketplaceMcpError("marketplace-data-unavailable", `${label} returned HTTP ${response.status}.`);
  }
  const bytes = await readBoundedResponse(response, stateByteLimit, label);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new MarketplaceMcpError("marketplace-data-invalid", `${label} is not valid JSON.`);
  }
}

export function createRemoteStateLoader({ env = {}, fetchImpl = globalThis.fetch } = {}) {
  return async function loadState() {
    const catalogUrl = configuredUrl(
      env.CATALOG_URL,
      defaultCatalogUrl,
      ["omarchyplugins.com", "www.omarchyplugins.com"],
    );
    const registryUrl = configuredUrl(
      env.REGISTRY_URL,
      defaultRegistryUrl,
      ["raw.githubusercontent.com"],
    );
    const key = `${catalogUrl.href}|${registryUrl.href}`;
    if (stateCache.key === key && stateCache.expiresAt > Date.now() && stateCache.state) {
      return stateCache.state;
    }
    const [catalog, registry] = await Promise.all([
      fetchJson(fetchImpl, catalogUrl, "Marketplace catalog"),
      fetchJson(fetchImpl, registryUrl, "Marketplace registry"),
    ]);
    const state = createMarketplaceState(catalog, registry);
    stateCache = { key, expiresAt: Date.now() + cacheLifetime, state };
    return state;
  };
}

export function createRemotePreviewProvider({
  env = {},
  fetchImpl = globalThis.fetch,
  inspector,
} = {}) {
  return Object.freeze({
    async listed(plugin) {
      if (!plugin.previewImage || !/^assets\/img\/plugins\/[A-Za-z0-9._-]+$/.test(plugin.previewImage)) {
        throw new MarketplaceMcpError("preview-missing", `Plugin "${plugin.id}" has no valid listed preview.`);
      }
      const catalogUrl = configuredUrl(
        env.CATALOG_URL,
        defaultCatalogUrl,
        ["omarchyplugins.com", "www.omarchyplugins.com"],
      );
      const url = new URL(plugin.previewImage, catalogUrl);
      if (url.origin !== catalogUrl.origin) {
        throw new MarketplaceMcpError("preview-invalid", "Listed preview URL is not allowed.");
      }
      const response = await fetchImpl(url, { headers: { Accept: "image/*" } });
      if (!response.ok) {
        throw new MarketplaceMcpError("preview-unavailable", `Listed preview returned HTTP ${response.status}.`);
      }
      const bytes = await readBoundedResponse(response, previewByteLimit, "Listed preview");
      return {
        data: encodeBase64(bytes),
        mimeType: response.headers.get("content-type")?.split(";")[0] || "image/webp",
        metadata: {
          source: "listed-plugin",
          pluginId: plugin.id,
          url: url.href,
          width: plugin.previewWidth || null,
          height: plugin.previewHeight || null,
          bytes: bytes.byteLength,
        },
      };
    },

    async candidate(request) {
      const preview = await inspector.getCandidatePreview(request, previewByteLimit);
      return {
        data: encodeBase64(preview.bytes),
        mimeType: preview.mimeType,
        metadata: {
          source: "candidate",
          repository: preview.repository,
          commitSha: preview.commitSha,
          path: preview.path,
          width: null,
          height: null,
          bytes: preview.bytes.byteLength,
        },
      };
    },
  });
}
