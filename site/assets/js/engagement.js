const productionSiteHosts = new Set([
  "plugins.omarchy.org",
  "omarchyplugins.com",
  "www.omarchyplugins.com",
]);
const localSiteHosts = new Set(["127.0.0.1", "localhost"]);
const eventTypes = new Set(["view", "copy", "heart"]);
const pluginIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const unsafeObjectKeys = new Set(["__proto__", "constructor", "prototype"]);
const viewStoragePrefix = "omarchy-plugin-view:";
const copyStoragePrefix = "omarchy-plugin-copy:";
const heartStoragePrefix = "omarchy-plugin-heart:";
const copyRequests = new Map();
const heartRequests = new Map();

function validPluginId(value) {
  return pluginIdPattern.test(value) && !unsafeObjectKeys.has(value.toLowerCase());
}

export function engagementApiBaseUrl(locationRef = globalThis.location) {
  const hostname = String(locationRef?.hostname || "").toLowerCase();
  if (localSiteHosts.has(hostname)) return "http://127.0.0.1:8787/v1";
  if (productionSiteHosts.has(hostname)) return "https://api.omarchyplugins.com/v1";
  return "";
}

function safeCount(value) {
  const count = Math.trunc(Number(value));
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

export function normalizeEngagementStats(payload) {
  const source = payload?.plugins;
  if (!source || typeof source !== "object" || Array.isArray(source)) return {};
  const normalized = {};
  for (const [pluginId, value] of Object.entries(source)) {
    if (!validPluginId(pluginId) || !value || typeof value !== "object") continue;
    normalized[pluginId] = {
      views: safeCount(value.views),
      copies: safeCount(value.copies),
      hearts: safeCount(value.hearts),
    };
  }
  return normalized;
}

export async function loadEngagementStats({
  fetchImpl = globalThis.fetch,
  locationRef = globalThis.location,
} = {}) {
  const baseUrl = engagementApiBaseUrl(locationRef);
  if (!baseUrl || typeof fetchImpl !== "function") return {};
  const response = await fetchImpl(`${baseUrl}/stats`, {
    cache: "no-store",
    credentials: "omit",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Engagement request failed: ${response.status}`);
  return normalizeEngagementStats(await response.json());
}

function normalizedPluginStats(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    views: safeCount(value.views),
    copies: safeCount(value.copies),
    hearts: safeCount(value.hearts),
  };
}

export async function recordEngagementEvent(pluginId, type, {
  fetchImpl = globalThis.fetch,
  locationRef = globalThis.location,
} = {}) {
  const baseUrl = engagementApiBaseUrl(locationRef);
  if (
    !baseUrl
    || typeof fetchImpl !== "function"
    || !validPluginId(String(pluginId || ""))
    || !eventTypes.has(type)
  ) return null;

  try {
    const response = await fetchImpl(`${baseUrl}/events`, {
      method: "POST",
      credentials: "omit",
      keepalive: true,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ pluginId, type }),
    });
    if (!response.ok) return null;
    const payload = await response.json();
    if (payload?.recorded === false) {
      return payload.reason === "repeat"
        ? { recorded: false, stats: null, reason: "repeat" }
        : { recorded: false, stats: null };
    }
    const stats = normalizedPluginStats(payload?.plugin);
    return payload?.recorded === true && stats
      ? { recorded: true, stats }
      : null;
  } catch {
    return null;
  }
}

export function hasPluginHeart(pluginId, storage = globalThis.localStorage) {
  if (!validPluginId(String(pluginId || ""))) return false;
  try {
    return storage?.getItem(`${heartStoragePrefix}${pluginId}`) === "1";
  } catch {
    return false;
  }
}

export async function recordPluginHeart(pluginId, {
  storage = globalThis.localStorage,
  ...options
} = {}) {
  const baseUrl = engagementApiBaseUrl(options.locationRef || globalThis.location);
  if (!baseUrl || !validPluginId(String(pluginId || ""))) return null;
  if (hasPluginHeart(pluginId, storage)) return { recorded: false, stats: null };
  if (heartRequests.has(pluginId)) return heartRequests.get(pluginId);

  const request = (async () => {
    const result = await recordEngagementEvent(pluginId, "heart", options);
    if (!result?.recorded) return result;
    try {
      storage?.setItem(`${heartStoragePrefix}${pluginId}`, "1");
    } catch {
      // The reaction is still recorded when browser storage is unavailable.
    }
    return result;
  })();
  heartRequests.set(pluginId, request);
  try {
    return await request;
  } finally {
    if (heartRequests.get(pluginId) === request) heartRequests.delete(pluginId);
  }
}

export async function recordPluginCopy(pluginId, {
  storage = globalThis.sessionStorage,
  ...options
} = {}) {
  const baseUrl = engagementApiBaseUrl(options.locationRef || globalThis.location);
  if (!baseUrl || !validPluginId(String(pluginId || ""))) return null;
  if (copyRequests.has(pluginId)) return copyRequests.get(pluginId);

  const key = `${copyStoragePrefix}${pluginId}`;
  try {
    if (storage?.getItem(key)) return { recorded: false, stats: null };
    storage?.setItem(key, "1");
  } catch {
    // Storage is only a best-effort repeat guard. The event remains anonymous.
  }

  const request = (async () => {
    const result = await recordEngagementEvent(pluginId, "copy", options);
    if (result === null) {
      try {
        storage?.removeItem(key);
      } catch {
        // A later successful copy may still retry when storage is unavailable.
      }
    }
    return result;
  })();
  copyRequests.set(pluginId, request);
  try {
    return await request;
  } finally {
    if (copyRequests.get(pluginId) === request) copyRequests.delete(pluginId);
  }
}

export async function recordPluginView(pluginId, {
  storage = globalThis.sessionStorage,
  ...options
} = {}) {
  const baseUrl = engagementApiBaseUrl(options.locationRef || globalThis.location);
  if (!baseUrl || !validPluginId(String(pluginId || ""))) return null;
  const key = `${viewStoragePrefix}${pluginId}`;
  try {
    if (storage?.getItem(key)) return { recorded: false, stats: null };
    storage?.setItem(key, "1");
  } catch {
    // Storage is only a best-effort refresh guard. The event remains anonymous.
  }

  const result = await recordEngagementEvent(pluginId, "view", options);
  if (result === null) {
    try {
      storage?.removeItem(key);
    } catch {
      // A later page load may still retry when storage is unavailable.
    }
  }
  return result;
}
