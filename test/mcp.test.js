import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { encodeBase64, readBoundedResponse } from "../mcp/bounded-response.mjs";
import { analyzeDuplicates } from "../mcp/duplicates.mjs";
import { createGithubInspector } from "../mcp/github-inspector.mjs";
import { createLocalMarketplaceService } from "../mcp/local-service.mjs";
import {
  currentProtocolVersion,
  handleMcpMessage,
  supportedProtocolVersions,
} from "../mcp/protocol.mjs";
import { createMarketplaceService, toolDefinitions } from "../mcp/service.mjs";
import { createMarketplaceState } from "../mcp/state.mjs";
import { handleRequest } from "../mcp/worker.mjs";

const root = resolve(import.meta.dirname, "..");
const commitSha = "a".repeat(40);
const treeSha = "b".repeat(40);

const catalogFixture = {
  generatedAt: "2026-08-30T12:00:00.000Z",
  warnings: [],
  plugins: [
    {
      id: "example.workspace-overview",
      name: "Workspace Overview",
      description: "Live workspace overview with window thumbnails and drag-and-drop movement.",
      author: "Example",
      version: "1.0.0",
      category: "Desktop",
      tags: ["workspaces", "quickshell"],
      kind: "Overlay",
      repo: "https://github.com/example/workspace-overview",
      sourceType: "community",
      status: "Available",
      verificationStatus: "verified",
      installAvailable: true,
      installCommand: "omarchy plugin add https://github.com/example/workspace-overview.git --enable",
      previewImage: "assets/img/plugins/example-workspace-overview-detail.webp",
      previewWidth: 1600,
      previewHeight: 900,
      stars: 12,
    },
    {
      id: "other.overview",
      name: "Overview",
      description: "Workspace overview displaying live window previews.",
      author: "Other",
      version: "2.0.0",
      category: "Appearance",
      tags: ["workspaces", "hyprland"],
      kind: "Overlay",
      repo: "https://github.com/other/overview",
      sourceType: "community",
      status: "Available",
      verificationStatus: "unverified",
      installAvailable: true,
      stars: 4,
    },
    {
      id: "example.battery",
      name: "Battery Meter",
      description: "Laptop battery percentage in the bar.",
      author: "Example",
      version: "1.0.0",
      category: "Hardware",
      tags: ["bar", "power-management"],
      kind: "Bar widget",
      repo: "https://github.com/example/battery-meter",
      sourceType: "community",
      status: "Available",
      verificationStatus: "verified",
      installAvailable: true,
      stars: 3,
    },
  ],
};

const registryFixture = {
  sources: [
    {
      repo: "https://github.com/example/workspace-overview",
      type: "plugin-source",
      repositoryIdentity: {
        schemaVersion: 1,
        nodeId: "R_workspace",
        databaseId: 101,
        previousRepositories: ["example/old-workspace-overview"],
      },
      plugins: { "example.workspace-overview": {} },
    },
    {
      repo: "https://github.com/other/overview",
      type: "plugin-source",
      plugins: { "other.overview": {} },
    },
    {
      repo: "https://github.com/example/battery-meter",
      type: "plugin-source",
      plugins: { "example.battery": {} },
    },
  ],
  retiredPluginIds: ["retired.plugin"],
};

function inspectionFixture(overrides = {}) {
  return {
    repository: {
      slug: "candidate/workspace-grid",
      url: "https://github.com/candidate/workspace-grid",
      nodeId: "R_candidate",
      databaseId: 202,
      description: "A live workspace grid.",
      homepage: "",
      stars: 0,
      updatedAt: "2026-08-30T12:00:00Z",
    },
    snapshot: { defaultBranch: "main", commitSha, treeSha },
    manifest: {
      schemaVersion: 1,
      id: "candidate.workspace-grid",
      name: "Workspace Grid",
      version: "1.0.0",
      author: "Candidate",
      description: "Live workspace overview with window thumbnails and drag-and-drop movement.",
      license: "MIT",
      kinds: ["overlay"],
      entryPoints: { overlay: "Main.qml" },
    },
    documentation: {
      readmePath: "README.md",
      licensePath: "LICENSE",
      mentionsInstallation: true,
      mentionsRemoval: true,
      mentionsDependencies: true,
    },
    preview: {
      path: "preview.png",
      size: 128,
      mimeType: "image/png",
      sourceUrl: `https://raw.githubusercontent.com/candidate/workspace-grid/${commitSha}/preview.png`,
      resourceRequest: {
        repository: "https://github.com/candidate/workspace-grid",
        commit: commitSha,
      },
    },
    suggestedTaxonomy: { category: "Desktop", tags: ["quickshell"] },
    checks: {
      status: "passed",
      items: [{ id: "manifest", status: "passed", message: "Manifest passed." }],
    },
    disclaimer: "Not a security review.",
    ...overrides,
  };
}

