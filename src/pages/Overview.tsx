import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { AnimatePresence, LayoutGroup, motion } from "motion/react"
import { Check, GripVertical, LayoutGrid, Pencil, Plus, RotateCcw, Search, SlidersHorizontal, Undo2, X } from "lucide-react"
import { SETTINGS_DEFAULTS, useLive, useSettings, useT, type WidgetInst, type WidgetSize } from "../lib/store"
import { bytes, fixed, isNum } from "../lib/util"
import { confirmDialog, contextMenu, EASE, EASE_IN, GLIDE, Layer, Page, Seg, SETTLE, SHEET } from "../ui/kit"
import { GameTitle } from "./Games"
import { CustomW, GROUPS, METRICS, parseSpec, PowerPlan, sizeOf, wdef, WIDGETS, type CustomSpec, type Viz, type WDef } from "./widgets"
export { heat } from "./widgets"

const ROW = 56, GAP = 14
/** library preview: a nominal 1320 px board's column, and the .wprev stage's content box (styles.css) */
const PREV_COL = (1320 - 11 * GAP) / 12, PREV_W = 384, PREV_H = 212
const SIZE_LABEL: Record<WidgetSize, string> = { s: "S", m: "M", l: "L", w: "W" }
const newId = (type: string) => `${type}-${Math.random().toString(36).slice(2, 8)}`
const save = (widgets: WidgetInst[]) => useSettings.getState().set({ widgets })
/** open a context menu under a button instead of at the pointer */
const below = (el: HTMLElement) => { const r = el.getBoundingClientRect(); return { clientX: r.left, clientY: r.bottom + 6, preventDefault() {}, stopPropagation() {} } }

// ============================================================ one widget on the board
function Cell({ w, edit, onDragOver, onDragEnd, onRemove, onEdit }: { w: WidgetInst; edit: boolean; onDragOver: (id: string, x: number, y: number) => void; onDragEnd: () => void; onRemove: () => void; onEdit: () => void }) {
  const t = useT()
  const d = wdef(w.type)
  if (!d) return null // a type from a newer version: skip rather than crash
  const [cols, rows] = sizeOf(d, w.size)
  const patch = (p: Partial<WidgetInst>) => save(useSettings.getState().widgets.map((x) => (x.id === w.id ? { ...x, ...p } : x)))
  return (
    <motion.div layout data-wid={w.id} className="wcell" style={{ gridColumn: `span ${cols}`, gridRow: `span ${rows}` }}
      variants={{ hidden: { opacity: 0, y: 10, scale: 0.98 }, show: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.42, ease: EASE } } }}
      exit={{ opacity: 0, scale: 0.92, transition: { duration: 0.2, ease: EASE_IN } }}
      transition={{ layout: GLIDE }}
      drag={edit} dragSnapToOrigin dragMomentum={false} dragElastic={0.08}
      onDrag={(e) => { const p = e as PointerEvent; onDragOver(w.id, p.clientX, p.clientY) }} onDragEnd={onDragEnd}
      whileDrag={{ scale: 1.035, zIndex: 20, boxShadow: "0 34px 80px -22px rgb(0 0 0 / 0.7)", cursor: "grabbing" }}>
      <div className="wbody"><d.C opt={w.opt ?? d.defOpt} edit={edit} /></div>
      <AnimatePresence>
        {edit && (
          <motion.div className="wtools" onPointerDown={(e) => e.stopPropagation()}
            initial={{ opacity: 0, y: -6, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1, transition: SETTLE }} exit={{ opacity: 0, y: -4, transition: { duration: 0.12 } }}>
            {d.opts && (
              <button title={t("显示内容", "What to show")} onClick={(e) => contextMenu(below(e.currentTarget), d.opts!().map((o) => ({ label: o.label, icon: (w.opt ?? d.defOpt) === o.v ? <Check /> : <span />, onClick: () => patch({ opt: o.v }) })))}><SlidersHorizontal size={13} /></button>
            )}
            {w.type === "custom" && <button title={t("编辑", "Edit")} onClick={onEdit}><Pencil size={13} /></button>}
            {Object.keys(d.sizes).length > 1 && (
              <span className="wsizes">
                {(Object.keys(d.sizes) as WidgetSize[]).map((s) => (
                  <button key={s} className={s === w.size ? "on" : ""} onClick={() => patch({ size: s })} title={`${sizeOf(d, s)[0]}×${sizeOf(d, s)[1]}`}>
                    {s === w.size && <motion.span layoutId={`wsz-${w.id}`} className="wsz-pill" transition={GLIDE} />}
                    <span>{SIZE_LABEL[s]}</span>
                  </button>
                ))}
              </span>
            )}
            <button className="x" title={t("移除", "Remove")} onClick={onRemove}><X size={14} /></button>
          </motion.div>
        )}
      </AnimatePresence>
      {edit && <span className="wgrip"><GripVertical size={14} /><b>{t(d.zh, d.en)}</b></span>}
    </motion.div>
  )
}

