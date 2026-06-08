import { ArrowDown, ArrowUp, Cpu, HardDrive, MemoryStick, MonitorPlay, Wifi, Zap } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";
import { useMetricsHistory } from "../../hooks/useMetricsHistory";
import { useSensors } from "../../hooks/useSensors";
import { cn } from "../../lib/cn";
import { formatBytes } from "../../lib/format";
import { useTf } from "../../lib/i18n";
import { api, type CpuTopology, type GpuOcInfo, type Overview } from "../../lib/ipc";
import { useSettings, type PerfCard } from "../../store/settings";
import { CoreGraphs } from "../charts/CoreGraphs";
import { GpuDetail } from "./GpuDetail";
import { Sparkline } from "../charts/Sparkline";
import { DualSparkline } from "../charts/DualSparkline";
import { AnimatedNumber } from "../ui/AnimatedNumber";

const CARDS: { id: PerfCard; label: string }[] = [
  { id: "cpu", label: "CPU" },
  { id: "mem", label: "内存" },
  { id: "gpu", label: "GPU" },
  { id: "disk", label: "磁盘" },
  { id: "net", label: "网络" },
  { id: "power", label: "功耗" },
];

const fmtRate = (v: number | null | undefined) => (v == null ? "—" : `${formatBytes(v)}/s`);
const fmtPct = (v: number | null | undefined) => (v == null ? "—" : `${v.toFixed(1)}%`);
const fmtTemp = (v: number | null | undefined) => (v == null ? "—" : `${v.toFixed(0)} °C`);
const fmtWatts = (v: number | null | undefined) => (v == null ? "—" : `${v.toFixed(0)} W`);
/** Live CPU clock: shown in GHz once it crosses 1 GHz, otherwise MHz. */
const fmtCpuClock = (mhz: number | null | undefined) =>
  mhz == null ? "—" : mhz >= 1000 ? `${(mhz / 1000).toFixed(2)} GHz` : `${Math.round(mhz)} MHz`;
/** GPU core/memory clock — always MHz, matching the GPU detail panel. */
const fmtMhz = (mhz: number | null | undefined) => (mhz == null ? "—" : `${Math.round(mhz)} MHz`);

function Card({ children }: { children: ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      className="glass hairline rounded-2xl p-4"
    >
      {children}
    </motion.div>
  );
}

function CardHead({ icon, label, value, color }: { icon: ReactNode; label: string; value: ReactNode; color: string }) {
  return (
    <div className="mb-1 flex items-center justify-between">
      <div className="flex items-center gap-2 text-[12.5px] font-semibold text-muted">
        {icon} {label}
      </div>
      <div className="nums display text-[22px] font-semibold glow-text" style={{ color }}>
        {value}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="hud-label text-[9px] text-dim">{label}</div>
      <div className="nums truncate text-[13px] font-medium text-ink">{value}</div>
    </div>
  );
}

