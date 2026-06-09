/**
 * Per-game performance session model + summary stats for the Monitor → 历史 report.
 *
 * The recorder (hooks/usePerfRecorder) samples these fields at ~5 Hz while a
 * detected game runs; on game exit the session is summarized (avg/min/max FPS,
 * 1% / 0.1% low, avg frame time, avg/max temps & power, total energy & estimated
 * CO₂) and persisted to history (store/perfHistory). The sample fields mirror the
 * GamePP CSV columns that CorePilot can source. Metrics the hardware/driver does
 * not expose (CPU voltage, per-core temp, GPU hotspot/VRAM temp) are omitted
 * rather than fabricated.
 */

/** One ~5 Hz sample. Every metric is nullable — one the hardware doesn't expose
 *  stays null and is skipped in aggregates. Fields added after the initial
 *  release are optional so older persisted sessions keep loading. */
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
  // --- added fields (optional for back-compat with older saved sessions) ---
  /** GPU memory (VRAM) clock, MHz. */
  gpuMemClock?: number | null;
  /** GPU memory-controller utilization, %. */
  gpuMemCtrlLoad?: number | null;
  /** GPU fan speed, % of max. */
  gpuFan?: number | null;
  /** Disk active time, %. */
  diskLoad?: number | null;
  /** Disk read throughput, bytes/s. */
  diskRead?: number | null;
  /** Disk write throughput, bytes/s. */
  diskWrite?: number | null;
  /** Network download throughput, bytes/s. */
  netDown?: number | null;
  /** Network upload throughput, bytes/s. */
  netUp?: number | null;
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
  avgCpuLoad: number | null;
  avgCpuTemp: number | null;
  maxCpuTemp: number | null;
  avgCpuPower: number | null;
  maxCpuPower: number | null;
  avgCpuClock: number | null;
  avgGpuLoad: number | null;
  avgGpuTemp: number | null;
  maxGpuTemp: number | null;
  avgGpuPower: number | null;
  maxGpuPower: number | null;
  avgGpuClock: number | null;
  avgVramLoad: number | null;
  maxVramLoad: number | null;
  avgMemLoad: number | null;
  /** Total electrical energy CPU+GPU drew over the session, watt-hours. */
  energyWh: number | null;
  /** Estimated CO₂ from `energyWh`, kilograms (see CO2_KG_PER_KWH). */
  co2Kg: number | null;
}

export interface PerfSession {
  id: string;
  /** Lowercased exe, e.g. "subnautica2-win64-shipping.exe". */
  exe: string;
  /** Friendly display name (exe without extension). */
  name: string;
  /** Full executable path (history-card icon + report path display), or null. */
  path: string | null;
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

function avg(values: Array<number | null | undefined>): number | null {
  const xs = values.filter(isNum);
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function maxOf(values: Array<number | null | undefined>): number | null {
  const xs = values.filter(isNum);
  return xs.length ? Math.max(...xs) : null;
}
function minOf(values: Array<number | null | undefined>): number | null {
  const xs = values.filter(isNum);
  return xs.length ? Math.min(...xs) : null;
}
/** p-th percentile (0..100) of the values (ascending). */
function percentile(values: Array<number | null | undefined>, p: number): number | null {
  const xs = values.filter(isNum).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const idx = Math.round((p / 100) * (xs.length - 1));
  return xs[Math.min(xs.length - 1, Math.max(0, idx))];
}

/**
 * Grid carbon-intensity factor used to estimate the CO₂ of the energy a session
 * drew. ≈ 0.55 kg CO₂ per kWh is a representative figure for the China grid mix;
 * it is an ESTIMATE only (real intensity varies by region, time, and source) and
 * is surfaced as such in the UI.
 */
export const CO2_KG_PER_KWH = 0.55;

/** Wh → kWh. */
const WH_PER_KWH = 1000;
/** ms → hours, for power(W)·time → energy(Wh). */
const MS_PER_HOUR = 3_600_000;

/**
 * Integrate instantaneous CPU+GPU power (watts) over the session to total energy
 * in watt-hours, using the trapezoidal rule on each sample's real timestamp `t`.
 *
 * Working from `t` (not an assumed fixed cadence) keeps the result correct after
 * `downsample` and across any sampling-rate change. A sample contributes only the
 * power channels it actually has; if neither CPU nor GPU power is present for an
 * interval, that interval is skipped (so partial telemetry under-reports rather
 * than fabricating zeros). Returns null when no interval had any power data.
 */
function computeEnergyWh(samples: PerfSample[]): number | null {
  if (samples.length < 2) return null;
  let wh = 0;
  let any = false;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    const dtMs = b.t - a.t;
    if (!Number.isFinite(dtMs) || dtMs <= 0) continue;
    const pa = sumPower(a);
    const pb = sumPower(b);
    if (pa == null && pb == null) continue;
    // Trapezoid; if one endpoint lacks power, treat the interval as flat at the
    // endpoint that has it (avoids dropping otherwise-valid intervals).
    const avgW = pa != null && pb != null ? (pa + pb) / 2 : (pa ?? pb)!;
    wh += avgW * (dtMs / MS_PER_HOUR);
    any = true;
  }
  return any ? wh : null;
}

/** Sum the CPU + GPU power channels a sample has (null if it has neither). */
function sumPower(s: PerfSample): number | null {
  const cpu = isNum(s.cpuPower) ? s.cpuPower : null;
  const gpu = isNum(s.gpuPower) ? s.gpuPower : null;
  if (cpu == null && gpu == null) return null;
  return (cpu ?? 0) + (gpu ?? 0);
}

/** Compute summary stats from the full (pre-downsample) sample set. */
export function summarize(samples: PerfSample[]): PerfSummary {
  const fps = samples.map((s) => s.fps);
  const energyWh = computeEnergyWh(samples);
  const co2Kg = energyWh != null ? (energyWh / WH_PER_KWH) * CO2_KG_PER_KWH : null;
  return {
    avgFps: avg(fps),
    minFps: minOf(fps),
    maxFps: maxOf(fps),
    // 1% / 0.1% low = low percentile of the per-sample FPS distribution.
    low1: percentile(fps, 1),
    low01: percentile(fps, 0.1),
    avgFrametimeMs: avg(samples.map((s) => s.frametimeMs)),
    avgCpuLoad: avg(samples.map((s) => s.cpuLoad)),
    avgCpuTemp: avg(samples.map((s) => s.cpuTemp)),
    maxCpuTemp: maxOf(samples.map((s) => s.cpuTemp)),
    avgCpuPower: avg(samples.map((s) => s.cpuPower)),
    maxCpuPower: maxOf(samples.map((s) => s.cpuPower)),
    avgCpuClock: avg(samples.map((s) => s.cpuClock)),
    avgGpuLoad: avg(samples.map((s) => s.gpuLoad)),
    avgGpuTemp: avg(samples.map((s) => s.gpuTemp)),
    maxGpuTemp: maxOf(samples.map((s) => s.gpuTemp)),
    avgGpuPower: avg(samples.map((s) => s.gpuPower)),
    maxGpuPower: maxOf(samples.map((s) => s.gpuPower)),
    avgGpuClock: avg(samples.map((s) => s.gpuClock)),
    avgVramLoad: avg(samples.map((s) => s.vramLoad)),
    maxVramLoad: maxOf(samples.map((s) => s.vramLoad)),
    avgMemLoad: avg(samples.map((s) => s.memLoad)),
    energyWh,
    co2Kg,
  };
}

/** Max stored chart points per session (keeps persisted history small while
 *  retaining enough resolution for smooth curves at 5 Hz). */
const CHART_POINTS = 1200;

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
