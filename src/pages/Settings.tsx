import { useEffect, useState, type CSSProperties } from "react"
import { motion } from "motion/react"
import { getVersion } from "@tauri-apps/api/app"
import { Download, FileDown, RefreshCw } from "lucide-react"
import { api, on, type TbConfig, type UpdateInfo } from "../lib/ipc"
import { act, toast, useSettings, useT, TB_METRICS, type Accent } from "../lib/store"
import { Field, Meter, Page, PageHead, Panel, Range, Seg, Switch, useAsync } from "../ui/kit"

function ThemeTile({ v, on, onClick, label }: { v: "dark" | "light"; on: boolean; onClick: () => void; label: string }) {
  const c = v === "dark" ? { bg: "#0c0c0e", rail: "#0f0f12", p: "#19191d", l: "rgba(255,248,235,.1)", ink: "#eeebe5" } : { bg: "#efede8", rail: "#e8e5df", p: "#fbfaf8", l: "rgba(20,16,10,.1)", ink: "#1b1a18" }
  return (
    <button onClick={onClick} className="col" style={{ "--gap": "8px", alignItems: "center" } as CSSProperties} aria-pressed={on}>
      <motion.div whileHover={{ y: -2 }} style={{ width: 132, height: 82, borderRadius: 8, background: c.bg, display: "grid", gridTemplateColumns: "28px 1fr", overflow: "hidden", boxShadow: on ? "0 0 0 2px var(--acc)" : `0 0 0 1px ${c.l}`, transition: "box-shadow .2s" }}>
        <div style={{ background: c.rail, borderRight: `1px solid ${c.l}`, padding: 6, display: "grid", gap: 4, alignContent: "start" }}>
          {[0, 1, 2, 3].map((i) => <i key={i} style={{ height: 4, borderRadius: 2, background: i === 1 ? "var(--acc)" : c.l }} />)}
        </div>
        <div style={{ padding: 7, display: "grid", gap: 5, gridTemplateColumns: "1fr 1fr", alignContent: "start" }}>
          <i style={{ gridColumn: "1 / -1", height: 22, borderRadius: 3, background: c.p, border: `1px solid ${c.l}`, position: "relative" }}><b style={{ position: "absolute", left: 4, right: 4, bottom: 5, height: 2, background: "var(--cpu)", borderRadius: 2 }} /></i>
          <i style={{ height: 16, borderRadius: 3, background: c.p, border: `1px solid ${c.l}` }} /><i style={{ height: 16, borderRadius: 3, background: c.p, border: `1px solid ${c.l}` }} />
        </div>
      </motion.div>
      <span style={{ color: on ? "var(--ink)" : "var(--ink-3)", fontSize: 12.5 }}>{label}</span>
    </button>
  )
}

const ACCENTS: { v: Accent; c: string }[] = [{ v: "violet", c: "#8b6cff" }, { v: "ember", c: "#ff6a2b" }, { v: "mint", c: "#2fd39a" }, { v: "sky", c: "#4aa8ff" }]

