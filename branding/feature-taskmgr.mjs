// Feature art ③ — Task Manager (1:1 clone).
//
// The 进程 (processes) tab of CorePilot's Task-Manager clone: a live process
// table with CPU mini-bars (accent → amber above 60%), teal GPU-engine badges,
// and an app-group row that expands mid-loop (chevron rotate + staggered child
// reveal) exactly like the real motion/react table. Mirrors TmProcessTable.
//   node feature-taskmgr.mjs  →  branding/feature-taskmgr.gif (+ .png poster)
import { join } from "node:path";
import { C, FONT, MONO, HERE, brandDefs, windowCard, clamp01, easeOut, makeClip } from "./lib.mjs";

const W = 960, H = 480, N = 80, RENDER_W = 960;

// Column anchors (within the 64..880 table).
const COL = { name: 86, threads: 486, cpuBar: 512, cpuVal: 600, gpu: 648, eng: 672, mem: 872 };
const ROW_H = 34;
const TABLE_X = 64, TABLE_W = 816, TABLE_TOP = 150;

const TABS = ["性能", "进程", "详细信息", "服务", "启动"];
const ACTIVE_TAB = 1;

// Top-level rows. `w` is the phase offset for the live CPU oscillation; `cpu`
// is its centre. The game row is tuned to cross 60% so the bar shifts to amber.
const ROWS = [
  // Group aggregates mirror the real GroupRow (sum of members; no single engine).
  { name: "Google Chrome", sub: "3 个进程", icon: "C", color: "#5BC8E8", group: 3, threads: 53, cpu: 4.5, w: 0.0, gpu: 2.1, eng: null,
    children: [
      { name: "chrome.exe · 渲染器", icon: "C", color: "#5BC8E8", threads: 28, cpu: 3.1, w: 0.7, gpu: 1.2, eng: "3D" },
      { name: "chrome.exe · GPU 进程", icon: "C", color: "#5BC8E8", threads: 14, cpu: 1.0, w: 0.4, gpu: 0.9, eng: "Video Decode" },
      { name: "chrome.exe · 网络服务", icon: "C", color: "#5BC8E8", threads: 11, cpu: 0.4, w: 0.9, gpu: 0, eng: null },
    ] },
  { name: "Cyberpunk 2077", sub: "Cyberpunk2077.exe", icon: "▶", color: "#F0B23C", threads: 42, cpu: 52, w: 0.25, gpu: 71.8, eng: "3D" },
  { name: "CorePilot", sub: "corepilot.exe", icon: "◆", color: "#A88BFF", threads: 31, cpu: 2.2, w: 0.5, gpu: 0.6, eng: "3D" },
  { name: "OBS Studio", sub: "obs64.exe", icon: "O", color: "#3FD98A", threads: 36, cpu: 6.8, w: 0.8, gpu: 14.3, eng: "Video Encode" },
  { name: "资源管理器", sub: "explorer.exe", icon: "E", color: "#9AA0BD", threads: 58, cpu: 0.9, w: 0.15, gpu: 0.3, eng: "3D" },
];

const liveCpu = (row, t) => Math.max(0, row.cpu + (0.5 - 0.5 * Math.cos((t + row.w) * Math.PI * 2)) * (row.cpu > 30 ? 24 : 3) - (row.cpu > 30 ? 8 : 1));

function procIcon(x, y, ch, color) {
  return `<rect x="${x}" y="${y - 9}" width="18" height="18" rx="5" fill="${color}" fill-opacity="0.18" stroke="${color}" stroke-opacity="0.55"/>
    <text x="${x + 9}" y="${y + 4}" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="800" fill="${color}">${ch}</text>`;
}

function engBadge(x, y, eng) {
  if (!eng) return `<text x="${COL.gpu}" y="${y + 4}" text-anchor="end" font-family="${MONO}" font-size="12" fill="${C.dim}">—</text>`;
  const w = 12 + eng.length * 6.4;
  return `<rect x="${x}" y="${y - 8}" width="${w}" height="16" rx="4" fill="${C.vcache}" fill-opacity="0.12" stroke="${C.vcache}" stroke-opacity="0.32"/>
    <text x="${x + w / 2}" y="${y + 3}" text-anchor="middle" font-family="${MONO}" font-size="9.5" font-weight="700" fill="${C.vcache}">${eng}</text>`;
}

