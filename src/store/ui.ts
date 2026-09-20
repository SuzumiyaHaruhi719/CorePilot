import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { SortKey } from "../components/cores/ProcessTable";
import type { OsdCategory } from "../lib/osd";
import { tauriStorage } from "../lib/persist";

export type TabId = "cores" | "taskmgr" | "monitor" | "osd" | "gpu" | "fans" | "optimize" | "disk" | "tuning" | "amd" | "settings";

/** Monitor tab sub-views: live dashboard vs. saved session reports. */
export type MonitorSub = "live" | "history";

/** 任务管理器 sub-views (the SecondaryTabs row). */
export type TaskmgrSec = "perf" | "procs" | "details" | "startup" | "services";

export type SortDir = "asc" | "desc";

/** A column's natural first click: text reads best ascending, numbers descending. */
export function defaultSortDir(key: SortKey): SortDir {
  return key === "name" || key === "group" ? "asc" : "desc";
}

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

  /* ── Session view state ────────────────────────────────────────────────
   * App.tsx remounts a tab's whole subtree on every tab switch (the
   * `<AnimatePresence mode="wait">` + `key={tab}`). That remount is deliberate —
   * it is what stops the leaving tab's pollers — but it also destroyed every
   * `useState` inside the tab, so coming back landed the user on a reset
   * sub-tab, an emptied search box and a sort order they never chose.
   * Hoisting those few fields here makes the remount invisible.
   *
   * NONE of them are in `partialize` below, so nothing new is written to disk
   * and the store version stays at 1 — a bare version bump silently discards
   * the user's persisted state (rule 4), and view state is not worth that risk.
   */

  /** Active 任务管理器 sub-tab. */
  taskmgrSec: TaskmgrSec;
  setTaskmgrSec: (sec: TaskmgrSec) => void;

  /** 任务管理器 → 进程 / 详细信息: filter text and sort order (shared by both
   *  views on purpose — they list the same processes). */
  procSearch: string;
  setProcSearch: (q: string) => void;
  procSortKey: SortKey;
  procSortDir: SortDir;
  /** Header click: the SAME column flips direction, a new column takes its
   *  natural default. Lives in the store so the handler passed down to the
   *  `memo`ized rows has a permanently stable identity — a callback re-created
   *  each render makes every row's comparator fail on every 1.5 s poll and
   *  quietly cancels the memo. */
  setProcSort: (key: SortKey) => void;

  /** 核心分配 tab: its own filter/sort pair. Deliberately NOT shared with the
   *  task-manager ones — typing a filter in one tab silently filtering another
   *  tab's table is a bug, not a feature. */
  coreSearch: string;
  setCoreSearch: (q: string) => void;
  coreSortKey: SortKey;
  coreSortDir: SortDir;
  setCoreSort: (key: SortKey) => void;

  /** Active category in the OSD content picker (owned by src/tabs/OsdConfig.tsx). */
  osdCategory: OsdCategory;
  setOsdCategory: (cat: OsdCategory) => void;
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

      taskmgrSec: "perf",
      setTaskmgrSec: (taskmgrSec) => set({ taskmgrSec }),

      procSearch: "",
      setProcSearch: (procSearch) => set({ procSearch }),
      procSortKey: "cpu",
      procSortDir: "desc",
      setProcSort: (key) =>
        set((s) =>
          key === s.procSortKey
            ? { procSortDir: s.procSortDir === "asc" ? "desc" : "asc" }
            : { procSortKey: key, procSortDir: defaultSortDir(key) },
        ),

      coreSearch: "",
      setCoreSearch: (coreSearch) => set({ coreSearch }),
      coreSortKey: "cpu",
      coreSortDir: "desc",
      setCoreSort: (key) =>
        set((s) =>
          key === s.coreSortKey
            ? { coreSortDir: s.coreSortDir === "asc" ? "desc" : "asc" }
            : { coreSortKey: key, coreSortDir: defaultSortDir(key) },
        ),

      osdCategory: "cpu",
      setOsdCategory: (osdCategory) => set({ osdCategory }),
    }),
    {
      name: "corepilot-ui",
      version: 1,
      storage: createJSONStorage(() => tauriStorage),
      // Persist ONLY the startup preference (auto-saved). tab / monitorSub /
      // optimizationEnabled and every view-state field above are intentionally
      // session-only: a restart shouldn't restore a tab or silently re-enable
      // optimization unless auto-apply is on. Because nothing was ADDED to this
      // list, the persisted shape is unchanged and `version` stays 1 (a bump
      // without a migrate wipes the user's saved state).
      partialize: (s) => ({ optimizeOnStartup: s.optimizeOnStartup, amdTuningUnlocked: s.amdTuningUnlocked }),
    },
  ),
);
