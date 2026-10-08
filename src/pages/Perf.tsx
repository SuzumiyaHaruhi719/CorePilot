// 进程 → 性能: Task-Manager-style device view. A device list with live sparklines on
// the left, the selected device's 60 s chart, readouts and extras on the right
// (per-thread charts for the CPU; per-engine graphs, VRAM and NVML stats for the GPU).
import { useState, type CSSProperties, type ReactNode } from "react"
import { AnimatePresence, motion } from "motion/react"
import { Check, SlidersHorizontal } from "lucide-react"
import { api, type GpuInfo } from "../lib/ipc"
import { useLive, useSettings, useT, type PerfDevice } from "../lib/store"
import { bytes, fixed, isNum, rate } from "../lib/util"
import { contextMenu, GLIDE, Mini, Scope, Spark, swapVariants, usePoll } from "../ui/kit"

const DEVICES: { id: PerfDevice; zh: string; en: string; color: string }[] = [
  { id: "cpu", zh: "CPU", en: "CPU", color: "var(--cpu)" },
  { id: "mem", zh: "内存", en: "Memory", color: "var(--mem)" },
  { id: "gpu", zh: "显卡", en: "GPU", color: "var(--gpu)" },
  { id: "disk", zh: "磁盘", en: "Disk", color: "var(--disk)" },
  { id: "net", zh: "网络", en: "Network", color: "var(--net)" },
  { id: "power", zh: "功耗", en: "Power", color: "var(--warn)" },
]
const ENGINES = ["3D", "Copy", "Video Encode", "Video Decode", "Compute"]
const ENGINE_ZH: Record<string, string> = { "3D": "3D", Copy: "复制", "Video Encode": "视频编码", "Video Decode": "视频解码", Compute: "计算" }
/** engine load history, kept across pane switches (only polled while the GPU pane is open) */
const engHist: Record<string, number[]> = {}
const peak = (d: number[], floor: number) => Math.max(floor, ...d) * 1.15
const Kv = ({ k, v, sub, color }: { k: string; v: ReactNode; sub?: ReactNode; color?: string }) => (
  <div className="pkv"><span>{k}</span><b className="num" style={{ color }}>{v}</b>{sub && <em className="num">{sub}</em>}</div>
)

