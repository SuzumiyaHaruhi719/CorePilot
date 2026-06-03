import { motion } from "motion/react";
import { Activity, ChevronDown, Cpu, Database, Gauge, Leaf, MonitorPlay, Timer, Zap } from "lucide-react";
import { useCallback, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { formatBytes } from "../../lib/format";
import {
  CO2_KG_PER_KWH,
  gameDisplayName,
  type PerfSample,
  type PerfSession,
  type PerfSummary,
} from "../../lib/perf";
import { TimeSeriesChart, type RefLine } from "./TimeSeriesChart";
import { DualAxisChart } from "./DualAxisChart";

/**
 * GamePP-style report for one finished perf session.
 *
 * Layout: a header (game, run window + duration, data-point count, CPU/GPU/
 * refresh), headline cards for energy (用电量, kWh) + estimated CO₂ (二氧化碳排放量),
 * a summary stat grid, and a column of synced time-series charts — one per metric
 * CorePilot can capture. Hovering any chart drops a vertical crosshair on every
 * chart at the same timestamp and shows a floating tooltip with the full hardware
 * readout at that instant. Metrics with no data render as "—" / are skipped.
 */

const DASH = "—";

const isNum = (v: number | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v);

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
function num(v: number | null | undefined, digits = 0): string {
  if (!isNum(v)) return DASH;
  return v.toFixed(digits);
}

/** Energy headline: show kWh once it crosses 1 kWh, else Wh. */
function fmtEnergy(wh: number | null | undefined): { value: string; unit: string } {
  if (!isNum(wh)) return { value: DASH, unit: "" };
  if (wh >= 1000) return { value: (wh / 1000).toFixed(3), unit: "kWh" };
  return { value: wh.toFixed(1), unit: "Wh" };
}

/** CO₂ headline: g below 1 kg, else kg. */
function fmtCo2(kg: number | null | undefined): { value: string; unit: string } {
  if (!isNum(kg)) return { value: DASH, unit: "" };
  if (kg < 1) return { value: (kg * 1000).toFixed(0), unit: "g" };
  return { value: kg.toFixed(3), unit: "kg" };
}

// ── Summary stat grid ───────────────────────────────────────────────────────

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
  { label: "平均 CPU 占用", key: "avgCpuLoad", digits: 0, unit: "%", hue: 200 },
  { label: "平均 CPU 温度", key: "avgCpuTemp", digits: 0, unit: "°C", hue: 280 },
  { label: "最高 CPU 温度", key: "maxCpuTemp", digits: 0, unit: "°C", hue: 22 },
  { label: "平均 CPU 功耗", key: "avgCpuPower", digits: 0, unit: "W", hue: 75 },
  { label: "平均 GPU 占用", key: "avgGpuLoad", digits: 0, unit: "%", hue: 158 },
  { label: "平均 GPU 温度", key: "avgGpuTemp", digits: 0, unit: "°C", hue: 184 },
  { label: "最高 GPU 温度", key: "maxGpuTemp", digits: 0, unit: "°C", hue: 22 },
  { label: "平均 GPU 功耗", key: "avgGpuPower", digits: 0, unit: "W", hue: 75 },
  { label: "平均 GPU 频率", key: "avgGpuClock", digits: 0, unit: "MHz", hue: 262 },
  { label: "平均显存占用", key: "avgVramLoad", digits: 0, unit: "%", hue: 300 },
  { label: "平均内存占用", key: "avgMemLoad", digits: 0, unit: "%", hue: 330 },
];

