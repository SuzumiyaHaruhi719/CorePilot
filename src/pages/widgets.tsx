// The Overview board's widget library: a metric registry, generic visualizations
// (number / curve / gauge / bars / ring) and ~25 built-in widgets. Users compose
// their own "custom" widgets from the same registry (pages/Overview.tsx builder).
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { create } from "zustand"
import {
  Activity, BarChart3, Clock3, Cpu, Fan, Gauge as GaugeIcon, Gamepad2, Globe, HardDrive, Info, Layers, LayoutGrid, ListOrdered, MemoryStick,
  MonitorCog, PieChart, Power, Sparkles, Thermometer, Waves, Wand2, Zap, Eraser, type LucideIcon,
} from "lucide-react"
import { api, type CpuSensor, type FanState, type GpuInfo, type MemDetail, type Proc, type Volume } from "../lib/ipc"
import { act, go, groupColor, tf, useLive, useProfiles, useT, type Series } from "../lib/store"
import { bytes, bytesParts, cpusOf, fixed, isNum, rate } from "../lib/util"
import { AsyncButton, Meter, Panel, Readout, Roll, Scope, Seg, Spark, Switch, useAsync, usePoll } from "../ui/kit"
import { OneClick } from "../ui/OneClick"
import { ProcIcon } from "./Processes"

/** Load → heat hue: cool blue at idle, through amber, to red at saturation. */
export function heat(l: number, alpha = 1) {
  const x = Math.max(0, Math.min(1, l / 100))
  const h = x < 0.7 ? 215 - (215 - 28) * (x / 0.7) : 28 - 28 * ((x - 0.7) / 0.3)
  return `hsl(${h.toFixed(0)} 88% ${58 + x * 4}% / ${alpha})`
}

