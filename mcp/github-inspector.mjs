import { parseGitHubRepository } from "../scripts/github-repository.mjs";
import {
  PluginManifestError,
  validatePluginManifest,
} from "../scripts/plugin-manifest.mjs";
import { readBoundedResponse } from "./bounded-response.mjs";
import { MarketplaceMcpError } from "./errors.mjs";
import { isFullCommit } from "./identifiers.mjs";

const apiBase = "https://api.github.com";
const rawBase = "https://raw.githubusercontent.com";
const manifestByteLimit = 1024 * 1024;
const readmeByteLimit = 1024 * 1024;
const apiResponseByteLimit = 8 * 1024 * 1024;
export const candidatePreviewByteLimit = 50 * 1024 * 1024;
const previewPattern = /^preview\.(?:png|jpe?g|webp|avif)$/i;
const previewPriority = ["preview.png", "preview.webp", "preview.jpg", "preview.jpeg", "preview.avif"];

const previewMimeTypes = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
});

function extension(path) {
  const match = String(path).toLowerCase().match(/\.[^.]+$/);
  return match?.[0] || "";
}

function previewMimeType(path) {
  return previewMimeTypes[extension(path)] || "application/octet-stream";
}

function isBlob(entry) {
  return entry?.type === "blob" && entry.mode !== "120000";
}

function rootFile(tree, pattern) {
  return tree.find((entry) => !entry.path.includes("/") && isBlob(entry) && pattern.test(entry.path)) || null;
}

function previewEntry(tree) {
  const candidates = tree.filter((entry) => (
    !entry.path.includes("/") && isBlob(entry) && previewPattern.test(entry.path)
  ));
  return candidates.sort((left, right) => {
    const leftPriority = previewPriority.indexOf(left.path.toLowerCase());
    const rightPriority = previewPriority.indexOf(right.path.toLowerCase());
    return leftPriority - rightPriority || left.path.localeCompare(right.path);
  })[0] || null;
}

function encodedPath(path) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function rawUrl(repository, commitSha, path) {
  return `${rawBase}/${repository.owner}/${repository.repository}/${commitSha}/${encodedPath(path)}`;
}

