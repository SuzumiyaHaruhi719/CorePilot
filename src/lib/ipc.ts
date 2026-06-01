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
  smtSibling: number | null;
}

export interface Ccd {
  ccdId: number;
  isVcache: boolean;
  l3Bytes: number;
  logicalCpus: number[];
  mask: number;
}

export interface CpuTopology {
  logicalCount: number;
  physicalCores: number;
  smt: boolean;
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
  /** Dominant GPU engine for this process, e.g. "3D" / "Video Encode" / "Compute". */
  gpuEngine?: string | null;
  /** Which GPU adapter the process is using, e.g. "NVIDIA GeForce RTX 4090". */
  gpuAdapter?: string | null;
}

export interface Metrics {
  cpuOverall: number;
  perCore: number[];
  memUsed: number;
  memTotal: number;
}

export interface AffinityInfo {
  procMask: number;
  sysMask: number;
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
}

export interface ServiceItem {
  name: string;
  display: string;
  status: string;
  startType: string;
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

export const api = {
  getOverview: () => invoke<Overview>("get_overview"),
  getTopology: () => invoke<CpuTopology>("get_topology"),
  listProcesses: () => invoke<ProcInfo[]>("list_processes"),
  getMetrics: () => invoke<Metrics>("get_metrics"),
  setAffinity: (pid: number, mask: number) => invoke<void>("set_affinity", { pid, mask }),
  getProcessAffinity: (pid: number) =>
    invoke<AffinityInfo>("get_process_affinity", { pid }),
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
};
