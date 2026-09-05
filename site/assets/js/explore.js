import { accentColor, formatDate, setupThemeToggle } from "./shared.js?v=20260831-01";
import { createExplorerSearchMatcher, repositoryPublisher } from "./explore-search.js?v=20260831-01";
import { inclusiveDayCount, inclusiveRangeStart } from "./growth-range.js?v=20260828-18";

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
let syncCommunityScrollFade = () => {};

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

function visible(node) {
  const clusterVisible = !activeCluster || node.cluster === activeCluster;
  const densityVisible = !focusMode || focusIndexes.has(node.index) || node === selected || matches.has(node.index);
  return clusterVisible && densityVisible;
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
  const lightTheme = document.documentElement.dataset.theme === "light";
  const labelHaloColor = lightTheme ? "#f8f8f6" : "#000";
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
    context.strokeStyle = clusterById.get(source.cluster).color;
    context.beginPath();
    context.moveTo(source.x * viewport.scale + viewport.x, source.y * viewport.scale + viewport.y);
    context.lineTo(target.x * viewport.scale + viewport.x, target.y * viewport.scale + viewport.y);
    context.stroke();
  }

  for (const cluster of explorer.clusters) {
    const members = explorer.nodes.filter((node) => node.cluster === cluster.id && visible(node)).sort((first, second) => second.influence - first.influence).slice(0, 9);
    if (!members.length) continue;
    const hub = worldToScreen(cluster.center);
    for (const node of members) {
      const position = worldToScreen(node);
      context.globalAlpha = lightTheme ? .46 : .34;
      context.strokeStyle = cluster.color;
      context.lineWidth = 1.05;
      context.beginPath();
      context.moveTo(hub.x, hub.y);
      context.lineTo(position.x, position.y);
      context.stroke();
    }
    context.globalAlpha = .95;
    context.fillStyle = cluster.color;
    context.shadowColor = cluster.color;
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
      color: lightTheme ? "#19191b" : "#efeff0",
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
    const cluster = clusterById.get(node.cluster);
    context.globalAlpha = emphasized(node) ? (focus ? 1 : .92) : .08;
    context.fillStyle = focus ? (lightTheme ? "#111" : "#fff") : cluster.color;
    context.shadowColor = cluster.color;
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
      color: lightTheme ? "#19191b" : "#c5c5c8",
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
  const detailAccent = accentColor(node.accent);
  const publisher = repositoryPublisher(node.repo);
  detail.style.setProperty("--detail-accent", detailAccent);
  detail.style.borderLeftColor = detailAccent;
  detail.querySelector("h2").textContent = node.name;
  detail.querySelector(".detail-publisher").textContent = `${publisher ? `by @${publisher}` : `by ${node.author || "Unknown"}`} · ${node.kind || node.category}`;
  detail.querySelector(".detail-identity").textContent = `${node.author || "Unknown"} · ${node.id}`;
  detail.querySelector(".detail-description").textContent = node.description || "No description available.";
  const community = detail.querySelector(".detail-community");
  community.style.setProperty("--community", cluster.color);
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
    button.setAttribute("aria-label", `Select related plugin ${candidate.name}, ${similarity}% similarity`);
    button.append(element("span", "", candidate.name), element("small", "", `${similarity}% →`));
    button.addEventListener("click", () => selectNode(candidate, true));
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
  const communities = document.querySelector("#community-list");
  communities.replaceChildren(...leadingClusters.map((cluster) => {
    const button = element("button", "community-row");
    button.type = "button";
    button.dataset.cluster = cluster.id;
    button.setAttribute("aria-label", `${cluster.label}: ${number.format(cluster.count)} plugins, ${Math.round(cluster.count / explorer.nodes.length * 100)} percent`);
    button.setAttribute("aria-pressed", "false");
    button.style.setProperty("--community", cluster.color);
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

canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  const position = pointerPosition(event);
  const factor = Math.exp(-event.deltaY * .0012);
  const nextScale = Math.min(3.2, Math.max(.1, viewport.scale * factor));
  const worldX = (position.x - viewport.x) / viewport.scale;
  const worldY = (position.y - viewport.y) / viewport.scale;
  viewport.x = position.x - worldX * nextScale;
  viewport.y = position.y - worldY * nextScale;
  viewport.scale = nextScale;
  drawGraph();
}, { passive: false });

canvas.addEventListener("pointerdown", (event) => {
  dragging = true;
  moved = false;
  pointer = pointerPosition(event);
  canvas.setPointerCapture(event.pointerId);
  canvas.classList.add("dragging");
});
canvas.addEventListener("pointermove", (event) => {
  const position = pointerPosition(event);
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
canvas.addEventListener("pointerup", (event) => {
  const position = pointerPosition(event);
  dragging = false;
  canvas.classList.remove("dragging");
  canvas.releasePointerCapture(event.pointerId);
  if (!moved) selectNode(nearestNode(position.x, position.y));
});
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
  };
  chartElement.addEventListener("pointermove", (event) => {
    if (!growthGuideModel) return;
    const bounds = chartElement.getBoundingClientRect();
    const viewBox = chartElement.viewBox.baseVal;
    const pointerX = (event.clientX - bounds.left) / bounds.width * viewBox.width;
    const pointerY = (event.clientY - bounds.top) / bounds.height * viewBox.height;
    const { points, chart, x, y, endValue } = growthGuideModel;
    if (pointerX < chart.left || pointerX > chart.right || pointerY < chart.top || pointerY > chart.bottom) {
      hideGuide();
      return;
    }

    const ratio = (pointerX - chart.left) / (chart.right - chart.left);
    const index = points.length === 1 ? 0 : Math.round(ratio * (points.length - 1));
    const point = points[Math.max(0, Math.min(points.length - 1, index))];
    const pointX = x(index);
    const pointY = y(point.total);
    const boxWidth = 198;
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
    guideValue.setAttribute("x", boxX + 13);
    guideValue.setAttribute("y", boxY + 25);
    guideValue.textContent = `${number.format(point.total)} plugins`;
    guideDate.setAttribute("x", boxX + 13);
    guideDate.setAttribute("y", boxY + 48);
    guideDate.textContent = posterDate.format(new Date(`${point.date}T00:00:00Z`)).toUpperCase();
    const collisionPadding = 10;
    const lineOverlapsEndValue = pointX >= endValue.x - collisionPadding
      && pointX <= endValue.x + endValue.width + collisionPadding;
    const badgeOverlapsEndValue = boxX < endValue.x + endValue.width + collisionPadding
      && boxX + boxWidth > endValue.x - collisionPadding
      && boxY < endValue.y + endValue.height + collisionPadding
      && boxY + boxHeight > endValue.y - collisionPadding;
    chartElement.querySelector("[data-chart-end-value]")?.classList.toggle("is-obscured", lineOverlapsEndValue || badgeOverlapsEndValue);
    guide.classList.remove("is-hidden");
  });
  chartElement.addEventListener("pointerleave", hideGuide);
}

function renderGrowth({ updateUrl = true } = {}) {
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
  const finalityDescription = end.date === explorer.growth.at(-1).date
    ? "The latest UTC day in this range is provisional until a successful later-day build finalizes it."
    : "All UTC days in this range are final.";
  document.querySelector("#growth-chart-description").textContent = `Active community plugin listings changed from ${number.format(start.total)} to ${number.format(end.total)} between ${posterDate.format(new Date(`${from}T00:00:00Z`))} and ${posterDate.format(new Date(`${to}T00:00:00Z`))}${percentage === null ? "" : `, a ${new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(Math.abs(percentage))} percent ${trendWord}`}. ${finalityDescription}`;
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
  grid.replaceChildren();
  labels.replaceChildren();
  pointLayer.replaceChildren();
  releaseLayer.replaceChildren();

  const chart = { left: 104, right: 1644, top: 70, bottom: 560 };
  const maximum = Math.max(...points.map((point) => point.total));
  const tickStep = niceTickStep(maximum);
  const yMaximum = Math.max(tickStep, Math.ceil(maximum / tickStep) * tickStep);
  const x = (index) => chart.left + (points.length === 1 ? 0 : index / (points.length - 1) * (chart.right - chart.left));
  const y = (value) => chart.bottom - value / yMaximum * (chart.bottom - chart.top);
  growthGuideModel = { points, chart, x, y };
  document.querySelector("[data-chart-hover-guide]").classList.add("is-hidden");

  for (let value = 0; value <= yMaximum; value += tickStep) {
    const positionY = y(value);
    grid.append(svgElement("line", { class: "chart-grid-line", x1: chart.left, y1: positionY, x2: chart.right, y2: positionY }));
    labels.append(svgElement("text", { class: "chart-axis-label", x: chart.left - 18, y: positionY + 5, "text-anchor": "end" }, number.format(value)));
  }

  const maximumXLabels = 7;
  const labelStep = Math.max(1, Math.ceil((points.length - 1) / (maximumXLabels - 1)));
  const axisDate = period > 62 ? monthDate : shortDate;
  points.forEach((point, index) => {
    if (index !== 0 && index !== points.length - 1 && index % labelStep !== 0) return;
    labels.append(svgElement("text", { class: "chart-axis-label", x: x(index), y: chart.bottom + 34, "text-anchor": "middle" }, axisDate.format(new Date(`${point.date}T00:00:00Z`)).toUpperCase()));
  });

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
  labels.append(endValueGroup);
  growthGuideModel.endValue = { x: valueBoxX, y: valueBoxY, width: valueBoxWidth, height: 36 };

  const releaseIndex = points.findIndex((point) => point.date === explorer.release.date);
  if (releaseIndex >= 0) {
    const releaseX = x(releaseIndex);
    releaseLayer.append(svgElement("line", { class: "release-line", x1: releaseX, y1: chart.top, x2: releaseX, y2: chart.bottom }));
    const releaseBoxWidth = 340;
    const releaseBoxHeight = 60;
    const boxX = Math.min(chart.right - releaseBoxWidth, Math.max(chart.left, releaseX));
    const boxY = chart.top + 10;
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
  document.querySelector("#growth-finality-copy").textContent = `Earlier UTC days are final. The latest day (${maximum}, UTC) is provisional until a successful later-day build finalizes it.`;
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
