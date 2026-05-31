import { RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "../../lib/cn";
import { api, type StartupItem } from "../../lib/ipc";
import { Toggle } from "../ui/Toggle";

const COLS = "grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_92px_52px]";

const LOC_LABEL: Record<string, string> = {
  hkcu_run: "用户启动",
  hklm_run: "系统启动",
  startup_folder: "启动文件夹",
};

export function StartupView() {
  const [items, setItems] = useState<StartupItem[]>([]);
  const [status, setStatus] = useState("");

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

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      <div className="flex items-center gap-3">
        <span className="nums text-[11.5px] text-dim">{items.length} 个启动项</span>
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
          <span>名称</span>
          <span>命令</span>
          <span>位置</span>
          <span className="text-right">启用</span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {items.map((item) => (
            <div
              key={`${item.location}:${item.name}`}
              className={cn("grid items-center gap-2 border-b border-line/40 px-3 py-2 text-[12.5px] hover:bg-surface2/50", COLS)}
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
          {items.length === 0 && <div className="py-10 text-center text-[12.5px] text-dim">没有启动项</div>}
        </div>
      </div>
    </div>
  );
}
