// OSD metric catalogue — keys match the original store and the taskbar plate
// ("cpu.temp", "fps.low1", …), so persisted metric lists carry over 1:1.
import type { FpsStats, GpuInfo, Metrics, Sensors } from "./ipc"
import type { MetricCat } from "./themes"
import { bytes, isNum } from "./util"

export interface PlateData { fps: FpsStats | null; m: Metrics | null; s: Sensors | null; g: GpuInfo | null }
export type OsdPosition = "tl" | "tc" | "tr" | "bl" | "bc" | "br"
export const OSD_POSITIONS: OsdPosition[] = ["tl", "tc", "tr", "bl", "bc", "br"]

const rate = (v: number | null | undefined) => (isNum(v) ? bytes(v, 1).replace(" ", "") : null)
const n0 = (v: number | null | undefined, u = "") => (isNum(v) ? `${v.toFixed(0)}${u}` : null)
const gpuUtil = (d: PlateData) => (d.g?.available ? d.g.utilizationGpu : d.s?.gpuPct)

export interface MetricDef { key: string; cat: MetricCat; zh: string; en: string; value: (d: PlateData) => string | null }
export const METRICS: MetricDef[] = [
  { key: "fps", cat: "fps", zh: "帧率", en: "FPS", value: (d) => n0(d.fps?.fps) },
  { key: "fps.low1", cat: "fps", zh: "1% Low", en: "1% Low", value: (d) => (isNum(d.fps?.low1) ? `1% ${d.fps!.low1!.toFixed(0)}` : null) },
  { key: "fps.low01", cat: "fps", zh: "0.1% Low", en: "0.1% Low", value: (d) => (isNum(d.fps?.low01) ? `.1% ${d.fps!.low01!.toFixed(0)}` : null) },
  { key: "fps.frametime", cat: "fps", zh: "帧时间", en: "Frametime", value: (d) => (isNum(d.fps?.frametimeMs) ? `${d.fps!.frametimeMs!.toFixed(1)}ms` : null) },
  { key: "cpu.util", cat: "cpu", zh: "占用", en: "Load", value: (d) => n0(d.m?.cpuOverall, "%") },
  { key: "cpu.temp", cat: "cpu", zh: "温度", en: "Temp", value: (d) => n0(d.s?.cpuTemp, "°") },
  { key: "cpu.power", cat: "cpu", zh: "功耗", en: "Power", value: (d) => n0(d.s?.cpuPower, "W") },
  { key: "cpu.freq", cat: "cpu", zh: "频率", en: "Clock", value: (d) => n0(d.s?.cpuClock, "MHz") },
  { key: "gpu.util", cat: "gpu", zh: "占用", en: "Load", value: (d) => n0(gpuUtil(d), "%") },
  { key: "gpu.temp", cat: "gpu", zh: "温度", en: "Temp", value: (d) => n0(d.g?.available ? d.g.temperature : d.s?.gpuTemp, "°") },
  { key: "gpu.power", cat: "gpu", zh: "功耗", en: "Power", value: (d) => n0(d.g?.available ? d.g.powerUsageW : d.s?.gpuPower, "W") },
  { key: "gpu.coreClock", cat: "gpu", zh: "核心频率", en: "Core clock", value: (d) => (d.g?.graphicsClock ? `${d.g.graphicsClock}MHz` : null) },
  { key: "gpu.memClock", cat: "gpu", zh: "显存频率", en: "Mem clock", value: (d) => (d.g?.memClock ? `${d.g.memClock}MHz` : null) },
  { key: "gpu.fan", cat: "gpu", zh: "风扇", en: "Fan", value: (d) => (d.g?.available ? `${d.g.fanSpeedPct}%` : null) },
  { key: "gpu.vramPct", cat: "gpu", zh: "显存占比", en: "VRAM %", value: (d) => (d.g?.available && d.g.memTotalBytes ? `${((d.g.memUsedBytes / d.g.memTotalBytes) * 100).toFixed(0)}%` : null) },
  { key: "gpu.vramUsed", cat: "gpu", zh: "显存用量", en: "VRAM used", value: (d) => rate(d.g?.available ? d.g.memUsedBytes : d.s?.vramUsed) },
  { key: "mem.util", cat: "mem", zh: "占用", en: "Load", value: (d) => (d.m?.memTotal ? `${((d.m.memUsed / d.m.memTotal) * 100).toFixed(0)}%` : null) },
  { key: "mem.used", cat: "mem", zh: "用量", en: "Used", value: (d) => rate(d.m?.memUsed) },
  { key: "disk.util", cat: "disk", zh: "活动", en: "Active", value: (d) => n0(d.s?.diskPct, "%") },
  { key: "disk.read", cat: "disk", zh: "读取", en: "Read", value: (d) => { const r = rate(d.s?.diskRead); return r && `R ${r}` } },
  { key: "disk.write", cat: "disk", zh: "写入", en: "Write", value: (d) => { const r = rate(d.s?.diskWrite); return r && `W ${r}` } },
  { key: "net.down", cat: "net", zh: "下载", en: "Down", value: (d) => { const r = rate(d.s?.netDown); return r && `↓${r}` } },
  { key: "net.up", cat: "net", zh: "上传", en: "Up", value: (d) => { const r = rate(d.s?.netUp); return r && `↑${r}` } },
]
export const CAT_ORDER: MetricCat[] = ["fps", "cpu", "gpu", "mem", "disk", "net"]
export const CAT_LABEL: Record<MetricCat, string> = { fps: "FPS", cpu: "CPU", gpu: "GPU", mem: "RAM", disk: "DISK", net: "NET" }

/** Injected-overlay row bits (corepilot-osd-ipc `show`) derived from the metric list. */
export function overlayFlags(metrics: string[]): number {
  const has = (re: RegExp) => metrics.some((m) => re.test(m))
  const bits = [has(/^fps(\.low)?/), has(/frametime/), has(/^cpu\./), has(/^gpu\.(util|temp|power|coreClock|memClock|fan)/), has(/^gpu\.vram/), has(/^mem\./), has(/^disk\./), has(/^net\./)]
  return bits.reduce((f, on, i) => (on ? f | (1 << i) : f), 0)
}
