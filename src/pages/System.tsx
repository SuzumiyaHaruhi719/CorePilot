import { useMemo, useState, type CSSProperties } from "react"
import { motion } from "motion/react"
import { CheckCircle2, CircleDashed, LifeBuoy, Play, RotateCw, Search, ShieldAlert, Square, XCircle } from "lucide-react"
import { api, type NetCheck, type Service } from "../lib/ipc"
import { act, toast, useProfiles, useSettings, useT } from "../lib/store"
import { AsyncButton, confirmDialog, Empty, Page, PageHead, Panel, Seg, Switch, Swap, useAsync, VList } from "../ui/kit"

// ------------------------------------------------------------ tweaks
type Risk = "safe" | "reboot" | "security"
const TWEAKS: { id: string; group: 0 | 1 | 2; risk: Risk; zh: [string, string]; en: [string, string] }[] = [
  { id: "mmcss_gaming", group: 0, risk: "safe", zh: ["游戏多媒体调度", "提高游戏线程的 MMCSS 调度与 GPU 优先级"], en: ["Gaming MMCSS profile", "Higher MMCSS scheduling and GPU priority for game threads"] },
  { id: "foreground_boost", group: 0, risk: "safe", zh: ["前台程序优先", "前台窗口获得更长的 CPU 时间片"], en: ["Foreground boost", "Longer CPU quanta for the foreground window"] },
  { id: "network_throttling_off", group: 0, risk: "safe", zh: ["关闭网络节流", "取消多媒体播放期间的网络限速"], en: ["Disable network throttling", "Remove the multimedia network rate limit"] },
  { id: "game_dvr_off", group: 0, risk: "safe", zh: ["关闭 Game DVR", "停止后台录制，减少帧时间波动"], en: ["Disable Game DVR", "Stop background capture to steady frame times"] },
  { id: "ultimate_power_plan", group: 0, risk: "safe", zh: ["卓越性能电源计划", "启用并切换到隐藏的“卓越性能”计划"], en: ["Ultimate Performance plan", "Unhide and activate the Ultimate Performance plan"] },
  { id: "vbs_off", group: 0, risk: "security", zh: ["关闭 VBS", "关闭基于虚拟化的安全以提升游戏性能，需要重启"], en: ["Disable VBS", "Turn off virtualization-based security for game performance; reboot required"] },
  { id: "ntfs_lastaccess_off", group: 1, risk: "safe", zh: ["关闭 NTFS 访问时间戳", "读取文件时不再写入最后访问时间"], en: ["Disable NTFS last-access", "No timestamp write on every file read"] },
  { id: "sysmain_off", group: 1, risk: "safe", zh: ["停用 SysMain", "停止预读服务，减少后台磁盘活动"], en: ["Disable SysMain", "Stop the prefetch service and its disk churn"] },
  { id: "search_off", group: 1, risk: "safe", zh: ["停用搜索索引", "停止 Windows Search 后台索引"], en: ["Disable search indexing", "Stop Windows Search background indexing"] },
  { id: "telemetry_off", group: 1, risk: "safe", zh: ["关闭遥测", "停止诊断数据收集与上传"], en: ["Disable telemetry", "Stop diagnostic data collection and upload"] },
  { id: "defender_rt_off", group: 2, risk: "security", zh: ["关闭 Defender 实时保护", "降低安全性，仅在排查性能问题时使用"], en: ["Disable Defender real-time", "Lowers security — use only while diagnosing"] },
  { id: "smartscreen_off", group: 2, risk: "security", zh: ["关闭 SmartScreen", "不再拦截未知来源的程序"], en: ["Disable SmartScreen", "Unknown apps are no longer screened"] },
  { id: "auto_update_off", group: 2, risk: "security", zh: ["暂停自动更新", "阻止 Windows 自动下载安装更新"], en: ["Pause automatic updates", "Block automatic Windows Update installs"] },
]

