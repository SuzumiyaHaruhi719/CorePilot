import { useEffect, useMemo, useState, type CSSProperties } from "react"
import { AnimatePresence, motion } from "motion/react"
import { ArrowLeft, Clock, FilePlus2, Gamepad2, Radar, Trash2 } from "lucide-react"
import { api, OSD_ROWS, type OverlayStatus, type Session } from "../lib/ipc"
import { act, useLive, useSettings, useT, type OsdMode } from "../lib/store"
import { duration, exeBase, fixed, isNum, lower } from "../lib/util"
import { confirmDialog, Empty, Page, PageHead, Panel, Range, Readout, Roll, Scope, Seg, Spark, Switch, swapVariants, usePoll, useAsync } from "../ui/kit"
import { Chart } from "../ui/Chart"
import { Plate, type PlateData } from "../osd/Osd"

// ------------------------------------------------------------ live HUD
function LiveHud() {
  const t = useT()
  const fg = useLive((s) => s.fg)
  const fps = useLive((s) => s.fps)
  const tick = useLive((s) => s.tick)
  const [hist, setHist] = useState<number[]>([])
  const [ov, setOv] = useState<OverlayStatus | null>(null)
  const mode = useSettings((s) => s.osd.mode)
  const allow = (exe: string) => {
    const o = useSettings.getState().osd
    useSettings.getState().set({ osd: { ...o, injectAllow: [...new Set([...o.injectAllow, exe.toLowerCase()])] } })
  }
  useEffect(() => { if (fg?.isGame && isNum(fps?.fps)) setHist((h) => [...h.slice(-119), fps!.fps!]) }, [tick]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!fg?.isGame) setHist([]) }, [fg?.isGame])
  usePoll(async () => setOv(await api.overlayStatus()), 3000, { enabled: !!fg?.isGame && mode === "inject" })

  if (!fg?.isGame) {
    return (
      <Panel title={t("实时帧率", "Live frame rate")} className="span2" style={{ minHeight: 248 }}>
        <div className="empty" style={{ padding: "26px 0" }}>
          <div style={{ position: "relative", width: 64, height: 64, display: "grid", placeItems: "center", color: "var(--acc)" }}>
            {[0, 1, 2].map((i) => (
              <motion.span key={i} style={{ position: "absolute", inset: 0, borderRadius: "50%", border: "1px solid var(--acc-line)" }}
                animate={{ scale: [0.4, 1.4], opacity: [0.8, 0] }} transition={{ duration: 2.4, repeat: Infinity, delay: i * 0.8, ease: "easeOut" }} />
            ))}
            <Radar size={22} />
          </div>
          <b>{t("等待游戏启动", "Waiting for a game")}</b>
          <div style={{ maxWidth: 440 }}>{t("游戏进入前台且画面覆盖整个显示器、帧率 ≥ 20 时自动识别。", "Detected automatically when a game is foreground, covers its monitor and renders ≥ 20 fps.")}{fg?.exe && <> {t("当前前台：", "Foreground: ")}<span className="mono">{fg.exe}</span></>}</div>
        </div>
      </Panel>
    )
  }
  return (
    <Panel title={t("实时帧率", "Live frame rate")} color="var(--fps)" className="span2 ticks" right={<span className="tag ok"><span className="dot pulse" />{fg.exe}</span>}>
      <div className="row" style={{ alignItems: "flex-end", "--gap": "36px", marginBottom: 14 } as CSSProperties}>
        <div className="readout"><span className="v" style={{ fontSize: 64 }}>{isNum(fps?.fps) ? <Roll value={fps!.fps!.toFixed(0)} /> : "—"}</span><span className="u">FPS</span></div>
        <div className="col" style={{ "--gap": "4px" } as CSSProperties}><span className="label">1% Low</span><Readout v={fps?.low1} size="md" /></div>
        <div className="col" style={{ "--gap": "4px" } as CSSProperties}><span className="label">0.1% Low</span><Readout v={fps?.low01} size="md" /></div>
        <div className="col" style={{ "--gap": "4px" } as CSSProperties}><span className="label">{t("帧时间", "Frametime")}</span><Readout v={fps?.frametimeMs} u="ms" digits={1} size="md" /></div>
        {mode === "inject" && ov && (
          <div className="col" style={{ marginLeft: "auto", "--gap": "4px", maxWidth: 240 } as CSSProperties}>
            <span className="label">{t("游戏内 OSD", "In-game OSD")}</span>
            <span className={`tag ${ov.attached ? "ok" : ov.target.blockedBy ? "crit" : "warn"}`} style={{ alignSelf: "flex-start" }}>{ov.target.api} · {ov.attached ? t("已注入", "injected") : t("窗口叠加", "window")}</span>
            <span className="faint" style={{ fontSize: 11.5 }}>{t(ov.reasonZh, ov.reasonEn)}</span>
            {ov.target.game && ov.target.exe && !ov.target.allowed && !ov.target.anticheat && !ov.target.blockedBy && (
              <button className="btn sm primary" style={{ alignSelf: "flex-start", marginTop: 4 }} onClick={() => allow(ov.target.exe!)}>{t("加入游戏内叠加白名单", "Add to in-game overlay allowlist")}</button>
            )}
          </div>
        )}
      </div>
      <Scope traces={[{ data: hist, color: "--fps", fill: true }]} height={110} tick={tick} />
    </Panel>
  )
}

