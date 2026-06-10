import { AlertTriangle, Check, Loader2, OctagonX, Sparkles, Thermometer } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { classifyFan, clampTuneParams } from "../../lib/autotuneUtils";
import { useTf } from "../../lib/i18n";
import {
  api,
  type AutoTuneParams,
  type AutoTuneProgress,
  type AutoTuneResult,
  type FanCalibProgress,
  type FanChannel,
  type FanGroup,
  type FanTempSource,
  type Sensors,
  type TuneWarning,
} from "../../lib/ipc";
import { useFanAutotune } from "../../store/fanAutotune";
import { useFanProfiles } from "../../store/fanProfiles";
import { useSettings } from "../../store/settings";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { Segmented } from "../ui/Segmented";
import { Slider } from "../ui/Slider";

type Step = "params" | "running" | "result";
type Assignment = FanGroup | "excluded";

const PHASE_ZH: Record<string, string> = {
  precheck: "环境检查",
  fanCalib: "风扇校准",
  baseline: "怠速基线",
  gridSweep: "满载网格扫描",
  gpuSweep: "GPU 负载扫描",
  fit: "模型拟合",
  synthesize: "曲线合成",
  validate: "满载验证",
  combinedValidate: "双满载验证",
  done: "完成",
};
const PHASE_ORDER = ["precheck", "fanCalib", "baseline", "gridSweep", "gpuSweep", "fit", "synthesize", "validate", "combinedValidate", "done"];

interface AutoTuneWizardProps {
  open: boolean;
  onClose: () => void;
  channels: FanChannel[];
  labels: Record<string, string>;
  temps: FanTempSource[];
}

