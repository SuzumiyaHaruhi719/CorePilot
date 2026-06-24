import type { TreeNode } from "../../../lib/ipc";
import { DISK_FLAG } from "../../../lib/ipc";

/**
 * Treemap rect colors, read from the live `@theme` tokens in `index.css` via
 * `getComputedStyle` (spec §3.5) so the treemap auto-retints across
 * graphite/cyberpunk/midnight/light for free. The canvas can't resolve
 * `var(--…)`, so we resolve the tokens to literal color strings once per layout
 * (cheap) and cache them in a `Palette`. Re-read on a theme/theme-style change
 * (the renderer rebuilds the palette when `data-theme` / `data-theme-style`
 * flips — same contract as `colors.ts`/`TimeSeriesChart`).
 *
 * Default mode = "by depth" (owner decision §7 / spec §3.5): an OKLCH lightness
 * ramp off `--color-accent` — SpaceSniffer's nested-shade look, cheapest and most
 * theme-portable. "by type" maps extension classes to existing signal hues.
 *
 * See docs/superpowers/specs/2026-06-23-disk-space-analyzer-design.md §3.5.
 */

export type ColorMode = "cushion" | "depth" | "type";

export interface Palette {
  /** Resolved literal colors (no `var()`), keyed by the token role. */
  accent: string;
  cyan: string;
  vcache: string;
  freq: string;
  surface2: string;
  surface3: string;
  dim: string;
  line: string;
  ink: string;
  muted: string;
  /** Accent OKLCH components for the depth ramp (parsed from `accent`). */
  accentL: number;
  accentC: number;
  accentH: number;
  /** True in light mode (flips the depth ramp direction for contrast). */
  light: boolean;
}

const TOKENS = [
  "--color-accent",
  "--color-cyan",
  "--color-vcache",
  "--color-freq",
  "--color-surface2",
  "--color-surface3",
  "--color-dim",
  "--color-line",
  "--color-ink",
  "--color-muted",
] as const;

function readVar(cs: CSSStyleDeclaration, name: string, fallback: string): string {
  const v = cs.getPropertyValue(name).trim();
  return v || fallback;
}

/** Parse `oklch(L% C H[ / a])` → [L(0-100), C, H]; tolerant fallback on miss. */
function parseOklch(s: string): [number, number, number] {
  const m = s.match(/oklch\(\s*([\d.]+)%?\s+([\d.]+)\s+([\d.]+)/i);
  if (!m) return [50, 0.1, 285];
  return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])];
}

/** Build a palette from the live theme tokens on :root. Call once per layout. */
export function readPalette(): Palette {
  const cs =
    typeof document !== "undefined"
      ? getComputedStyle(document.documentElement)
      : ({ getPropertyValue: () => "" } as unknown as CSSStyleDeclaration);
  const get = (name: (typeof TOKENS)[number], fb: string) => readVar(cs, name, fb);
  const accent = get("--color-accent", "oklch(62% 0.225 293)");
  const [aL, aC, aH] = parseOklch(accent);
  const light =
    typeof document !== "undefined" && document.documentElement.dataset.theme === "light";
  return {
    accent,
    cyan: get("--color-cyan", "oklch(80% 0.13 218)"),
    vcache: get("--color-vcache", "oklch(82% 0.13 184)"),
    freq: get("--color-freq", "oklch(81% 0.14 70)"),
    surface2: get("--color-surface2", "oklch(23% 0.042 288)"),
    surface3: get("--color-surface3", "oklch(29% 0.05 289)"),
    dim: get("--color-dim", "oklch(55% 0.03 285)"),
    line: get("--color-line", "oklch(100% 0 0 / 0.08)"),
    ink: get("--color-ink", "oklch(96% 0.008 285)"),
    muted: get("--color-muted", "oklch(72% 0.025 285)"),
    accentL: aL,
    accentC: aC,
    accentH: aH,
    light,
  };
}

