import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  engagementApiBaseUrl,
  hasPluginHeart,
  loadEngagementStats,
  normalizeEngagementStats,
  recordEngagementEvent,
  recordPluginCopy,
  recordPluginHeart,
  recordPluginView,
} from "../site/assets/js/engagement.js";
import {
  comparePluginEngagement,
  engagementSummary,
  formatEngagementCount,
  formatStars,
  hidePendingEngagement,
  pluginHeartButton,
} from "../site/assets/js/shared.js";
import {
  consumeSlidingWindow,
  engagementUpsertStatement,
  handleRequest,
  normalizeClientAddress,
  parseEngagementEvent,
} from "../worker/src/index.js";

function responseJson(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: init.status || 200,
    headers: { "Content-Type": "application/json" },
  });
}

function fakeDatabase(rows = [], {
  recorded = { plugin_id: "example.plugin" },
  totals = { views: 9, copies: 4, hearts: 3 },
  batchError = null,
} = {}) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const statement = {
        sql,
        values: [],
        bind(...values) {
          statement.values = values;
          return statement;
        },
        async all() {
          calls.push({ operation: "all", sql, values: statement.values });
          return { results: rows };
        },
      };
      return statement;
    },
    async batch(statements) {
      calls.push(...statements.map((statement) => ({
        operation: "batch",
        sql: statement.sql,
        values: statement.values,
      })));
      if (batchError) throw batchError;
      return statements.map((statement) => ({
        success: true,
        results: statement.sql.includes("RETURNING plugin_id")
          ? (recorded ? [recorded] : [])
          : [totals],
      }));
    },
  };
}

function fakeRateLimiter(success = true) {
  const keys = [];
  return {
    keys,
    async limit({ key }) {
      keys.push(key);
      return { success };
    },
  };
}

function fakeCache() {
  const values = new Map();
  return {
    values,
    async match(request) {
      return values.get(request.url)?.clone();
    },
    async put(request, response) {
      values.set(request.url, response.clone());
    },
  };
}

function eventHeaders({
  origin = "https://omarchyplugins.com",
  ip = "192.0.2.1",
} = {}) {
  const headers = {
    "Content-Type": "application/json",
    Origin: origin,
  };
  if (ip) headers["CF-Connecting-IP"] = ip;
  return headers;
}

const productionLocation = { hostname: "plugins.omarchy.org" };
const legacyProductionLocation = { hostname: "omarchyplugins.com" };
const localLocation = { hostname: "127.0.0.1" };
const testMinuteLimitVars = {
  VIEW_MINUTE_EVENT_LIMIT: "2",
  COPY_MINUTE_EVENT_LIMIT: "2",
  HEART_MINUTE_EVENT_LIMIT: "2",
};

test("engagement API routing supports canonical and legacy production hosts exactly", () => {
  assert.equal(engagementApiBaseUrl(productionLocation), "https://api.omarchyplugins.com/v1");
  assert.equal(engagementApiBaseUrl(legacyProductionLocation), "https://api.omarchyplugins.com/v1");
  assert.equal(
    engagementApiBaseUrl({ hostname: "www.omarchyplugins.com" }),
    "https://api.omarchyplugins.com/v1",
  );
  assert.equal(engagementApiBaseUrl(localLocation), "http://127.0.0.1:8787/v1");
  for (const hostname of [
    "preview.example",
    "plugins.omarchy.org.evil.example",
    "www.plugins.omarchy.org",
    "plugins.omarchy.org.",
  ]) {
    assert.equal(engagementApiBaseUrl({ hostname }), "");
  }
});

test("engagement counts and summaries stay compact, accessible, and command-aware", () => {
  assert.equal(formatEngagementCount(999), "999");
  assert.equal(formatEngagementCount(1000), "1k");
  assert.equal(formatEngagementCount(1200), "1.2k");
  assert.equal(formatEngagementCount(12_400), "12k");
  assert.equal(formatEngagementCount(1_500_000), "1.5m");
  assert.equal(formatStars(1000), "1k");
  assert.equal(formatStars(1200), "1.2k");
  const installable = engagementSummary({
    id: "example.plugin",
    installCommand: "omarchy plugin add example",
  }, { views: 1200, copies: 4 }, { detail: true });
  assert.match(installable, /data-plugin-engagement="example\.plugin"/);
  assert.match(installable, /<span class="engagement-glyph" aria-hidden="true"><\/span>/);
  assert.match(installable, /class="copy-icon engagement-copy-icon" aria-hidden="true"><\/span>/);
  assert.match(installable, /data-engagement-accessible>1200 marketplace detail views</);
  assert.match(installable, /data-engagement-accessible>4 successful command copies</);
  assert.match(installable, />1\.2k</);
  assert.match(installable, /class="engagement-visual" aria-hidden="true">[\s\S]*class="engagement-name">views</);
  const cardSummary = engagementSummary({
    id: "example.plugin",
    installCommand: "omarchy plugin add example",
  }, { views: 1200, copies: 4 });
  assert.match(cardSummary, /class="engagement-metric has-control-tooltip" data-engagement-metric="views"/);
  assert.match(cardSummary, /class="control-tooltip" role="tooltip" aria-hidden="true">Marketplace detail views/);
  assert.match(cardSummary, /class="control-tooltip" role="tooltip" aria-hidden="true">Successful command copies/);
  const manual = engagementSummary({ id: "manual.plugin", installCommand: "" }, {}, { pending: true });
  assert.match(manual, /data-engagement-metric="views"/);
  assert.doesNotMatch(manual, /data-engagement-metric="copies"/);
  assert.match(manual, /class="plugin-engagement is-pending"/);
  assert.match(manual, /aria-busy="true"/);

  const heart = pluginHeartButton({ id: "example.plugin", name: "Example" }, { hearts: 12 }, {
    hearted: true,
  });
  assert.match(heart, /data-plugin-heart="example\.plugin"/);
  assert.match(heart, /class="plugin-heart has-control-tooltip is-hearted"/);
  assert.match(heart, /<span class="social-glyph heart-glyph" data-heart-glyph aria-hidden="true"><\/span>/);
  assert.match(heart, /aria-pressed="true" aria-disabled="true"/);
  assert.doesNotMatch(heart, /\sdisabled/);
  assert.match(heart, /data-heart-tooltip role="tooltip" aria-hidden="true">Heart sent<\/span>/);
  assert.match(heart, />12<\/span>/);
  const detailHeart = pluginHeartButton({ id: "example.plugin", name: "Example" }, { hearts: 12 }, {
    detail: true,
  });
  assert.doesNotMatch(detailHeart, /has-control-tooltip|data-heart-tooltip/);
});

