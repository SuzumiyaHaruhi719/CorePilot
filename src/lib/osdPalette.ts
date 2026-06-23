import type { ThemeStyle } from "../store/settings";
import type { OsdCategory } from "./osd";

/**
 * Single source of truth for OSD metric colors, per theme. The SAME values drive
 * both the React plate (CSS `color`) and the native injected in-game overlay
 * (packed `0xRRGGBBAA`), so the OSD reads identically whether it's the config
 * preview, the transparent overlay window, or the hudhook-injected frame overlay.
 *
 * Order is the category order fps, cpu, gpu, mem, disk, net. Each theme stays
 * inside its own identity band so the six categories are distinct yet on-theme.
 * Cyberpunk is deliberately bright YELLOW + electric CYAN/BLUE only — its iconic
 * Cyberpunk-2077 palette — and never drifts into green (the old hue-spread did).
 */
const OSD_PALETTE: Record<ThemeStyle, Record<OsdCategory, string>> = {
  // warm orange identity, with cool accents for the data-rate categories
  graphite: { fps: "#ff9e47", cpu: "#ff8259", gpu: "#f2b43c", mem: "#4ec9c4", disk: "#5aaee6", net: "#5fd08f" },
  // violet-blue identity
  midnight: { fps: "#a78bfa", cpu: "#818cf8", gpu: "#5b9bf0", mem: "#4cc6e0", disk: "#c77df0", net: "#5fd0b0" },
  // phosphor-green identity
  terminal: { fps: "#46e07a", cpu: "#8fe04a", gpu: "#36e0a0", mem: "#3fd9c0", disk: "#d7e04a", net: "#36d6e0" },
  // CP2077: yellow + electric cyan/blue ONLY (no green)
  cyberpunk: { fps: "#ffe600", cpu: "#ffc42e", gpu: "#18c5de", mem: "#11a9e8", disk: "#3b90f0", net: "#5e84f2" },
  // light-blue identity (plate is always dark, so bright variants read well)
  porcelain: { fps: "#5ab0f5", cpu: "#4fc4e6", gpu: "#7a9cf5", mem: "#54c8c0", disk: "#c78cee", net: "#5fcf92" },
  // terracotta / amber identity
  sandstone: { fps: "#f0a24e", cpu: "#f08259", gpu: "#e6b43c", mem: "#6cc78a", disk: "#5aaee6", net: "#f07aa8" },
};

/** Active theme style, read live from the DOM (set on <html> in both the main app
 *  and the OSD overlay window). Falls back to graphite for any unknown value. */
function currentThemeStyle(): ThemeStyle {
  const s = (typeof document !== "undefined" && document.documentElement.dataset.themeStyle) || "";
  return s in OSD_PALETTE ? (s as ThemeStyle) : "graphite";
}

/** Themed label color for an OSD metric category (reads the active theme). */
export function osdCategoryColor(cat: OsdCategory): string {
  return OSD_PALETTE[currentThemeStyle()][cat];
}

/** Themed accent (the theme's hero/fps color) for the plate border + edge glow. */
export function osdPlateAccent(themeStyle?: ThemeStyle): string {
  return OSD_PALETTE[themeStyle ?? currentThemeStyle()].fps;
}

/** Themed category color for an EXPLICIT theme (no DOM read) — used to push the
 *  per-category palette to the native taskbar monitor on theme change, where the
 *  caller already has the reactive `themeStyle` and DOM-read ordering is unsafe. */
export function osdCategoryColorFor(themeStyle: ThemeStyle, cat: OsdCategory): string {
  return (OSD_PALETTE[themeStyle] ?? OSD_PALETTE.graphite)[cat];
}

/** Pack `#rrggbb` into a `0xRRGGBBAA` u32 (fully opaque) for the native overlay. */
function hexToRgba(hex: string): number {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return ((r << 24) | (g << 16) | (b << 8) | 0xff) >>> 0;
}

/**
 * Native overlay row-color palette as packed `0xRRGGBBAA`, in the IPC row order
 * the injected DLL uses: [FPS, FRAMETIME, CPU, GPU, VRAM, RAM, DISK, NET].
 * FRAMETIME shares the fps color and VRAM shares the gpu color (matching how the
 * native `build_rows` groups them). Pushed to the backend writer on theme change.
 */
export function osdRowColorsRgba(themeStyle: ThemeStyle): number[] {
  const p = OSD_PALETTE[themeStyle] ?? OSD_PALETTE.graphite;
  const order: OsdCategory[] = ["fps", "fps", "cpu", "gpu", "gpu", "mem", "disk", "net"];
  return order.map((c) => hexToRgba(p[c]));
}
