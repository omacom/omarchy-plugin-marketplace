import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildSecurityBaselineFailureReport,
  buildSecurityBaselineReport,
} from "./security-baseline-report.mjs";
import {
  runSecurityBaseline,
  SecurityBaselineError,
} from "./security-baseline-scanner.mjs";
import { verifiedPublicationDisposition } from "./security-baseline-policy.mjs";

export * from "./security-baseline-approval.mjs";
export * from "./security-baseline-policy.mjs";
export * from "./security-baseline-record.mjs";
export * from "./security-baseline-report.mjs";
export * from "./security-baseline-scanner.mjs";

function requiredArgument(name) {
  const prefix = `--${name}=`;
  const value = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  if (!value) throw new SecurityBaselineError("security-baseline-invalid", `--${name} is required`);
  return value;
}

export const securityBaselineScanLimitExitCode = 3;

let reportContext = "submission";

async function main() {
  const metadataPath = requiredArgument("metadata");
  const jsonPath = requiredArgument("json");
  const metadata = JSON.parse(await readFile(resolve(metadataPath), "utf8"));
  const pluginIds = Array.isArray(metadata?.pluginIds)
    ? [...metadata.pluginIds].sort()
    : [];
  const listedPluginIds = Array.isArray(metadata?.listedPlugins)
    ? metadata.listedPlugins.map((plugin) => plugin?.pluginId).sort()
    : [];
  if (
    metadata?.schemaVersion !== 1
    || typeof metadata.repoUrl !== "string"
    || typeof metadata.commitSha !== "string"
    || !pluginIds.length
    || pluginIds.some((id) => typeof id !== "string" || !id || id !== id.trim())
    || new Set(pluginIds).size !== pluginIds.length
    || JSON.stringify(pluginIds) !== JSON.stringify(listedPluginIds)
  ) {
    throw new SecurityBaselineError("security-baseline-invalid", "Validation metadata is invalid");
  }
  reportContext = metadata.context === "update" ? "update" : "submission";
  const result = await runSecurityBaseline(metadata.repoUrl, metadata.commitSha, {
    requiredPaths: metadata.entryPoints,
    ...(Array.isArray(metadata.listedPlugins)
      ? { listedPlugins: metadata.listedPlugins }
      : {}),
  });
  const publicationDisposition = verifiedPublicationDisposition(result);
  if (!publicationDisposition) {
    throw new SecurityBaselineError("security-baseline-invalid", "Verified publication disposition is invalid");
  }
  await writeFile(resolve(jsonPath), `${JSON.stringify({
    ...result,
    verifiedPublicationDisposition: publicationDisposition,
  }, null, 2)}\n`);
  process.stdout.write(buildSecurityBaselineReport(result, { context: reportContext }));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    const code = error?.code || "security-baseline-unavailable";
    process.stdout.write(buildSecurityBaselineFailureReport(error, { context: reportContext }));
    console.error(`Automated security baseline failed [${code}]`);
    process.exitCode = code === "security-baseline-scan-limit" ? securityBaselineScanLimitExitCode : 2;
  });
}
