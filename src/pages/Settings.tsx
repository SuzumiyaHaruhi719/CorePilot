import { useEffect, useState, type CSSProperties } from "react"
import { motion } from "motion/react"
import { getVersion } from "@tauri-apps/api/app"
import { Download, FileDown, RefreshCw, RotateCcw } from "lucide-react"
import { api, on, type TbConfig, type UpdateInfo } from "../lib/ipc"
import { act, SETTINGS_DEFAULTS, toast, useSettings, useT, TB_METRICS } from "../lib/store"
import { PALETTE, STYLES, type StyleDef } from "../lib/themes"
import { confirmDialog, Field, Meter, Page, PageHead, Panel, Range, Seg, Switch, useAsync } from "../ui/kit"
import { setStyle } from "../ui/Shell"

function StyleCard({ s, on }: { s: StyleDef; on: boolean }) {
  const t = useT()
  const [page, surface, acc] = s.swatch
  const line = s.light ? "rgba(20,16,10,.1)" : "rgba(255,255,255,.1)"
  return (
    <motion.button onClick={(e) => setStyle(s.id, { x: e.clientX, y: e.clientY })} aria-pressed={on} className="col" whileTap={{ scale: 0.97 }} transition={{ type: "spring", bounce: 0.3, visualDuration: 0.3 }}
      style={{ position: "relative", overflow: "hidden", "--gap": "10px", padding: 10, borderRadius: 14, textAlign: "left", background: "var(--panel-2)",
        border: `1px solid ${on ? "var(--acc-line)" : "var(--line)"}`, boxShadow: on ? `0 0 0 1px var(--acc-line), 0 0 22px color-mix(in oklab, ${acc} calc(35% * var(--glow-o)), transparent)` : "none" } as CSSProperties}>
      {/* live miniature of the shell in this style */}
      <div style={{ height: 84, borderRadius: 9, background: page, display: "grid", gridTemplateColumns: "22px 1fr", overflow: "hidden", boxShadow: `inset 0 0 0 1px ${line}` }}>
        <div style={{ borderRight: `1px solid ${line}`, display: "grid", gap: 5, padding: "7px 5px", alignContent: "start" }}>
          {[0, 1, 2, 3].map((i) => <i key={i} style={{ height: 9, borderRadius: 3, background: i === 1 ? acc : line, boxShadow: i === 1 ? `0 0 8px ${acc}` : "none" }} />)}
        </div>
        <div style={{ padding: 7, display: "grid", gap: 5, gridTemplateColumns: "1fr 1fr", alignContent: "start" }}>
          <i style={{ gridColumn: "1 / -1", height: 26, borderRadius: 4, background: surface, position: "relative", boxShadow: `inset 0 0 0 1px ${line}` }}>
            <b style={{ position: "absolute", left: 5, right: 5, bottom: 6, height: 2, borderRadius: 2, background: acc, boxShadow: `0 0 6px ${acc}` }} />
          </i>
          <i style={{ height: 22, borderRadius: 4, background: surface, boxShadow: `inset 0 0 0 1px ${line}` }} />
          <i style={{ height: 22, borderRadius: 4, background: surface, boxShadow: `inset 0 0 0 1px ${line}` }} />
        </div>
      </div>
      <div className="row spread">
        <b style={{ fontWeight: 600 }}>{t(s.zh, s.en)}</b>
        <span style={{ width: 10, height: 10, borderRadius: "50%", background: acc, boxShadow: `0 0 8px ${acc}` }} />
      </div>
      <span className="faint" style={{ fontSize: 11.5, marginTop: -6 }}>{t(s.descZh, s.descEn)}</span>
    </motion.button>
  )
}

