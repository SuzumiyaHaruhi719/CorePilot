import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { api, type CalibPoint, type FanCalibration, type FanChannelConfig, type FanCurvePoint, type FanMode } from "../lib/ipc";
import { tauriStorage } from "../lib/persist";

/** Per-fan configuration as edited in the UI (keyed by control id). */
export interface FanConfig {
  mode: FanMode;
  manualPct: number;
  tempSourceId: string | null;
  curve: FanCurvePoint[];
  minDuty: number;
  /** Curve-mode ramp-up smoothing: 0 = Smooth (slow ease toward the target),
   *  100 = Immediate (jump to the target in one tick, today's behavior). */
  spinUpPct: number;
  /** Curve-mode ramp-down smoothing: 0 = Smooth, 100 = Immediate. */
  spinDownPct: number;
}

/**
 * Balanced, quiet-but-safe default curve (°C → duty %), modelled on the widely
 * used Fan Control (Rem0o) community guidance: idle at 30% (also NVIDIA's manual
 * floor — newer GeForce cards ignore <30% and only do 0-RPM in auto mode), a
 * gentle mid-range, then full speed by 85 °C. Works for case/CPU/AIO and GPU fans.
 */
export const DEFAULT_CURVE: FanCurvePoint[] = [
  { tempC: 30, duty: 30 },
  { tempC: 45, duty: 38 },
  { tempC: 55, duty: 50 },
  { tempC: 65, duty: 65 },
  { tempC: 75, duty: 85 },
  { tempC: 85, duty: 100 },
];

export function defaultConfig(): FanConfig {
  return { mode: "auto", manualPct: 50, tempSourceId: null, curve: DEFAULT_CURVE, minDuty: 20, spinUpPct: 100, spinDownPct: 100 };
}

// Silent / Standard / Turbo modelled on ASUS Fan Xpert's CPU-fan presets: a
// quiet low-temp hold that ramps to full, progressively more aggressive.

/** Silent: 20% idle, gentle ramp, full only by ~78 °C — quietest. */
const SILENT_CURVE: FanCurvePoint[] = [
  { tempC: 30, duty: 20 },
  { tempC: 45, duty: 33 },
  { tempC: 55, duty: 45 },
  { tempC: 65, duty: 60 },
  { tempC: 72, duty: 80 },
  { tempC: 78, duty: 100 },
];

/** Standard: balanced — ~22% idle, full by ~73 °C. */
const STANDARD_CURVE: FanCurvePoint[] = [
  { tempC: 30, duty: 22 },
  { tempC: 40, duty: 33 },
  { tempC: 50, duty: 45 },
  { tempC: 60, duty: 60 },
  { tempC: 70, duty: 80 },
  { tempC: 73, duty: 100 },
];

