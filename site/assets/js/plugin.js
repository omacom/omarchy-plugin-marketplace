import {
  accentColor,
  copyText,
  currentHashId,
  displayTaxonomyTag,
  engagementSummary,
  escapeHtml,
  formatDate,
  formatStars,
  hasExactVerificationSnapshot,
  hidePendingEngagement,
  listingCheckState,
  listingCommitComparison,
  loadCatalog,
  pluginHeartButton,
  pluginVerificationDetailState,
  pluginVersionLabel,
  publisherLogin,
  setupControlTooltips,
  setupSectionNavigation,
  setupThemeToggle,
  showToast,
  updateEngagementSummary,
  updatePluginHeart
} from "./shared.js?v=20260831-01";
import {
  engagementApiBaseUrl,
  hasPluginHeart,
  loadEngagementStats,
  recordPluginCopy,
  recordPluginHeart,
  recordPluginView,
} from "./engagement.js?v=20260831-01";

function safeGitHubWebUrl(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:"
      || url.hostname !== "github.com"
      || url.username
      || url.password
      || url.port
    ) return "";
    return url.href;
  } catch {
    return "";
  }
}

function authorLink(plugin) {
  const login = publisherLogin(plugin);
  if (!login || plugin.builtIn) return escapeHtml(plugin.author);
  return `<a href="index.html?author=${encodeURIComponent(login)}" aria-label="Show all plugins by @${escapeHtml(login)}">${escapeHtml(plugin.author)}</a>`;
}

function marketplaceInstallAvailable(plugin) {
  return Boolean(plugin.installAvailable && plugin.upstreamCheckStatus !== "failed");
}

function displayedStatus(plugin) {
  if (plugin.upstreamCheckStatus === "failed") return "Compatibility failed";
  return plugin.status || (marketplaceInstallAvailable(plugin) ? "Available" : "Installation unavailable");
}

function statusTone(plugin) {
  if (plugin.upstreamCheckStatus === "failed") return "is-failed";
  if (
    plugin.upstreamCheckStatus === "unreachable"
    || (!plugin.installAvailable && !plugin.builtIn && !plugin.placeholder)
  ) return "is-caution";
  return "";
}

function verificationMarkers(verification) {
  return verification.markerLabels.map((label) => (
    `<span class="card-verification-marker${label === "Snapshot verified" ? " is-snapshot" : label === "Update unverified" ? " is-update" : ""}">${escapeHtml(label)}</span>`
  )).join("");
}

function detailVerificationBadge(plugin) {
  const verification = pluginVerificationDetailState(plugin);
  if (!verification) return "";
  return `<span class="card-verification detail-verification is-${verification.status}" aria-label="${escapeHtml(verification.label)}">
    <span class="card-verification-trigger">${verificationMarkers(verification)}</span>
  </span>`;
}

function asideVerificationBadge(verification) {
  const markers = verification.markerLabels.map((label) => {
    const tone = label === "Snapshot verified" ? "" : " is-unverified";
    return `<span class="aside-verification-marker status-label${tone}">${escapeHtml(label)}</span>`;
  }).join("");
  return `<span class="aside-verification is-${verification.status}" aria-label="${escapeHtml(verification.label)}">${markers}</span>`;
}

function setupDetailMetaLineStarts(root) {
  const meta = root.querySelector(".page-meta");
  if (!meta) return;
  const update = () => {
    let lineCenter = null;
    [...meta.children].forEach((item) => {
      item.classList.remove("is-line-start");
      if (getComputedStyle(item).display === "none") return;
      const rect = item.getBoundingClientRect();
      const center = (rect.top + rect.bottom) / 2;
      if (lineCenter === null || Math.abs(center - lineCenter) > 2) {
        item.classList.add("is-line-start");
        lineCenter = center;
      }
    });
  };
  update();
  root.ownerDocument.fonts?.ready.then(update);
  root.ownerDocument.defaultView?.addEventListener("resize", update);
}

