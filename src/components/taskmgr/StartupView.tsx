import { ArrowDown, ArrowUp, RotateCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "../../lib/cn";
import { api, type StartupItem } from "../../lib/ipc";
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
  return (
    <button
      onClick={onClick}
      className={cn(
        "hud-label no-drag flex cursor-pointer items-center gap-1 text-[9.5px] transition-colors hover:text-ink",
        align === "right" ? "justify-end" : "justify-start",
        active ? "text-accent" : "text-muted",
      )}
    >
      {label}
      {active && (dir === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
    </button>
  );
}

export function StartupView() {
  const [items, setItems] = useState<StartupItem[]>([]);
  const [status, setStatus] = useState("");
  const [sortKey, setSortKey] = useState<SKey>("enabled");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  async function load() {
    try {
      setItems(await api.listStartup());
    } catch {
      setStatus("无法读取启动项");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function toggle(item: StartupItem) {
    try {
      await api.setStartupEnabled(item.name, item.location, !item.enabled);
      setStatus(`${item.name} — ${!item.enabled ? "已启用" : "已禁用"}`);
      await load();
    } catch {
      setStatus(`${item.name} — 修改失败（可能需要管理员权限）`);
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
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      <div className="flex items-center gap-3">
        <span className="nums text-[11.5px] text-dim">{items.length} 个启动项</span>
        <button
          onClick={() => void load()}
          title="刷新"
          className="no-drag grid h-7 w-7 cursor-pointer place-items-center rounded-lg text-dim transition-colors hover:bg-surface3 hover:text-ink"
        >
          <RotateCw size={13} />
        </button>
        {status && <span className="ml-auto text-[11.5px] text-accent">{status}</span>}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-surface/50">
        {/* Horizontal scroll on narrow windows; min-w wrapper keeps the header
            and body aligned while the body scrolls vertically. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-x-auto">
        <div className={cn(MIN_W, "grid items-center gap-2 border-b border-line bg-surface2/70 px-3 py-2.5", COLS)}>
          <SortHead label="名称" active={sortKey === "name"} dir={sortDir} onClick={() => sort("name")} />
          <span className="hud-label text-[9.5px] text-muted">命令</span>
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
              className={cn(MIN_W, "grid items-center gap-2 border-b border-line/40 px-3 py-2 text-[12.5px] transition-colors hover:bg-surface2/50", COLS)}
            >
              <span className={cn("truncate", item.enabled ? "text-ink" : "text-dim")} title={item.name}>
                {item.name}
              </span>
              <span className="truncate text-[11.5px] text-dim" title={item.command}>
                {item.command}
              </span>
              <span className="text-[11px] text-muted">{LOC_LABEL[item.location] ?? item.location}</span>
              <div className="flex justify-end">
                <Toggle checked={item.enabled} onChange={() => toggle(item)} />
              </div>
            </div>
          ))}
          {visible.length === 0 && (
            <div className="flex flex-col items-center gap-1.5 py-12 text-center">
              <span className="hud-label text-[10px] text-dim">NO STARTUP ITEMS</span>
              <span className="text-[12.5px] text-dim">没有启动项</span>
            </div>
          )}
        </div>
        </div>
      </div>
    </div>
  );
}
