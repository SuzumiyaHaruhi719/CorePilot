// Feature art ⑥ — Motherboard fan control (FanXpert-style).
//
// A radial RPM gauge with a continuously spinning blade + a duty arc, beside the
// signature temperature→duty curve editor. As the temp source oscillates, a live
// cyan operating-point dot tracks along the curve and the RPM / duty readouts
// tick in sync — one coherent cause→effect chain (temp ↑ → dot climbs curve →
// duty ↑ → fan spins → RPM ↑). Mirrors src/tabs/FanControl + FanCurveEditor.
//   node feature-fan.mjs  →  branding/feature-fan.gif (+ .png poster)
import { join } from "node:path";
import { C, FONT, MONO, HERE, brandDefs, windowCard, clamp01, makeClip } from "./lib.mjs";

const W = 960, H = 480, N = 72, RENDER_W = 960;

// Standard preset curve (Fan Xpert-style), temperature (°C) → duty (%) — mirrors
// STANDARD_CURVE in src/store/fanProfiles.ts. Floor is the global MIN_SAFE_DUTY.
const CURVE = [
  { t: 30, d: 22 },
  { t: 40, d: 33 },
  { t: 50, d: 45 },
  { t: 60, d: 60 },
  { t: 70, d: 80 },
  { t: 73, d: 100 },
];
const MIN_DUTY = 20; // MIN_SAFE_DUTY

/** Linear interpolation of the fan curve (mirrors the Rust engine / interpCurve). */
function interpCurve(temp) {
  const pts = CURVE;
  if (temp <= pts[0].t) return pts[0].d;
  const last = pts[pts.length - 1];
  if (temp >= last.t) return last.d;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (temp >= a.t && temp <= b.t) {
      const span = b.t - a.t;
      return span <= 0 ? b.d : a.d + ((temp - a.t) / span) * (b.d - a.d);
    }
  }
  return last.d;
}

// ---- radial gauge geometry --------------------------------------------------
const GA = { cx: 196, cy: 268, r: 96 };
const ARC_START = 138, ARC_SWEEP = 264; // degrees: open-bottom radial gauge

