import type { CSSProperties } from "react";
import { api, type GpuOcInfo, type Metrics, type OsdFpsStats, type Sensors } from "./ipc";
import { formatBytes } from "./format";

/**
 * OSD (in-game overlay) metric catalog + data fetch.
 *
 * The overlay reuses CorePilot's existing backend commands (no extra sampler)
 * and renders a user-chosen subset of metrics. Each metric reports whether it is
 * `supported` on this build at all (false → shown greyed in config, e.g. FPS
 * which needs PresentMon, or sensors the hardware doesn't expose) and a `value`
 * formatter that returns the live string or `null` when momentarily unavailable.
 */

export interface OsdData {
  metrics: Metrics | null;
  sensors: Sensors | null;
  gpu: GpuOcInfo | null;
  /** Frame-pacing stats for the foreground game (null when unavailable). */
  fps: OsdFpsStats | null;
}

export type OsdCategory = "fps" | "cpu" | "gpu" | "mem" | "disk" | "net";

export interface OsdMetricDef {
  key: string;
  cat: OsdCategory;
  /** Full label for the config panel. */
  label: string;
  /** Short tag shown in the overlay (kept terse for low visual noise). */
  tag: string;
  /** Whether this build can ever provide the metric (false → greyed in config). */
  supported: boolean;
  /** Live formatted value, or null when momentarily unavailable. */
  value: (d: OsdData) => string | null;
}

const rate = (v: number | null | undefined): string | null =>
  v == null ? null : `${formatBytes(v, v < 1024 * 1024 ? 0 : 1)}/s`;
const pct = (v: number | null | undefined, digits = 0): string | null =>
  v == null ? null : `${v.toFixed(digits)}%`;

function memPct(d: OsdData): number | null {
  const m = d.metrics;
  if (!m || m.memTotal <= 0) return null;
  return (m.memUsed / m.memTotal) * 100;
}

/** GPU util prefers NVML (gpu tab), falls back to the PDH aggregate (sensors). */
function gpuUtil(d: OsdData): number | null {
  if (d.gpu?.available) return d.gpu.utilizationGpu;
  return d.sensors?.gpuPct ?? null;
}

export const OSD_METRICS: OsdMetricDef[] = [
  // FPS / frame pacing — derived from ETW present events (PresentMon-style).
  { key: "fps", cat: "fps", label: "FPS", tag: "FPS", supported: true, value: (d) => (d.fps?.fps == null ? null : d.fps.fps.toFixed(0)) },
  { key: "fps.low1", cat: "fps", label: "1% Low FPS", tag: "1%", supported: true, value: (d) => (d.fps?.low1 == null ? null : d.fps.low1.toFixed(0)) },
  { key: "fps.low01", cat: "fps", label: "0.1% Low FPS", tag: "0.1%", supported: true, value: (d) => (d.fps?.low01 == null ? null : d.fps.low01.toFixed(0)) },
  { key: "fps.frametime", cat: "fps", label: "帧时间 (ms)", tag: "FT", supported: true, value: (d) => (d.fps?.frametimeMs == null ? null : `${d.fps.frametimeMs.toFixed(1)}ms`) },
  { key: "net.up", cat: "net", label: "上传速度", tag: "↑", supported: true, value: (d) => { const r = rate(d.sensors?.netUp); return r ? `↑${r}` : null; } },
  { key: "net.down", cat: "net", label: "下载速度", tag: "↓", supported: true, value: (d) => { const r = rate(d.sensors?.netDown); return r ? `↓${r}` : null; } },

  // CPU
  { key: "cpu.util", cat: "cpu", label: "占用率 (%)", tag: "CPU", supported: true, value: (d) => pct(d.metrics?.cpuOverall, 0) },
  { key: "cpu.temp", cat: "cpu", label: "温度 (°C)", tag: "CPU", supported: true, value: (d) => (d.sensors?.cpuTemp == null ? null : `${d.sensors.cpuTemp.toFixed(0)}°`) },
  { key: "cpu.power", cat: "cpu", label: "热功耗 (W)", tag: "CPU", supported: true, value: (d) => (d.sensors?.cpuPower == null ? null : `${d.sensors.cpuPower.toFixed(0)}W`) },
  { key: "cpu.freq", cat: "cpu", label: "频率 (MHz)", tag: "CPU", supported: true, value: (d) => (d.sensors?.cpuClock == null ? null : `${Math.round(d.sensors.cpuClock)}MHz`) },

  // GPU
  { key: "gpu.util", cat: "gpu", label: "占用率 (%)", tag: "GPU", supported: true, value: (d) => pct(gpuUtil(d), 0) },
  { key: "gpu.temp", cat: "gpu", label: "温度 (°C)", tag: "GPU", supported: true, value: (d) => { const t = d.gpu?.temperature ?? d.sensors?.gpuTemp ?? null; return t == null ? null : `${t.toFixed(0)}°`; } },
  { key: "gpu.power", cat: "gpu", label: "热功耗 (W)", tag: "GPU", supported: true, value: (d) => { const p = d.gpu?.powerUsageW ?? d.sensors?.gpuPower ?? null; return p == null ? null : `${p.toFixed(0)}W`; } },
  { key: "gpu.coreClock", cat: "gpu", label: "核心频率 (MHz)", tag: "GPU", supported: true, value: (d) => (d.gpu?.graphicsClock ? `${d.gpu.graphicsClock}MHz` : null) },
  { key: "gpu.memClock", cat: "gpu", label: "显存频率 (MHz)", tag: "VRAM", supported: true, value: (d) => (d.gpu?.memClock ? `${d.gpu.memClock}MHz` : null) },
  { key: "gpu.fan", cat: "gpu", label: "风扇转速 (%)", tag: "FAN", supported: true, value: (d) => pct(d.gpu?.fanSpeedPct, 0) },
  { key: "gpu.vramPct", cat: "gpu", label: "显存占用 (%)", tag: "VRAM", supported: true, value: (d) => { const g = d.gpu; if (!g || g.memTotalBytes <= 0) return null; return pct((g.memUsedBytes / g.memTotalBytes) * 100, 0); } },
  { key: "gpu.vramUsed", cat: "gpu", label: "显存占用量", tag: "VRAM", supported: true, value: (d) => (d.gpu && d.gpu.memTotalBytes > 0 ? `${formatBytes(d.gpu.memUsedBytes, 1)}` : null) },

  // Memory
  { key: "mem.util", cat: "mem", label: "占用率 (%)", tag: "RAM", supported: true, value: (d) => pct(memPct(d), 0) },
  { key: "mem.used", cat: "mem", label: "占用量", tag: "RAM", supported: true, value: (d) => (d.metrics ? `${formatBytes(d.metrics.memUsed, 1)}` : null) },

  // Disk
  { key: "disk.util", cat: "disk", label: "活动时间 (%)", tag: "DISK", supported: true, value: (d) => pct(d.sensors?.diskPct, 0) },
  { key: "disk.read", cat: "disk", label: "读取速度", tag: "R", supported: true, value: (d) => rate(d.sensors?.diskRead) },
  { key: "disk.write", cat: "disk", label: "写入速度", tag: "W", supported: true, value: (d) => rate(d.sensors?.diskWrite) },
];

