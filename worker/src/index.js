const allowedOrigins = new Set([
  "https://plugins.omarchy.org",
  "https://omarchyplugins.com",
  "https://www.omarchyplugins.com",
  "http://127.0.0.1:4173",
  "http://localhost:4173",
]);
const pluginIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const unsafeObjectKeys = new Set(["__proto__", "constructor", "prototype"]);
const eventTypes = new Set(["view", "copy", "heart"]);
const defaultCatalogUrl = "https://omarchyplugins.com/catalog.json";
const defaultDailyEventLimit = 10_000;
const catalogCacheLifetime = 5 * 60 * 1000;
const hourWindowSeconds = 60 * 60;
const dayWindowSeconds = 24 * hourWindowSeconds;
const defaultAddressWindows = {
  view: { hour: 60, day: 240, pluginHour: 5 },
  copy: { hour: 12, day: 36, pluginHour: 1 },
  heart: { hour: 8, day: 24, pluginDay: 1 },
};
let catalogCache = { url: "", expiresAt: 0, pluginIds: new Set() };

function validPluginId(value) {
  return pluginIdPattern.test(value) && !unsafeObjectKeys.has(value.toLowerCase());
}

function validIpv4(value) {
  const parts = String(value || "").split(".");
  if (parts.length !== 4) return "";
  const octets = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return "";
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return "";
    octets.push(String(octet));
  }
  return octets.join(".");
}

function expandIpv6Groups(value) {
  let address = String(value || "").trim().toLowerCase();
  if (address.startsWith("[") && address.endsWith("]")) address = address.slice(1, -1);
  const zone = address.indexOf("%");
  if (zone !== -1) address = address.slice(0, zone);

  if (address.includes(".")) {
    const separator = address.lastIndexOf(":");
    if (separator === -1) return null;
    const mapped = validIpv4(address.slice(separator + 1));
    if (!mapped) return null;
    const [first, second, third, fourth] = mapped.split(".").map(Number);
    address = `${address.slice(0, separator + 1)}${((first << 8) | second).toString(16)}:${((third << 8) | fourth).toString(16)}`;
  }

  const halves = address.split("::");
  if (halves.length > 2) return null;
  const groupsFrom = (side) => {
    if (!side) return [];
    const groups = side.split(":");
    return groups.every((group) => /^[0-9a-f]{1,4}$/.test(group)) ? groups : null;
  };
  if (halves.length === 1) {
    const groups = groupsFrom(halves[0]);
    return groups?.length === 8 ? groups : null;
  }
  const head = groupsFrom(halves[0]);
  const tail = groupsFrom(halves[1]);
  if (!head || !tail) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...Array(missing).fill("0"), ...tail];
}

export function normalizeClientAddress(value) {
  const ip = String(value || "").trim();
  if (!ip) return "";
  const mapped = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) {
    const ipv4 = validIpv4(mapped[1]);
    return ipv4 ? `v4:${ipv4}` : "";
  }
  if (ip.includes(".") && !ip.includes(":")) {
    const ipv4 = validIpv4(ip);
    return ipv4 ? `v4:${ipv4}` : "";
  }
  const groups = expandIpv6Groups(ip);
  if (!groups) return "";
  const padded = groups.map((group) => group.padStart(4, "0"));
  if (padded.slice(0, 5).every((group) => group === "0000") && padded[5] === "ffff") {
    const high = Number.parseInt(padded[6], 16);
    const low = Number.parseInt(padded[7], 16);
    return `v4:${(high >> 8) & 255}.${high & 255}.${(low >> 8) & 255}.${low & 255}`;
  }
  return `v6:${padded.slice(0, 4).join(":")}/64`;
}

function hexDigest(buffer) {
  let hex = "";
  for (const byte of new Uint8Array(buffer)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

async function quotaRequest(parts) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("\n")));
  return new Request(`https://engagement-quota.invalid/${hexDigest(digest)}`);
}

function addressLimit(value, fallback) {
  return configuredEventLimit(value) || fallback;
}

