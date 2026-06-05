import { motion } from "motion/react";
import { cn } from "../../lib/cn";
import { clusterName, clusterTag, clusterTone, maskFromIds, maskHas, toggleBit } from "../../lib/cpu";
import type { CpuTopology } from "../../lib/ipc";

interface CoreGridProps {
  topo: CpuTopology;
  mask: bigint;
  onChange: (mask: bigint) => void;
}

const presetClass =
  "no-drag cursor-pointer rounded-md border border-line bg-surface2 px-2.5 py-1 text-[11px] font-medium text-muted transition-[background-color,border-color,color] duration-150 hover:border-line-strong hover:bg-surface3 hover:text-ink active:scale-[0.97]";

// Color classes per cluster tone (performance / secondary / neutral).
const TONE = {
  vcache: {
    text: "text-vcache",
    dot: "bg-vcache",
    on: "border-vcache/55 bg-vcache/20 text-vcache shadow-[0_0_10px_-1px_color-mix(in_oklch,var(--color-vcache)_45%,transparent)]",
  },
  freq: {
    text: "text-freq",
    dot: "bg-freq",
    on: "border-freq/55 bg-freq/20 text-freq shadow-[0_0_10px_-1px_color-mix(in_oklch,var(--color-freq)_45%,transparent)]",
  },
  neutral: {
    text: "text-accent",
    dot: "bg-accent",
    on: "border-accent/55 bg-accent/20 text-accent shadow-[0_0_10px_-1px_color-mix(in_oklch,var(--color-accent)_45%,transparent)]",
  },
} as const;

export function CoreGrid({ topo, mask, onChange }: CoreGridProps) {
  const allMask = maskFromIds(topo.logical.map((l) => l.id));
  const vcache = topo.ccds.find((c) => c.isVcache);
  const multiCluster = topo.ccds.length > 1;
  const selectedCount = topo.logical.filter((l) => maskHas(mask, l.id)).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="hud-label text-[10px] text-dim">CORE MAP · 核心映射</span>
        <span className="nums text-[11px] text-muted">
          <span className="text-accent">{selectedCount}</span> / {topo.logical.length} 已选
        </span>
      </div>
      {topo.ccds.map((ccd) => {
        // Generalized cluster identity from the backend kind/label: works for
        // AMD V-Cache, Intel P/E, and homogeneous CPUs alike.
        const tone = TONE[clusterTone(ccd.kind)];
        const name = clusterName(topo, ccd);
        const tag = clusterTag(ccd);
        const onInCluster = ccd.logicalCpus.filter((id) => maskHas(mask, id)).length;
        return (
          <div key={ccd.ccdId} className="hud-frame rounded-xl border border-line bg-surface2/30 p-3">
            <div className="mb-2.5 flex items-center justify-between">
              <div className="flex items-center gap-2 text-[11.5px]">
                <span className={cn("h-2 w-2 rounded-full glow-sm", tone.dot)} />
                <span className="font-semibold text-ink">{name}</span>
                {tag && <span className={cn("hud-label text-[9.5px]", tone.text)}>{tag}</span>}
                <span className="nums text-[10.5px] text-dim">{onInCluster}/{ccd.logicalCpus.length}</span>
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
                    title={`CPU ${id}`}
                    className={cn(
                      "nums grid h-8 cursor-pointer place-items-center rounded-md border text-[11px] font-medium transition-[background-color,border-color,color,box-shadow] duration-150",
                      on
                        ? tone.on
                        : "border-line bg-surface2 text-dim hover:border-line-strong hover:bg-surface3 hover:text-muted",
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

      <div className="flex flex-wrap gap-2 pt-0.5">
        <button className={presetClass} onClick={() => onChange(allMask)}>
          全选
        </button>
        <button className={presetClass} onClick={() => onChange(0n)}>
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
