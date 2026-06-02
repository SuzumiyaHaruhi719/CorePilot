import { motion } from "motion/react";
import { cn } from "../../lib/cn";
import { clusterName, clusterTag } from "../../lib/cpu";
import type { CpuTopology } from "../../lib/ipc";

interface CoreHeatmapProps {
  perCore: number[];
  topo: CpuTopology | null;
}

function Cell({ id, load, vcache }: { id: number; load: number; vcache: boolean }) {
  return (
    <div
      title={`CPU ${id} · ${load.toFixed(0)}%`}
      className="relative h-12 overflow-hidden rounded-md border border-line bg-surface2"
    >
      <motion.div
        className={cn("absolute inset-0", vcache ? "bg-vcache/35" : "bg-freq/35")}
        style={{ transformOrigin: "bottom" }}
        initial={false}
        animate={{ scaleY: Math.min(load, 100) / 100 }}
        transition={{ type: "spring", stiffness: 170, damping: 24 }}
      />
      <span className="nums absolute left-1 top-0.5 text-[9px] text-dim">{id}</span>
    </div>
  );
}

export function CoreHeatmap({ perCore, topo }: CoreHeatmapProps) {
  const ccds = topo?.ccds ?? [
    {
      ccdId: 0,
      isVcache: false,
      l3Bytes: 0,
      logicalCpus: perCore.map((_, i) => i),
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
          <div className="grid grid-cols-8 gap-1.5">
            {ccd.logicalCpus.map((id) => (
              <Cell key={id} id={id} load={perCore[id] ?? 0} vcache={ccd.isVcache} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
