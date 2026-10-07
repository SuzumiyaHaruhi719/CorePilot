import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import { AnimatePresence, motion } from "motion/react"
import { ChevronDown, ChevronRight, FolderOpen, Pin, RotateCcw, Search, Square, X } from "lucide-react"
import { api, PRIORITY, type Proc } from "../lib/ipc"
import { act, go, toast, useLive, useProfiles, useT } from "../lib/store"
import { bytes, cpusOf, duration, fixed, maskOf } from "../lib/util"
import { confirmDialog, Empty, Page, PageHead, Spark, usePoll, VList } from "../ui/kit"

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
function ProcIcon({ path, name }: { path: string | null; name: string }) {
  const src = useIcon(path)
  return src ? <img src={src} width={16} height={16} alt="" style={{ flex: "none" }} /> : (
    <span style={{ width: 16, height: 16, borderRadius: 4, flex: "none", display: "grid", placeItems: "center", background: "var(--raise)", color: "var(--ink-3)", font: "600 9px var(--f-num)" }}>{name[0]?.toUpperCase()}</span>
  )
}

// ------------------------------------------------------------ grouping
type SortKey = "name" | "pid" | "cpu" | "mem" | "gpu" | "gpuMem" | "power" | "threads"
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
    const agg: Proc = { ...ps[0], cpu: sum(ps, "cpu"), mem: sum(ps, "mem"), gpu: sum(ps, "gpu"), gpuMem: sum(ps, "gpuMem") || null, power: sum(ps, "power"), threads: sum(ps, "threads"), handles: sum(ps, "handles") }
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

const COLS = "minmax(240px, 2.6fr) 64px 70px 92px 64px 80px 64px 64px minmax(80px, .9fr)"

// ------------------------------------------------------------ page
export function Processes() {
  const t = useT()
  const [procs, setProcs] = useState<Proc[] | null>(null)
  const [q, setQ] = useState("")
  const [sort, setSort] = useState<SortKey>("cpu")
  const [desc, setDesc] = useState(true)
  const [grouped, setGrouped] = useState(true)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [sel, setSel] = useState<number | null>(null)
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

  const head = (k: SortKey, label: string, right = true) => (
    <button className={sort === k ? "on" : ""} style={{ justifyContent: right ? "flex-end" : "flex-start" }} onClick={() => { if (sort === k) setDesc(!desc); else { setSort(k); setDesc(k !== "name") } }}>
      {label}{sort === k && <ChevronDown size={11} style={{ transform: desc ? "" : "rotate(180deg)", transition: "transform .2s" }} />}
    </button>
  )
  const toggle = (name: string) => setOpen((o) => { const n = new Set(o); n.has(name) ? n.delete(name) : n.add(name); return n })

  return (
    <Page>
      <PageHead idx="02" title={t("进程", "Processes")}
        sub={procs ? t(`${procs.length} 个进程 · CPU 合计 ${totals!.cpu.toFixed(0)}% · 估算功耗 ${totals!.power.toFixed(0)} W`, `${procs.length} processes · CPU ${totals!.cpu.toFixed(0)}% total · ~${totals!.power.toFixed(0)} W`) : t("正在枚举…", "Enumerating…")}
        actions={<>
          <div className="search"><Search size={14} /><input className="input" style={{ width: 240 }} placeholder={t("名称、描述或 PID", "Name, description or PID")} value={q} onChange={(e) => setQ(e.target.value)} /></div>
          <button className={`chip ${grouped ? "on" : ""}`} onClick={() => setGrouped(!grouped)}>{t("按应用分组", "Group by app")}</button>
        </>} />
      <motion.div className="panel" style={{ position: "relative", overflow: "hidden", height: "calc(100vh - 210px)", minHeight: 380, display: "flex" }}
        variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0 } }}>
        <div className="table grow" style={{ "--cols": COLS } as CSSProperties}>
          <div className="thead">
            {head("name", t("名称", "Name"), false)}{head("pid", "PID")}{head("cpu", "CPU")}{head("mem", t("内存", "Memory"))}{head("gpu", "GPU")}{head("gpuMem", "VRAM")}{head("power", t("功耗", "Power"))}{head("threads", t("线程", "Threads"))}
            <button style={{ justifyContent: "flex-start" }} disabled>{t("用户", "User")}</button>
          </div>
          {!procs ? (
            <div className="col" style={{ padding: 14 }}>{Array.from({ length: 12 }, (_, i) => <div key={i} className="skeleton" style={{ height: 22, opacity: 1 - i * 0.07 }} />)}</div>
          ) : rows.length === 0 ? (
            <Empty title={t("没有匹配的进程", "No matching processes")} />
          ) : (
            <VList items={rows} row={(r) => r.key} height={36} style={{ flex: 1 }} render={(r) => (
              <ProcRow r={r} memTotal={memTotal} sel={!r.group && r.p.pid === sel} onClick={() => (r.group ? toggle(r.group.name) : setSel(r.p.pid === sel ? null : r.p.pid))} />
            )} />
          )}
        </div>
        <AnimatePresence>
          {selected && <Inspector key="insp" p={selected} trace={hist.current.get(selected.pid) ?? []} onClose={() => setSel(null)} />}
        </AnimatePresence>
      </motion.div>
    </Page>
  )
}

