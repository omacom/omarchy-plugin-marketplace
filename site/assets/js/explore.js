import { accentColor, formatDate, legibleColor, setupThemeToggle } from "./shared.js?v=20260923-01";
import { createExplorerSearchMatcher, repositoryPublisher } from "./explore-search.js?v=20260923-01";
import { themeById } from "./themes.js?v=20260920-05";
import { inclusiveDayCount, inclusiveRangeStart } from "./growth-range.js?v=20260828-18";
import { matchesBarTaxonomy, matchesVpnTaxonomy } from "./taxonomy.js?v=20260923-01";

const number = new Intl.NumberFormat("en-US");
const shortDate = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" });
const posterDate = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
const monthDate = new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
const calendarMonthDate = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const calendarFullDate = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const localDateTime = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short",
});
const localTime = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short" });
const svgNamespace = "http://www.w3.org/2000/svg";
const taxonomyCommunityFilters = Object.freeze([
  Object.freeze({
    id: "taxonomy:vpn",
    label: "VPN",
    color: "#68d6e8",
    anchor: "security",
    matches: matchesVpnTaxonomy,
  }),
  Object.freeze({
    id: "taxonomy:bar",
    label: "Bar",
    color: "#e8b568",
    anchor: "appearance",
    matches: matchesBarTaxonomy,
  }),
]);

const graphTab = document.querySelector("#graph-tab");
const growthTab = document.querySelector("#growth-tab");
const graphView = document.querySelector("#graph-view");
const growthView = document.querySelector("#growth-view");
const errorMessage = document.querySelector("#explore-error");
const loading = document.querySelector("#graph-loading");
const canvas = document.querySelector("#plugin-graph");
const context = canvas.getContext("2d");
const graphSearch = document.querySelector("#graph-search");
const graphMatchCount = document.querySelector("#graph-match-count");
const graphDensity = document.querySelector("#graph-density");
const graphReset = document.querySelector("#graph-reset");
const analysis = document.querySelector("#graph-analysis");
const detail = document.querySelector("#plugin-detail");
const allCommunities = document.querySelector("#all-communities");
const communityScrollFade = document.querySelector("#community-scroll-fade");

let explorer;
let clusterById;
let rankedNodes = [];
let focusIndexes = new Set();
let maximumInfluence = 1;
let pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
let viewport = { x: 0, y: 0, scale: 1, initialized: false };
let canvasSize = { width: 0, height: 0 };
let dragging = false;
let moved = false;
let pointer = { x: 0, y: 0 };
let hovered = null;
let selected = null;
let activeCluster = null;
let matches = new Set();
let query = "";
let focusMode = true;
let growthGuideModel = null;
let growthProjectionYear = null;
let syncCommunityScrollFade = () => {};
let graphPalette = null;
const communityFilterColors = new Map();
const activePointers = new Map();
let pinch = null;

function element(name, className, text) {
  const node = document.createElement(name);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svgElement(name, attributes = {}, text) {
  const node = document.createElementNS(svgNamespace, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

function dateTimeParts(formatter, value) {
  return Object.fromEntries(formatter.formatToParts(value)
    .filter(({ type }) => type !== "literal")
    .map(({ type, value: part }) => [type, part]));
}

function localDateTimeLabel(value) {
  const parts = dateTimeParts(localDateTime, value);
  return `${parts.day} ${parts.month.toUpperCase()} ${parts.year} · ${parts.hour}:${parts.minute} ${parts.timeZoneName.toUpperCase()}`;
}

function nextDailyRefresh(now = new Date()) {
  const refresh = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 4, 17));
  if (refresh <= now) refresh.setUTCDate(refresh.getUTCDate() + 1);
  return refresh;
}

function localTimeLabel(value) {
  const parts = dateTimeParts(localTime, value);
  return `${parts.hour}:${parts.minute} ${parts.timeZoneName.toUpperCase()}`;
}

function setupDataFreshness() {
  const updatedAt = new Date(explorer.generatedAt);
  const updatedTime = document.querySelector("#explorer-updated");
  if (Number.isNaN(updatedAt.getTime())) {
    updatedTime.textContent = "Unavailable";
    updatedTime.removeAttribute("datetime");
  } else {
    updatedTime.dateTime = updatedAt.toISOString();
    updatedTime.textContent = localDateTimeLabel(updatedAt);
  }
  document.querySelector("#explorer-refresh-time").textContent = `${localTimeLabel(nextDailyRefresh())} · 04:17 UTC`;
}

function matchesActiveCommunity(node) {
  if (!activeCluster) return true;
  const taxonomyFilter = taxonomyCommunityFilters.find((filter) => filter.id === activeCluster);
  return taxonomyFilter ? taxonomyFilter.matches(node) : node.cluster === activeCluster;
}

function visible(node) {
  const densityVisible = !focusMode || focusIndexes.has(node.index) || node === selected || matches.has(node.index);
  return matchesActiveCommunity(node) && densityVisible;
}

function emphasized(node) {
  return !query || matches.has(node.index);
}

function resizeCanvas({ fit = false } = {}) {
  const rect = canvas.getBoundingClientRect();
  canvasSize = { width: rect.width, height: rect.height };
  pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.floor(rect.width * pixelRatio));
  canvas.height = Math.max(1, Math.floor(rect.height * pixelRatio));
  if (explorer && (fit || !viewport.initialized)) fitGraph();
  drawGraph();
}

function fitGraph() {
  if (!explorer) return;
  const visibleNodes = explorer.nodes.filter(visible);
  if (!visibleNodes.length) return;
  const visibleClusters = explorer.clusters.filter((cluster) => visibleNodes.some((node) => node.cluster === cluster.id));
  const points = [...visibleNodes, ...visibleClusters.map((cluster) => cluster.center)];
  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const padding = Math.max(70, Math.max(spanX, spanY) * .07);
  const landscapeRail = 122;
  const inset = window.innerWidth > 760 ? 36 : 18;
  const availableWidth = Math.max(120, canvasSize.width - landscapeRail - inset * 2);
  const availableHeight = Math.max(120, canvasSize.height - inset * 2);
  const fittedWidth = spanX + padding * 2;
  const fittedHeight = spanY + padding * 2;
  viewport.scale = Math.min(availableWidth / fittedWidth, availableHeight / fittedHeight);
  viewport.x = inset + (availableWidth - fittedWidth * viewport.scale) / 2 - (minX - padding) * viewport.scale;
  viewport.y = inset + (availableHeight - fittedHeight * viewport.scale) / 2 - (minY - padding) * viewport.scale;
  viewport.initialized = true;
}

function worldToScreen(node) {
  return { x: node.x * viewport.scale + viewport.x, y: node.y * viewport.scale + viewport.y };
}

function nodeRadius(node) {
  return 2.8 + Math.min(9, Math.log10((node.stars || 0) + 1) * 1.8 + Math.sqrt(node.influence || 0) * .12);
}

function readGraphPalette() {
  const root = document.documentElement;
  const styles = getComputedStyle(root);
  const token = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;
  const background = token("--bg", "#000");
  return {
    light: themeById(root.dataset.theme).light,
    background,
    panel: token("--panel", background),
    heading: token("--heading", "#eee"),
    text: token("--text", "#d7d7d9"),
    colors: new Map(),
  };
}

// Community and accent colors are tuned for dark surfaces; darken them where a theme needs it.
function graphColor(color, surface = "background", minimum = 3) {
  const key = `${surface}:${minimum}:${color}`;
  if (!graphPalette.colors.has(key)) graphPalette.colors.set(key, legibleColor(color, graphPalette[surface], minimum));
  return graphPalette.colors.get(key);
}

function applyGraphTheme() {
  graphPalette = readGraphPalette();
  document.querySelectorAll(".community-row").forEach((button) => {
    const color = communityFilterColors.get(button.dataset.cluster);
    if (color) button.style.setProperty("--community", graphColor(color));
  });
  if (selected) selectNode(selected);
}

function drawCanvasLabel({ text, x, y, font, color, opacity, haloColor, haloWidth }) {
  context.save();
  context.font = font;
  context.lineJoin = "round";
  context.strokeStyle = haloColor;
  context.lineWidth = haloWidth;
  context.globalAlpha = Math.min(1, opacity + .28);
  context.strokeText(text, x, y);
  context.fillStyle = color;
  context.globalAlpha = opacity;
  context.fillText(text, x, y);
  context.restore();
}

