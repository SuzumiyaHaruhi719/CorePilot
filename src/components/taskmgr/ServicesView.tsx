import { ArrowDown, ArrowUp, Loader2, Play, RotateCw, Search, Square } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "../../lib/cn";
import { useTf } from "../../lib/i18n";
import { api, type ServiceItem } from "../../lib/ipc";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";

const COLS = "grid-cols-[minmax(110px,0.9fr)_52px_minmax(0,1.5fr)_70px_minmax(0,0.7fr)_108px]";

// Floor width so narrow windows scroll horizontally instead of crushing the
// description / group columns. Full literal so Tailwind's scanner picks it up.
const MIN_W = "min-w-[720px]";

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
        "hud-label no-drag flex cursor-pointer items-center gap-1 rounded-sm text-[9.5px] transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60",
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
  const tf = useTf();
  const [services, setServices] = useState<ServiceItem[]>([]);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState(false);
  const [confirm, setConfirm] = useState<{ svc: ServiceItem; action: "stop" | "restart" } | null>(null);
  const [sortKey, setSortKey] = useState<SKey>("display");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  async function load() {
    setLoading(true);
    setLoadErr(false);
    try {
      setServices(await api.listServices());
    } catch {
      setStatus("无法读取服务列表");
      setLoadErr(true);
    } finally {
      setLoading(false);
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
      setStatus(tf(`${svc.display} — 操作成功`, `${svc.display} — operation succeeded`));
      await new Promise((r) => setTimeout(r, 700));
      await load();
    } catch {
      setStatus(tf(`${svc.display} — 操作失败（服务可能受保护）`, `${svc.display} — operation failed (service may be protected)`));
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
        <span className="nums text-[11.5px] text-dim">{tf(`${visible.length} 项服务`, `${visible.length} services`)}</span>
        <button
          onClick={() => void load()}
          disabled={loading}
          title="刷新"
          aria-label="刷新服务列表"
          className="no-drag grid h-7 w-7 cursor-pointer place-items-center rounded-lg text-dim transition-colors hover:bg-surface3 hover:text-ink disabled:opacity-50"
        >
          <RotateCw size={13} className={loading ? "animate-spin" : ""} />
        </button>
        {status && <span className="ml-auto text-[11.5px] text-accent">{status}</span>}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-surface/50">
        {/* Horizontal scroll on narrow windows; min-w wrapper keeps the header
            and body aligned while the body scrolls vertically. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-x-auto">
        <div className={cn(MIN_W, "grid items-center gap-2 border-b border-line bg-surface2/70 px-3 py-2.5", COLS)}>
          <SortHead label="服务名" active={sortKey === "display"} dir={sortDir} onClick={() => sort("display")} />
          <span className="hud-label text-[9.5px] text-muted">PID</span>
          <span className="hud-label text-[9.5px] text-muted">描述</span>
          <SortHead label="状态" active={sortKey === "status"} dir={sortDir} onClick={() => sort("status")} />
          <span className="hud-label text-[9.5px] text-muted">组</span>
          <span className="hud-label text-right text-[9.5px] text-muted">操作</span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {visible.map((svc) => (
            <div
              key={svc.name}
              className={cn(MIN_W, "grid items-center gap-2 border-b border-line/40 px-3 py-[7px] text-[12.5px] transition-colors hover:bg-surface2/50", COLS)}
            >
              <span className="truncate text-ink" title={svc.display || svc.name}>
                {svc.name}
              </span>
              <span className="nums text-dim">{svc.pid ? svc.pid : "—"}</span>
              <span className="truncate text-[11.5px] text-muted" title={svc.description || svc.display}>
                {svc.description || svc.display || "—"}
              </span>
              <span className={cn("flex items-center gap-1.5 text-[12px]", STATUS_STYLE[svc.status] ?? "text-dim")}>
                {svc.status === "running" && <span className="h-1.5 w-1.5 rounded-full bg-ok glow-sm" />}
                {STATUS_LABEL[svc.status] ?? svc.status}
              </span>
              <span className="truncate text-[11px] text-dim" title={svc.group}>
                {svc.group || "—"}
              </span>
              <div className="flex items-center justify-end gap-1.5">
                {svc.status === "running" ? (
                  <>
                    <button
                      disabled={busy !== null}
                      onClick={() => setConfirm({ svc, action: "stop" })}
                      title="停止"
                      aria-label={tf(`停止 ${svc.display || svc.name}`, `Stop ${svc.display || svc.name}`)}
                      className="no-drag grid h-6 w-6 cursor-pointer place-items-center rounded-md text-dim transition hover:bg-danger hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {busy === svc.name ? <Loader2 size={12} className="animate-spin" /> : <Square size={12} />}
                    </button>
                    <button
                      disabled={busy !== null}
                      onClick={() => setConfirm({ svc, action: "restart" })}
                      title="重启"
                      aria-label={tf(`重启 ${svc.display || svc.name}`, `Restart ${svc.display || svc.name}`)}
                      className="no-drag grid h-6 w-6 cursor-pointer place-items-center rounded-md text-dim transition hover:bg-surface3 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <RotateCw size={12} />
                    </button>
                  </>
                ) : (
                  <button
                    disabled={busy !== null}
                    onClick={() => void control(svc, "start")}
                    title="启动"
                    aria-label={tf(`启动 ${svc.display || svc.name}`, `Start ${svc.display || svc.name}`)}
                    className="no-drag grid h-6 w-6 cursor-pointer place-items-center rounded-md text-dim transition hover:bg-ok hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {busy === svc.name ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                  </button>
                )}
              </div>
            </div>
          ))}
          {visible.length === 0 && (
            <div className="flex flex-col items-center gap-1.5 py-12 text-center">
              {loading ? (
                <span className="flex items-center gap-2 text-[12.5px] text-dim">
                  <Loader2 size={13} className="animate-spin" /> {tf("正在读取服务…", "Reading services…")}
                </span>
              ) : loadErr ? (
                <>
                  <span className="hud-label text-[10px] text-danger">ERROR</span>
                  <span className="text-[12.5px] text-danger">{tf("无法读取服务列表", "Couldn't read the service list")}</span>
                </>
              ) : (
                <>
                  <span className="hud-label text-[10px] text-dim">NO SERVICES</span>
                  <span className="text-[12.5px] text-dim">没有匹配的服务</span>
                </>
              )}
            </div>
          )}
        </div>
        </div>
      </div>

      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm?.action === "restart" ? "重启服务" : "停止服务"}
        footer={
          <>
            <Button onClick={() => setConfirm(null)} disabled={busy !== null}>取消</Button>
            <Button
              variant="danger"
              disabled={busy !== null}
              onClick={() => {
                if (confirm) void control(confirm.svc, confirm.action);
                setConfirm(null);
              }}
            >
              {confirm?.action === "restart" ? tf("重启", "Restart") : tf("停止", "Stop")}
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-relaxed text-muted">
          {confirm?.action === "restart"
            ? tf(`确定重启服务「${confirm?.svc.display || confirm?.svc.name}」吗？依赖它的功能会短暂中断。`, `Restart the service “${confirm?.svc.display || confirm?.svc.name}”? Features depending on it will briefly stop.`)
            : tf(`确定停止服务「${confirm?.svc.display || confirm?.svc.name}」吗？依赖它的功能将不可用，直到重新启动。`, `Stop the service “${confirm?.svc.display || confirm?.svc.name}”? Features depending on it will be unavailable until it's started again.`)}
        </p>
      </Modal>
    </div>
  );
}
