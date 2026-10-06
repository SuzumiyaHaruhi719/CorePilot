import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, Check, Loader2, RotateCcw, Save, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { Panel } from "../components/ui/Panel";
import { Badge, Cluster, ClusterCell as Cell, Readout } from "../components/ui/Readout";
import { Segmented } from "../components/ui/Segmented";
import { RangeInput } from "../components/ui/Slider";
import { TabHeader } from "../components/ui/TabHeader";
import { Toggle } from "../components/ui/Toggle";
import { cn } from "../lib/cn";
import { useT, useTf } from "../lib/i18n";
import { formatBytes } from "../lib/format";
import { easeOut } from "../lib/motion";
import { api, type GpuOcInfo, type GpuOcSettings } from "../lib/ipc";
import { refreshGpuOc, useSharedGpuOc } from "../hooks/useSharedTelemetry";
import { useGpuProfiles, type GpuProfile } from "../store/gpuProfiles";
import { REASON_DISPLAY_FAULT, REASON_UNCLEAN_SHUTDOWN, useGpuOcGuard } from "../store/gpuOcGuard";

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

/**
 * Why the startup auto-apply was skipped, in the user's language.
 *
 * The backend deliberately hands over a stable tag rather than a sentence
 * (rule 7 — user-visible text is `tf(zh, en)` on this side). An unrecognised tag
 * still gets a real explanation instead of a blank banner: the skip already
 * happened, so silence here would just look like the overclock vanished.
 */
function blockReasonText(tf: (zh: string, en: string) => string, reason: string): string {
  if (reason === REASON_DISPLAY_FAULT) {
    return tf(
      "上次关机前检测到显卡驱动错误，已暂停启动时自动应用超频",
      "A display-driver fault was logged before the last shutdown — the startup auto-apply was skipped",
    );
  }
  if (reason === REASON_UNCLEAN_SHUTDOWN) {
    return tf(
      "检测到上次异常关机，已暂停启动时自动应用超频",
      "The last shutdown was unclean — the startup auto-apply was skipped",
    );
  }
  return tf(
    "上次运行期间检测到系统异常，已暂停启动时自动应用超频",
    "A system fault was logged during the last session — the startup auto-apply was skipped",
  );
}

/** Temperature only earns color when it means something: warn near the limit, danger at it. */
function tempColor(t: number): string | undefined {
  if (t >= 83) return "var(--color-danger)";
  if (t >= 72) return "var(--color-warn)";
  return undefined;
}

interface TuneRowProps {
  title: string;
  desc: string;
  supported: boolean;
  /** Value shown on the row's right edge (dimmed while the row is off). */
  value: ReactNode;
  on: boolean;
  control: ReactNode;
  children: ReactNode;
}

/** A Windows-Settings-style row: title + context left, live value + switch right, rail below. */
function TuneRow({ title, desc, supported, value, on, control, children }: TuneRowProps) {
  const t = useT();
  const tf = useTf();
  return (
    <div className={cn("border-t border-line py-4 first:border-t-0 first:pt-1", !supported && "opacity-45")}>
      <div className="flex items-center gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium text-ink">{t(title)}</span>
            {!supported && <Badge>{tf("不支持", "Unsupported")}</Badge>}
          </div>
          <p className="mt-0.5 text-[12px] text-muted">{t(desc)}</p>
        </div>
        <div className={cn("nums text-[20px] transition-colors duration-150", on ? "text-ink" : "text-dim")}>{value}</div>
        <div className="no-drag">{control}</div>
      </div>
      <div className="mt-2.5">{children}</div>
    </div>
  );
}

const unit = (u: string) => <span className="ml-0.5 text-[11px] text-dim">{u}</span>;
const signed = (n: number) => (n > 0 ? `+${n}` : String(n));

