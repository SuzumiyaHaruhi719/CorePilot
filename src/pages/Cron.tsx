// 定时任务 (Cron): optimization jobs run by the backend scheduler (automation.rs),
// plus the memory-leak panel (also shown on 优化). Intervals below a task's safe
// minimum are offered but disabled, with the reason — the backend clamps anyway.
import { useEffect, useState, type CSSProperties, type ReactNode } from "react"
import { AnimatePresence, motion } from "motion/react"
import { AlertTriangle, CheckCircle2, Eraser, Globe, MemoryStick, RotateCcw, ScanSearch, Sparkles, Square, XCircle } from "lucide-react"
import { api, type AutoStatus, type JobCfg, type LeakReport, type LeakSuspect } from "../lib/ipc"
import { act, useSettings, useT } from "../lib/store"
import { bytes, duration } from "../lib/util"
import { confirmDialog, Empty, Meter, Page, PageHead, Panel, Range, Seg, Spark, Switch, usePoll } from "../ui/kit"
import { ProcIcon } from "./Processes"

const IVALS: [number, string, string][] = [[10, "10 秒", "10 s"], [60, "1 分钟", "1 min"], [600, "10 分钟", "10 min"], [1800, "30 分钟", "30 min"], [3600, "1 小时", "1 h"], [21600, "6 小时", "6 h"], [86400, "每天", "Daily"]]
/** mirrors automation.rs min_secs */
const MIN: Record<string, number> = { trim_ws: 300, purge_standby: 300, clean_temp: 3600, flush_dns: 600, leak_alert: 60 }
const TASK: Record<string, { icon: ReactNode; zh: [string, string, string]; en: [string, string, string] }> = {
  purge_standby: { icon: <Eraser size={16} />, zh: ["清空待机内存", "把系统缓存的待机页面归还为空闲内存，缓解大型游戏的卡顿", "过于频繁会丢掉 Windows 的文件缓存，反而更多读盘、更卡。推荐用“条件触发”：只在空闲内存不足时清理"], en: ["Purge standby list", "Return cached standby pages to free memory; helps stutter in big games", "Too often throws away Windows' file cache: more disk reads, more stutter. Prefer the condition trigger: only when free memory runs low"] },
  trim_ws: { icon: <MemoryStick size={16} />, zh: ["释放工作集", "让所有进程把暂时不用的内存交回系统", "过于频繁会让每个程序反复把内存读回来，界面与游戏都会变卡"], en: ["Trim working sets", "Every process hands idle memory back to the system", "Too often forces every app to page its memory back in; apps and games stutter"] },
  clean_temp: { icon: <Sparkles size={16} />, zh: ["清理临时文件", "删除用户与系统临时目录里的残留文件", "临时文件不会每分钟堆积，频繁扫描只是无谓的磁盘读写"], en: ["Clean temp files", "Delete leftovers in user and system temp folders", "Temp files don't pile up by the minute; frequent sweeps are pointless disk churn"] },
  flush_dns: { icon: <Globe size={16} />, zh: ["刷新 DNS 缓存", "清空解析缓存，修复部分网站打不开", "缓存本身能加快访问，频繁清空只会让每次打开网页都重新解析"], en: ["Flush DNS cache", "Clear the resolver cache when sites fail to load", "The cache speeds lookups up; flushing it often just re-resolves every site"] },
  leak_alert: { icon: <ScanSearch size={16} />, zh: ["内存泄漏提醒", "后台持续检测进程与内核内存，发现持续增长时通知你", "检测依赖分钟级的趋势，更频繁的检查不会更早发现"], en: ["Memory-leak alerts", "Watches process and kernel memory in the background and tells you about sustained growth", "Detection works on minute-scale trends; checking more often finds nothing sooner"] },
}
const ORDER = ["purge_standby", "trim_ws", "clean_temp", "flush_dns", "leak_alert"]
/** 60 → "1 分钟", 3600 → "1 小时" */
const span = (sec: number, t: (zh: string, en: string) => string) => sec >= 3600 ? t(`${sec / 3600} 小时`, `${sec / 3600} h`) : t(`${Math.round(sec / 60)} 分钟`, `${Math.round(sec / 60)} min`)

/** Seconds until a deadline, re-rendered every second. The status poll runs every
 *  2 s, so showing its snapshot directly made the countdown skip two at a time. */
function Countdown({ at }: { at: number }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id) }, [])
  return <>{duration(Math.max(0, Math.ceil((at - now) / 1000)))}</>
}

