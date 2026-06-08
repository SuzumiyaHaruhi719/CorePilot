import { Cpu, Fan, Gauge, ListTree, MonitorPlay, Rocket, Settings as SettingsIcon, Zap } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { motion } from "motion/react";
import { cn } from "../../lib/cn";
import { useT } from "../../lib/i18n";
import { springSmooth } from "../../lib/motion";
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
  { id: "osd", label: "游戏OSD", icon: MonitorPlay },
  { id: "gpu", label: "GPU", icon: Rocket },
  { id: "fans", label: "风扇", icon: Fan },
  { id: "optimize", label: "优化", icon: Zap },
  { id: "settings", label: "设置", icon: SettingsIcon },
];

// The whole tab scales as one cohesive unit on hover — icon, label and the
// active pill lift and grow together. (Previously the icon had its own larger
// scale that compounded with the button's, so only the icon appeared to "pop".)
const ITEM_VARIANTS = { hover: { scale: 1.06, y: -2 }, tap: { scale: 0.96 } };

export function NavRail() {
  const tab = useUi((s) => s.tab);
  const setTab = useUi((s) => s.setTab);
  const t = useT();

  return (
    <nav
      className={cn(
        "relative z-10 flex w-[88px] shrink-0 flex-col items-center gap-1.5 border-r border-line py-4",
        // When the viewport is too short for all items, scroll instead of clipping.
        // min-h-0 lets the flex column actually shrink; a slim, HUD-toned scrollbar
        // (scoped here so it stays narrow inside the 88px rail) appears only on overflow.
        "min-h-0 overflow-y-auto overflow-x-hidden",
        "[scrollbar-width:thin] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:border-0 [&::-webkit-scrollbar-thumb]:bg-ink/10 hover:[&::-webkit-scrollbar-thumb]:bg-ink/20",
      )}
    >
      {ITEMS.map((item) => {
        const active = tab === item.id;
        const Icon = item.icon;
        return (
          <motion.button
            key={item.id}
            onClick={() => setTab(item.id)}
            variants={ITEM_VARIANTS}
            whileHover="hover"
            whileTap="tap"
            transition={springSmooth}
            className="no-drag relative flex h-[60px] w-[72px] shrink-0 flex-col items-center justify-center gap-1 rounded-xl transition-colors hover:bg-surface2/40"
          >
            {active && (
              <motion.span
                layoutId="nav-pill"
                className="absolute inset-0 rounded-xl border border-accent/40 bg-accent/10 glow"
                transition={{ type: "spring", stiffness: 300, damping: 28 }}
              >
                <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-accent-bright" />
              </motion.span>
            )}
            <span
              className={cn(
                "relative z-10 transition-colors",
                active ? "text-accent-bright glow-text" : "text-dim",
              )}
            >
              <Icon size={21} strokeWidth={active ? 2.5 : 2} />
            </span>
            <span
              className={cn(
                "relative z-10 text-[10.5px] font-medium transition-colors",
                active ? "text-ink" : "text-dim",
              )}
            >
              {t(item.label)}
            </span>
            <ClickRipple />
          </motion.button>
        );
      })}
    </nav>
  );
}
