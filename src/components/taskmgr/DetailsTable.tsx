import { ArrowDown, ArrowUp, X } from "lucide-react";
import type { MouseEvent } from "react";
import { cn } from "../../lib/cn";
import { formatBytes, formatDuration } from "../../lib/format";
import { useTf } from "../../lib/i18n";
import type { ProcInfo } from "../../lib/ipc";
import type { SortKey } from "../cores/ProcessTable";
import { TableBodyState } from "./TmProcessTable";

interface DetailsTableProps {
  processes: ProcInfo[];
  sortKey: SortKey;
  sortDir: "asc" | "desc";
  onSort: (key: SortKey) => void;
  onEndTask: (proc: ProcInfo) => void;
  onRowContextMenu?: (e: MouseEvent, proc: ProcInfo) => void;
  /** First read in flight — show a skeleton instead of an empty state. */
  loading?: boolean;
  /** First read failed — show a retry/error state. */
  error?: boolean;
}

const COLS =
  "grid-cols-[minmax(0,1fr)_50px_84px_64px_74px_78px_74px_54px_46px_50px_34px]";

// Sum of the fixed columns above (+ a floor for the flexible name column and
// the inter-column gaps) so narrow windows scroll horizontally instead of
// crushing every cell. Kept as a full literal so Tailwind's scanner sees it.
const MIN_W = "min-w-[760px]";

function Head({
  k,
  label,
  sortKey,
  sortDir,
  onSort,
  align = "right",
}: {
  k: SortKey;
  label: string;
  sortKey: SortKey;
  sortDir: "asc" | "desc";
  onSort: (k: SortKey) => void;
  align?: "left" | "right";
}) {
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

export function DetailsTable({
  processes,
  sortKey,
  sortDir,
  onSort,
  onEndTask,
  onRowContextMenu,
  loading,
  error,
}: DetailsTableProps) {
  const tf = useTf();
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-surface/50">
      {/* Horizontal scroll: when the window is narrower than the table's fixed
          columns, scroll instead of squashing. The min-w wrapper holds both the
          header and the (vertically scrolling) body so they stay aligned. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-x-auto">
      <div className={cn(MIN_W, "grid items-center gap-2 border-b border-line bg-surface2/70 px-3 py-2.5", COLS)}>
        <Head k="name" label="名称" sortKey={sortKey} sortDir={sortDir} onSort={onSort} align="left" />
        <span className="hud-label text-right text-[9.5px] text-muted">PID</span>
        <span className="hud-label text-[9.5px] text-muted">用户</span>
        <Head k="cpu" label="CPU" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        <span className="hud-label text-right text-[9.5px] text-muted">CPU时间</span>
        <Head k="mem" label="内存" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        <Head k="gpuMem" label="显存" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        <span className="hud-label text-right text-[9.5px] text-muted">句柄</span>
        <Head k="threads" label="线程" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        <span className="hud-label text-right text-[9.5px] text-muted">平台</span>
        <span />
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {processes.map((p) => (
          <div
            key={p.pid}
            onContextMenu={(e) => onRowContextMenu?.(e, p)}
            className={cn(MIN_W, "group grid items-center gap-2 border-b border-line/40 px-3 py-[7px] text-[12.5px] hover:bg-surface2/50", COLS)}
          >
            <span className="truncate text-ink" title={p.name}>
              {p.name}
            </span>
            <span className="nums text-right text-dim">{p.pid}</span>
            <span className="truncate text-muted" title={p.user ?? undefined}>
              {p.user ?? "—"}
            </span>
            <span className="nums text-right text-ink">{p.cpu.toFixed(1)}</span>
            <span className="nums text-right text-muted">{formatDuration(p.cpuTime ?? 0)}</span>
            <span className="nums text-right text-muted">{formatBytes(p.mem, 0)}</span>
            <span className="nums text-right text-muted">{p.gpuMem ? formatBytes(p.gpuMem, 0) : "—"}</span>
            <span className="nums text-right text-dim">{p.handles ? p.handles : "—"}</span>
            <span className="nums text-right text-muted">{p.threads || "—"}</span>
            <span className="text-right text-[11px] text-dim">{p.platform ?? "—"}</span>
            <button
              onClick={() => onEndTask(p)}
              title="结束任务"
              aria-label={tf(`结束任务 ${p.name}`, `End task ${p.name}`)}
              className="no-drag grid h-6 w-6 cursor-pointer place-items-center rounded-md text-dim opacity-0 transition hover:bg-danger hover:text-white focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
            >
              <X size={13} />
            </button>
          </div>
        ))}
        {processes.length === 0 && (
          <TableBodyState
            loading={loading}
            error={error}
            emptyTag="NO PROCESSES"
            emptyLabel="没有匹配的进程"
          />
        )}
      </div>
      </div>
    </div>
  );
}