function drawGraph() {
  if (!explorer || !canvasSize.width || graphView.hidden) return;
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.clearRect(0, 0, canvasSize.width, canvasSize.height);
  const { light: lightTheme, background: labelHaloColor, heading: headingColor, text: labelColor } = graphPalette;
  const occupiedLabels = [];
  const clusterLabels = [];

  context.lineWidth = Math.max(.7, viewport.scale * .75);
  for (const edge of explorer.edges) {
    const source = explorer.nodes[edge.source];
    const target = explorer.nodes[edge.target];
    if (!visible(source) || !visible(target)) continue;
    const highlighted = selected && (source.index === selected.index || target.index === selected.index);
    const muted = query && (!matches.has(source.index) || !matches.has(target.index));
    context.globalAlpha = highlighted ? .95 : muted ? .02 : lightTheme ? .34 + edge.similarity * .28 : .22 + edge.similarity * .3;
    context.strokeStyle = graphColor(clusterById.get(source.cluster).color);
    context.beginPath();
    context.moveTo(source.x * viewport.scale + viewport.x, source.y * viewport.scale + viewport.y);
    context.lineTo(target.x * viewport.scale + viewport.x, target.y * viewport.scale + viewport.y);
    context.stroke();
  }

  for (const cluster of explorer.clusters) {
    const members = explorer.nodes.filter((node) => node.cluster === cluster.id && visible(node)).sort((first, second) => second.influence - first.influence).slice(0, 9);
    if (!members.length) continue;
    const hub = worldToScreen(cluster.center);
    const clusterColor = graphColor(cluster.color);
    for (const node of members) {
      const position = worldToScreen(node);
      context.globalAlpha = lightTheme ? .46 : .34;
      context.strokeStyle = clusterColor;
      context.lineWidth = 1.05;
      context.beginPath();
      context.moveTo(hub.x, hub.y);
      context.lineTo(position.x, position.y);
      context.stroke();
    }
    context.globalAlpha = .95;
    context.fillStyle = clusterColor;
    context.shadowColor = clusterColor;
    context.shadowBlur = 14;
    context.beginPath();
    context.arc(hub.x, hub.y, 5.5 + Math.sqrt(members.length), 0, Math.PI * 2);
    context.fill();
    context.shadowBlur = 0;
    const font = "700 11px Inter, sans-serif";
    context.font = font;
    clusterLabels.push({
      text: cluster.label,
      x: hub.x + 13,
      y: hub.y + 4,
      font,
      color: headingColor,
      opacity: .95,
      haloColor: labelHaloColor,
      haloWidth: 4,
    });
    occupiedLabels.push({ x: hub.x + 10, y: hub.y - 9, width: context.measureText(cluster.label).width + 8, height: 16 });
  }

  for (const node of explorer.nodes) {
    if (!visible(node)) continue;
    const position = worldToScreen(node);
    if (position.x < -20 || position.x > canvasSize.width + 20 || position.y < -20 || position.y > canvasSize.height + 20) continue;
    const focus = node === hovered || node === selected;
    const radius = nodeRadius(node) * (focus ? 1.8 : 1);
    const clusterColor = graphColor(clusterById.get(node.cluster).color);
    context.globalAlpha = emphasized(node) ? (focus ? 1 : .92) : .08;
    context.fillStyle = focus ? headingColor : clusterColor;
    context.shadowColor = clusterColor;
    context.shadowBlur = focus ? 12 : 0;
    context.beginPath();
    context.arc(position.x, position.y, radius, 0, Math.PI * 2);
    context.fill();
    context.shadowBlur = 0;
  }

  for (const label of clusterLabels) drawCanvasLabel(label);

  const lastRankedIndex = rankedNodes.length - 1;
  const primaryLabelInfluence = rankedNodes[Math.min(24, lastRankedIndex)]?.influence ?? Number.POSITIVE_INFINITY;
  const zoomedLabelInfluence = rankedNodes[Math.min(80, lastRankedIndex)]?.influence ?? primaryLabelInfluence;
  const labelCandidates = explorer.nodes
    .filter((node) => visible(node) && emphasized(node))
    .filter((node) => node === hovered || node === selected || (window.innerWidth > 760 && (node.influence >= primaryLabelInfluence || (viewport.scale > .85 && node.influence >= zoomedLabelInfluence) || viewport.scale > 1.65)))
    .sort((first, second) => Number(second === hovered || second === selected) - Number(first === hovered || first === selected) || second.influence - first.influence);
  for (const node of labelCandidates) {
    const position = worldToScreen(node);
    const focus = node === hovered || node === selected;
    const radius = nodeRadius(node) * (focus ? 1.8 : 1);
    context.font = `${focus ? 700 : 400} ${focus ? 13 : 9}px Inter, sans-serif`;
    const labelWidth = context.measureText(node.name).width;
    const box = { x: position.x + radius + 3, y: position.y - (focus ? 10 : 7), width: labelWidth + 6, height: focus ? 17 : 13 };
    const overlaps = occupiedLabels.some((item) => box.x < item.x + item.width && box.x + box.width > item.x && box.y < item.y + item.height && box.y + box.height > item.y);
    if (overlaps && !focus) continue;
    occupiedLabels.push(box);
    drawCanvasLabel({
      text: node.name,
      x: position.x + radius + 5,
      y: position.y + 4,
      font: context.font,
      color: labelColor,
      opacity: focus ? 1 : lightTheme ? .72 : .65,
      haloColor: labelHaloColor,
      haloWidth: focus ? 4 : 3,
    });
  }
  context.globalAlpha = 1;
}

function nearestNode(screenX, screenY) {
  let best = null;
  let bestDistance = 18;
  for (const node of explorer.nodes) {
    if (!visible(node)) continue;
    const position = worldToScreen(node);
    const distance = Math.hypot(position.x - screenX, position.y - screenY);
    if (distance < bestDistance) { best = node; bestDistance = distance; }
  }
  return best;
}

function centerNode(node, scale = Math.max(viewport.scale, 1.1)) {
  viewport.scale = Math.min(2.8, scale);
  const panelSpace = window.innerWidth > 760 ? 456 : 0;
  viewport.x = (canvasSize.width - panelSpace) / 2 - node.x * viewport.scale;
  viewport.y = canvasSize.height / 2 - node.y * viewport.scale;
  drawGraph();
}

function safeExternalUrl(value) {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : "#";
  } catch {
    return "#";
  }
}

function safePluginPreview(value) {
  const path = String(value || "").trim();
  return /^assets\/img\/plugins\/[a-z0-9._-]+\.webp$/i.test(path) ? path : "";
}

function pluginInitials(node) {
  const provided = String(node.initials || "").trim();
  if (provided) return provided.slice(0, 3).toUpperCase();
  return String(node.name || node.id || "?")
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase() || "?";
}