function ProcRow({ r, memTotal, sel, onClick }: { r: Row; memTotal: number; sel: boolean; onClick: () => void }) {
  const p = r.p
  const heatCell = (a: number, c: string, text: string) => (
    <span className="cell r heat" style={{ "--c": c, "--a": Math.min(0.3, a * 0.6) } as CSSProperties}><span>{text}</span></span>
  )
  return (
    <div className={`tr ${sel ? "sel" : ""}`} onClick={onClick} role="row" aria-selected={sel}>
      <span className="row" style={{ paddingLeft: r.depth ? 26 : 0, "--gap": "9px" } as CSSProperties}>
        {r.group ? (r.group.open ? <ChevronDown size={13} className="faint" /> : <ChevronRight size={13} className="faint" />) : r.depth === 0 && <span style={{ width: 13 }} />}
        <ProcIcon path={p.exePath} name={p.name} />
        <span className="ellipsis" style={{ color: "var(--ink)" }}>{p.description || p.name}</span>
        {r.group ? <span className="tag">{r.group.n}</span> : p.description && <span className="faint ellipsis" style={{ fontSize: 11.5 }}>{p.name}</span>}
      </span>
      <span className="cell r faint">{r.group ? "" : p.pid}</span>
      {heatCell(p.cpu / 100, "var(--cpu)", `${p.cpu.toFixed(1)}%`)}
      {heatCell((p.mem / memTotal) * 4, "var(--mem)", bytes(p.mem))}
      {heatCell(p.gpu / 100, "var(--gpu)", p.gpu ? `${p.gpu.toFixed(0)}%` : "—")}
      <span className="cell r">{p.gpuMem ? bytes(p.gpuMem) : "—"}</span>
      <span className="cell r">{p.power ? `${p.power.toFixed(1)}W` : "—"}</span>
      <span className="cell r faint">{p.threads}</span>
      <span className="cell faint ellipsis">{r.group ? "" : p.user ?? "—"}</span>
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

  const end = async () => {
    if (await confirmDialog({ title: t(`结束 ${name}？`, `End ${name}?`), body: t("未保存的数据将会丢失。", "Unsaved work in this process will be lost."), ok: t("结束任务", "End task"), danger: true }))
      await act(api.endTask(p.pid), t("已结束进程", "Process ended")).then(onClose)
  }
  const restart = async () => {
    if (await confirmDialog({ title: t(`重启 ${name}？`, `Restart ${name}?`), body: t("将结束进程并以相同路径重新启动。", "Ends the process and relaunches the same executable."), ok: t("重启", "Restart") }))
      await act(api.restartTask(p.pid), t("进程已重启", "Process restarted"))
  }
  const saveRule = () => {
    const exe = p.name.toLowerCase()
    const rules = useProfiles.getState().rules.filter((r) => r.exe !== exe)
    useProfiles.getState().set({ rules: [...rules, { exe, mask: maskOf(cpus).toString(), priority: null, on: true }] })
    toast("ok", t("已保存核心规则", "Core rule saved"), `${exe} → ${cpus.length} ${t("个逻辑核心", "logical CPUs")}`)
  }

  return (
    <motion.aside className="drawer" initial={{ x: 400, opacity: 0.6 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 400, opacity: 0 }} transition={{ type: "spring", stiffness: 380, damping: 40 }}>
      <div className="row" style={{ padding: "16px 16px 14px", borderBottom: "1px solid var(--line)", "--gap": "12px" } as CSSProperties}>
        <div style={{ width: 36, height: 36, borderRadius: 8, background: "var(--panel-2)", display: "grid", placeItems: "center", boxShadow: "inset 0 0 0 1px var(--line)" }}><ProcIcon path={p.exePath} name={p.name} /></div>
        <div className="col grow" style={{ "--gap": "2px" } as CSSProperties}>
          <b className="ellipsis" style={{ fontSize: 14 }}>{name}</b>
          <span className="faint mono ellipsis">{p.name} · PID {p.pid}</span>
        </div>
        <button className="btn ghost icon sm" onClick={onClose} aria-label={t("关闭", "Close")}><X size={15} /></button>
      </div>
      <div className="col" style={{ padding: 16, overflow: "auto", "--gap": "18px" } as CSSProperties}>
        <div>
          <div className="row spread" style={{ marginBottom: 6 }}><span className="label" style={{ color: "var(--cpu)" }}>CPU</span><span className="num">{p.cpu.toFixed(1)}%</span></div>
          <Spark data={trace} color="var(--cpu)" w={346} h={44} max={Math.max(10, ...trace)} />
        </div>
        <div className="kv">
          <span>{t("内存", "Memory")}</span><span>{bytes(p.mem)}</span>
          <span>GPU</span><span>{p.gpu ? `${p.gpu.toFixed(1)}% · ${p.gpuEngine ?? ""}` : "—"}</span>
          {p.gpuMem != null && <><span>VRAM</span><span>{bytes(p.gpuMem)}</span></>}
          <span>{t("功耗", "Power")}</span><span>{fixed(p.power, 1, " W")}</span>
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
              <button className="btn sm" disabled={!cpus.length} onClick={saveRule}><Pin size={12} />{t("保存为规则", "Save as rule")}</button>
              <button className="btn sm ghost" onClick={() => go("cores")}>{t("管理规则", "Rules")} →</button>
            </div>
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
