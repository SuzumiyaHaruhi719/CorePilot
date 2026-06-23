import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { tauriStorage } from "../lib/persist";
import type { OverlayStatus } from "../lib/ipc";

export type OsdStyle = "horizontal" | "vertical";
export type OsdPosition = "tl" | "tr" | "tc" | "bl" | "br" | "bc" | "free";

/** Which end of the taskbar's free area the monitor docks to. */
export type TbBarPosition = "left" | "right";

/** Default "taskbar monitor" Colors panel values. Matches LiteMonitor's
 *  light-theme palette (Background close to the system taskbar, green/amber/red
 *  value states) and the reference screenshot. Extracted so the create() initial
 *  state and the persist `migrate` backfill share one source of truth. */
export const TASKBAR_DEFAULTS = {
  tbColorsEnabled: false,
  tbBg: "#D2D2D2",
  tbLabel: "#141414",
  tbSafe: "#008040",
  tbWarn: "#B57500",
  tbCrit: "#C03030",
  tbWarnLoad: 60,
  tbCritLoad: 85,
  tbWarnTemp: 50,
  tbCritTemp: 70,
} as const;

/** The screenshot's default taskbar-monitor metric set: per-column pairs
 *  (CPU%/CPU°, CCLK/RAM, GPU%/GPU°, net↑/net↓) flowing into two rows. */
export const TBMON_METRICS = [
  "cpu.util",
  "cpu.temp",
  "cpu.freq",
  "mem.used",
  "gpu.util",
  "gpu.temp",
  "net.up",
  "net.down",
] as const;

/** Default settings for the INDEPENDENT taskbar monitor (the second overlay
 *  window). Separate from the OSD master switch / position: `tbEnabled` is the
 *  taskbar monitor's own on/off. Extracted so the create() initial state and the
 *  persist `migrate` backfill share one source of truth. */
export const TBMON_DEFAULTS = {
  /** Taskbar monitor master switch (NOT the OSD `enabled` flag). */
  tbEnabled: false,
  /** false = two rows (default — single row is too cramped); true = one row. */
  tbSingleLine: false,
  /** Which end of the bar's free area to dock to. */
  tbBarPosition: "left" as TbBarPosition,
  /** Horizontal offset (logical px) nudging the docked plate along the bar. */
  tbOffset: 0,
  /** Custom-layout master switch (size/bold/spacing below only apply when on). */
  tbCustomLayout: true,
  /** Font size (pt) of the cell text. */
  tbSize: 9,
  /** Bold cell text. */
  tbBold: true,
  /** Gap between cells / columns (px). */
  tbItemSpace: 6,
  /** Gap between a cell's label and its value (px). */
  tbInnerSpace: 8,
  /** Plate padding (px). */
  tbPadding: 2,
  /** Enabled metric keys for the taskbar monitor (its own list, in pair order). */
  tbMetrics: TBMON_METRICS as readonly string[] as string[],
} as const;

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

  // --- Taskbar monitor "Colors" panel (only used when position === "taskbar").
  // Optional so old persisted configs / sparse per-game overrides still type-check;
  // the persist `migrate` backfills the GLOBAL config and consumers default them. ---
  /** Master switch for the taskbar color skin. Off → the taskbar plate uses the
   *  normal glass/themed look (just docked on the bar). */
  tbColorsEnabled?: boolean;
  /** Solid plate background — set close to the system taskbar color to blend in. */
  tbBg?: string;
  /** Category-label text color. */
  tbLabel?: string;
  /** Value color in the safe (normal) state. */
  tbSafe?: string;
  /** Value color in the warn state (load ≥ tbWarnLoad / temp ≥ tbWarnTemp). */
  tbWarn?: string;
  /** Value color in the crit state (load ≥ tbCritLoad / temp ≥ tbCritTemp). */
  tbCrit?: string;
  /** Load-% warn / crit thresholds (CPU/GPU/mem/disk util, GPU fan). */
  tbWarnLoad?: number;
  tbCritLoad?: number;
  /** Temperature warn / crit thresholds (°C; CPU/GPU temp). */
  tbWarnTemp?: number;
  tbCritTemp?: number;

  // --- Taskbar monitor (the independent second overlay window). All optional so
  // old persisted configs type-check; the persist `migrate` backfills them. ---
  /** Taskbar monitor master switch — independent of the OSD `enabled` flag. */
  tbEnabled?: boolean;
  /** false = two rows (default); true = one cramped row. */
  tbSingleLine?: boolean;
  /** Dock to the left or right end of the bar's free area. */
  tbBarPosition?: TbBarPosition;
  /** Horizontal offset (logical px) along the bar. */
  tbOffset?: number;
  /** Custom-layout master switch (the size/spacing fields below only apply on). */
  tbCustomLayout?: boolean;
  /** Cell font size (pt). */
  tbSize?: number;
  /** Bold cell text. */
  tbBold?: boolean;
  /** Gap between cells / columns (px). */
  tbItemSpace?: number;
  /** Gap between a cell's label and its value (px). */
  tbInnerSpace?: number;
  /** Plate padding (px). */
  tbPadding?: number;
  /** The taskbar monitor's own enabled metric keys, in pair order. */
  tbMetrics?: string[];
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
      ...TASKBAR_DEFAULTS,
      ...TBMON_DEFAULTS,
      setEnabled: (enabled) => set({ enabled }),
      update: (patch) => set(patch),
      toggleMetric: (key) =>
        set((s) => ({
          metrics: s.metrics.includes(key)
            ? s.metrics.filter((k) => k !== key)
            : [...s.metrics, key],
        })),
    }),
    {
      name: "corepilot-osd",
      version: 3,
      storage: createJSONStorage(() => tauriStorage),
      // v1 → v2: backfill the taskbar "Colors" fields. v2 → v3: backfill the
      // independent taskbar-monitor settings (tbEnabled / two-row / layout).
      // Persisted values win where present.
      migrate: (persisted) => ({
        ...TASKBAR_DEFAULTS,
        ...TBMON_DEFAULTS,
        ...(persisted as Partial<OsdStore>),
      }),
    },
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
