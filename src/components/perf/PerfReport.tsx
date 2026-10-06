import { motion } from "motion/react";
import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { formatBytes } from "../../lib/format";
import { accentHue, hueColor } from "../../lib/colors";
import { cn } from "../../lib/cn";
import { useT, useTf } from "../../lib/i18n";
import { easeOut } from "../../lib/motion";
import { Cluster, ClusterCell, Readout } from "../ui/Readout";
import {
  CO2_KG_PER_KWH,
  gameDisplayName,
  type PerfSample,
  type PerfSummary,
} from "../../lib/perf";
import { loadSamples, peekSamples, type PerfSessionMeta } from "../../lib/perfSamples";
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

// ── Summary ──────────────────────────────────────────────────────────────────

/** Metric families share one hue across charts, tooltip dots and legends
 *  (DESIGN.md → data series). -1 = the theme accent (CPU is the primary metric). */
const HUE = { fps: 158, cpu: -1, gpu: 184, mem: 215, power: 85, disk: 78, netDown: 152, netUp: 85 } as const;
const hueOf = (h: number) => (h < 0 ? accentHue() : h);

interface KV {
  label: string;
  value: number | null | undefined;
  digits: number;
  unit?: string;
  /** Temperatures: warn/danger tint past these marks. */
  hot?: [number, number];
}

