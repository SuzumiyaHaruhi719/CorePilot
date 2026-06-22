import { invoke } from "@tauri-apps/api/core";
import type { PerfSample } from "./perf";

/** Reject a promise if it hasn't settled within `ms`, so a hung backend invoke
 *  can never permanently latch a poller's in-flight guard (which would make a
 *  reading disappear forever). Clears its timer when the wrapped promise settles. */
export function withTimeout<T>(p: Promise<T>, ms = 6000): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((_, reject) => {
    t = setTimeout(() => reject(new Error("invoke timeout")), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t)) as Promise<T>;
}

export interface Overview {
  cpuName: string;
  physicalCores: number;
  logicalCpus: number;
  ramTotal: number;
  os: string;
  vcacheCcd: number | null;
  detection: string;
}

export interface LogicalCpu {
  id: number;
  group: number;
  coreId: number;
  ccdId: number;
  isVcache: boolean;
  /** Windows efficiency class (higher = more performant); 0 on homogeneous CPUs. */
  efficiencyClass: number;
  smtSibling: number | null;
}

export interface Ccd {
  ccdId: number;
  isVcache: boolean;
  l3Bytes: number;
  logicalCpus: number[];
  /** Affinity mask over logical CPUs. `bigint` so all 64 bits are exact; the
   *  backend sends it as a decimal string (see `serde_u64`). */
  mask: bigint;
  /** Cluster nature: "vcache" | "freq" | "standard" | "pcore" | "ecore". */
  kind: string;
  /** Display label, e.g. "3D V-Cache", "频率核心", "CCD", "性能核", "能效核". */
  label: string;
}

export interface CpuTopology {
  logicalCount: number;
  physicalCores: number;
  smt: boolean;
  /** True when clusters were split by efficiency class (Intel P/E hybrid). */
  hybrid: boolean;
  ccds: Ccd[];
  logical: LogicalCpu[];
  vcacheCcd: number | null;
  detection: string;
}

export interface ProcInfo {
  pid: number;
  name: string;
  cpu: number;
  mem: number;
  threads: number;
  gpu: number;
  /** Per-process GPU memory (VRAM) in bytes, or null/absent when unavailable. */
  gpuMem?: number | null;
  power: number;
  /** CPU affinity mask (allowed logical CPUs); 0 if inaccessible. `bigint` so
   *  all 64 bits are exact; the backend sends it as a decimal string. */
  affinity: bigint;
  /** Process owner account (e.g. "SYSTEM", "Thomas"). */
  user?: string | null;
  /** Open handle count. */
  handles?: number;
  /** Total CPU time in seconds (kernel + user). */
  cpuTime?: number;
  /** "64位" | "32位". */
  platform?: string | null;
  /** Dominant GPU engine for this process, e.g. "3D" / "Video Encode" / "Compute". */
  gpuEngine?: string | null;
  /** Which GPU adapter the process is using, e.g. "NVIDIA GeForce RTX 4090". */
  gpuAdapter?: string | null;
  /** Friendly file description (e.g. "Google Chrome") — the name Task Manager shows. */
  description?: string | null;
  /** Whether the process's CPU affinity can be set (false for protected/system processes). */
  settable?: boolean;
  /** Parent process PID (0 when unresolved). Used to collapse children under their app. */
  parentPid?: number;
  /** Full path to the executable (e.g. "C:\\…\\chrome.exe"); used for the per-exe icon. */
  exePath?: string | null;
  /**
   * Synthetic placeholder for a group member that has been added but is not
   * currently running. Front-end only — never sent by the backend. Such rows
   * have no real pid (a stable negative id) and no live metrics.
   */
  offline?: boolean;
}

export interface Metrics {
  cpuOverall: number;
  perCore: number[];
  memUsed: number;
  memTotal: number;
}

export interface AffinityInfo {
  /** Process affinity mask. `bigint`; arrives from the backend as a decimal string. */
  procMask: bigint;
  /** System affinity mask. `bigint`; arrives from the backend as a decimal string. */
  sysMask: bigint;
}

export interface MemDetail {
  total: number;
  avail: number;
  used: number;
  loadPct: number;
}

