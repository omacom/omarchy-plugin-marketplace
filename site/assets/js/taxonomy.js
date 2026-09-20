const vpnPluginIds = new Set([
  "antesmd.amneziawg",
  "io.github.feilian",
  "jwhall.omanodes",
]);

const vpnIdentityTerms = new Set([
  "airvpn",
  "eduvpn",
  "expressvpn",
  "fortivpn",
  "ivpn",
  "mullvad",
  "multivpn",
  "netbird",
  "nordvpn",
  "nymvpn",
  "openvpn",
  "protonvpn",
  "surfshark",
  "tailscale",
  "twingate",
  "vpn",
  "windscribe",
  "wireguard",
  "zerotier",
]);

const securityScopedVpnIdentityTerms = new Set(["warp"]);
const vpnDescriptionTerms = new Set(["vpn", "wireguard"]);
const vpnActionTerms = new Set([
  "connect",
  "connection",
  "connections",
  "control",
  "controls",
  "disconnect",
  "launcher",
  "manager",
  "status",
  "switch",
  "switching",
  "toggle",
  "toggles",
  "tunnel",
  "tunnels",
]);

const barPluginKinds = new Set(["bar"]);
const barCategories = new Set(["Bar", "Bars"]);
const barIdentityTerms = new Set(["bar", "menubar", "statusbar", "topbar", "waybar"]);
const barHostKinds = new Set(["service"]);
const barHostCategories = new Set(["Appearance"]);
const barExcludedCategories = new Set(["Hardware"]);

function taxonomyTerms(value) {
  if (typeof value !== "string") return [];
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

export function matchesKidsTaxonomy(plugin) {
  const tags = Array.isArray(plugin?.tags) ? plugin.tags : [];
  return plugin?.category === "Kids" || tags.includes("kids") || tags.includes("education");
}

export function matchesVpnTaxonomy(plugin) {
  if (plugin?.category === "VPN") return true;
  const pluginId = typeof plugin?.id === "string" ? plugin.id.toLowerCase() : "";
  if (vpnPluginIds.has(pluginId)) return true;
  const localPluginId = pluginId.split(".").at(-1);
  const identityTerms = [localPluginId, plugin?.name]
    .filter(Boolean)
    .flatMap(taxonomyTerms);
  if (identityTerms.some((term) => vpnIdentityTerms.has(term))) return true;

  const tags = Array.isArray(plugin?.tags) ? plugin.tags : [];
  if (tags.includes("vpn")) return true;
  if (!tags.includes("security")) return false;
  if (identityTerms.some((term) => securityScopedVpnIdentityTerms.has(term))) return true;
  const descriptionTerms = taxonomyTerms(plugin?.description);
  return descriptionTerms.some((term) => vpnDescriptionTerms.has(term))
    && descriptionTerms.some((term) => vpnActionTerms.has(term));
}

export function matchesBarTaxonomy(plugin) {
  if (!plugin || typeof plugin !== "object") return false;
  if (barCategories.has(plugin.category)) return true;
  if (barPluginKinds.has(taxonomyTerms(plugin.kind).join("-"))) return true;
  if (barExcludedCategories.has(plugin.category)) return false;
  const pluginId = typeof plugin.id === "string" ? plugin.id.toLowerCase() : "";
  const localPluginId = pluginId.split(".").at(-1);
  const identityTerms = [localPluginId, plugin.name].filter(Boolean).flatMap(taxonomyTerms);
  if (!identityTerms.some((term) => barIdentityTerms.has(term))) return false;
  return barHostKinds.has(taxonomyTerms(plugin.kind).join("-"))
    || barHostCategories.has(plugin.category);
}

export function catalogCategoryTotals(plugins) {
  const totals = new Map();
  plugins.forEach((plugin) => totals.set(plugin.category, (totals.get(plugin.category) || 0) + 1));
  for (const [category, matches] of [
    ["Kids", matchesKidsTaxonomy],
    ["VPN", matchesVpnTaxonomy],
    ["Bar", matchesBarTaxonomy],
  ]) {
    const total = plugins.filter(matches).length;
    if (total) totals.set(category, total);
  }
  return totals;
}