/** One domain column of the summary: CPU / GPU / 系统 key-value rows. */
function KVColumn({ title, hue, rows }: { title: string; hue: number; rows: KV[] }) {
  const t = useT();
  return (
    <div className="min-w-0 border-l border-t border-line px-5 py-4">
      <div className="mb-2 flex items-center gap-2 text-[12px] font-medium text-ink">
        <span className="h-2 w-2 rounded-full" style={{ background: hueColor(hueOf(hue), 78, 0.14) }} />
        {t(title)}
      </div>
      <dl className="space-y-1.5">
        {rows.map((r) => {
          const v = r.value;
          const tone = r.hot && isNum(v) ? (v >= r.hot[1] ? "text-danger" : v >= r.hot[0] ? "text-warn" : "text-ink") : "text-ink";
          return (
            <div key={r.label} className="flex items-baseline justify-between gap-3">
              <dt className="truncate text-[12px] text-muted">{t(r.label)}</dt>
              <dd className={cn("nums shrink-0 text-[14px]", isNum(v) ? tone : "text-dim")}>
                {num(v, r.digits)}
                {isNum(v) && r.unit && <span className="ml-0.5 text-[11px] text-dim">{r.unit}</span>}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

// ── Chart catalog ────────────────────────────────────────────────────────────

interface ChartDef {
  key: string;
  title: string;
  /** Family hue; -1 = theme accent (see HUE). */
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
  { key: "fps", title: "FPS", hue: HUE.fps, unit: "", digits: 0, pick: (s) => s.fps, refs: { avg: "avgFps", min: "minFps", max: "maxFps" }, zeroFloor: true },
  { key: "ft", title: "帧时间", hue: HUE.fps, unit: " ms", digits: 1, pick: (s) => s.frametimeMs, refs: { avg: "avgFrametimeMs" } },
  { key: "cpuLoad", title: "CPU 占用", hue: HUE.cpu, unit: "%", digits: 0, pick: (s) => s.cpuLoad, refs: { avg: "avgCpuLoad" }, zeroFloor: true },
  { key: "cpuTemp", title: "CPU 温度", hue: HUE.cpu, unit: "°C", digits: 0, pick: (s) => s.cpuTemp, refs: { avg: "avgCpuTemp", max: "maxCpuTemp" } },
  { key: "cpuPower", title: "CPU 功耗", hue: HUE.power, unit: " W", digits: 0, pick: (s) => s.cpuPower, refs: { avg: "avgCpuPower", max: "maxCpuPower" }, zeroFloor: true },
  { key: "cpuClock", title: "CPU 频率", hue: HUE.cpu, unit: " MHz", digits: 0, pick: (s) => s.cpuClock, refs: { avg: "avgCpuClock" } },
  { key: "gpuLoad", title: "GPU 占用", hue: HUE.gpu, unit: "%", digits: 0, pick: (s) => s.gpuLoad, refs: { avg: "avgGpuLoad" }, zeroFloor: true },
  { key: "gpuTemp", title: "GPU 温度", hue: HUE.gpu, unit: "°C", digits: 0, pick: (s) => s.gpuTemp, refs: { avg: "avgGpuTemp", max: "maxGpuTemp" } },
  { key: "gpuPower", title: "GPU 功耗", hue: HUE.power, unit: " W", digits: 0, pick: (s) => s.gpuPower, refs: { avg: "avgGpuPower", max: "maxGpuPower" }, zeroFloor: true },
  { key: "totalPower", title: "总功耗 (CPU+GPU)", hue: HUE.power, unit: " W", digits: 0, pick: (s) => totalPower(s), zeroFloor: true },
  { key: "gpuClock", title: "GPU 核心频率", hue: HUE.gpu, unit: " MHz", digits: 0, pick: (s) => s.gpuClock, refs: { avg: "avgGpuClock" } },
  { key: "gpuMemClock", title: "显存频率", hue: HUE.mem, unit: " MHz", digits: 0, pick: (s) => s.gpuMemClock ?? null },
  { key: "gpuMemCtrl", title: "显存控制器占用", hue: HUE.mem, unit: "%", digits: 0, pick: (s) => s.gpuMemCtrlLoad ?? null, zeroFloor: true },
  { key: "vram", title: "显存占用", hue: HUE.mem, unit: "%", digits: 0, pick: (s) => s.vramLoad, refs: { avg: "avgVramLoad", max: "maxVramLoad" }, zeroFloor: true },
  { key: "gpuFan", title: "GPU 风扇", hue: HUE.gpu, unit: "%", digits: 0, pick: (s) => s.gpuFan ?? null, zeroFloor: true },
  { key: "mem", title: "内存占用", hue: HUE.mem, unit: "%", digits: 0, pick: (s) => s.memLoad, refs: { avg: "avgMemLoad" }, zeroFloor: true },
  { key: "disk", title: "磁盘活动", hue: HUE.disk, unit: "%", digits: 0, pick: (s) => s.diskLoad ?? null, zeroFloor: true },
  { key: "diskRW", title: "磁盘读写", hue: HUE.disk, unit: "", digits: 0, pick: (s) => maxNullable(s.diskRead, s.diskWrite), zeroFloor: true, fmt: rate },
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
  const t = useT();
  const fmt = def.fmt ?? ((v: number) => `${v.toFixed(def.digits)}${def.unit}`);
  return (
    <div className="glass rounded-xl px-4 pb-3 pt-3.5">
      <div className="mb-1.5 flex items-center gap-2 text-[12.5px] font-medium text-ink">
        <span className="h-2 w-2 rounded-full" style={{ background: hueColor(hueOf(def.hue), 78, 0.14) }} />
        {t(def.title)}
      </div>
      <TimeSeriesChart
        timesSec={timesSec}
        values={values}
        hue={hueOf(def.hue)}
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

/** One labelled readout in the featured chart's side column. */
function FeaturedStat({ label, value }: { label: string; value: string }) {
  return <Readout label={label} value={value === DASH ? null : value} size="sm" className="lg:border-t lg:border-line lg:pt-2 lg:first:border-t-0 lg:first:pt-0" />;
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
  const t = useT();
  const tf = useTf();
  // Only metrics that actually captured data are selectable.
  const selectable = useMemo(() => series.filter((s) => s.hasData), [series]);
  const [key, setKey] = useState<string>("fps");
  // Resolve the selection; fall back to the first available metric if the chosen
  // one (default "fps") has no data this session.
  const cur = selectable.find((s) => s.def.key === key) ?? selectable[0];
  const values = cur?.values ?? [];
  const stats = useMemo(() => seriesStats(values), [values]);

  // Pointer tracking for THIS chart so it shows the same full-metric tooltip the
  // small grid charts do — it lives outside their hover container, so it needs
  // its own. Positioned relative to the whole featured card (taller → fits).
  const featRef = useRef<HTMLDivElement>(null);
  const [featCur, setFeatCur] = useState<{ x: number; y: number } | null>(null);
  const onChartMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const el = featRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setFeatCur({ x: e.clientX - r.left, y: e.clientY - r.top });
  }, []);
  const onChartLeave = useCallback(() => {
    setFeatCur(null);
    onHover(null);
  }, [onHover]);

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
    <div ref={featRef} className="glass relative rounded-xl p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="relative">
          <select
            value={def.key}
            onChange={(e) => setKey(e.target.value)}
            aria-label={tf("图表指标", "Chart metric")}
            className="field no-drag h-8 cursor-pointer appearance-none pr-9 text-[13px] font-medium"
          >
            {selectable.map((s) => (
              <option key={s.def.key} value={s.def.key}>
                {t(s.def.title)}
              </option>
            ))}
          </select>
          <ChevronDown
            size={15}
            className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-dim"
          />
        </div>
        <div className="nums flex items-baseline gap-2">
          <span className="text-[12px] text-dim">{live ? t("当前") : t("平均")}</span>
          <span className="text-[28px] font-light leading-none" style={{ color: hueColor(hueOf(def.hue), 80, 0.14) }}>
            {fmtOrDash(headlineVal)}
          </span>
        </div>
      </div>

      {/* Grid (not flex) so the chart column is `minmax(0,1fr)` — a constrained,
          shrinkable width. uPlot sizes its canvas to an explicit pixel width, which
          would blow out a flex-1 column (canvas overflow feeds back into layout);
          the minmax track pins it the way the small-chart grid + host layout do. */}
      <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_10rem]">
        <div className="min-w-0" onPointerMove={onChartMove} onPointerLeave={onChartLeave}>
          <TimeSeriesChart
            timesSec={timesSec}
            values={values}
            hue={hueOf(def.hue)}
            format={fmt}
            refLines={buildRefs(summary, def)}
            zeroFloor={def.zeroFloor}
            height={260}
            syncKey={syncKey}
            onHover={onHover}
          />
        </div>
        <div className="flex flex-row flex-wrap gap-x-6 gap-y-3 lg:flex-col lg:gap-2 lg:border-l lg:border-line lg:pl-4">
          <FeaturedStat label="平均" value={fmtOrDash(stats.avg)} />
          <FeaturedStat label="最高" value={fmtOrDash(stats.max)} />
          <FeaturedStat label="最低" value={fmtOrDash(stats.min)} />
          {isFps && (
            <>
              <FeaturedStat label="1% Low" value={fmtOrDash(summary.low1)} />
              <FeaturedStat label="0.1% Low" value={fmtOrDash(summary.low01)} />
            </>
          )}
        </div>
      </div>
      {hovered && featCur && (
        <HoverTooltip sample={hovered} cursor={featCur} container={featRef.current} />
      )}
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
  { label: "FPS", hue: HUE.fps, fmt: (s) => (isNum(s.fps) ? s.fps.toFixed(0) : null) },
  { label: "帧时间", hue: HUE.fps, fmt: (s) => (isNum(s.frametimeMs) ? `${s.frametimeMs.toFixed(1)} ms` : null) },
  { label: "CPU 占用", hue: HUE.cpu, fmt: (s) => (isNum(s.cpuLoad) ? `${s.cpuLoad.toFixed(0)}%` : null) },
  { label: "CPU 温度", hue: HUE.cpu, fmt: (s) => (isNum(s.cpuTemp) ? `${s.cpuTemp.toFixed(0)}°C` : null) },
  { label: "CPU 功耗", hue: HUE.power, fmt: (s) => (isNum(s.cpuPower) ? `${s.cpuPower.toFixed(0)} W` : null) },
  { label: "CPU 频率", hue: HUE.cpu, fmt: (s) => (isNum(s.cpuClock) ? `${Math.round(s.cpuClock)} MHz` : null) },
  { label: "GPU 占用", hue: HUE.gpu, fmt: (s) => (isNum(s.gpuLoad) ? `${s.gpuLoad.toFixed(0)}%` : null) },
  { label: "GPU 温度", hue: HUE.gpu, fmt: (s) => (isNum(s.gpuTemp) ? `${s.gpuTemp.toFixed(0)}°C` : null) },
  { label: "GPU 功耗", hue: HUE.power, fmt: (s) => (isNum(s.gpuPower) ? `${s.gpuPower.toFixed(0)} W` : null) },
  { label: "总功耗", hue: HUE.power, fmt: (s) => { const v = totalPower(s); return isNum(v) ? `${v.toFixed(0)} W` : null; } },
  { label: "GPU 频率", hue: HUE.gpu, fmt: (s) => (isNum(s.gpuClock) ? `${s.gpuClock} MHz` : null) },
  { label: "显存频率", hue: HUE.mem, fmt: (s) => (isNum(s.gpuMemClock) ? `${s.gpuMemClock} MHz` : null) },
  { label: "显存控制器", hue: HUE.mem, fmt: (s) => (isNum(s.gpuMemCtrlLoad) ? `${s.gpuMemCtrlLoad.toFixed(0)}%` : null) },
  { label: "显存占用", hue: HUE.mem, fmt: (s) => (isNum(s.vramLoad) ? `${s.vramLoad.toFixed(0)}%` : null) },
  { label: "GPU 风扇", hue: HUE.gpu, fmt: (s) => (isNum(s.gpuFan) ? `${s.gpuFan.toFixed(0)}%` : null) },
  { label: "内存占用", hue: HUE.mem, fmt: (s) => (isNum(s.memLoad) ? `${s.memLoad.toFixed(0)}%` : null) },
  { label: "磁盘活动", hue: HUE.disk, fmt: (s) => (isNum(s.diskLoad) ? `${s.diskLoad.toFixed(0)}%` : null) },
  { label: "磁盘读", hue: HUE.disk, fmt: (s) => (isNum(s.diskRead) ? rate(s.diskRead) : null) },
  { label: "磁盘写", hue: HUE.disk, fmt: (s) => (isNum(s.diskWrite) ? rate(s.diskWrite) : null) },
  { label: "下载", hue: HUE.netDown, fmt: (s) => (isNum(s.netDown) ? rate(s.netDown) : null) },
  { label: "上传", hue: HUE.netUp, fmt: (s) => (isNum(s.netUp) ? rate(s.netUp) : null) },
];

/** Localized elapsed time label "m:ss" for the tooltip header. */
function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Stable empty series, so "not loaded yet" never churns the chart memos. */
const NO_SAMPLES: PerfSample[] = [];

/**
 * The session's sample array, pulled from its own file on demand (see
 * `lib/perfSamples`). Resolves synchronously from the LRU cache when the
 * session was just recorded or prefetched after hydration — which is the normal
 * path for the auto-surfaced report and the default (newest) selection, so the
 * charts still paint with data on the very first frame.
 *
 * A row that still carries inline `samples` (a v1 row whose migration write
 * failed) is read directly, with no IO.
 */
function useSessionSamples(session: PerfSessionMeta): PerfSample[] {
  const { id, samples: inline } = session;
  const [samples, setSamples] = useState<PerfSample[]>(
    () => inline ?? peekSamples(id) ?? NO_SAMPLES,
  );
  useEffect(() => {
    if (inline) {
      setSamples(inline);
      return;
    }
    const cached = peekSamples(id);
    if (cached) {
      setSamples(cached);
      return;
    }
    // Selecting another session mid-load must not paint the old one's data.
    let alive = true;
    void loadSamples(id).then((loaded) => {
      if (alive) setSamples(loaded);
    });
    return () => {
      alive = false;
    };
  }, [id, inline]);
  return samples;
}

export function PerfReport({ session }: { session: PerfSessionMeta }) {
  const tf = useTf();
  const { summary } = session;
  const samples = useSessionSamples(session);
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

  const hasFps = isNum(summary.avgFps);
  const metaBits = [
    session.cpuName,
    session.gpuName,
    session.refreshHz != null ? `${session.refreshHz} Hz` : null,
    samples.length > 0 ? tf(`采样 ${(session.durationSec / samples.length).toFixed(1)} 秒`, `${(session.durationSec / samples.length).toFixed(1)} s sampling`) : null,
  ].filter(Boolean);

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, transition: { duration: 0.08 } }}
      transition={{ duration: 0.2, ease: easeOut }}
      className="space-y-4"
    >
      {/* Header — typography only */}
      <header className="px-1">
        <h2 className="truncate font-title text-[20px] font-semibold leading-tight text-ink" title={gameDisplayName(session.exe)}>
          {gameDisplayName(session.exe)}
        </h2>
        <p className="nums mt-1 text-[12.5px] text-muted">
          {fmtDateTime(session.startedAt)} → {fmtDateTime(session.endedAt)}
          <span className="mx-1.5 text-dim">·</span>
          {fmtDuration(session.durationSec)}
        </p>
        {metaBits.length > 0 && <p className="mt-0.5 truncate text-[12px] text-dim">{metaBits.join("  ·  ")}</p>}
        {session.path && (
          <p className="mt-0.5 truncate font-mono text-[11px] text-dim" title={session.path}>
            {session.path}
          </p>
        )}
      </header>

      {/* Frame rate — the headline */}
      <section className="glass overflow-hidden rounded-xl">
        <Cluster min={96}>
          <ClusterCell className="col-span-2">
            <Readout label="平均 FPS" value={hasFps ? Math.round(summary.avgFps as number) : null} size="xl" color={hueColor(HUE.fps, 80, 0.14)} />
          </ClusterCell>
          <ClusterCell><Readout label="1% Low" value={isNum(summary.low1) ? Math.round(summary.low1) : null} size="lg" /></ClusterCell>
          <ClusterCell><Readout label="0.1% Low" value={isNum(summary.low01) ? Math.round(summary.low01) : null} size="lg" /></ClusterCell>
          <ClusterCell><Readout label="最低 FPS" value={isNum(summary.minFps) ? Math.round(summary.minFps) : null} size="lg" /></ClusterCell>
          <ClusterCell><Readout label="最高 FPS" value={isNum(summary.maxFps) ? Math.round(summary.maxFps) : null} size="lg" /></ClusterCell>
          <ClusterCell><Readout label="平均帧时间" value={isNum(summary.avgFrametimeMs) ? summary.avgFrametimeMs.toFixed(1) : null} unit="ms" size="lg" /></ClusterCell>
        </Cluster>
      </section>

      {/* Hardware summary — one column per domain */}
      <section className="glass overflow-hidden rounded-xl">
        <Cluster min={220}>
          <KVColumn
            title="CPU"
            hue={HUE.cpu}
            rows={[
              { label: "平均占用", value: summary.avgCpuLoad, digits: 0, unit: "%" },
              { label: "平均温度", value: summary.avgCpuTemp, digits: 0, unit: "°C", hot: [85, 95] },
              { label: "最高温度", value: summary.maxCpuTemp, digits: 0, unit: "°C", hot: [85, 95] },
              { label: "平均功耗", value: summary.avgCpuPower, digits: 0, unit: "W" },
              { label: "平均频率", value: summary.avgCpuClock, digits: 0, unit: "MHz" },
            ]}
          />
          <KVColumn
            title="GPU"
            hue={HUE.gpu}
            rows={[
              { label: "平均占用", value: summary.avgGpuLoad, digits: 0, unit: "%" },
              { label: "平均温度", value: summary.avgGpuTemp, digits: 0, unit: "°C", hot: [80, 88] },
              { label: "最高温度", value: summary.maxGpuTemp, digits: 0, unit: "°C", hot: [80, 88] },
              { label: "平均功耗", value: summary.avgGpuPower, digits: 0, unit: "W" },
              { label: "平均频率", value: summary.avgGpuClock, digits: 0, unit: "MHz" },
              { label: "平均显存占用", value: summary.avgVramLoad, digits: 0, unit: "%" },
            ]}
          />
          <div className="min-w-0 border-l border-t border-line px-5 py-4">
            <div className="mb-2 flex items-center gap-2 text-[12px] font-medium text-ink">
              <span className="h-2 w-2 rounded-full" style={{ background: hueColor(HUE.power, 78, 0.14) }} />
              {tf("系统与能耗", "System & energy")}
            </div>
            <dl className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-[12px] text-muted">{tf("平均内存占用", "Avg memory")}</dt>
                <dd className="nums text-[14px] text-ink">{num(summary.avgMemLoad)}{isNum(summary.avgMemLoad) && <span className="ml-0.5 text-[11px] text-dim">%</span>}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-[12px] text-muted">{tf("用电量 (CPU + GPU)", "Energy (CPU + GPU)")}</dt>
                <dd className="nums text-[14px] text-ink">{energy.value}<span className="ml-0.5 text-[11px] text-dim">{energy.unit}</span></dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-[12px] text-muted">{tf("二氧化碳 (估算)", "CO₂ (estimate)")}</dt>
                <dd className="nums text-[14px] text-ink">{co2.value}<span className="ml-0.5 text-[11px] text-dim">{co2.unit}</span></dd>
              </div>
            </dl>
            <p className="mt-2 text-[11px] text-dim">{tf(`按 ${CO2_KG_PER_KWH} kg CO₂/kWh 估算`, `Estimated at ${CO2_KG_PER_KWH} kg CO₂/kWh`)}</p>
          </div>
        </Cluster>
      </section>

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
        className="relative grid grid-cols-1 gap-3 lg:grid-cols-2"
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
          <div className="glass rounded-xl px-4 pb-3 pt-3.5 lg:col-span-2">
            <div className="mb-1.5 flex items-center gap-3 text-[12.5px] font-medium text-ink">
              {tf("网络上传 / 下载", "Network up / down")}
              <span className="flex items-center gap-1.5 text-[11.5px] font-normal text-muted">
                <span className="h-0.5 w-3 rounded-full" style={{ background: hueColor(HUE.netUp, 78, 0.14) }} />
                {tf("上传", "Up")}
              </span>
              <span className="flex items-center gap-1.5 text-[11.5px] font-normal text-muted">
                <span className="h-0.5 w-3 rounded-full" style={{ background: hueColor(HUE.netDown, 78, 0.14) }} />
                {tf("下载", "Down")}
              </span>
            </div>
            <DualAxisChart
              timesSec={timesSec}
              up={netUp}
              down={netDown}
              upHue={HUE.netUp}
              downHue={HUE.netDown}
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
      className="float pointer-events-none absolute z-20 w-[200px] rounded-xl p-3"
      style={{ left: Math.max(4, left), top: Math.max(4, cursor.y - 8) }}
    >
      <div className="nums mb-2 border-b border-line pb-1.5 text-[11px] text-muted">
        {fmtElapsed(sample.t)}
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center justify-between gap-1.5">
            <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-dim">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: hueColor(hueOf(r.hue), 78, 0.14) }} />
              <span className="truncate">{r.label}</span>
            </span>
            <span className="nums shrink-0 text-[11.5px] text-ink">{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
