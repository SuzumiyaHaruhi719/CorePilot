import {
  Activity,
  Check,
  CheckCircle2,
  ChevronRight,
  FolderOpen,
  ListPlus,
  Loader2,
  MonitorPlay,
  Palette,
  Plus,
  Search,
  Settings as SettingsIcon,
  Stethoscope,
  Trash2,
  Wrench,
  X,
  XCircle,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { Segmented } from "../components/ui/Segmented";
import { TabHeader } from "../components/ui/TabHeader";
import { Toggle } from "../components/ui/Toggle";
import { cn } from "../lib/cn";
import { useT, useTf } from "../lib/i18n";
import { api, type NetCheck, type ProcInfo } from "../lib/ipc";
import {
  ACCENT_HUE,
  useSettings,
  type AccentName,
  type GlowLevel,
  type Language,
} from "../store/settings";
import { useRecordTargets } from "../store/recordTargets";

const ACCENTS: AccentName[] = ["violet", "cyan", "teal", "amber", "rose"];

interface SettingRowProps {
  title: string;
  desc?: string;
  children: ReactNode;
}

function SettingRow({ title, desc, children }: SettingRowProps) {
  const t = useT();
  return (
    <div className="flex items-center justify-between gap-6 border-b border-line/60 py-3.5 last:border-0">
      <div>
        <div className="text-[13.5px] font-medium text-ink">{t(title)}</div>
        {desc && <div className="text-[12px] text-dim">{t(desc)}</div>}
      </div>
      <div className="no-drag shrink-0">{children}</div>
    </div>
  );
}

/** Uppercase HUD section header that sits at the top of a settings group. */
function SectionHeader({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  const t = useT();
  return (
    <div className="flex items-center gap-2 border-b border-line/60 py-3">
      <Icon size={13} className="text-accent-bright" />
      <span className="hud-label text-[10.5px] text-dim">{t(label)}</span>
      <span className="h-px flex-1 bg-line/50" />
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
  const tf = useTf();
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
                    busy ? "cursor-not-allowed opacity-50" : "cursor-pointer",
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
              {tf(`已选 ${selected.size} 项`, `${selected.size} selected`)}{selectedNeedsReboot && " · 含需重启的修复"}
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
          {tf(`即将执行以下 ${selected.size} 项网络修复：`, `About to run these ${selected.size} network fixes:`)}
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

/**
 * 性能记录名单 — a dedicated white / black list controlling which apps the perf
 * recorder (`usePerfRecorder`) samples. SEPARATE from the OSD show/hide list:
 *
 *  - 白名单 (white) = force-record this exe even if not auto-detected as a game.
 *  - 黑名单 (black) = NEVER record this exe, even if auto-detected (kills false
 *    positives).
 *
 * Mirrors the OsdConfig list UX: text-input add, "从运行中的进程选择" modal, and
 * "从文件选择" native picker.
 */
function PerfRecordTargetsCard() {
  const { targets, addTarget, removeTarget, setTargetList } = useRecordTargets();
  const [addName, setAddName] = useState("");
  // "Pick from running processes" picker state.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [procs, setProcs] = useState<ProcInfo[]>([]);
  const [procLoading, setProcLoading] = useState(false);
  const [procQuery, setProcQuery] = useState("");
  const [collapsed, setCollapsed] = useState(true);

  function submitAdd() {
    const n = addName.trim();
    if (!n) return;
    addTarget(n);
    setAddName("");
  }

  // Open the "pick from running processes" picker and (re)load the process list.
  async function openProcessPicker() {
    setProcQuery("");
    setPickerOpen(true);
    setProcLoading(true);
    try {
      setProcs(await api.listProcesses());
    } catch {
      setProcs([]);
    } finally {
      setProcLoading(false);
    }
  }

  // Add a process by exe name from the picker, then close it.
  function pickProcess(name: string) {
    addTarget(name);
    setPickerOpen(false);
  }

  // Add one or more exes by browsing to their .exe via a native file dialog —
  // works for apps that aren't running yet (unlike the running-process picker).
  async function pickFromFile() {
    try {
      const names = await api.pickExeFiles();
      for (const n of names) addTarget(n);
    } catch {
      /* dialog cancelled or unavailable — ignore */
    }
  }

  // De-duplicate by lowercased name, filter by the search query, sort alphabetically.
  const pickerProcs = useMemo(() => {
    const q = procQuery.trim().toLowerCase();
    const byName = new Map<string, ProcInfo>();
    for (const p of procs) {
      const key = p.name.toLowerCase();
      if (!key || byName.has(key)) continue;
      byName.set(key, p);
    }
    return [...byName.values()]
      .filter((p) => (q ? p.name.toLowerCase().includes(q) : true))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  }, [procs, procQuery]);

  return (
    <div className="border-b border-line/60 py-3.5 last:border-0">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="no-drag flex w-full cursor-pointer items-center gap-2 text-left"
      >
        <ChevronRight size={15} className={cn("shrink-0 text-dim transition-transform", !collapsed && "rotate-90")} />
        <span className="text-[13.5px] font-medium text-ink">性能记录名单 / 白·黑名单</span>
        {targets.length > 0 && (
          <span className="nums rounded-md bg-surface3 px-1.5 py-0.5 text-[10.5px] text-dim">{targets.length}</span>
        )}
      </button>
      {!collapsed && (
        <>
      <div className="mb-3 mt-2 text-[12px] leading-relaxed text-dim">
        控制哪些程序会被记录性能报告（独立于 OSD 显示名单）：白名单 = 强制记录（即使未被识别为游戏），黑名单
        = 从不记录（即使被识别为游戏）。
      </div>

      {/* Add by exe name + pickers */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          value={addName}
          onChange={(e) => setAddName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitAdd();
          }}
          placeholder="可执行文件名，如 cyberpunk2077.exe"
          className="no-drag w-64 rounded-lg border border-line bg-surface2 px-3 py-1.5 text-[12.5px] text-ink outline-none transition-colors focus:border-accent/50"
        />
        <button
          onClick={submitAdd}
          disabled={!addName.trim()}
          className="no-drag flex cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-surface2 px-2.5 py-1.5 text-[12px] text-muted transition-colors hover:bg-surface3 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Plus size={13} /> 添加
        </button>
        <button
          onClick={() => void openProcessPicker()}
          className="no-drag flex cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-surface2 px-2.5 py-1.5 text-[12px] text-muted transition-colors hover:bg-surface3 hover:text-ink"
        >
          <ListPlus size={13} /> 从运行中的进程选择
        </button>
        <button
          onClick={() => void pickFromFile()}
          className="no-drag flex cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-surface2 px-2.5 py-1.5 text-[12px] text-muted transition-colors hover:bg-surface3 hover:text-ink"
        >
          <FolderOpen size={13} /> 从文件选择
        </button>
      </div>

      {/* Entry list */}
      {targets.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line/70 px-3 py-4 text-center text-[12px] text-dim">
          暂无条目 — 默认仅记录自动识别为游戏的程序。在此添加以强制记录或屏蔽误判。
        </div>
      ) : (
        <div className="space-y-1.5">
          {targets.map((t) => (
            <div
              key={t.name}
              className="no-drag flex items-center gap-2 rounded-lg border border-line bg-surface2 px-3 py-2 text-[12.5px]"
            >
              <MonitorPlay size={13} className="shrink-0 text-dim" />
              <span className="flex-1 truncate text-muted">{t.name}</span>
              <Segmented
                id={`rec-list-${t.name}`}
                value={t.list}
                onChange={(v) => setTargetList(t.name, v as "white" | "black")}
                options={[
                  { value: "white", label: "强制记录" },
                  { value: "black", label: "从不记录" },
                ]}
              />
              <button
                onClick={() => removeTarget(t.name)}
                className="grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-lg text-dim transition-colors hover:bg-danger/15 hover:text-danger"
                title="移除"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
        </>
      )}

      {/* Pick a target from the currently-running processes. */}
      <Modal open={pickerOpen} onClose={() => setPickerOpen(false)} title="从运行中的进程选择">
        <div className="no-drag relative mb-3">
          <Search
            size={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-dim"
          />
          <input
            autoFocus
            value={procQuery}
            onChange={(e) => setProcQuery(e.target.value)}
            placeholder="搜索进程名…"
            className="w-full rounded-lg border border-line bg-surface2 py-2 pl-9 pr-3 text-[12.5px] text-ink outline-none transition-colors focus:border-accent/50"
          />
        </div>
        <div className="hairline max-h-[320px] overflow-auto rounded-xl border border-line bg-surface2/40">
          {procLoading ? (
            <div className="px-3 py-6 text-center text-[12px] text-dim">正在读取进程…</div>
          ) : pickerProcs.length === 0 ? (
            <div className="px-3 py-6 text-center text-[12px] text-dim">
              {procQuery.trim() ? "没有匹配的进程" : "未发现进程"}
            </div>
          ) : (
            <div className="space-y-0.5 p-1">
              {pickerProcs.map((p) => {
                const already = targets.some((t) => t.name === p.name.toLowerCase());
                return (
                  <button
                    key={p.name.toLowerCase()}
                    onClick={() => pickProcess(p.name)}
                    className="no-drag flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-left text-[12.5px] text-muted transition-colors hover:bg-accent/10 hover:text-ink"
                  >
                    <MonitorPlay size={13} className="shrink-0 text-dim" />
                    <span className="flex-1 truncate">{p.name}</span>
                    {p.description && (
                      <span className="truncate text-[11px] text-dim">{p.description}</span>
                    )}
                    {already && (
                      <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent-bright">
                        已添加
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </Modal>
    </div>
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
          <SectionHeader icon={Palette} label="外观 · APPEARANCE" />
          <SettingRow title="强调色" desc="主题主色调，实时应用">
            <div className="flex gap-2">
              {ACCENTS.map((accent) => {
                const active = settings.accent === accent;
                return (
                  <motion.button
                    key={accent}
                    title={accent}
                    whileHover={{ scale: 1.15 }}
                    whileTap={{ scale: 0.9 }}
                    onClick={() => settings.update({ accent })}
                    className={cn(
                      "grid h-7 w-7 cursor-pointer place-items-center rounded-full border-2 transition",
                      active ? "border-ink glow" : "border-transparent hover:border-line-strong",
                    )}
                    style={{ background: `oklch(72% 0.16 ${ACCENT_HUE[accent]})` }}
                  >
                    {active && <Check size={13} strokeWidth={3} className="text-white drop-shadow" />}
                  </motion.button>
                );
              })}
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

          <SettingRow title="窗口不透明度" desc="整个窗口的不透明度（亚克力开启时可透出背景）">
            <div className="flex items-center gap-3">
              <div className="w-40">
                <input
                  type="range"
                  min={30}
                  max={100}
                  step={1}
                  value={settings.windowOpacity}
                  onChange={(e) => settings.update({ windowOpacity: Number(e.target.value) })}
                  className="cp-slider"
                  style={{ "--pct": `${((settings.windowOpacity - 30) / 70) * 100}%` } as CSSProperties}
                />
              </div>
              <span className="nums w-11 text-right text-[13px] text-ink">{settings.windowOpacity}%</span>
            </div>
          </SettingRow>

          <SettingRow title="关闭动画（省电）" desc="关闭持续动效（HUD 背景 / 光晕 / 旋转图标等），明显降低空闲 CPU 占用，适合低端设备">
            <Toggle
              checked={settings.reduceMotion}
              onChange={(value) => settings.update({ reduceMotion: value })}
            />
          </SettingRow>

          <SettingRow title="后台记录性能曲线" desc="关闭任务管理器后仍在后台记录 CPU / GPU / 内存 / 磁盘 / 网络，下次打开图表即为完整曲线（会略增空闲占用）">
            <Toggle
              checked={settings.bgRecord}
              onChange={(value) => settings.update({ bgRecord: value })}
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
          <SectionHeader icon={Activity} label="性能与监控 · PERFORMANCE" />
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
          <PerfRecordTargetsCard />
        </motion.div>

        <NetworkCard />
      </div>
    </>
  );
}
