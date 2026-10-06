import { motion } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";
import { useMetricsHistory } from "../../hooks/useMetricsHistory";
import { useSensors } from "../../hooks/useSensors";
import { useSharedGpuOc } from "../../hooks/useSharedTelemetry";
import { cn } from "../../lib/cn";
import { formatBytes } from "../../lib/format";
import { useT, useTf } from "../../lib/i18n";
import { easeOut } from "../../lib/motion";
import { type CpuTopology, type Overview } from "../../lib/ipc";
import { getOverviewOnce, getTopologyOnce } from "../../lib/memoOnce";
import { useSettings, type PerfCard } from "../../store/settings";
import { useUi } from "../../store/ui";
import { CoreGraphs } from "../charts/CoreGraphs";
import { DualSparkline } from "../charts/DualSparkline";
import { Sparkline } from "../charts/Sparkline";
import { AnimatedNumber } from "../ui/AnimatedNumber";
import { Cluster, ClusterCell, Readout } from "../ui/Readout";
import { GpuDetail } from "./GpuDetail";

const ORDER: PerfCard[] = ["cpu", "mem", "gpu", "disk", "net", "power"];

/** Fixed series color per device family (DESIGN.md → data series). */
const COLOR: Record<PerfCard, string> = {
  cpu: "var(--color-accent)",
  mem: "var(--color-cyan)",
  gpu: "var(--color-vcache)",
  disk: "var(--color-freq)",
  net: "var(--color-ok)",
  power: "var(--color-warn)",
};
const NET_UP = "var(--color-warn)";

const rate = (v: number | null | undefined) => (v == null ? "—" : `${formatBytes(v)}/s`);
const pct = (v: number | null | undefined) => (v == null ? "—" : `${v.toFixed(0)}%`);
const ghz = (mhz: number | null | undefined) =>
  mhz == null ? null : mhz >= 1000 ? `${(mhz / 1000).toFixed(2)} GHz` : `${Math.round(mhz)} MHz`;
const temp = (v: number | null | undefined) => (v == null ? null : `${v.toFixed(0)} °C`);

interface Device {
  id: PerfCard;
  title: string;
  /** Hardware name shown under the detail title. */
  name?: string;
  /** Big headline value (number animates; string is shown as-is). */
  value: number | string | null;
  digits?: number;
  unit?: string;
  /** Two short status lines for the device list. */
  lines: [string | null, string | null];
  /** Mini/large chart. */
  chart: (height: number, grid?: boolean) => ReactNode;
  /** Label at the chart's top corners. */
  chartLeft: string;
  chartRight: string;
}

function DeviceRow({ d, active, onSelect }: { d: Device; active: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? "true" : undefined}
      className={cn(
        "no-drag flex w-full items-center gap-3 rounded-lg p-2 text-left transition-colors duration-150",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
        active ? "bg-surface2" : "hover:bg-surface2/50",
      )}
    >
      <div
        className="h-11 w-[68px] shrink-0 overflow-hidden rounded bg-base transition-shadow duration-150"
        style={{ boxShadow: `inset 0 0 0 1px ${active ? COLOR[d.id] : "var(--color-line)"}` }}
      >
        {d.chart(44)}
      </div>
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-ink">{d.title}</div>
        <div className="nums truncate text-[12px] text-muted">{d.lines[0] ?? "—"}</div>
        {d.lines[1] && <div className="nums truncate text-[11.5px] text-dim">{d.lines[1]}</div>}
      </div>
    </button>
  );
}

