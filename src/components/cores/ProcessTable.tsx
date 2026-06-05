import { ArrowDown, ArrowUp } from "lucide-react";
import type { MouseEvent } from "react";
import { cn } from "../../lib/cn";
import { groupColor } from "../../lib/colors";
import { classifyCcd } from "../../lib/cpu";
import { formatBytes } from "../../lib/format";
import type { CpuTopology, ProcInfo } from "../../lib/ipc";
import { groupForProcess, useGroups } from "../../store/groups";

export type SortKey = "name" | "group" | "threads" | "cpu" | "gpu" | "gpuMem" | "mem" | "power";

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
  /** Show a sortable "分组" column (used in the 全部进程 view). */
  showGroup?: boolean;
}

// The 分组 column is only present in the 全部进程 view; both literal templates
// appear in full so Tailwind's scanner picks them up.
const COLS_WITH_GROUP = "grid-cols-[28px_minmax(0,1fr)_124px_76px_88px_50px_92px_56px]";
const COLS_NO_GROUP = "grid-cols-[28px_minmax(0,1fr)_76px_88px_50px_92px_56px]";

/** Hardware threads + cluster a process spans (from its affinity mask). */
function HwThreads({ mask, topo }: { mask: bigint; topo: CpuTopology | null }) {
  const c = classifyCcd(mask, topo);
  if (c.count === 0) return <span className="nums text-right text-dim">—</span>;
  const dot =
    c.kind === "vcache" || c.kind === "pcore"
      ? "bg-vcache"
      : c.kind === "freq" || c.kind === "ecore"
        ? "bg-freq"
        : c.kind === "mixed" || c.kind === "standard"
          ? "bg-accent"
          : "bg-dim/60";
  const label =
    c.kind === "vcache"
      ? "V-Cache CCD"
      : c.kind === "freq"
        ? "频率 CCD"
        : c.kind === "pcore"
          ? "性能核"
          : c.kind === "ecore"
            ? "能效核"
            : c.kind === "standard"
              ? `CCD ${c.ccdId}`
              : c.kind === "mixed"
                ? "跨 CCD"
                : "全部核心";
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
        "hud-label no-drag flex cursor-pointer items-center gap-1 text-[9.5px] transition-colors hover:text-ink",
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
  showGroup = false,
}: ProcessTableProps) {
  const groups = useGroups((s) => s.groups);
  const allOn = processes.length > 0 && processes.every((p) => selected.has(p.pid));
  const COLS = showGroup ? COLS_WITH_GROUP : COLS_NO_GROUP;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-surface/40">
      <div
        className={cn(
          "grid items-center gap-2 border-b border-line bg-surface2/60 px-3 py-2.5",
          COLS,
        )}
      >
        <button
          onClick={onToggleAll}
          title="全选 / 取消全选"
          className={cn(
            "grid h-4 w-4 cursor-pointer place-items-center rounded border transition-colors",
            allOn ? "border-accent bg-accent" : "border-line-strong hover:border-accent/60",
          )}
        >
          {allOn && <span className="h-2 w-2 rounded-[2px] bg-white" />}
        </button>
        <Head k="name" label="进程名" sortKey={sortKey} sortDir={sortDir} onSort={onSort} align="left" />
        {showGroup && (
          <Head k="group" label="分组" sortKey={sortKey} sortDir={sortDir} onSort={onSort} align="left" />
        )}
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
          const offline = p.offline === true;
          return (
            <div
              key={p.pid}
              onClick={() => onToggle(p.pid)}
              onContextMenu={(e) => onRowContextMenu?.(e, p)}
              className={cn(
                "grid cursor-pointer items-center gap-2 border-b border-line/40 px-3 py-[7px] text-[12.5px] transition-colors",
                COLS,
                isSelected
                  ? "bg-accent/10 shadow-[inset_2px_0_0_0_var(--color-accent)]"
                  : "hover:bg-surface2/50",
                offline && "opacity-65",
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
                    style={{ background: groupColor(group.hue) }}
                    title={group.name}
                  />
                ) : (
                  <span className="h-2 w-2 shrink-0 rounded-full bg-dim/40" />
                )}
                <span className={cn("truncate", offline ? "text-muted" : "text-ink")} title={p.name}>
                  {p.name}
                </span>
                {offline && (
                  <span className="shrink-0 rounded-full border border-line-strong/60 px-1.5 py-px text-[10px] font-medium text-dim">
                    未运行
                  </span>
                )}
              </div>

              {showGroup &&
                (group ? (
                  <span
                    className="max-w-full justify-self-start truncate rounded-full px-2 py-0.5 text-[11px] font-medium"
                    style={{
                      background: `oklch(74% 0.15 ${group.hue} / 0.16)`,
                      color: `oklch(82% 0.13 ${group.hue})`,
                    }}
                    title={group.name}
                  >
                    {group.name}
                  </span>
                ) : (
                  <span className="justify-self-start text-[11.5px] text-dim">—</span>
                ))}

              <HwThreads mask={p.affinity} topo={topo} />

              {offline ? (
                <span className="nums text-right text-dim">—</span>
              ) : (
                <div className="flex items-center justify-end gap-1.5">
                  <span className="relative h-1 w-8 overflow-hidden rounded-full bg-surface3">
                    <span
                      className={cn(
                        "absolute inset-y-0 left-0 rounded-full transition-colors",
                        p.cpu >= 60 ? "bg-warn" : "bg-accent",
                      )}
                      style={{ width: `${Math.min(p.cpu, 100)}%` }}
                    />
                  </span>
                  <span className="nums w-[38px] text-right text-ink">{p.cpu.toFixed(1)}</span>
                </div>
              )}

              <span className="nums text-right text-dim">{p.gpu > 0.05 ? p.gpu.toFixed(1) : "—"}</span>
              <span className="nums text-right text-muted">{offline ? "—" : formatBytes(p.mem, 0)}</span>
              <span className="nums text-right text-dim">{p.power > 0.05 ? p.power.toFixed(0) : "—"}</span>
            </div>
          );
        })}
        {processes.length === 0 && (
          <div className="flex flex-col items-center gap-1.5 py-12 text-center">
            <span className="hud-label text-[10px] text-dim">NO PROCESSES</span>
            <span className="text-[12.5px] text-dim">没有匹配的进程</span>
          </div>
        )}
      </div>
    </div>
  );
}