function Appearance() {
  const t = useT()
  const s = useSettings()
  return (
    <Panel title={t("外观", "Appearance")}>
      <Field title={t("主题", "Theme")}>
        <ThemeTile v="dark" on={s.theme === "dark"} onClick={() => s.set({ theme: "dark" })} label={t("碳黑", "Carbon")} />
        <ThemeTile v="light" on={s.theme === "light"} onClick={() => s.set({ theme: "light" })} label={t("骨白", "Bone")} />
      </Field>
      <Field title={t("强调色", "Accent")} desc={t("用于选中、焦点与主要操作", "Selection, focus and primary actions")}>
        {ACCENTS.map((a) => (
          <motion.button key={a.v} aria-label={a.v} aria-pressed={s.accent === a.v} onClick={() => s.set({ accent: a.v })} whileTap={{ scale: 0.9 }}
            style={{ width: 24, height: 24, borderRadius: "50%", background: a.c, boxShadow: s.accent === a.v ? `0 0 0 2px var(--panel), 0 0 0 4px ${a.c}` : "none", transition: "box-shadow .2s" }} />
        ))}
      </Field>
      <Field title={t("语言", "Language")}><Seg value={s.lang} onChange={(lang) => s.set({ lang })} options={[{ v: "zh", label: "中文" }, { v: "en", label: "English" }]} /></Field>
      <Field title={t("减少动态效果", "Reduce motion")} desc={t("关闭过渡、滚动示波与数字滚动动画", "Disable transitions, scope glide and digit rolls")}><Switch on={s.reduceMotion} onChange={(reduceMotion) => s.set({ reduceMotion })} /></Field>
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
  const color = (k: string) => (k.startsWith("cpu") ? tb.themeCpu : k.startsWith("gpu") ? tb.themeGpu : k.startsWith("mem") ? tb.themeMem : k.startsWith("disk") ? tb.themeDisk : tb.themeNet)
  return (
    <Panel title={t("任务栏监控", "Taskbar monitor")} right={<Switch on={tb.enabled} onChange={(enabled) => up({ enabled })} />}>
      {/* mock taskbar preview */}
      <div style={{ height: 40, borderRadius: 6, background: "#1c1c1f", display: "flex", alignItems: "center", padding: "0 10px", gap: 6, justifyContent: tb.barPosition === "right" ? "flex-end" : "flex-start", marginBottom: 12, opacity: tb.enabled ? 1 : 0.4, transition: "opacity .3s", boxShadow: "inset 0 1px 0 rgba(255,255,255,.06)" }}>
        {tb.barPosition === "right" && <span style={{ flex: 1 }} />}
        <div style={{ display: "grid", gridAutoFlow: "column", gridTemplateRows: tb.singleLine ? "1fr" : "1fr 1fr", gap: `0 ${tb.itemSpace}px`, padding: tb.padding, background: tb.colorsEnabled ? tb.bg : "transparent", borderRadius: 3, font: `${tb.bold ? 700 : 400} ${tb.size + 2}px Bahnschrift, Segoe UI`, color: "#e6e6e6", marginLeft: tb.barPosition === "left" ? tb.offset : 0, marginRight: tb.barPosition === "right" ? tb.offset : 0 }}>
          {tb.metrics.map((m) => <span key={m} style={{ display: "flex", gap: tb.innerSpace / 2, whiteSpace: "nowrap" }}><span style={{ color: tb.colorsEnabled ? tb.label : "#9a9a9a" }}>{m.split(".")[0].toUpperCase()}</span><span style={{ color: tb.colorsEnabled ? color(m) : undefined }}>{m.endsWith("temp") ? "62°" : m.endsWith("util") ? "34%" : m.startsWith("net") ? "1.2M" : "4.8G"}</span></span>)}
        </div>
        {[0, 1, 2, 3].map((i) => <i key={i} style={{ width: 22, height: 22, borderRadius: 4, background: "rgba(255,255,255,.08)" }} />)}
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
      <Field title={t("停靠位置", "Dock side")}><Seg value={tb.barPosition} onChange={(barPosition) => up({ barPosition })} options={[{ v: "left", label: t("左侧", "Left") }, { v: "right", label: t("右侧", "Right") }]} /></Field>
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
            <Color value={tb.themeCpu} onChange={(themeCpu) => up({ themeCpu })} label="CPU" />
            <Color value={tb.themeGpu} onChange={(themeGpu) => up({ themeGpu })} label="GPU" />
            <Color value={tb.themeMem} onChange={(themeMem) => up({ themeMem })} label="RAM" />
            <Color value={tb.themeNet} onChange={(themeNet) => up({ themeNet })} label="NET" />
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
        <div className="col" style={{ "--gap": "14px" } as CSSProperties}><Appearance /><Behavior /><Updates /><About /></div>
        <Taskbar />
      </div>
    </Page>
  )
}
