import { useState, type CSSProperties } from "react"
import { motion } from "motion/react"
import { Eraser, Globe, MemoryStick, Sparkles } from "lucide-react"
import { api } from "../lib/ipc"
import { act, go, useLive, useT } from "../lib/store"
import { bytes, bytesParts, fixed, isNum, rate } from "../lib/util"
import { AsyncButton, Meter, Page, PageHead, Panel, Readout, Scope, Seg, useAsync } from "../ui/kit"

/** Load → heat hue: cool blue at idle, through amber, to red at saturation. */
export function heat(l: number, alpha = 1) {
  const x = Math.max(0, Math.min(1, l / 100))
  const h = x < 0.7 ? 215 - (215 - 28) * (x / 0.7) : 28 - 28 * ((x - 0.7) / 0.3)
  return `hsl(${h.toFixed(0)} 88% ${58 + x * 4}% / ${alpha})`
}

function HeroCell({ label, color, children, trace, max, sub }: { label: string; color: string; children: React.ReactNode; trace: number[]; max?: number; sub: React.ReactNode }) {
  const tick = useLive((s) => s.tick)
  return (
    <div className="col" style={{ "--gap": "10px", padding: "18px 20px 0", borderLeft: "1px solid var(--line)" } as CSSProperties}>
      <span className="label" style={{ color }}>{label}</span>
      {children}
      <div className="dim ellipsis" style={{ fontSize: 12, minHeight: 18 }}>{sub}</div>
      <div style={{ margin: "0 -20px" }}>
        <Scope traces={[{ data: trace, color, fill: true, width: 1.4 }]} max={max} height={54} tick={tick} grid={false} points={60} />
      </div>
    </div>
  )
}

function Hero() {
  const t = useT()
  const m = useLive((s) => s.metrics)
  const s = useLive((x) => x.sensors)
  const h = useLive((x) => x.hist)
  const fg = useLive((x) => x.fg)
  const fps = useLive((x) => x.fps)
  const memPct = m?.memTotal ? (m.memUsed / m.memTotal) * 100 : null
  const [mu, mUnit] = bytesParts(m?.memUsed)
  return (
    <Panel pad={false} className="ticks fill" style={{ overflow: "hidden" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0,1fr))", marginLeft: -1 }}>
        <HeroCell label={t("处理器", "Processor")} color="var(--cpu)" trace={h.cpu.slice(-60)} max={100}
          sub={<>{fixed(s?.cpuClock ? s.cpuClock / 1000 : null, 2, " GHz")} · {fixed(s?.cpuTemp, 0, " °C")} · {fixed(s?.cpuPower, 0, " W")}</>}>
          <Readout v={m?.cpuOverall} u="%" />
        </HeroCell>
        <HeroCell label={t("显卡", "Graphics")} color="var(--gpu)" trace={h.gpu.slice(-60)} max={100}
          sub={<>{fixed(s?.gpuTemp, 0, " °C")} · {fixed(s?.gpuPower, 0, " W")} · {s?.vramUsed != null ? `${bytes(s.vramUsed)} VRAM` : s?.gpuName ?? "—"}</>}>
          <Readout v={s?.gpuPct} u="%" />
        </HeroCell>
        <HeroCell label={t("内存", "Memory")} color="var(--mem)" trace={h.mem.slice(-60)} max={100}
          sub={<>{fixed(memPct, 0, "%")} {t("已用", "used")} · {bytes(m?.memTotal ?? null, 0)} {t("总计", "total")}</>}>
          <div className="readout"><span className="v">{mu}</span><span className="u">{mUnit}</span></div>
        </HeroCell>
        {fg?.isGame ? (
          <HeroCell label={t("游戏帧率", "Frame rate")} color="var(--fps)" trace={[]} sub={<>1% {fixed(fps?.low1, 0)} · 0.1% {fixed(fps?.low01, 0)} · {fixed(fps?.frametimeMs, 1, " ms")}</>}>
            <Readout v={fps?.fps} u="FPS" />
          </HeroCell>
        ) : (
          <HeroCell label={t("网络", "Network")} color="var(--net)" trace={h.down.slice(-60)} sub={<>▲ {rate(s?.netUp)}</>}>
            <div className="readout"><span className="v" style={{ fontSize: 34 }}>{rate(s?.netDown).replace("/s", "")}</span><span className="u">/s ▼</span></div>
          </HeroCell>
        )}
      </div>
    </Panel>
  )
}