export function Perf() {
  const t = useT()
  const shown = useSettings((s) => s.perfDevices)
  const list = DEVICES.filter((d) => shown[d.id] !== false)
  const [sel, setSel] = useState<PerfDevice>("cpu")
  const cur = list.find((d) => d.id === sel) ?? list[0]
  const m = useLive((s) => s.metrics)
  const s = useLive((x) => x.sensors)
  const h = useLive((x) => x.hist)
  const memPct = m?.memTotal ? (m.memUsed / m.memTotal) * 100 : null
  // the live value + trace each device shows in the list
  const brief: Record<PerfDevice, { v: string; sub: string; data: number[]; max?: number }> = {
    cpu: { v: fixed(m?.cpuOverall, 0, "%"), sub: fixed(s?.cpuClock ? s.cpuClock / 1000 : null, 2, " GHz"), data: h.cpu, max: 100 },
    mem: { v: fixed(memPct, 0, "%"), sub: `${bytes(m?.memUsed ?? null)} / ${bytes(m?.memTotal ?? null, 0)}`, data: h.mem, max: 100 },
    gpu: { v: fixed(s?.gpuPct, 0, "%"), sub: fixed(s?.gpuTemp, 0, " °C"), data: h.gpu, max: 100 },
    disk: { v: fixed(s?.diskPct, 0, "%"), sub: `R ${rate(s?.diskRead)}`, data: h.dsk, max: 100 },
    net: { v: rate(s?.netDown), sub: `▲ ${rate(s?.netUp)}`, data: h.down },
    power: { v: fixed(isNum(s?.cpuPower) || isNum(s?.gpuPower) ? (s?.cpuPower ?? 0) + (s?.gpuPower ?? 0) : null, 0, " W"), sub: `CPU ${fixed(s?.cpuPower, 0)} · GPU ${fixed(s?.gpuPower, 0)}`, data: h.cpuW.map((v, i) => v + (h.gpuW[i] ?? 0)) },
  }
  const pick = (e: React.MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    contextMenu({ clientX: r.left, clientY: r.bottom + 6, preventDefault() {}, stopPropagation() {} }, DEVICES.map((d) => ({
      label: t(d.zh, d.en), icon: shown[d.id] !== false ? <Check /> : <span />,
      // keep at least one device listed
      disabled: shown[d.id] !== false && list.length === 1,
      onClick: () => useSettings.getState().set({ perfDevices: { ...shown, [d.id]: shown[d.id] === false } }),
    })))
  }
  return (
    <div className="perf">
      <div className="plist">
        {list.map((d) => {
          const b = brief[d.id]
          const on = cur?.id === d.id
          return (
            <button key={d.id} className={`pdev rv ${on ? "on" : ""}`} onClick={() => setSel(d.id)} style={{ "--c": d.color } as CSSProperties}>
              {on && <motion.span layoutId="pdev-pill" className="pdev-pill" transition={GLIDE} />}
              <span className="col grow" style={{ "--gap": "2px", minWidth: 0, position: "relative" } as CSSProperties}>
                <b>{t(d.zh, d.en)}</b>
                <span className="num pv">{b.v}</span>
                <span className="faint ellipsis num" style={{ fontSize: 11 }}>{b.sub}</span>
              </span>
              <span style={{ position: "relative" }}><Spark data={b.data.slice(-40)} color={d.color} w={72} h={30} max={b.max ?? peak(b.data.slice(-40), 1)} /></span>
            </button>
          )
        })}
        <button className="btn ghost sm" style={{ alignSelf: "flex-start", marginTop: 4 }} onClick={pick}><SlidersHorizontal size={13} />{t("显示的设备", "Shown devices")}</button>
      </div>
      <div className="pmain panel pad">
        <AnimatePresence mode="wait" initial={false}>
          {cur && (
            <motion.div key={cur.id} className="col" style={{ "--gap": "16px" } as CSSProperties} variants={swapVariants(14, 0)} initial="hidden" animate="show" exit="exit">
              {cur.id === "cpu" && <CpuPane />}
              {cur.id === "mem" && <MemPane />}
              {cur.id === "gpu" && <GpuPane />}
              {cur.id === "disk" && <IoPane kind="disk" />}
              {cur.id === "net" && <IoPane kind="net" />}
              {cur.id === "power" && <PowerPane />}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}

function Head({ title, model, right }: { title: string; model?: string | null; right?: ReactNode }) {
  return (
    <div className="row spread" style={{ alignItems: "flex-end" }}>
      <div className="col" style={{ "--gap": "2px", minWidth: 0 } as CSSProperties}><b style={{ font: "600 22px var(--f-num)" }}>{title}</b>{model && <span className="faint ellipsis">{model}</span>}</div>
      {right}
    </div>
  )
}
function Big({ traces, max, label }: { traces: { data: number[]; color: string; fill?: boolean }[]; max?: number; label: string }) {
  const tick = useLive((s) => s.tick)
  return (
    <div className="pchart">
      <div className="row spread faint" style={{ fontSize: 11, marginBottom: 4 }}><span>{label}</span><span className="num">60 s</span></div>
      <Scope traces={traces.map((x) => ({ ...x, data: x.data.slice(-60), width: 1.5 }))} max={max} height={210} tick={tick} points={60} />
    </div>
  )
}

function CpuPane() {
  const t = useT()
  const ov = useLive((s) => s.overview)
  const topo = useLive((s) => s.topo)
  const m = useLive((s) => s.metrics)
  const s = useLive((x) => x.sensors)
  const h = useLive((x) => x.hist)
  const ch = useLive((x) => x.coreHist)
  return (
    <>
      <Head title="CPU" model={ov?.cpuName} right={<span className="num" style={{ font: "600 26px var(--f-num)", color: "var(--cpu)" }}>{fixed(m?.cpuOverall, 0, "%")}</span>} />
      <Big traces={[{ data: h.cpu, color: "--cpu", fill: true }]} max={100} label={t("利用率", "Utilization")} />
      <div className="pkvs">
        <Kv k={t("频率", "Clock")} v={fixed(s?.cpuClock ? s.cpuClock / 1000 : null, 2, " GHz")} />
        <Kv k={t("温度", "Temperature")} v={fixed(s?.cpuTemp, 0, " °C")} />
        <Kv k={t("功耗", "Power")} v={fixed(s?.cpuPower, 0, " W")} />
        <Kv k={t("核心", "Cores")} v={ov?.physicalCores ?? "—"} />
        <Kv k={t("逻辑处理器", "Logical processors")} v={ov?.logicalCpus ?? "—"} />
        <Kv k={t("超线程", "SMT")} v={topo ? (topo.smt ? t("开启", "On") : t("关闭", "Off")) : "—"} />
        {topo?.vcacheCcd != null && <Kv k="V-Cache" v={`CCD${topo.vcacheCcd}`} color="var(--acc)" />}
      </div>
      <div className="col" style={{ "--gap": "8px" } as CSSProperties}>
        <span className="label">{t("逻辑处理器利用率", "Per logical processor")}</span>
        {topo?.ccds.map((c) => (
          <div key={c.ccdId} className="col" style={{ "--gap": "6px" } as CSSProperties}>
            <span className="faint" style={{ fontSize: 11.5, color: c.isVcache ? "var(--acc)" : undefined }}>{c.label || `CCD ${c.ccdId}`}</span>
            <div className="lpgrid">
              {c.logicalCpus.map((i) => (
                <div key={i} className="lp" title={`CPU ${i}`}>
                  <span className="num">{(m?.perCore[i] ?? 0).toFixed(0)}<i>%</i></span>
                  <Mini data={ch[i] ?? []} color="var(--cpu)" h={34} />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

function MemPane() {
  const t = useT()
  const m = useLive((s) => s.metrics)
  const h = useLive((x) => x.hist)
  const used = m?.memUsed ?? null, total = m?.memTotal ?? null
  return (
    <>
      <Head title={t("内存", "Memory")} model={total ? bytes(total, 0) : null} right={<span className="num" style={{ font: "600 26px var(--f-num)", color: "var(--mem)" }}>{bytes(used)}</span>} />
      <Big traces={[{ data: h.mem, color: "--mem", fill: true }]} max={100} label={t("内存使用量", "Memory usage")} />
      <div className="pkvs">
        <Kv k={t("已用", "In use")} v={bytes(used)} sub={total && used ? `${((used / total) * 100).toFixed(0)}%` : undefined} />
        <Kv k={t("可用", "Available")} v={total != null && used != null ? bytes(Math.max(0, total - used)) : "—"} />
        <Kv k={t("总计", "Total")} v={bytes(total, 0)} />
      </div>
    </>
  )
}

function GpuPane() {
  const t = useT()
  const s = useLive((x) => x.sensors)
  const h = useLive((x) => x.hist)
  const [g, setG] = useState<GpuInfo | null>(null)
  const [eng, setEng] = useState<Record<string, number>>({})
  usePoll(async () => setG(await api.gpuInfo()), 1500)
  usePoll(async () => {
    const e = await api.gpuEngineLoads()
    for (const k of new Set([...ENGINES, ...Object.keys(e)])) engHist[k] = [...(engHist[k] ?? []).slice(-59), e[k] ?? 0]
    setEng(e)
  }, 1000)
  const nv = g?.available ? g : null
  const keys = [...ENGINES, ...Object.keys(eng).filter((k) => !ENGINES.includes(k) && eng[k] > 0.5)]
  return (
    <>
      <Head title={t("显卡", "GPU")} model={nv?.name ?? s?.gpuName} right={<span className="num" style={{ font: "600 26px var(--f-num)", color: "var(--gpu)" }}>{fixed(s?.gpuPct, 0, "%")}</span>} />
      {/* the per-engine split, like Task Manager's GPU page */}
      <div className="engrid big">
        {keys.map((k) => (
          <div key={k} className="engcell">
            <div className="row spread"><span className="dim" style={{ fontSize: 12 }}>{t(ENGINE_ZH[k] ?? k, k)}</span><b className="num" style={{ fontSize: 13 }}>{(eng[k] ?? 0).toFixed(0)}%</b></div>
            <Mini data={engHist[k] ?? []} color="var(--gpu)" h={64} />
          </div>
        ))}
      </div>
      <div className="pkvs">
        <Kv k={t("温度", "Temperature")} v={fixed(nv?.temperature ?? s?.gpuTemp, 0, " °C")} />
        <Kv k={t("功耗", "Power")} v={fixed(nv?.powerUsageW ?? s?.gpuPower, 0, " W")} sub={nv ? `/ ${nv.powerLimitW.toFixed(0)} W` : undefined} />
        <Kv k={t("显存已用", "VRAM used")} v={bytes(nv?.memUsedBytes ?? s?.vramUsed ?? null)} sub={nv || s?.vramTotal ? `/ ${bytes(nv?.memTotalBytes ?? s?.vramTotal ?? null, 0)}` : undefined} />
        {nv && <>
          <Kv k={t("核心频率", "Core clock")} v={`${nv.graphicsClock} MHz`} />
          <Kv k={t("显存频率", "Memory clock")} v={`${nv.memClock} MHz`} />
          <Kv k={t("风扇", "Fan")} v={`${nv.fanSpeedPct}%`} />
          <Kv k={t("显存控制器", "Memory controller")} v={`${nv.utilizationMem}%`} />
          <Kv k={t("驱动版本", "Driver")} v={nv.driverVersion || "—"} />
        </>}
      </div>
      <Big traces={[{ data: h.vram, color: "--gpu", fill: true }]} max={100} label={t("专用显存", "Dedicated VRAM")} />
      {!nv && g && <span className="faint" style={{ fontSize: 12 }}>{t("频率、风扇与驱动信息需要 NVIDIA 显卡（NVML）；引擎占用与显存适用于所有显卡。", "Clocks, fan and driver need an NVIDIA GPU (NVML); engine load and VRAM work on every GPU.")}</span>}
    </>
  )
}

function IoPane({ kind }: { kind: "disk" | "net" }) {
  const t = useT()
  const s = useLive((x) => x.sensors)
  const h = useLive((x) => x.hist)
  if (kind === "disk") {
    const d = [...h.rd.slice(-60), ...h.wr.slice(-60)]
    return (
      <>
        <Head title={t("磁盘", "Disk")} right={<span className="num" style={{ font: "600 26px var(--f-num)", color: "var(--disk)" }}>{fixed(s?.diskPct, 0, "%")}</span>} />
        <Big traces={[{ data: h.rd, color: "--disk", fill: true }, { data: h.wr, color: "--cpu" }]} max={peak(d, 1024 * 1024)} label={t("读写速率（读 / 写）", "Transfer rate (read / write)")} />
        <div className="pkvs">
          <Kv k={t("活动时间", "Active time")} v={fixed(s?.diskPct, 0, "%")} />
          <Kv k={t("读取", "Read")} v={rate(s?.diskRead)} color="var(--disk)" />
          <Kv k={t("写入", "Write")} v={rate(s?.diskWrite)} color="var(--cpu)" />
        </div>
      </>
    )
  }
  const d = [...h.down.slice(-60), ...h.up.slice(-60)]
  return (
    <>
      <Head title={t("网络", "Network")} right={<span className="num" style={{ font: "600 22px var(--f-num)", color: "var(--net)" }}>▼ {rate(s?.netDown)}</span>} />
      <Big traces={[{ data: h.down, color: "--net", fill: true }, { data: h.up, color: "--mem" }]} max={peak(d, 64 * 1024)} label={t("吞吐量（下载 / 上传）", "Throughput (down / up)")} />
      <div className="pkvs">
        <Kv k={t("下载", "Download")} v={rate(s?.netDown)} color="var(--net)" />
        <Kv k={t("上传", "Upload")} v={rate(s?.netUp)} color="var(--mem)" />
      </div>
    </>
  )
}

function PowerPane() {
  const t = useT()
  const s = useLive((x) => x.sensors)
  const h = useLive((x) => x.hist)
  const total = h.cpuW.map((v, i) => v + (h.gpuW[i] ?? 0))
  return (
    <>
      <Head title={t("功耗", "Power")} model={t("CPU + GPU 实时功耗", "Live CPU + GPU power")} right={<span className="num" style={{ font: "600 26px var(--f-num)", color: "var(--warn)" }}>{fixed(isNum(s?.cpuPower) || isNum(s?.gpuPower) ? (s?.cpuPower ?? 0) + (s?.gpuPower ?? 0) : null, 0, " W")}</span>} />
      <Big traces={[{ data: total, color: "--gpu", fill: true }, { data: h.cpuW, color: "--cpu", fill: true }]} max={peak(total.slice(-60), 50)} label={t("总功耗（CPU 叠加 GPU）", "Total power (CPU under GPU)")} />
      <div className="pkvs">
        <Kv k={t("CPU 功耗", "CPU power")} v={fixed(s?.cpuPower, 0, " W")} color="var(--cpu)" />
        <Kv k={t("GPU 功耗", "GPU power")} v={fixed(s?.gpuPower, 0, " W")} color="var(--gpu)" />
        <Kv k={t("CPU 温度", "CPU temp")} v={fixed(s?.cpuTemp, 0, " °C")} />
        <Kv k={t("GPU 温度", "GPU temp")} v={fixed(s?.gpuTemp, 0, " °C")} />
      </div>
    </>
  )
}
