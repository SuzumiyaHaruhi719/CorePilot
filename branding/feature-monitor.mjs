// Feature art ② / ④ — Live monitoring + Task Manager.
//
// Three live area-sparklines (CPU / GPU / RAM) scrolling left, big tickers, and
// a per-logical-core heatmap that breathes — the Performance tab at a glance.
//   node feature-monitor.mjs  →  branding/feature-monitor.gif (+ .png poster)
import { join } from "node:path";
import { C, FONT, MONO, HERE, brandDefs, windowCard, lerp, clamp01, makeClip } from "./lib.mjs";

const W = 960, H = 480, N = 64, RENDER_W = 960;
const SAMPLES = 64;

// Deterministic pseudo-random series so the sparkline looks "live" but loops.
function series(seed, t, base, amp) {
  // phase so the right edge keeps moving; loop by integer-period sines.
  const pts = [];
  for (let i = 0; i < SAMPLES; i++) {
    const x = i / (SAMPLES - 1);
    const phase = (x - t) * Math.PI * 2;
    const v =
      base +
      amp * (0.55 * Math.sin(phase * 2 + seed) + 0.3 * Math.sin(phase * 5 + seed * 2) + 0.15 * Math.sin(phase * 9 + seed));
    pts.push(clamp01(v));
  }
  return pts;
}

