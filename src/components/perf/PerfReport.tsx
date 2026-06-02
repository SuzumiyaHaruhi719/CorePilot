import { motion } from "motion/react";
import { Activity, Cpu, Database, Gauge, MonitorPlay, Timer } from "lucide-react";
import type { ReactNode } from "react";
import { gameDisplayName, type PerfSession, type PerfSummary } from "../../lib/perf";
import { TimeSeriesChart } from "./TimeSeriesChart";

/**
 * GamePP-style report for one finished perf session: a header (game name, the
 * localized run window + duration, data-point count, CPU/GPU/refresh), a summary
 * stat grid derived from `session.summary`, and two time-series charts (FPS and
 * frame time over the session). All metrics fall back to "—" when null.
 */

const DASH = "—";

/** mm:ss for a duration in seconds. */
function fmtDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Localized "YYYY/M/D HH:mm:ss" for an epoch-ms timestamp. */
function fmtDateTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Round a nullable number to `digits` decimals, or DASH when null. */
function num(v: number | null, digits = 0): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  return v.toFixed(digits);
}

interface StatDef {
  label: string;
  key: keyof PerfSummary;
  digits: number;
  unit?: string;
  hue: number;
}

/** Summary grid layout — order, units, decimals, and accent hue per stat. */
const STATS: StatDef[] = [
  { label: "平均 FPS", key: "avgFps", digits: 0, hue: 158 },
  { label: "最低 FPS", key: "minFps", digits: 0, hue: 22 },
  { label: "最高 FPS", key: "maxFps", digits: 0, hue: 200 },
  { label: "1% Low", key: "low1", digits: 0, hue: 85 },
  { label: "0.1% Low", key: "low01", digits: 0, hue: 60 },
  { label: "平均帧时间", key: "avgFrametimeMs", digits: 1, unit: "ms", hue: 224 },
  { label: "平均 CPU 温度", key: "avgCpuTemp", digits: 0, unit: "°C", hue: 280 },
  { label: "最高 CPU 温度", key: "maxCpuTemp", digits: 0, unit: "°C", hue: 22 },
  { label: "平均 CPU 功耗", key: "avgCpuPower", digits: 0, unit: "W", hue: 75 },
  { label: "平均 GPU 温度", key: "avgGpuTemp", digits: 0, unit: "°C", hue: 184 },
  { label: "最高 GPU 温度", key: "maxGpuTemp", digits: 0, unit: "°C", hue: 22 },
  { label: "平均 GPU 功耗", key: "avgGpuPower", digits: 0, unit: "W", hue: 75 },
  { label: "平均 GPU 频率", key: "avgGpuClock", digits: 0, unit: "MHz", hue: 262 },
  { label: "平均 GPU 占用", key: "avgGpuLoad", digits: 0, unit: "%", hue: 158 },
];

function StatCell({ stat, value }: { stat: StatDef; value: number | null }) {
  const empty = value == null || !Number.isFinite(value);
  return (
    <div className="rounded-xl border border-line bg-surface2/40 px-3 py-2.5">
      <div className="text-[10.5px] uppercase tracking-wide text-dim">{stat.label}</div>
      <div className="nums mt-0.5 flex items-baseline gap-1">
        <span
          className="text-[20px] font-semibold leading-none"
          style={{ color: empty ? "var(--color-dim)" : `oklch(82% 0.13 ${stat.hue})` }}
        >
          {num(value, stat.digits)}
        </span>
        {!empty && stat.unit && <span className="text-[10.5px] font-normal text-dim">{stat.unit}</span>}
      </div>
    </div>
  );
}

function MetaItem({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="shrink-0 text-dim">{icon}</span>
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-wide text-dim">{label}</div>
        <div className="truncate text-[12px] font-medium text-ink" title={value}>
          {value}
        </div>
      </div>
    </div>
  );
}

