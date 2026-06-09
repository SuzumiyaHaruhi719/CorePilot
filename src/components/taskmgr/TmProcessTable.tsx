import { AlertTriangle, ArrowDown, ArrowUp, ChevronRight, Loader2, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState, type MouseEvent } from "react";
import { cn } from "../../lib/cn";
import { formatBytes } from "../../lib/format";
import { useTf } from "../../lib/i18n";
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
  /** First read in flight — show a skeleton instead of an empty state. */
  loading?: boolean;
  /** First read failed — show a retry/error state. */
  error?: boolean;
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
        "hud-label no-drag flex cursor-pointer items-center gap-1 rounded-sm text-[9.5px] transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60",
        align === "right" ? "justify-end" : "justify-start",
        active ? "text-accent" : "text-muted",
      )}
    >
      {label}
      {active && (sortDir === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
    </button>
  );
}

/** A single shimmering skeleton row, sized to a generic table row so the
 *  loading state keeps the panel from collapsing while the first poll runs. */
function SkeletonRow() {
  return (
    <div className="flex items-center gap-2 border-b border-line/30 px-3 py-[7px]">
      <span className="h-4 w-4 shrink-0 animate-pulse rounded bg-surface3" />
      <span className="h-3 flex-1 animate-pulse rounded bg-surface3/80" />
      <span className="h-3 w-12 shrink-0 animate-pulse rounded bg-surface3/60" />
      <span className="h-3 w-10 shrink-0 animate-pulse rounded bg-surface3/60" />
    </div>
  );
}

interface TableBodyStateProps {
  loading?: boolean;
  error?: boolean;
  /** Uppercase HUD tag shown in the empty state (e.g. "NO PROCESSES"). */
  emptyTag: string;
  /** Friendly empty-state message. */
  emptyLabel: string;
  /** Optional retry handler; renders a retry hint in the error state. */
  onRetry?: () => void;
}

/** The shared loading / error / empty body for every process-style table.
 *  Render this only when there are no rows to show — it picks the right state
 *  so an in-flight first read never masquerades as "no matches". */
export function TableBodyState({ loading, error, emptyTag, emptyLabel, onRetry }: TableBodyStateProps) {
  if (loading) {
    return (
      <div aria-busy="true" aria-live="polite">
        <div className="flex items-center justify-center gap-2 py-3 text-dim">
          <Loader2 size={13} className="animate-spin text-accent" />
          <span className="hud-label text-[10px] text-muted">正在读取…</span>
        </div>
        {Array.from({ length: 7 }).map((_, i) => (
          <SkeletonRow key={i} />
        ))}
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex flex-col items-center gap-2 py-12 text-center" role="alert">
        <AlertTriangle size={20} className="text-warn" />
        <span className="hud-label text-[10px] text-warn">READ FAILED</span>
        <span className="text-[12.5px] text-muted">无法读取进程列表</span>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="no-drag mt-1 cursor-pointer rounded-lg border border-line bg-surface2 px-3 py-1 text-[11.5px] text-ink transition-colors hover:border-accent/50 hover:text-accent"
          >
            重试
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-1.5 py-12 text-center">
      <span className="hud-label text-[10px] text-dim">{emptyTag}</span>
      <span className="text-[12.5px] text-dim">{emptyLabel}</span>
    </div>
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
      <EndTaskButton onClick={() => onEndTask(p)} name={p.description ?? p.name} />
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
      <EndTaskButton onClick={() => onEndTask(p)} name={p.description ?? p.name} />
    </div>
  );
}

function EndTaskButton({ onClick, name }: { onClick: () => void; name: string }) {
  const tf = useTf();
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title="结束任务"
      aria-label={tf(`结束任务 ${name}`, `End task ${name}`)}
      className="no-drag grid h-6 w-6 cursor-pointer place-items-center rounded-md text-dim opacity-0 transition hover:bg-danger hover:text-white focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
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
  loading,
  error,
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
        {groups.length === 0 ? (
          <TableBodyState
            loading={loading}
            error={error}
            emptyTag="NO PROCESSES"
            emptyLabel="没有匹配的进程"
          />
        ) : (
          groups.map((g) => {
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
          })
        )}
      </div>
    </div>
  );
}
