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

/** A saved, named snapshot of all fan configs for one-click switching. */
export interface FanProfile {
  id: string;
  name: string;
  configs: Record<string, FanConfig>;
}

function uid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `fp_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

/** Deep-copy a config map so saved profiles don't alias the live state. */
function cloneConfigs(src: Record<string, FanConfig>): Record<string, FanConfig> {
  const out: Record<string, FanConfig> = {};
  for (const [k, v] of Object.entries(src)) {
    out[k] = { ...v, curve: v.curve.map((p) => ({ ...p })) };
  }
  return out;
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
  /** Saved fan profiles + the currently-applied one. */
  profiles: FanProfile[];
  activeProfileId: string | null;
  /** Snapshot the current configs as a named profile and make it active. */
  saveProfile: (name: string) => void;
  /** Apply a saved profile: load its configs and push to the engine. */
  applyProfile: (id: string) => void;
  deleteProfile: (id: string) => void;
  /** Push the current config set to the backend engine. */
  push: () => void;
  /** Last backend apply/push failure (localised), or null when the last apply
   *  succeeded. Surfaced in the Fan page so a failed apply isn't silent. */
  lastError: string | null;
  /** Clear the surfaced apply error. */
  clearError: () => void;
}

/** Best-effort message from a rejected `invoke` (Tauri rejects with a string,
 *  but be defensive for Error/unknown shapes too). */
function applyErrorMessage(e: unknown): string {
  if (typeof e === "string" && e.trim()) return e;
  if (e instanceof Error && e.message) return e.message;
  return "未知错误";
}

/** Fan configurations auto-persist (tauri-store) and push to the backend engine
 *  on every change. */
export const useFanProfiles = create<FanProfileState>()(
  persist(
    (set, get) => ({
      configs: {},
      labels: {},
      applyOnStartup: false,
      lastError: null,
      clearError: () => set({ lastError: null }),
      setConfig: (controlId, patch) => {
        const prev = get().configs[controlId] ?? defaultConfig();
        const next = { ...prev, ...patch };
        const configs = { ...get().configs, [controlId]: next };
        set({ configs });
        api
          .fanSetConfig(toBackend(configs))
          .then(() => set({ lastError: null }))
          .catch((e) => set({ lastError: applyErrorMessage(e) }));
      },
      setApplyOnStartup: (applyOnStartup) => set({ applyOnStartup }),
      setLabel: (controlId, label) => {
        const labels = { ...get().labels };
        const trimmed = label.trim();
        if (trimmed) labels[controlId] = trimmed;
        else delete labels[controlId];
        set({ labels });
      },
      profiles: [],
      activeProfileId: null,
      saveProfile: (name) => {
        const id = uid();
        const profile: FanProfile = { id, name, configs: cloneConfigs(get().configs) };
        set((s) => ({ profiles: [...s.profiles, profile], activeProfileId: id }));
      },
      applyProfile: (id) => {
        const profile = get().profiles.find((p) => p.id === id);
        if (!profile) return;
        const configs = cloneConfigs(profile.configs);
        set({ configs, activeProfileId: id });
        api
          .fanSetConfig(toBackend(configs))
          .then(() => set({ lastError: null }))
          .catch((e) => set({ lastError: applyErrorMessage(e) }));
      },
      deleteProfile: (id) =>
        set((s) => ({
          profiles: s.profiles.filter((p) => p.id !== id),
          activeProfileId: s.activeProfileId === id ? null : s.activeProfileId,
        })),
      push: () => {
        api
          .fanSetConfig(toBackend(get().configs))
          .then(() => set({ lastError: null }))
          .catch((e) => set({ lastError: applyErrorMessage(e) }));
      },
    }),
    {
      name: "corepilot-fan-profiles",
      version: 1,
      storage: createJSONStorage(() => tauriStorage),
      // `lastError` is a transient session signal — never persist it.
      partialize: ({ lastError: _lastError, clearError: _clearError, ...rest }) => rest,
    },
  ),
);