test("engagement sort comparators rank counts descending with deterministic ties", () => {
  const plugins = [
    { id: "zeta.plugin", name: "Zeta" },
    { id: "alpha.plugin", name: "Alpha" },
    { id: "beta.plugin", name: "Beta" },
  ];
  const stats = {
    "alpha.plugin": { views: 10, copies: 1, hearts: 2 },
    "beta.plugin": { views: 3, copies: 9, hearts: 12 },
    "zeta.plugin": { views: 10, copies: 9, hearts: 0 },
  };
  const orderedIds = (metric) => [...plugins]
    .sort((first, second) => comparePluginEngagement(first, second, stats, metric))
    .map((plugin) => plugin.id);
  assert.deepEqual(orderedIds("views"), ["alpha.plugin", "zeta.plugin", "beta.plugin"]);
  assert.deepEqual(orderedIds("copies"), ["beta.plugin", "zeta.plugin", "alpha.plugin"]);
  assert.deepEqual(orderedIds("hearts"), ["beta.plugin", "alpha.plugin", "zeta.plugin"]);
  assert.deepEqual(orderedIds("unsupported"), orderedIds("views"));
  assert.equal(comparePluginEngagement(
    { id: "missing.z", name: "Same" },
    { id: "missing.a", name: "Same" },
    { "missing.z": { views: -4 }, "missing.a": { views: Number.NaN } },
    "views",
  ) > 0, true);
});

test("engagement stats accept only safe IDs and non-negative integer counts", () => {
  assert.deepEqual(normalizeEngagementStats({
    plugins: {
      "example.plugin": { views: 12.9, copies: "4", hearts: 7.8 },
      "bad id": { views: 99, copies: 99, hearts: 99 },
      __proto__: { views: 99, copies: 99, hearts: 99 },
      constructor: { views: 99, copies: 99, hearts: 99 },
      negative: { views: -1, copies: Number.NaN, hearts: -4 },
    },
  }), {
    "example.plugin": { views: 12, copies: 4, hearts: 7 },
    negative: { views: 0, copies: 0, hearts: 0 },
  });
  assert.deepEqual(normalizeEngagementStats({ plugins: [] }), {});
});

test("engagement client loads public stats without credentials", async () => {
  let request;
  const result = await loadEngagementStats({
    locationRef: productionLocation,
    fetchImpl: async (...values) => {
      request = values;
      return responseJson({ plugins: { "example.plugin": { views: 2, copies: 1, hearts: 6 } } });
    },
  });
  assert.deepEqual(result, { "example.plugin": { views: 2, copies: 1, hearts: 6 } });
  assert.equal(request[0], "https://api.omarchyplugins.com/v1/stats");
  assert.equal(request[1].cache, "no-store");
  assert.equal(request[1].credentials, "omit");
  assert.equal(request[1].headers.Authorization, undefined);
});

test("engagement events contain only the plugin ID and fixed action type", async () => {
  let request;
  const recorded = await recordEngagementEvent("example.plugin", "copy", {
    locationRef: productionLocation,
    fetchImpl: async (...values) => {
      request = values;
      return responseJson({
        recorded: true,
        plugin: { views: 9, copies: 4, hearts: 3 },
      }, { status: 202 });
    },
  });
  assert.deepEqual(recorded, {
    recorded: true,
    stats: { views: 9, copies: 4, hearts: 3 },
  });
  assert.equal(request[0], "https://api.omarchyplugins.com/v1/events");
  assert.deepEqual(JSON.parse(request[1].body), {
    pluginId: "example.plugin",
    type: "copy",
  });
  assert.equal(request[1].credentials, "omit");
  assert.equal(request[1].headers.Authorization, undefined);
  assert.equal(await recordEngagementEvent("bad id", "copy", {
    locationRef: productionLocation,
    fetchImpl: async () => { throw new Error("must not run"); },
  }), null);
});

test("plugin copies are recorded once per browser session and retry after failure", async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  let requests = 0;
  const options = {
    storage,
    locationRef: productionLocation,
    fetchImpl: async () => {
      requests += 1;
      return responseJson({
        recorded: true,
        plugin: { views: 9, copies: 5, hearts: 3 },
      }, { status: 202 });
    },
  };
  assert.deepEqual(await recordPluginCopy("example.plugin", options), {
    recorded: true,
    stats: { views: 9, copies: 5, hearts: 3 },
  });
  assert.deepEqual(await recordPluginCopy("example.plugin", options), {
    recorded: false,
    stats: null,
  });
  assert.equal(requests, 1);
  assert.equal(values.get("omarchy-plugin-copy:example.plugin"), "1");

  const failed = await recordPluginCopy("failed.plugin", {
    ...options,
    fetchImpl: async () => {
      requests += 1;
      return responseJson({ error: "unavailable" }, { status: 503 });
    },
  });
  assert.equal(failed, null);
  assert.equal(values.has("omarchy-plugin-copy:failed.plugin"), false);
});

