import { AnimatePresence, motion } from "motion/react";
import {
  AlertTriangle,
  Check,
  Cpu,
  Fan,
  Gauge,
  Loader2,
  MemoryStick,
  RotateCcw,
  Rocket,
  Save,
  Thermometer,
  Trash2,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { ClickRipple } from "../components/ui/Ripple";
import { Slider } from "../components/ui/Slider";
import { TabHeader } from "../components/ui/TabHeader";
import { Toggle } from "../components/ui/Toggle";
import { cn } from "../lib/cn";
import { formatBytes } from "../lib/format";
import { hoverPop } from "../lib/motion";
import { api, type GpuOcInfo, type GpuOcSettings } from "../lib/ipc";
import { useGpuProfiles, type GpuProfile } from "../store/gpuProfiles";
import { useSettings } from "../store/settings";

/**
 * Lowest manual fan speed the UI lets you request, % of max. Mirrors the backend
 * `FAN_SPEED_FLOOR` in `gpu.rs`: a manual 0% would pin the fans fully off and let
 * the GPU overheat. "Auto" is the separate toggle (sends no manual value), so the
 * manual slider floor is safe to enforce here too.
 */
const MANUAL_FAN_FLOOR_PCT = 20;

function getErrorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return "操作失败";
}

function tempHue(t: number): number {
  if (t >= 83) return 22;
  if (t >= 72) return 55;
  return 158;
}

interface TileProps {
  icon: LucideIcon;
  label: string;
  value: string;
  sub?: string;
  hue: number;
  live?: boolean;
}

function StatTile({ icon: Icon, label, value, sub, hue, live = true }: TileProps) {
  const tint = `oklch(80% 0.14 ${hue})`;
  const dim = value === "—";
  return (
    <motion.div
      whileHover={{ y: -2 }}
      transition={hoverPop}
      className="hud-frame glass hairline group relative min-w-0 overflow-hidden rounded-xl p-3"
      style={{ "--glow": tint, "--color-accent": tint } as CSSProperties}
    >
      {/* edge accent rail */}
      <span
        className="pointer-events-none absolute inset-y-0 left-0 w-[2px]"
        style={{ background: tint, opacity: dim ? 0.25 : 0.7 }}
      />
      <div className="mb-2 flex items-center gap-2">
        <span
          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg"
          style={{ background: `color-mix(in oklch, ${tint} 16%, transparent)`, color: tint } as CSSProperties}
        >
          <Icon size={15} />
        </span>
        <span className="hud-label truncate text-[9.5px] text-dim">{label}</span>
        {live && !dim && (
          <span
            className="ml-auto h-1.5 w-1.5 shrink-0 animate-pulse rounded-full"
            style={{ background: tint, boxShadow: `0 0 6px ${tint}` }}
          />
        )}
      </div>
      <div className="nums flex items-baseline gap-1 truncate">
        <span
          className={cn("text-[22px] font-semibold leading-none", dim ? "text-dim" : "text-ink")}
          style={dim ? undefined : ({ color: tint, textShadow: `0 0 12px color-mix(in oklch, ${tint} 36%, transparent)` } as CSSProperties)}
        >
          {value}
        </span>
        {sub && <span className="truncate text-[10.5px] font-normal text-dim">{sub}</span>}
      </div>
    </motion.div>
  );
}

interface ControlCardProps {
  icon: LucideIcon;
  iconClass: string;
  title: string;
  supported: boolean;
  right?: React.ReactNode;
  children: React.ReactNode;
}

