import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { api, type FanCalibration, type FanChannelConfig, type FanCurvePoint, type FanMode } from "../lib/ipc";
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

// Both curves hit 100 % at 70 °C — the full-speed threshold for the Ryzen 9
// 9950X3D (keeps the hot V-Cache CCD in check before it throttles).

/** Quiet: barely audible at idle, holds low, then ramps hard into 70 °C → full. */
const QUIET_CURVE: FanCurvePoint[] = [
  { tempC: 30, duty: 20 },
  { tempC: 45, duty: 30 },
  { tempC: 55, duty: 45 },
  { tempC: 63, duty: 65 },
  { tempC: 70, duty: 100 },
];

/** Turbo: aggressive — high baseline, full speed by 70 °C. */
const TURBO_CURVE: FanCurvePoint[] = [
  { tempC: 30, duty: 45 },
  { tempC: 50, duty: 70 },
  { tempC: 60, duty: 88 },
  { tempC: 70, duty: 100 },
];

/** Built-in one-click presets. Quiet/Turbo are temperature curves (they need a
 *  temp source — the UI supplies a sensible default per channel); Full Blast pins
 *  every fan to 100 % (manual). */
export interface FanPreset {
  id: string;
  name: string;
  mode: FanMode;
  curve?: FanCurvePoint[];
  manualPct?: number;
}

export const FAN_PRESETS: FanPreset[] = [
  { id: "preset-quiet", name: "Quiet", mode: "curve", curve: QUIET_CURVE },
  { id: "preset-turbo", name: "Turbo", mode: "curve", curve: TURBO_CURVE },
  { id: "preset-fullblast", name: "Full Blast", mode: "manual", manualPct: 100 },
];

/**
 * Lowest duty any managed fan is ever driven to. A CPU cooler / AIO pump at 0%
 * can stop cooling, so calibration, presets and the manual/curve sliders all
 * clamp to this floor. Shared with the Fan UI so the data layer and the controls
 * agree. (Auto mode hands the fan back to the BIOS and is exempt.)
 */
export const MIN_SAFE_DUTY = 20;

/** Build a no-stall curve from a calibrated start duty: idle at the fan's
 *  quietest stable speed (30 °C), then ramp to full by 70 °C (the 9950X3D
 *  full-speed threshold), with all duties at or above the safe floor. */
function calibratedCurve(minStartDuty: number): FanCurvePoint[] {
  const lo = Math.round(Math.max(MIN_SAFE_DUTY, Math.min(minStartDuty, 60)));
  const span = 100 - lo;
  return [
    { tempC: 30, duty: lo },
    { tempC: 50, duty: Math.round(lo + span * 0.35) },
    { tempC: 60, duty: Math.round(lo + span * 0.7) },
    { tempC: 70, duty: 100 },
  ];
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
  /** Profile whose apply is in flight; becomes active only after it succeeds. */
  pendingProfileId: string | null;
  /** Snapshot the current configs as a NEW named profile and make it active (另存为). */
  saveProfile: (name: string) => void;
  /** Overwrite the currently-active profile with the live configs (保存当前). No-op
   *  when no profile is active. */
  updateActiveProfile: () => void;
  /** Apply a saved profile: load its configs and push to the engine. */
  applyProfile: (id: string) => void;
  /** Apply a built-in preset (Quiet/Turbo curve, or Full Blast 100%) to every
   *  controllable channel; `defaultTempSourceId` seeds the curve modes' source. */
  applyPreset: (presetId: string, channelIds: string[], defaultTempSourceId: string | null) => void;
  /** Turn AI-calibration results into a tailored no-stall curve per fan (idle at
   *  the measured start duty, full speed by 70 °C) and push them to the engine. */
  applyCalibration: (calibs: FanCalibration[], defaultTempSourceId: string | null) => void;
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
      pendingProfileId: null,
      saveProfile: (name) => {
        const id = uid();
        const profile: FanProfile = { id, name, configs: cloneConfigs(get().configs) };
        set((s) => ({ profiles: [...s.profiles, profile], activeProfileId: id }));
      },
      updateActiveProfile: () => {
        const { activeProfileId, configs } = get();
        if (!activeProfileId) return;
        set((s) => ({
          profiles: s.profiles.map((p) =>
            p.id === activeProfileId ? { ...p, configs: cloneConfigs(configs) } : p,
          ),
        }));
      },
      applyProfile: (id) => {
        const profile = get().profiles.find((p) => p.id === id);
        if (!profile) return;
        const configs = cloneConfigs(profile.configs);
        // Load configs immediately (so the engine reflects them), but mark the
        // profile active ONLY after the backend confirms — otherwise show pending
        // and, on failure, surface the error without a false "active" badge.
        set({ configs, pendingProfileId: id });
        api
          .fanSetConfig(toBackend(configs))
          .then(() => set({ activeProfileId: id, pendingProfileId: null, lastError: null }))
          .catch((e) => set({ pendingProfileId: null, lastError: applyErrorMessage(e) }));
      },
      applyPreset: (presetId, channelIds, defaultTempSourceId) => {
        const preset = FAN_PRESETS.find((p) => p.id === presetId);
        if (!preset || channelIds.length === 0) return;
        const cur = get().configs;
        const configs = { ...cur };
        for (const id of channelIds) {
          const prev = cur[id] ?? defaultConfig();
          if (preset.mode === "curve") {
            configs[id] = {
              ...prev,
              mode: "curve",
              curve: (preset.curve ?? DEFAULT_CURVE).map((p) => ({ ...p })),
              // Keep the channel's own temp source if it already has one; else fall
              // back to the supplied default (curve mode with no source reverts to
              // BIOS auto in the engine).
              tempSourceId: prev.tempSourceId ?? defaultTempSourceId,
            };
          } else {
            configs[id] = { ...prev, mode: "manual", manualPct: preset.manualPct ?? 100 };
          }
        }
        set({ configs, pendingProfileId: presetId });
        api
          .fanSetConfig(toBackend(configs))
          .then(() => set({ activeProfileId: presetId, pendingProfileId: null, lastError: null }))
          .catch((e) => set({ pendingProfileId: null, lastError: applyErrorMessage(e) }));
      },
      applyCalibration: (calibs, defaultTempSourceId) => {
        const cur = get().configs;
        const configs = { ...cur };
        for (const cal of calibs) {
          if (cal.disconnected) continue; // no fan on this header — leave it alone
          const prev = cur[cal.controlId] ?? defaultConfig();
          const lo = Math.round(Math.max(MIN_SAFE_DUTY, Math.min(cal.minStartDuty, 60)));
          configs[cal.controlId] = {
            ...prev,
            mode: "curve",
            curve: calibratedCurve(lo),
            minDuty: lo,
            tempSourceId: prev.tempSourceId ?? defaultTempSourceId,
          };
        }
        // Tuned state isn't a named preset, so clear any active-preset highlight.
        set({ configs, activeProfileId: null, pendingProfileId: null });
        api
          .fanSetConfig(toBackend(configs))
          .then(() => set({ lastError: null }))
          .catch((e) => set({ lastError: applyErrorMessage(e) }));
      },
      deleteProfile: (id) =>
        set((s) => ({
          profiles: s.profiles.filter((p) => p.id !== id),
          activeProfileId: s.activeProfileId === id ? null : s.activeProfileId,
          pendingProfileId: s.pendingProfileId === id ? null : s.pendingProfileId,
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
