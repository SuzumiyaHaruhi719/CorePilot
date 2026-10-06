import { AlertTriangle, Check, Eye, EyeOff, Fan, Gauge, Info, Layers, Loader2, Moon, Pencil, Plus, RefreshCw, RotateCcw, Save, Sparkles, Thermometer, Trash2, Wind } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { AutoTuneWizard } from "../components/fans/AutoTuneWizard";
import { FanCurveEditor } from "../components/fans/FanCurveEditor";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { Segmented } from "../components/ui/Segmented";
import { Panel } from "../components/ui/Panel";
import { Meter } from "../components/ui/Readout";
import { RangeInput, Slider } from "../components/ui/Slider";
import { TabHeader } from "../components/ui/TabHeader";
import { Toggle } from "../components/ui/Toggle";
import { curvesDiverge } from "../lib/autotuneUtils";
import { cn } from "../lib/cn";
import { useT, useTf } from "../lib/i18n";
import { easeOut } from "../lib/motion";
import { api, withTimeout, type FanCalibProgress, type FanCalibration, type FanChannel, type FanCurvePoint, type FanInfo, type FanMode, type FanTempSource } from "../lib/ipc";
import { useUiActive } from "../hooks/useUiActive";
import { useFanAutotune } from "../store/fanAutotune";
import { useSettings } from "../store/settings";
import { defaultConfig, FAN_PRESETS, MIN_SAFE_DUTY, useFanProfiles, type FanConfig } from "../store/fanProfiles";

const MODE_OPTIONS: { value: FanMode; label: string }[] = [
  { value: "auto", label: "自动" },
  { value: "manual", label: "手动" },
  { value: "curve", label: "曲线" },
];

/** Icon per built-in preset id (kept here so the store stays icon-free). */
const PRESET_ICON = { "preset-silent": Moon, "preset-standard": Gauge, "preset-turbo": Wind, "preset-fullblast": Fan } as const;

/** Linear interpolation of a fan curve (mirrors the Rust engine) for the live
 *  operating-point marker. */
function interpCurve(curve: FanCurvePoint[], temp: number): number {
  if (curve.length === 0) return 0;
  const pts = [...curve].sort((a, b) => a.tempC - b.tempC);
  if (temp <= pts[0].tempC) return pts[0].duty;
  const last = pts[pts.length - 1];
  if (temp >= last.tempC) return last.duty;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (temp >= a.tempC && temp <= b.tempC) {
      const span = b.tempC - a.tempC;
      if (span <= 0) return b.duty;
      return a.duty + ((temp - a.tempC) / span) * (b.duty - a.duty);
    }
  }
  return last.duty;
}

/** Prefer a CPU-ish temperature as the default curve source. */
function pickDefaultTempSource(temps: FanTempSource[]): string | null {
  if (temps.length === 0) return null;
  const cpu = temps.find((t) => /tctl|tdie|cpu|package|core/i.test(t.name));
  return (cpu ?? temps[0]).id;
}

interface ChannelCardProps {
  channel: FanChannel;
  config: FanConfig;
  temps: FanTempSource[];
  /** Custom display name, or undefined to show the chip's default name. */
  label?: string;
  onChange: (patch: Partial<FanConfig>) => void;
  onRename: (name: string) => void;
}

