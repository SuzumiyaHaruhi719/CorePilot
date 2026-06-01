import { ArrowDown, ArrowUp, Play, RotateCw, Search, Square } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "../../lib/cn";
import { api, type ServiceItem } from "../../lib/ipc";

const COLS = "grid-cols-[minmax(110px,0.9fr)_52px_minmax(0,1.5fr)_70px_minmax(0,0.7fr)_108px]";

const STATUS_STYLE: Record<string, string> = {
  running: "text-ok",
  stopped: "text-dim",
  paused: "text-warn",
};

const STATUS_LABEL: Record<string, string> = {
  running: "运行中",
  stopped: "已停止",
  paused: "已暂停",
  other: "其他",
};

const STATUS_RANK: Record<string, number> = { running: 0, paused: 1, stopped: 2, other: 3 };

type SKey = "display" | "status";

function SortHead({
  label,
  active,
  dir,
  onClick,
  align = "left",
}: {
  label: string;
  active: boolean;
  dir: "asc" | "desc";
  onClick: () => void;
  align?: "left" | "right";
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "no-drag flex items-center gap-1 text-[11.5px] font-medium transition-colors hover:text-ink",
        align === "right" ? "justify-end" : "justify-start",
        active ? "text-accent" : "text-muted",
      )}
    >
      {label}
      {active && (dir === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
    </button>
  );
}

export function ServicesView() {
  const [services, setServices] = useState<ServiceItem[]>([]);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SKey>("display");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  async function load() {
    try {
      setServices(await api.listServices());
    } catch {
      setStatus("无法读取服务列表");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function sort(k: SKey) {
    if (k === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(k);
      setSortDir("asc");
    }
  }

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q
      ? services.filter((s) => s.display.toLowerCase().includes(q) || s.name.toLowerCase().includes(q))
      : services;
    return [...filtered].sort((a, b) => {
      const byName = (a.display || a.name).localeCompare(b.display || b.name);
      const r = sortKey === "status" ? (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) || byName : byName;
      return sortDir === "asc" ? r : -r;
    });
  }, [services, search, sortKey, sortDir]);

  async function control(svc: ServiceItem, action: "start" | "stop" | "restart") {
    setBusy(svc.name);
    try {
      await api.controlService(svc.name, action);
      setStatus(`${svc.display} — 操作成功`);
      await new Promise((r) => setTimeout(r, 700));
      await load();
    } catch {
      setStatus(`${svc.display} — 操作失败（服务可能受保护）`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      <div className="flex items-center gap-3">
        <div className="no-drag relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-dim" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索服务…"
            className="w-56 rounded-lg border border-line bg-surface2 py-1.5 pl-8 pr-3 text-[12.5px] text-ink outline-none transition-colors focus:border-accent/50"
          />
        </div>
        <span className="nums text-[11.5px] text-dim">{visible.length} 项服务</span>
        <button
          onClick={() => void load()}
          title="刷新"
          className="no-drag grid h-7 w-7 place-items-center rounded-lg text-dim transition-colors hover:bg-surface3 hover:text-ink"
        >
          <RotateCw size={13} />
        </button>
        {status && <span className="ml-auto text-[11.5px] text-accent">{status}</span>}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-surface/50">
        <div className={cn("grid items-center gap-2 border-b border-line bg-surface2/70 px-3 py-2 text-[11.5px] font-medium text-muted", COLS)}>
          <SortHead label="服务名" active={sortKey === "display"} dir={sortDir} onClick={() => sort("display")} />
          <span className="text-[11.5px] font-medium text-muted">PID</span>
          <span className="text-[11.5px] font-medium text-muted">描述</span>
          <SortHead label="状态" active={sortKey === "status"} dir={sortDir} onClick={() => sort("status")} />
          <span className="text-[11.5px] font-medium text-muted">组</span>
          <span className="text-right text-[11.5px] font-medium text-muted">操作</span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {visible.map((svc) => (
            <div
              key={svc.name}
              className={cn("grid items-center gap-2 border-b border-line/40 px-3 py-[7px] text-[12.5px] hover:bg-surface2/50", COLS)}
            >
              <span className="truncate text-ink" title={svc.display || svc.name}>
                {svc.name}
              </span>
              <span className="nums text-dim">{svc.pid ? svc.pid : "—"}</span>
              <span className="truncate text-[11.5px] text-muted" title={svc.description || svc.display}>
                {svc.description || svc.display || "—"}
              </span>
              <span className={cn("text-[12px]", STATUS_STYLE[svc.status] ?? "text-dim")}>
                {STATUS_LABEL[svc.status] ?? svc.status}
              </span>
              <span className="truncate text-[11px] text-dim" title={svc.group}>
                {svc.group || "—"}
              </span>
              <div className="flex items-center justify-end gap-1.5">
                {svc.status === "running" ? (
                  <>
                    <button
                      disabled={busy === svc.name}
                      onClick={() => control(svc, "stop")}
                      title="停止"
                      className="no-drag grid h-6 w-6 place-items-center rounded-md text-dim transition hover:bg-danger hover:text-white disabled:opacity-40"
                    >
                      <Square size={12} />
                    </button>
                    <button
                      disabled={busy === svc.name}
                      onClick={() => control(svc, "restart")}
                      title="重启"
                      className="no-drag grid h-6 w-6 place-items-center rounded-md text-dim transition hover:bg-surface3 hover:text-ink disabled:opacity-40"
                    >
                      <RotateCw size={12} />
                    </button>
                  </>
                ) : (
                  <button
                    disabled={busy === svc.name}
                    onClick={() => control(svc, "start")}
                    title="启动"
                    className="no-drag grid h-6 w-6 place-items-center rounded-md text-dim transition hover:bg-ok hover:text-white disabled:opacity-40"
                  >
                    <Play size={12} />
                  </button>
                )}
              </div>
            </div>
          ))}
          {visible.length === 0 && <div className="py-10 text-center text-[12.5px] text-dim">没有匹配的服务</div>}
        </div>
      </div>
    </div>
  );
}