function Tweaks() {
  const t = useT()
  const snaps = useProfiles((s) => s.tweaks)
  const set = useProfiles((s) => s.set)
  const [busy, setBusy] = useState<string | null>(null)
  const toggle = async (tw: (typeof TWEAKS)[number], on: boolean) => {
    if (on && tw.risk === "security" && !(await confirmDialog({ title: t(`启用“${tw.zh[0]}”？`, `Enable “${tw.en[0]}”?`), body: t(tw.zh[1], tw.en[1]), ok: t("仍然启用", "Enable anyway"), danger: true }))) return
    setBusy(tw.id)
    try {
      if (on) {
        const snap = await api.tweakApply(tw.id)
        set({ tweaks: { ...useProfiles.getState().tweaks, [tw.id]: snap } })
        toast("ok", t(`已启用：${tw.zh[0]}`, `Enabled: ${tw.en[0]}`))
      } else {
        await api.tweakRevert(tw.id, snaps[tw.id])
        const { [tw.id]: _gone, ...rest } = useProfiles.getState().tweaks
        set({ tweaks: rest })
        toast("ok", t(`已还原：${tw.zh[0]}`, `Reverted: ${tw.en[0]}`))
      }
    } catch (e) {
      toast("err", t("操作失败", "Failed"), String(e)) // snapshot kept on a failed revert
    } finally { setBusy(null) }
  }
  const tag = { safe: ["", "可还原", "Reversible"], reboot: ["warn", "需重启", "Reboot"], security: ["crit", "降低安全性", "Lowers security"] } as const
  return (
    <div className="col" style={{ "--gap": "14px" } as CSSProperties}>
      <div className="panel pad row">
        <LifeBuoy size={18} className="c-acc" />
        <div className="col grow" style={{ "--gap": "2px" } as CSSProperties}>
          <b style={{ fontWeight: 500 }}>{t("修改前建议创建系统还原点", "Create a restore point first")}</b>
          <span className="faint" style={{ fontSize: 12 }}>{t("每项优化启用前都会保存原值快照，关闭开关即精确还原。", "Every tweak snapshots the original values; switching it off restores them exactly.")}</span>
        </div>
        <AsyncButton className="btn" onClick={() => act(api.restorePoint(), t("还原点已创建", "Restore point created"))}>{t("创建还原点", "Create restore point")}</AsyncButton>
      </div>
      <div className="grid g2" style={{ alignItems: "start" }}>
      {([["性能", "Performance"], ["系统", "System"], ["安全", "Security"]] as const).map(([zh, en], g) => (
        <Panel key={g} title={t(zh, en)} style={g === 0 ? { gridRow: "span 2" } : undefined}>
          {TWEAKS.filter((x) => x.group === g).map((tw) => (
            <div key={tw.id} className="field">
              <div className="ft row" style={{ "--gap": "8px" } as CSSProperties}>{t(tw.zh[0], tw.en[0])}{tw.risk !== "safe" && <span className={`tag ${tag[tw.risk][0]}`}>{t(tag[tw.risk][1], tag[tw.risk][2])}</span>}{tw.id === "vbs_off" && <span className="tag warn">{t("需重启", "Reboot")}</span>}</div>
              <div className="fd">{t(tw.zh[1], tw.en[1])}</div>
              <div className="fc"><Switch on={tw.id in snaps} disabled={busy === tw.id} onChange={(v) => toggle(tw, v)} label={tw.en[0]} /></div>
            </div>
          ))}
        </Panel>
      ))}
      </div>
    </div>
  )
}

// ------------------------------------------------------------ startup
function Startup() {
  const t = useT()
  const list = useAsync(api.startup)
  const loc = { hkcu_run: t("当前用户", "User"), hklm_run: t("所有用户", "Machine"), startup_folder: t("启动文件夹", "Startup folder") }
  if (list.loading && !list.data) return <div className="skeleton" style={{ height: 240 }} />
  if (!list.data?.length) return <Panel><Empty title={t("没有启动项", "No startup items")} /></Panel>
  return (
    <Panel pad={false}>
      <div className="table" style={{ "--cols": "minmax(160px,1fr) minmax(200px,2fr) 110px 44px" } as CSSProperties}>
        <div className="thead"><button disabled>{t("名称", "Name")}</button><button disabled>{t("命令", "Command")}</button><button disabled>{t("位置", "Location")}</button><button disabled>{t("启用", "On")}</button></div>
        {list.data.map((s) => (
          <div key={s.location + s.name} className="tr" style={{ height: 44, opacity: s.enabled ? 1 : 0.55, transition: "opacity .25s" }}>
            <span className="ellipsis" style={{ color: "var(--ink)" }}>{s.name}</span>
            <span className="mono faint ellipsis" title={s.command} style={{ fontSize: 11 }}>{s.command}</span>
            <span><span className="tag">{loc[s.location] ?? s.location}</span></span>
            <Switch on={s.enabled} label={s.name} onChange={async (v) => { list.set(list.data!.map((x) => (x === s ? { ...x, enabled: v } : x))); await act(api.setStartup(s.name, s.location, v)); list.reload() }} />
          </div>
        ))}
      </div>
    </Panel>
  )
}

