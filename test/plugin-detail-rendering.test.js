import assert from "node:assert/strict";
import test from "node:test";
import { detailTemplate, setupPreviewLightbox } from "../site/assets/js/plugin.js";

const verifiedCommit = "1".repeat(40);
const upstreamCommit = "2".repeat(40);

function communityPlugin(overrides = {}) {
  return {
    id: "example.community-plugin",
    name: "Community Plugin",
    initials: "CP",
    category: "Desktop",
    author: "Example Maintainer",
    description: "A community plugin used by rendering tests.",
    tags: ["desktop"],
    accent: "lime",
    version: "1.0.0",
    license: "MIT",
    sourceType: "community",
    builtIn: false,
    placeholder: false,
    installAvailable: true,
    installCommand: "omarchy plugin add https://github.com/example/community-plugin.git --enable",
    installNote: "",
    status: "Available",
    repositoryLayout: "root-plugin",
    verificationStatus: "unverified",
    verificationSnapshotStatus: "unverified",
    verificationCoverage: "unverified",
    repo: "https://github.com/example/community-plugin",
    sourceUrl: "https://github.com/example/community-plugin",
    ...overrides,
  };
}

function render(overrides = {}) {
  return detailTemplate(communityPlugin(overrides), { views: 0, copies: 0, hearts: 0 });
}

function assertCommunitySectionOrder(html) {
  const install = html.indexOf('id="install"');
  const verification = html.indexOf('id="verification"');
  const security = html.indexOf('id="security"');
  const terms = html.indexOf('id="terms"');
  assert.ok(install >= 0 && verification > install && security > verification && terms > security);
}

test("installable unverified plugin details render exact snapshot and mutable-install warnings", () => {
  const html = render();

  assertCommunitySectionOrder(html);
  assert.match(html, /<h2>Install<\/h2>/);
  assert.match(html, /Snapshot unverified:<\/strong> This listed commit has not been verified\./);
  assert.match(html, /Contributor action:<\/strong> Submit the exact listed commit/);
  assert.match(html, /This Omarchy command clones the repository’s current HEAD\./);
  assert.doesNotMatch(html, /Manual installation follows the upstream project’s instructions\./);
  assert.match(html, /href="https:\/\/github\.com\/omacom\/omarchy-plugin-marketplace\/issues\/new\?template=verify-plugin\.yml"/);
  assert.match(html, /href="https:\/\/github\.com\/omacom\/omarchy-plugin-marketplace\/security\/advisories\/new"/);
  assert.doesNotMatch(html, /github\.com\/HANCORE-linux\/omarchy-plugin-marketplace/);
  assert.match(html, /<section class="detail-section security-notice-section" id="security" aria-labelledby="security-notice-title">[\s\S]*<strong id="security-notice-title">Security Notice<\/strong>/);
});

test("detail tags use the curated Games, Security, and AI labels", () => {
  const html = render({ tags: ["games", "security", "ai", "quickshell"] });
  assert.match(html, /<span class="tag">Games<\/span>/);
  assert.match(html, /<span class="tag">Security<\/span>/);
  assert.match(html, /<span class="tag">AI<\/span>/);
  assert.match(html, /<span class="tag">quickshell<\/span>/);
});

test("plugin preview uses an escaped native button", () => {
  const html = render({
    name: `\"><span data-injected>Unsafe</span>`,
    previewImage: "assets/img/plugins/example-detail.webp",
    previewWidth: 1200,
    previewHeight: 800,
  });

  assert.match(html, /<button class="detail-preview" type="button" data-preview-open/);
  assert.match(html, /aria-label="Open &quot;&gt;&lt;span data-injected&gt;Unsafe&lt;\/span&gt; preview"/);
  assert.match(html, /alt="&quot;&gt;&lt;span data-injected&gt;Unsafe&lt;\/span&gt; desktop preview"/);
  assert.doesNotMatch(html, /<figure class="detail-preview"|<span data-injected>/);
});

