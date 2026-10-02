export const themeStorageKey = "omarchy-theme";
export const defaultThemeId = "dark";

export const siteThemes = Object.freeze([
  { id: "dark", name: "Marketplace Dark", light: false, bg: "#000000", accent: "#ff5a36", builtin: true },
  { id: "light", name: "Marketplace Light", light: true, bg: "#f8f8f6", accent: "#c6371c", builtin: true },
  { id: "tokyo-night", name: "Tokyo Night", light: false, bg: "#1a1b26", accent: "#9ece6a" },
  { id: "white", name: "White", light: true, bg: "#ffffff", accent: "#6e6e6e" },
  { id: "catppuccin", name: "Catppuccin", light: false, bg: "#1e1e2e", accent: "#89b4fa" },
  { id: "gruvbox", name: "Gruvbox", light: false, bg: "#282828", accent: "#7daea3" },
  { id: "matte-black", name: "Matte Black", light: false, bg: "#121212", accent: "#e68e0d" },
  { id: "rose-pine", name: "Rosé Pine", light: true, bg: "#faf4ed", accent: "#467881" },
  { id: "catppuccin-latte", name: "Catppuccin Latte", light: true, bg: "#eff1f5", accent: "#1d61e9" },
  { id: "ethereal", name: "Ethereal", light: false, bg: "#060b1e", accent: "#7d82d9" },
  { id: "everforest", name: "Everforest", light: false, bg: "#2d353b", accent: "#7fbbb3" },
  { id: "flexoki-light", name: "Flexoki Light", light: true, bg: "#fffcf0", accent: "#205ea6" },
  { id: "hackerman", name: "Hackerman", light: false, bg: "#0b0c16", accent: "#82fb9c" },
  { id: "kanagawa", name: "Kanagawa", light: false, bg: "#1f1f28", accent: "#dcd7ba" },
  { id: "last-horizon", name: "Last Horizon", light: false, bg: "#0c0b0c", accent: "#b59790" },
  { id: "lumon", name: "Lumon", light: false, bg: "#16242d", accent: "#8bc9eb" },
  { id: "lupine", name: "Lupine", light: true, bg: "#fafafa", accent: "#3264eb" },
  { id: "miasma", name: "Miasma", light: false, bg: "#222222", accent: "#8a9262" },
  { id: "nord", name: "Nord", light: false, bg: "#2e3440", accent: "#8aa8c5" },
  { id: "osaka-jade", name: "Osaka Jade", light: false, bg: "#111c18", accent: "#5c9b7f" },
  { id: "retro-82", name: "Retro 82", light: false, bg: "#05182e", accent: "#faa968" },
  { id: "ristretto", name: "Ristretto", light: false, bg: "#2c2525", accent: "#f38d70" },
  { id: "solitude", name: "Solitude", light: false, bg: "#101315", accent: "#798186" },
  { id: "vantablack", name: "Vantablack", light: false, bg: "#000000", accent: "#8d8d8d" },
]);

const themeIds = new Set(siteThemes.map((theme) => theme.id));

export function isThemeId(value) {
  return typeof value === "string" && themeIds.has(value);
}

export function themeById(id) {
  return siteThemes.find((theme) => theme.id === id) || siteThemes[0];
}

export function readStoredTheme(storage = globalThis.localStorage) {
  try {
    const stored = storage?.getItem(themeStorageKey);
    return isThemeId(stored) ? stored : defaultThemeId;
  } catch {
    return defaultThemeId;
  }
}

export function themePreviewPath(theme) {
  return theme.builtin ? "" : `assets/img/themes/${theme.id}.webp`;
}

export function applyTheme(id, {
  persist = true,
  root = document.documentElement,
  storage = globalThis.localStorage,
} = {}) {
  const theme = themeById(isThemeId(id) ? id : defaultThemeId);
  root.dataset.theme = theme.id;
  if (persist) {
    try {
      storage?.setItem(themeStorageKey, theme.id);
    } catch {
      /* storage unavailable */
    }
  }
  const themeColor = root.ownerDocument?.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.content = theme.bg;
  return theme;
}

export function pickerLayout(count, selected, viewWidth) {
  const expandedWidth = Math.min(230, Math.round(viewWidth * 0.22));
  const expandedHeight = Math.round(expandedWidth * 0.62);
  const sliceWidth = Math.max(26, Math.round(expandedWidth * 0.16));
  const sliceHeight = Math.round(expandedHeight * 0.91);
  const step = Math.round(sliceWidth * 0.72);
  const spacing = step - sliceWidth;
  const previewX = Math.round((viewWidth - expandedWidth) / 2);
  const sliceTop = Math.round((expandedHeight - sliceHeight) / 2);
  const items = [];
  for (let index = 0; index < count; index += 1) {
    const rel = index - selected;
    const isSelected = rel === 0;
    const left = isSelected
      ? previewX
      : rel < 0
        ? previewX + rel * step
        : previewX + expandedWidth + spacing + (rel - 1) * step;
    items.push({
      left,
      top: isSelected ? 0 : sliceTop,
      width: isSelected ? expandedWidth : sliceWidth,
      height: isSelected ? expandedHeight : sliceHeight,
      zIndex: isSelected ? 100 : 50 - Math.min(Math.abs(rel), 40),
      hidden: Math.abs(rel) > 20,
    });
  }
  return { height: expandedHeight, items };
}