function Job({ j, st, onChange }: { j: JobCfg; st: (AutoStatus & { polledAt: number }) | null; onChange: (p: Partial<JobCfg>) => void }) {
  const t = useT()
  const meta = TASK[j.task]
  const min = MIN[j.task] ?? 60
  const at = st && st.next[j.id] != null ? st.polledAt + st.next[j.id] * 1000 : null
  const last = st?.history.find((r) => r.id === j.id)
  const mem = st?.mem
  return (
    <div className={`job rv ${j.enabled ? "on" : ""}`}>
      <div className="jhead">
        <span className="jic">{meta.icon}</span>
        <div className="col grow" style={{ "--gap": "2px", minWidth: 0 } as CSSProperties}>
          <b>{t(meta.zh[0], meta.en[0])}</b>
          <span className="faint" style={{ fontSize: 12 }}>{t(meta.zh[1], meta.en[1])}</span>
        </div>
        <Switch on={j.enabled} onChange={(enabled) => onChange({ enabled })} label={t(meta.zh[0], meta.en[0])} />
      </div>
      <AnimatePresence initial={false}>
        {j.enabled && (
          <motion.div className="jbody" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1, transition: { duration: 0.3, ease: [0.16, 1, 0.3, 1] } }} exit={{ height: 0, opacity: 0, transition: { duration: 0.18 } }}>
            <div className="col" style={{ "--gap": "12px", paddingTop: 12 } as CSSProperties}>
              {j.task === "purge_standby" && (
                <div className="row" style={{ "--gap": "10px" } as CSSProperties}>
                  <span className="label">{t("触发方式", "Trigger")}</span>
                  <Seg value={j.cond ? "cond" : "time"} onChange={(v) => onChange({ cond: v === "cond" })} options={[{ v: "cond", label: t("条件触发", "When low") }, { v: "time", label: t("定时", "Interval") }]} />
                </div>
              )}
              {j.cond ? (
                <div className="grid g2" style={{ gap: 18 }}>
                  <div className="col" style={{ "--gap": "6px" } as CSSProperties}>
                    <span className="label">{t("空闲内存低于", "Free memory below")} <b className="num">{j.freeMb} MB</b>{mem && <span className="faint num"> · {t("当前", "now")} {bytes(mem.free, 0)}</span>}</span>
                    <Range value={j.freeMb} min={256} max={8192} step={256} onChange={(freeMb) => onChange({ freeMb })} />
                  </div>
                  <div className="col" style={{ "--gap": "6px" } as CSSProperties}>
                    <span className="label">{t("且待机列表高于", "and standby above")} <b className="num">{j.standbyMb} MB</b>{mem && <span className="faint num"> · {t("当前", "now")} {bytes(mem.standby, 0)}</span>}</span>
                    <Range value={j.standbyMb} min={0} max={16384} step={256} onChange={(standbyMb) => onChange({ standbyMb })} />
                  </div>
                </div>
              ) : (
                <div className="col" style={{ "--gap": "6px" } as CSSProperties}>
                  <span className="label">{t("间隔", "Every")}</span>
                  <div className="ivals">
                    {IVALS.map(([v, zh, en]) => (
                      <button key={v} className={j.everySecs === v ? "on" : ""} disabled={v < min} title={v < min ? t(meta.zh[2], meta.en[2]) : undefined} onClick={() => onChange({ everySecs: v })}>{t(zh, en)}</button>
                    ))}
                  </div>
                  <span className="faint" style={{ fontSize: 11.5 }}>{t(`最短 ${span(min, t)}：${meta.zh[2]}`, `At least ${span(min, t)}: ${meta.en[2]}`)}</span>
                </div>
              )}
              <div className="row wrap" style={{ "--gap": "16px", fontSize: 12 } as CSSProperties}>
                {j.task !== "leak_alert" && <label className="row" style={{ "--gap": "6px", cursor: "pointer" } as CSSProperties}><input type="checkbox" className="check" checked={j.skipInGame} onChange={(e) => onChange({ skipInGame: e.target.checked })} />{t("游戏运行时暂停", "Pause while a game runs")}</label>}
                <span className="grow" />
                {at != null && <span className="faint num">{t("下次", "Next")} <Countdown at={at} /></span>}
                {last && <span className={last.ok ? "faint" : "c-crit"}>{last.ok ? <CheckCircle2 size={12} /> : <XCircle size={12} />} {new Date(last.at).toLocaleTimeString()} · {last.detail}</span>}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export function Cron() {
  const t = useT()
  const jobs = useSettings((s) => s.automation)
  const [st, setSt] = useState<(AutoStatus & { polledAt: number }) | null>(null)
  usePoll(async () => { const r = await api.automationStatus(); setSt({ ...r, polledAt: Date.now() }) }, 2000)
  const byTask = (task: string) => jobs.find((j) => j.task === task)
  const patch = (id: string, p: Partial<JobCfg>) => useSettings.getState().set({ automation: jobs.map((j) => (j.id === id ? { ...j, ...p } : j)) })
  const mem = st?.mem
  return (
    <Page>
      <PageHead idx="09" title={t("定时任务", "Cron")} sub={t("由后台按计划执行，窗口最小化到托盘时也会运行", "Run by the backend on a schedule — also while the window is in the tray")} />
      <div className="grid" style={{ gridTemplateColumns: "minmax(0, 1.6fr) minmax(300px, 1fr)", gap: 16, alignItems: "start" }}>
        <Panel title={t("任务", "Jobs")}>
          <div className="jobs">{ORDER.map((task) => { const j = byTask(task); return j ? <Job key={j.id} j={j} st={st} onChange={(p) => patch(j.id, p)} /> : null })}</div>
        </Panel>
        <div className="col" style={{ "--gap": "16px" } as CSSProperties}>
          <Panel title={t("内存列表", "Memory lists")}>
            {!mem ? <span className="faint" style={{ fontSize: 12 }}>{t("读取中…（需要管理员权限）", "Reading… (needs administrator)")}</span> : (
              <div className="col" style={{ "--gap": "12px" } as CSSProperties}>
                {[[t("空闲", "Free"), mem.free, "var(--ok)"], [t("待机（缓存）", "Standby (cache)"), mem.standby, "var(--mem)"], [t("已修改", "Modified"), mem.modified, "var(--warn)"]].map(([k, v, c]) => (
                  <div key={k as string} className="col" style={{ "--gap": "5px" } as CSSProperties}>
                    <div className="row spread" style={{ fontSize: 12.5 }}><span className="dim">{k}</span><b className="num">{bytes(v as number)}</b></div>
                    <Meter v={v as number} max={mem.total || 1} color={c as string} />
                  </div>
                ))}
              </div>
            )}
          </Panel>
          <Panel title={t("运行记录", "History")}>
            {!st?.history.length ? <span className="faint" style={{ fontSize: 12 }}>{t("还没有运行过任务", "Nothing has run yet")}</span> : (
              <ul className="hist">
                {st.history.slice(0, 30).map((r, i) => (
                  <li key={i}>
                    {r.ok ? <CheckCircle2 size={13} style={{ color: "var(--ok)" }} /> : <XCircle size={13} style={{ color: "var(--crit)" }} />}
                    <span className="num faint">{new Date(r.at).toLocaleTimeString()}</span>
                    <b>{t(TASK[r.task]?.zh[0] ?? r.task, TASK[r.task]?.en[0] ?? r.task)}</b>
                    <span className="faint ellipsis grow" title={r.detail}>{r.detail}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
      <LeakPanel />
    </Page>
  )
}

// ------------------------------------------------------------ memory leaks
function SuspectRow({ s, onDone }: { s: LeakSuspect; onDone: () => void }) {
  const t = useT()
  const restart = async () => { if (await confirmDialog({ title: t(`重启 ${s.name}？`, `Restart ${s.name}?`), body: t("结束进程并以相同路径重新启动，泄漏的内存会全部归还。未保存的数据会丢失。", "Ends the process and starts it again; all leaked memory is returned. Unsaved work is lost."), ok: t("重启", "Restart") })) { await act(api.restartTask(s.pid), t("已重启", "Restarted")); onDone() } }
  const end = async () => { if (await confirmDialog({ title: t(`结束 ${s.name}？`, `End ${s.name}?`), ok: t("结束", "End"), danger: true })) { await act(api.endTask(s.pid), t("已结束", "Ended")); onDone() } }
  return (
    <div className="leakrow">
      <ProcIcon path={s.path} name={s.name} />
      <span className="col" style={{ "--gap": "1px", minWidth: 0 } as CSSProperties}><b className="ellipsis">{s.name}</b><span className="faint num" style={{ fontSize: 11 }}>PID {s.pid} · {t(`观察 ${s.minutes} 分钟`, `${s.minutes} min observed`)}</span></span>
      <span className="num">{bytes(s.privateBytes)}</span>
      <span className="num c-crit">+{bytes(s.growthBytes, 0)}</span>
      <span className="num faint">{s.slopeMbPerMin.toFixed(1)} MB/min</span>
      <Spark data={s.trend} color="var(--crit)" w={110} h={22} />
      <span className="row" style={{ "--gap": "4px" } as CSSProperties}>
        <button className="btn sm" onClick={restart}><RotateCcw size={12} />{t("重启", "Restart")}</button>
        <button className="btn ghost icon sm danger" title={t("结束", "End")} onClick={end}><Square size={12} /></button>
      </span>
    </div>
  )
}

export function LeakPanel() {
  const t = useT()
  const [r, setR] = useState<LeakReport | null>(null)
  const load = async () => setR(await api.leakReport())
  usePoll(load, 10_000)
  const k = r?.kernel
  return (
    <Panel title={t("内存泄漏检测", "Memory-leak detection")} right={r ? <span className="faint num" style={{ fontSize: 12 }}>{t(`已观察 ${r.minutes} 分钟`, `${r.minutes} min observed`)}</span> : null}>
      <p className="faint" style={{ margin: "0 0 12px", fontSize: 12.5, lineHeight: 1.6 }}>{t("释放内存不能修复泄漏：泄漏的程序只会把内存挤进页面文件，然后继续增长。这里按分钟追踪每个进程的私有内存与内核内存池，持续、单调地增长才会被判为泄漏；重启该程序才能真正归还内存。", "Freeing memory doesn't fix a leak: the leaking app just pushes memory into the page file and keeps growing. This tracks every process's private memory and the kernel pools per minute; only sustained, steady growth counts as a leak, and restarting that app is what actually returns the memory.")}</p>
      {!r ? <div className="skeleton" style={{ height: 80 }} /> : (
        <div className="col" style={{ "--gap": "14px" } as CSSProperties}>
          {r.suspects.length ? (
            <div className="col" style={{ "--gap": "2px" } as CSSProperties}>
              <span className="label c-crit"><AlertTriangle size={13} style={{ verticalAlign: -2 }} /> {t(`疑似泄漏 · ${r.suspects.length}`, `Suspected leaks · ${r.suspects.length}`)}</span>
              {r.suspects.map((s) => <SuspectRow key={s.pid} s={s} onDone={load} />)}
            </div>
          ) : (
            <Empty title={r.minutes < r.neededMinutes ? t(`正在建立基线（${r.minutes}/${r.neededMinutes} 分钟）`, `Building a baseline (${r.minutes}/${r.neededMinutes} min)`) : t("没有发现泄漏", "No leaks found")} body={t("至少 15 分钟内增长 300 MB 以上、每分钟 4 MB 以上且持续上升的进程才会出现在这里。", "A process shows up here after growing 300 MB+ at 4 MB/min+ steadily for at least 15 minutes.")} />
          )}
          {r.growers.length > 0 && (
            <div className="col" style={{ "--gap": "2px" } as CSSProperties}>
              <span className="label">{t("增长中（尚未达到泄漏标准）", "Growing (not a leak yet)")}</span>
              {r.growers.map((s) => <SuspectRow key={s.pid} s={s} onDone={load} />)}
            </div>
          )}
          {k && (
            <div className="kern">
              <span className="label">{t("内核内存", "Kernel memory")}</span>
              <div className="pkvs">
                <div className="pkv"><span>{t("非分页池", "Non-paged pool")}</span><b className={`num ${k.leak ? "c-crit" : ""}`}>{bytes(k.nonpaged)}</b><em className="num">{k.nonpagedSlopeMbPerMin >= 0 ? "+" : ""}{k.nonpagedSlopeMbPerMin.toFixed(2)} MB/min</em></div>
                <div className="pkv"><span>{t("分页池", "Paged pool")}</span><b className="num">{bytes(k.paged)}</b><em className="num">{k.pagedSlopeMbPerMin >= 0 ? "+" : ""}{k.pagedSlopeMbPerMin.toFixed(2)} MB/min</em></div>
                <div className="pkv"><span>{t("已提交", "Committed")}</span><b className="num">{bytes(k.commit)}</b><em className="num">/ {bytes(k.commitLimit, 0)}</em></div>
              </div>
              {k.leak && <p className="c-crit" style={{ margin: "10px 0 0", fontSize: 12.5 }}>{t("非分页池很大且仍在增长，通常是驱动泄漏（网卡、杀毒、外设驱动最常见）。更新或卸载最近安装的驱动；用 PoolMon 可按标记定位。只有重启才能回收。", "The non-paged pool is large and still growing: usually a driver leak (network, antivirus and peripheral drivers are the usual suspects). Update or remove recently installed drivers; PoolMon can pinpoint the tag. Only a reboot reclaims it.")}</p>}
            </div>
          )}
        </div>
      )}
    </Panel>
  )
}