function selectNode(node, center = false) {
  selected = node;
  if (!node) {
    canvas.setAttribute("aria-label", "Interactive semantic graph of community plugins");
    detail.hidden = true;
    analysis.hidden = false;
    drawGraph();
    return;
  }
  analysis.hidden = false;
  detail.hidden = false;
  canvas.setAttribute("aria-label", `Interactive semantic graph of community plugins. Selected ${node.name}.`);
  if (center) centerNode(node);
  const score = Math.round(node.influence / maximumInfluence * 100);
  const cluster = clusterById.get(node.cluster);
  const detailAccent = graphColor(accentColor(node.accent), "panel", 4.5);
  const publisher = repositoryPublisher(node.repo);
  detail.style.setProperty("--detail-accent", detailAccent);
  detail.style.borderLeftColor = detailAccent;
  detail.querySelector("h2").textContent = node.name;
  detail.querySelector(".detail-publisher").textContent = `${publisher ? `by @${publisher}` : `by ${node.author || "Unknown"}`} · ${node.kind || node.category}`;
  detail.querySelector(".detail-identity").textContent = `${node.author || "Unknown"} · ${node.id}`;
  detail.querySelector(".detail-description").textContent = node.description || "No description available.";
  const community = detail.querySelector(".detail-community");
  community.style.setProperty("--community", graphColor(cluster.color, "panel"));
  community.querySelector('[data-detail="community"]').textContent = cluster.label;
  const stars = detail.querySelector(".detail-stars");
  stars.querySelector('[data-detail="stars"]').textContent = number.format(node.stars || 0);
  stars.setAttribute("aria-label", `${number.format(node.stars || 0)} repository stars`);
  detail.querySelector('[data-detail="influence"]').textContent = `${score}/100`;
  detail.querySelector('[data-detail="listed"]').textContent = formatDate(node.listedAt);
  const previewImage = detail.querySelector(".detail-preview-image");
  const previewMark = detail.querySelector(".detail-preview-mark");
  const previewSource = safePluginPreview(node.previewThumbnail);
  previewImage.hidden = true;
  previewMark.hidden = false;
  previewMark.textContent = pluginInitials(node);
  previewImage.dataset.source = previewSource;
  if (previewSource) {
    previewImage.width = Number(node.previewThumbnailWidth) || 720;
    previewImage.height = Number(node.previewThumbnailHeight) || 405;
    previewImage.onload = () => {
      if (previewImage.dataset.source !== previewSource) return;
      previewImage.hidden = false;
      previewMark.hidden = true;
    };
    previewImage.onerror = () => {
      if (previewImage.dataset.source !== previewSource) return;
      previewImage.hidden = true;
      previewMark.hidden = false;
    };
    previewImage.src = previewSource;
  } else {
    previewImage.removeAttribute("src");
  }
  const tags = detail.querySelector(".detail-tags");
  const visibleTags = node.tags.slice(0, 3).map((tag) => element("span", "", tag));
  if (node.tags.length > visibleTags.length) {
    const more = element("span", "is-more", `+${node.tags.length - visibleTags.length}`);
    more.setAttribute("aria-label", `${node.tags.length - visibleTags.length} additional tags`);
    visibleTags.push(more);
  }
  tags.replaceChildren(...visibleTags);
  detail.querySelector(".plugin-link").href = `plugin.html?${new URLSearchParams({ id: node.id })}`;
  detail.querySelector(".repo-link").href = safeExternalUrl(node.repo);
  const neighbors = detail.querySelector(".neighbor-list");
  neighbors.replaceChildren(...node.neighbors.map((neighbor) => {
    const candidate = explorer.nodes[neighbor.index];
    const button = element("button", "neighbor-row");
    button.type = "button";
    const similarity = Math.round(neighbor.similarity * 100);
    const candidatePublisher = repositoryPublisher(candidate.repo);
    button.setAttribute("aria-label", `Select related plugin ${candidate.name}, ${similarity}% similarity${candidatePublisher ? `, by @${candidatePublisher}` : ""}`);
    const name = element("span", "", candidate.name);
    if (candidatePublisher) name.append(element("i", "neighbor-publisher", `@${candidatePublisher}`));
    button.append(name, element("small", "", `${similarity}% →`));
    button.addEventListener("click", () => {
      if (!matchesActiveCommunity(candidate)) setActiveCluster(null);
      selectNode(candidate, true);
    });
    return button;
  }));
  drawGraph();
}

function setActiveCluster(clusterId) {
  activeCluster = activeCluster === clusterId ? null : clusterId;
  document.querySelectorAll(".community-row").forEach((button) => {
    const active = button.dataset.cluster === activeCluster;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  allCommunities.classList.toggle("active", !activeCluster);
  allCommunities.setAttribute("aria-pressed", String(!activeCluster));
  if (selected && !visible(selected)) selectNode(null);
  document.querySelector("#visible-nodes").textContent = number.format(explorer.nodes.filter(visible).length);
  fitGraph();
  drawGraph();
}

function renderAnalysis() {
  allCommunities.setAttribute("aria-label", `Show all ${number.format(explorer.clusters.length)} communities`);
  allCommunities.addEventListener("click", () => {
    activeCluster = null;
    document.querySelectorAll(".community-row").forEach((button) => {
      button.classList.remove("active");
      button.setAttribute("aria-pressed", "false");
    });
    allCommunities.classList.add("active");
    allCommunities.setAttribute("aria-pressed", "true");
    document.querySelector("#visible-nodes").textContent = number.format(explorer.nodes.filter(visible).length);
    fitGraph();
    drawGraph();
  });

  const leadingClusters = [...explorer.clusters].sort((first, second) => second.count - first.count);
  const largestCluster = leadingClusters[0]?.count || 1;
  const communityFilters = [...leadingClusters];
  taxonomyCommunityFilters.forEach(({ id, label, color, anchor, matches }) => {
    const count = explorer.nodes.filter(matches).length;
    if (!count) return;
    const anchorIndex = communityFilters.findIndex((cluster) => cluster.id === anchor);
    communityFilters.splice(anchorIndex < 0 ? communityFilters.length : anchorIndex + 1, 0, {
      id, label, color, count, taxonomy: true,
    });
  });
  const communities = document.querySelector("#community-list");
  communities.replaceChildren(...communityFilters.map((cluster) => {
    const button = element("button", "community-row");
    button.type = "button";
    button.dataset.cluster = cluster.id;
    button.dataset.filterKind = cluster.taxonomy ? "taxonomy" : "community";
    button.setAttribute("aria-label", cluster.taxonomy
      ? `${cluster.label} filter: ${number.format(cluster.count)} matching plugins`
      : `${cluster.label}: ${number.format(cluster.count)} plugins, ${Math.round(cluster.count / explorer.nodes.length * 100)} percent`);
    button.setAttribute("aria-pressed", "false");
    communityFilterColors.set(cluster.id, cluster.color);
    button.style.setProperty("--community", graphColor(cluster.color));
    const meter = element("span", "community-meter");
    meter.setAttribute("aria-hidden", "true");
    meter.style.setProperty("--share", `${Math.round(cluster.count / largestCluster * 100)}%`);
    meter.append(element("i"));
    button.append(element("span", "community-name", cluster.label), meter);
    button.addEventListener("click", () => setActiveCluster(cluster.id));
    return button;
  }));
  communities.scrollTop = 0;

  syncCommunityScrollFade = () => {
    const remaining = communities.scrollHeight - communities.clientHeight - communities.scrollTop;
    communityScrollFade.hidden = communities.scrollHeight <= communities.clientHeight + 1 || remaining <= 2;
  };
  communities.addEventListener("scroll", syncCommunityScrollFade, { passive: true });
  new ResizeObserver(syncCommunityScrollFade).observe(communities);
  window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
    communities.scrollTop = 0;
    syncCommunityScrollFade();
  }));
}

function setupGraph() {
  graphPalette = readGraphPalette();
  clusterById = new Map(explorer.clusters.map((cluster) => [cluster.id, cluster]));
  rankedNodes = [...explorer.nodes].sort((first, second) => second.influence - first.influence);
  focusIndexes = new Set(rankedNodes.slice(0, 180).map((node) => node.index));
  maximumInfluence = rankedNodes[0]?.influence || 1;
  renderAnalysis();
  document.querySelector("#visible-nodes").textContent = number.format(explorer.nodes.filter(visible).length);
  document.querySelector("#total-nodes").textContent = number.format(explorer.nodes.length);
  document.querySelector("#total-edges").textContent = number.format(explorer.edges.length);
  document.querySelector("#total-clusters").textContent = explorer.clusters.length;
  document.querySelector("#graph-method").setAttribute("aria-label", explorer.method || "Local semantic similarity");
  loading.hidden = true;
  resizeCanvas({ fit: true });
}

function pointerPosition(event) {
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

graphSearch.addEventListener("input", () => {
  query = graphSearch.value.trim();
  matches = new Set();
  const matchesSearch = createExplorerSearchMatcher(query);
  if (query) explorer.nodes.forEach((node) => {
    if (matchesSearch(node)) matches.add(node.index);
  });
  graphMatchCount.hidden = !query;
  graphMatchCount.textContent = query ? `${number.format(matches.size)} match${matches.size === 1 ? "" : "es"}` : "";
  document.querySelector("#visible-nodes").textContent = number.format(explorer.nodes.filter(visible).length);
  drawGraph();
});

graphSearch.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || !matches.size) return;
  activeCluster = null;
  allCommunities.classList.add("active");
  allCommunities.setAttribute("aria-pressed", "true");
  document.querySelectorAll(".community-row").forEach((button) => {
    button.classList.remove("active");
    button.setAttribute("aria-pressed", "false");
  });
  selectNode(explorer.nodes[[...matches][0]], true);
  document.querySelector("#visible-nodes").textContent = number.format(explorer.nodes.filter(visible).length);
});

graphDensity.addEventListener("click", () => {
  focusMode = !focusMode;
  graphDensity.textContent = focusMode ? "Show all →" : "Focus view →";
  graphDensity.setAttribute("aria-pressed", String(!focusMode));
  document.querySelector("#visible-nodes").textContent = number.format(explorer.nodes.filter(visible).length);
  fitGraph();
  drawGraph();
});

