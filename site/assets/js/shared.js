const accentColors = {
  lime: "#b7ef51",
  violet: "#a78bfa",
  amber: "#f4bd62",
  cyan: "#68d6e8",
  coral: "#f18c75",
  blue: "#74a7f7",
  mint: "#69d4a7",
  rose: "#e896ba"
};

export function accentColor(name) {
  return accentColors[name] || accentColors.lime;
}

const taxonomyTagNames = Object.freeze({
  ai: "AI",
  games: "Games",
  launcher: "Launcher",
  media: "Media",
  "power-management": "Power",
  security: "Security",
  system: "System",
  workspaces: "Workspace",
});

export function displayTaxonomyTag(value) {
  const tag = String(value || "").trim();
  return taxonomyTagNames[tag] || tag;
}

export async function loadCatalog() {
  const response = await fetch("catalog.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`Catalog request failed: ${response.status}`);
  return response.json();
}

export function formatDate(value) {
  if (!value) return "Unknown";
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric"
  }).format(new Date(value));
}

export function formatStars(value = 0) {
  return formatEngagementCount(value);
}

function engagementCount(value) {
  const count = Math.trunc(Number(value));
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

export function formatEngagementCount(value = 0) {
  const count = engagementCount(value);
  if (count < 1000) return String(count);
  if (count < 10_000) return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

export function comparePluginEngagement(first, second, stats = {}, metric = "views") {
  const key = ["views", "copies", "hearts"].includes(metric) ? metric : "views";
  const value = (plugin) => engagementCount(stats?.[plugin?.id]?.[key]);
  return value(second) - value(first)
    || String(first?.name || "").localeCompare(String(second?.name || ""))
    || String(first?.id || "").localeCompare(String(second?.id || ""));
}

function engagementMetric(type, count, detail) {
  const views = type === "views";
  const label = views ? "marketplace detail views" : "successful command copies";
  const tooltipLabel = views ? "Marketplace detail views" : "Successful command copies";
  const icon = views
    ? '<span class="engagement-glyph" aria-hidden="true"></span>'
    : '<span class="copy-icon engagement-copy-icon" aria-hidden="true"></span>';
  const visibleName = views ? "views" : "copies";
  const tooltip = detail
    ? ` title="${label}"`
    : `<span class="control-tooltip" role="tooltip" aria-hidden="true">${tooltipLabel}</span>`;
  return `<span class="engagement-metric${detail ? "" : " has-control-tooltip"}" data-engagement-metric="${type}"${detail ? tooltip : ""}><span class="engagement-visual" aria-hidden="true">${icon}<span data-engagement-value>${formatEngagementCount(count)}</span>${detail ? `<span class="engagement-name">${visibleName}</span>` : ""}</span><span class="sr-only" data-engagement-accessible>${count} ${label}</span>${detail ? "" : tooltip}</span>`;
}

export function engagementSummary(plugin, stats = {}, {
  detail = false,
  pending = false,
} = {}) {
  const views = engagementCount(stats.views);
  const copies = engagementCount(stats.copies);
  const hasCommand = Boolean(plugin?.builtIn ? plugin.officialCommand : plugin?.installCommand);
  return `<div class="plugin-engagement${detail ? " detail-engagement" : ""}${pending ? " is-pending" : ""}" data-plugin-engagement="${escapeHtml(plugin?.id || "")}"${pending ? ' aria-busy="true"' : ""}>${engagementMetric("views", views, detail)}${hasCommand ? engagementMetric("copies", copies, detail) : ""}</div>`;
}

export function pluginHeartButton(plugin, stats = {}, {
  detail = false,
  hearted = false,
  pending = false,
} = {}) {
  const pluginId = escapeHtml(plugin?.id || "");
  const pluginName = escapeHtml(plugin?.name || "plugin");
  const count = engagementCount(stats.hearts);
  const action = hearted ? "Heart sent" : "Send a heart";
  const tooltip = detail
    ? ""
    : `<span class="control-tooltip" data-heart-tooltip role="tooltip" aria-hidden="true">${action}</span>`;
  return `<button class="plugin-heart${detail ? " detail-heart" : " has-control-tooltip"}${hearted ? " is-hearted" : ""}${pending ? " is-pending" : ""}" type="button" data-plugin-heart="${pluginId}" data-plugin-name="${pluginName}" aria-label="${action} for ${pluginName}; ${count} anonymous hearts" aria-pressed="${hearted}"${pending ? ' aria-busy="true"' : ""}${hearted ? ' aria-disabled="true"' : ""}><span class="social-glyph heart-glyph" data-heart-glyph aria-hidden="true"></span><span class="social-count" data-heart-value aria-hidden="true">${formatEngagementCount(count)}</span>${tooltip}</button>`;
}

export function hidePendingEngagement(root) {
  root.querySelectorAll(".plugin-engagement.is-pending, .plugin-heart.is-pending").forEach((element) => {
    element.hidden = true;
    element.classList.remove("is-pending");
    element.removeAttribute("aria-busy");
  });
}

export function updatePluginHeart(root, pluginId, stats = {}, {
  animate = false,
  hearted = false,
} = {}) {
  const count = engagementCount(stats.hearts);
  root.querySelectorAll("[data-plugin-heart]").forEach((button) => {
    if (button.dataset.pluginHeart !== pluginId) return;
    button.hidden = false;
    button.classList.remove("is-pending");
    button.classList.toggle("is-hearted", hearted);
    button.removeAttribute("aria-busy");
    button.setAttribute("aria-pressed", String(hearted));
    button.disabled = false;
    if (hearted) button.setAttribute("aria-disabled", "true");
    else button.removeAttribute("aria-disabled");
    const action = hearted ? "Heart sent" : "Send a heart";
    button.setAttribute("aria-label", `${action} for ${button.dataset.pluginName || "plugin"}; ${count} anonymous hearts`);
    const tooltip = button.querySelector("[data-heart-tooltip]");
    if (tooltip) {
      tooltip.textContent = action;
      positionControlTooltip(button);
    }
    const value = button.querySelector("[data-heart-value]");
    if (value) value.textContent = formatEngagementCount(count);
    if (!animate) return;
    button.classList.remove("is-celebrating");
    void button.offsetWidth;
    button.classList.add("is-celebrating");
    button.addEventListener("animationend", () => {
      button.classList.remove("is-celebrating");
    }, { once: true });
  });
}

const controlTooltipRoots = new WeakSet();
const controlTooltipDocuments = new WeakSet();

export function positionTooltip(host, tooltip) {
  const hostRect = host.getBoundingClientRect();
  const tooltipWidth = tooltip.getBoundingClientRect().width;
  const viewportWidth = host.ownerDocument.documentElement.clientWidth;
  const originLeft = hostRect.left + host.clientLeft;
  const centered = (hostRect.width - tooltipWidth) / 2 - host.clientLeft;
  const minimum = 8 - originLeft;
  const maximum = viewportWidth - 8 - originLeft - tooltipWidth;
  const clamped = Math.min(Math.max(centered, minimum), maximum);
  const positioned = clamped <= minimum
    ? Math.ceil(clamped)
    : clamped >= maximum
      ? Math.floor(clamped)
      : Math.round(clamped);
  tooltip.style.right = "auto";
  tooltip.style.left = `${positioned}px`;
}

function positionControlTooltip(host) {
  const tooltip = host.querySelector(":scope > .control-tooltip");
  if (tooltip) positionTooltip(host, tooltip);
}

export function setupControlTooltips(root) {
  root.querySelectorAll(".has-control-tooltip").forEach((host) => {
    if (host.dataset.controlTooltipReady === "true") return;
    host.dataset.controlTooltipReady = "true";
    const show = () => {
      host.classList.remove("is-tooltip-dismissed");
      positionControlTooltip(host);
    };
    host.addEventListener("pointerenter", show);
    host.addEventListener("focusin", show);
  });

  if (!controlTooltipRoots.has(root)) {
    controlTooltipRoots.add(root);
    root.ownerDocument.defaultView?.addEventListener("resize", () => {
      root.querySelectorAll(".has-control-tooltip:hover, .has-control-tooltip:focus-within")
        .forEach(positionControlTooltip);
    });
  }

  const documentRef = root.ownerDocument;
  if (!controlTooltipDocuments.has(documentRef)) {
    controlTooltipDocuments.add(documentRef);
    documentRef.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      documentRef.querySelectorAll(".has-control-tooltip:hover, .has-control-tooltip:focus-within")
        .forEach((host) => host.classList.add("is-tooltip-dismissed"));
    });
  }
}

