import { X } from "lucide-react";
import type { MouseEvent } from "react";
import { cn } from "../../lib/cn";
import { formatBytes, formatDuration } from "../../lib/format";
import { useTf } from "../../lib/i18n";
import type { ProcInfo } from "../../lib/ipc";
import type { SortKey } from "../cores/ProcessTable";
import { SortHead as Head, HeadLabel, TABLE, TABLE_HEAD, TABLE_ROW, TableBodyState } from "../ui/Table";

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

// Skip layout/paint for rows scrolled out of view. `auto` lets the browser
// remember each row's real height after its first paint, so scrollbar size and
// scroll offsets are unchanged. Paint-cost cut only, NOT virtualization: every
// row stays in the DOM. Details rows are always single-line.
const ROW_CV = "[content-visibility:auto] [contain-intrinsic-size:auto_30px]";

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
    <div className={TABLE}>
      {/* Horizontal scroll: when the window is narrower than the table's fixed
          columns, scroll instead of squashing. The min-w wrapper holds both the
          header and the (vertically scrolling) body so they stay aligned. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-x-auto">
      <div className={cn(MIN_W, TABLE_HEAD, COLS)}>
        <Head k="name" label="名称" sortKey={sortKey} sortDir={sortDir} onSort={onSort} align="left" />
        <HeadLabel label="PID" />
        <span className="pl-2"><HeadLabel label="用户" align="left" /></span>
        <Head k="cpu" label="CPU" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        <HeadLabel label="CPU时间" />
        <Head k="mem" label="内存" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        <Head k="gpuMem" label="显存" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        <HeadLabel label="句柄" />
        <Head k="threads" label="线程" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        <HeadLabel label="平台" />
        <span />
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {processes.map((p) => (
          <div
            key={p.pid}
            onContextMenu={(e) => onRowContextMenu?.(e, p)}
            className={cn(MIN_W, ROW_CV, TABLE_ROW, "group py-[7px]", COLS)}
          >
            <span className="truncate text-ink" title={p.name}>
              {p.name}
            </span>
            <span className="nums text-right text-dim">{p.pid}</span>
            <span className="truncate pl-2 text-muted" title={p.user ?? undefined}>
              {p.user ?? "—"}
            </span>
            <span className="nums text-right text-ink">{p.cpu.toFixed(1)}</span>
            <span className="nums text-right text-muted">{formatDuration(p.cpuTime ?? 0)}</span>
            <span className="nums text-right text-muted">{formatBytes(p.mem, 0)}</span>
            <span className="nums text-right text-muted">{p.gpuMem ? formatBytes(p.gpuMem, 0) : "—"}</span>
            <span className="nums text-right text-dim">{p.handles ? p.handles : "—"}</span>
            <span className="nums text-right text-muted">{p.threads || "—"}</span>
            <span className="text-right text-[12px] text-dim">{p.platform ?? "—"}</span>
            <button
              onClick={() => onEndTask(p)}
              title="结束任务"
              aria-label={tf(`结束任务 ${p.name}`, `End task ${p.name}`)}
              className="no-drag grid h-6 w-6 cursor-pointer place-items-center rounded-md text-dim opacity-0 transition-[opacity,color,background-color] duration-150 hover:bg-danger/12 hover:text-danger focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 group-hover:opacity-100 group-focus-within:opacity-100"
            >
              <X size={13} />
            </button>
          </div>
        ))}
        {processes.length === 0 && (
          <TableBodyState loading={loading} error={error} emptyLabel="没有匹配的进程" emptyHint="换个关键词试试" />
        )}
      </div>
      </div>
    </div>
  );
}
