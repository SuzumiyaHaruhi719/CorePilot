/**
 * Per-game performance session model + summary stats for the Monitor → 历史 report.
 *
 * The recorder (hooks/usePerfRecorder) samples these fields ~1 Hz while a
 * detected game runs; on game exit the session is summarized (avg/min/max FPS,
 * 1% / 0.1% low, avg frame time, avg/max temps & power) and persisted to
 * history (store/perfHistory). The sample fields mirror the GamePP CSV columns
 * that CorePilot can source.
 */

/** One ~1 Hz sample. Every metric is nullable — one the hardware doesn't expose
 *  stays null and is skipped in aggregates. */
export interface PerfSample {
  /** Milliseconds since session start. */
  t: number;
  fps: number | null;
  frametimeMs: number | null;
  cpuLoad: number | null;
  cpuTemp: number | null;
  cpuPower: number | null;
  cpuClock: number | null;
  gpuLoad: number | null;
  gpuTemp: number | null;
  gpuPower: number | null;
  gpuClock: number | null;
  vramLoad: number | null;
  memLoad: number | null;
}

export interface PerfSummary {
  avgFps: number | null;
  minFps: number | null;
  maxFps: number | null;
  /** 1% low FPS (1st-percentile of per-sample FPS). */
  low1: number | null;
  /** 0.1% low FPS (0.1th-percentile of per-sample FPS). */
  low01: number | null;
  avgFrametimeMs: number | null;
  avgCpuTemp: number | null;
  maxCpuTemp: number | null;
  avgCpuPower: number | null;
  avgCpuClock: number | null;
  avgGpuTemp: number | null;
  maxGpuTemp: number | null;
  avgGpuPower: number | null;
  avgGpuClock: number | null;
  avgGpuLoad: number | null;
}

export interface PerfSession {
  id: string;
  /** Lowercased exe, e.g. "subnautica2-win64-shipping.exe". */
  exe: string;
  /** Friendly display name (exe without extension). */
  name: string;
  /** Epoch ms. */
  startedAt: number;
  endedAt: number;
  durationSec: number;
  cpuName: string | null;
  gpuName: string | null;
  refreshHz: number | null;
  summary: PerfSummary;
  /** Time series for charts (downsampled to <= CHART_POINTS points). */
  samples: PerfSample[];
}

const isNum = (v: number | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v);

function avg(values: Array<number | null>): number | null {
  const xs = values.filter(isNum);
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function maxOf(values: Array<number | null>): number | null {
  const xs = values.filter(isNum);
  return xs.length ? Math.max(...xs) : null;
}
function minOf(values: Array<number | null>): number | null {
  const xs = values.filter(isNum);
  return xs.length ? Math.min(...xs) : null;
}
/** p-th percentile (0..100) of the values (ascending). */
function percentile(values: Array<number | null>, p: number): number | null {
  const xs = values.filter(isNum).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const idx = Math.round((p / 100) * (xs.length - 1));
  return xs[Math.min(xs.length - 1, Math.max(0, idx))];
}

/** Compute summary stats from the full (pre-downsample) sample set. */
export function summarize(samples: PerfSample[]): PerfSummary {
  const fps = samples.map((s) => s.fps);
  return {
    avgFps: avg(fps),
    minFps: minOf(fps),
    maxFps: maxOf(fps),
    // 1% / 0.1% low = low percentile of the per-second FPS distribution.
    low1: percentile(fps, 1),
    low01: percentile(fps, 0.1),
    avgFrametimeMs: avg(samples.map((s) => s.frametimeMs)),
    avgCpuTemp: avg(samples.map((s) => s.cpuTemp)),
    maxCpuTemp: maxOf(samples.map((s) => s.cpuTemp)),
    avgCpuPower: avg(samples.map((s) => s.cpuPower)),
    avgCpuClock: avg(samples.map((s) => s.cpuClock)),
    avgGpuTemp: avg(samples.map((s) => s.gpuTemp)),
    maxGpuTemp: maxOf(samples.map((s) => s.gpuTemp)),
    avgGpuPower: avg(samples.map((s) => s.gpuPower)),
    avgGpuClock: avg(samples.map((s) => s.gpuClock)),
    avgGpuLoad: avg(samples.map((s) => s.gpuLoad)),
  };
}

/** Max stored chart points per session (keeps persisted history small). */
export const CHART_POINTS = 600;

/** Uniformly downsample to at most `max` points (keeps the final point). */
export function downsample(samples: PerfSample[], max = CHART_POINTS): PerfSample[] {
  if (samples.length <= max) return samples;
  const step = samples.length / max;
  const out: PerfSample[] = [];
  for (let i = 0; i < max; i++) out.push(samples[Math.floor(i * step)]);
  out[out.length - 1] = samples[samples.length - 1];
  return out;
}

/** Strip the extension for a friendly display name. */
export function gameDisplayName(exe: string): string {
  return exe.replace(/\.exe$/i, "");
}