export function updateEngagementSummary(root, pluginId, stats = {}) {
  const values = {
    views: engagementCount(stats.views),
    copies: engagementCount(stats.copies),
  };
  root.querySelectorAll("[data-plugin-engagement]").forEach((summary) => {
    if (summary.dataset.pluginEngagement !== pluginId) return;
    summary.hidden = false;
    summary.classList.remove("is-pending");
    summary.removeAttribute("aria-busy");
    summary.querySelectorAll("[data-engagement-metric]").forEach((metric) => {
      const type = metric.dataset.engagementMetric;
      if (!Object.hasOwn(values, type)) return;
      const count = values[type];
      const label = type === "views" ? "marketplace detail views" : "successful command copies";
      const value = metric.querySelector("[data-engagement-value]");
      if (value) value.textContent = formatEngagementCount(count);
      const accessible = metric.querySelector("[data-engagement-accessible]");
      if (accessible) accessible.textContent = `${count} ${label}`;
    });
  });
}

export function listingTime(plugin) {
  if (plugin?.listedAt) return Date.parse(plugin.listedAt);
  if (plugin?.addedAt) return Date.parse(`${plugin.addedAt}T00:00:00Z`);
  return Number.NaN;
}

export function activityTime(plugin) {
  const timestamps = [
    Date.parse(plugin?.versionUpdatedAt || ""),
    Date.parse(plugin?.repositoryUpdatedAt || ""),
  ].filter(Number.isFinite);
  return timestamps.length ? Math.max(...timestamps) : 0;
}