export interface CleanResult {
  bytes: number;
  files: number;
}

/** One deep SMU/CPU sensor (per-core clock, CCD temp, VDDCR/SoC voltage, package
 *  power, TDC/EDC, …). `kind` is the LHM SensorType. Read-only telemetry. */
export interface CpuSensor {
  name: string;
  kind: string;
  value: number | null;
}

export interface Sensors {
  gpuPct: number | null;
  gpuName: string | null;
  vramUsed: number | null;
  vramTotal: number | null;
  diskPct: number | null;
  diskRead: number | null;
  diskWrite: number | null;
  netUp: number | null;
  netDown: number | null;
  cpuPower: number | null;
  gpuPower: number | null;
  cpuTemp: number | null;
  gpuTemp: number | null;
  /** Live CPU clock in MHz (base × % processor performance); null if unavailable. */
  cpuClock: number | null;
  /** Deep SMU/CPU sensors (per-core clocks, CCD temps, voltages, TDC/EDC…); empty
   *  if no hardware-sensor driver (PawnIO) is available. */
  cpuSensors: CpuSensor[];
}

export interface GpuOcInfo {
  available: boolean;
  name: string;
  driverVersion: string;
  graphicsClock: number;
  memClock: number;
  smClock: number;
  temperature: number;
  powerUsageW: number;
  powerLimitW: number;
  powerLimitMinW: number;
  powerLimitMaxW: number;
  fanSpeedPct: number;
  utilizationGpu: number;
  utilizationMem: number;
  memUsedBytes: number;
  memTotalBytes: number;
  maxGraphicsClockMhz: number;
  tempLimitC: number;
  tempLimitMinC: number;
  tempLimitMaxC: number;
  supportsPowerLimit: boolean;
  supportsLockedClocks: boolean;
  supportsFanControl: boolean;
  supportsTempLimit: boolean;
  /** NVAPI clock-offset overclocking available (Afterburner-style +/- MHz). */
  supportsClockOffset: boolean;
  coreOffsetMinMhz: number;
  coreOffsetMaxMhz: number;
  memOffsetMinMhz: number;
  memOffsetMaxMhz: number;
}

export interface GpuOcSettings {
  powerLimitW?: number;
  coreClockMinMhz?: number;
  coreClockMaxMhz?: number;
  memClockMinMhz?: number;
  memClockMaxMhz?: number;
  fanSpeedPct?: number;
  tempLimitC?: number;
  /** Core clock offset in MHz (NVAPI). */
  coreOffsetMhz?: number;
  /** Memory clock offset in MHz (NVAPI). */
  memOffsetMhz?: number;
}

/** One controllable fan header (a Super-I/O fan-control channel) + its RPM. */
export interface FanChannel {
  id: string;
  name: string;
  /** Owning hardware, e.g. "Nuvoton NCT6798D". */
  hw: string;
  /** Current duty %, or null when unread. */
  pct: number | null;
  /** True when this header accepts software PWM writes on this board. */
  controllable: boolean;
  /** Best-matched fan RPM, or null. */
  rpm: number | null;
  rpmName: string | null;
}

/** A temperature sensor usable as a fan-curve source. */
export interface FanTempSource {
  id: string;
  name: string;
  c: number | null;
}

/** Live motherboard fan state. */
export interface FanInfo {
  /** The sidecar produced fan/control data at least once. */
  available: boolean;
  /** At least one header is software-controllable on this board. */
  supported: boolean;
  channels: FanChannel[];
  temps: FanTempSource[];
}

export type FanMode = "auto" | "manual" | "curve";

/** One point of a fan curve: at `tempC` °C, run at `duty` %. */
export interface FanCurvePoint {
  tempC: number;
  duty: number;
}

/** Per-fan configuration pushed to the backend engine. */
export interface FanChannelConfig {
  controlId: string;
  mode: FanMode;
  manualPct?: number;
  tempSourceId?: string | null;
  curve?: FanCurvePoint[];
  minDuty?: number;
  /** Curve-mode ramp-up smoothing: 0 = Smooth, 100 = Immediate (instant). */
  spinUpPct?: number;
  /** Curve-mode ramp-down smoothing: 0 = Smooth, 100 = Immediate (instant). */
  spinDownPct?: number;
  /** Optional SECOND temp source + curve (GPU assist); duty = max(curve, curve2). */
  tempSourceId2?: string | null;
  curve2?: FanCurvePoint[];
}