// ============================================================ greeting hero
/** The machine's "living core": breathes and spins faster as load rises, tinted by
 *  the mood; the ring is CPU load. Pure CSS transforms (composited), paused hidden. */
function Orb() {
  const cpu = useLive((s) => s.metrics?.cpuOverall ?? 0)
  return (
    <div className="orb" style={{ "--p": cpu.toFixed(1) } as CSSProperties} aria-hidden>
      <i className="orb-halo" /><i className="orb-ring" /><i className="orb-arc" /><i className="orb-core" />
      <span className="orb-v num">{cpu.toFixed(0)}<em>%</em></span>
    </div>
  )
}

function Hero({ actions }: { actions: ReactNode }) {
  const t = useT()
  const mood = useLive((s) => s.mood)
  const m = useLive((s) => s.metrics)
  const sn = useLive((s) => s.sensors)
  const fg = useLive((s) => s.fg)
  const fps = useLive((s) => s.fps)
  const ov = useLive((s) => s.overview)
  const h = new Date().getHours()
  const greet = h < 5 ? t("夜深了", "Still up") : h < 11 ? t("早上好", "Good morning") : h < 13 ? t("中午好", "Good afternoon") : h < 18 ? t("下午好", "Good afternoon") : t("晚上好", "Good evening")
  const game = fg?.isGame && fg.exe ? <GameTitle exe={fg.exe} path={null} /> : null
  const line = mood === "hot" ? t("有点热了，留意一下散热", "Running warm — keep an eye on cooling")
    : mood === "game" ? <>{game}{t(" 进行中，祝你玩得开心", " is running — have fun")}</>
    : mood === "busy" ? t("正在全力工作，一切尽在掌控", "Working hard, all under control")
    : h < 5 ? t("机器很安静，你也早点休息", "All quiet here — get some rest")
    : t("一切安好，机器正从容运转", "All calm — your machine is cruising")
  const memPct = m?.memTotal ? (m.memUsed / m.memTotal) * 100 : null
  const facts: [string, string, string?][] = mood === "game" && isNum(fps?.fps)
    ? [["FPS", fps!.fps!.toFixed(0), "--fps"], ["1% Low", isNum(fps?.low1) ? fps!.low1!.toFixed(0) : "—"], ["CPU", fixed(sn?.cpuTemp, 0, "°C"), "--cpu"], ["GPU", fixed(sn?.gpuTemp, 0, "°C"), "--gpu"]]
    : [["CPU", fixed(sn?.cpuTemp, 0, "°C"), "--cpu"], ["GPU", fixed(sn?.gpuTemp, 0, "°C"), "--gpu"], [t("内存", "RAM"), fixed(memPct, 0, "%"), "--mem"], [t("整机功耗", "Power"), isNum(sn?.cpuPower) || isNum(sn?.gpuPower) ? `${((sn?.cpuPower ?? 0) + (sn?.gpuPower ?? 0)).toFixed(0)} W` : "—"]]
  return (
    <motion.header className={`hero mood-${mood}`} variants={{ hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: EASE } } }}>
      <Orb />
      <div className="hero-txt">
        <h1>{greet}</h1>
        <AnimatePresence mode="wait" initial={false}>
          <motion.p key={mood} initial={{ opacity: 0, y: 6, filter: "blur(4px)" }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }} exit={{ opacity: 0, y: -4, transition: { duration: 0.14 } }} transition={{ duration: 0.4, ease: EASE }}>{line}</motion.p>
        </AnimatePresence>
        <div className="hero-facts">
          {facts.map(([k, v, c]) => <span key={k} style={c ? ({ "--c": `var(${c})` } as CSSProperties) : undefined}><em>{k}</em><b className="num">{v}</b></span>)}
          {ov && <span className="hero-sys faint ellipsis">{ov.cpuName} · {bytes(ov.ramTotal, 0)}</span>}
        </div>
      </div>
      <div className="hero-act">{actions}</div>
    </motion.header>
  )
}