function Appearance() {
  const t = useT()
  const s = useSettings()
  return (
    <Panel title={t("外观", "Appearance")}>
      <div className="label" style={{ marginBottom: 12 }}>{t("主题风格", "Theme style")}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12, marginBottom: 8 }}>
        {STYLES.map((x) => <StyleCard key={x.id} s={x} on={s.style === x.id} />)}
      </div>
      <Field title={t("光晕强度", "Glow")} desc={t("霓虹光晕、发光边框与图标光效", "Neon halos, glowing edges and icon light")}>
        <Seg value={s.glow} onChange={(glow) => s.set({ glow })} options={[{ v: "off", label: t("关", "Off") }, { v: "soft", label: t("柔和", "Soft") }, { v: "medium", label: t("标准", "Medium") }, { v: "intense", label: t("强烈", "Intense") }]} />
      </Field>
      <Field title={t("语言", "Language")}><Seg value={s.lang} onChange={(lang) => s.set({ lang })} options={[{ v: "zh", label: "中文" }, { v: "en", label: "English" }]} /></Field>
      <Field title={t("减少动态效果", "Reduce motion")} desc={t("关闭过渡、数字滚动与示波滑动", "Disable transitions, number tweens and scope glide")}><Switch on={s.reduceMotion} onChange={(reduceMotion) => s.set({ reduceMotion })} /></Field>
      <Field title={t("跟随系统动画设置", "Follow system animation setting")} desc={t("开启后，Windows 关闭“动画效果”时 CorePilot 也减少动态效果；关闭则始终保留动画", "When on, turning off Windows \"Animation effects\" also reduces CorePilot's motion; when off, CorePilot always animates")}><Switch on={s.followSystemMotion} onChange={(followSystemMotion) => s.set({ followSystemMotion })} /></Field>
      <Field title={t("玻璃质感", "Frosted glass")} desc={t("面板半透明并模糊背景光晕（旧版亚克力效果）", "Translucent panels that blur the backdrop (the old acrylic look)")}><Switch on={s.glass} onChange={(glass) => s.set({ glass })} /></Field>
      <Field title={<>{t("窗口不透明度", "Window opacity")} <span className="num faint">{s.opacity}%</span></>}>
        <div style={{ width: 180 }}><Range value={s.opacity} min={30} max={100} onChange={(opacity) => s.set({ opacity })} /></div>
      </Field>
    </Panel>
  )
}

function Behavior() {
  const t = useT()
  const s = useSettings()
  const auto = useAsync(api.autostart)
  return (
    <Panel title={t("行为", "Behavior")}>
      <Field title={t("关闭时最小化到托盘", "Close to tray")} desc={t("核心规则、风扇曲线、OSD 与性能记录在后台继续运行", "Core rules, fan curves, OSD and recording keep running")}><Switch on={s.closeToTray} onChange={(closeToTray) => s.set({ closeToTray })} /></Field>
      <Field title={t("开机自动启动", "Start with Windows")} desc={t("以管理员权限静默启动，无 UAC 弹窗", "Starts elevated at logon with no UAC prompt")}>
        <Switch on={!!auto.data} disabled={auto.loading} onChange={async (v) => { auto.set(v); await act(api.setAutostart(v)); auto.reload() }} />
      </Field>
    </Panel>
  )
}

function Performance() {
  const t = useT()
  const s = useSettings()
  return (
    <Panel title={t("性能与渲染", "Performance & rendering")}>
      <Field title={t("刷新间隔", "Refresh interval")} desc={t("遥测采样频率；所有实时曲线同步滑动。更长的间隔更省 CPU", "Telemetry sampling rate; every live chart glides in step. Longer saves CPU")}>
        <Seg value={s.pollMs} onChange={(pollMs) => s.set({ pollMs })} options={[500, 1000, 1500, 2000, 3000].map((v) => ({ v, label: v < 1000 ? `${v}ms` : `${v / 1000}s` }))} />
      </Field>
      <Field title={t("GPU 渲染", "GPU rendering")} desc={t("省 GPU：关闭光晕、模糊与动画，几乎不占用显卡。游戏时省电：仅在游戏位于前台时启用", "Low: no glow, blur or animation, barely touches the GPU. While gaming: only when a game is in front")}>
        <Seg value={s.gpuMode} onChange={(gpuMode) => s.set({ gpuMode })} options={[{ v: "full", label: t("完整", "Full") }, { v: "auto", label: t("游戏时省电", "While gaming") }, { v: "low", label: t("省 GPU", "Low") }]} />
      </Field>
      <Field title={t("后台记录性能曲线", "Record in background")} desc={t("窗口隐藏时继续采样，回来时曲线是完整的（略增 CPU 占用）", "Keep sampling while hidden so charts are complete when you return (slightly more CPU)")}><Switch on={s.bgRecord} onChange={(bgRecord) => s.set({ bgRecord })} /></Field>
    </Panel>
  )
}

