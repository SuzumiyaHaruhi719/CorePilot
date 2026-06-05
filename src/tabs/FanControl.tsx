import { AlertTriangle, Check, Eye, EyeOff, Fan, Gauge, Info, Layers, Pencil, Save, Thermometer, Trash2, Wind } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { FanCurveEditor } from "../components/fans/FanCurveEditor";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { Segmented } from "../components/ui/Segmented";
import { Slider } from "../components/ui/Slider";
import { TabHeader } from "../components/ui/TabHeader";
import { Toggle } from "../components/ui/Toggle";
import { cn } from "../lib/cn";
import { hoverPop } from "../lib/motion";
import { api, type FanChannel, type FanCurvePoint, type FanInfo, type FanMode, type FanTempSource } from "../lib/ipc";
import { useSettings } from "../store/settings";
import { defaultConfig, useFanProfiles, type FanConfig } from "../store/fanProfiles";

const MODE_OPTIONS: { value: FanMode; label: string }[] = [
  { value: "auto", label: "自动" },
  { value: "manual", label: "手动" },
  { value: "curve", label: "曲线" },
];

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
  const locked = !channel.controllable;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const displayName = label || channel.name;

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
    liveTemp != null ? Math.max(config.minDuty, interpCurve(config.curve, liveTemp)) : null;

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
              spinning ? "bg-cyan/20 text-cyan glow-sm" : "bg-surface3 text-dim",
            )}
            style={spinning ? ({ "--glow": "var(--color-cyan)" } as React.CSSProperties) : undefined}
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
            <div className="nums text-[15px] font-semibold leading-tight text-cyan" style={{ textShadow: rpm != null ? "0 0 10px color-mix(in oklch, var(--color-cyan) 30%, transparent)" : undefined }}>
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
                min={0}
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
                      background: `oklch(70% 0.14 ${tempHue(liveTemp)} / 0.14)`,
                      borderColor: `oklch(70% 0.14 ${tempHue(liveTemp)} / 0.35)`,
                      color: `oklch(82% 0.13 ${tempHue(liveTemp)})`,
                    }}
                  >
                    <span
                      className="h-1.5 w-1.5 animate-pulse rounded-full"
                      style={{ background: `oklch(82% 0.13 ${tempHue(liveTemp)})` }}
                    />
                    {Math.round(liveTemp)}°C → {liveDuty != null ? Math.round(liveDuty) : "—"}%
                  </span>
                )}
              </div>

              <FanCurveEditor
                points={config.curve}
                onChange={(curve) => onChange({ curve })}
                minDuty={config.minDuty}
                live={liveTemp != null && liveDuty != null ? { tempC: liveTemp, duty: liveDuty } : null}
              />

              <Slider
                label="最低转速下限（风扇不会低于此值）"
                value={config.minDuty}
                min={0}
                max={100}
                unit="%"
                onChange={(v) => onChange({ minDuty: v })}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function FanControl() {
  const pollMs = useSettings((s) => s.pollMs);
  const { configs, labels, applyOnStartup, setConfig, setApplyOnStartup, setLabel, profiles, activeProfileId, saveProfile, applyProfile, deleteProfile, lastError, clearError } =
    useFanProfiles();
  const [info, setInfo] = useState<FanInfo | null>(null);
  // Control ids that have shown a valid (>0) RPM at least once this session.
  // Headers that have never spun are hidden (no fan connected) until they do.
  const [seen, setSeen] = useState<Set<string>>(() => new Set());
  const [showAll, setShowAll] = useState(false);
  const [showSave, setShowSave] = useState(false);
  const [newName, setNewName] = useState("");

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
          // Remember any header that is currently spinning, so a fan that idles
          // back to 0 (BIOS fan-stop) stays visible instead of vanishing.
          const spinning = i.channels.filter((c) => (c.rpm ?? 0) > 0).map((c) => c.id);
          if (spinning.length) {
            setSeen((prev) => {
              let changed = false;
              const next = new Set(prev);
              for (const id of spinning) if (!next.has(id)) { next.add(id); changed = true; }
              return changed ? next : prev;
            });
          }
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
  // Auto-hide headers with no detectable RPM (never spun) — show once they do.
  const visibleChannels = showAll
    ? channels
    : channels.filter((c) => (c.rpm ?? 0) > 0 || seen.has(c.id));
  const hiddenCount = channels.length - visibleChannels.length;

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
              <Button onClick={() => { setNewName(""); setShowSave(true); }}>
                <Save size={13} /> 保存当前
              </Button>
            </div>
            {profiles.length === 0 ? (
              <p className="text-[11px] leading-relaxed text-dim">
                把每个风扇调好后点「保存当前」存为一套方案,之后即可一键切换(如「静音」「游戏全速」)。
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                <AnimatePresence>
                  {profiles.map((p) => {
                    const active = p.id === activeProfileId;
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
                        onClick={() => applyProfile(p.id)}
                        className={cn(
                          "no-drag group relative flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-left",
                          active ? "border-accent/50 bg-accent/10 glow-sm" : "border-line bg-surface2/50 hover:bg-surface3",
                        )}
                      >
                        <Layers size={13} className={active ? "text-accent-bright" : "text-dim"} />
                        <span className="text-[12.5px] font-medium text-ink">{p.name}</span>
                        {active && <Check size={12} className="text-accent-bright" />}
                        <span
                          role="button"
                          tabIndex={-1}
                          onClick={(e) => { e.stopPropagation(); deleteProfile(p.id); }}
                          className="ml-0.5 grid h-5 w-5 cursor-pointer place-items-center rounded-md text-dim opacity-0 transition hover:bg-danger hover:text-white group-hover:opacity-100"
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
                <span className="min-w-0">应用风扇配置失败:{lastError}</span>
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
              {hiddenCount > 0 && (
                <button
                  type="button"
                  onClick={() => setShowAll((v) => !v)}
                  className="no-drag flex cursor-pointer items-center gap-1.5 text-[11px] text-dim transition-colors hover:text-muted"
                >
                  {showAll ? <EyeOff size={12} /> : <Eye size={12} />}
                  {showAll ? "隐藏未接入" : `显示全部 (+${hiddenCount})`}
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
              <Fan size={14} className="animate-spin-slow text-cyan" /> 正在读取风扇接口…
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
                saveProfile(newName.trim() || `配置 ${profiles.length + 1}`);
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
              saveProfile(newName.trim() || `配置 ${profiles.length + 1}`);
              setShowSave(false);
            }
          }}
          placeholder="配置名称，例如「静音」「游戏全速」"
          className="no-drag w-full rounded-lg border border-line bg-surface2 px-3 py-2 text-[13px] text-ink outline-none transition-colors focus:border-accent/50"
        />
        <p className="mt-2 text-[11.5px] text-dim">将保存当前每个风扇的模式与曲线，可随时一键切换。</p>
      </Modal>
    </>
  );
}
