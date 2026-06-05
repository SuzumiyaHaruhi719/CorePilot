import { ArrowDown, ArrowUp, ChevronRight, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState, type MouseEvent } from "react";
import { cn } from "../../lib/cn";
import { formatBytes } from "../../lib/format";
import type { ProcInfo } from "../../lib/ipc";
import { easeOut } from "../../lib/motion";
import type { SortKey } from "../cores/ProcessTable";
import { ProcIcon } from "./ProcIcon";
import { buildProcGroups, type ProcGroup } from "./procGroups";

interface TmProcessTableProps {
  processes: ProcInfo[];
  sortKey: SortKey;
  sortDir: "asc" | "desc";
  onSort: (key: SortKey) => void;
  onEndTask: (proc: ProcInfo) => void;
  onRowContextMenu?: (e: MouseEvent, proc: ProcInfo) => void;
  detailed?: boolean;
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

/** A horizontal mini-bar + value, reused for CPU on every row.
 *  Bar hue shifts to warn above 60% load for at-a-glance telemetry. */
function CpuCell({ value }: { value: number }) {
  const hot = value >= 60;
  return (
    <div className="flex items-center justify-end gap-1.5">
      <span className="relative h-1 w-8 overflow-hidden rounded-full bg-surface3">
        <span
          className={cn("absolute inset-y-0 left-0 rounded-full transition-colors", hot ? "bg-warn" : "bg-accent")}
          style={{ width: `${Math.min(value, 100)}%` }}
        />
      </span>
      <span className="nums w-[38px] text-right text-ink">{value.toFixed(1)}</span>
    </div>
  );
}

interface MetricCellsProps {
  cpu: number;
  gpu: number;
  mem: number;
  threads: number;
  gpuEngine?: string | null;
  gpuAdapter?: string | null;
  detailed?: boolean;
}

/** The shared CPU / GPU / (engine) / memory cells used by every row variant. */
function MetricCells({ cpu, gpu, mem, threads, gpuEngine, gpuAdapter, detailed }: MetricCellsProps) {
  return (
    <>
      <span className="nums text-right text-muted">{threads || "—"}</span>
      <CpuCell value={cpu} />
      <span
        className={cn("nums text-right", gpu > 0.05 ? "text-vcache" : "text-dim")}
        title={gpu > 0.05 ? `${gpuAdapter ?? "GPU"} · ${gpuEngine ?? ""}`.trim() : undefined}
      >
        {gpu > 0.05 ? gpu.toFixed(1) : "—"}
      </span>
      {detailed &&
        (gpu > 0.05 && gpuEngine ? (
          <span
            className="hud-label justify-self-start truncate rounded border border-vcache/30 bg-vcache/10 px-1.5 py-px text-[9px] text-vcache"
            title={gpuAdapter ?? undefined}
          >
            {gpuEngine}
          </span>
        ) : (
          <span className="text-[11.5px] text-dim">—</span>
        ))}
      <span className="nums text-right text-muted">{formatBytes(mem, 0)}</span>
    </>
  );
}

interface RowProps {
  cols: string;
  detailed?: boolean;
  onEndTask: (proc: ProcInfo) => void;
  onRowContextMenu?: (e: MouseEvent, proc: ProcInfo) => void;
}

/** A single (ungrouped) process row. */
function LeafRow({ p, cols, detailed, onEndTask, onRowContextMenu }: RowProps & { p: ProcInfo }) {
  return (
    <div
      onContextMenu={(e) => onRowContextMenu?.(e, p)}
      className={cn(
        "group grid items-center gap-2 border-b border-line/40 px-3 py-[7px] text-[12.5px] hover:bg-surface2/50",
        cols,
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        {/* Spacer aligns single rows with grouped rows (where a chevron sits). */}
        <span className="w-3.5 shrink-0" />
        <ProcIcon exePath={p.exePath} />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-ink" title={p.description ?? p.name}>
            {p.description ?? p.name}
          </span>
          {p.description && (
            <span className="truncate text-[10.5px] leading-tight text-dim" title={p.name}>
              {p.name}
            </span>
          )}
        </div>
      </div>
      {detailed && <span className="nums text-right text-dim">{p.pid}</span>}
      <MetricCells
        cpu={p.cpu}
        gpu={p.gpu}
        mem={p.mem}
        threads={p.threads}
        gpuEngine={p.gpuEngine}
        gpuAdapter={p.gpuAdapter}
        detailed={detailed}
      />
      <EndTaskButton onClick={() => onEndTask(p)} />
    </div>
  );
}

/** The parent/app row for a multi-instance group. Click toggles expansion. */
function GroupRow({
  g,
  cols,
  detailed,
  expanded,
  onToggle,
  onRowContextMenu,
}: RowProps & { g: ProcGroup; expanded: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      onContextMenu={(e) => onRowContextMenu?.(e, g.members[0])}
      className={cn(
        "no-drag grid w-full items-center gap-2 border-b border-line/40 bg-surface2/35 px-3 py-[7px] text-left text-[12.5px] transition-colors hover:bg-surface2/70",
        cols,
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <motion.span
          animate={{ rotate: expanded ? 90 : 0 }}
          transition={{ duration: 0.18, ease: easeOut }}
          className="grid w-3.5 shrink-0 place-items-center text-muted"
        >
          <ChevronRight size={13} />
        </motion.span>
        <ProcIcon exePath={g.exePath} />
        <span className="truncate font-medium text-ink" title={g.label}>
          {g.label}
        </span>
        <span className="nums shrink-0 text-[11px] text-dim">({g.members.length})</span>
      </div>
      {detailed && <span className="nums text-right text-dim">—</span>}
      <MetricCells cpu={g.cpu} gpu={g.gpu} mem={g.mem} threads={g.threads} detailed={detailed} />
      {/* Keep the trailing action column aligned; groups have no single End-task. */}
      <span />
    </button>
  );
}

/** An indented child row revealed when its group is expanded. */
function ChildRow({ p, cols, detailed, onEndTask, onRowContextMenu }: RowProps & { p: ProcInfo }) {
  return (
    <div
      onContextMenu={(e) => onRowContextMenu?.(e, p)}
      className={cn(
        "group grid items-center gap-2 border-b border-line/30 bg-surface/30 px-3 py-[6px] text-[12.5px] hover:bg-surface2/50",
        cols,
      )}
    >
      <div className="flex min-w-0 items-center gap-2 pl-3.5">
        <span className="w-3.5 shrink-0" />
        <ProcIcon exePath={p.exePath} size={15} />
        <span className="truncate text-muted" title={`${p.description ?? p.name} · PID ${p.pid}`}>
          {p.description ?? p.name}
        </span>
      </div>
      {detailed && <span className="nums text-right text-dim">{p.pid}</span>}
      <MetricCells
        cpu={p.cpu}
        gpu={p.gpu}
        mem={p.mem}
        threads={p.threads}
        gpuEngine={p.gpuEngine}
        gpuAdapter={p.gpuAdapter}
        detailed={detailed}
      />
      <EndTaskButton onClick={() => onEndTask(p)} />
    </div>
  );
}

function EndTaskButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title="结束任务"
      className="no-drag grid h-6 w-6 place-items-center rounded-md text-dim opacity-0 transition hover:bg-danger hover:text-white group-hover:opacity-100"
    >
      <X size={13} />
    </button>
  );
}

export function TmProcessTable({
  processes,
  sortKey,
  sortDir,
  onSort,
  onEndTask,
  onRowContextMenu,
  detailed,
}: TmProcessTableProps) {
  const cols = detailed
    ? "grid-cols-[minmax(0,1fr)_56px_44px_78px_46px_minmax(96px,0.9fr)_84px_36px]"
    : "grid-cols-[minmax(0,1fr)_48px_84px_50px_92px_40px]";

  // Which app groups are expanded. Keyed by the stable group key so the set
  // survives re-sorts and the 1s polling refresh.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  const groups = useMemo(
    () => buildProcGroups(processes, sortKey, sortDir),
    [processes, sortKey, sortDir],
  );

  function toggle(key: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const rowProps = { cols, detailed, onEndTask, onRowContextMenu };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-surface/50">
      <div className={cn("grid items-center gap-2 border-b border-line bg-surface2/70 px-3 py-2.5", cols)}>
        <Head k="name" label="进程名" sortKey={sortKey} sortDir={sortDir} onSort={onSort} align="left" />
        {detailed && <span className="hud-label text-right text-[9.5px] text-muted">PID</span>}
        <Head k="threads" label="线程" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        <Head k="cpu" label="CPU" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        <Head k="gpu" label="GPU" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        {detailed && <span className="hud-label text-[9.5px] text-muted">GPU 引擎</span>}
        <Head k="mem" label="内存" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        <span />
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {groups.map((g) => {
          if (!g.isGroup) {
            return <LeafRow key={g.key} p={g.members[0]} {...rowProps} />;
          }
          const isOpen = expanded.has(g.key);
          return (
            <div key={g.key}>
              <GroupRow g={g} expanded={isOpen} onToggle={() => toggle(g.key)} {...rowProps} />
              <AnimatePresence initial={false}>
                {isOpen && (
                  <motion.div
                    key="children"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2, ease: easeOut }}
                    className="overflow-hidden"
                  >
                    {g.members.map((p) => (
                      <ChildRow key={p.pid} p={p} {...rowProps} />
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
        {groups.length === 0 && (
          <div className="flex flex-col items-center gap-1.5 py-12 text-center">
            <span className="hud-label text-[10px] text-dim">NO PROCESSES</span>
            <span className="text-[12.5px] text-dim">没有匹配的进程</span>
          </div>
        )}
      </div>
    </div>
  );
}
