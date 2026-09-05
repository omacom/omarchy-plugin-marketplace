import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import sharp from "sharp";
import { createMarketplaceState } from "./state.mjs";
import { MarketplaceMcpError } from "./errors.mjs";

const listedPreviewByteLimit = 8 * 1024 * 1024;
const candidatePreviewByteLimit = 50 * 1024 * 1024;
const previewPixelLimit = 40_000_000;

function mimeType(path) {
  const extension = extname(path).toLowerCase();
  if (extension === ".webp") return "image/webp";
  if (extension === ".png") return "image/png";
  if ([".jpg", ".jpeg"].includes(extension)) return "image/jpeg";
  if (extension === ".avif") return "image/avif";
  return "application/octet-stream";
}

function safePreviewPath(root, value) {
  if (!/^assets\/img\/plugins\/[A-Za-z0-9._-]+$/.test(String(value || ""))) {
    throw new MarketplaceMcpError("preview-invalid", "Listed preview path is invalid.");
  }
  const siteRoot = resolve(root, "site");
  const target = resolve(siteRoot, value);
  if (!target.startsWith(`${siteRoot}${sep}`)) {
    throw new MarketplaceMcpError("preview-invalid", "Listed preview path escapes the site directory.");
  }
  return target;
}

export function createLocalStateLoader(root = resolve(import.meta.dirname, "..")) {
  let statePromise;
  return async function loadState() {
    if (!statePromise) {
      statePromise = Promise.all([
        readFile(resolve(root, "site/catalog.json"), "utf8").then(JSON.parse),
        readFile(resolve(root, "registry.json"), "utf8").then(JSON.parse),
      ]).then(([catalog, registry]) => createMarketplaceState(catalog, registry));
    }
    return statePromise;
  };
}

export function createLocalPreviewProvider({
  root = resolve(import.meta.dirname, ".."),
  inspector,
} = {}) {
  return Object.freeze({
    async listed(plugin) {
      if (!plugin.previewImage) {
        throw new MarketplaceMcpError("preview-missing", `Plugin "${plugin.id}" has no listed preview.`);
      }
      const path = safePreviewPath(root, plugin.previewImage);
      const metadata = await stat(path);
      if (!metadata.isFile() || metadata.size < 1 || metadata.size > listedPreviewByteLimit) {
        throw new MarketplaceMcpError("preview-invalid", "Listed preview is missing or exceeds the MCP delivery limit.");
      }
      const bytes = await readFile(path);
      return {
        data: bytes.toString("base64"),
        mimeType: mimeType(path),
        metadata: {
          source: "listed-plugin",
          pluginId: plugin.id,
          path: plugin.previewImage,
          width: plugin.previewWidth || null,
          height: plugin.previewHeight || null,
          bytes: bytes.byteLength,
        },
      };
    },

    async candidate(request) {
      if (!inspector) {
        throw new MarketplaceMcpError("configuration-invalid", "Candidate preview inspection is unavailable.");
      }
      const preview = await inspector.getCandidatePreview(request, candidatePreviewByteLimit);
      let output;
      let info;
      try {
        const result = await sharp(preview.bytes, {
          failOn: "error",
          limitInputPixels: previewPixelLimit,
        })
          .rotate()
          .resize({
            width: 1600,
            height: 1600,
            fit: "inside",
            withoutEnlargement: true,
          })
          .webp({ quality: 82, alphaQuality: 90, effort: 4, smartSubsample: true })
          .toBuffer({ resolveWithObject: true });
        output = result.data;
        info = result.info;
      } catch {
        throw new MarketplaceMcpError("preview-invalid", "Candidate preview could not be decoded safely.");
      }
      return {
        data: output.toString("base64"),
        mimeType: "image/webp",
        metadata: {
          source: "candidate",
          repository: preview.repository,
          commitSha: preview.commitSha,
          path: preview.path,
          width: info.width,
          height: info.height,
          bytes: output.byteLength,
          convertedFrom: preview.mimeType,
        },
      };
    },
  });
}
