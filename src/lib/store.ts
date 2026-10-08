// App state. Two persisted stores (settings, profiles) go through the backend's
// crash-safe persist.rs via persist_get/persist_set; `useLive` is volatile.
// Rule: never bump a `version` here without adding a `migrate`.
import { create } from "zustand"
import { persist, createJSONStorage, type StateStorage } from "zustand/middleware"
import { api, logUi, type CurvePoint, type FanCalibration, type JobCfg, type FanConfig, type Foreground, type FpsStats, type GpuOc, type Metrics, type Overview, type Sensors, type TbConfig, type Topology, type TuneResult } from "./ipc"
import type { OsdPosition } from "./osd"
import type { Glow, ThemeStyle } from "./themes"

// ------------------------------------------------------------ storage adapter
// A key whose READ failed (persist_get rejected: store unreadable) is never
// written this session — hydrating defaults and saving them would overwrite
// real data. null still means "absent".
const unreadable = new Set<string>()
// Coalesce to the latest value per key (250 ms trailing — slider drags), then
// chain writes per key: persist_set crosses a non-FIFO mutex backend-side, so
// two in-flight sets of one key could land out of order.
const pending = new Map<string, { value: string; timer: ReturnType<typeof setTimeout> }>()
const tails = new Map<string, Promise<unknown>>()
function flush(name: string) {
  const p = pending.get(name)
  if (!p) return
  clearTimeout(p.timer)
  pending.delete(name)
  const next = (tails.get(name) ?? Promise.resolve()).then(() => api.persistSet(name, p.value)).catch(console.error)
  tails.set(name, next)
}
addEventListener("pagehide", () => [...pending.keys()].forEach(flush))
export const backend: StateStorage = {
  getItem: async (name) => {
    let v: unknown
    try {
      v = await api.persistGet(name)
    } catch (e) {
      unreadable.add(name)
      toast("err", tf("设置存储读取失败，本次修改不会保存", "Settings store unreadable — changes won't be saved this session"), String(e))
      return null // in-memory defaults only; never persisted (see setItem)
    }
    return v == null ? null : typeof v === "string" ? v : JSON.stringify(v)
  },
  setItem: (name, value) => {
    if (unreadable.has(name)) return
    clearTimeout(pending.get(name)?.timer)
    pending.set(name, { value, timer: setTimeout(() => flush(name), 250) })
  },
  removeItem: () => {},
}
const storage = createJSONStorage(() => backend)

