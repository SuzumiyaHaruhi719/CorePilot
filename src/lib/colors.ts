/**
 * Group color identity. Group dots/badges render as `oklch(74% 0.15 <hue>)`,
 * so a group's color is fully described by a single OKLCH hue (0–359). Keeping
 * lightness/chroma fixed gives every group a consistent, premium vibrancy while
 * the hue provides a distinct identity.
 */

/** The OKLCH lightness/chroma every group dot shares. */
const GROUP_L = 74;
const GROUP_C = 0.15;

/** True when the app is in light mode (drives theme-aware telemetry colors). */
export function isLightTheme(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.theme === "light";
}

/**
 * OKLCH hue of the ACTIVE theme's accent (keyed off `data-theme-style` on
 * <html>). Lets "primary" telemetry (CPU %, GPU clock, VRAM, CPU temp, etc.)
 * track the theme accent instead of a fixed violet that clashes per theme.
 * Mirrors the accent hues in THEME_STYLES / index.css. Reads the DOM live, so
 * re-render to pick up a theme switch (same contract as hueColor).
 */
const STYLE_ACCENT_HUE: Record<string, number> = {
  graphite: 50, // warm orange
  cyberpunk: 101, // neon yellow
  midnight: 274, // violet-blue
  terminal: 144, // phosphor green
  porcelain: 235, // light blue
  sandstone: 48, // terracotta
};
export function accentHue(): number {
  const style = typeof document !== "undefined" ? document.documentElement.dataset.themeStyle : undefined;
  return (style ? STYLE_ACCENT_HUE[style] : undefined) ?? 50;
}

/**
 * Telemetry/identity color for a hue, tuned per theme. The dark HUD uses bright
 * (~80% L) neon hues; on a light background those wash out, so light mode drops
 * lightness and adds chroma for vivid, AA-legible lines, dots and fills. Used by
 * groups, charts, sparklines, gauges and report tiles so every hue recolors with
 * the theme. Reads `data-theme` live, so re-render to pick up a toggle.
 */
export function hueColor(hue: number, darkL = 80, darkC = 0.14): string {
  if (isLightTheme()) {
    return `oklch(48% ${Math.min(darkC + 0.05, 0.25)} ${hue})`;
  }
  return `oklch(${darkL}% ${darkC} ${hue})`;
}

/** CSS color for a group hue (matches the dots rendered across the app). */
export function groupColor(hue: number): string {
  return isLightTheme() ? `oklch(46% 0.19 ${hue})` : `oklch(${GROUP_L}% ${GROUP_C} ${hue})`;
}

/** Curated, visually distinct hues spread around the wheel (quick-pick swatches). */
export const GROUP_PALETTE = [12, 30, 55, 90, 140, 165, 188, 220, 255, 280, 312, 340];

/** Shortest distance between two hues on the 0–360 circle (0–180). */
export function hueDistance(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

/**
 * Pick a hue that's visually distinct from every hue in `used`. Prefers an
 * unused palette color; if all palette colors sit close to an existing group,
 * returns the hue (sampled around the wheel) that maximizes the minimum
 * distance to `used`. This keeps newly created groups from reusing a color.
 */
export function pickDistinctHue(used: number[]): number {
  if (used.length === 0) return GROUP_PALETTE[0];
  const free = GROUP_PALETTE.find((h) => used.every((u) => hueDistance(h, u) >= 18));
  if (free !== undefined) return free;

  let best = GROUP_PALETTE[0];
  let bestDist = -1;
  for (let h = 0; h < 360; h += 4) {
    const dist = Math.min(...used.map((u) => hueDistance(h, u)));
    if (dist > bestDist) {
      bestDist = dist;
      best = h;
    }
  }
  return best;
}