interface ChartPanelProps {
  icon: ReactNode;
  title: string;
  values: Array<number | null>;
  hue: number;
  unit: string;
  digits: number;
  refLines: Array<{ value: number; label: string; muted?: boolean }>;
  zeroFloor?: boolean;
}

function ChartPanel({ icon, title, values, hue, unit, digits, refLines, zeroFloor }: ChartPanelProps) {
  const format = (v: number) => `${v.toFixed(digits)}${unit}`;
  return (
    <div className="rounded-2xl border border-line bg-surface2/40 p-4">
      <div className="mb-2 flex items-center gap-2 text-[12.5px] font-semibold text-muted">
        <span style={{ color: `oklch(80% 0.13 ${hue})` }}>{icon}</span> {title}
      </div>
      <TimeSeriesChart values={values} hue={hue} format={format} refLines={refLines} zeroFloor={zeroFloor} />
    </div>
  );
}

export function PerfReport({ session }: { session: PerfSession }) {
  const { summary, samples } = session;

  const fpsValues = samples.map((s) => s.fps);
  const frametimeValues = samples.map((s) => s.frametimeMs);

  // FPS reference lines: avg (bright) + min/max (muted).
  const fpsRefs = [
    summary.avgFps != null && { value: summary.avgFps, label: "平均" },
    summary.minFps != null && { value: summary.minFps, label: "最低", muted: true },
    summary.maxFps != null && { value: summary.maxFps, label: "最高", muted: true },
  ].filter((r): r is { value: number; label: string; muted?: boolean } => Boolean(r));

  // Frame time: just the average reference (lower is better).
  const frametimeRefs = [
    summary.avgFrametimeMs != null && { value: summary.avgFrametimeMs, label: "平均" },
  ].filter((r): r is { value: number; label: string; muted?: boolean } => Boolean(r));

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
      className="space-y-4"
    >
      {/* Header */}
      <div className="glass hairline rounded-2xl p-4">
        <div className="flex items-start gap-3.5">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl grad-accent glow text-white">
            <Gauge size={22} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[17px] font-semibold leading-tight text-ink" title={gameDisplayName(session.exe)}>
              {gameDisplayName(session.exe)}
            </h2>
            <p className="nums mt-0.5 text-[12px] text-muted">
              {fmtDateTime(session.startedAt)} → {fmtDateTime(session.endedAt)} · {fmtDuration(session.durationSec)}
            </p>
          </div>
        </div>

        <div className="mt-3.5 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-line pt-3.5 sm:grid-cols-4">
          <MetaItem icon={<Database size={14} />} label="数据点" value={`${samples.length}`} />
          <MetaItem icon={<Cpu size={14} />} label="CPU" value={session.cpuName ?? DASH} />
          <MetaItem icon={<MonitorPlay size={14} />} label="GPU" value={session.gpuName ?? DASH} />
          <MetaItem
            icon={<MonitorPlay size={14} />}
            label="刷新率"
            value={session.refreshHz != null ? `${session.refreshHz} Hz` : DASH}
          />
        </div>
      </div>

      {/* Summary stat grid */}
      <div className="glass hairline rounded-2xl p-4">
        <div className="mb-3 flex items-center gap-2 text-[12.5px] font-semibold text-muted">
          <Activity size={15} className="text-accent" /> 性能汇总
        </div>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
          {STATS.map((stat) => (
            <StatCell key={stat.key} stat={stat} value={summary[stat.key]} />
          ))}
        </div>
      </div>

      {/* Time-series charts */}
      <div className="glass hairline space-y-4 rounded-2xl p-4">
        <ChartPanel
          icon={<Gauge size={15} />}
          title="FPS"
          values={fpsValues}
          hue={158}
          unit=""
          digits={0}
          refLines={fpsRefs}
          zeroFloor
        />
        <ChartPanel
          icon={<Timer size={15} />}
          title="帧时间 (ms)"
          values={frametimeValues}
          hue={224}
          unit=" ms"
          digits={1}
          refLines={frametimeRefs}
        />
      </div>
    </motion.div>
  );
}