function fakePreview(source, values = {}) {
  return {
    data: Buffer.from("preview").toString("base64"),
    mimeType: "image/png",
    metadata: { source, bytes: 7, ...values },
  };
}

function testService({ inspection = inspectionFixture() } = {}) {
  const state = createMarketplaceState(catalogFixture, registryFixture);
  const inspector = {
    inspect: async () => inspection,
    getCandidatePreview: async () => ({
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "image/png",
      path: "preview.png",
      commitSha,
      repository: "candidate/workspace-grid",
    }),
  };
  const previewProvider = {
    listed: async (plugin) => fakePreview("listed-plugin", { pluginId: plugin.id }),
    candidate: async (request) => fakePreview("candidate", request),
  };
  return createMarketplaceService({ loadState: async () => state, inspector, previewProvider });
}

function modernRequest(id, method, params = {}) {
  return {
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": currentProtocolVersion,
        "io.modelcontextprotocol/clientInfo": { name: "mcp-test", version: "1.0.0" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };
}

function responseJson(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function protocolHeaders(message, extras = {}) {
  const name = message.method === "tools/call"
    ? message.params.name
    : message.method === "resources/read"
      ? message.params.uri
      : null;
  return {
    "Content-Type": "application/json",
    "MCP-Protocol-Version": currentProtocolVersion,
    "Mcp-Method": message.method,
    ...(name === null ? {} : { "Mcp-Name": name }),
    ...extras,
  };
}

function fakeRateLimiter(success = true) {
  return { limit: async () => ({ success }) };
}

test("MCP exposes a deterministic read-only tool and resource contract", async () => {
  assert.deepEqual(toolDefinitions.map((tool) => tool.name), [
    "search_plugins",
    "get_plugin",
    "find_similar_plugins",
    "review_candidate",
    "get_preview",
  ]);
  for (const tool of toolDefinitions) {
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  const discovery = await handleMcpMessage(
    modernRequest(1, "server/discover"),
    testService(),
  );
  assert.equal(discovery.result.resultType, "complete");
  assert.deepEqual(discovery.result.supportedVersions, supportedProtocolVersions);
  assert.deepEqual(discovery.result.capabilities, { tools: {}, resources: {} });

  const tools = await handleMcpMessage(modernRequest(2, "tools/list"), testService());
  assert.deepEqual(tools.result.tools.map((tool) => tool.name), toolDefinitions.map((tool) => tool.name));
  assert.equal(tools.result.ttlMs, 300_000);
  assert.equal(tools.result.cacheScope, "public");

  const resources = await handleMcpMessage(modernRequest(3, "resources/list"), testService());
  assert.deepEqual(resources.result.resources.map((resource) => resource.uri), [
    "marketplace://catalog/summary",
    "marketplace://submission/policy",
  ]);
  const templates = await handleMcpMessage(
    modernRequest(4, "resources/templates/list"),
    testService(),
  );
  assert.deepEqual(templates.result.resourceTemplates.map((resource) => resource.uriTemplate), [
    "marketplace://plugins/{pluginId}",
    "marketplace://plugins/{pluginId}/preview",
  ]);
});

test("MCP search combines marketplace semantics with exact filters and bounded results", async () => {
  const service = testService();
  const result = await service.callTool("search_plugins", {
    query: "workspace overview",
    tags: ["workspaces"],
    verificationStatus: "verified",
    installAvailable: true,
    limit: 2,
  });
  assert.equal(result.structuredContent.totalMatches, 1);
  assert.equal(result.structuredContent.results[0].id, "example.workspace-overview");
  assert.equal(result.structuredContent.results[0].previewAvailable, true);
  await assert.rejects(
    service.callTool("search_plugins", { query: "workspace", unexpected: true }),
    /Unexpected tool argument/,
  );
  await assert.rejects(
    service.callTool("search_plugins", { tags: ["not-a-marketplace-tag"] }),
    /tags must contain/,
  );
});

test("MCP plugin records and resources expose complete catalog metadata without mutation", async () => {
  const service = testService();
  const detail = await service.callTool("get_plugin", { pluginId: "example.workspace-overview" });
  assert.equal(detail.structuredContent.installCommand.includes("omarchy plugin add"), true);
  assert.equal(
    detail.structuredContent.previewResourceUri,
    "marketplace://plugins/example.workspace-overview/preview",
  );
  const resource = await service.readResource("marketplace://plugins/example.workspace-overview");
  assert.equal(JSON.parse(resource[0].text).verificationStatus, "verified");
  const image = await service.readResource("marketplace://plugins/example.workspace-overview/preview");
  assert.equal(image[0].mimeType, "image/png");
  assert.equal(Buffer.from(image[0].blob, "base64").toString(), "preview");
  await assert.rejects(
    service.readResource("marketplace://plugins/missing.plugin"),
    /not listed/,
  );
  await assert.rejects(
    service.readResource("marketplace://plugins/%2Fetc"),
    /invalid plugin ID/,
  );
  await assert.rejects(
    service.readResource("marketplace://plugins/%"),
    /invalid plugin ID/,
  );
});

test("shared MCP argument contracts reject malformed and ambiguous requests", async () => {
  const service = testService();
  await assert.rejects(
    service.callTool("find_similar_plugins", {}),
    /Provide a repository, plugin ID, name, or description/,
  );
  await assert.rejects(
    service.callTool("find_similar_plugins", { repository: "https://example.com/plugin" }),
    /public HTTPS GitHub repository root URL/,
  );
  await assert.rejects(
    service.callTool("review_candidate", {
      repository: "https://github.com/candidate/workspace-grid",
      similarityLimit: 0,
    }),
    /similarityLimit must be an integer from 1 through 25/,
  );
  await assert.rejects(
    service.callTool("get_preview", {
      repository: "https://github.com/candidate/workspace-grid",
      commit: "short",
    }),
    /full 40-character commit SHA/,
  );
});

test("shared bounded-response utilities enforce declared and streamed byte limits", async () => {
  await assert.rejects(
    readBoundedResponse(new Response("small", {
      headers: { "Content-Length": "9" },
    }), 8, "Fixture"),
    /Fixture exceeds the 8-byte limit/,
  );
  await assert.rejects(
    readBoundedResponse(new Response("123456789"), 8, "Streamed fixture"),
    /Streamed fixture exceeds the 8-byte limit/,
  );
  assert.equal(encodeBase64(new Uint8Array([0, 1, 2, 253, 254, 255])), "AAEC/f7/");
});

test("duplicate analysis separates exact conflicts from advisory similarity", () => {
  const state = createMarketplaceState(catalogFixture, registryFixture);
  const exact = analyzeDuplicates(state, {
    repository: "https://github.com/example/old-workspace-overview",
    repositoryNodeId: "R_workspace",
    repositoryDatabaseId: 101,
    id: "retired.plugin",
    name: "Overview",
    description: "Live workspace overview with window thumbnails and drag-and-drop movement.",
    author: "Candidate",
    category: "Desktop",
    tags: ["workspaces", "quickshell"],
    kind: "Overlay",
  });
  assert.equal(exact.conclusion, "exact-conflict");
  assert.deepEqual(exact.exactConflicts.map((entry) => entry.type).sort(), [
    "plugin-id-retired",
    "repository-listed",
  ]);
  assert.equal(exact.similarPlugins[0].plugin.id, "other.overview");
  assert.equal(exact.similarPlugins[0].reasons.some((reason) => reason.startsWith("shared description")), true);

  const advisory = analyzeDuplicates(state, {
    repository: "https://github.com/candidate/workspace-grid",
    id: "candidate.workspace-grid",
    name: "Workspace Overview",
    description: "Live workspace overview with window thumbnails and drag-and-drop movement.",
    category: "Desktop",
    tags: ["workspaces", "quickshell"],
    kind: "Overlay",
  });
  assert.equal(advisory.exactConflicts.length, 0);
  assert.equal(advisory.conclusion, "manual-comparison-required");
  assert.equal(advisory.similarPlugins[0].classification, "possible-duplicate");
});

test("MCP registry state rejects malformed historical repository aliases", () => {
  const invalidRegistry = structuredClone(registryFixture);
  invalidRegistry.sources[0].repositoryIdentity.previousRepositories.push("not a repository slug");
  assert.throws(
    () => createMarketplaceState(catalogFixture, invalidRegistry),
    /source aliases are invalid/,
  );
});

test("candidate review binds metadata, title, taxonomy, duplicate signals, and owner confirmation", async () => {
  const service = testService();
  const result = await service.callTool("review_candidate", {
    repository: "https://github.com/candidate/workspace-grid",
    commit: commitSha,
    submissionTitle: "[Plugin]: Different title",
    category: "Desktop",
    tags: ["workspaces", "quickshell"],
    similarityLimit: 3,
  });
  const report = result.structuredContent;
  assert.equal(report.snapshot.commitSha, commitSha);
  assert.equal(report.metadataConsistency.title.status, "differs");
  assert.equal(report.duplicateAnalysis.exactConflicts.length, 0);
  assert.equal(report.duplicateAnalysis.similarPlugins[0].plugin.id, "example.workspace-overview");
  assert.equal(report.submissionReadiness.status, "review-required");
  assert.equal(report.submissionReadiness.ownerConfirmationRequired.length, 5);
  assert.match(report.disclaimer, /not a security review/i);
});

test("preview tool returns both inspectable metadata and MCP image content", async () => {
  const service = testService();
  const listed = await service.callTool("get_preview", { pluginId: "example.workspace-overview" });
  assert.deepEqual(listed.content.map((entry) => entry.type), ["text", "image"]);
  assert.equal(Buffer.from(listed.content[1].data, "base64").toString(), "preview");
  const candidate = await service.callTool("get_preview", {
    repository: "https://github.com/candidate/workspace-grid",
    commit: commitSha,
  });
  assert.equal(candidate.structuredContent.commit, commitSha);
  await assert.rejects(
    service.callTool("get_preview", {
      pluginId: "example.workspace-overview",
      repository: "https://github.com/candidate/workspace-grid",
      commit: commitSha,
    }),
    /either pluginId or repository/,
  );
});

test("candidate GitHub inspection is exact-commit, bounded, static, and does not forward tokens to raw content", async () => {
  const requests = [];
  const tree = [
    { path: "manifest.json", type: "blob", mode: "100644", size: 300 },
    { path: "Main.qml", type: "blob", mode: "100644", size: 50 },
    { path: "README.md", type: "blob", mode: "100644", size: 100 },
    { path: "LICENSE", type: "blob", mode: "100644", size: 100 },
    { path: "preview.png", type: "blob", mode: "100644", size: 4 },
  ];
  const manifest = {
    schemaVersion: 1,
    id: "candidate.workspace-grid",
    name: "Workspace Grid",
    version: "1.0.0",
    author: "Candidate",
    description: "A live workspace grid.",
    license: "MIT",
    kinds: ["overlay"],
    entryPoints: { overlay: "Main.qml" },
  };
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), headers: new Headers(options.headers) });
    if (String(url).endsWith("/repos/candidate/workspace-grid")) {
      return responseJson({
        private: false,
        disabled: false,
        archived: false,
        default_branch: "main",
        node_id: "R_candidate",
        id: 202,
        description: "A live workspace grid.",
        homepage: "",
        stargazers_count: 0,
        pushed_at: "2026-08-30T12:00:00Z",
      });
    }
    if (String(url).includes("/commits/")) {
      return responseJson({ sha: commitSha, commit: { tree: { sha: treeSha } } });
    }
    if (String(url).includes("/git/trees/")) return responseJson({ truncated: false, tree });
    if (String(url).endsWith("/manifest.json")) return new Response(JSON.stringify(manifest));
    if (String(url).endsWith("/README.md")) {
      return new Response("## Installation\nInstall it.\n## Removal\nUninstall it.\nDependencies: none.");
    }
    if (String(url).endsWith("/preview.png")) {
      return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { "Content-Type": "image/png" } });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const inspector = createGithubInspector({ fetchImpl, token: "secret-token" });
  const report = await inspector.inspect({
    repository: "https://github.com/candidate/workspace-grid",
    commit: commitSha,
  });
  assert.equal(report.checks.status, "passed");
  assert.equal(report.manifest.id, "candidate.workspace-grid");
  assert.equal(report.documentation.mentionsInstallation, true);
  assert.equal(report.documentation.mentionsRemoval, true);
  assert.equal(report.preview.sourceUrl.includes(commitSha), true);
  const apiRequests = requests.filter((request) => request.url.startsWith("https://api.github.com/"));
  const rawRequests = requests.filter((request) => request.url.startsWith("https://raw.githubusercontent.com/"));
  assert.equal(apiRequests.every((request) => request.headers.get("Authorization") === "Bearer secret-token"), true);
  assert.equal(rawRequests.every((request) => request.headers.get("Authorization") === null), true);

  const preview = await inspector.getCandidatePreview({
    repository: "https://github.com/candidate/workspace-grid",
    commit: commitSha,
  }, 16);
  assert.deepEqual([...preview.bytes], [1, 2, 3, 4]);
});

