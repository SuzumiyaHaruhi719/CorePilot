// Feature art ① — Process Core Assignment (the flagship).
//
// A topology-aware core grid: CCD0 = 3D V-Cache (teal), CCD1 = frequency (amber).
// A "Game" process group sweeps in and binds its affinity to the V-Cache cores —
// those threads light up teal and lock; the rest dim. Mirrors the in-app
// core-grid selector + group affinity enforcement.
//   node feature-cores.mjs  →  branding/feature-cores.gif (+ .png poster)
import { join } from "node:path";
import { C, FONT, MONO, HERE, brandDefs, windowCard, lerp, clamp01, easeInOut, easeOutBack, makeClip } from "./lib.mjs";

const W = 960, H = 480, N = 64, RENDER_W = 960;

// 16 threads per CCD (8 cores x 2), laid out as a 2-row grid per CCD.
const COLS = 8, ROWS = 2;

function ccdGrid(ox, oy, accent, accentHot, label, sub, bound, t) {
  const cell = 46, gap = 10;
  let s = `<text x="${ox}" y="${oy - 16}" font-family="${MONO}" font-size="13" font-weight="700" fill="${accent}" letter-spacing="1">${label}</text>`;
  s += `<text x="${ox + 360}" y="${oy - 16}" text-anchor="end" font-family="${MONO}" font-size="12" fill="${C.dim}">${sub}</text>`;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const i = r * COLS + c;
      const x = ox + c * (cell + gap);
      const y = oy + r * (cell + gap);
      // Stagger the "bind" so threads light up left→right.
      const local = clamp01((t - i * 0.012) * 1.0);
      const on = bound ? easeInOut(local) : 0;
      const fill = bound
        ? `rgba(${accent === C.vcache ? "47,214,198" : "240,178,60"}, ${(0.14 + on * 0.7).toFixed(2)})`
        : "rgba(255,255,255,0.05)";
      const stroke = bound ? accentHot : "rgba(255,255,255,0.12)";
      const so = bound ? (0.3 + on * 0.6).toFixed(2) : "1";
      s += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="11" fill="${fill}" stroke="${stroke}" stroke-opacity="${so}" stroke-width="1.5"/>`;
      if (bound && on > 0.5) {
        s += `<rect x="${x - 3}" y="${y - 3}" width="${cell + 6}" height="${cell + 6}" rx="13" fill="none" stroke="${accentHot}" stroke-opacity="${((on - 0.5) * 0.7).toFixed(2)}" stroke-width="2" filter="url(#soft)"/>`;
        // tiny check / lock tick
        s += `<path d="M${x + 14} ${y + 24} l7 7 l12 -14" stroke="${accentHot}" stroke-width="3.2" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="${((on - 0.5) * 2).toFixed(2)}"/>`;
      }
      s += `<text x="${x + cell / 2}" y="${y + cell - 8}" text-anchor="middle" font-family="${MONO}" font-size="9" fill="${C.dim}" opacity="0.7">${String(i).padStart(2, "0")}</text>`;
    }
  }
  return s;
}

function build(t) {
  // Phases: 0..0.16 chip flies in, 0.16..0.7 bind sweep, hold, loop fade.
  const bindT = clamp01((t - 0.14) / 0.5);
  const chipIn = easeOutBack(clamp01(t / 0.18));
  const chipX = lerp(-120, 150, chipIn);
  const chipOp = clamp01(t / 0.12);

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    ${brandDefs(W, H)}
    <radialGradient id="halo" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(280 230) scale(520 360)"><stop stop-color="${C.accent}" stop-opacity="0.16"/><stop offset="1" stop-color="${C.accent}" stop-opacity="0"/></radialGradient>
    <radialGradient id="vign" cx="0.5" cy="0.5" r="0.78"><stop offset="0.62" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.4"/></radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#halo)"/>

  ${windowCard(40, 20, 880, 448, "进程核心分配 · Process Core Assignment", C.accent)}

  <!-- group chip flying to the grid -->
  <g transform="translate(${chipX} 96)" opacity="${chipOp.toFixed(2)}">
    <rect x="0" y="0" width="180" height="38" rx="10" fill="${C.surface2}" stroke="${C.vcache}" stroke-opacity="0.5"/>
    <circle cx="22" cy="19" r="7" fill="${C.vcache}"/>
    <text x="40" y="24" font-family="${FONT}" font-size="15" font-weight="700" fill="${C.ink}">游戏 · Game</text>
  </g>
  <text x="346" y="120" font-family="${MONO}" font-size="12" fill="${C.muted}">预设：仅 V-Cache CCD  →  ${bindT > 0.05 ? "应用亲和性…" : "选择核心"}</text>

  <!-- CCD0 = V-Cache (bound), CCD1 = frequency (idle) -->
  <g transform="translate(80 158)">
    ${ccdGrid(0, 28, C.vcache, C.vcacheHot, "CCD0 · 3D V-CACHE", "8C / 16T", true, bindT)}
  </g>
  <g transform="translate(80 296)">
    ${ccdGrid(0, 28, C.freq, C.freqHot, "CCD1 · 高频核心", "8C / 16T · 闲置", false, bindT)}
  </g>

  <!-- footer status -->
  <rect x="80" y="434" width="800" height="2" rx="1" fill="${C.line}" opacity="0.06"/>
  <circle cx="92" cy="450" r="4" fill="${bindT > 0.95 ? C.ok : C.warn}"/>
  <text x="104" y="455" font-family="${MONO}" font-size="12.5" fill="${C.muted}">${
    bindT > 0.95 ? "已绑定 16 线程 · 自动记忆此分组" : `绑定中  ${Math.round(bindT * 100)}%`
  }</text>
  <text x="880" y="455" text-anchor="end" font-family="${MONO}" font-size="12" fill="${C.dim}">自动检测 · AMD CCD / Intel P-E / 单簇</text>

  <rect width="${W}" height="${H}" fill="url(#vign)"/>
</svg>`;
}

makeClip({
  name: "feat_cores",
  n: N,
  width: RENDER_W,
  build,
  fps: 26,
  maxColors: 160,
  gifOut: join(HERE, "feature-cores.gif"),
  posterOut: join(HERE, "feature-cores.png"),
  posterT: 0.8,
});
console.log("feature-cores: wrote feature-cores.gif + .png");