function ChannelCard({ channel, config, temps, label, onChange, onRename }: ChannelCardProps) {
  const t = useT();
  const tf = useTf();
  const locked = !channel.controllable;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const displayName = label || channel.name;
  // While dragging the curve, hold a local draft so we don't persist + hit the
  // backend on every pointer-move; commit once on release.
  const [draftCurve, setDraftCurve] = useState<FanCurvePoint[] | null>(null);
  const effectiveCurve = draftCurve ?? config.curve;
  // Case fans tuned with a GPU-assist curve carry a second curve (curve2) driven
  // by the GPU temp source; toggle which one the editor below edits.
  const [activeCurve, setActiveCurve] = useState<"primary" | "gpu">("primary");

  function startEdit() {
    setDraft(label ?? "");
    setEditing(true);
    requestAnimationFrame(() => inputRef.current?.focus());
  }
  function commitEdit() {
    onRename(draft);
    setEditing(false);
  }
  const source = temps.find((t) => t.id === config.tempSourceId) ?? null;
  const liveTemp = source?.c ?? null;
  const liveDuty =
    liveTemp != null ? Math.max(config.minDuty, interpCurve(effectiveCurve, liveTemp)) : null;
  const gpuSource = temps.find((t) => t.id === config.tempSourceId2) ?? null;
  const gpuLiveTemp = gpuSource?.c ?? null;

  function setMode(mode: FanMode) {
    if (mode === "curve" && !config.tempSourceId) {
      onChange({ mode, tempSourceId: pickDefaultTempSource(temps) });
    } else {
      onChange({ mode });
    }
  }

  const spinning = !locked && config.mode !== "auto";
  const rpm = channel.rpm != null ? Math.round(channel.rpm) : null;
  const pct = channel.pct != null ? Math.round(channel.pct) : null;
  // The glyph turns at a rate that tracks the real fan: faster fan, faster spin.
  const spinSec = rpm && rpm > 0 ? Math.max(0.5, Math.min(4, 2400 / rpm)) : 0;

  return (
    <section className={cn("glass rounded-xl", locked && "opacity-60")}>
      <header className="flex items-center justify-between gap-4 px-4 pb-3 pt-3.5">
        <div className="flex min-w-0 items-center gap-3">
          <Fan
            size={20}
            strokeWidth={1.6}
            className={cn("shrink-0 transition-colors", spinning ? "text-accent" : "text-dim", spinSec > 0 && "animate-spin-slow")}
            style={spinSec > 0 ? { animationDuration: `${spinSec}s` } : undefined}
          />
          <div className="min-w-0">
            {editing ? (
              <input
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commitEdit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitEdit();
                  if (e.key === "Escape") setEditing(false);
                }}
                placeholder={channel.name}
                maxLength={24}
                aria-label={tf("风扇名称", "Fan name")}
                className="field no-drag h-7 w-36 px-2 text-[13px] font-semibold"
              />
            ) : (
              <button
                type="button"
                onClick={startEdit}
                title={tf("点击重命名", "Click to rename")}
                className="no-drag group flex max-w-full cursor-pointer items-center gap-1.5 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
              >
                <span className="truncate text-[13.5px] font-semibold text-ink">{displayName}</span>
                <Pencil size={12} className="shrink-0 text-dim opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
              </button>
            )}
            <div className="truncate text-[11.5px] text-dim">
              {channel.hw}
              {label ? ` · ${channel.name}` : ""}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-baseline gap-4 text-right">
          <div>
            <div className="nums text-[22px] leading-none text-ink">
              {rpm ?? <span className="text-dim">—</span>}
              <span className="ml-1 text-[11px] text-dim">RPM</span>
            </div>
          </div>
          <div className="nums w-12 text-[15px] leading-none text-muted">
            {pct ?? "—"}
            <span className="ml-0.5 text-[11px] text-dim">%</span>
          </div>
        </div>
      </header>

      <div className="border-t border-line px-4 pb-4 pt-3">
        {locked ? (
          <div className="flex items-center gap-2 text-[12.5px] text-warn">
            <AlertTriangle size={14} className="shrink-0" /> 此风扇接口被主板固件锁定，无法软件调速（仅可读取转速）。
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Segmented id={`fan-mode-${channel.id}`} value={config.mode} options={MODE_OPTIONS} onChange={setMode} />
              {config.mode === "curve" && liveTemp != null && (
                <span className="nums flex items-center gap-1.5 text-[12.5px] text-muted" title={tf("当前温度 → 曲线目标转速", "Current temperature → curve target")}>
                  <span className="live-dot text-cyan" />
                  <span className={cn(liveTemp >= 80 ? "text-danger" : liveTemp >= 65 ? "text-warn" : "text-ink")}>{Math.round(liveTemp)}°C</span>
                  <span className="text-dim">→</span>
                  <span className="text-ink">{liveDuty != null ? Math.round(liveDuty) : "—"}%</span>
                </span>
              )}
            </div>

            {config.mode === "manual" && (
              <div className="mt-4">
                <Slider label="手动转速" value={config.manualPct} min={MIN_SAFE_DUTY} max={100} unit="%" onChange={(v) => onChange({ manualPct: v })} />
              </div>
            )}

            {config.mode === "curve" && (
              <div className="mt-3 space-y-4">
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex min-w-0 items-center gap-2 text-[12.5px] text-muted">
                    <Thermometer size={14} className="shrink-0 text-dim" /> {t("温度源")}
                    <select
                      value={config.tempSourceId ?? ""}
                      onChange={(e) => onChange({ tempSourceId: e.target.value })}
                      className="field no-drag h-7 min-w-0 cursor-pointer pr-6 text-[12px]"
                    >
                      {temps.map((tp) => (
                        <option key={tp.id} value={tp.id}>
                          {tp.name}
                          {tp.c != null ? ` (${Math.round(tp.c)}°C)` : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  {config.curve2 && config.curve2.length > 0 && (
                    <Segmented
                      id={`fan-curvesel-${channel.id}`}
                      value={activeCurve}
                      options={[
                        { value: "primary", label: tf("CPU 源", "CPU source") },
                        { value: "gpu", label: tf("GPU 辅助", "GPU assist") },
                      ]}
                      onChange={(v) => setActiveCurve(v as "primary" | "gpu")}
                    />
                  )}
                </div>

                {activeCurve === "primary" || !config.curve2?.length ? (
                  <FanCurveEditor
                    points={effectiveCurve}
                    onChange={setDraftCurve}
                    onCommit={(curve) => {
                      setDraftCurve(null);
                      onChange({ curve });
                    }}
                    minDuty={config.minDuty}
                    live={liveTemp != null && liveDuty != null ? { tempC: liveTemp, duty: liveDuty } : null}
                  />
                ) : (
                  <FanCurveEditor
                    points={config.curve2 ?? []}
                    onChange={() => undefined}
                    onCommit={(curve2) => onChange({ curve2 })}
                    minDuty={config.minDuty}
                    live={
                      gpuLiveTemp != null
                        ? { tempC: gpuLiveTemp, duty: Math.max(config.minDuty, interpCurve(config.curve2 ?? [], gpuLiveTemp)) }
                        : null
                    }
                  />
                )}

                <Slider
                  label="最低转速下限（风扇不会低于此值）"
                  value={config.minDuty}
                  min={MIN_SAFE_DUTY}
                  max={100}
                  unit="%"
                  onChange={(v) => onChange({ minDuty: v })}
                />

                {/* Spin up / down time — how fast the fan ramps toward its curve
                    target. Smooth (0) eases over several ticks; Immediate (100)
                    jumps straight there (the default / classic behavior). */}
                <div className="grid gap-4 sm:grid-cols-2">
                  {(
                    [
                      ["spinUpPct", tf("加速响应", "Spin-up")],
                      ["spinDownPct", tf("减速响应", "Spin-down")],
                    ] as const
                  ).map(([key, title]) => (
                    <div key={key}>
                      <div className="mb-1 flex items-baseline justify-between text-[12.5px] text-muted">
                        <span>{title}</span>
                        <span className="nums text-[13px] text-ink">{config[key] ?? 100}</span>
                      </div>
                      <RangeInput label={title} value={config[key] ?? 100} min={0} max={100} ticks={false} onChange={(v) => onChange({ [key]: v })} />
                      <div className="flex justify-between text-[11px] text-dim">
                        <span>{tf("平缓", "Smooth")}</span>
                        <span>{tf("立即", "Immediate")}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

export function FanControl() {
  const t = useT();
  const tf = useTf();
  const pollMs = useSettings((s) => s.pollMs);
  const { configs, labels, spunFans, markSpun, applyOnStartup, setConfig, setApplyOnStartup, setLabel, profiles, activeProfileId, pendingProfileId, saveProfile, updateActiveProfile, applyProfile, applyPreset, applyCalibration, resetToDefault, deleteProfile, lastError, clearError } =
    useFanProfiles();
  const autotune = useFanAutotune();
  const [showTuneWizard, setShowTuneWizard] = useState(false);
  const [resynthBusy, setResynthBusy] = useState(false);

  // Re-solve curves from the STORED model (seconds, no re-measurement) and
  // apply — the upgrade path after synthesis-algorithm fixes.
  async function resynthNow() {
    const s = useFanAutotune.getState();
    const r = s.result;
    if (!r) return;
    setResynthBusy(true);
    try {
      const resp = await api.fanAutotuneResynth({
        params: r.params,
        model: r.model,
        modelGpu: r.modelGpu ?? null,
        calibrations: r.calibrations,
        pDesign: r.pDesign,
        pDesignGpu: r.pDesignGpu ?? null,
      });
      const next = {
        ...r,
        curves: resp.curves,
        wPoints: resp.wPoints,
        gpuWPoints: resp.gpuWPoints ?? null,
        effectiveTarget: resp.effectiveTarget,
        effectiveTargetGpu: resp.effectiveTargetGpu ?? null,
        warnings: resp.warnings,
      };
      s.setResult(next);
      s.applyTuned(next.curves, next.cpuSourceId ?? null, next.gpuSourceId ?? null);
      s.configurePassive();
    } catch {
      // apply failures surface via the fan store's lastError banner
    } finally {
      setResynthBusy(false);
    }
  }
  const [delProfile, setDelProfile] = useState<{ id: string; name: string } | null>(null);
  const [info, setInfo] = useState<FanInfo | null>(null);
  // Control ids that have shown a valid (>0) RPM at least once — PERSISTED in the
  // store (spunFans), so a real fan stays listed across relaunches even when idle,
  // while empty headers (never spun) stay hidden until they actually turn.
  const seen = new Set(spunFans);
  const [showAll, setShowAll] = useState(false);
  const [showSave, setShowSave] = useState(false);
  const [newName, setNewName] = useState("");
  // Reset-to-default confirm — the reset overwrites every fan's custom / AI-
  // calibrated curve (30 s per fan to regenerate), so it must not be one-click.
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  // AI calibration (FanXpert-style auto tuning) state.
  const [showCalibConfirm, setShowCalibConfirm] = useState(false);
  const [calibrating, setCalibrating] = useState(false);
  const [calibProgress, setCalibProgress] = useState<FanCalibProgress | null>(null);
  const [calibResults, setCalibResults] = useState<FanCalibration[] | null>(null);
  const [calibError, setCalibError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshErr, setRefreshErr] = useState(false);

  // Apply saved fan configs when the page opens (hydration-aware).
  useEffect(() => {
    const p = useFanProfiles.persist;
    const run = () => useFanProfiles.getState().push();
    if (p.hasHydrated()) {
      run();
      return;
    }
    return p.onFinishHydration(run);
  }, []);

  // Live polling.
  useEffect(() => {
    let alive = true;
    let inFlight = false;
    let lastKey = "";
    const tick = async () => {
      // Backpressure: never queue a second fanInfo while one is outstanding.
      if (inFlight) return;
      // Nobody can see the RPMs — the window is in the tray, minimized, or behind
      // a fullscreen game. `fan_info` walks every sensord control on every call
      // and a result re-renders this whole page; neither is worth doing for an
      // audience of zero. The fan ENGINE is backend-side (fan::start_engine) and
      // is untouched by this, so curves keep being driven while we are quiet.
      if (!useUiActive.getState().active) return;
      inFlight = true;
      try {
        const i = await withTimeout(api.fanInfo());
        if (!alive) return;
        // Equality skip: the fan page is a large tree and RPM readings repeat
        // verbatim whenever the fans are steady, which is most of the time.
        const key = JSON.stringify(i);
        if (key !== lastKey) {
          lastKey = key;
          setInfo(i);
        }
        // Remember any header currently spinning (PERSISTED via markSpun), so a
        // fan that idles back to 0 (BIOS fan-stop) or survives a relaunch stays
        // visible. Idempotent — only writes when a new id first spins.
        const spinning = i.channels.filter((c) => (c.rpm ?? 0) > 0).map((c) => c.id);
        if (spinning.length) markSpun(spinning);
      } catch {
        // Keep last good readings on transient failure/timeout.
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const id = setInterval(() => void tick(), Math.max(800, pollMs));
    // Re-read the moment the user looks back, so the page never greets them with
    // the RPMs from whenever they last minimized it.
    const unGate = useUiActive.subscribe((s, prev) => {
      if (s.active && !prev.active) void tick();
    });
    return () => {
      alive = false;
      clearInterval(id);
      unGate();
    };
  }, [pollMs]);

  // Hand-edit detection: configs diverging from the tuned curves pause passive
  // learning (spec §7 — never overwrite the user's manual work).
  useEffect(() => {
    const s = useFanAutotune.getState();
    if (!s.result || s.passivePaused || !s.passiveEnabled) return;
    if (curvesDiverge(configs, s.result.curves)) {
      s.setPassivePaused(true);
    }
  }, [configs]);

  // Re-arm passive learning on startup (the backend forgets across restarts).
  useEffect(() => {
    const p = useFanAutotune.persist;
    const run = () => useFanAutotune.getState().configurePassive();
    if (p.hasHydrated()) {
      run();
      return;
    }
    return p.onFinishHydration(run);
  }, []);

  const channels = info?.channels ?? [];
  // Presets apply only to software-controllable headers; curve presets need a
  // temp source, so default to a CPU temperature (else the first available one).
  const controllableIds = channels.filter((c) => c.controllable).map((c) => c.id);
  const temps = info?.temps ?? [];
  const presetTempSourceId =
    (temps.find((t) => /cpu|package|tctl|tdie|核/i.test(t.name)) ?? temps[0])?.id ?? null;
  // Show a header that's currently reporting RPM, has EVER spun (persisted in
  // spunFans — so a real fan stays listed across relaunches even while idle/stopped),
  // or has a custom label. Empty headers (controllable ports with no fan → always
  // 0 RPM) never enter spunFans, so they stay hidden (no phantom 0-RPM fans) until
  // they actually turn — or via 显示全部.
  const visibleChannels = showAll
    ? channels
    : channels.filter((c) => (c.rpm ?? 0) > 0 || seen.has(c.id) || !!labels[c.id]);
  const hiddenCount = channels.length - visibleChannels.length;

  // Run an AI calibration sweep: listen for live progress, calibrate every
  // controllable header, then auto-apply the tailored per-fan curves.
  async function runCalibration() {
    setShowCalibConfirm(false);
    setCalibResults(null);
    setCalibError(null);
    setCalibProgress(null);
    setCalibrating(true);
    // Subscribe inside try so a listener-setup failure can't leave the UI stuck
    // in the "calibrating" state; the finally always resets it.
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await listen<FanCalibProgress>("fan-calib-progress", (e) => setCalibProgress(e.payload));
      const results = await api.fanCalibrate(controllableIds);
      applyCalibration(results, presetTempSourceId);
      setCalibResults(results);
    } catch (e) {
      setCalibError(typeof e === "string" ? e : e instanceof Error ? e.message : "校准失败");
    } finally {
      unlisten?.();
      setCalibrating(false);
      setCalibProgress(null);
    }
  }

  // Manual refresh: re-read the live fan headers immediately (a header that just
  // spun up will appear without waiting for the next poll tick).
  async function refreshFans() {
    setRefreshing(true);
    setRefreshErr(false);
    try {
      setInfo(await api.fanInfo());
    } catch {
      setRefreshErr(true);
    } finally {
      setTimeout(() => setRefreshing(false), 400);
    }
  }

  const chip = (active: boolean, disabled: boolean) =>
    cn(
      "no-drag group relative flex h-8 cursor-pointer items-center gap-2 rounded-md px-3 text-[12.5px] transition-[background-color,color,box-shadow] duration-150",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
      active
        ? "bg-accent/12 font-medium text-ink shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--color-accent)_55%,transparent)]"
        : "bg-surface2 text-muted shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-surface3 hover:text-ink",
      disabled && "cursor-not-allowed opacity-45",
    );

  return (
    <>
      <TabHeader
        title="风扇控制"
        subtitle="主板风扇调速 — 手动 / 温度曲线（FanXpert 式），基于 LibreHardwareMonitor，配置自动保存"
        actions={
          <label className="flex cursor-pointer items-center gap-3">
            <span className="text-right">
              <span className="block text-[13px] font-medium text-ink">{t("启动时自动应用")}</span>
              <span className="block text-[11.5px] text-dim">{tf("开机即按配置调速", "Fans follow your setup at boot")}</span>
            </span>
            <Toggle checked={applyOnStartup} onChange={setApplyOnStartup} label={tf("启动时自动应用", "Apply on startup")} />
          </label>
        }
      />

      {info && !info.available ? (
        <div className="grid flex-1 place-items-center px-6 pb-8">
          <div className="flex max-w-sm flex-col items-center text-center">
            <Wind size={22} className="text-warn" />
            <div className="mt-3 text-[14px] font-semibold text-ink">未检测到主板风扇传感器</div>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-muted">
              风扇调速依赖主板 Super-I/O 芯片（Nuvoton / ITE / Fintek）。请确认以管理员身份运行；部分笔记本或精简主板可能不暴露风扇控制。
            </p>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 space-y-4 overflow-auto px-6 pb-6">
          {info && !info.supported && (
            <div className="flex items-start gap-2.5 rounded-lg bg-warn/10 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-warn ring-1 ring-inset ring-warn/25">
              <AlertTriangle size={15} className="mt-0.5 shrink-0" />
              <p>
                检测到风扇转速，但本主板固件未开放软件写入风扇接口（部分锁定的消费级主板如此）。可读取监控，暂不能调速 —— 这是主板固件限制，并非 CorePilot 问题。
              </p>
            </div>
          )}

          {/* Surface a failed backend apply so a profile never looks "active"
              while nothing was actually applied. Click to dismiss. */}
          <AnimatePresence>
            {lastError && (
              <motion.button
                type="button"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2, ease: easeOut }}
                onClick={clearError}
                title={tf("点击关闭", "Click to dismiss")}
                className="no-drag flex w-full items-start gap-2.5 overflow-hidden rounded-lg bg-danger/10 px-3.5 py-2.5 text-left text-[12.5px] text-danger ring-1 ring-inset ring-danger/25 transition-colors hover:bg-danger/14"
              >
                <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                <span className="min-w-0">{tf(`应用风扇配置失败:${lastError}`, `Failed to apply fan profile: ${lastError}`)}</span>
              </motion.button>
            )}
          </AnimatePresence>

          {/* Profiles — presets + saved setups, one click applies to every fan */}
          <Panel
            title="风扇配置"
            desc={tf("点击即应用到所有可调风扇", "Click to apply to every controllable fan")}
            actions={
              <>
                <Button
                  variant="primary"
                  onClick={() => setShowTuneWizard(true)}
                  disabled={calibrating || controllableIds.length === 0}
                  title={tf("实测本机散热系统,自动调出最优温度曲线(约 25–32 分钟)", "Measure this machine's cooling and auto-tune optimal curves (≈25–32 min)")}
                >
                  <Sparkles size={14} /> {tf("智能调优", "Smart Tune")}
                </Button>
                <Button
                  onClick={() => setShowCalibConfirm(true)}
                  disabled={calibrating || controllableIds.length === 0}
                  title="逐个风扇扫描转速，自动生成专属曲线（约 30 秒/风扇）"
                >
                  {calibrating && <Loader2 size={14} className="animate-spin" />} AI 智能校准
                </Button>
                <span className="mx-0.5 h-5 w-px bg-line" aria-hidden />
                <Button variant="subtle" className="w-8 px-0" onClick={updateActiveProfile} disabled={!activeProfileId} title="覆盖保存到当前所选配置" ariaLabel={tf("保存当前", "Save current")}>
                  <Save size={15} />
                </Button>
                <Button variant="subtle" className="w-8 px-0" onClick={() => { setNewName(""); setShowSave(true); }} title="保存为新的配置" ariaLabel={tf("另存为", "Save as")}>
                  <Plus size={16} />
                </Button>
                <Button
                  variant="subtle"
                  className="w-8 px-0"
                  onClick={() => setShowResetConfirm(true)}
                  disabled={calibrating || controllableIds.length === 0}
                  title="撤销 AI 校准 / 自定义，恢复内置默认曲线"
                  ariaLabel={tf("重置默认曲线", "Reset default curves")}
                >
                  <RotateCcw size={15} />
                </Button>
              </>
            }
          >
            <AnimatePresence>
              {calibrating && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.2, ease: easeOut }}
                  className="overflow-hidden"
                >
                  <div className="mb-3 rounded-lg bg-surface2 px-3 py-2.5">
                    <div className="flex items-center gap-2 text-[12.5px] text-muted">
                      <Loader2 size={14} className="animate-spin text-accent" />
                      <span>{t("正在校准")}</span>
                      <span className="font-medium text-ink">{calibProgress?.name ?? "…"}</span>
                      {calibProgress && (
                        <span className="nums text-dim">
                          {calibProgress.fanIndex + 1}/{calibProgress.fanTotal}
                        </span>
                      )}
                      <span className="nums ml-auto text-dim">
                        {calibProgress ? `${calibProgress.duty}% → ${calibProgress.rpm ?? "—"} RPM` : ""}
                      </span>
                    </div>
                    <Meter className="mt-2" value={calibProgress?.duty ?? 0} />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <div role="radiogroup" aria-label={tf("风扇配置", "Fan profiles")} className="flex flex-wrap items-center gap-1.5">
              {FAN_PRESETS.map((preset) => {
                const Icon = PRESET_ICON[preset.id as keyof typeof PRESET_ICON] ?? Layers;
                const pending = preset.id === pendingProfileId;
                const active = preset.id === activeProfileId && !pending;
                // Block overlapping fan writes while any apply is pending.
                const disabled = controllableIds.length === 0 || pendingProfileId !== null;
                return (
                  <button
                    key={preset.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    disabled={disabled}
                    onClick={() => applyPreset(preset.id, controllableIds, presetTempSourceId)}
                    title={preset.mode === "curve" ? "温度曲线预设(自动按温度调速)" : "全速 100%"}
                    className={chip(active, disabled)}
                  >
                    {pending ? <Loader2 size={13} className="animate-spin" /> : <Icon size={13} className={active ? "text-accent" : "text-dim"} />}
                    {preset.name}
                  </button>
                );
              })}
              {profiles.length > 0 && <span className="mx-1.5 h-5 w-px bg-line" aria-hidden />}
              <AnimatePresence initial={false}>
                {profiles.map((p) => {
                  const pending = p.id === pendingProfileId;
                  const active = p.id === activeProfileId && !pending;
                  const blocked = pendingProfileId !== null;
                  return (
                    <motion.div
                      key={p.id}
                      layout="position"
                      initial={{ opacity: 0, scale: 0.96 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.96 }}
                      transition={{ duration: 0.16, ease: easeOut }}
                      className="group relative"
                    >
                      <button
                        type="button"
                        role="radio"
                        aria-checked={active}
                        disabled={blocked}
                        onClick={() => applyProfile(p.id)}
                        className={cn(chip(active, blocked), "pr-8")}
                      >
                        {pending ? <Loader2 size={13} className="animate-spin" /> : active ? <Check size={13} className="text-accent" /> : <Layers size={13} className="text-dim" />}
                        {p.name}
                      </button>
                      <button
                        type="button"
                        aria-label={tf(`删除配置 ${p.name}`, `Delete profile ${p.name}`)}
                        onClick={() => setDelProfile({ id: p.id, name: p.name })}
                        className="no-drag absolute right-1 top-1/2 grid h-6 w-6 -translate-y-1/2 cursor-pointer place-items-center rounded text-dim opacity-0 transition-[opacity,color,background-color] duration-150 hover:bg-danger/12 hover:text-danger focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 group-hover:opacity-100"
                      >
                        <Trash2 size={12} />
                      </button>
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            </div>
            {profiles.length === 0 && (
              <p className="mt-2.5 text-[12px] leading-relaxed text-dim">
                把每个风扇调好后点「保存当前」存为一套方案,之后即可一键切换(如「静音」「游戏全速」)。
              </p>
            )}

            {autotune.result && (
              <div className="-mx-4 -mb-4 mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-b-xl border-t border-line bg-surface2/40 px-4 py-2.5 text-[12px] text-muted">
                <span>
                  {tf("上次智能调优", "Last smart tune")}{" "}
                  <span className="nums text-ink">{new Date(autotune.result.finishedAtMs).toLocaleString()}</span>
                </span>
                <span>
                  {tf("目标", "Target")} <span className="nums text-ink">{Math.round(autotune.result.effectiveTarget)}°C</span>
                  <span className="mx-1.5 text-dim">·</span>
                  {tf("满载实测", "validated")} <span className="nums text-ink">{Math.round(autotune.result.validation.tV * 10) / 10}°C</span>
                </span>
                <button
                  type="button"
                  onClick={() => void resynthNow()}
                  disabled={resynthBusy}
                  title={tf("从已存模型秒级重算并应用曲线(无需重新测量;算法更新后用这个)", "Re-solve curves from the stored model in seconds (no re-measurement; use after algorithm updates)")}
                  className="no-drag flex cursor-pointer items-center gap-1.5 rounded text-[12px] text-muted transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <RefreshCw size={12} className={resynthBusy ? "animate-spin" : ""} /> {tf("重算曲线", "Re-solve")}
                </button>
                <label className="ml-auto flex cursor-pointer items-center gap-2.5">
                  <span>
                    {tf("被动学习", "Passive learning")}
                    {autotune.passivePaused && <span className="ml-1.5 text-warn">{tf("已暂停 · 检测到手动修改", "Paused · hand-edit detected")}</span>}
                  </span>
                  <Toggle
                    checked={autotune.passiveEnabled && !autotune.passivePaused}
                    label={tf("被动学习", "Passive learning")}
                    onChange={(v) => {
                      if (autotune.passivePaused && v) {
                        // Re-enabling after a hand-edit re-applies the tuned curves.
                        autotune.applyTuned(autotune.result!.curves, autotune.result!.cpuSourceId ?? null, autotune.result!.gpuSourceId ?? null);
                      }
                      autotune.setPassiveEnabled(v);
                      autotune.setPassivePaused(false);
                    }}
                  />
                </label>
              </div>
            )}
          </Panel>

          <div className="flex items-center justify-between gap-3 px-1 pt-1">
            <div className="flex items-baseline gap-2">
              <span className="text-[13px] font-semibold text-ink">{t("风扇接口")}</span>
              <span className="nums text-[12px] text-dim">{visibleChannels.length}</span>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {refreshErr && (
                <span className="mr-2 flex items-center gap-1 text-[12px] text-danger">
                  <AlertTriangle size={12} /> {tf("刷新失败 · 传感器服务未就绪", "Refresh failed · sensor service not ready")}
                </span>
              )}
              {channels.length > 0 && (
                <Button variant="subtle" size="sm" onClick={() => setShowAll((v) => !v)}>
                  {showAll ? <EyeOff size={13} /> : <Eye size={13} />}
                  {showAll ? t("仅显示活动") : hiddenCount > 0 ? tf(`显示全部 (+${hiddenCount})`, `Show all (+${hiddenCount})`) : t("显示全部")}
                </Button>
              )}
              <Button variant="subtle" size="sm" onClick={() => void refreshFans()} ariaLabel={tf("刷新风扇接口", "Refresh fan headers")}>
                <RefreshCw size={13} className={refreshing ? "animate-spin" : ""} /> {t("刷新")}
              </Button>
            </div>
          </div>

          {channels.length === 0 ? (
            <div className="grid gap-3 lg:grid-cols-2" aria-busy>
              <div className="skeleton h-[120px] rounded-xl" />
              <div className="skeleton h-[120px] rounded-xl" />
            </div>
          ) : visibleChannels.length === 0 ? (
            <div className="flex flex-col items-center py-10 text-center">
              <Fan size={22} className="text-dim" />
              <p className="mt-2 text-[12.5px] text-muted">暂未检测到有效转速的风扇接口（接口接入风扇并转动后会自动显示）。</p>
            </div>
          ) : (
            <div className="grid items-start gap-3 lg:grid-cols-2">
              {visibleChannels.map((ch) => (
                <ChannelCard
                  key={ch.id}
                  channel={ch}
                  config={configs[ch.id] ?? defaultConfig()}
                  temps={info?.temps ?? []}
                  label={labels[ch.id]}
                  onChange={(patch) => setConfig(ch.id, patch)}
                  onRename={(name) => setLabel(ch.id, name)}
                />
              ))}
            </div>
          )}

          <p className="flex max-w-[110ch] items-start gap-2 text-[11.5px] leading-relaxed text-dim">
            <Info size={13} className="mt-0.5 shrink-0" />
            <span>
              曲线模式按所选温度源实时插值调速；手动模式固定转速；自动模式交还主板 BIOS 控制。CorePilot 退出时会把所有被接管的风扇恢复为 BIOS 默认，避免风扇被锁定在某一转速。
              <span className="text-warn"> 调速会影响散热，请确保温度处于安全范围。</span>
            </span>
          </p>
        </div>
      )}

      <Modal
        open={showSave}
        onClose={() => setShowSave(false)}
        title="保存风扇配置"
        footer={
          <>
            <Button onClick={() => setShowSave(false)}>取消</Button>
            <Button
              variant="primary"
              onClick={() => {
                saveProfile(newName.trim() || tf(`配置 ${profiles.length + 1}`, `Profile ${profiles.length + 1}`));
                setShowSave(false);
              }}
            >
              保存
            </Button>
          </>
        }
      >
        <input
          autoFocus
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              saveProfile(newName.trim() || tf(`配置 ${profiles.length + 1}`, `Profile ${profiles.length + 1}`));
              setShowSave(false);
            }
          }}
          placeholder="配置名称，例如「静音」「游戏全速」"
          className="field no-drag h-9 w-full text-[13px]"
        />
        <p className="mt-2 text-[12px] text-muted">将保存当前每个风扇的模式与曲线，可随时一键切换。</p>
      </Modal>

      <Modal
        open={delProfile !== null}
        onClose={() => setDelProfile(null)}
        title="删除风扇配置"
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
          确定删除配置 <span className="font-semibold text-ink">{delProfile?.name}</span> 吗？此操作不可撤销（当前风扇设置不受影响）。
        </p>
      </Modal>

      <Modal
        open={showResetConfirm}
        onClose={() => setShowResetConfirm(false)}
        title="重置默认曲线"
        footer={
          <>
            <Button onClick={() => setShowResetConfirm(false)}>取消</Button>
            <Button
              variant="danger"
              onClick={() => {
                resetToDefault(controllableIds, presetTempSourceId);
                setShowResetConfirm(false);
              }}
            >
              <RotateCcw size={13} /> 重置
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-relaxed text-muted">
          {tf(
            "将把所有可调风扇恢复为内置默认曲线，覆盖你的自定义曲线与 AI 校准结果（重新校准约 30 秒/风扇）。已保存的配置不受影响。",
            "This restores every controllable fan to the built-in default curve, overwriting your custom curves and AI calibration results (re-calibrating takes ~30 s per fan). Saved profiles are not affected.",
          )}
        </p>
      </Modal>

      <Modal
        open={showCalibConfirm}
        onClose={() => setShowCalibConfirm(false)}
        title="AI 智能校准"
        footer={
          <>
            <Button onClick={() => setShowCalibConfirm(false)}>取消</Button>
            <Button variant="primary" onClick={() => void runCalibration()}>
              <Sparkles size={13} /> 开始校准
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-relaxed text-muted">
          {tf(
            `将依次把每个可调风扇从 0 拉到 100% 扫描转速（约 ${controllableIds.length} 个风扇 × 30 秒），测出每个风扇的起转转速与最高转速，并生成平缓的专属曲线（怠速取最低稳定转速，缓慢爬升、85°C 才全速，避免日常温度下空转过响）。`,
            `Each adjustable fan is swept 0 → 100% to measure RPM (about ${controllableIds.length} fans × 30 s), finding each fan's start and max RPM, then building a GENTLE tailored curve (idle at the lowest stable speed, slow ramp, full only at 85°C so it isn't loud at everyday temps).`,
          )}
        </p>
        <p className="mt-2 text-[11.5px] text-dim">
          期间风扇会明显变速、可能有噪音，属正常现象；校准时建议不要运行重负载。完成后自动应用。
        </p>
      </Modal>

      <Modal
        open={calibResults !== null || calibError !== null}
        onClose={() => { setCalibResults(null); setCalibError(null); }}
        title={calibError ? "校准失败" : "AI 校准完成"}
        footer={
          <Button variant="primary" onClick={() => { setCalibResults(null); setCalibError(null); }}>
            完成
          </Button>
        }
      >
        {calibError ? (
          <p className="text-[13px] leading-relaxed text-danger">{calibError}</p>
        ) : (
          <>
            <p className="mb-3 text-[12.5px] leading-relaxed text-muted">
              {tf(
                "已按每个风扇的实测转速生成专属曲线并自动应用：曲线节点对应「最高转速的百分比」(实际风量)，而非原始占空比——所以中段不再因占空比虚高而过响。如某风扇仍偏高，点「重置默认曲线」即可还原。",
                "Tailored curves were generated from each fan's MEASURED RPM and applied: curve nodes now target a percentage of that fan's max RPM (real airflow) rather than raw PWM duty — so the mid-range no longer runs loud just because duty outpaces RPM. If a fan still feels high, click “Reset to default curve”.",
              )}
            </p>
            <div className="space-y-1.5">
              {(calibResults ?? []).map((c) => (
                <div key={c.controlId} className="flex items-center justify-between border-t border-line py-2 text-[12.5px] first:border-t-0">
                  <span className="font-medium text-ink">{labels[c.controlId] ?? c.name}</span>
                  {c.disconnected ? (
                    <span className="text-dim">未检测到风扇</span>
                  ) : (
                    <span className="nums text-muted">
                      {t("起转")} <span className="text-ink">{Math.round(c.minStartDuty)}%</span> · {t("最高")}{" "}
                      <span className="text-ink">{Math.round(c.maxRpm)}</span> RPM
                    </span>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </Modal>

      <AutoTuneWizard
        open={showTuneWizard}
        onClose={() => setShowTuneWizard(false)}
        channels={channels}
        labels={labels}
        temps={info?.temps ?? []}
      />
    </>
  );
}
