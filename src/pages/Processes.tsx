import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import { AnimatePresence, motion } from "motion/react"
import { AppWindow, Check, ChevronDown, ChevronRight, Columns3, Copy, FolderOpen, Info, Pin, RotateCcw, Search, Square, X } from "lucide-react"
import { api, PRIORITY, type Proc } from "../lib/ipc"
import { act, go, groupColor, PROC_COLS, tf, toast, useLive, useProfiles, useSettings, useT, type ProcCol } from "../lib/store"
import { enforceGroups } from "../lib/boot"
import { bytes, cpusOf, duration, fixed, maskOf } from "../lib/util"
import { confirmDialog, contextMenu, EASE, EASE_IN, Empty, Page, PageHead, Mini, Seg, SHEET, usePoll, VList } from "../ui/kit"
import { Perf } from "./Perf"

// ------------------------------------------------------------ icons
const icons = new Map<string, string | null | Promise<string | null>>()
function useIcon(path: string | null) {
  const [src, setSrc] = useState<string | null>(() => { const v = path ? icons.get(path) : null; return typeof v === "string" ? v : null })
  useEffect(() => {
    if (!path) return
    let v = icons.get(path)
    if (typeof v === "string" || v === null) { setSrc(v); return }
    if (!v) { v = api.processIcon(path).catch(() => null); icons.set(path, v); v.then((r) => icons.set(path, r)) }
    let live = true
    v.then((r) => live && setSrc(r))
    return () => { live = false }
  }, [path])
  return src
}
export function ProcIcon({ path, name }: { path: string | null; name: string }) {
  const src = useIcon(path)
  return src ? <img src={src} width={16} height={16} alt="" draggable={false} style={{ flex: "none" }} /> : (
    <AppWindow size={15} strokeWidth={1.6} aria-label={name} style={{ flex: "none", color: "var(--ink-4)" }} />
  )
}

const ENGINE_ZH: Record<string, string> = { "Video Encode": "视频编码", "Video Decode": "视频解码", "Video Processing": "视频处理", Compute: "计算", Copy: "复制", Security: "安全" }
const engine = (e: string) => tf(ENGINE_ZH[e] ?? e, e)
/** Per-engine totals across a group's instances, busiest first. */
function mergeEngines(ps: Proc[]): [string, number][] {
  const m = new Map<string, number>()
  for (const p of ps) for (const [e, v] of p.gpuEngines ?? []) m.set(e, (m.get(e) ?? 0) + v)
  return [...m].map(([e, v]): [string, number] => [e, Math.min(100, v)]).sort((a, b) => b[1] - a[1])
}

// ------------------------------------------------------------ shared actions (inspector + right-click)
export function copyPath(path: string) {
  navigator.clipboard.writeText(path).then(() => toast("ok", tf("已复制路径", "Path copied"), path), () => toast("err", tf("无法写入剪贴板", "Couldn't write to the clipboard")))
}
async function endProc(p: Proc, then?: () => void) {
  const name = p.description || p.name
  if (await confirmDialog({ title: tf(`结束 ${name}？`, `End ${name}?`), body: tf("未保存的数据将会丢失。", "Unsaved work in this process will be lost."), ok: tf("结束任务", "End task"), danger: true }))
    await act(api.endTask(p.pid), tf("已结束进程", "Process ended")).then(then)
}
async function restartProc(p: Proc) {
  const name = p.description || p.name
  if (await confirmDialog({ title: tf(`重启 ${name}？`, `Restart ${name}?`), body: tf("将结束进程并以相同路径重新启动。", "Ends the process and relaunches the same executable."), ok: tf("重启", "Restart") }))
    await act(api.restartTask(p.pid), tf("进程已重启", "Process restarted"))
}

// ------------------------------------------------------------ grouping
type SortKey = "name" | "pid" | "cpu" | "mem" | "gpu" | "gpuMem" | "power" | "threads" | "handles" | "cpuTime" | "platform" | "user"
interface Row { key: string; depth: 0 | 1; group?: { name: string; n: number; open: boolean }; p: Proc }
const sum = (ps: Proc[], k: keyof Proc) => ps.reduce((a, p) => a + (Number(p[k]) || 0), 0)

