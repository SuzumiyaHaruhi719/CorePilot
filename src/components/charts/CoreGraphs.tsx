import { useEffect, useState } from "react";
import { cn } from "../../lib/cn";
import { clusterName, clusterTag } from "../../lib/cpu";
import type { CpuTopology } from "../../lib/ipc";
import { historySnapshot, isRecording } from "../../hooks/useSharedTelemetry";
import { Sparkline } from "./Sparkline";

const POINTS = 40;

/** Seed the per-core buffers from background-recorded history (last POINTS of
 *  each core's ring) when background recording is on, so graphs open full. */
function seedPerCore(): number[][] {
  if (!isRecording()) return [];
  const snap = historySnapshot.perCore();
  if (snap.length === 0) return [];
  return snap.map((buf) => {
    const tail = buf.slice(-POINTS);
    return tail.length < POINTS ? [...new Array(POINTS - tail.length).fill(0), ...tail] : tail;
  });
}

interface CoreGraphsProps {
  perCore: number[];
  topo: CpuTopology | null;
}

function MiniGraph({ id, value, hist, vcache }: { id: number; value: number; hist: number[]; vcache: boolean }) {
  return (
    <div className="rounded-lg border border-line bg-surface2/60 p-1.5">
      <div className="flex items-center justify-between px-0.5">
        <span className="nums text-[9px] text-dim">{id}</span>
        <span className={cn("nums text-[10px] font-medium", vcache ? "text-vcache" : "text-freq")}>
          {value.toFixed(0)}
        </span>
      </div>
      <Sparkline data={hist} max={100} hue={vcache ? 184 : 70} height={30} />
    </div>
  );
}

export function CoreGraphs({ perCore, topo }: CoreGraphsProps) {
  const n = perCore.length || topo?.logicalCount || 0;
  const [hist, setHist] = useState<number[][]>(seedPerCore);

  useEffect(() => {
    if (n === 0) return;
    setHist((prev) => {
      const base = prev.length === n ? prev : Array.from({ length: n }, () => new Array(POINTS).fill(0));
      return base.map((buf, i) => [...buf.slice(1), perCore[i] ?? 0]);
    });
  }, [perCore, n]);

  const ccds = topo?.ccds ?? [
    {
      ccdId: 0,
      isVcache: false,
      l3Bytes: 0,
      logicalCpus: Array.from({ length: n }, (_, i) => i),
      mask: 0n,
      kind: "standard",
      label: "全部核心",
    },
  ];

  return (
    <div className="space-y-3">
      {ccds.map((ccd) => (
        <div key={ccd.ccdId}>
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px]">
            <span className={cn("h-2 w-2 rounded-full glow-sm", ccd.isVcache ? "bg-vcache" : "bg-freq")} />
            <span className="font-medium text-muted">
              {clusterName(topo, ccd)}
              {clusterTag(ccd) ? ` · ${clusterTag(ccd)}` : ""}
            </span>
          </div>
          <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-8">
            {ccd.logicalCpus.map((id) => (
              <MiniGraph
                key={id}
                id={id}
                value={perCore[id] ?? 0}
                hist={hist[id] ?? []}
                vcache={ccd.isVcache}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
