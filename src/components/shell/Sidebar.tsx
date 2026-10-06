import { Activity, Cpu, Fan, Gauge, HardDrive, ListTree, MonitorPlay, Rocket, Settings as SettingsIcon, Zap } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { motion } from "motion/react";
import { cn } from "../../lib/cn";
import { useT, useTf } from "../../lib/i18n";
import { springSmooth } from "../../lib/motion";
import { useDiskScan } from "../../store/diskScan";
import { useOsd } from "../../store/osd";
import { useUi, type TabId } from "../../store/ui";

interface NavItem {
  id: TabId;
  label: string;
  icon: LucideIcon;
}

interface NavGroup {
  zh: string;
  en: string;
  items: NavItem[];
}

const GROUPS: NavGroup[] = [
  {
    zh: "性能",
    en: "Performance",
    items: [
      { id: "cores", label: "核心分配", icon: Cpu },
      { id: "taskmgr", label: "任务管理器", icon: ListTree },
      { id: "monitor", label: "历史", icon: Gauge },
    ],
  },
  {
    zh: "硬件",
    en: "Hardware",
    items: [
      { id: "gpu", label: "GPU", icon: Rocket },
      { id: "fans", label: "风扇", icon: Fan },
    ],
  },
  {
    zh: "工具",
    en: "Tools",
    items: [
      { id: "osd", label: "游戏OSD", icon: MonitorPlay },
      { id: "optimize", label: "优化", icon: Zap },
      { id: "disk", label: "存储分析", icon: HardDrive },
    ],
  },
];

const AMD_ITEM: NavItem = { id: "amd", label: "AMD 优化", icon: Activity };
const SETTINGS_ITEM: NavItem = { id: "settings", label: "设置", icon: SettingsIcon };

/** Which features are live right now — shown as a dot on their nav entry. */
function useLiveState(): Partial<Record<TabId, "on" | "busy">> {
  const optimizing = useUi((s) => s.optimizationEnabled);
  const osdOn = useOsd((s) => s.enabled || s.desktopMode);
  const scanning = useDiskScan((s) => Object.values(s.views).some((v) => v.progress?.status === "scanning"));
  return {
    cores: optimizing ? "on" : undefined,
    osd: osdOn ? "on" : undefined,
    disk: scanning ? "busy" : undefined,
  };
}

function Item({ item, active, state, onSelect }: { item: NavItem; active: boolean; state?: "on" | "busy"; onSelect: () => void }) {
  const t = useT();
  const tf = useTf();
  const Icon = item.icon;
  const label = t(item.label);
  const stateText = state === "busy" ? tf("进行中", "Running") : state === "on" ? tf("已启用", "On") : undefined;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? "page" : undefined}
      title={stateText ? `${label} · ${stateText}` : label}
      className={cn(
        "no-drag group relative flex h-9 w-full shrink-0 items-center gap-3 rounded-md px-2.5 text-left text-[13px] transition-colors duration-150",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
        "max-[1199px]:justify-center max-[1199px]:px-0",
        active ? "bg-surface2 text-ink" : "text-muted hover:bg-surface2/60 hover:text-ink",
      )}
    >
      {active && (
        <motion.span
          layoutId="nav-pill"
          className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-accent"
          transition={springSmooth}
        />
      )}
      <span className="relative">
        <Icon size={17} strokeWidth={active ? 2.1 : 1.8} className={cn("transition-colors", active ? "text-accent" : "text-dim group-hover:text-muted")} />
        {state && (
          <span
            className={cn(
              "absolute -right-1 -top-0.5 hidden h-[7px] w-[7px] rounded-full ring-2 ring-chrome max-[1199px]:block",
              state === "busy" ? "bg-accent" : "bg-ok",
            )}
          />
        )}
      </span>
      <span className={cn("min-w-0 flex-1 truncate max-[1199px]:hidden", active && "font-medium")}>{label}</span>
      {state && (
        <span className={cn("live-dot mr-0.5 max-[1199px]:hidden", state === "busy" ? "text-accent" : "text-ok")} aria-hidden />
      )}
    </button>
  );
}

export function Sidebar() {
  const tab = useUi((s) => s.tab);
  const setTab = useUi((s) => s.setTab);
  const amdUnlocked = useUi((s) => s.amdTuningUnlocked);
  const live = useLiveState();
  const tf = useTf();

  // The AMD tuning tab stays hidden until it's unlocked in Settings, so its
  // dangerous SMU write controls can't be reached by accident.
  const groups = amdUnlocked
    ? GROUPS.map((g) => (g.zh === "硬件" ? { ...g, items: [...g.items, AMD_ITEM] } : g))
    : GROUPS;

  return (
    <nav
      aria-label={tf("主导航", "Main")}
      className={cn(
        "relative z-10 flex w-[208px] shrink-0 flex-col px-2 pb-2 pt-3 max-[1199px]:w-[60px]",
        "min-h-0 overflow-y-auto overflow-x-hidden [scrollbar-width:none]",
      )}
    >
      {groups.map((g, i) => (
        <div key={g.zh} className={cn("flex flex-col gap-0.5", i > 0 && "mt-4")}>
          <div className="mb-1 px-2.5 text-[11.5px] text-dim max-[1199px]:hidden">{tf(g.zh, g.en)}</div>
          {i > 0 && <div className="mx-auto mb-2 hidden h-px w-6 bg-line max-[1199px]:block" />}
          {g.items.map((item) => (
            <Item key={item.id} item={item} active={tab === item.id} state={live[item.id]} onSelect={() => setTab(item.id)} />
          ))}
        </div>
      ))}
      <div className="mt-auto pt-4">
        <Item item={SETTINGS_ITEM} active={tab === "settings"} onSelect={() => setTab("settings")} />
      </div>
    </nav>
  );
}