function decodedText(bytes) {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function githubHeaders(token, accept = "application/vnd.github+json") {
  return {
    Accept: accept,
    "User-Agent": "omarchy-plugin-marketplace-mcp",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function fetchResponse(fetchImpl, url, options, timeoutMs) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...options,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new MarketplaceMcpError("repository-unreachable", "GitHub did not respond before the inspection timeout.");
  }
  if (!response.ok) {
    const code = response.status === 403 || response.status === 429
      ? "github-rate-limited"
      : response.status === 404
        ? "repository-unreachable"
        : "github-request-failed";
    throw new MarketplaceMcpError(code, `GitHub returned HTTP ${response.status} during candidate inspection.`);
  }
  return response;
}

async function readJson(fetchImpl, url, token, timeoutMs, label) {
  const response = await fetchResponse(
    fetchImpl,
    url,
    { headers: githubHeaders(token) },
    timeoutMs,
  );
  const bytes = await readBoundedResponse(response, apiResponseByteLimit, label);
  try {
    return JSON.parse(decodedText(bytes));
  } catch {
    throw new MarketplaceMcpError("github-response-invalid", `${label} was not valid JSON.`);
  }
}

async function readRaw(fetchImpl, repository, commitSha, path, timeoutMs, limit) {
  const response = await fetchResponse(
    fetchImpl,
    rawUrl(repository, commitSha, path),
    {
      headers: {
        Accept: "application/octet-stream",
        "User-Agent": "omarchy-plugin-marketplace-mcp",
      },
    },
    timeoutMs,
  );
  return readBoundedResponse(response, limit, path);
}

function publicManifest(manifest) {
  if (!manifest) return null;
  return {
    schemaVersion: manifest.schemaVersion,
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    author: manifest.author,
    description: manifest.description,
    license: manifest.license || null,
    kinds: manifest.kinds,
    entryPoints: manifest.entryPoints,
    ...(manifest.barWidget ? { barWidget: manifest.barWidget } : {}),
  };
}

function suggestionForKinds(kinds = []) {
  let category = "Other";
  if (kinds.includes("bar-widget")) category = "Widgets";
  else if (kinds.some((kind) => ["overlay", "panel", "bar"].includes(kind))) category = "Desktop";
  else if (kinds.includes("service")) category = "System";
  const tags = [];
  if (kinds.includes("bar-widget") || kinds.includes("bar")) tags.push("bar");
  if (kinds.some((kind) => ["bar-widget", "menu", "overlay", "panel", "service"].includes(kind))) {
    tags.push("quickshell");
  }
  if (kinds.includes("service")) tags.push("system");
  return { category, tags: [...new Set(tags)].slice(0, 3) };
}

function documentationSignals(readme) {
  const text = String(readme || "");
  return {
    mentionsInstallation: /\b(?:install|installation|setup)\b/i.test(text),
    mentionsRemoval: /\b(?:remove|removal|uninstall)\b/i.test(text),
    mentionsDependencies: /\b(?:dependencies|dependency|requires|requirements)\b/i.test(text),
  };
}

export function createGithubInspector({
  fetchImpl = globalThis.fetch,
  token = "",
  timeoutMs = 15_000,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new MarketplaceMcpError("configuration-invalid", "A fetch implementation is required.");
  }

  async function snapshot(repositoryUrl, requestedCommit = "") {
    let repository;
    try {
      repository = parseGitHubRepository(repositoryUrl);
    } catch (error) {
      throw new MarketplaceMcpError("repository-invalid", error.message);
    }
    if (requestedCommit && !isFullCommit(requestedCommit)) {
      throw new MarketplaceMcpError("commit-invalid", "Candidate commit must be a full 40-character SHA.");
    }
    const metadata = await readJson(
      fetchImpl,
      `${apiBase}/repos/${repository.owner}/${repository.repository}`,
      token,
      timeoutMs,
      "Repository metadata",
    );
    if (metadata.private || metadata.disabled || metadata.archived) {
      throw new MarketplaceMcpError(
        "repository-unreachable",
        `${repository.slug} must be public, active, and unarchived.`,
      );
    }
    if (typeof metadata.full_name === "string") {
      try {
        repository = parseGitHubRepository(`https://github.com/${metadata.full_name}`);
      } catch {
        throw new MarketplaceMcpError("github-response-invalid", "GitHub returned an invalid canonical repository name.");
      }
    }
    const reference = requestedCommit || metadata.default_branch;
    const commit = await readJson(
      fetchImpl,
      `${apiBase}/repos/${repository.owner}/${repository.repository}/commits/${encodeURIComponent(reference)}`,
      token,
      timeoutMs,
      "Commit metadata",
    );
    const commitSha = String(commit.sha || "").toLowerCase();
    const treeSha = String(commit.commit?.tree?.sha || "").toLowerCase();
    if (!isFullCommit(commitSha) || !isFullCommit(treeSha)) {
      throw new MarketplaceMcpError("github-response-invalid", "GitHub returned an invalid candidate snapshot.");
    }
    if (requestedCommit && requestedCommit.toLowerCase() !== commitSha) {
      throw new MarketplaceMcpError("commit-mismatch", "GitHub resolved a different candidate commit.");
    }
    const treeResponse = await readJson(
      fetchImpl,
      `${apiBase}/repos/${repository.owner}/${repository.repository}/git/trees/${treeSha}?recursive=1`,
      token,
      timeoutMs,
      "Repository tree",
    );
    if (treeResponse.truncated || !Array.isArray(treeResponse.tree)) {
      throw new MarketplaceMcpError(
        "unsupported-repository-layout",
        "The candidate repository tree is incomplete or too large.",
      );
    }
    return {
      repository,
      metadata,
      defaultBranch: metadata.default_branch,
      commitSha,
      treeSha,
      tree: treeResponse.tree,
      treeByPath: new Map(treeResponse.tree.map((entry) => [entry.path, entry])),
    };
  }

  async function inspect({ repository: repositoryUrl, commit = "" }) {
    const resolved = await snapshot(repositoryUrl, commit);
    const checks = [];
    const rootManifest = resolved.treeByPath.get("manifest.json");
    const manifestPaths = resolved.tree
      .filter((entry) => /^(?:[^/]+\/)?manifest\.json$/i.test(entry.path) && isBlob(entry))
      .map((entry) => entry.path)
      .sort();
    let manifest = null;
    if (!isBlob(rootManifest) || manifestPaths.length !== 1) {
      checks.push({
        id: "repository-layout",
        status: "needs-fixes",
        message: "New submissions require exactly one manifest.json at the repository root.",
      });
    } else {
      try {
        manifest = JSON.parse(decodedText(await readRaw(
          fetchImpl,
          resolved.repository,
          resolved.commitSha,
          "manifest.json",
          timeoutMs,
          manifestByteLimit,
        )));
        validatePluginManifest(manifest, "manifest.json", { community: true });
        checks.push({ id: "manifest", status: "passed", message: "Root manifest is structurally valid." });
      } catch (error) {
        if (error instanceof PluginManifestError) {
          checks.push({ id: error.code, status: "needs-fixes", message: error.message });
          manifest = null;
        } else if (error instanceof SyntaxError) {
          checks.push({ id: "manifest-invalid", status: "needs-fixes", message: "manifest.json is not valid JSON." });
          manifest = null;
        } else {
          throw error;
        }
      }
    }
    if (manifest) {
      const symlink = resolved.tree.find((entry) => entry.mode === "120000");
      if (symlink) {
        checks.push({
          id: "manifest-symlink",
          status: "needs-fixes",
          message: "Symlinks are not allowed in a root plugin repository.",
        });
      }
      const missingEntryPoint = Object.values(manifest.entryPoints).find((path) => (
        !isBlob(resolved.treeByPath.get(path))
      ));
      checks.push(missingEntryPoint
        ? {
          id: "entry-point-missing",
          status: "needs-fixes",
          message: `Declared entry point "${missingEntryPoint}" is missing or linked.`,
        }
        : {
          id: "entry-points",
          status: "passed",
          message: "Every declared entry point exists in the candidate snapshot.",
        });
    }
    const readmeEntry = rootFile(resolved.tree, /^readme(?:\.[^/]+)?$/i);
    const licenseEntry = rootFile(resolved.tree, /^(?:licen[cs]e|copying)(?:\.[^/]+)?$/i);
    checks.push(readmeEntry
      ? { id: "readme", status: "passed", message: `Root documentation found at ${readmeEntry.path}.` }
      : { id: "readme-missing", status: "needs-fixes", message: "A root README is required." });
    checks.push(licenseEntry
      ? { id: "license", status: "passed", message: `Root license found at ${licenseEntry.path}.` }
      : { id: "license-missing", status: "needs-fixes", message: "A root license file is required." });
    let readme = "";
    if (readmeEntry) {
      readme = decodedText(await readRaw(
        fetchImpl,
        resolved.repository,
        resolved.commitSha,
        readmeEntry.path,
        timeoutMs,
        readmeByteLimit,
      ));
    }
    const docs = documentationSignals(readme);
    if (readmeEntry) {
      checks.push({
        id: "documentation-signals",
        status: docs.mentionsInstallation && docs.mentionsRemoval ? "passed" : "review-required",
        message: docs.mentionsInstallation && docs.mentionsRemoval
          ? "README text mentions installation and removal."
          : "README exists, but installation or removal guidance was not detected automatically.",
      });
    }
    const preview = previewEntry(resolved.tree);
    const previewMetadata = preview ? {
      path: preview.path,
      size: preview.size,
      mimeType: previewMimeType(preview.path),
      sourceUrl: rawUrl(resolved.repository, resolved.commitSha, preview.path),
      resourceRequest: {
        repository: `https://github.com/${resolved.repository.slug}`,
        commit: resolved.commitSha,
      },
    } : null;
    checks.push(preview
      ? {
        id: "preview",
        status: Number(preview.size) > 0 && Number(preview.size) <= candidatePreviewByteLimit
          ? "passed"
          : "needs-fixes",
        message: Number(preview.size) > 0 && Number(preview.size) <= candidatePreviewByteLimit
          ? `Optional root preview found at ${preview.path}.`
          : "The root preview is empty or exceeds the 50 MB input limit.",
      }
      : {
        id: "preview",
        status: "not-provided",
        message: "No optional root preview was found; the marketplace fallback will be used.",
      });
    return {
      repository: {
        slug: resolved.repository.slug,
        url: `https://github.com/${resolved.repository.slug}`,
        nodeId: resolved.metadata.node_id || null,
        databaseId: Number.isSafeInteger(resolved.metadata.id) ? resolved.metadata.id : null,
        description: resolved.metadata.description || "",
        homepage: resolved.metadata.homepage || "",
        stars: Number.isSafeInteger(resolved.metadata.stargazers_count)
          ? resolved.metadata.stargazers_count
          : 0,
        updatedAt: resolved.metadata.pushed_at || resolved.metadata.updated_at || null,
      },
      snapshot: {
        defaultBranch: resolved.defaultBranch,
        commitSha: resolved.commitSha,
        treeSha: resolved.treeSha,
      },
      manifest: publicManifest(manifest),
      documentation: {
        readmePath: readmeEntry?.path || null,
        licensePath: licenseEntry?.path || null,
        ...docs,
      },
      preview: previewMetadata,
      suggestedTaxonomy: suggestionForKinds(manifest?.kinds || []),
      checks: {
        status: checks.some((check) => check.status === "needs-fixes")
          ? "needs-fixes"
          : checks.some((check) => check.status === "review-required")
            ? "review-required"
            : "passed",
        items: checks,
      },
      disclaimer: "Candidate inspection is static, read-only, and commit-bound. It is not a security review, approval, certification, or endorsement.",
    };
  }

  async function getCandidatePreview({ repository: repositoryUrl, commit }, byteLimit = candidatePreviewByteLimit) {
    if (!isFullCommit(commit)) {
      throw new MarketplaceMcpError("commit-invalid", "Candidate preview requests require a full 40-character SHA.");
    }
    const resolved = await snapshot(repositoryUrl, commit);
    const preview = previewEntry(resolved.tree);
    if (!preview) {
      throw new MarketplaceMcpError("preview-missing", "The candidate snapshot has no supported root preview.");
    }
    if (!Number.isFinite(preview.size) || preview.size < 1 || preview.size > byteLimit) {
      throw new MarketplaceMcpError("preview-too-large", `Candidate preview exceeds the ${byteLimit}-byte MCP delivery limit.`);
    }
    return {
      bytes: await readRaw(
        fetchImpl,
        resolved.repository,
        resolved.commitSha,
        preview.path,
        timeoutMs,
        byteLimit,
      ),
      path: preview.path,
      mimeType: previewMimeType(preview.path),
      commitSha: resolved.commitSha,
      repository: resolved.repository.slug,
    };
  }

  return Object.freeze({ inspect, getCandidatePreview });
}