export function PerfView() {
  const t = useT();
  const tf = useTf();
  const { cpu, memPct, latest } = useMetricsHistory(60);
  const { latest: sensors, gpuHist, diskHist, netUpHist, netDownHist, powerHist } = useSensors(60);
  const [topo, setTopo] = useState<CpuTopology | null>(null);
  const [overview, setOverview] = useState<Overview | null>(null);
  const perfCards = useSettings((s) => s.perfCards);
  const togglePerfCard = useSettings((s) => s.togglePerfCard);
  const sel = useUi((s) => s.perfDevice);
  const setSel = useUi((s) => s.setPerfDevice);

  // Both are fixed hardware descriptions, memoized for the session: the 性能
  // sub-tab is remounted every time the user switches sub-tab OR top-level tab,
  // and each remount used to re-issue both IPCs for data that cannot change.
  useEffect(() => {
    getTopologyOnce().then(setTopo).catch(() => undefined);
    getOverviewOnce().then(setOverview).catch(() => undefined);
  }, []);

  // NVML clocks/temperature for the GPU device (graphicsClock isn't in Sensors).
  // Shared poller — one interval for this view, GpuDetail and the GPU page; it
  // stops entirely while nobody can see the window.
  const gpuOc = useSharedGpuOc();

  const cpuNow = latest?.cpuOverall ?? 0;
  const memUsed = latest?.memUsed ?? 0;
  const memTotal = latest?.memTotal ?? 0;
  const memNowPct = memTotal > 0 ? (memUsed / memTotal) * 100 : 0;
  const vramPct = sensors?.vramTotal && sensors.vramUsed ? (sensors.vramUsed / sensors.vramTotal) * 100 : null;
  // Prefer NVML readings; fall back to the generic sensor when NVML is absent.
  const gpuOcLive = gpuOc?.available ? gpuOc : null;
  const gpuTemp = gpuOcLive?.temperature ?? sensors?.gpuTemp ?? null;
  const diskMax = Math.max(...diskHist, 1);
  const powerMax = Math.max(...powerHist, 1);
  const totalPower =
    sensors?.cpuPower != null || sensors?.gpuPower != null ? (sensors?.cpuPower ?? 0) + (sensors?.gpuPower ?? 0) : null;

  const devices: Record<PerfCard, Device> = {
    cpu: {
      id: "cpu",
      title: "CPU",
      name: overview?.cpuName,
      value: cpuNow,
      digits: 0,
      unit: "%",
      lines: [`${cpuNow.toFixed(0)}%  ${ghz(sensors?.cpuClock) ?? ""}`, temp(sensors?.cpuTemp)],
      chart: (h, grid) => <Sparkline data={cpu} max={100} color={COLOR.cpu} height={h} grid={grid} />,
      chartLeft: tf("利用率", "Utilization"),
      chartRight: "100%",
    },
    mem: {
      id: "mem",
      title: t("内存"),
      name: memTotal ? formatBytes(memTotal) : undefined,
      value: memNowPct,
      digits: 0,
      unit: "%",
      lines: [`${formatBytes(memUsed)} / ${formatBytes(memTotal)}`, `${memNowPct.toFixed(0)}%`],
      chart: (h, grid) => <Sparkline data={memPct} max={100} color={COLOR.mem} height={h} grid={grid} />,
      chartLeft: tf("内存使用量", "Memory usage"),
      chartRight: memTotal ? formatBytes(memTotal) : "100%",
    },
    gpu: {
      id: "gpu",
      title: "GPU",
      name: sensors?.gpuName ?? undefined,
      value: sensors?.gpuPct ?? null,
      digits: 0,
      unit: "%",
      lines: [pct(sensors?.gpuPct), temp(gpuTemp)],
      chart: (h, grid) => <Sparkline data={gpuHist} max={100} color={COLOR.gpu} height={h} grid={grid} />,
      chartLeft: "3D",
      chartRight: "100%",
    },
    disk: {
      id: "disk",
      title: t("磁盘"),
      value: sensors?.diskPct ?? null,
      digits: 0,
      unit: "%",
      lines: [`${tf("读", "R")} ${rate(sensors?.diskRead)}`, `${tf("写", "W")} ${rate(sensors?.diskWrite)}`],
      chart: (h, grid) => <Sparkline data={diskHist} max={diskMax} color={COLOR.disk} height={h} grid={grid} />,
      chartLeft: tf("读写速率", "Transfer rate"),
      chartRight: `${formatBytes(diskMax)}/s`,
    },
    net: {
      id: "net",
      title: t("网络"),
      value: rate((sensors?.netDown ?? 0) + (sensors?.netUp ?? 0)),
      lines: [`↓ ${rate(sensors?.netDown)}`, `↑ ${rate(sensors?.netUp)}`],
      chart: (h, grid) => <DualSparkline up={netUpHist} down={netDownHist} upColor={NET_UP} downColor={COLOR.net} height={h} grid={grid} />,
      chartLeft: tf("吞吐量（上下行各自缩放）", "Throughput (each axis scaled)"),
      chartRight: "",
    },
    power: {
      id: "power",
      title: t("功耗"),
      name: tf("CPU + GPU 实时功耗", "Live CPU + GPU power"),
      value: totalPower,
      digits: 0,
      unit: "W",
      lines: [totalPower != null ? `${totalPower.toFixed(0)} W` : null, null],
      chart: (h, grid) => <Sparkline data={powerHist} max={powerMax} color={COLOR.power} height={h} grid={grid} />,
      chartLeft: tf("总功耗", "Total power"),
      chartRight: `${powerMax.toFixed(0)} W`,
    },
  };

  const visible = ORDER.filter((id) => perfCards[id]);
  const active = visible.includes(sel) ? sel : visible[0];
  const d = active ? devices[active] : null;

  return (
    <div className="flex min-h-0 flex-1 gap-4 px-6 pb-6 pt-4">
      {/* Device list — Windows Task Manager's left column. */}
      <aside className="flex w-[228px] shrink-0 flex-col overflow-y-auto">
        <div className="flex flex-col gap-0.5">
          {visible.map((id) => (
            <DeviceRow key={id} d={devices[id]} active={id === active} onSelect={() => setSel(id)} />
          ))}
        </div>
        <div className="mt-auto border-t border-line pt-3">
          <div className="mb-2 px-2 text-[11.5px] text-dim">{tf("显示的设备", "Shown devices")}</div>
          <div className="flex flex-wrap gap-1 px-1">
            {ORDER.map((id) => (
              <button
                key={id}
                type="button"
                aria-pressed={perfCards[id]}
                onClick={() => togglePerfCard(id)}
                className={cn(
                  "no-drag h-6 cursor-pointer rounded-md px-2 text-[11.5px] transition-colors duration-150",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
                  perfCards[id] ? "bg-surface3 text-ink" : "text-dim hover:bg-surface2 hover:text-muted",
                )}
              >
                {devices[id].title}
              </button>
            ))}
          </div>
        </div>
      </aside>

      {/* Detail — big chart + readouts for the selected device. */}
      <section className="glass min-w-0 flex-1 overflow-y-auto rounded-xl">
        {!d ? (
          <div className="grid h-full place-items-center p-8 text-center">
            <div>
              <div className="text-[14px] font-semibold text-ink">{tf("没有显示的设备", "No devices shown")}</div>
              <p className="mt-1 text-[12.5px] text-muted">{tf("在左下角选择要显示的设备。", "Pick devices to show at the bottom left.")}</p>
            </div>
          </div>
        ) : (
          <motion.div key={d.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.18, ease: easeOut }}>
            <header className="flex items-end justify-between gap-6 px-5 pt-4">
              <div className="min-w-0">
                <h2 className="font-title text-[20px] font-semibold text-ink">{d.title}</h2>
                <div className="mt-0.5 truncate text-[12px] text-dim" title={d.name}>
                  {d.name ?? " "}
                </div>
              </div>
              <div className="nums flex shrink-0 items-baseline gap-1 text-[40px] font-light leading-none" style={{ color: COLOR[d.id] }}>
                {d.value == null ? (
                  <span className="text-dim">—</span>
                ) : typeof d.value === "number" ? (
                  <AnimatedNumber value={d.value} digits={d.digits ?? 0} />
                ) : (
                  <span className="text-[28px]">{d.value}</span>
                )}
                {d.unit && d.value != null && <span className="text-[15px] text-dim">{d.unit}</span>}
              </div>
            </header>

            <div className="px-5 pt-3">
              <div className="mb-1 flex justify-between text-[11px] text-dim">
                <span>{d.chartLeft}</span>
                <span className="nums">{d.chartRight}</span>
              </div>
              <div
                className="overflow-hidden rounded-md shadow-[inset_0_0_0_1px_var(--color-line)]"
                style={{ background: `color-mix(in oklch, ${COLOR[d.id]} 3%, transparent)` }}
              >
                {d.chart(200, true)}
              </div>
              <div className="mt-1 flex justify-between text-[11px] text-dim">
                <span className="nums">{tf("60 秒", "60 seconds")}</span>
                <span className="nums">0</span>
              </div>
              {d.id === "net" && (
                <div className="mt-2 flex gap-4 text-[11.5px] text-muted">
                  <span className="flex items-center gap-1.5">
                    <span className="h-0.5 w-3 rounded-full" style={{ background: COLOR.net }} />
                    {tf("下载", "Download")}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-0.5 w-3 rounded-full" style={{ background: NET_UP }} />
                    {tf("上传", "Upload")}
                  </span>
                </div>
              )}
            </div>

            <Cluster className="mt-4 border-t border-line" min={108}>
              {d.id === "cpu" && (
                <>
                  <ClusterCell><Readout label="频率" value={ghz(sensors?.cpuClock)} /></ClusterCell>
                  <ClusterCell><Readout label="温度" value={sensors?.cpuTemp} digits={0} unit="°C" /></ClusterCell>
                  <ClusterCell><Readout label="功耗" value={sensors?.cpuPower} digits={0} unit="W" /></ClusterCell>
                  <ClusterCell><Readout label="核心" value={overview?.physicalCores} /></ClusterCell>
                  <ClusterCell><Readout label="逻辑处理器" value={overview?.logicalCpus} /></ClusterCell>
                  {/* V-Cache is X3D-only; on other CPUs show SMT status instead. */}
                  <ClusterCell>
                    {overview?.vcacheCcd != null ? (
                      <Readout label="V-Cache" value={`CCD${overview.vcacheCcd}`} />
                    ) : (
                      <Readout label="超线程" value={overview ? (overview.logicalCpus > overview.physicalCores ? t("开启") : t("关闭")) : null} />
                    )}
                  </ClusterCell>
                </>
              )}
              {d.id === "mem" && (
                <>
                  <ClusterCell meter={memNowPct} meterColor={COLOR.mem}><Readout label="已用" value={formatBytes(memUsed)} /></ClusterCell>
                  <ClusterCell><Readout label="可用" value={formatBytes(Math.max(memTotal - memUsed, 0))} /></ClusterCell>
                  <ClusterCell><Readout label="总计" value={formatBytes(memTotal)} /></ClusterCell>
                </>
              )}
              {d.id === "gpu" && (
                <>
                  <ClusterCell><Readout label="核心频率" value={gpuOcLive?.graphicsClock} unit="MHz" /></ClusterCell>
                  <ClusterCell><Readout label="显存频率" value={gpuOcLive?.memClock} unit="MHz" /></ClusterCell>
                  <ClusterCell><Readout label="温度" value={gpuTemp} digits={0} unit="°C" /></ClusterCell>
                  <ClusterCell><Readout label="功耗" value={gpuOcLive?.powerUsageW ?? sensors?.gpuPower} digits={0} unit="W" sub={gpuOcLive ? `/ ${gpuOcLive.powerLimitW.toFixed(0)} W` : undefined} /></ClusterCell>
                  <ClusterCell><Readout label="风扇" value={gpuOcLive?.fanSpeedPct} unit="%" /></ClusterCell>
                  <ClusterCell meter={vramPct ?? undefined} meterColor="var(--color-cyan)">
                    <Readout label="显存已用" value={sensors?.vramUsed != null ? formatBytes(sensors.vramUsed) : null} sub={sensors?.vramTotal != null ? `/ ${formatBytes(sensors.vramTotal)}` : undefined} />
                  </ClusterCell>
                  <ClusterCell><Readout label="显存控制器" value={gpuOcLive?.utilizationMem} unit="%" /></ClusterCell>
                  <ClusterCell><Readout label="驱动版本" value={gpuOcLive?.driverVersion || null} /></ClusterCell>
                </>
              )}
              {d.id === "disk" && (
                <>
                  <ClusterCell><Readout label="活动时间" value={sensors?.diskPct} digits={0} unit="%" /></ClusterCell>
                  <ClusterCell><Readout label="读取" value={rate(sensors?.diskRead)} color={sensors?.diskRead ? undefined : "var(--color-dim)"} /></ClusterCell>
                  <ClusterCell><Readout label="写入" value={rate(sensors?.diskWrite)} color={sensors?.diskWrite ? undefined : "var(--color-dim)"} /></ClusterCell>
                </>
              )}
              {d.id === "net" && (
                <>
                  <ClusterCell><Readout label="下载" value={rate(sensors?.netDown)} color={COLOR.net} /></ClusterCell>
                  <ClusterCell><Readout label="上传" value={rate(sensors?.netUp)} color={NET_UP} /></ClusterCell>
                </>
              )}
              {d.id === "power" && (
                <>
                  <ClusterCell><Readout label="CPU 功耗" value={sensors?.cpuPower} digits={0} unit="W" /></ClusterCell>
                  <ClusterCell><Readout label="GPU 功耗" value={sensors?.gpuPower} digits={0} unit="W" /></ClusterCell>
                  <ClusterCell><Readout label="CPU 温度" value={sensors?.cpuTemp} digits={0} unit="°C" /></ClusterCell>
                  <ClusterCell><Readout label="GPU 温度" value={sensors?.gpuTemp} digits={0} unit="°C" /></ClusterCell>
                </>
              )}
            </Cluster>

            {d.id === "power" && sensors?.cpuPower == null && sensors?.gpuPower == null && (
              <p className="border-t border-line px-5 py-3 text-[12px] text-muted">
                功耗 / 温度需要传感器组件；若显示 “—”，请确认 sensord 已随程序部署。
              </p>
            )}
            {d.id === "cpu" && (
              <div className="border-t border-line px-5 py-4">
                <div className="mb-3 flex items-baseline gap-2">
                  <span className="text-[13px] font-semibold text-ink">{t("逻辑处理器利用率")}</span>
                  <span className="nums text-[12px] text-dim">
                    {overview ? tf(`${overview.logicalCpus} 线程`, `${overview.logicalCpus} threads`) : ""}
                  </span>
                </div>
                <CoreGraphs perCore={latest?.perCore ?? []} topo={topo} />
              </div>
            )}
            {d.id === "gpu" && (
              <div className="border-t border-line px-5 py-4">
                <GpuDetail />
              </div>
            )}
          </motion.div>
        )}
      </section>
    </div>
  );
}
