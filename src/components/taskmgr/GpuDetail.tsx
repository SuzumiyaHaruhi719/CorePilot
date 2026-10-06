import { useEffect, useState } from "react";
import { formatBytes } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { api, withTimeout } from "../../lib/ipc";
import { useSharedGpuOc } from "../../hooks/useSharedTelemetry";
import { useUiActive } from "../../hooks/useUiActive";
import { useSettings } from "../../store/settings";
import { Sparkline } from "../charts/Sparkline";

/** Engine graphs shown, in Windows Task-Manager order. */
const ENGINES = ["3D", "Copy", "Video Encode", "Video Decode", "Compute"] as const;
const CAP = 60;
const GPU = "var(--color-vcache)";

function push(arr: number[], v: number): number[] {
  const next = arr.length >= CAP ? arr.slice(arr.length - CAP + 1) : arr.slice();
  next.push(v);
  return next;
}

/**
 * GPU extras for the Performance detail pane — mirrors Windows Task Manager's GPU
 * page below the main graph: per-engine graphs (3D / Copy / Video Encode / Video
 * Decode / Compute) and dedicated VRAM. Polls the PDH per-engine aggregate; the
 * NVML snapshot comes from the shared poller. Renders nothing without NVML.
 */
export function GpuDetail() {
  const t = useT();
  // NVML snapshot comes from the app-wide shared poller (one interval for this
  // pane, PerfView and the GPU page; it stops while nobody can see the window).
  const info = useSharedGpuOc();
  const [vramHist, setVramHist] = useState<number[]>([]);
  const [engines, setEngines] = useState<Record<string, number>>({});
  const [engHist, setEngHist] = useState<Record<string, number[]>>({});
  const pollMs = useSettings((s) => s.pollMs);
  const uiActive = useUiActive((s) => s.active);

  // Advance the VRAM graph in step with the shared poller so it stays aligned
  // with the numbers printed beside it.
  useEffect(() => {
    if (!info) return;
    setVramHist((h) => push(h, info.memTotalBytes > 0 ? (info.memUsedBytes / info.memTotalBytes) * 100 : 0));
  }, [info]);

  // Per-engine PDH aggregate. Separate command, so it keeps its own interval —
  // at the user's poll rate, paused while the window is hidden/covered.
  useEffect(() => {
    if (!uiActive) return;
    let alive = true;
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const e = await withTimeout(api.gpuEngines());
        if (!alive) return;
        setEngines(e);
        setEngHist((prev) => {
          const next: Record<string, number[]> = { ...prev };
          for (const name of ENGINES) next[name] = push(prev[name] ?? [], e[name] ?? 0);
          return next;
        });
      } catch {
        /* ignore — degrade silently */
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const id = setInterval(() => void tick(), Math.max(pollMs, 1000));
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [pollMs, uiActive]);

  if (info && !info.available) return null;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
        {ENGINES.map((name) => (
          <div key={name} className="overflow-hidden rounded-md bg-surface2/50 shadow-[inset_0_0_0_1px_var(--color-line)]">
            <div className="flex items-baseline justify-between px-2 pt-1.5">
              <span className="text-[11.5px] text-muted">{name}</span>
              <span className="nums text-[12px] text-ink">{Math.round(engines[name] ?? 0)}%</span>
            </div>
            <Sparkline data={engHist[name] ?? []} max={100} color={GPU} height={36} />
          </div>
        ))}
      </div>

      <div>
        <div className="mb-1.5 flex items-baseline justify-between text-[12px]">
          <span className="text-muted">{t("专用显存 (Dedicated)")}</span>
          <span className="nums text-dim">
            {info ? formatBytes(info.memUsedBytes) : "—"} / {info ? formatBytes(info.memTotalBytes) : "—"}
          </span>
        </div>
        <div className="overflow-hidden rounded-md shadow-[inset_0_0_0_1px_var(--color-line)]">
          <Sparkline data={vramHist} max={100} color="var(--color-cyan)" height={56} grid />
        </div>
      </div>
    </div>
  );
}
