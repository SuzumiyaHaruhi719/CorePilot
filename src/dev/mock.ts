// Browser-preview IPC mock (DEV only, never bundled — see main.tsx). Plausible,
// slowly-drifting data for a 9950X3D + RTX 4090 box so every page renders.
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks"
import { emit } from "@tauri-apps/api/event"
import type { Proc, Session, TreeNode } from "../lib/ipc"

const now = () => Date.now() / 1000
const wave = (p: number, lo: number, hi: number, ph = 0) => lo + ((Math.sin(now() / p + ph) + 1) / 2) * (hi - lo) + Math.random() * (hi - lo) * 0.06
const GB = 1024 ** 3

const logical = Array.from({ length: 32 }, (_, id) => ({ id, group: 0, coreId: id % 16, ccdId: id % 16 < 8 ? 0 : 1, isVcache: id % 16 < 8, efficiencyClass: 0, smtSibling: id < 16 ? id + 16 : id - 16 }))
const ccd = (k: number) => {
  const cpus = logical.filter((l) => l.ccdId === k).map((l) => l.id)
  return { ccdId: k, isVcache: k === 0, l3Bytes: (k === 0 ? 96 : 32) * 1024 * 1024, logicalCpus: cpus, mask: cpus.reduce((m, c) => m | (1n << BigInt(c)), 0n).toString(), kind: k === 0 ? "vcache" : "freq", label: k === 0 ? "3D V-Cache" : "频率核心" }
}
const topo = { logicalCount: 32, physicalCores: 16, smt: true, hybrid: false, ccds: [ccd(0), ccd(1)], logical, vcacheCcd: 0, detection: "AMD Zen 5 · 2 CCD" }

const NAMES: [string, string | null, number][] = [
  ["cs2.exe", "Counter-Strike 2", 22], ["chrome.exe", "Google Chrome", 3], ["chrome.exe", "Google Chrome", 1], ["chrome.exe", "Google Chrome", 0.4], ["chrome.exe", "Google Chrome", 0.2],
  ["Discord.exe", "Discord", 0.8], ["Discord.exe", "Discord", 0.3], ["steam.exe", "Steam", 0.6], ["steamwebhelper.exe", "Steam Client WebHelper", 0.5], ["explorer.exe", "Windows 资源管理器", 0.4],
  ["Code.exe", "Visual Studio Code", 1.2], ["Code.exe", "Visual Studio Code", 0.6], ["corepilot.exe", "CorePilot", 0.7], ["sensord.exe", null, 0.3], ["dwm.exe", "桌面窗口管理器", 1.4],
  ["svchost.exe", null, 0.1], ["svchost.exe", null, 0.2], ["svchost.exe", null, 0.05], ["svchost.exe", null, 0.1], ["MsMpEng.exe", null, 0.9], ["audiodg.exe", null, 0.3],
  ["Spotify.exe", "Spotify", 0.4], ["obs64.exe", "OBS Studio", 4.1], ["nvcontainer.exe", null, 0.2], ["System", null, 0.6], ["Registry", null, 0], ["csrss.exe", null, 0.1],
  ["wallpaper64.exe", "Wallpaper Engine", 1.1], ["SearchHost.exe", "搜索", 0.1], ["RuntimeBroker.exe", null, 0], ["ctfmon.exe", null, 0],
]
const procs = (): Proc[] => NAMES.map(([name, description, base], i) => ({
  pid: 1000 + i * 37, name, description, cpu: Math.max(0, base * wave(3 + i, 0.6, 1.4, i)), mem: (base * 0.4 + 0.08 + (i % 5) * 0.06) * GB,
  threads: 8 + ((i * 13) % 90), gpu: name === "cs2.exe" ? wave(4, 88, 98) : name === "obs64.exe" ? 6 : name === "dwm.exe" ? 2 : 0, gpuMem: name === "cs2.exe" ? 7.2 * GB : name === "chrome.exe" && i === 1 ? 0.6 * GB : null,
  power: base * 2.2, affinity: name === "cs2.exe" ? topo.ccds[0].mask : "4294967295", user: /^(System|Registry|csrss|svchost|MsMpEng|audiodg)/.test(name) ? "SYSTEM" : "Thomas",
  handles: 200 + i * 31, cpuTime: 30 + i * 400, platform: "64位", gpuEngine: name === "cs2.exe" ? "3D" : null, gpuAdapter: null, settable: !/^(System|Registry|csrss)/.test(name),
  parentPid: 4, exePath: name.endsWith(".exe") ? `C:\\Program Files\\${name.replace(".exe", "")}\\${name}` : null,
}))

