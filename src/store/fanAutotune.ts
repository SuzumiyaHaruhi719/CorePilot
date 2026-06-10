import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  api,
  type AutoTuneParams,
  type AutoTuneResult,
  type PassiveConfig,
  type TunedFanCurve,
} from "../lib/ipc";
import { tauriStorage } from "../lib/persist";
import { useFanProfiles } from "./fanProfiles";

export interface PassiveLogEntry {
  atMs: number;
  axis: "cpu" | "gpu";
  deltaC: number;
  medianResidualC: number;
}

export function defaultTuneParams(): AutoTuneParams {
  return { targetTempC: 85, targetGpuTempC: 80, quietFloorPct: 25, noiseCeilPct: 100, groups: {} };
}

interface FanAutotuneState {
  /** Last completed tune (model + grid + curves), or null. */
  result: AutoTuneResult | null;
  /** Last-used wizard parameters (pre-filled next time). */
  params: AutoTuneParams;
  passiveEnabled: boolean;
  /** True when a hand-edit paused passive learning (cleared by re-apply/re-tune). */
  passivePaused: boolean;
  passiveLog: PassiveLogEntry[];
  setParams: (p: AutoTuneParams) => void;
  setResult: (r: AutoTuneResult | null) => void;
  /** Write tuned curves into the live fan configs and push to the engine. */
  applyTuned: (curves: TunedFanCurve[], cpuSourceId: string | null, gpuSourceId: string | null) => void;
  /** Send (or clear) the passive-learning config to the backend. */
  configurePassive: () => void;
  setPassiveEnabled: (v: boolean) => void;
  setPassivePaused: (v: boolean) => void;
  addPassiveLog: (e: PassiveLogEntry) => void;
}

export const useFanAutotune = create<FanAutotuneState>()(
  persist(
    (set, get) => ({
      result: null,
      params: defaultTuneParams(),
      passiveEnabled: true,
      passivePaused: false,
      passiveLog: [],
      setParams: (params) => set({ params }),
      setResult: (result) => set({ result }),

      applyTuned: (curves, cpuSourceId, gpuSourceId) => {
        const fp = useFanProfiles.getState();
        for (const c of curves) {
          fp.setConfig(c.controlId, {
            mode: "curve",
            curve: c.curve.map((p) => ({ ...p })),
            curve2: c.curve2.map((p) => ({ ...p })),
            tempSourceId: cpuSourceId ?? fp.configs[c.controlId]?.tempSourceId ?? null,
            tempSourceId2: c.curve2.length > 0 ? gpuSourceId : null,
            minDuty: c.minDuty,
            spinUpPct: c.spinUpPct,
            spinDownPct: c.spinDownPct,
          });
        }
        set({ passivePaused: false });
      },

      configurePassive: () => {
        const { result, params, passiveEnabled, passivePaused } = get();
        if (!result || !passiveEnabled || passivePaused) {
          void api.fanPassiveConfigure(null).catch(() => undefined);
          return;
        }
        const cfg: PassiveConfig = {
          enabled: true,
          params,
          model: result.model,
          modelGpu: result.modelGpu ?? null,
          calibrations: result.calibrations,
          pDesign: result.pDesign,
          pDesignGpu: result.pDesignGpu ?? null,
        };
        void api.fanPassiveConfigure(cfg).catch(() => undefined);
      },

      setPassiveEnabled: (passiveEnabled) => {
        set({ passiveEnabled });
        get().configurePassive();
      },
      setPassivePaused: (passivePaused) => {
        set({ passivePaused });
        get().configurePassive();
      },
      addPassiveLog: (e) =>
        set((s) => ({ passiveLog: [e, ...s.passiveLog].slice(0, 20) })),
    }),
    {
      name: "corepilot-fan-autotune",
      version: 1,
      storage: createJSONStorage(() => tauriStorage),
      partialize: ({ passivePaused: _p, ...rest }) => rest,
    },
  ),
);
