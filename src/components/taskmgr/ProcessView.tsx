import { ChevronsUp, Copy, FolderOpen, Loader2, MonitorPlay, RotateCw, Search, X } from "lucide-react";
import { useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useProcesses } from "../../hooks/useProcesses";
import { useTf } from "../../lib/i18n";
import { PRIORITY, api, type ProcInfo } from "../../lib/ipc";
import { useOsdTargets } from "../../store/osd";
import { Button } from "../ui/Button";
import { ContextMenu, type MenuState } from "../ui/ContextMenu";
import { Modal } from "../ui/Modal";
import type { SortKey } from "../cores/ProcessTable";
import { DetailsTable } from "./DetailsTable";
import { TmProcessTable } from "./TmProcessTable";

interface ProcessViewProps {
  detailed?: boolean;
}

/** Service-account owners whose processes must never be plain-killed from the
 *  UI — ending them destabilizes Windows. The only action offered is RESTART
 *  (kill + relaunch the same image, like Task Manager's explorer.exe 重新启动).
 *  Well-known SIDs keep these English names on every Windows locale. */
const SYSTEM_ACCOUNTS = new Set(["system", "local service", "network service"]);

function isSystemProc(p: ProcInfo): boolean {
  return SYSTEM_ACCOUNTS.has((p.user ?? "").trim().toLowerCase());
}