const polar = (cx, cy, r, deg) => {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
};
function arcPath(cx, cy, r, startDeg, endDeg) {
  const [x0, y0] = polar(cx, cy, r, startDeg);
  const [x1, y1] = polar(cx, cy, r, endDeg);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/** Five swept blades on a hub, rotated by `rot` degrees (continuous spin). */
function fanBlades(cx, cy, rot, intensity) {
  const hubR = 12, tip = 58, bw = 26;
  let blades = "";
  for (let i = 0; i < 5; i++) {
    const a = rot + i * 72;
    const d = `M 0 ${-hubR} Q ${bw} ${-tip * 0.5} ${bw * 0.28} ${-tip} Q ${-bw * 0.2} ${-tip * 0.72} 0 ${-hubR} Z`;
    blades += `<path d="${d}" fill="url(#blade)" transform="rotate(${a})" opacity="${(0.78 + intensity * 0.22).toFixed(2)}"/>`;
  }
  return `<g transform="translate(${cx} ${cy})">
    ${blades}
    <circle r="${hubR}" fill="#241d3c" stroke="${C.accentBright}" stroke-opacity="0.6" stroke-width="2"/>
    <circle r="4.5" fill="${C.accentBright}"/>
  </g>`;
}

// ---- curve editor geometry --------------------------------------------------
const CE = { x: 392, y: 150, w: 488, h: 196, pad: 26 };
const ceX = (t) => CE.x + CE.pad + (t / 100) * (CE.w - CE.pad * 2);
const ceY = (d) => CE.y + CE.pad + (1 - d / 100) * (CE.h - CE.pad * 2);

function segmented(x, y, active) {
  const opts = ["自动", "手动", "曲线"];
  const pw = 58, ph = 28, gap = 0;
  let s = `<rect x="${x}" y="${y}" width="${pw * 3 + gap * 2 + 8}" height="${ph + 8}" rx="11" fill="${C.surface2}" stroke="${C.line}" stroke-opacity="0.10"/>`;
  // sliding active pill
  const ax = x + 4 + active * pw;
  s += `<rect x="${ax}" y="${y + 4}" width="${pw}" height="${ph}" rx="8" fill="${C.accent}" fill-opacity="0.9"/>`;
  opts.forEach((o, i) => {
    const on = i === active;
    s += `<text x="${x + 4 + i * pw + pw / 2}" y="${y + 4 + ph / 2 + 5}" text-anchor="middle" font-family="${FONT}" font-size="14" font-weight="${on ? 700 : 500}" fill="${on ? "#fff" : C.muted}">${o}</text>`;
  });
  return s;
}

// Minimal preset icons (stroke glyphs, no emoji): moon · gauge · wind · fan.
const PRESET_GLYPH = {
  silent: `<path d="M5 0 a6 6 0 1 0 5 8 A7.5 7.5 0 0 1 5 0 Z" fill="none" stroke="currentColor" stroke-width="1.4"/>`,
  standard: `<path d="M-5 4 A6.5 6.5 0 1 1 5 4" fill="none" stroke="currentColor" stroke-width="1.4"/><line x1="0" y1="3" x2="3" y2="-2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>`,
  turbo: `<path d="M-6 -3 h8 a2.5 2.5 0 1 1 2 4 M-6 1 h11 a2.5 2.5 0 1 0 2 -4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>`,
  full: `<g fill="none" stroke="currentColor" stroke-width="1.3"><circle r="1.6"/><path d="M0 -1.6 Q5 -5 6 0 M1.4 0.8 Q5 4 1 5.4 M-1.4 0.8 Q-6 3 -6 -1.5" /></g>`,
};
function preset(x, y, label, glyph, active, w = 90) {
  const h = 34;
  const stroke = active ? C.accent : C.line;
  const so = active ? "0.8" : "0.12";
  const ink = active ? C.accentBright : C.muted;
  return `<g>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="9" fill="${active ? "rgba(124,92,255,0.14)" : C.surface2}" stroke="${stroke}" stroke-opacity="${so}"/>
    <g transform="translate(${x + 17} ${y + h / 2})" color="${ink}">${PRESET_GLYPH[glyph]}</g>
    <text x="${x + 32}" y="${y + h / 2 + 5}" font-family="${FONT}" font-size="13" font-weight="${active ? 700 : 500}" fill="${active ? C.ink : C.muted}">${label}</text>
  </g>`;
}

function build(t) {
  // Temp source oscillates smoothly (loops seamlessly): drives the whole chain.
  const temp = 50 + 22 * Math.sin(t * Math.PI * 2);        // ~28..72 °C
  const duty = interpCurve(temp);                          // % via the Standard curve
  const rpm = Math.round(360 + (duty / 100) * 1560);       // 360..1920 RPM
  const intensity = clamp01((duty - MIN_DUTY) / (100 - MIN_DUTY));
  // Continuous, seamless spin (integer turns/loop so the GIF loops cleanly);
  // perceived speed is conveyed by the RPM readout + duty arc, not blade rate.
  const rot = t * 360 * 4;

  // duty arc fill
  const arcEnd = ARC_START + ARC_SWEEP * (duty / 100);
  // live point on the curve
  const lx = ceX(Math.max(0, Math.min(100, temp)));
  const ly = ceY(Math.max(0, Math.min(100, duty)));

  // curve geometry
  const linePts = CURVE.map((p) => `${ceX(p.t).toFixed(1)},${ceY(p.d).toFixed(1)}`).join(" ");
  const baseY = (CE.y + CE.h - CE.pad).toFixed(1);
  const areaPts = `${ceX(CURVE[0].t).toFixed(1)},${baseY} ${linePts} ${ceX(CURVE[CURVE.length - 1].t).toFixed(1)},${baseY}`;
  const floorY = ceY(MIN_DUTY);

  // grid
  let grid = "";
  for (const g of [0, 25, 50, 75, 100]) {
    grid += `<line x1="${ceX(g)}" y1="${CE.y + CE.pad}" x2="${ceX(g)}" y2="${CE.y + CE.h - CE.pad}" stroke="${C.line}" stroke-opacity="0.06"/>`;
    grid += `<text x="${ceX(g)}" y="${CE.y + CE.h - 6}" text-anchor="middle" font-family="${MONO}" font-size="9" fill="${C.dim}">${g}°</text>`;
    grid += `<line x1="${CE.x + CE.pad}" y1="${ceY(g)}" x2="${CE.x + CE.w - CE.pad}" y2="${ceY(g)}" stroke="${C.line}" stroke-opacity="0.06"/>`;
  }

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    ${brandDefs(W, H)}
    <radialGradient id="halo" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(${GA.cx} ${GA.cy}) scale(360)"><stop stop-color="${C.accent}" stop-opacity="0.18"/><stop offset="1" stop-color="${C.accent}" stop-opacity="0"/></radialGradient>
    <radialGradient id="vign" cx="0.5" cy="0.5" r="0.8"><stop offset="0.6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.4"/></radialGradient>
    <linearGradient id="blade" x1="0" y1="-80" x2="20" y2="0" gradientUnits="userSpaceOnUse"><stop stop-color="${C.accentBright}"/><stop offset="1" stop-color="#5B3CE0"/></linearGradient>
    <linearGradient id="dutyArc" x1="${GA.cx - GA.r}" y1="0" x2="${GA.cx + GA.r}" y2="0" gradientUnits="userSpaceOnUse"><stop stop-color="${C.cyan}"/><stop offset="1" stop-color="${C.accentBright}"/></linearGradient>
    <linearGradient id="cfill" x1="0" y1="${CE.y}" x2="0" y2="${CE.y + CE.h}" gradientUnits="userSpaceOnUse"><stop stop-color="${C.accent}" stop-opacity="0.28"/><stop offset="1" stop-color="${C.accent}" stop-opacity="0.02"/></linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#halo)"/>

  ${windowCard(40, 20, 880, 448, "风扇控制 · Fan Control", C.accent)}

  <!-- mode segmented + temp-source / spin-up meta -->
  ${segmented(64, 72, 2)}
  <text x="392" y="92" font-family="${MONO}" font-size="12" fill="${C.muted}">温度源 · CPU Tctl</text>
  <text x="880" y="92" text-anchor="end" font-family="${MONO}" font-size="12" fill="${C.dim}">最低转速下限 ${MIN_DUTY}% · 加速 立即</text>

  <!-- ① radial RPM gauge + spinning blade (left) -->
  <g>
    <circle cx="${GA.cx}" cy="${GA.cy}" r="${GA.r + 14}" fill="${C.surface}" stroke="${C.line}" stroke-opacity="0.08"/>
    <path d="${arcPath(GA.cx, GA.cy, GA.r, ARC_START, ARC_START + ARC_SWEEP)}" fill="none" stroke="${C.line}" stroke-opacity="0.10" stroke-width="9" stroke-linecap="round"/>
    <path d="${arcPath(GA.cx, GA.cy, GA.r, ARC_START, arcEnd)}" fill="none" stroke="url(#dutyArc)" stroke-width="9" stroke-linecap="round" filter="url(#soft)"/>
    <path d="${arcPath(GA.cx, GA.cy, GA.r, ARC_START, arcEnd)}" fill="none" stroke="url(#dutyArc)" stroke-width="9" stroke-linecap="round"/>
    ${fanBlades(GA.cx, GA.cy - 18, rot, intensity)}
    <!-- readout plate keeps the RPM legible over the spinning blades -->
    <ellipse cx="${GA.cx}" cy="${GA.cy + 46}" rx="60" ry="26" fill="${C.bg0}" opacity="0.6" filter="url(#softer)"/>
    <text x="${GA.cx}" y="${GA.cy + 50}" text-anchor="middle" font-family="${MONO}" font-size="30" font-weight="800" fill="${C.ink}" letter-spacing="-0.5">${rpm}</text>
    <text x="${GA.cx}" y="${GA.cy + 66}" text-anchor="middle" font-family="${MONO}" font-size="10.5" fill="${C.dim}">RPM</text>
    <text x="${GA.cx}" y="${GA.cy + GA.r + 6}" text-anchor="middle" font-family="${MONO}" font-size="13" font-weight="700" fill="${C.cyan}">占空比 ${Math.round(duty)}%</text>
  </g>

  <!-- ② temperature → duty curve editor (right) -->
  <g>
    <rect x="${CE.x}" y="${CE.y}" width="${CE.w}" height="${CE.h}" rx="12" fill="${C.surface2}" fill-opacity="0.35" stroke="${C.line}" stroke-opacity="0.08"/>
    ${grid}
    <!-- min-duty floor band -->
    <rect x="${CE.x + CE.pad}" y="${floorY}" width="${CE.w - CE.pad * 2}" height="${(CE.y + CE.h - CE.pad - floorY).toFixed(1)}" fill="${C.dim}" opacity="0.08"/>
    <polygon points="${areaPts}" fill="url(#cfill)"/>
    <polyline points="${linePts}" fill="none" stroke="${C.accentBright}" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round" filter="url(#soft)"/>
    <polyline points="${linePts}" fill="none" stroke="${C.accentBright}" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/>
    ${CURVE.map((p) => `<circle cx="${ceX(p.t).toFixed(1)}" cy="${ceY(p.d).toFixed(1)}" r="5" fill="${C.accentBright}" stroke="${C.bg0}" stroke-width="2"/>`).join("")}
    <!-- live operating point (cyan), tracking temp→duty -->
    <line x1="${lx.toFixed(1)}" y1="${CE.y + CE.pad}" x2="${lx.toFixed(1)}" y2="${CE.y + CE.h - CE.pad}" stroke="${C.cyan}" stroke-width="1" stroke-dasharray="3 3" opacity="0.6"/>
    <circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="10" fill="${C.cyan}" opacity="0.18"/>
    <circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="5.5" fill="${C.cyan}" stroke="${C.bg0}" stroke-width="1.8" filter="url(#soft)"/>
    <text x="${CE.x + CE.w - CE.pad}" y="${CE.y + 16}" text-anchor="end" font-family="${MONO}" font-size="11" fill="${C.cyan}" font-weight="700">${Math.round(temp)}°C → ${Math.round(duty)}%</text>
    <text x="${CE.x + 4}" y="${CE.y - 8}" font-family="${MONO}" font-size="11.5" font-weight="700" fill="${C.muted}">温度 → 转速曲线 · 拖动调整</text>
  </g>

  <!-- ③ built-in presets (Silent / Standard / Turbo / Full Blast — Standard active) -->
  ${preset(64, 392, "Silent", "silent", false, 82)}
  ${preset(154, 392, "Standard", "standard", true, 100)}
  ${preset(262, 392, "Turbo", "turbo", false, 80)}
  ${preset(350, 392, "Full Blast", "full", false, 108)}

  <!-- footer status -->
  <rect x="64" y="438" width="816" height="1.5" rx="1" fill="${C.line}" opacity="0.06"/>
  <circle cx="72" cy="455" r="4" fill="${C.ok}"/>
  <text x="86" y="460" font-family="${MONO}" font-size="12" fill="${C.muted}">曲线模式 · 已接管 · 退出自动恢复 BIOS 默认</text>
  <text x="880" y="460" text-anchor="end" font-family="${MONO}" font-size="11.5" fill="${C.dim}">LibreHardwareMonitor · Super-I/O PWM · 锁定时优雅降级</text>

  <rect width="${W}" height="${H}" fill="url(#vign)"/>
</svg>`;
}

makeClip({
  name: "feat_fan",
  n: N,
  width: RENDER_W,
  build,
  fps: 26,
  maxColors: 180,
  gifOut: join(HERE, "feature-fan.gif"),
  posterOut: join(HERE, "feature-fan.png"),
  posterT: 0.32,
});
console.log("feature-fan: wrote feature-fan.gif + .png");
