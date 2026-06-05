import { ArrowDown, ArrowUp, X } from "lucide-react";
import type { MouseEvent } from "react";
import { cn } from "../../lib/cn";
import { formatBytes, formatDuration } from "../../lib/format";
import type { ProcInfo } from "../../lib/ipc";
import type { SortKey } from "../cores/ProcessTable";

interface DetailsTableProps {
  processes: ProcInfo[];
  sortKey: SortKey;
  sortDir: "asc" | "desc";
  onSort: (key: SortKey) => void;
  onEndTask: (proc: ProcInfo) => void;
  onRowContextMenu?: (e: MouseEvent, proc: ProcInfo) => void;
}

const COLS =
  "grid-cols-[minmax(0,1fr)_50px_84px_64px_74px_78px_74px_54px_46px_50px_34px]";

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

export function DetailsTable({ processes, sortKey, sortDir, onSort, onEndTask, onRowContextMenu }: DetailsTableProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-surface/50">
      <div className={cn("grid items-center gap-2 border-b border-line bg-surface2/70 px-3 py-2.5", COLS)}>
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
            className={cn("group grid items-center gap-2 border-b border-line/40 px-3 py-[7px] text-[12.5px] hover:bg-surface2/50", COLS)}
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
              className="no-drag grid h-6 w-6 place-items-center rounded-md text-dim opacity-0 transition hover:bg-danger hover:text-white group-hover:opacity-100"
            >
              <X size={13} />
            </button>
          </div>
        ))}
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