function GamePrefs() {
  const t = useT()
  const s = useSettings()
  return (
    <Panel title={t("游戏", "Games")}>
      <Field title={t("游戏结束后自动弹出性能报告", "Show the report when a game closes")} desc={t("将 CorePilot 调到前台并打开该局的报告", "Brings CorePilot to the front on that session's report")}><Switch on={s.autoShowReport} onChange={(autoShowReport) => s.set({ autoShowReport })} /></Field>
      <Field title={t("系统通知", "System notification")} desc={t("报告生成时发送 Windows 通知", "Windows notification when a report is ready")}><Switch on={s.gameNotify} onChange={(gameNotify) => s.set({ gameNotify })} /></Field>
    </Panel>
  )
}

function Expert() {
  const t = useT()
  const s = useSettings()
  return (
    <Panel title={t("专家", "Expert")}>
      <Field title={t("启用 AMD 调优（实验性 · 危险）", "Enable AMD tuning (experimental · risky)")} desc={t("解锁 超频 → 高级 中的曲线优化与 PBO：直接写入 Ryzen SMU，设置不当可能导致死机或无法开机", "Unlocks Curve Optimizer and PBO in Tuning → Advanced: live Ryzen SMU writes; bad values can crash or fail to boot")}>
        <Switch on={s.amdTuning} onChange={async (v) => { if (!v || await confirmDialog({ title: t("解锁 AMD 调优？", "Unlock AMD tuning?"), body: t("我了解这些写入可能导致系统不稳定。", "I understand these writes can make the system unstable."), ok: t("解锁", "Unlock"), danger: true })) s.set({ amdTuning: v }) }} />
      </Field>
      <Field title={t("智能调优：允许后台负载", "Auto-tune: allow background load")} desc={t("默认允许在有其他负载时运行风扇智能调优（结果可能偏保守）", "Let fan auto-tune run with other load present by default (results may be conservative)")}><Switch on={s.tuneAllowBusy} onChange={(tuneAllowBusy) => s.set({ tuneAllowBusy })} /></Field>
    </Panel>
  )
}

