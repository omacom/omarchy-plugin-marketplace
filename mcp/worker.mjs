import { createGithubInspector } from "./github-inspector.mjs";
import { currentProtocolVersion, handleMcpMessage, parseJsonRpc } from "./protocol.mjs";
import { createRemotePreviewProvider, createRemoteStateLoader } from "./remote-adapters.mjs";
import { createMarketplaceService } from "./service.mjs";

const bodyByteLimit = 1024 * 1024;
const defaultOrigins = new Set([
  "https://omarchyplugins.com",
  "https://www.omarchyplugins.com",
  "http://127.0.0.1:4173",
  "http://localhost:4173",
]);

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "MCP-Protocol-Version": currentProtocolVersion,
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

function rpcError(id, code, message, data) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

function allowedOrigins(env) {
  const configured = String(env.MCP_ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return new Set([...defaultOrigins, ...configured]);
}

function corsHeaders(origin, env) {
  if (!origin || !allowedOrigins(env).has(origin)) return { Vary: "Origin" };
  return {
    "Access-Control-Allow-Headers": [
      "Content-Type",
      "MCP-Protocol-Version",
      "Mcp-Method",
      "Mcp-Name",
    ].join(", "),
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Expose-Headers": "MCP-Protocol-Version, Retry-After",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

async function readLimitedBody(request) {
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > bodyByteLimit) return null;
  if (!request.body?.getReader) {
    const text = await request.text();
    return new TextEncoder().encode(text).byteLength <= bodyByteLimit ? text : null;
  }
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      size += value.byteLength;
      if (size > bodyByteLimit) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

function namedParameter(message) {
  if (message.method === "tools/call" || message.method === "prompts/get") {
    return message.params?.name;
  }
  if (message.method === "resources/read") return message.params?.uri;
  return undefined;
}

function validateModernHeaders(request, message) {
  const protocol = request.headers.get("MCP-Protocol-Version");
  if (protocol !== currentProtocolVersion) {
    return rpcError(message?.id, -32022, "Unsupported protocol version", {
      supportedVersions: [currentProtocolVersion],
    });
  }
  const bodyProtocol = message?.params?._meta?.["io.modelcontextprotocol/protocolVersion"];
  if (bodyProtocol !== currentProtocolVersion) {
    return rpcError(message?.id, -32022, "Request metadata protocol version is missing or unsupported");
  }
  if (request.headers.get("Mcp-Method") !== message.method) {
    return rpcError(message?.id, -32020, "Header mismatch", { header: "Mcp-Method" });
  }
  const expectedName = namedParameter(message);
  const actualName = request.headers.get("Mcp-Name");
  if (expectedName !== undefined && actualName !== expectedName) {
    return rpcError(message?.id, -32020, "Header mismatch", { header: "Mcp-Name" });
  }
  if (expectedName === undefined && actualName !== null) {
    return rpcError(message?.id, -32020, "Header mismatch", { header: "Mcp-Name" });
  }
  return null;
}

function remoteService(env, fetchImpl) {
  const inspector = createGithubInspector({
    fetchImpl,
    token: env.GITHUB_TOKEN || "",
  });
  return createMarketplaceService({
    loadState: createRemoteStateLoader({ env, fetchImpl }),
    inspector,
    previewProvider: createRemotePreviewProvider({ env, fetchImpl, inspector }),
  });
}

export async function handleRequest(request, env = {}, { fetchImpl = globalThis.fetch } = {}) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin") || "";
  if (origin && !allowedOrigins(env).has(origin)) {
    return json({ error: "Origin not allowed" }, 403, { Vary: "Origin" });
  }
  if (url.pathname === "/health") {
    if (request.method !== "GET") return json({ error: "Method not allowed" }, 405, { Allow: "GET" });
    return json({ status: "ok", protocolVersion: currentProtocolVersion }, 200, corsHeaders(origin, env));
  }
  if (url.pathname !== "/mcp") return json({ error: "Not found" }, 404, corsHeaders(origin, env));
  if (request.method === "OPTIONS") {
    if (!origin) return new Response(null, { status: 403 });
    return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
  }
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405, { Allow: "POST", ...corsHeaders(origin, env) });
  }
  if (!env.MCP_RATE_LIMITER?.limit) {
    return json({ error: "Rate limiter unavailable" }, 503, corsHeaders(origin, env));
  }
  const requestIp = request.headers.get("CF-Connecting-IP") || "unknown";
  let rateLimit;
  try {
    rateLimit = await env.MCP_RATE_LIMITER.limit({ key: `mcp:${requestIp}` });
  } catch {
    return json({ error: "Rate limiter unavailable" }, 503, corsHeaders(origin, env));
  }
  if (!rateLimit.success) {
    return json({ error: "Rate limit exceeded" }, 429, {
      "Retry-After": "60",
      ...corsHeaders(origin, env),
    });
  }
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return json({ error: "Expected a JSON request" }, 415, corsHeaders(origin, env));
  }
  let body;
  try {
    body = await readLimitedBody(request);
  } catch {
    return json({ error: "Request body unavailable" }, 400, corsHeaders(origin, env));
  }
  if (body === null) return json({ error: "Request body too large" }, 413, corsHeaders(origin, env));
  const parsed = parseJsonRpc(body);
  if (parsed.error) return json(parsed.error, 400, corsHeaders(origin, env));
  const headerError = validateModernHeaders(request, parsed.message);
  if (headerError) return json(headerError, 400, corsHeaders(origin, env));
  const githubTool = parsed.message.method === "tools/call"
    && (
      parsed.message.params?.name === "review_candidate"
      || (
        parsed.message.params?.name === "get_preview"
        && parsed.message.params?.arguments?.repository
      )
    );
  if (githubTool) {
    if (!env.MCP_GITHUB_RATE_LIMITER?.limit) {
      return json({ error: "Candidate inspection rate limiter unavailable" }, 503, corsHeaders(origin, env));
    }
    let githubRateLimit;
    try {
      githubRateLimit = await env.MCP_GITHUB_RATE_LIMITER.limit({ key: `github:${requestIp}` });
    } catch {
      return json({ error: "Candidate inspection rate limiter unavailable" }, 503, corsHeaders(origin, env));
    }
    if (!githubRateLimit.success) {
      return json({ error: "Candidate inspection rate limit exceeded" }, 429, {
        "Retry-After": "60",
        ...corsHeaders(origin, env),
      });
    }
  }
  const result = await handleMcpMessage(
    parsed.message,
    remoteService(env, fetchImpl),
    {
      protocolVersion: currentProtocolVersion,
      protocolVersions: [currentProtocolVersion],
    },
  );
  if (!result) return new Response(null, { status: 202, headers: corsHeaders(origin, env) });
  return json(result, 200, corsHeaders(origin, env));
}

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
};