export function GpuTune() {
  const t = useT();
  const tf = useTf();
  const { profiles, activeId, applyOnStartup, startupError, addProfile, updateProfile, deleteProfile, setActive, setApplyOnStartup, setStartupError } =
    useGpuProfiles();

  // Session-only: set by App.tsx when the startup crash guard skipped the
  // auto-apply. Never persisted — see store/gpuOcGuard.ts.
  const ocBlock = useGpuOcGuard((s) => s.block);
  const setOcBlock = useGpuOcGuard((s) => s.setBlock);

  const [status, setStatus] = useState<{ kind: "ok" | "error"; message: string } | null>(null);
  const okStatus = (message: string) => setStatus({ kind: "ok", message });
  const errStatus = (message: string) => setStatus({ kind: "error", message });
  const [applying, setApplying] = useState(false);
  const [showSave, setShowSave] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [newName, setNewName] = useState("");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [delProfile, setDelProfile] = useState<GpuProfile | null>(null);

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

  // Live readout — from the app-wide shared poller (PerfView / GpuDetail read the
  // same one). `gpu_oc_info` is ~20 NVML calls per read; this page used to add a
  // third independent interval on top of those two. The shared poller also stops
  // while nobody can see the window, so leaving this tab open in the tray during
  // a game no longer hammers NVML behind the game.
  const info = useSharedGpuOc();

  // "The first read has come back (or given up)" — the spinner-vs-content gate.
  // A card-less machine still answers with `available: false`, so `info` going
  // non-null covers it; the timer is only for the case the old code got from
  // `withTimeout` — a backend that never answers at all must still drop the
  // spinner rather than leave the page loading forever.
  const [infoLoaded, setInfoLoaded] = useState(false);
  useEffect(() => {
    if (info) setInfoLoaded(true);
  }, [info]);
  useEffect(() => {
    const id = window.setTimeout(() => setInfoLoaded(true), 4000);
    return () => window.clearTimeout(id);
  }, []);

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
      okStatus(label);
      await refreshGpuOc();
    } catch (e: unknown) {
      errStatus(getErrorMessage(e));
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
      const fresh = await refreshGpuOc();
      setPowerOn(true);
      if (fresh) setPowerW(Math.round(fresh.powerLimitW));
      setCoreOffOn(false);
      setCoreOffset(0);
      setMemOffOn(false);
      setMemOffset(0);
      setFanAuto(true);
      setTempOn(false);
      if (fresh && fresh.tempLimitC > 0) setTempLimit(fresh.tempLimitC);
      okStatus("已恢复出厂默认");
    } catch (e: unknown) {
      errStatus(getErrorMessage(e));
    } finally {
      setApplying(false);
    }
  }

  function saveProfile() {
    const name = newName.trim() || tf(`配置 ${profiles.length + 1}`, `Profile ${profiles.length + 1}`);
    addProfile(name, draftToSettings());
    setNewName("");
    setShowSave(false);
    okStatus(tf(`已保存配置「${name}」`, `Saved profile “${name}”`));
  }

  // Save Current (保存当前): overwrite the active profile's settings in place.
  function saveCurrent() {
    if (!activeId) return;
    updateProfile(activeId, { settings: draftToSettings() });
    const name = profiles.find((p) => p.id === activeId)?.name ?? "当前配置";
    okStatus(tf(`已保存到「${name}」`, `Saved to “${name}”`));
  }

  async function loadProfile(p: GpuProfile) {
    // Re-entry guard: a second click mid-apply would overlap two gpuOcApply
    // IPCs (racing hardware writes + status lines).
    if (applying) return;
    // Mark active only AFTER the backend confirms the apply; show pending meanwhile.
    loadDraft(p.settings, info);
    setPendingId(p.id);
    setApplying(true);
    setStatus(null);
    try {
      await api.gpuOcApply(p.settings);
      setActive(p.id);
      okStatus(tf(`已应用配置「${p.name}」`, `Applied profile “${p.name}”`));
      await refreshGpuOc();
    } catch (e: unknown) {
      errStatus(getErrorMessage(e));
    } finally {
      setApplying(false);
      setPendingId(null);
    }
  }

  // ── Crash-guard banner ────────────────────────────────────────────────────
  // The profile the startup apply WOULD have used. "仍然应用" goes through
  // `loadProfile` rather than a bare `api.gpuOcApply` so the deliberate path is
  // identical to clicking the profile in the list: same re-entry guard, same
  // status line, same post-apply refresh. Both actions clear the banner —
  // whatever happened, the user has now decided, and a failed apply still says
  // so in the status line below.
  const blockedProfile = ocBlock ? (profiles.find((p) => p.id === activeId) ?? null) : null;

  async function applyBlockedProfile() {
    if (!blockedProfile) return;
    await loadProfile(blockedProfile);
    setOcBlock(null);
  }

  async function resetFromBlock() {
    await reset();
    setOcBlock(null);
  }

  const isErrorStatus = status?.kind === "error";
  const powerPct = info && info.powerLimitW > 0 ? (info.powerUsageW / info.powerLimitW) * 100 : undefined;
  const vramPct = info && info.memTotalBytes > 0 ? (info.memUsedBytes / info.memTotalBytes) * 100 : undefined;

  return (
    <>
      <TabHeader title="GPU 超频" subtitle="NVIDIA 实时调优 — 功率 / 频率偏移(NVAPI) / 温度 / 风扇，配置可保存自动应用" />

      {!infoLoaded && !info ? (
        <div className="min-h-0 flex-1 space-y-4 px-6 pb-6" aria-busy>
          <div className="skeleton h-[132px] rounded-xl" />
          <div className="skeleton h-[360px] rounded-xl" />
        </div>
      ) : !info?.available ? (
        <div className="grid flex-1 place-items-center px-6 pb-8">
          <div className="flex max-w-sm flex-col items-center text-center">
            <AlertTriangle size={22} className="text-warn" />
            <div className="mt-3 text-[14px] font-semibold text-ink">未检测到受支持的 NVIDIA 显卡</div>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">
              GPU 超频通过 NVIDIA NVML 实现，仅支持 NVIDIA 独立显卡。请确认已安装显卡驱动并以管理员身份运行。
            </p>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 space-y-4 overflow-auto px-6 pb-6">
          {ocBlock && (
            <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg bg-warn/10 px-3.5 py-2.5 text-[12.5px] text-warn ring-1 ring-inset ring-warn/25">
              <AlertTriangle size={15} className="shrink-0" />
              <span className="min-w-0 flex-1">
                {blockReasonText(tf, ocBlock.reason)}
                {ocBlock.detail && <span className="ml-1 opacity-70">({ocBlock.detail})</span>}
              </span>
              <div className="flex shrink-0 items-center gap-1.5">
                {blockedProfile && (
                  <Button size="sm" disabled={applying} onClick={() => void applyBlockedProfile()}>
                    {tf("仍然应用", "Apply anyway")}
                  </Button>
                )}
                <Button size="sm" disabled={applying} onClick={() => void resetFromBlock()}>
                  {tf("恢复默认", "Reset to stock")}
                </Button>
                <Button size="sm" variant="subtle" ariaLabel={tf("关闭", "Dismiss")} onClick={() => setOcBlock(null)} className="w-7 px-0 text-warn hover:text-warn">
                  <X size={14} />
                </Button>
              </div>
            </div>
          )}
          {startupError && (
            <div role="alert" className="flex items-center gap-3 rounded-lg bg-danger/10 px-3.5 py-2.5 text-[12.5px] text-danger ring-1 ring-inset ring-danger/25">
              <AlertTriangle size={15} className="shrink-0" />
              <span className="min-w-0 flex-1">
                {tf(`启动时自动应用超频失败 — ${startupError}`, `Auto-apply on startup failed — ${startupError}`)}
              </span>
              <Button size="sm" variant="subtle" ariaLabel={tf("关闭", "Dismiss")} onClick={() => setStartupError(null)} className="w-7 px-0 text-danger hover:text-danger">
                <X size={14} />
              </Button>
            </div>
          )}

          {/* Instrument cluster — one panel, hairline-divided readouts. */}
          <Panel
            title={info.name}
            desc={tf(`驱动 ${info.driverVersion}`, `Driver ${info.driverVersion}`)}
            actions={
              <span className="flex items-center gap-2 text-[11.5px] text-dim">
                <span className="live-dot text-ok" />
                {tf("实时", "Live")}
              </span>
            }
            flush
          >
            <Cluster className="rounded-b-xl">
                <Cell>
                  <Readout
                    label="核心频率"
                    value={info.graphicsClock}
                    unit="MHz"
                    size="lg"
                    sub={tf(`上限 ${info.maxGraphicsClockMhz} MHz`, `Max ${info.maxGraphicsClockMhz} MHz`)}
                  />
                </Cell>
                <Cell>
                  <Readout label="显存频率" value={info.memClock} unit="MHz" size="lg" />
                </Cell>
                <Cell>
                  <Readout
                    label="温度"
                    value={info.temperature}
                    unit="°C"
                    size="lg"
                    color={tempColor(info.temperature)}
                    sub={info.tempLimitC > 0 ? tf(`目标 ${info.tempLimitC} °C`, `Target ${info.tempLimitC} °C`) : undefined}
                  />
                </Cell>
                <Cell meter={powerPct} meterColor="var(--color-warn)">
                  <Readout
                    label="功耗"
                    value={info.powerUsageW}
                    unit="W"
                    size="lg"
                    sub={tf(`上限 ${info.powerLimitW.toFixed(0)} W`, `Limit ${info.powerLimitW.toFixed(0)} W`)}
                  />
                </Cell>
                <Cell meter={info.utilizationGpu} meterColor="var(--color-vcache)">
                  <Readout label="GPU 占用" value={info.utilizationGpu} unit="%" size="lg" />
                </Cell>
                <Cell meter={vramPct} meterColor="var(--color-cyan)">
                  <Readout label="显存" value={formatBytes(info.memUsedBytes, 1)} size="lg" sub={`/ ${formatBytes(info.memTotalBytes, 0)}`} />
                </Cell>
                <Cell meter={info.fanSpeedPct} meterColor="var(--color-muted)">
                  <Readout label="风扇" value={info.fanSpeedPct} unit="%" size="lg" />
                </Cell>
            </Cluster>
          </Panel>

          <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
            {/* Tuning */}
            <Panel title="调优控制" desc="开启一项后拖动调整，点「应用」写入显卡。">
              <TuneRow
                title="功率上限"
                desc="提高可获得更持久的 Boost"
                supported={!!info.supportsPowerLimit}
                on={powerOn}
                value={
                  <>
                    {powerW}
                    {unit("W")}
                  </>
                }
                control={<Toggle checked={powerOn} onChange={setPowerOn} label={tf("启用功率上限", "Enable power limit")} />}
              >
                <RangeInput
                  label={tf("目标功率", "Target power")}
                  value={powerW}
                  min={Math.round(info.powerLimitMinW)}
                  max={Math.round(info.powerLimitMaxW)}
                  unit="W"
                  disabled={!powerOn || !info.supportsPowerLimit}
                  onChange={setPowerW}
                />
              </TuneRow>

              <TuneRow
                title="核心频率偏移"
                desc="Afterburner 式 +/- MHz，提升 Boost 上限"
                supported={!!info.supportsClockOffset}
                on={coreOffOn}
                value={
                  <>
                    {signed(coreOffset)}
                    {unit("MHz")}
                  </>
                }
                control={<Toggle checked={coreOffOn} onChange={setCoreOffOn} label={tf("启用核心频率偏移", "Enable core offset")} />}
              >
                <RangeInput
                  label={tf("核心频率偏移", "Core clock offset")}
                  value={coreOffset}
                  min={info.coreOffsetMinMhz}
                  max={info.coreOffsetMaxMhz}
                  step={5}
                  unit="MHz"
                  disabled={!coreOffOn || !info.supportsClockOffset}
                  onChange={setCoreOffset}
                />
              </TuneRow>

              <TuneRow
                title="显存频率偏移"
                desc="+/- MHz，小幅递增测试稳定性"
                supported={!!info.supportsClockOffset}
                on={memOffOn}
                value={
                  <>
                    {signed(memOffset)}
                    {unit("MHz")}
                  </>
                }
                control={<Toggle checked={memOffOn} onChange={setMemOffOn} label={tf("启用显存频率偏移", "Enable memory offset")} />}
              >
                <RangeInput
                  label={tf("显存频率偏移", "Memory clock offset")}
                  value={memOffset}
                  min={info.memOffsetMinMhz}
                  max={info.memOffsetMaxMhz}
                  step={10}
                  unit="MHz"
                  disabled={!memOffOn || !info.supportsClockOffset}
                  onChange={setMemOffset}
                />
              </TuneRow>

              <TuneRow
                title="温度上限"
                desc="达到后自动降频维持，越低越凉、性能略降"
                supported={!!info.supportsTempLimit}
                on={tempOn}
                value={
                  <>
                    {tempLimit}
                    {unit("°C")}
                  </>
                }
                control={<Toggle checked={tempOn} onChange={setTempOn} label={tf("启用温度上限", "Enable temperature limit")} />}
              >
                <RangeInput
                  label={tf("目标温度", "Target temperature")}
                  value={tempLimit}
                  min={info.tempLimitMinC > 0 ? info.tempLimitMinC : 50}
                  max={info.tempLimitMaxC > 0 ? info.tempLimitMaxC : 90}
                  unit="°C"
                  disabled={!tempOn || !info.supportsTempLimit}
                  onChange={setTempLimit}
                />
              </TuneRow>

              <TuneRow
                title="风扇转速"
                desc="自动交由显卡固件控制；手动固定转速"
                supported={!!info.supportsFanControl}
                on={!fanAuto}
                value={
                  fanAuto ? null : (
                    <>
                      {fanPct}
                      {unit("%")}
                    </>
                  )
                }
                control={
                  <Segmented
                    id="gpu-fan-mode"
                    value={fanAuto ? "auto" : "manual"}
                    onChange={(v) => setFanAuto(v === "auto")}
                    options={[
                      { value: "auto", label: "自动" },
                      { value: "manual", label: "手动" },
                    ]}
                  />
                }
              >
                <RangeInput
                  label={tf("手动转速", "Manual fan speed")}
                  value={fanPct}
                  min={MANUAL_FAN_FLOOR_PCT}
                  max={100}
                  unit="%"
                  disabled={fanAuto || !info.supportsFanControl}
                  onChange={setFanPct}
                />
              </TuneRow>

              <div className="-mx-4 -mb-4 mt-1 flex flex-wrap items-center gap-2 rounded-b-xl border-t border-line bg-surface2/40 px-4 py-3">
                <Button variant="primary" onClick={() => void applySettings(draftToSettings(), "已应用调优设置")} disabled={applying}>
                  {applying && <Loader2 size={14} className="animate-spin" />} {applying ? "应用中…" : "应用"}
                </Button>
                <Button onClick={saveCurrent} disabled={applying || !activeId} title="覆盖保存到当前所选配置">
                  <Save size={14} /> 保存当前
                </Button>
                <Button onClick={() => setShowSave(true)} disabled={applying} title="保存为新的配置">
                  另存为
                </Button>
                <Button variant="subtle" onClick={() => setShowResetConfirm(true)} disabled={applying} title="清零所有偏移并恢复固件默认">
                  <RotateCcw size={14} /> 恢复默认
                </Button>
                <AnimatePresence mode="wait">
                  {status && (
                    <motion.span
                      key={status.message}
                      role="status"
                      initial={{ opacity: 0, y: 3 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.18, ease: easeOut }}
                      className={cn("ml-auto flex items-center gap-1.5 text-[12px] font-medium", isErrorStatus ? "text-danger" : "text-ok")}
                    >
                      {isErrorStatus ? <AlertTriangle size={13} /> : <Check size={13} />} {t(status.message)}
                    </motion.span>
                  )}
                </AnimatePresence>
              </div>
            </Panel>

            {/* Profiles */}
            <Panel
              title="超频配置"
              desc={profiles.length > 0 ? tf(`${profiles.length} 个配置 · 点击即应用`, `${profiles.length} saved · click to apply`) : undefined}
              bodyClassName="px-2 pb-2"
            >
              {profiles.length === 0 ? (
                <div className="px-2 pb-2 pt-1">
                  <p className="text-[12.5px] leading-relaxed text-muted">
                    还没有保存的配置。调好参数后点「另存为」，即可一键随时切换；开启「启动时自动应用」后，CorePilot 启动会自动套用所选配置。
                  </p>
                  <Button className="mt-3" size="sm" onClick={() => setShowSave(true)} disabled={applying}>
                    <Save size={13} /> {tf("保存当前参数为配置", "Save current as profile")}
                  </Button>
                </div>
              ) : (
                <div role="radiogroup" aria-label={tf("超频配置", "Overclock profiles")} className="flex flex-col gap-0.5">
                  <AnimatePresence initial={false}>
                    {profiles.map((p) => {
                      const pending = p.id === pendingId;
                      const active = p.id === activeId && !pending;
                      const summary =
                        [
                          p.settings.powerLimitW != null && `${Math.round(p.settings.powerLimitW)}W`,
                          p.settings.coreOffsetMhz != null && `${t("核心")} ${signed(p.settings.coreOffsetMhz)}`,
                          p.settings.memOffsetMhz != null && `${t("显存")} ${signed(p.settings.memOffsetMhz)}`,
                          p.settings.fanSpeedPct != null && `${t("风扇")} ${p.settings.fanSpeedPct}%`,
                          p.settings.tempLimitC != null && `${p.settings.tempLimitC}°C`,
                        ]
                          .filter(Boolean)
                          .join(" · ") || t("默认");
                      return (
                        <motion.div
                          key={p.id}
                          layout
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: "auto" }}
                          exit={{ opacity: 0, height: 0 }}
                          transition={{ duration: 0.2, ease: easeOut }}
                          className="group relative"
                        >
                          <button
                            type="button"
                            role="radio"
                            aria-checked={active}
                            onClick={() => void loadProfile(p)}
                            disabled={applying}
                            className={cn(
                              "no-drag flex w-full items-center gap-3 rounded-lg px-2.5 py-2 pr-9 text-left transition-colors duration-150",
                              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
                              active ? "bg-accent/10" : "hover:bg-surface2",
                              applying && !pending && "cursor-not-allowed opacity-55",
                            )}
                          >
                            <span
                              className={cn(
                                "grid h-4 w-4 shrink-0 place-items-center rounded-full transition-colors",
                                active ? "bg-accent" : "shadow-[inset_0_0_0_1.5px_var(--color-dim)]",
                              )}
                            >
                              {pending ? (
                                <Loader2 size={12} className="animate-spin text-accent" />
                              ) : (
                                active && <span className="h-1.5 w-1.5 rounded-full bg-on-accent" />
                              )}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[13px] font-medium text-ink">{p.name}</span>
                              <span className="nums block truncate text-[11.5px] text-dim">{pending ? t("应用中…") : summary}</span>
                            </span>
                          </button>
                          <button
                            type="button"
                            onClick={() => setDelProfile(p)}
                            className="no-drag absolute right-1.5 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-md text-dim opacity-0 transition-[opacity,color,background-color] duration-150 hover:bg-danger/12 hover:text-danger focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 group-hover:opacity-100"
                            aria-label={tf(`删除配置 ${p.name}`, `Delete profile ${p.name}`)}
                            title={tf("删除配置", "Delete profile")}
                          >
                            <Trash2 size={13} />
                          </button>
                        </motion.div>
                      );
                    })}
                  </AnimatePresence>
                </div>
              )}
              <label className="mt-2 flex cursor-pointer items-center justify-between gap-3 border-t border-line px-2.5 pb-1.5 pt-3 text-[12.5px] text-ink">
                <span>
                  启动时自动应用
                  <span className="block text-[11.5px] text-dim">{tf("检测到异常关机时会自动跳过", "Skipped automatically after a crash")}</span>
                </span>
                <Toggle checked={applyOnStartup} onChange={setApplyOnStartup} label={tf("启动时自动应用", "Apply on startup")} />
              </label>
            </Panel>
          </div>

          <p className="flex max-w-[110ch] items-start gap-2 text-[11.5px] leading-relaxed text-dim">
            <AlertTriangle size={13} className="mt-0.5 shrink-0 text-warn" />
            <span>
              {t(
                "功率上限 / 温度目标 / 风扇通过 NVIDIA NVML（钳制在固件安全范围，不会超压损坏）；核心 / 显存频率偏移通过 NVAPI 实现，即 MSI Afterburner 式 +/- MHz 真实超频，会提升 Boost 上限。",
              )}{" "}
              <span className="text-warn">{t("偏移过高可能花屏或崩溃 —— 请小幅递增测试稳定性，随时「恢复默认」清零。")}</span>
            </span>
          </p>
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
          className="field no-drag h-9 w-full text-[13px]"
        />
        <p className="mt-2 text-[12px] text-muted">将保存当前已开启的调优项，可随时一键应用。</p>
      </Modal>

      <Modal
        open={delProfile !== null}
        onClose={() => setDelProfile(null)}
        title="删除超频配置"
        footer={
          <>
            <Button onClick={() => setDelProfile(null)}>取消</Button>
            <Button
              variant="danger"
              onClick={() => {
                if (delProfile) deleteProfile(delProfile.id);
                setDelProfile(null);
              }}
            >
              删除
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-relaxed text-muted">
          确定删除超频配置 <span className="font-semibold text-ink">{delProfile?.name}</span> 吗？此操作不可撤销（当前 GPU 设置不受影响）。
        </p>
      </Modal>

      <Modal
        open={showResetConfirm}
        onClose={() => setShowResetConfirm(false)}
        title="恢复默认"
        footer={
          <>
            <Button onClick={() => setShowResetConfirm(false)}>取消</Button>
            <Button
              variant="danger"
              onClick={() => {
                setShowResetConfirm(false);
                void reset();
              }}
            >
              恢复默认
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-relaxed text-muted">
          {tf(
            "确定将所有功率 / 频率偏移 / 温度 / 风扇设置清零并恢复固件默认吗？当前正在运行的超频将立即失效。",
            "Reset all power / clock-offset / temp / fan settings to firmware defaults? Your current live overclock will be cleared immediately.",
          )}
        </p>
      </Modal>
    </>
  );
}