// ============================================================ library sheet
function Library({ onAdd, onCustom, onClose }: { onAdd: (d: WDef) => void; onCustom: () => void; onClose: () => void }) {
  const t = useT()
  const [q, setQ] = useState("")
  const [hov, setHov] = useState<WDef>(WIDGETS[0])
  const [added, setAdded] = useState<string | null>(null)
  const widgets = useSettings((s) => s.widgets)
  const count = (type: string) => widgets.filter((w) => w.type === type).length
  const k = q.trim().toLowerCase()
  const list = WIDGETS.filter((d) => d.type !== "custom" && (!k || [d.zh, d.en, d.dzh, d.den].some((x) => x.toLowerCase().includes(k))))
  // render at true board size, then scale into the fixed stage like a thumbnail —
  // drawing a 12-column widget at the sheet's 384 px width squeezed and clipped it
  const [pc, pr] = sizeOf(hov, hov.def)
  const pw = pc * PREV_COL + (pc - 1) * GAP, ph = pr * ROW + (pr - 1) * GAP
  const ps = Math.min(1, PREV_W / pw, PREV_H / ph)
  return (
    <Layer>
      <motion.div className="scrim light" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
      <motion.aside className="wlib" initial={{ x: "100%" }} animate={{ x: 0, transition: { duration: 0.46, ease: SHEET } }} exit={{ x: "100%", transition: { duration: 0.26, ease: EASE_IN } }}>
        <header>
          <div className="col" style={{ "--gap": "2px" } as CSSProperties}><b>{t("小组件库", "Widget library")}</b><span className="faint" style={{ fontSize: 12 }}>{t(`${WIDGETS.length} 种 · 单击添加，可重复添加`, `${WIDGETS.length} kinds · click to add, add as many as you like`)}</span></div>
          <button className="btn ghost icon sm" onClick={onClose} aria-label={t("关闭", "Close")}><X size={15} /></button>
        </header>
        {/* live preview of the hovered widget, at its default size */}
        <div className="wprev">
          <AnimatePresence mode="popLayout" initial={false}>
            {/* variant labels (not objects) so the widget's own Panel entrance runs here too */}
            <motion.div key={hov.type} style={{ width: pw * ps, height: ph * ps }}
              initial="hidden" animate="show" exit={{ opacity: 0, y: -6, transition: { duration: 0.14 } }}
              variants={{ hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0, transition: { duration: 0.28, ease: EASE } } }}>
              <div className="wprev-in" style={{ width: pw, height: ph, transform: `scale(${ps})` }}><hov.C opt={hov.defOpt} /></div>
            </motion.div>
          </AnimatePresence>
        </div>
        <div className="search" style={{ margin: "0 16px 8px" }}><Search size={14} /><input className="input" style={{ width: "100%" }} placeholder={t("搜索小组件", "Search widgets")} value={q} onChange={(e) => setQ(e.target.value)} autoFocus /></div>
        <div className="wlist">
          {!k && (
            <button className="wlcard custom rv" onClick={onCustom} onMouseEnter={() => setHov(wdef("custom")!)}>
              <span className="wlicon"><Plus size={18} /></span>
              <span className="col grow" style={{ "--gap": "2px", minWidth: 0 } as CSSProperties}><b>{t("创建自定义小组件", "Build a custom widget")}</b><span className="faint">{t("自选指标与图表样式", "Pick metrics and a chart style")}</span></span>
            </button>
          )}
          {GROUPS.map(([g, zh, en]) => {
            const items = list.filter((d) => d.group === g)
            if (!items.length) return null
            return (
              <section key={g}>
                <div className="label" style={{ margin: "14px 6px 6px" }}>{t(zh, en)}</div>
                {items.map((d) => (
                  <button key={d.type} className={`wlcard rv ${hov.type === d.type ? "hov" : ""}`} onMouseEnter={() => setHov(d)} onFocus={() => setHov(d)}
                    onClick={() => { onAdd(d); setAdded(d.type); setTimeout(() => setAdded((a) => (a === d.type ? null : a)), 1100) }}>
                    <span className="wlicon"><d.icon size={18} /></span>
                    <span className="col grow" style={{ "--gap": "2px", minWidth: 0 } as CSSProperties}>
                      <span className="row" style={{ "--gap": "6px" } as CSSProperties}><b>{t(d.zh, d.en)}</b>{count(d.type) > 0 && <span className="tag">{count(d.type)}</span>}</span>
                      <span className="faint">{t(d.dzh, d.den)}</span>
                    </span>
                    <span className="wladd">
                      <AnimatePresence mode="wait" initial={false}>
                        {added === d.type
                          ? <motion.span key="ok" initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1, transition: SETTLE }} exit={{ opacity: 0 }}><Check size={15} /></motion.span>
                          : <motion.span key="add" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}><Plus size={15} /></motion.span>}
                      </AnimatePresence>
                    </span>
                  </button>
                ))}
              </section>
            )
          })}
        </div>
      </motion.aside>
    </Layer>
  )
}