/** Extension → signal-hue class (spec §3.5 "by type"). Lowercased, no dot. */
function extClass(name: string): "code" | "image" | "video" | "exec" | "other" {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (CODE.has(ext)) return "code";
  if (IMAGE.has(ext)) return "image";
  if (VIDEO.has(ext)) return "video";
  if (EXEC.has(ext)) return "exec";
  return "other";
}

const CODE = new Set([
  "js", "ts", "tsx", "jsx", "rs", "c", "h", "cpp", "hpp", "cs", "go", "py", "java",
  "json", "toml", "yaml", "yml", "xml", "html", "css", "md", "txt", "log", "csv",
]);
const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "tiff", "heic"]);
const VIDEO = new Set([
  "mp4", "mkv", "mov", "avi", "webm", "flv", "wmv",
  "zip", "rar", "7z", "tar", "gz", "iso", "cab",
]);
const EXEC = new Set(["exe", "dll", "sys", "msi", "bin", "so", "dylib", "bat", "cmd", "ps1"]);

/** Replace/append the alpha of an `oklch(L C H[ / a])` string. */
function withAlpha(oklch: string, alpha: number): string {
  const open = oklch.indexOf("(");
  const close = oklch.lastIndexOf(")");
  if (open < 0 || close < 0) return oklch;
  let inner = oklch.slice(open + 1, close).trim();
  const slash = inner.indexOf("/");
  if (slash >= 0) inner = inner.slice(0, slash).trim();
  return `oklch(${inner} / ${alpha})`;
}

/** Flat hues (OKLCH H) for the modern per-region treemap coloring — 16 roughly
 *  evenly-spaced (~22°) around the wheel so neighbouring top-level regions get
 *  visibly distinct colors. Each top-level disk region (C:\Users, C:\Windows, …)
 *  hashes to one, so a whole subtree reads as one color block. Was 10 hues, which
 *  on a typical C: collided 3-way (Users/WeGameApps/hiberfil → same teal, etc.);
 *  16 spreads the ~16-25 real top-level dirs across far more distinct colors. */
const FLAT_HUES = [
  12, 35, 58, 80, 102, 125, 148, 170, 192, 215, 238, 260, 282, 305, 328, 350,
];

/** First path component below the drive root: "C:\\Users\\Thomas\\x" → "users".
 *  Empty for the root itself. Drives the per-region hue so siblings of a region
 *  share its color. */
