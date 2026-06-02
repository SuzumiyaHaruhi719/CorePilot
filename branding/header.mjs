// CorePilot — animated hero header.
//
// A light-sweep races across the logical-thread grid (CCD0 teal 3D V-Cache /
// CCD1 amber-violet frequency cores), the chip mark's core pulses, and a soft
// halo breathes behind the wordmark. Renders frames → optimized GIF in one shot:
//   node header.mjs   →   branding/header.gif + branding/header.png
import { join } from "node:path";
import { C, FONT, MONO, HERE, brandDefs, chipMark, lerp, pulse01, makeClip } from "./lib.mjs";

const W = 1280, H = 420;
const N = 44, RENDER_W = 1000;

// Logical-thread bar: first half = V-Cache CCD (teal), second = frequency (amber).
function coreRow(sweep) {
  const n = 32, x0 = 360, x1 = 1200, yBase = 300, gap = 7;
  const cellW = (x1 - x0 - gap * (n - 1)) / n;
  let s = "";
  for (let i = 0; i < n; i++) {
    const x = x0 + i * (cellW + gap);
    const xn = i / (n - 1);
    let d = Math.abs(xn - sweep);
    d = Math.min(d, 1 - d);
    const lit = Math.max(0, 1 - d / 0.13);
    const vCache = i < 16;
    const base = vCache ? "#0f766e" : "#7a5a16";
    const hot = vCache ? C.vcacheHot : C.freqHot;
    const h = 18 + lit * 18;
    const y = yBase - lit * 9;
    const op = lerp(0.26, 1, lit);
    const col = lit > 0.45 ? hot : base;
    s += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${cellW.toFixed(1)}" height="${h.toFixed(1)}" rx="5" fill="${col}" opacity="${op.toFixed(2)}"/>`;
    if (lit > 0.4) {
      s += `<rect x="${(x - 4).toFixed(1)}" y="${(y - 4).toFixed(1)}" width="${(cellW + 8).toFixed(1)}" height="${(h + 8).toFixed(1)}" rx="7" fill="${hot}" opacity="${(lit * 0.3).toFixed(2)}" filter="url(#soft)"/>`;
    }
  }
  return s;
}

function build(t) {
  const pulse = pulse01(t);
  const sweep = t; // seamless wrapped sweep
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    ${brandDefs(W, H)}
    <radialGradient id="bgHalo" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(190 175) rotate(35) scale(560 360)">
      <stop stop-color="${C.accent}" stop-opacity="${(0.30 + 0.12 * pulse).toFixed(3)}"/><stop offset="1" stop-color="${C.accent}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="bgHalo2" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(1080 320) rotate(120) scale(420 300)">
      <stop stop-color="${C.vcache}" stop-opacity="${(0.12 + 0.07 * pulse).toFixed(3)}"/><stop offset="1" stop-color="${C.vcache}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="title" x1="360" y1="150" x2="900" y2="210" gradientUnits="userSpaceOnUse"><stop stop-color="#FFFFFF"/><stop offset="1" stop-color="#C9BCFF"/></linearGradient>
    <radialGradient id="vign" cx="0.5" cy="0.5" r="0.75"><stop offset="0.6" stop-color="#000000" stop-opacity="0"/><stop offset="1" stop-color="#000000" stop-opacity="0.45"/></radialGradient>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#bgHalo)"/>
  <rect width="${W}" height="${H}" fill="url(#bgHalo2)"/>
  <rect width="${W}" height="120" fill="#FFFFFF" opacity="0.02"/>

  ${chipMark(186, 196, 0.34, pulse)}

  <text x="360" y="158" font-family="${FONT}" font-size="92" font-weight="800" fill="url(#title)" letter-spacing="-1">CorePilot</text>
  <text x="364" y="212" font-family="${FONT}" font-size="28" font-weight="500" fill="${C.muted}">拓扑感知分核 · GPU 超频 · 任务管理器 · 游戏内 OSD</text>

  ${coreRow(sweep)}

  <text x="360" y="362" font-family="${MONO}" font-size="17" font-weight="600" fill="${C.vcache}" letter-spacing="1">CCD0 · 3D V-CACHE</text>
  <text x="760" y="362" text-anchor="middle" font-family="${MONO}" font-size="14" font-weight="500" fill="${C.dim}" letter-spacing="2">TOPOLOGY-AWARE  ·  AMD / INTEL  ·  UP TO 64T</text>
  <text x="1200" y="362" text-anchor="end" font-family="${MONO}" font-size="17" font-weight="600" fill="${C.freq}" letter-spacing="1">CCD1 · 高频核心</text>

  <rect width="${W}" height="${H}" fill="url(#vign)"/>
</svg>`;
}

makeClip({
  name: "header",
  n: N,
  width: RENDER_W,
  build,
  fps: 24,
  maxColors: 192,
  gifOut: join(HERE, "header.gif"),
  posterOut: join(HERE, "header.png"),
});
console.log("header: wrote header.gif + header.png");
