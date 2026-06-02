// Feature art ⑤ — In-game OSD overlay.
//
// A stylised game frame with CorePilot's transparent, click-through metrics
// plate pinned top-left (CPU/GPU/RAM/FPS ticking live), plus the global toggle
// hotkey badge (Ctrl+Shift+F10). Mirrors src/osd/OsdPlate + useOsdHotkey.
//   node feature-osd.mjs  →  branding/feature-osd.gif (+ .png poster)
import { join } from "node:path";
import { C, FONT, MONO, HERE, brandDefs, lerp, clamp01, makeClip } from "./lib.mjs";

const W = 960, H = 480, N = 60, RENDER_W = 960;

// A cheap parallax "skyline" so it reads as a game scene without art assets.
function gameScene(t) {
  const drift = (t * 60) % 120;
  let hills = "";
  for (let i = -1; i < 9; i++) {
    const x = i * 130 - drift;
    const h = 120 + ((i * 53) % 70);
    hills += `<path d="M${x} ${H} L${x} ${H - h} Q${x + 65} ${H - h - 40} ${x + 130} ${H - h} L${x + 130} ${H} Z" fill="#1a2740" opacity="0.55"/>`;
  }
  let hills2 = "";
  const drift2 = (t * 110) % 90;
  for (let i = -1; i < 12; i++) {
    const x = i * 90 - drift2;
    const h = 60 + ((i * 37) % 50);
    hills2 += `<path d="M${x} ${H} L${x} ${H - h} L${x + 45} ${H - h - 24} L${x + 90} ${H - h} L${x + 90} ${H} Z" fill="#24375e" opacity="0.7"/>`;
  }
  // sun + a few stars
  let stars = "";
  for (let i = 0; i < 26; i++) {
    const sx = (i * 137) % W, sy = (i * 71) % 200;
    const tw = 0.3 + 0.7 * (0.5 - 0.5 * Math.cos((t + i * 0.13) * Math.PI * 2));
    stars += `<circle cx="${sx}" cy="${sy + 30}" r="1.4" fill="#cdd6ff" opacity="${tw.toFixed(2)}"/>`;
  }
  return `${stars}<circle cx="740" cy="150" r="64" fill="url(#sun)"/>${hills}${hills2}`;
}

// One metric token: tag in category color + value in white.
function tok(tag, color, val) {
  return `<tspan fill="${color}" font-weight="800">${tag}</tspan><tspan fill="#fff"> ${val}</tspan>`;
}

function build(t) {
  // live values
  const w = (a) => 0.5 - 0.5 * Math.cos((t + a) * Math.PI * 2);
  const fps = Math.round(142 + w(0) * 24);
  const cpu = Math.round(38 + w(0.2) * 26);
  const gpu = Math.round(82 + w(0.5) * 14);
  const cpuT = Math.round(62 + w(0.3) * 6);
  const gpuT = Math.round(64 + w(0.6) * 5);
  const ram = (18.4 + w(0.1) * 1.6).toFixed(1);
  // hotkey badge pulse
  const press = clamp01(1 - ((t * 2) % 1) * 6); // brief flash twice per loop
  const plateIn = clamp01(t / 0.1);

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    ${brandDefs(W, H)}
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="${H}" gradientUnits="userSpaceOnUse"><stop stop-color="#0c1430"/><stop offset="0.5" stop-color="#16203f"/><stop offset="1" stop-color="#0a1124"/></linearGradient>
    <radialGradient id="sun" cx="0.5" cy="0.5" r="0.5"><stop stop-color="#ffd9a0"/><stop offset="0.5" stop-color="#ff9d57" stop-opacity="0.7"/><stop offset="1" stop-color="#ff9d57" stop-opacity="0"/></radialGradient>
    <radialGradient id="vign" cx="0.5" cy="0.5" r="0.8"><stop offset="0.55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.5"/></radialGradient>
    <clipPath id="screen"><rect x="24" y="24" width="912" height="432" rx="16"/></clipPath>
  </defs>
  <rect width="${W}" height="${H}" fill="${C.bg1}"/>

  <!-- game viewport -->
  <g clip-path="url(#screen)">
    <rect x="24" y="24" width="912" height="432" fill="url(#sky)"/>
    ${gameScene(t)}
    <rect x="24" y="24" width="912" height="432" fill="url(#vign)"/>

    <!-- OSD plate: transparent, click-through, pinned top-left -->
    <g transform="translate(48 48)" opacity="${plateIn.toFixed(2)}">
      <rect x="0" y="0" width="372" height="62" rx="10" fill="rgba(8,10,16,0.62)" stroke="rgba(255,255,255,0.10)"/>
      <text x="16" y="27" font-family="${MONO}" font-size="16" letter-spacing="0.3">
        ${tok("FPS", C.accentBright, fps)}<tspan>   </tspan>${tok("CPU", C.accentBright, `${cpu}% ${cpuT}°`)}
      </text>
      <text x="16" y="50" font-family="${MONO}" font-size="16" letter-spacing="0.3">
        ${tok("GPU", C.vcacheHot, `${gpu}% ${gpuT}°`)}<tspan>   </tspan>${tok("RAM", C.cyan, `${ram}G`)}
      </text>
    </g>

    <!-- hotkey badge -->
    <g transform="translate(632 396)">
      <rect x="0" y="0" width="280" height="36" rx="18" fill="rgba(8,10,16,${(0.5 + press * 0.35).toFixed(2)})" stroke="${C.accent}" stroke-opacity="${(0.4 + press * 0.6).toFixed(2)}" stroke-width="1.5"/>
      <text x="18" y="23" font-family="${MONO}" font-size="13" font-weight="700" fill="${C.accentBright}">Ctrl+Shift+F10</text>
      <text x="150" y="23" font-family="${FONT}" font-size="13" fill="${C.muted}">切换叠加层</text>
    </g>
  </g>

  <!-- monitor bezel -->
  <rect x="24" y="24" width="912" height="432" rx="16" fill="none" stroke="${C.line}" stroke-opacity="0.12" stroke-width="2"/>
  <text x="40" y="18" font-family="${MONO}" font-size="12" font-weight="700" fill="${C.muted}">游戏内 OSD · In-game overlay</text>
  <text x="920" y="18" text-anchor="end" font-family="${MONO}" font-size="11" fill="${C.dim}">透明 · 点击穿透 · 横向/竖排 · FPS 经 ETW PresentMon</text>
</svg>`;
}

makeClip({
  name: "feat_osd",
  n: N,
  width: RENDER_W,
  build,
  fps: 24,
  maxColors: 180,
  gifOut: join(HERE, "feature-osd.gif"),
  posterOut: join(HERE, "feature-osd.png"),
  posterT: 0.3,
});
console.log("feature-osd: wrote feature-osd.gif + .png");
