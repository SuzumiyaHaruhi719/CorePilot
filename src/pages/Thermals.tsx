import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import { AnimatePresence, motion } from "motion/react"
import { Fan, ShieldAlert, Square, Wand2, Waves } from "lucide-react"
import { api, on, type CalibProgress, type CurvePoint, type FanConfig, type FanState, type TuneParams, type TuneProgress } from "../lib/ipc"
import { applyTunedCurves } from "../lib/boot"
import { act, toast, useProfiles, useT } from "../lib/store"
import { clamp, curveAt, isNum } from "../lib/util"
import { confirmDialog, Empty, Field, Meter, Page, PageHead, Panel, Range, Roll, Seg, Switch, usePoll } from "../ui/kit"

const PRESETS: Record<string, CurvePoint[]> = {
  quiet: [{ tempC: 30, duty: 20 }, { tempC: 50, duty: 28 }, { tempC: 65, duty: 42 }, { tempC: 75, duty: 62 }, { tempC: 88, duty: 100 }],
  balanced: [{ tempC: 30, duty: 25 }, { tempC: 50, duty: 38 }, { tempC: 65, duty: 58 }, { tempC: 75, duty: 78 }, { tempC: 85, duty: 100 }],
  perf: [{ tempC: 30, duty: 35 }, { tempC: 45, duty: 55 }, { tempC: 60, duty: 75 }, { tempC: 70, duty: 92 }, { tempC: 80, duty: 100 }],
}
const T0 = 20, T1 = 100

function defaultConfig(id: string, st: FanState): FanConfig {
  const cpu = st.temps.find((x) => /cpu|tctl|package/i.test(x.name)) ?? st.temps[0]
  return { controlId: id, mode: "auto", manualPct: 50, tempSourceId: cpu?.id ?? null, curve: PRESETS.balanced, minDuty: 20, spinUpPct: 100, spinDownPct: 100, tempSourceId2: null, curve2: [] }
}