/** One measured (duty %, RPM) sample from an AI calibration sweep. */
export interface CalibPoint {
  duty: number;
  rpm: number;
}

/** Per-fan AI-calibration result (FanXpert-style auto tuning). */
export interface FanCalibration {
  controlId: string;
  name: string;
  /** Lowest duty at which the fan reliably spins (its quietest stable speed). */
  minStartDuty: number;
  maxRpm: number;
  /** Lowest duty whose RPM already reaches ~97% of max. */
  saturationDuty: number;
  points: CalibPoint[];
  /** True when the header never produced any RPM during the sweep. */
  disconnected: boolean;
}

/** Live progress event (`fan-calib-progress`) emitted after each sweep step. */
export interface FanCalibProgress {
  controlId: string;
  name: string;
  fanIndex: number;
  fanTotal: number;
  duty: number;
  rpm: number | null;
}

// --- fan auto-tune (spec: docs/superpowers/specs/2026-06-10-fan-autotune-design.md) ---

export type FanGroup = "cpu" | "case";

export interface AutoTuneParams {
  targetTempC: number;
  targetGpuTempC: number;
  quietFloorPct: number;
  noiseCeilPct: number;
  groups: Record<string, FanGroup>;
  reuseCalibration?: FanCalibration[] | null;
  /** Settings toggle: tune even with background load (precheck warns instead of aborting). */
  allowBackgroundLoad?: boolean;
}

export interface ThermalModel {
  alpha: number;
  tOff: number;
  rInf: number;
  kC: number;
  kX: number;
  rmse: number;
  conservativeShift: number;
}

export interface GpuModel {
  tOffG: number;
  rG: number;
  kG: number;
  rmse: number;
  conservativeShift: number;
}

export interface TuneWarning {
  kind: string;
  messageZh: string;
  messageEn: string;
  achievableC?: number | null;
}

export interface WPoint {
  tempC: number;
  wCpu: number;
  wCase: number;
}

export interface TunedFanCurve {
  controlId: string;
  group: FanGroup;
  curve: FanCurvePoint[];
  curve2: FanCurvePoint[];
  minDuty: number;
  spinUpPct: number;
  spinDownPct: number;
}

export interface AutoTuneProgress {
  phase: string;
  step: number;
  stepTotal: number;
  cpuTemp?: number | null;
  cpuPower?: number | null;
  gpuTemp?: number | null;
  gpuPower?: number | null;
  wCpu?: number | null;
  wCase?: number | null;
  etaS?: number | null;
  note?: string | null;
}

export interface TuneGridPoint {
  wCpu: number;
  wCase: number;
  tSs: number;
  pAvg: number;
  saturated: boolean;
  skipped: boolean;
}

export interface TuneGpuGridPoint {
  wCase: number;
  tGpuSs: number;
  pGpuAvg: number;
  tCpu: number;
}

export interface TuneBaseline {
  tIdle: number;
  pIdle: number;
  tGpuIdle?: number | null;
  pGpuIdle?: number | null;
}

export interface TuneValidation {
  tV: number;
  iterations: number;
  oscillationFixed: boolean;
  converged: boolean;
  combinedTCpu?: number | null;
  combinedTGpu?: number | null;
}

export interface AutoTuneResult {
  params: AutoTuneParams;
  calibrations: FanCalibration[];
  baseline: TuneBaseline;
  grid: TuneGridPoint[];
  gpuGrid: TuneGpuGridPoint[];
  model: ThermalModel;
  modelGpu?: GpuModel | null;
  pDesign: number;
  pDesignGpu?: number | null;
  effectiveTarget: number;
  effectiveTargetGpu?: number | null;
  gpuCpuCouplingC?: number | null;
  wPoints: WPoint[];
  gpuWPoints?: [number, number][] | null;
  curves: TunedFanCurve[];
  cpuSourceId?: string | null;
  gpuSourceId?: string | null;
  validation: TuneValidation;
  warnings: TuneWarning[];
  finishedAtMs: number;
}