test("preview lightbox keeps untrusted alt text inert and restores focus", () => {
  const listenersFor = (element) => {
    element.listeners = new Map();
    element.addEventListener = (type, listener) => element.listeners.set(type, listener);
    return element;
  };
  const document = {
    createElement(tagName) {
      const element = listenersFor({ tagName, attributes: {} });
      element.setAttribute = (name, value) => { element.attributes[name] = String(value); };
      return element;
    },
  };
  const unsafeAlt = `\"><img src=x onerror=alert(1)> desktop preview`;
  const previewImage = {
    alt: unsafeAlt,
    currentSrc: "",
    src: "https://example.test/fallback.webp",
    getAttribute: (name) => ({ width: "1200", height: "800" })[name] || null,
  };
  const trigger = listenersFor({
    dataset: { fullSrc: "assets/img/plugins/example-detail.webp" },
    querySelector: (selector) => selector === "img" ? previewImage : null,
    focusOptions: null,
    focus(options) { this.focusOptions = options; },
  });
  const root = {
    ownerDocument: document,
    querySelector: (selector) => selector === "[data-preview-open]" ? trigger : null,
  };
  const dialog = listenersFor({
    open: false,
    children: [],
    closeCount: 0,
    replaceChildren(...children) { this.children = children; },
    showModal() { this.open = true; },
    close() { this.closeCount += 1; },
  });
  Object.defineProperty(dialog, "innerHTML", {
    set() { assert.fail("Lightbox content must not use innerHTML"); },
  });

  setupPreviewLightbox(root, dialog);
  trigger.listeners.get("click")();

  assert.equal(dialog.open, true);
  assert.equal(dialog.children.length, 2);
  const [closeButton, fullImage] = dialog.children;
  assert.equal(closeButton.tagName, "button");
  assert.equal(closeButton.attributes["aria-label"], "Close preview");
  assert.equal(fullImage.tagName, "img");
  assert.equal(fullImage.src, "assets/img/plugins/example-detail.webp");
  assert.equal(fullImage.alt, unsafeAlt);
  assert.equal(fullImage.width, 1200);
  assert.equal(fullImage.height, 800);

  closeButton.listeners.get("click")();
  dialog.listeners.get("click")({ target: dialog });
  assert.equal(dialog.closeCount, 2);

  dialog.listeners.get("close")();
  assert.deepEqual(dialog.children, []);
  assert.deepEqual(trigger.focusOptions, { preventScroll: true });
});

test("manual setup plugin details render the manual-install security context", () => {
  const html = render({
    installAvailable: false,
    installCommand: "",
    installNote: "Follow the upstream installation instructions.",
    status: "Manual setup",
  });

  assertCommunitySectionOrder(html);
  assert.match(html, /<h2>Availability<\/h2>/);
  assert.match(html, /<strong>Manual setup<\/strong>/);
  assert.match(html, /Snapshot unverified:<\/strong> This listed commit has not been verified\./);
  assert.match(html, /Manual installation follows the upstream project’s instructions\./);
  assert.doesNotMatch(html, /This Omarchy command clones the repository’s current HEAD\./);
});

test("verified plugin details render only the exact verified snapshot", () => {
  const html = render({
    verificationStatus: "verified",
    verificationSnapshotStatus: "verified",
    verificationCoverage: "snapshot-verified",
    verificationCommit: verifiedCommit,
    listingValidatedCommit: verifiedCommit,
    listingValidatedAt: "2026-08-20T12:00:00.000Z",
    listingValidatedBranch: "main",
    upstreamCheckStatus: "passed",
    upstreamValidatedCommit: verifiedCommit,
    upstreamObservedCommit: verifiedCommit,
    upstreamObservedBranch: "main",
    upstreamCheckedAt: "2026-08-20T12:00:00.000Z",
  });

  assertCommunitySectionOrder(html);
  assert.match(html, /Snapshot verified:<\/strong> Marketplace verification covers only the exact commit/);
  assert.match(html, new RegExp(`<dt>Verified snapshot<\\/dt><dd><a href="https:\\/\\/github\\.com\\/example\\/community-plugin\\/commit\\/${verifiedCommit}"[\\s\\S]*<code>1111111<\\/code>`));
  assert.doesNotMatch(html, /Snapshot unverified:|Update unverified:|Contributor action:/);
});

test("changed upstream details preserve the verified snapshot and flag the update", () => {
  const html = render({
    verificationStatus: "unverified",
    verificationSnapshotStatus: "verified",
    verificationCoverage: "update-unverified",
    verificationCommit: verifiedCommit,
    listingValidatedCommit: verifiedCommit,
    listingValidatedAt: "2026-08-20T12:00:00.000Z",
    listingValidatedBranch: "main",
    upstreamCheckStatus: "passed",
    upstreamValidatedCommit: upstreamCommit,
    upstreamObservedCommit: upstreamCommit,
    upstreamObservedBranch: "main",
    upstreamCheckedAt: "2026-08-21T12:00:00.000Z",
  });

  assertCommunitySectionOrder(html);
  assert.match(html, /Snapshot verified:<\/strong>/);
  assert.match(html, /Update unverified:<\/strong> The latest upstream changes have not been verified\./);
  assert.match(html, /Contributor action:<\/strong> Submit the new exact commit/);
});

