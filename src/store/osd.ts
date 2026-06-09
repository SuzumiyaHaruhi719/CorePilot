import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { tauriStorage } from "../lib/persist";
import type { OverlayStatus } from "../lib/ipc";

export type OsdStyle = "horizontal" | "vertical";
export type OsdPosition = "tl" | "tr" | "tc" | "bl" | "br" | "bc" | "free";

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
  /** Free-placement position (top-left, normalized 0..1); used when position === "free". */
  freeX: number;
  freeY: number;
  /** Rounded-corner plate. */
  rounded: boolean;
  /** OLED anti burn-in: slowly nudge the overlay's position over time. */
  oledShift: boolean;
  /** Desktop mode: also show the OSD when no game is in the foreground (on the
   *  desktop / regular apps); FPS metrics are hidden there (no game → no FPS). */
  desktopMode: boolean;
  /** In-game (injection) overlay master switch. Persisted so it survives tab
   *  switches; the attach/detach loop runs from the OSD config panel. */
  inject: boolean;
  /** AUTO inject mode: backend keeps the overlay DLL resident in the foreground
   *  game and shows the OSD only while that game is the active window (hidden on
   *  alt-tab, ejected on exit). Mutually exclusive with `inject` — auto wins. */
  autoInject: boolean;
  /** Enabled metric keys (see OSD_METRICS), in display order. */
  metrics: string[];
}

interface OsdStore extends OsdConfig {
  setEnabled: (enabled: boolean) => void;
  update: (patch: Partial<OsdConfig>) => void;
  toggleMetric: (key: string) => void;
}

/** Which list a game sits on, as an explicit override of game auto-detection.
 *  `white` = force SHOW (even if not detected as a game); `black` = force HIDE
 *  (never show, even if it is a game). */
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
  "fps",
  "fps.low1",
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
      freeX: 0.04,
      freeY: 0.04,
      rounded: true,
      oledShift: false,
      desktopMode: false,
      inject: false,
      autoInject: false,
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

/** Live in-game (injection) overlay status, published by the app-level
 *  `useOverlayInjection` driver and read by the OSD config panel's status line.
 *  Not persisted — it reflects the current foreground app's inject/window state. */
interface OverlayStatusStore {
  status: OverlayStatus | null;
  setStatus: (status: OverlayStatus | null) => void;
}

export const useOverlayStatus = create<OverlayStatusStore>((set) => ({
  status: null,
  setStatus: (status) => set({ status }),
}));

/** Appearance/metric fields of an OsdConfig (everything except `enabled`, which
 *  is the master switch and never part of a per-game override). */
export type OsdAppearance = Omit<OsdConfig, "enabled">;

interface OsdTargetsStore {
  targets: OsdTarget[];
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
      targets: [],
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
 * Decide whether the OSD should render for the given foreground app, and with
 * what config. Two independent layers:
 *
 *   1. The **in-game overlay** — shows on apps auto-detected as games when the
 *      master switch (`enabled`) is on. The per-app lists tune this layer:
 *        - whitelist → force SHOW (even if NOT detected as a game).
 *        - blacklist → suppress it (treat the app as "not a game to show on").
 *   2. The **desktop OSD** — a persistent overlay the user turned on
 *      (`desktopMode`). It shows on the desktop / regular (non-game) apps,
 *      INCLUDING blacklisted ones. Blacklisting an app must NOT tear the desktop
 *      OSD down when you alt-tab to it — the black list only governs the in-game
 *      layer (which matters when `desktopMode` is off). FPS is hidden here (no
 *      game → no FPS), handled by the caller.
 *
 * Returns the effective `OsdConfig` to render, or `null` to hide.
 */
export function resolveOsd(
  global: OsdConfig,
  targets: OsdTarget[],
  exe: string | null,
  isGame: boolean,
): OsdConfig | null {
  const n = exe ? normName(exe) : "";
  const match = n ? targets.find((t) => t.name === n) : undefined;
  // Whitelist: force SHOW for this app, even if it isn't detected as a game.
  if (match?.list === "white") return effectiveConfig(global, match.config);
  // A blacklisted app is treated as "not a game" so it never triggers the
  // in-game overlay — but the persistent desktop OSD (below) still applies.
  const blacked = match?.list === "black";
  if (!blacked && isGame) return global.enabled ? effectiveConfig(global, undefined) : null;
  // Non-game (or a blacklisted app treated as one): the desktop OSD shows iff
  // desktop mode is on. This is what keeps the desktop OSD alive when you switch
  // to a blacklisted app; with desktop mode off, a blacklist genuinely hides it.
  return global.desktopMode ? effectiveConfig(global, match?.config) : null;
}
