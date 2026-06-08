import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { emit } from "@tauri-apps/api/event";
import { NavRail } from "./components/shell/NavRail";
import { StatusBar } from "./components/shell/StatusBar";
import { TitleBar } from "./components/shell/TitleBar";
import { api, type Overview } from "./lib/ipc";
import { osdRowColorsRgba } from "./lib/osdPalette";
import { useSettings } from "./store/settings";
import { useAffinityEnforcer } from "./hooks/useAffinityEnforcer";
import { useOsdHotkey } from "./hooks/useOsdHotkey";
import { usePerfRecorder } from "./hooks/usePerfRecorder";
import { useOverlayInjection } from "./hooks/useOverlayInjection";
import { useLiveHistoryRecorder } from "./hooks/useSharedTelemetry";
import { useGlobalI18n } from "./lib/i18n";
import { useUi, type TabId } from "./store/ui";
import { CoreAssignment } from "./tabs/CoreAssignment";
import { FanControl } from "./tabs/FanControl";
import { GpuTune } from "./tabs/GpuTune";
import { Monitor } from "./tabs/Monitor";
import { Optimize } from "./tabs/Optimize";
import { OsdConfig } from "./tabs/OsdConfig";
import { Settings } from "./tabs/Settings";
import { TaskManager } from "./tabs/TaskManager";
import { Tuning } from "./tabs/Tuning";
import { useGpuProfiles } from "./store/gpuProfiles";
import { useFanProfiles } from "./store/fanProfiles";
import { useOsd } from "./store/osd";

/** Last pointer-down position, used as the origin for the theme-switch circular
 *  reveal so the new theme appears to wipe out from where the user clicked. */
const switchOrigin = { x: NaN, y: NaN };
if (typeof window !== "undefined") {
  window.addEventListener(
    "pointerdown",
    (e) => {
      switchOrigin.x = e.clientX;
      switchOrigin.y = e.clientY;
    },
    { capture: true, passive: true },
  );
}

const TABS: Record<TabId, () => ReactElement> = {
  cores: CoreAssignment,
  taskmgr: TaskManager,
  monitor: Monitor,
  osd: OsdConfig,
  gpu: GpuTune,
  fans: FanControl,
  optimize: Optimize,
  tuning: Tuning,
  settings: Settings,
};

