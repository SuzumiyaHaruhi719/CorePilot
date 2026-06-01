import { ArrowDown, ArrowUp } from "lucide-react";
import type { MouseEvent } from "react";
import { cn } from "../../lib/cn";
import { classifyCcd } from "../../lib/cpu";
import { formatBytes } from "../../lib/format";
import type { CpuTopology, ProcInfo } from "../../lib/ipc";
import { groupForProcess, useGroups } from "../../store/groups";

export type SortKey = "name" | "threads" | "cpu" | "gpu" | "mem" | "power";

interface ProcessTableProps {
  processes: ProcInfo[];
  sortKey: SortKey;
  sortDir: "asc" | "desc";
  onSort: (key: SortKey) => void;
  selected: Set<number>;
  onToggle: (pid: number) => void;
  onToggleAll: () => void;
  onRowContextMenu?: (e: MouseEvent, proc: ProcInfo) => void;
  topo: CpuTopology | null;
}

const COLS = "grid-cols-[28px_minmax(0,1fr)_76px_88px_50px_92px_56px]";

/** Hardware threads + CCD a process spans (from its affinity mask). */
function HwThreads({ mask, topo }: { mask: number; topo: CpuTopology | null }) {
  const c = classifyCcd(mask, topo);
  if (c.count === 0) return <span className="nums text-right text-dim">—</span>;
  const dot =
    c.kind === "vcache" ? "bg-vcache" : c.kind === "freq" ? "bg-freq" : c.kind === "mixed" ? "bg-accent" : "bg-dim/60";
  const label =
    c.kind === "vcache" ? "V-Cache CCD" : c.kind === "freq" ? "频率 CCD" : c.kind === "mixed" ? "跨 CCD" : "全部核心";
  return (
    <span className="flex items-center justify-end gap-1.5" title={`${c.count} 硬件线程 · ${label}`}>
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dot)} />
      <span className="nums text-muted">{c.count}</span>
    </span>
  );
}

interface HeadProps {
  k: SortKey;
  label: string;
  sortKey: SortKey;
  sortDir: "asc" | "desc";
  onSort: (k: SortKey) => void;
  align?: "left" | "right";
}

function Head({ k, label, sortKey, sortDir, onSort, align = "right" }: HeadProps) {
  const active = sortKey === k;
  return (
    <button
      onClick={() => onSort(k)}
      className={cn(
        "no-drag flex items-center gap-1 text-[11.5px] font-medium transition-colors hover:text-ink",
        align === "right" ? "justify-end" : "justify-start",
        active ? "text-accent" : "text-muted",
      )}
    >
      {label}
      {active && (sortDir === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
    </button>
  );
}

export function ProcessTable({
  processes,
  sortKey,
  sortDir,
  onSort,
  selected,
  onToggle,
  onToggleAll,
  onRowContextMenu,
  topo,
}: ProcessTableProps) {
  const groups = useGroups((s) => s.groups);
  const allOn = processes.length > 0 && processes.every((p) => selected.has(p.pid));

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-surface/40">
      <div
        className={cn(
          "grid items-center gap-2 border-b border-line bg-surface2/60 px-3 py-2",
          COLS,
        )}
      >
        <button
          onClick={onToggleAll}
          title="全选 / 取消全选"
          className={cn(
            "grid h-4 w-4 place-items-center rounded border transition-colors",
            allOn ? "border-accent bg-accent" : "border-line-strong hover:border-accent/60",
          )}
        >
          {allOn && <span className="h-2 w-2 rounded-[2px] bg-white" />}
        </button>
        <Head k="name" label="进程名" sortKey={sortKey} sortDir={sortDir} onSort={onSort} align="left" />
        <Head k="threads" label="硬件线程" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        <Head k="cpu" label="CPU" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        <Head k="gpu" label="GPU" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        <Head k="mem" label="内存" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        <Head k="power" label="电源" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {processes.map((p) => {
          const group = groupForProcess(groups, p.name);
          const isSelected = selected.has(p.pid);
          return (
            <div
              key={p.pid}
              onClick={() => onToggle(p.pid)}
              onContextMenu={(e) => onRowContextMenu?.(e, p)}
              className={cn(
                "grid cursor-pointer items-center gap-2 border-b border-line/40 px-3 py-[7px] text-[12.5px] transition-colors",
                COLS,
                isSelected ? "bg-accent/10" : "hover:bg-surface2/50",
              )}
            >
              <span
                className={cn(
                  "grid h-4 w-4 place-items-center rounded border transition-colors",
                  isSelected ? "border-accent bg-accent" : "border-line-strong",
                )}
              >
                {isSelected && <span className="h-2 w-2 rounded-[2px] bg-white" />}
              </span>

              <div className="flex min-w-0 items-center gap-2">
                {group ? (
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: `oklch(74% 0.15 ${group.hue})` }}
                    title={group.name}
                  />
                ) : (
                  <span className="h-2 w-2 shrink-0 rounded-full bg-dim/40" />
                )}
                <span className="truncate text-ink" title={p.name}>
                  {p.name}
                </span>
              </div>

              <HwThreads mask={p.affinity} topo={topo} />

              <div className="flex items-center justify-end gap-1.5">
                <span className="relative h-1 w-8 overflow-hidden rounded-full bg-surface3">
                  <span
                    className="absolute inset-y-0 left-0 rounded-full bg-accent"
                    style={{ width: `${Math.min(p.cpu, 100)}%` }}
                  />
                </span>
                <span className="nums w-[38px] text-right text-ink">{p.cpu.toFixed(1)}</span>
              </div>

              <span className="nums text-right text-dim">{p.gpu > 0.05 ? p.gpu.toFixed(1) : "—"}</span>
              <span className="nums text-right text-muted">{formatBytes(p.mem, 0)}</span>
              <span className="nums text-right text-dim">{p.power > 0.05 ? p.power.toFixed(0) : "—"}</span>
            </div>
          );
        })}
        {processes.length === 0 && (
          <div className="py-10 text-center text-[12.5px] text-dim">没有匹配的进程</div>
        )}
      </div>
    </div>
  );
}
