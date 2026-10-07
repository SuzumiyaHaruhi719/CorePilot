import { useMemo, useState, type CSSProperties } from "react"
import { Cpu, MonitorCog, RotateCcw, ShieldAlert } from "lucide-react"
import { api, type CpuSensor, type GpuInfo, type GpuOc, type SmuReply, type SmuStatus } from "../lib/ipc"
import { act, useLive, useProfiles, useT } from "../lib/store"
import { bytes, isNum } from "../lib/util"
import { AsyncButton, confirmDialog, Empty, Field, Meter, Page, PageHead, Panel, Range, Readout, Switch, usePoll } from "../ui/kit"

// ------------------------------------------------------------ GPU
function Knob({ label, unit, value, min, max, step = 1, onChange, enabled = true, hint, color }: { label: string; unit: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; enabled?: boolean; hint?: string; color?: string }) {
  return (
    <div className="col" style={{ "--gap": "8px", opacity: enabled ? 1 : 0.4 } as CSSProperties}>
      <div className="row spread">
        <span className="label">{label}</span>
        <span className="num" style={{ fontSize: 16 }}>{value > 0 && unit === "MHz" ? "+" : ""}{value}<span className="faint" style={{ fontSize: 11, marginLeft: 3 }}>{unit}</span></span>
      </div>
      <Range value={value} min={min} max={max} step={step} onChange={onChange} disabled={!enabled} color={color} />
      <div className="row spread faint num" style={{ fontSize: 10.5 }}><span>{min}</span>{hint && <span>{hint}</span>}<span>{max}</span></div>
    </div>
  )
}

