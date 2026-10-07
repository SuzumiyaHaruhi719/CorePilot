// Typed surface over the Rust IPC. Every command name / arg shape here mirrors
// a `#[tauri::command]` in src-tauri; Tauri maps camelCase keys to snake_case.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// ---------------------------------------------------------------- types
export interface LogicalCpu { id: number; group: number; coreId: number; ccdId: number; isVcache: boolean; efficiencyClass: number; smtSibling: number | null }
export interface Ccd { ccdId: number; isVcache: boolean; l3Bytes: number; logicalCpus: number[]; mask: string; kind: "vcache" | "freq" | "standard" | "pcore" | "ecore"; label: string }
export interface Topology { logicalCount: number; physicalCores: number; smt: boolean; hybrid: boolean; ccds: Ccd[]; logical: LogicalCpu[]; vcacheCcd: number | null; detection: string }
export interface Overview { cpuName: string; physicalCores: number; logicalCpus: number; ramTotal: number; os: string; vcacheCcd: number | null; detection: string }
export interface Metrics { cpuOverall: number; perCore: number[]; memUsed: number; memTotal: number }
export interface CpuSensor { name: string; kind: string; value: number | null }
export interface Sensors {
  gpuPct: number | null; gpuName: string | null; vramUsed: number | null; vramTotal: number | null
  diskPct: number | null; diskRead: number | null; diskWrite: number | null; netUp: number | null; netDown: number | null
  cpuPower: number | null; gpuPower: number | null; cpuTemp: number | null; gpuTemp: number | null; cpuClock: number | null
}
export interface Proc {
  pid: number; name: string; cpu: number; mem: number; threads: number; gpu: number; gpuMem: number | null; power: number
  affinity: string; user: string | null; handles: number; cpuTime: number; platform: string | null; gpuEngine: string | null
  gpuAdapter: string | null; description: string | null; settable: boolean; parentPid: number; exePath: string | null
}
export interface MemDetail { total: number; avail: number; used: number; loadPct: number }
export interface CleanResult { bytes: number; files: number }
export interface Service { name: string; display: string; status: "running" | "stopped" | "paused" | "other"; startType: string; pid: number; description: string; group: string }
export interface StartupItem { name: string; command: string; location: "hkcu_run" | "hklm_run" | "startup_folder"; enabled: boolean }
export interface NetCheck { id: string; label: string; ok: boolean; detail: string }
export interface Volume { scanId: string; root: string; letter: string; label: string; fileSystem: string; driveType: string; total: number; free: number; supported: boolean }
export interface TreeNode { id: number; parent: number; name: string; logicalSize: number; allocSize: number; fileCount: number; flags: number; hasMore: boolean; path: string | null }
export interface TreeView { scanId: string; generation: number; focusPath: string; nodes: TreeNode[]; truncated: boolean }
export interface ItemRow { path: string; name: string; logicalSize: number; allocSize: number; fileCount: number; flags: number }
export interface ScanProgress {
  scanId: string; root: string; status: "scanning" | "done" | "cancelled" | "error"; filesSeen: number; dirsSeen: number
  bytesAlloc: number; bytesLogical: number; skipped: number; nodeCount: number; generation: number; truncated: boolean
  disconnected: boolean; currentPath: string; elapsedMs: number; error: string | null
}
export const FLAG = { DIR: 1, REPARSE: 2, DENIED: 4, HIDDEN: 8, SYSTEM: 16, HARDLINK: 32, AGGREGATED: 64 } as const