function App() {
  const tab = useUi((s) => s.tab);
  const acrylic = useSettings((s) => s.acrylic);
  const windowOpacity = useSettings((s) => s.windowOpacity);
  const glow = useSettings((s) => s.glow);
  const theme = useSettings((s) => s.theme);
  const themeStyle = useSettings((s) => s.themeStyle);
  const reduceMotion = useSettings((s) => s.reduceMotion);
  const gpuRender = useSettings((s) => s.gpuRender);
  const closeToTray = useSettings((s) => s.closeToTray);
  const [overview, setOverview] = useState<Overview | null>(null);
  useAffinityEnforcer(overview ? (1n << BigInt(overview.logicalCpus)) - 1n : 0n);
  useOsdHotkey();
  usePerfRecorder();
  useOverlayInjection();
  useLiveHistoryRecorder();
  useGlobalI18n();

  useEffect(() => {
    api.getOverview().then(setOverview).catch(() => undefined);
  }, []);

  // Auto-apply the active GPU overclock profile on launch, if enabled. Storage
  // is async (tauri-plugin-store), so wait for hydration before reading state.
  useEffect(() => {
    const applyActive = () => {
      const { applyOnStartup, activeId, profiles, setStartupError } = useGpuProfiles.getState();
      if (!applyOnStartup || !activeId) return;
      const active = profiles.find((p) => p.id === activeId);
      if (!active) return;
      // Surface a startup-apply failure on the GPU page instead of silently
      // leaving the user believing their overclock was applied at boot.
      api.gpuOcApply(active.settings).catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "unknown error";
        setStartupError(`「${active.name}」: ${msg}`);
      });
    };
    if (useGpuProfiles.persist.hasHydrated()) {
      applyActive();
      return;
    }
    return useGpuProfiles.persist.onFinishHydration(applyActive);
  }, []);

  // Apply saved fan configs on launch when "apply on startup" is enabled, so
  // custom fan curves take effect at boot without opening the Fan page. Storage
  // is async (tauri-plugin-store) → wait for hydration before reading state.
  // A failed push records `lastError` in the store, surfaced on the Fan page.
  useEffect(() => {
    let retry: ReturnType<typeof setTimeout> | undefined;
    const applyFans = () => {
      if (!useFanProfiles.getState().applyOnStartup) return;
      useFanProfiles.getState().push();
      // A fresh-boot push can land BEFORE sensord has enumerated the writable fan
      // headers, so the backend rejects every config ("unknown/non-controllable
      // control id") and curves never take effect. Re-push once it's had time to
      // come up; the second push is a no-op if the first already succeeded.
      retry = setTimeout(() => {
        if (useFanProfiles.getState().applyOnStartup) useFanProfiles.getState().push();
      }, 5000);
    };
    const un = useFanProfiles.persist.hasHydrated() ? undefined : useFanProfiles.persist.onFinishHydration(applyFans);
    if (useFanProfiles.persist.hasHydrated()) applyFans();
    return () => {
      un?.();
      if (retry) clearTimeout(retry);
    };
  }, []);

  // Re-show the OSD overlay on launch if it was left enabled OR desktop mode is
  // on (the overlay window must exist for either; store is async → wait for it).
  useEffect(() => {
    const showIfEnabled = () => {
      const s = useOsd.getState();
      if (s.enabled || s.desktopMode) api.osdSetVisible(true).catch(() => undefined);
    };
    if (useOsd.persist.hasHydrated()) {
      showIfEnabled();
      return;
    }
    return useOsd.persist.onFinishHydration(showIfEnabled);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.acrylic = String(acrylic);
    // Apply/clear the real Win11 acrylic backdrop on the native window so the
    // toggle does something (the CSS below only frosts the page when it's on).
    api.setAcrylic(acrylic).catch(() => undefined);
  }, [acrylic]);

  useEffect(() => {
    // Whole-window opacity (%). Persisted in settings; applied natively.
    api.setWindowOpacity(windowOpacity).catch(() => undefined);
  }, [windowOpacity]);

  useEffect(() => {
    document.documentElement.dataset.glow = glow;
  }, [glow]);

  // Light / dark theme — drives the `html[data-theme="light"]` token overrides
  // in index.css. A short color/background transition makes the switch smooth.
  // Light / dark theme. Flipping `data-theme` recolors the whole token system at
  // once; we wrap it in a View Transition and clip-reveal the NEW theme as a
  // circle expanding from the toggle's click point (iOS-style). Falls back to an
  // instant swap when View Transitions aren't available or motion is reduced.
  const themeFirstRun = useRef(true);
  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      root.dataset.theme = theme;
      root.dataset.themeStyle = themeStyle;
      // Recolor the OSD overlay window (a separate webview that never mounts App)
      // to match the active theme.
      void emit("osd:theme", { theme, themeStyle });
    };
    type VTDoc = Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void> } };
    const startVT = (document as VTDoc).startViewTransition?.bind(document);
    // The View Transition snapshots the WHOLE page. With acrylic backdrop-filter +
    // the cyberpunk effect layers, rasterizing that snapshot is what FROZE the theme
    // switch. Skip the VT for those heavy cases and let the cheap CSS cross-fade (the
    // body background-color transition + the --color-accent / --color-accent-bright
    // @property transitions on <html>) carry the recolor smoothly — the static UI is
    // identical, only the switch animation is lighter (no full-page snapshot).
    const heavyForViewTransition = useSettings.getState().acrylic || themeStyle === "cyberpunk";
    // Never animate the very first paint (no theme "change" to reveal).
    if (themeFirstRun.current || !startVT || reduceMotion || heavyForViewTransition) {
      themeFirstRun.current = false;
      apply();
      return;
    }
    const cx = Number.isFinite(switchOrigin.x) ? switchOrigin.x : window.innerWidth / 2;
    const cy = Number.isFinite(switchOrigin.y) ? switchOrigin.y : window.innerHeight / 2;
    const end = Math.hypot(Math.max(cx, window.innerWidth - cx), Math.max(cy, window.innerHeight - cy));
    const vt = startVT(apply);
    vt.ready
      .then(() => {
        root.animate(
          { clipPath: [`circle(0px at ${cx}px ${cy}px)`, `circle(${end}px at ${cx}px ${cy}px)`] },
          { duration: 480, easing: "cubic-bezier(0.16, 1, 0.3, 1)", pseudoElement: "::view-transition-new(root)" },
        );
        // Subtle dip on the outgoing theme so the reveal reads as a layered wipe.
        root.animate(
          { opacity: [1, 0.94, 1] },
          { duration: 380, easing: "cubic-bezier(0.22, 1, 0.36, 1)", pseudoElement: "::view-transition-old(root)" },
        );
      })
      .catch(() => undefined);
  }, [theme, themeStyle, reduceMotion]);

  // Mirror reduce-motion to the DOM so CSS can kill continuous animations (HUD
  // grid, glow pulses, spinners) — the main idle-CPU cost on low-end machines.
  useEffect(() => {
    document.documentElement.dataset.reduceMotion = String(reduceMotion);
  }, [reduceMotion]);

  // GPU-render toggle → mirrored to the DOM so the low-GPU CSS mode can drop the
  // backdrop-filter blur + the blurred ambient backdrop orbs (see index.css).
  useEffect(() => {
    document.documentElement.dataset.gpuRender = String(gpuRender);
  }, [gpuRender]);

  // Keep the NATIVE injected overlay's per-row colors in sync with the theme so
  // the in-game OSD shows the active theme's palette (cyberpunk yellow+blue, …).
  // Safe no-op when injection isn't active; runs on mount + every theme change.
  useEffect(() => {
    api.overlaySetPalette(osdRowColorsRgba(themeStyle)).catch(() => undefined);
  }, [themeStyle]);

  // Mirror the "close to tray" preference to the backend window-close handler.
  useEffect(() => {
    api.setCloseToTray(closeToTray).catch(() => undefined);
  }, [closeToTray]);

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
    <MotionConfig reducedMotion={reduceMotion ? "always" : "never"}>
      <div className="relative flex h-screen w-screen flex-col overflow-hidden bg-base text-ink">
        <div aria-hidden className="app-backdrop pointer-events-none absolute inset-0 -z-10 overflow-hidden">
          <div className="hud-grid absolute inset-0 opacity-60" />
          <div className="absolute -left-40 -top-40 h-[480px] w-[480px] rounded-full bg-accent/20 blur-[120px]" />
          <div className="absolute -bottom-52 -right-32 h-[460px] w-[460px] rounded-full bg-rose/12 blur-[130px]" />
          <div className="absolute -bottom-40 left-1/3 h-[360px] w-[360px] rounded-full bg-cyan/10 blur-[130px]" />
        </div>

        <TitleBar cpuName={overview?.cpuName} />

        <div className="flex min-h-0 flex-1">
          <NavRail />
          <main className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
            <AnimatePresence mode="wait">
              <motion.div
                key={tab}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.2, ease: [0.33, 1, 0.68, 1] }}
                className="flex h-full min-h-0 min-w-0 flex-col"
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
