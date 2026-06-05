import { create } from "zustand";

export type TabId = "cores" | "taskmgr" | "monitor" | "osd" | "gpu" | "fans" | "optimize" | "tuning" | "settings";

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
  toggleOptimization: () => void;
  setOptimization: (value: boolean) => void;
}

export const useUi = create<UiState>((set) => ({
  tab: "cores",
  setTab: (tab) => set({ tab }),
  monitorSub: "live",
  setMonitorSub: (monitorSub) => set({ monitorSub }),
  optimizationEnabled: true,
  toggleOptimization: () => set((s) => ({ optimizationEnabled: !s.optimizationEnabled })),
  setOptimization: (optimizationEnabled) => set({ optimizationEnabled }),
}));