export interface GpuInfo {
  available: boolean; name: string; driverVersion: string; graphicsClock: number; memClock: number; smClock: number; temperature: number
  powerUsageW: number; powerLimitW: number; powerLimitMinW: number; powerLimitMaxW: number; fanSpeedPct: number
  utilizationGpu: number; utilizationMem: number; memUsedBytes: number; memTotalBytes: number; maxGraphicsClockMhz: number
  tempLimitC: number; tempLimitMinC: number; tempLimitMaxC: number
  supportsPowerLimit: boolean; supportsLockedClocks: boolean; supportsFanControl: boolean; supportsTempLimit: boolean; supportsClockOffset: boolean
  coreOffsetMinMhz: number; coreOffsetMaxMhz: number; memOffsetMinMhz: number; memOffsetMaxMhz: number
}
export interface GpuOc {
  powerLimitW?: number | null; coreClockMinMhz?: number | null; coreClockMaxMhz?: number | null; memClockMinMhz?: number | null
  memClockMaxMhz?: number | null; fanSpeedPct?: number | null; tempLimitC?: number | null; coreOffsetMhz?: number | null; memOffsetMhz?: number | null
}
export interface GpuGuard { blocked: boolean; reason: "" | "unclean_shutdown" | "display_driver_fault" | "recent_fault"; detail: string }
export interface SmuStatus { pawnIo: boolean; loaded: boolean; version: number; versionStr: string; lastReply: string | null; lastReplyOk: boolean; supported?: boolean; unsupportedReason?: string | null }
/** SMU writes resolve after the SMU answered (≤3 s). Older backends returned a bare bool. */
export type SmuReply = { ok: boolean; detail: string } | boolean

export interface FanChannel { id: string; name: string; hw: string; pct: number | null; controllable: boolean; rpm: number | null; rpmName: string | null }
export interface FanTemp { id: string; name: string; c: number | null }
export interface FanState { available: boolean; supported: boolean; channels: FanChannel[]; temps: FanTemp[]; dirtyHeaders?: string[] }
export interface CurvePoint { tempC: number; duty: number }
export type FanMode = "auto" | "manual" | "curve"
export interface FanConfig {
  controlId: string; mode: FanMode; manualPct: number; tempSourceId: string | null; curve: CurvePoint[]
  minDuty: number; spinUpPct: number; spinDownPct: number; tempSourceId2: string | null; curve2: CurvePoint[]
}
export interface FanCalibration { controlId: string; name: string; minStartDuty: number; maxRpm: number; saturationDuty: number; points: { duty: number; rpm: number }[]; disconnected: boolean }
export interface CalibProgress { controlId: string; name: string; fanIndex: number; fanTotal: number; duty: number; rpm: number | null }
export interface TuneParams {
  targetTempC: number; targetGpuTempC: number; quietFloorPct: number; noiseCeilPct: number
  groups: Record<string, "cpu" | "case">; reuseCalibration?: FanCalibration[] | null; allowBackgroundLoad: boolean
}
export interface TuneProgress {
  phase: string; step: number; stepTotal: number; cpuTemp: number | null; cpuPower: number | null; gpuTemp: number | null
  gpuPower: number | null; wCpu: number | null; wCase: number | null; etaS: number | null; note: string | null
}
export interface TunedCurve { controlId: string; group: "cpu" | "case"; curve: CurvePoint[]; curve2: CurvePoint[]; minDuty: number; spinUpPct: number; spinDownPct: number }
export interface TuneWarning { kind: string; messageZh: string; messageEn: string; achievableC: number | null }
// Model blobs round-trip opaquely (resynth / passive learning take them back).
export type Opaque = Record<string, unknown>
export interface TuneResult {
  params: TuneParams; calibrations: FanCalibration[]; baseline: { tIdle: number; pIdle: number; tGpuIdle: number | null; pGpuIdle: number | null }
  model: Opaque; modelGpu: Opaque | null; pDesign: number; pDesignGpu: number | null
  effectiveTarget: number; effectiveTargetGpu: number | null; curves: TunedCurve[]; cpuSourceId: string | null; gpuSourceId: string | null
  validation: { tV: number; iterations: number; oscillationFixed: boolean; converged: boolean; combinedTCpu: number | null; combinedTGpu: number | null }
  warnings: TuneWarning[]; finishedAtMs: number
  [k: string]: unknown
}
export interface TuneAbort { phase: string; reasonZh: string; reasonEn: string }
export interface PassiveStatus { enabled: boolean; cpuSamples: number; gpuSamples: number; accumulatedCpuC: number; accumulatedGpuC: number }
export interface PassiveAdjustment { axis: "cpu" | "gpu"; deltaC: number; medianResidualC: number; curves: TunedCurve[] }