const TB_LABEL: Record<string, [string, string]> = {
  "cpu.util": ["CPU 占用", "CPU load"], "cpu.temp": ["CPU 温度", "CPU temp"], "cpu.freq": ["CPU 频率", "CPU clock"], "cpu.power": ["CPU 功耗", "CPU power"],
  "mem.used": ["内存用量", "RAM used"], "mem.util": ["内存占比", "RAM %"], "gpu.util": ["GPU 占用", "GPU load"], "gpu.temp": ["GPU 温度", "GPU temp"],
  "gpu.power": ["GPU 功耗", "GPU power"], "gpu.fan": ["GPU 风扇", "GPU fan"], "gpu.vramPct": ["显存占比", "VRAM %"], "gpu.vramUsed": ["显存用量", "VRAM used"],
  "gpu.coreClock": ["GPU 核心频率", "GPU clock"], "gpu.memClock": ["GPU 显存频率", "GPU mem clock"], "disk.util": ["磁盘活动", "Disk active"],
  "disk.read": ["磁盘读取", "Disk read"], "disk.write": ["磁盘写入", "Disk write"], "net.up": ["上传", "Upload"], "net.down": ["下载", "Download"],
}
function Color({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <label className="col" style={{ "--gap": "4px", alignItems: "center", fontSize: 11 } as CSSProperties}>
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}
        style={{ width: 30, height: 30, padding: 0, border: "1px solid var(--line-2)", borderRadius: 6, background: "none", cursor: "pointer" }} />
      <span className="faint">{label}</span>
    </label>
  )
}
function Taskbar() {
  const t = useT()
  const tb = useSettings((s) => s.taskbar)
  const set = useSettings((s) => s.set)
  const up = (p: Partial<TbConfig>) => set({ taskbar: { ...tb, ...p } })
  const pal = PALETTE[useSettings((s) => s.style)]
  const eff = { themeCpu: tb.themeCpu || pal.cpu, themeGpu: tb.themeGpu || pal.gpu, themeMem: tb.themeMem || pal.mem, themeDisk: tb.themeDisk || pal.disk, themeNet: tb.themeNet || pal.net }
  const color = (k: string) => (k.startsWith("cpu") ? eff.themeCpu : k.startsWith("gpu") ? eff.themeGpu : k.startsWith("mem") ? eff.themeMem : k.startsWith("disk") ? eff.themeDisk : eff.themeNet)
  // same grid the native plate draws: devices in fixed order, label centred,
  // readings stacked two per column
  const ORDER = ["cpu", "gpu", "mem", "disk", "net"]
  const devs = ORDER.map((d) => ({ d, keys: tb.metrics.filter((m) => m.startsWith(d + ".")) })).filter((x) => x.keys.length)
  const rows = tb.singleLine ? 1 : 2
  const sample = (m: string) => m.endsWith("temp") ? "62°C" : m === "cpu.freq" ? "5528MHz" : m.endsWith("Clock") ? "2520MHz" : m.endsWith("power") ? "212W" : m === "net.up" ? "▲1.2 MB/s" : m === "net.down" ? "▼8.4 MB/s" : m === "disk.read" ? "R 24 MB/s" : m === "disk.write" ? "W 3 MB/s" : m === "mem.used" || m === "gpu.vramUsed" ? "59.2 GB" : m === "mem.util" ? "47%" : "34%"
  return (
    <Panel title={t("任务栏监控", "Taskbar monitor")} right={<span className="row" style={{ "--gap": "10px" } as CSSProperties}><button className="btn ghost sm" onClick={() => set({ taskbar: { ...SETTINGS_DEFAULTS.taskbar, enabled: tb.enabled } })}><RotateCcw size={12} />{t("恢复默认", "Reset")}</button><Switch on={tb.enabled} onChange={(enabled) => up({ enabled })} /></span>}>
      {/* mock taskbar: start/search on the left, tray on the right */}
      <div className="tbmock" style={{ opacity: tb.enabled ? 1 : 0.45 }}>
        <i className="tbm-start" /><i className="tbm-search" />
        <span style={{ flex: 1 }} />
        {tb.barPosition === "left" && <span style={{ order: -1, width: tb.offset }} />}
        <div className="tbplate" style={{ order: tb.barPosition === "left" ? -1 : 0, marginRight: tb.barPosition === "right" ? 8 + tb.offset : 0, marginLeft: tb.barPosition === "left" ? 8 : 0, gap: tb.itemSpace, padding: tb.padding, background: tb.colorsEnabled ? tb.bg : "transparent", font: `${tb.bold ? 700 : 400} ${tb.size + 2.5}px 'Segoe UI Variable Text', 'Segoe UI', sans-serif` }}>
          {devs.map(({ d, keys }) => (
            <span key={d} className="tbp-dev" style={{ gap: tb.innerSpace }}>
              {/* the native plate stacks the label's letters upright (C / P / U) in the device colour */}
              <span className={`tbp-lbl ${rows === 2 ? "v" : ""}`} style={{ color: color(d), marginRight: Math.max(4, (tb.innerSpace * 2) / 3) - tb.innerSpace }}>{d === "mem" ? "RAM" : d.toUpperCase()}</span>
              {Array.from({ length: Math.ceil(keys.length / rows) }, (_, c) => keys.slice(c * rows, c * rows + rows)).map((col, c) => (
                <span key={c} className="tbp-col" style={{ justifyContent: col.length === 1 ? "center" : "space-between" }}>
                  {col.map((m) => <span key={m} style={{ color: tb.colorsEnabled ? tb.safe : "#f2f2f2" }}>{sample(m)}</span>)}
                </span>
              ))}
            </span>
          ))}
        </div>
        <span className="tbm-tray">{[0, 1, 2].map((i) => <i key={i} />)}<b>13:15</b></span>
      </div>
      <Field title={t("显示项目", "Metrics")} desc={t("按点击顺序排列", "Shown in the order you pick them")}>
        <span />
      </Field>
      <div className="row wrap" style={{ "--gap": "6px", marginTop: -4, marginBottom: 8 } as CSSProperties}>
        {TB_METRICS.map((m) => {
          const i = tb.metrics.indexOf(m)
          return <button key={m} className={`chip ${i >= 0 ? "on" : ""}`} onClick={() => up({ metrics: i >= 0 ? tb.metrics.filter((x) => x !== m) : [...tb.metrics, m] })}>{i >= 0 && <span className="num c-acc">{i + 1}</span>}{t(...TB_LABEL[m])}</button>
        })}
      </div>
      <Field title={t("单行显示", "Single line")}><Switch on={tb.singleLine} onChange={(singleLine) => up({ singleLine })} /></Field>
      <Field title={t("停靠位置", "Dock")} desc={t("托盘左侧会跟随托盘图标的增减实时移动", "Next to the tray follows tray icons as they come and go")}><Seg value={tb.barPosition} onChange={(barPosition) => up({ barPosition })} options={[{ v: "right", label: t("托盘左侧", "Next to tray") }, { v: "left", label: t("任务栏左端", "Taskbar left") }]} /></Field>
      <Field title={<>{t("偏移", "Offset")} <span className="num faint">{tb.offset}px</span></>}><div style={{ width: 160 }}><Range value={tb.offset} min={0} max={150} onChange={(offset) => up({ offset })} /></div></Field>
      <Field title={<>{t("字号", "Font size")} <span className="num faint">{tb.size}</span></>}><div className="row" style={{ width: 220 }}><Range value={tb.size} min={6} max={16} onChange={(size) => up({ size })} /><button className={`chip ${tb.bold ? "on" : ""}`} onClick={() => up({ bold: !tb.bold })}>B</button></div></Field>
      <Field title={<>{t("间距", "Spacing")} <span className="num faint">{tb.itemSpace} / {tb.innerSpace} / {tb.padding}</span></>}>
        <div className="col" style={{ width: 160, "--gap": "6px" } as CSSProperties}><Range value={tb.itemSpace} min={0} max={40} onChange={(itemSpace) => up({ itemSpace })} /><Range value={tb.innerSpace} min={0} max={40} onChange={(innerSpace) => up({ innerSpace })} /><Range value={tb.padding} min={0} max={20} onChange={(padding) => up({ padding })} /></div>
      </Field>
      <Field title={t("自定义颜色", "Custom colors")} desc={t("按阈值着色：正常 / 警告 / 严重", "Threshold colors: safe / warn / critical")}><Switch on={tb.colorsEnabled} onChange={(colorsEnabled) => up({ colorsEnabled })} /></Field>
      {tb.colorsEnabled && (
        <div className="col" style={{ "--gap": "14px", paddingBottom: 6 } as CSSProperties}>
          <div className="row wrap" style={{ "--gap": "14px" } as CSSProperties}>
            <Color value={tb.bg} onChange={(bg) => up({ bg })} label={t("背景", "Bg")} />
            <Color value={tb.label} onChange={(label) => up({ label })} label={t("标签", "Label")} />
            <Color value={tb.safe} onChange={(safe) => up({ safe })} label={t("正常", "Safe")} />
            <Color value={tb.warn} onChange={(warn) => up({ warn })} label={t("警告", "Warn")} />
            <Color value={tb.crit} onChange={(crit) => up({ crit })} label={t("严重", "Crit")} />
            <Color value={eff.themeCpu} onChange={(themeCpu) => up({ themeCpu })} label="CPU" />
            <Color value={eff.themeGpu} onChange={(themeGpu) => up({ themeGpu })} label="GPU" />
            <Color value={eff.themeMem} onChange={(themeMem) => up({ themeMem })} label="RAM" />
            <Color value={eff.themeNet} onChange={(themeNet) => up({ themeNet })} label="NET" />
            <button className="btn sm ghost" style={{ alignSelf: "center" }} onClick={() => up({ themeFps: "", themeCpu: "", themeGpu: "", themeMem: "", themeDisk: "", themeNet: "" })}>{t("跟随主题", "Follow theme")}</button>
          </div>
          <div className="grid g2" style={{ gap: 18 }}>
            <div className="col" style={{ "--gap": "6px" } as CSSProperties}><span className="label">{t("负载阈值", "Load thresholds")} <span className="num">{tb.warnLoad}/{tb.critLoad}%</span></span><Range value={tb.warnLoad} min={10} max={100} onChange={(warnLoad) => up({ warnLoad })} color="var(--warn)" /><Range value={tb.critLoad} min={10} max={100} onChange={(critLoad) => up({ critLoad })} color="var(--crit)" /></div>
            <div className="col" style={{ "--gap": "6px" } as CSSProperties}><span className="label">{t("温度阈值", "Temp thresholds")} <span className="num">{tb.warnTemp}/{tb.critTemp}°</span></span><Range value={tb.warnTemp} min={30} max={100} onChange={(warnTemp) => up({ warnTemp })} color="var(--warn)" /><Range value={tb.critTemp} min={30} max={110} onChange={(critTemp) => up({ critTemp })} color="var(--crit)" /></div>
          </div>
        </div>
      )}
    </Panel>
  )
}