function buildRows(procs: Proc[], q: string, sort: SortKey, desc: boolean, open: Set<string>, grouped: boolean): Row[] {
  const k = q.trim().toLowerCase()
  const list = k ? procs.filter((p) => p.name.toLowerCase().includes(k) || p.description?.toLowerCase().includes(k) || String(p.pid) === k) : procs
  const cmp = (a: Proc, b: Proc) => {
    const va = a[sort] ?? 0, vb = b[sort] ?? 0
    const r = typeof va === "string" ? va.localeCompare(vb as string) : (va as number) - (vb as number)
    return desc ? -r : r
  }
  if (!grouped) return list.slice().sort(cmp).map((p) => ({ key: String(p.pid), depth: 0, p }))
  const by = new Map<string, Proc[]>()
  for (const p of list) { const g = by.get(p.name); g ? g.push(p) : by.set(p.name, [p]) }
  const heads = [...by.entries()].map(([name, ps]) => {
    if (ps.length === 1) return { name, ps, agg: ps[0] }
    // icon/path from the first instance that has one (protected children report none)
    const agg: Proc = { ...ps[0], exePath: ps.find((p) => p.exePath)?.exePath ?? null, cpu: sum(ps, "cpu"), mem: sum(ps, "mem"), gpu: Math.min(100, sum(ps, "gpu")), gpuEngines: mergeEngines(ps), gpuMem: sum(ps, "gpuMem") || null, power: sum(ps, "power"), threads: sum(ps, "threads"), handles: sum(ps, "handles") }
    return { name, ps, agg }
  })
  heads.sort((a, b) => cmp(a.agg, b.agg))
  const rows: Row[] = []
  for (const h of heads) {
    if (h.ps.length === 1) { rows.push({ key: String(h.agg.pid), depth: 0, p: h.agg }); continue }
    const isOpen = open.has(h.name) || !!k
    rows.push({ key: `g:${h.name}`, depth: 0, group: { name: h.name, n: h.ps.length, open: isOpen }, p: h.agg })
    if (isOpen) for (const p of h.ps.slice().sort(cmp)) rows.push({ key: String(p.pid), depth: 1, p })
  }
  return rows
}

/** Optional columns (设置 → procCols; toggled from the 列 menu or a header right-click). */
const COL: Record<ProcCol, { w: string; zh: string; en: string; sort?: SortKey; left?: boolean }> = {
  pid: { w: "64px", zh: "PID", en: "PID", sort: "pid" },
  cpu: { w: "70px", zh: "CPU", en: "CPU", sort: "cpu" },
  mem: { w: "92px", zh: "内存", en: "Memory", sort: "mem" },
  gpu: { w: "64px", zh: "GPU", en: "GPU", sort: "gpu" },
  engine: { w: "156px", zh: "GPU 引擎", en: "GPU engine", left: true },
  vram: { w: "80px", zh: "显存", en: "VRAM", sort: "gpuMem" },
  power: { w: "76px", zh: "功耗指数", en: "Power impact", sort: "power" },
  threads: { w: "64px", zh: "线程", en: "Threads", sort: "threads" },
  handles: { w: "70px", zh: "句柄", en: "Handles", sort: "handles" },
  cpuTime: { w: "84px", zh: "CPU 时间", en: "CPU time", sort: "cpuTime" },
  platform: { w: "64px", zh: "平台", en: "Platform", sort: "platform", left: true },
  user: { w: "minmax(80px, .9fr)", zh: "用户", en: "User", sort: "user", left: true },
}

