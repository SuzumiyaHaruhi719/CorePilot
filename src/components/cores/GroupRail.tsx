import { Download, ListTree, Plus, Upload } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo } from "react";
import { cn } from "../../lib/cn";
import { groupColor } from "../../lib/colors";
import { useT, useTf } from "../../lib/i18n";
import { maskToCpuList } from "../../lib/format";
import { easeOut, springSmooth } from "../../lib/motion";
import type { ProcInfo } from "../../lib/ipc";
import { useGroups, type GroupRule } from "../../store/groups";
import { Badge } from "../ui/Readout";
import { Toggle } from "../ui/Toggle";

interface GroupRailProps {
  processes: ProcInfo[];
  fullMask: bigint;
  optimizeOnStartup: boolean;
  onToggleOptimizeOnStartup: () => void;
  onExport: () => void;
  onImport: () => void;
}

// How many of the group's name patterns currently have a process running — i.e.
// "active rules", always ≤ the pattern count shown as the denominator. (Counting
// matched patterns, not process instances: a group with N rules could otherwise
// report far more than N "active" when names like svchost.exe run many copies.)
//
// `running` is built ONCE per render by the caller, not per group per poll.
function activeCount(group: GroupRule, running: ReadonlySet<string>): number {
  return group.patterns.reduce((n, pat) => (running.has(pat.toLowerCase()) ? n + 1 : n), 0);
}

function RailItem({
  selected,
  onSelect,
  color,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  color: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "no-drag relative w-full cursor-pointer rounded-lg px-3 py-2 text-left transition-colors duration-150",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
        selected ? "bg-surface2" : "hover:bg-surface2/50",
      )}
    >
      {selected && (
        <motion.span
          layoutId="group-pill"
          className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full"
          style={{ background: color }}
          transition={springSmooth}
        />
      )}
      {children}
    </button>
  );
}

export function GroupRail({ processes, fullMask, optimizeOnStartup, onToggleOptimizeOnStartup, onExport, onImport }: GroupRailProps) {
  const t = useT();
  const tf = useTf();
  const groups = useGroups((s) => s.groups);
  const selectedId = useGroups((s) => s.selectedId);
  const select = useGroups((s) => s.select);
  const addGroup = useGroups((s) => s.addGroup);

  // One pass over the roster per poll, shared by every group's counter and by
  // the 全部进程 total below.
  const { running, settableCount } = useMemo(() => {
    const names = new Set<string>();
    let settable = 0;
    for (const p of processes) {
      names.add(p.name.toLowerCase());
      if (p.settable) settable += 1;
    }
    return { running: names, settableCount: settable };
  }, [processes]);

  return (
    <div className="flex w-[232px] shrink-0 flex-col border-r border-line">
      <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
        <RailItem selected={selectedId === null} onSelect={() => select(null)} color="var(--color-accent)">
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2.5">
              <ListTree size={15} className={selectedId === null ? "text-accent" : "text-dim"} />
              <span className="text-[13px] font-medium text-ink">{t("全部进程")}</span>
            </span>
            <span className="nums text-[12px] text-dim">{settableCount}</span>
          </div>
        </RailItem>

        <div className="mb-1 mt-4 flex items-center justify-between px-3">
          <span className="text-[11.5px] text-dim">{tf("分组", "Groups")}</span>
          <button
            type="button"
            onClick={() => addGroup({ mask: fullMask })}
            title={tf("创建分组", "New group")}
            aria-label={tf("创建分组", "New group")}
            className="no-drag grid h-6 w-6 cursor-pointer place-items-center rounded-md text-muted transition-colors hover:bg-surface2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            <Plus size={15} />
          </button>
        </div>

        <div className="flex flex-col gap-0.5">
          <AnimatePresence initial={false}>
            {groups.map((group) => {
              const active = activeCount(group, running);
              const selected = group.id === selectedId;
              const color = groupColor(group.hue);
              return (
                <motion.div
                  key={group.id}
                  layout="position"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.2, ease: easeOut }}
                >
                  <RailItem selected={selected} onSelect={() => select(group.id)} color={color}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-2.5">
                        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} />
                        <span className="truncate text-[13px] font-medium text-ink">{group.name}</span>
                        {group.builtin && <Badge className="h-[18px] px-1 text-[10.5px]">{t("内置")}</Badge>}
                      </span>
                      <span
                        className="nums shrink-0 text-[12px] text-dim"
                        title={tf(`${active} / ${group.patterns.length} 个规则有进程正在运行`, `${active} / ${group.patterns.length} rules have running processes`)}
                      >
                        <span className={active > 0 ? "text-ink" : ""}>{active}</span>/{group.patterns.length}
                      </span>
                    </div>
                    <div className="nums mt-0.5 truncate pl-5 text-[11.5px] text-dim">
                      CPU {group.mask === 0n ? t("全部") : maskToCpuList(group.mask)}
                    </div>
                  </RailItem>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>

        {groups.length === 0 && (
          <div className="px-3 py-6 text-[12px] leading-relaxed text-muted">
            {tf("还没有分组。", "No groups yet.")}
            <button
              type="button"
              onClick={() => addGroup({ mask: fullMask })}
              className="no-drag ml-1 cursor-pointer text-accent underline-offset-2 hover:underline"
            >
              {tf("创建第一个分组", "Create the first one")}
            </button>
          </div>
        )}
      </div>

      <div className="border-t border-line px-3 py-3">
        <label className="flex cursor-pointer items-center justify-between gap-3 text-[12.5px] text-ink">
          <span>
            {tf("启动时自动启用", "Enable on launch")}
            <span className="block text-[11.5px] text-dim">{tf("下次启动时开始绑定", "Pins from the next launch")}</span>
          </span>
          <Toggle checked={optimizeOnStartup} onChange={onToggleOptimizeOnStartup} label={tf("下次启动时自动应用", "Auto-apply on next launch")} />
        </label>
        <div className="mt-3 flex gap-1">
          <button
            type="button"
            onClick={onImport}
            className="no-drag flex h-7 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md text-[12px] text-muted transition-colors hover:bg-surface2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            <Upload size={13} /> {t("导入")}
          </button>
          <button
            type="button"
            onClick={onExport}
            className="no-drag flex h-7 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md text-[12px] text-muted transition-colors hover:bg-surface2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          >
            <Download size={13} /> {t("导出")}
          </button>
        </div>
      </div>
    </div>
  );
}