export function AutoTuneWizard({ open, onClose, channels, labels, temps }: AutoTuneWizardProps) {
  const tf = useTf();
  const store = useFanAutotune();
  const [step, setStep] = useState<Step>("params");
  const [assign, setAssign] = useState<Record<string, Assignment>>({});
  const [draft, setDraft] = useState<AutoTuneParams>(store.params);
  const [progress, setProgress] = useState<AutoTuneProgress | null>(null);
  // Live sensors polled at 1 Hz while running — the tune only emits progress
  // at step boundaries (settles can be 35-120 s apart), which read as frozen.
  const [live, setLive] = useState<Sensors | null>(null);
  const [calib, setCalib] = useState<FanCalibProgress | null>(null);
  const [tempHistory, setTempHistory] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AutoTuneResult | null>(null);
  const [resynthBusy, setResynthBusy] = useState(false);
  const runningRef = useRef(false);

  // Spec §3 阶段 0: the GPU's OWN fans never appear in the grouping list —
  // they belong to the GPU driver. Curve-driving them can undercool the card
  // (field incident: GPU fans tuned into the case group sat at the quiet
  // floor during gaming).
  const controllable = channels.filter(
    (c) => c.controllable && !/nvidia|geforce|radeon|\bgpu\b/i.test(c.hw) && !c.id.startsWith("/gpu"),
  );
  const gpuPresent = temps.some((t) => /gpu/i.test(t.name));

  // Seed group assignments whenever the wizard opens.
  useEffect(() => {
    if (!open) return;
    setStep("params");
    setError(null);
    setResult(null);
    setDraft(store.params);
    const seeded: Record<string, Assignment> = {};
    for (const c of controllable) {
      const prior = store.params.groups[c.id];
      seeded[c.id] = prior ?? classifyFan(labels[c.id] ?? c.name);
    }
    setAssign(seeded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const cpuCount = Object.values(assign).filter((a) => a === "cpu").length;
  const startBlocked = cpuCount === 0 || controllable.length === 0;

  // 1 Hz live readouts + per-step calibration detail while the tune runs.
  // The sidecar samples at 1 Hz, so polling faster buys nothing.
  useEffect(() => {
    if (step !== "running") return;
    let alive = true;
    const tick = () =>
      api
        .getSensors()
        .then((s) => {
          if (!alive) return;
          setLive(s);
          if (s.cpuTemp != null) {
            setTempHistory((h) => [...h.slice(-299), s.cpuTemp as number]);
          }
        })
        .catch(() => undefined);
    void tick();
    const id = setInterval(tick, 1000);
    let unlistenCalib: (() => void) | undefined;
    void listen<FanCalibProgress>("fan-calib-progress", (e) => {
      if (alive) setCalib(e.payload);
    }).then((u) => {
      unlistenCalib = u;
    });
    return () => {
      alive = false;
      clearInterval(id);
      unlistenCalib?.();
    };
  }, [step]);

  // Calibration detail is only meaningful inside the fanCalib phase.
  useEffect(() => {
    if (progress && progress.phase !== "fanCalib") setCalib(null);
  }, [progress]);

  async function start() {
    const groups: Record<string, FanGroup> = {};
    for (const [id, a] of Object.entries(assign)) {
      if (a === "cpu" || a === "case") groups[id] = a;
    }
    // Settings toggle: a busy system tunes anyway (precheck downgrades its
    // abort to an accuracy warning in the result).
    const allowBackgroundLoad = useSettings.getState().tuneAllowBusy;
    const params = clampTuneParams({ ...draft, groups, allowBackgroundLoad });
    store.setParams(params);
    setStep("running");
    setProgress(null);
    setTempHistory([]);
    setError(null);
    runningRef.current = true;
    let unlisten: (() => void) | undefined;
    try {
      // Readouts + temp history come from the 1 Hz poll; this event only
      // drives the phase/step labels.
      unlisten = await listen<AutoTuneProgress>("fan-autotune-progress", (e) => {
        setProgress(e.payload);
      });
      const r = await api.fanAutotuneStart(params);
      store.setResult(r);
      store.applyTuned(r.curves, r.cpuSourceId ?? null, r.gpuSourceId ?? null);
      store.configurePassive();
      // Spec §6: snapshot the tuned configs as a named profile so the user can
      // one-click switch between the tuned curves and the built-in presets.
      const d = new Date(r.finishedAtMs);
      const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      useFanProfiles.getState().saveProfile(tf(`智能调优 ${stamp}`, `Smart Tune ${stamp}`));
      setResult(r);
      setStep("result");
    } catch (e) {
      setError(typeof e === "string" ? e : e instanceof Error ? e.message : tf("调优失败", "Tuning failed"));
    } finally {
      unlisten?.();
      runningRef.current = false;
    }
  }

  /** One-click feasibility actions on the result page (spec §5.2). */
  async function resynthWith(patch: Partial<AutoTuneParams>) {
    if (!result) return;
    setResynthBusy(true);
    try {
      const params = clampTuneParams({ ...result.params, ...patch });
      const resp = await api.fanAutotuneResynth({
        params,
        model: result.model,
        modelGpu: result.modelGpu ?? null,
        calibrations: result.calibrations,
        pDesign: result.pDesign,
        pDesignGpu: result.pDesignGpu ?? null,
      });
      const next: AutoTuneResult = {
        ...result,
        params,
        curves: resp.curves,
        wPoints: resp.wPoints,
        gpuWPoints: resp.gpuWPoints ?? null,
        effectiveTarget: resp.effectiveTarget,
        effectiveTargetGpu: resp.effectiveTargetGpu ?? null,
        warnings: resp.warnings,
      };
      store.setParams(params);
      store.setResult(next);
      store.applyTuned(next.curves, next.cpuSourceId ?? null, next.gpuSourceId ?? null);
      store.configurePassive();
      setResult(next);
    } catch {
      // resynth is best-effort UI sugar; the applied tune stays valid
    } finally {
      setResynthBusy(false);
    }
  }

  function requestClose() {
    if (runningRef.current) return; // running step has its own abort button
    onClose();
  }

  const phaseIdx = progress ? Math.max(0, PHASE_ORDER.indexOf(progress.phase)) : 0;

  return (
    <Modal
      open={open}
      onClose={requestClose}
      title={tf("智能调优", "Smart Tune")}
      footer={
        step === "params" ? (
          <>
            <Button onClick={onClose}>{tf("取消", "Cancel")}</Button>
            <Button variant="primary" disabled={startBlocked} onClick={() => void start()}>
              <Sparkles size={13} /> {tf("开始调优(约 25–32 分钟)", "Start (≈25–32 min)")}
            </Button>
          </>
        ) : step === "running" ? (
          <Button
            variant="danger"
            onClick={() => {
              void api.fanAutotuneAbort();
            }}
          >
            <OctagonX size={13} /> {tf("中止", "Abort")}
          </Button>
        ) : (
          <Button variant="primary" onClick={onClose}>
            {tf("完成", "Done")}
          </Button>
        )
      }
    >
      {step === "params" && (
        <div className="space-y-4">
          <Slider
            label={tf("目标最高 CPU 温度(满载钉住此温度)", "Target max CPU temp (pinned at full load)")}
            value={draft.targetTempC}
            min={60}
            max={88}
            unit="°C"
            onChange={(v) => setDraft({ ...draft, targetTempC: v })}
          />
          <Slider
            label={
              gpuPresent
                ? tf("GPU 辅助排热目标温度(机箱风扇)", "GPU assist target temp (case fans)")
                : tf("GPU 目标(未检测到 GPU 温度,GPU 轴将跳过)", "GPU target (no GPU temp detected — axis will be skipped)")
            }
            value={draft.targetGpuTempC}
            min={60}
            max={87}
            unit="°C"
            onChange={(v) => setDraft({ ...draft, targetGpuTempC: v })}
          />
          <Slider
            label={tf("安静底线(低温时的理想转速,占各扇最大转速)", "Quiet floor (idle speed, % of each fan's max RPM)")}
            value={draft.quietFloorPct}
            min={0}
            max={60}
            unit="%"
            onChange={(v) => setDraft({ ...draft, quietFloorPct: v })}
          />
          <Slider
            label={tf("噪音上限(紧急高温除外)", "Noise ceiling (emergency heat exempt)")}
            value={draft.noiseCeilPct}
            min={Math.max(40, draft.quietFloorPct + 15)}
            max={100}
            unit="%"
            onChange={(v) => setDraft({ ...draft, noiseCeilPct: v })}
          />

          <div>
            <div className="hud-label mb-1.5 text-[9.5px] text-dim">{tf("风扇分组", "FAN GROUPS")}</div>
            <div className="space-y-1.5">
              {controllable.map((c) => (
                <div key={c.id} className="flex items-center justify-between gap-2 rounded-lg border border-line bg-surface2/50 px-2.5 py-1.5">
                  <span className="min-w-0 truncate text-[12px] text-ink">{labels[c.id] ?? c.name}</span>
                  <Segmented
                    id={`tune-group-${c.id}`}
                    value={assign[c.id] ?? "case"}
                    options={[
                      { value: "cpu", label: tf("CPU 组", "CPU") },
                      { value: "case", label: tf("机箱组", "Case") },
                      { value: "excluded", label: tf("不参与", "Skip") },
                    ]}
                    onChange={(v) => setAssign({ ...assign, [c.id]: v as Assignment })}
                  />
                </div>
              ))}
            </div>
            {Object.entries(assign).some(([id, a]) => a === "excluded" && /pump|水泵/i.test(labels[id] ?? controllable.find((c) => c.id === id)?.name ?? "")) && (
              <p className="mt-1.5 text-[10.5px] text-dim">
                {tf("检测到水泵接口已自动排除:水泵必须恒速,不能跟随温度曲线。", "Pump headers are auto-excluded: a pump must run at constant speed, never on a temp curve.")}
              </p>
            )}
            {cpuCount === 0 && (
              <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-warn">
                <AlertTriangle size={12} /> {tf("CPU 组至少需要 1 个风扇", "The CPU group needs at least one fan")}
              </p>
            )}
          </div>
          <p className="text-[11px] leading-relaxed text-dim">
            {tf(
              "全程会运行内置满载(CPU 全核 + GPU 计算),风扇会反复变速,属正常现象。期间请不要使用电脑跑其他重负载;随时可中止,中止即恢复原配置。",
              "The tune runs built-in full loads (all-core CPU + GPU compute); fans will repeatedly change speed. Avoid other heavy workloads during the run; abort anytime to restore the previous config.",
            )}
          </p>
        </div>
      )}

      {step === "running" && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-[12.5px] text-ink">
            <Loader2 size={14} className="animate-spin text-accent-bright" />
            <span className="font-semibold">{PHASE_ZH[progress?.phase ?? "precheck"] ?? progress?.phase}</span>
            {progress && progress.stepTotal > 0 && (
              <span className="nums text-dim">
                {progress.step}/{progress.stepTotal}
              </span>
            )}
            {progress?.note && <span className="text-[10.5px] text-dim">{progress.note}</span>}
            {progress?.phase === "fanCalib" && calib && (
              <span className="nums ml-auto text-[10.5px] text-dim">
                {(labels[calib.controlId] ?? calib.name)} ({calib.fanIndex + 1}/{calib.fanTotal}) ·{" "}
                {Math.round(calib.duty)}% → {calib.rpm != null ? Math.round(calib.rpm) : "—"} RPM
              </span>
            )}
          </div>
          <div className="h-1 overflow-hidden rounded-full bg-surface3">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-500"
              style={{ width: `${Math.round(((phaseIdx + 1) / PHASE_ORDER.length) * 100)}%` }}
            />
          </div>
          <div className="grid grid-cols-2 gap-2 text-[11.5px]">
            <Readout label="CPU" value={live?.cpuTemp ?? progress?.cpuTemp} unit="°C" warn={((live?.cpuTemp ?? progress?.cpuTemp) ?? 0) >= 85} />
            <Readout label={tf("CPU 功耗", "CPU power")} value={live?.cpuPower ?? progress?.cpuPower} unit="W" />
            <Readout label="GPU" value={live?.gpuTemp ?? progress?.gpuTemp} unit="°C" warn={((live?.gpuTemp ?? progress?.gpuTemp) ?? 0) >= 88} />
            <Readout label={tf("GPU 功耗", "GPU power")} value={live?.gpuPower ?? progress?.gpuPower} unit="W" />
            <Readout label={tf("CPU 组风量", "CPU airflow")} value={progress?.wCpu != null ? progress.wCpu * 100 : null} unit="%" />
            <Readout label={tf("机箱组风量", "Case airflow")} value={progress?.wCase != null ? progress.wCase * 100 : null} unit="%" />
          </div>
          {tempHistory.length > 2 && (
            <svg viewBox="0 0 300 60" className="h-14 w-full">
              <polyline
                fill="none"
                stroke="var(--color-accent)"
                strokeWidth="1.5"
                points={tempHistory
                  .map((t, i) => {
                    const lo = Math.min(...tempHistory);
                    const hi = Math.max(...tempHistory, lo + 1);
                    const x = (i / Math.max(1, tempHistory.length - 1)) * 300;
                    const y = 58 - ((t - lo) / (hi - lo)) * 54;
                    return `${x.toFixed(1)},${y.toFixed(1)}`;
                  })
                  .join(" ")}
              />
            </svg>
          )}
          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[11.5px] text-danger">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <div className="min-w-0">
                <p>{error}</p>
                <Button onClick={onClose}>{tf("关闭", "Close")}</Button>
              </div>
            </div>
          )}
        </div>
      )}

      {step === "result" && result && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-ink">
            <Check size={15} className="text-accent-bright" /> {tf("调优完成,曲线已应用", "Tune complete — curves applied")}
          </div>
          <div className="grid grid-cols-2 gap-2 text-[11.5px]">
            <Readout label={tf("满载实测", "Validated full-load")} value={result.validation.tV} unit="°C" />
            <Readout label={tf("有效目标", "Effective target")} value={result.effectiveTarget} unit="°C" />
            <Readout label={tf("设计功率", "Design power")} value={result.pDesign} unit="W" />
            <Readout
              label={tf("GPU→CPU 热耦合", "GPU→CPU coupling")}
              value={result.gpuCpuCouplingC}
              unit="°C"
            />
          </div>
          {!result.validation.converged && (
            <p className="text-[11px] text-warn">
              {tf("验证未完全收敛,被动学习会在日常使用中继续收口。", "Validation didn't fully converge; passive learning will keep closing the gap.")}
            </p>
          )}
          {result.warnings.map((w) => (
            <WarningRow key={w.kind + w.messageZh} w={w} busy={resynthBusy} onRaiseCeiling={() => void resynthWith({ noiseCeilPct: 100 })} />
          ))}
          <p className="text-[11px] leading-relaxed text-dim">
            {tf(
              "已自动保存为风扇配置档案;之后修改目标温度/底线/上限都会秒级重算,无需重新测量。",
              "Saved as a fan profile; future target/floor/ceiling changes re-solve in seconds with no re-measurement.",
            )}
          </p>
        </div>
      )}
    </Modal>
  );
}