test("parallel plugin copies share one in-flight request", async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  let requests = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const options = {
    storage,
    locationRef: productionLocation,
    fetchImpl: async () => {
      requests += 1;
      await gate;
      return responseJson({
        recorded: true,
        plugin: { views: 9, copies: 6, hearts: 3 },
      }, { status: 202 });
    },
  };
  const first = recordPluginCopy("parallel.plugin", options);
  const second = recordPluginCopy("parallel.plugin", options);
  assert.equal(requests, 1);
  release();
  assert.deepEqual(await Promise.all([first, second]), [
    { recorded: true, stats: { views: 9, copies: 6, hearts: 3 } },
    { recorded: true, stats: { views: 9, copies: 6, hearts: 3 } },
  ]);
});

test("plugin views are recorded once per browser session and retry after failure", async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  let requests = 0;
  const options = {
    storage,
    locationRef: productionLocation,
    fetchImpl: async () => {
      requests += 1;
      return responseJson({
        recorded: true,
        plugin: { views: 9, copies: 4, hearts: 3 },
      }, { status: 202 });
    },
  };
  assert.deepEqual(await recordPluginView("example.plugin", options), {
    recorded: true,
    stats: { views: 9, copies: 4, hearts: 3 },
  });
  assert.deepEqual(await recordPluginView("example.plugin", options), {
    recorded: false,
    stats: null,
  });
  assert.equal(requests, 1);

  const failing = {
    ...options,
    fetchImpl: async () => {
      requests += 1;
      return responseJson({ error: "unavailable" }, { status: 503 });
    },
  };
  assert.equal(await recordPluginView("another.plugin", failing), null);
  assert.equal(values.has("omarchy-plugin-view:another.plugin"), false);
});

test("plugin hearts are recorded once per browser and only persisted after success", async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
  };
  let requests = 0;
  const options = {
    storage,
    locationRef: productionLocation,
    fetchImpl: async (_url, request) => {
      requests += 1;
      assert.deepEqual(JSON.parse(request.body), {
        pluginId: "example.plugin",
        type: "heart",
      });
      return responseJson({
        recorded: true,
        plugin: { views: 9, copies: 4, hearts: 5 },
      }, { status: 202 });
    },
  };
  assert.equal(hasPluginHeart("example.plugin", storage), false);
  assert.deepEqual(await recordPluginHeart("example.plugin", options), {
    recorded: true,
    stats: { views: 9, copies: 4, hearts: 5 },
  });
  assert.equal(hasPluginHeart("example.plugin", storage), true);
  assert.deepEqual(await recordPluginHeart("example.plugin", options), {
    recorded: false,
    stats: null,
  });
  assert.equal(requests, 1);

  const failed = await recordPluginHeart("failed.plugin", {
    ...options,
    fetchImpl: async () => responseJson({ error: "unavailable" }, { status: 503 }),
  });
  assert.equal(failed, null);
  assert.equal(hasPluginHeart("failed.plugin", storage), false);
});

test("parallel heart attempts share one in-flight request", async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
  };
  let requests = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const options = {
    storage,
    locationRef: productionLocation,
    fetchImpl: async () => {
      requests += 1;
      await gate;
      return responseJson({
        recorded: true,
        plugin: { views: 9, copies: 4, hearts: 6 },
      }, { status: 202 });
    },
  };
  const first = recordPluginHeart("parallel.plugin", options);
  const second = recordPluginHeart("parallel.plugin", options);
  assert.equal(requests, 1);
  release();
  assert.deepEqual(await Promise.all([first, second]), [
    { recorded: true, stats: { views: 9, copies: 4, hearts: 6 } },
    { recorded: true, stats: { views: 9, copies: 4, hearts: 6 } },
  ]);
  assert.equal(hasPluginHeart("parallel.plugin", storage), true);
});

test("failed engagement loads can clear pending UI state", () => {
  const elements = [
    { hidden: false, classList: { remove(value) { assert.equal(value, "is-pending"); } }, removeAttribute(value) { assert.equal(value, "aria-busy"); } },
    { hidden: false, classList: { remove(value) { assert.equal(value, "is-pending"); } }, removeAttribute(value) { assert.equal(value, "aria-busy"); } },
  ];
  hidePendingEngagement({
    querySelectorAll(selector) {
      assert.equal(selector, ".plugin-engagement.is-pending, .plugin-heart.is-pending");
      return elements;
    },
  });
  assert.equal(elements.every((element) => element.hidden), true);
});

test("Worker event parsing rejects extra fields and unsupported values", () => {
  assert.deepEqual(parseEngagementEvent({ pluginId: "example.plugin", type: "view" }), {
    pluginId: "example.plugin",
    type: "view",
  });
  assert.deepEqual(parseEngagementEvent({ pluginId: "example.plugin", type: "heart" }), {
    pluginId: "example.plugin",
    type: "heart",
  });
  assert.equal(parseEngagementEvent({ pluginId: "example.plugin", type: "install" }), null);
  assert.equal(parseEngagementEvent({ pluginId: "__proto__", type: "copy" }), null);
  assert.equal(parseEngagementEvent({ pluginId: "example.plugin", type: "copy", token: "secret" }), null);
});

test("Worker exposes aggregate stats with restricted CORS and no credentials", async () => {
  const database = fakeDatabase([
    { plugin_id: "example.plugin", views: 8, copies: 3, hearts: 5 },
    { plugin_id: "bad id", views: 99, copies: 99, hearts: 99 },
  ]);
  const response = await handleRequest(new Request("https://api.omarchyplugins.com/v1/stats", {
    headers: { Origin: "https://omarchyplugins.com" },
  }), { ENGAGEMENT_DB: database });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), {
    schemaVersion: 1,
    plugins: { "example.plugin": { views: 8, copies: 3, hearts: 5 } },
  });
  assert.equal(database.calls[0].operation, "all");
});

