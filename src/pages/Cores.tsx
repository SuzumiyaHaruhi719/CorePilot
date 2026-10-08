import { useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { AnimatePresence, motion } from "motion/react"
import { ChevronDown, ChevronUp, Copy, Cpu, FolderOpen, ListTree, LogOut, Pencil, Plus, Search, Trash2, X } from "lucide-react"
import { api, PRIORITY, type Ccd, type Proc, type Topology } from "../lib/ipc"
import { enforceGroups, restoreGroups } from "../lib/boot"
import { act, groupColor, toast, useLive, useProfiles, useT, type Group } from "../lib/store"
import { bytes, cpusOf, maskOf } from "../lib/util"
import { celebrate } from "../ui/fx"
import { confirmDialog, contextMenu, EASE_IN, Empty, Layer, Page, PageHead, Panel, SETTLE, Switch, usePoll, VList } from "../ui/kit"
import { heat } from "./Overview"
import { copyPath, ProcIcon } from "./Processes"
type SortK = "name" | "n" | "cpu" | "mem" | "hw" | "group"

// ------------------------------------------------------------ helpers
const PRIOS: [number | null, string, string][] = [[null, "不改变", "Unchanged"], [PRIORITY.idle, "低", "Low"], [PRIORITY.below, "较低", "Below normal"], [PRIORITY.normal, "正常", "Normal"], [PRIORITY.above, "较高", "Above normal"], [PRIORITY.high, "高", "High"]]
const prioLabel = (p: number | null, t: (zh: string, en: string) => string) => { const x = PRIOS.find(([v]) => v === p); return x ? t(x[1], x[2]) : "" }

/** Human summary of a mask against the topology: "3D V-Cache", "全核", or "12 线程". */
function maskLabel(mask: string, topo: Topology | null, t: (zh: string, en: string) => string) {
  if (!topo) return ""
  const all = maskOf(topo.logical.map((l) => l.id)).toString()
  if (mask === all) return t("全核", "All cores")
  const ccd = topo.ccds.find((c) => c.mask === mask)
  if (ccd) return topo.hybrid ? ccd.label : `CCD${ccd.ccdId}${ccd.isVcache ? " · V-Cache" : ""}`
  return t(`${cpusOf(mask, topo.logicalCount).length} 线程`, `${cpusOf(mask, topo.logicalCount).length} threads`)
}

/** "8 核 16 线程" — physical cores (distinct coreId) + logical threads a mask owns. */
function coreCount(mask: string, topo: Topology | null, t: (zh: string, en: string) => string) {
  if (!topo) return ""
  const own = new Set(cpusOf(mask, topo.logicalCount))
  const cores = new Set(topo.logical.filter((l) => own.has(l.id)).map((l) => `${l.group}:${l.coreId}`)).size
  return topo.smt && cores !== own.size ? t(`${cores} 核 ${own.size} 线程`, `${cores}C / ${own.size}T`) : t(`${own.size} 核`, `${own.size} cores`)
}

/** Hardware threads a program may run on, and which cluster they sit in ("CCD0", "跨 CCD", "全部"). */
function hwThreads(mask: string | null, topo: Topology | null, t: (zh: string, en: string) => string) {
  if (!mask || !topo) return null
  const own = cpusOf(mask, topo.logicalCount)
  if (!own.length) return null
  const ccds = new Set(topo.logical.filter((l) => own.includes(l.id)).map((l) => l.ccdId))
  const ccd = ccds.size === 1 ? topo.ccds.find((c) => c.ccdId === [...ccds][0]) : undefined
  const where = own.length === topo.logicalCount ? t("全部", "All") : ccd ? (topo.hybrid ? ccd.label : `CCD${ccd.ccdId}`) : t("跨 CCD", "Multi-CCD")
  return { n: own.length, where }
}

function nextHue(groups: Group[]) {
  for (const h of [182, 12, 274, 92, 48, 320, 220, 140]) if (groups.every((g) => Math.abs(g.hue - h) > 20)) return h
  return Math.round(Math.random() * 360)
}

interface ExeRow { name: string; procs: Proc[]; cpu: number; mem: number; path: string | null; desc: string | null; running: boolean }

// ------------------------------------------------------------ die map
function DieMap({ topo, load, groups }: { topo: Topology; load: number[]; groups: Group[] }) {
  const t = useT()
  return (
    <div className="grid" style={{ gridTemplateColumns: `repeat(${Math.min(4, topo.ccds.length)}, minmax(0,1fr))`, gap: 14 }}>
      {topo.ccds.map((c: Ccd) => {
        const avg = c.logicalCpus.reduce((a, i) => a + (load[i] ?? 0), 0) / Math.max(1, c.logicalCpus.length)
        const users = groups.filter((g) => g.mask === c.mask)
        return (
          <motion.div key={c.ccdId} className={`panel pad ${c.isVcache ? "hot" : ""}`} variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0 } }}
            style={c.isVcache ? { background: "linear-gradient(180deg, var(--acc-soft), transparent 55%), var(--panel)" } : undefined}>
            <div className="row spread" style={{ marginBottom: 12 }}>
              <div className="row" style={{ "--gap": "8px" } as CSSProperties}>
                <b className="num" style={{ fontSize: 15 }}>{topo.hybrid ? c.label : `CCD ${c.ccdId}`}</b>
                <span className={`tag ${c.isVcache || c.kind === "pcore" ? "acc" : ""}`}>{c.kind === "vcache" ? "3D V-Cache" : c.kind === "freq" ? t("频率优先", "Frequency") : c.kind === "ecore" ? t("能效核", "E-cores") : c.kind === "pcore" ? t("性能核", "P-cores") : "CCD"}</span>
                {users.map((g) => <span key={g.id} title={g.name} style={{ width: 8, height: 8, borderRadius: "50%", background: groupColor(g.hue), boxShadow: `0 0 8px ${groupColor(g.hue)}` }} />)}
              </div>
              <span className="num faint">{avg.toFixed(0)}%</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(16, c.logicalCpus.length)}, 1fr)`, gap: 3, height: 40 }}>
              {c.logicalCpus.map((i) => {
                const l = load[i] ?? 0
                return (
                  <div key={i} title={`CPU ${i} · ${l.toFixed(0)}%`} style={{ position: "relative", borderRadius: 3, overflow: "hidden", background: "var(--hover)" }}>
                    <div style={{ position: "absolute", inset: 0, background: heat(l), opacity: 0.85, transformOrigin: "bottom", transform: `scaleY(${Math.max(0.04, l / 100)})`, transition: "transform 900ms cubic-bezier(.16,1,.3,1), background 900ms" }} />
                  </div>
                )
              })}
            </div>
          </motion.div>
        )
      })}
    </div>
  )
}

// ------------------------------------------------------------ edit cores modal
function CoreEditor({ group, topo, onClose }: { group: Group; topo: Topology; onClose: () => void }) {
  const t = useT()
  const [cpus, setCpus] = useState(() => cpusOf(group.mask, topo.logicalCount))
  const save = async () => {
    const mask = maskOf(cpus).toString()
    const groups = useProfiles.getState().groups.map((g) => (g.id === group.id ? { ...g, mask } : g))
    useProfiles.getState().set({ groups })
    onClose()
    if (useLive.getState().coreOpt) await enforceGroups()
    toast("ok", t(`已更新「${group.name}」的核心`, `Updated cores for “${group.name}”`))
  }
  return (
    <Layer>
      <motion.div className="scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
      <motion.div className="modal wide" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.97 }} transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}>
        <h3>{t(`编辑「${group.name}」的核心`, `Cores for “${group.name}”`)}</h3>
        <p className="faint" style={{ fontSize: 12.5 }}>{t("选择这个分组的进程允许运行的逻辑核心。", "Pick the logical CPUs this group's processes may run on.")}</p>
        <div className="row wrap" style={{ margin: "18px 0 14px", "--gap": "8px" } as CSSProperties}>
          <button className={`chip ${cpus.length === topo.logicalCount ? "on" : ""}`} onClick={() => setCpus(topo.logical.map((l) => l.id))}>{t("全核", "All cores")}</button>
          {topo.ccds.map((c) => {
            const on = cpus.length === c.logicalCpus.length && c.logicalCpus.every((i) => cpus.includes(i))
            return <button key={c.ccdId} className={`chip ${on ? "on" : ""}`} onClick={() => setCpus(c.logicalCpus)}>{topo.hybrid ? c.label : `CCD${c.ccdId}`}{c.isVcache ? " · V-Cache" : ""}</button>
          })}
          <span className="grow" />
          <span className="num faint">{cpus.length}/{topo.logicalCount}</span>
        </div>
        {topo.ccds.map((c) => (
          <div key={c.ccdId} style={{ marginBottom: 12 }}>
            <div className="label" style={{ marginBottom: 8 }}>{topo.hybrid ? c.label : `CCD ${c.ccdId}`}</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(16, 1fr)", gap: 4 }}>
              {c.logicalCpus.map((id) => {
                const on = cpus.includes(id)
                return (
                  <motion.button key={id} whileTap={{ scale: 0.9 }} onClick={() => setCpus(on ? cpus.filter((x) => x !== id) : [...cpus, id])}
                    style={{ height: 30, borderRadius: 6, font: "600 11px var(--f-num)", background: on ? "var(--acc-soft)" : "var(--hover)", color: on ? "var(--ink)" : "var(--ink-4)", boxShadow: `inset 0 0 0 1px ${on ? "var(--acc-line)" : "var(--line)"}`, transition: "background .15s, color .15s, box-shadow .15s" }}>
                    {id}
                  </motion.button>
                )
              })}
            </div>
          </div>
        ))}
        <div className="row end">
          <button className="btn ghost" onClick={onClose}>{t("取消", "Cancel")}</button>
          <button className="btn primary" disabled={!cpus.length} onClick={save}>{t("保存", "Save")}</button>
        </div>
      </motion.div>
    </Layer>
  )
}

// ------------------------------------------------------------ page
export function Cores() {
  const t = useT()
  const topo = useLive((s) => s.topo)
  const load = useLive((s) => s.metrics?.perCore ?? [])
  const coreOpt = useLive((s) => s.coreOpt)
  const groups = useProfiles((s) => s.groups)
  const onStartup = useProfiles((s) => s.optimizeOnStartup)
  const set = useProfiles((s) => s.set)
  const [procs, setProcs] = useState<Proc[] | null>(null)
  const [selGroup, setSelGroup] = useState<string | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [q, setQ] = useState("")
  const [editing, setEditing] = useState<Group | null>(null)
  const [busy, setBusy] = useState(false)
  const [sort, setSort] = useState<{ k: SortK; desc: boolean }>({ k: "cpu", desc: true })
  const headRef = useRef<HTMLDivElement>(null)

  usePoll(async () => { const p = await api.processes(); setProcs(p); useLive.setState({ procCount: p.length }) }, 2000)

  const ownerOf = useMemo(() => {
    const m = new Map<string, Group>()
    for (const g of groups) for (const p of g.patterns) if (!m.has(p)) m.set(p, g)
    return m
  }, [groups])
  // live affinity of a running instance, else the mask its group will apply
  const maskFor = (r: ExeRow) => r.procs.find((p) => p.affinity)?.affinity ?? ownerOf.get(r.name)?.mask ?? null
  const running = useMemo(() => {
    const m = new Map<string, ExeRow>()
    for (const p of procs ?? []) {
      if (!p.settable) continue // never offer what we can't schedule
      const k = p.name.toLowerCase()
      const r = m.get(k) ?? { name: k, procs: [], cpu: 0, mem: 0, path: p.exePath, desc: p.description, running: true }
      r.path ??= p.exePath // sandboxed children (Chrome, QQ…) often hide their path; take the first that has one
      r.desc ??= p.description
      r.procs.push(p); r.cpu += p.cpu; r.mem += p.mem
      m.set(k, r)
    }
    return m
  }, [procs])
  const group = groups.find((g) => g.id === selGroup) ?? null
  const rows = useMemo(() => {
    const k = q.trim().toLowerCase()
    let list: ExeRow[]
    if (group) {
      list = group.patterns.map((n) => running.get(n) ?? { name: n, procs: [], cpu: 0, mem: 0, path: null, desc: null, running: false })
    } else list = [...running.values()]
    if (k) list = list.filter((r) => r.name.includes(k) || r.desc?.toLowerCase().includes(k))
    const val = (r: ExeRow): number | string => sort.k === "name" ? (r.desc || r.name).toLowerCase() : sort.k === "n" ? r.procs.length : sort.k === "mem" ? r.mem : sort.k === "hw" ? (hwThreads(maskFor(r), topo, t)?.n ?? -1) : sort.k === "group" ? (ownerOf.get(r.name)?.name ?? "\uffff") : r.cpu
    const dir = sort.desc ? -1 : 1
    // running programs stay above stopped ones whatever the column
    return list.sort((a, b) => {
      if (a.running !== b.running) return Number(b.running) - Number(a.running)
      const va = val(a), vb = val(b)
      const r = typeof va === "string" ? va.localeCompare(vb as string) : va - (vb as number)
      return r * dir || a.name.localeCompare(b.name)
    })
  }, [group, running, q, sort, ownerOf, topo]) // eslint-disable-line react-hooks/exhaustive-deps
  const head = (k: SortK, label: string, right = false) => (
    <button className={`${right ? "r" : ""} ${sort.k === k ? "on" : ""}`} onClick={() => setSort((s) => ({ k, desc: s.k === k ? !s.desc : k !== "name" && k !== "group" }))} aria-sort={sort.k === k ? (sort.desc ? "descending" : "ascending") : "none"}>
      {label}{sort.k === k && (sort.desc ? <ChevronDown size={12} /> : <ChevronUp size={12} />)}
    </button>
  )

  const toggleOpt = async (on: boolean) => {
    if (on) celebrate(document.activeElement, 0.35) // the clicked switch has focus
    setBusy(true)
    useLive.setState({ coreOpt: on })
    toast(on ? "ok" : "info", on ? t("核心优化已启用", "Core optimization on") : t("核心优化已关闭，已恢复全核", "Core optimization off — all cores restored"))
    setTimeout(() => setBusy(false), 1200)
  }
  const assign = async (target: Group, names = [...picked]) => {
    const next = groups.map((g) => (g.id === target.id ? { ...g, patterns: [...new Set([...g.patterns, ...names])] } : { ...g, patterns: g.patterns.filter((p) => !names.includes(p)) }))
    set({ groups: next })
    setPicked(new Set())
    if (useLive.getState().coreOpt) await enforceGroups()
    toast("ok", t(`已将 ${names.length} 个程序分配到「${target.name}」`, `Assigned ${names.length} programs to “${target.name}”`))
  }
  const removeFromGroup = async (names = [...picked], from = group) => {
    if (!from) return
    const group = from
    set({ groups: groups.map((g) => (g.id === group.id ? { ...g, patterns: g.patterns.filter((p) => !names.includes(p)) } : g)) })
    setPicked(new Set())
    const failed = useLive.getState().coreOpt ? await restoreGroups([{ ...group, patterns: names }]) : 0
    toast("ok", t(`已从「${group.name}」移出 ${names.length} 个程序`, `Removed ${names.length} programs from “${group.name}”`) + (failed ? t(` · ${failed} 个恢复全核失败`, ` · ${failed} couldn't restore all cores`) : ""))
  }
  const addGroup = () => {
    const vc = topo?.ccds.find((c) => c.isVcache)
    const g: Group = { id: crypto.randomUUID(), name: t("新建分组", "New group"), hue: nextHue(groups), mask: vc?.mask ?? (topo ? maskOf(topo.logical.map((l) => l.id)).toString() : "0"), priority: null, patterns: [] }
    set({ groups: [...groups, g] })
    setSelGroup(g.id)
  }
  const updGroup = (p: Partial<Group>) => group && set({ groups: groups.map((g) => (g.id === group.id ? { ...g, ...p } : g)) })
  const delGroup = async () => {
    if (!group) return
    if (!(await confirmDialog({ title: t(`删除分组「${group.name}」？`, `Delete group “${group.name}”?`), body: t("其中的程序会恢复全核运行。", "Its programs get all cores back."), ok: t("删除", "Delete"), danger: true }))) return
    if (useLive.getState().coreOpt) await restoreGroups([group])
    set({ groups: groups.filter((g) => g.id !== group.id) })
    setSelGroup(null)
  }
  const allPicked = rows.length > 0 && rows.every((r) => picked.has(r.name))
  const settableCount = running.size

  return (
    <Page>
      <PageHead title={t("核心分配", "Core assignment")}
        sub={topo ? t(`${topo.detection} · ${topo.ccds.length} 个核心簇 · 按 CCD 分组调度进程，游戏固定到 3D V-Cache、后台挪到频率核心`, `${topo.detection} · ${topo.ccds.length} core clusters · pin games to V-Cache, move background apps to the frequency CCD`) : "…"}
        actions={
          <div className="panel row" style={{ padding: "10px 16px", "--gap": "18px", borderRadius: 12 } as CSSProperties}>
            <div className="row" style={{ "--gap": "10px" } as CSSProperties}>
              <Switch on={coreOpt} disabled={busy} onChange={toggleOpt} label={t("核心优化", "Core optimization")} />
              <div className="col" style={{ "--gap": "1px" } as CSSProperties}>
                <b style={{ fontWeight: 600, fontSize: 13 }} className={coreOpt ? "c-acc" : undefined}>{t("核心优化", "Core optimization")}</b>
                <span className="faint" style={{ fontSize: 11.5 }}>{coreOpt ? t("每 5 秒自动应用分组", "Groups enforced every 5 s") : t("已关闭", "Off")}</span>
              </div>
            </div>
            <i style={{ width: 1, height: 28, background: "var(--line)" }} />
            <label className="row" style={{ "--gap": "8px", fontSize: 12.5, cursor: "pointer" } as CSSProperties}>
              <input type="checkbox" className="check" checked={onStartup} onChange={(e) => set({ optimizeOnStartup: e.target.checked })} />
              {t("开机自动启用", "Enable at launch")}
            </label>
          </div>
        } />

      {topo ? <DieMap topo={topo} load={load} groups={groups} /> : <div className="skeleton" style={{ height: 110 }} />}

      <motion.div className="panel" style={{ display: "grid", gridTemplateColumns: "300px minmax(0,1fr)", height: "calc(100vh - 400px)", minHeight: 440, overflow: "hidden", position: "relative" }}
        variants={{ hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0 } }}>
        {/* group rail */}
        <div className="col scroller" style={{ borderRight: "1px solid var(--line)", padding: 12, overflow: "auto", "--gap": "8px" } as CSSProperties}>
          <div className="row spread" style={{ padding: "4px 4px 6px" }}>
            <span className="label">{t("进程分组", "Groups")}</span>
            <button className="btn icon sm primary" onClick={addGroup} title={t("新建分组", "New group")}><Plus size={14} /></button>
          </div>
          <GroupCard active={!group} onClick={() => { setSelGroup(null); setPicked(new Set()) }} icon={<ListTree size={15} />} name={t("全部进程", "All processes")} meta={t(`${settableCount} 个可调度程序`, `${settableCount} schedulable programs`)} />
          <AnimatePresence initial={false}>
            {groups.map((g) => {
              const live = g.patterns.filter((p) => running.has(p)).length
              return (
                <GroupCard key={g.id} active={g.id === selGroup} color={groupColor(g.hue)} onClick={() => { setSelGroup(g.id); setPicked(new Set()) }}
                  name={g.name} topo={topo} mask={g.mask}
                  meta={[/线程|threads/.test(maskLabel(g.mask, topo, t)) ? t("自定义核心", "Custom cores") : maskLabel(g.mask, topo, t), g.priority != null ? prioLabel(g.priority, t) : null].filter(Boolean).join(" · ")}
                  count={<><b style={{ color: live ? "var(--ok)" : undefined }}>{live}</b> {t("运行", "live")} / {g.patterns.length} {t("个程序", "programs")}</>} />
              )
            })}
          </AnimatePresence>
        </div>

        {/* table */}
        <div className="col" style={{ minHeight: 0, "--gap": 0 } as CSSProperties}>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={group?.id ?? "all"} className="row" style={{ padding: "14px 16px", borderBottom: "1px solid var(--line)", minHeight: 62, "--gap": "10px" } as CSSProperties}
              initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
              {group ? (
                <>
                  <button title={t("换个颜色", "Change color")} onClick={() => updGroup({ hue: (group.hue + 47) % 360 })}
                    style={{ width: 30, height: 30, borderRadius: 8, display: "grid", placeItems: "center", background: "var(--hover)", boxShadow: "inset 0 0 0 1px var(--line)" }}>
                    <span style={{ width: 11, height: 11, borderRadius: "50%", background: groupColor(group.hue), boxShadow: `0 0 10px ${groupColor(group.hue)}` }} />
                  </button>
                  <input className="input" style={{ width: 170, fontWeight: 600 }} value={group.name} onChange={(e) => updGroup({ name: e.target.value })} />
                  <button className="btn sm" onClick={() => setEditing(group)}><Cpu size={13} />{maskLabel(group.mask, topo, t)} · {coreCount(group.mask, topo, t)}<Pencil size={11} className="faint" /></button>
                  <select className="input" style={{ height: 28, width: 120 }} value={group.priority ?? ""} onChange={(e) => updGroup({ priority: e.target.value === "" ? null : Number(e.target.value) })}>
                    {PRIOS.map(([v, zh, en]) => <option key={String(v)} value={v ?? ""}>{t("优先级：", "Priority: ")}{t(zh, en)}</option>)}
                  </select>
                  <button className="btn ghost icon sm danger" title={t("删除分组", "Delete group")} onClick={delGroup}><Trash2 size={13} /></button>
                </>
              ) : (
                <div className="col" style={{ "--gap": "1px" } as CSSProperties}>
                  <b style={{ fontWeight: 600 }}>{t("全部进程", "All processes")}</b>
                  <span className="faint" style={{ fontSize: 12 }}>{t("勾选程序，然后在底部选择要分配到的分组", "Tick programs, then pick a group in the bar below")}</span>
                </div>
              )}
              <span className="grow" />
              <div className="search"><Search size={14} /><input className="input" style={{ width: 200 }} placeholder={t("搜索程序", "Search programs")} value={q} onChange={(e) => setQ(e.target.value)} /></div>
            </motion.div>
          </AnimatePresence>
          <div className="table" style={{ "--cols": "22px minmax(220px,2fr) 54px 70px 86px 112px minmax(120px,1fr)", flex: 1, minHeight: 0 } as CSSProperties}>
            <div className="thead" ref={headRef}>
              <input type="checkbox" className="check" checked={allPicked} ref={(el) => { if (el) el.indeterminate = !allPicked && picked.size > 0 }}
                onChange={() => setPicked(allPicked ? new Set() : new Set(rows.map((r) => r.name)))} aria-label={t("全选", "Select all")} />
              {head("name", t("程序", "Program"))}{head("n", t("实例", "Inst."), true)}{head("cpu", "CPU", true)}{head("mem", t("内存", "Memory"), true)}{head("hw", t("硬件线程", "HW threads"), true)}{head("group", t("分组", "Group"))}
            </div>
            {!procs ? <div className="col" style={{ padding: 16 }}>{[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="skeleton" style={{ height: 24 }} />)}</div>
              : rows.length === 0 ? <Empty icon={<Cpu size={28} strokeWidth={1.4} />} title={group ? t("这个分组还没有程序", "No programs in this group yet") : t("没有匹配的程序", "No matching programs")} body={group ? t("回到「全部进程」，勾选程序后分配到这里。", "Go to All processes, tick programs and assign them here.") : undefined} />
              : (
                <VList items={rows} row={(r) => r.name} height={42} style={{ flex: 1, paddingBottom: picked.size ? 80 : 0 }} flip={`${sort.k}:${sort.desc}`} onScrollX={(x) => { if (headRef.current) headRef.current.scrollLeft = x }} render={(r) => {
                  const g = ownerOf.get(r.name)
                  const on = picked.has(r.name)
                  const hw = hwThreads(maskFor(r), topo, t)
                  return (
                    <div className={`tr ${on ? "sel" : ""}`} style={{ height: 42, opacity: r.running ? 1 : 0.55, cursor: "pointer" }}
                      onClick={() => setPicked((s) => { const n = new Set(s); n.has(r.name) ? n.delete(r.name) : n.add(r.name); return n })}
                      onContextMenu={(e) => contextMenu(e, [
                        { label: t("在资源管理器中显示", "Show in Explorer"), icon: <FolderOpen />, disabled: !r.path, onClick: () => act(api.reveal(r.path!)) },
                        { label: t("复制路径", "Copy path"), icon: <Copy />, disabled: !r.path, onClick: () => copyPath(r.path!) },
                        "sep",
                        ...groups.filter((x) => x.id !== g?.id).map((x) => ({ label: t(`分配到「${x.name}」`, `Assign to “${x.name}”`), icon: <span className="mdot" style={{ background: groupColor(x.hue) }} />, onClick: () => assign(x, [r.name]) })),
                        g && { label: t(`移出「${g.name}」`, `Remove from “${g.name}”`), icon: <LogOut />, danger: true, onClick: () => removeFromGroup([r.name], g) },
                      ])}>
                      <input type="checkbox" className="check" checked={on} readOnly tabIndex={-1} />
                      <span className="row" style={{ "--gap": "10px" } as CSSProperties}>
                        <ProcIcon path={r.path} name={r.name} />
                        <span className="ellipsis" style={{ color: "var(--ink)" }}>{r.desc || r.name}</span>
                        {r.desc && <span className="faint ellipsis mono" style={{ fontSize: 11 }}>{r.name}</span>}
                        {!r.running && <span className="tag">{t("未运行", "not running")}</span>}
                      </span>
                      <span className="cell r faint">{r.procs.length || ""}</span>
                      <span className="cell r">{r.running ? `${r.cpu.toFixed(1)}%` : ""}</span>
                      <span className="cell r">{r.running ? bytes(r.mem) : ""}</span>
                      <span className="cell r hwt">{hw ? <><b className="num">{hw.n}</b><span>{hw.where}</span></> : <span className="faint">—</span>}</span>
                      <span>{g ? <span className="tag" style={{ color: groupColor(g.hue), borderColor: `color-mix(in oklab, ${groupColor(g.hue)} 40%, transparent)` }}><span className="dot" />{g.name}</span> : <span className="faint" style={{ fontSize: 12 }}>—</span>}</span>
                    </div>
                  )
                }} />
              )}
          </div>
        </div>

        {/* floating batch bar */}
        <AnimatePresence>
          {picked.size > 0 && (
            <motion.div className="batchbar" role="toolbar" aria-label={t("批量分配", "Batch assign")}
              initial={{ opacity: 0, y: 24, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1, transition: SETTLE }} exit={{ opacity: 0, y: 16, scale: 0.98, transition: { duration: 0.16, ease: EASE_IN } }}>
              <span className="count"><motion.b key={picked.size} className="num" initial={{ y: -8, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}>{picked.size}</motion.b></span>
              <span className="lbl">{t("个程序 · 分配到", picked.size === 1 ? "program · assign to" : "programs · assign to")}</span>
              {groups.filter((g) => g.id !== group?.id).map((g) => (
                <button key={g.id} className="gchip" onClick={() => assign(g)} style={{ "--c": groupColor(g.hue) } as CSSProperties}><i />{g.name}</button>
              ))}
              {group && <><span className="sep" /><button className="gchip out" onClick={() => removeFromGroup()}><LogOut size={13} />{t("移出分组", "Remove")}</button></>}
              <span className="sep" />
              <button className="x" onClick={() => setPicked(new Set())} aria-label={t("清除选择", "Clear selection")} title={t("清除选择", "Clear selection")}><X size={14} /></button>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      <AnimatePresence>{editing && topo && <CoreEditor key="ce" group={editing} topo={topo} onClose={() => setEditing(null)} />}</AnimatePresence>
      {!groups.length && <Panel><Empty title={t("还没有分组", "No groups yet")} body={t("新建一个分组，例如把游戏固定到 3D V-Cache CCD。", "Create a group — e.g. pin games to the V-Cache CCD.")} /></Panel>}
    </Page>
  )
}

/** Which logical CPUs a mask owns, compressed to ranges: "0–7, 16–23". */
function cpuRanges(list: number[]) {
  const out: string[] = []
  for (let i = 0; i < list.length; i++) {
    let j = i
    while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++
    out.push(i === j ? String(list[i]) : `${list[i]}–${list[j]}`)
    i = j
  }
  return out.join(", ")
}

function GroupCard({ active, color, onClick, name, meta, count, icon, topo, mask }: { active: boolean; color?: string; onClick: () => void; name: string; meta: string; count?: ReactNode; icon?: ReactNode; topo?: Topology | null; mask?: string }) {
  const c = color ?? "var(--acc)"
  const t = useT()
  const own = topo && mask ? new Set(cpusOf(mask, topo.logicalCount)) : null
  return (
    <motion.button layout onClick={onClick} className="col" initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.12 } }}
      whileTap={{ scale: 0.98 }} transition={SETTLE}
      style={{ position: "relative", overflow: "hidden", width: "100%", flex: "none", textAlign: "left", padding: "12px 14px", borderRadius: 11, "--gap": "6px",
        transitionProperty: "background-color, border-color, box-shadow", transitionDuration: "var(--t-med)", transitionTimingFunction: "var(--ease)",
        background: active ? `color-mix(in oklab, ${c} 12%, var(--panel-2))` : "var(--panel-2)",
        border: `1px solid ${active ? `color-mix(in oklab, ${c} 55%, transparent)` : "var(--line)"}`,
        boxShadow: active ? `0 0 16px -4px color-mix(in oklab, ${c} 60%, transparent), inset 3px 0 0 0 ${c}` : "none" } as CSSProperties}>
      <span className="row" style={{ "--gap": "9px", minWidth: 0 } as CSSProperties}>
        {icon ?? <span style={{ width: 10, height: 10, borderRadius: "50%", background: c, flex: "none", boxShadow: active ? `0 0 10px ${c}` : "none" }} />}
        <span className="ellipsis" style={{ fontWeight: 600, fontSize: 13.5 }}>{name}</span>
      </span>
      <span className="faint" style={{ fontSize: 11.5, paddingLeft: 19, lineHeight: 1.45 }}>{meta}</span>
      {own && topo && (
        <>
          {/* one cell per logical CPU — lit where this group may run */}
          <span className="corestrip" style={{ "--c": c, gridTemplateColumns: `repeat(${Math.min(topo.logicalCount, 32)}, 1fr)` } as CSSProperties} aria-hidden>
            {topo.logical.map((l) => <i key={l.id} className={own.has(l.id) ? "on" : ""} />)}
          </span>
          <span className="num faint" style={{ fontSize: 11, paddingLeft: 19 }}>
            {mask ? coreCount(mask, topo, t) : ""} · CPU {own.size === topo.logicalCount ? t("全部", "all") : cpuRanges([...own].sort((a, b) => a - b))}
          </span>
        </>
      )}
      {count && <span className="num faint" style={{ fontSize: 11.5, paddingLeft: 19 }}>{count}</span>}
    </motion.button>
  )
}
