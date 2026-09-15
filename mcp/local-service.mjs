import { resolve } from "node:path";
import { createGithubInspector } from "./github-inspector.mjs";
import { createLocalPreviewProvider, createLocalStateLoader } from "./local-adapters.mjs";
import { createMarketplaceService } from "./service.mjs";

export function createLocalMarketplaceService({
  root = resolve(import.meta.dirname, ".."),
  fetchImpl = globalThis.fetch,
  githubToken = process.env.GITHUB_TOKEN || "",
  inspector: providedInspector,
  loadState: providedStateLoader,
  previewProvider: providedPreviewProvider,
} = {}) {
  const inspector = providedInspector || createGithubInspector({
    fetchImpl,
    token: githubToken,
  });
  const loadState = providedStateLoader || createLocalStateLoader(root);
  const previewProvider = providedPreviewProvider || createLocalPreviewProvider({ root, inspector });
  return createMarketplaceService({ loadState, inspector, previewProvider });
}
