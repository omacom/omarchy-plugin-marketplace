import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const marketplaceRepository = "omacom/omarchy-plugin-marketplace";
const catalogWriteGroup = "plugin-catalog-writes";
const maximumAdmissionDepth = 10;
const maximumResponseBytes = 1024 * 1024;
const maximumRequestTimeoutMilliseconds = 15_000;

function requireRepository(value) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value || "")) {
    throw new Error("GITHUB_REPOSITORY must be an exact owner/repository slug.");
  }
  if (value.toLowerCase() !== marketplaceRepository.toLowerCase()) {
    throw new Error(`GITHUB_REPOSITORY must be ${marketplaceRepository}.`);
  }
  return marketplaceRepository;
}

function requirePositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Concurrency response ${field} is invalid.`);
  }
}

export function parseCatalogWriteConcurrencyResponse(status, body) {
  if (status === 404) {
    return Object.freeze({ group: catalogWriteGroup, depth: 0, members: Object.freeze([]) });
  }
  if (status !== 200) {
    throw new Error(`Concurrency lookup returned HTTP ${status}.`);
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("Concurrency response is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Concurrency response must be an object.");
  }
  if (parsed.group_name !== catalogWriteGroup) {
    throw new Error("Concurrency response group does not match plugin-catalog-writes.");
  }
  if (!Number.isSafeInteger(parsed.total_count) || parsed.total_count < 1 || parsed.total_count > 100) {
    throw new Error("Concurrency response total_count is invalid.");
  }
  if (!Array.isArray(parsed.group_members) || parsed.group_members.length !== parsed.total_count) {
    throw new Error("Concurrency response member count is incomplete.");
  }

  const identities = new Set();
  const members = parsed.group_members.map((member) => {
    if (!member || typeof member !== "object" || Array.isArray(member)) {
      throw new Error("Concurrency response contains an invalid member.");
    }
    requirePositiveInteger(member.run_id, "run_id");
    if (typeof member.run_name !== "string" || member.run_name.length === 0) {
      throw new Error("Concurrency response run_name is invalid.");
    }
    if (member.status !== "in_progress" && member.status !== "pending") {
      throw new Error("Concurrency response member status is invalid.");
    }
    if (member.job_id != null) {
      requirePositiveInteger(member.job_id, "job_id");
    }
    const identity = `${member.run_id}:${member.job_id ?? "workflow"}`;
    if (identities.has(identity)) {
      throw new Error("Concurrency response contains a duplicate member.");
    }
    identities.add(identity);
    return Object.freeze({
      runId: member.run_id,
      jobId: member.job_id ?? null,
      status: member.status,
    });
  });

  return Object.freeze({
    group: catalogWriteGroup,
    depth: parsed.total_count,
    members: Object.freeze(members),
  });
}

export function catalogWriteAdmission(queue) {
  if (!queue || queue.group !== catalogWriteGroup || !Number.isSafeInteger(queue.depth) || queue.depth < 0) {
    throw new Error("Catalog write queue state is invalid.");
  }
  return Object.freeze({
    admitted: queue.depth <= maximumAdmissionDepth,
    depth: queue.depth,
    threshold: maximumAdmissionDepth,
  });
}

async function readBoundedBody(response) {
  if (!response.body) {
    throw new Error("Concurrency response body is unavailable.");
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength != null) {
    const length = /^[0-9]+$/.test(declaredLength) ? Number(declaredLength) : Number.NaN;
    if (!Number.isSafeInteger(length) || length < 0 || length > maximumResponseBytes) {
      const error = new Error("Concurrency response Content-Length is invalid or too large.");
      await response.body.cancel(error).catch(() => {});
      throw error;
    }
  }

  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximumResponseBytes) {
        throw new Error("Concurrency response exceeds the one MiB limit.");
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(merged);
  } catch (error) {
    throw new Error("Concurrency response is not valid UTF-8.", { cause: error });
  }
}

export async function fetchCatalogWriteQueue({
  repository,
  token,
  fetchImpl = fetch,
  timeoutMilliseconds = maximumRequestTimeoutMilliseconds,
}) {
  const slug = requireRepository(repository);
  if (typeof token !== "string" || token.length === 0 || /[\r\n]/.test(token)) {
    throw new Error("A bounded GitHub token is required for concurrency admission checks.");
  }
  if (!Number.isSafeInteger(timeoutMilliseconds) ||
      timeoutMilliseconds < 1 ||
      timeoutMilliseconds > maximumRequestTimeoutMilliseconds) {
    throw new Error("Concurrency request timeout is invalid.");
  }
  const url = `https://api.github.com/repos/${slug}/actions/concurrency_groups/${catalogWriteGroup}`;
  const response = await fetchImpl(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMilliseconds),
  });
  const body = await readBoundedBody(response);
  return parseCatalogWriteConcurrencyResponse(response.status, body);
}

async function main() {
  const queue = await fetchCatalogWriteQueue({
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
  });
  const decision = catalogWriteAdmission(queue);
  if (!decision.admitted) {
    console.error(
      `Catalog write admission denied: queue depth ${decision.depth} exceeds ${decision.threshold}.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(`Catalog write admission granted: queue depth ${decision.depth}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`Catalog write admission check failed closed: ${error.message}`);
    process.exitCode = 2;
  });
}