/** Turbo: aggressive — 30% idle, full by ~72 °C. */
const TURBO_CURVE: FanCurvePoint[] = [
  { tempC: 30, duty: 30 },
  { tempC: 40, duty: 40 },
  { tempC: 50, duty: 49 },
  { tempC: 60, duty: 61 },
  { tempC: 68, duty: 80 },
  { tempC: 72, duty: 100 },
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
  { id: "preset-silent", name: "Silent", mode: "curve", curve: SILENT_CURVE },
  { id: "preset-standard", name: "Standard", mode: "curve", curve: STANDARD_CURVE },
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

/**
 * Each temperature node of a calibrated curve targets a FRACTION OF THE FAN'S
 * MEASURED MAX RPM (real airflow), not a raw PWM duty. The duty that achieves
 * each fraction is then looked up from the calibration's own (duty→RPM) samples.
 *
 * Why: a curve point that reads "50%" should mean ~50% of the fan's real top
 * speed — the user's mental model ("duty should track RPM"). On the reported
 * NCT6701D the fan tops out ~3000 RPM but ~80% PWM already shows ~1393 RPM, i.e.
 * RPM is far from linear in duty (and the chip's tachometer may under-report).
 * Targeting RPM% and inverting through the measured samples corrects that for
 * THIS fan regardless of the absolute RPM scale: on a fan whose RPM is linear in
 * duty (a correctly-reporting one) the mapping is ~identity, so it never regrabs
 * a well-behaved fan; on a non-linear / half-reading one it picks the lower duty
 * that already delivers the intended airflow.
 *
 * `(tempC, rpmFraction)` — quiet idle, gentle mid-range, full airflow by 85 °C.
 */
const CALIB_RPM_TARGETS: { tempC: number; frac: number }[] = [
  { tempC: 40, frac: 0.0 }, // idle: the fan's quietest stable speed (start duty)
  { tempC: 60, frac: 0.35 },
  { tempC: 75, frac: 0.65 },
  { tempC: 85, frac: 1.0 }, // full airflow
];

/** Lowest count of usable (rpm>0) calibration samples needed to trust the
 *  measured duty→RPM mapping; below this we fall back to the start-duty curve. */
const MIN_USABLE_SAMPLES = 3;

/**
 * Invert the measured (duty → RPM) samples: return the PWM duty that achieves
 * `frac` of `maxRpm`. Samples are sorted by duty and linearly interpolated; the
 * result is clamped to [`minStartDuty`, 100] so a curve never drops a fan below
 * the speed at which it reliably spins. `frac` is clamped to [0, 1].
 *
 * `frac = 0` maps to `minStartDuty` (idle at the quietest stable speed). For a
 * fan whose RPM rises linearly with duty this is ~`frac × 100`; for a non-linear
 * or under-reporting fan it returns the (lower) duty that already delivers that
 * airflow — which is exactly the fix for "duty disproportionate to RPM".
 */
function dutyForRpmFraction(
  points: CalibPoint[],
  frac: number,
  minStartDuty: number,
  maxRpm: number,
): number {
  const f = Math.max(0, Math.min(1, frac));
  const lo = Math.max(MIN_SAFE_DUTY, minStartDuty);
  if (f <= 0 || maxRpm <= 0) return lo;

  const target = f * maxRpm;
  // Sort by duty and keep only finite, spinning samples.
  const usable = points
    .filter((p) => Number.isFinite(p.duty) && Number.isFinite(p.rpm) && p.rpm > 0)
    .sort((a, b) => a.duty - b.duty);
  if (usable.length === 0) return Math.min(100, Math.max(lo, Math.round(f * 100)));

  // Below the first sample's RPM → use its duty (already clamped to the floor).
  if (target <= usable[0].rpm) return Math.max(lo, Math.round(usable[0].duty));
  // At/above the top measured RPM → full duty (can't spin it faster than max).
  const top = usable[usable.length - 1];
  if (target >= top.rpm) return 100;

  // Find the bracketing samples and interpolate duty against RPM.
  for (let i = 0; i < usable.length - 1; i++) {
    const a = usable[i];
    const b = usable[i + 1];
    if (target >= a.rpm && target <= b.rpm) {
      const span = b.rpm - a.rpm;
      const duty = span <= 0 ? b.duty : a.duty + ((target - a.rpm) / span) * (b.duty - a.duty);
      return Math.max(lo, Math.min(100, Math.round(duty)));
    }
  }
  return 100;
}

/** Build a GENTLE no-stall curve from a calibrated start duty: idle at the fan's
 *  quietest stable speed, ramp slowly through the mid-range, and only hit full
 *  near 85 °C. The old curve hit ~70% of the span by 60 °C and full by 70 °C,
 *  which drove stiff fans to 90%+ duty at everyday temps — way too loud. Keeps
 *  the floor at/above the start duty (capped) so the fan still spins up. Used as
 *  a fallback when the calibration didn't capture enough RPM samples to map by
 *  airflow (see `calibratedCurveFromPoints`). */
function calibratedCurve(minStartDuty: number): FanCurvePoint[] {
  const lo = Math.round(Math.max(MIN_SAFE_DUTY, Math.min(minStartDuty, 50)));
  const span = 100 - lo;
  return [
    { tempC: 40, duty: lo },
    { tempC: 60, duty: Math.round(lo + span * 0.28) },
    { tempC: 75, duty: Math.round(lo + span * 0.6) },
    { tempC: 85, duty: 100 },
  ];
}

/**
 * Build a calibrated temperature→duty curve whose nodes target a fraction of the
 * fan's MEASURED max RPM (real airflow) rather than raw PWM duty — see
 * `CALIB_RPM_TARGETS` / `dutyForRpmFraction`. Falls back to the start-duty curve
 * when the sweep captured too few spinning samples to trust the mapping. The
 * resulting curve's Y axis is still PWM duty (so the editor + engine are
 * unchanged); the nodes are simply placed at the duty that yields the intended
 * RPM, so a fan whose RPM lags its duty no longer sits near full for mid airflow.
 */
function calibratedCurveFromPoints(cal: FanCalibration, minStartDuty: number): FanCurvePoint[] {
  const usable = cal.points.filter((p) => Number.isFinite(p.rpm) && p.rpm > 0);
  if (usable.length < MIN_USABLE_SAMPLES || cal.maxRpm <= 0) {
    return calibratedCurve(minStartDuty);
  }
  const curve = CALIB_RPM_TARGETS.map(({ tempC, frac }) => ({
    tempC,
    duty: dutyForRpmFraction(cal.points, frac, minStartDuty, cal.maxRpm),
  }));
  // Enforce a non-decreasing duty profile: the inversion is monotonic in theory,
  // but measurement noise at adjacent RPM targets could invert two neighbours.
  for (let i = 1; i < curve.length; i++) {
    if (curve[i].duty < curve[i - 1].duty) curve[i].duty = curve[i - 1].duty;
  }
  return curve;
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
    // Coalesce so profiles saved before these fields existed still ramp
    // instantly (100 = Immediate = today's behavior).
    spinUpPct: c.spinUpPct ?? 100,
    spinDownPct: c.spinDownPct ?? 100,
  }));
}

