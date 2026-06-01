import { ArrowDown, ArrowUp, X } from "lucide-react";
import type { MouseEvent } from "react";
import { cn } from "../../lib/cn";
import { formatBytes } from "../../lib/format";
import type { ProcInfo } from "../../lib/ipc";
import type { SortKey } from "../cores/ProcessTable";

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

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-surface/50">
      <div className={cn("grid items-center gap-2 border-b border-line bg-surface2/70 px-3 py-2", cols)}>
        <Head k="name" label="进程名" sortKey={sortKey} sortDir={sortDir} onSort={onSort} align="left" />
        {detailed && <span className="text-right text-[11.5px] font-medium text-muted">PID</span>}
        <Head k="threads" label="线程" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        <Head k="cpu" label="CPU" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        <Head k="gpu" label="GPU" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        {detailed && <span className="text-[11.5px] font-medium text-muted">GPU 引擎</span>}
        <Head k="mem" label="内存" sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
        <span />
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {processes.map((p) => (
          <div
            key={p.pid}
            onContextMenu={(e) => onRowContextMenu?.(e, p)}
            className={cn("group grid items-center gap-2 border-b border-line/40 px-3 py-[7px] text-[12.5px] hover:bg-surface2/50", cols)}
          >
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
            {detailed && <span className="nums text-right text-dim">{p.pid}</span>}
            <span className="nums text-right text-muted">{p.threads || "—"}</span>
            <div className="flex items-center justify-end gap-1.5">
              <span className="relative h-1 w-8 overflow-hidden rounded-full bg-surface3">
                <span
                  className="absolute inset-y-0 left-0 rounded-full bg-accent"
                  style={{ width: `${Math.min(p.cpu, 100)}%` }}
                />
              </span>
              <span className="nums w-[38px] text-right text-ink">{p.cpu.toFixed(1)}</span>
            </div>
            <span
              className="nums text-right text-dim"
              title={p.gpu > 0.05 ? `${p.gpuAdapter ?? "GPU"} · ${p.gpuEngine ?? ""}`.trim() : undefined}
            >
              {p.gpu > 0.05 ? p.gpu.toFixed(1) : "—"}
            </span>
            {detailed && (
              <span className="truncate text-[11.5px] text-muted" title={p.gpuAdapter ?? undefined}>
                {p.gpu > 0.05 ? (p.gpuEngine ?? "—") : "—"}
              </span>
            )}
            <span className="nums text-right text-muted">{formatBytes(p.mem, 0)}</span>
            <button
              onClick={() => onEndTask(p)}
              title="结束任务"
              className="no-drag grid h-6 w-6 place-items-center rounded-md text-dim opacity-0 transition hover:bg-danger hover:text-white group-hover:opacity-100"
            >
              <X size={13} />
            </button>
          </div>
        ))}
        {processes.length === 0 && <div className="py-10 text-center text-[12.5px] text-dim">没有匹配的进程</div>}
      </div>
    </div>
  );
}
