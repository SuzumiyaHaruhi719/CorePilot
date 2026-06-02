import { motion } from "motion/react";
import { cn } from "../../lib/cn";
import { clusterName, clusterTag, clusterTone, maskFromIds, maskHas, toggleBit } from "../../lib/cpu";
import type { CpuTopology } from "../../lib/ipc";

interface CoreGridProps {
  topo: CpuTopology;
  mask: number;
  onChange: (mask: number) => void;
}

const presetClass =
  "no-drag rounded-md border border-line bg-surface2 px-2 py-1 text-[11px] text-muted transition-colors hover:bg-surface3 hover:text-ink";

// Color classes per cluster tone (performance / secondary / neutral).
const TONE = {
  vcache: { text: "text-vcache", dot: "bg-vcache", on: "border-vcache/50 bg-vcache/20 text-vcache glow-sm" },
  freq: { text: "text-freq", dot: "bg-freq", on: "border-freq/50 bg-freq/20 text-freq glow-sm" },
  neutral: { text: "text-accent", dot: "bg-accent", on: "border-accent/50 bg-accent/20 text-accent glow-sm" },
} as const;

export function CoreGrid({ topo, mask, onChange }: CoreGridProps) {
  const allMask = maskFromIds(topo.logical.map((l) => l.id));
  const vcache = topo.ccds.find((c) => c.isVcache);
  const multiCluster = topo.ccds.length > 1;

  return (
    <div className="space-y-3.5">
      {topo.ccds.map((ccd) => {
        // Generalized cluster identity from the backend kind/label: works for
        // AMD V-Cache, Intel P/E, and homogeneous CPUs alike.
        const tone = TONE[clusterTone(ccd.kind)];
        const name = clusterName(topo, ccd);
        const tag = clusterTag(ccd);
        return (
          <div key={ccd.ccdId}>
            <div className="mb-1.5 flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-[11.5px]">
                <span className={cn("h-2 w-2 rounded-full glow-sm", tone.dot)} />
                <span className="font-semibold text-ink">{name}</span>
                {tag && <span className={tone.text}>{tag}</span>}
              </div>
              <button className={presetClass} onClick={() => onChange(maskFromIds(ccd.logicalCpus))}>
                {multiCluster ? "仅此组" : "全选"}
              </button>
            </div>
            <div className="grid grid-cols-8 gap-1.5">
              {ccd.logicalCpus.map((id) => {
                const on = maskHas(mask, id);
                return (
                  <motion.button
                    key={id}
                    whileTap={{ scale: 0.86 }}
                    onClick={() => onChange(toggleBit(mask, id))}
                    className={cn(
                      "nums grid h-8 place-items-center rounded-md border text-[11px] font-medium transition-colors",
                      on ? tone.on : "border-line bg-surface2 text-dim hover:bg-surface3 hover:text-muted",
                    )}
                  >
                    {id}
                  </motion.button>
                );
              })}
            </div>
          </div>
        );
      })}

      <div className="flex flex-wrap gap-2 pt-1">
        <button className={presetClass} onClick={() => onChange(allMask)}>
          全选
        </button>
        <button className={presetClass} onClick={() => onChange(0)}>
          清空
        </button>
        {vcache && (
          <button className={presetClass} onClick={() => onChange(maskFromIds(vcache.logicalCpus))}>
            仅 V-Cache CCD
          </button>
        )}
      </div>
    </div>
  );
}