// ------------------------------------------------------------ settings
export type Lang = "zh" | "en"
export type OsdMode = "off" | "window" | "inject"
export interface OsdConfig {
  mode: OsdMode
  layout: "row" | "column"
  position: OsdPosition
  metrics: string[]
  scale: number
  /** plate background opacity 0..1 (0 = text only) */
  bg: number
  rounded: boolean
  autoGames: boolean
  targets: string[]
  hotkey: string
  injectAllow: string[]
}
export interface Settings {
  lang: Lang
  style: ThemeStyle
  glow: Glow
  reduceMotion: boolean
  /** honour Windows "animation effects" off (prefers-reduced-motion); off by default */
  followSystemMotion: boolean
  opacity: number
  closeToTray: boolean
  osd: OsdConfig
  recorder: { enabled: boolean; white: string[]; black: string[] }
  taskbar: TbConfig
  /** the taskbar plate was reset once for the redrawn (calm, two-row) layout */
  tbV3: boolean
  /** telemetry poll interval (ms); every live chart glides in step with it */
  pollMs: number
  /** "low": no glow, blur or motion — barely touches the GPU; "auto": low while a game is in front */
  gpuMode: "full" | "low" | "auto"
  /** frosted-glass panels over the backdrop */
  glass: boolean
  /** keep sampling while the window is hidden, so charts are full when it comes back */
  bgRecord: boolean
  /** raise the window onto a game's report when the game closes */
  autoShowReport: boolean
  /** Windows notification when a game report is ready */
  gameNotify: boolean
  /** unlocks CPU Curve Optimizer / PBO (live SMU writes) */
  amdTuning: boolean
  /** auto-tune wizard default: allow background load */
  tuneAllowBusy: boolean
  autoCheckUpdates: boolean
  /** devices listed in 进程 → 性能 */
  perfDevices: Record<PerfDevice, boolean>
  /** optional 进程 table columns shown */
  procCols: ProcCol[]
  /** the Overview board: widget instances in order (pages/widgets.tsx) */
  widgets: WidgetInst[]
  /** 定时任务: pushed to the backend scheduler (automation.rs), which clamps intervals */
  automation: JobCfg[]
}
export type WidgetSize = "s" | "m" | "l" | "w"
export interface WidgetInst { id: string; type: string; size: WidgetSize; opt?: string }
export type PerfDevice = "cpu" | "mem" | "gpu" | "disk" | "net" | "power"
export const PROC_COLS = ["pid", "cpu", "mem", "gpu", "engine", "vram", "power", "threads", "handles", "cpuTime", "platform", "user"] as const
export type ProcCol = (typeof PROC_COLS)[number]
export const TB_METRICS = ["cpu.util", "cpu.temp", "cpu.freq", "cpu.power", "mem.used", "mem.util", "gpu.util", "gpu.temp", "gpu.power", "gpu.fan", "gpu.vramPct", "gpu.vramUsed", "gpu.coreClock", "gpu.memClock", "disk.util", "disk.read", "disk.write", "net.up", "net.down"] as const

const defaults: Settings = {
  lang: "zh",
  style: "midnight",
  glow: "medium",
  reduceMotion: false,
  followSystemMotion: false,
  opacity: 100,
  closeToTray: true,
  osd: {
    mode: "window", layout: "row", position: "tl", scale: 1, bg: 0.55, rounded: true, autoGames: true, targets: [], hotkey: "Alt+Shift+O", injectAllow: [],
    metrics: ["fps", "fps.low1", "cpu.util", "cpu.temp", "gpu.util", "gpu.temp", "mem.used"],
  },
  recorder: { enabled: true, white: [], black: [] },
  taskbar: {
    enabled: false, singleLine: false, barPosition: "right", offset: 0, customLayout: true, size: 9, bold: true,
    itemSpace: 22, innerSpace: 10, padding: 3, colorsEnabled: false, bg: "#0b0f16", label: "#8e8c88",
    safe: "#3ddc97", warn: "#f2c94c", crit: "#ff5468",
    // "" = follow the theme style's palette (resolved in boot.ts before the push)
    themeFps: "", themeCpu: "", themeGpu: "", themeMem: "", themeDisk: "", themeNet: "",
    warnLoad: 60, critLoad: 85, warnTemp: 70, critTemp: 85,
    metrics: ["cpu.util", "cpu.temp", "gpu.util", "gpu.temp", "mem.used", "mem.util", "net.up", "net.down"],
  },
  tbV3: false,
  pollMs: 1000,
  gpuMode: "full",
  glass: false,
  bgRecord: false,
  autoShowReport: true,
  gameNotify: true,
  amdTuning: false,
  tuneAllowBusy: false,
  autoCheckUpdates: true,
  perfDevices: { cpu: true, mem: true, gpu: true, disk: true, net: true, power: true },
  procCols: ["pid", "cpu", "mem", "gpu", "engine", "vram", "power", "threads", "user"],
  widgets: [
    { id: "vitals", type: "vitals", size: "w" }, { id: "oneclick", type: "oneclick", size: "w" },
    { id: "scope", type: "scope", size: "l" }, { id: "thermal", type: "thermal", size: "m" },
    { id: "ring-cpu", type: "ring", size: "m", opt: "cpu" }, { id: "ring-mem", type: "ring", size: "m", opt: "mem" }, { id: "clock", type: "clock", size: "m" },
    { id: "cores", type: "cores", size: "l" }, { id: "io", type: "io", size: "m" },
    { id: "quick", type: "quick", size: "w" },
  ],
  automation: [
    { id: "purge_standby", task: "purge_standby", enabled: false, everySecs: 1800, cond: true, freeMb: 1024, standbyMb: 1024, skipInGame: true },
    { id: "trim_ws", task: "trim_ws", enabled: false, everySecs: 1800, cond: false, freeMb: 1024, standbyMb: 0, skipInGame: true },
    { id: "clean_temp", task: "clean_temp", enabled: false, everySecs: 86400, cond: false, freeMb: 1024, standbyMb: 0, skipInGame: true },
    { id: "flush_dns", task: "flush_dns", enabled: false, everySecs: 3600, cond: false, freeMb: 1024, standbyMb: 0, skipInGame: true },
    { id: "leak_alert", task: "leak_alert", enabled: true, everySecs: 300, cond: false, freeMb: 1024, standbyMb: 0, skipInGame: false },
  ],
}