// ------------------------------------------------------------ curve editor
function CurveEditor({ curve, curve2, onCommit, liveT, liveDuty, color = "var(--acc)" }: { curve: CurvePoint[]; curve2?: CurvePoint[]; onCommit: (c: CurvePoint[]) => void; liveT: number | null; liveDuty: number | null; color?: string }) {
  const t = useT()
  const box = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(600)
  const [pts, setPts] = useState(curve)
  const [drag, setDrag] = useState<number | null>(null)
  useEffect(() => { if (drag == null) setPts(curve) }, [curve]) // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const ro = new ResizeObserver(() => setW(box.current!.clientWidth))
    ro.observe(box.current!)
    return () => ro.disconnect()
  }, [])
  const H = 260, PL = 34, PB = 24, PT = 10, PR = 10
  const X = (tc: number) => PL + ((tc - T0) / (T1 - T0)) * (w - PL - PR)
  const Y = (d: number) => PT + (1 - d / 100) * (H - PT - PB)
  const inv = (cx: number, cy: number) => ({ tempC: T0 + ((cx - PL) / (w - PL - PR)) * (T1 - T0), duty: (1 - (cy - PT) / (H - PT - PB)) * 100 })
  const path = (c: CurvePoint[]) => c.length ? `M ${PL} ${Y(c[0].duty)} ` + c.map((p) => `L ${X(p.tempC)} ${Y(p.duty)}`).join(" ") + ` L ${w - PR} ${Y(c[c.length - 1].duty)}` : ""
  const move = (e: React.PointerEvent) => {
    if (drag == null) return
    const r = (e.currentTarget as SVGElement).getBoundingClientRect()
    const p = inv(e.clientX - r.left, e.clientY - r.top)
    setPts((c) => c.map((q, i) => i !== drag ? q : {
      tempC: Math.round(clamp(p.tempC, (c[i - 1]?.tempC ?? T0 - 1) + 1, (c[i + 1]?.tempC ?? T1 + 1) - 1)),
      duty: Math.round(clamp(p.duty, 0, 100)),
    }))
  }
  const addPoint = (e: React.MouseEvent) => {
    const r = (e.currentTarget as SVGElement).getBoundingClientRect()
    const p = inv(e.clientX - r.left, e.clientY - r.top)
    const next = [...pts, { tempC: Math.round(clamp(p.tempC, T0, T1)), duty: Math.round(clamp(p.duty, 0, 100)) }].sort((a, b) => a.tempC - b.tempC)
    setPts(next); onCommit(next)
  }
  return (
    <div ref={box} style={{ position: "relative", userSelect: "none" }}>
      <svg width={w} height={H} onPointerMove={move} onPointerUp={() => { if (drag != null) { setDrag(null); onCommit(pts) } }} onDoubleClick={addPoint} style={{ display: "block", touchAction: "none" }}>
        {[0, 25, 50, 75, 100].map((d) => <g key={d}><line x1={PL} x2={w - PR} y1={Y(d)} y2={Y(d)} stroke="var(--grid)" /><text x={PL - 8} y={Y(d) + 3} textAnchor="end" fontSize="10" fill="var(--ink-3)" fontFamily="Bahnschrift">{d}</text></g>)}
        {[20, 30, 40, 50, 60, 70, 80, 90, 100].map((c) => <g key={c}><line y1={PT} y2={H - PB} x1={X(c)} x2={X(c)} stroke="var(--grid)" /><text x={X(c)} y={H - 7} textAnchor="middle" fontSize="10" fill="var(--ink-3)" fontFamily="Bahnschrift">{c}°</text></g>)}
        {curve2 && curve2.length > 0 && <path d={path(curve2)} fill="none" stroke="var(--gpu)" strokeWidth="1.4" strokeDasharray="4 4" opacity=".8" />}
        <path d={`${path(pts)} L ${w - PR} ${H - PB} L ${PL} ${H - PB} Z`} fill={color} opacity=".08" />
        <path d={path(pts)} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
        {isNum(liveT) && (
          <motion.g animate={{ x: X(clamp(liveT, T0, T1)), y: Y(liveDuty ?? curveAt(pts, liveT)) }} transition={{ type: "spring", stiffness: 120, damping: 20 }}>
            <line y1={0} y2={H} transform={`translate(0 ${-Y(liveDuty ?? curveAt(pts, liveT))})`} stroke="var(--ink-3)" strokeDasharray="2 3" />
            <circle r="9" fill={color} opacity=".18"><animate attributeName="r" values="6;12;6" dur="2s" repeatCount="indefinite" /></circle>
            <circle r="4" fill="var(--ink)" />
          </motion.g>
        )}
        {pts.map((p, i) => (
          <g key={i} transform={`translate(${X(p.tempC)} ${Y(p.duty)})`} style={{ cursor: "grab" }}
            onPointerDown={(e) => { (e.currentTarget.ownerSVGElement as SVGSVGElement).setPointerCapture(e.pointerId); setDrag(i) }}
            onContextMenu={(e) => { e.preventDefault(); if (pts.length > 2) { const n = pts.filter((_, k) => k !== i); setPts(n); onCommit(n) } }}>
            <circle r="12" fill="transparent" />
            <circle r={drag === i ? 7 : 5.5} fill="var(--panel)" stroke={color} strokeWidth="2" style={{ transition: "r .15s" }} />
            {drag === i && <text y={-14} textAnchor="middle" fontSize="11" fill="var(--ink)" fontFamily="Bahnschrift">{p.tempC}° · {p.duty}%</text>}
          </g>
        ))}
      </svg>
      <div className="faint" style={{ fontSize: 11.5, marginTop: 4 }}>{t("拖动节点调整 · 双击空白处添加 · 右键节点删除", "Drag nodes · double-click to add · right-click a node to remove")}</div>
    </div>
  )
}