graphReset.addEventListener("click", () => {
  activeCluster = null;
  query = "";
  matches.clear();
  graphSearch.value = "";
  graphMatchCount.hidden = true;
  graphMatchCount.textContent = "";
  allCommunities.classList.add("active");
  allCommunities.setAttribute("aria-pressed", "true");
  document.querySelectorAll(".community-row").forEach((button) => {
    button.classList.remove("active");
    button.setAttribute("aria-pressed", "false");
  });
  selectNode(null);
  document.querySelector("#visible-nodes").textContent = number.format(explorer.nodes.filter(visible).length);
  fitGraph();
  drawGraph();
});

function zoomAt(position, scale) {
  const nextScale = Math.min(3.2, Math.max(.1, scale));
  const worldX = (position.x - viewport.x) / viewport.scale;
  const worldY = (position.y - viewport.y) / viewport.scale;
  viewport.x = position.x - worldX * nextScale;
  viewport.y = position.y - worldY * nextScale;
  viewport.scale = nextScale;
}

function pinchState() {
  const [first, second] = [...activePointers.values()];
  return {
    distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
    center: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
  };
}

canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  zoomAt(pointerPosition(event), viewport.scale * Math.exp(-event.deltaY * .0012));
  drawGraph();
}, { passive: false });

canvas.addEventListener("pointerdown", (event) => {
  const position = pointerPosition(event);
  activePointers.set(event.pointerId, position);
  canvas.setPointerCapture(event.pointerId);
  if (activePointers.size === 2) {
    // A second touch turns the drag into a pinch; a pinch never selects a plugin.
    pinch = pinchState();
    moved = true;
    return;
  }
  if (activePointers.size > 2) return;
  dragging = true;
  moved = false;
  pointer = position;
  canvas.classList.add("dragging");
});
canvas.addEventListener("pointermove", (event) => {
  const position = pointerPosition(event);
  if (activePointers.has(event.pointerId)) activePointers.set(event.pointerId, position);
  if (pinch && activePointers.size >= 2) {
    const next = pinchState();
    zoomAt(next.center, viewport.scale * next.distance / pinch.distance);
    viewport.x += next.center.x - pinch.center.x;
    viewport.y += next.center.y - pinch.center.y;
    pinch = next;
    drawGraph();
    return;
  }
  if (dragging) {
    const deltaX = position.x - pointer.x;
    const deltaY = position.y - pointer.y;
    if (Math.hypot(deltaX, deltaY) > 2) moved = true;
    viewport.x += deltaX;
    viewport.y += deltaY;
    pointer = position;
    drawGraph();
  } else {
    const next = nearestNode(position.x, position.y);
    if (next !== hovered) { hovered = next; drawGraph(); }
  }
});
function endPointer(event, { select }) {
  const position = pointerPosition(event);
  activePointers.delete(event.pointerId);
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  if (pinch) {
    if (activePointers.size >= 2) return;
    pinch = null;
    const remaining = [...activePointers.values()][0];
    dragging = Boolean(remaining);
    if (remaining) pointer = remaining;
    else canvas.classList.remove("dragging");
    return;
  }
  dragging = false;
  canvas.classList.remove("dragging");
  if (select && !moved) selectNode(nearestNode(position.x, position.y));
}
canvas.addEventListener("pointerup", (event) => endPointer(event, { select: true }));
canvas.addEventListener("pointercancel", (event) => endPointer(event, { select: false }));
canvas.addEventListener("pointerleave", () => { if (!dragging) { hovered = null; drawGraph(); } });
canvas.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (selected) {
      event.preventDefault();
      selectNode(null);
    }
    return;
  }
  const visibleNodes = rankedNodes.filter(visible);
  if (!visibleNodes.length || !["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const current = visibleNodes.indexOf(selected);
  let next = current;
  if (["ArrowRight", "ArrowDown"].includes(event.key)) next = (current + 1) % visibleNodes.length;
  if (["ArrowLeft", "ArrowUp"].includes(event.key)) next = (current <= 0 ? visibleNodes.length : current) - 1;
  if (event.key === "Home") next = 0;
  if (event.key === "End") next = visibleNodes.length - 1;
  selectNode(visibleNodes[next], true);
});
document.querySelector("#detail-close").addEventListener("click", () => selectNode(null));

function dateIndex(date) {
  return explorer.growth.findIndex((point) => point.date === date);
}

function clampedDate(value, fallback) {
  const minimum = explorer.growth[0].date;
  const maximum = explorer.growth.at(-1).date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return fallback;
  return value < minimum ? minimum : value > maximum ? maximum : value;
}

function growthPresetFrom(days) {
  return clampedDate(inclusiveRangeStart(explorer.growth.at(-1).date, days), explorer.growth[0].date);
}