export interface ResynthRequest {
  params: AutoTuneParams;
  model: ThermalModel;
  modelGpu?: GpuModel | null;
  calibrations: FanCalibration[];
  pDesign: number;
  pDesignGpu?: number | null;
}

export interface ResynthResponse {
  curves: TunedFanCurve[];
  wPoints: WPoint[];
  gpuWPoints?: [number, number][] | null;
  effectiveTarget: number;
  effectiveTargetGpu?: number | null;
  warnings: TuneWarning[];
}

export interface PassiveConfig {
  enabled: boolean;
  params: AutoTuneParams;
  model: ThermalModel;
  modelGpu?: GpuModel | null;
  calibrations: FanCalibration[];
  pDesign: number;
  pDesignGpu?: number | null;
}

export interface PassiveStatus {
  enabled: boolean;
  cpuSamples: number;
  gpuSamples: number;
  accumulatedCpuC: number;
  accumulatedGpuC: number;
}

/** Payload of the `fan-autotune-passive` event. */
export interface PassiveAdjustment {
  axis: "cpu" | "gpu";
  deltaC: number;
  medianResidualC: number;
  curves: TunedFanCurve[];
}

/** Payload of the `fan-autotune-aborted` event. */
export interface AutoTuneAbortInfo {
  phase: string;
  reasonZh: string;
  reasonEn: string;
}

export interface ServiceItem {
  name: string;
  display: string;
  status: string;
  startType: string;
  pid?: number;
  description?: string;
  group?: string;
}

export interface StartupItem {
  name: string;
  command: string;
  location: string;
  enabled: boolean;
}

