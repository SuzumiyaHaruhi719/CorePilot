/**
 * Browser-only Tauri IPC mock for UI work (`npm run dev` → /preview.html).
 *
 * Never loaded by the app: index.html → main.tsx has no path to this file; only
 * preview.html imports it before main.tsx. It fakes a Ryzen 9 9950X3D + RTX 4090
 * box with gently drifting telemetry so every tab renders with plausible data.
 *
 * URL params: ?tab=<TabId>&style=<ThemeStyle>&lang=en
 *
 * ponytail: commands not listed here resolve to null — add a case when a screen
 * needs real-looking data from one.
 */
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const LOGICAL = 32;
const t0 = performance.now();
const tsec = () => (performance.now() - t0) / 1000;
const wave = (period: number, phase = 0) => (Math.sin((tsec() / period) * Math.PI * 2 + phase) + 1) / 2;
const jitter = (n: number) => (Math.random() - 0.5) * n;

const ALL_MASK = ((1n << BigInt(LOGICAL)) - 1n).toString();
const CCD0 = Array.from({ length: 16 }, (_, i) => (i < 8 ? i : i + 8)); // cores 0-7 + SMT 16-23
const CCD1 = Array.from({ length: 16 }, (_, i) => (i < 8 ? i + 8 : i + 16));
const maskOf = (ids: number[]) => ids.reduce((m, i) => m | (1n << BigInt(i)), 0n).toString();

const topology = {
  logicalCount: LOGICAL,
  physicalCores: 16,
  smt: true,
  hybrid: false,
  vcacheCcd: 0,
  detection: "L3 size (96 MB vs 32 MB)",
  ccds: [
    { ccdId: 0, isVcache: true, l3Bytes: 96 * MB, logicalCpus: CCD0, mask: maskOf(CCD0), kind: "vcache", label: "3D V-Cache" },
    { ccdId: 1, isVcache: false, l3Bytes: 32 * MB, logicalCpus: CCD1, mask: maskOf(CCD1), kind: "freq", label: "频率核心" },
  ],
  logical: Array.from({ length: LOGICAL }, (_, id) => {
    const core = id % 16;
    return { id, group: 0, coreId: core, ccdId: core < 8 ? 0 : 1, isVcache: core < 8, efficiencyClass: 0, smtSibling: id < 16 ? id + 16 : id - 16 };
  }),
};

const PROCS: Array<[string, string, number, number, number, number?]> = [
  // name, description, cpu%, memMB, gpu%, power
  ["cyberpunk2077.exe", "Cyberpunk 2077", 38.2, 11200, 92, 48],
  ["chrome.exe", "Google Chrome", 4.1, 2860, 2, 3.2],
  ["Discord.exe", "Discord", 1.2, 640, 1, 0.8],
  ["steam.exe", "Steam", 0.6, 410, 0, 0.4],
  ["steamwebhelper.exe", "Steam Client WebHelper", 0.9, 520, 1, 0.5],
  ["explorer.exe", "Windows Explorer", 0.4, 180, 0, 0.2],
  ["obs64.exe", "OBS Studio", 3.4, 820, 6, 4.1],
  ["Spotify.exe", "Spotify", 0.7, 360, 0, 0.3],
  ["Code.exe", "Visual Studio Code", 1.8, 1240, 0, 1.1],
  ["MsMpEng.exe", "Antimalware Service Executable", 0.3, 290, 0, 0.2],
  ["dwm.exe", "Desktop Window Manager", 1.1, 160, 4, 0.9],
  ["svchost.exe", "Service Host", 0.2, 48, 0, 0.1],
  ["nvcontainer.exe", "NVIDIA Container", 0.1, 72, 0, 0.1],
  ["corepilot.exe", "CorePilot", 0.8, 210, 0, 0.4],
  ["RazerCentralService.exe", "Razer Central", 0.2, 96, 0, 0.1],
  ["audiodg.exe", "Windows Audio Device Graph Isolation", 0.5, 34, 0, 0.2],
  ["Taskmgr.exe", "Task Manager", 0.3, 64, 0, 0.1],
  ["SearchHost.exe", "Search", 0, 120, 0, 0],
  ["WindowsTerminal.exe", "Windows Terminal", 0.2, 140, 0, 0.1],
  ["EpicGamesLauncher.exe", "Epic Games Launcher", 0.4, 260, 0, 0.2],
];