function Gpu() {
  const t = useT()
  const [g, setG] = useState<GpuInfo | null>(null)
  const prof = useProfiles((s) => s.gpu)
  const set = useProfiles((s) => s.set)
  const [draft, setDraft] = useState<GpuOc | null>(null)
  usePoll(async () => {
    const info = await api.gpuInfo()
    setG(info)
    setDraft((d) => d ?? {
      powerLimitW: prof.oc.powerLimitW ?? Math.round(info.powerLimitW), coreOffsetMhz: prof.oc.coreOffsetMhz ?? 0, memOffsetMhz: prof.oc.memOffsetMhz ?? 0,
      tempLimitC: prof.oc.tempLimitC ?? info.tempLimitC, fanSpeedPct: prof.oc.fanSpeedPct ?? null, coreClockMaxMhz: prof.oc.coreClockMaxMhz ?? null,
    })
  }, 1500)
  if (!g) return <div className="skeleton" style={{ height: 260 }} />
  if (!g.available) return <Panel title="GPU"><Empty icon={<MonitorCog size={28} strokeWidth={1.4} />} title={t("未检测到可调校的 NVIDIA 显卡", "No tunable NVIDIA GPU detected")} body={t("GPU 超频依赖 NVML（NVIDIA 驱动自带）。", "GPU tuning uses NVML, shipped with the NVIDIA driver.")} /></Panel>
  const d = draft!
  const up = (p: GpuOc) => setDraft({ ...d, ...p })
  const apply = async () => {
    const oc: GpuOc = {
      powerLimitW: g.supportsPowerLimit ? d.powerLimitW : null,
      coreOffsetMhz: g.supportsClockOffset ? d.coreOffsetMhz : null,
      memOffsetMhz: g.supportsClockOffset ? d.memOffsetMhz : null,
      tempLimitC: g.supportsTempLimit ? d.tempLimitC : null,
      fanSpeedPct: g.supportsFanControl ? d.fanSpeedPct : null,
      coreClockMinMhz: null, coreClockMaxMhz: g.supportsLockedClocks ? d.coreClockMaxMhz : null,
    }
    if (await act(api.gpuApply(oc), t("GPU 设置已应用", "GPU settings applied")) !== undefined) set({ gpu: { ...prof, oc } })
  }
  const reset = async () => {
    await act(api.gpuReset(), t("已恢复默认", "Restored defaults"))
    set({ gpu: { ...prof, oc: {} } })
    setDraft(null)
  }
  return (
    <Panel title={g.name} color="var(--gpu)" className="fill ticks" right={<span className="faint" style={{ fontSize: 12 }}>{t("驱动", "Driver")} {g.driverVersion}</span>}>
      <div className="grid" style={{ gridTemplateColumns: "repeat(6, minmax(0,1fr))", marginBottom: 20 }}>
        <div className="col" style={{ "--gap": "6px" } as CSSProperties}><span className="label">{t("核心", "Core")}</span><Readout v={g.graphicsClock} u="MHz" size="md" /></div>
        <div className="col" style={{ "--gap": "6px" } as CSSProperties}><span className="label">{t("显存", "Memory")}</span><Readout v={g.memClock} u="MHz" size="md" /></div>
        <div className="col" style={{ "--gap": "6px" } as CSSProperties}><span className="label">{t("温度", "Temp")}</span><Readout v={g.temperature} u="°C" size="md" /></div>
        <div className="col" style={{ "--gap": "6px" } as CSSProperties}><span className="label">{t("功耗", "Power")}</span><Readout v={g.powerUsageW} u={`/ ${g.powerLimitW.toFixed(0)} W`} size="md" /></div>
        <div className="col" style={{ "--gap": "6px" } as CSSProperties}><span className="label">{t("负载", "Load")}</span><Readout v={g.utilizationGpu} u="%" size="md" /><Meter v={g.utilizationGpu} color="var(--gpu)" /></div>
        <div className="col" style={{ "--gap": "6px" } as CSSProperties}><span className="label">VRAM</span><div className="readout md"><span className="v">{bytes(g.memUsedBytes).split(" ")[0]}</span><span className="u">{bytes(g.memUsedBytes).split(" ")[1]} / {bytes(g.memTotalBytes, 0)}</span></div><Meter v={g.memUsedBytes} max={g.memTotalBytes || 1} color="var(--gpu)" /></div>
      </div>
      <div className="grid g3" style={{ gap: 26 }}>
        <Knob label={t("功耗墙", "Power limit")} unit="W" value={d.powerLimitW ?? 0} min={Math.round(g.powerLimitMinW)} max={Math.round(g.powerLimitMaxW)} onChange={(v) => up({ powerLimitW: v })} enabled={g.supportsPowerLimit} color="var(--gpu)" />
        <Knob label={t("核心频率偏移", "Core offset")} unit="MHz" value={d.coreOffsetMhz ?? 0} min={g.coreOffsetMinMhz} max={g.coreOffsetMaxMhz} step={5} onChange={(v) => up({ coreOffsetMhz: v })} enabled={g.supportsClockOffset} color="var(--gpu)" />
        <Knob label={t("显存频率偏移", "Memory offset")} unit="MHz" value={d.memOffsetMhz ?? 0} min={g.memOffsetMinMhz} max={g.memOffsetMaxMhz} step={10} onChange={(v) => up({ memOffsetMhz: v })} enabled={g.supportsClockOffset} color="var(--gpu)" />
        <Knob label={t("温度墙", "Temp limit")} unit="°C" value={d.tempLimitC ?? g.tempLimitC} min={g.tempLimitMinC} max={g.tempLimitMaxC} onChange={(v) => up({ tempLimitC: v })} enabled={g.supportsTempLimit} color="var(--gpu)" />
        <div className="col" style={{ "--gap": "8px", opacity: g.supportsLockedClocks ? 1 : 0.4 } as CSSProperties}>
          <div className="row spread"><span className="label">{t("锁定最高核心频率", "Lock max core clock")}</span><Switch on={d.coreClockMaxMhz != null} disabled={!g.supportsLockedClocks} onChange={(v) => up({ coreClockMaxMhz: v ? g.maxGraphicsClockMhz : null })} /></div>
          {d.coreClockMaxMhz != null ? <><Range value={d.coreClockMaxMhz} min={300} max={g.maxGraphicsClockMhz || 3000} step={15} onChange={(v) => up({ coreClockMaxMhz: v })} color="var(--gpu)" /><span className="num faint" style={{ fontSize: 11 }}>≤ {d.coreClockMaxMhz} MHz</span></> : <span className="faint" style={{ fontSize: 12 }}>{t("用于降压降温：限制最高频率", "For undervolt-style capping")}</span>}
        </div>
        <div className="col" style={{ "--gap": "8px", opacity: g.supportsFanControl ? 1 : 0.4 } as CSSProperties}>
          <div className="row spread"><span className="label">{t("显卡风扇", "GPU fan")} <span className="num" style={{ color: "var(--ink-2)" }}>{g.fanSpeedPct}%</span></span><Switch on={d.fanSpeedPct != null} disabled={!g.supportsFanControl} onChange={(v) => up({ fanSpeedPct: v ? Math.max(30, g.fanSpeedPct) : null })} label={t("固定转速", "Fixed speed")} /></div>
          {d.fanSpeedPct != null ? <><Range value={d.fanSpeedPct} min={0} max={100} onChange={(v) => up({ fanSpeedPct: v })} color="var(--gpu)" /><span className="num faint" style={{ fontSize: 11 }}>{d.fanSpeedPct}%</span></> : <span className="faint" style={{ fontSize: 12 }}>{t("驱动自动控制", "Driver automatic")}</span>}
        </div>
      </div>
      <div className="row" style={{ marginTop: 22, paddingTop: 16, borderTop: "1px solid var(--line)" }}>
        <AsyncButton className="btn primary" onClick={apply}>{t("应用", "Apply")}</AsyncButton>
        <AsyncButton className="btn" onClick={reset}><RotateCcw size={13} />{t("恢复默认", "Reset")}</AsyncButton>
        <span className="grow" />
        <div className="col" style={{ "--gap": "2px", textAlign: "right" } as CSSProperties}>
          <span>{t("开机自动应用", "Apply on startup")}</span>
          <span className="faint" style={{ fontSize: 11.5 }}>{t("若上次异常关机或驱动崩溃，会自动跳过", "Skipped automatically after a crash or driver fault")}</span>
        </div>
        <Switch on={prof.onStartup} onChange={(onStartup) => set({ gpu: { ...prof, onStartup } })} />
      </div>
    </Panel>
  )
}

