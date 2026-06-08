import {
  Activity,
  ArrowDown,
  ArrowUp,
  Cpu,
  Gauge,
  HardDrive,
  MemoryStick,
  MonitorPlay,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { Sparkline } from "../components/charts/Sparkline";
import { PerfHistory } from "../components/perf/PerfHistory";
import { AnimatedNumber } from "../components/ui/AnimatedNumber";
import { Segmented } from "../components/ui/Segmented";
import { TabHeader } from "../components/ui/TabHeader";
import { useMetricsHistory } from "../hooks/useMetricsHistory";
import { useSensors } from "../hooks/useSensors";
import { formatBytes } from "../lib/format";
import { hueColor } from "../lib/colors";
import { useTf } from "../lib/i18n";
import { easeOut } from "../lib/motion";
import { useUi, type MonitorSub } from "../store/ui";

const SUB_TABS: { value: MonitorSub; label: string }[] = [
  { value: "live", label: "实时" },
  { value: "history", label: "历史" },
];

const HISTORY_POINTS = 80;

const fmtRate = (v: number | null | undefined) => (v == null ? "—" : `${formatBytes(v)}/s`);
// Theme-aware telemetry color: bright neon on the dark HUD, deeper/saturated on
// light so lines and values stay legible. `hueColor` reads `data-theme` live.
const oklch = (hue: number, l = 80, c = 0.13) => hueColor(hue, l, c);

// ── Small HUD readout: an aligned label/value pair under a gauge ──────────────

interface ReadoutProps {
  label: string;
  value: string;
  hue?: number;
  live?: boolean;
}

function Readout({ label, value, hue, live }: ReadoutProps) {
  const empty = value === "—";
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="hud-label text-[8.5px] text-dim">{label}</span>
      <span
        className="nums truncate text-[12.5px] font-medium leading-none"
        style={{ color: empty ? "var(--color-dim)" : hue != null && live ? oklch(hue, 82) : "var(--color-ink)" }}
      >
        {value}
      </span>
    </div>
  );
}

// ── Primary instrument: big gauge card with sparkline + secondary readouts ────

interface InstrumentCardProps {
  icon: LucideIcon;
  label: string;
  value: number | null;
  hue: number;
  hist: number[];
  caption?: string;
  readouts?: ReadoutProps[];
  delay: number;
  reduce: boolean;
}

function InstrumentCard({
  icon: Icon,
  label,
  value,
  hue,
  hist,
  caption,
  readouts,
  delay,
  reduce,
}: InstrumentCardProps) {
  const live = value != null;
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay, ease: easeOut }}
      className="hud-frame glass hairline relative flex flex-col overflow-hidden rounded-2xl p-4"
    >
      {/* Header: icon chip + HUD label, percent badge top-right */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span
            className="grid h-9 w-9 place-items-center rounded-xl"
            style={{ background: `oklch(70% 0.13 ${hue} / 0.14)`, color: oklch(hue, 80) }}
          >
            <Icon size={17} />
          </span>
          <span className="hud-label text-[10px] text-muted">{label}</span>
        </div>
        <span
          className="nums rounded-md px-1.5 py-0.5 text-[9.5px] font-medium"
          style={{ background: `oklch(70% 0.13 ${hue} / 0.12)`, color: oklch(hue, 78) }}
        >
          {live ? "LIVE" : "—"}
        </span>
      </div>

      {/* Headline value */}
      <div
        className={live ? "nums mt-2 text-[44px] font-bold leading-none glow-text" : "nums mt-2 text-[44px] font-bold leading-none text-dim"}
        style={live ? { color: oklch(hue, 82) } : undefined}
      >
        {value == null ? "—" : <AnimatedNumber value={value} digits={0} suffix="%" />}
      </div>
      <div className="mt-1 h-3.5 truncate text-[11px] text-dim">{caption ?? ""}</div>

      {/* Sparkline framed as a HUD readout strip */}
      <div className="mt-2.5 overflow-hidden rounded-lg border border-line bg-surface2/40">
        <Sparkline data={hist} max={100} hue={hue} height={62} />
      </div>

      {/* Secondary telemetry readouts */}
      {readouts && readouts.length > 0 && (
        <div className="mt-3 grid grid-cols-3 gap-2 border-t border-line pt-2.5">
          {readouts.map((r) => (
            <Readout key={r.label} {...r} hue={hue} live={live} />
          ))}
        </div>
      )}
    </motion.div>
  );
}

