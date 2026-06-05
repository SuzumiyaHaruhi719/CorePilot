import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { api, type FanChannelConfig, type FanCurvePoint, type FanMode } from "../lib/ipc";
import { tauriStorage } from "../lib/persist";

/** Per-fan configuration as edited in the UI (keyed by control id). */
export interface FanConfig {
  mode: FanMode;
  manualPct: number;
  tempSourceId: string | null;
  curve: FanCurvePoint[];
  minDuty: number;
}

/** A sensible silent-ish default curve (°C → duty %). */
export const DEFAULT_CURVE: FanCurvePoint[] = [
  { tempC: 30, duty: 20 },
  { tempC: 50, duty: 35 },
  { tempC: 65, duty: 55 },
  { tempC: 78, duty: 80 },
  { tempC: 85, duty: 100 },
];

export function defaultConfig(): FanConfig {
  return { mode: "auto", manualPct: 50, tempSourceId: null, curve: DEFAULT_CURVE, minDuty: 20 };
}

function toBackend(configs: Record<string, FanConfig>): FanChannelConfig[] {
  return Object.entries(configs).map(([controlId, c]) => ({
    controlId,
    mode: c.mode,
    manualPct: c.manualPct,
    tempSourceId: c.tempSourceId,
    curve: c.curve,
    minDuty: c.minDuty,
  }));
}

interface FanProfileState {
  configs: Record<string, FanConfig>;
  applyOnStartup: boolean;
  /** Custom display names per control id (e.g. "CPU", "水泵"). UI-only; not sent
   *  to the backend engine. */
  labels: Record<string, string>;
  /** Patch one fan's config and push the whole set to the backend engine. */
  setConfig: (controlId: string, patch: Partial<FanConfig>) => void;
  setApplyOnStartup: (value: boolean) => void;
  /** Set (or clear, with "") a fan's custom display name. */
  setLabel: (controlId: string, label: string) => void;
  /** Push the current config set to the backend engine. */
  push: () => void;
}

/** Fan configurations auto-persist (tauri-store) and push to the backend engine
 *  on every change. */
export const useFanProfiles = create<FanProfileState>()(
  persist(
    (set, get) => ({
      configs: {},
      labels: {},
      applyOnStartup: false,
      setConfig: (controlId, patch) => {
        const prev = get().configs[controlId] ?? defaultConfig();
        const next = { ...prev, ...patch };
        const configs = { ...get().configs, [controlId]: next };
        set({ configs });
        api.fanSetConfig(toBackend(configs)).catch(() => undefined);
      },
      setApplyOnStartup: (applyOnStartup) => set({ applyOnStartup }),
      setLabel: (controlId, label) => {
        const labels = { ...get().labels };
        const trimmed = label.trim();
        if (trimmed) labels[controlId] = trimmed;
        else delete labels[controlId];
        set({ labels });
      },
      push: () => {
        api.fanSetConfig(toBackend(get().configs)).catch(() => undefined);
      },
    }),
    { name: "corepilot-fan-profiles", version: 1, storage: createJSONStorage(() => tauriStorage) },
  ),
);
