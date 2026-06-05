import { MonitorPlay } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { cn } from "../../lib/cn";
import { formatBytes } from "../../lib/format";
import { api, type GpuOcInfo } from "../../lib/ipc";
import { Sparkline } from "../charts/Sparkline";

/** Engine graphs shown, in Windows Task-Manager order. */
const ENGINES = ["3D", "Copy", "Video Encode", "Video Decode", "Compute"] as const;
const CAP = 60;

function push(arr: number[], v: number): number[] {
  const next = arr.length >= CAP ? arr.slice(arr.length - CAP + 1) : arr.slice();
  next.push(v);
  return next;
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="hud-label text-[9px] text-dim">{label}</div>
      <div className="nums truncate text-[13px] font-medium text-ink">{value}</div>
    </div>
  );
}

/**
 * Detailed GPU panel for the Performance view — mirrors Windows Task Manager's
 * GPU page: a main utilization graph, per-engine graphs (3D / Copy / Video
 * Encode / Video Decode / Compute), dedicated VRAM, and a clock/temp/power/
 * driver info grid. Polls NVML (`gpu_oc_info`) + the PDH per-engine aggregate.
 * Renders nothing when no NVIDIA GPU is present (the basic GPU card still shows).
 */
export function GpuDetail() {
  const [info, setInfo] = useState<GpuOcInfo | null>(null);
  const [utilHist, setUtilHist] = useState<number[]>([]);
  const [vramHist, setVramHist] = useState<number[]>([]);
  const [engines, setEngines] = useState<Record<string, number>>({});
  const [engHist, setEngHist] = useState<Record<string, number[]>>({});

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const [i, e] = await Promise.all([api.gpuOcInfo(), api.gpuEngines()]);
        if (!alive) return;
        setInfo(i);
        setEngines(e);
        setUtilHist((h) => push(h, i.utilizationGpu));
        setVramHist((h) => push(h, i.memTotalBytes > 0 ? (i.memUsedBytes / i.memTotalBytes) * 100 : 0));
        setEngHist((prev) => {
          const next: Record<string, number[]> = { ...prev };
          for (const name of ENGINES) next[name] = push(prev[name] ?? [], e[name] ?? 0);
          return next;
        });
      } catch {
        /* ignore — degrade silently */
      }
    };
    void tick();
    const id = setInterval(tick, 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (info && !info.available) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      className="glass hairline space-y-4 rounded-2xl p-4"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-[12.5px] font-semibold text-muted">
          <MonitorPlay size={15} className="text-vcache" /> GPU
          <span className="font-normal text-dim">— {info?.name ?? "—"}</span>
        </div>
        <div className="nums display text-[22px] font-semibold text-vcache glow-text">{info ? info.utilizationGpu : 0}%</div>
      </div>

      <Sparkline data={utilHist} max={100} hue={184} height={92} />

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
        {ENGINES.map((name) => {
          const live = (engines[name] ?? 0) > 1;
          return (
            <div
              key={name}
              className={cn(
                "rounded-xl border bg-surface2/40 p-2.5 transition-colors",
                live ? "border-vcache/30" : "border-line",
              )}
            >
              <div className="mb-1 flex items-center justify-between">
                <span className="hud-label text-[9px] text-muted">{name}</span>
                <span className={cn("nums text-[12px] font-semibold", live ? "text-vcache" : "text-ink")}>
                  {Math.round(engines[name] ?? 0)}%
                </span>
              </div>
              <Sparkline data={engHist[name] ?? []} max={100} hue={184} height={38} />
            </div>
          );
        })}
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between text-[11px]">
          <span className="text-muted">专用显存 (Dedicated)</span>
          <span className="nums text-dim">
            {info ? formatBytes(info.memUsedBytes) : "—"} / {info ? formatBytes(info.memTotalBytes) : "—"}
          </span>
        </div>
        <Sparkline data={vramHist} max={100} hue={280} height={56} />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Info label="核心频率" value={info ? `${info.graphicsClock} MHz` : "—"} />
        <Info label="显存频率" value={info ? `${info.memClock} MHz` : "—"} />
        <Info label="温度" value={info ? `${info.temperature} °C` : "—"} />
        <Info label="功耗" value={info ? `${info.powerUsageW.toFixed(0)} / ${info.powerLimitW.toFixed(0)} W` : "—"} />
        <Info label="风扇" value={info ? `${info.fanSpeedPct}%` : "—"} />
        <Info label="显存控制器" value={info ? `${info.utilizationMem}%` : "—"} />
        <Info label="显存总量" value={info ? formatBytes(info.memTotalBytes) : "—"} />
        <Info label="驱动版本" value={info?.driverVersion || "—"} />
      </div>
    </motion.div>
  );
}