const fanCh = [["/lpc/0/control/0", "CPU 风扇"], ["/lpc/0/control/1", "水泵"], ["/lpc/0/control/2", "机箱前置 1"], ["/lpc/0/control/3", "机箱前置 2"], ["/lpc/0/control/4", "机箱后置"]]
const store = (k: string) => localStorage.getItem(`mock:${k}`)

function tree(): TreeNode[] {
  const nodes: TreeNode[] = []
  let id = 0
  const add = (parent: number, name: string, size: number, dir: boolean, path: string | null) => { nodes.push({ id, parent, name, logicalSize: size, allocSize: size, fileCount: dir ? 1200 : 1, flags: dir ? 1 : 0, hasMore: false, path }); return id++ }
  const root = add(0, "C:\\", 820 * GB, true, "C:\\")
  const spec: [string, number, [string, number][]][] = [
    ["Program Files (x86)", 380, [["Steam", 320], ["Microsoft", 24], ["Common Files", 6]]], ["Users", 210, [["Thomas", 200], ["Public", 2]]],
    ["Windows", 42, [["System32", 18], ["WinSxS", 14], ["Installer", 6]]], ["Program Files", 96, [["NVIDIA Corporation", 4], ["Docker", 30], ["JetBrains", 18], ["Adobe", 22]]],
    ["pagefile.sys", 32, []], ["hiberfil.sys", 25, []], ["ProgramData", 22, [["Package Cache", 9], ["NVIDIA", 3]]],
  ]
  for (const [n, s, kids] of spec) {
    const d = add(root, n, s * GB, kids.length > 0, kids.length ? `C:\\${n}` : null)
    for (const [kn, ks] of kids) {
      const k = add(d, kn, ks * GB, true, `C:\\${n}\\${kn}`)
      const files = ["data.pak", "movie.mp4", "textures.bundle", "music.flac", "game.exe", "shot.png", "cache.bin", "voice.wem"]
      let left = ks * GB
      for (let i = 0; i < 9 && left > GB * 0.1; i++) { const sz = left * (0.22 + (i % 3) * 0.08); left -= sz; add(k, `${i}_${files[i % files.length]}`, sz, false, null) }
    }
  }
  return nodes
}

function session(i: number): Session {
  const start = Date.now() - (i + 1) * 86400_000
  const samples = Array.from({ length: 600 }, (_, k) => {
    const fps = 240 + Math.sin(k / 30) * 30 - (k % 97 === 0 ? 120 : 0) + Math.random() * 12 - i * 40
    return { t: k * 200, fps, frametimeMs: 1000 / fps, cpuLoad: 35 + Math.sin(k / 50) * 8, cpuTemp: 62 + Math.sin(k / 80) * 4, cpuPower: 95 + Math.sin(k / 40) * 12, cpuClock: 5500, gpuLoad: 92 + Math.sin(k / 20) * 5, gpuTemp: 64 + k / 100, gpuPower: 380 + Math.sin(k / 25) * 30, gpuClock: 2700, vramLoad: 45, memLoad: 38, gpuFan: 52, diskRead: 0, diskWrite: 0, netDown: 0, netUp: 0 }
  })
  const f = samples.map((s) => s.fps)
  return {
    id: `0000000${i}-0000-4000-8000-000000000000`,
    meta: { exe: ["cs2.exe", "eldenring.exe", "starcitizen.exe"][i], path: null, startedAt: start, endedAt: start + 120_000, durationSec: 3600 + i * 1700, cpuName: "AMD Ryzen 9 9950X3D 16-Core Processor", gpuName: "NVIDIA GeForce RTX 4090" },
    summary: { avgFps: f.reduce((a, b) => a + b) / f.length, minFps: Math.min(...f), maxFps: Math.max(...f), low1: Math.min(...f) * 1.3, low01: Math.min(...f), avgFrametimeMs: 4.2, avgCpuLoad: 35, avgCpuTemp: 62, maxCpuTemp: 68, avgCpuPower: 95, maxCpuPower: 118, avgCpuClock: 5500, avgGpuLoad: 92, avgGpuTemp: 66, maxGpuTemp: 71, avgGpuPower: 380, maxGpuPower: 430, avgGpuClock: 2700, avgVramLoad: 45, maxVramLoad: 50, avgMemLoad: 38, energyWh: 410 + i * 200, co2Kg: 0.21 },
    samples,
  }
}
const sessions = [0, 1, 2].map(session)
let scanStarted = 0

