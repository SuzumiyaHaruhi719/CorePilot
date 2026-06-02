/**
 * Group color identity. Group dots/badges render as `oklch(74% 0.15 <hue>)`,
 * so a group's color is fully described by a single OKLCH hue (0–359). Keeping
 * lightness/chroma fixed gives every group a consistent, premium vibrancy while
 * the hue provides a distinct identity.
 */

/** The OKLCH lightness/chroma every group dot shares. */
export const GROUP_L = 74;
export const GROUP_C = 0.15;

/** CSS color for a group hue (matches the dots rendered across the app). */
export function groupColor(hue: number): string {
  return `oklch(${GROUP_L}% ${GROUP_C} ${hue})`;
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