export function setupPreviewLightbox(root, dialog) {
  const trigger = root.querySelector("[data-preview-open]");
  const previewImage = trigger?.querySelector("img");
  if (!trigger || !previewImage || !dialog) return;

  const document = root.ownerDocument;
  const openPreview = () => {
    if (dialog.open) return;

    const closeButton = document.createElement("button");
    closeButton.className = "lightbox-close";
    closeButton.type = "button";
    closeButton.setAttribute("aria-label", "Close preview");
    closeButton.textContent = "×";

    const fullImage = document.createElement("img");
    fullImage.className = "lightbox-img";
    fullImage.src = trigger.dataset.fullSrc || previewImage.currentSrc || previewImage.src;
    fullImage.alt = previewImage.alt;
    fullImage.width = Number(previewImage.getAttribute("width")) || 1600;
    fullImage.height = Number(previewImage.getAttribute("height")) || 900;
    fullImage.decoding = "async";

    closeButton.addEventListener("click", () => dialog.close());
    dialog.replaceChildren(closeButton, fullImage);
    dialog.showModal();
  };

  trigger.addEventListener("click", openPreview);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", () => {
    dialog.replaceChildren();
    trigger.focus({ preventScroll: true });
  });
}

export function detailTemplate(plugin, engagement, {
  engagementEnabled = false,
  hearted = false,
  pendingEngagement = false,
} = {}) {
  const securityReportUrl = "https://github.com/omacom/omarchy-plugin-marketplace/security/advisories/new";
  const verificationRequestUrl = "https://github.com/omacom/omarchy-plugin-marketplace/issues/new?template=verify-plugin.yml";
  const tags = (plugin.tags || []).map((tag) => `<span class="tag">${escapeHtml(displayTaxonomyTag(tag))}</span>`).join("");
  const preview = plugin.previewImage
    ? `<button class="detail-preview" type="button" data-preview-open data-full-src="${escapeHtml(plugin.previewImage)}" aria-label="${escapeHtml(`Open ${plugin.name} preview`)}"><img src="${escapeHtml(plugin.previewImage)}" alt="${escapeHtml(plugin.name)} desktop preview" width="${Number(plugin.previewWidth) || 1600}" height="${Number(plugin.previewHeight) || 900}"></button>`
    : "";
  const installAvailable = marketplaceInstallAvailable(plugin);
  const pluginStatus = displayedStatus(plugin);
  const command = plugin.builtIn
    ? plugin.officialCommand
    : installAvailable
      ? plugin.installCommand
      : "";
  const commandLabel = plugin.builtIn ? plugin.officialCommandLabel : "Install current upstream";
  const copyCommandLabel = plugin.builtIn
    ? `Copy ${commandLabel.toLowerCase()} command`
    : "Copy mutable upstream install command";
  const commandPanel = command ? `<div class="command-panel">
        <div class="command-panel-head"><span>BASH <span>${escapeHtml(commandLabel)}</span></span>
        <button class="copy-button has-control-tooltip" type="button" data-install-copy aria-label="${escapeHtml(copyCommandLabel)}">
          <span class="copy-icon" aria-hidden="true"></span><span data-copy-label>Copy</span>
          <span class="control-tooltip" role="tooltip" aria-hidden="true">${escapeHtml(copyCommandLabel)}</span>
        </button></div><pre><code><span class="prompt">❯</span> ${escapeHtml(command)}</code></pre></div>` : "";
  const isThirdPartyListing = plugin.sourceType === "community"
    && !plugin.builtIn
    && !plugin.placeholder;
  const verificationEligible = isThirdPartyListing && plugin.repositoryLayout !== "suite";
  const canRequestVerification = verificationEligible;
  const snapshotVerified = verificationEligible && hasExactVerificationSnapshot(plugin);
  const verificationDetail = pluginVerificationDetailState(plugin);
  const updateUnverified = snapshotVerified && verificationDetail?.coverage === "update-unverified";
  const snapshotNotice = !verificationEligible && isThirdPartyListing
    ? `<li class="verification-unverified"><strong>Verification unavailable:</strong> Suite listings are outside the plugin verification workflow.</li>`
    : snapshotVerified
      ? `<li class="verification-snapshot"><strong>Snapshot verified:</strong> Marketplace verification covers only the exact commit shown under Listing checks.</li>`
      : isThirdPartyListing
        ? `<li class="verification-unverified"><strong>Snapshot unverified:</strong> This listed commit has not been verified.</li>`
        : "";
  const updateNotice = updateUnverified
    ? `<li class="verification-update"><strong>Update unverified:</strong> The latest upstream changes have not been verified.</li>`
    : "";
  const contributorAction = canRequestVerification && updateUnverified
    ? `<li class="verification-contributor-action"><strong>Contributor action:</strong> Submit the new exact commit through the <a href="${verificationRequestUrl}" target="_blank" rel="noreferrer">plugin verification form <span aria-hidden="true">↗</span></a>.</li>`
    : canRequestVerification && !snapshotVerified
      ? `<li class="verification-contributor-action"><strong>Contributor action:</strong> Submit the exact listed commit through the <a href="${verificationRequestUrl}" target="_blank" rel="noreferrer">plugin verification form <span aria-hidden="true">↗</span></a>.</li>`
      : "";
  const verificationStatusSection = isThirdPartyListing
    ? `<section class="detail-section" id="verification"><h2>Verification status</h2><div class="placeholder-install verification-status-note"><ul class="verification-status-list">${snapshotNotice}${updateNotice}${contributorAction}</ul></div></section>`
    : "";
  const securityContext = plugin.upstreamCheckStatus === "failed"
    ? "Marketplace installation is unavailable because compatibility has not been confirmed. Installation through another method is not bound to the marketplace’s listed or verified snapshot and may install or execute different code."
    : command
      ? "This Omarchy command clones the repository’s current HEAD. It is not bound to the marketplace’s verified snapshot and may install a different commit. Check the installed commit before enabling it."
      : pluginStatus === "Manual setup"
        ? "Manual installation follows the upstream project’s instructions. It is not bound to the marketplace’s listed or verified snapshot and may install or execute different code. Check the installed commit before enabling it."
        : "Marketplace installation is unavailable because compatibility has not been confirmed. Installation through another method is not bound to the marketplace’s listed or verified snapshot and may install or execute different code.";
  const installSecurityNotice = isThirdPartyListing
    ? `<div class="callout prominent-callout install-security-note"><strong id="security-notice-title">Security Notice</strong><p>${securityContext}</p><p>Third-party plugins run as unsandboxed code. Automated checks are limited and are not a security audit or guarantee. Inspect the source and capabilities, and <a href="${securityReportUrl}" target="_blank" rel="noreferrer">report suspicious plugins ASAP <span aria-hidden="true">↗</span></a>.</p></div>`
    : "";
  const securityNoticeSection = installSecurityNotice
    ? `<section class="detail-section security-notice-section" id="security" aria-labelledby="security-notice-title">${installSecurityNotice}</section>`
    : "";
  const displayedInstallNote = installAvailable && plugin.repositoryLayout === "root-plugin"
    ? ""
    : plugin.installNote || "";
  const installNote = displayedInstallNote
    ? `<p class="install-note">${escapeHtml(displayedInstallNote)}</p>`
    : "";
  const install = plugin.builtIn
    ? `${commandPanel}<div class="placeholder-install builtin-availability"><strong>Included with Omarchy Quattro</strong><p>This first-party plugin ships with Omarchy. The command configures the included plugin; it does not download marketplace code.</p></div>`
    : plugin.placeholder
      ? `<div class="placeholder-install"><strong>Coming soon</strong><p>${escapeHtml(plugin.installNote)}</p></div>`
      : !installAvailable
        ? `<div class="placeholder-install"><strong>${escapeHtml(pluginStatus)}</strong><p>${escapeHtml(plugin.installNote || "")}</p></div>`
        : `${commandPanel}${installNote}`;

  const availabilityHeading = plugin.builtIn || plugin.placeholder || !installAvailable
    ? "Availability"
    : "Install";
  const sourceNote = plugin.builtIn
    ? `<div class="placeholder-install terms-source-note"><strong>Official Omarchy source</strong><p>This first-party plugin is included with Omarchy Quattro. Review its source in the official Omarchy repository.</p></div>`
    : "";
  const sourceUrl = plugin.sourceUrl || plugin.repo;
  const shortSha = (value) => /^[a-f0-9]{40}$/i.test(value || "") ? value.slice(0, 7) : "unknown";
  const repositoryUrl = String(plugin.repo || "").replace(/\/+$/, "");
  const commitLink = (sha, label) => /^[a-f0-9]{40}$/i.test(sha || "")
    ? `<a href="${escapeHtml(`${repositoryUrl}/commit/${sha}`)}" target="_blank" rel="noreferrer" aria-label="${escapeHtml(`${label}: ${shortSha(sha)}`)}"><code>${escapeHtml(shortSha(sha))}</code> <span aria-hidden="true">↗</span></a>`
    : "Unknown";
  const branchPath = String(plugin.upstreamObservedBranch || plugin.listingValidatedBranch || "")
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  const branchLink = branchPath
    ? `<a href="${escapeHtml(`${repositoryUrl}/tree/${branchPath}`)}" target="_blank" rel="noreferrer">${escapeHtml(plugin.upstreamObservedBranch || plugin.listingValidatedBranch)} <span aria-hidden="true">↗</span></a>`
    : "Unknown";
  const formatCheckTime = (value) => {
    if (!value) return "Unknown";
    return new Intl.DateTimeFormat("en", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short"
    }).format(new Date(value));
  };
  const check = listingCheckState(plugin);
  const comparedCommits = listingCommitComparison(plugin);
  const comparison = check.comparison === "changed"
    ? `<a href="${escapeHtml(`${repositoryUrl}/compare/${comparedCommits.listingCommit}...${comparedCommits.upstreamCommit}`)}" target="_blank" rel="noreferrer">View changes <span aria-hidden="true">↗</span></a>`
    : check.comparison === "unknown"
      ? "Could not determine"
      : "No changes detected";
  const lastCompatible = check.lastCompatibleCommit
    ? `<div class="listing-check-row"><dt>Last compatible</dt><dd>${commitLink(check.lastCompatibleCommit, "View last compatible commit")}</dd></div>`
    : "";
  const lastSuccessful = check.lastSuccessfulAt
    ? `<div class="listing-check-row"><dt>Last successful</dt><dd><time datetime="${escapeHtml(check.lastSuccessfulAt)}">${escapeHtml(formatCheckTime(check.lastSuccessfulAt))}</time></dd></div>`
    : "";
  const repositoryReleaseUrl = safeGitHubWebUrl(plugin.repositoryRelease?.url);
  const repositoryRelease = plugin.repositoryRelease?.tag && repositoryReleaseUrl
    ? `<a href="${escapeHtml(repositoryReleaseUrl)}" target="_blank" rel="noreferrer">${escapeHtml(plugin.repositoryRelease.tag)} <span aria-hidden="true">↗</span></a>`
    : "No release tag";
  const provenance = !plugin.builtIn && !plugin.placeholder && plugin.listingValidatedCommit
    ? `<section class="listing-checks" aria-labelledby="listing-checks-title">
        <h3 id="listing-checks-title">Listing checks</h3>
        <dl>
          <div class="listing-check-row"><dt>Compatibility</dt><dd><span class="listing-check-status ${check.statusTone}">${check.statusLabel}</span></dd></div>
          <div class="listing-check-row"><dt>Last checked</dt><dd><time datetime="${escapeHtml(plugin.upstreamCheckedAt || "")}">${escapeHtml(formatCheckTime(plugin.upstreamCheckedAt))}</time></dd></div>
          <div class="listing-check-row"><dt>Last known release</dt><dd>${repositoryRelease}</dd></div>
          <div class="listing-check-row"><dt>${check.commitLabel}</dt><dd>${commitLink(check.checkedCommit, `View ${check.commitLabel.toLowerCase()}`)}</dd></div>
          ${lastSuccessful}
          ${lastCompatible}
          <div class="listing-check-row"><dt>${snapshotVerified ? "Verified snapshot" : "Listing snapshot"}</dt><dd>${commitLink(plugin.listingValidatedCommit, snapshotVerified ? "View verified snapshot" : "View listing snapshot")}<small>${escapeHtml(formatDate(plugin.listingValidatedAt))}</small></dd></div>
          <div class="listing-check-row"><dt>Branch</dt><dd>${branchLink}</dd></div>
          <div class="listing-check-row"><dt>Upstream changes</dt><dd>${comparison}</dd></div>
        </dl>
      </section>`
    : "";
  const versionLabel = pluginVersionLabel(plugin);
  const manifestVersion = versionLabel
    ? `<span class="manifest-version"><span>${escapeHtml(versionLabel)}</span></span>`
    : "";
  const verificationBadge = detailVerificationBadge(plugin);

  return `
    <article class="plugin-detail-article" style="--card-accent:${accentColor(plugin.accent)}">
      <header class="page-header" id="overview"><div class="page-eyebrow">${escapeHtml(plugin.category)}</div>
        <div class="detail-title"><span class="detail-icon">${escapeHtml(plugin.initials)}</span><h1>${escapeHtml(plugin.name)}</h1></div>
        <div class="page-meta"><span>${escapeHtml(plugin.id)}</span>${manifestVersion}<span>by ${authorLink(plugin)}</span><span class="detail-status-meta"><span class="status ${statusTone(plugin)}"><i class="status-dot" aria-hidden="true"></i>${escapeHtml(pluginStatus)}</span>${verificationBadge}</span></div>
        ${engagementEnabled ? `<div class="detail-engagement-cluster">
          ${engagementSummary(plugin, engagement, { detail: true, pending: pendingEngagement })}
          ${pluginHeartButton(plugin, engagement, { detail: true, hearted, pending: pendingEngagement })}
        </div>` : ""}
      </header>
      <p class="detail-description">${escapeHtml(plugin.description)}</p>${preview}<div class="plugin-tags">${tags}</div>
      <section class="detail-section${isThirdPartyListing ? " detail-section-before-verification" : ""}" id="install"><h2>${plugin.builtIn ? escapeHtml(plugin.officialCommandLabel) : availabilityHeading}</h2>${install}</section>
      ${verificationStatusSection}
      ${securityNoticeSection}
      <section class="detail-section" id="terms"><h2>Terms of Use</h2>${sourceNote}${provenance}<p style="margin-top:18px"><a class="button primary" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noreferrer">View source ↗</a></p></section>
    </article>`;
}

