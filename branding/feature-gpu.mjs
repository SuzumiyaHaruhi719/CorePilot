// Feature art ③ — GPU Overclocking (MSI Afterburner-style).
//
// A radial clock dial whose needle climbs as a core "+MHz" offset is dialed in
// (NVAPI offset), with live power / temperature / fan readouts and a memory
// offset slider. Mirrors the in-app NVML + NVAPI tuning panel.
//   node feature-gpu.mjs  →  branding/feature-gpu.gif (+ .png poster)
import { join } from "node:path";
import { C, FONT, MONO, HERE, brandDefs, windowCard, lerp, clamp01, easeInOut, makeClip } from "./lib.mjs";

const W = 960, H = 480, N = 64, RENDER_W = 960;

// Dial geometry.
const CX = 250, CY = 250, R = 150;
const A0 = 135, A1 = 405; // degrees, sweep 270°
const deg2rad = (d) => (d * Math.PI) / 180;
const polar = (cx, cy, r, deg) => [cx + r * Math.cos(deg2rad(deg)), cy + r * Math.sin(deg2rad(deg))];

function arc(cx, cy, r, a0, a1, color, width, op = 1) {
  const [x0, y0] = polar(cx, cy, r, a0);
  const [x1, y1] = polar(cx, cy, r, a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `<path d="M${x0.toFixed(1)} ${y0.toFixed(1)} A${r} ${r} 0 ${large} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}" stroke="${color}" stroke-width="${width}" fill="none" stroke-linecap="round" opacity="${op}"/>`;
}

function ticks() {
  let s = "";
  for (let i = 0; i <= 10; i++) {
    const a = lerp(A0, A1, i / 10);
    const [x0, y0] = polar(CX, CY, R - 6, a);
    const [x1, y1] = polar(CX, CY, R - 20, a);
    s += `<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}" stroke="${C.dim}" stroke-width="2" opacity="0.6"/>`;
  }
  return s;
}

function slider(x, y, w, frac, color, label, valTxt) {
  const fx = x + w * frac;
  return `
  <text x="${x}" y="${y - 10}" font-family="${MONO}" font-size="12" fill="${C.muted}">${label}</text>
  <text x="${x + w}" y="${y - 10}" text-anchor="end" font-family="${MONO}" font-size="12.5" font-weight="700" fill="${color}">${valTxt}</text>
  <rect x="${x}" y="${y}" width="${w}" height="6" rx="3" fill="rgba(255,255,255,0.08)"/>
  <rect x="${x}" y="${y}" width="${(w * frac).toFixed(1)}" height="6" rx="3" fill="${color}"/>
  <circle cx="${fx.toFixed(1)}" cy="${y + 3}" r="9" fill="${C.surface2}" stroke="${color}" stroke-width="2.5"/>`;
}

function build(t) {
  // Dial climbs in then holds, with a gentle live shimmer.
  const climb = easeInOut(clamp01(t / 0.55));
  const shimmer = 0.5 - 0.5 * Math.cos(t * Math.PI * 2);
  const baseClock = 2700;
  const offset = Math.round(climb * 150); // +0..150 MHz core offset
  const clock = baseClock + offset + Math.round(shimmer * 18);
  const frac = (clock - 2400) / (3300 - 2400);
  const needleA = lerp(A0, A1, clamp01(frac));
  const [nx, ny] = polar(CX, CY, R - 30, needleA);
  const power = (320 + climb * 28 + shimmer * 6).toFixed(0);
  const temp = (58 + climb * 9 + shimmer * 2).toFixed(0);
  const fan = (46 + climb * 22).toFixed(0);
  const memOff = Math.round(climb * 800);

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    ${brandDefs(W, H)}
    <radialGradient id="halo" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(250 250) scale(360)"><stop stop-color="${C.vcache}" stop-opacity="0.14"/><stop offset="1" stop-color="${C.vcache}" stop-opacity="0"/></radialGradient>
    <linearGradient id="dialArc" x1="100" y1="100" x2="400" y2="400" gradientUnits="userSpaceOnUse"><stop stop-color="${C.cyan}"/><stop offset="0.6" stop-color="${C.vcache}"/><stop offset="1" stop-color="${C.freq}"/></linearGradient>
    <radialGradient id="vign" cx="0.5" cy="0.5" r="0.78"><stop offset="0.62" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.4"/></radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#halo)"/>

  ${windowCard(40, 28, 880, 424, "GPU 超频 · NVIDIA NVML + NVAPI", C.vcache)}

  <!-- dial -->
  ${ticks()}
  ${arc(CX, CY, R, A0, A1, "rgba(255,255,255,0.08)", 14)}
  ${arc(CX, CY, R, A0, needleA, "url(#dialArc)", 14)}
  <circle cx="${CX}" cy="${CY}" r="${R - 36}" fill="none" stroke="${C.line}" stroke-opacity="0.06"/>
  <!-- needle -->
  <line x1="${CX}" y1="${CY}" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}" stroke="${C.freqHot}" stroke-width="4" stroke-linecap="round" filter="url(#soft)"/>
  <line x1="${CX}" y1="${CY}" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}" stroke="${C.white}" stroke-width="2.4" stroke-linecap="round"/>
  <circle cx="${CX}" cy="${CY}" r="10" fill="${C.surface2}" stroke="${C.freqHot}" stroke-width="2.5"/>
  <text x="${CX}" y="${CY + 70}" text-anchor="middle" font-family="${MONO}" font-size="40" font-weight="800" fill="${C.ink}">${clock}</text>
  <text x="${CX}" y="${CY + 92}" text-anchor="middle" font-family="${MONO}" font-size="13" fill="${C.muted}" letter-spacing="2">CORE CLOCK · MHz</text>
  <rect x="${CX - 52}" y="${CY - 96}" width="104" height="26" rx="13" fill="rgba(47,214,198,0.12)" stroke="${C.vcache}" stroke-opacity="0.6"/>
  <text x="${CX}" y="${CY - 78}" text-anchor="middle" font-family="${MONO}" font-size="14" font-weight="800" fill="${C.vcacheHot}">+${offset} MHz</text>

  <!-- right column: readouts + sliders -->
  <g transform="translate(470 96)">
    <text font-family="${FONT}" font-size="16" font-weight="700" fill="${C.ink}">NVIDIA GeForce RTX 4090</text>

    <g transform="translate(0 36)">
      <rect width="124" height="58" rx="12" fill="${C.surface2}"/><text x="14" y="26" font-family="${MONO}" font-size="11" fill="${C.dim}">功耗 POWER</text><text x="14" y="48" font-family="${MONO}" font-size="20" font-weight="800" fill="${C.freq}">${power}W</text>
      <rect x="140" width="124" height="58" rx="12" fill="${C.surface2}"/><text x="154" y="26" font-family="${MONO}" font-size="11" fill="${C.dim}">温度 TEMP</text><text x="154" y="48" font-family="${MONO}" font-size="20" font-weight="800" fill="${C.ok}">${temp}°C</text>
      <rect x="280" width="124" height="58" rx="12" fill="${C.surface2}"/><text x="294" y="26" font-family="${MONO}" font-size="11" fill="${C.dim}">风扇 FAN</text><text x="294" y="48" font-family="${MONO}" font-size="20" font-weight="800" fill="${C.cyan}">${fan}%</text>
    </g>

    <g transform="translate(0 130)">${slider(0, 18, 404, climb, C.vcache, "核心频率偏移 · Core Offset", `+${offset} MHz`)}</g>
    <g transform="translate(0 196)">${slider(0, 18, 404, climb * 0.5, C.accentBright, "显存频率偏移 · Mem Offset", `+${memOff} MHz`)}</g>
    <g transform="translate(0 262)">${slider(0, 18, 404, 0.82, C.freq, "功率上限 · Power Limit", "115%")}</g>

    <text x="0" y="300" font-family="${MONO}" font-size="11.5" fill="${C.dim}">钳制项限制在固件安全范围 · 偏移为高级项，可一键恢复默认</text>
  </g>

  <rect width="${W}" height="${H}" fill="url(#vign)"/>
</svg>`;
}

makeClip({
  name: "feat_gpu",
  n: N,
  width: RENDER_W,
  build,
  fps: 26,
  maxColors: 160,
  gifOut: join(HERE, "feature-gpu.gif"),
  posterOut: join(HERE, "feature-gpu.png"),
  posterT: 0.85,
});
console.log("feature-gpu: wrote feature-gpu.gif + .png");