function ControlCard({ icon: Icon, iconClass, title, supported, right, children }: ControlCardProps) {
  return (
    <div
      className={cn(
        "rounded-xl border border-line bg-surface2/40 p-3.5 transition-colors duration-200",
        supported ? "hover:border-line-strong" : "opacity-45",
      )}
    >
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={cn("grid h-6 w-6 place-items-center rounded-md bg-surface3", iconClass)}>
            <Icon size={13} />
          </span>
          <span className="text-[12.5px] font-medium text-ink">{title}</span>
          {!supported && <span className="hud-label text-[9px] text-dim">不支持</span>}
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}

export function GpuTune() {
  const pollMs = useSettings((s) => s.pollMs);
  const { profiles, activeId, applyOnStartup, addProfile, deleteProfile, setActive, setApplyOnStartup } =
    useGpuProfiles();

  const [info, setInfo] = useState<GpuOcInfo | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [showSave, setShowSave] = useState(false);
  const [newName, setNewName] = useState("");

  const [powerOn, setPowerOn] = useState(true);
  const [powerW, setPowerW] = useState(300);
  const [coreOffOn, setCoreOffOn] = useState(false);
  const [coreOffset, setCoreOffset] = useState(0);
  const [memOffOn, setMemOffOn] = useState(false);
  const [memOffset, setMemOffset] = useState(0);
  const [fanAuto, setFanAuto] = useState(true);
  const [fanPct, setFanPct] = useState(50);
  const [tempOn, setTempOn] = useState(false);
  const [tempLimit, setTempLimit] = useState(83);

  const seeded = useRef(false);

  function draftToSettings(): GpuOcSettings {
    const s: GpuOcSettings = {};
    if (powerOn) s.powerLimitW = powerW;
    if (coreOffOn) s.coreOffsetMhz = coreOffset;
    if (memOffOn) s.memOffsetMhz = memOffset;
    if (!fanAuto) s.fanSpeedPct = fanPct;
    if (tempOn) s.tempLimitC = tempLimit;
    return s;
  }

  function loadDraft(s: GpuOcSettings, fallback: GpuOcInfo | null) {
    setPowerOn(s.powerLimitW != null);
    if (s.powerLimitW != null) setPowerW(Math.round(s.powerLimitW));
    else if (fallback) setPowerW(Math.round(fallback.powerLimitW));
    setCoreOffOn(s.coreOffsetMhz != null);
    if (s.coreOffsetMhz != null) setCoreOffset(s.coreOffsetMhz);
    setMemOffOn(s.memOffsetMhz != null);
    if (s.memOffsetMhz != null) setMemOffset(s.memOffsetMhz);
    setFanAuto(s.fanSpeedPct == null);
    if (s.fanSpeedPct != null) setFanPct(Math.max(MANUAL_FAN_FLOOR_PCT, s.fanSpeedPct));
    setTempOn(s.tempLimitC != null);
    if (s.tempLimitC != null) setTempLimit(s.tempLimitC);
    else if (fallback && fallback.tempLimitC > 0) setTempLimit(fallback.tempLimitC);
  }

  // Live readout polling.
  useEffect(() => {
    let alive = true;
    const tick = () =>
      api
        .gpuOcInfo()
        .then((i) => {
          if (alive) setInfo(i);
        })
        .catch(() => undefined);
    void tick();
    const id = setInterval(tick, Math.max(800, pollMs));
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [pollMs]);

  // Seed sliders once from the live card (or the active saved profile).
  useEffect(() => {
    if (!info || !info.available || seeded.current) return;
    seeded.current = true;
    setPowerW(Math.round(info.powerLimitW));
    setFanPct(Math.max(MANUAL_FAN_FLOOR_PCT, info.fanSpeedPct > 0 ? info.fanSpeedPct : 50));
    if (info.tempLimitC > 0) setTempLimit(info.tempLimitC);
    const active = profiles.find((p) => p.id === activeId);
    if (active) loadDraft(active.settings, info);
  }, [info, profiles, activeId]);

  async function applySettings(s: GpuOcSettings, label: string) {
    setApplying(true);
    setStatus(null);
    try {
      await api.gpuOcApply(s);
      setStatus(label);
      const fresh = await api.gpuOcInfo();
      setInfo(fresh);
    } catch (e: unknown) {
      setStatus(getErrorMessage(e));
    } finally {
      setApplying(false);
    }
  }

  async function reset() {
    setApplying(true);
    setStatus(null);
    try {
      await api.gpuOcReset();
      setActive(null);
      const fresh = await api.gpuOcInfo();
      setInfo(fresh);
      setPowerOn(true);
      setPowerW(Math.round(fresh.powerLimitW));
      setCoreOffOn(false);
      setCoreOffset(0);
      setMemOffOn(false);
      setMemOffset(0);
      setFanAuto(true);
      setTempOn(false);
      if (fresh.tempLimitC > 0) setTempLimit(fresh.tempLimitC);
      setStatus("已恢复出厂默认");
    } catch (e: unknown) {
      setStatus(getErrorMessage(e));
    } finally {
      setApplying(false);
    }
  }

  function saveProfile() {
    const name = newName.trim() || `配置 ${profiles.length + 1}`;
    addProfile(name, draftToSettings());
    setNewName("");
    setShowSave(false);
    setStatus(`已保存配置「${name}」`);
  }

  function loadProfile(p: GpuProfile) {
    loadDraft(p.settings, info);
    setActive(p.id);
    void applySettings(p.settings, `已应用配置「${p.name}」`);
  }

  const isErrorStatus = status != null && !status.startsWith("已");

  return (
    <>
      <TabHeader
        icon={Rocket}
        title="GPU 超频"
        subtitle="NVIDIA 实时调优 — 功率 / 频率偏移(NVAPI) / 温度 / 风扇，配置可保存自动应用"
      />

      {info && !info.available ? (
        <div className="grid flex-1 place-items-center px-6 pb-8">
          <div className="glass hairline flex max-w-md flex-col items-center gap-3 rounded-2xl p-8 text-center">
            <span className="grid h-12 w-12 place-items-center rounded-xl bg-warn/15 text-warn">
              <AlertTriangle size={22} />
            </span>
            <div className="text-[14px] font-semibold text-ink">未检测到受支持的 NVIDIA 显卡</div>
            <p className="text-[12px] leading-relaxed text-dim">
              GPU 超频通过 NVIDIA NVML 实现，仅支持 NVIDIA 独立显卡。请确认已安装显卡驱动并以管理员身份运行。
            </p>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 space-y-4 overflow-auto px-6 pb-6">
          {/* Live readout — instrument cluster */}
          <div>
            <div className="mb-2.5 flex items-center gap-2">
              <Gauge size={13} className="text-accent" />
              <span className="hud-label text-[10px] text-dim">实时遥测</span>
              <span className="h-px flex-1 bg-line" />
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              <StatTile icon={Cpu} label="核心频率" value={info ? String(info.graphicsClock) : "—"} sub="MHz" hue={274} />
              <StatTile icon={MemoryStick} label="显存频率" value={info ? String(info.memClock) : "—"} sub="MHz" hue={224} />
              <StatTile
                icon={Thermometer}
                label="温度"
                value={info ? String(info.temperature) : "—"}
                sub="°C"
                hue={info ? tempHue(info.temperature) : 158}
              />
              <StatTile
                icon={Zap}
                label="功耗"
                value={info ? info.powerUsageW.toFixed(0) : "—"}
                sub={info ? `/ ${info.powerLimitW.toFixed(0)} W` : "W"}
                hue={75}
              />
              <StatTile icon={Gauge} label="GPU 占用" value={info ? String(info.utilizationGpu) : "—"} sub="%" hue={158} />
              <StatTile icon={Fan} label="风扇" value={info ? String(info.fanSpeedPct) : "—"} sub="%" hue={200} />
              <StatTile
                icon={MemoryStick}
                label="显存"
                value={info ? formatBytes(info.memUsedBytes, 1) : "—"}
                sub={info ? `/ ${formatBytes(info.memTotalBytes, 0)}` : ""}
                hue={280}
              />
              <StatTile
                icon={Cpu}
                label="显卡"
                value={info ? info.name.replace(/NVIDIA GeForce /i, "") : "—"}
                hue={262}
                live={false}
              />
            </div>
          </div>

          {/* Tuning */}
          <div className="glass hairline space-y-3.5 rounded-2xl p-4">
            <div className="flex items-center gap-2">
              <Gauge size={13} className="text-accent" />
              <span className="hud-label text-[10px] text-dim">调优控制</span>
              <span className="h-px flex-1 bg-line" />
            </div>

            <ControlCard
              icon={Zap}
              iconClass="text-warn"
              title="功率上限"
              supported={!!info?.supportsPowerLimit}
              right={
                <label className="flex items-center gap-2 text-[11.5px] text-muted">
                  启用
                  <Toggle checked={powerOn} onChange={setPowerOn} />
                </label>
              }
            >
              <Slider
                label="目标功率（提高可获得更持久的 Boost）"
                value={powerW}
                min={info ? Math.round(info.powerLimitMinW) : 100}
                max={info ? Math.round(info.powerLimitMaxW) : 450}
                unit="W"
                disabled={!powerOn || !info?.supportsPowerLimit}
                onChange={setPowerW}
              />
            </ControlCard>

            <ControlCard
              icon={Cpu}
              iconClass="text-accent"
              title="核心频率偏移"
              supported={!!info?.supportsClockOffset}
              right={
                <label className="flex items-center gap-2 text-[11.5px] text-muted">
                  启用
                  <Toggle checked={coreOffOn} onChange={setCoreOffOn} />
                </label>
              }
            >
              <Slider
                label="核心频率偏移（Afterburner 式 +/- MHz，提升 Boost 上限）"
                value={coreOffset}
                min={info ? info.coreOffsetMinMhz : -500}
                max={info ? info.coreOffsetMaxMhz : 1000}
                step={5}
                unit="MHz"
                disabled={!coreOffOn || !info?.supportsClockOffset}
                onChange={setCoreOffset}
              />
            </ControlCard>

            <ControlCard
              icon={MemoryStick}
              iconClass="text-cyan"
              title="显存频率偏移"
              supported={!!info?.supportsClockOffset}
              right={
                <label className="flex items-center gap-2 text-[11.5px] text-muted">
                  启用
                  <Toggle checked={memOffOn} onChange={setMemOffOn} />
                </label>
              }
            >
              <Slider
                label="显存频率偏移（+/- MHz）"
                value={memOffset}
                min={info ? info.memOffsetMinMhz : -2000}
                max={info ? info.memOffsetMaxMhz : 3000}
                step={10}
                unit="MHz"
                disabled={!memOffOn || !info?.supportsClockOffset}
                onChange={setMemOffset}
              />
            </ControlCard>

            <ControlCard
              icon={Thermometer}
              iconClass="text-warn"
              title="温度上限"
              supported={!!info?.supportsTempLimit}
              right={
                <label className="flex items-center gap-2 text-[11.5px] text-muted">
                  启用
                  <Toggle checked={tempOn} onChange={setTempOn} />
                </label>
              }
            >
              <Slider
                label="目标温度（达到后自动降频维持，越低越凉、性能略降）"
                value={tempLimit}
                min={info && info.tempLimitMinC > 0 ? info.tempLimitMinC : 50}
                max={info && info.tempLimitMaxC > 0 ? info.tempLimitMaxC : 90}
                unit="°C"
                disabled={!tempOn || !info?.supportsTempLimit}
                onChange={setTempLimit}
              />
            </ControlCard>

            <ControlCard
              icon={Fan}
              iconClass="text-cyan"
              title="风扇转速"
              supported={!!info?.supportsFanControl}
              right={
                <label className="flex items-center gap-2 text-[11.5px] text-muted">
                  自动
                  <Toggle checked={fanAuto} onChange={setFanAuto} />
                </label>
              }
            >
              <Slider
                label="手动转速"
                value={fanPct}
                min={MANUAL_FAN_FLOOR_PCT}
                max={100}
                unit="%"
                disabled={fanAuto || !info?.supportsFanControl}
                onChange={setFanPct}
              />
            </ControlCard>

            <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3.5">
              <Button variant="primary" onClick={() => void applySettings(draftToSettings(), "已应用调优设置")} disabled={applying}>
                {applying ? <Loader2 size={14} className="animate-spin" /> : <Rocket size={14} />} {applying ? "应用中…" : "应用"}
              </Button>
              <Button variant="subtle" onClick={() => setShowSave(true)} disabled={applying}>
                <Save size={14} /> 保存为配置
              </Button>
              <Button variant="subtle" onClick={() => void reset()} disabled={applying} title="清零所有偏移并恢复固件默认">
                <RotateCcw size={14} /> 恢复默认
              </Button>
              <AnimatePresence mode="wait">
                {status && (
                  <motion.span
                    key={status}
                    initial={{ opacity: 0, x: -6 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0 }}
                    transition={hoverPop}
                    className={cn(
                      "ml-auto flex items-center gap-1.5 text-[12px] font-medium",
                      isErrorStatus ? "text-danger" : "text-ok glow-text",
                    )}
                  >
                    {isErrorStatus ? <AlertTriangle size={13} /> : <Check size={13} />} {status}
                  </motion.span>
                )}
              </AnimatePresence>
            </div>
          </div>

          {/* Profiles */}
          <div className="glass hairline space-y-3 rounded-2xl p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Save size={13} className="text-accent" />
                <span className="hud-label text-[10px] text-dim">超频配置</span>
                {profiles.length > 0 && <span className="nums text-[10px] text-dim">· {profiles.length}</span>}
              </div>
              <label className="flex cursor-pointer items-center gap-2 text-[11.5px] text-muted">
                启动时自动应用
                <Toggle checked={applyOnStartup} onChange={setApplyOnStartup} />
              </label>
            </div>

            {profiles.length === 0 ? (
              <p className="rounded-xl border border-dashed border-line bg-surface2/30 px-3.5 py-3 text-[11.5px] leading-relaxed text-dim">
                还没有保存的配置。调好参数后点「保存为配置」，即可一键随时切换；开启「启动时自动应用」后，CorePilot 启动会自动套用所选配置。
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                <AnimatePresence>
                  {profiles.map((p) => {
                    const active = p.id === activeId;
                    return (
                      <motion.button
                        key={p.id}
                        layout
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.85 }}
                        whileHover={{ scale: 1.03, y: -2 }}
                        whileTap={{ scale: 0.97 }}
                        transition={hoverPop}
                        onClick={() => loadProfile(p)}
                        className={cn(
                          "no-drag group relative flex items-center gap-2 overflow-hidden rounded-xl border px-3 py-2 text-left",
                          active ? "border-accent/50 bg-accent/10 glow-sm" : "border-line bg-surface2/50 hover:bg-surface3",
                        )}
                      >
                        <span className={cn("grid h-7 w-7 shrink-0 place-items-center rounded-lg", active ? "bg-accent/20 text-accent-bright" : "bg-surface3 text-dim")}>
                          <Rocket size={14} />
                        </span>
                        <div>
                          <div className="flex items-center gap-1.5">
                            <span className="text-[12.5px] font-medium text-ink">{p.name}</span>
                            {active && <span className="hud-label text-[8px] text-accent-bright glow-text">已应用</span>}
                          </div>
                          <div className="nums text-[10px] text-dim">
                            {[
                              p.settings.powerLimitW != null && `${Math.round(p.settings.powerLimitW)}W`,
                              p.settings.coreOffsetMhz != null &&
                                `核心${(p.settings.coreOffsetMhz ?? 0) >= 0 ? "+" : ""}${p.settings.coreOffsetMhz}MHz`,
                              p.settings.memOffsetMhz != null &&
                                `显存${(p.settings.memOffsetMhz ?? 0) >= 0 ? "+" : ""}${p.settings.memOffsetMhz}MHz`,
                              p.settings.fanSpeedPct != null && `风扇${p.settings.fanSpeedPct}%`,
                              p.settings.tempLimitC != null && `${p.settings.tempLimitC}°C`,
                            ]
                              .filter(Boolean)
                              .join(" · ") || "默认"}
                          </div>
                        </div>
                        <span
                          role="button"
                          tabIndex={-1}
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteProfile(p.id);
                          }}
                          className="no-drag ml-1 grid h-5 w-5 cursor-pointer place-items-center rounded-md text-dim opacity-0 transition-colors duration-150 hover:bg-danger hover:text-white group-hover:opacity-100"
                          title="删除配置"
                        >
                          <Trash2 size={12} />
                        </span>
                        <ClickRipple />
                      </motion.button>
                    );
                  })}
                </AnimatePresence>
              </div>
            )}
          </div>

          <div className="flex items-start gap-2 text-[11px] leading-relaxed text-dim">
            <AlertTriangle size={13} className="mt-0.5 shrink-0 text-warn/70" />
            <p>
              功率上限 / 温度目标 / 风扇通过 NVIDIA <span className="text-muted">NVML</span>（钳制在固件安全范围，不会超压损坏）；核心 / 显存<span className="text-muted">频率偏移</span>通过 <span className="text-muted">NVAPI</span> 实现，即 MSI Afterburner 式 +/- MHz 真实超频，会提升 Boost 上限。<span className="text-warn/90">偏移过高可能花屏或崩溃 —— 请小幅递增测试稳定性，随时「恢复默认」清零。</span>
            </p>
          </div>
        </div>
      )}

      <Modal
        open={showSave}
        onClose={() => setShowSave(false)}
        title="保存超频配置"
        footer={
          <>
            <Button onClick={() => setShowSave(false)}>取消</Button>
            <Button variant="primary" onClick={saveProfile}>
              保存
            </Button>
          </>
        }
      >
        <input
          autoFocus
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && saveProfile()}
          placeholder="配置名称，例如「游戏全速」「静音节能」"
          className="no-drag w-full rounded-lg border border-line bg-surface2 px-3 py-2 text-[13px] text-ink outline-none transition-colors focus:border-accent/50"
        />
        <p className="mt-2 text-[11.5px] text-dim">将保存当前已开启的调优项，可随时一键应用。</p>
      </Modal>
    </>
  );
}
