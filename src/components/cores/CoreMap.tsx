import { useMemo } from "react";
import { cn } from "../../lib/cn";
import { clusterName, clusterTag, clusterTone, maskHas } from "../../lib/cpu";
import { useT } from "../../lib/i18n";
import type { CpuTopology } from "../../lib/ipc";
import { useSharedMetrics } from "../../hooks/useSharedTelemetry";

const TONE_COLOR = {
  vcache: "var(--color-vcache)",
  freq: "var(--color-freq)",
  neutral: "var(--color-accent)",
} as const;

interface CoreMapProps {
  topo: CpuTopology;
  /** Live per-logical-CPU load (0–100). */
  perCore: number[];
  /** The group's affinity mask; null = no group (load-only overview). 0n = all cores. */
  mask: bigint | null;
  /** Group color for the cores in `mask`. */
  color?: string;
}

/**
 * The die, drawn as it is: one column per physical core, its SMT sibling beneath,
 * one block per cluster (CCD / P-cores / E-cores). Cores in the group's mask are
 * outlined in the group color; every cell fills bottom-up with that thread's
 * live load. Read-only — editing happens in the 选择核心 dialog.
 */
export function CoreMap({ topo, perCore, mask, color = "var(--color-accent)" }: CoreMapProps) {
  const t = useT();
  const byId = useMemo(() => new Map(topo.logical.map((l) => [l.id, l])), [topo]);

  const clusters = useMemo(
    () =>
      topo.ccds.map((ccd) => {
        const ids = new Set(ccd.logicalCpus);
        // Primary thread of each physical core = the lower id of an SMT pair
        // (or the only thread when SMT is off / an E-core).
        const cols: Array<[number, number | null]> = [];
        for (const id of ccd.logicalCpus) {
          const sib = byId.get(id)?.smtSibling ?? null;
          if (sib != null && ids.has(sib) && sib < id) continue;
          cols.push([id, sib != null && ids.has(sib) ? sib : null]);
        }
        return { ccd, cols };
      }),
    [topo, byId],
  );

  const inMask = (id: number) => mask != null && (mask === 0n || maskHas(mask, id));

  return (
    <div className="flex flex-wrap gap-x-8 gap-y-4">
      {clusters.map(({ ccd, cols }) => {
        const tone = TONE_COLOR[clusterTone(ccd.kind)];
        const picked = ccd.logicalCpus.filter(inMask).length;
        return (
          <div key={ccd.ccdId} className="min-w-0">
            <div className="mb-2 flex items-center gap-2 text-[12px]">
              <span className="h-2 w-2 rounded-full" style={{ background: tone }} />
              <span className="font-medium text-ink">{t(clusterName(topo, ccd))}</span>
              {clusterTag(ccd) && <span className="text-dim">{t(clusterTag(ccd))}</span>}
              {mask != null && (
                <span className="nums text-dim">
                  {picked}/{ccd.logicalCpus.length}
                </span>
              )}
            </div>
            <div className="flex gap-1">
              {cols.map(([a, b]) => (
                <div key={a} className="flex flex-col gap-1">
                  {[a, b].map((id, row) =>
                    id == null ? (
                      row === 1 && cols.some(([, s]) => s != null) ? <span key="gap" className="h-7 w-7" /> : null
                    ) : (
                      <Cell key={id} id={id} load={perCore[id] ?? 0} on={inMask(id)} color={color} dimmed={mask != null && !inMask(id)} />
                    ),
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Cell({ id, load, on, color, dimmed }: { id: number; load: number; on: boolean; color: string; dimmed: boolean }) {
  const l = Math.max(0, Math.min(100, load));
  return (
    <span
      title={`CPU ${id} · ${l.toFixed(0)}%`}
      className={cn("relative block h-7 w-7 overflow-hidden rounded-md transition-[box-shadow,opacity] duration-200", dimmed && "opacity-55")}
      style={{
        background: "var(--color-surface2)",
        boxShadow: on ? `inset 0 0 0 1.5px ${color}` : "inset 0 0 0 1px var(--color-line)",
      }}
    >
      <span
        className="absolute inset-0 origin-bottom transition-transform duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]"
        style={{
          transform: `scaleY(${l / 100})`,
          background: on ? `color-mix(in oklch, ${color} 45%, transparent)` : "color-mix(in oklch, var(--color-ink) 16%, transparent)",
        }}
      />
      <span className="nums relative grid h-full place-items-center text-[10.5px] text-muted">{id}</span>
    </span>
  );
}

/** CoreMap fed by the shared metrics poller — isolated so only the map
 *  re-renders on each tick, not the page that hosts it. */
export function LiveCoreMap(props: Omit<CoreMapProps, "perCore">) {
  const metrics = useSharedMetrics();
  return <CoreMap {...props} perCore={metrics?.perCore ?? []} />;
}
