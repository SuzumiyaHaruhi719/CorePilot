import {
  FolderOpen,
  Gamepad2,
  ListPlus,
  MonitorPlay,
  Plus,
  RotateCcw,
  Search,
  ShieldCheck,
  Syringe,
  Trash2,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { Modal } from "../components/ui/Modal";
import { Segmented } from "../components/ui/Segmented";
import { Slider } from "../components/ui/Slider";
import { TabHeader } from "../components/ui/TabHeader";
import { Toggle } from "../components/ui/Toggle";
import { cn } from "../lib/cn";
import { api, type OverlayStatus, type ProcInfo } from "../lib/ipc";
import {
  OSD_CATEGORIES,
  OSD_METRICS,
  fetchOsdData,
  freePosStyle,
  layoutFlagsFromMetrics,
  type OsdCategory,
  type OsdData,
} from "../lib/osd";
import {
  effectiveConfig,
  useOsd,
  useOsdTargets,
  type OsdAppearance,
  type OsdConfig as OsdCfg,
} from "../store/osd";
import { OsdPlate } from "../osd/OsdPlate";

const EMPTY: OsdData = { metrics: null, sensors: null, gpu: null, fps: null };

function cfgOf(s: OsdCfg): OsdCfg {
  return {
    enabled: s.enabled,
    style: s.style,
    scale: s.scale,
    opacity: s.opacity,
    position: s.position,
    freeX: s.freeX,
    freeY: s.freeY,
    rounded: s.rounded,
    oledShift: s.oledShift,
    desktopMode: s.desktopMode,
    metrics: s.metrics,
  };
}

export function OsdConfig() {
  const osd = useOsd();
  const { targets, addTarget, removeTarget, setTargetList, updateTargetConfig } = useOsdTargets();
  const [cat, setCat] = useState<OsdCategory>("cpu");
  const [data, setData] = useState<OsdData>(EMPTY);
  const [selected, setSelected] = useState<string | null>(null);
  const [addName, setAddName] = useState("");
  // "Pick from running processes" picker state.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [procs, setProcs] = useState<ProcInfo[]>([]);
  const [procLoading, setProcLoading] = useState(false);
  const [procQuery, setProcQuery] = useState("");
  const previewRef = useRef<HTMLDivElement>(null);

  const selectedTarget = useMemo(
    () => targets.find((t) => t.name === selected) ?? null,
    [targets, selected],
  );

  // Global default as a plain config object (used for preview + as the base the
  // per-game override merges onto).
  const globalCfg = cfgOf(osd);

  // The config currently being previewed/edited: the selected game's effective
  // config when one is selected, else the global default.
  const previewCfg = selectedTarget
    ? effectiveConfig(globalCfg, selectedTarget.config)
    : globalCfg;

  // Live preview poll (only while this tab is mounted).
  const needGpu = previewCfg.metrics.some((k) => k.startsWith("gpu."));
  const needFps = previewCfg.metrics.includes("fps");
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const d = await fetchOsdData(needGpu, needFps);
      if (alive) setData(d);
    };
    void tick();
    const id = window.setInterval(() => void tick(), 1000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [needGpu, needFps]);

  // Push every default-config change to the live overlay window (no-op if closed).
  useEffect(() => useOsd.subscribe((s) => void emit("osd:cfg", cfgOf(s))), []);
  // Push every list change too, so the overlay re-resolves immediately.
  useEffect(
    () => useOsdTargets.subscribe((s) => void emit("osd:targets", { targets: s.targets })),
    [],
  );

  function setEnabled(enabled: boolean) {
    osd.setEnabled(enabled);
    // Keep the overlay window up if desktop mode still wants it.
    api.osdSetVisible(enabled || osd.desktopMode).catch(() => undefined);
  }

  // Appearance/metric editors operate on either the global default or the
  // selected game's override.
  const editingOverride = selectedTarget !== null;
  function applyPatch(patch: Partial<OsdCfg>) {
    if (selectedTarget) updateTargetConfig(selectedTarget.name, patch);
    else osd.update(patch);
  }
  // Free placement: drag the plate within the preview to set its normalized
  // top-left position (clamped to the box). The same coords drive the overlay.
  function onFreeDragStart(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    const box = previewRef.current;
    if (!box) return;
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    const move = (ev: PointerEvent) => {
      const rect = box.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      applyPatch({
        freeX: clamp((ev.clientX - rect.left) / rect.width),
        freeY: clamp((ev.clientY - rect.top) / rect.height),
      });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
  function toggleMetric(key: string) {
    if (selectedTarget) {
      const cur = previewCfg.metrics;
      const next = cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key];
      updateTargetConfig(selectedTarget.name, { metrics: next });
    } else {
      osd.toggleMetric(key);
    }
  }

  function submitAdd() {
    const n = addName.trim();
    if (!n) return;
    addTarget(n);
    setAddName("");
    setSelected(n.toLowerCase());
  }

  // Open the "pick from running processes" picker and (re)load the process list.
  async function openProcessPicker() {
    setProcQuery("");
    setPickerOpen(true);
    setProcLoading(true);
    try {
      const list = await api.listProcesses();
      setProcs(list);
    } catch {
      setProcs([]);
    } finally {
      setProcLoading(false);
    }
  }

  // Add a process by exe name from the picker, then close it.
  function pickProcess(name: string) {
    addTarget(name);
    setSelected(name.toLowerCase());
    setPickerOpen(false);
  }

  // Add one or more games by browsing to their .exe via a native file dialog —
  // works for games that aren't running yet (unlike the running-process picker).
  async function pickFromFile() {
    try {
      const names = await api.pickExeFiles();
      let last: string | null = null;
      for (const n of names) {
        addTarget(n);
        last = n.toLowerCase();
      }
      if (last) setSelected(last);
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
    <>
      <TabHeader
        icon={MonitorPlay}
        title="游戏内监控 OSD"
        subtitle="可定制的低占用游戏叠加层 — 适用于无边框 / 窗口化游戏，所有更改即时生效"
      />
      <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
        {/* Enable + preview */}
        <div className="glass hairline rounded-2xl p-4">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <div className="text-[14px] font-semibold text-ink">启用游戏内叠加</div>
              <div className="text-[12px] text-dim">总开关 — 关闭后所有游戏均不显示叠加层</div>
            </div>
            <Toggle checked={osd.enabled} onChange={setEnabled} />
          </div>

          <div className="mb-3 flex items-center justify-between border-t border-line/60 pt-3">
            <div>
              <div className="text-[13.5px] font-medium text-ink">桌面模式</div>
              <div className="text-[12px] text-dim">
                非游戏时也在桌面显示（仅 CPU / GPU / 内存 / 硬盘 / 网络，不含 FPS）
              </div>
            </div>
            <Toggle
              checked={osd.desktopMode}
              onChange={(v) => {
                osd.update({ desktopMode: v });
                // Desktop mode needs the overlay window too — show it now (or
                // hide if both this and the in-game master are off).
                api.osdSetVisible(v || osd.enabled).catch(() => undefined);
              }}
            />
          </div>

          {/* Live preview over a faux game backdrop */}
          <div className="relative overflow-hidden rounded-xl border border-line">
            <div
              ref={previewRef}
              className="relative flex min-h-[120px] p-2"
              style={{
                background:
                  "radial-gradient(120% 140% at 20% 0%, oklch(38% 0.08 250) 0%, oklch(16% 0.03 265) 60%), repeating-linear-gradient(135deg, oklch(20% 0.02 265) 0 14px, oklch(22% 0.02 265) 14px 28px)",
                alignItems:
                  previewCfg.position === "free"
                    ? undefined
                    : previewCfg.position.startsWith("t")
                      ? "flex-start"
                      : "flex-end",
                justifyContent:
                  previewCfg.position === "free"
                    ? undefined
                    : previewCfg.position.endsWith("l")
                      ? "flex-start"
                      : "flex-end",
              }}
            >
              {previewCfg.position === "free" ? (
                <div
                  className="absolute cursor-grab touch-none active:cursor-grabbing"
                  style={freePosStyle(previewCfg.freeX, previewCfg.freeY)}
                  onPointerDown={onFreeDragStart}
                >
                  <OsdPlate
                    metrics={previewCfg.metrics}
                    style={previewCfg.style}
                    scale={previewCfg.scale}
                    opacity={previewCfg.opacity}
                    rounded={previewCfg.rounded}
                    data={data}
                  />
                </div>
              ) : (
                <OsdPlate
                  metrics={previewCfg.metrics}
                  style={previewCfg.style}
                  scale={previewCfg.scale}
                  opacity={previewCfg.opacity}
                  rounded={previewCfg.rounded}
                  data={data}
                />
              )}
            </div>
            <span className="pointer-events-none absolute right-2 top-2 rounded bg-black/40 px-1.5 py-0.5 text-[10px] text-white/60">
              {editingOverride ? `预览 · ${selectedTarget?.name}` : "预览 · 默认"}
            </span>
            {previewCfg.position === "free" && (
              <span className="pointer-events-none absolute left-2 top-2 rounded bg-accent/25 px-1.5 py-0.5 text-[10px] text-white/85">
                拖动叠加层自由摆放
              </span>
            )}
          </div>
        </div>

        {/* In-frame injection overlay (true fullscreen) + anti-cheat-safe hybrid */}
        <InjectionOverlaySection metrics={previewCfg.metrics} />

        {/* Per-game white / black list */}
        <div className="glass hairline rounded-2xl p-4">
          <div className="mb-3 flex items-center gap-2">
            <Gamepad2 size={15} className="text-accent-bright" />
            <span className="text-[13.5px] font-semibold text-ink">游戏名单 / 白·黑名单</span>
          </div>
          <div className="mb-3 text-[11.5px] leading-relaxed text-dim">
            默认在识别为游戏的应用上自动显示；白名单 = 强制显示，黑名单 = 强制隐藏。
          </div>

          {/* Add by exe name */}
          <div className="mb-3 flex items-center gap-2">
            <input
              value={addName}
              onChange={(e) => setAddName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitAdd();
              }}
              placeholder="可执行文件名，如 cyberpunk2077.exe"
              className="no-drag w-72 rounded-lg border border-line bg-surface2 px-3 py-1.5 text-[12.5px] text-ink outline-none transition-colors focus:border-accent/50"
            />
            <button
              onClick={submitAdd}
              disabled={!addName.trim()}
              className="no-drag flex items-center gap-1.5 rounded-lg border border-line bg-surface2 px-2.5 py-1.5 text-[12px] text-muted transition-colors hover:bg-surface3 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Plus size={13} /> 添加
            </button>
            <button
              onClick={() => void openProcessPicker()}
              className="no-drag flex items-center gap-1.5 rounded-lg border border-line bg-surface2 px-2.5 py-1.5 text-[12px] text-muted transition-colors hover:bg-surface3 hover:text-ink"
            >
              <ListPlus size={13} /> 从运行中的进程选择
            </button>
            <button
              onClick={() => void pickFromFile()}
              className="no-drag flex items-center gap-1.5 rounded-lg border border-line bg-surface2 px-2.5 py-1.5 text-[12px] text-muted transition-colors hover:bg-surface3 hover:text-ink"
            >
              <FolderOpen size={13} /> 从文件选择
            </button>
          </div>

          {/* Entry list */}
          {targets.length === 0 ? (
            <div className="rounded-lg border border-dashed border-line/70 px-3 py-4 text-center text-[12px] text-dim">
              暂无游戏 — 在此添加，或在任务管理器中右键进程 → “添加游戏内覆盖”。
            </div>
          ) : (
            <div className="space-y-1.5">
              {targets.map((t) => {
                const isSel = t.name === selected;
                const hasOverride = t.config !== undefined;
                return (
                  <div
                    key={t.name}
                    className={cn(
                      "no-drag flex items-center gap-2 rounded-lg border px-3 py-2 text-[12.5px] transition-colors",
                      isSel ? "border-accent/40 bg-accent/10" : "border-line bg-surface2",
                    )}
                  >
                    <button
                      onClick={() => setSelected(isSel ? null : t.name)}
                      className="flex flex-1 items-center gap-2 text-left"
                    >
                      <MonitorPlay
                        size={13}
                        className={isSel ? "text-accent-bright" : "text-dim"}
                      />
                      <span className={cn("flex-1 truncate", isSel ? "text-ink" : "text-muted")}>
                        {t.name}
                      </span>
                      {hasOverride && (
                        <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent-bright">
                          自定义
                        </span>
                      )}
                    </button>
                    <Segmented
                      id={`osd-list-${t.name}`}
                      value={t.list}
                      onChange={(v) => setTargetList(t.name, v as "white" | "black")}
                      options={[
                        { value: "white", label: "强制显示" },
                        { value: "black", label: "强制隐藏" },
                      ]}
                    />
                    <button
                      onClick={() => {
                        removeTarget(t.name);
                        if (isSel) setSelected(null);
                      }}
                      className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-dim transition-colors hover:bg-danger/15 hover:text-danger"
                      title="移除"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {/* Per-game override controls */}
          {selectedTarget && (
            <div className="mt-3 rounded-xl border border-accent/30 bg-accent/5 p-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <span className="text-[12.5px] font-semibold text-ink">
                  “{selectedTarget.name}” 的叠加设置
                </span>
                <button
                  onClick={() => updateTargetConfig(selectedTarget.name, undefined)}
                  disabled={selectedTarget.config === undefined}
                  className="no-drag flex items-center gap-1.5 rounded-lg border border-line bg-surface2 px-2.5 py-1 text-[11.5px] text-muted transition-colors hover:bg-surface3 hover:text-ink disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <RotateCcw size={12} /> 用默认
                </button>
              </div>
              <div className="text-[11px] leading-relaxed text-dim">
                {selectedTarget.config === undefined
                  ? "当前沿用全局默认外观与监控项；在下方调整即为该游戏单独定制。"
                  : "已为该游戏单独定制；点“用默认”可还原为全局默认。"}
              </div>
            </div>
          )}
        </div>

        {/* Appearance settings (drive the default, or the selected game's override) */}
        <OsdAppearanceControls cfg={previewCfg} onChange={applyPatch} />

        {/* Monitoring content */}
        <div className="glass hairline rounded-2xl p-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-[13.5px] font-semibold text-ink">
              监控内容{editingOverride ? ` · ${selectedTarget?.name}` : "（默认）"}
            </span>
            <button
              onClick={() => applyPatch({ metrics: [] })}
              className="no-drag flex items-center gap-1.5 rounded-lg border border-line bg-surface2 px-2.5 py-1 text-[11.5px] text-muted transition-colors hover:bg-surface3 hover:text-ink"
            >
              <RotateCcw size={12} /> 全部清空
            </button>
          </div>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {OSD_CATEGORIES.map((c) => (
              <button
                key={c.id}
                onClick={() => setCat(c.id)}
                className={cn(
                  "no-drag rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition-colors",
                  cat === c.id ? "bg-accent/15 text-accent-bright" : "text-dim hover:bg-surface3 hover:text-ink",
                )}
              >
                {c.label}
              </button>
            ))}
          </div>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={cat}
              className="grid gap-2 sm:grid-cols-2"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.2, ease: [0.33, 1, 0.68, 1] }}
            >
              {OSD_METRICS.filter((m) => m.cat === cat).map((m) => {
                const on = previewCfg.metrics.includes(m.key);
                return (
                  <button
                    key={m.key}
                    disabled={!m.supported}
                    onClick={() => toggleMetric(m.key)}
                    className={cn(
                      "no-drag flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-[12.5px] transition-colors",
                      !m.supported
                        ? "cursor-not-allowed border-line/60 text-dim opacity-55"
                        : on
                          ? "border-accent/40 bg-accent/10 text-ink"
                          : "border-line bg-surface2 text-muted hover:bg-surface3 hover:text-ink",
                    )}
                  >
                    <span
                      className={cn(
                        "grid h-4 w-4 shrink-0 place-items-center rounded border transition-colors",
                        on && m.supported ? "border-accent bg-accent" : "border-line-strong",
                      )}
                    >
                      {on && m.supported && <span className="h-2 w-2 rounded-[2px] bg-white" />}
                    </span>
                    <span className="flex-1">{m.label}</span>
                    {!m.supported && <span className="text-[10.5px] text-dim">需 PresentMon</span>}
                  </button>
                );
              })}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

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
                    className="no-drag flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[12.5px] text-muted transition-colors hover:bg-accent/10 hover:text-ink"
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
    </>
  );
}

interface InjectionOverlaySectionProps {
  /** The currently-previewed metric selection — drives which rows the injected
   *  overlay draws (mapped to `layout_flags`). */
  metrics: readonly string[];
}

/** How often we re-check the foreground app + (re)attach while injection is on. */
const INJECT_POLL_MS = 1500;

/**
 * "游戏内叠加（注入）" — the MSI-Afterburner-style in-frame overlay that draws
 * inside the game's own back buffer (so it works in true exclusive fullscreen,
 * unlike the window overlay). It carries the SAFE hybrid: when the foreground
 * game is anti-cheat-protected or uses an API we can't hook, the backend refuses
 * to inject and transparently falls back to the window overlay — this section's
 * status line explains exactly what happened, so a user never gets silently
 * nothing (or, worse, a ban).
 */
function InjectionOverlaySection({ metrics }: InjectionOverlaySectionProps) {
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState<OverlayStatus | null>(null);
  // PID we currently have the injected overlay attached to (0 = none). A ref so
  // the poll loop can detach the previous game when the foreground changes
  // without re-subscribing the interval on every attach.
  const attachedPid = useRef(0);

  // Keep the latest layout flags in a ref so the steady-state poll uses the
  // user's current metric selection without restarting the interval.
  const layoutFlags = useMemo(() => layoutFlagsFromMetrics(metrics), [metrics]);
  const flagsRef = useRef(layoutFlags);
  flagsRef.current = layoutFlags;

  const detachCurrent = useCallback(async () => {
    const pid = attachedPid.current;
    if (pid !== 0) {
      attachedPid.current = 0;
      await api.overlayDetach(pid).catch(() => undefined);
    }
  }, []);

  // While enabled: poll the foreground app; inject when it's an injectable game
  // (detaching any previously-attached game first), else show the explanatory
  // status (the backend has already fallen back to the window overlay).
  useEffect(() => {
    if (!enabled) {
      // Turning off: detach whatever we attached.
      void detachCurrent();
      setStatus(null);
      return;
    }
    let alive = true;
    const tick = async () => {
      try {
        const st = await api.overlayStatus();
        if (!alive) return;
        if (st.mode === "inject") {
          // Re-attach when the foreground game changed; (re)attaching the same
          // pid is cheap and keeps the layout flags current.
          if (attachedPid.current !== st.target.pid) {
            if (attachedPid.current !== 0) await detachCurrent();
            const attached = await api.overlayAttach(st.target.pid, flagsRef.current);
            attachedPid.current = st.target.pid;
            if (alive) setStatus(attached);
          } else {
            // Refresh the layout flags on the live target.
            const attached = await api.overlayAttach(st.target.pid, flagsRef.current);
            if (alive) setStatus(attached);
          }
        } else {
          // Not injectable (anti-cheat / unsupported / no game): drop any prior
          // attach and surface the reason. The backend already chose the window
          // fallback when appropriate.
          if (attachedPid.current !== 0) await detachCurrent();
          if (alive) setStatus(st);
        }
      } catch {
        if (alive) setStatus(null);
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), INJECT_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [enabled, detachCurrent]);

  // Detach on unmount (leaving the tab) so we never leave a stale injection.
  useEffect(() => () => void detachCurrent(), [detachCurrent]);

  return (
    <div className="glass hairline rounded-2xl p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Syringe size={15} className="text-accent-bright" />
          <div>
            <div className="text-[13.5px] font-semibold text-ink">游戏内叠加（注入）</div>
            <div className="text-[12px] text-dim">
              注入式叠加，绘制在游戏画面内 — 支持独占全屏；自动检测反作弊并避让
            </div>
          </div>
        </div>
        <Toggle checked={enabled} onChange={setEnabled} />
      </div>

      {/* Anti-cheat safety note — always visible so the guarantee is explicit. */}
      <div className="mb-3 flex items-start gap-2 rounded-lg border border-line/60 bg-surface2/50 px-3 py-2">
        <ShieldCheck size={14} className="mt-0.5 shrink-0 text-ok" />
        <span className="text-[11.5px] leading-relaxed text-dim">
          检测到 EasyAntiCheat / BattlEye / Vanguard 等反作弊时
          <span className="text-muted">绝不注入</span>
          ，自动改用窗口叠加，避免误判封号。
        </span>
      </div>

      {/* Live status line for the foreground game. */}
      <InjectionStatusLine enabled={enabled} status={status} />
    </div>
  );
}

interface InjectionStatusLineProps {
  enabled: boolean;
  status: OverlayStatus | null;
}

/** The live status pill: colour + icon follow the resolved overlay mode so the
 *  user instantly sees "injected", "fell back to window (anti-cheat)", etc. */
function InjectionStatusLine({ enabled, status }: InjectionStatusLineProps) {
  if (!enabled) {
    return (
      <div className="rounded-lg border border-dashed border-line/70 px-3 py-2.5 text-center text-[12px] text-dim">
        开启后将自动叠加到前台游戏
      </div>
    );
  }
  if (!status) {
    return (
      <div className="rounded-lg border border-line bg-surface2 px-3 py-2.5 text-[12px] text-dim">
        正在检测前台游戏…
      </div>
    );
  }
  // Map mode → accent colour. Inject = success; window fallback = warning amber;
  // none = neutral.
  const tone =
    status.mode === "inject"
      ? "border-ok/40 bg-ok/10 text-ok"
      : status.mode === "window"
        ? "border-warn/40 bg-warn/10 text-warn"
        : "border-line bg-surface2 text-muted";
  return (
    <div className={cn("flex items-center gap-2 rounded-lg border px-3 py-2.5 text-[12.5px]", tone)}>
      {status.mode === "inject" ? (
        <Syringe size={14} className="shrink-0" />
      ) : status.mode === "window" ? (
        <MonitorPlay size={14} className="shrink-0" />
      ) : (
        <Gamepad2 size={14} className="shrink-0" />
      )}
      <span className="flex-1">{status.reason}</span>
      {status.target.pid !== 0 && (
        <span className="shrink-0 rounded bg-black/20 px-1.5 py-0.5 text-[10.5px] opacity-80">
          PID {status.target.pid}
        </span>
      )}
    </div>
  );
}

interface OsdAppearanceControlsProps {
  cfg: OsdAppearance;
  onChange: (patch: Partial<OsdCfg>) => void;
}

/** The shared style / position / scale / opacity / rounded controls, driven by a
 *  config value + a patch callback so the same UI edits either the global default
 *  or a selected game's per-game override. */
function OsdAppearanceControls({ cfg, onChange }: OsdAppearanceControlsProps) {
  return (
    <div className="glass hairline grid gap-4 rounded-2xl p-4 sm:grid-cols-2">
      <Row label="布局样式">
        <Segmented
          id="osd-style"
          value={cfg.style}
          onChange={(v) => onChange({ style: v as OsdCfg["style"] })}
          options={[
            { value: "horizontal", label: "横向" },
            { value: "vertical", label: "竖排" },
          ]}
        />
      </Row>
      <Row label="屏幕位置">
        <Segmented
          id="osd-pos"
          value={cfg.position}
          onChange={(v) => onChange({ position: v as OsdCfg["position"] })}
          options={[
            { value: "tl", label: "左上" },
            { value: "tr", label: "右上" },
            { value: "bl", label: "左下" },
            { value: "br", label: "右下" },
            { value: "free", label: "自由" },
          ]}
        />
      </Row>
      <div className="sm:col-span-1">
        <Slider
          label="字体大小"
          value={Math.round(cfg.scale * 100)}
          min={80}
          max={200}
          step={10}
          unit="%"
          onChange={(v) => onChange({ scale: v / 100 })}
        />
      </div>
      <div className="sm:col-span-1">
        <Slider
          label="背景不透明度"
          value={Math.round(cfg.opacity * 100)}
          min={0}
          max={90}
          step={5}
          unit="%"
          onChange={(v) => onChange({ opacity: v / 100 })}
        />
      </div>
      <Row label="圆角背板">
        <Toggle checked={cfg.rounded} onChange={(v) => onChange({ rounded: v })} />
      </Row>
      <Row label="OLED 防烧屏">
        <Toggle checked={cfg.oledShift} onChange={(v) => onChange({ oledShift: v })} />
      </Row>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[12.5px] text-muted">{label}</span>
      <div className="no-drag shrink-0">{children}</div>
    </div>
  );
}
