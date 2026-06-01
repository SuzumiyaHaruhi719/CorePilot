import { Cpu, Gauge, ListTree, Settings as SettingsIcon, Zap } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { motion } from "motion/react";
import { cn } from "../../lib/cn";
import { hoverPop } from "../../lib/motion";
import { useUi, type TabId } from "../../store/ui";
import { ClickRipple } from "../ui/Ripple";

interface NavItem {
  id: TabId;
  label: string;
  icon: LucideIcon;
}

const ITEMS: NavItem[] = [
  { id: "cores", label: "核心分配", icon: Cpu },
  { id: "taskmgr", label: "任务管理器", icon: ListTree },
  { id: "monitor", label: "监控", icon: Gauge },
  { id: "optimize", label: "优化", icon: Zap },
  { id: "settings", label: "设置", icon: SettingsIcon },
];

export function NavRail() {
  const tab = useUi((s) => s.tab);
  const setTab = useUi((s) => s.setTab);

  return (
    <nav className="relative z-10 flex w-[88px] shrink-0 flex-col items-center gap-1.5 border-r border-line py-4">
      {ITEMS.map((item) => {
        const active = tab === item.id;
        const Icon = item.icon;
        return (
          <motion.button
            key={item.id}
            onClick={() => setTab(item.id)}
            whileHover={{ scale: 1.08, y: -2 }}
            whileTap={{ scale: 0.95 }}
            transition={hoverPop}
            className="no-drag relative flex h-[60px] w-[72px] flex-col items-center justify-center gap-1 rounded-xl transition-colors hover:bg-surface2/40"
          >
            {active && (
              <motion.span
                layoutId="nav-pill"
                className="absolute inset-0 rounded-xl border border-accent/40 bg-accent/10 glow"
                transition={{ type: "spring", stiffness: 300, damping: 28 }}
              />
            )}
            <motion.span
              variants={{ hover: { scale: 1.16, y: -2 }, tap: { scale: 0.9 } }}
              transition={hoverPop}
              className={cn(
                "relative z-10 transition-colors",
                active ? "text-accent-bright glow-text" : "text-dim",
              )}
            >
              <Icon size={21} strokeWidth={active ? 2.5 : 2} />
            </motion.span>
            <span
              className={cn(
                "relative z-10 text-[10.5px] font-medium transition-colors",
                active ? "text-ink" : "text-dim",
              )}
            >
              {item.label}
            </span>
            <ClickRipple />
          </motion.button>
        );
      })}
    </nav>
  );
}