mockWindows("main")
mockIPC((cmd, args) => {
  const a = (args ?? {}) as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  const per = Array.from({ length: 32 }, (_, i) => Math.min(100, Math.max(0, wave(2 + (i % 7), i % 16 < 8 ? 25 : 2, i % 16 < 8 ? 85 : 30, i))))
  switch (cmd) {
    case "get_topology": return topo
    case "get_overview": return { cpuName: "AMD Ryzen 9 9950X3D 16-Core Processor", physicalCores: 16, logicalCpus: 32, ramTotal: 64 * GB, os: "Windows 11 Pro 25H2", vcacheCcd: 0, detection: topo.detection }
    case "get_metrics": return { cpuOverall: per.reduce((x, y) => x + y) / 32, perCore: per, memUsed: wave(20, 24, 27) * GB, memTotal: 64 * GB }
    case "get_sensors": return { gpuPct: wave(5, 82, 97), gpuName: "NVIDIA GeForce RTX 4090", vramUsed: 9.4 * GB, vramTotal: 24 * GB, diskPct: wave(3, 1, 18), diskRead: wave(2, 0, 40e6), diskWrite: wave(3, 0, 12e6), netUp: wave(2, 40e3, 400e3), netDown: wave(3, 0.4e6, 6e6), cpuPower: wave(6, 88, 128), gpuPower: wave(4, 340, 420), cpuTemp: wave(9, 61, 72), gpuTemp: wave(14, 63, 69), cpuClock: wave(4, 5350, 5650) }
    case "cpu_sensors": return [...Array.from({ length: 8 }, (_, i) => ({ name: `Core #${i + 1} Clock`, kind: "Clock", value: wave(3, 5300, 5700, i) })), { name: "Core (SVI3)", kind: "Voltage", value: 1.21 }, { name: "SoC (SVI3)", kind: "Voltage", value: 1.05 }, { name: "CCD1 (Tdie)", kind: "Temperature", value: 64 }, { name: "CCD2 (Tdie)", kind: "Temperature", value: 58 }, { name: "Package", kind: "Power", value: 112 }]
    case "list_processes": return procs()
    case "process_icon": return null
    case "get_memory_detail": return { total: 64 * GB, avail: 38 * GB, used: 26 * GB, loadPct: 40 }
    case "clean_temp": return { bytes: 1.7 * GB, files: 4312 }
    case "get_power_plan": return "high"
    case "foreground_info": return { exe: "cs2.exe", pid: 1000, isGame: true }
    case "osd_fps_stats": { const f = wave(2, 228, 262); return { fps: f, frametimeMs: 1000 / f, low1: f * 0.71, low01: f * 0.55 } }
    case "overlay_status": { const allowed = JSON.parse(store("cp.settings") ?? "{}")?.state?.osd?.injectAllow?.includes("cs2.exe") ?? false; return { target: { pid: 1000, api: "dx11", anticheat: false, blockedBy: null, game: true, exe: "cs2.exe", allowed, native: true, injectable: allowed }, mode: allowed ? "inject" : "window", reason: "", reasonZh: allowed ? "✅ 已注入（DX11）" : "未加入游戏内叠加白名单，使用窗口叠加", reasonEn: allowed ? "✅ Injected (DX11)" : "Not on the in-game overlay allowlist — using the window overlay", attached: allowed } }
    case "game_library_list": return [{ name: "Counter-Strike 2", path: "D:\\Steam\\steamapps\\common\\cs2\\game\\bin\\win64\\cs2.exe", source: "Steam" }, { name: "ELDEN RING", path: "D:\\Steam\\steamapps\\common\\ELDEN RING\\Game\\eldenring.exe", source: "Steam" }, { name: "Star Citizen", path: "C:\\RSI\\StarCitizen\\LIVE\\Bin64\\StarCitizen.exe", source: "Custom" }, { name: "Alan Wake 2", path: "E:\\Epic\\AlanWake2\\AlanWake2.exe", source: "Epic" }]
    case "gpu_oc_info": return { available: true, name: "NVIDIA GeForce RTX 4090", driverVersion: "581.42", graphicsClock: Math.round(wave(3, 2700, 2790)), memClock: 10501, smClock: 2760, temperature: Math.round(wave(14, 63, 69)), powerUsageW: wave(4, 340, 420), powerLimitW: 450, powerLimitMinW: 150, powerLimitMaxW: 600, fanSpeedPct: 54, utilizationGpu: Math.round(wave(5, 82, 97)), utilizationMem: 40, memUsedBytes: 9.4 * GB, memTotalBytes: 24 * GB, maxGraphicsClockMhz: 3105, tempLimitC: 84, tempLimitMinC: 65, tempLimitMaxC: 90, supportsPowerLimit: true, supportsLockedClocks: true, supportsFanControl: true, supportsTempLimit: true, supportsClockOffset: true, coreOffsetMinMhz: -500, coreOffsetMaxMhz: 300, memOffsetMinMhz: -1000, memOffsetMaxMhz: 1500 }
    case "gpu_oc_startup_check": return { blocked: false, reason: "", detail: "" }
    case "smu_status": return { pawnIo: true, loaded: true, version: 0x5c, versionStr: "92.0", lastReply: null, lastReplyOk: true, supported: true, unsupportedReason: null }
    case "fan_info": return { available: true, supported: true, dirtyHeaders: [], channels: fanCh.map(([id, name], i) => { const pct = wave(8, 32, 60, i); return { id, name, hw: "NCT6701D", pct, controllable: true, rpm: pct * (i === 1 ? 32 : 18) + 200, rpmName: name } }).concat([{ id: "/gpu/fan", name: "GPU 风扇", hw: "RTX 4090", pct: 54, controllable: false, rpm: 1480, rpmName: "GPU" }]), temps: [{ id: "/amdcpu/0/temperature/2", name: "CPU (Tctl/Tdie)", c: wave(9, 61, 72) }, { id: "/lpc/0/temperature/0", name: "主板", c: 38 }, { id: "/gpu/0/temperature/0", name: "GPU 核心", c: wave(14, 63, 69) }, { id: "/nvme/0", name: "NVMe 990 Pro", c: 46 }] }
    case "smu_apply_co": case "smu_apply_co_all": case "smu_apply_limit": case "smu_set_scalar": case "smu_force_stock": return { ok: true, detail: "ok" }
    case "fan_passive_status": return { enabled: false, cpuSamples: 0, gpuSamples: 0, accumulatedCpuC: 0, accumulatedGpuC: 0 }
    case "disk_list_volumes": return [{ scanId: "C", root: "C:\\", letter: "C:", label: "Windows", fileSystem: "NTFS", driveType: "fixed", total: 1.86e12, free: 0.98e12, supported: true }, { scanId: "D", root: "D:\\", letter: "D:", label: "Games", fileSystem: "NTFS", driveType: "fixed", total: 3.6e12, free: 0.6e12, supported: true }, { scanId: "E", root: "E:\\", letter: "E:", label: "", fileSystem: "exFAT", driveType: "removable", total: 1e12, free: 0.7e12, supported: false }]
    case "disk_scan_start": scanStarted = Date.now(); a.scanIds.forEach((id: string) => { let k = 0; const iv = setInterval(() => { k++; emit("disk-scan://progress", prog(id, k >= 12 ? "done" : "scanning", k)); if (k >= 12) clearInterval(iv) }, 300) }); return a.scanIds
    case "disk_scan_status": return prog(a.scanId, scanStarted ? "done" : "cancelled", 12)
    case "disk_tree": return { scanId: a.scanId, generation: 1, focusPath: a.focusPath ?? "C:\\", nodes: subtree(a.focusPath), truncated: false }
    case "disk_top_items": return tree().filter((n) => !(n.flags & 1)).sort((x, y) => y.allocSize - x.allocSize).slice(0, 20).map((n) => ({ path: `C:\\…\\${n.id}\\${n.name}`, name: n.name, logicalSize: n.allocSize, allocSize: n.allocSize, fileCount: 1, flags: n.flags }))
    case "list_services": return Array.from({ length: 60 }, (_, i) => ({ name: `Svc${i}`, display: ["Windows Update", "Windows Search", "SysMain", "Print Spooler", "Bluetooth Support Service", "Steam Client Service", "NVIDIA Display Container LS"][i % 7] + (i > 6 ? ` ${i}` : ""), status: i % 3 ? "running" : "stopped", startType: ["auto", "manual", "disabled"][i % 3], pid: i % 3 ? 4000 + i : 0, description: "Mock service description.", group: "" }))
    case "list_startup": return [{ name: "Steam", command: '"C:\\Program Files (x86)\\Steam\\steam.exe" -silent', location: "hkcu_run", enabled: true }, { name: "Discord", command: "C:\\Users\\Thomas\\AppData\\Local\\Discord\\Update.exe --processStart Discord.exe", location: "hkcu_run", enabled: false }, { name: "NVIDIA Broadcast", command: "C:\\Program Files\\NVIDIA Corporation\\NVIDIA Broadcast\\NVIDIA Broadcast UI.exe", location: "hklm_run", enabled: true }]
    case "network_diagnose": case "network_repair": return [{ id: "adapter", label: "网卡", ok: true, detail: "Realtek 2.5GbE · 2500 Mbps" }, { id: "gateway", label: "网关", ok: true, detail: "192.168.1.1 · 1 ms" }, { id: "dns", label: "DNS", ok: true, detail: "223.5.5.5 · 9 ms" }, { id: "proxy", label: "代理", ok: false, detail: "系统代理指向 127.0.0.1:7890" }]
    case "tweak_apply": return JSON.stringify({ kind: "reg" })
    case "update_check": return { available: true, currentVersion: "0.5.0", latestVersion: "0.6.0", notes: "· 全新界面\n· 风扇自动调校改进", pubDate: null, flavor: "installer", gameForeground: false, blockers: [], releasesUrl: "" }
    case "get_autostart": return true
    case "ui_occluded": return false
    case "startup_directive": return null
    case "persist_get": return store(a.name)
    case "persist_set": localStorage.setItem(`mock:${a.name}`, a.value); return null
    case "perf_session_ids": return sessions.map((s) => s.id)
    case "perf_session_load": return JSON.stringify(sessions.find((s) => s.id === a.id) ?? null)
    case "export_debug_logs": return "C:\\Users\\Thomas\\Downloads\\CorePilot-logs"
    case "plugin:app|version": return "0.5.0"
    case "osd_target_monitor": return [0, 0, 1920, 1080]
    default: return null
  }
}, { shouldMockEvents: true })

function prog(scanId: string, status: string, k: number) {
  return { scanId, root: `${scanId}:\\`, status, filesSeen: k * 183_211, dirsSeen: k * 9100, bytesAlloc: Math.min(12, k) / 12 * 0.88e12, bytesLogical: 0, skipped: 0, nodeCount: k * 190000, generation: k, truncated: false, disconnected: false, currentPath: `${scanId}:\\Program Files (x86)\\Steam\\steamapps\\common\\…\\${k}.pak`, elapsedMs: k * 300, error: null }
}
function subtree(focus: string | null): TreeNode[] {
  const all = tree()
  const root = focus ? all.find((n) => n.path === focus) ?? all[0] : all[0]
  const keep = new Map<number, number>()
  const out: TreeNode[] = []
  const walk = (n: TreeNode, parent: number) => {
    const id = out.length
    keep.set(n.id, id)
    out.push({ ...n, id, parent })
    for (const c of all) if (c.parent === n.id && c.id !== n.id) walk(c, id)
  }
  walk(root, 0)
  return out
}