function RecorderCard() {
  const t = useT()
  const rec = useSettings((s) => s.recorder)
  const set = useSettings((s) => s.set)
  const ids = useAsync(api.sessionIds)
  return (
    <Panel title={t("性能记录器", "Performance recorder")} color="var(--crit)">
      <div className="col" style={{ "--gap": "14px" } as CSSProperties}>
        <div className="row spread">
          <div className="col" style={{ "--gap": "2px" } as CSSProperties}>
            <b style={{ fontWeight: 500 }}>{t("自动记录游戏会话", "Record game sessions")}</b>
            <span className="faint" style={{ fontSize: 12 }}>{t("5 Hz 采样，退出游戏后生成报告", "5 Hz sampling; report on game exit")}</span>
          </div>
          <Switch on={rec.enabled} onChange={(enabled) => set({ recorder: { ...rec, enabled } })} />
        </div>
        <div className="hr" />
        <div className="row" style={{ "--gap": "26px" } as CSSProperties}>
          <div className="col" style={{ "--gap": "4px" } as CSSProperties}><span className="label">{t("报告", "Reports")}</span><Readout v={ids.data?.length ?? null} size="md" /></div>
          <div className="col" style={{ "--gap": "4px" } as CSSProperties}><span className="label">{t("始终记录", "Always")}</span><Readout v={rec.white.length} size="md" /></div>
          <div className="col" style={{ "--gap": "4px" } as CSSProperties}><span className="label">{t("排除", "Excluded")}</span><Readout v={rec.black.length} size="md" /></div>
        </div>
        <span className="faint" style={{ fontSize: 12 }}>{t("记录在后台原生线程运行，主窗口冻结或隐藏也不会丢失数据。", "Recording runs on a native backend thread — unaffected by the window being hidden.")}</span>
      </div>
    </Panel>
  )
}

// ------------------------------------------------------------ OSD studio
const ROW_LABEL: Record<string, [string, string]> = { fps: ["帧率", "FPS"], frametime: ["帧时间", "Frametime"], cpu: ["CPU", "CPU"], gpu: ["GPU", "GPU"], vram: ["显存", "VRAM"], ram: ["内存", "RAM"], disk: ["磁盘", "Disk"], net: ["网络", "Network"] }

function HotkeyInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const t = useT()
  const [rec, setRec] = useState(false)
  return (
    <button className="input mono" style={{ width: 150, textAlign: "center", color: rec ? "var(--acc)" : undefined }} onClick={() => setRec(true)} onBlur={() => setRec(false)}
      onKeyDown={(e) => {
        if (!rec) return
        e.preventDefault()
        if (e.key === "Escape") { setRec(false); return }
        if (e.key === "Backspace") { onChange(""); setRec(false); return }
        if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return
        const k = e.key.length === 1 ? e.key.toUpperCase() : e.key
        onChange([e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", k].filter(Boolean).join("+"))
        setRec(false)
      }}>
      {rec ? t("按下组合键…", "Press keys…") : value || t("未设置", "None")}
    </button>
  )
}

function OsdStudio() {
  const t = useT()
  const osd = useSettings((s) => s.osd)
  const set = useSettings((s) => s.set)
  const m = useLive((s) => s.metrics)
  const sn = useLive((s) => s.sensors)
  const fps = useLive((s) => s.fps)
  const up = (p: Partial<typeof osd>) => set({ osd: { ...osd, ...p } })
  const fake = 144 + Math.sin(Date.now() / 900) * 6
  const d: PlateData = { fps: fps?.fps ? fps : { fps: fake, low1: fake * 0.72, low01: fake * 0.6, frametimeMs: 1000 / fake }, m, s: sn, g: null }
  const corners = [{ c: 0, s: { top: 12, left: 12 } }, { c: 1, s: { top: 12, right: 12 } }, { c: 2, s: { bottom: 12, left: 12 } }, { c: 3, s: { bottom: 12, right: 12 } }] as const
  return (
    <Panel title={t("OSD 工作室", "OSD studio")} className="fill">
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.25fr) minmax(300px, 1fr)", gap: 22 }}>
        {/* the preview monitor IS the corner picker */}
        <div>
          <div style={{ position: "relative", aspectRatio: "16 / 9", borderRadius: 8, overflow: "hidden", boxShadow: "inset 0 0 0 1px var(--line-2)",
            background: "radial-gradient(120% 90% at 70% 110%, #3b2a1a 0%, transparent 55%), radial-gradient(90% 80% at 15% -10%, #1d2c46 0%, transparent 60%), linear-gradient(180deg, #11141b, #0b0b0e)" }}>
            <div style={{ position: "absolute", inset: 0, backgroundImage: "linear-gradient(rgba(255,255,255,.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.035) 1px, transparent 1px)", backgroundSize: "28px 28px" }} />
            {corners.map(({ c, s }) => (
              <button key={c} aria-label={t(`停靠角 ${c + 1}`, `Corner ${c + 1}`)} onClick={() => up({ corner: c })}
                style={{ position: "absolute", ...s, width: "42%", height: "42%", borderRadius: 6, border: osd.corner === c ? "none" : "1px dashed transparent", transition: "border-color .2s" }}
                onMouseEnter={(e) => (e.currentTarget.style.borderColor = "rgba(255,255,255,.18)")} onMouseLeave={(e) => (e.currentTarget.style.borderColor = "transparent")} />
            ))}
            <AnimatePresence>
              {osd.mode !== "off" && (
                <motion.div key="plate" layout style={{ position: "absolute", ...corners[osd.corner].s, pointerEvents: "none" }}
                  initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }} transition={{ type: "spring", stiffness: 380, damping: 32 }}>
                  <Plate d={d} rows={osd.rows} scale={osd.scale * 0.82} />
                </motion.div>
              )}
            </AnimatePresence>
            {osd.mode === "off" && <div className="empty" style={{ position: "absolute", inset: 0, color: "rgba(255,255,255,.4)" }}>{t("OSD 已关闭", "OSD is off")}</div>}
          </div>
          <div className="faint" style={{ fontSize: 12, marginTop: 8 }}>{t("点击画面任意一角以停靠 OSD", "Click any corner of the screen to dock the OSD")}</div>
        </div>
        <div className="col" style={{ "--gap": "0px" } as CSSProperties}>
          <div className="field">
            <div className="ft">{t("显示方式", "Mode")}</div>
            <div className="fd">{osd.mode === "inject" ? t("注入游戏渲染管线，独占全屏也可见。仅对下方允许注入的游戏生效；检测到反作弊时自动回退为窗口。", "Draws inside the game's frame — works in exclusive fullscreen. Only for games allowed below; anti-cheat falls back to window.") : t("透明置顶窗口，适用于无边框/窗口化游戏。", "Transparent topmost window — for borderless / windowed games.")}</div>
            <div className="fc"><Seg<OsdMode> value={osd.mode} onChange={(mode) => up({ mode })} options={[{ v: "off", label: t("关", "Off") }, { v: "window", label: t("窗口", "Window") }, { v: "inject", label: t("注入", "Inject") }]} /></div>
          </div>
          <div className="field">
            <div className="ft">{t("显示内容", "Rows")}</div>
            <div className="fc" style={{ gridRow: "auto", gridColumn: "1 / -1", flexWrap: "wrap", gap: 6 }}>
              {OSD_ROWS.map((r) => <button key={r} className={`chip ${osd.rows[r] ? "on" : ""}`} onClick={() => up({ rows: { ...osd.rows, [r]: !osd.rows[r] } })}>{t(...ROW_LABEL[r])}</button>)}
            </div>
          </div>
          <div className="field">
            <div className="ft">{t("大小", "Size")} <span className="faint num">{Math.round(osd.scale * 100)}%</span></div>
            <div className="fc" style={{ width: 160 }}><Range value={osd.scale} min={0.7} max={1.8} step={0.05} onChange={(scale) => up({ scale })} /></div>
          </div>
          <div className="field">
            <div className="ft">{t("识别到游戏时自动显示", "Show on detected games")}</div>
            <div className="fd">{t("关闭后仅对下方标记“始终 OSD”的程序显示", "When off, only programs marked “Always OSD” below")}</div>
            <div className="fc"><Switch on={osd.autoGames} onChange={(autoGames) => up({ autoGames })} /></div>
          </div>
          <div className="field">
            <div className="ft">{t("开关热键", "Toggle hotkey")}</div>
            <div className="fd">{t("全局生效，游戏中也可用", "Global — works in-game")}</div>
            <div className="fc"><HotkeyInput value={osd.hotkey} onChange={(hotkey) => up({ hotkey })} /></div>
          </div>
        </div>
      </div>
    </Panel>
  )
}

