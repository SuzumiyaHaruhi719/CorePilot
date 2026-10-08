import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { animate, AnimatePresence, motion } from "motion/react"
import { AlertTriangle, ArrowRight, Check, Gauge, HardDrive, Loader2, MemoryStick, RotateCcw, Wand2, X, Zap } from "lucide-react"
import { runOneClick, STEPS, type OneClickResult, type StepId, type StepState } from "../lib/optimize"
import { useT } from "../lib/store"
import { bytes } from "../lib/util"
import { burst } from "./fx"
import { EASE, SETTLE } from "./kit"

type Phase = "idle" | "run" | "done" | "fail"

/** Counts up from 0 once mounted (results reveal). */
function CountUp({ v, fmt }: { v: number; fmt: (x: number) => string }) {
  const [x, setX] = useState(0)
  useEffect(() => { const c = animate(0, v, { duration: 1.25, ease: EASE, onUpdate: setX }); return () => c.stop() }, [v])
  return <>{fmt(x)}</>
}

function Stat({ icon, k, children, i }: { icon: ReactNode; k: string; children: ReactNode; i: number }) {
  return (
    <motion.span className="oc-stat" initial={{ opacity: 0, y: 10, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1, transition: { ...SETTLE, delay: 0.12 + i * 0.07 } }}>
      <span className="oc-sic">{icon}</span>
      <span className="col" style={{ "--gap": "0px", minWidth: 0 } as CSSProperties}><em>{k}</em><b className="num">{children}</b></span>
    </motion.span>
  )
}

/** 一键优化: the signature optimize moment. Running = a light orbits the card's border
 *  and each step lights up (and sparks) as it lands; done = shockwave + sparks from
 *  the emblem and the step row turns into the results, counting up. The card keeps
 *  one height in every phase, so it also fits the Overview widget. */