function spark(x, y, w, h, pts, color, fillId) {
  const step = w / (pts.length - 1);
  let d = `M${x} ${(y + h - pts[0] * h).toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) d += ` L${(x + i * step).toFixed(1)} ${(y + h - pts[i] * h).toFixed(1)}`;
  const area = `${d} L${x + w} ${y + h} L${x} ${y + h} Z`;
  return `
  <path d="${area}" fill="url(#${fillId})"/>
  <path d="${d}" stroke="${color}" stroke-width="2.5" fill="none" stroke-linejoin="round"/>
  <circle cx="${x + w}" cy="${(y + h - pts[pts.length - 1] * h).toFixed(1)}" r="3.5" fill="${color}"/>`;
}

function card(x, y, w, label, color, fillId, valTxt, pts) {
  return `
  <rect x="${x}" y="${y}" width="${w}" height="150" rx="14" fill="${C.surface2}" stroke="${C.line}" stroke-opacity="0.07"/>
  <text x="${x + 16}" y="${y + 28}" font-family="${MONO}" font-size="12" font-weight="700" fill="${color}" letter-spacing="1">${label}</text>
  <text x="${x + w - 16}" y="${y + 34}" text-anchor="end" font-family="${MONO}" font-size="26" font-weight="800" fill="${C.ink}">${valTxt}</text>
  ${spark(x + 14, y + 48, w - 28, 86, pts, color, fillId)}`;
}

// per-LP heatmap (32 cells = 2 CCD x 16T)
function heatmap(x, y, t) {
  const cell = 26, gap = 6, cols = 16;
  let s = `<text x="${x}" y="${y - 10}" font-family="${MONO}" font-size="11" font-weight="700" fill="${C.muted}" letter-spacing="1">每逻辑核 · PER-CORE</text>`;
  for (let i = 0; i < 32; i++) {
    const r = Math.floor(i / cols), c = i % cols;
    const cx = x + c * (cell + gap), cy = y + r * (cell + gap);
    const load = clamp01(0.45 + 0.5 * Math.sin((t * 2 + i * 0.4) * Math.PI * 2) * Math.cos(i * 1.3));
    const vCache = r === 0;
    const baseCol = vCache ? [47, 214, 198] : [240, 178, 60];
    const fill = `rgba(${baseCol[0]},${baseCol[1]},${baseCol[2]},${(0.12 + load * 0.78).toFixed(2)})`;
    s += `<rect x="${cx}" y="${cy}" width="${cell}" height="${cell}" rx="6" fill="${fill}"/>`;
  }
  return s;
}

function build(t) {
  const w = (a) => 0.5 - 0.5 * Math.cos((t + a) * Math.PI * 2);
  const cpu = series(1.0, t, 0.42, 0.34);
  const gpu = series(2.4, t, 0.6, 0.3);
  const ram = series(3.7, t, 0.55, 0.12);
  const cpuV = Math.round(cpu[SAMPLES - 1] * 100);
  const gpuV = Math.round(gpu[SAMPLES - 1] * 100);
  const ramV = (12 + ram[SAMPLES - 1] * 20).toFixed(1);

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    ${brandDefs(W, H)}
    <linearGradient id="fillAccent" x1="0" y1="0" x2="0" y2="1"><stop stop-color="${C.accent}" stop-opacity="0.45"/><stop offset="1" stop-color="${C.accent}" stop-opacity="0"/></linearGradient>
    <linearGradient id="fillTeal" x1="0" y1="0" x2="0" y2="1"><stop stop-color="${C.vcache}" stop-opacity="0.42"/><stop offset="1" stop-color="${C.vcache}" stop-opacity="0"/></linearGradient>
    <linearGradient id="fillCyan" x1="0" y1="0" x2="0" y2="1"><stop stop-color="${C.cyan}" stop-opacity="0.4"/><stop offset="1" stop-color="${C.cyan}" stop-opacity="0"/></linearGradient>
    <radialGradient id="halo" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(480 120) scale(560 320)"><stop stop-color="${C.accent}" stop-opacity="0.12"/><stop offset="1" stop-color="${C.accent}" stop-opacity="0"/></radialGradient>
    <radialGradient id="vign" cx="0.5" cy="0.5" r="0.78"><stop offset="0.62" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.4"/></radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#halo)"/>

  ${windowCard(40, 28, 880, 424, "性能监控 · Live Performance", C.accent)}

  ${card(64, 92, 264, "CPU", C.accentBright, "fillAccent", `${cpuV}%`, cpu)}
  ${card(348, 92, 264, "GPU", C.vcacheHot, "fillTeal", `${gpuV}%`, gpu)}
  ${card(632, 92, 264, "RAM", C.cyan, "fillCyan", `${ramV}G`, ram)}

  <g transform="translate(64 300)">${heatmap(0, 28, t)}</g>

  <!-- side stat chips -->
  <g transform="translate(560 286)">
    <text font-family="${MONO}" font-size="11" font-weight="700" fill="${C.muted}" letter-spacing="1">实时速率 · RATES</text>
    <g transform="translate(0 16)">
      <rect width="160" height="40" rx="10" fill="${C.surface2}"/><text x="12" y="18" font-family="${MONO}" font-size="10" fill="${C.dim}">磁盘 DISK</text><text x="148" y="30" text-anchor="end" font-family="${MONO}" font-size="15" font-weight="700" fill="${C.freq}">${(w(0.2) * 900 + 120 | 0)} MB/s</text>
      <rect y="48" width="160" height="40" rx="10" fill="${C.surface2}"/><text x="12" y="66" font-family="${MONO}" font-size="10" fill="${C.dim}">网络 NET</text><text x="148" y="78" text-anchor="end" font-family="${MONO}" font-size="15" font-weight="700" fill="${C.ok}">↓${(w(0.5) * 60 + 4 | 0)} MB/s</text>
      <rect x="176" width="160" height="40" rx="10" fill="${C.surface2}"/><text x="188" y="18" font-family="${MONO}" font-size="10" fill="${C.dim}">显存 VRAM</text><text x="324" y="30" text-anchor="end" font-family="${MONO}" font-size="15" font-weight="700" fill="${C.accentBright}">${(7.2 + w(0.3) * 2).toFixed(1)} GB</text>
      <rect x="176" y="48" width="160" height="40" rx="10" fill="${C.surface2}"/><text x="188" y="66" font-family="${MONO}" font-size="10" fill="${C.dim}">GPU 温度</text><text x="324" y="78" text-anchor="end" font-family="${MONO}" font-size="15" font-weight="700" fill="${C.ok}">${(63 + w(0.6) * 5).toFixed(0)}°C</text>
    </g>
  </g>

  <text x="64" y="438" font-family="${MONO}" font-size="11.5" fill="${C.dim}">CPU·内存·GPU·显存·磁盘·网络 实时曲线 + 每核/每 CCD 热力图 · 可自选显示指标</text>

  <rect width="${W}" height="${H}" fill="url(#vign)"/>
</svg>`;
}

makeClip({
  name: "feat_monitor",
  n: N,
  width: RENDER_W,
  build,
  fps: 26,
  maxColors: 170,
  gifOut: join(HERE, "feature-monitor.gif"),
  posterOut: join(HERE, "feature-monitor.png"),
  posterT: 0.5,
});
console.log("feature-monitor: wrote feature-monitor.gif + .png");
