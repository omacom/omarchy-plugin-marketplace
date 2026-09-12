import { MarketplaceMcpError, safeError } from "./errors.mjs";
import { toolDefinitions } from "./contracts.mjs";

export const currentProtocolVersion = "2026-07-28";
export const supportedProtocolVersions = Object.freeze([
  currentProtocolVersion,
  "2025-11-25",
  "2025-06-18",
]);
export const serverInfo = Object.freeze({
  name: "omarchy-plugin-marketplace",
  title: "Omarchy Plugin Marketplace",
  version: "0.1.0",
});

const instructions = "Use search_plugins and get_plugin for marketplace discovery. Use review_candidate before preparing a submission; inspect its exact conflicts, advisory similarities, metadata checks, and preview. MCP results are read-only and are not security reviews or approval decisions.";

function response(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(id, code, message, data) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
  };
}

function requestVersion(message, fallback = "") {
  return message?.params?._meta?.["io.modelcontextprotocol/protocolVersion"] || fallback;
}

function modernResult(result, modern, { cacheable = false } = {}) {
  if (!modern) return result;
  return {
    resultType: "complete",
    ...result,
    ...(cacheable ? { ttlMs: 300_000, cacheScope: "public" } : {}),
    _meta: {
      ...(result?._meta || {}),
      "io.modelcontextprotocol/serverInfo": serverInfo,
    },
  };
}

function toolErrorResult(error, modern) {
  const detail = safeError(error);
  return modernResult({
    content: [{ type: "text", text: JSON.stringify(detail, null, 2) }],
    structuredContent: detail,
    isError: true,
  }, modern);
}

function validRequest(message) {
  return message
    && typeof message === "object"
    && !Array.isArray(message)
    && message.jsonrpc === "2.0"
    && typeof message.method === "string";
}

export async function handleMcpMessage(
  message,
  service,
  { protocolVersion = "", protocolVersions = supportedProtocolVersions } = {},
) {
  if (!validRequest(message)) return errorResponse(message?.id, -32600, "Invalid Request");
  const isNotification = message.id === undefined;
  const version = requestVersion(message, protocolVersion);
  const modern = version === currentProtocolVersion || message.method === "server/discover";
  if (version && !protocolVersions.includes(version)) {
    return errorResponse(message.id, -32022, "Unsupported protocol version", {
      supportedVersions: protocolVersions,
    });
  }
  if (isNotification) {
    return null;
  }
  try {
    if (message.method === "server/discover") {
      return response(message.id, modernResult({
        supportedVersions: protocolVersions,
        capabilities: { tools: {}, resources: {} },
        instructions,
      }, true, { cacheable: true }));
    }
    if (message.method === "initialize") {
      if (modern) return errorResponse(message.id, -32601, "Method not found");
      const requested = message.params?.protocolVersion;
      const selected = protocolVersions.includes(requested) && requested !== currentProtocolVersion
        ? requested
        : "2025-11-25";
      return response(message.id, {
        protocolVersion: selected,
        capabilities: { tools: {}, resources: {} },
        serverInfo,
        instructions,
      });
    }
    if (message.method === "ping") {
      return response(message.id, modernResult({}, modern));
    }
    if (message.method === "tools/list") {
      return response(message.id, modernResult({ tools: toolDefinitions }, modern, { cacheable: true }));
    }
    if (message.method === "tools/call") {
      if (typeof message.params?.name !== "string") {
        return errorResponse(message.id, -32602, "Invalid params", { reason: "Tool name is required." });
      }
      try {
        const result = await service.callTool(message.params.name, message.params.arguments || {});
        return response(message.id, modernResult(result, modern));
      } catch (error) {
        if (error instanceof MarketplaceMcpError) {
          return response(message.id, toolErrorResult(error, modern));
        }
        throw error;
      }
    }
    if (message.method === "resources/list") {
      return response(message.id, modernResult({
        resources: await service.listResources(),
      }, modern, { cacheable: true }));
    }
    if (message.method === "resources/templates/list") {
      return response(message.id, modernResult({
        resourceTemplates: await service.listResourceTemplates(),
      }, modern, { cacheable: true }));
    }
    if (message.method === "resources/read") {
      if (typeof message.params?.uri !== "string") {
        return errorResponse(message.id, -32602, "Invalid params", { reason: "Resource URI is required." });
      }
      try {
        return response(message.id, modernResult({
          contents: await service.readResource(message.params.uri),
        }, modern, { cacheable: true }));
      } catch (error) {
        if (error instanceof MarketplaceMcpError) {
          return errorResponse(message.id, -32002, "Resource not found", safeError(error));
        }
        throw error;
      }
    }
    return errorResponse(message.id, -32601, "Method not found");
  } catch {
    return errorResponse(message.id, -32603, "Internal error");
  }
}

export function parseJsonRpc(text) {
  try {
    return { message: JSON.parse(text), error: null };
  } catch {
    return { message: null, error: errorResponse(null, -32700, "Parse error") };
  }
}