let pidSeq = 4100;
const procs = PROCS.map(([name, description, cpu, memMb, gpu, power]) => ({
  pid: (pidSeq += 124 + Math.floor(Math.random() * 300)),
  name,
  description,
  cpu,
  mem: memMb * MB,
  threads: Math.floor(8 + Math.random() * 120),
  gpu,
  gpuMem: gpu > 0 ? gpu * 90 * MB : null,
  power: power ?? 0,
  affinity: name.startsWith("cyberpunk") ? maskOf(CCD0) : ALL_MASK,
  user: name === "svchost.exe" || name === "MsMpEng.exe" ? "SYSTEM" : "Thomas",
  handles: Math.floor(200 + Math.random() * 3000),
  cpuTime: Math.floor(Math.random() * 9000),
  platform: "64位",
  gpuEngine: gpu > 0 ? "3D" : null,
  gpuAdapter: gpu > 0 ? "NVIDIA GeForce RTX 4090" : null,
  settable: name !== "MsMpEng.exe",
  parentPid: 0,
  exePath: null,
}));

function metrics() {
  const load = 22 + wave(14) * 30;
  const perCore = Array.from({ length: LOGICAL }, (_, i) => {
    const hot = i < 8 ? 1.9 : i < 16 ? 0.6 : 0.35;
    return Math.max(0, Math.min(100, load * hot + jitter(14) + Math.sin(tsec() / 3 + i) * 8));
  });
  return { cpuOverall: perCore.reduce((a, b) => a + b, 0) / LOGICAL, perCore, memUsed: 27.4 * GB + wave(30) * 2 * GB, memTotal: 64 * GB };
}

function sensors() {
  const g = 78 + wave(9) * 18;
  return {
    gpuPct: g,
    gpuName: "NVIDIA GeForce RTX 4090",
    vramUsed: 13.1 * GB + wave(20) * GB,
    vramTotal: 24 * GB,
    diskPct: 3 + wave(5) * 9,
    diskRead: 42 * MB * wave(4),
    diskWrite: 8 * MB * wave(6, 1),
    netUp: 180_000 * wave(3),
    netDown: 2_400_000 * wave(5, 2),
    cpuPower: 92 + wave(14) * 40,
    gpuPower: 310 + wave(9) * 90,
    cpuTemp: 68 + wave(14) * 9,
    gpuTemp: 64 + wave(18) * 8,
    cpuClock: 5180 + jitter(120),
    cpuSensors: [
      ...Array.from({ length: 16 }, (_, i) => ({ name: `Core #${i + 1}`, kind: "Clock", value: 5100 + jitter(250) - (i < 8 ? 200 : 0) })),
      { name: "CCD1 (Tdie)", kind: "Temperature", value: 71 + jitter(2) },
      { name: "CCD2 (Tdie)", kind: "Temperature", value: 63 + jitter(2) },
      { name: "Core (SVI3 TFN)", kind: "Voltage", value: 1.21 + jitter(0.04) },
      { name: "SoC (SVI3 TFN)", kind: "Voltage", value: 1.05 },
      { name: "Package", kind: "Power", value: 118 + jitter(10) },
    ],
  };
}