// ------------------------------------------------------------ fan card
function FanCard({ ch, cfg, sel, onSelect }: { ch: FanState["channels"][number]; cfg?: FanConfig; sel: boolean; onSelect: () => void }) {
  const t = useT()
  const rpm = ch.rpm ?? 0
  const spin = rpm > 0 ? Math.max(0.35, 2400 / rpm) : 0
  return (
    <motion.button className="panel pad col" onClick={onSelect} disabled={!ch.controllable}
      style={{ textAlign: "left", "--gap": "10px", borderColor: sel ? "var(--acc-line)" : undefined, background: sel ? "linear-gradient(180deg, var(--acc-soft), transparent 60%), var(--panel)" : undefined, opacity: ch.controllable ? 1 : 0.7 } as CSSProperties}
      whileHover={ch.controllable ? { y: -2 } : undefined} variants={{ hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0 } }}>
      <div className="row spread">
        <span className="ellipsis" style={{ fontWeight: 500 }}>{ch.name}</span>
        <span className={`tag ${cfg?.mode === "curve" ? "acc" : ""}`}>{!ch.controllable ? t("只读", "read-only") : cfg?.mode === "curve" ? t("曲线", "curve") : cfg?.mode === "manual" ? t("手动", "manual") : t("自动", "auto")}</span>
      </div>
      <div className="row" style={{ "--gap": "12px" } as CSSProperties}>
        <Fan size={26} strokeWidth={1.3} style={{ color: rpm ? "var(--acc)" : "var(--ink-4)", animation: spin ? `spin ${spin}s linear infinite` : undefined }} />
        <div className="readout md"><span className="v">{isNum(ch.rpm) ? <Roll value={ch.rpm.toFixed(0)} /> : "—"}</span><span className="u">RPM</span></div>
      </div>
      <div className="row" style={{ "--gap": "10px" } as CSSProperties}>
        <div className="grow"><Meter v={ch.pct} /></div>
        <span className="num faint" style={{ fontSize: 11 }}>{isNum(ch.pct) ? `${ch.pct.toFixed(0)}%` : "—"}</span>
      </div>
    </motion.button>
  )
}

// ------------------------------------------------------------ autotune
const PHASES: Record<string, [string, string]> = {
  precheck: ["预检", "Pre-check"], fanCalib: ["风扇标定", "Fan calibration"], baseline: ["空载基线", "Idle baseline"], gridSweep: ["CPU 热扫描", "CPU thermal sweep"],
  gpuSweep: ["GPU 热扫描", "GPU thermal sweep"], fit: ["拟合热模型", "Fitting model"], synthesize: ["生成曲线", "Synthesizing curves"],
  validate: ["闭环验证", "Closed-loop validation"], combinedValidate: ["联合验证", "Combined validation"], done: ["完成", "Done"],
}

