// Shared brand kit for CorePilot's animated README assets.
//
// Every feature script renders a sequence of SVG frames with @resvg/resvg-js,
// then stitches them into a high-quality GIF via ffmpeg's palettegen/paletteuse
// (a per-clip optimized palette → crisp gradients, small files, no banding).
//
// Palette mirrors src/index.css (OKLCH tokens) converted to sRGB hex so the
// README art matches the running app exactly:
//   accent violet · accent-bright · cyan · v-cache teal · freq amber · ok green.
import { Resvg } from "@resvg/resvg-js";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));

/** Brand palette (sRGB hex), matched to the app's OKLCH design tokens. */
export const C = {
  bg0: "#0E0B18",
  bg1: "#07060D",
  surface: "#16131F",
  surface2: "#1C1830",
  line: "#FFFFFF",
  ink: "#F3F1FA",
  muted: "#9AA0BD",
  dim: "#6B6F87",
  accent: "#7C5CFF",
  accentBright: "#A88BFF",
  cyan: "#5BC8E8",
  vcache: "#2FD6C6", // 3D V-Cache CCD identity (teal)
  vcacheHot: "#5EEAD4",
  freq: "#F0B23C", // frequency CCD / amber identity
  freqHot: "#FFD27A",
  ok: "#3FD98A",
  warn: "#F5C84B",
  danger: "#F0604E",
  white: "#FFFFFF",
};

export const FONT = "Segoe UI, Microsoft YaHei UI, sans-serif";
export const MONO = "Consolas, ui-monospace, monospace";