// ------------------------------------------------------------ game list
function GameList() {
  const t = useT()
  const lib = useAsync(api.games)
  const osd = useSettings((s) => s.osd)
  const rec = useSettings((s) => s.recorder)
  const set = useSettings((s) => s.set)
  const rows = useMemo(() => {
    const m = new Map<string, { exe: string; name: string; source: string; path: string | null }>()
    for (const g of lib.data ?? []) { const exe = exeBase(g.path); if (exe) m.set(exe, { exe, name: g.name, source: g.source, path: g.path }) }
    for (const exe of [...osd.targets, ...osd.injectAllow, ...rec.white, ...rec.black]) if (!m.has(exe)) m.set(exe, { exe, name: exe.replace(/\.exe$/, ""), source: t("自定义", "Custom"), path: null })
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [lib.data, osd.targets, osd.injectAllow, rec.white, rec.black, t])
  const toggle = (list: string[], exe: string, on: boolean) => (on ? [...new Set([...list, exe])] : list.filter((x) => x !== exe))
  const setRec = (exe: string, v: "auto" | "always" | "never") =>
    set({ recorder: { ...rec, white: toggle(rec.white, exe, v === "always"), black: toggle(rec.black, exe, v === "never") } })
  const add = async () => {
    for (const exe of await api.pickExe()) set({ osd: { ...useSettings.getState().osd, targets: toggle(useSettings.getState().osd.targets, lower(exe), true) } })
  }
  return (
    <Panel title={t("游戏与程序", "Games & programs")} className="fill" right={<button className="btn sm" onClick={add}><FilePlus2 size={13} />{t("添加程序", "Add program")}</button>}>
      {lib.loading ? <div className="skeleton" style={{ height: 120 }} /> : rows.length === 0 ? (
        <Empty icon={<Gamepad2 size={28} strokeWidth={1.4} />} title={t("未找到已安装的游戏", "No installed games found")} body={t("支持 Steam / Epic / GOG 库扫描，也可手动添加任意程序。", "Steam, Epic and GOG libraries are scanned; add any program manually.")} />
      ) : (
        <div className="table" style={{ "--cols": "minmax(200px, 1fr) 80px 110px 110px 230px", maxHeight: 360, overflow: "auto" } as CSSProperties}>
          <div className="thead"><button disabled>{t("名称", "Name")}</button><button disabled>{t("来源", "Source")}</button><button disabled>{t("始终 OSD", "Always OSD")}</button><button disabled title={t("仅对白名单内、无反作弊的 64 位游戏注入", "Only allow-listed, anti-cheat-free 64-bit games are injected")}>{t("游戏内注入", "In-game")}</button><button disabled>{t("性能记录", "Recording")}</button></div>
          {rows.map((g) => (
            <div key={g.exe} className="tr" style={{ height: 44 }}>
              <span className="col" style={{ "--gap": "1px" } as CSSProperties}><span className="ellipsis" style={{ color: "var(--ink)" }}>{g.name}</span><span className="mono faint ellipsis" style={{ fontSize: 10.5 }}>{g.exe}</span></span>
              <span><span className="tag">{g.source}</span></span>
              <span><Switch on={osd.targets.includes(g.exe)} onChange={(v) => set({ osd: { ...osd, targets: toggle(osd.targets, g.exe, v) } })} /></span>
              <span><Switch on={osd.injectAllow.includes(g.exe)} onChange={(v) => set({ osd: { ...osd, injectAllow: toggle(osd.injectAllow, g.exe, v) } })} label={t("游戏内注入", "In-game overlay")} /></span>
              <Seg value={rec.white.includes(g.exe) ? "always" : rec.black.includes(g.exe) ? "never" : "auto"} onChange={(v) => setRec(g.exe, v)}
                options={[{ v: "auto", label: t("自动", "Auto") }, { v: "always", label: t("始终", "Always") }, { v: "never", label: t("从不", "Never") }]} />
            </div>
          ))}
        </div>
      )}
    </Panel>
  )
}

// ------------------------------------------------------------ sessions
interface Card { id: string; meta: Session["meta"]; summary: Session["summary"]; spark: number[] }
function parse(raw: string | null, id: string): Session | null {
  try {
    const s = JSON.parse(raw ?? "") as Session
    return s?.meta && s.summary && Array.isArray(s.samples) ? { ...s, id } : null
  } catch { return null }
}

function Sessions({ onOpen }: { onOpen: (id: string) => void }) {
  const t = useT()
  const openId = useLive((s) => s.openSession)
  const [cards, setCards] = useState<Card[] | null>(null)
  const load = async () => {
    const ids = await api.sessionIds()
    const out: Card[] = []
    for (let i = 0; i < ids.length; i += 4) {
      const chunk = await Promise.all(ids.slice(i, i + 4).map(async (id) => parse(await api.sessionLoad(id), id)))
      for (const s of chunk) if (s) {
        const f = s.samples.map((x) => x.fps ?? 0)
        const step = Math.max(1, Math.floor(f.length / 48))
        out.push({ id: s.id, meta: s.meta, summary: s.summary, spark: f.filter((_, k) => k % step === 0) })
      }
    }
    setCards(out.sort((a, b) => b.meta.startedAt - a.meta.startedAt))
  }
  useEffect(() => { load() }, [openId]) // new report arrives → refresh
  const clear = async () => {
    if (await confirmDialog({ title: t("删除全部报告？", "Delete all reports?"), body: t("此操作无法撤销。", "This can't be undone."), ok: t("全部删除", "Delete all"), danger: true })) {
      await act(api.sessionDeleteAll(), t("已删除全部报告", "All reports deleted"))
      load()
    }
  }
  return (
    <Panel title={t("会话报告", "Session reports")} className="fill" right={cards?.length ? <button className="btn sm ghost danger" onClick={clear}><Trash2 size={12} />{t("全部删除", "Delete all")}</button> : null}>
      {!cards ? <div className="grid g3">{[0, 1, 2].map((i) => <div key={i} className="skeleton" style={{ height: 118 }} />)}</div> : cards.length === 0 ? (
        <Empty icon={<Clock size={28} strokeWidth={1.4} />} title={t("还没有报告", "No reports yet")} body={t("玩一局游戏，退出后这里会出现完整的帧率、温度与功耗报告。", "Play a session — on exit a full frame-rate, thermal and power report appears here.")} />
      ) : (
        <div className="grid g3">
          {cards.map((c, i) => (
            <motion.button key={c.id} className="panel pad col" style={{ textAlign: "left", "--gap": "10px" } as CSSProperties}
              initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i, 12) * 0.03 }} whileHover={{ y: -2, borderColor: "var(--line-3)" }} onClick={() => onOpen(c.id)}>
              <div className="row spread">
                <b className="ellipsis" style={{ fontWeight: 600 }}>{c.meta.exe.replace(/\.exe$/i, "")}</b>
                <span className="faint num" style={{ fontSize: 11 }}>{duration(c.meta.durationSec)}</span>
              </div>
              <div className="row spread" style={{ alignItems: "flex-end" }}>
                <div className="readout md"><span className="v">{fixed(c.summary.avgFps, 0)}</span><span className="u">FPS · 1% {fixed(c.summary.low1, 0)}</span></div>
                <Spark data={c.spark} color="var(--acc)" w={96} h={30} />
              </div>
              <span className="faint" style={{ fontSize: 11.5 }}>{new Date(c.meta.startedAt).toLocaleString()}</span>
            </motion.button>
          ))}
        </div>
      )}
    </Panel>
  )
}