test("Worker permits canonical and legacy origins exactly", async () => {
  const env = { ENGAGEMENT_DB: fakeDatabase() };
  for (const origin of [
    "https://plugins.omarchy.org",
    "https://omarchyplugins.com",
    "https://www.omarchyplugins.com",
  ]) {
    const response = await handleRequest(new Request("https://api.omarchyplugins.com/v1/events", {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "POST",
      },
    }), env);
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), origin);
  }
  for (const origin of [
    "http://plugins.omarchy.org",
    "https://plugins.omarchy.org.evil.example",
    "https://www.plugins.omarchy.org",
    "https://plugins.omarchy.org:444",
  ]) {
    const response = await handleRequest(new Request("https://api.omarchyplugins.com/v1/events", {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "POST",
      },
    }), env);
    assert.equal(response.status, 403);
    assert.equal(response.headers.has("Access-Control-Allow-Origin"), false);
  }
});

test("Worker rejects streamed oversized event bodies without buffering or catalog access", async () => {
  const database = fakeDatabase();
  const rateLimiter = fakeRateLimiter();
  const request = new Request("https://api.omarchyplugins.com/v1/events", {
    method: "POST",
    headers: eventHeaders(),
    body: JSON.stringify({ pluginId: "example.plugin", type: "copy", padding: "x".repeat(1100) }),
  });
  assert.equal(request.headers.has("Content-Length"), false);
  const response = await handleRequest(request, {
    ENGAGEMENT_DB: database,
    ENGAGEMENT_RATE_LIMITER: rateLimiter,
  }, {
    fetchImpl: async () => { throw new Error("must not fetch"); },
  });
  assert.equal(response.status, 413);
  assert.equal(database.calls.length, 0);
  assert.equal(rateLimiter.keys.length, 1);
});

test("Worker rate limiting runs before request body, catalog, and D1 access", async () => {
  const database = fakeDatabase();
  const rateLimiter = fakeRateLimiter(false);
  let bodyAccessed = false;
  const request = {
    url: "https://api.omarchyplugins.com/v1/events",
    method: "POST",
    headers: new Headers({
      "CF-Connecting-IP": "192.0.2.1",
      "Content-Type": "application/json",
      Origin: "https://omarchyplugins.com",
    }),
    get body() {
      bodyAccessed = true;
      throw new Error("body must not be accessed");
    },
  };
  const response = await handleRequest(request, {
    ENGAGEMENT_DB: database,
    ENGAGEMENT_RATE_LIMITER: rateLimiter,
  }, {
    fetchImpl: async () => { throw new Error("catalog must not be fetched"); },
  });
  assert.equal(response.status, 429);
  assert.equal(bodyAccessed, false);
  assert.equal(response.headers.get("Retry-After"), "60");
  assert.deepEqual(rateLimiter.keys, ["events:v4:192.0.2.1"]);
  assert.equal(database.calls.length, 0);
});

test("Worker fails closed when its target limiter is unavailable", async () => {
  const database = fakeDatabase();
  const response = await handleRequest(new Request("https://api.omarchyplugins.com/v1/events", {
    method: "POST",
    headers: eventHeaders(),
    body: JSON.stringify({ pluginId: "example.plugin", type: "copy" }),
  }), {
    ENGAGEMENT_DB: database,
    ENGAGEMENT_RATE_LIMITER: fakeRateLimiter(),
    CATALOG_URL: "https://catalog-target-config.example/catalog.json",
    ...testMinuteLimitVars,
  }, {
    fetchImpl: async () => responseJson({ plugins: [{ id: "example.plugin" }] }),
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Event service unavailable" });
  assert.equal(database.calls.length, 0);
});

test("Worker applies a generic target limiter before D1 access", async () => {
  const database = fakeDatabase();
  const outerRateLimiter = fakeRateLimiter();
  const targetRateLimiter = fakeRateLimiter(false);
  const response = await handleRequest(new Request("https://api.omarchyplugins.com/v1/events", {
    method: "POST",
    headers: eventHeaders({ ip: "192.0.2.8" }),
    body: JSON.stringify({ pluginId: "example.plugin", type: "copy" }),
  }), {
    ENGAGEMENT_DB: database,
    ENGAGEMENT_RATE_LIMITER: outerRateLimiter,
    ENGAGEMENT_TARGET_RATE_LIMITER: targetRateLimiter,
    CATALOG_URL: "https://catalog-target.example/catalog.json",
    ...testMinuteLimitVars,
  }, {
    fetchImpl: async () => responseJson({ plugins: [{ id: "example.plugin" }] }),
  });
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: "Rate limit exceeded" });
  assert.equal(response.headers.get("Retry-After"), "60");
  assert.deepEqual(outerRateLimiter.keys, ["events:v4:192.0.2.8"]);
  assert.deepEqual(targetRateLimiter.keys, ["target:v4:192.0.2.8:example.plugin:copy"]);
  assert.equal(database.calls.length, 0);
});