test("candidate GitHub inspection reports invalid manifests without executing repository code", async () => {
  let entryPointFetched = false;
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/repos/candidate/broken")) {
      return responseJson({
        private: false,
        disabled: false,
        archived: false,
        default_branch: "main",
        node_id: "R_broken",
        id: 303,
      });
    }
    if (String(url).includes("/commits/")) {
      return responseJson({ sha: commitSha, commit: { tree: { sha: treeSha } } });
    }
    if (String(url).includes("/git/trees/")) {
      return responseJson({
        truncated: false,
        tree: [
          { path: "manifest.json", type: "blob", mode: "100644", size: 10 },
          { path: "README.md", type: "blob", mode: "100644", size: 10 },
          { path: "LICENSE", type: "blob", mode: "100644", size: 10 },
          { path: "run.sh", type: "blob", mode: "100755", size: 10 },
        ],
      });
    }
    if (String(url).endsWith("/manifest.json")) return new Response("{not json");
    if (String(url).endsWith("/README.md")) return new Response("Install and remove instructions.");
    if (String(url).endsWith("/run.sh")) {
      entryPointFetched = true;
      throw new Error("Executable repository code must not be fetched");
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const inspector = createGithubInspector({ fetchImpl });
  const report = await inspector.inspect({ repository: "https://github.com/candidate/broken" });
  assert.equal(report.checks.status, "needs-fixes");
  assert.equal(report.checks.items.some((check) => check.id === "manifest-invalid"), true);
  assert.equal(entryPointFetched, false);
});

