import {
  AlertTriangle,
  Bug,
  Check,
  CheckCircle2,
  ChevronRight,
  FolderOpen,
  ListPlus,
  Loader2,
  MonitorPlay,
  Plus,
  Search,
  Stethoscope,
  Trash2,
  Wrench,
  X,
  XCircle,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { Segmented } from "../components/ui/Segmented";
import { RangeInput } from "../components/ui/Slider";
import { TabHeader } from "../components/ui/TabHeader";
import { Toggle } from "../components/ui/Toggle";
import { useUi } from "../store/ui";
import { cn } from "../lib/cn";
import { springSmooth } from "../lib/motion";
import { useT, useTf } from "../lib/i18n";
import { api, type NetCheck, type ProcInfo } from "../lib/ipc";
import {
  THEME_STYLES,
  useSettings,
  type GlowLevel,
  type Language,
  type Theme,
} from "../store/settings";
import { useRecordTargets } from "../store/recordTargets";
import { UpdateCard } from "../components/update/UpdateCard";

interface SettingRowProps {
  title: string;
  desc?: string;
  /** Tint the description as an error (e.g. a write that failed and reverted). */
  danger?: boolean;
  children: ReactNode;
}

/** One setting: what it is on the left, its control on the right. */
function SettingRow({ title, desc, danger, children }: SettingRowProps) {
  const t = useT();
  return (
    <div className="flex items-center justify-between gap-8 border-t border-line py-3.5 first:border-t-0">
      <div className="min-w-0 max-w-[62ch]">
        <div className="text-[13px] font-medium text-ink">{t(title)}</div>
        {desc && <div className={cn("mt-0.5 text-[12px] leading-relaxed", danger ? "text-danger" : "text-muted")}>{t(desc)}</div>}
      </div>
      <div className="no-drag shrink-0">{children}</div>
    </div>
  );
}

/** A titled settings group (anchor target for the section index). */
function SettingsSection({ id, title, desc, children }: { id: string; title: string; desc?: string; children: ReactNode }) {
  return (
    <section id={`sec-${id}`} className="glass scroll-mt-2 rounded-xl px-4 pb-1 pt-3.5">
      <h2 className="text-[14px] font-semibold text-ink">{title}</h2>
      {desc && <p className="mt-0.5 text-[12px] text-muted">{desc}</p>}
      <div className="mt-1.5">{children}</div>
    </section>
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
  // Network results come from the backend (some details embed live IPs), so the
  // backend localizes them — pass the app's current language.
  const en = useSettings((s) => s.language) === "en";
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
      const result = await api.networkDiagnose(en);
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
      setRepairResults(await api.networkRepair(actions, en));
    } catch (err: unknown) {
      setError(getErrorMessage(err));
    } finally {
      setRepairing(false);
    }
  }

  const selectedNeedsReboot = REPAIR_OPTIONS.some((o) => selected.has(o.id) && o.needsReboot);
  const busy = diagnosing || repairing;

  return (
    <div className="pb-3.5 pt-2">
      <div className="mb-3 flex items-center justify-between gap-4">
        <span className="text-[12.5px] text-muted">{tf("检测网卡、网关、DNS、代理与外网连通性", "Checks adapter, gateway, DNS, proxy and internet reachability")}</span>
        <Button disabled={busy} onClick={runDiagnose}>
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
            className="mb-2 rounded-lg bg-danger/10 ring-1 ring-inset ring-danger/25 px-3 py-2 text-[11.5px] text-danger"
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
            className="overflow-hidden rounded-lg bg-surface2/60 px-3.5 py-1.5"
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
                    "no-drag flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[12.5px] transition-colors",
                    isOn ? "bg-accent/10 text-ink" : "text-muted hover:bg-surface2 hover:text-ink",
                    busy ? "cursor-not-allowed opacity-50" : "cursor-pointer",
                  )}
                >
                  <span
                    className={cn(
                      "grid h-4 w-4 shrink-0 place-items-center rounded-[4px] transition-colors",
                      // text-on-accent, not text-white: the tick sits on the accent
                      // fill, which is neon yellow/green on the bright-accent themes.
                      isOn ? "bg-accent text-on-accent" : "shadow-[inset_0_0_0_1.5px_var(--color-dim)]",
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
            <div className="overflow-hidden rounded-lg bg-surface2/60 px-3.5 py-1.5">
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
    </div>
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
  const tf = useTf();
  const { targets, addTarget, removeTarget, setTargetList } = useRecordTargets();
  const [addName, setAddName] = useState("");
  // "Pick from running processes" picker state.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [procs, setProcs] = useState<ProcInfo[]>([]);
  const [procLoading, setProcLoading] = useState(false);
  const [procErr, setProcErr] = useState(false);
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
    setProcErr(false);
    try {
      setProcs(await api.listProcesses());
    } catch {
      setProcs([]);
      setProcErr(true);
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
    <div className="border-t border-line py-3.5">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        className="no-drag flex w-full cursor-pointer items-center gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
      >
        <ChevronRight size={15} className={cn("shrink-0 text-dim transition-transform", !collapsed && "rotate-90")} />
        <span className="text-[13px] font-medium text-ink">性能记录名单 / 白·黑名单</span>
        {targets.length > 0 && (
          <span className="nums rounded bg-surface3 px-1.5 text-[11px] leading-5 text-dim">{targets.length}</span>
        )}
      </button>
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
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
          className="field no-drag w-64"
        />
        <button
          onClick={submitAdd}
          disabled={!addName.trim()}
          className="no-drag flex h-[30px] cursor-pointer items-center gap-1.5 rounded-md bg-surface2 px-2.5 text-[12px] text-ink shadow-[inset_0_0_0_1px_var(--color-line)] transition-colors hover:bg-surface3 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Plus size={13} /> 添加
        </button>
        <button
          onClick={() => void openProcessPicker()}
          className="no-drag flex h-[30px] cursor-pointer items-center gap-1.5 rounded-md bg-surface2 px-2.5 text-[12px] text-ink shadow-[inset_0_0_0_1px_var(--color-line)] transition-colors hover:bg-surface3 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ListPlus size={13} /> 从运行中的进程选择
        </button>
        <button
          onClick={() => void pickFromFile()}
          className="no-drag flex h-[30px] cursor-pointer items-center gap-1.5 rounded-md bg-surface2 px-2.5 text-[12px] text-ink shadow-[inset_0_0_0_1px_var(--color-line)] transition-colors hover:bg-surface3 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <FolderOpen size={13} /> 从文件选择
        </button>
      </div>

      {/* Entry list */}
      {targets.length === 0 ? (
        <div className="px-3 py-4 text-center text-[12.5px] text-muted">
          暂无条目 — 默认仅记录自动识别为游戏的程序。在此添加以强制记录或屏蔽误判。
        </div>
      ) : (
        <div className="space-y-0.5">
          {targets.map((t) => (
            <div
              key={t.name}
              className="no-drag flex items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] hover:bg-surface2/60"
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
                aria-label={tf(`移除 ${t.name}`, `Remove ${t.name}`)}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
          </motion.div>
        )}
      </AnimatePresence>

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
            className="field h-9 w-full pl-9"
          />
        </div>
        <div className="max-h-[320px] overflow-auto rounded-lg bg-surface2/50 shadow-[inset_0_0_0_1px_var(--color-line)]">
          {procLoading ? (
            <div className="px-3 py-6 text-center text-[12px] text-dim">正在读取进程…</div>
          ) : procErr ? (
            <div className="flex items-center justify-center gap-1.5 px-3 py-6 text-center text-[12px] text-danger">
              <AlertTriangle size={13} /> {tf("无法读取进程列表", "Couldn't read the process list")}
            </div>
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
                      <span className="shrink-0 rounded bg-accent/14 px-1.5 text-[11px] font-medium leading-5 text-accent">
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
  const t = useT();
  const tf = useTf();
  const activeStyle = THEME_STYLES.find((s) => s.id === settings.themeStyle);
  // 开机自启动 — reflects the actual OS scheduled task (not a persisted setting):
  // query it on mount, write through on toggle (optimistic, revert on failure).
  const [autostartOn, setAutostartOn] = useState(false);
  useEffect(() => {
    api.getAutostart().then(setAutostartOn).catch(() => undefined);
  }, []);
  const [autostartErr, setAutostartErr] = useState(false);
  const toggleAutostart = (v: boolean) => {
    setAutostartOn(v);
    setAutostartErr(false);
    // Optimistic write-through; on failure revert the toggle AND say so — a
    // silently-snapping-back toggle reads as a UI glitch, not a failed change.
    api.setAutostart(v).catch(() => {
      setAutostartOn(!v);
      setAutostartErr(true);
    });
  };
  // AMD/SMU tuning master switch (persisted). OFF by default so the dangerous SMU
  // write controls can't be reached by accident; unlocking reveals the hidden
  // "AMD 优化" tab. Turning it off while on that tab leaves it for Settings.
  const amdUnlocked = useUi((s) => s.amdTuningUnlocked);
  const setAmdUnlocked = useUi((s) => s.setAmdTuningUnlocked);
  const uiTab = useUi((s) => s.tab);
  const setUiTab = useUi((s) => s.setTab);
  const toggleAmdUnlocked = (v: boolean) => {
    setAmdUnlocked(v);
    if (!v && uiTab === "amd") setUiTab("settings");
  };

  const sections: Array<{ id: string; zh: string; en: string }> = [
    { id: "appearance", zh: "外观", en: "Appearance" },
    { id: "power", zh: "性能与省电", en: "Performance & power" },
    { id: "startup", zh: "启动与后台", en: "Startup & background" },
    { id: "recording", zh: "游戏记录", en: "Game recording" },
    { id: "advanced", zh: "高级", en: "Advanced" },
    { id: "network", zh: "网络", en: "Network" },
    { id: "update", zh: "更新", en: "Updates" },
    { id: "debug", zh: "诊断", en: "Diagnostics" },
  ];
  const scrollRef = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState("appearance");
  // Highlight the section nearest the top of the scroll area.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const io = new IntersectionObserver(
      (entries) => {
        const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setCurrent(top.target.id.replace("sec-", ""));
      },
      { root, rootMargin: "0px 0px -65% 0px" },
    );
    for (const s of sections) {
      const el = document.getElementById(`sec-${s.id}`);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
    // `sections` is a static list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const jump = (id: string) => document.getElementById(`sec-${id}`)?.scrollIntoView({ behavior: settings.reduceMotion ? "auto" : "smooth", block: "start" });

  return (
    <>
      <TabHeader title="设置" subtitle="所有更改即时自动保存 — 无需手动保存" />
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto px-6 pb-10">
        <div className="mx-auto grid max-w-[1000px] items-start gap-8 lg:grid-cols-[168px_minmax(0,1fr)]">
          {/* Section index — Windows-Settings style, sticky beside the content. */}
          <nav aria-label={tf("设置分区", "Settings sections")} className="hidden flex-col gap-0.5 lg:sticky lg:top-0 lg:flex">
            {sections.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => jump(s.id)}
                aria-current={current === s.id ? "true" : undefined}
                className={cn(
                  "no-drag relative h-8 rounded-md px-3 text-left text-[13px] transition-colors duration-150",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
                  current === s.id ? "bg-surface2 font-medium text-ink" : "text-muted hover:bg-surface2/60 hover:text-ink",
                )}
              >
                {current === s.id && (
                  <motion.span layoutId="settings-pill" className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-accent" transition={springSmooth} />
                )}
                {tf(s.zh, s.en)}
              </button>
            ))}
          </nav>

          <div className="min-w-0 space-y-4">
            <SettingsSection id="appearance" title={tf("外观", "Appearance")}>
              <SettingRow title="主题" desc="深色或浅色界面">
                <Segmented
                  id="theme"
                  value={settings.theme}
                  onChange={(v) =>
                    settings.update({
                      theme: v as Theme,
                      themeStyle: v === "light" ? "porcelain" : "graphite",
                    })
                  }
                  options={[
                    { value: "dark", label: "深色" },
                    { value: "light", label: "浅色" },
                  ]}
                />
              </SettingRow>
              <div className="border-t border-line py-3.5">
                <div className="mb-3 flex items-baseline justify-between gap-3">
                  <span className="text-[13px] font-medium text-ink">{t("主题风格")}</span>
                  <span className="text-[12px] text-muted">{activeStyle ? t(activeStyle.desc) : ""}</span>
                </div>
                <div role="radiogroup" aria-label={t("主题风格")} className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {THEME_STYLES.map((s) => {
                    const active = settings.themeStyle === s.id;
                    const [page, surface, accent] = s.swatches;
                    return (
                      <button
                        key={s.id}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        onClick={() => settings.update({ theme: s.mode, themeStyle: s.id })}
                        className={cn(
                          "no-drag group cursor-pointer rounded-lg p-1.5 text-left transition-[box-shadow,background-color] duration-150",
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
                          active ? "bg-accent/10 shadow-[inset_0_0_0_1.5px_var(--color-accent)]" : "shadow-[inset_0_0_0_1px_var(--color-line)] hover:bg-surface2",
                        )}
                      >
                        {/* A miniature window in the preset's own colors. */}
                        <span className="relative block h-14 overflow-hidden rounded-md" style={{ background: page }}>
                          <span className="absolute inset-y-0 left-0 w-1/4" style={{ background: page, filter: "brightness(0.82)" }} />
                          <span className="absolute bottom-1.5 left-[30%] right-1.5 top-1.5 rounded" style={{ background: surface }} />
                          <span className="absolute left-[36%] top-3.5 h-1.5 w-1/3 rounded-full" style={{ background: accent }} />
                          <span className="absolute left-[36%] top-7 h-1 w-1/2 rounded-full opacity-40" style={{ background: page === surface ? "#888" : page }} />
                        </span>
                        <span className="mt-1.5 flex items-center justify-between px-1 pb-0.5">
                          <span className="text-[12.5px] font-medium text-ink">{t(s.name)}</span>
                          {active ? <Check size={13} className="text-accent" /> : <span className="text-[11px] text-dim">{s.mode === "dark" ? t("深色") : t("浅色")}</span>}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
              <SettingRow title="发光强度" desc="活动元素的柔和光晕">
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
                <Toggle checked={settings.acrylic} onChange={(value) => settings.update({ acrylic: value })} label={t("亚克力模糊")} />
              </SettingRow>
              <SettingRow title="窗口不透明度" desc="整个窗口的不透明度（亚克力开启时可透出背景）">
                <div className="flex items-center gap-3">
                  <RangeInput
                    label={tf("窗口不透明度", "Window opacity")}
                    value={settings.windowOpacity}
                    min={30}
                    max={100}
                    ticks={false}
                    className="w-40"
                    onChange={(v) => settings.update({ windowOpacity: v })}
                  />
                  <span className="nums w-11 text-right text-[13px] text-ink">{settings.windowOpacity}%</span>
                </div>
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
            </SettingsSection>

            <SettingsSection id="power" title={tf("性能与省电", "Performance & power")}>
              <SettingRow title="关闭动画（省电）" desc="关闭持续动效（HUD 背景 / 光晕 / 旋转图标等），明显降低空闲 CPU 占用，适合低端设备">
                <Toggle checked={settings.reduceMotion} onChange={(value) => settings.update({ reduceMotion: value })} label={t("关闭动画（省电）")} />
              </SettingRow>
              <SettingRow title="GPU 渲染（界面与动效）" desc="开启时用 GPU 加速亚克力模糊、光晕与动画；关闭后改用极简渲染，几乎不占用显卡——游戏时避免与游戏抢 GPU，也可消除合成器卡顿">
                <Toggle checked={settings.gpuRender} onChange={(value) => settings.update({ gpuRender: value })} label={t("GPU 渲染（界面与动效）")} />
              </SettingRow>
              <SettingRow title="后台记录性能曲线" desc="关闭任务管理器后仍在后台记录 CPU / GPU / 内存 / 磁盘 / 网络，下次打开图表即为完整曲线（会略增空闲占用）">
                <Toggle checked={settings.bgRecord} onChange={(value) => settings.update({ bgRecord: value })} label={t("后台记录性能曲线")} />
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
            </SettingsSection>

            <SettingsSection id="startup" title={tf("启动与后台", "Startup & background")}>
              <SettingRow title="关闭后保留到托盘" desc="关闭窗口时收起到系统托盘，后台继续运行（亲和性 / 超频 / OSD）；右键托盘图标可退出">
                <Toggle checked={settings.closeToTray} onChange={(value) => settings.update({ closeToTray: value })} label={t("关闭后保留到托盘")} />
              </SettingRow>
              <SettingRow
                title="开机自启动"
                desc={
                  autostartErr
                    ? tf("设置失败,已恢复原状 — 请确认以管理员身份运行后重试", "Change failed and was reverted — make sure CorePilot runs as administrator, then retry")
                    : "登录 Windows 时自动以管理员身份启动（计划任务方式，不弹 UAC）；配合“关闭后保留到托盘”可在开机后静默后台运行"
                }
                danger={autostartErr}
              >
                <Toggle checked={autostartOn} onChange={(value) => toggleAutostart(value)} label={t("开机自启动")} />
              </SettingRow>
            </SettingsSection>

            <SettingsSection id="recording" title={tf("游戏记录", "Game recording")}>
              <SettingRow title="游戏性能记录" desc="检测到游戏运行时自动采样性能；游戏关闭后在 监控 → 历史 生成报告">
                <Toggle checked={settings.perfRecording} onChange={(value) => settings.update({ perfRecording: value })} label={t("游戏性能记录")} />
              </SettingRow>
              <SettingRow title="游戏结束后自动弹出性能报告" desc="游戏关闭时将 CorePilot 切到前台并打开本次性能报告">
                <Toggle checked={settings.autoShowReport} onChange={(value) => settings.update({ autoShowReport: value })} label={t("游戏结束后自动弹出性能报告")} />
              </SettingRow>
              <SettingRow title="游戏检测通知" desc="检测到游戏运行 / 性能报告生成时发送 Windows 系统通知">
                <Toggle checked={settings.gameNotify} onChange={(value) => settings.update({ gameNotify: value })} label={t("游戏检测通知")} />
              </SettingRow>
              <PerfRecordTargetsCard />
            </SettingsSection>

            <SettingsSection id="advanced" title={tf("高级", "Advanced")}>
              <SettingRow
                title="启用 AMD 调优（实验性 · 危险）"
                desc="解锁「AMD 优化」标签:Ryzen SMU 级 Curve Optimizer 撤压 / PBO 限制。内核级写入,设置不当可能导致 WHEA 报错、死机或无法开机;默认关闭以防误触。开启后侧栏会出现「AMD 优化」标签。"
              >
                <Toggle checked={amdUnlocked} onChange={(value) => toggleAmdUnlocked(value)} label={t("启用 AMD 调优（实验性 · 危险）")} />
              </SettingRow>
              <SettingRow
                title="智能调优:允许后台负载"
                desc="风扇智能调优默认要求系统空闲(后台占用会污染怠速基线)。开启后即使有后台负载也可开始调优 — 结果会标注实测后台占用并提示精度可能下降;91°C 失控保护与满载验证不受影响。常驻监控/挂机软件挡住调优时用这个。"
              >
                <Toggle checked={settings.tuneAllowBusy} onChange={(value) => settings.update({ tuneAllowBusy: value })} label={t("智能调优:允许后台负载")} />
              </SettingRow>
            </SettingsSection>

            <SettingsSection id="network" title={tf("网络诊断与修复", "Network diagnostics")} desc={tf("一键检测常见断网问题，按需修复", "Find common connectivity problems and fix them")}>
              <NetworkCard />
            </SettingsSection>
            <SettingsSection id="update" title={tf("更新", "Updates")}>
              <UpdateCard />
            </SettingsSection>
            <SettingsSection id="debug" title={tf("诊断", "Diagnostics")}>
              <DebugCard />
            </SettingsSection>
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * One-click debug export. Dumps the complete in-memory session log (every
 * CorePilot event since launch + warnings/errors/panics) into a fresh
 * `Downloads/CorePilot_Debug_<timestamp>/` folder and opens it in Explorer.
 */
function DebugCard() {
  const t = useT();
  const tf = useTf();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  function timestampName(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `CorePilot_Debug_${d.getFullYear()}_${p(d.getMonth() + 1)}_${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  async function run() {
    if (busy) return;
    setBusy(true);
    setResult(null);
    try {
      const dir = await api.exportDebugLogs(timestampName());
      setResult({ ok: true, text: dir });
      // Open the folder so the user can grab it immediately.
      await api.revealInExplorer(`${dir}\\corepilot.log`).catch(() => undefined);
    } catch (e: unknown) {
      const msg = typeof e === "string" ? e : e instanceof Error ? e.message : "导出失败";
      setResult({ ok: false, text: msg });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pb-3.5 pt-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-ink">{t("调试日志")}</div>
          <div className="mt-0.5 text-[12px] leading-relaxed text-muted">
            {t("将本次启动以来的完整日志保存到下载文件夹，便于反馈问题。")}
          </div>
        </div>
        <Button onClick={() => void run()} disabled={busy}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Bug size={14} />} {t("导出调试日志")}
        </Button>
      </div>
      {result && (
        <div
          className={cn(
            "mt-3 flex items-start gap-1.5 break-all rounded-lg px-3 py-2 text-[12px] ring-1 ring-inset",
            result.ok ? "bg-ok/10 text-ok ring-ok/25" : "bg-danger/10 text-danger ring-danger/25",
          )}
        >
          {result.ok ? <CheckCircle2 size={13} className="mt-0.5 shrink-0" /> : <AlertTriangle size={13} className="mt-0.5 shrink-0" />}
          <span className="min-w-0">
            {result.ok ? tf(`已保存到 ${result.text}`, `Saved to ${result.text}`) : tf(`导出失败：${result.text}`, `Export failed: ${result.text}`)}
          </span>
        </div>
      )}
    </div>
  );
}
