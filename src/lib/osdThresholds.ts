import type { OsdData } from "./osd";

/**
 * Taskbar-monitor threshold helpers (LiteMonitor MetricUtils.GetState, v1).
 *
 * For the taskbar color skin each value is colored by a 3-state level — safe /
 * warn / crit — derived from a raw numeric reading and a pair of thresholds.
 * v1 covers the two threshold kinds LiteMonitor's light-theme panel exposes:
 * load% (CPU/GPU/mem/disk util, GPU fan) and temperature (CPU/GPU temp). All
 * other metrics (freq / power / RPM / FPS / byte-rates) render in the safe color.
 */

/** 0 = safe, 1 = warn, 2 = crit. Mirrors LiteMonitor's GetState ordering. */
export type OsdState = 0 | 1 | 2;

/** Port of LiteMonitor MetricUtils.GetState: crit wins, then warn, else safe.
 *  A missing / non-finite reading is treated as safe (nothing to flag). */
export function stateOf(
  v: number | null | undefined,
  warn: number,
  crit: number,
): OsdState {
  if (v == null || !isFinite(v)) return 0;
  if (v >= crit) return 2;
  if (v >= warn) return 1;
  return 0;
}

/** Which threshold pair a metric key uses, or null for "always safe". */
export type ThresholdKind = "load" | "temp" | null;

/** Map a metric key → threshold kind. Util/fan keys use the load thresholds;
 *  temperature keys use the temp thresholds; everything else has no thresholds. */
export function thresholdKind(key: string): ThresholdKind {
  if (key === "cpu.temp" || key === "gpu.temp") return "temp";
  if (
    key.endsWith(".util") ||
    key === "gpu.fan" ||
    key === "gpu.vramPct"
  )
    return "load";
  return null;
}

/** Raw numeric reading used by GetState for a metric key — the same underlying
 *  expressions the OSD_METRICS formatters use (without the unit formatting), so
 *  the colored state matches the displayed number. Returns null when the metric
 *  has no threshold kind or the reading is momentarily unavailable. */
export function rawOf(key: string, d: OsdData): number | null {
  switch (key) {
    case "cpu.util":
      return d.metrics?.cpuOverall ?? null;
    case "cpu.temp":
      return d.sensors?.cpuTemp ?? null;
    case "gpu.util":
      return d.gpu?.available ? d.gpu.utilizationGpu : (d.sensors?.gpuPct ?? null);
    case "gpu.temp":
      return d.gpu?.temperature ?? d.sensors?.gpuTemp ?? null;
    case "gpu.fan":
      return d.gpu?.fanSpeedPct ?? null;
    case "gpu.vramPct": {
      const g = d.gpu;
      if (!g || g.memTotalBytes <= 0) return null;
      return (g.memUsedBytes / g.memTotalBytes) * 100;
    }
    case "mem.util": {
      const m = d.metrics;
      if (!m || m.memTotal <= 0) return null;
      return (m.memUsed / m.memTotal) * 100;
    }
    case "disk.util":
      return d.sensors?.diskPct ?? null;
    default:
      return null;
  }
}
