import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertCompleteGitHistory,
  assertGrowthContinuity,
  readCommittedExplorerData,
} from "./explorer-growth-history.mjs";
import { matchesKidsTaxonomy } from "../site/assets/js/taxonomy.js";

const catalogUrl = process.env.MARKETPLACE_EXPLORER_CATALOG_PATH
  ? resolve(process.env.MARKETPLACE_EXPLORER_CATALOG_PATH)
  : new URL("../site/catalog.json", import.meta.url);
const outputUrl = process.env.MARKETPLACE_EXPLORER_OUTPUT_PATH
  ? resolve(process.env.MARKETPLACE_EXPLORER_OUTPUT_PATH)
  : new URL("../site/explorer-data.json", import.meta.url);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const catalog = JSON.parse(fs.readFileSync(catalogUrl, "utf8"));
const plugins = catalog.plugins.filter((plugin) => plugin.sourceType === "community");

assertCompleteGitHistory(projectRoot);

const clusterDefinitions = [
  ["ai", "AI & Automation", "#a78bfa", [" ai ", "llm", "gpt", "claude", "ollama", "agent", "assistant", "openai", "automation"]],
  ["games", "Games", "#f4bd62", ["game", "chess", "snake", "minesweeper", "solitaire", "quake", "doom", "arcade", "steam", "gaming"]],
  ["kids", "Kids & Education", "#ff9fcf", []],
  ["network", "Network & VPN", "#68d6e8", ["vpn", "wireguard", "network", "wifi", "tailscale", "openvpn", "proxy", "firewall", "ssh", "connectivity"]],
  ["media", "Media & Audio", "#e896ba", ["music", "audio", "media", "spotify", "youtube", "radio", "podcast", "volume", "mpris", "album", "sound"]],
  ["productivity", "Productivity", "#b7ef51", ["todo", "task", "calendar", "agenda", "timer", "pomodoro", "notes", "mail", "gmail", "clipboard", "productivity", "reminder"]],
  ["system", "System & Monitoring", "#74a7f7", ["system", "cpu", "gpu", "memory", "battery", "temperature", "process", "disk", "monitoring", "performance", "resource"]],
  ["hardware", "Hardware & Devices", "#f18c75", ["hardware", "display", "printer", "bluetooth", "airpods", "tesla", "camera", "webcam", "keyboard", "mouse", "device", "screen"]],
  ["files", "Files & Storage", "#69d4a7", ["file", "download", "backup", "storage", "drive", "snapshot", "archive", "folder", "sync"]],
  ["communication", "Communication", "#ff8f70", ["chat", "discord", "whatsapp", "telegram", "slack", "matrix", "notification", "message", "inbox"]],
  ["appearance", "Appearance & Themes", "#caa7ff", ["theme", "wallpaper", "colour", "color", "style", "visual", "animation", "blur", "scanline", "appearance"]],
  ["developer", "Developer Tools", "#80c7ff", ["github", " git ", "coder", "terminal", "docker", "kubernetes", "developer", " api ", "code", "repository"]],
  ["home", "Home & IoT", "#77d9b3", ["home assistant", "smart home", "weather", "radar", "energy", "iot", "unifi", "house", "climate"]],
  ["security", "Security & Privacy", "#ff6b5f", ["security", "password", "passkey", "vault", "secret", "privacy", "lock screen", "authentication", "credential"]],
  ["navigation", "Shell & Navigation", "#d7d7dc", ["launcher", "workspace", "workspaces", "dock", "navbar", "menu", "window switcher", "app switcher"]],
  ["other", "Other", "#8c8c93", []],
].map(([id, label, color, keywords]) => ({ id, label, color, keywords }));

const stopWords = new Set(`a an and are as at be been by can for from has have in into is it its of on or that the their this to with your you plugin plugins omarchy community bar widget widgets shows show lets using use`.split(" "));

function normalizedText(plugin) {
  return ` ${[plugin.name, plugin.id, plugin.category, plugin.description, ...(plugin.tags || [])].filter(Boolean).join(" ").toLowerCase()} `;
}

