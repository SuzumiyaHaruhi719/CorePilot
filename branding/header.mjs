// Generate animated header frames for CorePilot.
// A light-sweep races across the 32 logical threads (CCD0 teal V-Cache / CCD1 violet
// frequency), the logo core-glow pulses. Frames -> PNG via resvg; ffmpeg makes the GIF.
import { Resvg } from "@resvg/resvg-js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FRAMES = join(HERE, "frames");
mkdirSync(FRAMES, { recursive: true });

const W = 1280;
const H = 420;
const N_FRAMES = 50;
const RENDER_W = 1200;

const lerp = (a, b, t) => a + (b - a) * t;

function chipMark(cx, cy, scale, pulse) {
  // The icon mark (die + pins + glowing core + boost chevrons) centered at cx,cy.
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

function coreRow(sweep) {
  const n = 32;
  const x0 = 360;
  const x1 = 1200;
  const yBase = 300;
  const gap = 7;
  const cellW = (x1 - x0 - gap * (n - 1)) / n;
  let s = "";
  for (let i = 0; i < n; i++) {
    const x = x0 + i * (cellW + gap);
    const xn = i / (n - 1);
    let d = Math.abs(xn - sweep);
    d = Math.min(d, 1 - d);
    const lit = Math.max(0, 1 - d / 0.13);
    const ccd0 = i < 16;
    const base = ccd0 ? "#0f766e" : "#4733b8";
    const hot = ccd0 ? "#5eead4" : "#b6a1ff";
    const h = 18 + lit * 16;
    const y = yBase - lit * 8;
    const op = lerp(0.28, 1, lit);
    const col = lit > 0.45 ? hot : base;
    s += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${cellW.toFixed(1)}" height="${h.toFixed(1)}" rx="5" fill="${col}" opacity="${op.toFixed(2)}"/>`;
    if (lit > 0.4) {
      s += `<rect x="${(x - 4).toFixed(1)}" y="${(y - 4).toFixed(1)}" width="${(cellW + 8).toFixed(1)}" height="${(h + 8).toFixed(1)}" rx="7" fill="${hot}" opacity="${(lit * 0.28).toFixed(2)}" filter="url(#cellGlow)"/>`;
    }
  }
  return s;
}

function buildSvg(t) {
  const pulse = 0.5 + 0.5 * Math.sin(t * Math.PI * 2);
  const sweep = t; // 0..1 seamless wrapped sweep
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="${W}" y2="${H}" gradientUnits="userSpaceOnUse">
      <stop stop-color="#0E0B18"/><stop offset="1" stop-color="#07060D"/>
    </linearGradient>
    <radialGradient id="bgHalo" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(190 175) rotate(35) scale(560 360)">
      <stop stop-color="#7C5CFF" stop-opacity="${(0.30 + 0.12 * pulse).toFixed(3)}"/><stop offset="1" stop-color="#7C5CFF" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="markHalo" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(512 512) scale(240)">
      <stop stop-color="#8B6CFF" stop-opacity="0.9"/><stop offset="1" stop-color="#8B6CFF" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="dieStroke" x1="298" y1="298" x2="726" y2="726" gradientUnits="userSpaceOnUse"><stop stop-color="#B6A1FF"/><stop offset="1" stop-color="#5B3CE0"/></linearGradient>
    <linearGradient id="dieFill" x1="512" y1="298" x2="512" y2="726" gradientUnits="userSpaceOnUse"><stop stop-color="#1C1733"/><stop offset="1" stop-color="#100D1C"/></linearGradient>
    <linearGradient id="pin" x1="512" y1="244" x2="512" y2="324" gradientUnits="userSpaceOnUse"><stop stop-color="#9079FF"/><stop offset="1" stop-color="#4733B8"/></linearGradient>
    <linearGradient id="core" x1="512" y1="372" x2="512" y2="652" gradientUnits="userSpaceOnUse"><stop stop-color="#A88BFF"/><stop offset="0.5" stop-color="#5E8BF5"/><stop offset="1" stop-color="#2FD6C6"/></linearGradient>
    <linearGradient id="title" x1="360" y1="150" x2="900" y2="210" gradientUnits="userSpaceOnUse"><stop stop-color="#FFFFFF"/><stop offset="1" stop-color="#C9BCFF"/></linearGradient>
    <filter id="coreGlow" x="-70%" y="-70%" width="240%" height="240%"><feGaussianBlur stdDeviation="26" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <filter id="cellGlow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="6"/></filter>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#bgHalo)"/>

  ${chipMark(186, 196, 0.34, pulse)}

  <text x="360" y="158" font-family="Segoe UI, Microsoft YaHei UI, sans-serif" font-size="92" font-weight="800" fill="url(#title)" letter-spacing="-1">CorePilot</text>
  <text x="364" y="212" font-family="Segoe UI, Microsoft YaHei UI, sans-serif" font-size="29" font-weight="500" fill="#9AA0BD">AMD Ryzen 9 9950X3D · 双 CCD 智能分核 · 实时功耗温度</text>

  ${coreRow(sweep)}

  <text x="360" y="358" font-family="Consolas, Segoe UI, sans-serif" font-size="17" font-weight="600" fill="#2dd4bf" letter-spacing="1">CCD0 · 3D V-CACHE</text>
  <text x="1200" y="358" text-anchor="end" font-family="Consolas, Segoe UI, sans-serif" font-size="17" font-weight="600" fill="#b6a1ff" letter-spacing="1">CCD1 · 高频核心</text>
</svg>`;
}

let last;
for (let f = 0; f < N_FRAMES; f++) {
  const t = f / N_FRAMES;
  const svg = buildSvg(t);
  const png = new Resvg(svg, { fitTo: { mode: "width", value: RENDER_W }, font: { loadSystemFonts: true } }).render().asPng();
  writeFileSync(join(FRAMES, `f_${String(f).padStart(3, "0")}.png`), png);
  last = svg;
}
// Static banner = a frame with the sweep mid-grid.
const banner = new Resvg(buildSvg(0.5), { fitTo: { mode: "width", value: RENDER_W }, font: { loadSystemFonts: true } }).render().asPng();
writeFileSync(join(HERE, "header.png"), banner);
console.log(`rendered ${N_FRAMES} frames + header.png`);