test("protocol returns tool errors as model-readable results and preserves legacy initialization", async () => {
  const service = testService();
  const missing = await handleMcpMessage(modernRequest(1, "tools/call", {
    name: "get_plugin",
    arguments: { pluginId: "missing.plugin" },
  }), service);
  assert.equal(missing.result.resultType, "complete");
  assert.equal(missing.result.isError, true);
  assert.equal(missing.result.structuredContent.code, "plugin-not-found");

  const legacy = await handleMcpMessage({
    jsonrpc: "2.0",
    id: 2,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "legacy-test", version: "1.0.0" },
    },
  }, service);
  assert.equal(legacy.result.protocolVersion, "2025-11-25");
  assert.equal(legacy.result.resultType, undefined);
  const removedInitialize = await handleMcpMessage(
    modernRequest(20, "initialize", { protocolVersion: currentProtocolVersion }),
    service,
  );
  assert.equal(removedInitialize.error.code, -32601);
  const unknown = await handleMcpMessage({
    jsonrpc: "2.0",
    id: 3,
    method: "unknown/method",
    params: {},
  }, service);
  assert.equal(unknown.error.code, -32601);
});

test("HTTP MCP adapter validates origin, rate limit, modern headers, and executes a full tool call", async () => {
  const fetchImpl = async (url) => {
    if (String(url) === "https://omarchyplugins.com/catalog.json") return responseJson(catalogFixture);
    if (String(url).includes("raw.githubusercontent.com/HANCORE-linux/omarchy-plugin-marketplace/main/registry.json")) {
      return responseJson(registryFixture);
    }
    throw new Error(`Unexpected remote state URL: ${url}`);
  };
  const env = { MCP_RATE_LIMITER: fakeRateLimiter() };
  const message = modernRequest(1, "tools/call", {
    name: "search_plugins",
    arguments: { query: "battery", limit: 2 },
  });
  const request = new Request("https://mcp.example/mcp", {
    method: "POST",
    headers: protocolHeaders(message),
    body: JSON.stringify(message),
  });
  const response = await handleRequest(request, env, { fetchImpl });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.result.resultType, "complete");
  assert.equal(payload.result.structuredContent.results[0].id, "example.battery");
  assert.equal(response.headers.get("MCP-Protocol-Version"), currentProtocolVersion);

  const discoverMessage = modernRequest(9, "server/discover");
  const discoverResponse = await handleRequest(new Request("https://mcp.example/mcp", {
    method: "POST",
    headers: protocolHeaders(discoverMessage),
    body: JSON.stringify(discoverMessage),
  }), env, { fetchImpl });
  assert.deepEqual((await discoverResponse.json()).result.supportedVersions, [currentProtocolVersion]);

  const mismatched = new Request("https://mcp.example/mcp", {
    method: "POST",
    headers: protocolHeaders(message, { "Mcp-Method": "tools/list" }),
    body: JSON.stringify(message),
  });
  const mismatchResponse = await handleRequest(mismatched, env, { fetchImpl });
  assert.equal(mismatchResponse.status, 400);
  assert.equal((await mismatchResponse.json()).error.code, -32020);

  const blockedOrigin = new Request("https://mcp.example/mcp", {
    method: "POST",
    headers: protocolHeaders(message, { Origin: "https://evil.example" }),
    body: JSON.stringify(message),
  });
  assert.equal((await handleRequest(blockedOrigin, env, { fetchImpl })).status, 403);
  const freshRequest = () => new Request("https://mcp.example/mcp", {
    method: "POST",
    headers: protocolHeaders(message),
    body: JSON.stringify(message),
  });
  assert.equal((await handleRequest(freshRequest(), {}, { fetchImpl })).status, 503);
  assert.equal((await handleRequest(freshRequest(), {
    MCP_RATE_LIMITER: fakeRateLimiter(false),
  }, { fetchImpl })).status, 429);

  const oversizedRequest = new Request("https://mcp.example/mcp", {
    method: "POST",
    headers: protocolHeaders(message, { "Content-Length": String((1024 * 1024) + 1) }),
    body: JSON.stringify(message),
  });
  assert.equal((await handleRequest(oversizedRequest, env, { fetchImpl })).status, 413);

  const candidateMessage = modernRequest(10, "tools/call", {
    name: "review_candidate",
    arguments: { repository: "https://github.com/candidate/workspace-grid" },
  });
  const candidateRequest = () => new Request("https://mcp.example/mcp", {
    method: "POST",
    headers: protocolHeaders(candidateMessage),
    body: JSON.stringify(candidateMessage),
  });
  assert.equal((await handleRequest(candidateRequest(), {
    MCP_RATE_LIMITER: fakeRateLimiter(),
  }, { fetchImpl })).status, 503);
  assert.equal((await handleRequest(candidateRequest(), {
    MCP_RATE_LIMITER: fakeRateLimiter(),
    MCP_GITHUB_RATE_LIMITER: fakeRateLimiter(false),
  }, { fetchImpl })).status, 429);
});