// ── Secondary panel: framed mini-instrument (disk / net / power) ──────────────

interface MiniPanelProps {
  icon: LucideIcon;
  label: string;
  hue: number;
  children: ReactNode;
  delay: number;
  reduce: boolean;
}

function MiniPanel({ icon: Icon, label, hue, children, delay, reduce }: MiniPanelProps) {
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay, ease: easeOut }}
      className="glass hairline rounded-2xl p-4"
    >
      <div className="mb-3 flex items-center gap-2">
        <Icon size={14} style={{ color: oklch(hue, 78) }} />
        <span className="hud-label text-[10px] text-muted">{label}</span>
      </div>
      {children}
    </motion.div>
  );
}

/** Directional I/O readout (read/write, up/down) with mono value. */
function FlowReadout({
  dir,
  label,
  value,
}: {
  dir: "in" | "out";
  label: string;
  value: string;
}) {
  const Icon = dir === "in" ? ArrowDown : ArrowUp;
  const color = dir === "in" ? "text-ok" : "text-warn";
  return (
    <div className="flex items-center gap-2">
      <Icon size={14} className={color} />
      <div className="min-w-0">
        <div className="hud-label text-[8.5px] text-dim">{label}</div>
        <div className="nums text-[14px] font-medium text-ink">{value}</div>
      </div>
    </div>
  );
}