/** Result of a single network diagnostic or repair step. */
export interface NetCheck {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

/** Windows priority classes. */
export const PRIORITY = {
  idle: 0x40,
  belowNormal: 0x4000,
  normal: 0x20,
  aboveNormal: 0x8000,
  high: 0x80,
  realtime: 0x100,
} as const;

/**
 * Raw wire shapes: u64 affinity masks cross the IPC boundary as decimal strings
 * (a JS number can't hold > 2^53 exactly). The `api` layer parses those strings
 * into `bigint` so the rest of the app never sees the string form.
 */
type RawCcd = Omit<Ccd, "mask"> & { mask: string };
type RawCpuTopology = Omit<CpuTopology, "ccds"> & { ccds: RawCcd[] };
type RawProcInfo = Omit<ProcInfo, "affinity"> & { affinity: string };
interface RawAffinityInfo {
  procMask: string;
  sysMask: string;
}

/** SMU tuning status from the sidecar (Curve Optimizer / PBO write host). */
export interface SmuStatus {
  /** PawnIO ring-0 driver installed on the machine. */
  pawnIo: boolean;
  /** RyzenSMU module loaded → SMU writes possible. */
  loaded: boolean;
  version: number;
  versionStr: string;
  /** Detail text of the last apply reply (error/success). */
  lastReply: string | null;
  lastReplyOk: boolean;
}

export const api = {
  getOverview: () => invoke<Overview>("get_overview"),
  getTopology: async (): Promise<CpuTopology> => {
    const raw = await invoke<RawCpuTopology>("get_topology");
    return {
      ...raw,
      ccds: raw.ccds.map((ccd) => ({ ...ccd, mask: BigInt(ccd.mask) })),
    };
  },
  listProcesses: async (): Promise<ProcInfo[]> => {
    const raw = await invoke<RawProcInfo[]>("list_processes");
    return raw.map((p) => ({ ...p, affinity: BigInt(p.affinity) }));
  },
  processIcon: (exePath: string) => invoke<string | null>("process_icon", { exePath }),
  /** Open a native .exe file picker; returns chosen files' lowercased base names. */
  pickExeFiles: () => invoke<string[]>("pick_exe_files"),
  gpuEngines: () => invoke<Record<string, number>>("gpu_engine_loads"),
  getMetrics: () => invoke<Metrics>("get_metrics"),
  setAffinity: (pid: number, mask: bigint) =>
    invoke<void>("set_affinity", { pid, mask: mask.toString() }),
  getProcessAffinity: async (pid: number): Promise<AffinityInfo> => {
    const raw = await invoke<RawAffinityInfo>("get_process_affinity", { pid });
    return { procMask: BigInt(raw.procMask), sysMask: BigInt(raw.sysMask) };
  },
  setPriority: (pid: number, priorityClass: number) =>
    invoke<void>("set_priority", { pid, class: priorityClass }),
  getMemoryDetail: () => invoke<MemDetail>("get_memory_detail"),
  freeWorkingSets: () => invoke<void>("free_working_sets"),
  purgeStandby: () => invoke<void>("purge_standby"),
  cleanTemp: () => invoke<CleanResult>("clean_temp"),
  flushDns: () => invoke<void>("flush_dns"),
  endTask: (pid: number) => invoke<void>("end_task", { pid }),
  getSensors: () => invoke<Sensors>("get_sensors"),
  // SMU tuning (Curve Optimizer / PBO) — forwarded to the sensord sidecar.
  smuStatus: () => invoke<SmuStatus>("smu_status"),
  smuApplyCo: (ccd: number, core: number, margin: number) =>
    invoke<boolean>("smu_apply_co", { ccd, core, margin }),
  smuApplyCoAll: (margin: number) => invoke<boolean>("smu_apply_co_all", { margin }),
  smuApplyLimit: (kind: "ppt" | "tdc" | "edc", value: number) =>
    invoke<boolean>("smu_apply_limit", { kind, value }),
  smuSetScalar: (scalar: number) => invoke<boolean>("smu_set_scalar", { scalar }),
  /** Explicit "force stock": all-core CO = 0 (overrides BIOS for this boot). */
  smuForceStock: () => invoke<boolean>("smu_force_stock"),
  /** Reveal a file in Windows Explorer (open its folder + select it). */
  revealInExplorer: (path: string) => invoke<void>("reveal_in_explorer", { path }),
  /** Dump the full session log to Downloads/<folderName>/; returns the folder path. */
  exportDebugLogs: (folderName: string) => invoke<string>("export_debug_logs", { folderName }),
  getPowerPlan: () => invoke<string>("get_power_plan"),
  setPowerPlan: (plan: string) => invoke<void>("set_power_plan", { plan }),
  listServices: () => invoke<ServiceItem[]>("list_services"),
  controlService: (name: string, action: "start" | "stop" | "restart") =>
    invoke<void>("control_service", { name, action }),
  listStartup: () => invoke<StartupItem[]>("list_startup"),
  setStartupEnabled: (name: string, location: string, enabled: boolean) =>
    invoke<void>("set_startup_enabled", { name, location, enabled }),
  networkDiagnose: (en: boolean) => invoke<NetCheck[]>("network_diagnose", { en }),
  networkRepair: (actions: string[], en: boolean) => invoke<NetCheck[]>("network_repair", { actions, en }),
  gpuOcInfo: () => invoke<GpuOcInfo>("gpu_oc_info"),
  gpuOcApply: (settings: GpuOcSettings) => invoke<void>("gpu_oc_apply", { settings }),
  gpuOcReset: () => invoke<void>("gpu_oc_reset"),
  /** Live motherboard fan headers + temperature sources. */
  fanInfo: () => invoke<FanInfo>("fan_info"),
  /** Push the per-fan configuration (mode/curve) to the backend fan engine. */
  fanSetConfig: (configs: FanChannelConfig[]) => invoke<void>("fan_set_config", { configs }),
  /** AI-calibrate the given controllable headers (or all when empty): sweep PWM,
   *  measure RPM, and return each fan's start/stop/saturation envelope. Emits
   *  `fan-calib-progress` events during the (multi-second) sweep. */
  fanCalibrate: (controlIds: string[]) => invoke<FanCalibration[]>("fan_calibrate", { controlIds }),
  /** Run the closed-loop auto-tune: measure this machine's thermal response under
   *  built-in load and synthesize per-fan curves. Emits `fan-autotune-progress`. */
  fanAutotuneStart: (params: AutoTuneParams) => invoke<AutoTuneResult>("fan_autotune_start", { params }),
  fanAutotuneAbort: () => invoke<boolean>("fan_autotune_abort"),
  fanAutotuneResynth: (req: ResynthRequest) => invoke<ResynthResponse>("fan_autotune_resynth", { req }),
  fanPassiveConfigure: (config: PassiveConfig | null) => invoke<void>("fan_passive_configure", { config }),
  fanPassiveStatus: () => invoke<PassiveStatus>("fan_passive_status"),
  /** Apply a reversible system optimization tweak by id (深度优化). Returns a JSON
   *  snapshot of the pre-apply state; persist it and pass it back to `tweakRevert`
   *  to restore the EXACT prior values (empty string when nothing was captured). */
  tweakApply: (id: string) => invoke<string>("tweak_apply", { id }),
  /** Revert an optimization tweak. Pass the `snapshot` returned by `tweakApply` to
   *  restore the exact prior state; an empty/missing snapshot reverts to Windows'
   *  documented default. */
  tweakRevert: (id: string, snapshot: string) =>
    invoke<void>("tweak_revert", { id, snapshot }),
  /** Create a System Restore point before applying tweaks. */
  createRestorePoint: () => invoke<void>("create_restore_point"),
  osdSetVisible: (visible: boolean) => invoke<void>("osd_set_visible", { visible }),
  osdSetBounds: (x: number, y: number, w: number, h: number) =>
    invoke<void>("osd_set_bounds", { x, y, w, h }),
  /** Logical bounds [x,y,w,h] of the monitor the foreground game is on (null when
   *  unresolved), so the overlay can follow the game across monitors. */
  osdTargetMonitor: () =>
    invoke<[number, number, number, number] | null>("osd_target_monitor"),
  osdFps: () => invoke<number | null>("osd_fps"),
  osdFpsStats: () => invoke<OsdFpsStats>("osd_fps_stats"),
  foregroundProcess: () => invoke<string | null>("foreground_process"),
  foregroundInfo: () => invoke<ForegroundInfo>("foreground_info"),
  pidAlive: (pid: number) => invoke<boolean>("pid_alive", { pid }),
  /** Installed games discovered from Steam / Epic / GOG (read-only display). */
  gameLibraryList: () => invoke<GameEntry[]>("game_library_list"),
  /** Attach the in-game (injection) overlay to `pid` — or, when the target is
   *  anti-cheat-protected / unsupported, transparently fall back to the window
   *  overlay. `layoutFlags` is the `show::*` bitfield of metric rows to draw. */
  overlayAttach: (pid: number, layoutFlags?: number) =>
    invoke<OverlayStatus>("overlay_attach", { pid, layoutFlags }),
  /** Detach (eject) the injected overlay from `pid`; idempotent. */
  overlayDetach: (pid: number) => invoke<void>("overlay_detach", { pid }),
  /** Overlay status for `pid`, or the foreground game when omitted. */
  overlayStatus: (pid?: number) => invoke<OverlayStatus>("overlay_status", { pid: pid ?? null }),
  /** AUTO mode: backend auto-injects the foreground game (resident) and shows the
   *  OSD only while it's the active window (hidden on alt-tab, ejected on exit). */
  overlaySetAuto: (enable: boolean, layoutFlags?: number) =>
    invoke<void>("overlay_set_auto", { enable, layoutFlags }),
  /** Push the per-theme OSD row-color palette (8 packed 0xRRGGBBAA entries, in IPC
   *  row order) to the injected-overlay writer so the in-game overlay matches the
   *  active theme. Safe no-op when injection isn't active. */
  overlaySetPalette: (rowColors: number[]) =>
    invoke<void>("overlay_set_palette", { rowColors }),
  /**
   * Push perf-recorder config to the backend recorder thread (which does the
   * actual sampling). Called on mount and whenever the relevant stores change.
   * `white`/`black` are the record white/black list exe names; `osdWhite` is the
   * OSD whitelist (also force-records, for back-compat). All lowercased.
   */
  perfRecorderConfig: (cfg: {
    enabled: boolean;
    white: string[];
    black: string[];
    osdWhite: string[];
  }) =>
    invoke<void>("perf_recorder_config", {
      enabled: cfg.enabled,
      white: cfg.white,
      black: cfg.black,
      osdWhite: cfg.osdWhite,
    }),
  setCloseToTray: (enabled: boolean) => invoke<void>("set_close_to_tray", { enabled }),
  /** Apply/clear the Windows 11 acrylic window backdrop on the main window. */
  setAcrylic: (enabled: boolean) => invoke<void>("set_acrylic", { enabled }),
  /** Set whole-window opacity (30–100%). Auto-applied on change + persisted. */
  setWindowOpacity: (percent: number) => invoke<void>("set_window_opacity", { percent }),
  /** Whether "开机自启动" is on (a logon scheduled task exists). */
  getAutostart: () => invoke<boolean>("get_autostart"),
  /** Enable/disable launching CorePilot elevated at Windows logon (scheduled task,
   *  no UAC prompt). Source of truth is the OS task, not a persisted setting. */
  setAutostart: (enable: boolean) => invoke<void>("set_autostart", { enable }),
};

/**
 * Payload of the backend `perf://session` event (emitted when a recorded game
 * exits). Mirrors the Rust `SessionPayload` (camelCase). `samples` are the full
 * (pre-downsample) `PerfSample` series; the frontend summarizes + downsamples
 * them when building the persisted `PerfSession`.
 */
export interface PerfSessionEvent {
  exe: string;
  /** Full exe path (report path display + history-card icon), or null. */
  path: string | null;
  startedAt: number;
  endedAt: number;
  durationSec: number;
  cpuName: string | null;
  gpuName: string | null;
  samples: PerfSample[];
}

/** Frame-pacing stats for the in-game OSD, derived from the ETW present stream.
 *  All fields are null when FPS data is unavailable (no game / no privilege). */
export interface OsdFpsStats {
  fps: number | null;
  frametimeMs: number | null;
  /** 1% low FPS (reciprocal of the 99th-percentile frame time). */
  low1: number | null;
  /** 0.1% low FPS (reciprocal of the 99.9th-percentile frame time). */
  low01: number | null;
}

/** Foreground app snapshot — game detection + the perf-session recorder. */
export interface ForegroundInfo {
  /** Lowercased exe name, or null when unresolved. */
  exe: string | null;
  /** Foreground PID (0 when none). */
  pid: number;
  /** True when the foreground app is rendering frames (has recent presents). */
  isGame: boolean;
}

/** One installed game discovered from a storefront library (Steam/Epic/GOG). */
export interface GameEntry {
  name: string;
  /** Install directory (lowercased) the detector prefix-matches EXE paths against. */
  path: string;
  /** "Steam" | "Epic" | "GOG". */
  source: string;
}

/** Graphics API detected for an overlay target (drives which Present is hooked).
 *  Lowercased to match the backend's serde rename. */
export type GraphicsApi = "dx12" | "dx11" | "dx10" | "dx9" | "vulkan" | "opengl" | "unknown";

/** A target process classified for the in-game (injection) overlay. */
export interface OverlayTarget {
  pid: number;
  api: GraphicsApi;
  /** True when a known anti-cheat module is loaded — injection is refused. */
  anticheat: boolean;
  /** True iff the API is hookable AND no anti-cheat is present. */
  injectable: boolean;
}

/** What the overlay does for a target:
 *  - `inject`: the in-frame DLL overlay (premium path);
 *  - `window`: the keep-alive window overlay (anti-cheat / unsupported API → safe);
 *  - `none`: no usable target (no foreground game). */
export type OverlayMode = "inject" | "window" | "none";

/** Overlay status for a target: classification, chosen mode, and a localised
 *  reason for the UI status line. */
export interface OverlayStatus {
  target: OverlayTarget;
  mode: OverlayMode;
  /** Localised explanation, e.g. "✅ 可注入（DX12）". */
  reason: string;
  /** Whether the injected overlay is currently attached to this exact PID. */
  attached: boolean;
}