function showDetailError({ title, message, crumb }) {
  const content = document.querySelector("#detail-content");
  const error = document.querySelector("#detail-error");
  content.hidden = true;
  error.hidden = false;
  error.querySelector("h1").textContent = title;
  error.querySelector("p").textContent = message;
  document.querySelector("#crumb-name").textContent = crumb;
  document.title = `${title} | Omarchy Plugins`;
}

async function init() {
  setupThemeToggle();
  const id = new URLSearchParams(location.search).get("id");
  const content = document.querySelector("#detail-content");
  const engagementEnabled = Boolean(engagementApiBaseUrl());
  let pluginEngagement = { views: 0, copies: 0, hearts: 0 };
  let authoritativeEngagement = null;
  let engagementLoaded = false;
  let catalog;
  try {
    catalog = await loadCatalog();
  } catch (reason) {
    console.error(reason);
    showDetailError({
      title: "Catalog unavailable",
      message: "The plugin catalog could not be loaded. Try again in a moment.",
      crumb: "Unavailable",
    });
    return;
  }

  if (!catalog || !Array.isArray(catalog.plugins)) {
    showDetailError({
      title: "Catalog unavailable",
      message: "The plugin catalog could not be loaded. Try again in a moment.",
      crumb: "Unavailable",
    });
    return;
  }

  const plugin = catalog.plugins.find((item) => item?.id === id);
  if (!plugin) {
    showDetailError({
      title: "Plugin not found",
      message: "This plugin does not exist in the current catalog.",
      crumb: "Not found",
    });
    return;
  }

  try {
    document.title = `${plugin.name} | Omarchy Plugins`;
    document.querySelector("#crumb-name").textContent = plugin.name;
    content.className = "";
    content.innerHTML = detailTemplate(plugin, pluginEngagement, {
      engagementEnabled,
      hearted: hasPluginHeart(plugin.id),
      pendingEngagement: engagementEnabled,
    });
    setupControlTooltips(content);
    setupDetailMetaLineStarts(content);
    setupPreviewLightbox(content, document.querySelector("#preview-lightbox"));
    document.querySelector("#aside-verification-link").hidden = !content.querySelector("#verification");
    document.querySelector("#aside-security-link").hidden = !content.querySelector("#security");
    if (currentHashId() === "trust") {
      const url = new URL(location.href);
      url.hash = "terms";
      history.replaceState(history.state, "", url);
    }
    setupSectionNavigation({
      sectionSelector: "#detail-content .plugin-detail-article > [id]",
      linkSelector: ".right-aside .aside-link[href^='#'], .mobile-bottom a[href^='#']",
    });
    if (location.hash) {
      const targetId = currentHashId();
      const target = document.getElementById(targetId);
      if (target) {
        let allowDeferredScroll = true;
        const cancelDeferredScroll = () => { allowDeferredScroll = false; };
        const scrollToTarget = () => {
          if (!allowDeferredScroll || currentHashId() !== targetId) return;
          window.requestAnimationFrame(() => {
            if (allowDeferredScroll && currentHashId() === targetId) target.scrollIntoView();
          });
        };
        window.requestAnimationFrame(scrollToTarget);
        window.addEventListener("pointerdown", cancelDeferredScroll, { once: true, passive: true });
        window.addEventListener("wheel", cancelDeferredScroll, { once: true, passive: true });
        window.addEventListener("touchstart", cancelDeferredScroll, { once: true, passive: true });
        window.addEventListener("keydown", cancelDeferredScroll, { once: true });
        content.querySelectorAll("img:not([loading='lazy'])").forEach((image) => {
          if (image.complete) return;
          image.addEventListener("load", scrollToTarget, { once: true });
          image.addEventListener("error", scrollToTarget, { once: true });
        });
      }
    }
    document.querySelector("#aside-status").innerHTML = `<span class="status-label ${statusTone(plugin)}">${escapeHtml(displayedStatus(plugin))}</span>`;
    const verification = pluginVerificationDetailState(plugin);
    const verificationRow = document.querySelector("#aside-verification-row");
    verificationRow.hidden = !verification;
    if (verification) {
      document.querySelector("#aside-verification").innerHTML = asideVerificationBadge(verification);
    }
    const versionLabel = pluginVersionLabel(plugin);
    document.querySelector("#aside-version").textContent = versionLabel
      ? versionLabel.replace(/^manifest\s+/, "")
      : "—";
    document.querySelector("#aside-license").textContent = plugin.license || "Unknown";
    document.querySelector("#aside-owner").innerHTML = authorLink(plugin);
    if (plugin.builtIn || plugin.placeholder || !marketplaceInstallAvailable(plugin)) {
      const navigationLabel = plugin.builtIn ? plugin.officialCommandLabel : "Availability";
      document.querySelector("#aside-install-link").textContent = navigationLabel;
      document.querySelector("#mobile-install-link").textContent = plugin.builtIn
        ? "Command"
        : plugin.placeholder
          ? "Preview"
          : "Status";
    }

    const applyAuthoritativeEngagement = (result) => {
      if (!result?.recorded || !result.stats) return;
      authoritativeEngagement = {
        views: Math.max(authoritativeEngagement?.views || 0, result.stats.views),
        copies: Math.max(authoritativeEngagement?.copies || 0, result.stats.copies),
        hearts: Math.max(authoritativeEngagement?.hearts || 0, result.stats.hearts),
      };
      pluginEngagement = authoritativeEngagement;
      engagementLoaded = true;
      const engagementCluster = content.querySelector(".detail-engagement-cluster");
      if (engagementCluster) engagementCluster.hidden = false;
      updateEngagementSummary(document, plugin.id, pluginEngagement);
      updatePluginHeart(document, plugin.id, pluginEngagement, {
        hearted: hasPluginHeart(plugin.id),
      });
    };

    const heartButton = content.querySelector("[data-plugin-heart]");
    heartButton?.addEventListener("click", async () => {
      if (heartButton.getAttribute("aria-disabled") === "true" || heartButton.dataset.heartSubmitting === "true") return;
      heartButton.dataset.heartSubmitting = "true";
      heartButton.setAttribute("aria-busy", "true");
      const result = await recordPluginHeart(plugin.id);
      delete heartButton.dataset.heartSubmitting;
      heartButton.removeAttribute("aria-busy");
      if (!result?.recorded) {
        showToast("Heart could not be sent. Try again.");
        return;
      }
      applyAuthoritativeEngagement(result);
      updatePluginHeart(document, plugin.id, result.stats, {
        animate: true,
        hearted: true,
      });
      showToast("Heart sent.");
    });

    const copyButton = content.querySelector("[data-install-copy]");
    copyButton?.addEventListener("click", async () => {
      const command = plugin.builtIn ? plugin.officialCommand : plugin.installCommand;
      if (!await copyText(command, copyButton)) return;
      applyAuthoritativeEngagement(await recordPluginCopy(plugin.id));
    });

    if (engagementEnabled) {
      loadEngagementStats().then((stats) => {
        const current = stats[plugin.id] || { views: 0, copies: 0, hearts: 0 };
        pluginEngagement = authoritativeEngagement || current;
        engagementLoaded = true;
        updateEngagementSummary(document, plugin.id, pluginEngagement);
        updatePluginHeart(document, plugin.id, pluginEngagement, {
          hearted: hasPluginHeart(plugin.id),
        });
      }).catch((reason) => {
        console.warn("Engagement stats unavailable", reason);
        if (!engagementLoaded) {
          hidePendingEngagement(document);
          const engagementCluster = content.querySelector(".detail-engagement-cluster");
          if (engagementCluster) engagementCluster.hidden = true;
        }
      });
      recordPluginView(plugin.id).then(applyAuthoritativeEngagement);
    }
  } catch (reason) {
    console.error(reason);
    showDetailError({
      title: "Plugin details unavailable",
      message: "The plugin details could not be displayed. Return to the marketplace and try again.",
      crumb: "Unavailable",
    });
  }
}

if (typeof document !== "undefined") init();