export interface FpsStats { fps: number | null; frametimeMs: number | null; low1: number | null; low01: number | null }
export interface Foreground { exe: string | null; pid: number; isGame: boolean }
export interface GameEntry { name: string; path: string; source: string }
export interface OverlayStatus {
  target: { pid: number; api: string; anticheat: boolean; blockedBy: string | null; game: boolean; exe: string | null; allowed: boolean; native: boolean; injectable: boolean }
  mode: "inject" | "window" | "none"; reason: string; reasonZh: string; reasonEn: string; attached: boolean
}
export interface PerfSample {
  t: number; fps: number | null; frametimeMs: number | null; cpuLoad: number | null; cpuTemp: number | null; cpuPower: number | null
  cpuClock: number | null; gpuLoad: number | null; gpuTemp: number | null; gpuPower: number | null; gpuClock: number | null
  vramLoad: number | null; memLoad: number | null; gpuFan: number | null; diskRead: number | null; diskWrite: number | null
  netDown: number | null; netUp: number | null; [k: string]: number | null
}
export interface PerfSummary {
  avgFps: number | null; minFps: number | null; maxFps: number | null; low1: number | null; low01: number | null; avgFrametimeMs: number | null
  avgCpuLoad: number | null; avgCpuTemp: number | null; maxCpuTemp: number | null; avgCpuPower: number | null; maxCpuPower: number | null
  avgCpuClock: number | null; avgGpuLoad: number | null; avgGpuTemp: number | null; maxGpuTemp: number | null; avgGpuPower: number | null
  maxGpuPower: number | null; avgGpuClock: number | null; avgVramLoad: number | null; maxVramLoad: number | null; avgMemLoad: number | null
  energyWh: number | null; co2Kg: number | null
}
export interface SessionMeta { exe: string; path: string | null; startedAt: number; endedAt: number; durationSec: number; cpuName: string | null; gpuName: string | null }
export interface Session { id: string; meta: SessionMeta; summary: PerfSummary; samples: PerfSample[] }

export interface UpdateInfo {
  available: boolean; currentVersion: string; latestVersion: string | null; notes: string | null; pubDate: string | null
  flavor: "installer" | "portable"; gameForeground: boolean; blockers: { id: string; severity: "block" | "warn"; message: string }[]; releasesUrl: string
}

export interface TbConfig {
  enabled: boolean; singleLine: boolean; barPosition: "left" | "right"; offset: number; customLayout: boolean; size: number; bold: boolean
  itemSpace: number; innerSpace: number; padding: number; colorsEnabled: boolean; bg: string; label: string; safe: string; warn: string; crit: string
  themeFps: string; themeCpu: string; themeGpu: string; themeMem: string; themeDisk: string; themeNet: string
  warnLoad: number; critLoad: number; warnTemp: number; critTemp: number; metrics: string[]
}

// ---------------------------------------------------------------- commands
const call = <T,>(cmd: string, args?: Record<string, unknown>) => invoke<T>(cmd, args)

