import { Loader2, Play, RotateCw, Search, Square } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "../../lib/cn";
import { useTf } from "../../lib/i18n";
import { api, type ServiceItem } from "../../lib/ipc";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { Badge } from "../ui/Readout";
import { SortHead as Head, HeadLabel, TABLE, TABLE_HEAD, TABLE_ROW, TableBodyState } from "../ui/Table";

const COLS = "grid-cols-[minmax(110px,0.9fr)_52px_minmax(0,1.5fr)_70px_minmax(0,0.7fr)_108px]";

// Floor width so narrow windows scroll horizontally instead of crushing the
// description / group columns. Full literal so Tailwind's scanner picks it up.
const MIN_W = "min-w-[720px]";

// Skip layout/paint for rows scrolled out of view. `auto` lets the browser
// remember each row's real height after its first paint, so scrollbar size and
// scroll offsets are unchanged. Paint-cost cut only, NOT virtualization: every
// row stays in the DOM. Service rows are always single-line.
const ROW_CV = "[content-visibility:auto] [contain-intrinsic-size:auto_30px]";

const STATUS_TONE: Record<string, "ok" | "neutral" | "warn"> = {
  running: "ok",
  stopped: "neutral",
  paused: "warn",
};

const STATUS_LABEL: Record<string, string> = {
  running: "运行中",
  stopped: "已停止",
  paused: "已暂停",
  other: "其他",
};

const STATUS_EN: Record<string, string> = {
  running: "Running",
  stopped: "Stopped",
  paused: "Paused",
  other: "Other",
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
  // Local sort state (not the shared SortKey); same look as ui/Table's SortHead.
  return <Head k="x" label={label} sortKey={active ? "x" : "-"} sortDir={dir} onSort={onClick} align={align} />;
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
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 pb-6 pt-4">
      <div className="flex items-center gap-3">
        <label className="field no-drag flex w-64 items-center gap-2">
          <Search size={14} className="shrink-0 text-dim" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索服务…"
            className="min-w-0 flex-1 bg-transparent text-[12.5px] text-ink outline-none"
          />
        </label>
        <span className="nums text-[12px] text-dim">{tf(`${visible.length} 项服务`, `${visible.length} services`)}</span>
        <button
          onClick={() => void load()}
          disabled={loading}
          title="刷新"
          aria-label="刷新服务列表"
          className="no-drag grid h-8 w-8 cursor-pointer place-items-center rounded-md text-dim transition-colors hover:bg-surface2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:opacity-50"
        >
          <RotateCw size={13} className={loading ? "animate-spin" : ""} />
        </button>
        {status && <span role="status" className="ml-auto truncate text-[12px] text-muted">{status}</span>}
      </div>

      <div className={TABLE}>
        {/* Horizontal scroll on narrow windows; min-w wrapper keeps the header
            and body aligned while the body scrolls vertically. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-x-auto">
        <div className={cn(MIN_W, TABLE_HEAD, COLS)}>
          <SortHead label="服务名" active={sortKey === "display"} dir={sortDir} onClick={() => sort("display")} />
          <HeadLabel label="PID" align="left" />
          <HeadLabel label="描述" align="left" />
          <SortHead label="状态" active={sortKey === "status"} dir={sortDir} onClick={() => sort("status")} />
          <HeadLabel label="组" align="left" />
          <HeadLabel label="操作" />
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {visible.map((svc) => (
            <div
              key={svc.name}
              className={cn(MIN_W, ROW_CV, TABLE_ROW, "py-[7px]", COLS)}
            >
              <span className="truncate text-ink" title={svc.display || svc.name}>
                {svc.name}
              </span>
              <span className="nums text-dim">{svc.pid ? svc.pid : "—"}</span>
              <span className="truncate text-[12px] text-muted" title={svc.description || svc.display}>
                {svc.description || svc.display || "—"}
              </span>
              <span>
                <Badge tone={STATUS_TONE[svc.status] ?? "neutral"} dot={svc.status === "running"}>
                  {tf(STATUS_LABEL[svc.status] ?? svc.status, STATUS_EN[svc.status] ?? svc.status)}
                </Badge>
              </span>
              <span className="truncate text-[12px] text-dim" title={svc.group}>
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
                      className="no-drag grid h-6 w-6 cursor-pointer place-items-center rounded-md text-dim transition-colors hover:bg-danger/12 hover:text-danger disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {busy === svc.name ? <Loader2 size={12} className="animate-spin" /> : <Square size={12} />}
                    </button>
                    <button
                      disabled={busy !== null}
                      onClick={() => setConfirm({ svc, action: "restart" })}
                      title="重启"
                      aria-label={tf(`重启 ${svc.display || svc.name}`, `Restart ${svc.display || svc.name}`)}
                      className="no-drag grid h-6 w-6 cursor-pointer place-items-center rounded-md text-dim transition-colors hover:bg-surface3 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
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
                    className="no-drag grid h-6 w-6 cursor-pointer place-items-center rounded-md text-dim transition-colors hover:bg-ok/12 hover:text-ok disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {busy === svc.name ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                  </button>
                )}
              </div>
            </div>
          ))}
          {visible.length === 0 && (
            <TableBodyState loading={loading} error={loadErr} emptyLabel="没有匹配的服务" onRetry={() => void load()} />
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
