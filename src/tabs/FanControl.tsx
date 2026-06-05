import { AlertTriangle, Fan, Gauge, Info, Pencil, Thermometer, Wind } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { FanCurveEditor } from "../components/fans/FanCurveEditor";
import { Segmented } from "../components/ui/Segmented";
import { Slider } from "../components/ui/Slider";
import { TabHeader } from "../components/ui/TabHeader";
import { Toggle } from "../components/ui/Toggle";
import { cn } from "../lib/cn";
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

  return (
    <div className={cn("rounded-2xl border border-line bg-surface2/40 p-4", locked && "opacity-60")}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-cyan/15 text-cyan">
            <Fan size={17} className={config.mode !== "auto" ? "animate-spin-slow" : ""} />
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
                className="no-drag w-32 rounded-md border border-accent/50 bg-surface2 px-1.5 py-0.5 text-[13px] font-semibold text-ink outline-none"
              />
            ) : (
              <button
                type="button"
                onClick={startEdit}
                title="点击重命名"
                className="no-drag group flex items-center gap-1.5 text-left"
              >
                <span className="text-[13.5px] font-semibold text-ink underline decoration-dotted decoration-dim/40 underline-offset-4">{displayName}</span>
                <Pencil size={12} className="text-dim/70 transition-colors group-hover:text-accent" />
              </button>
            )}
            <div className="text-[10.5px] text-dim">
              {channel.hw}
              {label ? ` · ${channel.name}` : ""}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right">
            <div className="text-[9.5px] uppercase tracking-wide text-dim">转速</div>
            <div className="nums text-[14px] font-semibold text-ink">
              {channel.rpm != null ? Math.round(channel.rpm) : "—"}
              <span className="ml-0.5 text-[10px] font-normal text-dim">RPM</span>
            </div>
          </div>
          <div className="text-right">
            <div className="text-[9.5px] uppercase tracking-wide text-dim">占空比</div>
            <div className="nums text-[14px] font-semibold text-ink">
              {channel.pct != null ? Math.round(channel.pct) : "—"}
              <span className="ml-0.5 text-[10px] font-normal text-dim">%</span>
            </div>
          </div>
        </div>
      </div>

      {locked ? (
        <div className="flex items-center gap-2 rounded-lg bg-warn/10 px-3 py-2 text-[11.5px] text-warn">
          <AlertTriangle size={13} /> 此风扇接口被主板固件锁定，无法软件调速（仅可读取转速）。
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
                    className="no-drag rounded-lg border border-line bg-surface2 px-2 py-1 text-[12px] text-ink outline-none focus:border-accent/50"
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
                    className="nums rounded-md px-2 py-0.5 text-[11.5px] font-medium"
                    style={{
                      background: `oklch(70% 0.14 ${tempHue(liveTemp)} / 0.16)`,
                      color: `oklch(82% 0.13 ${tempHue(liveTemp)})`,
                    }}
                  >
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
  const { configs, labels, applyOnStartup, setConfig, setApplyOnStartup, setLabel } = useFanProfiles();
  const [info, setInfo] = useState<FanInfo | null>(null);

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

  const channels = info?.channels ?? [];

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

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-[12.5px] font-semibold text-muted">
              <Gauge size={15} className="text-accent" /> 风扇接口
              <span className="text-[11px] font-normal text-dim">· {channels.length} 个</span>
            </div>
            <label className="flex items-center gap-2 text-[11.5px] text-muted">
              启动时自动应用
              <Toggle checked={applyOnStartup} onChange={setApplyOnStartup} />
            </label>
          </div>

          {channels.length === 0 ? (
            <p className="text-[11.5px] leading-relaxed text-dim">正在读取风扇接口…</p>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {channels.map((ch) => (
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
    </>
  );
}