function tokens(plugin) {
  return normalizedText(plugin)
    .replaceAll(/[^a-z0-9+#.-]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/^[.-]+|[.-]+$/g, ""))
    .filter((word) => word.length > 2 && !stopWords.has(word));
}

function assignCluster(plugin) {
  const sourceTags = plugin.tags || [];
  if (matchesKidsTaxonomy(plugin)) return "kids";
  const normalizedTags = sourceTags.map((tag) => String(tag).toLowerCase());
  const text = normalizedText(plugin);
  const name = ` ${plugin.name.toLowerCase()} `;
  const tags = ` ${normalizedTags.join(" ")} `;
  let best = clusterDefinitions.at(-1);
  let bestScore = 0;
  for (const cluster of clusterDefinitions.slice(0, -1)) {
    let score = 0;
    for (const keyword of cluster.keywords) {
      if (text.includes(keyword)) score += 1;
      if (name.includes(keyword)) score += 2.5;
      if (tags.includes(keyword)) score += 2;
    }
    if (score > bestScore) {
      bestScore = score;
      best = cluster;
    }
  }
  return best.id;
}

const documents = plugins.map(tokens);
const documentFrequency = new Map();
for (const document of documents) {
  for (const token of new Set(document)) documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
}

const vectors = documents.map((document) => {
  const counts = new Map();
  for (const token of document) counts.set(token, (counts.get(token) || 0) + 1);
  const vector = new Map();
  let norm = 0;
  for (const [token, count] of counts) {
    const weight = (1 + Math.log(count)) * Math.log((plugins.length + 1) / ((documentFrequency.get(token) || 0) + 1));
    vector.set(token, weight);
    norm += weight * weight;
  }
  norm = Math.sqrt(norm) || 1;
  for (const [token, weight] of vector) vector.set(token, weight / norm);
  return vector;
});

function cosine(first, second) {
  const [small, large] = first.size < second.size ? [first, second] : [second, first];
  let score = 0;
  for (const [token, weight] of small) score += weight * (large.get(token) || 0);
  return score;
}

const clusterMembers = new Map(clusterDefinitions.map((cluster) => [cluster.id, []]));
const assigned = plugins.map((plugin, index) => {
  const cluster = assignCluster(plugin);
  clusterMembers.get(cluster).push(index);
  return cluster;
});

const nearest = plugins.map(() => []);
function remember(index, candidate, similarity) {
  const list = nearest[index];
  list.push({ index: candidate, similarity });
  list.sort((first, second) => second.similarity - first.similarity);
  if (list.length > 4) list.length = 4;
}

for (let first = 0; first < plugins.length; first++) {
  for (let second = first + 1; second < plugins.length; second++) {
    const sameCluster = assigned[first] === assigned[second];
    const similarity = cosine(vectors[first], vectors[second]) + (sameCluster ? 0.035 : 0);
    if (similarity < 0.075) continue;
    remember(first, second, similarity);
    remember(second, first, similarity);
  }
}

const edgeKeys = new Set();
const edges = [];
nearest.forEach((neighbors, source) => {
  for (const neighbor of neighbors) {
    const first = Math.min(source, neighbor.index);
    const second = Math.max(source, neighbor.index);
    const key = `${first}:${second}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    edges.push({ source: first, target: second, similarity: Number(neighbor.similarity.toFixed(4)) });
  }
});

const weightedDegree = plugins.map(() => 0);
for (const edge of edges) {
  weightedDegree[edge.source] += edge.similarity;
  weightedDegree[edge.target] += edge.similarity;
}
const influence = plugins.map((plugin, index) => weightedDegree[index] * 4 + Math.log2((plugin.stars || 0) + 1) * 2.4);

const world = { width: 3400, height: 2300 };
const targetByCluster = {
  ai: [1120, 840], games: [760, 1280], kids: [700, 650], network: [1260, 1710], media: [2220, 770],
  productivity: [1750, 650], system: [1740, 1210], hardware: [2260, 1430], files: [1950, 1700],
  communication: [2260, 490], appearance: [2600, 1090], developer: [1160, 1390], home: [2580, 1660],
  security: [1570, 1840], navigation: [1370, 1030], other: [1760, 880],
};
const positions = plugins.map(() => ({ x: 0, y: 0, vx: 0, vy: 0 }));

for (const definition of clusterDefinitions) {
  const members = clusterMembers.get(definition.id).sort((first, second) => influence[second] - influence[first]);
  const [targetX, targetY] = targetByCluster[definition.id];
  members.forEach((pluginIndex, localIndex) => {
    const seed = [...plugins[pluginIndex].id].reduce((sum, character) => (sum * 31 + character.charCodeAt(0)) >>> 0, 7);
    const theta = localIndex * 2.399963 + (seed % 100) / 100;
    const radius = 17 * Math.sqrt(localIndex) + (seed % 13);
    positions[pluginIndex].x = targetX + Math.cos(theta) * radius;
    positions[pluginIndex].y = targetY + Math.sin(theta) * radius;
  });
}

for (let iteration = 0; iteration < 260; iteration++) {
  const cooling = 1 - iteration / 260;
  for (const edge of edges) {
    const source = positions[edge.source];
    const target = positions[edge.target];
    const deltaX = target.x - source.x;
    const deltaY = target.y - source.y;
    const distance = Math.hypot(deltaX, deltaY) || 1;
    const desired = 56 + (1 - edge.similarity) * 90;
    const force = (distance - desired) * (.004 + edge.similarity * .006);
    source.vx += deltaX / distance * force;
    source.vy += deltaY / distance * force;
    target.vx -= deltaX / distance * force;
    target.vy -= deltaY / distance * force;
  }

  const cellSize = 68;
  const grid = new Map();
  positions.forEach((position, index) => {
    const key = `${Math.floor(position.x / cellSize)}:${Math.floor(position.y / cellSize)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(index);
  });
  positions.forEach((position, index) => {
    const cellX = Math.floor(position.x / cellSize);
    const cellY = Math.floor(position.y / cellSize);
    for (let offsetX = -1; offsetX <= 1; offsetX++) for (let offsetY = -1; offsetY <= 1; offsetY++) {
      for (const otherIndex of grid.get(`${cellX + offsetX}:${cellY + offsetY}`) || []) {
        if (otherIndex <= index) continue;
        const other = positions[otherIndex];
        let deltaX = other.x - position.x;
        let deltaY = other.y - position.y;
        let distance = Math.hypot(deltaX, deltaY);
        if (!distance) { deltaX = .5; deltaY = .5; distance = Math.SQRT1_2; }
        if (distance >= 54) continue;
        const force = (54 - distance) * .055;
        position.vx -= deltaX / distance * force;
        position.vy -= deltaY / distance * force;
        other.vx += deltaX / distance * force;
        other.vy += deltaY / distance * force;
      }
    }
  });

  positions.forEach((position, index) => {
    const [targetX, targetY] = targetByCluster[assigned[index]];
    const clusterForce = .0012 + cooling * .0018;
    position.vx += (targetX - position.x) * clusterForce;
    position.vy += (targetY - position.y) * clusterForce;
    position.vx *= .82;
    position.vy *= .82;
    position.x += position.vx;
    position.y += position.vy;
  });
}

const bounds = positions.reduce((result, position) => ({
  minX: Math.min(result.minX, position.x), maxX: Math.max(result.maxX, position.x),
  minY: Math.min(result.minY, position.y), maxY: Math.max(result.maxY, position.y),
}), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
const layoutScale = Math.min((world.width - 300) / (bounds.maxX - bounds.minX), (world.height - 300) / (bounds.maxY - bounds.minY));
positions.forEach((position) => {
  position.x = 150 + (position.x - bounds.minX) * layoutScale;
  position.y = 150 + (position.y - bounds.minY) * layoutScale;
});

const clusters = clusterDefinitions.map((definition) => {
  const members = clusterMembers.get(definition.id);
  const center = members.reduce((sum, index) => ({ x: sum.x + positions[index].x, y: sum.y + positions[index].y }), { x: 0, y: 0 });
  center.x /= members.length || 1;
  center.y /= members.length || 1;
  return { id: definition.id, label: definition.label, color: definition.color, count: members.length, center };
}).filter((cluster) => cluster.count > 0);

const nodes = plugins.map((plugin, index) => ({
  index,
  id: plugin.id,
  name: plugin.name,
  author: plugin.author,
  description: plugin.description,
  category: plugin.category,
  kind: plugin.kind,
  repo: plugin.repo,
  accent: plugin.accent,
  initials: plugin.initials,
  previewThumbnail: plugin.previewThumbnail,
  previewThumbnailWidth: plugin.previewThumbnailWidth,
  previewThumbnailHeight: plugin.previewThumbnailHeight,
  tags: plugin.tags || [],
  stars: plugin.stars || 0,
  listedAt: plugin.listedAt || plugin.addedAt,
  cluster: assigned[index],
  influence: Number(influence[index].toFixed(3)),
  x: Number(positions[index].x.toFixed(2)),
  y: Number(positions[index].y.toFixed(2)),
  neighbors: nearest[index].map(({ index: neighbor, similarity }) => ({ index: neighbor, similarity: Number(similarity.toFixed(3)) })),
}));

function utcDay(value) {
  return new Date(`${String(value).slice(0, 10)}T00:00:00.000Z`);
}

function communityCount(snapshot) {
  return snapshot.plugins.filter((plugin) => !plugin.builtIn && (plugin.sourceType || "community") === "community").length;
}

function dailySeries(snapshots) {
  const totals = new Map(snapshots.map(({ date, total }) => [date, total]));
  const dates = [...totals.keys()].sort();
  const firstDay = utcDay(dates[0]);
  const lastDay = utcDay(dates.at(-1));
  const growth = [];
  let total = totals.get(dates[0]);
  let previous = total;
  for (let day = new Date(firstDay); day <= lastDay; day.setUTCDate(day.getUTCDate() + 1)) {
    const date = day.toISOString().slice(0, 10);
    if (totals.has(date)) total = totals.get(date);
    growth.push({ date, total, added: growth.length ? total - previous : total });
    previous = total;
  }
  return growth;
}

function historicalCatalogGrowth() {
  const log = execFileSync(
    "git",
    ["log", "--reverse", "--format=%H%x09%cI", "--", "site/catalog.json"],
    { cwd: projectRoot, encoding: "utf8" },
  ).trim();
  if (!log) throw new Error("Catalog history is unavailable");

  const latestCommitByDay = new Map();
  const commits = log.split("\n").map((line) => {
    const [commit, timestamp] = line.split("\t");
    return { commit, timestamp, date: new Date(timestamp).toISOString().slice(0, 10) };
  }).sort((first, second) => Date.parse(first.timestamp) - Date.parse(second.timestamp));
  for (const entry of commits) latestCommitByDay.set(entry.date, entry);

  // generatedAt is the logical horizon, even on standalone/no-op rebuilds.
  // A cross-midnight commit must not create a day beyond that catalog's day.
  // Later snapshots become eligible when a later-day catalog is supplied.
  const currentDate = String(catalog.generatedAt).slice(0, 10);
  const snapshots = [...latestCommitByDay.values()]
    .filter(({ date }) => date <= currentDate)
    .map(({ commit, date }) => {
      const snapshot = JSON.parse(execFileSync("git", ["show", `${commit}:site/catalog.json`], {
        cwd: projectRoot,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      }));
      return { date, total: communityCount(snapshot) };
    });
  const current = { date: currentDate, total: communityCount(catalog) };
  const currentIndex = snapshots.findIndex((snapshot) => snapshot.date === currentDate);
  if (currentIndex >= 0) snapshots[currentIndex] = current;
  else snapshots.push(current);

  return {
    growth: dailySeries(snapshots),
    meta: {
      method: "git-catalog-snapshots",
      label: "End-of-day Git catalog snapshots",
      detail: "Earlier UTC days use the final committed catalog state. The latest UTC day is provisional until a successful later-day build finalizes it.",
      timezone: "UTC",
      historical: true,
    },
  };
}

const growthResult = historicalCatalogGrowth();
const committedExplorer = readCommittedExplorerData(projectRoot);
assertGrowthContinuity(committedExplorer, growthResult.growth, catalog.generatedAt);

const output = {
  generatedAt: catalog.generatedAt,
  method: "Local TF-IDF similarity",
  scope: "community",
  release: { date: "2026-08-14", label: "Omarchy Quattro v4.0.0 release" },
  world,
  clusters,
  nodes,
  edges,
  growth: growthResult.growth,
  growthMeta: growthResult.meta,
};

fs.writeFileSync(outputUrl, JSON.stringify(output));
console.log(JSON.stringify({
  plugins: nodes.length,
  edges: edges.length,
  clusters: clusters.length,
  growthDays: growthResult.growth.length,
  growthMethod: growthResult.meta.method,
}, null, 2));
