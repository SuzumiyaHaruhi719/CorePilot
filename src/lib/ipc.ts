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

/**
 * One fixed/removable volume for the Disk Analyzer picker (Zone A). Mirrors the
 * Rust `disk_scan::VolumeInfo` (camelCase). `total`/`free` are bytes; the picker
 * derives `used = total - free`. `supported` false → greyed/disabled row.
 */
export interface VolumeInfo {
  /** Stable scan key — volume GUID path (`\\?\Volume{guid}\`) or the drive root. */
  scanId: string;
  /** Friendly display root, e.g. "C:\\". */
  root: string;
  /** Drive letter without separator, e.g. "C:". */
  letter: string;
  /** Volume label (may be empty). */
  label: string;
  /** File system, e.g. "NTFS" (may be empty). */
  fileSystem: string;
  /** "fixed" | "removable" | "remote" | "cdrom" | "ramdisk" | "unknown". */
  driveType: string;
  /** Total size in bytes (0 when unavailable). */
  total: number;
  /** Free bytes (0 when unavailable). */
  free: number;
  /** True when the volume can be scanned (has size info + a filesystem). */
  supported: boolean;
}

/**
 * Scalar progress for one disk scan. Mirrors the Rust `disk_scan::ScanProgress`
 * (camelCase) — the `disk-scan://progress` event payload AND the
 * `disk_scan_status` return. Never carries the tree (pulled via `disk_tree` in
 * Phase 2). `status`: "scanning" | "done" | "cancelled" | "error".
 */
export interface ScanProgress {
  scanId: string;
  root: string;
  status: "scanning" | "done" | "cancelled" | "error";
  filesSeen: number;
  dirsSeen: number;
  bytesAlloc: number;
  bytesLogical: number;
  skipped: number;
  nodeCount: number;
  /** Bumped on each published snapshot — the frontend pulls a tree on a new gen. */
  generation: number;
  /** True once the node cap stopped descent (truncation banner). */
  truncated: boolean;
  /** True when a sustained I/O-error streak tripped the drive-disconnect
   *  transition (spec §2.5.5 / §7) — the UI shows a dedicated disconnect surface. */
  disconnected: boolean;
  /** The directory currently being walked (display path; empty when idle/done).
   *  Surfaced in the progress chip so a slow (e.g. antivirus-throttled) scan looks
   *  visibly working rather than hung (spec §7). */
  currentPath: string;
  elapsedMs: number;
  error: string | null;
}

/**
 * One node of a bounded `disk_tree` LOD slice. Mirrors the Rust
 * `disk_scan::TreeNode` (camelCase). Indices (`id`/`parent`) are LOCAL to the
 * slice (NOT arena NodeIds); `nodes[0]` is the focus root (`parent === id`).
 * Byte sizes are plain numbers (a disk can't hold > 2^53 bytes ≈ 9 PB), matching
 * the `ScanProgress` precedent. The Phase 3 treemap layout re-nests these via
 * `parent` + size-desc sibling order.
 */
export interface TreeNode {
  /** Local index within `TreeView.nodes` (0 === the focus root). */
  id: number;
  /** Local index of the parent within this slice (self for the focus root). */
  parent: number;
  /** Display name (path component or synthetic aggregate label). */
  name: string;
  logicalSize: number;
  allocSize: number;
  fileCount: number;
  /** Bit flags: IS_DIR(1) | REPARSE(2) | DENIED(4) | HIDDEN(8) | SYSTEM(16) | HARDLINK(32) | AGGREGATED(64). */
  flags: number;
  /** True when this directory has children the slice did not expand (LOD
   *  collapsed by depth/min-bytes/max-nodes) → render as a drillable container. */
  hasMore: boolean;
  /** Absolute path — present for the focus root + directory containers (so a
   *  drill can re-`diskTree` on it); null for ordinary leaves. */
  path: string | null;
}

/**
 * A bounded LOD slice of a scan tree for one focused container. Mirrors the Rust
 * `disk_scan::TreeView` (camelCase) — the workhorse the treemap pulls via
 * `diskTree`. The backend does the LOD slicing so a huge tree never crosses IPC
 * whole; re-pull on a new `generation` (from the progress event), and drill by
 * re-calling with a child's `path` as `focusPath`.
 */
export interface TreeView {
  scanId: string;
  /** Snapshot generation this slice came from (re-pull when it advances). */
  generation: number;
  /** Absolute path of the focus root (the disk root when `focusPath` was null). */
  focusPath: string;
  /** Flat slice nodes; `nodes[0]` is the focus root. */
  nodes: TreeNode[];
  /** True when LOD collapsed at least one subtree (some `hasMore` is set). */
  truncated: boolean;
}

/**
 * One row of the "what's eating my space" flat list (`diskTopItems`). Mirrors the
 * Rust `disk_scan::ItemRow` (camelCase). Top-N largest items in the focused
 * (sub)tree by allocation size.
 */
export interface ItemRow {
  /** Absolute path of the item. */
  path: string;
  /** Leaf/aggregate name (last path component). */
  name: string;
  logicalSize: number;
  allocSize: number;
  fileCount: number;
  flags: number;
}

/** Disk-Analyzer node flag bits (mirror `disk_scan.rs` FLAG_* constants). */
export const DISK_FLAG = {
  isDir: 1 << 0,
  reparse: 1 << 1,
  denied: 1 << 2,
  hidden: 1 << 3,
  system: 1 << 4,
  hardlink: 1 << 5,
  aggregated: 1 << 6,
} as const;

export const api = {
  getOverview: () => invoke<Overview>("get_overview"),
  /** Enumerate fixed + removable volumes for the Disk Analyzer picker (Zone A). */
  diskListVolumes: () => invoke<VolumeInfo[]>("disk_list_volumes"),
  /** Start scanning each disk on its own dedicated thread; returns the keys. O(1). */
  diskScanStart: (scanIds: string[]) => invoke<string[]>("disk_scan_start", { scanIds }),
  /** Flip the per-disk cancel atomic; the walk drains promptly. O(1). */
  diskScanCancel: (scanId: string) => invoke<void>("disk_scan_cancel", { scanId }),
  /** Cold read of a scan's progress atomics (the event is the live channel). O(1). */
  diskScanStatus: (scanId: string) => invoke<ScanProgress>("disk_scan_status", { scanId }),
  /**
   * Pull a bounded LOD slice of a scan's published tree (the treemap workhorse).
   * Backend clones the snapshot `Arc` + slices it off the IPC thread, so a huge
   * tree never crosses whole. `focusPath` null/empty → the disk root; pass a
   * child's `path` to drill. `depthLimit`/`minBytes`/`maxNodes` are the LOD knobs
   * (omit to use backend defaults: depth 4, all sizes, 4096 nodes).
   */
  diskTree: (
    scanId: string,
    focusPath?: string | null,
    opts?: { depthLimit?: number; minBytes?: number; maxNodes?: number },
  ) =>
    invoke<TreeView>("disk_tree", {
      scanId,
      focusPath: focusPath ?? null,
      depthLimit: opts?.depthLimit ?? null,
      minBytes: opts?.minBytes ?? null,
      maxNodes: opts?.maxNodes ?? null,
    }),
  /** Top-N largest items in the focused (sub)tree by alloc size (the "what's
   *  eating my space" flat list). `focusPath` null → whole disk; `n` defaults to 20. */
  diskTopItems: (scanId: string, focusPath?: string | null, n?: number) =>
    invoke<ItemRow[]>("disk_top_items", { scanId, focusPath: focusPath ?? null, n: n ?? null }),
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