// ---- easing -----------------------------------------------------------------
export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
export const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
export const easeOut = (t) => 1 - Math.pow(1 - t, 3);
export const easeOutBack = (t) => {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
/** Smooth 0→1→0 pulse over a 0..1 loop param. */
export const pulse01 = (t) => 0.5 - 0.5 * Math.cos(t * Math.PI * 2);

// ---- shared SVG fragments ---------------------------------------------------

/** Reusable gradient/filter defs used across the brand art. Pass a unique `id`
 *  prefix per <svg> only if embedding more than one; default ids are fine for
 *  standalone documents. */
export function brandDefs(w, h) {
  return `
  <linearGradient id="bg" x1="0" y1="0" x2="${w}" y2="${h}" gradientUnits="userSpaceOnUse">
    <stop stop-color="${C.bg0}"/><stop offset="1" stop-color="${C.bg1}"/>
  </linearGradient>
  <linearGradient id="dieStroke" x1="298" y1="298" x2="726" y2="726" gradientUnits="userSpaceOnUse"><stop stop-color="${C.accentBright}"/><stop offset="1" stop-color="#5B3CE0"/></linearGradient>
  <linearGradient id="dieFill" x1="512" y1="298" x2="512" y2="726" gradientUnits="userSpaceOnUse"><stop stop-color="#1C1733"/><stop offset="1" stop-color="#100D1C"/></linearGradient>
  <linearGradient id="pin" x1="512" y1="244" x2="512" y2="324" gradientUnits="userSpaceOnUse"><stop stop-color="#9079FF"/><stop offset="1" stop-color="#4733B8"/></linearGradient>
  <linearGradient id="core" x1="512" y1="372" x2="512" y2="652" gradientUnits="userSpaceOnUse"><stop stop-color="${C.accentBright}"/><stop offset="0.5" stop-color="#5E8BF5"/><stop offset="1" stop-color="${C.vcache}"/></linearGradient>
  <radialGradient id="markHalo" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(512 512) scale(240)"><stop stop-color="#8B6CFF" stop-opacity="0.9"/><stop offset="1" stop-color="#8B6CFF" stop-opacity="0"/></radialGradient>
  <filter id="coreGlow" x="-70%" y="-70%" width="240%" height="240%"><feGaussianBlur stdDeviation="26" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  <filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="7"/></filter>
  <filter id="softer" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="16"/></filter>`;
}

/** The CorePilot chip mark (die + pins + glowing core + boost chevrons),
 *  centered at (cx,cy), scaled, with a 0..1 glow `pulse`. Requires brandDefs(). */
export function chipMark(cx, cy, scale, pulse = 1) {
  const glowO = (0.45 + 0.55 * pulse).toFixed(2);
  return `
  <g transform="translate(${cx} ${cy}) scale(${scale}) translate(-512 -512)">
    <circle cx="512" cy="512" r="240" fill="url(#markHalo)" opacity="${glowO}"/>
    <g fill="url(#pin)">
      <rect x="338" y="252" width="48" height="78" rx="16"/><rect x="488" y="252" width="48" height="78" rx="16"/><rect x="638" y="252" width="48" height="78" rx="16"/>
      <rect x="338" y="694" width="48" height="78" rx="16"/><rect x="488" y="694" width="48" height="78" rx="16"/><rect x="638" y="694" width="48" height="78" rx="16"/>
      <rect x="252" y="338" width="78" height="48" rx="16"/><rect x="252" y="488" width="78" height="48" rx="16"/><rect x="252" y="638" width="78" height="48" rx="16"/>
      <rect x="694" y="338" width="78" height="48" rx="16"/><rect x="694" y="488" width="78" height="48" rx="16"/><rect x="694" y="638" width="78" height="48" rx="16"/>
    </g>
    <rect x="298" y="298" width="428" height="428" rx="92" fill="url(#dieFill)" stroke="url(#dieStroke)" stroke-width="10"/>
    <g filter="url(#coreGlow)"><rect x="372" y="372" width="280" height="280" rx="68" fill="url(#core)"/></g>
    <g stroke-linecap="round" stroke-linejoin="round" fill="none">
      <path d="M438 556 L512 476 L586 556" stroke="#FFFFFF" stroke-width="38"/>
      <path d="M438 614 L512 534 L586 614" stroke="#FFFFFF" stroke-width="38" opacity="0.42"/>
    </g>
  </g>`;
}

/** A rounded "window card" chrome (title bar + three dots) to frame UI mockups. */
export function windowCard(x, y, w, h, title, accent = C.accent) {
  return `
  <g>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="18" fill="${C.surface}" stroke="${C.line}" stroke-opacity="0.10"/>
    <rect x="${x}" y="${y}" width="${w}" height="40" rx="18" fill="${C.surface2}"/>
    <rect x="${x}" y="${y + 26}" width="${w}" height="16" fill="${C.surface2}"/>
    <circle cx="${x + 22}" cy="${y + 20}" r="5.5" fill="${C.danger}"/><circle cx="${x + 40}" cy="${y + 20}" r="5.5" fill="${C.warn}"/><circle cx="${x + 58}" cy="${y + 20}" r="5.5" fill="${C.ok}"/>
    <circle cx="${x + 84}" cy="${y + 20}" r="4" fill="${accent}"/>
    <text x="${x + 96}" y="${y + 25}" font-family="${FONT}" font-size="14" font-weight="600" fill="${C.muted}">${title}</text>
  </g>`;
}

// ---- render + encode --------------------------------------------------------

/** Render `n` frames; `build(t, f)` returns an SVG string for loop param t∈[0,1).
 *  Frames go to <dir>/<name>_NNN.png at the given render width. Returns the
 *  frames dir + count for framesToGif. */
export function renderFrames({ name, n, width, build, dir }) {
  const framesDir = dir ?? join(HERE, "frames");
  mkdirSync(framesDir, { recursive: true });
  // Clear any stale frames for this name so ffmpeg's %03d glob is clean.
  for (const f of readdirSync(framesDir)) {
    if (f.startsWith(`${name}_`) && f.endsWith(".png")) rmSync(join(framesDir, f));
  }
  for (let f = 0; f < n; f++) {
    const t = f / n;
    const svg = build(t, f);
    const png = new Resvg(svg, {
      fitTo: { mode: "width", value: width },
      font: { loadSystemFonts: true },
      background: "rgba(0,0,0,0)",
    }).render().asPng();
    writeFileSync(join(framesDir, `${name}_${String(f).padStart(3, "0")}.png`), png);
  }
  return { framesDir, n, name };
}

/** Stitch rendered frames into a polished GIF using a per-clip optimized palette.
 *  fps controls playback speed; dither=sierra2_4a keeps gradients smooth. */
export function framesToGif({ framesDir, name }, outPath, { fps = 25, maxColors = 200 } = {}) {
  const pattern = join(framesDir, `${name}_%03d.png`);
  const palette = join(framesDir, `${name}_palette.png`);
  const run = (args, label) => {
    const r = spawnSync("ffmpeg", args, { encoding: "utf8" });
    if (r.status !== 0) {
      throw new Error(`ffmpeg ${label} failed (status ${r.status}):\n${r.stderr ?? r.error}`);
    }
  };
  run(
    ["-y", "-framerate", String(fps), "-i", pattern,
     "-vf", `palettegen=max_colors=${maxColors}:stats_mode=diff`, palette],
    "palettegen",
  );
  run(
    ["-y", "-framerate", String(fps), "-i", pattern, "-i", palette,
     "-lavfi", "paletteuse=dither=sierra2_4a:diff_mode=rectangle", "-loop", "0", outPath],
    "paletteuse",
  );
  rmSync(palette, { force: true });
}

/** Render a single still SVG to a PNG (for poster frames / static fallbacks). */
export function renderPng(svg, outPath, width) {
  const png = new Resvg(svg, {
    fitTo: { mode: "width", value: width },
    font: { loadSystemFonts: true },
    background: "rgba(0,0,0,0)",
  }).render().asPng();
  writeFileSync(outPath, png);
}

/** Convenience: render frames, encode the GIF, and emit a poster PNG from the
 *  midpoint frame. Logs sizes. */
export function makeClip({ name, n, width, build, fps, maxColors, gifOut, posterOut, posterT = 0.5 }) {
  const frames = renderFrames({ name, n, width, build });
  framesToGif(frames, gifOut, { fps, maxColors });
  if (posterOut) renderPng(build(posterT, Math.round(posterT * n)), posterOut, width);
  return frames;
}