export function ProcessView({ detailed }: ProcessViewProps) {
  const tf = useTf();
  const { processes, loading, error } = useProcesses();
  const [sortKey, setSortKey] = useState<SortKey>("cpu");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [search, setSearch] = useState("");
  const [pendingKill, setPendingKill] = useState<ProcInfo | null>(null);
  const [killing, setKilling] = useState(false);
  const [status, setStatus] = useState("");
  const [menu, setMenu] = useState<MenuState | null>(null);
  const addOsdTarget = useOsdTargets((s) => s.addTarget);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q ? processes.filter((p) => p.name.toLowerCase().includes(q)) : processes;
    return [...filtered].sort((a, b) => {
      let r = 0;
      switch (sortKey) {
        case "name":
          r = a.name.localeCompare(b.name);
          break;
        case "threads":
          r = a.threads - b.threads;
          break;
        case "cpu":
          r = a.cpu - b.cpu;
          break;
        case "mem":
          r = a.mem - b.mem;
          break;
        case "gpu":
          r = a.gpu - b.gpu;
          break;
        case "gpuMem":
          r = (a.gpuMem ?? 0) - (b.gpuMem ?? 0);
          break;
        case "power":
          r = a.power - b.power;
          break;
      }
      return sortDir === "asc" ? r : -r;
    });
  }, [processes, search, sortKey, sortDir]);

  function handleSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir(key === "name" ? "asc" : "desc");
    }
  }

  function openRowMenu(e: ReactMouseEvent, proc: ProcInfo) {
    e.preventDefault();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        isSystemProc(proc)
          ? { label: tf("重启任务", "Restart task"), icon: RotateCw, danger: true, onClick: () => setPendingKill(proc) }
          : { label: "结束任务", icon: X, danger: true, onClick: () => setPendingKill(proc) },
        {
          label: "设为高优先级",
          icon: ChevronsUp,
          onClick: () =>
            void api
              .setPriority(proc.pid, PRIORITY.high)
              .then(() => setStatus(tf(`已将 ${proc.name} 设为高优先级`, `Set ${proc.name} to high priority`)))
              .catch(() => setStatus(tf("设置优先级失败（受保护进程）", "Failed to set priority (protected process)"))),
        },
        {
          label: "设为正常优先级",
          onClick: () =>
            void api
              .setPriority(proc.pid, PRIORITY.normal)
              .then(() => setStatus(tf(`已将 ${proc.name} 设为正常优先级`, `Set ${proc.name} to normal priority`)))
              .catch(() => setStatus(tf("设置优先级失败（受保护进程）", "Failed to set priority (protected process)"))),
        },
        {
          label: "设为低优先级",
          onClick: () =>
            void api
              .setPriority(proc.pid, PRIORITY.belowNormal)
              .then(() => setStatus(tf(`已将 ${proc.name} 设为低优先级`, `Set ${proc.name} to low priority`)))
              .catch(() => setStatus(tf("设置优先级失败（受保护进程）", "Failed to set priority (protected process)"))),
        },
        {
          label: "添加游戏内覆盖",
          icon: MonitorPlay,
          onClick: () => {
            addOsdTarget(proc.name);
            setStatus(tf(`已将 ${proc.name} 加入游戏内覆盖名单`, `Added ${proc.name} to the in-game overlay list`));
          },
        },
        {
          label: "打开文件位置",
          icon: FolderOpen,
          disabled: !proc.exePath,
          onClick: () => {
            if (!proc.exePath) return;
            void api
              .revealInExplorer(proc.exePath)
              .then(() => setStatus(tf(`已在资源管理器中定位 ${proc.name}`, `Located ${proc.name} in File Explorer`)))
              .catch((e: unknown) => setStatus(typeof e === "string" ? e : "打开文件位置失败"));
          },
        },
        {
          label: "复制应用路径",
          icon: Copy,
          disabled: !proc.exePath,
          onClick: () => {
            if (!proc.exePath) return;
            void navigator.clipboard
              .writeText(proc.exePath)
              .then(() => setStatus(tf(`已复制路径：${proc.exePath}`, `Copied path: ${proc.exePath}`)))
              .catch(() => setStatus(tf("复制失败", "Copy failed")));
          },
        },
        { label: "复制名称", icon: Copy, onClick: () => void navigator.clipboard.writeText(proc.name) },
        { label: "复制 PID", icon: Copy, onClick: () => void navigator.clipboard.writeText(String(proc.pid)) },
      ],
    });
  }

  async function confirmKill() {
    if (!pendingKill || killing) return;
    const target = pendingKill;
    const restart = isSystemProc(target);
    setKilling(true);
    try {
      if (restart) {
        // System-owned process: plain "end task" is not offered — kill +
        // relaunch the same image instead (Task Manager's explorer.exe 重新启动).
        await api.restartTask(target.pid);
        setStatus(tf(`已重启 ${target.name}`, `Restarted ${target.name}`));
      } else {
        await api.endTask(target.pid);
        setStatus(tf(`已结束 ${target.name}`, `Ended ${target.name}`));
      }
      setPendingKill(null);
    } catch {
      setStatus(
        restart
          ? tf(`无法重启 ${target.name}（受保护的系统进程）`, `Couldn't restart ${target.name} (protected system process)`)
          : tf(`无法结束 ${target.name}（可能是受保护的系统进程）`, `Couldn't end ${target.name} (possibly a protected system process)`),
      );
      setPendingKill(null);
    } finally {
      setKilling(false);
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
            placeholder="搜索进程…"
            className="w-56 rounded-lg border border-line bg-surface2 py-1.5 pl-8 pr-3 text-[12.5px] text-ink outline-none transition-colors focus:border-accent/50"
          />
        </div>
        <span className="nums text-[11.5px] text-dim">{visible.length} 个进程</span>
        {status && (
          <span className="ml-auto flex items-center gap-1.5 text-[11.5px] text-accent">
            <span className="h-1.5 w-1.5 rounded-full bg-accent glow-sm" />
            {status}
          </span>
        )}
      </div>

      {detailed ? (
        <DetailsTable
          processes={visible}
          loading={loading}
          error={error}
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={handleSort}
          onEndTask={setPendingKill}
          onRowContextMenu={openRowMenu}
        />
      ) : (
        <TmProcessTable
          processes={visible}
          loading={loading}
          error={error}
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={handleSort}
          onEndTask={setPendingKill}
          onRowContextMenu={openRowMenu}
        />
      )}

      <Modal
        open={!!pendingKill}
        onClose={() => !killing && setPendingKill(null)}
        title={pendingKill && isSystemProc(pendingKill) ? tf("重启任务", "Restart task") : "结束任务"}
        footer={
          <>
            <Button onClick={() => setPendingKill(null)} disabled={killing}>取消</Button>
            <Button variant="danger" onClick={confirmKill} disabled={killing}>
              {killing ? <Loader2 size={13} className="animate-spin" /> : null}{" "}
              {pendingKill && isSystemProc(pendingKill) ? tf("重启任务", "Restart") : "结束任务"}
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-relaxed text-muted">
          {pendingKill && isSystemProc(pendingKill) ? (
            <>
              <span className="font-semibold text-ink">{pendingKill.name}</span> (PID {pendingKill.pid}){" "}
              {tf(
                "是系统进程，不能直接结束，只能重启（结束后自动重新启动）。",
                "is a system process and can't be ended — it can only be restarted (killed, then relaunched).",
              )}
            </>
          ) : (
            <>
              {tf("确定要结束", "End")} <span className="font-semibold text-ink">{pendingKill?.name}</span>{" "}
              (PID {pendingKill?.pid}){tf("吗？未保存的数据将丢失。", "? Unsaved data will be lost.")}
            </>
          )}
        </p>
      </Modal>
      <ContextMenu state={menu} onClose={() => setMenu(null)} />
    </div>
  );
}
