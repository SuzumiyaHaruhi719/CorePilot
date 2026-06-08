import { Download, ListTree, Plus, Power, Upload } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { CSSProperties } from "react";
import { cn } from "../../lib/cn";
import { groupColor } from "../../lib/colors";
import { maskToCpuList } from "../../lib/format";
import { hoverPop } from "../../lib/motion";
import type { ProcInfo } from "../../lib/ipc";
import { useGroups, type GroupRule } from "../../store/groups";
import { ClickRipple } from "../ui/Ripple";

interface GroupRailProps {
  processes: ProcInfo[];
  fullMask: bigint;
  optimizationEnabled: boolean;
  onToggleOptimization: () => void;
  onExport: () => void;
  onImport: () => void;
}

// How many of the group's name patterns currently have a process running — i.e.
// "active rules", always ≤ the pattern count shown as the denominator. (Counting
// matched patterns, not process instances: a group with N rules could otherwise
// report far more than N "active" when names like svchost.exe run many copies,
// which read as a nonsensical "657 / 239".)
function activeCount(group: GroupRule, processes: ProcInfo[]): number {
  const running = new Set(processes.map((p) => p.name.toLowerCase()));
  return group.patterns.reduce((n, pat) => (running.has(pat.toLowerCase()) ? n + 1 : n), 0);
}

export function GroupRail({
  processes,
  fullMask,
  optimizationEnabled,
  onToggleOptimization,
  onExport,
  onImport,
}: GroupRailProps) {
  const groups = useGroups((s) => s.groups);
  const selectedId = useGroups((s) => s.selectedId);
  const select = useGroups((s) => s.select);
  const addGroup = useGroups((s) => s.addGroup);

  return (
    <div className="flex w-[244px] shrink-0 flex-col border-r border-line">
      <div className="flex items-center justify-between px-3 py-3">
        <span className="hud-label text-[10.5px] text-muted">进程分组</span>
        <motion.button
          whileHover={{ scale: 1.12 }}
          whileTap={{ scale: 0.9 }}
          onClick={() => addGroup({ mask: fullMask })}
          className="no-drag grid h-6 w-6 cursor-pointer place-items-center rounded-lg bg-accent/15 text-accent transition-colors hover:bg-accent/25 hover:text-accent-bright"
          title="创建分组"
        >
          <Plus size={15} />
        </motion.button>
      </div>

      {/* py-2.5 matches px-2.5 so the selected item's glow-sm (≈10px blur) isn't
          clipped by overflow-auto at the top/bottom edges. */}
      <div className="min-h-0 flex-1 space-y-1.5 overflow-auto px-2.5 py-2.5">
        <button
          onClick={() => select(null)}
          className={cn(
            "no-drag flex w-full cursor-pointer items-center justify-between rounded-xl border p-2.5 text-left transition-[background-color,border-color] duration-150",
            selectedId === null
              ? "border-accent/40 bg-accent/10 glow-sm"
              : "border-line bg-surface2 hover:border-line-strong hover:bg-surface3",
          )}
        >
          <div className="flex items-center gap-2">
            <ListTree size={14} className={selectedId === null ? "text-accent-bright" : "text-dim"} />
            <span className="text-[13px] font-medium text-ink">全部进程</span>
          </div>
          <span className="nums text-[11px] text-muted">{processes.filter((p) => p.settable).length}</span>
        </button>
        <div className="hud-label px-1 pt-1.5 text-[9.5px] text-dim">分组</div>
        <AnimatePresence initial={false}>
          {groups.map((group) => {
          const active = activeCount(group, processes);
          const selected = group.id === selectedId;
          const color = groupColor(group.hue);
          return (
            <motion.button
              key={group.id}
              layout
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              onClick={() => select(group.id)}
              whileHover={{ scale: 1.02, y: -2 }}
              whileTap={{ scale: 0.985 }}
              transition={hoverPop}
              className={cn(
                "relative w-full cursor-pointer overflow-hidden rounded-xl border p-2.5 text-left transition-[background-color,border-color] duration-150",
                selected
                  ? "bg-surface3/60"
                  : "border-line bg-surface2 hover:border-line-strong hover:bg-surface3",
              )}
              style={
                selected
                  ? {
                      borderColor: `color-mix(in oklch, ${color} 50%, transparent)`,
                      boxShadow: `0 0 14px -3px color-mix(in oklch, ${color} 55%, transparent), inset 2px 0 0 0 ${color}`,
                    }
                  : undefined
              }
            >
              <div className="flex items-center justify-between">
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className={cn("h-2.5 w-2.5 shrink-0 rounded-full", selected && "glow-sm")}
                    style={{ background: color, "--glow": color } as CSSProperties}
                  />
                  <span className="truncate text-[13px] font-medium text-ink">{group.name}</span>
                  {group.builtin && (
                    <span className="hud-label shrink-0 rounded border border-line px-1 py-px text-[8px] text-dim">
                      内置
                    </span>
                  )}
                </div>
                <span
                  className="nums shrink-0 text-[11px] text-muted"
                  title={`${active} / ${group.patterns.length} 个规则有进程正在运行`}
                >
                  <span className={active > 0 ? "text-ink" : ""}>{active}</span> / {group.patterns.length}
                </span>
              </div>
              <div className="nums mt-1 truncate text-[10.5px] text-dim">
                CPU {group.mask === 0n ? "全部" : maskToCpuList(group.mask)}
              </div>
              <ClickRipple />
            </motion.button>
          );
          })}
        </AnimatePresence>
        {groups.length === 0 && (
          <div className="mx-1 mt-2 rounded-xl border border-dashed border-line px-3 py-8 text-center text-[12px] leading-relaxed text-dim">
            还没有分组
            <br />
            点击右上角 <Plus size={11} className="inline -translate-y-px" /> 创建
          </div>
        )}
      </div>

      <div className="space-y-2 border-t border-line p-2.5">
        <motion.button
          whileHover={{ scale: 1.015 }}
          whileTap={{ scale: 0.97 }}
          transition={hoverPop}
          onClick={onToggleOptimization}
          style={optimizationEnabled ? ({ "--glow": "var(--color-ok)" } as CSSProperties) : undefined}
          className={cn(
            "flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl py-2.5 text-[12.5px] font-semibold transition-[background-color,border-color,color] duration-150",
            optimizationEnabled
              ? "border border-ok/45 bg-ok/15 text-ok glow-sm"
              : "border border-danger/40 bg-danger/15 text-danger hover:bg-danger/25",
          )}
        >
          <Power size={15} />
          {optimizationEnabled ? "优化已启用" : "已停用 · 点击启用"}
        </motion.button>
        <div className="flex gap-2">
          <button
            onClick={onImport}
            className="no-drag flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-line bg-surface2 py-1.5 text-[11.5px] text-muted transition-colors hover:border-line-strong hover:bg-surface3 hover:text-ink"
          >
            <Upload size={13} /> 导入
          </button>
          <button
            onClick={onExport}
            className="no-drag flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-line bg-surface2 py-1.5 text-[11.5px] text-muted transition-colors hover:border-line-strong hover:bg-surface3 hover:text-ink"
          >
            <Download size={13} /> 导出
          </button>
        </div>
      </div>
    </div>
  );
}
