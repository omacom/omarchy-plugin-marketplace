export const supportedPluginKinds = Object.freeze([
  "bar",
  "bar-widget",
  "menu",
  "overlay",
  "panel",
  "service",
]);

const supportedPluginKindSet = new Set(supportedPluginKinds);

export const manifestFieldLimits = Object.freeze({
  id: 128,
  name: 120,
  version: 64,
  author: 120,
  description: 500,
  license: 120,
});

export const maximumManifestVersionLength = manifestFieldLimits.version;

export class PluginManifestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PluginManifestError";
    this.code = code;
  }
}

function defaultFailure(code, message) {
  throw new PluginManifestError(code, message);
}

function entryPointKey(kind) {
  return kind === "bar-widget" ? "barWidget" : kind;
}

export function validatePluginManifest(
  manifest,
  manifestPath,
  { community = false, fail = defaultFailure } = {},
) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail("manifest-invalid", `${manifestPath}: manifest must be a JSON object`);
  }
  if (manifest.schemaVersion !== 1) {
    fail("manifest-invalid", `${manifestPath}: manifest field "schemaVersion" must be exactly 1`);
  }
  const required = ["id", "name", "version", "author", "description"];
  for (const field of required) {
    if (typeof manifest[field] !== "string" || !manifest[field].trim()) {
      fail("manifest-invalid", `${manifestPath}: manifest field "${field}" is required`);
    }
    const normalized = manifest[field].trim();
    if (field === "id" && manifest[field] !== normalized) {
      fail("manifest-invalid", `${manifestPath}: manifest field "id" must not contain leading or trailing whitespace`);
    }
    if (/[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) {
      fail("manifest-invalid", `${manifestPath}: manifest field "${field}" contains control characters`);
    }
    if (community && normalized.length > manifestFieldLimits[field]) {
      fail(
        "manifest-invalid",
        `${manifestPath}: manifest field "${field}" must not exceed ${manifestFieldLimits[field]} characters`,
      );
    }
    manifest[field] = normalized;
  }
  if (manifest.license !== undefined) {
    if (typeof manifest.license !== "string" || !manifest.license.trim()) {
      fail("manifest-invalid", `${manifestPath}: manifest field "license" must be a non-empty string`);
    }
    const normalizedLicense = manifest.license.trim();
    if (/[\u0000-\u001f\u007f-\u009f]/u.test(normalizedLicense)) {
      fail("manifest-invalid", `${manifestPath}: manifest field "license" contains control characters`);
    }
    if (community && normalizedLicense.length > manifestFieldLimits.license) {
      fail(
        "manifest-invalid",
        `${manifestPath}: manifest field "license" must not exceed ${manifestFieldLimits.license} characters`,
      );
    }
    manifest.license = normalizedLicense;
  }
  if (
    !/^[a-z0-9][a-z0-9._-]*$/i.test(manifest.id)
    || manifest.id.includes("..")
  ) {
    fail("manifest-invalid", `${manifestPath}: manifest id contains unsupported characters`);
  }
  if (community && manifest.id !== manifest.id.toLowerCase()) {
    fail("manifest-invalid", `${manifestPath}: community manifest ids must use lowercase characters`);
  }
  if (community && manifest.id.toLowerCase().startsWith("omarchy.")) {
    fail("reserved-plugin-id", `${manifestPath}: the omarchy.* namespace is reserved`);
  }
  if (
    !Array.isArray(manifest.kinds)
    || manifest.kinds.length === 0
    || manifest.kinds.some((kind) => typeof kind !== "string" || !supportedPluginKindSet.has(kind))
  ) {
    fail("manifest-invalid", `${manifestPath}: manifest "kinds" contains unsupported values`);
  }
  if (!manifest.entryPoints || typeof manifest.entryPoints !== "object" || Array.isArray(manifest.entryPoints)) {
    fail("manifest-invalid", `${manifestPath}: manifest "entryPoints" must be an object`);
  }
  if (
    manifest.barWidget
    && typeof manifest.barWidget === "object"
    && !Array.isArray(manifest.barWidget)
    && Object.hasOwn(manifest.barWidget, "defaultSection")
    && (
      typeof manifest.barWidget.defaultSection !== "string"
      || !["left", "center", "right"].includes(manifest.barWidget.defaultSection)
    )
  ) {
    fail(
      "manifest-invalid",
      `${manifestPath}: "barWidget.defaultSection" must be left, center, or right`,
    );
  }
  for (const kind of manifest.kinds) {
    if (!Object.hasOwn(manifest.entryPoints, entryPointKey(kind))) {
      fail("entry-point-missing", `${manifestPath}: entry point for "${kind}" is missing`);
    }
  }
  const entryPoints = Object.values(manifest.entryPoints);
  if (
    entryPoints.length === 0
    || entryPoints.some((entryPoint) => (
      typeof entryPoint !== "string"
      || !entryPoint.trim()
      || entryPoint.startsWith("/")
      || entryPoint.includes("..")
      || /[\\:\r\n\0]/.test(entryPoint)
    ))
  ) {
    fail("manifest-invalid", `${manifestPath}: entry points must be safe relative paths`);
  }
  return manifest;
}
