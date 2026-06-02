import { invoke } from "@tauri-apps/api/core";

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
  getPowerPlan: () => invoke<string>("get_power_plan"),
  setPowerPlan: (plan: string) => invoke<void>("set_power_plan", { plan }),
  listServices: () => invoke<ServiceItem[]>("list_services"),
  controlService: (name: string, action: "start" | "stop" | "restart") =>
    invoke<void>("control_service", { name, action }),
  listStartup: () => invoke<StartupItem[]>("list_startup"),
  setStartupEnabled: (name: string, location: string, enabled: boolean) =>
    invoke<void>("set_startup_enabled", { name, location, enabled }),
  gpuOcInfo: () => invoke<GpuOcInfo>("gpu_oc_info"),
  gpuOcApply: (settings: GpuOcSettings) => invoke<void>("gpu_oc_apply", { settings }),
  gpuOcReset: () => invoke<void>("gpu_oc_reset"),
  osdSetVisible: (visible: boolean) => invoke<void>("osd_set_visible", { visible }),
  osdFps: () => invoke<number | null>("osd_fps"),
  osdFpsStats: () => invoke<OsdFpsStats>("osd_fps_stats"),
  foregroundProcess: () => invoke<string | null>("foreground_process"),
  setCloseToTray: (enabled: boolean) => invoke<void>("set_close_to_tray", { enabled }),
};

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