const gpuOcInfo = () => ({
  available: true,
  name: "NVIDIA GeForce RTX 4090",
  driverVersion: "581.42",
  graphicsClock: 2745 + Math.round(jitter(30)),
  memClock: 10501,
  smClock: 2745,
  temperature: Math.round(64 + wave(18) * 8),
  powerUsageW: 310 + wave(9) * 90,
  powerLimitW: 450,
  powerLimitMinW: 150,
  powerLimitMaxW: 600,
  fanSpeedPct: 52,
  utilizationGpu: Math.round(78 + wave(9) * 18),
  utilizationMem: 41,
  memUsedBytes: 13.1 * GB,
  memTotalBytes: 24 * GB,
  maxGraphicsClockMhz: 3120,
  tempLimitC: 83,
  tempLimitMinC: 65,
  tempLimitMaxC: 88,
  supportsPowerLimit: true,
  supportsLockedClocks: true,
  supportsFanControl: true,
  supportsTempLimit: true,
  supportsClockOffset: true,
  coreOffsetMinMhz: -1000,
  coreOffsetMaxMhz: 1000,
  memOffsetMinMhz: -1000,
  memOffsetMaxMhz: 1500,
});

const FANS: Array<[string, string, number, boolean]> = [
  ["cpu", "CPU Fan", 1180, true],
  ["cpu_opt", "CPU OPT", 1210, true],
  ["sys1", "Chassis Fan 1", 860, true],
  ["sys2", "Chassis Fan 2", 880, true],
  ["sys3", "Chassis Fan 3", 0, true],
  ["aio", "AIO Pump", 2650, false],
];
const fanInfo = () => ({
  available: true,
  supported: true,
  channels: FANS.map(([id, name, rpm, ctl], i) => ({
    id: `/lpc/nct6799d/control/${i}`,
    name,
    hw: "Nuvoton NCT6799D",
    pct: rpm ? Math.round(38 + wave(12, i) * 12) : 0,
    controllable: ctl,
    rpm: rpm ? Math.round(rpm + wave(12, i) * 140) : 0,
    rpmName: `${name} ${id}`,
  })),
  temps: [
    { id: "/amdcpu/0/temperature/2", name: "CPU (Tctl/Tdie)", c: 68 + wave(14) * 9 },
    { id: "/gpu-nvidia/0/temperature/0", name: "GPU Core", c: 64 + wave(18) * 8 },
    { id: "/lpc/nct6799d/temperature/1", name: "Motherboard", c: 38 },
    { id: "/lpc/nct6799d/temperature/4", name: "PCH", c: 52 },
  ],
});

const volumes = [
  { scanId: "C:\\", root: "C:\\", letter: "C:", label: "System", fileSystem: "NTFS", driveType: "fixed", total: 1999 * GB, free: 612 * GB, supported: true },
  { scanId: "D:\\", root: "D:\\", letter: "D:", label: "Games", fileSystem: "NTFS", driveType: "fixed", total: 3999 * GB, free: 1180 * GB, supported: true },
  { scanId: "E:\\", root: "E:\\", letter: "E:", label: "Media", fileSystem: "exFAT", driveType: "removable", total: 931 * GB, free: 288 * GB, supported: true },
];

const services = ["AudioSrv|Windows Audio|running|Automatic", "BITS|Background Intelligent Transfer Service|stopped|Manual", "Dhcp|DHCP Client|running|Automatic", "NVDisplay.ContainerLocalSystem|NVIDIA Display Container LS|running|Automatic", "Spooler|Print Spooler|running|Automatic", "WSearch|Windows Search|running|Automatic (Delayed Start)", "wuauserv|Windows Update|stopped|Manual", "SysMain|SysMain|running|Automatic"].map((s, i) => {
  const [name, display, status, startType] = s.split("|");
  return { name, display, status, startType, pid: status === "running" ? 1200 + i * 88 : undefined, description: `${display} service`, group: "LocalSystemNetworkRestricted" };
});

const startup = [
  ["Discord", "C:\\Users\\Thomas\\AppData\\Local\\Discord\\Update.exe --processStart Discord.exe", true],
  ["Steam", '"C:\\Program Files (x86)\\Steam\\steam.exe" -silent', true],
  ["Spotify", "C:\\Users\\Thomas\\AppData\\Roaming\\Spotify\\Spotify.exe /minimized", false],
  ["Razer Synapse", '"C:\\Program Files\\Razer\\RazerAppEngine\\RazerAppEngine.exe" --autostart', true],
  ["OneDrive", '"C:\\Program Files\\Microsoft OneDrive\\OneDrive.exe" /background', false],
].map(([name, command, enabled]) => ({ name, command, location: "HKCU\\Run", enabled }));