export const api = {
  topology: () => call<Topology>("get_topology"),
  overview: () => call<Overview>("get_overview"),
  metrics: () => call<Metrics>("get_metrics"),
  sensors: () => call<Sensors>("get_sensors"),
  cpuSensors: () => call<CpuSensor[]>("cpu_sensors"),
  processes: () => call<Proc[]>("list_processes"),
  processIcon: (exePath: string) => call<string | null>("process_icon", { exePath }),
  gpuEngineLoads: () => call<Record<string, number>>("gpu_engine_loads"),
  setAffinity: (pid: number, mask: bigint) => call<void>("set_affinity", { pid, mask: mask.toString() }),
  setPriority: (pid: number, cls: number) => call<void>("set_priority", { pid, class: cls }),
  endTask: (pid: number) => call<void>("end_task", { pid }),
  restartTask: (pid: number) => call<void>("restart_task", { pid }),
  reveal: (path: string) => call<void>("reveal_in_explorer", { path }),

  memory: () => call<MemDetail>("get_memory_detail"),
  freeWorkingSets: () => call<void>("free_working_sets"),
  purgeStandby: () => call<void>("purge_standby"),
  cleanTemp: () => call<CleanResult>("clean_temp"),
  flushDns: () => call<void>("flush_dns"),
  powerPlan: () => call<"balanced" | "high" | "other">("get_power_plan"),
  setPowerPlan: (plan: "balanced" | "high") => call<void>("set_power_plan", { plan }),
  services: () => call<Service[]>("list_services"),
  controlService: (name: string, action: "start" | "stop" | "restart") => call<void>("control_service", { name, action }),
  startup: () => call<StartupItem[]>("list_startup"),
  setStartup: (name: string, location: string, enabled: boolean) => call<void>("set_startup_enabled", { name, location, enabled }),
  netDiagnose: (en: boolean) => call<NetCheck[]>("network_diagnose", { en }),
  netRepair: (actions: string[], en: boolean) => call<NetCheck[]>("network_repair", { actions, en }),
  tweakApply: (id: string) => call<string>("tweak_apply", { id }),
  tweakRevert: (id: string, snapshot: string) => call<void>("tweak_revert", { id, snapshot }),
  restorePoint: () => call<void>("create_restore_point"),

  volumes: () => call<Volume[]>("disk_list_volumes"),
  scanStart: (scanIds: string[]) => call<string[]>("disk_scan_start", { scanIds }),
  scanCancel: (scanId: string) => call<void>("disk_scan_cancel", { scanId }),
  scanStatus: (scanId: string) => call<ScanProgress>("disk_scan_status", { scanId }),
  diskTree: (scanId: string, focusPath: string | null, o: { depthLimit?: number; minBytes?: number; maxNodes?: number } = {}) =>
    call<TreeView>("disk_tree", { scanId, focusPath, ...o }),
  diskTop: (scanId: string, focusPath: string | null, n = 40) => call<ItemRow[]>("disk_top_items", { scanId, focusPath, n }),
  startupDirective: () => call<string | null>("startup_directive"),

  gpuInfo: () => call<GpuInfo>("gpu_oc_info"),
  gpuApply: (settings: GpuOc) => call<void>("gpu_oc_apply", { settings }),
  gpuReset: () => call<void>("gpu_oc_reset"),
  gpuGuard: () => call<GpuGuard>("gpu_oc_startup_check"),
  smuStatus: () => call<SmuStatus>("smu_status"),
  smuCo: (ccd: number, core: number, margin: number) => call<SmuReply>("smu_apply_co", { ccd, core, margin }),
  smuCoAll: (margin: number) => call<SmuReply>("smu_apply_co_all", { margin }),
  smuLimit: (kind: "ppt" | "tdc" | "edc", value: number) => call<SmuReply>("smu_apply_limit", { kind, value }),
  smuScalar: (scalar: number) => call<SmuReply>("smu_set_scalar", { scalar }),
  smuStock: () => call<SmuReply>("smu_force_stock"),

  fanInfo: () => call<FanState>("fan_info"),
  fanSetConfig: (configs: FanConfig[]) => call<void>("fan_set_config", { configs }),
  fanCalibrate: (controlIds: string[]) => call<FanCalibration[]>("fan_calibrate", { controlIds }),
  tuneStart: (params: TuneParams) => call<TuneResult>("fan_autotune_start", { params }),
  tuneAbort: () => call<boolean>("fan_autotune_abort"),
  tuneResynth: (req: { params: TuneParams; model: Opaque; modelGpu: Opaque | null; calibrations: FanCalibration[]; pDesign: number; pDesignGpu: number | null }) =>
    call<{ curves: TunedCurve[]; effectiveTarget: number; effectiveTargetGpu: number | null; warnings: TuneWarning[] }>("fan_autotune_resynth", { req }),
  passiveConfigure: (config: Opaque | null) => call<void>("fan_passive_configure", { config }),
  passiveStatus: () => call<PassiveStatus>("fan_passive_status"),

  fps: () => call<FpsStats>("osd_fps_stats"),
  foreground: () => call<Foreground>("foreground_info"),
  pidAlive: (pid: number) => call<boolean>("pid_alive", { pid }),
  games: () => call<GameEntry[]>("game_library_list"),
  pickExe: () => call<string[]>("pick_exe_files"),
  overlayStatus: (pid: number | null = null) => call<OverlayStatus>("overlay_status", { pid }),
  /** Backend owns injection: it injects only detected, allow-listed, native 64-bit, anti-cheat-free games. */
  overlayConfig: (enabled: boolean, allow: string[], layoutFlags: number) => call<void>("overlay_config", { enabled, allow, layoutFlags }),
  overlayPalette: (rowColors: number[]) => call<void>("overlay_set_palette", { rowColors }),
  osdBounds: (x: number, y: number, w: number, h: number) => call<void>("osd_set_bounds", { x, y, w, h }),
  osdMonitor: () => call<[number, number, number, number] | null>("osd_target_monitor"),
  osdHeartbeat: () => call<void>("osd_heartbeat"),
  recorderConfig: (enabled: boolean, white: string[], black: string[], osdWhite: string[]) =>
    call<void>("perf_recorder_config", { enabled, white, black, osdWhite }),
  tbmonConfig: (c: TbConfig) => call<void>("tbmon_config", { ...c }),

  persistGet: (name: string) => call<unknown>("persist_get", { name }),
  persistSet: (name: string, value: unknown) => call<void>("persist_set", { name, value }),
  sessionSave: (id: string, json: string) => call<void>("perf_session_save", { id, json }),
  sessionLoad: (id: string) => call<string | null>("perf_session_load", { id }),
  sessionDelete: (id: string) => call<void>("perf_session_delete", { id }),
  sessionDeleteAll: () => call<void>("perf_session_delete_all"),
  sessionIds: () => call<string[]>("perf_session_ids"),

  closeToTray: (enabled: boolean) => call<void>("set_close_to_tray", { enabled }),
  occluded: () => call<boolean>("ui_occluded"),
  opacity: (percent: number) => call<void>("set_window_opacity", { percent }),
  autostart: () => call<boolean>("get_autostart"),
  setAutostart: (enable: boolean) => call<void>("set_autostart", { enable }),
  updateCheck: () => call<UpdateInfo>("update_check"),
  updateInstall: () => call<void>("update_install"),
  exportLogs: (folderName: string) => call<string>("export_debug_logs", { folderName }),
}

// ---------------------------------------------------------------- events
export interface Events {
  "disk-scan://progress": ScanProgress
  "perf://session": Omit<Session, "id">
  "fan-calib-progress": CalibProgress
  "fan-autotune-progress": TuneProgress
  "fan-autotune-aborted": TuneAbort
  "fan-autotune-passive": PassiveAdjustment
  "update://state": { phase: string; error?: string }
  "update://progress": { downloaded: number; total: number | null }
  "app://focus": boolean
}
export function on<K extends keyof Events>(ev: K, fn: (p: Events[K]) => void): Promise<UnlistenFn> {
  return listen<Events[K]>(ev, (e) => fn(e.payload))
}

export const PRIORITY = { idle: 0x40, below: 0x4000, normal: 0x20, above: 0x8000, high: 0x80 } as const
// Overlay row bits (crates/corepilot-osd-ipc `show`), in palette row order.
export const OSD_ROWS = ["fps", "frametime", "cpu", "gpu", "vram", "ram", "disk", "net"] as const
export type OsdRow = (typeof OSD_ROWS)[number]
export const osdFlags = (rows: Record<string, boolean>) => OSD_ROWS.reduce((f, r, i) => (rows[r] ? f | (1 << i) : f), 0)