test("stdio server completes modern discovery and a catalog query end to end", async () => {
  const child = spawn(process.execPath, [resolve(root, "mcp/server.mjs")], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const messages = [
    modernRequest(1, "server/discover"),
    modernRequest(2, "tools/call", {
      name: "search_plugins",
      arguments: { query: "workspace overview", limit: 1 },
    }),
  ];
  child.stdin.end(`${messages.map(JSON.stringify).join("\n")}\n`);
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  assert.equal(stderr, "");
  const responses = stdout.trim().split("\n").map(JSON.parse);
  assert.equal(responses.length, 2);
  assert.equal(responses[0].result.supportedVersions[0], currentProtocolVersion);
  assert.equal(responses[1].result.structuredContent.returned, 1);
  assert.equal(responses[1].result.structuredContent.results[0].id.length > 0, true);
});

test("MCP implementation remains dependency-free and keeps the existing engagement Worker separate", async () => {
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  assert.equal(packageJson.scripts.mcp, "node mcp/server.mjs");
  assert.deepEqual(Object.keys(packageJson.devDependencies), ["sharp"]);
  const workerSource = await readFile(resolve(root, "mcp/worker.mjs"), "utf8");
  const workerTemplate = await readFile(resolve(root, "mcp/wrangler.example.jsonc"), "utf8");
  const ignore = await readFile(resolve(root, ".gitignore"), "utf8");
  const engagementSource = await readFile(resolve(root, "worker/src/index.js"), "utf8");
  assert.match(workerSource, /MCP_RATE_LIMITER/);
  assert.match(workerSource, /MCP_GITHUB_RATE_LIMITER/);
  assert.doesNotMatch(workerSource, /ENGAGEMENT_DB/);
  assert.doesNotMatch(engagementSource, /Mcp-Method|server\/discover|tools\/call/);
  assert.match(workerTemplate, /"name": "MCP_RATE_LIMITER"/);
  assert.match(workerTemplate, /"name": "MCP_GITHUB_RATE_LIMITER"/);
  assert.doesNotMatch(workerTemplate, /ghp_|github_pat_|Bearer\s/);
  assert.match(ignore, /mcp\/wrangler\.jsonc/);
});