// ------------------------------------------------------------ SMU (Ryzen)
const smuDraft = { all: 0, cores: {} as Record<string, number>, ppt: 0, tdc: 0, edc: 0, scalar: 1 }

function Smu() {
  const t = useT()
  const topo = useLive((s) => s.topo)
  const [st, setSt] = useState<SmuStatus | null>(null)
  const [d, setD] = useState(smuDraft)
  const up = (p: Partial<typeof d>) => { const n = { ...d, ...p }; Object.assign(smuDraft, n); setD(n) }
  usePoll(async () => setSt(await api.smuStatus()), 2500)
  const cores = useMemo(() => topo?.ccds.map((c) => ({ ccd: c.ccdId, label: c.label, cores: [...new Set(c.logicalCpus.map((i) => topo.logical.find((l) => l.id === i)!.coreId))] })) ?? [], [topo])
  const ok = (r: SmuReply, msg: string) => {
    const good = typeof r === "boolean" ? r : r.ok
    if (!good) throw new Error(typeof r === "boolean" ? st?.lastReply ?? "SMU rejected" : r.detail)
    return msg
  }
  const locked = st?.supported === false
  if (!st) return <div className="skeleton" style={{ height: 200 }} />
  if (!st.loaded) {
    return (
      <Panel title={t("CPU 曲线优化 / PBO", "CPU Curve Optimizer / PBO")} className="fill">
        <Empty icon={<Cpu size={28} strokeWidth={1.4} />} title={st.pawnIo ? t("SMU 模块未加载", "SMU module not loaded") : t("需要 PawnIO 驱动", "PawnIO driver required")}
          body={t("曲线优化与 PBO 调整通过 PawnIO 签名驱动访问 AMD SMU，仅支持锐龙处理器。", "Curve Optimizer and PBO tuning access the AMD SMU through the signed PawnIO driver — Ryzen only.")} />
      </Panel>
    )
  }
  return (
    <Panel title={t("CPU 曲线优化 / PBO", "CPU Curve Optimizer / PBO")} color="var(--cpu)" className="fill" right={<span className="tag ok">SMU {st.versionStr}</span>}>
      <div className="row" style={{ padding: "10px 12px", borderRadius: 6, background: "color-mix(in oklab, var(--warn) 10%, transparent)", color: "var(--warn)", marginBottom: 18, fontSize: 12.5 }}>
        <ShieldAlert size={15} />{t("实时覆盖设置，重启后恢复 BIOS 值。负值过大可能导致不稳定，请逐步测试。", "Live overrides — a reboot restores BIOS values. Large negative margins can be unstable; step carefully.")}
      </div>
      {locked && <div className="tag crit" style={{ height: "auto", padding: "8px 10px", marginBottom: 14, textTransform: "none", letterSpacing: 0, font: "400 12.5px var(--f-ui)" }}>{t("此处理器不支持 SMU 调节：", "SMU tuning unsupported on this CPU: ")}{st.unsupportedReason ?? "—"}</div>}
      <fieldset disabled={locked} style={{ border: 0, padding: 0, margin: 0, minWidth: 0, display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1.4fr)", gap: 28 }}>
        <div className="col" style={{ "--gap": "0" } as CSSProperties}>
          <Field title={<>{t("全核曲线优化", "All-core CO")} <span className="num c-cpu">{d.all > 0 ? "+" : ""}{d.all}</span></>} desc={t("负值 = 降压，提升频率与能效", "Negative = undervolt for clocks & efficiency")}>
            <div className="row" style={{ width: 210 }}><Range value={d.all} min={-50} max={30} onChange={(all) => up({ all })} color="var(--cpu)" /><AsyncButton className="btn sm" onClick={async () => act(api.smuCoAll(d.all).then((r) => ok(r, "")), t(`全核 CO ${d.all}`, `All-core CO ${d.all}`))}>{t("应用", "Apply")}</AsyncButton></div>
          </Field>
          {(["ppt", "tdc", "edc"] as const).map((k) => (
            <Field key={k} title={k.toUpperCase()} desc={{ ppt: t("封装功耗上限 (W)", "Package power (W)"), tdc: t("持续电流 (A)", "Thermal current (A)"), edc: t("峰值电流 (A)", "Electrical current (A)") }[k]}>
              <input className="input num" type="number" min={0} style={{ width: 90 }} value={d[k] || ""} placeholder="—" onChange={(e) => up({ [k]: Number(e.target.value) })} />
              <AsyncButton className="btn sm" disabled={!d[k]} onClick={async () => act(api.smuLimit(k, d[k]).then((r) => ok(r, "")), `${k.toUpperCase()} ${d[k]}`)}>{t("应用", "Apply")}</AsyncButton>
            </Field>
          ))}
          <Field title={<>{t("PBO 倍率", "PBO scalar")} <span className="num">{d.scalar}×</span></>}>
            <div className="row" style={{ width: 210 }}><Range value={d.scalar} min={1} max={10} onChange={(scalar) => up({ scalar })} color="var(--cpu)" /><AsyncButton className="btn sm" onClick={async () => act(api.smuScalar(d.scalar).then((r) => ok(r, "")), `${d.scalar}×`)}>{t("应用", "Apply")}</AsyncButton></div>
          </Field>
          <Field title={t("强制恢复默认", "Force stock")} desc={t("全核 CO 归零，覆盖 BIOS 中的降压设置（本次开机有效）", "All-core CO = 0, overriding BIOS undervolt for this boot")}>
            <AsyncButton className="btn sm danger" onClick={async () => { if (await confirmDialog({ title: t("恢复默认电压曲线？", "Force stock voltage curve?"), ok: t("恢复", "Force stock"), danger: true })) await act(api.smuStock().then((r) => ok(r, "")), t("已恢复默认", "Stock restored")) }}>{t("恢复", "Force stock")}</AsyncButton>
          </Field>
          {st.lastReply && <div className={`mono ${st.lastReplyOk ? "faint" : "c-crit"}`} style={{ fontSize: 11, paddingTop: 10 }}>{st.lastReply}</div>}
        </div>
        <div className="col" style={{ "--gap": "14px" } as CSSProperties}>
          <span className="label">{t("单核曲线优化", "Per-core CO")}</span>
          {cores.map((c) => (
            <div key={c.ccd} className="col" style={{ "--gap": "8px" } as CSSProperties}>
              <span className="faint" style={{ fontSize: 12 }}>{c.label || `CCD ${c.ccd}`}</span>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: 6 }}>
                {c.cores.map((_, i) => {
                  const key = `${c.ccd}:${i}`
                  const v = d.cores[key] ?? 0
                  return (
                    <div key={key} className="col" style={{ "--gap": "4px", padding: 6, borderRadius: 6, background: "var(--bg)", boxShadow: "inset 0 0 0 1px var(--line)", alignItems: "center" } as CSSProperties}>
                      <span className="faint num" style={{ fontSize: 10 }}>C{i}</span>
                      <input className="num" type="number" min={-50} max={30} value={v} aria-label={`CCD ${c.ccd} core ${i}`}
                        style={{ width: "100%", background: "transparent", border: 0, textAlign: "center", fontSize: 15, color: v < 0 ? "var(--cpu)" : v > 0 ? "var(--crit)" : "var(--ink)" }}
                        onChange={(e) => up({ cores: { ...d.cores, [key]: Math.max(-50, Math.min(30, Number(e.target.value))) } })}
                        onBlur={() => act(api.smuCo(c.ccd, i, v).then((r) => ok(r, "")), `CCD${c.ccd} C${i} ${v}`)} />
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
          <span className="faint" style={{ fontSize: 11.5 }}>{t("修改后离开输入框即应用到该核心", "Applied to that core when the field loses focus")}</span>
        </div>
      </fieldset>
    </Panel>
  )
}

function CpuDeep() {
  const t = useT()
  const [rows, setRows] = useState<CpuSensor[] | null>(null)
  const [gone, setGone] = useState(false)
  usePoll(async () => { try { setRows(await api.cpuSensors()) } catch { setGone(true) } }, 2000, { enabled: !gone })
  const groups = useMemo(() => {
    const m = new Map<string, CpuSensor[]>()
    for (const r of rows ?? []) m.set(r.kind, [...(m.get(r.kind) ?? []), r])
    return [...m.entries()]
  }, [rows])
  if (gone || !rows?.length) return null
  const unit: Record<string, string> = { Power: "W", Voltage: "V", Clock: "MHz", Current: "A", Temperature: "°C", Load: "%", Factor: "" }
  return (
    <Panel title={t("CPU 深度遥测", "CPU deep telemetry")} className="fill">
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: "6px 24px" }}>
        {groups.map(([kind, list]) => (
          <div key={kind} className="col" style={{ "--gap": "4px" } as CSSProperties}>
            <span className="label" style={{ padding: "8px 0 4px" }}>{kind}</span>
            {list.map((r) => (
              <div key={r.name} className="row spread" style={{ fontSize: 12 }}>
                <span className="faint ellipsis">{r.name}</span>
                <span className="num">{isNum(r.value) ? `${r.value.toFixed(kind === "Voltage" ? 3 : kind === "Clock" ? 0 : 1)} ${unit[kind] ?? ""}` : "—"}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Panel>
  )
}

export function Tuning() {
  const t = useT()
  const s = useLive((x) => x.sensors)
  return (
    <Page>
      <PageHead idx="06" title={t("超频调校", "Tuning")} sub={t(`GPU 超频与锐龙 SMU 调节 · 当前 CPU ${isNum(s?.cpuPower) ? s!.cpuPower!.toFixed(0) : "—"} W / GPU ${isNum(s?.gpuPower) ? s!.gpuPower!.toFixed(0) : "—"} W`, `GPU overclocking and Ryzen SMU · CPU ${isNum(s?.cpuPower) ? s!.cpuPower!.toFixed(0) : "—"} W / GPU ${isNum(s?.gpuPower) ? s!.gpuPower!.toFixed(0) : "—"} W now`)} />
      <Gpu />
      <Smu />
      <CpuDeep />
    </Page>
  )
}
