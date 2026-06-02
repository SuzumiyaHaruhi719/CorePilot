import {
  Check,
  CheckCircle2,
  Loader2,
  Settings as SettingsIcon,
  Stethoscope,
  Wrench,
  X,
  XCircle,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState, type ReactNode } from "react";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { Segmented } from "../components/ui/Segmented";
import { TabHeader } from "../components/ui/TabHeader";
import { Toggle } from "../components/ui/Toggle";
import { cn } from "../lib/cn";
import { api, type NetCheck } from "../lib/ipc";
import {
  ACCENT_HUE,
  useSettings,
  type AccentName,
  type GlowLevel,
  type Language,
} from "../store/settings";

const ACCENTS: AccentName[] = ["violet", "cyan", "teal", "amber", "rose"];

interface SettingRowProps {
  title: string;
  desc?: string;
  children: ReactNode;
}

function SettingRow({ title, desc, children }: SettingRowProps) {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-line/60 py-3.5 last:border-0">
      <div>
        <div className="text-[13.5px] font-medium text-ink">{title}</div>
        {desc && <div className="text-[12px] text-dim">{desc}</div>}
      </div>
      <div className="no-drag shrink-0">{children}</div>
    </div>
  );
}

function getErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return "操作失败";
}

/** A user-selectable repair action. */
interface RepairOption {
  id: string;
  label: string;
  /** Diagnostic check ids whose failure should pre-select this repair. */
  fixesFor: string[];
  /** Marks repairs that only take effect after a reboot. */
  needsReboot?: boolean;
}

const REPAIR_OPTIONS: RepairOption[] = [
  { id: "flushDns", label: "刷新 DNS 缓存", fixesFor: ["dns"] },
  { id: "renewDhcp", label: "重新获取 IP", fixesFor: ["adapter", "gateway"] },
  { id: "resetWinsock", label: "重置 Winsock（需重启）", fixesFor: ["internet"], needsReboot: true },
  { id: "resetTcpip", label: "重置 TCP/IP（需重启）", fixesFor: ["internet", "gateway"], needsReboot: true },
  { id: "resetProxy", label: "重置代理", fixesFor: ["proxy"] },
];

/** One diagnostic / repair result row: ✓ or ✗ icon, label, and detail text. */
function CheckRow({ check }: { check: NetCheck }) {
  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      className="flex items-start gap-2.5 py-1.5"
    >
      <span className={cn("mt-0.5 shrink-0", check.ok ? "text-ok" : "text-danger")}>
        {check.ok ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
      </span>
      <div className="min-w-0">
        <div className="text-[12.5px] font-medium text-ink">{check.label}</div>
        <div className="text-[11.5px] leading-relaxed text-dim">{check.detail}</div>
      </div>
    </motion.div>
  );
}