function StatCell({ stat, value }: { stat: StatDef; value: number | null }) {
  const empty = !isNum(value);
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

function HeadlineCard({
  icon,
  label,
  value,
  unit,
  hue,
  sub,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  unit: string;
  hue: number;
  sub?: string;
}) {
  const empty = value === DASH;
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-line bg-surface2/40 px-4 py-3">
      <span
        className="grid h-10 w-10 shrink-0 place-items-center rounded-xl"
        style={{ background: `oklch(70% 0.13 ${hue} / 0.16)`, color: `oklch(82% 0.13 ${hue})` }}
      >
        {icon}
      </span>
      <div className="min-w-0">
        <div className="text-[10.5px] uppercase tracking-wide text-dim">{label}</div>
        <div className="nums flex items-baseline gap-1">
          <span
            className="text-[22px] font-semibold leading-none"
            style={{ color: empty ? "var(--color-dim)" : `oklch(84% 0.13 ${hue})` }}
          >
            {value}
          </span>
          {!empty && <span className="text-[12px] font-normal text-dim">{unit}</span>}
        </div>
        {sub && <div className="mt-0.5 text-[10px] text-dim">{sub}</div>}
      </div>
    </div>
  );
}

// ── Chart catalog ────────────────────────────────────────────────────────────

interface ChartDef {
  key: string;
  title: string;
  icon: ReactNode;
  hue: number;
  unit: string;
  digits: number;
  /** Extract this metric's series from the samples. */
  pick: (s: PerfSample) => number | null;
  /** Reference-line summary keys: [avg, min?, max?]. */
  refs?: { avg?: keyof PerfSummary; min?: keyof PerfSummary; max?: keyof PerfSummary };
  /** Pin y-floor to 0 (counts/percentages); temps/clocks auto-fit. */
  zeroFloor?: boolean;
  /** Per-sample tooltip formatter (defaults to value + unit). */
  fmt?: (v: number) => string;
}

const rate = (v: number): string => `${formatBytes(v, v < 1024 * 1024 ? 0 : 1)}/s`;

/** Master metric list — drives the charts AND the hover tooltip rows, so the two
 *  always stay in sync. Charts whose series is entirely null are skipped. */
const CHARTS: ChartDef[] = [
  { key: "fps", title: "FPS", icon: <Gauge size={15} />, hue: 158, unit: "", digits: 0, pick: (s) => s.fps, refs: { avg: "avgFps", min: "minFps", max: "maxFps" }, zeroFloor: true },
  { key: "ft", title: "帧时间", icon: <Timer size={15} />, hue: 224, unit: " ms", digits: 1, pick: (s) => s.frametimeMs, refs: { avg: "avgFrametimeMs" } },
  { key: "cpuLoad", title: "CPU 占用", icon: <Cpu size={15} />, hue: 200, unit: "%", digits: 0, pick: (s) => s.cpuLoad, refs: { avg: "avgCpuLoad" }, zeroFloor: true },
  { key: "cpuTemp", title: "CPU 温度", icon: <Cpu size={15} />, hue: 280, unit: "°C", digits: 0, pick: (s) => s.cpuTemp, refs: { avg: "avgCpuTemp", max: "maxCpuTemp" } },
  { key: "cpuPower", title: "CPU 功耗", icon: <Cpu size={15} />, hue: 75, unit: " W", digits: 0, pick: (s) => s.cpuPower, refs: { avg: "avgCpuPower", max: "maxCpuPower" }, zeroFloor: true },
  { key: "cpuClock", title: "CPU 频率", icon: <Cpu size={15} />, hue: 262, unit: " MHz", digits: 0, pick: (s) => s.cpuClock, refs: { avg: "avgCpuClock" } },
  { key: "gpuLoad", title: "GPU 占用", icon: <MonitorPlay size={15} />, hue: 158, unit: "%", digits: 0, pick: (s) => s.gpuLoad, refs: { avg: "avgGpuLoad" }, zeroFloor: true },
  { key: "gpuTemp", title: "GPU 温度", icon: <MonitorPlay size={15} />, hue: 184, unit: "°C", digits: 0, pick: (s) => s.gpuTemp, refs: { avg: "avgGpuTemp", max: "maxGpuTemp" } },
  { key: "gpuPower", title: "GPU 功耗", icon: <MonitorPlay size={15} />, hue: 75, unit: " W", digits: 0, pick: (s) => s.gpuPower, refs: { avg: "avgGpuPower", max: "maxGpuPower" }, zeroFloor: true },
  { key: "totalPower", title: "总功耗 (CPU+GPU)", icon: <Zap size={15} />, hue: 50, unit: " W", digits: 0, pick: (s) => totalPower(s), zeroFloor: true },
  { key: "gpuClock", title: "GPU 核心频率", icon: <MonitorPlay size={15} />, hue: 262, unit: " MHz", digits: 0, pick: (s) => s.gpuClock, refs: { avg: "avgGpuClock" } },
  { key: "gpuMemClock", title: "显存频率", icon: <Database size={15} />, hue: 300, unit: " MHz", digits: 0, pick: (s) => s.gpuMemClock ?? null },
  { key: "gpuMemCtrl", title: "显存控制器占用", icon: <Database size={15} />, hue: 300, unit: "%", digits: 0, pick: (s) => s.gpuMemCtrlLoad ?? null, zeroFloor: true },
  { key: "vram", title: "显存占用", icon: <Database size={15} />, hue: 300, unit: "%", digits: 0, pick: (s) => s.vramLoad, refs: { avg: "avgVramLoad", max: "maxVramLoad" }, zeroFloor: true },
  { key: "gpuFan", title: "GPU 风扇", icon: <Activity size={15} />, hue: 200, unit: "%", digits: 0, pick: (s) => s.gpuFan ?? null, zeroFloor: true },
  { key: "mem", title: "内存占用", icon: <Database size={15} />, hue: 330, unit: "%", digits: 0, pick: (s) => s.memLoad, refs: { avg: "avgMemLoad" }, zeroFloor: true },
  { key: "disk", title: "磁盘活动", icon: <Activity size={15} />, hue: 50, unit: "%", digits: 0, pick: (s) => s.diskLoad ?? null, zeroFloor: true },
  { key: "diskRW", title: "磁盘读写", icon: <Activity size={15} />, hue: 50, unit: "", digits: 0, pick: (s) => maxNullable(s.diskRead, s.diskWrite), zeroFloor: true, fmt: rate },
];