function setupGrowthCalendar(fromInput, toInput, minimum, maximum) {
  const calendar = document.querySelector("#growth-calendar");
  const calendarGrid = document.querySelector("#growth-calendar-grid");
  const calendarMonthLabel = document.querySelector("#growth-calendar-month");
  const previousButton = calendar.querySelector('[data-calendar-nav="-1"]');
  const nextButton = calendar.querySelector('[data-calendar-nav="1"]');
  const controls = document.querySelector(".growth-controls");
  let activeInput = null;
  let visibleMonth = null;

  const isoDate = (date) => date.toISOString().slice(0, 10);
  const utcDate = (value) => new Date(`${value}T00:00:00Z`);
  const shiftDate = (value, days) => {
    const date = utcDate(value);
    date.setUTCDate(date.getUTCDate() + days);
    return isoDate(date);
  };

  function positionCalendar() {
    if (calendar.hidden || !activeInput) return;
    const controlsRect = controls.getBoundingClientRect();
    const inputRect = activeInput.getBoundingClientRect();
    const calendarWidth = calendar.offsetWidth;
    const preferredLeft = inputRect.left - controlsRect.left;
    const maximumLeft = Math.max(12, controlsRect.width - calendarWidth - 12);
    calendar.style.left = `${Math.min(maximumLeft, Math.max(12, preferredLeft))}px`;
    calendar.style.top = `${window.innerWidth <= 760 ? controlsRect.height + 8 : inputRect.bottom - controlsRect.top + 8}px`;
  }

  function focusCalendarDate(date) {
    window.requestAnimationFrame(() => {
      const exact = calendarGrid.querySelector(`[data-calendar-date="${date}"]:not(:disabled)`);
      const fallback = calendarGrid.querySelector(".growth-calendar-day:not(:disabled)");
      (exact || fallback)?.focus();
    });
  }

  function renderCalendar({ focusDate = "" } = {}) {
    if (!activeInput || !visibleMonth) return;
    const year = visibleMonth.getUTCFullYear();
    const month = visibleMonth.getUTCMonth();
    const monthStart = new Date(Date.UTC(year, month, 1));
    const gridStart = new Date(monthStart);
    gridStart.setUTCDate(gridStart.getUTCDate() - ((monthStart.getUTCDay() + 6) % 7));
    const selectedDate = activeInput.value;
    const today = new Date().toISOString().slice(0, 10);
    const days = [];

    for (let index = 0; index < 42; index += 1) {
      const date = new Date(gridStart);
      date.setUTCDate(gridStart.getUTCDate() + index);
      const dateValue = isoDate(date);
      const day = element("button", "growth-calendar-day", String(date.getUTCDate()));
      day.type = "button";
      day.dataset.calendarDate = dateValue;
      day.setAttribute("role", "gridcell");
      day.setAttribute("aria-label", calendarFullDate.format(date));
      day.setAttribute("aria-selected", String(dateValue === selectedDate));
      day.tabIndex = -1;
      day.disabled = dateValue < minimum || dateValue > maximum;
      day.classList.toggle("is-outside", date.getUTCMonth() !== month);
      day.classList.toggle("is-today", dateValue === today);
      day.classList.toggle("is-selected", dateValue === selectedDate);
      days.push(day);
    }
    calendarGrid.replaceChildren(...days);
    calendarMonthLabel.textContent = calendarMonthDate.format(visibleMonth);
    const previousMonthEnd = isoDate(new Date(Date.UTC(year, month, 0)));
    const nextMonthStart = isoDate(new Date(Date.UTC(year, month + 1, 1)));
    previousButton.disabled = previousMonthEnd < minimum;
    nextButton.disabled = nextMonthStart > maximum;
    const tabbable = calendarGrid.querySelector(`[data-calendar-date="${selectedDate}"]:not(:disabled)`)
      || calendarGrid.querySelector(".growth-calendar-day:not(:disabled)");
    if (tabbable) tabbable.tabIndex = 0;
    positionCalendar();
    if (focusDate) focusCalendarDate(focusDate);
  }

  function closeCalendar({ restoreFocus = false } = {}) {
    if (calendar.hidden) return;
    const previousInput = activeInput;
    calendar.hidden = true;
    calendar.removeAttribute("aria-label");
    document.querySelectorAll(".date-range label.is-open").forEach((label) => label.classList.remove("is-open"));
    [fromInput, toInput].forEach((input) => input.setAttribute("aria-expanded", "false"));
    activeInput = null;
    if (restoreFocus) previousInput?.focus();
  }

  function openCalendar(input) {
    if (!calendar.hidden && activeInput === input) {
      closeCalendar({ restoreFocus: true });
      return;
    }
    if (activeInput) closeCalendar();
    activeInput = input;
    visibleMonth = utcDate(input.value);
    visibleMonth.setUTCDate(1);
    input.setAttribute("aria-expanded", "true");
    input.closest("label").classList.add("is-open");
    calendar.setAttribute("aria-label", `Choose ${input === fromInput ? "From" : "To"} date`);
    calendar.hidden = false;
    renderCalendar({ focusDate: input.value });
  }

  function selectDate(date) {
    if (!activeInput || date < minimum || date > maximum) return;
    activeInput.value = date;
    activeInput.dispatchEvent(new Event("change", { bubbles: true }));
    closeCalendar({ restoreFocus: true });
  }

  for (const input of [fromInput, toInput]) {
    input.addEventListener("click", () => openCalendar(input));
    input.addEventListener("keydown", (event) => {
      if (!["Enter", " ", "ArrowDown"].includes(event.key)) return;
      event.preventDefault();
      openCalendar(input);
    });
  }

  calendar.querySelectorAll("[data-calendar-nav]").forEach((button) => {
    button.addEventListener("click", () => {
      visibleMonth.setUTCMonth(visibleMonth.getUTCMonth() + Number(button.dataset.calendarNav));
      renderCalendar();
    });
  });
  calendar.querySelectorAll("[data-calendar-bound]").forEach((button) => {
    button.addEventListener("click", () => selectDate(button.dataset.calendarBound === "minimum" ? minimum : maximum));
  });
  calendarGrid.addEventListener("click", (event) => {
    const day = event.target.closest("[data-calendar-date]");
    if (day && !day.disabled) selectDate(day.dataset.calendarDate);
  });
  calendarGrid.addEventListener("keydown", (event) => {
    const day = event.target.closest("[data-calendar-date]");
    if (!day) return;
    const offsets = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    let nextDate = day.dataset.calendarDate;
    if (Object.hasOwn(offsets, event.key)) nextDate = shiftDate(nextDate, offsets[event.key]);
    else if (event.key === "Home") nextDate = shiftDate(nextDate, -((utcDate(nextDate).getUTCDay() + 6) % 7));
    else if (event.key === "End") nextDate = shiftDate(nextDate, 6 - ((utcDate(nextDate).getUTCDay() + 6) % 7));
    else if (["PageUp", "PageDown"].includes(event.key)) {
      const next = utcDate(nextDate);
      next.setUTCMonth(next.getUTCMonth() + (event.key === "PageUp" ? -1 : 1));
      nextDate = isoDate(next);
    } else return;
    event.preventDefault();
    nextDate = nextDate < minimum ? minimum : nextDate > maximum ? maximum : nextDate;
    const next = utcDate(nextDate);
    if (next.getUTCMonth() !== visibleMonth.getUTCMonth() || next.getUTCFullYear() !== visibleMonth.getUTCFullYear()) {
      visibleMonth = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth(), 1));
      renderCalendar({ focusDate: nextDate });
    } else focusCalendarDate(nextDate);
  });
  document.addEventListener("pointerdown", (event) => {
    if (calendar.hidden || calendar.contains(event.target) || event.target === activeInput) return;
    closeCalendar();
  }, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !calendar.hidden) {
      event.preventDefault();
      closeCalendar({ restoreFocus: true });
    }
  });
  window.addEventListener("resize", positionCalendar);
  return closeCalendar;
}

function setGrowthUrl(from, to) {
  const url = new URL(window.location.href);
  url.searchParams.set("view", "growth");
  url.searchParams.set("from", from);
  url.searchParams.set("to", to);
  window.history.replaceState(null, "", url);
}

function periodLabel(from, to, days) {
  if (days < 60) return `${days} Day${days === 1 ? "" : "s"}`;
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  let months = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + end.getUTCMonth() - start.getUTCMonth();
  if (end.getUTCDate() < start.getUTCDate()) months -= 1;
  months = Math.max(1, months);
  if (months < 24) return `${months} Month${months === 1 ? "" : "s"}`;
  const years = Math.floor(months / 12);
  const remainingMonths = months % 12;
  return `${years} Year${years === 1 ? "" : "s"}${remainingMonths ? ` ${remainingMonths} Month${remainingMonths === 1 ? "" : "s"}` : ""}`;
}

function addUtcDays(date, days) {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

function dayOffset(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

// Linear year-end projection. The pace is the average of daily additions from the Quattro release to the last
// completed day; the band spans the slowest and fastest complete week (7-day blocks from the day after the
// release). Every projected value is anchored on the last completed day, because the latest day is still
// filling up. Line, band, hover, and labels all use these functions.
function quattroPaceProjection(endDate) {
  const series = explorer.growth;
  const latest = series.at(-1);
  const completedIndex = Math.max(0, series.length - 2);
  const completed = series[completedIndex];
  const releaseIndex = Math.max(0, series.findIndex((point) => point.date === explorer.release.date));
  const release = series[releaseIndex];
  const paceDays = dayOffset(release.date, completed.date);
  if (paceDays <= 0 || endDate <= latest.date) return null;
  const perDay = (completed.total - release.total) / paceDays;
  const weeklyPaces = [];
  for (let end = releaseIndex + 7; end <= completedIndex; end += 7) weeklyPaces.push((series[end].total - series[end - 7].total) / 7);
  // The band always contains the average pace, even if the unfinished week runs outside the complete weeks.
  const slowest = Math.min(perDay, ...weeklyPaces);
  const fastest = Math.max(perDay, ...weeklyPaces);
  const at = (pace) => (date) => completed.total + pace * dayOffset(completed.date, date);
  const valueAt = at(perDay);
  const lowAt = at(slowest);
  const highAt = at(fastest);
  return {
    perDay,
    slowest,
    fastest,
    anchorDate: completed.date,
    valueAt,
    lowAt,
    highAt,
    endDate,
    total: Math.round(valueAt(endDate)),
    low: Math.round(lowAt(endDate)),
    high: Math.round(highAt(endDate)),
    days: dayOffset(latest.date, endDate),
  };
}

function niceTickStep(maximum, targetTicks = 8) {
  const roughStep = maximum / targetTicks;
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(1, roughStep)));
  const normalized = roughStep / magnitude;
  const multiplier = [1, 2, 5, 10].find((candidate) => candidate >= normalized) || 10;
  return multiplier * magnitude;
}