function AutoTune({ st }: { st: FanState }) {
  const t = useT()
  const tune = useProfiles((s) => s.tune)
  const passive = useProfiles((s) => s.passive)
  const set = useProfiles((s) => s.set)
  const ctl = st.channels.filter((c) => c.controllable)
  const [params, setParams] = useState<TuneParams>(() => tune?.params ?? {
    targetTempC: 85, targetGpuTempC: 80, quietFloorPct: 25, noiseCeilPct: 100, allowBackgroundLoad: false,
    groups: Object.fromEntries(ctl.map((c) => [c.id, /cpu|pump|aio|泵|水冷/i.test(c.name) ? "cpu" : "case"])),
  })
  const [prog, setProg] = useState<TuneProgress | null>(null)
  const [running, setRunning] = useState(false)
  useEffect(() => {
    const u = [on("fan-autotune-progress", setProg), on("fan-autotune-aborted", (a) => toast("warn", t("自动调校已中止", "Autotune aborted"), t(a.reasonZh, a.reasonEn)))]
    return () => { u.forEach((p) => p.then((f) => f())) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const up = (p: Partial<TuneParams>) => setParams((x) => ({ ...x, ...p }))
  const start = async () => {
    if (!(await confirmDialog({ title: t("开始自动调校？", "Start autotune?"), body: t("约 20–40 分钟。期间会施加 CPU/GPU 负载并让风扇在不同转速运行，请保持电脑空闲。", "Takes ~20–40 min. CPU/GPU load is applied and fans sweep through speeds — leave the PC idle."), ok: t("开始", "Start") }))) return
    setRunning(true)
    setProg(null)
    try {
      const reuse = useProfiles.getState().calibrations
      const r = await api.tuneStart({ ...params, reuseCalibration: reuse.length ? reuse : null })
      set({ tune: r, calibrations: r.calibrations })
      applyTunedCurves(r.curves, r.cpuSourceId, r.gpuSourceId)
      toast("ok", t("自动调校完成，曲线已应用", "Autotune done — curves applied"), t(`目标 ${r.effectiveTarget.toFixed(0)}°C`, `target ${r.effectiveTarget.toFixed(0)} °C`))
    } catch (e) {
      toast("err", t("自动调校失败", "Autotune failed"), String(e))
    } finally { setRunning(false) }
  }
  const retarget = async (targetTempC: number) => {
    if (!tune) return
    const p = { ...tune.params, targetTempC }
    const r = await act(api.tuneResynth({ params: p, model: tune.model, modelGpu: tune.modelGpu, calibrations: tune.calibrations, pDesign: tune.pDesign, pDesignGpu: tune.pDesignGpu }))
    if (!r) return
    set({ tune: { ...tune, params: p, curves: r.curves, effectiveTarget: r.effectiveTarget, effectiveTargetGpu: r.effectiveTargetGpu, warnings: r.warnings } })
    applyTunedCurves(r.curves, tune.cpuSourceId, tune.gpuSourceId)
  }
  const pct = prog ? (prog.step / Math.max(1, prog.stepTotal)) * 100 : 0
  return (
    <Panel title={t("闭环自动调校", "Closed-loop autotune")} color="var(--acc)" className="fill ticks" right={running ? <button className="btn sm danger" onClick={() => api.tuneAbort()}><Square size={11} />{t("中止", "Abort")}</button> : null}>
      <AnimatePresence mode="wait" initial={false}>
        {running ? (
          <motion.div key="run" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="col" style={{ "--gap": "16px" } as CSSProperties}>
            <div className="row spread" style={{ alignItems: "flex-end" }}>
              <div className="col" style={{ "--gap": "4px" } as CSSProperties}>
                <span className="label">{t("阶段", "Phase")}</span>
                <b style={{ font: "600 22px var(--f-num)" }}>{prog ? t(...(PHASES[prog.phase] ?? [prog.phase, prog.phase])) : t("准备中…", "Preparing…")}</b>
                <span className="faint" style={{ fontSize: 12 }}>{prog?.note ?? ""}</span>
              </div>
              <div className="row" style={{ "--gap": "26px" } as CSSProperties}>
                <div className="col" style={{ "--gap": "2px" } as CSSProperties}><span className="label c-cpu">CPU</span><span className="num" style={{ fontSize: 18 }}>{isNum(prog?.cpuTemp) ? `${prog!.cpuTemp!.toFixed(1)}°` : "—"} <span className="faint" style={{ fontSize: 12 }}>{isNum(prog?.cpuPower) ? `${prog!.cpuPower!.toFixed(0)} W` : ""}</span></span></div>
                <div className="col" style={{ "--gap": "2px" } as CSSProperties}><span className="label c-gpu">GPU</span><span className="num" style={{ fontSize: 18 }}>{isNum(prog?.gpuTemp) ? `${prog!.gpuTemp!.toFixed(1)}°` : "—"} <span className="faint" style={{ fontSize: 12 }}>{isNum(prog?.gpuPower) ? `${prog!.gpuPower!.toFixed(0)} W` : ""}</span></span></div>
                <div className="col" style={{ "--gap": "2px" } as CSSProperties}><span className="label">ETA</span><span className="num" style={{ fontSize: 18 }}>{isNum(prog?.etaS) ? `${Math.ceil(prog!.etaS! / 60)} min` : "—"}</span></div>
              </div>
            </div>
            <div className="meter lg"><i style={{ transform: `scaleX(${pct / 100})` }} /></div>
            <div className="row" style={{ "--gap": "4px" } as CSSProperties}>
              {Object.keys(PHASES).filter((k) => k !== "done").map((k) => {
                const keys = Object.keys(PHASES)
                const cur = prog ? keys.indexOf(prog.phase) : -1
                const idx = keys.indexOf(k)
                return <div key={k} className="grow" title={t(...PHASES[k])} style={{ height: 3, borderRadius: 3, background: idx < cur ? "var(--acc)" : idx === cur ? "var(--acc-line)" : "var(--line)", transition: "background .4s" }} />
              })}
            </div>
          </motion.div>
        ) : (
          <motion.div key="cfg" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 28 }}>
            <div>
              <Field title={<>{t("CPU 目标温度", "CPU target")} <span className="num c-cpu">{params.targetTempC}°C</span></>} desc={t("满载时允许达到的温度，越高越安静", "Allowed full-load temperature — higher is quieter")}>
                <div style={{ width: 150 }}><Range value={params.targetTempC} min={60} max={88} onChange={(v) => up({ targetTempC: v })} color="var(--cpu)" /></div>
              </Field>
              <Field title={<>{t("GPU 目标温度", "GPU target")} <span className="num c-gpu">{params.targetGpuTempC}°C</span></>}>
                <div style={{ width: 150 }}><Range value={params.targetGpuTempC} min={60} max={87} onChange={(v) => up({ targetGpuTempC: v })} color="var(--gpu)" /></div>
              </Field>
              <Field title={<>{t("静音下限 / 噪音上限", "Quiet floor / noise ceiling")} <span className="num faint">{params.quietFloorPct}–{params.noiseCeilPct}%</span></>}>
                <div className="col" style={{ width: 150, "--gap": "6px" } as CSSProperties}>
                  <Range value={params.quietFloorPct} min={0} max={60} onChange={(v) => up({ quietFloorPct: v, noiseCeilPct: Math.max(params.noiseCeilPct, v + 15) })} />
                  <Range value={params.noiseCeilPct} min={40} max={100} onChange={(v) => up({ noiseCeilPct: v, quietFloorPct: Math.min(params.quietFloorPct, v - 15) })} />
                </div>
              </Field>
              <Field title={t("允许后台负载", "Allow background load")} desc={t("有其他程序占用 CPU 时仍继续", "Continue even if other programs load the CPU")}>
                <Switch on={params.allowBackgroundLoad} onChange={(v) => up({ allowBackgroundLoad: v })} />
              </Field>
            </div>
            <div className="col" style={{ "--gap": "10px" } as CSSProperties}>
              <span className="label">{t("风扇分组", "Fan groups")}</span>
              {ctl.map((c) => (
                <div key={c.id} className="row spread">
                  <span className="ellipsis">{c.name}</span>
                  <Seg value={params.groups[c.id] ?? "case"} onChange={(g) => up({ groups: { ...params.groups, [c.id]: g } })} options={[{ v: "cpu", label: t("CPU 散热", "CPU cooler") }, { v: "case", label: t("机箱", "Case") }]} />
                </div>
              ))}
              <div className="row" style={{ marginTop: "auto", paddingTop: 12 }}>
                <button className="btn primary" onClick={start} disabled={!ctl.length}><Wand2 size={14} />{tune ? t("重新调校", "Re-tune") : t("开始自动调校", "Start autotune")}</button>
              </div>
            </div>
            {tune && (
              <div style={{ gridColumn: "1 / -1", borderTop: "1px solid var(--line)", paddingTop: 14 }} className="col">
                <div className="row wrap" style={{ "--gap": "26px" } as CSSProperties}>
                  <div className="col" style={{ "--gap": "2px" } as CSSProperties}><span className="label">{t("有效目标", "Effective target")}</span><span className="num" style={{ fontSize: 20 }}>{tune.effectiveTarget.toFixed(1)}°C</span></div>
                  <div className="col" style={{ "--gap": "2px" } as CSSProperties}><span className="label">{t("验证", "Validation")}</span><span className={`tag ${tune.validation.converged ? "ok" : "warn"}`}>{tune.validation.converged ? t("已收敛", "converged") : t("未完全收敛", "not converged")} · {tune.validation.tV.toFixed(1)}°</span></div>
                  <div className="col" style={{ "--gap": "2px" } as CSSProperties}><span className="label">{t("完成于", "Finished")}</span><span className="faint">{new Date(tune.finishedAtMs).toLocaleString()}</span></div>
                  <div className="row" style={{ marginLeft: "auto" }}>
                    <Waves size={15} className="c-acc" /><span>{t("被动学习", "Passive learning")}</span>
                    <Switch on={passive} onChange={(p) => set({ passive: p })} />
                  </div>
                </div>
                <Field title={t("调整目标温度（无需重新测量）", "Retarget without re-measuring")} desc={t("基于已拟合的热模型即时重算曲线", "Recomputes curves instantly from the fitted thermal model")}>
                  <div style={{ width: 180 }}><RetargetSlider value={tune.params.targetTempC} onCommit={retarget} /></div>
                </Field>
                {tune.warnings.map((w, i) => <div key={i} className="tag warn" style={{ height: "auto", padding: "6px 8px", textTransform: "none", letterSpacing: 0, font: "400 12px var(--f-ui)" }}>{t(w.messageZh, w.messageEn)}</div>)}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </Panel>
  )
}
function RetargetSlider({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  return <div className="row"><Range value={v} min={60} max={88} onChange={setV} onCommit={onCommit} color="var(--cpu)" /><span className="num" style={{ width: 36 }}>{v}°</span></div>
}

// ------------------------------------------------------------ page
export function Thermals() {
  const t = useT()
  const [st, setSt] = useState<FanState | null>(null)
  const [sel, setSel] = useState<string | null>(null)
  const [calib, setCalib] = useState<CalibProgress | null>(null)
  const fans = useProfiles((s) => s.fans)
  const set = useProfiles((s) => s.set)
  usePoll(async () => setSt(await api.fanInfo()), 2000)
  useEffect(() => { const u = on("fan-calib-progress", setCalib); return () => { u.then((f) => f()) } }, [])

  const ctl = st?.channels.filter((c) => c.controllable) ?? []
  const selId = sel ?? ctl[0]?.id ?? null
  const ch = st?.channels.find((c) => c.id === selId)
  const cfg = selId && st ? fans[selId] ?? defaultConfig(selId, st) : null
  const upd = (p: Partial<FanConfig>) => { if (cfg && selId) set({ fans: { ...fans, [selId]: { ...cfg, ...p } } }) }
  const src = st?.temps.find((x) => x.id === cfg?.tempSourceId)
  const temps = useMemo(() => st?.temps ?? [], [st])

  const calibrate = async () => {
    if (!(await confirmDialog({ title: t("校准风扇？", "Calibrate fans?"), body: t("每个风扇会依次从 0% 扫到 100%，测量起转占空比与最高转速，约需几分钟。", "Each fan sweeps 0→100% to measure start duty and max RPM. Takes a few minutes."), ok: t("开始校准", "Calibrate") }))) return
    const r = await act(api.fanCalibrate(ctl.map((c) => c.id)), t("校准完成", "Calibration complete"))
    setCalib(null)
    if (r) set({ calibrations: r })
  }

  if (st && (!st.available || !st.supported)) {
    return (
      <Page>
        <PageHead idx="05" title={t("散热", "Thermals")} />
        <Panel><Empty icon={<Fan size={30} strokeWidth={1.3} />} title={t("无法控制此主板的风扇", "This board's fans can't be controlled")} body={t("传感器服务未就绪，或主板的 Super I/O 芯片被锁定。温度与转速读数仍会在可用时显示。", "The sensor service isn't ready, or the board's Super I/O chip is locked. Readings still show when available.")} /></Panel>
      </Page>
    )
  }

  return (
    <Page>
      <PageHead idx="05" title={t("散热", "Thermals")} sub={t("风扇曲线、校准与基于热模型的自动调校", "Fan curves, calibration and model-based autotune")}
        actions={<button className="btn" onClick={calibrate} disabled={!ctl.length || !!calib}>{calib ? t(`校准中 ${calib.fanIndex + 1}/${calib.fanTotal} · ${calib.duty.toFixed(0)}%`, `Calibrating ${calib.fanIndex + 1}/${calib.fanTotal} · ${calib.duty.toFixed(0)}%`) : t("校准风扇", "Calibrate fans")}</button>} />
      {!!st?.dirtyHeaders?.length && (
        <div className="panel pad row" style={{ borderColor: "color-mix(in oklab, var(--warn) 45%, transparent)", color: "var(--warn)" }}>
          <ShieldAlert size={16} />
          <span>{t("传感器进程异常退出，以下风扇无法交还 BIOS 控制，已保持安全转速；重启电脑可恢复。", "The sensor process exited uncleanly; these fans can't be handed back to BIOS control and are held at a safe speed. Reboot to restore BIOS control.")}{" "}
            <span className="dim">{st.dirtyHeaders.map((id) => st.channels.find((c) => c.id === id)?.name ?? id).join(", ")}</span></span>
        </div>
      )}
      {!st ? <div className="skeleton" style={{ height: 200 }} /> : (
        <div className="grid g4">
          {st.channels.map((c) => <FanCard key={c.id} ch={c} cfg={fans[c.id]} sel={c.id === selId} onSelect={() => setSel(c.id)} />)}

          {ch && cfg && (
            <Panel title={ch.name} color="var(--acc)" className="fill" right={<Seg value={cfg.mode} onChange={(mode) => upd({ mode })} options={[{ v: "auto", label: t("主板自动", "BIOS auto") }, { v: "manual", label: t("固定转速", "Fixed") }, { v: "curve", label: t("温控曲线", "Curve") }]} />}>
              <AnimatePresence mode="wait" initial={false}>
                <motion.div key={cfg.mode} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
                  {cfg.mode === "auto" && <Empty title={t("由主板 BIOS 控制", "Controlled by the BIOS")} body={t("切换到“固定转速”或“温控曲线”以接管此风扇。", "Switch to Fixed or Curve to take over this fan.")} />}
                  {cfg.mode === "manual" && (
                    <div className="row" style={{ "--gap": "24px", padding: "18px 0" } as CSSProperties}>
                      <div className="readout"><span className="v"><Roll value={cfg.manualPct.toFixed(0)} /></span><span className="u">%</span></div>
                      <div className="grow"><Range value={cfg.manualPct} min={0} max={100} onChange={(manualPct) => upd({ manualPct })} /></div>
                    </div>
                  )}
                  {cfg.mode === "curve" && (
                    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 260px", gap: 24 }}>
                      <CurveEditor curve={cfg.curve} curve2={cfg.curve2} onCommit={(curve) => upd({ curve })} liveT={src?.c ?? null} liveDuty={ch.pct} />
                      <div className="col" style={{ "--gap": "0" } as CSSProperties}>
                        <div className="field"><div className="ft">{t("温度源", "Source")}</div>
                          <div className="fc"><select className="input" style={{ width: 150 }} value={cfg.tempSourceId ?? ""} onChange={(e) => upd({ tempSourceId: e.target.value || null })}>
                            {temps.map((x) => <option key={x.id} value={x.id}>{x.name}{isNum(x.c) ? ` · ${x.c.toFixed(0)}°` : ""}</option>)}
                          </select></div>
                        </div>
                        <div className="field"><div className="ft">{t("预设", "Presets")}</div>
                          <div className="fc" style={{ gap: 4 }}>{(["quiet", "balanced", "perf"] as const).map((k) => <button key={k} className="btn sm" onClick={() => upd({ curve: PRESETS[k] })}>{t({ quiet: "静音", balanced: "均衡", perf: "性能" }[k], { quiet: "Quiet", balanced: "Balanced", perf: "Perf" }[k])}</button>)}</div>
                        </div>
                        <div className="field"><div className="ft">{t("最低转速", "Min duty")} <span className="num faint">{cfg.minDuty}%</span></div><div className="fc" style={{ width: 100 }}><Range value={cfg.minDuty} min={0} max={60} onChange={(minDuty) => upd({ minDuty })} /></div></div>
                        <div className="field"><div className="ft">{t("升速 / 降速", "Ramp up / down")} <span className="num faint">{cfg.spinUpPct}/{cfg.spinDownPct}</span></div>
                          <div className="fd">{t("每 2 秒最多变化的百分比", "Max % change per 2 s tick")}</div>
                          <div className="fc col" style={{ width: 100, gap: 6 }}><Range value={cfg.spinUpPct} min={1} max={100} onChange={(spinUpPct) => upd({ spinUpPct })} /><Range value={cfg.spinDownPct} min={1} max={100} onChange={(spinDownPct) => upd({ spinDownPct })} /></div>
                        </div>
                        {cfg.curve2.length > 0 && <div className="faint" style={{ fontSize: 11.5, paddingTop: 8 }}><span className="c-gpu">- - -</span> {t("GPU 辅助曲线（取两者较高值）", "GPU assist curve (max of both)")}</div>}
                      </div>
                    </div>
                  )}
                </motion.div>
              </AnimatePresence>
            </Panel>
          )}

          <Panel title={t("温度源", "Temperature sources")} className="span2">
            <div className="col" style={{ "--gap": "10px" } as CSSProperties}>
              {temps.map((x) => (
                <div key={x.id} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 120px 48px", alignItems: "center", gap: 12 }}>
                  <span className="ellipsis dim">{x.name}</span>
                  <Meter v={x.c} max={100} color={isNum(x.c) && x.c > 85 ? "var(--crit)" : isNum(x.c) && x.c > 70 ? "var(--warn)" : "var(--mem)"} />
                  <span className="num" style={{ textAlign: "right" }}>{isNum(x.c) ? `${x.c.toFixed(0)}°` : "—"}</span>
                </div>
              ))}
              {!temps.length && <span className="faint">{t("无温度读数", "No temperature readings")}</span>}
            </div>
          </Panel>
          <Calibrations />
          {ctl.length > 0 && <AutoTune st={st} />}
        </div>
      )}
    </Page>
  )
}

function Calibrations() {
  const t = useT()
  const cal = useProfiles((s) => s.calibrations)
  return (
    <Panel title={t("校准数据", "Calibration")} className="span2">
      {!cal.length ? <span className="faint">{t("尚未校准。校准后曲线与自动调校会以真实起转点为准。", "Not calibrated yet. Calibration lets curves and autotune use real start duties.")}</span> : (
        <div className="col" style={{ "--gap": "8px" } as CSSProperties}>
          {cal.map((c) => (
            <div key={c.controlId} className="row spread" style={{ fontSize: 12.5 }}>
              <span className="ellipsis">{c.name}</span>
              {c.disconnected ? <span className="tag warn">{t("未连接", "disconnected")}</span> : <span className="num dim">{t("起转", "start")} {c.minStartDuty.toFixed(0)}% · {c.maxRpm.toFixed(0)} RPM · {t("饱和", "sat.")} {c.saturationDuty.toFixed(0)}%</span>}
            </div>
          ))}
        </div>
      )}
    </Panel>
  )
}