/** Larger of two nullable values (for the combined disk R/W chart). */
function maxNullable(a: number | null | undefined, b: number | null | undefined): number | null {
  const xs = [a, b].filter(isNum);
  return xs.length ? Math.max(...xs) : null;
}

/** Total system power for a sample = CPU + GPU watts. Null only when BOTH are
 *  missing; if one is present the other counts as 0 (matches the live 总功耗 card). */
function totalPower(s: PerfSample): number | null {
  const c = isNum(s.cpuPower) ? s.cpuPower : null;
  const g = isNum(s.gpuPower) ? s.gpuPower : null;
  if (c == null && g == null) return null;
  return (c ?? 0) + (g ?? 0);
}

/** Build avg/min/max reference lines for a chart from the session summary. */
function buildRefs(summary: PerfSummary, def: ChartDef): RefLine[] {
  const out: RefLine[] = [];
  const r = def.refs;
  if (!r) return out;
  if (r.avg && isNum(summary[r.avg])) out.push({ value: summary[r.avg] as number, label: "平均" });
  if (r.min && isNum(summary[r.min])) out.push({ value: summary[r.min] as number, label: "最低", muted: true });
  if (r.max && isNum(summary[r.max])) out.push({ value: summary[r.max] as number, label: "最高", muted: true });
  return out;
}

interface ChartPanelProps {
  def: ChartDef;
  timesSec: number[];
  values: Array<number | null>;
  refLines: RefLine[];
  syncKey: string;
  onHover: (idx: number | null) => void;
}

