import { motion } from "motion/react";
import { cn } from "../../lib/cn";
import { useT, useTf } from "../../lib/i18n";
import { clusterName, clusterTag, clusterTone, maskFromIds, maskHas, toggleBit } from "../../lib/cpu";
import type { CpuTopology } from "../../lib/ipc";

interface CoreGridProps {
  topo: CpuTopology;
  mask: bigint;
  onChange: (mask: bigint) => void;
}

const presetClass =
  "no-drag h-7 cursor-pointer rounded-md bg-surface2 px-2.5 text-[12px] text-muted shadow-[inset_0_0_0_1px_var(--color-line)] transition-colors duration-150 hover:bg-surface3 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60";

// Selected-cell classes per cluster tone (performance / secondary / neutral).
const TONE = {
  vcache: { dot: "bg-vcache", on: "bg-vcache/22 text-ink shadow-[inset_0_0_0_1.5px_var(--color-vcache)]" },
  freq: { dot: "bg-freq", on: "bg-freq/22 text-ink shadow-[inset_0_0_0_1.5px_var(--color-freq)]" },
  neutral: { dot: "bg-accent", on: "bg-accent/22 text-ink shadow-[inset_0_0_0_1.5px_var(--color-accent)]" },
} as const;

export function CoreGrid({ topo, mask, onChange }: CoreGridProps) {
  const t = useT();
  const tf = useTf();
  const allMask = maskFromIds(topo.logical.map((l) => l.id));
  const vcache = topo.ccds.find((c) => c.isVcache);
  const multiCluster = topo.ccds.length > 1;
  const selectedCount = topo.logical.filter((l) => maskHas(mask, l.id)).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-[12.5px] text-muted">{tf("点击核心切换；分组内进程只会运行在选中的核心上。", "Click cores to toggle; the group's processes run only on selected cores.")}</span>
        <span className="nums shrink-0 text-[12px] text-muted">
          <span className="text-ink">{selectedCount}</span> / {topo.logical.length} {tf("已选", "selected")}
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
          <div key={ccd.ccdId} className="border-t border-line pt-3">
            <div className="mb-2.5 flex items-center justify-between">
              <div className="flex items-center gap-2 text-[12px]">
                <span className={cn("h-2 w-2 rounded-full", tone.dot)} />
                <span className="font-medium text-ink">{t(name)}</span>
                {tag && <span className="text-dim">{t(tag)}</span>}
                <span className="nums text-dim">{onInCluster}/{ccd.logicalCpus.length}</span>
              </div>
              <button className={presetClass} onClick={() => onChange(maskFromIds(ccd.logicalCpus))}>
                {multiCluster ? t("仅此组") : t("全选")}
              </button>
            </div>
            <div className="grid grid-cols-8 gap-1.5">
              {ccd.logicalCpus.map((id) => {
                const on = maskHas(mask, id);
                return (
                  <motion.button
                    key={id}
                    whileTap={{ scale: 0.92 }}
                    aria-pressed={on}
                    onClick={() => onChange(toggleBit(mask, id))}
                    title={`CPU ${id}`}
                    className={cn(
                      "nums grid h-8 cursor-pointer place-items-center rounded-md text-[12px] transition-[background-color,color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
                      on ? tone.on : "bg-surface2 text-dim shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-surface3 hover:text-muted",
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

      <div className="flex flex-wrap gap-2 border-t border-line pt-3">
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
