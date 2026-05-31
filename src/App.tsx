import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useEffect, useState, type ReactElement } from "react";
import { NavRail } from "./components/shell/NavRail";
import { StatusBar } from "./components/shell/StatusBar";
import { TitleBar } from "./components/shell/TitleBar";
import { api, type Overview } from "./lib/ipc";
import { ACCENT_HUE, useSettings } from "./store/settings";
import { useUi, type TabId } from "./store/ui";
import { CoreAssignment } from "./tabs/CoreAssignment";
import { Monitor } from "./tabs/Monitor";
import { Optimize } from "./tabs/Optimize";
import { Settings } from "./tabs/Settings";
import { TaskManager } from "./tabs/TaskManager";

const TABS: Record<TabId, () => ReactElement> = {
  cores: CoreAssignment,
  taskmgr: TaskManager,
  monitor: Monitor,
  optimize: Optimize,
  settings: Settings,
};

function App() {
  const tab = useUi((s) => s.tab);
  const accent = useSettings((s) => s.accent);
  const acrylic = useSettings((s) => s.acrylic);
  const reduceMotion = useSettings((s) => s.reduceMotion);
  const [overview, setOverview] = useState<Overview | null>(null);

  useEffect(() => {
    api.getOverview().then(setOverview).catch(() => undefined);
  }, []);

  useEffect(() => {
    const hue = ACCENT_HUE[accent];
    const root = document.documentElement.style;
    root.setProperty("--color-accent", `oklch(67% 0.185 ${hue})`);
    root.setProperty("--color-accent-bright", `oklch(77% 0.16 ${hue})`);
  }, [accent]);

  useEffect(() => {
    document.documentElement.dataset.acrylic = String(acrylic);
  }, [acrylic]);

  // Suppress the WebView's default right-click menu (keep it only for text fields).
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      e.preventDefault();
    };
    document.addEventListener("contextmenu", handler);
    return () => document.removeEventListener("contextmenu", handler);
  }, []);

  const Active = TABS[tab];

  return (
    <MotionConfig reducedMotion={reduceMotion ? "always" : "user"}>
      <div className="relative flex h-screen w-screen flex-col overflow-hidden text-ink">
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
          <div className="absolute -left-40 -top-40 h-[480px] w-[480px] rounded-full bg-accent/20 blur-[120px]" />
          <div className="absolute -bottom-52 -right-32 h-[460px] w-[460px] rounded-full bg-cyan/15 blur-[130px]" />
        </div>

        <TitleBar cpuName={overview?.cpuName} />

        <div className="flex min-h-0 flex-1">
          <NavRail />
          <main className="relative min-h-0 flex-1 overflow-hidden">
            <AnimatePresence mode="wait">
              <motion.div
                key={tab}
                initial={{ opacity: 0, y: 10, scale: 0.994 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -6, scale: 0.994 }}
                transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                className="flex h-full min-h-0 flex-col"
              >
                <Active />
              </motion.div>
            </AnimatePresence>
          </main>
        </div>

        <StatusBar />
      </div>
    </MotionConfig>
  );
}

export default App;
