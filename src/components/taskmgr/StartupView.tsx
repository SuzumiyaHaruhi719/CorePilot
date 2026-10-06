import { RotateCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "../../lib/cn";
import { useTf } from "../../lib/i18n";
import { api, type StartupItem } from "../../lib/ipc";
import { SortHead as Head, HeadLabel, TABLE, TABLE_HEAD, TABLE_ROW, TableBodyState } from "../ui/Table";
import { Toggle } from "../ui/Toggle";

const COLS = "grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_92px_64px]";

// Floor width so narrow windows scroll horizontally instead of crushing the
// name / command columns. Full literal so Tailwind's scanner picks it up.
const MIN_W = "min-w-[560px]";

const LOC_LABEL: Record<string, string> = {
  hkcu_run: "用户启动",
  hklm_run: "系统启动",
  startup_folder: "启动文件夹",
};

type SKey = "name" | "location" | "enabled";

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

export function StartupView() {
  const tf = useTf();
  const [items, setItems] = useState<StartupItem[]>([]);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SKey>("enabled");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  async function load() {
    setLoading(true);
    setLoadErr(false);
    try {
      setItems(await api.listStartup());
    } catch {
      setStatus("无法读取启动项");
      setLoadErr(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function toggle(item: StartupItem) {
    const key = `${item.location}:${item.name}`;
    if (busyKey) return;
    setBusyKey(key);
    try {
      await api.setStartupEnabled(item.name, item.location, !item.enabled);
      setStatus(tf(`${item.name} — ${!item.enabled ? "已启用" : "已禁用"}`, `${item.name} — ${!item.enabled ? "enabled" : "disabled"}`));
      await load();
    } catch {
      setStatus(tf(`${item.name} — 修改失败（可能需要管理员权限）`, `${item.name} — change failed (admin rights may be required)`));
    } finally {
      setBusyKey(null);
    }
  }

  function sort(k: SKey) {
    if (k === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(k);
      setSortDir(k === "enabled" ? "desc" : "asc");
    }
  }

  const visible = useMemo(() => {
    return [...items].sort((a, b) => {
      let r = 0;
      if (sortKey === "name") r = a.name.localeCompare(b.name);
      else if (sortKey === "location") r = a.location.localeCompare(b.location);
      else r = (a.enabled ? 1 : 0) - (b.enabled ? 1 : 0);
      if (r === 0) r = a.name.localeCompare(b.name);
      return sortDir === "asc" ? r : -r;
    });
  }, [items, sortKey, sortDir]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 pb-6 pt-4">
      <div className="flex items-center gap-3">
        <span className="nums text-[12px] text-dim">{tf(`${items.length} 个启动项`, `${items.length} startup items`)}</span>
        <button
          onClick={() => void load()}
          disabled={loading}
          title="刷新"
          aria-label="刷新启动项"
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
          <SortHead label="名称" active={sortKey === "name"} dir={sortDir} onClick={() => sort("name")} />
          <HeadLabel label="命令" align="left" />
          <SortHead label="位置" active={sortKey === "location"} dir={sortDir} onClick={() => sort("location")} />
          <SortHead
            label="启用"
            active={sortKey === "enabled"}
            dir={sortDir}
            onClick={() => sort("enabled")}
            align="right"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {visible.map((item) => (
            <div
              key={`${item.location}:${item.name}`}
              className={cn(MIN_W, TABLE_ROW, "py-2", COLS)}
            >
              <span className={cn("truncate", item.enabled ? "text-ink" : "text-dim")} title={item.name}>
                {item.name}
              </span>
              <span className="truncate font-mono text-[11.5px] text-dim" title={item.command}>
                {item.command}
              </span>
              <span className="text-[12px] text-muted">{LOC_LABEL[item.location] ?? item.location}</span>
              <div className="flex justify-end">
                <Toggle
                  checked={item.enabled}
                  disabled={busyKey !== null}
                  label={tf(`${item.name} 开机启动`, `${item.name} startup`)}
                  onChange={() => toggle(item)}
                />
              </div>
            </div>
          ))}
          {visible.length === 0 && (
            <TableBodyState loading={loading} error={loadErr} emptyLabel="没有启动项" onRetry={() => void load()} />
          )}
        </div>
        </div>
      </div>
    </div>
  );
}