/** v1 → v2: theme+accent became style presets; the OSD became row/column with granular metrics. */
const ROW_TO_METRICS: Record<string, string[]> = { fps: ["fps", "fps.low1"], frametime: ["fps.frametime"], cpu: ["cpu.util", "cpu.temp"], gpu: ["gpu.util", "gpu.temp"], vram: ["gpu.vramUsed"], ram: ["mem.used"], disk: ["disk.read", "disk.write"], net: ["net.down", "net.up"] }
type Loose = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
/** Windows "animation effects" as Chromium reports it. */
export const sysReduce = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null
/** The one motion policy: in-app 减少动态效果, the system flag when opted in, or low-GPU mode. */
export const motionReduced = (s: Pick<Settings, "reduceMotion" | "followSystemMotion"> = useSettings.getState()) =>
  s.reduceMotion || (s.followSystemMotion && !!sysReduce?.matches) || useLive.getState().lowGpu

export function migrateSettings(old: unknown, version: number): Settings {
  const s: Loose = { ...(old as Loose) }
  if (version < 2) {
    s.style = s.theme === "light" ? "porcelain" : (({ ember: "graphite", mint: "terminal" } as Record<string, ThemeStyle>)[s.accent] ?? "midnight")
    s.glow = "medium"
    const o: Loose = s.osd ?? {}
    const rows: Record<string, boolean> = o.rows ?? {}
    const osd: Loose = {
      ...defaults.osd, ...o,
      layout: "row",
      position: (["tl", "tr", "bl", "br"] as OsdPosition[])[o.corner ?? 0] ?? "tl",
      metrics: Object.entries(rows).flatMap(([k, on]) => (on ? ROW_TO_METRICS[k] ?? [] : [])),
    }
    delete osd.rows
    delete osd.corner
    s.osd = osd
    // old taskbar colors were the previous fixed palette — let the theme drive them
    if (s.taskbar) Object.assign(s.taskbar, { themeFps: "", themeCpu: "", themeGpu: "", themeMem: "", themeDisk: "", themeNet: "" })
    delete s.theme
    delete s.accent
  }
  // v3: the taskbar plate got vertical device labels and roomier spacing — move
  // spacing still at the old defaults (14/6/2) to the new ones; custom values stay
  if (version < 3 && s.taskbar && s.taskbar.itemSpace === 14 && s.taskbar.innerSpace === 6 && s.taskbar.padding === 2) {
    Object.assign(s.taskbar, { itemSpace: defaults.taskbar.itemSpace, innerSpace: defaults.taskbar.innerSpace, padding: defaults.taskbar.padding })
  }
  return s as Settings
}