function Stat({ k, v, u, sub }: { k: string; v: number | null | undefined; u?: string; sub?: string }) {
  return (
    <div className="panel pad col" style={{ "--gap": "8px" } as CSSProperties}>
      <span className="label">{k}</span>
      <Readout v={v} u={u} size="md" roll={false} />
      {sub && <span className="faint num" style={{ fontSize: 11.5 }}>{sub}</span>}
    </div>
  )
}

function Report({ id, onBack }: { id: string; onBack: () => void }) {
  const t = useT()
  const [s, setS] = useState<Session | null | undefined>(undefined)
  useEffect(() => { api.sessionLoad(id).then((r) => setS(parse(r, id))) }, [id])
  const data = useMemo(() => {
    if (!s) return null
    const base = s.samples[0]?.t > 1e12 ? s.meta.startedAt : 0
    const x = s.samples.map((p) => (p.t - base) / 1000)
    const col = (k: string) => s.samples.map((p) => (isNum(p[k]) ? p[k] : null))
    const f = s.samples.map((p) => p.fps).filter(isNum)
    const max = Math.max(1, ...f)
    const bins = Array.from({ length: 24 }, () => 0)
    for (const v of f) bins[Math.min(23, Math.floor((v / max) * 24))]++
    return { x, col, bins, max }
  }, [s])
  const del = async () => {
    if (await confirmDialog({ title: t("删除此报告？", "Delete this report?"), ok: t("删除", "Delete"), danger: true })) { await act(api.sessionDelete(id)); onBack() }
  }
  if (s === undefined) return <div className="skeleton" style={{ height: 300 }} />
  if (!s || !data) return <Empty title={t("报告无法读取", "Report can't be read")}><button className="btn" onClick={onBack}>{t("返回", "Back")}</button></Empty>
  const sm = s.summary
  const peak = Math.max(...data.bins)
  return (
    <motion.div className="col" style={{ "--gap": "14px" } as CSSProperties} variants={swapVariants(0, 10)} initial="hidden" animate="show">
      <div className="row">
        <button className="btn ghost sm" onClick={onBack}><ArrowLeft size={14} />{t("全部报告", "All reports")}</button>
        <span className="grow" />
        <button className="btn sm danger" onClick={del}><Trash2 size={12} />{t("删除", "Delete")}</button>
      </div>
      <div className="panel pad ticks row spread">
        <div className="col" style={{ "--gap": "4px" } as CSSProperties}>
          <b style={{ font: "600 24px var(--f-num)" }}>{s.meta.exe.replace(/\.exe$/i, "")}</b>
          <span className="faint">{new Date(s.meta.startedAt).toLocaleString()} · {duration(s.meta.durationSec)} · {s.meta.cpuName ?? ""}{s.meta.gpuName ? ` · ${s.meta.gpuName}` : ""}</span>
        </div>
        <div className="readout"><span className="v">{fixed(sm.avgFps, 0)}</span><span className="u">{t("平均 FPS", "avg FPS")}</span></div>
      </div>
      <div className="grid" style={{ gridTemplateColumns: "repeat(6, minmax(0,1fr))" }}>
        <Stat k="1% Low" v={sm.low1} sub={`min ${fixed(sm.minFps, 0)} · max ${fixed(sm.maxFps, 0)}`} />
        <Stat k="0.1% Low" v={sm.low01} />
        <Stat k={t("帧时间", "Frametime")} v={sm.avgFrametimeMs} u="ms" />
        <Stat k={t("CPU 温度", "CPU temp")} v={sm.avgCpuTemp} u="°C" sub={t(`峰值 ${fixed(sm.maxCpuTemp, 0)}°`, `peak ${fixed(sm.maxCpuTemp, 0)}°`)} />
        <Stat k={t("GPU 温度", "GPU temp")} v={sm.avgGpuTemp} u="°C" sub={t(`峰值 ${fixed(sm.maxGpuTemp, 0)}°`, `peak ${fixed(sm.maxGpuTemp, 0)}°`)} />
        <Stat k={t("能耗", "Energy")} v={sm.energyWh} u="Wh" sub={isNum(sm.co2Kg) ? `≈ ${(sm.co2Kg * 1000).toFixed(0)} g CO₂` : undefined} />
      </div>
      <Panel title={t("帧率", "Frame rate")} color="var(--fps)">
        <Chart sync="r" x={data.x} ys={[data.col("fps")]} series={[{ label: "FPS", color: "--acc", fill: true }]} height={200} />
      </Panel>
      <div className="grid g2">
        <Panel title={t("负载 %", "Load %")}><Chart sync="r" x={data.x} ys={[data.col("cpuLoad"), data.col("gpuLoad")]} series={[{ label: "CPU", color: "--cpu" }, { label: "GPU", color: "--gpu" }]} /></Panel>
        <Panel title={t("温度 °C", "Temperature °C")}><Chart sync="r" x={data.x} ys={[data.col("cpuTemp"), data.col("gpuTemp")]} series={[{ label: "CPU", color: "--cpu" }, { label: "GPU", color: "--gpu" }]} /></Panel>
        <Panel title={t("功耗 W", "Power W")}><Chart sync="r" x={data.x} ys={[data.col("cpuPower"), data.col("gpuPower")]} series={[{ label: "CPU", color: "--cpu", fill: true }, { label: "GPU", color: "--gpu", fill: true }]} /></Panel>
        <Panel title={t("帧率分布", "FPS distribution")}>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 180 }}>
            {data.bins.map((b, i) => (
              <motion.div key={i} title={`${Math.round((i / 24) * data.max)}–${Math.round(((i + 1) / 24) * data.max)} FPS · ${b}`} style={{ flex: 1, borderRadius: "3px 3px 0 0", background: "var(--acc)", opacity: 0.35 + 0.65 * (b / (peak || 1)), transformOrigin: "bottom" }}
                initial={{ scaleY: 0 }} animate={{ scaleY: 1 }} transition={{ delay: i * 0.015, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}>
                <div style={{ height: `${(b / (peak || 1)) * 170 + 2}px` }} />
              </motion.div>
            ))}
          </div>
          <div className="row spread faint num" style={{ fontSize: 10.5, marginTop: 6 }}><span>0</span><span>{data.max.toFixed(0)} FPS</span></div>
        </Panel>
      </div>
    </motion.div>
  )
}

let seenReport: string | null = null
export function Games() {
  const t = useT()
  // a fresh report (perf://session) opens once, the next time the user lands here
  const [open, setOpen] = useState<string | null>(() => {
    const p = useLive.getState().openSession
    if (p && p !== seenReport) { seenReport = p; return p }
    return null
  })
  return (
    <Page>
      <PageHead idx="04" title={t("游戏", "Games")} sub={t("帧率侦测、游戏内 OSD 与自动性能报告", "Frame-rate detection, in-game OSD and automatic performance reports")} />
      <AnimatePresence mode="wait" initial={false}>
        {open ? (
          <motion.div key="r" variants={swapVariants(16, 0)} initial="hidden" animate="show" exit="exit"><Report id={open} onBack={() => setOpen(null)} /></motion.div>
        ) : (
          <motion.div key="l" className="grid g3" variants={swapVariants(-16, 0)} initial="hidden" animate="show" exit="exit">
            <LiveHud />
            <RecorderCard />
            <OsdStudio />
            <Sessions onOpen={setOpen} />
            <GameList />
          </motion.div>
        )}
      </AnimatePresence>
    </Page>
  )
}