function addressWindowLimits(env) {
  const defaults = defaultAddressWindows;
  return {
    view: {
      hour: addressLimit(env.VIEW_ADDRESS_HOUR_EVENT_LIMIT, defaults.view.hour),
      day: addressLimit(env.VIEW_ADDRESS_DAY_EVENT_LIMIT, defaults.view.day),
      pluginHour: addressLimit(env.VIEW_ADDRESS_PLUGIN_HOUR_EVENT_LIMIT, defaults.view.pluginHour),
    },
    copy: {
      hour: addressLimit(env.COPY_ADDRESS_HOUR_EVENT_LIMIT, defaults.copy.hour),
      day: addressLimit(env.COPY_ADDRESS_DAY_EVENT_LIMIT, defaults.copy.day),
      pluginHour: addressLimit(env.COPY_ADDRESS_PLUGIN_HOUR_EVENT_LIMIT, defaults.copy.pluginHour),
    },
    heart: {
      hour: addressLimit(env.HEART_ADDRESS_HOUR_EVENT_LIMIT, defaults.heart.hour),
      day: addressLimit(env.HEART_ADDRESS_DAY_EVENT_LIMIT, defaults.heart.day),
      pluginDay: addressLimit(env.HEART_ADDRESS_PLUGIN_DAY_EVENT_LIMIT, defaults.heart.pluginDay),
    },
  };
}

function addressWindowsFor(type, pluginId, limits) {
  const spec = limits[type];
  const windows = [
    { limit: spec.hour, windowSeconds: hourWindowSeconds, parts: ["hour", type] },
    { limit: spec.day, windowSeconds: dayWindowSeconds, parts: ["day", type] },
  ];
  if (type === "heart") {
    windows.push({
      limit: spec.pluginDay,
      windowSeconds: dayWindowSeconds,
      parts: ["plugin-day", type, pluginId],
    });
  } else {
    windows.push({
      limit: spec.pluginHour,
      windowSeconds: hourWindowSeconds,
      parts: ["plugin-hour", type, pluginId],
    });
  }
  return windows;
}

export async function consumeSlidingWindow(cache, {
  key,
  limit,
  windowSeconds,
  now = Date.now(),
  record = true,
} = {}) {
  if (!cache?.match || !cache?.put) return { success: false, retryAfter: 60, unavailable: true };
  const request = typeof key === "string"
    ? new Request(`https://engagement-quota.invalid/${key}`)
    : key;
  const cached = await cache.match(request);
  let events = cached ? await cached.json() : [];
  if (!Array.isArray(events)) throw new Error("invalid sliding window");
  const cutoff = now - windowSeconds * 1000;
  events = events.filter((value) => Number.isSafeInteger(value) && value > cutoff);
  if (events.length >= limit) {
    return {
      success: false,
      retryAfter: Math.max(1, Math.ceil((events[0] + windowSeconds * 1000 - now) / 1000)),
    };
  }
  if (!record) return { success: true, retryAfter: 0, events, request };
  events.push(now);
  const ttl = Math.max(1, Math.ceil((events[0] + windowSeconds * 1000 - now) / 1000));
  await cache.put(request, new Response(JSON.stringify(events), {
    headers: {
      "Cache-Control": `max-age=${ttl}`,
      "Content-Type": "application/json",
    },
  }));
  return { success: true, retryAfter: 0 };
}

async function consumeAddressWindows(cache, address, pluginId, type, env, now) {
  const windows = addressWindowsFor(type, pluginId, addressWindowLimits(env));
  const pending = [];
  let retryAfter = 0;
  for (const window of windows) {
    const result = await consumeSlidingWindow(cache, {
      key: await quotaRequest([address, ...window.parts]),
      limit: window.limit,
      windowSeconds: window.windowSeconds,
      now,
      record: false,
    });
    if (result.unavailable) return result;
    if (!result.success) retryAfter = Math.max(retryAfter, result.retryAfter);
    else pending.push({ ...window, result });
  }
  if (retryAfter) return { success: false, retryAfter };
  for (const { result, windowSeconds } of pending) {
    const events = [...result.events, now];
    const ttl = Math.max(1, Math.ceil((events[0] + windowSeconds * 1000 - now) / 1000));
    await cache.put(result.request, new Response(JSON.stringify(events), {
      headers: {
        "Cache-Control": `max-age=${ttl}`,
        "Content-Type": "application/json",
      },
    }));
  }
  return { success: true, retryAfter: 0 };
}

