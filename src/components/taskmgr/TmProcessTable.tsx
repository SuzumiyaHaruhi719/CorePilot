import { ChevronRight, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { memo, useCallback, useMemo, useState, type MouseEvent } from "react";
import { cn } from "../../lib/cn";
import { formatBytes } from "../../lib/format";
import { useTf } from "../../lib/i18n";
import type { ProcInfo } from "../../lib/ipc";
import { easeOut } from "../../lib/motion";
import type { SortKey } from "../cores/ProcessTable";
import { SortHead as Head, HeadLabel, TABLE, TABLE_HEAD, TABLE_ROW, TableBodyState } from "../ui/Table";
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

// Skip layout/paint for rows scrolled out of the viewport. `auto` makes the
// browser remember each row's real height after its first paint, so scrollbar
// size and scroll offsets stay exactly as they are today. This is a paint-cost
// cut, NOT virtualization — every row stays in the DOM, so scroll position,
// find-in-page and focus order are unchanged.
// A leaf row grows to two lines when the process has a file description, hence
// the taller placeholder; group/child rows are always single-line.
const ROW_CV_2LINE = "[content-visibility:auto] [contain-intrinsic-size:auto_36px]";
const ROW_CV_1LINE = "[content-visibility:auto] [contain-intrinsic-size:auto_30px]";

export { TableBodyState };

/** A horizontal mini-bar + value, reused for CPU on every row.
 *  Bar hue shifts to warn above 60% load for at-a-glance telemetry. */
function CpuCell({ value }: { value: number }) {
  const hot = value >= 60;
  return (
    <div className="flex items-center justify-end gap-1.5">
      <span className="relative h-1 w-8 overflow-hidden rounded-full bg-surface3">
        <span
          className={cn("absolute inset-y-0 left-0 origin-left rounded-full transition-[transform,background-color] duration-300", hot ? "bg-warn" : "bg-accent")}
          style={{ width: "100%", transform: `scaleX(${Math.min(value, 100) / 100})` }}
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
            className="justify-self-start truncate rounded bg-vcache/12 px-1.5 text-[11px] font-medium leading-5 text-vcache"
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
const LeafRow = memo(function LeafRow({ p, cols, detailed, onEndTask, onRowContextMenu }: RowProps & { p: ProcInfo }) {
  return (
    <div
      onContextMenu={(e) => onRowContextMenu?.(e, p)}
      className={cn(
        "group py-[7px]",
        TABLE_ROW,
        ROW_CV_2LINE,
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
            <span className="truncate text-[11px] leading-tight text-dim" title={p.name}>
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
});

/** The parent/app row for a multi-instance group. Click toggles expansion. */
const GroupRow = memo(function GroupRow({
  g,
  cols,
  detailed,
  expanded,
  onToggle,
  onRowContextMenu,
}: RowProps & { g: ProcGroup; expanded: boolean; onToggle: (key: string) => void }) {
  return (
    <button
      type="button"
      // The group key is closed over HERE, inside the memo, so the parent can
      // hand every group the same stable `onToggle`. An `() => toggle(g.key)`
      // built in the parent's map would be a new function per group per render
      // and would defeat this component's memo on every 1.5 s poll.
      onClick={() => onToggle(g.key)}
      onContextMenu={(e) => onRowContextMenu?.(e, g.members[0])}
      className={cn(
        "no-drag w-full py-[7px] text-left focus-visible:outline-none focus-visible:bg-surface2",
        TABLE_ROW,
        ROW_CV_1LINE,
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
});

/** An indented child row revealed when its group is expanded. */
const ChildRow = memo(function ChildRow({ p, cols, detailed, onEndTask, onRowContextMenu }: RowProps & { p: ProcInfo }) {
  return (
    <div
      onContextMenu={(e) => onRowContextMenu?.(e, p)}
      className={cn(
        "group bg-surface2/25 py-[6px]",
        TABLE_ROW,
        ROW_CV_1LINE,
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
});

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
      className="no-drag grid h-6 w-6 cursor-pointer place-items-center rounded-md text-dim opacity-0 transition-[opacity,color,background-color] duration-150 hover:bg-danger/12 hover:text-danger focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 group-hover:opacity-100 group-focus-within:opacity-100"
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

  const toggle = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const rowProps = useMemo(
    () => ({ cols, detailed, onEndTask, onRowContextMenu }),
    [cols, detailed, onEndTask, onRowContextMenu],
  );

  return (
    <div className={TABLE}>
      <div className={cn(TABLE_HEAD, cols)}>
        <Head k="name" label="进程名" sortKey={sortKey} sortDir={sortDir} onSort={onSort} align="left" />
        {detailed && <HeadLabel label="PID" />}
        <Head k="threads" label="线程" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        <Head k="cpu" label="CPU" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        <Head k="gpu" label="GPU" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        {detailed && <HeadLabel label="GPU 引擎" align="left" />}
        <Head k="mem" label="内存" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        <span />
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {groups.length === 0 ? (
          <TableBodyState loading={loading} error={error} emptyLabel="没有匹配的进程" emptyHint="换个关键词试试" />
        ) : (
          groups.map((g) => {
            if (!g.isGroup) {
              return <LeafRow key={g.key} p={g.members[0]} {...rowProps} />;
            }
            const isOpen = expanded.has(g.key);
            return (
              <div key={g.key}>
                <GroupRow g={g} expanded={isOpen} onToggle={toggle} {...rowProps} />
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