// ============================================================ custom widget builder
const VIZ: { v: Viz; zh: string; en: string }[] = [{ v: "line", zh: "曲线", en: "Curve" }, { v: "number", zh: "数字", en: "Number" }, { v: "gauge", zh: "仪表", en: "Gauge" }, { v: "bars", zh: "条形", en: "Bars" }]
function Builder({ init, onSave, onClose }: { init: CustomSpec; onSave: (s: CustomSpec) => void; onClose: () => void }) {
  const t = useT()
  const [spec, setSpec] = useState(init)
  const up = (p: Partial<CustomSpec>) => setSpec((s) => ({ ...s, ...p }))
  const limit = spec.viz === "gauge" ? 1 : 4
  const toggle = (id: string) => up({ metrics: spec.metrics.includes(id) ? spec.metrics.filter((x) => x !== id) : [...spec.metrics, id].slice(-limit) })
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopImmediatePropagation(); onClose() } }
    addEventListener("keydown", k, true)
    return () => removeEventListener("keydown", k, true)
  }, [onClose])
  const opt = JSON.stringify({ ...spec, metrics: spec.metrics.slice(0, limit) })
  return (
    <Layer>
      <motion.div className="scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
      <motion.div className="wbuilder" role="dialog" initial={{ opacity: 0, scale: 0.96, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0, transition: SETTLE }} exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.14, ease: EASE_IN } }}>
        <div className="col" style={{ "--gap": "16px", padding: 24, minWidth: 0 } as CSSProperties}>
          <h3 style={{ margin: 0, font: "600 18px var(--f-num)" }}>{t("自定义小组件", "Custom widget")}</h3>
          <label className="col" style={{ "--gap": "6px" } as CSSProperties}><span className="label">{t("名称", "Title")}</span><input className="input" placeholder={t("留空则使用指标名", "Leave empty to use the metric names")} value={spec.title} onChange={(e) => up({ title: e.target.value.slice(0, 40) })} /></label>
          <div className="col" style={{ "--gap": "6px" } as CSSProperties}><span className="label">{t("样式", "Style")}</span><Seg value={spec.viz} onChange={(viz) => up({ viz, metrics: viz === "gauge" ? spec.metrics.slice(0, 1) : spec.metrics })} options={VIZ.map((x) => ({ v: x.v, label: t(x.zh, x.en) }))} /></div>
          <div className="col" style={{ "--gap": "6px" } as CSSProperties}>
            <span className="label">{t("指标", "Metrics")} <span className="faint num">{spec.metrics.length}/{limit}</span></span>
            <div className="mpick">
              {METRICS.map((m) => {
                const on = spec.metrics.includes(m.id)
                return (
                  <motion.button key={m.id} layout className={`mchip ${on ? "on" : ""}`} style={{ "--c": m.color } as CSSProperties} onClick={() => toggle(m.id)} whileTap={{ scale: 0.95 }}>
                    <i />{t(m.zh, m.en)}{on && <b className="num">{spec.metrics.indexOf(m.id) + 1}</b>}
                  </motion.button>
                )
              })}
            </div>
          </div>
          {(spec.viz === "line" || spec.viz === "number") && <div className="col" style={{ "--gap": "6px" } as CSSProperties}><span className="label">{t("时间窗口", "Window")}</span><Seg value={spec.win} onChange={(win) => up({ win })} options={[{ v: 60, label: t("60 秒", "60 s") }, { v: 120, label: t("120 秒", "120 s") }]} /></div>}
          <div className="row end" style={{ marginTop: "auto" }}>
            <button className="btn ghost" onClick={onClose}>{t("取消", "Cancel")}</button>
            <button className="btn primary" disabled={!spec.metrics.length} onClick={() => onSave({ ...spec, metrics: spec.metrics.slice(0, limit) })}><Check size={14} />{t("保存", "Save")}</button>
          </div>
        </div>
        <div className="wbprev">
          <span className="label" style={{ marginBottom: 10 }}>{t("实时预览", "Live preview")}</span>
          <motion.div initial="show" animate="show" style={{ height: 4 * ROW + 3 * GAP }}>{spec.metrics.length ? <CustomW opt={opt} /> : <div className="wnote" style={{ height: "100%" }}>{t("至少选择一个指标", "Pick at least one metric")}</div>}</motion.div>
        </div>
      </motion.div>
    </Layer>
  )
}

