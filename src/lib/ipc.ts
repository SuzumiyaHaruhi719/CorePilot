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
};