function ChartPanel({ def, timesSec, values, refLines, syncKey, onHover }: ChartPanelProps) {
  const fmt = def.fmt ?? ((v: number) => `${v.toFixed(def.digits)}${def.unit}`);
  return (
    <div className="rounded-2xl border border-line bg-surface2/40 p-4">
      <div className="mb-2 flex items-center gap-2 text-[12.5px] font-semibold text-muted">
        <span style={{ color: `oklch(80% 0.13 ${def.hue})` }}>{def.icon}</span> {def.title}
      </div>
      <TimeSeriesChart
        timesSec={timesSec}
        values={values}
        hue={def.hue}
        format={fmt}
        refLines={refLines}
        zeroFloor={def.zeroFloor}
        syncKey={syncKey}
        onHover={onHover}
      />
    </div>
  );
}

// ── Featured (big) chart with metric switcher ────────────────────────────────

/** avg / min / max for a metric series (null samples skipped). */
function seriesStats(values: Array<number | null>): {
  avg: number | null;
  min: number | null;
  max: number | null;
} {
  let sum = 0;
  let n = 0;
  let mn = Infinity;
  let mx = -Infinity;
  for (const v of values) {
    if (!isNum(v)) continue;
    sum += v;
    n += 1;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  if (n === 0) return { avg: null, min: null, max: null };
  return { avg: sum / n, min: mn, max: mx };
}

/** One labelled readout in the featured chart's side panel. */
function FeaturedStat({ label, value, hue }: { label: string; value: string; hue: number }) {
  const empty = value === DASH;
  return (
    <div className="flex items-baseline justify-between gap-2 rounded-lg border border-line bg-surface2/40 px-2.5 py-1.5 lg:flex-col lg:items-start lg:gap-0.5">
      <span className="text-[10px] uppercase tracking-wide text-dim">{label}</span>
      <span
        className="nums text-[15px] font-semibold leading-none"
        style={{ color: empty ? "var(--color-dim)" : `oklch(82% 0.13 ${hue})` }}
      >
        {value}
      </span>
    </div>
  );
}

interface FeaturedChartProps {
  /** Pre-extracted per-metric series (same objects the small grid renders). */
  series: Array<{ def: ChartDef; values: Array<number | null>; hasData: boolean }>;
  summary: PerfSummary;
  timesSec: number[];
  syncKey: string;
  onHover: (idx: number | null) => void;
  /** The currently hovered sample (drives the live headline value), or null. */
  hovered: PerfSample | null;
}

/**
 * GamePP-style headline chart: one large time-series the user switches between
 * metrics via a dropdown. Reuses the shared `CHARTS` catalog, joins the same
 * synced-cursor group as the small grid (so the crosshair tracks across all
 * charts), and shows a live "当前" value while hovering (else the average). The
 * side panel lists avg/max/min — plus 1% / 0.1% lows for FPS.
 */
function FeaturedChart({ series, summary, timesSec, syncKey, onHover, hovered }: FeaturedChartProps) {
  // Only metrics that actually captured data are selectable.
  const selectable = useMemo(() => series.filter((s) => s.hasData), [series]);
  const [key, setKey] = useState<string>("fps");
  // Resolve the selection; fall back to the first available metric if the chosen
  // one (default "fps") has no data this session.
  const cur = selectable.find((s) => s.def.key === key) ?? selectable[0];
  const values = cur?.values ?? [];
  const stats = useMemo(() => seriesStats(values), [values]);

  if (!cur) return null; // nothing captured at all
  const def = cur.def;
  const fmt = def.fmt ?? ((v: number) => `${v.toFixed(def.digits)}${def.unit}`);
  const fmtOrDash = (v: number | null) => (isNum(v) ? fmt(v) : DASH);

  // Headline reflects the cursor while hovering, else the session average.
  const hoverVal = hovered ? def.pick(hovered) : null;
  const live = isNum(hoverVal);
  const headlineVal = live ? hoverVal : stats.avg;
  const isFps = def.key === "fps";

  return (
    <div className="glass hairline rounded-2xl p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="relative">
          <select
            value={def.key}
            onChange={(e) => setKey(e.target.value)}
            style={{ colorScheme: "dark" }}
            className="appearance-none rounded-lg border border-line bg-surface2 py-1.5 pl-3 pr-9 text-[13px] font-semibold text-ink outline-none transition-colors hover:border-line-strong focus:border-accent"
          >
            {selectable.map((s) => (
              <option key={s.def.key} value={s.def.key}>
                {s.def.title}
              </option>
            ))}
          </select>
          <ChevronDown
            size={15}
            className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-dim"
          />
        </div>
        <div className="nums flex items-baseline gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-dim">{live ? "当前" : "平均"}</span>
          <span
            className="text-[26px] font-semibold leading-none"
            style={{ color: `oklch(84% 0.13 ${def.hue})` }}
          >
            {fmtOrDash(headlineVal)}
          </span>
        </div>
      </div>

      {/* Grid (not flex) so the chart column is `minmax(0,1fr)` — a constrained,
          shrinkable width. uPlot sizes its canvas to an explicit pixel width, which
          would blow out a flex-1 column (canvas overflow feeds back into layout);
          the minmax track pins it the way the small-chart grid + host layout do. */}
      <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_10rem]">
        <div className="min-w-0">
          <TimeSeriesChart
            timesSec={timesSec}
            values={values}
            hue={def.hue}
            format={fmt}
            refLines={buildRefs(summary, def)}
            zeroFloor={def.zeroFloor}
            height={280}
            syncKey={syncKey}
            onHover={onHover}
          />
        </div>
        <div className="flex flex-row flex-wrap gap-2 lg:flex-col">
          <FeaturedStat label="平均" value={fmtOrDash(stats.avg)} hue={def.hue} />
          <FeaturedStat label="最高" value={fmtOrDash(stats.max)} hue={22} />
          <FeaturedStat label="最低" value={fmtOrDash(stats.min)} hue={200} />
          {isFps && (
            <>
              <FeaturedStat label="1% Low" value={fmtOrDash(summary.low1)} hue={85} />
              <FeaturedStat label="0.1% Low" value={fmtOrDash(summary.low01)} hue={60} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Hover tooltip ────────────────────────────────────────────────────────────

/** Rows shown in the floating tooltip — same catalog as the charts, plus the
 *  metrics that don't get their own chart (kept terse). */
interface TooltipRow {
  label: string;
  hue: number;
  fmt: (s: PerfSample) => string | null;
}

const TOOLTIP_ROWS: TooltipRow[] = [
  { label: "FPS", hue: 158, fmt: (s) => (isNum(s.fps) ? s.fps.toFixed(0) : null) },
  { label: "帧时间", hue: 224, fmt: (s) => (isNum(s.frametimeMs) ? `${s.frametimeMs.toFixed(1)} ms` : null) },
  { label: "CPU 占用", hue: 200, fmt: (s) => (isNum(s.cpuLoad) ? `${s.cpuLoad.toFixed(0)}%` : null) },
  { label: "CPU 温度", hue: 280, fmt: (s) => (isNum(s.cpuTemp) ? `${s.cpuTemp.toFixed(0)}°C` : null) },
  { label: "CPU 功耗", hue: 75, fmt: (s) => (isNum(s.cpuPower) ? `${s.cpuPower.toFixed(0)} W` : null) },
  { label: "CPU 频率", hue: 262, fmt: (s) => (isNum(s.cpuClock) ? `${Math.round(s.cpuClock)} MHz` : null) },
  { label: "GPU 占用", hue: 158, fmt: (s) => (isNum(s.gpuLoad) ? `${s.gpuLoad.toFixed(0)}%` : null) },
  { label: "GPU 温度", hue: 184, fmt: (s) => (isNum(s.gpuTemp) ? `${s.gpuTemp.toFixed(0)}°C` : null) },
  { label: "GPU 功耗", hue: 75, fmt: (s) => (isNum(s.gpuPower) ? `${s.gpuPower.toFixed(0)} W` : null) },
  { label: "总功耗", hue: 50, fmt: (s) => { const v = totalPower(s); return isNum(v) ? `${v.toFixed(0)} W` : null; } },
  { label: "GPU 频率", hue: 262, fmt: (s) => (isNum(s.gpuClock) ? `${s.gpuClock} MHz` : null) },
  { label: "显存频率", hue: 300, fmt: (s) => (isNum(s.gpuMemClock) ? `${s.gpuMemClock} MHz` : null) },
  { label: "显存控制器", hue: 300, fmt: (s) => (isNum(s.gpuMemCtrlLoad) ? `${s.gpuMemCtrlLoad.toFixed(0)}%` : null) },
  { label: "显存占用", hue: 300, fmt: (s) => (isNum(s.vramLoad) ? `${s.vramLoad.toFixed(0)}%` : null) },
  { label: "GPU 风扇", hue: 200, fmt: (s) => (isNum(s.gpuFan) ? `${s.gpuFan.toFixed(0)}%` : null) },
  { label: "内存占用", hue: 330, fmt: (s) => (isNum(s.memLoad) ? `${s.memLoad.toFixed(0)}%` : null) },
  { label: "磁盘活动", hue: 50, fmt: (s) => (isNum(s.diskLoad) ? `${s.diskLoad.toFixed(0)}%` : null) },
  { label: "磁盘读", hue: 50, fmt: (s) => (isNum(s.diskRead) ? rate(s.diskRead) : null) },
  { label: "磁盘写", hue: 50, fmt: (s) => (isNum(s.diskWrite) ? rate(s.diskWrite) : null) },
  { label: "下载", hue: 224, fmt: (s) => (isNum(s.netDown) ? rate(s.netDown) : null) },
  { label: "上传", hue: 224, fmt: (s) => (isNum(s.netUp) ? rate(s.netUp) : null) },
];

/** Localized elapsed time label "m:ss" for the tooltip header. */
function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function PerfReport({ session }: { session: PerfSession }) {
  const { summary, samples } = session;
  const syncKey = useId();
  const wrapRef = useRef<HTMLDivElement>(null);

  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  // Cursor position (CSS px, relative to the charts wrapper) for tooltip placement.
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);

  // Shared x-axis: elapsed seconds for every sample.
  const timesSec = useMemo(() => samples.map((s) => s.t / 1000), [samples]);

  // Pre-extract each chart's series once; decide which charts have data.
  const series = useMemo(
    () =>
      CHARTS.map((def) => {
        const values = samples.map((s) => def.pick(s));
        return { def, values, hasData: values.some(isNum) };
      }),
    [samples],
  );

  // Network up/down as separate series for the dual-axis 网络 panel (it shows two
  // scales in one chart, so it isn't part of the single-series CHARTS catalog).
  const netUp = useMemo(() => samples.map((s) => s.netUp ?? null), [samples]);
  const netDown = useMemo(() => samples.map((s) => s.netDown ?? null), [samples]);
  const hasNet = useMemo(() => netUp.some(isNum) || netDown.some(isNum), [netUp, netDown]);

  const onHover = useCallback((idx: number | null) => setHoverIdx(idx), []);

  // Track the pointer over the charts column so the tooltip can follow it.
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setCursor({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  }, []);
  const onPointerLeave = useCallback(() => {
    setHoverIdx(null);
    setCursor(null);
  }, []);

  const hovered = hoverIdx != null ? samples[hoverIdx] : null;
  const energy = fmtEnergy(summary.energyWh);
  const co2 = fmtCo2(summary.co2Kg);

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

      {/* Energy + CO₂ headline */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <HeadlineCard
          icon={<Zap size={20} />}
          label="用电量 (CPU + GPU)"
          value={energy.value}
          unit={energy.unit}
          hue={85}
          sub="本次会话 CPU + GPU 功耗积分"
        />
        <HeadlineCard
          icon={<Leaf size={20} />}
          label="二氧化碳排放量 (估算)"
          value={co2.value}
          unit={co2.unit}
          hue={158}
          sub={`估算值 · ${CO2_KG_PER_KWH} kg CO₂/kWh`}
        />
      </div>

      {/* Summary stat grid */}
      <div className="glass hairline rounded-2xl p-4">
        <div className="mb-3 flex items-center gap-2 text-[12.5px] font-semibold text-muted">
          <Activity size={15} className="text-accent" /> 性能汇总
        </div>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
          {STATS.map((stat) => (
            <StatCell key={stat.key} stat={stat} value={summary[stat.key] as number | null} />
          ))}
        </div>
      </div>

      {/* Featured big chart — user switches which metric it shows */}
      <FeaturedChart
        series={series}
        summary={summary}
        timesSec={timesSec}
        syncKey={syncKey}
        onHover={onHover}
        hovered={hovered}
      />

      {/* Time-series charts (shared synced cursor + floating tooltip) */}
      <div
        ref={wrapRef}
        className="glass hairline relative grid grid-cols-1 gap-4 rounded-2xl p-4 lg:grid-cols-2"
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
      >
        {series
          .filter((s) => s.hasData)
          .map(({ def, values }) => (
            <ChartPanel
              key={def.key}
              def={def}
              timesSec={timesSec}
              values={values}
              refLines={buildRefs(summary, def)}
              syncKey={syncKey}
              onHover={onHover}
            />
          ))}

        {hasNet && (
          <div className="rounded-2xl border border-line bg-surface2/40 p-4 lg:col-span-2">
            <div className="mb-2 flex items-center gap-2 text-[12.5px] font-semibold text-muted">
              <Activity size={15} style={{ color: "oklch(80% 0.13 224)" }} /> 网络上传 / 下载
              <span className="nums ml-1 text-[10.5px] font-normal">
                <span style={{ color: "oklch(80% 0.13 75)" }}>↑ 上传</span>
                <span className="text-dim"> · </span>
                <span style={{ color: "oklch(80% 0.13 224)" }}>↓ 下载</span>
              </span>
            </div>
            <DualAxisChart
              timesSec={timesSec}
              up={netUp}
              down={netDown}
              upHue={75}
              downHue={224}
              format={rate}
              syncKey={syncKey}
              onHover={onHover}
            />
          </div>
        )}

        {hovered && cursor && (
          <HoverTooltip sample={hovered} cursor={cursor} container={wrapRef.current} />
        )}
      </div>
    </motion.div>
  );
}

/** Floating tooltip: full hardware readout at the hovered timestamp. Positioned
 *  near the cursor and flipped to stay inside the charts container. */
function HoverTooltip({
  sample,
  cursor,
  container,
}: {
  sample: PerfSample;
  cursor: { x: number; y: number };
  container: HTMLDivElement | null;
}) {
  const rows = TOOLTIP_ROWS.map((r) => ({ ...r, value: r.fmt(sample) })).filter(
    (r): r is TooltipRow & { value: string } => r.value !== null,
  );
  if (rows.length === 0) return null;

  const TOOLTIP_W = 200;
  const OFFSET = 16;
  const cw = container?.clientWidth ?? 0;
  // Flip to the left of the cursor when it would overflow the right edge.
  const flip = cw > 0 && cursor.x + OFFSET + TOOLTIP_W > cw;
  const left = flip ? cursor.x - OFFSET - TOOLTIP_W : cursor.x + OFFSET;

  return (
    <div
      className="pointer-events-none absolute z-20 w-[200px] rounded-xl border border-line-strong bg-surface/95 p-3 shadow-xl backdrop-blur"
      style={{ left: Math.max(4, left), top: Math.max(4, cursor.y - 8) }}
    >
      <div className="nums mb-2 border-b border-line pb-1.5 text-[10.5px] font-medium text-dim">
        {fmtElapsed(sample.t)}
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1">
        {rows.map((r) => (
          <div key={r.label} className="flex items-baseline justify-between gap-1.5">
            <span className="truncate text-[10.5px] text-dim">{r.label}</span>
            <span className="nums shrink-0 text-[11px] font-medium" style={{ color: `oklch(82% 0.13 ${r.hue})` }}>
              {r.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
