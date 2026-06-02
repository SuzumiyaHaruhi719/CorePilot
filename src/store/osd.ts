import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { tauriStorage } from "../lib/persist";

export type OsdStyle = "horizontal" | "vertical";
export type OsdPosition = "tl" | "tr" | "bl" | "br";

/** OSD overlay configuration. Persisted and shared between the config panel
 *  (main window) and the overlay window via the tauri-store backed `persist`. */
export interface OsdConfig {
  enabled: boolean;
  style: OsdStyle;
  /** Font scale multiplier (0.8–2.0). */
  scale: number;
  /** Panel background opacity (0 = no plate, 1 = solid). */
  opacity: number;
  position: OsdPosition;
  /** Rounded-corner plate. */
  rounded: boolean;
  /** Enabled metric keys (see OSD_METRICS), in display order. */
  metrics: string[];
}

interface OsdStore extends OsdConfig {
  setEnabled: (enabled: boolean) => void;
  update: (patch: Partial<OsdConfig>) => void;
  toggleMetric: (key: string) => void;
}

/** How the per-game list is interpreted. */
export type OsdMode = "whitelist" | "all";

/** Which list a game sits on. `white` = explicitly shown (whitelist mode) or
 *  just listed (all mode); `black` = explicitly suppressed (all mode). */
export type OsdListKind = "white" | "black";

/** A per-process OSD rule. `config` optionally overrides the *global* default
 *  appearance/metrics for this game; `undefined` (or absent) = inherit global. */
export interface OsdTarget {
  /** Lowercased executable name, e.g. "cyberpunk2077.exe". */
  name: string;
  list: OsdListKind;
  /** Partial per-game override of the global OsdConfig; undefined = use default. */
  config?: Partial<OsdConfig>;
}

const DEFAULT_METRICS = [
  "cpu.util",
  "cpu.temp",
  "gpu.util",
  "gpu.temp",
  "gpu.power",
  "mem.util",
];

export const useOsd = create<OsdStore>()(
  persist(
    (set) => ({
      enabled: false,
      style: "horizontal",
      scale: 1,
      opacity: 0.55,
      position: "tl",
      rounded: true,
      metrics: DEFAULT_METRICS,
      setEnabled: (enabled) => set({ enabled }),
      update: (patch) => set(patch),
      toggleMetric: (key) =>
        set((s) => ({
          metrics: s.metrics.includes(key)
            ? s.metrics.filter((k) => k !== key)
            : [...s.metrics, key],
        })),
    }),
    { name: "corepilot-osd", version: 1, storage: createJSONStorage(() => tauriStorage) },
  ),
);

/** Appearance/metric fields of an OsdConfig (everything except `enabled`, which
 *  is the master switch and never part of a per-game override). */
export type OsdAppearance = Omit<OsdConfig, "enabled">;

interface OsdTargetsStore {
  /** whitelist = show only for listed games; all = show for everything except
   *  blacklisted games. */
  mode: OsdMode;
  targets: OsdTarget[];
  setMode: (mode: OsdMode) => void;
  /** Add a game by exe name (no-op if already present). New entries default to
   *  the white list with no per-game override (inherit global). */
  addTarget: (name: string, list?: OsdListKind) => void;
  removeTarget: (name: string) => void;
  setTargetList: (name: string, list: OsdListKind) => void;
  /** Merge `patch` into a target's per-game config override. Passing
   *  `undefined` clears the override entirely ("use default"). */
  updateTargetConfig: (name: string, patch: Partial<OsdConfig> | undefined) => void;
}

/** Normalize an exe name the way both the backend and Task-Manager rows produce
 *  it (trimmed + lowercased) so matches are case-insensitive. */
function normName(name: string): string {
  return name.trim().toLowerCase();
}

export const useOsdTargets = create<OsdTargetsStore>()(
  persist(
    (set) => ({
      mode: "all",
      targets: [],
      setMode: (mode) => set({ mode }),
      addTarget: (name, list = "white") =>
        set((s) => {
          const n = normName(name);
          if (!n || s.targets.some((t) => t.name === n)) return s;
          return { targets: [...s.targets, { name: n, list }] };
        }),
      removeTarget: (name) =>
        set((s) => ({ targets: s.targets.filter((t) => t.name !== normName(name)) })),
      setTargetList: (name, list) =>
        set((s) => ({
          targets: s.targets.map((t) => (t.name === normName(name) ? { ...t, list } : t)),
        })),
      updateTargetConfig: (name, patch) =>
        set((s) => ({
          targets: s.targets.map((t) => {
            if (t.name !== normName(name)) return t;
            if (patch === undefined) {
              // Clear the override (revert to global default).
              const { config: _drop, ...rest } = t;
              void _drop;
              return rest;
            }
            return { ...t, config: { ...t.config, ...patch } };
          }),
        })),
    }),
    { name: "corepilot-osd-targets", version: 1, storage: createJSONStorage(() => tauriStorage) },
  ),
);

/** The effective config for a target: the global default with the target's
 *  per-game override merged on top (override wins; `enabled` always comes from
 *  the global master switch). */
export function effectiveConfig(global: OsdConfig, override?: Partial<OsdConfig>): OsdConfig {
  if (!override) return global;
  return { ...global, ...override, enabled: global.enabled };
}

/**
 * Decide whether the OSD should render for the given foreground exe, and with
 * what config.
 *
 * - whitelist mode: show **iff** a `white` entry matches → its effective config.
 * - all mode: show for everything **unless** a `black` entry matches → hide.
 *
 * Returns the effective `OsdConfig` to render, or `null` to hide. `exe` of
 * `null`/empty (no foreground app resolvable) always hides.
 */
export function resolveOsd(
  global: OsdConfig,
  mode: OsdMode,
  targets: OsdTarget[],
  exe: string | null,
): OsdConfig | null {
  const n = exe ? normName(exe) : "";
  const match = n ? targets.find((t) => t.name === n) : undefined;
  if (mode === "whitelist") {
    if (match && match.list === "white") return effectiveConfig(global, match.config);
    return null;
  }
  // "all": show everywhere, except an explicit blacklist match.
  if (match && match.list === "black") return null;
  return effectiveConfig(global, match?.config);
}