// ------------------------------------------------------------ page
export function Processes() {
  const t = useT()
  const [procs, setProcs] = useState<Proc[] | null>(null)
  const [q, setQ] = useState("")
  const [sort, setSort] = useState<SortKey>("cpu")
  const [desc, setDesc] = useState(true)
  const headRef = useRef<HTMLDivElement>(null)
  const [grouped, setGrouped] = useState(true)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [sel, setSel] = useState<number | null>(null)
  const [view, setView] = useState<"list" | "perf">("list")
  const memTotal = useLive((s) => s.metrics?.memTotal ?? 1)
  const hist = useRef(new Map<number, number[]>())

  usePoll(async () => {
    const list = await api.processes()
    setProcs(list)
    useLive.setState({ procCount: list.length })
    if (sel != null) {
      const p = list.find((x) => x.pid === sel)
      const h = hist.current.get(sel) ?? []
      hist.current.set(sel, [...h.slice(-59), p?.cpu ?? 0])
    }
  }, 2000)

  const rows = useMemo(() => (procs ? buildRows(procs, q, sort, desc, open, grouped) : []), [procs, q, sort, desc, open, grouped])
  const selected = procs?.find((p) => p.pid === sel) ?? null
  const totals = useMemo(() => procs && { cpu: sum(procs, "cpu"), gpu: sum(procs, "gpu"), power: sum(procs, "power") }, [procs])

  const cols = useSettings((s) => s.procCols).filter((c) => COL[c])
  const gridCols = ["minmax(240px, 2.6fr)", ...cols.map((c) => COL[c].w)].join(" ")
  const colMenu = (e: { clientX: number; clientY: number; preventDefault(): void; stopPropagation(): void }) => contextMenu(e, PROC_COLS.map((c) => ({
    label: t(COL[c].zh, COL[c].en), icon: cols.includes(c) ? <Check /> : <span />,
    onClick: () => useSettings.getState().set({ procCols: cols.includes(c) ? cols.filter((x) => x !== c) : PROC_COLS.filter((x) => x === c || cols.includes(x)) }),
  })))
  const head = (k: SortKey, label: string, right = true) => (
    <button className={sort === k ? "on" : ""} style={{ justifyContent: right ? "flex-end" : "flex-start" }} onClick={() => { if (sort === k) setDesc(!desc); else { setSort(k); setDesc(k !== "name") } }}>
      {label}{sort === k && <ChevronDown size={11} style={{ transform: desc ? "" : "rotate(180deg)", transition: "transform .2s" }} />}
    </button>
  )
  const toggle = (name: string) => setOpen((o) => { const n = new Set(o); n.has(name) ? n.delete(name) : n.add(name); return n })

  return (
    <Page>
      <PageHead idx="02" title={t("进程", "Processes")}
        sub={procs ? t(`${procs.length} 个进程 · CPU 合计 ${totals!.cpu.toFixed(0)}%`, `${procs.length} processes · CPU ${totals!.cpu.toFixed(0)}% total`) : t("正在枚举…", "Enumerating…")}
        actions={<>
          {/* the switch stays the right-most item, so the list-only tools fade in and
              out beside it instead of the switch jumping across the header */}
          <AnimatePresence initial={false}>
          {view === "list" && <motion.div key="tools" className="row" style={{ "--gap": "10px" } as CSSProperties}
            initial={{ opacity: 0, x: 14 }} animate={{ opacity: 1, x: 0, transition: { duration: 0.3, ease: EASE } }} exit={{ opacity: 0, x: 14, transition: { duration: 0.14, ease: EASE_IN } }}><div className="search"><Search size={14} /><input className="input" style={{ width: 240 }} placeholder={t("名称、描述或 PID", "Name, description or PID")} value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <button className={`chip ${grouped ? "on" : ""}`} onClick={() => setGrouped(!grouped)}>{t("按应用分组", "Group by app")}</button>
          <button className="btn ghost sm" title={t("显示的列", "Columns")} onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); colMenu({ clientX: r.left, clientY: r.bottom + 6, preventDefault() {}, stopPropagation() {} }) }}><Columns3 size={14} />{t("列", "Columns")}</button></motion.div>}
          </AnimatePresence>
          <Seg value={view} onChange={setView} options={[{ v: "list", label: t("进程", "Processes") }, { v: "perf", label: t("性能", "Performance") }]} />
        </>} />
      {/* custom = direction, so the EXITING view also slides away from the tab you picked */}
      <AnimatePresence mode="wait" initial={false} custom={view === "perf" ? 1 : -1}>
      <motion.div key={view} className="col" style={{ "--gap": "16px" } as CSSProperties} custom={view === "perf" ? 1 : -1} initial="hidden" animate="show" exit="exit"
        variants={{ hidden: (d: number) => ({ opacity: 0, x: 28 * d }), show: { opacity: 1, x: 0, transition: { duration: 0.32, ease: EASE, staggerChildren: 0.03 } }, exit: (d: number) => ({ opacity: 0, x: -28 * d, transition: { duration: 0.13, ease: EASE_IN } }) }}>
      {view === "perf" ? <Perf /> : (
      <motion.div className="panel" style={{ position: "relative", overflow: "hidden", height: "calc(100vh - 210px)", minHeight: 380, display: "flex" }}
        variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0 } }}>
        <div className="table grow" style={{ "--cols": gridCols } as CSSProperties}>
          <div className="thead" ref={headRef} onContextMenu={colMenu}>
            {head("name", t("名称", "Name"), false)}
            {cols.map((c) => COL[c].sort ? <span key={c} style={{ display: "contents" }}>{head(COL[c].sort!, t(COL[c].zh, COL[c].en), !COL[c].left)}</span> : <button key={c} style={{ justifyContent: "flex-start" }} disabled>{t(COL[c].zh, COL[c].en)}</button>)}
          </div>
          {!procs ? (
            <div className="col" style={{ padding: 14 }}>{Array.from({ length: 12 }, (_, i) => <div key={i} className="skeleton" style={{ height: 22, opacity: 1 - i * 0.07 }} />)}</div>
          ) : rows.length === 0 ? (
            <Empty title={t("没有匹配的进程", "No matching processes")} />
          ) : (
            <VList items={rows} row={(r) => r.key} height={36} style={{ flex: 1 }} flip={`${sort}:${desc}:${grouped}`} onScrollX={(x) => { if (headRef.current) headRef.current.scrollLeft = x }} render={(r) => (
              <ProcRow r={r} cols={cols} memTotal={memTotal} sel={!r.group && r.p.pid === sel} onClick={() => (r.group ? toggle(r.group.name) : setSel(r.p.pid === sel ? null : r.p.pid))}
                onMenu={(e) => contextMenu(e, [
                  { label: t("在资源管理器中显示", "Show in Explorer"), icon: <FolderOpen />, disabled: !r.p.exePath, onClick: () => act(api.reveal(r.p.exePath!)) },
                  { label: t("复制路径", "Copy path"), icon: <Copy />, disabled: !r.p.exePath, onClick: () => copyPath(r.p.exePath!) },
                  "sep",
                  r.group
                    ? { label: r.group.open ? t("收起实例", "Collapse instances") : t(`展开 ${r.group.n} 个实例`, `Expand ${r.group.n} instances`), icon: r.group.open ? <ChevronDown /> : <ChevronRight />, onClick: () => toggle(r.group!.name) }
                    : { label: t("详细信息", "Details"), icon: <Info />, onClick: () => setSel(r.p.pid) },
                  !r.group && { label: t("重启", "Restart"), icon: <RotateCcw />, disabled: !r.p.exePath, onClick: () => restartProc(r.p) },
                  !r.group && { label: t("结束任务", "End task"), icon: <Square />, danger: true, onClick: () => endProc(r.p, () => setSel(null)) },
                ])} />
            )} />
          )}
        </div>
        <AnimatePresence>
          {selected && <Inspector key="insp" p={selected} trace={hist.current.get(selected.pid) ?? []} onClose={() => setSel(null)} />}
        </AnimatePresence>
      </motion.div>
      )}
      </motion.div>
      </AnimatePresence>
    </Page>
  )
}

