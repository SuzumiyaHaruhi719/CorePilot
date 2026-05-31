import { Activity, ArrowDown, ArrowUp, Cpu, Gamepad2, Gauge, HardDrive, MemoryStick, MonitorPlay } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { motion } from "motion/react";
import { Sparkline } from "../components/charts/Sparkline";
import { AnimatedNumber } from "../components/ui/AnimatedNumber";
import { TabHeader } from "../components/ui/TabHeader";
import { useMetricsHistory } from "../hooks/useMetricsHistory";
import { useSensors } from "../hooks/useSensors";
import { formatBytes } from "../lib/format";

const fmtRate = (v: number | null | undefined) => (v == null ? "—" : `${formatBytes(v)}/s`);

interface GaugeCardProps {
  icon: LucideIcon;
  label: string;
  value: number | null;
  hue: number;
  hist: number[];
  sub?: string;
}

function GaugeCard({ icon: Icon, label, value, hue, hist, sub }: GaugeCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      className="glass hairline relative overflow-hidden rounded-2xl p-4"
    >
      <div className="flex items-center gap-2 text-[12.5px] font-semibold text-muted">
        <Icon size={15} style={{ color: `oklch(74% 0.14 ${hue})` }} /> {label}
      </div>
      <div
        className="nums mt-1.5 text-[42px] font-bold leading-none glow-text"
        style={{ color: `oklch(80% 0.13 ${hue})` }}
      >
        {value == null ? "—" : <AnimatedNumber value={value} digits={0} suffix="%" />}
      </div>
      <div className="mt-1 h-4 truncate text-[11px] text-dim">{sub ?? ""}</div>
      <div className="mt-2">
        <Sparkline data={hist} max={100} hue={hue} height={72} />
      </div>
    </motion.div>
  );
}

export function Monitor() {
  const { cpu, memPct, latest } = useMetricsHistory(80);
  const { latest: sensors, gpuHist } = useSensors(80);

  const cpuNow = latest?.cpuOverall ?? 0;
  const memUsed = latest?.memUsed ?? 0;
  const memTotal = latest?.memTotal ?? 0;
  const memNowPct = memTotal > 0 ? (memUsed / memTotal) * 100 : 0;

  return (
    <>
      <TabHeader icon={Gauge} title="游戏监控" subtitle="实时性能监控 — CPU / GPU / 内存 / 磁盘 / 网络" />
      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
        <div className="grid gap-4 md:grid-cols-3">
          <GaugeCard icon={Cpu} label="CPU" value={cpuNow} hue={280} hist={cpu} sub={`${cpuNow.toFixed(1)}% 占用`} />
          <GaugeCard
            icon={MonitorPlay}
            label="GPU"
            value={sensors?.gpuPct ?? null}
            hue={184}
            hist={gpuHist}
            sub={sensors?.gpuName ?? "—"}
          />
          <GaugeCard
            icon={MemoryStick}
            label="内存"
            value={memNowPct}
            hue={224}
            hist={memPct}
            sub={`${formatBytes(memUsed)} / ${formatBytes(memTotal)}`}
          />
        </div>

        {/* In-game FPS (honest: needs PresentMon overlay component) */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.05, ease: [0.22, 1, 0.36, 1] }}
          className="glass hairline flex items-center justify-between rounded-2xl p-4"
        >
          <div className="flex items-center gap-3">
            <span className="grid h-11 w-11 place-items-center rounded-xl bg-accent/15 text-accent">
              <Gamepad2 size={21} />
            </span>
            <div>
              <div className="text-[14px] font-semibold text-ink">游戏帧率 (FPS)</div>
              <div className="text-[11.5px] text-dim">
                启动游戏后自动检测 · 游戏内 FPS / 帧时间叠加 (PresentMon) 即将上线
              </div>
            </div>
          </div>
          <div className="nums text-[34px] font-bold text-dim">—</div>
        </motion.div>

        <div className="grid gap-4 sm:grid-cols-2">
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: 0.1, ease: [0.22, 1, 0.36, 1] }}
            className="glass hairline rounded-2xl p-4"
          >
            <div className="mb-3 flex items-center gap-2 text-[12.5px] font-semibold text-muted">
              <HardDrive size={15} className="text-freq" /> 磁盘
            </div>
            <div className="grid grid-cols-2 gap-3">
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
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: 0.15, ease: [0.22, 1, 0.36, 1] }}
            className="glass hairline rounded-2xl p-4"
          >
            <div className="mb-3 flex items-center gap-2 text-[12.5px] font-semibold text-muted">
              <Activity size={15} className="text-accent" /> 网络
            </div>
            <div className="grid grid-cols-2 gap-3">
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
          </motion.div>
        </div>
      </div>
    </>
  );
}
