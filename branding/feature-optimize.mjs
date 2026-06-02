// Feature art ④ — One-click Optimization.
//
// A big "一键优化" pulse triggers a checklist that ticks down (free working sets,
// purge standby, clean temp, flush DNS, high-perf power plan) while a memory bar
// drops. Mirrors the in-app one-click optimizer.
//   node feature-optimize.mjs  →  branding/feature-optimize.gif (+ .png poster)
import { join } from "node:path";
import { C, FONT, MONO, HERE, brandDefs, windowCard, lerp, clamp01, easeOut, makeClip } from "./lib.mjs";

const W = 960, H = 480, N = 60, RENDER_W = 960;

const STEPS = [
  "释放内存工作集 · Free working sets",
  "清理待机缓存 · Purge standby list",
  "清理临时文件 · Clean temp files",
  "刷新 DNS 缓存 · Flush DNS",
  "切换高性能电源计划 · High-Performance plan",
];

function checklist(x, y, t) {
  let s = "";
  STEPS.forEach((label, i) => {
    const local = clamp01((t - 0.12 - i * 0.13) / 0.12);
    const done = local > 0.99;
    const cy = y + i * 52;
    const ring = done ? C.ok : local > 0 ? C.accentBright : "rgba(255,255,255,0.18)";
    s += `<rect x="${x}" y="${cy}" width="520" height="42" rx="11" fill="${C.surface2}" stroke="${C.line}" stroke-opacity="0.06"/>`;
    s += `<circle cx="${x + 24}" cy="${cy + 21}" r="11" fill="none" stroke="${ring}" stroke-width="2.5"/>`;
    if (local > 0) {
      const p = easeOut(local);
      // animated check
      s += `<path d="M${x + 18} ${cy + 21} l4 5 l9 -10" stroke="${done ? C.ok : C.accentBright}" stroke-width="2.8" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="${p.toFixed(2)}"/>`;
    }
    s += `<text x="${x + 48}" y="${cy + 26}" font-family="${FONT}" font-size="15" font-weight="${done ? 600 : 500}" fill="${done ? C.ink : C.muted}">${label}</text>`;
    if (done) s += `<text x="${x + 504}" y="${cy + 26}" text-anchor="end" font-family="${MONO}" font-size="12" font-weight="700" fill="${C.ok}">✓</text>`;
  });
  return s;
}

function build(t) {
  const press = clamp01(1 - Math.abs(t - 0.08) / 0.08); // button press flash near start
  const progress = clamp01((t - 0.12) / 0.7);
  // memory drops from 71% → 44% as it runs
  const memPct = lerp(71, 44, easeOut(progress));
  const freed = (lerp(0, 6.8, easeOut(progress))).toFixed(1);

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    ${brandDefs(W, H)}
    <linearGradient id="btn" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${C.accent}"/><stop offset="1" stop-color="#5E8BF5"/></linearGradient>
    <linearGradient id="memg" x1="0" y1="0" x2="1" y2="0"><stop stop-color="${C.ok}"/><stop offset="1" stop-color="${C.vcache}"/></linearGradient>
    <radialGradient id="halo" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(700 360) scale(420 320)"><stop stop-color="${C.accent}" stop-opacity="0.16"/><stop offset="1" stop-color="${C.accent}" stop-opacity="0"/></radialGradient>
    <radialGradient id="vign" cx="0.5" cy="0.5" r="0.78"><stop offset="0.62" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.4"/></radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#halo)"/>

  ${windowCard(40, 28, 880, 424, "优化 · One-click Optimization", C.accent)}

  ${checklist(72, 100, t)}

  <!-- right: big button + memory gauge -->
  <g transform="translate(640 110)">
    <rect x="0" y="0" width="232" height="92" rx="18" fill="url(#btn)"/>
    <rect x="0" y="0" width="232" height="92" rx="18" fill="#fff" opacity="${(press * 0.25).toFixed(2)}"/>
    <text x="116" y="44" text-anchor="middle" font-family="${FONT}" font-size="26" font-weight="800" fill="#fff">一键优化</text>
    <text x="116" y="70" text-anchor="middle" font-family="${MONO}" font-size="12" fill="#fff" opacity="0.85">ONE-CLICK BOOST</text>

    <g transform="translate(0 132)">
      <text font-family="${MONO}" font-size="12" font-weight="700" fill="${C.muted}">内存占用 · MEMORY</text>
      <text x="232" y="0" text-anchor="end" font-family="${MONO}" font-size="22" font-weight="800" fill="${C.ok}">${memPct.toFixed(0)}%</text>
      <rect x="0" y="14" width="232" height="14" rx="7" fill="rgba(255,255,255,0.08)"/>
      <rect x="0" y="14" width="${(232 * memPct / 100).toFixed(1)}" height="14" rx="7" fill="url(#memg)"/>
      <text x="0" y="58" font-family="${MONO}" font-size="13" fill="${C.muted}">已释放 <tspan fill="${C.ok}" font-weight="700">${freed} GB</tspan></text>
    </g>

    <g transform="translate(0 232)">
      <text font-family="${MONO}" font-size="12" font-weight="700" fill="${C.muted}">电源计划 · POWER PLAN</text>
      <rect x="0" y="12" width="232" height="36" rx="10" fill="${C.surface2}" stroke="${progress > 0.9 ? C.freq : C.line}" stroke-opacity="${progress > 0.9 ? "0.6" : "0.08"}"/>
      <text x="16" y="35" font-family="${FONT}" font-size="14" font-weight="700" fill="${progress > 0.9 ? C.freq : C.muted}">${progress > 0.9 ? "⚡ 高性能 High-Performance" : "平衡 Balanced"}</text>
    </g>
  </g>

  <rect width="${W}" height="${H}" fill="url(#vign)"/>
</svg>`;
}

makeClip({
  name: "feat_opt",
  n: N,
  width: RENDER_W,
  build,
  fps: 26,
  maxColors: 150,
  gifOut: join(HERE, "feature-optimize.gif"),
  posterOut: join(HERE, "feature-optimize.png"),
  posterT: 0.95,
});
console.log("feature-optimize: wrote feature-optimize.gif + .png");