/** One data row (group header, leaf, or indented child). */
function row(y, r, t, { indent = 0, isGroup = false, chevron = 0, opacity = 1, dim = false } = {}) {
  const cpu = liveCpu(r, t);
  const hot = cpu >= 60;
  const barW = 50, fillW = Math.min(cpu, 100) / 100 * barW;
  const nameX = COL.name + indent;
  const nameFill = dim ? C.muted : C.ink;
  const gpu = r.gpu ?? 0;

  return `<g opacity="${opacity.toFixed(2)}">
    ${isGroup ? `<rect x="${TABLE_X}" y="${y - ROW_H / 2}" width="${TABLE_W}" height="${ROW_H}" fill="${C.surface2}" fill-opacity="0.35"/>` : ""}
    <line x1="${TABLE_X}" y1="${y + ROW_H / 2}" x2="${TABLE_X + TABLE_W}" y2="${y + ROW_H / 2}" stroke="${C.line}" stroke-opacity="0.05"/>
    ${isGroup ? `<path d="M${nameX - 14} ${y - 4} l5 4 l-5 4" fill="none" stroke="${C.muted}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" transform="rotate(${chevron} ${nameX - 11} ${y})"/>` : ""}
    ${procIcon(nameX, y, r.icon, r.color)}
    <text x="${nameX + 26}" y="${y + (r.sub ? -1 : 4)}" font-family="${FONT}" font-size="13" font-weight="${isGroup ? 600 : 500}" fill="${nameFill}">${r.name}${isGroup ? ` <tspan fill="${C.dim}" font-size="11">(${r.group})</tspan>` : ""}</text>
    ${r.sub && !isGroup ? `<text x="${nameX + 26}" y="${y + 11}" font-family="${FONT}" font-size="9.5" fill="${C.dim}">${r.sub}</text>` : ""}
    <text x="${COL.threads}" y="${y + 4}" text-anchor="end" font-family="${MONO}" font-size="12" fill="${C.muted}">${r.threads}</text>
    <!-- CPU mini-bar -->
    <rect x="${COL.cpuBar}" y="${y - 2.5}" width="${barW}" height="5" rx="2.5" fill="${C.surface}" stroke="${C.line}" stroke-opacity="0.06"/>
    <rect x="${COL.cpuBar}" y="${y - 2.5}" width="${fillW.toFixed(1)}" height="5" rx="2.5" fill="${hot ? C.warn : C.accent}"/>
    <text x="${COL.cpuVal}" y="${y + 4}" text-anchor="end" font-family="${MONO}" font-size="12" fill="${hot ? C.warn : C.ink}">${cpu.toFixed(1)}</text>
    <!-- GPU + engine -->
    <text x="${COL.gpu}" y="${y + 4}" text-anchor="end" font-family="${MONO}" font-size="12" fill="${gpu > 0.05 ? C.vcache : C.dim}">${gpu > 0.05 ? gpu.toFixed(1) : "—"}</text>
    ${gpu > 0.05 && !isGroup ? engBadge(COL.eng, y, r.eng) : `<text x="${COL.eng + 6}" y="${y + 4}" font-family="${MONO}" font-size="12" fill="${C.dim}">—</text>`}
    <text x="${COL.mem}" y="${y + 4}" text-anchor="end" font-family="${MONO}" font-size="12" fill="${C.muted}">${(r.threads * 5.3).toFixed(0)} MB</text>
  </g>`;
}

// Seamless expand envelope: 0 at loop ends, 1 in the middle. Ease-out on the
// enter (matches the real motion/react table + premium-motion principle).
function expandEnv(t) {
  if (t < 0.12) return 0;
  if (t < 0.30) return easeOut((t - 0.12) / 0.18);
  if (t < 0.70) return 1;
  if (t < 0.88) return 1 - easeOut((t - 0.70) / 0.18);
  return 0;
}