export function OneClick() {
  const t = useT()
  const [phase, setPhase] = useState<Phase>("idle")
  const [steps, setSteps] = useState<Partial<Record<StepId, StepState>>>({})
  const [res, setRes] = useState<OneClickResult | null>(null)
  const emblem = useRef<HTMLSpanElement>(null)
  const chips = useRef<Partial<Record<StepId, HTMLSpanElement | null>>>({})
  const spark = (el: Element | null | undefined, power: number) => { if (el) { const r = el.getBoundingClientRect(); burst(r.left + r.width / 2, r.top + r.height / 2, power) } }
  const run = async () => {
    if (phase === "run") return
    setPhase("run")
    setRes(null)
    setSteps({})
    const r = await runOneClick((id, s) => {
      setSteps((x) => ({ ...x, [id]: s }))
      if (s === "done") spark(chips.current[id], 0.06)
    })
    setRes(r)
    setPhase(r.ok ? "done" : "fail")
    if (r.ok) spark(emblem.current, 1.25)
  }
  const landed = Object.values(steps).filter((s) => s === "done" || s === "fail").length
  const pct = Math.round((landed / STEPS.length) * 100)
  const sub = phase === "run" ? t(`正在优化 · ${landed}/${STEPS.length}`, `Optimizing · ${landed}/${STEPS.length}`)
    : phase === "done" ? t("优化完成，系统已焕然一新", "All done — your system feels fresh")
    : phase === "fail" ? t(`完成，但有 ${res?.failed.length ?? 0} 项未成功`, `Done, ${res?.failed.length ?? 0} step(s) failed`)
    : t("释放内存 · 清理缓存与临时文件 · 推荐游戏优化 · 卓越性能", "Free memory · clean caches & temp · gaming tweaks · Ultimate Performance")
  const icon = phase === "run" ? <Loader2 size={26} className="spin" /> : phase === "done" ? <Check size={28} strokeWidth={2.6} /> : phase === "fail" ? <AlertTriangle size={24} /> : <Wand2 size={26} />
  return (
    <motion.div className={`oc oc-${phase}`} variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0 } }}>
      <i className="oc-trail" aria-hidden />
      <i className="oc-beam" aria-hidden />
      <button className="oc-hit" onClick={run} disabled={phase === "run"} aria-label={t("一键优化", "One-click optimize")}>
        <span className="oc-emblem" ref={emblem}>
          <svg className="oc-orbit" viewBox="0 0 64 64" aria-hidden>
            <circle className="trk" cx="32" cy="32" r="29" />
            <circle className="arc" cx="32" cy="32" r="29" pathLength="100" strokeDasharray="24 76" />
          </svg>
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span key={phase} className="oc-ic" initial={{ scale: 0.3, opacity: 0, rotate: -40 }} animate={{ scale: 1, opacity: 1, rotate: 0, transition: SETTLE }} exit={{ scale: 0.4, opacity: 0, transition: { duration: 0.12 } }}>
              {icon}
            </motion.span>
          </AnimatePresence>
        </span>
        <span className="oc-body">
          <span className="oc-top">
            <b>{t("一键优化", "One-click optimize")}</b>
            <AnimatePresence mode="wait" initial={false}>
              <motion.span key={sub} className="oc-sub" initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -5, transition: { duration: 0.1 } }} transition={{ duration: 0.24, ease: EASE }}>{sub}</motion.span>
            </AnimatePresence>
          </span>
          <AnimatePresence mode="wait" initial={false}>
            {res && phase !== "run" ? (
              <motion.span key="res" className="oc-row" exit={{ opacity: 0, transition: { duration: 0.1 } }}>
                <Stat i={0} icon={<MemoryStick size={14} />} k={t("释放内存", "Memory freed")}>{res.freed >= 1 << 20 ? <CountUp v={res.freed} fmt={(x) => bytes(x)} /> : t("已很干净", "Already lean")}</Stat>
                <Stat i={1} icon={<HardDrive size={14} />} k={t("临时文件", "Temp files")}><CountUp v={res.tempFiles} fmt={(x) => t(`${Math.round(x)} 个`, `${Math.round(x)}`)} /> · <CountUp v={res.tempBytes} fmt={(x) => bytes(x)} /></Stat>
                <Stat i={2} icon={<Zap size={14} />} k={t("游戏优化", "Gaming tweaks")}>{res.applied ? t(`新启用 ${res.applied} 项`, `+${res.applied} enabled`) : t("已全部启用", "All on")}</Stat>
                <Stat i={3} icon={<Gauge size={14} />} k={t("电源计划", "Power plan")}>{res.plan ? t("卓越性能", "Ultimate") : t("未切换", "Unchanged")}</Stat>
              </motion.span>
            ) : (
              <motion.span key="steps" className="oc-row" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.1 } }}>
                {STEPS.map((s) => {
                  const st = steps[s.id] ?? "idle"
                  return (
                    <span key={s.id} ref={(el) => { chips.current[s.id] = el }} className={`oc-step ${st}`}>
                      <span className="oc-dot">
                        <AnimatePresence mode="popLayout" initial={false}>
                          <motion.span key={st} initial={{ scale: 0.2, opacity: 0 }} animate={{ scale: 1, opacity: 1, transition: SETTLE }} exit={{ scale: 0.2, opacity: 0, transition: { duration: 0.08 } }}>
                            {st === "run" ? <Loader2 size={11} className="spin" /> : st === "done" ? <Check size={11} strokeWidth={3} /> : st === "fail" ? <X size={11} strokeWidth={3} /> : <i />}
                          </motion.span>
                        </AnimatePresence>
                      </span>
                      {t(s.zh, s.en)}
                    </span>
                  )
                })}
              </motion.span>
            )}
          </AnimatePresence>
        </span>
        <span className="oc-go">
          <AnimatePresence mode="wait" initial={false}>
            <motion.span key={phase === "run" ? "run" : phase === "idle" ? "idle" : "again"} className="row" style={{ "--gap": "6px" } as CSSProperties}
              initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -8, transition: { duration: 0.1 } }} transition={{ duration: 0.22, ease: EASE }}>
              {phase === "run" ? <b className="num">{pct}%</b> : phase === "idle" ? <>{t("开始", "Start")}<ArrowRight size={15} /></> : <>{t("再次优化", "Run again")}<RotateCcw size={14} /></>}
            </motion.span>
          </AnimatePresence>
        </span>
      </button>
      <i className="oc-progress" style={{ transform: `scaleX(${phase === "run" ? pct / 100 : phase === "idle" ? 0 : 1})` }} aria-hidden />
    </motion.div>
  )
}
