import { useEffect, useState } from "react";
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

function MiniGraph({ id, value, hist, color }: { id: number; value: number; hist: number[]; color: string }) {
  return (
    <div className="overflow-hidden rounded-md bg-surface2/50 shadow-[inset_0_0_0_1px_var(--color-line)]">
      <div className="flex items-baseline justify-between px-1.5 pt-1">
        <span className="nums text-[10px] text-dim">{id}</span>
        <span className="nums text-[11px] text-ink">{value.toFixed(0)}</span>
      </div>
      <Sparkline data={hist} max={100} color={color} height={28} />
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
    <div className="space-y-4">
      {ccds.map((ccd) => {
        const color = ccd.isVcache ? "var(--color-vcache)" : "var(--color-freq)";
        return (
          <div key={ccd.ccdId}>
            <div className="mb-2 flex items-center gap-2 text-[12px]">
              <span className="h-2 w-2 rounded-full" style={{ background: color }} />
              <span className="font-medium text-ink">{clusterName(topo, ccd)}</span>
              {clusterTag(ccd) && <span className="text-dim">{clusterTag(ccd)}</span>}
            </div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(64px,1fr))] gap-1.5">
              {ccd.logicalCpus.map((id) => (
                <MiniGraph key={id} id={id} value={perCore[id] ?? 0} hist={hist[id] ?? []} color={color} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