function Updates() {
  const t = useT()
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState<string | null>(null)
  const [dl, setDl] = useState<{ downloaded: number; total: number | null } | null>(null)
  useEffect(() => {
    const u = [on("update://state", (s) => { setPhase(s.phase); if (s.error) toast("err", t("更新失败", "Update failed"), s.error) }), on("update://progress", setDl)]
    return () => { u.forEach((p) => p.then((f) => f())) }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const auto = useSettings((x) => x.autoCheckUpdates)
  const check = async () => { setBusy(true); try { setInfo(await api.updateCheck()) } catch (e) { toast("err", t("检查更新失败", "Update check failed"), String(e)) } finally { setBusy(false) } }
  const blocked = info?.blockers.some((b) => b.severity === "block")
  return (
    <Panel title={t("更新", "Updates")}>
      <div className="row spread">
        <div className="col" style={{ "--gap": "2px" } as CSSProperties}>
          <b style={{ fontWeight: 500 }}>{info ? (info.available ? t(`发现新版本 ${info.latestVersion}`, `Version ${info.latestVersion} available`) : t("已是最新版本", "You're up to date")) : t("检查新版本", "Check for a new version")}</b>
          <span className="faint" style={{ fontSize: 12 }}>{info ? `${t("当前", "Current")} ${info.currentVersion} · ${info.flavor === "portable" ? t("便携版", "portable") : t("安装版", "installer")}` : ""}</span>
        </div>
        <div className="row">
          <button className="btn" onClick={check} disabled={busy}><RefreshCw size={13} className={busy ? "spin" : ""} style={busy ? { animation: "spin .9s linear infinite" } : undefined} />{t("检查", "Check")}</button>
          {info?.available && <button className="btn primary" disabled={blocked || !!phase} onClick={() => act(api.updateInstall())}><Download size={13} />{t("安装", "Install")}</button>}
        </div>
      </div>
      <Field title={t("自动检查更新", "Check automatically")} desc={t("启动后检查一次，有新版本时提示", "Checks once after launch and tells you about a new version")}><Switch on={auto} onChange={(autoCheckUpdates) => useSettings.getState().set({ autoCheckUpdates })} /></Field>
      {info?.blockers.map((b) => <div key={b.id} className={`tag ${b.severity === "block" ? "crit" : "warn"}`} style={{ height: "auto", padding: "6px 8px", marginTop: 10, textTransform: "none", letterSpacing: 0, font: "400 12px var(--f-ui)" }}>{b.message}</div>)}
      {info?.notes && info.available && <div className="selectable dim" style={{ marginTop: 12, fontSize: 12.5, whiteSpace: "pre-wrap", maxHeight: 160, overflow: "auto", padding: 10, borderRadius: 6, background: "var(--bg)" }}>{info.notes}</div>}
      {phase && (
        <div className="col" style={{ marginTop: 12, "--gap": "6px" } as CSSProperties}>
          <span className="faint" style={{ fontSize: 12 }}>{phase}{dl?.total ? ` · ${Math.round((dl.downloaded / dl.total) * 100)}%` : ""}</span>
          <Meter v={dl?.downloaded ?? 0} max={dl?.total ?? 1} />
        </div>
      )}
    </Panel>
  )
}

function About() {
  const t = useT()
  const ver = useAsync(() => getVersion().catch(() => "dev"))
  return (
    <Panel title={t("诊断与关于", "Diagnostics & about")}>
      <Field title={t("导出调试日志", "Export debug logs")} desc={t("完整会话日志保存到“下载”文件夹，便于反馈问题", "Saves the full session log to Downloads for bug reports")}>
        <button className="btn" onClick={() => act(api.exportLogs(`CorePilot-logs-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}`), (p) => t(`已导出到 ${p}`, `Exported to ${p}`))}><FileDown size={13} />{t("导出", "Export")}</button>
      </Field>
      <Field title="CorePilot" desc={t("系统调校与游戏性能工具", "System tuning & game performance")}><span className="num faint">v{ver.data}</span></Field>
    </Panel>
  )
}

export function Settings() {
  const t = useT()
  return (
    <Page>
      <PageHead idx="09" title={t("设置", "Settings")} />
      <div className="grid g2" style={{ alignItems: "start" }}>
        <div className="col" style={{ "--gap": "14px" } as CSSProperties}><Appearance /><Performance /><Behavior /><Updates /><About /></div>
        <div className="col" style={{ "--gap": "14px" } as CSSProperties}><Taskbar /><GamePrefs /><Expert /></div>
      </div>
    </Page>
  )
}