export function currentHashId() {
  const raw = location.hash.slice(1);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function isRecentlyAdded(plugin, now = Date.now(), windowHours = 12) {
  if (plugin?.builtIn || plugin?.placeholder) return false;
  const listedAt = listingTime(plugin);
  if (!Number.isFinite(listedAt)) return false;
  const age = now - listedAt;
  return age >= 0 && age < windowHours * 60 * 60 * 1000;
}

export function isRecentlyUpdated(plugin, now = Date.now(), windowHours = 12) {
  if (!plugin?.versionUpdatedAt || plugin?.builtIn || plugin?.placeholder) return false;
  const updatedAt = Date.parse(plugin.versionUpdatedAt);
  if (!Number.isFinite(updatedAt)) return false;
  const age = now - updatedAt;
  return age >= 0 && age < windowHours * 60 * 60 * 1000;
}

export function pluginVersionLabel(plugin) {
  if (plugin?.placeholder || !plugin?.version) return "";
  const version = String(plugin.version).trim();
  if (!version) return "";
  return `manifest ${/^v\d/i.test(version) ? version : `v${version}`}`;
}

export function publisherLogin(plugin) {
  try {
    const url = new URL(plugin.repo);
    if (url.hostname.toLowerCase() !== "github.com") return "";
    return url.pathname.split("/").filter(Boolean)[0] || "";
  } catch {
    return "";
  }
}

function fullCommit(value) {
  return /^[a-f0-9]{40}$/i.test(value || "") ? value.toLowerCase() : "";
}

export function listingCommitComparison(plugin) {
  const listingCommit = fullCommit(plugin?.listingValidatedCommit);
  const upstreamCommit = fullCommit(plugin?.upstreamObservedCommit)
    || fullCommit(plugin?.upstreamValidatedCommit);
  const comparison = !listingCommit || !upstreamCommit
    ? "unknown"
    : upstreamCommit === listingCommit
      ? "unchanged"
      : "changed";
  return { listingCommit, upstreamCommit, comparison };
}

export function hasExactVerificationSnapshot(plugin) {
  const verificationCommit = fullCommit(plugin?.verificationCommit);
  const { listingCommit } = listingCommitComparison(plugin);
  return plugin?.verificationSnapshotStatus === "verified"
    && Boolean(verificationCommit)
    && verificationCommit === listingCommit;
}

export function matchesVerificationStatus(plugin, status) {
  return !plugin?.builtIn
    && plugin?.repositoryLayout !== "suite"
    && plugin?.verificationStatus === status;
}

export function pluginVerificationState(plugin) {
  if (plugin?.builtIn) return null;
  if (plugin?.verificationStatus === "verified") {
    return {
      status: "verified",
      label: "Verified",
      explanation: plugin?.verificationMethod === "maintainer-reviewed"
        ? "A marketplace maintainer reviewed the reported capabilities for the listed commit. This is not a security audit."
        : "Automated checks passed for the listed commit. This is not a security audit.",
    };
  }
  return {
    status: "unverified",
    label: "Unverified",
    explanation: "No current verification record is available for the listed commit. This does not mean the plugin is malicious.",
  };
}

export function pluginVerificationDetailState(plugin) {
  if (plugin?.builtIn || plugin?.repositoryLayout === "suite") return null;
  if (
    hasExactVerificationSnapshot(plugin)
    && (
      plugin?.verificationStatus === "verified"
      || plugin?.verificationCoverage === "update-unverified"
    )
  ) {
    const verifiedCommit = fullCommit(plugin.verificationCommit);
    const { upstreamCommit } = listingCommitComparison(plugin);
    const updateUnverified = plugin?.verificationCoverage === "update-unverified"
      || !upstreamCommit
      || upstreamCommit !== verifiedCommit;
    if (updateUnverified) {
      return {
        status: "unverified",
        coverage: "update-unverified",
        label: "Snapshot verified. Update unverified",
        markerLabels: ["Snapshot verified", "Update unverified"],
        explanation: upstreamCommit
          ? "The current upstream commit differs from the verified snapshot. The update and mutable upstream install command are not covered by that verification."
          : "The current upstream commit could not be confirmed. The mutable upstream install command is not covered by the snapshot verification.",
      };
    }
    return {
      status: "verified",
      coverage: "snapshot-verified",
      label: "Snapshot verified",
      markerLabels: ["Snapshot verified"],
      explanation: plugin?.verificationMethod === "maintainer-reviewed"
        ? "A marketplace maintainer reviewed the reported findings and capabilities for this exact snapshot. The mutable upstream install command is not commit-bound. This is not a security audit."
        : "Automated checks passed for this exact snapshot. The mutable upstream install command is not commit-bound. This is not a security audit.",
    };
  }
  return {
    status: "unverified",
    coverage: "unverified",
    label: "Unverified",
    markerLabels: ["Unverified"],
    explanation: "No current verification record is available for the listed snapshot. This does not mean the plugin is malicious.",
  };
}

export function listingCheckState(plugin) {
  const { upstreamCommit, comparison } = listingCommitComparison(plugin);

  if (plugin?.upstreamCheckStatus === "passed") {
    return {
      statusLabel: "Passed",
      statusTone: "is-passed",
      commitLabel: "Checked commit",
      checkedCommit: upstreamCommit,
      comparison,
    };
  }

  if (plugin?.upstreamCheckStatus === "failed") {
    return {
      statusLabel: "Failed",
      statusTone: "is-failed",
      commitLabel: "Checked commit",
      checkedCommit: upstreamCommit,
      lastCompatibleCommit: fullCommit(plugin.upstreamValidatedCommit),
      comparison,
    };
  }

  return {
    statusLabel: "Status unknown",
    statusTone: "is-caution",
    commitLabel: "Last compatible",
    checkedCommit: fullCommit(plugin?.upstreamValidatedCommit),
    lastSuccessfulAt: plugin?.upstreamValidatedAt,
    comparison: "unknown",
  };
}

export function paginationState(totalItems, requestedPage = 1, pageSize = 9) {
  const total = Math.max(0, Math.trunc(Number(totalItems)) || 0);
  const size = Math.max(1, Math.trunc(Number(pageSize)) || 1);
  const totalPages = Math.max(1, Math.ceil(total / size));
  const page = Math.min(totalPages, Math.max(1, Math.trunc(Number(requestedPage)) || 1));
  const start = (page - 1) * size;

  return {
    page,
    totalPages,
    start,
    end: Math.min(start + size, total),
    hasPrevious: page > 1,
    hasNext: page < totalPages,
  };
}

export function catalogViewControls(totalItems, showAll, pageSize = 9) {
  const total = Math.max(0, Math.trunc(Number(totalItems)) || 0);
  const size = Math.max(1, Math.trunc(Number(pageSize)) || 1);
  return {
    paginationHidden: Boolean(showAll) || total <= size,
    browseAllHidden: Boolean(showAll) || total <= size,
    dockHidden: !showAll,
    reserveDockSpace: Boolean(showAll),
  };
}

export function appendCatalogViewState(params, { showAll = false, page = 1 } = {}) {
  params.delete("view");
  params.delete("page");
  if (showAll) params.set("view", "all");
  else if (page > 1) params.set("page", String(page));
  return params;
}

export function readCatalogViewState(params) {
  const showAll = params.get("view") === "all";
  return {
    showAll,
    page: showAll
      ? 1
      : Math.max(1, Number.parseInt(params.get("page") || "1", 10) || 1),
  };
}

export function setupSectionNavigation({
  sectionSelector,
  linkSelector,
  markerRatio = 0.55,
  markerMax = Number.POSITIVE_INFINITY,
  activateLastAtPageEnd = true,
}) {
  const sections = [...document.querySelectorAll(sectionSelector)];
  const links = [...document.querySelectorAll(linkSelector)];
  if (!sections.length || !links.length) return () => {};

  let frame = 0;
  let pinnedId = "";
  let pinTimer = 0;

  const setActive = (id) => {
    for (const link of links) {
      const sectionIds = link.dataset.sectionIds
        ?.trim()
        .split(/\s+/)
        .filter(Boolean) || [link.hash.slice(1)];
      const active = sectionIds.includes(id);
      link.classList.toggle("active", active);
      if (active) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    }
  };

  const update = () => {
    frame = 0;
    const atPageEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
    let active = sections[0];

    if (activateLastAtPageEnd && atPageEnd) {
      active = sections.at(-1);
    } else {
      const marker = window.scrollY + Math.min(markerMax, window.innerHeight * markerRatio);
      for (const section of sections) {
        const sectionTop = section.getBoundingClientRect().top + window.scrollY;
        if (sectionTop <= marker) active = section;
        else break;
      }
    }

    if (!pinnedId) setActive(active.id);
  };

  const scheduleUpdate = () => {
    if (!frame) frame = window.requestAnimationFrame(update);
  };

  const pinSection = (id) => {
    pinnedId = id;
    window.clearTimeout(pinTimer);
    pinTimer = window.setTimeout(() => {
      pinnedId = "";
    }, 900);
    setActive(id);
  };

  for (const link of links) {
    link.addEventListener("click", () => pinSection(link.hash.slice(1)));
  }
  const releasePinnedSection = () => {
    if (!pinnedId) return;
    window.clearTimeout(pinTimer);
    pinnedId = "";
    scheduleUpdate();
  };
  const releaseOnNavigationKey = (event) => {
    if (["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " "].includes(event.key)) {
      releasePinnedSection();
    }
  };
  window.addEventListener("scroll", scheduleUpdate, { passive: true });
  window.addEventListener("resize", scheduleUpdate);
  window.addEventListener("wheel", releasePinnedSection, { passive: true });
  window.addEventListener("touchstart", releasePinnedSection, { passive: true });
  window.addEventListener("keydown", releaseOnNavigationKey);
  const handleHashChange = () => {
    const id = currentHashId();
    if (sections.some((section) => section.id === id)) {
      pinSection(id);
    }
  };
  window.addEventListener("hashchange", handleHashChange);

  const initialId = currentHashId();
  if (sections.some((section) => section.id === initialId)) {
    pinSection(initialId);
  } else {
    update();
  }

  return () => {
    if (frame) window.cancelAnimationFrame(frame);
    window.clearTimeout(pinTimer);
    window.removeEventListener("scroll", scheduleUpdate);
    window.removeEventListener("resize", scheduleUpdate);
    window.removeEventListener("wheel", releasePinnedSection);
    window.removeEventListener("touchstart", releasePinnedSection);
    window.removeEventListener("keydown", releaseOnNavigationKey);
    window.removeEventListener("hashchange", handleHashChange);
  };
}

export function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function setupThemeToggle() {
  const toggle = document.querySelector(".theme-toggle");
  if (!toggle) return;

  const syncThemeState = () => {
    const current = document.documentElement.dataset.theme === "light" ? "light" : "dark";
    const next = current === "dark" ? "light" : "dark";
    toggle.setAttribute("aria-label", `${current} theme active; switch to ${next} theme`);
    toggle.setAttribute("aria-pressed", String(current === "light"));
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) themeColor.content = current === "light" ? "#f8f8f6" : "#000000";
  };

  syncThemeState();
  toggle.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("omarchy-theme", next);
    syncThemeState();
  });
}