// ============================================================ the board
export function Overview() {
  const t = useT()
  const widgets = useSettings((s) => s.widgets)
  const [edit, setEdit] = useState(false)
  const [lib, setLib] = useState(false)
  const [builder, setBuilder] = useState<{ id?: string; spec: CustomSpec } | null>(null)
  const [undo, setUndo] = useState<{ w: WidgetInst; i: number } | null>(null)
  const drag = useRef({ over: "", at: 0 })

  // Esc closes the innermost layer; leaving edit mode drops a pending undo
  useEffect(() => {
    if (!edit) return
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !lib && !builder) setEdit(false) }
    addEventListener("keydown", k)
    return () => removeEventListener("keydown", k)
  }, [edit, lib, builder])
  useEffect(() => { if (!undo) return; const id = setTimeout(() => setUndo(null), 6000); return () => clearTimeout(id) }, [undo])

  /** drag-reorder: while a widget is dragged over another, it takes that slot */
  const onDragOver = (id: string, x: number, y: number) => {
    const hit = document.elementsFromPoint(x, y).map((el) => (el as HTMLElement).closest?.("[data-wid]") as HTMLElement | null).find((el) => el && el.dataset.wid !== id)
    const target = hit?.dataset.wid
    const now = performance.now()
    if (!target || (target === drag.current.over && now - drag.current.at < 400) || now - drag.current.at < 140) return
    drag.current = { over: target, at: now }
    const list = useSettings.getState().widgets.slice()
    const from = list.findIndex((w) => w.id === id), to = list.findIndex((w) => w.id === target)
    if (from < 0 || to < 0) return
    list.splice(to, 0, list.splice(from, 1)[0])
    save(list)
  }
  const add = (d: WDef, opt?: string) => {
    const w: WidgetInst = { id: newId(d.type), type: d.type, size: d.def, opt: opt ?? d.defOpt }
    save([...useSettings.getState().widgets, w])
    requestAnimationFrame(() => setTimeout(() => document.querySelector(`[data-wid="${w.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 120))
  }
  const remove = (w: WidgetInst) => {
    const list = useSettings.getState().widgets
    setUndo({ w, i: list.findIndex((x) => x.id === w.id) })
    save(list.filter((x) => x.id !== w.id))
  }
  const restore = () => {
    if (!undo) return
    const list = useSettings.getState().widgets.slice()
    list.splice(Math.min(undo.i, list.length), 0, undo.w)
    save(list)
    setUndo(null)
  }
  const saveCustom = (spec: CustomSpec) => {
    const opt = JSON.stringify(spec)
    if (builder?.id) save(useSettings.getState().widgets.map((w) => (w.id === builder.id ? { ...w, opt } : w)))
    else add(wdef("custom")!, opt)
    setBuilder(null)
  }

  return (
    <Page>
      <Hero actions={
        <AnimatePresence mode="popLayout" initial={false}>
          {edit ? (
            <motion.div key="e" className="row" style={{ "--gap": "8px" } as CSSProperties} initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0, transition: { duration: 0.26, ease: EASE } }} exit={{ opacity: 0, x: 12, transition: { duration: 0.14 } }}>
              <button className="btn ghost" onClick={async () => { if (await confirmDialog({ title: t("恢复默认布局？", "Restore the default layout?"), body: t("当前布局与自定义小组件会被替换。", "Your layout and custom widgets will be replaced."), ok: t("恢复", "Restore") })) save(SETTINGS_DEFAULTS.widgets) }}><RotateCcw size={13} />{t("恢复默认", "Default")}</button>
              <button className="btn" onClick={() => setLib(true)}><Plus size={14} />{t("添加小组件", "Add widget")}</button>
              <button className="btn primary" onClick={() => setEdit(false)}><Check size={14} />{t("完成", "Done")}</button>
            </motion.div>
          ) : (
            <motion.div key="n" className="row" style={{ "--gap": "10px" } as CSSProperties} initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0, transition: { duration: 0.26, ease: EASE } }} exit={{ opacity: 0, x: -12, transition: { duration: 0.14 } }}>
              <span className="label">{t("电源计划", "Power plan")}</span><PowerPlan />
              <button className="btn ghost icon" title={t("自定义布局", "Customize layout")} onClick={() => setEdit(true)}><LayoutGrid size={15} /></button>
            </motion.div>
          )}
        </AnimatePresence>
      } />
      <AnimatePresence>
        {edit && (
          <motion.div className="wbanner" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto", transition: { duration: 0.3, ease: EASE } }} exit={{ opacity: 0, height: 0, transition: { duration: 0.18 } }}>
            <span>{t("拖动小组件调整顺序 · 右上角切换尺寸与内容 · Esc 完成", "Drag widgets to reorder · switch size and content top-right · Esc when done")}</span>
          </motion.div>
        )}
      </AnimatePresence>
      <LayoutGroup>
        <div className={`wgrid ${edit ? "editing" : ""}`} style={{ gridAutoRows: ROW, gap: GAP }}>
          <AnimatePresence initial={false} mode="popLayout">
            {widgets.map((w) => (
              <Cell key={w.id} w={w} edit={edit} onDragOver={onDragOver} onDragEnd={() => (drag.current.over = "")} onRemove={() => remove(w)} onEdit={() => setBuilder({ id: w.id, spec: parseSpec(w.opt) })} />
            ))}
            {edit && (
              <motion.button key="add" layout className="wadd" onClick={() => setLib(true)} initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }} transition={{ layout: GLIDE }}>
                <Plus size={18} />{t("添加小组件", "Add widget")}
              </motion.button>
            )}
          </AnimatePresence>
        </div>
      </LayoutGroup>
      {!widgets.length && !edit && (
        <div className="wnote" style={{ padding: 60 }}>
          <LayoutGrid size={26} strokeWidth={1.4} />{t("总览是空的", "The overview is empty")}
          <button className="btn primary" onClick={() => { setEdit(true); setLib(true) }}><Plus size={14} />{t("添加小组件", "Add widgets")}</button>
        </div>
      )}
      <AnimatePresence>{lib && <Library key="lib" onAdd={(d) => add(d)} onCustom={() => setBuilder({ spec: { title: "", viz: "line", metrics: ["cpu", "gpu"], win: 120 } })} onClose={() => setLib(false)} />}</AnimatePresence>
      <AnimatePresence>{builder && <Builder key="b" init={builder.spec} onSave={saveCustom} onClose={() => setBuilder(null)} />}</AnimatePresence>
      <AnimatePresence>
        {undo && (
          <motion.div className="wundo" initial={{ opacity: 0, y: 20, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1, transition: SETTLE }} exit={{ opacity: 0, y: 12, transition: { duration: 0.16 } }}>
            <span>{t(`已移除「${t(wdef(undo.w.type)?.zh ?? "", wdef(undo.w.type)?.en ?? "")}」`, `Removed “${wdef(undo.w.type)?.en ?? ""}”`)}</span>
            <button className="btn sm" onClick={restore}><Undo2 size={13} />{t("撤销", "Undo")}</button>
          </motion.div>
        )}
      </AnimatePresence>
    </Page>
  )
}