function corsHeaders(origin) {
  if (!allowedOrigins.has(origin)) return { Vary: "Origin" };
  return {
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

function boundedEventLimit(value, fallback) {
  const limit = Math.trunc(Number(value));
  return Number.isSafeInteger(limit) && limit > 0
    ? Math.min(limit, 1_000_000)
    : fallback;
}

function eventLimit(value) {
  return boundedEventLimit(value, defaultDailyEventLimit);
}

function configuredEventLimit(value) {
  return boundedEventLimit(value, 0);
}

function minuteEventLimits(env) {
  const limits = {
    views: configuredEventLimit(env.VIEW_MINUTE_EVENT_LIMIT),
    copies: configuredEventLimit(env.COPY_MINUTE_EVENT_LIMIT),
    hearts: configuredEventLimit(env.HEART_MINUTE_EVENT_LIMIT),
  };
  return Object.values(limits).every(Boolean) ? limits : null;
}

function validCatalogUrl(value) {
  try {
    const url = new URL(value || defaultCatalogUrl);
    const local = ["127.0.0.1", "localhost"].includes(url.hostname);
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return "";
    return url.href;
  } catch {
    return "";
  }
}

export function parseEngagementEvent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const pluginId = String(value.pluginId || "");
  const type = String(value.type || "");
  if (
    !validPluginId(pluginId)
    || !eventTypes.has(type)
    || Object.keys(value).some((key) => !["pluginId", "type"].includes(key))
  ) return null;
  return { pluginId, type };
}

async function catalogPluginIds(env, fetchImpl, now = Date.now()) {
  const url = validCatalogUrl(env.CATALOG_URL);
  if (!url) throw new Error("CATALOG_URL is invalid");
  if (catalogCache.url === url && catalogCache.expiresAt > now) {
    return catalogCache.pluginIds;
  }
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Catalog returned ${response.status}`);
  const catalog = await response.json();
  if (!catalog || !Array.isArray(catalog.plugins)) throw new Error("Catalog response is invalid");
  const pluginIds = new Set(
    catalog.plugins
      .map((plugin) => plugin?.id)
      .filter((pluginId) => validPluginId(String(pluginId || ""))),
  );
  catalogCache = { url, expiresAt: now + catalogCacheLifetime, pluginIds };
  return pluginIds;
}

function safeCount(value) {
  const count = Math.trunc(Number(value));
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

function normalizedRows(results) {
  const plugins = {};
  for (const row of results || []) {
    const pluginId = String(row.plugin_id || "");
    if (!validPluginId(pluginId)) continue;
    plugins[pluginId] = {
      views: safeCount(row.views),
      copies: safeCount(row.copies),
      hearts: safeCount(row.hearts),
    };
  }
  return plugins;
}

const engagementTotalsSql = `
  SELECT SUM(views) AS views, SUM(copies) AS copies, SUM(hearts) AS hearts
  FROM plugin_engagement_daily
  WHERE plugin_id = ?1
`;

function normalizedTotals(row) {
  return {
    views: safeCount(row?.views),
    copies: safeCount(row?.copies),
    hearts: safeCount(row?.hearts),
  };
}

async function statsResponse(env) {
  const result = await env.ENGAGEMENT_DB.prepare(`
    SELECT plugin_id, SUM(views) AS views, SUM(copies) AS copies, SUM(hearts) AS hearts
    FROM plugin_engagement_daily
    GROUP BY plugin_id
    ORDER BY plugin_id
  `).all();
  return json(
    { schemaVersion: 1, plugins: normalizedRows(result.results) },
    200,
    {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=60, s-maxage=300",
    },
  );
}

function browserStatsResponse(response) {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function cachedStatsResponse(request, env, cache, waitUntil) {
  const cacheKey = new Request(new URL("/v1/stats", request.url), { method: "GET" });
  if (cache?.match) {
    const cached = await cache.match(cacheKey);
    if (cached) return browserStatsResponse(cached);
  }
  const response = await statsResponse(env);
  if (cache?.put) {
    const write = cache.put(cacheKey, response.clone()).catch(() => {});
    waitUntil(write);
  }
  return browserStatsResponse(response);
}

async function readLimitedBody(request, limit) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

const engagementUpsertSql = `
  INSERT INTO plugin_engagement_daily (
    plugin_id, day, views, copies, hearts,
    views_minute, views_minute_count,
    copies_minute, copies_minute_count,
    hearts_minute, hearts_minute_count
  )
  VALUES (
    ?1, ?2, ?4, ?5, ?6,
    CASE WHEN ?4 > 0 THEN ?3 ELSE NULL END, ?4,
    CASE WHEN ?5 > 0 THEN ?3 ELSE NULL END, ?5,
    CASE WHEN ?6 > 0 THEN ?3 ELSE NULL END, ?6
  )
  ON CONFLICT(plugin_id, day) DO UPDATE SET
    views = CASE WHEN excluded.views > 0
      THEN MIN(plugin_engagement_daily.views + excluded.views, ?7)
      ELSE plugin_engagement_daily.views END,
    copies = CASE WHEN excluded.copies > 0
      THEN MIN(plugin_engagement_daily.copies + excluded.copies, ?7)
      ELSE plugin_engagement_daily.copies END,
    hearts = CASE WHEN excluded.hearts > 0
      THEN MIN(plugin_engagement_daily.hearts + excluded.hearts, ?7)
      ELSE plugin_engagement_daily.hearts END,
    views_minute = CASE WHEN excluded.views > 0
      THEN ?3 ELSE plugin_engagement_daily.views_minute END,
    views_minute_count = CASE WHEN excluded.views > 0
      THEN CASE WHEN plugin_engagement_daily.views_minute = ?3
        THEN plugin_engagement_daily.views_minute_count + excluded.views
        ELSE excluded.views END
      ELSE plugin_engagement_daily.views_minute_count END,
    copies_minute = CASE WHEN excluded.copies > 0
      THEN ?3 ELSE plugin_engagement_daily.copies_minute END,
    copies_minute_count = CASE WHEN excluded.copies > 0
      THEN CASE WHEN plugin_engagement_daily.copies_minute = ?3
        THEN plugin_engagement_daily.copies_minute_count + excluded.copies
        ELSE excluded.copies END
      ELSE plugin_engagement_daily.copies_minute_count END,
    hearts_minute = CASE WHEN excluded.hearts > 0
      THEN ?3 ELSE plugin_engagement_daily.hearts_minute END,
    hearts_minute_count = CASE WHEN excluded.hearts > 0
      THEN CASE WHEN plugin_engagement_daily.hearts_minute = ?3
        THEN plugin_engagement_daily.hearts_minute_count + excluded.hearts
        ELSE excluded.hearts END
      ELSE plugin_engagement_daily.hearts_minute_count END
  WHERE
    (excluded.views > 0
      AND plugin_engagement_daily.views < ?7
      AND (plugin_engagement_daily.views_minute IS NULL
        OR plugin_engagement_daily.views_minute < ?3
        OR (plugin_engagement_daily.views_minute = ?3
          AND plugin_engagement_daily.views_minute_count < ?8)))
    OR (excluded.copies > 0
      AND plugin_engagement_daily.copies < ?7
      AND (plugin_engagement_daily.copies_minute IS NULL
        OR plugin_engagement_daily.copies_minute < ?3
        OR (plugin_engagement_daily.copies_minute = ?3
          AND plugin_engagement_daily.copies_minute_count < ?9)))
    OR (excluded.hearts > 0
      AND plugin_engagement_daily.hearts < ?7
      AND (plugin_engagement_daily.hearts_minute IS NULL
        OR plugin_engagement_daily.hearts_minute < ?3
        OR (plugin_engagement_daily.hearts_minute = ?3
          AND plugin_engagement_daily.hearts_minute_count < ?10)))
  RETURNING plugin_id
`;

export function engagementUpsertStatement() {
  return engagementUpsertSql;
}

async function eventResponse(request, env, origin, fetchImpl, cache, now) {
  if (!allowedOrigins.has(origin)) return json({ error: "Origin not allowed" }, 403);
  const contentType = request.headers.get("Content-Type") || "";
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return json({ error: "Expected a JSON request" }, 415, corsHeaders(origin));
  }
  if (Number.isFinite(contentLength) && contentLength > 1024) {
    return json({ error: "Request body too large" }, 413, corsHeaders(origin));
  }

  if (!env.ENGAGEMENT_RATE_LIMITER?.limit) {
    return json({ error: "Rate limiter unavailable" }, 503, corsHeaders(origin));
  }
  const address = normalizeClientAddress(request.headers.get("CF-Connecting-IP") || "");
  if (!address) {
    return json(
      { error: "Rate limit exceeded" },
      429,
      { ...corsHeaders(origin), "Retry-After": "60" },
    );
  }
  const rateLimit = await env.ENGAGEMENT_RATE_LIMITER.limit({ key: `events:${address}` });
  if (!rateLimit.success) {
    return json(
      { error: "Rate limit exceeded" },
      429,
      { ...corsHeaders(origin), "Retry-After": "60" },
    );
  }

  let event;
  try {
    const body = await readLimitedBody(request, 1024);
    if (body === null) {
      return json({ error: "Request body too large" }, 413, corsHeaders(origin));
    }
    event = parseEngagementEvent(JSON.parse(body));
  } catch {
    event = null;
  }
  if (!event) return json({ error: "Invalid engagement event" }, 400, corsHeaders(origin));

  const minuteLimits = minuteEventLimits(env);
  if (!minuteLimits) {
    return json({ error: "Event service unavailable" }, 503, corsHeaders(origin));
  }

  let pluginIds;
  try {
    pluginIds = await catalogPluginIds(env, fetchImpl);
  } catch {
    return json({ error: "Plugin catalog unavailable" }, 503, corsHeaders(origin));
  }
  if (!pluginIds.has(event.pluginId)) {
    return json({ error: "Unknown plugin" }, 404, corsHeaders(origin));
  }

  if (!env.ENGAGEMENT_TARGET_RATE_LIMITER?.limit) {
    return json({ error: "Event service unavailable" }, 503, corsHeaders(origin));
  }
  const targetRateLimit = await env.ENGAGEMENT_TARGET_RATE_LIMITER.limit({
    key: `target:${address}:${event.pluginId}:${event.type}`,
  });
  if (!targetRateLimit.success) {
    return json(
      { error: "Rate limit exceeded" },
      429,
      { ...corsHeaders(origin), "Retry-After": "60" },
    );
  }

  const addressLimitResult = await consumeAddressWindows(
    cache,
    address,
    event.pluginId,
    event.type,
    env,
    now,
  );
  if (addressLimitResult.unavailable) {
    return json({ error: "Event service unavailable" }, 503, corsHeaders(origin));
  }
  if (!addressLimitResult.success) {
    return json(
      { error: "Rate limit exceeded" },
      429,
      { ...corsHeaders(origin), "Retry-After": String(addressLimitResult.retryAfter) },
    );
  }

  const timestamp = new Date(now).toISOString();
  const day = timestamp.slice(0, 10);
  const minute = timestamp.slice(0, 16);
  const views = event.type === "view" ? 1 : 0;
  const copies = event.type === "copy" ? 1 : 0;
  const hearts = event.type === "heart" ? 1 : 0;
  const limit = eventLimit(env.DAILY_EVENT_LIMIT);
  const [writeResult, totalsResult] = await env.ENGAGEMENT_DB.batch([
    env.ENGAGEMENT_DB.prepare(engagementUpsertSql).bind(
      event.pluginId,
      day,
      minute,
      views,
      copies,
      hearts,
      limit,
      minuteLimits.views,
      minuteLimits.copies,
      minuteLimits.hearts,
    ),
    env.ENGAGEMENT_DB.prepare(engagementTotalsSql).bind(event.pluginId),
  ]);

  if (!writeResult?.results?.length) {
    return json({ recorded: false, reason: "limit" }, 202, corsHeaders(origin));
  }
  return json({
    recorded: true,
    plugin: normalizedTotals(totalsResult?.results?.[0]),
  }, 202, corsHeaders(origin));
}

export async function handleRequest(request, env, {
  fetchImpl = fetch,
  cache = globalThis.caches?.default,
  waitUntil = () => {},
  now = Date.now(),
} = {}) {
  if (!env?.ENGAGEMENT_DB) return json({ error: "Service unavailable" }, 503);
  const url = new URL(request.url);
  const origin = request.headers.get("Origin") || "";

  if (request.method === "OPTIONS") {
    if (!allowedOrigins.has(origin)) return new Response(null, { status: 403 });
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (url.pathname === "/v1/stats") {
    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405, { Allow: "GET", ...corsHeaders(origin) });
    }
    try {
      return await cachedStatsResponse(request, env, cache, waitUntil);
    } catch {
      return json({ error: "Stats unavailable" }, 503, corsHeaders(origin));
    }
  }
  if (url.pathname === "/v1/events") {
    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405, { Allow: "POST", ...corsHeaders(origin) });
    }
    try {
      return await eventResponse(request, env, origin, fetchImpl, cache, now);
    } catch {
      return json({ error: "Event service unavailable" }, 503, corsHeaders(origin));
    }
  }
  return json({ error: "Not found" }, 404, corsHeaders(origin));
}

export default {
  fetch(request, env, context) {
    return handleRequest(request, env, {
      cache: globalThis.caches?.default,
      waitUntil: context.waitUntil.bind(context),
    });
  },
};
