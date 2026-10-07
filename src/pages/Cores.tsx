import { useMemo, useState, type CSSProperties } from "react"
import { AnimatePresence, motion } from "motion/react"
import { FilePlus2, Plus, Trash2 } from "lucide-react"
import { api, PRIORITY, type Ccd, type Topology } from "../lib/ipc"
import { useLive, useProfiles, useT, type Rule } from "../lib/store"
import { bytes, cpusOf, lower } from "../lib/util"
import { Empty, Page, PageHead, Panel, Switch, useAsync } from "../ui/kit"
import { heat } from "./Overview"

function CcdBlock({ c, topo, load }: { c: Ccd; topo: Topology; load: number[] }) {
  const t = useT()
  // physical cores of this CCD, each with its SMT threads
  const cores = useMemo(() => {
    const m = new Map<number, number[]>()
    for (const id of c.logicalCpus) {
      const l = topo.logical.find((x) => x.id === id)!
      const k = l.coreId
      m.set(k, [...(m.get(k) ?? []), id])
    }
    return [...m.values()]
  }, [c, topo])
  const avg = c.logicalCpus.reduce((a, i) => a + (load[i] ?? 0), 0) / Math.max(1, c.logicalCpus.length)
  const kindTag = { vcache: ["3D V-Cache", "acc"], freq: [t("频率优先", "Frequency"), ""], pcore: [t("性能核", "P-cores"), "acc"], ecore: [t("能效核", "E-cores"), ""], standard: ["CCD", ""] }[c.kind]
  return (
    <motion.div className="panel pad ticks" style={c.isVcache ? { borderColor: "var(--acc-line)", background: "linear-gradient(180deg, var(--acc-soft), transparent 40%), var(--panel)" } : undefined}
      variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0 } }}>
      <div className="row spread" style={{ marginBottom: 14 }}>
        <div className="col" style={{ "--gap": "4px" } as CSSProperties}>
          <div className="row"><b className="num" style={{ fontSize: 16 }}>{topo.hybrid ? c.label : `CCD ${c.ccdId}`}</b><span className={`tag ${kindTag[1]}`}>{kindTag[0]}</span></div>
          <span className="faint" style={{ fontSize: 12 }}>{cores.length} {t("核", "cores")} · {c.logicalCpus.length} {t("线程", "threads")}{c.l3Bytes ? ` · L3 ${bytes(c.l3Bytes, 0)}` : ""}</span>
        </div>
        <div className="readout sm"><span className="v">{avg.toFixed(0)}</span><span className="u">%</span></div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(8, cores.length)}, 1fr)`, gap: 6 }}>
        {cores.map((threads, i) => (
          <div key={i} style={{ padding: 4, borderRadius: 6, background: "var(--bg)", boxShadow: "inset 0 0 0 1px var(--line)", display: "grid", gridTemplateColumns: `repeat(${threads.length}, 1fr)`, gap: 3 }}>
            {threads.map((id) => {
              const l = load[id] ?? 0
              return (
                <div key={id} title={`CPU ${id} · ${l.toFixed(0)}%`} style={{ height: 68, borderRadius: 3, position: "relative", overflow: "hidden", background: "var(--hover)" }}>
                  <div style={{ position: "absolute", inset: 0, background: heat(l), opacity: 0.85, transformOrigin: "bottom", transform: `scaleY(${Math.max(0.03, l / 100)})`, transition: "transform 900ms cubic-bezier(.16,1,.3,1), background 900ms" }} />
                  <span className="num" style={{ position: "absolute", left: 0, right: 0, bottom: 3, textAlign: "center", fontSize: 9, color: "var(--ink-2)" }}>{id}</span>
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </motion.div>
  )
}

const PRIOS: [number | null, string, string][] = [[null, "不改变", "Unchanged"], [PRIORITY.idle, "低", "Low"], [PRIORITY.below, "较低", "Below normal"], [PRIORITY.normal, "正常", "Normal"], [PRIORITY.above, "较高", "Above normal"], [PRIORITY.high, "高", "High"]]

function Target({ rule, topo, onChange }: { rule: Rule; topo: Topology; onChange: (mask: string | null) => void }) {
  const t = useT()
  const cur = rule.mask ? cpusOf(rule.mask, topo.logicalCount) : null
  return (
    <div className="row wrap" style={{ "--gap": "5px" } as CSSProperties}>
      <button className={`chip ${!cur ? "on" : ""}`} style={{ height: 24 }} onClick={() => onChange(null)}>{t("不限制", "Any")}</button>
      {topo.ccds.map((c) => (
        <button key={c.ccdId} className={`chip ${rule.mask === c.mask ? "on" : ""}`} style={{ height: 24 }} onClick={() => onChange(c.mask)}>{c.label || `CCD${c.ccdId}`}</button>
      ))}
      {cur && !topo.ccds.some((c) => c.mask === rule.mask) && <span className="tag acc">{t(`自定义 ${cur.length} 线程`, `Custom · ${cur.length}T`)}</span>}
    </div>
  )
}

function Rules() {
  const t = useT()
  const topo = useLive((s) => s.topo)
  const rules = useProfiles((s) => s.rules)
  const set = useProfiles((s) => s.set)
  const [name, setName] = useState("")
  const procs = useAsync(api.processes)
  const games = useAsync(api.games)
  const upd = (i: number, p: Partial<Rule>) => set({ rules: rules.map((r, k) => (k === i ? { ...r, ...p } : r)) })
  const add = (exe: string) => {
    const e = lower(exe)
    if (!e || rules.some((r) => r.exe === e)) return
    const vc = topo?.ccds.find((c) => c.isVcache)
    set({ rules: [...rules, { exe: e.endsWith(".exe") ? e : `${e}.exe`, mask: vc?.mask ?? null, priority: null, on: true }] })
    setName("")
  }
  const suggestions = useMemo(() => {
    const k = lower(name)
    if (!k) return []
    const pool = new Set([...(games.data ?? []).map((g) => g.path.split(/[\\/]/).pop()!.toLowerCase()), ...(procs.data ?? []).map((p) => p.name.toLowerCase())])
    return [...pool].filter((n) => n.includes(k) && !rules.some((r) => r.exe === n)).slice(0, 6)
  }, [name, procs.data, games.data, rules])
  if (!topo) return null
  return (
    <Panel title={t("核心规则", "Core rules")} className="fill" right={<span className="faint" style={{ fontSize: 12 }}>{t("每 5 秒对匹配进程自动应用，窗口隐藏时也生效", "Enforced every 5 s on matching processes — even while hidden")}</span>}>
      <div className="row" style={{ marginBottom: 12, position: "relative" }}>
        <input className="input" style={{ width: 300 }} placeholder={t("进程名，例如 cs2.exe", "Process name, e.g. cs2.exe")} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add(name)} />
        <button className="btn" onClick={() => add(name)} disabled={!name.trim()}><Plus size={14} />{t("添加", "Add")}</button>
        <button className="btn ghost" onClick={async () => (await api.pickExe()).forEach(add)}><FilePlus2 size={14} />{t("浏览 exe…", "Browse exe…")}</button>
        <AnimatePresence>
          {suggestions.length > 0 && (
            <motion.div className="panel" style={{ position: "absolute", top: 34, left: 0, width: 300, zIndex: 5, padding: 4, boxShadow: "var(--pop-shadow)" }} initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              {suggestions.map((s) => <button key={s} className="nav" style={{ display: "flex", width: "100%", height: 30 }} onClick={() => add(s)}><span className="nav-bg" /><span className="mono">{s}</span></button>)}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      {rules.length === 0 ? (
        <Empty title={t("还没有规则", "No rules yet")} body={t("把游戏固定到 3D V-Cache CCD、把后台程序压到能效核——规则会在进程启动后自动生效。", "Pin games to the V-Cache CCD or push background apps onto E-cores — rules apply automatically when the process starts.")} />
      ) : (
        <div className="table" style={{ "--cols": "minmax(160px,1fr) minmax(260px,2fr) 150px 44px 34px" } as CSSProperties}>
          <div className="thead" style={{ background: "transparent" }}>
            <button disabled>{t("进程", "Process")}</button><button disabled>{t("核心", "Cores")}</button><button disabled>{t("优先级", "Priority")}</button><button disabled>{t("启用", "On")}</button><span />
          </div>
          <AnimatePresence initial={false}>
            {rules.map((r, i) => (
              <motion.div key={r.exe} className="tr" style={{ height: 46 }} layout initial={{ opacity: 0, x: -8 }} animate={{ opacity: r.on ? 1 : 0.5, x: 0 }} exit={{ opacity: 0, x: 8 }}>
                <span className="mono ellipsis" style={{ color: "var(--ink)" }}>{r.exe}</span>
                <Target rule={r} topo={topo} onChange={(mask) => upd(i, { mask })} />
                <select className="input" style={{ height: 26 }} value={r.priority ?? ""} onChange={(e) => upd(i, { priority: e.target.value === "" ? null : Number(e.target.value) })}>
                  {PRIOS.map(([v, zh, en]) => <option key={String(v)} value={v ?? ""}>{t(zh, en)}</option>)}
                </select>
                <Switch on={r.on} onChange={(on) => upd(i, { on })} label={r.exe} />
                <button className="btn ghost icon sm" aria-label={t("删除", "Delete")} onClick={() => set({ rules: rules.filter((_, k) => k !== i) })}><Trash2 size={13} /></button>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
    </Panel>
  )
}

export function Cores() {
  const t = useT()
  const topo = useLive((s) => s.topo)
  const load = useLive((s) => s.metrics?.perCore ?? [])
  return (
    <Page>
      <PageHead idx="03" title={t("核心调度", "Core scheduling")}
        sub={topo ? `${topo.detection} · ${topo.physicalCores}C/${topo.logicalCount}T${topo.smt ? " · SMT" : ""}${topo.hybrid ? t(" · 混合架构", " · hybrid") : ""}` : "…"} />
      {topo ? (
        <div className="grid" style={{ gridTemplateColumns: `repeat(${Math.min(2, topo.ccds.length)}, minmax(0,1fr))` }}>
          {topo.ccds.map((c) => <CcdBlock key={c.ccdId} c={c} topo={topo} load={load} />)}
        </div>
      ) : <div className="skeleton" style={{ height: 180 }} />}
      <Rules />
    </Page>
  )
}