function LoadScope() {
  const t = useT()
  const h = useLive((s) => s.hist)
  const tick = useLive((s) => s.tick)
  const [show, setShow] = useState({ cpu: true, gpu: true, mem: true })
  const traces = [
    show.mem && { data: h.mem, color: "--mem", width: 1.3 },
    show.gpu && { data: h.gpu, color: "--gpu" },
    show.cpu && { data: h.cpu, color: "--cpu", fill: true },
  ].filter(Boolean) as { data: number[]; color: string }[]
  const key = (k: keyof typeof show, label: string, c: string) => (
    <button className={`chip ${show[k] ? "on" : ""}`} onClick={() => setShow({ ...show, [k]: !show[k] })} style={{ height: 22, fontSize: 11 }}>
      <i style={{ width: 8, height: 2, background: c, borderRadius: 2 }} />{label}
    </button>
  )
  return (
    <Panel title={t("实时负载 · 120 秒", "Live load · 120 s")} className="span2" right={<>{key("cpu", "CPU", "var(--cpu)")}{key("gpu", "GPU", "var(--gpu)")}{key("mem", "RAM", "var(--mem)")}</>}>
      <div style={{ position: "relative" }}>
        <Scope traces={traces} max={100} height={210} tick={tick} />
        <div className="col faint num" style={{ position: "absolute", inset: "0 auto 0 0", justifyContent: "space-between", fontSize: 10, padding: "2px 0", pointerEvents: "none", "--gap": 0 } as CSSProperties}>
          <span>100</span><span>50</span><span>0</span>
        </div>
      </div>
    </Panel>
  )
}

function Thermal() {
  const t = useT()
  const s = useLive((x) => x.sensors)
  const h = useLive((x) => x.hist)
  const tick = useLive((x) => x.tick)
  const row = (label: string, v: number | null | undefined, w: number | null | undefined, color: string, data: number[]) => (
    <div className="col" style={{ "--gap": "6px" } as CSSProperties}>
      <div className="row spread">
        <span className="label" style={{ color }}>{label}</span>
        <span className="num dim" style={{ fontSize: 12 }}>{fixed(w, 0, " W")}</span>
      </div>
      <div className="row spread" style={{ alignItems: "flex-end" }}>
        <Readout v={v} u="°C" size="md" />
        <div style={{ width: "55%" }}><Scope traces={[{ data: data.slice(-60), color, width: 1.4 }]} height={34} max={100} tick={tick} grid={false} points={60} /></div>
      </div>
      <Meter v={v} max={100} color={isNum(v) && v > 85 ? "var(--crit)" : isNum(v) && v > 72 ? "var(--warn)" : color} />
    </div>
  )
  return (
    <Panel title={t("温度与功耗", "Thermals & power")} right={<button className="btn ghost sm" onClick={() => go("thermals")}>{t("风扇", "Fans")} →</button>}>
      <div className="col" style={{ "--gap": "22px" } as CSSProperties}>
        {row("CPU", s?.cpuTemp, s?.cpuPower, "var(--cpu)", h.cpuT)}
        {row("GPU", s?.gpuTemp, s?.gpuPower, "var(--gpu)", h.gpuT)}
      </div>
    </Panel>
  )
}

