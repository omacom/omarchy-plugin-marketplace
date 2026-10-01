import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CatalogCheckError,
  inspectListedPluginSource,
} from "./build-catalog.mjs";
import {
  buildPluginUpdateValidationReport,
  parsePluginUpdateRequest,
  PluginUpdateError,
  publicPluginUpdateFailure,
  resolvePluginUpdate,
  sourceForPluginUpdate,
} from "./plugin-update.mjs";
import { canonicalRepositoryRequest } from "./verification-subject.mjs";

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
}

async function main() {
  const title = requiredEnvironment("ISSUE_TITLE");
  if (!title.startsWith("[Verify]:")) {
    throw new PluginUpdateError(
      "update-fields-invalid",
      "Plugin verification title must start with [Verify]:",
    );
  }
  const root = resolve(import.meta.dirname, "..");
  const registry = JSON.parse(await readFile(resolve(root, "registry.json"), "utf8"));
  const request = canonicalRepositoryRequest(
    registry,
    parsePluginUpdateRequest(requiredEnvironment("ISSUE_BODY")),
  );
  const source = sourceForPluginUpdate(registry, request);
  let inspection;
  try {
    inspection = await inspectListedPluginSource(source);
  } catch (error) {
    if (!(error instanceof CatalogCheckError)) throw error;
    throw new PluginUpdateError(
      "update-compatibility-invalid",
      "The update commit did not pass marketplace compatibility validation",
    );
  }
  const result = resolvePluginUpdate(registry, request, inspection);
  if (process.env.VALIDATION_METADATA_PATH) {
    await writeFile(resolve(process.env.VALIDATION_METADATA_PATH), `${JSON.stringify({
      schemaVersion: 1,
      context: "update",
      repoUrl: request.repoUrl,
      repository: request.repository,
      defaultBranch: inspection.defaultBranch,
      commitSha: inspection.commitSha,
      pluginIds: result.pluginIds,
      listedPlugins: result.manifests.map((manifest) => ({
        pluginId: manifest.id,
        manifestPathHint: manifest.path,
      })),
      entryPoints: [...new Set(
        result.manifests.flatMap((manifest) => manifest.entryPoints || []),
      )].sort(),
    }, null, 2)}\n`);
  }
  process.stdout.write(buildPluginUpdateValidationReport({ ...result, request }));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    const failure = publicPluginUpdateFailure(error);
    console.error(`Plugin update validation failed [${failure.code}]`);
    process.stdout.write(`<!-- marketplace-update-validation -->
## Plugin update validation

❌ **Validation failed:** ${failure.reason}

Correct the verification request and retry validation. The current marketplace snapshot remains unchanged.
`);
    process.exitCode = failure.code === "update-internal-error" ? 2 : 1;
  });
}