function setupGrowthGuide() {
  const chartElement = document.querySelector("#growth-chart");
  const guide = chartElement.querySelector("[data-chart-hover-guide]");
  const guideLine = guide.querySelector(".chart-hover-line");
  const guidePoint = guide.querySelector(".chart-hover-point");
  const guideBox = guide.querySelector(".chart-hover-box");
  const guideValue = guide.querySelector(".chart-hover-value");
  const guideDate = guide.querySelector(".chart-hover-date");

  const hideGuide = () => {
    guide.classList.add("is-hidden");
    chartElement.querySelector("[data-chart-end-value]")?.classList.remove("is-obscured");
    chartElement.querySelector("[data-chart-projection-value]")?.classList.remove("is-obscured");
  };
  chartElement.addEventListener("pointermove", (event) => {
    if (!growthGuideModel) return;
    const bounds = chartElement.getBoundingClientRect();
    const viewBox = chartElement.viewBox.baseVal;
    const pointerX = (event.clientX - bounds.left) / bounds.width * viewBox.width;
    const pointerY = (event.clientY - bounds.top) / bounds.height * viewBox.height;
    const { points, chart, x, y, endValue, lastSlot, projection, projectionValue, from } = growthGuideModel;
    if (pointerX < chart.left || pointerX > chart.right || pointerY < chart.top || pointerY > chart.bottom) {
      hideGuide();
      return;
    }

    const ratio = (pointerX - chart.left) / (chart.right - chart.left);
    const index = lastSlot === 0 ? 0 : Math.round(ratio * lastSlot);
    const projected = index > points.length - 1;
    if (projected && !projection) {
      hideGuide();
      return;
    }
    const point = projected
      ? { date: addUtcDays(from, index), total: projection.valueAt(addUtcDays(from, index)) }
      : points[Math.max(0, index)];
    const pointX = x(index);
    const pointY = y(point.total);
    const boxWidth = projected ? 300 : 198;
    const boxHeight = 60;
    const boxX = pointX + boxWidth + 16 > chart.right ? pointX - boxWidth - 16 : pointX + 16;
    const boxY = Math.max(chart.top + 8, Math.min(chart.bottom - boxHeight - 8, pointY - boxHeight / 2));
    guideLine.setAttribute("x1", pointX);
    guideLine.setAttribute("x2", pointX);
    guideLine.setAttribute("y1", chart.top);
    guideLine.setAttribute("y2", chart.bottom);
    guidePoint.setAttribute("cx", pointX);
    guidePoint.setAttribute("cy", pointY);
    guideBox.setAttribute("x", boxX);
    guideBox.setAttribute("y", boxY);
    guideBox.setAttribute("width", boxWidth);
    guideValue.setAttribute("x", boxX + 13);
    guideValue.setAttribute("y", boxY + 25);
    guideValue.textContent = projected
      ? `≈ ${number.format(Math.round(point.total))} plugins`
      : `${number.format(point.total)} plugins`;
    guideDate.setAttribute("x", boxX + 13);
    guideDate.setAttribute("y", boxY + 48);
    guideDate.textContent = projected
      ? `${posterDate.format(new Date(`${point.date}T00:00:00Z`)).toUpperCase()} · ${number.format(Math.round(projection.lowAt(point.date)))}–${number.format(Math.round(projection.highAt(point.date)))}`
      : posterDate.format(new Date(`${point.date}T00:00:00Z`)).toUpperCase();
    const collisionPadding = 10;
    const lineOverlapsEndValue = pointX >= endValue.x - collisionPadding
      && pointX <= endValue.x + endValue.width + collisionPadding;
    const badgeOverlapsEndValue = boxX < endValue.x + endValue.width + collisionPadding
      && boxX + boxWidth > endValue.x - collisionPadding
      && boxY < endValue.y + endValue.height + collisionPadding
      && boxY + boxHeight > endValue.y - collisionPadding;
    const overlapsProjectionValue = Boolean(projectionValue)
      && boxX < projectionValue.x + projectionValue.width + collisionPadding
      && boxX + boxWidth > projectionValue.x - collisionPadding
      && boxY < projectionValue.y + projectionValue.height + collisionPadding
      && boxY + boxHeight > projectionValue.y - collisionPadding;
    chartElement.querySelector("[data-chart-projection-value]")?.classList.toggle("is-obscured", overlapsProjectionValue || (projected && index === lastSlot));
    chartElement.querySelector("[data-chart-end-value]")?.classList.toggle("is-obscured", lineOverlapsEndValue || badgeOverlapsEndValue);
    guide.classList.remove("is-hidden");
  });
  chartElement.addEventListener("pointerleave", hideGuide);
}

