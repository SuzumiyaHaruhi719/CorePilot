import { Play, RotateCw, Search, Square } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "../../lib/cn";
import { api, type ServiceItem } from "../../lib/ipc";

const COLS = "grid-cols-[minmax(0,1fr)_84px_132px]";

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

export function ServicesView() {
  const [services, setServices] = useState<ServiceItem[]>([]);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

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

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q
      ? services.filter((s) => s.display.toLowerCase().includes(q) || s.name.toLowerCase().includes(q))
      : services;
  }, [services, search]);

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
          <span>服务</span>
          <span>状态</span>
          <span className="text-right">操作</span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {visible.map((svc) => (
            <div
              key={svc.name}
              className={cn("grid items-center gap-2 border-b border-line/40 px-3 py-[7px] text-[12.5px] hover:bg-surface2/50", COLS)}
            >
              <div className="min-w-0">
                <div className="truncate text-ink" title={svc.display}>
                  {svc.display || svc.name}
                </div>
                <div className="truncate text-[10.5px] text-dim">{svc.name}</div>
              </div>
              <span className={cn("text-[12px]", STATUS_STYLE[svc.status] ?? "text-dim")}>
                {STATUS_LABEL[svc.status] ?? svc.status}
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