export function PerfView() {
  const tf = useTf();
  const { cpu, memPct, latest } = useMetricsHistory(60);
  const { latest: sensors, gpuHist, diskHist, netUpHist, netDownHist, powerHist } = useSensors(60);
  const [topo, setTopo] = useState<CpuTopology | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [gpuOc, setGpuOc] = useState<GpuOcInfo | null>(null);
  const perfCards = useSettings((s) => s.perfCards);
  const togglePerfCard = useSettings((s) => s.togglePerfCard);
  const pollMs = useSettings((s) => s.pollMs);

  useEffect(() => {
    api.getTopology().then(setTopo).catch(() => undefined);
    api.getOverview().then(setOverview).catch(() => undefined);
  }, []);

  // NVML GPU clocks/temperature for the GPU card (graphicsClock isn't in Sensors).
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const info = await api.gpuOcInfo();
        if (alive) setGpuOc(info);
      } catch {
        /* NVML may be unavailable — the card falls back to Sensors. */
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), Math.max(pollMs, 1000));
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [pollMs]);

  const cpuNow = latest?.cpuOverall ?? 0;
  const memUsed = latest?.memUsed ?? 0;
  const memTotal = latest?.memTotal ?? 0;
  const memNowPct = memTotal > 0 ? (memUsed / memTotal) * 100 : 0;
  const vramPct =
    sensors?.vramTotal && sensors.vramUsed ? (sensors.vramUsed / sensors.vramTotal) * 100 : null;
  // Prefer NVML readings; fall back to the generic sensor when NVML is absent.
  const gpuOcLive = gpuOc?.available ? gpuOc : null;
  const gpuTemp = gpuOcLive?.temperature ?? sensors?.gpuTemp ?? null;
  const gpuCoreClock = gpuOcLive?.graphicsClock ?? null;

  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="hud-label mr-1 text-[9.5px] text-dim">显示</span>
        {CARDS.map((c) => (
          <button
            key={c.id}
            onClick={() => togglePerfCard(c.id)}
            className={cn(
              "no-drag cursor-pointer rounded-lg border px-2.5 py-1 text-[11.5px] transition-[background-color,border-color,color] duration-150 active:scale-[0.97]",
              perfCards[c.id]
                ? "border-accent/40 bg-accent/15 text-ink"
                : "border-line bg-surface2 text-dim hover:border-line-strong hover:text-muted",
            )}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {perfCards.cpu && (
          <Card>
            <CardHead
              icon={<Cpu size={15} className="text-accent" />}
              label="CPU"
              value={<AnimatedNumber value={cpuNow} digits={1} suffix="%" />}
              color="var(--color-accent-bright)"
            />
            <div className="truncate text-[11px] text-dim" title={overview?.cpuName}>
              {overview?.cpuName ?? "—"}
            </div>
            <div className="my-2">
              <Sparkline data={cpu} max={100} hue={280} height={84} />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Stat label="频率" value={fmtCpuClock(sensors?.cpuClock)} />
              <Stat label="温度" value={fmtTemp(sensors?.cpuTemp)} />
              <Stat label="功耗" value={fmtWatts(sensors?.cpuPower)} />
              <Stat label="核心" value={overview ? `${overview.physicalCores}` : "—"} />
              <Stat label="逻辑处理器" value={overview ? `${overview.logicalCpus}` : "—"} />
              {/* V-Cache is X3D-only; on other CPUs show SMT status instead. */}
              {overview?.vcacheCcd != null ? (
                <Stat label="V-Cache" value={`CCD${overview.vcacheCcd}`} />
              ) : (
                <Stat
                  label="超线程"
                  value={overview ? (overview.logicalCpus > overview.physicalCores ? "开启" : "关闭") : "—"}
                />
              )}
            </div>
          </Card>
        )}

        {perfCards.mem && (
          <Card>
            <CardHead
              icon={<MemoryStick size={15} className="text-cyan" />}
              label="内存"
              value={<AnimatedNumber value={memNowPct} digits={1} suffix="%" />}
              color="var(--color-cyan)"
            />
            <div className="nums text-[11px] text-dim">
              {formatBytes(memUsed)} / {formatBytes(memTotal)}
            </div>
            <div className="my-2">
              <Sparkline data={memPct} max={100} hue={224} height={84} />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Stat label="已用" value={formatBytes(memUsed)} />
              <Stat label="可用" value={formatBytes(Math.max(memTotal - memUsed, 0))} />
              <Stat label="总计" value={formatBytes(memTotal)} />
            </div>
          </Card>
        )}

        {perfCards.gpu && (
          <Card>
            <CardHead
              icon={<MonitorPlay size={15} className="text-vcache" />}
              label="GPU"
              value={sensors?.gpuPct != null ? <AnimatedNumber value={sensors.gpuPct} digits={1} suffix="%" /> : "—"}
              color="var(--color-vcache)"
            />
            <div className="truncate text-[11px] text-dim" title={sensors?.gpuName ?? undefined}>
              {sensors?.gpuName ?? "—"}
            </div>
            <div className="my-2">
              <Sparkline data={gpuHist} max={100} hue={184} height={84} />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Stat label="核心" value={fmtMhz(gpuCoreClock)} />
              <Stat label="温度" value={fmtTemp(gpuTemp)} />
              <Stat label="功耗" value={fmtWatts(sensors?.gpuPower)} />
              <Stat label="显存已用" value={sensors?.vramUsed != null ? formatBytes(sensors.vramUsed) : "—"} />
              <Stat label="显存总量" value={sensors?.vramTotal != null ? formatBytes(sensors.vramTotal) : "—"} />
              <Stat label="显存占用" value={fmtPct(vramPct)} />
            </div>
          </Card>
        )}

        {perfCards.disk && (
          <Card>
            <CardHead
              icon={<HardDrive size={15} className="text-freq" />}
              label="磁盘"
              value={fmtPct(sensors?.diskPct)}
              color="var(--color-freq)"
            />
            <div className="my-2">
              <Sparkline data={diskHist} max={Math.max(...diskHist, 1)} hue={70} height={84} />
            </div>
            <div className="mt-2 grid grid-cols-2 gap-3">
              <div className="flex items-center gap-2">
                <ArrowDown size={14} className="text-ok" />
                <div>
                  <div className="text-[10.5px] text-dim">读取</div>
                  <div className="nums text-[14px] font-medium text-ink">{fmtRate(sensors?.diskRead)}</div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <ArrowUp size={14} className="text-warn" />
                <div>
                  <div className="text-[10.5px] text-dim">写入</div>
                  <div className="nums text-[14px] font-medium text-ink">{fmtRate(sensors?.diskWrite)}</div>
                </div>
              </div>
            </div>
          </Card>
        )}

        {perfCards.net && (
          <Card>
            <CardHead
              icon={<Wifi size={15} className="text-accent" />}
              label="网络"
              value={<span className="text-[14px]">{fmtRate((sensors?.netDown ?? 0) + (sensors?.netUp ?? 0))}</span>}
              color="var(--color-accent-bright)"
            />
            <div className="my-2">
              <DualSparkline
                up={netUpHist}
                down={netDownHist}
                upHue={75}
                downHue={150}
                height={84}
              />
            </div>
            <div className="mt-2 grid grid-cols-2 gap-3">
              <div className="flex items-center gap-2">
                <ArrowDown size={14} className="text-ok" />
                <div>
                  <div className="text-[10.5px] text-dim">下载</div>
                  <div className="nums text-[14px] font-medium text-ink">{fmtRate(sensors?.netDown)}</div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <ArrowUp size={14} className="text-warn" />
                <div>
                  <div className="text-[10.5px] text-dim">上传</div>
                  <div className="nums text-[14px] font-medium text-ink">{fmtRate(sensors?.netUp)}</div>
                </div>
              </div>
            </div>
          </Card>
        )}

        {perfCards.power && (
          <Card>
            <CardHead
              icon={<Zap size={15} className="text-warn" />}
              label="总功耗"
              value={
                sensors?.cpuPower != null || sensors?.gpuPower != null ? (
                  <AnimatedNumber
                    value={(sensors?.cpuPower ?? 0) + (sensors?.gpuPower ?? 0)}
                    digits={0}
                    suffix="W"
                  />
                ) : (
                  "—"
                )
              }
              color="var(--color-warn)"
            />
            <div className="nums text-[11px] text-dim">CPU + GPU 实时功耗</div>
            <div className="my-2">
              <Sparkline data={powerHist} max={Math.max(...powerHist, 1)} hue={75} height={84} />
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="CPU 功耗" value={sensors?.cpuPower != null ? `${sensors.cpuPower.toFixed(0)} W` : "—"} />
              <Stat label="GPU 功耗" value={sensors?.gpuPower != null ? `${sensors.gpuPower.toFixed(0)} W` : "—"} />
              <Stat label="CPU 温度" value={sensors?.cpuTemp != null ? `${sensors.cpuTemp.toFixed(0)} °C` : "—"} />
              <Stat label="GPU 温度" value={sensors?.gpuTemp != null ? `${sensors.gpuTemp.toFixed(0)} °C` : "—"} />
            </div>
            {sensors?.cpuPower == null && sensors?.gpuPower == null && (
              <p className="mt-3 text-[11px] leading-relaxed text-dim">
                功耗 / 温度需要传感器组件；若显示 “—”，请确认 sensord 已随程序部署。
              </p>
            )}
          </Card>
        )}
      </div>

      {perfCards.cpu && (
        <Card>
          <div className="mb-3 flex items-center gap-2 text-[12.5px] font-semibold text-muted">
            <Cpu size={15} className="text-accent" /> 逻辑处理器利用率
            <span className="nums text-[11px] font-normal text-dim">
              ({overview ? tf(`${overview.logicalCpus} 线程`, `${overview.logicalCpus} threads`) : "—"})
            </span>
          </div>
          <CoreGraphs perCore={latest?.perCore ?? []} topo={topo} />
        </Card>
      )}

      {perfCards.gpu && <GpuDetail />}
    </div>
  );
}
