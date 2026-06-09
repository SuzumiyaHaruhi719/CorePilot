import { AlertTriangle, Check, Eye, EyeOff, Fan, Gauge, Info, Layers, Loader2, Moon, Pencil, RefreshCw, RotateCcw, Save, Sparkles, Thermometer, Trash2, Wind } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { FanCurveEditor } from "../components/fans/FanCurveEditor";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { Segmented } from "../components/ui/Segmented";
import { Slider } from "../components/ui/Slider";
import { TabHeader } from "../components/ui/TabHeader";
import { Toggle } from "../components/ui/Toggle";
import { cn } from "../lib/cn";
import { hueColor, isLightTheme } from "../lib/colors";
import { useT, useTf } from "../lib/i18n";
import { hoverPop } from "../lib/motion";
import { api, type FanCalibProgress, type FanCalibration, type FanChannel, type FanCurvePoint, type FanInfo, type FanMode, type FanTempSource } from "../lib/ipc";
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

function tempHue(t: number): number {
  if (t >= 80) return 22;
  if (t >= 65) return 55;
  return 200;
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

  return (
    <div
      className={cn(
        "hud-frame glass hairline relative overflow-hidden rounded-2xl p-4 transition-colors duration-200",
        locked && "opacity-60",
      )}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span
            className={cn(
              "grid h-9 w-9 place-items-center rounded-lg transition-colors duration-200",
              spinning ? "bg-accent/20 text-accent glow-sm" : "bg-surface3 text-dim",
            )}
            style={spinning ? ({ "--glow": "var(--color-accent)" } as React.CSSProperties) : undefined}
          >
            <Fan size={17} className={spinning ? "animate-spin-slow" : ""} />
          </span>
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
                className="no-drag w-32 rounded-md border border-accent/50 bg-surface2 px-1.5 py-0.5 text-[13px] font-semibold text-ink outline-none glow-sm"
              />
            ) : (
              <button
                type="button"
                onClick={startEdit}
                title="点击重命名"
                className="no-drag group flex cursor-pointer items-center gap-1.5 text-left"
              >
                <span className="text-[13.5px] font-semibold text-ink underline decoration-dotted decoration-dim/40 underline-offset-4 transition-colors group-hover:decoration-accent">{displayName}</span>
                <Pencil size={12} className="text-dim/70 transition-colors group-hover:text-accent" />
              </button>
            )}
            <div className="text-[10.5px] text-dim">
              {channel.hw}
              {label ? ` · ${channel.name}` : ""}
            </div>
          </div>
        </div>
        <div className="flex items-stretch gap-2">
          <div className="rounded-lg border border-line bg-surface2/50 px-2.5 py-1 text-right">
            <div className="hud-label text-[8.5px] text-dim">转速</div>
            <div className="nums text-[15px] font-semibold leading-tight text-accent" style={{ textShadow: rpm != null && !isLightTheme() ? "0 0 10px color-mix(in oklch, var(--color-accent) 30%, transparent)" : undefined }}>
              {rpm ?? "—"}
              <span className="ml-0.5 text-[9.5px] font-normal text-dim">RPM</span>
            </div>
          </div>
          <div className="rounded-lg border border-line bg-surface2/50 px-2.5 py-1 text-right">
            <div className="hud-label text-[8.5px] text-dim">占空比</div>
            <div className="nums text-[15px] font-semibold leading-tight text-ink">
              {pct ?? "—"}
              <span className="ml-0.5 text-[9.5px] font-normal text-dim">%</span>
            </div>
          </div>
        </div>
      </div>

      {locked ? (
        <div className="flex items-center gap-2 rounded-lg border border-warn/25 bg-warn/10 px-3 py-2 text-[11.5px] text-warn">
          <AlertTriangle size={13} className="shrink-0" /> 此风扇接口被主板固件锁定，无法软件调速（仅可读取转速）。
        </div>
      ) : (
        <>
          <Segmented id={`fan-mode-${channel.id}`} value={config.mode} options={MODE_OPTIONS} onChange={setMode} />

          {config.mode === "manual" && (
            <div className="mt-3">
              <Slider
                label="手动转速"
                value={config.manualPct}
                min={MIN_SAFE_DUTY}
                max={100}
                unit="%"
                onChange={(v) => onChange({ manualPct: v })}
              />
            </div>
          )}

          {config.mode === "curve" && (
            <div className="mt-3 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-[11.5px] text-muted">
                  <Thermometer size={13} className="text-warn" /> 温度源
                  <select
                    value={config.tempSourceId ?? ""}
                    onChange={(e) => onChange({ tempSourceId: e.target.value })}
                    className="no-drag cursor-pointer rounded-lg border border-line bg-surface2 px-2 py-1 text-[12px] text-ink outline-none transition-colors hover:border-line-strong focus:border-accent/50"
                  >
                    {temps.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                        {t.c != null ? ` (${Math.round(t.c)}°C)` : ""}
                      </option>
                    ))}
                  </select>
                </label>
                {liveTemp != null && (
                  <span
                    className="nums inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11.5px] font-medium"
                    style={{
                      background: `color-mix(in oklch, ${hueColor(tempHue(liveTemp), 82, 0.13)} 14%, transparent)`,
                      borderColor: `color-mix(in oklch, ${hueColor(tempHue(liveTemp), 82, 0.13)} 35%, transparent)`,
                      color: hueColor(tempHue(liveTemp), 82, 0.13),
                    }}
                  >
                    <span
                      className="h-1.5 w-1.5 animate-pulse rounded-full"
                      style={{ background: hueColor(tempHue(liveTemp), 82, 0.13) }}
                    />
                    {Math.round(liveTemp)}°C → {liveDuty != null ? Math.round(liveDuty) : "—"}%
                  </span>
                )}
              </div>

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
              <div>
                <Slider
                  label={tf("风扇加速时间", "Fan Spin Up Time")}
                  value={config.spinUpPct ?? 100}
                  min={0}
                  max={100}
                  onChange={(v) => onChange({ spinUpPct: v })}
                />
                <div className="mt-0.5 flex justify-between text-[10.5px] text-dim">
                  <span>{tf("平缓", "Smooth")}</span>
                  <span>{tf("立即", "Immediate")}</span>
                </div>
              </div>

              <div>
                <Slider
                  label={tf("风扇减速时间", "Fan Spin Down Time")}
                  value={config.spinDownPct ?? 100}
                  min={0}
                  max={100}
                  onChange={(v) => onChange({ spinDownPct: v })}
                />
                <div className="mt-0.5 flex justify-between text-[10.5px] text-dim">
                  <span>{tf("平缓", "Smooth")}</span>
                  <span>{tf("立即", "Immediate")}</span>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function FanControl() {
  const t = useT();
  const tf = useTf();
  const pollMs = useSettings((s) => s.pollMs);
  const { configs, labels, spunFans, markSpun, applyOnStartup, setConfig, setApplyOnStartup, setLabel, profiles, activeProfileId, pendingProfileId, saveProfile, updateActiveProfile, applyProfile, applyPreset, applyCalibration, resetToDefault, deleteProfile, lastError, clearError } =
    useFanProfiles();
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
    const tick = () =>
      api
        .fanInfo()
        .then((i) => {
          if (!alive) return;
          setInfo(i);
          // Remember any header currently spinning (PERSISTED via markSpun), so a
          // fan that idles back to 0 (BIOS fan-stop) or survives a relaunch stays
          // visible. Idempotent — only writes when a new id first spins.
          const spinning = i.channels.filter((c) => (c.rpm ?? 0) > 0).map((c) => c.id);
          if (spinning.length) markSpun(spinning);
        })
        .catch(() => undefined);
    void tick();
    const id = setInterval(tick, Math.max(800, pollMs));
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [pollMs]);

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

  return (
    <>
      <TabHeader
        icon={Fan}
        title="风扇控制"
        subtitle="主板风扇调速 — 手动 / 温度曲线（FanXpert 式），基于 LibreHardwareMonitor，配置自动保存"
      />

      {info && !info.available ? (
        <div className="grid flex-1 place-items-center px-6 pb-8">
          <div className="glass hairline flex max-w-md flex-col items-center gap-3 rounded-2xl p-8 text-center">
            <span className="grid h-12 w-12 place-items-center rounded-xl bg-warn/15 text-warn">
              <Wind size={22} />
            </span>
            <div className="text-[14px] font-semibold text-ink">未检测到主板风扇传感器</div>
            <p className="text-[12px] leading-relaxed text-dim">
              风扇调速依赖主板 Super-I/O 芯片（Nuvoton / ITE / Fintek）。请确认以管理员身份运行；部分笔记本或精简主板可能不暴露风扇控制。
            </p>
          </div>
        </div>
      ) : (
        <div className="min-h-0 flex-1 space-y-4 overflow-auto px-6 pb-6">
          {info && !info.supported && (
            <div className="flex items-start gap-2 rounded-xl border border-warn/30 bg-warn/10 px-3.5 py-2.5 text-[11.5px] leading-relaxed text-warn">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <p>
                检测到风扇转速，但本主板固件未开放软件写入风扇接口（部分锁定的消费级主板如此）。可读取监控，暂不能调速 —— 这是主板固件限制，并非 CorePilot 问题。
              </p>
            </div>
          )}

          {/* Fan profiles — one-click switch */}
          <div className="glass hairline rounded-2xl p-3.5">
            <div className="mb-2.5 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Layers size={13} className="text-accent" />
                <span className="hud-label text-[10px] text-dim">风扇配置</span>
                {profiles.length > 0 && <span className="nums text-[10px] text-dim">· {profiles.length}</span>}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  onClick={() => setShowCalibConfirm(true)}
                  disabled={calibrating || controllableIds.length === 0}
                  title="逐个风扇扫描转速，自动生成专属曲线（约 30 秒/风扇）"
                >
                  {calibrating ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />} AI 智能校准
                </Button>
                <Button
                  onClick={() => setShowResetConfirm(true)}
                  disabled={calibrating || controllableIds.length === 0}
                  title="撤销 AI 校准 / 自定义，恢复内置默认曲线"
                >
                  <RotateCcw size={13} /> 重置默认曲线
                </Button>
                <Button onClick={updateActiveProfile} disabled={!activeProfileId} title="覆盖保存到当前所选配置">
                  <Save size={13} /> 保存当前
                </Button>
                <Button onClick={() => { setNewName(""); setShowSave(true); }} title="保存为新的配置">
                  <Layers size={13} /> 另存为
                </Button>
              </div>
            </div>

            {calibrating && (
              <div className="mb-3 rounded-lg border border-accent/30 bg-accent/[0.06] px-3 py-2">
                <div className="flex items-center gap-2 text-[11.5px] text-muted">
                  <Loader2 size={13} className="animate-spin text-accent-bright" />
                  <span>正在校准</span>
                  <span className="font-medium text-ink">{calibProgress?.name ?? "…"}</span>
                  {calibProgress && (
                    <span className="text-dim">
                      ({calibProgress.fanIndex + 1}/{calibProgress.fanTotal})
                    </span>
                  )}
                  <span className="nums ml-auto text-dim">
                    {calibProgress ? `${calibProgress.duty}% → ${calibProgress.rpm ?? "—"} RPM` : ""}
                  </span>
                </div>
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface3">
                  <div
                    className="h-full rounded-full bg-accent transition-[width] duration-300"
                    style={{ width: `${calibProgress?.duty ?? 0}%` }}
                  />
                </div>
              </div>
            )}

            {/* Built-in quick presets (Quiet/Turbo curves + Full Blast). */}
            <div className="mb-3">
              <div className="hud-label mb-1.5 text-[9.5px] text-dim">快速预设 · PRESETS</div>
              <div className="flex flex-wrap gap-2">
                {FAN_PRESETS.map((preset) => {
                  const Icon = PRESET_ICON[preset.id as keyof typeof PRESET_ICON] ?? Layers;
                  const pending = preset.id === pendingProfileId;
                  const active = preset.id === activeProfileId && !pending;
                  // Block overlapping fan writes: disable every preset (including
                  // the pending one — it shows a spinner) while any apply is pending.
                  const disabled = controllableIds.length === 0 || pendingProfileId !== null;
                  return (
                    <motion.button
                      key={preset.id}
                      whileHover={disabled ? undefined : { scale: 1.03, y: -2 }}
                      whileTap={disabled ? undefined : { scale: 0.97 }}
                      transition={hoverPop}
                      disabled={disabled}
                      onClick={() => applyPreset(preset.id, controllableIds, presetTempSourceId)}
                      aria-pressed={active}
                      title={preset.mode === "curve" ? "温度曲线预设(自动按温度调速)" : "全速 100%"}
                      className={cn(
                        "no-drag flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
                        active
                          ? "border-accent/50 bg-accent/12 text-accent-bright glow-sm"
                          : "border-line bg-surface2/50 text-muted hover:bg-surface3 hover:text-ink",
                        disabled && "cursor-not-allowed opacity-40",
                      )}
                    >
                      {pending ? <Loader2 size={12} className="animate-spin" /> : <Icon size={12} />}
                      {preset.name}
                    </motion.button>
                  );
                })}
              </div>
            </div>

            {profiles.length === 0 ? (
              <p className="text-[11px] leading-relaxed text-dim">
                把每个风扇调好后点「保存当前」存为一套方案,之后即可一键切换(如「静音」「游戏全速」)。
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                <AnimatePresence>
                  {profiles.map((p) => {
                    const pending = p.id === pendingProfileId;
                    const active = p.id === activeProfileId && !pending;
                    // Disable all profiles (including the pending one, which shows
                    // its spinner) while an apply is in flight — no overlapping writes.
                    const blocked = pendingProfileId !== null;
                    return (
                      <motion.button
                        key={p.id}
                        layout
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.85 }}
                        whileHover={blocked ? undefined : { scale: 1.03, y: -2 }}
                        whileTap={blocked ? undefined : { scale: 0.97 }}
                        transition={hoverPop}
                        disabled={blocked}
                        onClick={() => applyProfile(p.id)}
                        aria-pressed={active}
                        className={cn(
                          "no-drag group relative flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
                          active ? "border-accent/50 bg-accent/10 glow-sm" : "border-line bg-surface2/50 hover:bg-surface3",
                          blocked && "cursor-not-allowed opacity-50",
                        )}
                      >
                        {pending ? (
                          <Loader2 size={13} className="animate-spin text-accent-bright" />
                        ) : (
                          <Layers size={13} className={active ? "text-accent-bright" : "text-dim"} />
                        )}
                        <span className="text-[12.5px] font-medium text-ink">{p.name}</span>
                        {active && <Check size={12} className="text-accent-bright" />}
                        <span
                          role="button"
                          tabIndex={0}
                          aria-label={tf(`删除配置 ${p.name}`, `Delete profile ${p.name}`)}
                          onClick={(e) => { e.stopPropagation(); setDelProfile({ id: p.id, name: p.name }); }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              e.stopPropagation();
                              setDelProfile({ id: p.id, name: p.name });
                            }
                          }}
                          className="ml-0.5 grid h-5 w-5 cursor-pointer place-items-center rounded-md text-dim opacity-0 transition hover:bg-danger hover:text-white focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 group-focus-within:opacity-100 group-hover:opacity-100"
                        >
                          <Trash2 size={11} />
                        </span>
                      </motion.button>
                    );
                  })}
                </AnimatePresence>
              </div>
            )}
          </div>

          {/* Surface a failed backend apply so a profile never looks "active"
              while nothing was actually applied. Click to dismiss. */}
          <AnimatePresence>
            {lastError && (
              <motion.button
                type="button"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                onClick={clearError}
                title="点击关闭"
                className="no-drag flex w-full items-start gap-2 overflow-hidden rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-left text-[11.5px] text-danger transition-colors hover:bg-danger/15"
              >
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span className="min-w-0">{tf(`应用风扇配置失败:${lastError}`, `Failed to apply fan profile: ${lastError}`)}</span>
              </motion.button>
            )}
          </AnimatePresence>

          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Gauge size={13} className="text-accent" />
              <span className="hud-label text-[10px] text-dim">风扇接口</span>
              <span className="nums text-[10px] text-dim">· {visibleChannels.length}</span>
              <span className="h-px flex-1 bg-line" />
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <button
                type="button"
                onClick={() => void refreshFans()}
                title="刷新风扇接口"
                aria-label="刷新风扇接口"
                className="no-drag flex cursor-pointer items-center gap-1.5 text-[11px] text-dim transition-colors hover:text-muted"
              >
                <RefreshCw size={12} className={refreshing ? "animate-spin" : ""} /> 刷新
              </button>
              {refreshErr && (
                <span className="flex items-center gap-1 text-[10.5px] text-danger">
                  <AlertTriangle size={11} /> {tf("刷新失败 · 传感器服务未就绪", "Refresh failed · sensor service not ready")}
                </span>
              )}
              {channels.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowAll((v) => !v)}
                  className="no-drag flex cursor-pointer items-center gap-1.5 text-[11px] text-dim transition-colors hover:text-muted"
                >
                  {showAll ? <EyeOff size={12} /> : <Eye size={12} />}
                  {showAll ? "仅显示活动" : hiddenCount > 0 ? tf(`显示全部 (+${hiddenCount})`, `Show all (+${hiddenCount})`) : "显示全部"}
                </button>
              )}
              <label className="flex shrink-0 cursor-pointer items-center gap-2 text-[11.5px] text-muted">
                启动时自动应用
                <Toggle checked={applyOnStartup} onChange={setApplyOnStartup} />
              </label>
            </div>
          </div>

          {channels.length === 0 ? (
            <div className="flex items-center gap-2.5 rounded-xl border border-dashed border-line bg-surface2/30 px-3.5 py-3 text-[11.5px] text-dim">
              <Fan size={14} className="animate-spin-slow text-accent" /> 正在读取风扇接口…
            </div>
          ) : visibleChannels.length === 0 ? (
            <div className="flex items-center gap-2.5 rounded-xl border border-dashed border-line bg-surface2/30 px-3.5 py-3 text-[11.5px] text-dim">
              <Fan size={14} className="text-dim" /> 暂未检测到有效转速的风扇接口（接口接入风扇并转动后会自动显示）。
            </div>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
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

          <div className="flex items-start gap-2 text-[11px] leading-relaxed text-dim">
            <Info size={13} className="mt-0.5 shrink-0 text-accent/70" />
            <p>
              曲线模式按所选温度源实时插值调速；手动模式固定转速；自动模式交还主板 BIOS 控制。CorePilot 退出时会把所有被接管的风扇恢复为 BIOS 默认，避免风扇被锁定在某一转速。
              <span className="text-warn/90"> 调速会影响散热，请确保温度处于安全范围。</span>
            </p>
          </div>
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
          className="no-drag w-full rounded-lg border border-line bg-surface2 px-3 py-2 text-[13px] text-ink outline-none transition-colors focus:border-accent/50"
        />
        <p className="mt-2 text-[11.5px] text-dim">将保存当前每个风扇的模式与曲线，可随时一键切换。</p>
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
                <div
                  key={c.controlId}
                  className="flex items-center justify-between rounded-lg border border-line bg-surface2/50 px-3 py-2 text-[12px]"
                >
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
    </>
  );
}