function Readout({ label, value, unit, warn }: { label: string; value?: number | null; unit: string; warn?: boolean }) {
  return (
    <div className="rounded-lg border border-line bg-surface2/50 px-2.5 py-1.5">
      <div className="hud-label text-[8.5px] text-dim">{label}</div>
      <div className={`nums text-[14px] font-semibold leading-tight ${warn ? "text-warn" : "text-ink"}`}>
        {value != null ? Math.round(value * 10) / 10 : "—"}
        <span className="ml-0.5 text-[9px] font-normal text-dim">{unit}</span>
      </div>
    </div>
  );
}

function WarningRow({ w, busy, onRaiseCeiling }: { w: TuneWarning; busy: boolean; onRaiseCeiling: () => void }) {
  const tf = useTf();
  return (
    <div className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-[11.5px] text-warn">
      <div className="flex items-start gap-2">
        <Thermometer size={13} className="mt-0.5 shrink-0" />
        <p className="min-w-0">{tf(w.messageZh, w.messageEn)}</p>
      </div>
      {w.kind === "ceilingInsufficient" && (
        <div className="mt-1.5 flex gap-2">
          <Button disabled={busy} onClick={onRaiseCeiling}>
            {tf("放宽上限到 100% 并重算", "Raise ceiling to 100% & re-solve")}
          </Button>
          <span className="self-center text-[10.5px] text-dim">{tf("或保持现状(接受可达温度)", "or keep as-is (accept the achievable temp)")}</span>
        </div>
      )}
    </div>
  );
}