function LiveDashboard() {
  const tf = useTf();
  const reduce = useReducedMotion() ?? false;
  const { cpu, memPct, latest } = useMetricsHistory(HISTORY_POINTS);
  const { latest: sensors, gpuHist, powerHist } = useSensors(HISTORY_POINTS);

  const cpuNow = latest?.cpuOverall ?? 0;
  const memUsed = latest?.memUsed ?? 0;
  const memTotal = latest?.memTotal ?? 0;
  const memNowPct = memTotal > 0 ? (memUsed / memTotal) * 100 : 0;
  const coreCount = latest?.perCore.length ?? null;

  const cpuTemp = sensors?.cpuTemp;
  const cpuPower = sensors?.cpuPower;
  const cpuClock = sensors?.cpuClock;
  const gpuTemp = sensors?.gpuTemp;
  const gpuPower = sensors?.gpuPower;
  const vramUsed = sensors?.vramUsed ?? null;
  const vramTotal = sensors?.vramTotal ?? null;
  const vramPct = vramUsed != null && vramTotal != null && vramTotal > 0 ? (vramUsed / vramTotal) * 100 : null;

  const fmtNum = (v: number | null | undefined, unit: string, digits = 0) =>
    v == null ? "—" : `${v.toFixed(digits)}${unit}`;
  const totalPower = (cpuPower ?? 0) + (gpuPower ?? 0);

  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4 pb-6">
      {/* Section: primary cluster */}
      <div className="flex items-center gap-2 pl-0.5">
        <span className="hud-label text-[10px] text-dim">核心遥测 · CORE TELEMETRY</span>
        <span className="hairline h-px flex-1 rounded-full" />
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <InstrumentCard
          icon={Cpu}
          label="CPU"
          value={cpuNow}
          hue={280}
          hist={cpu}
          caption={coreCount != null ? tf(`${coreCount} 线程 · 占用率`, `${coreCount} threads · usage`) : "占用率"}
          readouts={[
            { label: "TEMP", value: fmtNum(cpuTemp, "°C") },
            { label: "POWER", value: fmtNum(cpuPower, "W") },
            { label: "CLOCK", value: cpuClock == null ? "—" : `${Math.round(cpuClock)}` },
          ]}
          delay={0}
          reduce={reduce}
        />
        <InstrumentCard
          icon={MonitorPlay}
          label="GPU"
          value={sensors?.gpuPct ?? null}
          hue={184}
          hist={gpuHist}
          caption={sensors?.gpuName ?? "—"}
          readouts={[
            { label: "TEMP", value: fmtNum(gpuTemp, "°C") },
            { label: "POWER", value: fmtNum(gpuPower, "W") },
            { label: "VRAM", value: vramPct == null ? "—" : `${Math.round(vramPct)}%` },
          ]}
          delay={0.05}
          reduce={reduce}
        />
        <InstrumentCard
          icon={MemoryStick}
          label="内存"
          value={memNowPct}
          hue={224}
          hist={memPct}
          caption={memTotal > 0 ? `${formatBytes(memUsed)} / ${formatBytes(memTotal)}` : "—"}
          readouts={[
            { label: "USED", value: memTotal > 0 ? formatBytes(memUsed) : "—" },
            { label: "TOTAL", value: memTotal > 0 ? formatBytes(memTotal) : "—" },
            { label: "FREE", value: memTotal > 0 ? formatBytes(Math.max(0, memTotal - memUsed)) : "—" },
          ]}
          delay={0.1}
          reduce={reduce}
        />
      </div>

      {/* Section: I/O + power */}
      <div className="flex items-center gap-2 pl-0.5">
        <span className="hud-label text-[10px] text-dim">数据流 · I/O & POWER</span>
        <span className="hairline h-px flex-1 rounded-full" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <MiniPanel icon={HardDrive} label="磁盘" hue={50} delay={0.2} reduce={reduce}>
          <div className="grid grid-cols-2 gap-3">
            <FlowReadout dir="in" label="读取" value={fmtRate(sensors?.diskRead)} />
            <FlowReadout dir="out" label="写入" value={fmtRate(sensors?.diskWrite)} />
          </div>
        </MiniPanel>

        <MiniPanel icon={Activity} label="网络" hue={224} delay={0.25} reduce={reduce}>
          <div className="grid grid-cols-2 gap-3">
            <FlowReadout dir="in" label="下载" value={fmtRate(sensors?.netDown)} />
            <FlowReadout dir="out" label="上传" value={fmtRate(sensors?.netUp)} />
          </div>
        </MiniPanel>

        <MiniPanel icon={Zap} label="总功耗" hue={75} delay={0.3} reduce={reduce}>
          <div className="flex items-end justify-between gap-3">
            <div className="flex items-baseline gap-1">
              <span
                className="nums text-[26px] font-bold leading-none"
                style={{ color: cpuPower == null && gpuPower == null ? "var(--color-dim)" : oklch(75, 82) }}
              >
                {cpuPower == null && gpuPower == null ? "—" : Math.round(totalPower)}
              </span>
              {(cpuPower != null || gpuPower != null) && <span className="text-[11px] text-dim">W</span>}
            </div>
            <div className="h-9 w-24 overflow-hidden rounded-md border border-line bg-surface2/40">
              <Sparkline data={powerHist} max={Math.max(60, ...powerHist) * 1.1} hue={75} height={36} />
            </div>
          </div>
          <div className="mt-2 flex gap-3 border-t border-line pt-2">
            <Readout label="CPU" value={fmtNum(cpuPower, "W")} />
            <Readout label="GPU" value={fmtNum(gpuPower, "W")} />
          </div>
        </MiniPanel>
      </div>
    </div>
  );
}

export function Monitor() {
  const sub = useUi((s) => s.monitorSub);
  const setSub = useUi((s) => s.setMonitorSub);
  const reduce = useReducedMotion() ?? false;

  return (
    <>
      <TabHeader
        icon={Gauge}
        title="游戏监控"
        subtitle="实时性能监控 — CPU / GPU / 内存 / 磁盘 / 网络"
        actions={<Segmented id="monitor-sub" value={sub} options={SUB_TABS} onChange={setSub} />}
      />
      <AnimatePresence mode="wait">
        <motion.div
          key={sub}
          initial={reduce ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6 }}
          transition={{ duration: 0.2, ease: [0.33, 1, 0.68, 1] }}
          className="flex min-h-0 flex-1 flex-col"
        >
          {sub === "live" ? <LiveDashboard /> : <PerfHistory />}
        </motion.div>
      </AnimatePresence>
    </>
  );
}