function ProcRow({ r, cols, memTotal, sel, onClick, onMenu }: { r: Row; cols: ProcCol[]; memTotal: number; sel: boolean; onClick: () => void; onMenu: (e: React.MouseEvent) => void }) {
  const p = r.p
  const heatCell = (a: number, c: string, text: string) => (
    <span className="cell r heat" style={{ "--c": c, "--a": `${Math.min(28, a * 60).toFixed(1)}%` } as CSSProperties}><span>{text}</span></span>
  )
  return (
    <div className={`tr ${sel ? "sel" : ""}`} onClick={onClick} onContextMenu={onMenu} role="row" aria-selected={sel}>
      <span className="row" style={{ paddingLeft: r.depth ? 26 : 0, "--gap": "9px" } as CSSProperties}>
        {r.group ? (r.group.open ? <ChevronDown size={13} className="faint" /> : <ChevronRight size={13} className="faint" />) : r.depth === 0 && <span style={{ width: 13 }} />}
        <ProcIcon path={p.exePath} name={p.name} />
        <span className="ellipsis" style={{ color: "var(--ink)" }}>{p.description || p.name}</span>
        {r.group ? <span className="tag">{r.group.n}</span> : p.description && <span className="faint ellipsis" style={{ fontSize: 11.5 }}>{p.name}</span>}
      </span>
      {cols.map((c) => {
        switch (c) {
          case "pid": return <span key={c} className="cell r faint">{r.group ? "" : p.pid}</span>
          case "cpu": return <span key={c} style={{ display: "contents" }}>{heatCell(p.cpu / 100, "var(--cpu)", `${p.cpu.toFixed(1)}%`)}</span>
          case "mem": return <span key={c} style={{ display: "contents" }}>{heatCell((p.mem / memTotal) * 4, "var(--mem)", bytes(p.mem))}</span>
          case "gpu": return <span key={c} style={{ display: "contents" }}>{heatCell(p.gpu / 100, "var(--gpu)", p.gpu >= 0.5 ? `${p.gpu.toFixed(0)}%` : "—")}</span>
          case "engine": return <span key={c} className="engs">{p.gpuEngines?.filter(([, v]) => v >= 0.5).slice(0, 2).map(([e, v], i) => <span key={e} className={i ? "eng dim" : "eng"} title={`${engine(e)} ${v.toFixed(1)}%`}>{engine(e)}<b className="num">{v.toFixed(0)}%</b></span>)}</span>
          case "vram": return <span key={c} className="cell r">{p.gpuMem ? bytes(p.gpuMem) : "—"}</span>
          case "power": return <span key={c} className="cell r">{p.power >= 0.1 ? p.power.toFixed(1) : "—"}</span>
          case "threads": return <span key={c} className="cell r faint">{p.threads}</span>
          case "handles": return <span key={c} className="cell r faint">{p.handles || "—"}</span>
          case "cpuTime": return <span key={c} className="cell r faint">{p.cpuTime ? duration(p.cpuTime) : "—"}</span>
          case "platform": return <span key={c} className="cell faint">{p.platform ?? "—"}</span>
          case "user": return <span key={c} className="cell faint ellipsis">{r.group ? "" : p.user ?? "—"}</span>
        }
      })}
    </div>
  )
}