test("Worker fails closed when aggregate limit configuration is unavailable", async () => {
  const database = fakeDatabase();
  const response = await handleRequest(new Request("https://api.omarchyplugins.com/v1/events", {
    method: "POST",
    headers: eventHeaders(),
    body: JSON.stringify({ pluginId: "example.plugin", type: "view" }),
  }), {
    ENGAGEMENT_DB: database,
    ENGAGEMENT_RATE_LIMITER: fakeRateLimiter(),
    ENGAGEMENT_TARGET_RATE_LIMITER: fakeRateLimiter(),
    CATALOG_URL: "https://catalog-config.example/catalog.json",
  }, {
    fetchImpl: async () => responseJson({ plugins: [{ id: "example.plugin" }] }),
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Event service unavailable" });
  assert.equal(database.calls.length, 0);
});

test("Worker treats an aggregate event ceiling as a real no-op", async () => {
  const database = fakeDatabase([], { recorded: null });
  const response = await handleRequest(new Request("https://api.omarchyplugins.com/v1/events", {
    method: "POST",
    headers: eventHeaders(),
    body: JSON.stringify({ pluginId: "example.plugin", type: "view" }),
  }), {
    ENGAGEMENT_DB: database,
    ENGAGEMENT_RATE_LIMITER: fakeRateLimiter(),
    ENGAGEMENT_TARGET_RATE_LIMITER: fakeRateLimiter(),
    CATALOG_URL: "https://catalog-limit.example/catalog.json",
    ...testMinuteLimitVars,
  }, {
    cache: fakeCache(),
    fetchImpl: async () => responseJson({ plugins: [{ id: "example.plugin" }] }),
  });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { recorded: false, reason: "limit" });
  assert.equal(database.calls.length, 2);
  assert.equal(database.calls.every((call) => call.operation === "batch"), true);
});

test("Worker returns no success when its transactional write-and-totals batch fails", async () => {
  const database = fakeDatabase([], { batchError: new Error("totals failed") });
  const response = await handleRequest(new Request("https://api.omarchyplugins.com/v1/events", {
    method: "POST",
    headers: eventHeaders(),
    body: JSON.stringify({ pluginId: "example.plugin", type: "heart" }),
  }), {
    ENGAGEMENT_DB: database,
    ENGAGEMENT_RATE_LIMITER: fakeRateLimiter(),
    ENGAGEMENT_TARGET_RATE_LIMITER: fakeRateLimiter(),
    CATALOG_URL: "https://catalog-batch.example/catalog.json",
    ...testMinuteLimitVars,
  }, {
    cache: fakeCache(),
    fetchImpl: async () => responseJson({ plugins: [{ id: "example.plugin" }] }),
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Event service unavailable" });
  assert.equal(database.calls.length, 2);
  assert.equal(database.calls.every((call) => call.operation === "batch"), true);
  assert.match(database.calls[0].sql, /RETURNING plugin_id/);
  assert.match(database.calls[1].sql, /SELECT SUM\(views\)/);
});

test("Worker upserts never lower unrelated counters after a limit reduction", async () => {
  const [schema, burstMigration, checkMigration] = await Promise.all([
    readFile(new URL("../worker/migrations/0001_plugin_engagement.sql", import.meta.url), "utf8"),
    readFile(new URL("../worker/migrations/0002_plugin_engagement_burst_limits.sql", import.meta.url), "utf8"),
    readFile(new URL("../worker/migrations/0003_fix_engagement_minute_checks.sql", import.meta.url), "utf8"),
  ]);
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(schema);
    database.prepare(`
      INSERT INTO plugin_engagement_daily (plugin_id, day, views, copies, hearts)
      VALUES (?1, ?2, ?3, ?4, ?5)
    `).run("example.plugin", "2026-08-16", 10_000, 499, 700);
    database.exec(burstMigration);
    database.exec(checkMigration);
    const migrated = database.prepare(`
      SELECT views, copies, hearts,
        views_minute, views_minute_count,
        copies_minute, copies_minute_count,
        hearts_minute, hearts_minute_count
      FROM plugin_engagement_daily WHERE plugin_id = ?1
    `).get("example.plugin");
    assert.deepEqual({ ...migrated }, {
      views: 10_000,
      copies: 499,
      hearts: 700,
      views_minute: null,
      views_minute_count: 0,
      copies_minute: null,
      copies_minute_count: 0,
      hearts_minute: null,
      hearts_minute_count: 0,
    });

    const updated = database.prepare(engagementUpsertStatement())
      .get("example.plugin", "2026-08-16", "2026-08-16T12:00", 0, 1, 0, 500, 10, 10, 10);
    assert.equal(updated.plugin_id, "example.plugin");
    const afterCopy = database.prepare(`
      SELECT views, copies, hearts FROM plugin_engagement_daily WHERE plugin_id = ?1
    `).get("example.plugin");
    assert.deepEqual({ ...afterCopy }, { views: 10_000, copies: 500, hearts: 700 });

    const capped = database.prepare(engagementUpsertStatement())
      .get("example.plugin", "2026-08-16", "2026-08-16T12:00", 0, 0, 1, 500, 10, 10, 10);
    assert.equal(capped, undefined);
    const afterHeart = database.prepare(`
      SELECT views, copies, hearts FROM plugin_engagement_daily WHERE plugin_id = ?1
    `).get("example.plugin");
    assert.deepEqual({ ...afterHeart }, { views: 10_000, copies: 500, hearts: 700 });
  } finally {
    database.close();
  }
});

test("Worker atomically enforces per-plugin minute ceilings without actor records", async () => {
  const [schema, burstMigration, checkMigration] = await Promise.all([
    readFile(new URL("../worker/migrations/0001_plugin_engagement.sql", import.meta.url), "utf8"),
    readFile(new URL("../worker/migrations/0002_plugin_engagement_burst_limits.sql", import.meta.url), "utf8"),
    readFile(new URL("../worker/migrations/0003_fix_engagement_minute_checks.sql", import.meta.url), "utf8"),
  ]);
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(schema);
    database.exec(burstMigration);
    database.exec(checkMigration);
    const write = database.prepare(engagementUpsertStatement());
    const values = (minute, views, copies, hearts) => [
      "example.plugin", "2026-08-17", minute, views, copies, hearts, 100, 2, 1, 1,
    ];

    assert.equal(write.get(...values("2026-08-17T12:00", 1, 0, 0)).plugin_id, "example.plugin");
    const invalidMinutes = [
      "T026-08-17T12:00",
      "2026-0T-17T12:00",
      "2026-08-T7T12:00",
      "2026-08-17T1-:00",
      "2026-08-17T12:0T",
      "2026/08-17T12:00",
      "2026-08/17T12:00",
      "2026-08-17 12:00",
      "2026-08-17T12-00",
      "2026-08-17T12:0",
      "2026-08-17T12:000",
    ];
    for (const column of ["views_minute", "copies_minute", "hearts_minute"]) {
      const updateMinute = database.prepare(`
        UPDATE plugin_engagement_daily SET ${column} = ?1 WHERE plugin_id = ?2
      `);
      for (const invalidMinute of invalidMinutes) {
        assert.throws(
          () => updateMinute.run(invalidMinute, "example.plugin"),
          /CHECK constraint failed/,
        );
      }
    }
    assert.equal(write.get(...values("2026-08-17T12:00", 1, 0, 0)).plugin_id, "example.plugin");
    assert.equal(write.get(...values("2026-08-17T12:00", 1, 0, 0)), undefined);
    assert.equal(write.get(...values("2026-08-17T12:01", 1, 0, 0)).plugin_id, "example.plugin");
    assert.equal(write.get(...values("2026-08-17T12:00", 1, 0, 0)), undefined);
    assert.equal(write.get(...values("2026-08-17T12:01", 1, 0, 0)).plugin_id, "example.plugin");
    assert.equal(write.get(...values("2026-08-17T12:01", 1, 0, 0)), undefined);
    assert.equal(write.get(...values("2026-08-17T12:01", 0, 1, 0)).plugin_id, "example.plugin");
    assert.equal(write.get(...values("2026-08-17T12:01", 0, 1, 0)), undefined);
    assert.equal(write.get(...values("2026-08-17T12:01", 0, 0, 1)).plugin_id, "example.plugin");
    assert.equal(write.get(...values("2026-08-17T12:01", 0, 0, 1)), undefined);

    const row = database.prepare(`
      SELECT views, copies, hearts,
        views_minute, views_minute_count,
        copies_minute, copies_minute_count,
        hearts_minute, hearts_minute_count
      FROM plugin_engagement_daily WHERE plugin_id = ?1
    `).get("example.plugin");
    assert.deepEqual({ ...row }, {
      views: 4,
      copies: 1,
      hearts: 1,
      views_minute: "2026-08-17T12:01",
      views_minute_count: 2,
      copies_minute: "2026-08-17T12:01",
      copies_minute_count: 1,
      hearts_minute: "2026-08-17T12:01",
      hearts_minute_count: 1,
    });
  } finally {
    database.close();
  }
});

test("Worker caches aggregate stats at the edge while disabling browser storage", async () => {
  const database = fakeDatabase([{ plugin_id: "example.plugin", views: 8, copies: 3, hearts: 5 }]);
  const values = new Map();
  const storedCacheControls = [];
  const cache = {
    async match(request) {
      return values.get(request.url)?.clone();
    },
    async put(request, response) {
      storedCacheControls.push(response.headers.get("Cache-Control"));
      values.set(request.url, response.clone());
    },
  };
  const pending = [];
  const options = {
    cache,
    waitUntil: (promise) => pending.push(promise),
  };
  const request = new Request("https://api.omarchyplugins.com/v1/stats", {
    headers: { Origin: "https://omarchyplugins.com" },
  });
  const first = await handleRequest(request, { ENGAGEMENT_DB: database }, options);
  assert.equal(first.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(first.headers.get("Cache-Control"), "no-store");
  await Promise.all(pending);
  assert.deepEqual(storedCacheControls, ["public, max-age=60, s-maxage=300"]);
  const second = await handleRequest(request, { ENGAGEMENT_DB: database }, options);
  assert.equal(second.status, 200);
  assert.equal(second.headers.get("Cache-Control"), "no-store");
  assert.equal(database.calls.length, 1);
});

test("Worker records only known catalog plugins from allowed origins", async () => {
  const database = fakeDatabase();
  const rateLimiter = fakeRateLimiter();
  const targetRateLimiter = fakeRateLimiter();
  const env = {
    ENGAGEMENT_DB: database,
    ENGAGEMENT_RATE_LIMITER: rateLimiter,
    ENGAGEMENT_TARGET_RATE_LIMITER: targetRateLimiter,
    CATALOG_URL: "https://catalog-one.example/catalog.json",
    DAILY_EVENT_LIMIT: "500",
    ...testMinuteLimitVars,
  };
  const fetchImpl = async () => responseJson({ plugins: [{ id: "example.plugin" }] });
  const request = (pluginId, origin = "https://omarchyplugins.com", type = "heart") => new Request(
    "https://api.omarchyplugins.com/v1/events",
    {
      method: "POST",
      headers: eventHeaders({ origin }),
      body: JSON.stringify({ pluginId, type }),
    },
  );

  const response = await handleRequest(request("example.plugin"), env, {
    cache: fakeCache(),
    fetchImpl,
  });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    recorded: true,
    plugin: { views: 9, copies: 4, hearts: 3 },
  });
  assert.equal(database.calls[0].operation, "batch");
  assert.equal(database.calls[0].values[0], "example.plugin");
  assert.match(database.calls[0].values[1], /^\d{4}-\d{2}-\d{2}$/);
  assert.match(database.calls[0].values[2], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  assert.deepEqual(database.calls[0].values.slice(3), [0, 0, 1, 500, 2, 2, 2]);
  assert.match(database.calls[1].sql, /SELECT SUM\(views\)/);
  assert.match(rateLimiter.keys[0], /^events:/);
  assert.match(targetRateLimiter.keys[0], /^target:/);

  const canonical = await handleRequest(
    request("example.plugin", "https://plugins.omarchy.org", "copy"),
    env,
    { cache: fakeCache(), fetchImpl },
  );
  assert.equal(canonical.status, 202);
  assert.equal(canonical.headers.get("Access-Control-Allow-Origin"), "https://plugins.omarchy.org");

  const unknown = await handleRequest(request("unknown.plugin"), env, { fetchImpl });
  assert.equal(unknown.status, 404);
  const forbidden = await handleRequest(request("example.plugin", "https://attacker.example"), env, { fetchImpl });
  assert.equal(forbidden.status, 403);
  assert.equal(database.calls.length, 4);
});

test("Worker rejects events without a usable client address before reading the body", async () => {
  const database = fakeDatabase();
  const rateLimiter = fakeRateLimiter();
  let bodyAccessed = false;
  const request = {
    url: "https://api.omarchyplugins.com/v1/events",
    method: "POST",
    headers: new Headers({
      "Content-Type": "application/json",
      Origin: "https://omarchyplugins.com",
    }),
    get body() {
      bodyAccessed = true;
      throw new Error("body must not be accessed");
    },
  };
  const missing = await handleRequest(request, {
    ENGAGEMENT_DB: database,
    ENGAGEMENT_RATE_LIMITER: rateLimiter,
  });
  assert.equal(missing.status, 429);
  assert.equal(bodyAccessed, false);
  assert.equal(rateLimiter.keys.length, 0);
  assert.equal(database.calls.length, 0);

  const invalid = await handleRequest(new Request("https://api.omarchyplugins.com/v1/events", {
    method: "POST",
    headers: eventHeaders({ ip: "not-an-ip" }),
    body: JSON.stringify({ pluginId: "example.plugin", type: "heart" }),
  }), {
    ENGAGEMENT_DB: database,
    ENGAGEMENT_RATE_LIMITER: rateLimiter,
  });
  assert.equal(invalid.status, 429);
  assert.equal(database.calls.length, 0);
});

test("normalizeClientAddress maps IPv4, mapped IPv6, and IPv6 /64 prefixes", () => {
  assert.equal(normalizeClientAddress("192.0.2.1"), "v4:192.0.2.1");
  assert.equal(normalizeClientAddress("::ffff:192.0.2.1"), "v4:192.0.2.1");
  assert.equal(normalizeClientAddress("0:0:0:0:0:ffff:192.0.2.1"), "v4:192.0.2.1");
  assert.equal(normalizeClientAddress("::ffff:c000:201"), "v4:192.0.2.1");
  assert.equal(normalizeClientAddress("2001:db8:1:2::1"), "v6:2001:0db8:0001:0002/64");
  assert.equal(normalizeClientAddress("2001:DB8:1:2:0:0:0:ffff"), "v6:2001:0db8:0001:0002/64");
  assert.equal(normalizeClientAddress("2001:db8:1:3::1"), "v6:2001:0db8:0001:0003/64");
  assert.equal(normalizeClientAddress("[2001:db8:1:2::1]"), "v6:2001:0db8:0001:0002/64");
  assert.equal(normalizeClientAddress("::1"), "v6:0000:0000:0000:0000/64");
  assert.equal(normalizeClientAddress(""), "");
  assert.equal(normalizeClientAddress("999.0.2.1"), "");
  assert.equal(normalizeClientAddress("2001:db8::1::2"), "");
});

test("sliding windows reject overflow until the oldest event expires", async () => {
  const cache = fakeCache();
  const now = Date.parse("2026-08-21T12:00:00.000Z");
  const first = await consumeSlidingWindow(cache, {
    key: "hearts",
    limit: 1,
    windowSeconds: 60,
    now,
  });
  const blocked = await consumeSlidingWindow(cache, {
    key: "hearts",
    limit: 1,
    windowSeconds: 60,
    now: now + 59_000,
  });
  const reopened = await consumeSlidingWindow(cache, {
    key: "hearts",
    limit: 1,
    windowSeconds: 60,
    now: now + 60_000,
  });
  assert.equal(first.success, true);
  assert.equal(blocked.success, false);
  assert.equal(blocked.retryAfter, 1);
  assert.equal(reopened.success, true);
});

test("Worker address windows stop repeat hearts from one address without D1 actor keys", async () => {
  const database = fakeDatabase();
  const cache = fakeCache();
  const now = Date.parse("2026-08-21T12:00:00.000Z");
  const env = {
    ENGAGEMENT_DB: database,
    ENGAGEMENT_RATE_LIMITER: fakeRateLimiter(),
    ENGAGEMENT_TARGET_RATE_LIMITER: fakeRateLimiter(),
    CATALOG_URL: "https://catalog-address.example/catalog.json",
    ...testMinuteLimitVars,
  };
  const options = {
    cache,
    fetchImpl: async () => responseJson({ plugins: [{ id: "example.plugin" }] }),
    now,
  };
  const request = () => new Request("https://api.omarchyplugins.com/v1/events", {
    method: "POST",
    headers: eventHeaders(),
    body: JSON.stringify({ pluginId: "example.plugin", type: "heart" }),
  });

  const first = await handleRequest(request(), env, options);
  assert.equal(first.status, 202);
  assert.deepEqual(await first.json(), {
    recorded: true,
    plugin: { views: 9, copies: 4, hearts: 3 },
  });
  assert.equal(database.calls.length, 2);

  const blocked = await handleRequest(request(), env, options);
  assert.equal(blocked.status, 429);
  assert.deepEqual(await blocked.json(), { error: "Rate limit exceeded" });
  assert.equal(blocked.headers.get("Retry-After"), "86400");
  assert.equal(database.calls.length, 2);
  assert.equal([...cache.values.keys()].every((url) => (
    url.startsWith("https://engagement-quota.invalid/")
    && !url.includes("192.0.2.1")
    && !url.includes("example.plugin")
  )), true);

  const later = await handleRequest(request(), env, {
    ...options,
    now: now + 86_400_000,
  });
  assert.equal(later.status, 202);
  assert.equal(database.calls.length, 4);
});

test("Worker shares IPv6 /64 quota across interface IDs", async () => {
  const database = fakeDatabase();
  const cache = fakeCache();
  const env = {
    ENGAGEMENT_DB: database,
    ENGAGEMENT_RATE_LIMITER: fakeRateLimiter(),
    ENGAGEMENT_TARGET_RATE_LIMITER: fakeRateLimiter(),
    CATALOG_URL: "https://catalog-v6.example/catalog.json",
    ...testMinuteLimitVars,
  };
  const post = (ip) => handleRequest(new Request("https://api.omarchyplugins.com/v1/events", {
    method: "POST",
    headers: eventHeaders({ ip }),
    body: JSON.stringify({ pluginId: "example.plugin", type: "heart" }),
  }), env, {
    cache,
    fetchImpl: async () => responseJson({ plugins: [{ id: "example.plugin" }] }),
    now: Date.parse("2026-08-21T15:00:00.000Z"),
  });

  assert.equal((await post("2001:db8:1:2::1")).status, 202);
  assert.equal((await post("2001:db8:1:2:0:0:0:ffff")).status, 429);
  assert.equal((await post("2001:db8:1:3::1")).status, 202);
  assert.equal(database.calls.length, 4);
});

test("Worker hour windows cap spray across plugins from one address", async () => {
  const database = fakeDatabase();
  const cache = fakeCache();
  const env = {
    ENGAGEMENT_DB: database,
    ENGAGEMENT_RATE_LIMITER: fakeRateLimiter(),
    ENGAGEMENT_TARGET_RATE_LIMITER: fakeRateLimiter(),
    CATALOG_URL: "https://catalog-spray.example/catalog.json",
    HEART_ADDRESS_HOUR_EVENT_LIMIT: "2",
    ...testMinuteLimitVars,
  };
  const plugins = [{ id: "alpha.plugin" }, { id: "beta.plugin" }, { id: "gamma.plugin" }];
  const post = (pluginId) => handleRequest(new Request("https://api.omarchyplugins.com/v1/events", {
    method: "POST",
    headers: eventHeaders(),
    body: JSON.stringify({ pluginId, type: "heart" }),
  }), env, {
    cache,
    fetchImpl: async () => responseJson({ plugins }),
    now: Date.parse("2026-08-21T16:00:00.000Z"),
  });

  assert.equal((await post("alpha.plugin")).status, 202);
  assert.equal((await post("beta.plugin")).status, 202);
  const blocked = await post("gamma.plugin");
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get("Retry-After"), "3600");
  assert.equal(database.calls.length, 4);
});