function topRegion(path: string): string {
  const parts = path.replace(/\//g, "\\").split("\\").filter(Boolean);
  return parts.length >= 2 ? parts[1].toLowerCase() : "";
}

/** Stable 32-bit FNV-1a hash → picks a palette hue per region name. */
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Fill color for one rect. `depth` is the nesting depth (0..n); `node` is the
 * backing TreeNode (null for a synthetic bucket tile → muted neutral).
 *
 * - default (modern flat): per top-level region hue; files bright, folders muted.
 * - "cushion"/"type": alternative schemes (also flat-rendered — no bevel).
 */
export function rectColor(
  p: Palette,
  mode: ColorMode,
  depth: number,
  node: TreeNode | null,
): string {
  if (node == null) {
    // Synthetic "… N more" bucket — muted neutral so it recedes.
    return withAlpha(p.surface3, 0.55);
  }
  const isDir = (node.flags & DISK_FLAG.isDir) !== 0;

  if (mode === "cushion") {
    // SpaceSniffer look: warm tan/neutral folder frames, blue file fills (spec §3.2).
    // Folders derive from the amber `--color-freq` token at LOW chroma so they read
    // as a warm neutral frame (not a saturated band) and deepen in L as they nest —
    // the frame recedes behind the content. Files take the cyan/blue token.
    const [fL, , fH] = parseOklch(p.freq); // amber/tan hue (~70)
    if (isDir) {
      const step = Math.min(depth, 6);
      // Warm tan cushions, L receding deeper so the bevel reads as nesting depth.
      // The dark theme used to clamp this to L≈22–37% at C=0.03 → near-black,
      // muddy gray-brown frames that looked nothing like SpaceSniffer. Brighter
      // base + a touch more chroma + a wider per-depth step makes them read as
      // SpaceSniffer's warm tan with clear level-to-level contrast.
      const L = p.light
        ? Math.max(74, fL - step * 3)
        : Math.max(30, 54 - step * 4);
      const C = 0.05;
      return `oklch(${L}% ${C} ${fH} / 0.66)`;
    }
    if ((node.flags & DISK_FLAG.aggregated) !== 0) return withAlpha(p.surface3, 0.6);
    // Files: a WARM tan tile (same hue family as the folders), a touch brighter +
    // more saturated than the receding folder frame so leaves pop out of their
    // container. SpaceSniffer keeps the whole disk in one warm family — the bevel
    // + folder header labels carry folder/file, NOT hue — so a blue file fill (the
    // old behavior) made the treemap read blue-dominated instead of tan.
    const L = p.light ? 80 : 60;
    return `oklch(${L}% 0.072 ${fH} / 0.92)`;
  }

  if (mode === "type") {
    if (isDir) {
      // Folder frames: neutral surface, slightly deeper as they nest.
      return depth % 2 === 0 ? p.surface2 : p.surface3;
    }
    if ((node.flags & DISK_FLAG.aggregated) !== 0) return withAlpha(p.surface3, 0.6);
    switch (extClass(node.name)) {
      case "code":
        return withAlpha(p.accent, 0.78);
      case "image":
        return withAlpha(p.cyan, 0.78);
      case "video":
        return withAlpha(p.vcache, 0.78);
      case "exec":
        return withAlpha(p.freq, 0.8);
      default:
        return withAlpha(p.dim, 0.7);
    }
  }

  // DEFAULT — modern flat. Each top-level region gets a distinct hue from the
  // curated palette (stable, derived from the path), so Users / Windows / Program
  // Files etc. read as separate color blocks. Within a region: folders are a
  // muted/darker frame, files a brighter saturated tile, lightness stepping a
  // little per nesting level so depth still reads. Flat fills — the hairline
  // separator (see `separator`) divides tiles, no skeuomorphic bevel.
  if ((node.flags & DISK_FLAG.aggregated) !== 0) return withAlpha(p.surface3, 0.6);
  const region = node.path ? topRegion(node.path) : "";
  const hue = region ? FLAT_HUES[hashStr(region) % FLAT_HUES.length] : p.accentH;
  const step = Math.min(depth, 6);
  if (isDir) {
    const L = p.light ? Math.max(68, 78 - step * 3) : 38 + step * 3;
    return `oklch(${L}% 0.055 ${hue} / 0.85)`;
  }
  const L = p.light ? Math.max(52, 70 - step * 2) : Math.min(82, 60 + step * 3);
  return `oklch(${L}% 0.115 ${hue} / 0.95)`;
}

/** Stroke (border) color for a rect at a given depth. */
export function strokeColor(p: Palette): string {
  return p.line;
}

/** Text color for labels drawn on rects. */
export function labelColor(p: Palette, onContainer: boolean): string {
  return onContainer ? p.muted : p.ink;
}

/**
 * Flat hairline that divides adjacent tiles (replaces the skeuomorphic 3D bevel).
 * A single subtle 1px stroke — modern flat, DPR-stable, no per-pixel gradient
 * (no GPU-budget churn — MEMORY: box-shadow DPC storm). The gap reads as crisp
 * tile separation against the colored fills.
 */
export function separator(p: Palette): string {
  return p.light ? "oklch(0% 0 0 / 0.14)" : "oklch(0% 0 0 / 0.42)";
}

/** Header/title-bar fill for a top-level container — a faint band darker than the
 *  frame fill so it reads as a header strip (spec §3.2). */
export function titleBarColor(p: Palette): string {
  return p.light ? "oklch(0% 0 0 / 0.07)" : "oklch(0% 0 0 / 0.22)";
}