function NetworkCard() {
  const [diagnosing, setDiagnosing] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [checks, setChecks] = useState<NetCheck[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [repairResults, setRepairResults] = useState<NetCheck[] | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runDiagnose() {
    setDiagnosing(true);
    setError(null);
    setRepairResults(null);
    try {
      const result = await api.networkDiagnose();
      setChecks(result);
      // Pre-select repairs tied to any failed check; the user can still change.
      const failed = new Set(result.filter((c) => !c.ok).map((c) => c.id));
      const preset = new Set(
        REPAIR_OPTIONS.filter((opt) => opt.fixesFor.some((id) => failed.has(id))).map((opt) => opt.id),
      );
      setSelected(preset);
    } catch (err: unknown) {
      setError(getErrorMessage(err));
      setChecks(null);
    } finally {
      setDiagnosing(false);
    }
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function runRepair() {
    setConfirmOpen(false);
    setRepairing(true);
    setError(null);
    try {
      // Preserve REPAIR_OPTIONS order for a stable, predictable result list.
      const actions = REPAIR_OPTIONS.filter((opt) => selected.has(opt.id)).map((opt) => opt.id);
      setRepairResults(await api.networkRepair(actions));
    } catch (err: unknown) {
      setError(getErrorMessage(err));
    } finally {
      setRepairing(false);
    }
  }

  const selectedNeedsReboot = REPAIR_OPTIONS.some((o) => selected.has(o.id) && o.needsReboot);
  const busy = diagnosing || repairing;

  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1], delay: 0.06 }}
      className="glass hairline mx-auto mt-4 max-w-2xl rounded-2xl p-5"
    >
      <div className="mb-3 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-accent/15 text-accent-bright">
            <Stethoscope size={17} />
          </span>
          <div>
            <div className="text-[13.5px] font-semibold text-ink">网络诊断与修复</div>
            <div className="text-[11.5px] text-dim">一键检测常见断网问题，按需修复</div>
          </div>
        </div>
        <Button variant="primary" disabled={busy} onClick={runDiagnose}>
          {diagnosing ? <Loader2 size={14} className="animate-spin" /> : <Stethoscope size={14} />}
          {diagnosing ? "检测中…" : "一键检测"}
        </Button>
      </div>

      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="mb-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[11.5px] text-danger"
          >
            {error}
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {checks && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="overflow-hidden rounded-xl border border-line/60 bg-surface2/40 px-3.5 py-1.5"
          >
            {checks.map((check) => (
              <CheckRow key={check.id} check={check} />
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      {checks && (
        <div className="mt-4">
          <div className="mb-2 text-[12px] font-semibold text-muted">修复项（可自行勾选）</div>
          <div className="grid gap-2 sm:grid-cols-2">
            {REPAIR_OPTIONS.map((opt) => {
              const isOn = selected.has(opt.id);
              return (
                <button
                  key={opt.id}
                  type="button"
                  disabled={busy}
                  onClick={() => toggle(opt.id)}
                  className={cn(
                    "no-drag flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-[12.5px] transition-colors",
                    isOn
                      ? "border-accent/50 bg-accent/15 text-ink glow-sm"
                      : "border-line bg-surface2 text-muted hover:border-line-strong hover:text-ink",
                    busy && "cursor-not-allowed opacity-50",
                  )}
                >
                  <span
                    className={cn(
                      "grid h-[18px] w-[18px] shrink-0 place-items-center rounded-md border transition-colors",
                      isOn ? "border-accent bg-accent-bright text-white" : "border-line",
                    )}
                  >
                    {isOn && <Check size={12} strokeWidth={3} />}
                  </span>
                  {opt.label}
                </button>
              );
            })}
          </div>

          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="text-[11px] text-dim">
              已选 {selected.size} 项{selectedNeedsReboot && " · 含需重启的修复"}
            </span>
            <Button
              variant="primary"
              disabled={busy || selected.size === 0}
              onClick={() => setConfirmOpen(true)}
            >
              {repairing ? <Loader2 size={14} className="animate-spin" /> : <Wrench size={14} />}
              {repairing ? "修复中…" : "修复所选"}
            </Button>
          </div>
        </div>
      )}

      <AnimatePresence>
        {repairResults && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="mt-4"
          >
            <div className="mb-2 text-[12px] font-semibold text-muted">修复结果</div>
            <div className="overflow-hidden rounded-xl border border-line/60 bg-surface2/40 px-3.5 py-1.5">
              {repairResults.length === 0 ? (
                <div className="py-2 text-[11.5px] text-dim">未执行任何修复。</div>
              ) : (
                repairResults.map((check) => <CheckRow key={check.id} check={check} />)
              )}
            </div>
            {repairResults.some((c) => c.detail.includes("重启")) && (
              <p className="mt-2 text-[11px] leading-relaxed text-warn">
                部分修复（Winsock / TCP-IP 重置）需重启电脑后才能完全生效。
              </p>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="确认执行修复"
        footer={
          <>
            <Button onClick={() => setConfirmOpen(false)}>
              <X size={14} /> 取消
            </Button>
            <Button variant="primary" onClick={runRepair}>
              <Wrench size={14} /> 确认修复
            </Button>
          </>
        }
      >
        <p className="text-[13px] leading-relaxed text-ink">
          即将执行以下 {selected.size} 项网络修复：
        </p>
        <ul className="mt-2 space-y-1">
          {REPAIR_OPTIONS.filter((o) => selected.has(o.id)).map((o) => (
            <li key={o.id} className="flex items-center gap-2 text-[12.5px] text-muted">
              <span className="h-1.5 w-1.5 rounded-full bg-accent-bright" />
              {o.label}
            </li>
          ))}
        </ul>
        {selectedNeedsReboot && (
          <p className="mt-3 text-[11.5px] leading-relaxed text-warn">
            注意：含重置 Winsock / TCP-IP，这些操作需重启电脑后生效，并可能短暂中断现有网络连接。
          </p>
        )}
      </Modal>
    </motion.div>
  );
}

export function Settings() {
  const settings = useSettings();

  return (
    <>
      <TabHeader icon={SettingsIcon} title="设置" subtitle="所有更改即时自动保存 — 无需手动保存" />
      <div className="min-h-0 flex-1 overflow-auto px-6 pb-6">
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          className="glass hairline mx-auto max-w-2xl rounded-2xl px-5 py-2"
        >
          <SettingRow title="强调色" desc="主题主色调，实时应用">
            <div className="flex gap-2">
              {ACCENTS.map((accent) => (
                <motion.button
                  key={accent}
                  whileHover={{ scale: 1.15 }}
                  whileTap={{ scale: 0.9 }}
                  onClick={() => settings.update({ accent })}
                  className={cn(
                    "h-7 w-7 rounded-full border-2 transition",
                    settings.accent === accent ? "border-ink glow" : "border-transparent",
                  )}
                  style={{ background: `oklch(72% 0.16 ${ACCENT_HUE[accent]})` }}
                />
              ))}
            </div>
          </SettingRow>

          <SettingRow title="发光强度" desc="界面柔和发光效果">
            <Segmented
              id="glow"
              value={settings.glow}
              onChange={(value) => settings.update({ glow: value as GlowLevel })}
              options={[
                { value: "soft", label: "柔和" },
                { value: "medium", label: "中等" },
                { value: "intense", label: "强烈" },
              ]}
            />
          </SettingRow>

          <SettingRow title="亚克力模糊" desc="Windows 11 acrylic 背景效果">
            <Toggle checked={settings.acrylic} onChange={(value) => settings.update({ acrylic: value })} />
          </SettingRow>

          <SettingRow title="减弱动画" desc="降低动效以提升无障碍体验">
            <Toggle
              checked={settings.reduceMotion}
              onChange={(value) => settings.update({ reduceMotion: value })}
            />
          </SettingRow>

          <SettingRow
            title="关闭后保留到托盘"
            desc="关闭窗口时收起到系统托盘，后台继续运行（亲和性 / 超频 / OSD）；右键托盘图标可退出"
          >
            <Toggle
              checked={settings.closeToTray}
              onChange={(value) => settings.update({ closeToTray: value })}
            />
          </SettingRow>

          <SettingRow title="语言 / Language">
            <Segmented
              id="lang"
              value={settings.language}
              onChange={(value) => settings.update({ language: value as Language })}
              options={[
                { value: "zh", label: "中文" },
                { value: "en", label: "EN" },
              ]}
            />
          </SettingRow>

          <SettingRow title="刷新间隔" desc="实时数据轮询频率">
            <Segmented
              id="poll"
              value={String(settings.pollMs)}
              onChange={(value) => settings.update({ pollMs: Number(value) })}
              options={[
                { value: "1000", label: "1s" },
                { value: "1500", label: "1.5s" },
                { value: "2000", label: "2s" },
                { value: "3000", label: "3s" },
              ]}
            />
          </SettingRow>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1], delay: 0.03 }}
          className="glass hairline mx-auto mt-4 max-w-2xl rounded-2xl px-5 py-2"
        >
          <div className="border-b border-line/60 py-3 text-[12px] font-semibold uppercase tracking-wider text-muted">
            性能与监控
          </div>
          <SettingRow
            title="游戏性能记录"
            desc="检测到游戏运行时自动采样性能；游戏关闭后在 监控 → 历史 生成报告"
          >
            <Toggle
              checked={settings.perfRecording}
              onChange={(value) => settings.update({ perfRecording: value })}
            />
          </SettingRow>
          <SettingRow
            title="游戏结束后自动弹出性能报告"
            desc="游戏关闭时将 CorePilot 切到前台并打开本次性能报告"
          >
            <Toggle
              checked={settings.autoShowReport}
              onChange={(value) => settings.update({ autoShowReport: value })}
            />
          </SettingRow>
          <SettingRow title="游戏检测通知" desc="检测到游戏运行 / 性能报告生成时发送 Windows 系统通知">
            <Toggle
              checked={settings.gameNotify}
              onChange={(value) => settings.update({ gameNotify: value })}
            />
          </SettingRow>
        </motion.div>

        <NetworkCard />
      </div>
    </>
  );
}
