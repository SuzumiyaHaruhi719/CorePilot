import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { tauriStorage } from "../lib/persist";

export type TabId = "cores" | "taskmgr" | "monitor" | "osd" | "gpu" | "fans" | "optimize" | "tuning" | "amd" | "settings";

/** Monitor tab sub-views: live dashboard vs. saved session reports. */
export type MonitorSub = "live" | "history";

interface UiState {
  tab: TabId;
  setTab: (tab: TabId) => void;
  /** Active Monitor sub-tab. Lifted into the store so the perf recorder can
   * drive it to "history" when auto-surfacing a finished session's report. */
  monitorSub: MonitorSub;
  setMonitorSub: (sub: MonitorSub) => void;
  optimizationEnabled: boolean;
  /** When true, affinity optimization auto-enables on the NEXT app launch. This is
   *  the ONLY persisted ui field (auto-saved) — `optimizationEnabled`, `tab` and
   *  `monitorSub` stay session-only, so a restart never silently re-pins affinity
   *  unless the user opted in here. */
  optimizeOnStartup: boolean;
  toggleOptimization: () => void;
  setOptimization: (value: boolean) => void;
  setOptimizeOnStartup: (value: boolean) => void;
  /** Master safety switch for the AMD/SMU tuning tab. OFF by default and persisted,
   *  so the dangerous Curve-Optimizer / PBO write controls stay locked away and
   *  can't be triggered by accident — the user must deliberately unlock them. */
  amdTuningUnlocked: boolean;
  setAmdTuningUnlocked: (value: boolean) => void;
}

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      tab: "cores",
      setTab: (tab) => set({ tab }),
      monitorSub: "live",
      setMonitorSub: (monitorSub) => set({ monitorSub }),
      // Off by default: auto-pinning every matching process on launch can pile a whole
      // CCD group onto ONE CCD (saturating it while the other idles). The user opts in
      // via the toggle (or the "auto-apply on next launch" checkbox) when they want
      // affinity enforcement; until then both CCDs run everything (Windows scheduler).
      optimizationEnabled: false,
      optimizeOnStartup: false,
      toggleOptimization: () => set((s) => ({ optimizationEnabled: !s.optimizationEnabled })),
      setOptimization: (optimizationEnabled) => set({ optimizationEnabled }),
      setOptimizeOnStartup: (optimizeOnStartup) => set({ optimizeOnStartup }),
      amdTuningUnlocked: false,
      setAmdTuningUnlocked: (amdTuningUnlocked) => set({ amdTuningUnlocked }),
    }),
    {
      name: "corepilot-ui",
      version: 1,
      storage: createJSONStorage(() => tauriStorage),
      // Persist ONLY the startup preference (auto-saved). tab / monitorSub /
      // optimizationEnabled are intentionally session-only: a restart shouldn't
      // restore a tab or silently re-enable optimization unless auto-apply is on.
      partialize: (s) => ({ optimizeOnStartup: s.optimizeOnStartup, amdTuningUnlocked: s.amdTuningUnlocked }),
    },
  ),
);