function CoreMap() {
  const t = useT()
  const topo = useLive((s) => s.topo)
  const m = useLive((s) => s.metrics)
  if (!topo || !m) return <Panel title={t("核心负载", "Core load")} className="span2"><div className="skeleton" style={{ height: 120 }} /></Panel>
  return (
    <Panel title={t("核心负载", "Core load")} className="span2" right={<span className="faint" style={{ fontSize: 12 }}>{topo.physicalCores}C / {topo.logicalCount}T · {topo.detection}</span>}>
      <div className="row" style={{ "--gap": "18px", alignItems: "stretch" } as CSSProperties}>
        {topo.ccds.map((c) => (
          <div key={c.ccdId} className="col grow" style={{ "--gap": "8px" } as CSSProperties}>
            <div className="row spread">
              <span className="label" style={{ color: c.isVcache ? "var(--acc)" : undefined }}>{c.label || `CCD ${c.ccdId}`}</span>
              <span className="num faint" style={{ fontSize: 11 }}>{(c.logicalCpus.reduce((a, i) => a + (m.perCore[i] ?? 0), 0) / Math.max(1, c.logicalCpus.length)).toFixed(0)}%</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(16, c.logicalCpus.length)}, 1fr)`, gap: 3, height: 96 }}>
              {c.logicalCpus.map((i) => {
                const l = m.perCore[i] ?? 0
                return (
                  <div key={i} title={`CPU ${i} · ${l.toFixed(0)}%`} style={{ position: "relative", borderRadius: 3, background: "var(--hover)", overflow: "hidden", boxShadow: "inset 0 0 0 1px var(--line)" }}>
                    <div style={{ position: "absolute", inset: 0, background: `linear-gradient(to top, ${heat(l)}, ${heat(l, 0.35)})`, transformOrigin: "bottom", transform: `scaleY(${Math.max(0.02, l / 100)})`, transition: "transform 900ms cubic-bezier(.16,1,.3,1), background 900ms" }} />
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </Panel>
  )
}

function IO() {
  const t = useT()
  const s = useLive((x) => x.sensors)
  const h = useLive((x) => x.hist)
  const tick = useLive((x) => x.tick)
  return (
    <Panel title={t("读写与网络", "I/O & network")}>
      <div className="col" style={{ "--gap": "14px" } as CSSProperties}>
        <div>
          <div className="row spread" style={{ fontSize: 12, marginBottom: 4 }}>
            <span className="c-disk">{t("磁盘", "Disk")} <span className="faint num">{fixed(s?.diskPct, 0, "%")}</span></span>
            <span className="num dim">R {rate(s?.diskRead)} · W {rate(s?.diskWrite)}</span>
          </div>
          <Scope traces={[{ data: h.rd, color: "--disk", fill: true, width: 1.3 }, { data: h.wr, color: "--cpu", width: 1.2 }]} height={44} tick={tick} grid={false} />
        </div>
        <div>
          <div className="row spread" style={{ fontSize: 12, marginBottom: 4 }}>
            <span className="c-net">{t("网络", "Network")}</span>
            <span className="num dim">▼ {rate(s?.netDown)} · ▲ {rate(s?.netUp)}</span>
          </div>
          <Scope traces={[{ data: h.down, color: "--net", fill: true, width: 1.3 }, { data: h.up, color: "--mem", width: 1.2 }]} height={44} tick={tick} grid={false} />
        </div>
      </div>
    </Panel>
  )
}

function Quick() {
  const t = useT()
  const mem = useAsync(api.memory)
  const tile = (icon: React.ReactNode, title: string, desc: string, run: () => Promise<unknown>) => (
    <motion.div className="panel pad col" style={{ "--gap": "10px" } as CSSProperties} variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0 } }} whileHover={{ y: -2 }} transition={{ duration: 0.2 }}>
      <div className="row" style={{ color: "var(--acc)" }}>{icon}<b style={{ color: "var(--ink)", fontWeight: 500 }}>{title}</b></div>
      <div className="faint" style={{ fontSize: 12, minHeight: 34 }}>{desc}</div>
      <AsyncButton className="btn sm" onClick={async () => { await run(); mem.reload() }}>{t("执行", "Run")}</AsyncButton>
    </motion.div>
  )
  return (
    <div className="grid g4 fill">
      {tile(<MemoryStick size={16} />, t("释放工作集", "Trim working sets"), t(`让进程归还空闲内存。当前可用 ${bytes(mem.data?.avail ?? null)}`, `Processes return idle pages. ${bytes(mem.data?.avail ?? null)} available now`), () => act(api.freeWorkingSets(), t("已释放工作集", "Working sets trimmed")))}
      {tile(<Eraser size={16} />, t("清空待机内存", "Purge standby"), t("丢弃缓存的待机页面，缓解游戏卡顿。", "Drop cached standby pages — helps stutter in games."), () => act(api.purgeStandby(), t("待机内存已清空", "Standby list purged")))}
      {tile(<Sparkles size={16} />, t("清理临时文件", "Clean temp files"), t("删除用户与系统临时目录中的残留。", "Remove leftovers in user and system temp folders."), () => act(api.cleanTemp(), (r) => t(`已清理 ${bytes(r.bytes)} · ${r.files} 个文件`, `Freed ${bytes(r.bytes)} · ${r.files} files`)))}
      {tile(<Globe size={16} />, t("刷新 DNS", "Flush DNS"), t("清空解析缓存，修复部分网页打不开。", "Clear the resolver cache when sites fail to load."), () => act(api.flushDns(), t("DNS 缓存已刷新", "DNS cache flushed")))}
    </div>
  )
}

function PowerPlan() {
  const t = useT()
  const plan = useAsync(api.powerPlan)
  if (!plan.data) return null
  return (
    <Seg value={plan.data} onChange={async (v) => { if (v === "other") return; plan.set(v); await act(api.setPowerPlan(v)); plan.reload() }}
      options={[{ v: "balanced", label: t("平衡", "Balanced") }, { v: "high", label: t("高性能", "High perf") }, ...(plan.data === "other" ? [{ v: "other" as const, label: t("自定义", "Custom") }] : [])]} />
  )
}

export function Overview() {
  const t = useT()
  const ov = useLive((s) => s.overview)
  return (
    <Page>
      <PageHead idx="01" title={t("总览", "Overview")} sub={ov ? `${ov.cpuName} · ${ov.physicalCores} ${t("核", "cores")} / ${ov.logicalCpus} ${t("线程", "threads")} · ${bytes(ov.ramTotal, 0)} · ${ov.os}` : "…"} actions={<><span className="label">{t("电源计划", "Power plan")}</span><PowerPlan /></>} />
      <div className="grid g3">
        <Hero />
        <LoadScope />
        <Thermal />
        <CoreMap />
        <IO />
        <Quick />
      </div>
    </Page>
  )
}