test("Worker fails closed when the address-window cache is unavailable", async () => {
  const database = fakeDatabase();
  const response = await handleRequest(new Request("https://api.omarchyplugins.com/v1/events", {
    method: "POST",
    headers: eventHeaders(),
    body: JSON.stringify({ pluginId: "example.plugin", type: "copy" }),
  }), {
    ENGAGEMENT_DB: database,
    ENGAGEMENT_RATE_LIMITER: fakeRateLimiter(),
    ENGAGEMENT_TARGET_RATE_LIMITER: fakeRateLimiter(),
    CATALOG_URL: "https://catalog-cache.example/catalog.json",
    ...testMinuteLimitVars,
  }, {
    cache: {},
    fetchImpl: async () => responseJson({ plugins: [{ id: "example.plugin" }] }),
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Event service unavailable" });
  assert.equal(database.calls.length, 0);
});

test("Worker deployment files contain placeholders but no credentials", async () => {
  const root = new URL("../", import.meta.url);
  const [ignore, template, migration, burstMigration, checkMigration, workerSource, clientSource] = await Promise.all([
    readFile(new URL(".gitignore", root), "utf8"),
    readFile(new URL("worker/wrangler.example.jsonc", root), "utf8"),
    readFile(new URL("worker/migrations/0001_plugin_engagement.sql", root), "utf8"),
    readFile(new URL("worker/migrations/0002_plugin_engagement_burst_limits.sql", root), "utf8"),
    readFile(new URL("worker/migrations/0003_fix_engagement_minute_checks.sql", root), "utf8"),
    readFile(new URL("worker/src/index.js", root), "utf8"),
    readFile(new URL("site/assets/js/engagement.js", root), "utf8"),
  ]);
  assert.match(ignore, /worker\/wrangler\.jsonc/);
  assert.match(ignore, /worker\/\.dev\.vars\*/);
  assert.match(template, /REPLACE_WITH_D1_DATABASE_ID/);
  assert.match(template, /"name": "ENGAGEMENT_RATE_LIMITER"/);
  assert.match(template, /"simple": \{ "limit": 60, "period": 60 \}/);
  assert.match(template, /"name": "ENGAGEMENT_TARGET_RATE_LIMITER"/);
  assert.match(template, /REPLACE_WITH_TARGET_RATE_LIMIT/);
  const configuredTemplate = template.replace('"REPLACE_WITH_TARGET_RATE_LIMIT"', "7");
  assert.match(configuredTemplate, /"simple": \{ "limit": 7, "period": 60 \}/);
  assert.doesNotMatch(configuredTemplate, /"limit": "7"/);
  assert.match(template, /REPLACE_WITH_VIEW_MINUTE_LIMIT/);
  assert.match(template, /REPLACE_WITH_COPY_MINUTE_LIMIT/);
  assert.match(template, /REPLACE_WITH_HEART_MINUTE_LIMIT/);
  assert.doesNotMatch(template, /api[_-]?token|account[_-]?token|bearer\s+[A-Za-z0-9]/i);
  assert.match(migration, /hearts INTEGER NOT NULL DEFAULT 0/);
  assert.match(migration, /PRIMARY KEY \(plugin_id, day\)/);
  assert.match(burstMigration, /ADD COLUMN views_minute TEXT/);
  assert.match(burstMigration, /ADD COLUMN copies_minute_count INTEGER NOT NULL DEFAULT 0/);
  assert.match(burstMigration, /ADD COLUMN hearts_minute_count INTEGER NOT NULL DEFAULT 0/);
  assert.doesNotMatch(burstMigration, /actor|browser|ip_address/i);
  assert.match(checkMigration, /DROP COLUMN views_minute/);
  assert.match(checkMigration, /substr\(views_minute, 11, 1\) = 'T'/);
  assert.match(checkMigration, /substr\(views_minute, 1, 4\) NOT GLOB '\*\[\^0-9\]\*'/);
  assert.match(checkMigration, /substr\(hearts_minute, 15, 2\) NOT GLOB '\*\[\^0-9\]\*'/);
  assert.doesNotMatch(checkMigration, /actor|browser|ip_address/i);
  assert.doesNotMatch(`${workerSource}${clientSource}`, /actorId|actor_hash|omarchy-plugin-actor/i);
  assert.match(workerSource, /engagement-quota\.invalid/);
  assert.match(workerSource, /normalizeClientAddress/);
  assert.doesNotMatch(engagementUpsertStatement(), /ip_address|client_address|quota/i);
});