type Patch<T> = Partial<T> | ((s: T) => Partial<T>)
interface SettingsStore extends Settings { set: (p: Patch<Settings>) => void }
export const SETTINGS_KEY = "cp.settings"
export const mergeSettings = (st: Partial<Settings> | undefined): Settings =>
  ({ ...defaults, ...st, osd: { ...defaults.osd, ...st?.osd }, recorder: { ...defaults.recorder, ...st?.recorder }, taskbar: { ...defaults.taskbar, ...st?.taskbar } })
export const useSettings = create<SettingsStore>()(
  persist(
    (set) => ({ ...defaults, set: (p) => set(p as never) }),
    {
      name: SETTINGS_KEY, version: 3, storage, skipHydration: true, migrate: migrateSettings,
      partialize: ({ set: _s, ...rest }) => rest,
      // deep-merge one level so new nested keys get defaults on old data
      merge: (p, cur) => ({ ...cur, ...mergeSettings(p as Partial<Settings>) }),
    },
  ),
)
export const SETTINGS_DEFAULTS = defaults

// ------------------------------------------------------------ profiles
/** A CCD group: processes whose exe name is in `patterns` get `mask` + `priority`. */
export interface Group { id: string; name: string; hue: number; mask: string; priority: number | null; patterns: string[] }
export const groupColor = (hue: number) => `oklch(74% 0.16 ${hue})`
/** a saved whole-machine fan setup (风扇配置) */
export interface FanProfile { id: string; name: string; fans: Record<string, FanConfig> }
export interface Profiles {
  groups: Group[]
  /** apply groups automatically at launch (the master switch itself is session state) */
  optimizeOnStartup: boolean
  fans: Record<string, FanConfig>
  /** saved fan setups + which preset/profile is active (null = custom edits) */
  fanProfiles: FanProfile[]
  fanActive: string | null
  /** user names for fan headers */
  fanLabels: Record<string, string>
  /** headers that have ever reported RPM — the rest are empty and hidden by default */
  spun: string[]
  calibrations: FanCalibration[]
  tune: TuneResult | null
  passive: boolean
  gpu: { oc: GpuOc; onStartup: boolean }
  tweaks: Record<string, string>
  /** legacy "corepilot-*" data imported (lib/migrate.ts) */
  imported: boolean
  /** second legacy pass done: groups, theme style, glow, OSD layout */
  legacy2: boolean
  /** third legacy pass done: fan profiles, active preset, labels, spun headers */
  legacy3: boolean
  /** fourth legacy pass done: poll rate, GPU render, glass, recording/report/notify, AMD gate, update check, perf devices */
  legacy4?: boolean
  /** the user's own curves for the built-in fan presets (preset id → curve); absent = built-in */
  presetCurves?: Record<string, CurvePoint[]>
}
/** v1 → v2: flat per-exe rules become groups, bucketed by (mask, priority). */
export function migrateProfiles(old: unknown, version: number): Profiles {
  const p: Loose = { ...(old as Loose) }
  if (version < 2) {
    const rules = (p.rules ?? []) as { exe: string; mask: string | null; priority: number | null; on: boolean }[]
    const buckets = new Map<string, Group>()
    for (const r of rules) {
      const k = `${r.mask}|${r.priority}`
      if (!buckets.has(k)) buckets.set(k, { id: crypto.randomUUID(), name: `分组 ${buckets.size + 1}`, hue: (buckets.size * 97 + 182) % 360, mask: r.mask ?? "0", priority: r.priority, patterns: [] })
      buckets.get(k)!.patterns.push(r.exe)
    }
    p.groups = [...buckets.values()]
    p.optimizeOnStartup = rules.some((r) => r.on)
    p.legacy2 = false
    delete p.rules
  }
  return p as Profiles
}
interface ProfilesStore extends Profiles { set: (p: Patch<Profiles>) => void }
export const useProfiles = create<ProfilesStore>()(
  persist(
    (set) => ({ groups: [], optimizeOnStartup: false, fans: {}, fanProfiles: [], fanActive: null, fanLabels: {}, spun: [], legacy3: false, calibrations: [], tune: null, passive: false, gpu: { oc: {}, onStartup: false }, tweaks: {}, imported: false, legacy2: false, set: (p) => set(p as never) }),
    { name: "cp.profiles", version: 2, storage, skipHydration: true, migrate: migrateProfiles, partialize: ({ set: _s, ...rest }) => rest },
  ),
)

