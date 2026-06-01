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

function getErrorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return "操作失败";
}

const CORE_MIN_FLOOR = 210;

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
}

function StatTile({ icon: Icon, label, value, sub, hue }: TileProps) {
  return (
    <div className="glass hairline flex min-w-0 items-center gap-3 rounded-xl p-3">
      <span
        className="grid h-9 w-9 shrink-0 place-items-center rounded-lg"
        style={
          {
            background: `oklch(70% 0.14 ${hue} / 0.16)`,
            color: `oklch(80% 0.14 ${hue})`,
          } as CSSProperties
        }
      >
        <Icon size={17} />
      </span>
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-wide text-dim">{label}</div>
        <div className="nums truncate text-[15px] font-semibold text-ink">
          {value}
          {sub && <span className="ml-1 text-[11px] font-normal text-dim">{sub}</span>}
        </div>
      </div>
    </div>
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
    <div className={cn("rounded-xl border border-line bg-surface2/40 p-3.5", !supported && "opacity-45")}>
      <div className="mb-2.5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon size={14} className={iconClass} />
          <span className="text-[12.5px] font-medium text-ink">{title}</span>
          {!supported && <span className="text-[10.5px] text-dim">· 不支持</span>}
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
  const [coreOn, setCoreOn] = useState(false);
  const [coreMax, setCoreMax] = useState(2800);
  const [fanAuto, setFanAuto] = useState(true);
  const [fanPct, setFanPct] = useState(50);
  const [tempOn, setTempOn] = useState(false);
  const [tempLimit, setTempLimit] = useState(83);

  const seeded = useRef(false);

  function draftToSettings(): GpuOcSettings {
    const s: GpuOcSettings = {};
    if (powerOn) s.powerLimitW = powerW;
    if (coreOn) {
      s.coreClockMinMhz = CORE_MIN_FLOOR;
      s.coreClockMaxMhz = coreMax;
    }
    if (!fanAuto) s.fanSpeedPct = fanPct;
    if (tempOn) s.tempLimitC = tempLimit;
    return s;
  }

  function loadDraft(s: GpuOcSettings, fallback: GpuOcInfo | null) {
    setPowerOn(s.powerLimitW != null);
    if (s.powerLimitW != null) setPowerW(Math.round(s.powerLimitW));
    else if (fallback) setPowerW(Math.round(fallback.powerLimitW));
    setCoreOn(s.coreClockMaxMhz != null);
    if (s.coreClockMaxMhz != null) setCoreMax(s.coreClockMaxMhz);
    setFanAuto(s.fanSpeedPct == null);
    if (s.fanSpeedPct != null) setFanPct(s.fanSpeedPct);
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
    setCoreMax(info.maxGraphicsClockMhz > 0 ? info.maxGraphicsClockMhz : 2800);
    setFanPct(info.fanSpeedPct > 0 ? info.fanSpeedPct : 50);
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
      setCoreOn(false);
      setCoreMax(fresh.maxGraphicsClockMhz > 0 ? fresh.maxGraphicsClockMhz : 2800);
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

  return (
    <>
      <TabHeader
        icon={Rocket}
        title="GPU 超频"
        subtitle="NVIDIA 显卡实时调优 — 功率 / 核心频率 / 风扇，配置可保存自动应用"
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
          {/* Live readout */}
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
            />
          </div>

          {/* Tuning */}
          <div className="glass hairline space-y-3.5 rounded-2xl p-4">
            <div className="flex items-center gap-2 text-[12.5px] font-semibold text-muted">
              <Gauge size={15} className="text-accent" /> 调优控制
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
              title="锁定核心频率上限"
              supported={!!info && info.supportsLockedClocks && info.maxGraphicsClockMhz > 0}
              right={
                <label className="flex items-center gap-2 text-[11.5px] text-muted">
                  启用
                  <Toggle checked={coreOn} onChange={setCoreOn} />
                </label>
              }
            >
              <Slider
                label="核心频率（在固件支持范围内锁定上限）"
                value={coreMax}
                min={300}
                max={info && info.maxGraphicsClockMhz > 0 ? info.maxGraphicsClockMhz : 3000}
                step={15}
                unit="MHz"
                disabled={!coreOn || !info?.supportsLockedClocks || !info || info.maxGraphicsClockMhz === 0}
                onChange={setCoreMax}
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
                min={0}
                max={100}
                unit="%"
                disabled={fanAuto || !info?.supportsFanControl}
                onChange={setFanPct}
              />
            </ControlCard>

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button variant="primary" onClick={() => void applySettings(draftToSettings(), "已应用调优设置")} disabled={applying}>
                {applying ? <Loader2 size={14} className="animate-spin" /> : <Rocket size={14} />} 应用
              </Button>
              <Button onClick={() => void reset()} disabled={applying}>
                <RotateCcw size={14} /> 恢复默认
              </Button>
              <Button onClick={() => setShowSave(true)}>
                <Save size={14} /> 保存为配置
              </Button>
              <AnimatePresence>
                {status && (
                  <motion.span
                    initial={{ opacity: 0, x: -6 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0 }}
                    className="ml-1 flex items-center gap-1.5 text-[12px] font-medium text-ok"
                  >
                    <Check size={13} /> {status}
                  </motion.span>
                )}
              </AnimatePresence>
            </div>
          </div>

          {/* Profiles */}
          <div className="glass hairline space-y-3 rounded-2xl p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-[12.5px] font-semibold text-muted">
                <Save size={15} className="text-accent" /> 超频配置
              </div>
              <label className="flex items-center gap-2 text-[11.5px] text-muted">
                启动时自动应用
                <Toggle checked={applyOnStartup} onChange={setApplyOnStartup} />
              </label>
            </div>

            {profiles.length === 0 ? (
              <p className="text-[11.5px] leading-relaxed text-dim">
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
                        <Rocket size={14} className={active ? "text-accent-bright" : "text-dim"} />
                        <div>
                          <div className="text-[12.5px] font-medium text-ink">{p.name}</div>
                          <div className="nums text-[10px] text-dim">
                            {[
                              p.settings.powerLimitW != null && `${Math.round(p.settings.powerLimitW)}W`,
                              p.settings.coreClockMaxMhz != null && `${p.settings.coreClockMaxMhz}MHz`,
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
                          className="ml-1 grid h-5 w-5 place-items-center rounded-md text-dim opacity-0 transition hover:bg-danger hover:text-white group-hover:opacity-100"
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
              调优通过 NVIDIA NVML 实现：功率上限、核心频率锁定与风扇转速均会被钳制在显卡固件允许的安全范围内，<span className="text-muted">不会超压、无法损坏硬件，且可随时「恢复默认」</span>。提示：NVML 的频率锁定是在固件支持区间内固定上/下限，并非 MSI Afterburner 那种 +MHz 偏移超频（后者需 NVAPI 私有接口，风险更高）。
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