function renderGrowth({ updateUrl = true } = {}) {
  document.querySelector(".growth-poster").classList.toggle("is-light", themeById(document.documentElement.dataset.theme).light);
  const fromInput = document.querySelector("#growth-from");
  const toInput = document.querySelector("#growth-to");
  let from = clampedDate(fromInput.value, explorer.growth[0].date);
  let to = clampedDate(toInput.value, explorer.growth.at(-1).date);
  if (from > to) [from, to] = [to, from];
  fromInput.value = from;
  toInput.value = to;
  const startIndex = dateIndex(from);
  const endIndex = dateIndex(to);
  const points = explorer.growth.slice(startIndex, endIndex + 1);
  if (!points.length) return;

  const start = points[0];
  const end = points.at(-1);
  const change = end.total - start.total;
  const percentage = start.total ? change / start.total * 100 : null;
  const trendArrow = change > 0 ? "↗" : change < 0 ? "↘" : "→";
  const trendWord = change > 0 ? "increase" : change < 0 ? "decrease" : "change";
  const rateText = percentage === null
    ? "New"
    : `${percentage > 0 ? "+" : ""}${new Intl.NumberFormat("en-US", { maximumFractionDigits: Math.abs(percentage) < 10 ? 1 : 0 }).format(percentage)}%`;
  const period = inclusiveDayCount(from, to);
  document.querySelector("#growth-start-total").textContent = number.format(start.total);
  document.querySelector("#growth-end-total").textContent = number.format(end.total);
  const growthDelta = document.querySelector("#growth-delta");
  growthDelta.querySelector("strong").textContent = `${change > 0 ? "+" : ""}${number.format(change)}`;
  growthDelta.classList.toggle("is-flat", change === 0);
  const absoluteChange = Math.abs(change);
  growthDelta.setAttribute("aria-label", `${number.format(absoluteChange)} plugin${absoluteChange === 1 ? "" : "s"} ${trendWord} over the selected period`);
  document.querySelector("#growth-trend-arrow").textContent = trendArrow;
  document.querySelector("#growth-rate-value").textContent = rateText;
  const growthRate = document.querySelector("#growth-rate");
  growthRate.classList.toggle("is-flat", change === 0);
  growthRate.setAttribute("aria-label", percentage === null
    ? "New growth from a zero starting value"
    : `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(Math.abs(percentage))} percent ${trendWord} over the selected period`);
  document.querySelector("#growth-period").textContent = periodLabel(from, to, period);
  document.querySelector("#growth-range-copy").textContent = from === explorer.release.date
    ? "since the Quattro release"
    : `${shortDate.format(new Date(`${from}T00:00:00Z`))}–${shortDate.format(new Date(`${to}T00:00:00Z`))}`;
  document.querySelector("#growth-as-of").textContent = `As of ${posterDate.format(new Date(`${to}T00:00:00Z`)).toUpperCase()}`;
  document.querySelector("#growth-chart-description").textContent = `Active community plugin listings changed from ${number.format(start.total)} to ${number.format(end.total)} between ${posterDate.format(new Date(`${from}T00:00:00Z`))} and ${posterDate.format(new Date(`${to}T00:00:00Z`))}${percentage === null ? "" : `, a ${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(Math.abs(percentage))} percent ${trendWord}`}.`;
  const latestDate = explorer.growth.at(-1).date;
  const projectionButtons = [...document.querySelectorAll("[data-projection-year]")];
  projectionButtons.forEach((button) => {
    button.hidden = `${button.dataset.projectionYear}-12-31` <= latestDate;
    button.disabled = to !== latestDate;
    button.setAttribute("aria-pressed", String(button.dataset.projectionYear === growthProjectionYear));
  });
  document.querySelector(".growth-projection-row").hidden = projectionButtons.every((button) => button.hidden);
  const projection = growthProjectionYear && to === latestDate ? quattroPaceProjection(`${growthProjectionYear}-12-31`) : null;
  document.querySelector("#growth-legend-projection").hidden = !projection;
  document.querySelector("#growth-legend-band").hidden = !projection;
  if (projection) {
    document.querySelector("#growth-chart-description").textContent += ` Projected at the average pace since the Quattro release (${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(projection.perDay)} plugins per day): about ${number.format(projection.total)} by ${posterDate.format(new Date(`${projection.endDate}T00:00:00Z`))}. At the pace of the slowest and fastest complete week since the release (${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(projection.slowest)} and ${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(projection.fastest)} per day): ${number.format(projection.low)} to ${number.format(projection.high)}.`;
    for (let year = Number(latestDate.slice(0, 4)); `${year}-12-31` < projection.endDate; year += 1) {
      const date = `${year}-12-31`;
      if (date <= latestDate) continue;
      document.querySelector("#growth-chart-description").textContent += ` By ${posterDate.format(new Date(`${date}T00:00:00Z`))}: about ${number.format(Math.round(projection.valueAt(date)))} (${number.format(Math.round(projection.lowAt(date)))} to ${number.format(Math.round(projection.highAt(date)))}).`;
    }
  }
  if (updateUrl) setGrowthUrl(from, to);

  let activePreset = "";
  if (to === explorer.growth.at(-1).date && from === explorer.release.date) activePreset = "release";
  else if (to === explorer.growth.at(-1).date && from === explorer.growth[0].date) activePreset = "all";
  else if (to === explorer.growth.at(-1).date && from === growthPresetFrom(7)) activePreset = "7";
  else if (to === explorer.growth.at(-1).date && from === growthPresetFrom(14)) activePreset = "14";
  document.querySelectorAll("[data-growth-preset]").forEach((button) => {
    const active = button.dataset.growthPreset === activePreset;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });

  const grid = document.querySelector("[data-chart-grid]");
  const labels = document.querySelector("[data-chart-labels]");
  const pointLayer = document.querySelector("[data-chart-points]");
  const releaseLayer = document.querySelector("[data-release-marker]");
  const projectionLayer = document.querySelector("[data-chart-projection]");
  grid.replaceChildren();
  labels.replaceChildren();
  pointLayer.replaceChildren();
  releaseLayer.replaceChildren();
  projectionLayer.replaceChildren();

  const chart = { left: 104, right: 1644, top: 70, bottom: 560 };
  const lastSlot = points.length - 1 + (projection ? projection.days : 0);
  const maximum = Math.max(...points.map((point) => point.total), projection ? projection.highAt(projection.endDate) : 0);
  const tickStep = niceTickStep(maximum);
  const yMaximum = Math.max(tickStep, Math.ceil(maximum / tickStep) * tickStep);
  const x = (index) => chart.left + (lastSlot === 0 ? 0 : index / lastSlot * (chart.right - chart.left));
  const y = (value) => chart.bottom - value / yMaximum * (chart.bottom - chart.top);
  growthGuideModel = { points, chart, x, y, lastSlot, projection, from };
  document.querySelector("[data-chart-hover-guide]").classList.add("is-hidden");

  for (let value = 0; value <= yMaximum; value += tickStep) {
    const positionY = y(value);
    grid.append(svgElement("line", { class: "chart-grid-line", x1: chart.left, y1: positionY, x2: chart.right, y2: positionY }));
    labels.append(svgElement("text", { class: "chart-axis-label", x: chart.left - 18, y: positionY + 5, "text-anchor": "end" }, number.format(value)));
  }

  const maximumXLabels = 7;
  const labelStep = Math.max(1, Math.ceil(lastSlot / (maximumXLabels - 1)));
  const axisDate = projection ? (lastSlot > 186 ? monthDate : shortDate) : period > 62 ? monthDate : shortDate;
  for (let index = 0; index <= lastSlot; index += 1) {
    if (index !== 0 && index !== lastSlot && index % labelStep !== 0) continue;
    labels.append(svgElement("text", { class: "chart-axis-label", x: x(index), y: chart.bottom + 34, "text-anchor": "middle" }, axisDate.format(new Date(`${addUtcDays(from, index)}T00:00:00Z`)).toUpperCase()));
  }

  const linePath = points.map((point, index) => `${index ? "L" : "M"}${x(index).toFixed(2)},${y(point.total).toFixed(2)}`).join(" ");
  const areaPath = `${linePath} L${x(points.length - 1)},${chart.bottom} L${x(0)},${chart.bottom} Z`;
  document.querySelector("[data-chart-line]").setAttribute("d", linePath);
  document.querySelector("[data-chart-area]").setAttribute("d", areaPath);
  pointLayer.append(svgElement("circle", { class: "chart-point", cx: x(0), cy: y(start.total), r: 5 }));
  pointLayer.append(svgElement("circle", { class: "chart-point", cx: x(points.length - 1), cy: y(end.total), r: 8 }));
  pointLayer.append(svgElement("circle", { class: "chart-point-ring", cx: x(points.length - 1), cy: y(end.total), r: 14 }));

  const valueBoxWidth = 126;
  const valueBoxX = x(points.length - 1) - valueBoxWidth / 2;
  const preferredValueBoxY = y(end.total) - 53;
  const valueBoxY = preferredValueBoxY < 70 ? 8 : preferredValueBoxY;
  const endValueGroup = svgElement("g", { class: "chart-end-value", "data-chart-end-value": "" });
  endValueGroup.append(svgElement("rect", { class: "chart-value-box", x: valueBoxX, y: valueBoxY, width: valueBoxWidth, height: 36 }));
  endValueGroup.append(svgElement("text", { class: "chart-value-label", x: valueBoxX + 14, y: valueBoxY + 24 }, number.format(end.total)));
  // With the projection, the current total moves into the TODAY badge instead.
  if (!projection) labels.append(endValueGroup);
  growthGuideModel.endValue = { x: valueBoxX, y: valueBoxY, width: valueBoxWidth, height: 36 };

  const releaseIndex = points.findIndex((point) => point.date === explorer.release.date);
  const releaseBoxWidth = 340;
  const releaseBoxHeight = 60;
  const releaseBox = releaseIndex >= 0
    ? { x: Math.min(chart.right - releaseBoxWidth, Math.max(chart.left, x(releaseIndex))), y: chart.top + 10, width: releaseBoxWidth, height: releaseBoxHeight }
    : null;

  if (projection) {
    // Straight segments are exact here: every projected value is linear in days since the anchor.
    const startSlot = Math.max(0, dayOffset(from, projection.anchorDate));
    const startDate = addUtcDays(from, startSlot);
    const startX = x(startSlot);
    const endX = x(lastSlot);
    const endY = y(projection.valueAt(projection.endDate));
    projectionLayer.append(svgElement("path", {
      class: "chart-projection-band",
      d: `M${startX},${y(projection.highAt(startDate))} L${endX},${y(projection.highAt(projection.endDate))} L${endX},${y(projection.lowAt(projection.endDate))} L${startX},${y(projection.lowAt(startDate))} Z`,
    }));
    projectionLayer.append(svgElement("line", { class: "chart-projection-line", x1: startX, y1: y(projection.valueAt(startDate)), x2: endX, y2: endY }));
    projectionLayer.append(svgElement("circle", { class: "chart-projection-point", cx: endX, cy: endY, r: 7 }));
    // Point badges in the release badge style, each with a pointer to its point. The selected year end keeps its
    // fixed spot above the band end. TODAY and every earlier year end try positions close above its point first (starting
    // at the point like the release badge, then centered, then ending at the point), further up next, and below
    // the point last. A position is taken only if its box overlaps no badge, its pointer crosses no badge, and
    // its box covers no earlier pointer.
    const occupied = releaseBox ? [releaseBox] : [];
    const pointers = [];
    const gap = 8;
    const boxesOverlap = (first, second) => first.x < second.x + second.width + gap && first.x + first.width + gap > second.x
      && first.y < second.y + second.height + gap && first.y + first.height + gap > second.y;
    const pointerCrosses = (pointer, box) => pointer.x >= box.x - gap && pointer.x <= box.x + box.width + gap
      && pointer.top < box.y + box.height && pointer.bottom > box.y;
    const placeable = (box, pointer) => !occupied.some((other) => boxesOverlap(box, other) || pointerCrosses(pointer, other))
      && !pointers.some((other) => pointerCrosses(other, box));
    const pointBadge = (pointX, pointY, title, meta, { attributes = {}, fixed = null } = {}) => {
      const badgeWidth = Math.ceil(Math.max(title.length * 12.4, meta.length * 10.4)) + 32;
      const badgeHeight = 60;
      let badgeX;
      let badgeY;
      if (fixed) {
        ({ x: badgeX, y: badgeY } = fixed(badgeWidth, badgeHeight));
      } else {
        const lefts = [pointX - 20, pointX - badgeWidth / 2, pointX + 20 - badgeWidth]
          .map((left) => Math.min(chart.right + 40 - badgeWidth, Math.max(chart.left, left)))
          .filter((left) => pointX >= left + 8 && pointX <= left + badgeWidth - 8);
        const tops = [];
        for (let top = pointY - 48 - badgeHeight; top >= 8; top -= 34) tops.push(top);
        for (let top = pointY + 48; top + badgeHeight <= chart.bottom - 8; top += 34) tops.push(top);
        const spot = tops.flatMap((top) => lefts.map((left) => ({ left, top }))).find(({ left, top }) => placeable(
          { x: left, y: top, width: badgeWidth, height: badgeHeight },
          top > pointY ? { x: pointX, top: pointY + 18, bottom: top } : { x: pointX, top: top + badgeHeight, bottom: pointY - 18 },
        ));
        if (!spot) return null;
        badgeX = spot.left;
        badgeY = spot.top;
      }
      const rect = { x: badgeX, y: badgeY, width: badgeWidth, height: badgeHeight };
      occupied.push(rect);
      pointers.push(badgeY > pointY ? { x: pointX, top: pointY + 18, bottom: badgeY } : { x: pointX, top: badgeY + badgeHeight, bottom: pointY - 18 });
      const badge = svgElement("g", attributes);
      const below = badgeY > pointY;
      const tip = below ? pointY + 18 : pointY - 18;
      const direction = below ? 1 : -1;
      badge.append(svgElement("line", { class: "today-pointer", x1: pointX, y1: below ? badgeY : badgeY + badgeHeight, x2: pointX, y2: tip + direction * 7 }));
      badge.append(svgElement("path", { class: "today-pointer-head", d: `M${pointX - 6},${tip + direction * 9} L${pointX + 6},${tip + direction * 9} L${pointX},${tip} Z` }));
      badge.append(svgElement("rect", { class: "release-label-box", x: badgeX, y: badgeY, width: badgeWidth, height: badgeHeight }));
      badge.append(svgElement("rect", { class: "release-label-accent", x: badgeX, y: badgeY, width: 4, height: badgeHeight }));
      badge.append(svgElement("text", { class: "release-label", x: badgeX + 16, y: badgeY + 25 }, title));
      badge.append(svgElement("text", { class: "release-label-meta", x: badgeX + 16, y: badgeY + 48 }, meta));
      projectionLayer.append(badge);
      return rect;
    };
    const yearEndMeta = (date) => `${posterDate.format(new Date(`${date}T00:00:00Z`)).toUpperCase()} · ${number.format(Math.round(projection.lowAt(date)))}–${number.format(Math.round(projection.highAt(date)))}`;

    growthGuideModel.projectionValue = pointBadge(endX, endY, `≈ ${number.format(projection.total)} PLUGINS`, yearEndMeta(projection.endDate), {
      attributes: { class: "chart-end-value", "data-chart-projection-value": "" },
      fixed: (width, height) => ({ x: endX + 20 - width, y: Math.max(8, y(projection.highAt(projection.endDate)) - height - 12) }),
    });
    const yearEnds = [];
    for (let year = Number(end.date.slice(0, 4)); `${year}-12-31` < projection.endDate; year += 1) {
      const date = `${year}-12-31`;
      if (date <= end.date) continue;
      const pointX = x(dayOffset(from, date));
      const pointY = y(projection.valueAt(date));
      projectionLayer.append(svgElement("circle", { class: "chart-projection-point", cx: pointX, cy: pointY, r: 6 }));
      yearEnds.push({ date, pointX, pointY });
    }
    // Later year ends first, TODAY last: the points rise to the right, so this keeps pointers short.
    yearEnds.reverse().forEach(({ date, pointX, pointY }) => {
      pointBadge(pointX, pointY, `≈ ${number.format(Math.round(projection.valueAt(date)))} PLUGINS`, yearEndMeta(date));
    });
    const todayDate = posterDate.format(new Date(`${end.date}T00:00:00Z`)).toUpperCase();
    pointBadge(x(points.length - 1), y(end.total), `${number.format(end.total)} PLUGINS`, `${todayDate} · TODAY`);
  }

  if (releaseBox) {
    const releaseX = x(releaseIndex);
    releaseLayer.append(svgElement("line", { class: "release-line", x1: releaseX, y1: chart.top, x2: releaseX, y2: chart.bottom }));
    const boxX = releaseBox.x;
    const boxY = releaseBox.y;
    releaseLayer.append(svgElement("rect", { class: "release-label-box", x: boxX, y: boxY, width: releaseBoxWidth, height: releaseBoxHeight }));
    releaseLayer.append(svgElement("rect", { class: "release-label-accent", x: boxX, y: boxY, width: 4, height: releaseBoxHeight }));
    const releaseDate = posterDate.format(new Date(`${explorer.release.date}T00:00:00Z`)).toUpperCase();
    releaseLayer.append(svgElement("text", { class: "release-label", x: boxX + 16, y: boxY + 25 }, "OMARCHY QUATTRO v4.0.0"));
    releaseLayer.append(svgElement("text", { class: "release-label-meta", x: boxX + 16, y: boxY + 48 }, `${releaseDate} · RELEASE`));
  }
}