/**
 * `show::*` layout-flag bits in `corepilot-osd-ipc` (the injected overlay reads
 * these from the shared block to decide which metric ROWS to draw). Must stay in
 * sync with the Rust `show` module.
 */
const OSD_SHOW_FLAGS = {
  fps: 1 << 0,
  frametime: 1 << 1,
  cpu: 1 << 2,
  gpu: 1 << 3,
  vram: 1 << 4,
  ram: 1 << 5,
  disk: 1 << 6,
  net: 1 << 7,
} as const;

/**
 * Derive the injected-overlay `layout_flags` bitfield from the user's selected
 * metric keys. The in-frame overlay groups metrics into rows (FPS, frame-time,
 * CPU, GPU, VRAM, RAM, disk, net), so any selected metric in a group lights that
 * group's bit. Frame-time/lows share the FRAMETIME row; VRAM keys map to VRAM.
 */
export function layoutFlagsFromMetrics(metrics: readonly string[]): number {
  let flags = 0;
  for (const key of metrics) {
    if (key === "fps") flags |= OSD_SHOW_FLAGS.fps;
    else if (key === "fps.frametime" || key === "fps.low1" || key === "fps.low01")
      flags |= OSD_SHOW_FLAGS.frametime;
    else if (key.startsWith("cpu.")) flags |= OSD_SHOW_FLAGS.cpu;
    else if (key === "gpu.vramPct" || key === "gpu.vramUsed" || key === "gpu.memClock")
      flags |= OSD_SHOW_FLAGS.vram;
    else if (key.startsWith("gpu.")) flags |= OSD_SHOW_FLAGS.gpu;
    else if (key.startsWith("mem.")) flags |= OSD_SHOW_FLAGS.ram;
    else if (key.startsWith("disk.")) flags |= OSD_SHOW_FLAGS.disk;
    else if (key.startsWith("net.")) flags |= OSD_SHOW_FLAGS.net;
  }
  return flags;
}

export const OSD_CATEGORIES: { id: OsdCategory; label: string }[] = [
  { id: "fps", label: "FPS" },
  { id: "cpu", label: "CPU" },
  { id: "gpu", label: "GPU" },
  { id: "mem", label: "内存" },
  { id: "disk", label: "硬盘" },
  { id: "net", label: "网络" },
];

/** Fixed display order for grouping in the overlay (one group per category). */
export const OSD_CATEGORY_ORDER: OsdCategory[] = ["fps", "cpu", "gpu", "mem", "disk", "net"];

/** Fetch one overlay snapshot. GPU info / FPS are only queried when a metric in
 *  that group is on (keeps overhead low when the user shows neither). */
export async function fetchOsdData(needGpu: boolean, needFps: boolean): Promise<OsdData> {
  const [metrics, sensors, gpu, fps] = await Promise.all([
    api.getMetrics().catch(() => null),
    api.getSensors().catch(() => null),
    needGpu ? api.gpuOcInfo().catch(() => null) : Promise.resolve(null),
    needFps ? api.osdFpsStats().catch(() => null) : Promise.resolve(null),
  ]);
  return { metrics, sensors, gpu, fps };
}

/** Absolute-position style for "free" placement. `x`/`y` are the plate's
 *  top-left position normalized to 0..1 of the viewport; the same mapping is
 *  used in the config preview and the live overlay so they stay consistent. */
export function freePosStyle(x: number, y: number): CSSProperties {
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const cx = clamp(x);
  const cy = clamp(y);
  return {
    position: "absolute",
    left: `${cx * 100}%`,
    top: `${cy * 100}%`,
    // Anchor proportionally so the plate stays fully inside the canvas at the
    // edges (plate-left = freeX·(boxW − plateW)) — matching how the live overlay
    // clamps freeX·monitorW into [0, monitorW − plateW].
    transform: `translate(${-cx * 100}%, ${-cy * 100}%)`,
  };
}