// ------------------------------------------------------------ services
function Services() {
  const t = useT()
  const list = useAsync(api.services)
  const [q, setQ] = useState("")
  const [f, setF] = useState<"all" | "running" | "stopped">("all")
  const rows = useMemo(() => {
    const k = q.trim().toLowerCase()
    return (list.data ?? []).filter((s) => (f === "all" || s.status === f) && (!k || s.name.toLowerCase().includes(k) || s.display.toLowerCase().includes(k)))
      .sort((a, b) => a.display.localeCompare(b.display))
  }, [list.data, q, f])
  const start = { auto: t("自动", "Auto"), manual: t("手动", "Manual"), disabled: t("禁用", "Disabled"), boot: "Boot", system: "System", other: "—" } as Record<string, string>
  const ctl = async (s: Service, a: "start" | "stop" | "restart") => {
    if (a !== "start" && !(await confirmDialog({ title: t(`${a === "stop" ? "停止" : "重启"}服务 ${s.display}？`, `${a === "stop" ? "Stop" : "Restart"} ${s.display}?`), body: s.description || undefined, ok: a === "stop" ? t("停止", "Stop") : t("重启", "Restart"), danger: a === "stop" }))) return
    await act(api.controlService(s.name, a), t("服务状态已更新", "Service updated"))
    list.reload()
  }
  return (
    <Panel pad={false} style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 250px)", minHeight: 360 }}>
      <div className="row" style={{ padding: "12px 14px", borderBottom: "1px solid var(--line)" }}>
        <div className="search"><Search size={14} /><input className="input" style={{ width: 260 }} placeholder={t("搜索服务", "Search services")} value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <Seg value={f} onChange={setF} options={[{ v: "all", label: t("全部", "All") }, { v: "running", label: t("运行中", "Running") }, { v: "stopped", label: t("已停止", "Stopped") }]} />
        <span className="grow" />
        <span className="faint num" style={{ fontSize: 12 }}>{rows.length}</span>
      </div>
      {!list.data ? <div className="skeleton" style={{ margin: 14, height: 200 }} /> : (
        <div className="table" style={{ "--cols": "minmax(220px,2fr) 90px 80px 60px 110px", flex: 1, minHeight: 0 } as CSSProperties}>
          <div className="thead"><button disabled>{t("服务", "Service")}</button><button disabled>{t("状态", "Status")}</button><button disabled>{t("启动", "Start")}</button><button disabled className="r">PID</button><span /></div>
          <VList items={rows} row={(s) => s.name} height={42} style={{ flex: 1 }} render={(s) => (
            <div className="tr" style={{ height: 42 }} title={s.description}>
              <span className="col" style={{ "--gap": "1px" } as CSSProperties}><span className="ellipsis" style={{ color: "var(--ink)" }}>{s.display}</span><span className="mono faint ellipsis" style={{ fontSize: 10.5 }}>{s.name}</span></span>
              <span><span className={`tag ${s.status === "running" ? "ok" : ""}`}>{s.status === "running" ? <><span className="dot" />{t("运行", "Running")}</> : s.status === "stopped" ? t("停止", "Stopped") : s.status}</span></span>
              <span className="faint" style={{ fontSize: 12 }}>{start[s.startType] ?? s.startType}</span>
              <span className="cell r faint">{s.pid || ""}</span>
              <span className="row" style={{ justifyContent: "flex-end", "--gap": "2px" } as CSSProperties}>
                {s.status !== "running" && <button className="btn ghost icon sm" title={t("启动", "Start")} onClick={() => ctl(s, "start")}><Play size={12} /></button>}
                {s.status === "running" && <><button className="btn ghost icon sm" title={t("重启", "Restart")} onClick={() => ctl(s, "restart")}><RotateCw size={12} /></button><button className="btn ghost icon sm" title={t("停止", "Stop")} onClick={() => ctl(s, "stop")}><Square size={11} /></button></>}
              </span>
            </div>
          )} />
        </div>
      )}
    </Panel>
  )
}