test("observed commit drift overrides stale snapshot coverage", () => {
  const html = render({
    verificationStatus: "verified",
    verificationSnapshotStatus: "verified",
    verificationCoverage: "snapshot-verified",
    verificationCommit: verifiedCommit,
    listingValidatedCommit: verifiedCommit,
    upstreamObservedCommit: upstreamCommit,
  });

  assert.match(html, /Snapshot verified:<\/strong>/);
  assert.match(html, /Update unverified:<\/strong> The latest upstream changes have not been verified\./);
  assert.match(html, /Contributor action:<\/strong> Submit the new exact commit/);
});

test("detail checks use a valid fallback when observed commit metadata is malformed", () => {
  const html = render({
    verificationStatus: "verified",
    verificationSnapshotStatus: "verified",
    verificationCoverage: "snapshot-verified",
    verificationCommit: verifiedCommit,
    listingValidatedCommit: verifiedCommit,
    upstreamObservedCommit: "malformed",
    upstreamValidatedCommit: upstreamCommit.toUpperCase(),
    upstreamCheckStatus: "passed",
  });

  assert.match(html, /Update unverified:<\/strong>/);
  assert.match(html, new RegExp(`/compare/${verifiedCommit}\\.\\.\\.${upstreamCommit}`));
  assert.doesNotMatch(html, /No changes detected|Could not determine/);
});

test("detail checks fail closed when current commit metadata is invalid", () => {
  const html = render({
    verificationStatus: "verified",
    verificationSnapshotStatus: "verified",
    verificationCoverage: "snapshot-verified",
    verificationCommit: verifiedCommit,
    listingValidatedCommit: verifiedCommit,
    upstreamObservedCommit: "malformed",
    upstreamValidatedCommit: "also-malformed",
    upstreamCheckStatus: "passed",
  });

  assert.match(html, /Update unverified:<\/strong>/);
  assert.match(html, /Could not determine/);
  assert.doesNotMatch(html, /View changes|No changes detected/);
});

test("compatibility failures override stale manual status and install commands", () => {
  const html = render({
    installAvailable: false,
    installCommand: "omarchy plugin add https://github.com/example/stale.git --enable",
    installNote: "The latest compatibility check failed.",
    status: "Manual setup",
    upstreamCheckStatus: "failed",
  });

  assertCommunitySectionOrder(html);
  assert.match(html, /<strong>Compatibility failed<\/strong>/);
  assert.match(html, /Marketplace installation is unavailable because compatibility has not been confirmed\./);
  assert.match(html, /Installation through another method is not bound to the marketplace’s listed or verified snapshot/);
  assert.doesNotMatch(html, /Manual installation follows the upstream project’s instructions\.|data-install-copy/);
});

test("mismatched snapshot commits fail closed as unverified", () => {
  const html = render({
    verificationStatus: "verified",
    verificationSnapshotStatus: "verified",
    verificationCoverage: "snapshot-verified",
    verificationCommit: verifiedCommit,
    listingValidatedCommit: upstreamCommit,
  });

  assert.match(html, /Snapshot unverified:<\/strong>/);
  assert.match(html, /Contributor action:<\/strong> Submit the exact listed commit/);
  assert.match(html, /<dt>Listing snapshot<\/dt>/);
  assert.doesNotMatch(html, /Snapshot verified:|Update unverified:|<dt>Verified snapshot<\/dt>/);
});

test("suite listings do not offer the unsupported verification workflow", () => {
  const html = render({
    installAvailable: false,
    installCommand: "",
    installNote: "Follow the suite installation instructions.",
    status: "Manual setup",
    repositoryLayout: "suite",
    verificationStatus: "unverified",
    verificationSnapshotStatus: "verified",
    verificationCoverage: "update-unverified",
    verificationCommit: verifiedCommit,
    listingValidatedCommit: verifiedCommit,
    upstreamObservedCommit: upstreamCommit,
  });

  assert.match(html, /Verification unavailable:<\/strong> Suite listings are outside the plugin verification workflow\./);
  assert.doesNotMatch(html, /Snapshot verified:|Snapshot unverified:|Update unverified:|Contributor action:|plugin verification form|detail-verification/);
});

test("community plugin author links to the marketplace author filter", () => {
  const html = render();

  assert.match(html, /<span>by <a href="index\.html\?author=example" aria-label="Show all plugins by @example">Example Maintainer<\/a><\/span>/);
});

test("built-in plugin author renders as plain text", () => {
  const html = render({
    builtIn: true,
    repo: "https://github.com/basecamp/omarchy",
    sourceType: "builtin",
    officialCommand: "omarchy plugin enable example.community-plugin",
    officialCommandLabel: "Enable plugin",
  });

  assert.match(html, /<span>by Example Maintainer<\/span>/);
  assert.doesNotMatch(html, /<a href="index\.html\?author=/);
});
