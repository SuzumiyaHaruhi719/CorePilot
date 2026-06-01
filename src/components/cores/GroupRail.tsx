import { Download, Plus, Power, Upload } from "lucide-react";
import { motion } from "motion/react";
import { cn } from "../../lib/cn";
import { maskToCpuList } from "../../lib/format";
import { hoverPop } from "../../lib/motion";
import type { ProcInfo } from "../../lib/ipc";
import { useGroups, type GroupRule } from "../../store/groups";
import { ClickRipple } from "../ui/Ripple";

interface GroupRailProps {
  processes: ProcInfo[];
  fullMask: number;
  optimizationEnabled: boolean;
  onToggleOptimization: () => void;
  onExport: () => void;
  onImport: () => void;
}

function activeCount(group: GroupRule, processes: ProcInfo[]): number {
  const names = new Set(group.patterns);
  return processes.filter((p) => names.has(p.name.toLowerCase())).length;
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
      <div className="flex items-center justify-between px-3 py-2.5">
        <span className="text-[12px] font-semibold uppercase tracking-[0.12em] text-muted">进程分组</span>
        <motion.button
          whileHover={{ scale: 1.12 }}
          whileTap={{ scale: 0.9 }}
          onClick={() => addGroup({ mask: fullMask })}
          className="no-drag grid h-6 w-6 place-items-center rounded-lg bg-accent/15 text-accent hover:bg-accent/25"
          title="创建分组"
        >
          <Plus size={15} />
        </motion.button>
      </div>

      <div className="min-h-0 flex-1 space-y-1.5 overflow-auto px-2.5 pb-2">
        {groups.map((group) => {
          const active = activeCount(group, processes);
          const selected = group.id === selectedId;
          return (
            <motion.button
              key={group.id}
              layout
              onClick={() => select(group.id)}
              whileHover={{ scale: 1.02, y: -2 }}
              whileTap={{ scale: 0.985 }}
              transition={hoverPop}
              className={cn(
                "relative w-full rounded-xl border p-2.5 text-left transition-colors",
                selected ? "border-accent/40 bg-accent/10 glow-sm" : "border-line bg-surface2 hover:bg-surface3",
              )}
            >
              <div className="flex items-center justify-between">
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full glow-sm"
                    style={{ background: `oklch(74% 0.15 ${group.hue})` }}
                  />
                  <span className="truncate text-[13px] font-medium text-ink">{group.name}</span>
                </div>
                <span className="nums shrink-0 text-[11px] text-muted">
                  {active} / {group.patterns.length}
                </span>
              </div>
              <div className="nums mt-1 truncate text-[10.5px] text-dim">
                CPU {group.mask === 0 ? "全部" : maskToCpuList(group.mask)}
              </div>
              <ClickRipple />
            </motion.button>
          );
        })}
        {groups.length === 0 && (
          <div className="px-2 py-8 text-center text-[12px] leading-relaxed text-dim">
            还没有分组
            <br />
            点击右上角 + 创建
          </div>
        )}
      </div>

      <div className="space-y-2 border-t border-line p-2.5">
        <motion.button
          whileTap={{ scale: 0.97 }}
          onClick={onToggleOptimization}
          className={cn(
            "flex w-full items-center justify-center gap-2 rounded-xl py-2 text-[12.5px] font-semibold transition-colors",
            optimizationEnabled
              ? "border border-ok/40 bg-ok/15 text-ok glow-sm"
              : "border border-danger/40 bg-danger/15 text-danger",
          )}
        >
          <Power size={15} />
          {optimizationEnabled ? "优化已启用" : "已停用 · 点击启用"}
        </motion.button>
        <div className="flex gap-2">
          <button
            onClick={onImport}
            className="no-drag flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-line bg-surface2 py-1.5 text-[11.5px] text-muted transition-colors hover:bg-surface3 hover:text-ink"
          >
            <Upload size={13} /> 导入
          </button>
          <button
            onClick={onExport}
            className="no-drag flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-line bg-surface2 py-1.5 text-[11.5px] text-muted transition-colors hover:bg-surface3 hover:text-ink"
          >
            <Download size={13} /> 导出
          </button>
        </div>
      </div>
    </div>
  );
}