interface FanProfileState {
  configs: Record<string, FanConfig>;
  applyOnStartup: boolean;
  /** Custom display names per control id (e.g. "CPU", "水泵"). UI-only; not sent
   *  to the backend engine. */
  labels: Record<string, string>;
  /** Control ids that have reported RPM > 0 at least once (PERSISTED), so a real
   *  fan stays listed across relaunches even while idle/stopped, while empty
   *  headers (which never spin) stay hidden. */
  spunFans: string[];
  /** Record control ids seen spinning (rpm > 0). Persisted + idempotent. */
  markSpun: (ids: string[]) => void;
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
  /** Undo AI calibration / custom tweaks: reset every channel to the built-in
   *  DEFAULT_CURVE (curve mode, default floor) and push to the engine. */
  resetToDefault: (channelIds: string[], defaultTempSourceId: string | null) => void;
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
      spunFans: [],
      applyOnStartup: false,
      lastError: null,
      clearError: () => set({ lastError: null }),
      markSpun: (ids) =>
        set((s) => {
          const next = new Set(s.spunFans);
          let changed = false;
          for (const id of ids) if (!next.has(id)) { next.add(id); changed = true; }
          return changed ? { spunFans: [...next] } : {};
        }),
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
            // Map each curve node to a fraction of the fan's MEASURED max RPM
            // (real airflow) and invert it through the sweep's duty→RPM samples,
            // so "mid curve" means mid airflow — not a high duty that the fan's
            // (possibly under-reported / non-linear) RPM lags far behind.
            curve: calibratedCurveFromPoints(cal, lo),
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
      resetToDefault: (channelIds, defaultTempSourceId) => {
        const cur = get().configs;
        const configs = { ...cur };
        for (const id of channelIds) {
          const prev = cur[id] ?? defaultConfig();
          configs[id] = {
            ...prev,
            mode: "curve",
            curve: DEFAULT_CURVE.map((p) => ({ ...p })),
            minDuty: MIN_SAFE_DUTY,
            tempSourceId: prev.tempSourceId ?? defaultTempSourceId,
          };
        }
        // Reverting to the stock curve isn't a named preset / calibration.
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