/** Load both persisted stores. They don't hydrate on import (skipHydration): main.tsx
 *  calls this once the IPC host is ready (in the browser preview: after the mock). */
export const hydrated = () => Promise.all([useSettings.persist.rehydrate(), useProfiles.persist.rehydrate()])

// ------------------------------------------------------------ live (volatile)
export type PageId = "overview" | "processes" | "cores" | "games" | "thermals" | "tuning" | "system" | "cron" | "disk" | "settings"
export const HIST = 120
export type Series = "cpu" | "gpu" | "mem" | "cpuT" | "gpuT" | "up" | "down" | "rd" | "wr" | "cpuW" | "gpuW" | "clk" | "vram" | "dsk" | "fps"
export type Mood = "calm" | "busy" | "game" | "hot"
export interface Toast { id: number; kind: "ok" | "warn" | "err" | "info"; title: string; body?: string }
interface Live {
  page: PageId
  visible: boolean
  topo: Topology | null
  overview: Overview | null
  metrics: Metrics | null
  sensors: Sensors | null
  hist: Record<Series, number[]>
  /** per logical CPU load history (same length cap as hist) — 进程 → 性能 mini charts */
  coreHist: number[][]
  /** the machine's state at a glance — tints the ambient light, drives the Overview greeting */
  mood: Mood
  tick: number
  openSession: string | null
  fg: Foreground | null
  fps: FpsStats | null
  procCount: number
  palette: boolean
  /** core-group master switch (session state; defaults to profiles.optimizeOnStartup) */
  coreOpt: boolean
  toasts: Toast[]
  /** low-GPU mode in effect right now (settings.gpuMode, "auto" follows the foreground game) */
  lowGpu: boolean
}
const empty = () => Object.fromEntries((["cpu", "gpu", "mem", "cpuT", "gpuT", "up", "down", "rd", "wr", "cpuW", "gpuW", "clk", "vram", "dsk", "fps"] as Series[]).map((k) => [k, []])) as unknown as Record<Series, number[]>
export const useLive = create<Live>()(() => ({
  page: "overview", visible: true, topo: null, overview: null, metrics: null, sensors: null,
  hist: empty(), coreHist: [], mood: "calm", tick: 0, openSession: null, fg: null, fps: null, procCount: 0, palette: false, coreOpt: false, toasts: [], lowGpu: false,
}))
export const go = (page: PageId) => useLive.setState({ page })

let toastId = 0
export function toast(kind: Toast["kind"], title: string, body?: string) {
  if (kind === "err") logUi("error", body ? `${title}: ${body}` : title)
  const id = ++toastId
  useLive.setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, title, body }] }))
  setTimeout(() => useLive.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === "err" ? 7000 : 4200)
}

// ------------------------------------------------------------ i18n
// Chinese-first: every user-visible string is t(zh, en).
export const tf = (zh: string, en: string) => (useSettings.getState().lang === "en" ? en : zh)
export function useT() {
  const lang = useSettings((s) => s.lang)
  return (zh: string, en: string) => (lang === "en" ? en : zh)
}
/** Run an IPC action with toast feedback. Returns the result or undefined. */
export async function act<T>(p: Promise<T>, ok?: string | ((v: T) => string)): Promise<T | undefined> {
  try {
    const v = await p
    if (ok) toast("ok", typeof ok === "function" ? ok(v) : ok)
    return v
  } catch (e) {
    toast("err", tf("操作失败", "Action failed"), String(e))
    return undefined
  }
}