function build(t) {
  const expandT = expandEnv(t);
  const kids = ROWS[0].children;
  const childrenH = expandT * kids.length * ROW_H;

  // Render top-level rows; the Chrome group injects its children + shifts the rest.
  let body = "";
  let y = TABLE_TOP + ROW_H / 2;
  ROWS.forEach((r, i) => {
    if (i === 0) {
      body += row(y, r, t, { isGroup: true, chevron: expandT * 90 });
      y += ROW_H;
      // clipped children block
      body += `<g clip-path="url(#kidclip)"><g transform="translate(0 ${(-(1 - expandT) * 8).toFixed(1)})">`;
      kids.forEach((c, ci) => {
        const op = clamp01((expandT - ci * 0.16) / 0.4);
        body += row(y + ci * ROW_H, c, t, { indent: 22, opacity: op, dim: true });
      });
      body += `</g></g>`;
      y += childrenH;
    } else {
      body += row(y, r, t, {});
      y += ROW_H;
    }
  });

  // tabs
  let tabs = "";
  let tx = TABLE_X;
  TABS.forEach((label, i) => {
    const on = i === ACTIVE_TAB;
    const tw = 14 + label.length * 14;
    tabs += `<text x="${tx + tw / 2}" y="92" text-anchor="middle" font-family="${FONT}" font-size="13.5" font-weight="${on ? 700 : 500}" fill="${on ? C.ink : C.muted}">${label}</text>`;
    if (on) tabs += `<rect x="${tx + 6}" y="102" width="${tw - 12}" height="2.5" rx="1.25" fill="${C.accent}"/>`;
    tx += tw + 10;
  });

  const totalCpu = ROWS.reduce((s, r) => s + liveCpu(r, t), 0);

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    ${brandDefs(W, H)}
    <radialGradient id="halo" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(300 220) scale(560 380)"><stop stop-color="${C.accent}" stop-opacity="0.14"/><stop offset="1" stop-color="${C.accent}" stop-opacity="0"/></radialGradient>
    <radialGradient id="vign" cx="0.5" cy="0.5" r="0.8"><stop offset="0.62" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.4"/></radialGradient>
    <clipPath id="kidclip"><rect x="${TABLE_X}" y="${TABLE_TOP + ROW_H}" width="${TABLE_W}" height="${childrenH.toFixed(1)}"/></clipPath>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#halo)"/>

  ${windowCard(40, 20, 880, 448, "任务管理器 · Task Manager", C.accent)}

  <!-- tab strip -->
  ${tabs}
  <line x1="${TABLE_X}" y1="104" x2="${TABLE_X + TABLE_W}" y2="104" stroke="${C.line}" stroke-opacity="0.07"/>

  <!-- column header -->
  <g font-family="${FONT}" font-size="10" font-weight="700" letter-spacing="0.5">
    <text x="${COL.name}" y="${TABLE_TOP - 8}" fill="${C.accent}">进程名</text>
    <text x="${COL.threads}" y="${TABLE_TOP - 8}" text-anchor="end" fill="${C.muted}">线程</text>
    <text x="${COL.cpuVal}" y="${TABLE_TOP - 8}" text-anchor="end" fill="${C.muted}">CPU</text>
    <text x="${COL.gpu}" y="${TABLE_TOP - 8}" text-anchor="end" fill="${C.muted}">GPU</text>
    <text x="${COL.eng}" y="${TABLE_TOP - 8}" fill="${C.muted}">GPU 引擎</text>
    <text x="${COL.mem}" y="${TABLE_TOP - 8}" text-anchor="end" fill="${C.muted}">内存</text>
  </g>
  <line x1="${TABLE_X}" y1="${TABLE_TOP - 2}" x2="${TABLE_X + TABLE_W}" y2="${TABLE_TOP - 2}" stroke="${C.line}" stroke-opacity="0.10"/>

  ${body}

  <!-- footer -->
  <rect x="${TABLE_X}" y="438" width="${TABLE_W}" height="1.5" rx="1" fill="${C.line}" opacity="0.06"/>
  <text x="${TABLE_X}" y="460" font-family="${MONO}" font-size="11.5" fill="${C.dim}">进程 219 · 1:1 列复刻 · 应用分组可展开 · GPU 引擎占用 · 点击列排序</text>
  <text x="${TABLE_X + TABLE_W}" y="460" text-anchor="end" font-family="${MONO}" font-size="12" fill="${C.muted}">CPU 总计 ${totalCpu.toFixed(0)}%</text>

  <rect width="${W}" height="${H}" fill="url(#vign)"/>
</svg>`;
}

makeClip({
  name: "feat_taskmgr",
  n: N,
  width: RENDER_W,
  build,
  fps: 26,
  maxColors: 180,
  gifOut: join(HERE, "feature-taskmgr.gif"),
  posterOut: join(HERE, "feature-taskmgr.png"),
  posterT: 0.5,
});
console.log("feature-taskmgr: wrote feature-taskmgr.gif + .png");
