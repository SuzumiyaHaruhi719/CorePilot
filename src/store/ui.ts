import { create } from "zustand";

export type TabId = "cores" | "taskmgr" | "monitor" | "optimize" | "settings";

interface UiState {
  tab: TabId;
  setTab: (tab: TabId) => void;
  optimizationEnabled: boolean;
  toggleOptimization: () => void;
  setOptimization: (value: boolean) => void;
}

export const useUi = create<UiState>((set) => ({
  tab: "cores",
  setTab: (tab) => set({ tab }),
  optimizationEnabled: true,
  toggleOptimization: () => set((s) => ({ optimizationEnabled: !s.optimizationEnabled })),
  setOptimization: (optimizationEnabled) => set({ optimizationEnabled }),
}));