// ------------------------------------------------------------ network
const FIXES: [string, string, string, boolean][] = [
  ["flushDns", "刷新 DNS 缓存", "Flush DNS cache", false], ["renewDhcp", "重新获取 IP 地址", "Renew IP address", false],
  ["resetProxy", "重置系统代理", "Reset system proxy", false], ["resetWinsock", "重置 Winsock", "Reset Winsock", true], ["resetTcpip", "重置 TCP/IP 协议栈", "Reset TCP/IP stack", true],
]
function CheckList({ items }: { items: NetCheck[] }) {
  return (
    <div className="col" style={{ "--gap": "2px" } as CSSProperties}>
      {items.map((c, i) => (
        <motion.div key={c.id + i} className="row" style={{ padding: "9px 0", borderTop: i ? "1px solid var(--line)" : 0, "--gap": "12px" } as CSSProperties}
          initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.07 }}>
          {c.ok ? <CheckCircle2 size={16} className="c-ok" /> : <XCircle size={16} className="c-crit" />}
          <span style={{ minWidth: 180 }}>{c.label}</span>
          <span className="faint ellipsis grow" style={{ fontSize: 12 }}>{c.detail}</span>
        </motion.div>
      ))}
    </div>
  )
}
function Network() {
  const t = useT()
  const en = useSettings((s) => s.lang === "en")
  const [diag, setDiag] = useState<NetCheck[] | null>(null)
  const [res, setRes] = useState<NetCheck[] | null>(null)
  const [pick, setPick] = useState<string[]>(["flushDns", "renewDhcp"])
  const [running, setRunning] = useState(false)
  return (
    <div className="grid g2">
      <Panel title={t("诊断", "Diagnose")} right={<AsyncButton className="btn sm primary" onClick={async () => { setDiag(null); setDiag(await api.netDiagnose(en)) }}>{t("开始诊断", "Run diagnosis")}</AsyncButton>}>
        {diag ? <CheckList items={diag} /> : <Empty icon={<CircleDashed size={26} strokeWidth={1.4} />} title={t("检查网卡、网关、DNS 与代理", "Checks adapter, gateway, DNS and proxy")} />}
      </Panel>
      <Panel title={t("修复", "Repair")}>
        <div className="col" style={{ "--gap": "0" } as CSSProperties}>
          {FIXES.map(([id, zh, enl, reboot]) => (
            <label key={id} className="field" style={{ cursor: "pointer" }}>
              <div className="ft row" style={{ "--gap": "8px" } as CSSProperties}>{t(zh, enl)}{reboot && <span className="tag warn">{t("需重启", "Reboot")}</span>}</div>
              <div className="fc"><input type="checkbox" checked={pick.includes(id)} onChange={(e) => setPick(e.target.checked ? [...pick, id] : pick.filter((x) => x !== id))} style={{ accentColor: "var(--acc)", width: 16, height: 16 }} /></div>
            </label>
          ))}
          <div className="row" style={{ paddingTop: 12 }}>
            <button className="btn primary" disabled={!pick.length || running} onClick={async () => { setRunning(true); try { setRes(await api.netRepair(pick, en)) } catch (e) { toast("err", t("修复失败", "Repair failed"), String(e)) } finally { setRunning(false) } }}>
              {running ? t("修复中…", "Repairing…") : t("执行修复", "Repair")}
            </button>
          </div>
          {res && <div style={{ paddingTop: 12 }}><CheckList items={res} /></div>}
        </div>
      </Panel>
    </div>
  )
}

type Tab = "tweaks" | "startup" | "services" | "network"
let lastTab: Tab = "tweaks"
export function System() {
  const t = useT()
  const [tab, setTab] = useState<Tab>(lastTab)
  const go = (v: Tab) => { lastTab = v; setTab(v) }
  return (
    <Page>
      <PageHead idx="07" title={t("系统维护", "System")} sub={t("可还原的系统优化、启动项、服务与网络修复", "Reversible tweaks, startup items, services and network repair")}
        actions={<Seg value={tab} onChange={go} options={[{ v: "tweaks", label: t("优化", "Tweaks") }, { v: "startup", label: t("启动项", "Startup") }, { v: "services", label: t("服务", "Services") }, { v: "network", label: t("网络", "Network") }]} />} />
      <Swap k={tab}>
        {tab === "tweaks" && <Tweaks />}
        {tab === "startup" && <Startup />}
        {tab === "services" && <Services />}
        {tab === "network" && <Network />}
      </Swap>
      {tab === "tweaks" && <div className="row faint" style={{ fontSize: 12 }}><ShieldAlert size={13} />{t("所有操作需要管理员权限，CorePilot 已以管理员身份运行。", "All actions need admin rights — CorePilot already runs elevated.")}</div>}
    </Page>
  )
}