function setupGrowth() {
  const fromInput = document.querySelector("#growth-from");
  const toInput = document.querySelector("#growth-to");
  const minimum = explorer.growth[0].date;
  const maximum = explorer.growth.at(-1).date;
  const growthMeta = explorer.growthMeta || {};
  const timezone = growthMeta.timezone || "UTC";
  document.querySelector("#growth-method-copy").textContent = growthMeta.historical
    ? `${growthMeta.label} (${timezone})`
    : growthMeta.label || "Reconstructed catalog growth";
  document.querySelector("#growth-legend-copy").textContent = growthMeta.historical
    ? "Active community listings"
    : "Reconstructed cumulative listings";
  document.querySelector("#growth-source").textContent = growthMeta.historical
    ? "Git catalog snapshots"
    : "Current catalog metadata · excludes delisted plugins";
  fromInput.min = minimum;
  fromInput.max = maximum;
  toInput.min = minimum;
  toInput.max = maximum;
  const params = new URLSearchParams(window.location.search);
  fromInput.value = clampedDate(params.get("from"), clampedDate(explorer.release.date, minimum));
  toInput.value = clampedDate(params.get("to"), maximum);
  fromInput.addEventListener("change", renderGrowth);
  toInput.addEventListener("change", renderGrowth);
  const closeGrowthCalendar = setupGrowthCalendar(fromInput, toInput, minimum, maximum);
  setupGrowthGuide();
  document.querySelectorAll("[data-projection-year]").forEach((button) => {
    button.addEventListener("click", () => {
      const year = button.dataset.projectionYear;
      growthProjectionYear = growthProjectionYear === year ? null : year;
      renderGrowth({ updateUrl: false });
    });
  });
  document.querySelectorAll("[data-growth-preset]").forEach((button) => {
    button.addEventListener("click", () => {
      closeGrowthCalendar();
      const preset = button.dataset.growthPreset;
      if (preset === "all") fromInput.value = minimum;
      else if (preset === "release") fromInput.value = clampedDate(explorer.release.date, minimum);
      else fromInput.value = growthPresetFrom(preset);
      toInput.value = maximum;
      renderGrowth();
    });
  });
  renderGrowth({ updateUrl: false });
}

function setView(view, { updateUrl = true } = {}) {
  const growth = view === "growth";
  graphView.hidden = growth;
  growthView.hidden = !growth;
  graphTab.classList.toggle("active", !growth);
  growthTab.classList.toggle("active", growth);
  graphTab.setAttribute("aria-selected", String(!growth));
  growthTab.setAttribute("aria-selected", String(growth));
  graphTab.tabIndex = growth ? -1 : 0;
  growthTab.tabIndex = growth ? 0 : -1;
  if (updateUrl) {
    const url = new URL(window.location.href);
    if (growth) url.searchParams.set("view", "growth");
    else {
      url.searchParams.delete("view");
      url.searchParams.delete("from");
      url.searchParams.delete("to");
    }
    window.history.replaceState(null, "", url);
  }
  if (growth) renderGrowth();
  else window.requestAnimationFrame(() => {
    resizeCanvas({ fit: false });
    syncCommunityScrollFade();
  });
}

document.querySelectorAll("[data-explore-view]").forEach((button) => {
  button.addEventListener("click", () => setView(button.dataset.exploreView));
  button.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = ["ArrowLeft", "Home"].includes(event.key) ? graphTab : growthTab;
    setView(next.dataset.exploreView);
    next.focus();
  });
});

setupThemeToggle();
new MutationObserver(() => {
  applyGraphTheme();
  drawGraph();
  if (!growthView.hidden && explorer) renderGrowth({ updateUrl: false });
}).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
new ResizeObserver(() => resizeCanvas()).observe(canvas);
let growthResizeFrame;
window.addEventListener("resize", () => {
  if (growthView.hidden || !explorer || growthResizeFrame) return;
  growthResizeFrame = window.requestAnimationFrame(() => {
    growthResizeFrame = null;
    renderGrowth({ updateUrl: false });
  });
});

try {
  const response = await fetch("explorer-data.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`Explorer request failed: ${response.status}`);
  explorer = await response.json();
  setupDataFreshness();
  setupGraph();
  setupGrowth();
  setView(new URLSearchParams(window.location.search).get("view") === "growth" ? "growth" : "graph", { updateUrl: false });
} catch (error) {
  console.error(error);
  loading.hidden = true;
  graphView.hidden = true;
  growthView.hidden = true;
  errorMessage.hidden = false;
}