const store = new Map<string, string>(Object.entries(JSON.parse(localStorage.getItem("cp-preview-store") ?? "{}")));
const saveStore = () => localStorage.setItem("cp-preview-store", JSON.stringify(Object.fromEntries(store)));

// URL overrides are applied to the persisted blobs BEFORE the stores hydrate.
const params = new URLSearchParams(location.search);
const patchStore = (key: string, patch: Record<string, unknown>) => {
  const env = JSON.parse(store.get(key) ?? '{"state":{},"version":0}');
  env.state = { ...env.state, ...patch };
  store.set(key, JSON.stringify(env));
};
const style = params.get("style");
if (style) patchStore("corepilot-settings", { themeStyle: style, theme: style === "porcelain" || style === "sandstone" ? "light" : "dark" });
if (params.get("lang")) patchStore("corepilot-settings", { language: params.get("lang") });

mockWindows("main");
mockIPC(
  (cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case "get_overview":
        return { cpuName: "AMD Ryzen 9 9950X3D 16-Core Processor", physicalCores: 16, logicalCpus: LOGICAL, ramTotal: 64 * GB, os: "Windows 11 Pro 26100", vcacheCcd: 0, detection: topology.detection };
      case "get_topology":
        return topology;
      case "list_processes":
        return procs.map((p) => ({ ...p, cpu: Math.max(0, p.cpu + jitter(p.cpu * 0.3)), gpu: p.gpu ? Math.max(0, p.gpu + jitter(4)) : 0 }));
      case "get_metrics":
        return metrics();
      case "get_sensors":
        return sensors();
      case "gpu_oc_info":
        return gpuOcInfo();
      case "gpu_engine_loads":
        return { "3D": 88, Copy: 4, "Video Encode": 12, "Video Decode": 0, Compute: 2 };
      case "fan_info":
        return fanInfo();
      case "get_memory_detail":
        return { total: 64 * GB, avail: 36 * GB, used: 28 * GB, loadPct: 44 };
      case "list_services":
        return services;
      case "list_startup":
        return startup;
      case "disk_list_volumes":
        return volumes;
      case "smu_status":
        return { pawnIo: true, loaded: true, version: 0x5c2a00, versionStr: "92.42.0", lastReply: null, lastReplyOk: true };
      case "get_power_plan":
        return "high";
      case "get_process_affinity":
        return { procMask: ALL_MASK, sysMask: ALL_MASK };
      case "get_autostart":
        return true;
      case "ui_occluded":
        return false;
      case "perf_session_ids":
        return [];
      case "game_library_list":
        return [];
      case "osd_fps":
        return 141 + jitter(6);
      case "fan_passive_status":
        return { enabled: false, cpuSamples: 0, gpuSamples: 0, accumulatedCpuC: 0, accumulatedGpuC: 0 };
      case "overlay_status":
        return { attached: false, pid: null, api: null, error: null };
      case "gpu_oc_startup_check":
        return { blocked: false, reason: "", detail: "" };
      case "persist_get":
        return store.get(a.name as string) ?? null;
      case "persist_set":
        store.set(a.name as string, a.value as string);
        saveStore();
        return null;
      case "persist_delete":
        store.delete(a.name as string);
        saveStore();
        return null;
      default:
        return null;
    }
  },
  { shouldMockEvents: true },
);

const tab = params.get("tab");
if (tab) {
  void import("../store/ui").then(({ useUi }) => {
    const go = () => {
      useUi.getState().setTab(tab as never);
      const sec = params.get("sec");
      if (sec) useUi.setState(tab === "monitor" ? { monitorSub: sec as never } : { taskmgrSec: sec as never });
    };
    if (useUi.persist.hasHydrated()) go();
    else useUi.persist.onFinishHydration(go);
  });
}