// ============================================================ plumbing
/** Measures its box so charts fill whatever size the widget was given. */
function Grow({ children, min = 24 }: { children: (w: number, h: number) => ReactNode; min?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = ref.current!
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return <div ref={ref} className="wgrow">{box.h >= min && children(box.w, box.h)}</div>
}
const W = ({ title, right, children, color }: { title: ReactNode; right?: ReactNode; children: ReactNode; color?: string }) => (
  <Panel title={title} right={right} color={color} className="wpanel">{children}</Panel>
)
const Note = ({ children }: { children: ReactNode }) => <div className="wnote">{children}</div>
/** rank colours for ring segments: six hues far apart, so neighbours never blend */
const RANK = [200, 330, 145, 42, 265, 12].map((h) => `hsl(${h} 74% 62%)`)

/** One shared process poll for every widget that needs the list (≥ 1.5 s apart). */
const useProcStore = create<{ list: Proc[] | null }>(() => ({ list: null }))
let procAt = 0, procBusy = false
async function pullProcs() {
  if (procBusy || Date.now() - procAt < 1500) return
  procBusy = true
  try { useProcStore.setState({ list: await api.processes() }); procAt = Date.now() } catch { /* logged by ipc */ } finally { procBusy = false }
}
function useProcs() {
  usePoll(pullProcs, 2000)
  return useProcStore((s) => s.list)
}
interface App { name: string; label: string; path: string | null; cpu: number; mem: number; gpu: number; vram: number; power: number; n: number; masks: string[] }
function apps(list: Proc[]): App[] {
  const by = new Map<string, App>()
  for (const p of list) {
    let a = by.get(p.name)
    if (!a) by.set(p.name, (a = { name: p.name, label: p.description || p.name, path: p.exePath, cpu: 0, mem: 0, gpu: 0, vram: 0, power: 0, n: 0, masks: [] }))
    a.cpu += p.cpu; a.mem += p.mem; a.gpu += p.gpu; a.vram += p.gpuMem ?? 0; a.power += p.power; a.n++
    if (!a.path && p.exePath) a.path = p.exePath
    if (p.affinity) a.masks.push(p.affinity)
  }
  return [...by.values()]
}

// ============================================================ metric registry (built-ins + the custom builder)
export type Unit = "%" | "°C" | "W" | "MHz" | "B/s" | "FPS"
export interface MetricDef { id: string; zh: string; en: string; color: string; unit: Unit; fixedMax?: number; hist: Series | ((h: Record<Series, number[]>) => number[]); cur: () => number | null }
const L = () => useLive.getState()
export const METRICS: MetricDef[] = [
  { id: "cpu", zh: "CPU 占用", en: "CPU load", color: "var(--cpu)", unit: "%", fixedMax: 100, hist: "cpu", cur: () => L().metrics?.cpuOverall ?? null },
  { id: "gpu", zh: "GPU 占用", en: "GPU load", color: "var(--gpu)", unit: "%", fixedMax: 100, hist: "gpu", cur: () => L().sensors?.gpuPct ?? null },
  { id: "mem", zh: "内存占用", en: "RAM", color: "var(--mem)", unit: "%", fixedMax: 100, hist: "mem", cur: () => { const m = L().metrics; return m?.memTotal ? (m.memUsed / m.memTotal) * 100 : null } },
  { id: "vram", zh: "显存占用", en: "VRAM", color: "var(--gpu)", unit: "%", fixedMax: 100, hist: "vram", cur: () => { const s = L().sensors; return s?.vramUsed != null && s.vramTotal ? (s.vramUsed / s.vramTotal) * 100 : null } },
  { id: "dsk", zh: "磁盘活动", en: "Disk active", color: "var(--disk)", unit: "%", fixedMax: 100, hist: "dsk", cur: () => L().sensors?.diskPct ?? null },
  { id: "cpuT", zh: "CPU 温度", en: "CPU temp", color: "var(--cpu)", unit: "°C", fixedMax: 100, hist: "cpuT", cur: () => L().sensors?.cpuTemp ?? null },
  { id: "gpuT", zh: "GPU 温度", en: "GPU temp", color: "var(--gpu)", unit: "°C", fixedMax: 100, hist: "gpuT", cur: () => L().sensors?.gpuTemp ?? null },
  { id: "cpuW", zh: "CPU 功耗", en: "CPU power", color: "var(--cpu)", unit: "W", hist: "cpuW", cur: () => L().sensors?.cpuPower ?? null },
  { id: "gpuW", zh: "GPU 功耗", en: "GPU power", color: "var(--gpu)", unit: "W", hist: "gpuW", cur: () => L().sensors?.gpuPower ?? null },
  { id: "pow", zh: "总功耗", en: "Total power", color: "var(--warn)", unit: "W", hist: (h) => h.cpuW.map((v, i) => v + (h.gpuW[i] ?? 0)), cur: () => { const s = L().sensors; return isNum(s?.cpuPower) || isNum(s?.gpuPower) ? (s?.cpuPower ?? 0) + (s?.gpuPower ?? 0) : null } },
  { id: "clk", zh: "CPU 频率", en: "CPU clock", color: "var(--cpu)", unit: "MHz", hist: "clk", cur: () => L().sensors?.cpuClock ?? null },
  { id: "down", zh: "下载", en: "Download", color: "var(--net)", unit: "B/s", hist: "down", cur: () => L().sensors?.netDown ?? null },
  { id: "up", zh: "上传", en: "Upload", color: "var(--mem)", unit: "B/s", hist: "up", cur: () => L().sensors?.netUp ?? null },
  { id: "rd", zh: "磁盘读取", en: "Disk read", color: "var(--disk)", unit: "B/s", hist: "rd", cur: () => L().sensors?.diskRead ?? null },
  { id: "wr", zh: "磁盘写入", en: "Disk write", color: "var(--cpu)", unit: "B/s", hist: "wr", cur: () => L().sensors?.diskWrite ?? null },
  { id: "fps", zh: "游戏帧率", en: "Game FPS", color: "var(--fps)", unit: "FPS", hist: "fps", cur: () => (L().fg?.isGame ? L().fps?.fps ?? null : null) },
]
export const metric = (id: string) => METRICS.find((m) => m.id === id) ?? METRICS[0]
const histOf = (m: MetricDef, h: Record<Series, number[]>) => (typeof m.hist === "function" ? m.hist(h) : h[m.hist])
export function fmt(m: MetricDef, v: number | null | undefined): [string, string] {
  if (!isNum(v)) return ["—", ""]
  switch (m.unit) {
    case "MHz": return v >= 1000 ? [(v / 1000).toFixed(2), "GHz"] : [v.toFixed(0), "MHz"]
    case "B/s": { const [a, b] = bytesParts(v); return [a, `${b}/s`] }
    case "W": return [v.toFixed(0), "W"]
    case "FPS": return [v.toFixed(0), "FPS"]
    default: return [v.toFixed(0), m.unit]
  }
}
/** Chart ceiling: fixed for percentages/temps, else the window's peak with headroom. */
const ceil = (m: MetricDef, data: number[]) => m.fixedMax ?? Math.max(m.unit === "MHz" ? 1000 : m.unit === "W" ? 20 : m.unit === "FPS" ? 30 : 1024, ...data) * 1.15

// ============================================================ generic visualizations
export function Gauge({ v, max, color, label, value, unit }: { v: number | null; max: number; color: string; label?: string; value: string; unit: string }) {
  const R = 44, C = 2 * Math.PI * R, arc = C * 0.75
  const f = isNum(v) ? Math.max(0, Math.min(1, v / max)) : 0
  return (
    <div className="gauge">
      <svg viewBox="0 0 120 120">
        <circle cx="60" cy="60" r={R} className="gtrack" strokeDasharray={`${arc} ${C}`} transform="rotate(135 60 60)" />
        <circle cx="60" cy="60" r={R} className="gval" style={{ stroke: color, strokeDasharray: `${arc * f} ${C}` }} transform="rotate(135 60 60)" />
      </svg>
      <div className="gtext"><b className="num">{value}</b><span>{unit}</span>{label && <em>{label}</em>}</div>
    </div>
  )
}

interface RSeg { key: string; label: string; v: number; color: string; path?: string | null; dim?: boolean }
/** Donut with animated segments; hovering a segment (or its legend row) puts it in the centre. */
export function Ring({ segs, total, center, sub, fmtV }: { segs: RSeg[]; total: number; center: string; sub: string; fmtV: (v: number) => string }) {
  const [hov, setHov] = useState<string | null>(null)
  const R = 42, C = 2 * Math.PI * R
  let at = 0
  const h = segs.find((s) => s.key === hov)
  return (
    <div className="wring">
      <div className="wring-svg">
        <svg viewBox="0 0 110 110">
          <circle cx="55" cy="55" r={R} className="rtrack" />
          {segs.map((s) => {
            const len = Math.max(0, (s.v / Math.max(total, 1e-9)) * C)
            const el = <circle key={s.key} cx="55" cy="55" r={R} className={`rseg ${hov === s.key ? "on" : ""}`} onMouseEnter={() => setHov(s.key)} onMouseLeave={() => setHov(null)}
              style={{ stroke: s.color, strokeDasharray: `${Math.max(0, len - 1.2)} ${C}`, strokeDashoffset: -at, opacity: s.dim ? 0.35 : 1 }} transform="rotate(-90 55 55)" />
            at += len
            return el
          })}
        </svg>
        <div className="rcenter"><b className="num">{h ? fmtV(h.v) : center}</b><span className="ellipsis">{h ? h.label : sub}</span></div>
      </div>
      <ul className="rlegend">
        {segs.filter((s) => !s.dim).map((s) => (
          <li key={s.key} className={hov === s.key ? "on" : ""} onMouseEnter={() => setHov(s.key)} onMouseLeave={() => setHov(null)}>
            <i style={{ background: s.color }} />
            {s.path !== undefined && <ProcIcon path={s.path} name={s.label} />}
            <span className="ellipsis grow">{s.label}</span>
            <b className="num">{fmtV(s.v)}</b>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** A metric's live trace scaled 0–100 against its own ceiling (so mixed units share one chart). */
function Lines({ ids, height, points = 120 }: { ids: string[]; height: number; points?: number }) {
  const h = useLive((s) => s.hist)
  const tick = useLive((s) => s.tick)
  const traces = ids.map((id, i) => {
    const m = metric(id)
    const d = histOf(m, h).slice(-points)
    const c = ceil(m, d)
    return { data: d.map((v) => (v / c) * 100), color: m.color, width: 1.4, fill: i === 0 }
  })
  return <Scope traces={traces} max={100} height={height} tick={tick} grid={height > 90} points={points} />
}

// ============================================================ built-in widgets
export interface WProps { opt?: string; edit?: boolean }

function Vitals() {
  const t = useT()
  const m = useLive((s) => s.metrics)
  const s = useLive((x) => x.sensors)
  const h = useLive((x) => x.hist)
  const fg = useLive((x) => x.fg)
  const fps = useLive((x) => x.fps)
  const tick = useLive((x) => x.tick)
  const memPct = m?.memTotal ? (m.memUsed / m.memTotal) * 100 : null
  const [mu, mUnit] = bytesParts(m?.memUsed)
  const cell = (label: string, color: string, value: ReactNode, sub: ReactNode, trace: number[], max?: number) => (
    <div className="vcell">
      <span className="label" style={{ color }}>{label}</span>
      {value}
      <div className="dim ellipsis" style={{ fontSize: 12, minHeight: 18 }}>{sub}</div>
      <div className="vtrace"><Grow min={10}>{(_, hh) => <Scope traces={[{ data: trace, color, fill: true, width: 1.4 }]} max={max} height={hh} tick={tick} grid={false} points={60} />}</Grow></div>
    </div>
  )
  return (
    <Panel pad={false} className="wpanel" style={{ overflow: "hidden" }}>
      <div className="vitals">
        {cell(t("处理器", "Processor"), "var(--cpu)", <Readout v={m?.cpuOverall} u="%" />, <>{fixed(s?.cpuClock ? s.cpuClock / 1000 : null, 2, " GHz")} · {fixed(s?.cpuTemp, 0, " °C")} · {fixed(s?.cpuPower, 0, " W")}</>, h.cpu.slice(-60), 100)}
        {cell(t("显卡", "Graphics"), "var(--gpu)", <Readout v={s?.gpuPct} u="%" />, <>{fixed(s?.gpuTemp, 0, " °C")} · {fixed(s?.gpuPower, 0, " W")} · {s?.vramUsed != null ? `${bytes(s.vramUsed)} VRAM` : s?.gpuName ?? "—"}</>, h.gpu.slice(-60), 100)}
        {cell(t("内存", "Memory"), "var(--mem)", <div className="readout"><span className="v">{mu}</span><span className="u">{mUnit}</span></div>, <>{fixed(memPct, 0, "%")} {t("已用", "used")} · {bytes(m?.memTotal ?? null, 0)} {t("总计", "total")}</>, h.mem.slice(-60), 100)}
        {fg?.isGame
          ? cell(t("游戏帧率", "Frame rate"), "var(--fps)", <Readout v={fps?.fps} u="FPS" />, <>1% {fixed(fps?.low1, 0)} · 0.1% {fixed(fps?.low01, 0)} · {fixed(fps?.frametimeMs, 1, " ms")}</>, h.fps.slice(-60))
          : cell(t("网络", "Network"), "var(--net)", <div className="readout"><span className="v" style={{ fontSize: 34 }}>{rate(s?.netDown).replace("/s", "")}</span><span className="u">/s ▼</span></div>, <>▲ {rate(s?.netUp)}</>, h.down.slice(-60))}
      </div>
    </Panel>
  )
}

function LoadScope() {
  const t = useT()
  const h = useLive((s) => s.hist)
  const tick = useLive((s) => s.tick)
  const [show, setShow] = useState({ cpu: true, gpu: true, mem: true })
  const traces = [show.mem && { data: h.mem, color: "--mem", width: 1.3 }, show.gpu && { data: h.gpu, color: "--gpu" }, show.cpu && { data: h.cpu, color: "--cpu", fill: true }].filter(Boolean) as { data: number[]; color: string }[]
  const key = (k: keyof typeof show, label: string, c: string) => (
    <button className={`chip ${show[k] ? "on" : ""}`} onClick={() => setShow({ ...show, [k]: !show[k] })} style={{ height: 22, fontSize: 11 }}><i style={{ width: 8, height: 2, background: c, borderRadius: 2 }} />{label}</button>
  )
  return (
    <W title={t("实时负载 · 120 秒", "Live load · 120 s")} right={<>{key("cpu", "CPU", "var(--cpu)")}{key("gpu", "GPU", "var(--gpu)")}{key("mem", "RAM", "var(--mem)")}</>}>
      <Grow>{(_, hh) => (
        <div style={{ position: "relative" }}>
          <Scope traces={traces} max={100} height={hh} tick={tick} />
          <div className="col faint num" style={{ position: "absolute", inset: "0 auto 0 0", justifyContent: "space-between", fontSize: 10, padding: "2px 0", pointerEvents: "none", "--gap": 0 } as CSSProperties}><span>100</span><span>50</span><span>0</span></div>
        </div>
      )}</Grow>
    </W>
  )
}

function Thermal() {
  const t = useT()
  const s = useLive((x) => x.sensors)
  const h = useLive((x) => x.hist)
  const tick = useLive((x) => x.tick)
  const word = (v: number | null | undefined) => !isNum(v) ? "" : v < 60 ? t("凉爽", "Cool") : v < 75 ? t("温和", "Warm") : v < 85 ? t("偏热", "Hot") : t("过热", "Too hot")
  const block = (label: string, v: number | null | undefined, w: number | null | undefined, color: string, data: number[]) => {
    const c = isNum(v) && v >= 85 ? "var(--crit)" : isNum(v) && v >= 75 ? "var(--warn)" : color
    return (
      <div className="tblock" style={{ "--c": c } as CSSProperties}>
        <div className="row spread"><span className="label" style={{ color }}>{label}</span><span className="num dim" style={{ fontSize: 12 }}>{fixed(w, 0, " W")}{word(v) && <> · <span style={{ color: c }}>{word(v)}</span></>}</span></div>
        <div className="tblock-main">
          <Readout v={v} u="°C" size="md" />
          <Grow min={18}>{(_, hh) => <Scope traces={[{ data: data.slice(-60), color, fill: true, width: 1.5 }]} height={hh} max={100} tick={tick} grid={false} points={60} />}</Grow>
        </div>
        <Meter v={v} max={100} color={c} />
      </div>
    )
  }
  return (
    <W title={t("温度与功耗", "Thermals & power")} right={<button className="btn ghost sm" onClick={() => go("thermals")}>{t("风扇", "Fans")} →</button>}>
      <div className="therm">
        {block("CPU", s?.cpuTemp, s?.cpuPower, "var(--cpu)", h.cpuT)}
        {block("GPU", s?.gpuTemp, s?.gpuPower, "var(--gpu)", h.gpuT)}
      </div>
    </W>
  )
}

function CoreMap() {
  const t = useT()
  const topo = useLive((s) => s.topo)
  const m = useLive((s) => s.metrics)
  if (!topo || !m) return <W title={t("核心负载", "Core load")}><div className="skeleton" style={{ flex: 1 }} /></W>
  return (
    <W title={t("核心负载", "Core load")} right={<span className="faint" style={{ fontSize: 12 }}>{topo.physicalCores}C / {topo.logicalCount}T</span>}>
      <div className="row" style={{ "--gap": "18px", alignItems: "stretch", flex: 1, minHeight: 0 } as CSSProperties}>
        {topo.ccds.map((c) => (
          <div key={c.ccdId} className="col grow" style={{ "--gap": "8px", minWidth: 0 } as CSSProperties}>
            <div className="row spread">
              <span className="label" style={{ color: c.isVcache ? "var(--acc)" : undefined }}>{c.label || `CCD ${c.ccdId}`}</span>
              <span className="num faint" style={{ fontSize: 11 }}>{(c.logicalCpus.reduce((a, i) => a + (m.perCore[i] ?? 0), 0) / Math.max(1, c.logicalCpus.length)).toFixed(0)}%</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(16, c.logicalCpus.length)}, 1fr)`, gap: 3, flex: 1, minHeight: 40 }}>
              {c.logicalCpus.map((i) => {
                const l = m.perCore[i] ?? 0
                return (
                  <div key={i} className="cbar" title={`CPU ${i} · ${l.toFixed(0)}%`}>
                    <div className="cbar-win" style={{ transform: `translateY(${100 - Math.max(2, l)}%)` }}><div className="cbar-fill" style={{ transform: `translateY(${Math.max(2, l) - 100}%)` }} /></div>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </W>
  )
}

/** Per-logical-CPU load over time: one row per thread, newest on the right. */
function CoreHeat() {
  const t = useT()
  const topo = useLive((s) => s.topo)
  const m = useLive((s) => s.metrics)
  const tick = useLive((s) => s.tick)
  const cv = useRef<HTMLCanvasElement>(null)
  const hist = useRef<number[][]>([])
  const COLS = 90
  useEffect(() => {
    if (!m) return
    hist.current = [...hist.current.slice(-(COLS - 1)), m.perCore.slice()]
    const c = cv.current
    if (!c || !topo) return
    const order = topo.ccds.flatMap((x) => x.logicalCpus)
    const rows = order.length || m.perCore.length
    const dpr = devicePixelRatio || 1
    const w = c.clientWidth, h = c.clientHeight
    if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr) }
    const g = c.getContext("2d")!
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, w, h)
    const cw = w / COLS, rh = h / rows
    hist.current.forEach((col, x) => {
      const ox = (COLS - hist.current.length + x) * cw
      order.forEach((cpu, y) => { g.fillStyle = heat(col[cpu] ?? 0, 0.25 + Math.min(1, (col[cpu] ?? 0) / 60) * 0.75); g.fillRect(ox, y * rh, cw + 0.5, Math.max(1, rh - (rh > 4 ? 1 : 0))) })
    })
  }, [tick]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <W title={t("核心热力图", "Core heat timeline")} right={<span className="faint" style={{ fontSize: 12 }}>{topo ? `${topo.logicalCount} ${t("线程", "threads")}` : ""} · 90 s</span>}>
      <canvas ref={cv} className="wcanvas" />
    </W>
  )
}

function IO() {
  const t = useT()
  const s = useLive((x) => x.sensors)
  const h = useLive((x) => x.hist)
  const tick = useLive((x) => x.tick)
  return (
    <W title={t("读写与网络", "I/O & network")}>
      <div className="col" style={{ "--gap": "12px", flex: 1, minHeight: 0 } as CSSProperties}>
        <div className="col grow" style={{ minHeight: 0 }}>
          <div className="row spread" style={{ fontSize: 12, marginBottom: 4 }}><span className="c-disk">{t("磁盘", "Disk")} <span className="faint num">{fixed(s?.diskPct, 0, "%")}</span></span><span className="num dim">R {rate(s?.diskRead)} · W {rate(s?.diskWrite)}</span></div>
          <Grow min={16}>{(_, hh) => <Scope traces={[{ data: h.rd, color: "--disk", fill: true, width: 1.3 }, { data: h.wr, color: "--cpu", width: 1.2 }]} height={hh} tick={tick} grid={false} />}</Grow>
        </div>
        <div className="col grow" style={{ minHeight: 0 }}>
          <div className="row spread" style={{ fontSize: 12, marginBottom: 4 }}><span className="c-net">{t("网络", "Network")}</span><span className="num dim">▼ {rate(s?.netDown)} · ▲ {rate(s?.netUp)}</span></div>
          <Grow min={16}>{(_, hh) => <Scope traces={[{ data: h.down, color: "--net", fill: true, width: 1.3 }, { data: h.up, color: "--mem", width: 1.2 }]} height={hh} tick={tick} grid={false} />}</Grow>
        </div>
      </div>
    </W>
  )
}

function Quick() {
  const t = useT()
  const mem = useAsync(api.memory)
  const tile = (icon: ReactNode, title: string, desc: string, run: () => Promise<unknown>) => (
    <div className="qtile fx-card rv">
      <span className="qic">{icon}</span>
      <div className="col grow" style={{ "--gap": "3px", minWidth: 0 } as CSSProperties}>
        <b style={{ color: "var(--ink)", fontWeight: 600 }}>{title}</b>
        <span className="faint" style={{ fontSize: 12, lineHeight: 1.45 }}>{desc}</span>
      </div>
      <AsyncButton className="btn sm" fx onClick={async () => { const v = await run(); mem.reload(); return v }}>{t("执行", "Run")}</AsyncButton>
    </div>
  )
  return (
    <div className="qgrid">
      {tile(<MemoryStick size={16} />, t("释放工作集", "Trim working sets"), t(`让进程归还空闲内存。当前可用 ${bytes(mem.data?.avail ?? null)}`, `Processes return idle pages. ${bytes(mem.data?.avail ?? null)} available now`), () => act(api.freeWorkingSets(), t("已释放工作集", "Working sets trimmed")))}
      {tile(<Eraser size={16} />, t("清空待机内存", "Purge standby"), t("丢弃缓存的待机页面，缓解游戏卡顿。", "Drop cached standby pages — helps stutter in games."), () => act(api.purgeStandby(), t("待机内存已清空", "Standby list purged")))}
      {tile(<Sparkles size={16} />, t("清理临时文件", "Clean temp files"), t("删除用户与系统临时目录中的残留。", "Remove leftovers in user and system temp folders."), () => act(api.cleanTemp(), (r) => t(`已清理 ${bytes(r.bytes)} · ${r.files} 个文件`, `Freed ${bytes(r.bytes)} · ${r.files} files`)))}
      {tile(<Globe size={16} />, t("刷新 DNS", "Flush DNS"), t("清空解析缓存，修复部分网页打不开。", "Clear the resolver cache when sites fail to load."), () => act(api.flushDns(), t("DNS 缓存已刷新", "DNS cache flushed")))}
    </div>
  )
}

export function PowerPlan() {
  const t = useT()
  const plan = useAsync(api.powerPlan)
  if (!plan.data) return null
  return (
    <Seg value={plan.data} onChange={async (v) => { if (v === "other") return; plan.set(v); await act(api.setPowerPlan(v)); plan.reload() }}
      options={[{ v: "balanced", label: t("平衡", "Balanced") }, { v: "high", label: t("高性能", "High perf") }, { v: "ultimate", label: t("卓越性能", "Ultimate") }, ...(plan.data === "other" ? [{ v: "other" as const, label: t("自定义", "Custom") }] : [])]} />
  )
}
function PowerPlanW() {
  const t = useT()
  return <W title={t("电源计划", "Power plan")}><div className="wcenter"><PowerPlan /></div></W>
}

// ---- process rings
const RING_OPTS = ["cpu", "mem", "gpu", "vram", "power", "group"]
function ringLabel(opt: string) {
  if (opt.startsWith("ccd:")) return tf(`CCD${opt.slice(4)} 上的程序`, `Programs on CCD${opt.slice(4)}`)
  return ({ cpu: tf("CPU 占用", "CPU by program"), mem: tf("内存占用", "RAM by program"), gpu: tf("GPU 占用", "GPU by program"), vram: tf("显存占用", "VRAM by program"), power: tf("功耗指数", "Power by program"), group: tf("按核心分组", "CPU by core group") } as Record<string, string>)[opt] ?? opt
}
function ProcRing({ opt = "cpu" }: WProps) {
  const list = useProcs()
  const m = useLive((s) => s.metrics)
  const s = useLive((x) => x.sensors)
  const topo = useLive((x) => x.topo)
  const groups = useProfiles((x) => x.groups)
  const data = useMemo(() => {
    if (!list) return null
    const a = apps(list)
    if (opt === "group") {
      const segs: RSeg[] = groups.map((g) => ({ key: g.id, label: g.name, color: groupColor(g.hue), v: a.filter((x) => g.patterns.includes(x.name.toLowerCase())).reduce((t, x) => t + x.cpu, 0) }))
      const grouped = new Set(groups.flatMap((g) => g.patterns))
      segs.push({ key: "~none", label: tf("未分组", "Ungrouped"), color: "var(--ink-4)", v: a.filter((x) => !grouped.has(x.name.toLowerCase())).reduce((t, x) => t + x.cpu, 0) })
      const used = segs.reduce((t, x) => t + x.v, 0)
      segs.push({ key: "~idle", label: tf("空闲", "Idle"), color: "var(--line-2)", v: Math.max(0, 100 - used), dim: true })
      return { segs: segs.filter((x) => x.v > 0.05), total: 100, center: `${used.toFixed(0)}%`, fmtV: (v: number) => `${v.toFixed(1)}%` }
    }
    let val: (x: App) => number, total: number, fmtV: (v: number) => string
    if (opt.startsWith("ccd:") && topo) {
      // a program's load is spread over the threads its affinity allows; count the share on this CCD
      const ccd = topo.ccds.find((c) => String(c.ccdId) === opt.slice(4))
      const own = new Set(ccd?.logicalCpus ?? [])
      val = (x) => { const mask = x.masks[0]; if (!mask) return 0; const cpus = cpusOf(mask, topo.logicalCount); const k = cpus.filter((c) => own.has(c)).length; return cpus.length ? (x.cpu * topo.logicalCount * k) / cpus.length / Math.max(1, own.size) : 0 }
      total = 100; fmtV = (v) => `${v.toFixed(1)}%`
    } else if (opt === "mem") { val = (x) => x.mem; total = m?.memTotal ?? 1; fmtV = (v) => bytes(v) }
    else if (opt === "vram") { val = (x) => x.vram; total = s?.vramTotal ?? Math.max(1, a.reduce((t, x) => t + x.vram, 0)); fmtV = (v) => bytes(v) }
    else if (opt === "gpu") { val = (x) => x.gpu; total = 100; fmtV = (v) => `${v.toFixed(1)}%` }
    else if (opt === "power") { val = (x) => x.power; total = Math.max(1, a.reduce((t, x) => t + x.power, 0)); fmtV = (v) => v.toFixed(1) }
    else { val = (x) => x.cpu; total = 100; fmtV = (v) => `${v.toFixed(1)}%` }
    const ranked = a.map((x) => ({ x, v: val(x) })).filter((r) => r.v > 0).sort((p, q) => q.v - p.v)
    const top = ranked.slice(0, 6)
    const segs: RSeg[] = top.map(({ x, v }, i) => ({ key: x.name, label: x.label, path: x.path, v, color: RANK[i] }))
    const others = ranked.slice(6).reduce((t, r) => t + r.v, 0)
    if (others > 0) segs.push({ key: "~others", label: tf(`其他 ${ranked.length - 6} 个`, `${ranked.length - 6} others`), v: others, color: "var(--ink-4)" })
    const used = segs.reduce((t, x) => t + x.v, 0)
    if (total > used) segs.push({ key: "~free", label: tf("空闲", "Free"), v: total - used, color: "var(--line-2)", dim: true })
    return { segs, total: Math.max(total, used), center: opt === "mem" || opt === "vram" ? bytes(used) : opt === "power" ? used.toFixed(0) : `${used.toFixed(0)}%`, fmtV }
  }, [list, opt, m?.memTotal, s?.vramTotal, topo, groups])
  return (
    <W title={ringLabel(opt)} right={<button className="btn ghost sm" onClick={() => go(opt === "group" || opt.startsWith("ccd:") ? "cores" : "processes")}>→</button>}>
      {data ? <Ring segs={data.segs} total={data.total} center={data.center} sub={ringLabel(opt)} fmtV={data.fmtV} /> : <div className="skeleton" style={{ flex: 1 }} />}
    </W>
  )
}

function TopProcs({ opt = "cpu" }: WProps) {
  const t = useT()
  const list = useProcs()
  const m = useLive((s) => s.metrics)
  const rows = useMemo(() => {
    if (!list) return null
    const a = apps(list)
    const val = (x: App) => (opt === "mem" ? x.mem : opt === "gpu" ? x.gpu : opt === "vram" ? x.vram : x.cpu)
    return a.map((x) => ({ x, v: val(x) })).filter((r) => r.v > 0).sort((p, q) => q.v - p.v).slice(0, 8)
  }, [list, opt])
  const max = opt === "mem" ? m?.memTotal ?? 1 : opt === "vram" ? Math.max(1, ...(rows?.map((r) => r.v) ?? [1])) : 100
  const f = (v: number) => (opt === "mem" || opt === "vram" ? bytes(v) : `${v.toFixed(1)}%`)
  return (
    <W title={({ cpu: t("CPU 排行", "Top CPU"), mem: t("内存排行", "Top RAM"), gpu: t("GPU 排行", "Top GPU"), vram: t("显存排行", "Top VRAM") } as Record<string, string>)[opt] ?? opt} right={<button className="btn ghost sm" onClick={() => go("processes")}>→</button>}>
      {!rows ? <div className="skeleton" style={{ flex: 1 }} /> : (
        <ul className="toplist">
          {rows.map(({ x, v }, i) => (
            <li key={x.name}>
              <ProcIcon path={x.path} name={x.label} />
              <span className="ellipsis grow">{x.label}{x.n > 1 && <span className="faint num"> ×{x.n}</span>}</span>
              <b className="num">{f(v)}</b>
              <i style={{ transform: `scaleX(${Math.min(1, v / max)})`, background: RANK[i % RANK.length] }} />
            </li>
          ))}
        </ul>
      )}
    </W>
  )
}

function ClockW() {
  const t = useT()
  const s = useLive((x) => x.sensors)
  const h = useLive((x) => x.hist)
  const [cores, setCores] = useState<CpuSensor[]>([])
  usePoll(async () => setCores((await api.cpuSensors()).filter((c) => c.kind === "Clock" && /core/i.test(c.name) && isNum(c.value))), 2000)
  const win = h.clk.filter((v) => v > 0).slice(-60)
  const avg = win.length ? win.reduce((a, b) => a + b, 0) / win.length : null
  const peak = win.length ? Math.max(...win) : null
  const maxCore = Math.max(1, ...cores.map((c) => c.value ?? 0))
  return (
    <W title={t("CPU 频率", "CPU clock")} color="var(--cpu)">
      <div className="row" style={{ "--gap": "18px", alignItems: "baseline" } as CSSProperties}>
        <Readout v={s?.cpuClock ? s.cpuClock / 1000 : null} digits={2} u="GHz" size="md" />
        <span className="num faint" style={{ fontSize: 12 }}>{t("均值", "avg")} {fixed(avg ? avg / 1000 : null, 2)} · {t("峰值", "peak")} {fixed(peak ? peak / 1000 : null, 2)}</span>
      </div>
      <Grow min={30}>{(_, hh) => <Lines ids={["clk"]} height={hh} points={60} />}</Grow>
      {cores.length > 0 && (
        <div className="corebars" title={t("每核实时频率", "Per-core clock")}>
          {cores.map((c) => <i key={c.name} title={`${c.name} · ${c.value!.toFixed(0)} MHz`} style={{ transform: `scaleY(${Math.max(0.04, c.value! / maxCore)})` }} />)}
        </div>
      )}
    </W>
  )
}

function PowerW() {
  const t = useT()
  const s = useLive((x) => x.sensors)
  const h = useLive((x) => x.hist)
  const tick = useLive((x) => x.tick)
  const total = h.cpuW.map((v, i) => v + (h.gpuW[i] ?? 0))
  const max = Math.max(50, ...total) * 1.15
  return (
    <W title={t("功耗", "Power")} color="var(--warn)" right={<span className="num" style={{ fontSize: 13 }}>{fixed(isNum(s?.cpuPower) || isNum(s?.gpuPower) ? (s?.cpuPower ?? 0) + (s?.gpuPower ?? 0) : null, 0, " W")}</span>}>
      <div className="row" style={{ "--gap": "16px", fontSize: 12 } as CSSProperties}>
        <span><i className="kdot" style={{ background: "var(--cpu)" }} />CPU <b className="num">{fixed(s?.cpuPower, 0, " W")}</b></span>
        <span><i className="kdot" style={{ background: "var(--gpu)" }} />GPU <b className="num">{fixed(s?.gpuPower, 0, " W")}</b></span>
      </div>
      {/* stacked: total (GPU on top of CPU) behind, CPU in front */}
      <Grow min={24}>{(_, hh) => <Scope traces={[{ data: total, color: "--gpu", fill: true, width: 1.3 }, { data: h.cpuW, color: "--cpu", fill: true, width: 1.3 }]} max={max} height={hh} tick={tick} grid={false} />}</Grow>
    </W>
  )
}

const ENGINES = ["3D", "Copy", "Video Encode", "Video Decode", "Compute"]
const ENGINE_ZH: Record<string, string> = { "3D": "3D", Copy: "复制", "Video Encode": "视频编码", "Video Decode": "视频解码", Compute: "计算", "Video Processing": "视频处理", Security: "安全" }
function EnginesW() {
  const t = useT()
  const [cur, setCur] = useState<Record<string, number>>({})
  const hist = useRef<Record<string, number[]>>({})
  usePoll(async () => {
    const e = await api.gpuEngineLoads()
    for (const k of new Set([...ENGINES, ...Object.keys(e)])) hist.current[k] = [...(hist.current[k] ?? []).slice(-39), e[k] ?? 0]
    setCur(e)
  }, 1000)
  const keys = [...ENGINES, ...Object.keys(cur).filter((k) => !ENGINES.includes(k) && cur[k] > 0.5)]
  return (
    <W title={t("GPU 引擎", "GPU engines")} color="var(--gpu)">
      <div className="engrid">
        {keys.map((k) => (
          <div key={k} className="engcell">
            <div className="row spread"><span className="dim" style={{ fontSize: 12 }}>{t(ENGINE_ZH[k] ?? k, k)}</span><b className="num" style={{ fontSize: 13 }}>{(cur[k] ?? 0).toFixed(0)}%</b></div>
            <Spark data={hist.current[k] ?? []} color="var(--gpu)" w={160} h={26} max={100} />
          </div>
        ))}
      </div>
    </W>
  )
}

function FpsW() {
  const t = useT()
  const fg = useLive((s) => s.fg)
  const fps = useLive((s) => s.fps)
  const h = useLive((s) => s.hist)
  const tick = useLive((s) => s.tick)
  if (!fg?.isGame) return <W title={t("游戏帧率", "Game FPS")} color="var(--fps)"><Note><Gamepad2 size={22} strokeWidth={1.4} />{t("未检测到游戏 · 游戏全屏运行时自动显示", "No game detected · shows up when a game runs")}</Note></W>
  return (
    <W title={fg.exe ?? t("游戏帧率", "Game FPS")} color="var(--fps)" right={<span className="num faint" style={{ fontSize: 12 }}>{fixed(fps?.frametimeMs, 1, " ms")}</span>}>
      <div className="row" style={{ "--gap": "18px", alignItems: "baseline" } as CSSProperties}>
        <Readout v={fps?.fps} u="FPS" size="md" />
        <span className="num faint" style={{ fontSize: 12 }}>1% {fixed(fps?.low1, 0)} · 0.1% {fixed(fps?.low01, 0)}</span>
      </div>
      <Grow min={20}>{(_, hh) => <Scope traces={[{ data: h.fps.slice(-60), color: "--fps", fill: true, width: 1.4 }]} max={Math.max(60, ...h.fps.slice(-60)) * 1.1} height={hh} tick={tick} grid={false} points={60} />}</Grow>
    </W>
  )
}

function FansW() {
  const t = useT()
  const [st, setSt] = useState<FanState | null>(null)
  usePoll(async () => setSt(await api.fanInfo()), 2000)
  const fans = st?.channels.filter((c) => isNum(c.rpm) || isNum(c.pct)) ?? []
  return (
    <W title={t("风扇", "Fans")} right={<button className="btn ghost sm" onClick={() => go("thermals")}>→</button>}>
      {!st ? <div className="skeleton" style={{ flex: 1 }} /> : !st.available || !fans.length ? <Note><Fan size={22} strokeWidth={1.4} />{t("未检测到风扇读数（主板传感器不受支持或传感器进程未运行）", "No fan readings (board sensors unsupported or the sensor process isn't running)")}</Note> : (
        <ul className="toplist">
          {fans.map((c) => (
            <li key={c.id}>
              <Fan size={14} className="spin-slow" style={{ animationDuration: `${Math.max(0.35, 2400 / Math.max(300, c.rpm ?? 300))}s`, color: "var(--acc)" }} />
              <span className="ellipsis grow">{c.name}</span>
              <b className="num">{isNum(c.rpm) ? `${c.rpm.toFixed(0)} RPM` : "—"}</b>
              <i style={{ transform: `scaleX(${(c.pct ?? 0) / 100})`, background: "var(--acc)" }} />
            </li>
          ))}
        </ul>
      )}
    </W>
  )
}

function TempsW() {
  const t = useT()
  const s = useLive((x) => x.sensors)
  const [st, setSt] = useState<FanState | null>(null)
  usePoll(async () => setSt(await api.fanInfo()), 2500)
  const rows = [
    { id: "cpu", name: "CPU", c: s?.cpuTemp ?? null },
    { id: "gpu", name: "GPU", c: s?.gpuTemp ?? null },
    ...(st?.temps ?? []).filter((x) => isNum(x.c) && x.c > 0 && x.c < 130).map((x) => ({ id: x.id, name: x.name, c: x.c })),
  ].filter((r) => isNum(r.c))
  return (
    <W title={t("全部温度", "All temperatures")} color="var(--warn)">
      {!rows.length ? <Note><Thermometer size={22} strokeWidth={1.4} />{t("没有可用的温度传感器", "No temperature sensors available")}</Note> : (
        <ul className="toplist">
          {rows.map((r) => (
            <li key={r.id}>
              <Thermometer size={14} style={{ color: heat(Math.max(0, (r.c! - 25) * 1.4)) }} />
              <span className="ellipsis grow">{r.name}</span>
              <b className="num">{r.c!.toFixed(0)}°C</b>
              <i style={{ transform: `scaleX(${Math.min(1, r.c! / 100)})`, background: heat(Math.max(0, (r.c! - 25) * 1.4)) }} />
            </li>
          ))}
        </ul>
      )}
    </W>
  )
}

function MemoryW() {
  const t = useT()
  const [mem, setMem] = useState<MemDetail | null>(null)
  usePoll(async () => setMem(await api.memory()), 3000)
  const list = useProcs()
  const top = useMemo(() => (list ? apps(list).sort((a, b) => b.mem - a.mem).slice(0, 3) : []), [list])
  if (!mem) return <W title={t("内存", "Memory")} color="var(--mem)"><div className="skeleton" style={{ flex: 1 }} /></W>
  const segs: RSeg[] = [...top.map((a, i) => ({ key: a.name, label: a.label, path: a.path, v: a.mem, color: RANK[i] })), { key: "~rest", label: tf("其他已用", "Other in use"), v: Math.max(0, mem.used - top.reduce((x, a) => x + a.mem, 0)), color: "var(--mem)" }, { key: "~free", label: tf("可用", "Available"), v: mem.avail, color: "var(--line-2)", dim: true }]
  return <W title={t("内存", "Memory")} color="var(--mem)"><Ring segs={segs} total={mem.total} center={`${mem.loadPct.toFixed(0)}%`} sub={`${bytes(mem.used)} / ${bytes(mem.total, 0)}`} fmtV={(v) => bytes(v)} /></W>
}

function VolumesW() {
  const t = useT()
  const [vols, setVols] = useState<Volume[] | null>(null)
  usePoll(async () => setVols(await api.volumes()), 30_000)
  return (
    <W title={t("磁盘空间", "Disk space")} color="var(--disk)" right={<button className="btn ghost sm" onClick={() => go("disk")}>→</button>}>
      {!vols ? <div className="skeleton" style={{ flex: 1 }} /> : (
        <ul className="toplist vols">
          {vols.filter((v) => v.total > 0).map((v) => {
            const used = (v.total - v.free) / v.total
            return (
              <li key={v.root}>
                <HardDrive size={14} style={{ color: "var(--disk)" }} />
                <span className="ellipsis grow"><b>{v.letter || v.root}</b> <span className="faint">{v.label}</span></span>
                <b className="num">{bytes(v.free, 0)} <span className="faint">{t("可用", "free")}</span></b>
                <i style={{ transform: `scaleX(${used})`, background: used > 0.9 ? "var(--crit)" : used > 0.75 ? "var(--warn)" : "var(--disk)" }} />
              </li>
            )
          })}
        </ul>
      )}
    </W>
  )
}

function GpuStateW() {
  const t = useT()
  const [g, setG] = useState<GpuInfo | null>(null)
  usePoll(async () => setG(await api.gpuInfo()), 1500)
  if (g && !g.available) return <W title={t("显卡状态", "GPU state")} color="var(--gpu)"><Note><MonitorCog size={22} strokeWidth={1.4} />{t("需要 NVIDIA 显卡与驱动（NVML）。其他显卡的占用与温度仍显示在其他小组件中。", "Needs an NVIDIA GPU and driver (NVML). Other GPUs still show load and temperature in the other widgets.")}</Note></W>
  if (!g) return <W title={t("显卡状态", "GPU state")} color="var(--gpu)"><div className="skeleton" style={{ flex: 1 }} /></W>
  const kv = (k: string, v: string) => <div className="kvrow"><span className="faint">{k}</span><b className="num">{v}</b></div>
  return (
    <W title={g.name} color="var(--gpu)">
      <div className="row" style={{ "--gap": "14px", flex: 1, minHeight: 0, alignItems: "center" } as CSSProperties}>
        <Gauge v={g.powerUsageW} max={Math.max(1, g.powerLimitW)} color="var(--gpu)" value={g.powerUsageW.toFixed(0)} unit={`/ ${g.powerLimitW.toFixed(0)} W`} />
        <div className="col grow" style={{ "--gap": "5px", fontSize: 12.5 } as CSSProperties}>
          {kv(t("核心频率", "Core clock"), `${g.graphicsClock} MHz`)}
          {kv(t("显存频率", "Memory clock"), `${g.memClock} MHz`)}
          {kv(t("温度", "Temp"), `${g.temperature} °C`)}
          {kv(t("风扇", "Fan"), `${g.fanSpeedPct}%`)}
          {kv(t("显存", "VRAM"), `${bytes(g.memUsedBytes)} / ${bytes(g.memTotalBytes, 0)}`)}
          {kv(t("显存控制器", "Memory controller"), `${g.utilizationMem}%`)}
          {kv(t("驱动", "Driver"), g.driverVersion || "—")}
        </div>
      </div>
    </W>
  )
}

function CpuSensorsW() {
  const t = useT()
  const [list, setList] = useState<CpuSensor[] | null>(null)
  usePoll(async () => setList(await api.cpuSensors()), 2000)
  const KINDS: [string, string, string, (v: number) => string][] = [["Voltage", "电压", "Voltage", (v) => `${v.toFixed(3)} V`], ["Power", "功耗", "Power", (v) => `${v.toFixed(1)} W`], ["Temperature", "温度", "Temperature", (v) => `${v.toFixed(1)} °C`], ["Current", "电流", "Current", (v) => `${v.toFixed(1)} A`], ["Clock", "频率", "Clock", (v) => `${v.toFixed(0)} MHz`], ["Factor", "倍频", "Factor", (v) => v.toFixed(2)]]
  if (list && !list.length) return <W title={t("CPU 深度传感器", "CPU deep sensors")} color="var(--cpu)"><Note><Cpu size={22} strokeWidth={1.4} />{t("传感器进程未提供 CPU 深度读数（需要受支持的 CPU 与 PawnIO 驱动）", "The sensor process reports no deep CPU readings (needs a supported CPU and the PawnIO driver)")}</Note></W>
  return (
    <W title={t("CPU 深度传感器", "CPU deep sensors")} color="var(--cpu)">
      {!list ? <div className="skeleton" style={{ flex: 1 }} /> : (
        <div className="sensgrid">
          {KINDS.map(([k, zh, en, f]) => {
            const rows = list.filter((x) => x.kind === k && isNum(x.value))
            if (!rows.length) return null
            return (
              <div key={k} className="col" style={{ "--gap": "3px" } as CSSProperties}>
                <span className="label">{t(zh, en)}</span>
                {rows.slice(0, 8).map((r) => <div key={r.name} className="kvrow"><span className="faint ellipsis">{r.name}</span><b className="num">{f(r.value!)}</b></div>)}
              </div>
            )
          })}
        </div>
      )}
    </W>
  )
}

function GroupsW() {
  const t = useT()
  const groups = useProfiles((s) => s.groups)
  const coreOpt = useLive((s) => s.coreOpt)
  const topo = useLive((s) => s.topo)
  const list = useProcs()
  const a = useMemo(() => (list ? apps(list) : []), [list])
  return (
    <W title={t("核心分组", "Core groups")} right={<Switch on={coreOpt} onChange={(v) => useLive.setState({ coreOpt: v })} label={t("核心优化", "Core optimization")} />}>
      {!groups.length ? <Note><Layers size={22} strokeWidth={1.4} /><span>{t("还没有分组 · ", "No groups yet · ")}<button className="btn ghost sm" onClick={() => go("cores")}>{t("去创建", "Create one")}</button></span></Note> : (
        <ul className="toplist">
          {groups.map((g) => {
            const mine = a.filter((x) => g.patterns.includes(x.name.toLowerCase()))
            const cpu = mine.reduce((s, x) => s + x.cpu, 0)
            return (
              <li key={g.id} onClick={() => go("cores")} style={{ cursor: "pointer" }}>
                <i className="kdot" style={{ background: groupColor(g.hue), boxShadow: `0 0 8px ${groupColor(g.hue)}` }} />
                <span className="ellipsis grow">{g.name} <span className="faint num">{topo ? `${cpusOf(g.mask, topo.logicalCount).length}T` : ""}</span></span>
                <b className="num">{mine.length}/{g.patterns.length} · {cpu.toFixed(0)}%</b>
                <i style={{ transform: `scaleX(${Math.min(1, cpu / 100)})`, background: groupColor(g.hue) }} />
              </li>
            )
          })}
        </ul>
      )}
    </W>
  )
}

function ClockFace() {
  const t = useT()
  const [now, setNow] = useState(() => new Date())
  useEffect(() => { const id = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(id) }, [])
  const p = (n: number) => String(n).padStart(2, "0")
  return (
    <W title={t("时钟", "Clock")}>
      <div className="wcenter col" style={{ "--gap": "4px" } as CSSProperties}>
        <Roll value={`${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`} className="clockface num" />
        <span className="faint">{now.toLocaleDateString(tf("zh-CN", "en-US"), { weekday: "long", year: "numeric", month: "long", day: "numeric" })}</span>
      </div>
    </W>
  )
}

function SysInfoW() {
  const t = useT()
  const ov = useLive((s) => s.overview)
  const topo = useLive((s) => s.topo)
  const s = useLive((x) => x.sensors)
  const kv = (k: string, v: ReactNode) => <div className="kvrow"><span className="faint">{k}</span><b className="ellipsis" style={{ fontWeight: 500 }}>{v}</b></div>
  return (
    <W title={t("系统信息", "System info")}>
      <div className="col" style={{ "--gap": "6px", fontSize: 12.5 } as CSSProperties}>
        {kv(t("处理器", "CPU"), ov?.cpuName ?? "—")}
        {kv(t("核心", "Cores"), ov ? `${ov.physicalCores} ${t("核", "C")} / ${ov.logicalCpus} ${t("线程", "T")}${topo?.vcacheCcd != null ? ` · V-Cache CCD${topo.vcacheCcd}` : ""}` : "—")}
        {kv(t("显卡", "GPU"), s?.gpuName ?? "—")}
        {kv(t("内存", "Memory"), ov ? bytes(ov.ramTotal, 0) : "—")}
        {kv(t("系统", "OS"), ov?.os ?? "—")}
        {kv(t("拓扑检测", "Topology"), topo?.detection ?? "—")}
      </div>
    </W>
  )
}

function OneClickW() { return <div className="wfill"><OneClick /></div> }

// ---- single-metric widgets (also what the custom builder composes)
const STAT_OPTS = METRICS.map((m) => m.id)
function StatW({ opt = "cpu" }: WProps) {
  const t = useT()
  const m = metric(opt)
  useLive((s) => s.tick)
  const [v, u] = fmt(m, m.cur())
  return (
    <W title={t(m.zh, m.en)} color={m.color}>
      <div className="readout"><span className="v">{v}</span><span className="u">{u}</span></div>
      <Grow min={14}>{(_, hh) => <Lines ids={[m.id]} height={hh} points={60} />}</Grow>
    </W>
  )
}
function GaugeW({ opt = "cpuT" }: WProps) {
  const t = useT()
  const m = metric(opt)
  const h = useLive((s) => s.hist)
  const v = m.cur()
  const [val, unit] = fmt(m, v)
  const max = m.fixedMax ?? ceil(m, histOf(m, h))
  return <W title={t(m.zh, m.en)} color={m.color}><div className="wcenter"><Gauge v={v} max={max} color={m.unit === "°C" && isNum(v) ? heat(Math.max(0, (v - 25) * 1.4)) : m.color} value={val} unit={unit} /></div></W>
}

// ---- user-built widgets
export type Viz = "number" | "line" | "gauge" | "bars"
export interface CustomSpec { title: string; viz: Viz; metrics: string[]; win: 60 | 120 }
export const parseSpec = (opt?: string): CustomSpec => {
  try { const s = JSON.parse(opt ?? ""); if (s && Array.isArray(s.metrics) && s.metrics.length) return { title: String(s.title ?? ""), viz: ["number", "line", "gauge", "bars"].includes(s.viz) ? s.viz : "line", metrics: s.metrics.filter((x: string) => METRICS.some((m) => m.id === x)).slice(0, 4), win: s.win === 60 ? 60 : 120 } } catch { /* fall through */ }
  return { title: "", viz: "line", metrics: ["cpu"], win: 120 }
}
export function CustomW({ opt }: WProps) {
  const t = useT()
  const spec = parseSpec(opt)
  const h = useLive((s) => s.hist)
  useLive((s) => s.tick)
  const ms = spec.metrics.map(metric)
  const title = spec.title || ms.map((m) => t(m.zh, m.en)).join(" · ")
  if (spec.viz === "gauge") {
    const m = ms[0]
    const v = m.cur()
    const [val, unit] = fmt(m, v)
    return <W title={title} color={m.color}><div className="wcenter"><Gauge v={v} max={m.fixedMax ?? ceil(m, histOf(m, h))} color={m.color} value={val} unit={unit} /></div></W>
  }
  if (spec.viz === "bars") return (
    <W title={title}>
      <ul className="toplist">
        {ms.map((m) => { const v = m.cur(); const [a, b] = fmt(m, v); return (
          <li key={m.id}><i className="kdot" style={{ background: m.color }} /><span className="ellipsis grow">{t(m.zh, m.en)}</span><b className="num">{a} <span className="faint">{b}</span></b><i style={{ transform: `scaleX(${isNum(v) ? Math.min(1, v / (m.fixedMax ?? ceil(m, histOf(m, h)))) : 0})`, background: m.color }} /></li>
        ) })}
      </ul>
    </W>
  )
  const legend = (
    <div className="row wrap" style={{ "--gap": "14px" } as CSSProperties}>
      {ms.map((m, i) => { const [a, b] = fmt(m, m.cur()); return (
        <span key={m.id} className={spec.viz === "number" && i === 0 ? "readout" : ""} style={spec.viz === "number" && i === 0 ? undefined : { fontSize: 12 }}>
          {spec.viz === "number" && i === 0 ? <><span className="v">{a}</span><span className="u">{b}</span></> : <><i className="kdot" style={{ background: m.color }} />{ms.length > 1 && <span className="faint">{t(m.zh, m.en)} </span>}<b className="num">{a}</b> <span className="faint">{b}</span></>}
        </span>
      ) })}
    </div>
  )
  return <W title={title} color={ms[0].color}>{legend}<Grow min={14}>{(_, hh) => <Lines ids={spec.metrics} height={hh} points={spec.win} />}</Grow></W>
}

// ============================================================ catalog
export type Group = "live" | "proc" | "hw" | "act"
export type Size = "s" | "m" | "l" | "w"
export interface WDef {
  type: string; zh: string; en: string; dzh: string; den: string; group: Group; icon: LucideIcon
  /** size → [columns of 12, rows] */
  sizes: Partial<Record<Size, [number, number]>>; def: Size
  opts?: () => { v: string; label: string }[]; defOpt?: string
  C: (p: WProps) => ReactNode
}
const SM = { s: [3, 5], m: [4, 5], l: [6, 5] } as Partial<Record<Size, [number, number]>>
export const WIDGETS: WDef[] = [
  { type: "vitals", zh: "关键指标", en: "Vitals", dzh: "CPU、显卡、内存与网络/帧率的实时数值与曲线", den: "Live CPU, GPU, RAM and network / FPS with traces", group: "live", icon: Activity, sizes: { w: [12, 4] }, def: "w", C: Vitals },
  { type: "scope", zh: "实时负载", en: "Live load", dzh: "CPU / GPU / 内存 120 秒示波曲线", den: "120 s CPU / GPU / RAM scope", group: "live", icon: Waves, sizes: { m: [6, 5], l: [8, 5], w: [12, 5] }, def: "l", C: LoadScope },
  { type: "stat", zh: "单项指标", en: "Single metric", dzh: "任选一项指标：大号数值 + 迷你曲线", den: "Any metric as a big number with a sparkline", group: "live", icon: BarChart3, sizes: { s: [3, 3], m: [4, 3], l: [6, 3] }, def: "s", opts: () => STAT_OPTS.map((v) => ({ v, label: tf(metric(v).zh, metric(v).en) })), defOpt: "cpu", C: StatW },
  { type: "gauge", zh: "仪表盘", en: "Gauge", dzh: "任选一项指标的环形仪表", den: "Any metric as a dial", group: "live", icon: GaugeIcon, sizes: { s: [3, 4], m: [4, 4] }, def: "s", opts: () => STAT_OPTS.map((v) => ({ v, label: tf(metric(v).zh, metric(v).en) })), defOpt: "cpuT", C: GaugeW },
  { type: "clock", zh: "CPU 频率曲线", en: "CPU clock curve", dzh: "频率历史、均值/峰值与每核实时频率", den: "Clock history, avg / peak and per-core clocks", group: "live", icon: Zap, sizes: { m: [4, 5], l: [6, 5], w: [8, 5] }, def: "m", C: ClockW },
  { type: "thermal", zh: "温度与功耗", en: "Thermals & power", dzh: "CPU / GPU 温度、功耗与趋势", den: "CPU / GPU temperature, power and trend", group: "live", icon: Thermometer, sizes: { s: [3, 5], m: [4, 5], l: [6, 5] }, def: "m", C: Thermal },
  { type: "power", zh: "功耗堆叠", en: "Power stack", dzh: "CPU + GPU 实时功耗堆叠面积图", den: "Stacked CPU + GPU power", group: "live", icon: Power, sizes: { m: [4, 4], l: [6, 4], w: [8, 4] }, def: "m", C: PowerW },
  { type: "io", zh: "读写与网络", en: "I/O & network", dzh: "磁盘读写与网络上下行曲线", den: "Disk read/write and network up/down", group: "live", icon: Globe, sizes: { m: [4, 4], l: [6, 4] }, def: "m", C: IO },
  { type: "fps", zh: "游戏帧率", en: "Game FPS", dzh: "当前游戏帧率、1% / 0.1% 低帧与帧时间", den: "Current game FPS, 1% / 0.1% lows and frametime", group: "live", icon: Gamepad2, sizes: { s: [3, 4], m: [4, 4], l: [6, 4] }, def: "m", C: FpsW },
  { type: "ring", zh: "进程占用环形图", en: "Process ring", dzh: "哪些程序占用了 CPU / 内存 / GPU / 显存 / 功耗，或按核心分组 / CCD", den: "Which programs hold CPU / RAM / GPU / VRAM / power, or by core group / CCD", group: "proc", icon: PieChart, sizes: SM, def: "m",
    opts: () => [...RING_OPTS, ...(useLive.getState().topo?.ccds.map((c) => `ccd:${c.ccdId}`) ?? [])].map((v) => ({ v, label: ringLabel(v) })), defOpt: "cpu", C: ProcRing },
  { type: "top", zh: "进程排行", en: "Top processes", dzh: "按 CPU / 内存 / GPU / 显存排序的前 8 个程序", den: "Top 8 programs by CPU / RAM / GPU / VRAM", group: "proc", icon: ListOrdered, sizes: SM, def: "m",
    opts: () => [["cpu", "CPU"], ["mem", tf("内存", "RAM")], ["gpu", "GPU"], ["vram", tf("显存", "VRAM")]].map(([v, label]) => ({ v, label })), defOpt: "cpu", C: TopProcs },
  { type: "groups", zh: "核心分组", en: "Core groups", dzh: "各分组运行中的程序与占用，一键开关核心优化", den: "Running programs and load per group, with the master switch", group: "proc", icon: Layers, sizes: SM, def: "m", C: GroupsW },
  { type: "cores", zh: "核心负载", en: "Core load", dzh: "按 CCD 排列的每线程实时负载", den: "Per-thread live load by CCD", group: "hw", icon: Cpu, sizes: { m: [6, 4], l: [8, 4], w: [12, 4] }, def: "l", C: CoreMap },
  { type: "heat", zh: "核心热力图", en: "Core heat timeline", dzh: "每个线程 90 秒负载热力时间轴", den: "90 s load heat timeline per thread", group: "hw", icon: LayoutGrid, sizes: { m: [6, 4], l: [8, 5], w: [12, 5] }, def: "l", C: CoreHeat },
  { type: "engines", zh: "GPU 引擎", en: "GPU engines", dzh: "3D / 复制 / 视频编码 / 解码 / 计算 各引擎占用", den: "3D / Copy / Video Encode / Decode / Compute load", group: "hw", icon: MonitorCog, sizes: { m: [4, 5], l: [6, 4], w: [8, 4] }, def: "m", C: EnginesW },
  { type: "gpu", zh: "显卡状态", en: "GPU state", dzh: "频率、功耗/上限、温度、风扇、显存与驱动（NVIDIA）", den: "Clocks, power / limit, temp, fan, VRAM, driver (NVIDIA)", group: "hw", icon: MonitorCog, sizes: { m: [4, 5], l: [6, 5] }, def: "m", C: GpuStateW },
  { type: "cpusens", zh: "CPU 深度传感器", en: "CPU deep sensors", dzh: "电压、功耗、温度、电流与每核频率", den: "Voltages, power, temperatures, current and per-core clocks", group: "hw", icon: Cpu, sizes: { m: [4, 5], l: [6, 5], w: [8, 5] }, def: "l", C: CpuSensorsW },
  { type: "memory", zh: "内存构成", en: "Memory", dzh: "占用最多的程序与可用内存", den: "Biggest programs and available memory", group: "hw", icon: MemoryStick, sizes: SM, def: "m", C: MemoryW },
  { type: "temps", zh: "全部温度", en: "All temperatures", dzh: "CPU、GPU 与主板全部温度传感器", den: "CPU, GPU and every motherboard sensor", group: "hw", icon: Thermometer, sizes: SM, def: "m", C: TempsW },
  { type: "fans", zh: "风扇", en: "Fans", dzh: "每个风扇的转速与占空比", den: "Speed and duty of every fan", group: "hw", icon: Fan, sizes: SM, def: "m", C: FansW },
  { type: "volumes", zh: "磁盘空间", en: "Disk space", dzh: "各分区可用空间", den: "Free space per volume", group: "hw", icon: HardDrive, sizes: { s: [3, 4], m: [4, 4], l: [6, 4] }, def: "m", C: VolumesW },
  { type: "sysinfo", zh: "系统信息", en: "System info", dzh: "处理器、显卡、内存、系统与拓扑", den: "CPU, GPU, memory, OS and topology", group: "hw", icon: Info, sizes: { m: [4, 4], l: [6, 4] }, def: "m", C: SysInfoW },
  { type: "oneclick", zh: "一键优化", en: "One-click optimize", dzh: "释放内存、清理缓存与临时文件、切换卓越性能", den: "Free memory, clean caches and temp, Ultimate Performance", group: "act", icon: Wand2, sizes: { w: [12, 2], l: [8, 2] }, def: "w", C: OneClickW },
  { type: "quick", zh: "快捷操作", en: "Quick actions", dzh: "释放工作集、清空待机内存、清理临时文件、刷新 DNS", den: "Trim working sets, purge standby, clean temp, flush DNS", group: "act", icon: Sparkles, sizes: { w: [12, 2], l: [8, 4] }, def: "w", C: Quick },
  { type: "powerplan", zh: "电源计划", en: "Power plan", dzh: "平衡 / 高性能 / 卓越性能 一键切换", den: "Balanced / High / Ultimate in one tap", group: "act", icon: Power, sizes: { s: [3, 2], m: [4, 2], l: [6, 2] }, def: "m", C: PowerPlanW },
  { type: "clockface", zh: "时钟", en: "Clock", dzh: "数字时钟与日期", den: "Digital clock and date", group: "act", icon: Clock3, sizes: { s: [3, 2], m: [4, 2] }, def: "s", C: ClockFace },
  { type: "custom", zh: "自定义小组件", en: "Custom widget", dzh: "自选指标与图表样式组合出你自己的小组件", den: "Pick metrics and a chart style to build your own", group: "live", icon: Sparkles, sizes: { s: [3, 4], m: [4, 4], l: [6, 5], w: [12, 5] }, def: "m", C: CustomW },
]
export const wdef = (type: string) => WIDGETS.find((w) => w.type === type)
export const GROUPS: [Group, string, string][] = [["live", "实时监控", "Live"], ["proc", "进程", "Processes"], ["hw", "硬件", "Hardware"], ["act", "操作", "Actions"]]

/** Fits a widget whose stored size is no longer offered. */
export const sizeOf = (d: WDef, s: Size): [number, number] => d.sizes[s] ?? d.sizes[d.def]!