let toastTimer;
const copyLabelStates = new WeakMap();

export function findCopyLabel(button) {
  return button?.querySelector("[data-copy-label]")
    ?? button?.querySelector('.copy-button > span:not([aria-hidden="true"])');
}

export function showCopiedState(label, icon, duration = 1400) {
  if (!label) return;
  const previous = copyLabelStates.get(label);
  const original = previous?.original ?? label.textContent;
  const activeIcon = icon ?? previous?.icon;
  if (previous) clearTimeout(previous.timer);
  label.textContent = "Copied";
  activeIcon?.classList.add("is-copied");
  const timer = setTimeout(() => {
    label.textContent = original;
    activeIcon?.classList.remove("is-copied");
    copyLabelStates.delete(label);
  }, duration);
  copyLabelStates.set(label, { original, timer, icon: activeIcon });
}

export function showToast(message = "Copied to clipboard") {
  const toast = document.querySelector("#toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 1800);
}

export async function writeClipboard(value, {
  clipboard = globalThis.navigator?.clipboard,
  documentRef = globalThis.document,
} = {}) {
  try {
    if (!clipboard?.writeText) throw new Error("Clipboard API unavailable");
    await clipboard.writeText(value);
    return true;
  } catch {
    if (!documentRef?.createElement || !documentRef?.body) return false;
    const area = documentRef.createElement("textarea");
    area.value = value;
    area.style.position = "fixed";
    area.style.opacity = "0";
    documentRef.body.append(area);
    area.select();
    try {
      return Boolean(documentRef.execCommand?.("copy"));
    } catch {
      return false;
    } finally {
      area.remove();
    }
  }
}

export async function copyText(value, button) {
  if (!value) return false;
  if (!await writeClipboard(value)) {
    showToast("Copy failed. Select and copy manually.");
    return false;
  }

  const label = findCopyLabel(button);
  showCopiedState(label, button?.querySelector(".copy-icon"));
  showToast("Copied to clipboard");
  return true;
}

export function setupCopyButtons(root = document) {
  root.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", () => copyText(button.dataset.copy, button));
  });
}

export function starIcon() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z"/></svg>';
}

export function clockIcon() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/></svg>';
}