// ------------------------------------------------------------ inspector
function Inspector({ p, trace, onClose }: { p: Proc; trace: number[]; onClose: () => void }) {
  const t = useT()
  const topo = useLive((s) => s.topo)
  const n = topo?.logicalCount ?? 0
  const [cpus, setCpus] = useState<number[]>(() => cpusOf(p.affinity, n))
  useEffect(() => { setCpus(cpusOf(p.affinity, n)) }, [p.pid, n]) // eslint-disable-line react-hooks/exhaustive-deps
  const system = !p.user || /^(SYSTEM|LOCAL SERVICE|NETWORK SERVICE)$/i.test(p.user)
  const name = p.description || p.name

  const end = () => endProc(p, onClose)
  const restart = () => restartProc(p)
  const groups = useProfiles((s) => s.groups)
  const exe = p.name.toLowerCase()
  const current = groups.find((g) => g.patterns.includes(exe))
  const assign = async (id: string) => {
    const next = groups.map((g) => (g.id === id ? { ...g, patterns: [...new Set([...g.patterns, exe])] } : { ...g, patterns: g.patterns.filter((x) => x !== exe) }))
    useProfiles.getState().set({ groups: next })
    if (useLive.getState().coreOpt) await enforceGroups()
    toast("ok", t(`已加入「${next.find((g) => g.id === id)!.name}」`, `Added to “${next.find((g) => g.id === id)!.name}”`), exe)
  }

  return (
    <motion.aside className="drawer" initial={{ x: "100%" }} animate={{ x: 0, transition: { duration: 0.44, ease: SHEET } }} exit={{ x: "100%", transition: { duration: 0.24, ease: EASE_IN } }}>
      <div className="row" style={{ padding: "16px 16px 14px", borderBottom: "1px solid var(--line)", "--gap": "12px" } as CSSProperties}>
        <div style={{ width: 36, height: 36, borderRadius: 8, background: "var(--panel-2)", display: "grid", placeItems: "center", boxShadow: "inset 0 0 0 1px var(--line)" }}><ProcIcon path={p.exePath} name={p.name} /></div>
        <div className="col grow" style={{ "--gap": "2px" } as CSSProperties}>
          <b className="ellipsis" style={{ fontSize: 14 }}>{name}</b>
          <span className="faint mono ellipsis">{p.name} · PID {p.pid}</span>
        </div>
        <button className="btn ghost icon sm" onClick={onClose} aria-label={t("关闭", "Close")}><X size={15} /></button>
      </div>
      <div className="col scroller" style={{ padding: 16, overflow: "auto", "--gap": "18px" } as CSSProperties}>
        <div>
          <div className="row spread" style={{ marginBottom: 6 }}><span className="label" style={{ color: "var(--cpu)" }}>CPU</span><span className="num">{p.cpu.toFixed(1)}%</span></div>
          <Mini data={trace} color="var(--cpu)" h={64} max={Math.max(10, ...trace) * 1.15} />
        </div>
        <div className="kv">
          <span>{t("内存", "Memory")}</span><span>{bytes(p.mem)}</span>
          <span>GPU</span><span>{p.gpuEngines?.length ? p.gpuEngines.map(([e, v]) => `${engine(e)} ${v.toFixed(0)}%`).join(" · ") : "—"}</span>
          {p.gpuMem != null && <><span>VRAM</span><span>{bytes(p.gpuMem)}</span></>}
          <span title={t("相对占用指数（0–100），不是瓦数", "Relative impact index (0–100), not watts")}>{t("功耗指数", "Power impact")}</span><span>{fixed(p.power, 1)}</span>
          <span>{t("线程 / 句柄", "Threads / handles")}</span><span>{p.threads} / {p.handles}</span>
          <span>{t("CPU 时间", "CPU time")}</span><span>{duration(p.cpuTime)}</span>
          <span>{t("用户", "User")}</span><span>{p.user ?? "—"}</span>
          <span>{t("平台", "Platform")}</span><span>{p.platform ?? "—"}</span>
          <span>{t("父进程", "Parent")}</span><span>{p.parentPid || "—"}</span>
        </div>
        {p.exePath && <div className="mono selectable faint" style={{ fontSize: 11, wordBreak: "break-all", padding: "8px 10px", background: "var(--bg)", borderRadius: 6 }}>{p.exePath}</div>}

        <div className="col" style={{ "--gap": "8px" } as CSSProperties}>
          <span className="label">{t("优先级", "Priority")}</span>
          <div className="row wrap" style={{ "--gap": "6px" } as CSSProperties}>
            {([["idle", "低", "Low"], ["below", "较低", "Below"], ["normal", "正常", "Normal"], ["above", "较高", "Above"], ["high", "高", "High"]] as const).map(([k, zh, en]) => (
              <button key={k} className="btn sm" disabled={!p.settable} onClick={() => act(api.setPriority(p.pid, PRIORITY[k]), t(`优先级：${zh}`, `Priority: ${en}`))}>{t(zh, en)}</button>
            ))}
          </div>
        </div>

        {topo && (
          <div className="col" style={{ "--gap": "8px" } as CSSProperties}>
            <div className="row spread"><span className="label">{t("CPU 亲和性", "CPU affinity")}</span><span className="faint num" style={{ fontSize: 11 }}>{cpus.length}/{n}</span></div>
            <div className="row wrap" style={{ "--gap": "6px" } as CSSProperties}>
              <button className={`chip ${cpus.length === n ? "on" : ""}`} onClick={() => setCpus(topo.logical.map((l) => l.id))}>{t("全部", "All")}</button>
              {topo.ccds.map((c) => {
                const on = cpus.length === c.logicalCpus.length && c.logicalCpus.every((i) => cpus.includes(i))
                return <button key={c.ccdId} className={`chip ${on ? "on" : ""}`} onClick={() => setCpus(c.logicalCpus)}>{c.label || `CCD${c.ccdId}`}</button>
              })}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(16, 1fr)", gap: 3 }}>
              {topo.logical.map((l) => {
                const on = cpus.includes(l.id)
                return (
                  <button key={l.id} title={`CPU ${l.id}`} disabled={!p.settable} onClick={() => setCpus(on ? cpus.filter((c) => c !== l.id) : [...cpus, l.id])}
                    style={{ height: 20, borderRadius: 3, font: "500 9px var(--f-num)", background: on ? "var(--acc-soft)" : "var(--hover)", color: on ? "var(--ink)" : "var(--ink-4)", boxShadow: `inset 0 0 0 1px ${on ? "var(--acc-line)" : "var(--line)"}`, transition: "all .15s" }}>
                    {l.id}
                  </button>
                )
              })}
            </div>
            <div className="row" style={{ "--gap": "6px" } as CSSProperties}>
              <button className="btn sm primary" disabled={!p.settable || !cpus.length} onClick={() => act(api.setAffinity(p.pid, maskOf(cpus)), t("亲和性已应用", "Affinity applied"))}>{t("应用", "Apply")}</button>
              <button className="btn sm ghost" onClick={() => go("cores")}>{t("核心分配", "Core groups")} →</button>
            </div>
            {groups.length > 0 && (
              <div className="row wrap" style={{ "--gap": "6px" } as CSSProperties}>
                <span className="faint" style={{ fontSize: 12 }}><Pin size={11} /> {t("分组", "Group")}</span>
                {groups.map((g) => (
                  <button key={g.id} className={`chip ${current?.id === g.id ? "on" : ""}`} style={{ height: 24, fontSize: 11.5 }} disabled={!p.settable} onClick={() => assign(g.id)}>
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: groupColor(g.hue) }} />{g.name}
                  </button>
                ))}
              </div>
            )}
            {!p.settable && <span className="faint" style={{ fontSize: 12 }}>{t("受保护进程，无法修改调度。", "Protected process — scheduling can't be changed.")}</span>}
          </div>
        )}
      </div>
      <div className="row" style={{ marginTop: "auto", padding: 14, borderTop: "1px solid var(--line)", "--gap": "8px" } as CSSProperties}>
        <button className="btn sm ghost" disabled={!p.exePath} onClick={() => act(api.reveal(p.exePath!))}><FolderOpen size={13} />{t("文件位置", "Location")}</button>
        <span className="grow" />
        <button className="btn sm" onClick={restart}><RotateCcw size={12} />{t("重启", "Restart")}</button>
        <button className="btn sm danger" onClick={end} title={system ? t("系统进程，建议改用重启", "System process — restart is safer") : undefined}><Square size={11} />{t("结束任务", "End task")}</button>
      </div>
    </motion.aside>
  )
}
