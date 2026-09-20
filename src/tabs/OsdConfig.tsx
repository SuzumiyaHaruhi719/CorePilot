import {
  AlertTriangle,
  ChevronRight,
  Eye,
  EyeOff,
  FolderOpen,
  Gamepad2,
  ListPlus,
  Loader2,
  Monitor,
  MonitorPlay,
  Palette,
  Plus,
  RotateCcw,
  Search,
  ShieldCheck,
  Syringe,
  Trash2,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { Modal } from "../components/ui/Modal";
import { Segmented } from "../components/ui/Segmented";
import { Slider } from "../components/ui/Slider";
import { TabHeader } from "../components/ui/TabHeader";
import { Toggle } from "../components/ui/Toggle";
import { useSharedGpuOc, useSharedMetrics, useSharedSensors } from "../hooks/useSharedTelemetry";
import { useUiActive } from "../hooks/useUiActive";
import { cn } from "../lib/cn";
import { useTf } from "../lib/i18n";
import {
  api,
  type ForegroundInfo,
  type GameEntry,
  type OsdFpsStats,
  type OverlayStatus,
  type ProcInfo,
} from "../lib/ipc";
import {
  OSD_CATEGORIES,
  OSD_METRICS,
  freePosStyle,
  type OsdCategory,
  type OsdData,
  type OsdMetricDef,
} from "../lib/osd";
import { useSettings } from "../store/settings";
import {
  TASKBAR_DEFAULTS,
  TBMON_DEFAULTS,
  effectiveConfig,
  explainOsd,
  useOsd,
  useOsdTargets,
  useOverlayStatus,
  type OsdAppearance,
  type OsdConfig as OsdCfg,
  type OsdVisibility,
  type TbBarPosition,
} from "../store/osd";
import { OsdPlate } from "../osd/OsdPlate";

/**
 * Keyboard-focus ring for this tab's raw `<button>`s. The UI-kit controls
 * (Toggle / Segmented / Slider) carry their own; these hand-rolled buttons —
 * the metric tiles, category tabs and list rows — had none, so tabbing through
 * the content picker left no visible focus anywhere. Same token as the table
 * headers so the whole app rings identically.
 */
const FOCUS_RING = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60";

/** Corner labels for the status line ("位置 左上"). Kept bilingual here rather
 *  than reusing the Segmented options, which are Chinese-only by design. */
const POSITION_LABEL: Record<OsdCfg["position"], [zh: string, en: string]> = {
  tl: ["左上", "top-left"],
  tc: ["上中", "top-center"],
  tr: ["右上", "top-right"],
  bl: ["左下", "bottom-left"],
  bc: ["下中", "bottom-center"],
  br: ["右下", "bottom-right"],
  free: ["自由摆放", "free placement"],
};

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
    inject: s.inject,
    metrics: s.metrics,
    tbColorsEnabled: s.tbColorsEnabled,
    tbBg: s.tbBg,
    tbLabel: s.tbLabel,
    tbSafe: s.tbSafe,
    tbWarn: s.tbWarn,
    tbCrit: s.tbCrit,
    tbWarnLoad: s.tbWarnLoad,
    tbCritLoad: s.tbCritLoad,
    tbWarnTemp: s.tbWarnTemp,
    tbCritTemp: s.tbCritTemp,
    tbEnabled: s.tbEnabled,
    tbSingleLine: s.tbSingleLine,
    tbBarPosition: s.tbBarPosition,
    tbOffset: s.tbOffset,
    tbCustomLayout: s.tbCustomLayout,
    tbSize: s.tbSize,
    tbBold: s.tbBold,
    tbItemSpace: s.tbItemSpace,
    tbInnerSpace: s.tbInnerSpace,
    tbPadding: s.tbPadding,
    tbMetrics: s.tbMetrics,
  };
}

export function OsdConfig() {
  const tf = useTf();
  const osd = useOsd();
  const { targets, addTarget, removeTarget, setTargetList, updateTargetConfig } = useOsdTargets();
  const [cat, setCat] = useState<OsdCategory>("cpu");
  const [selected, setSelected] = useState<string | null>(null);
  const [addName, setAddName] = useState("");
  // "Pick from running processes" picker state.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [procs, setProcs] = useState<ProcInfo[]>([]);
  const [procLoading, setProcLoading] = useState(false);
  const [procErr, setProcErr] = useState(false);
  const [procQuery, setProcQuery] = useState("");
  // Transient free-placement position held only while dragging the plate, so the
  // preview follows the pointer smoothly without writing the persisted store on
  // every move; the final position is committed once on pointer-up.
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  // Detaches the in-flight free-placement drag's window listeners. Held in a ref
  // so an unmount mid-drag can tear them down (otherwise the pointermove/pointerup
  // handlers leak and could setState on the unmounted component).
  const dragCleanupRef = useRef<(() => void) | null>(null);

  const selectedTarget = useMemo(
    () => targets.find((t) => t.name === selected) ?? null,
    [targets, selected],
  );

  // Global default as a plain config object (used for preview + as the base the
  // per-game override merges onto). Memoized so the identity only moves when the
  // store does — the memoized editor subtrees below take it (via previewCfg) as
  // a prop, and a fresh object every telemetry tick would defeat them.
  const globalCfg = useMemo(() => cfgOf(osd), [osd]);

  // The config currently being previewed/edited: the selected game's effective
  // config when one is selected, else the global default.
  const previewCfg = useMemo(
    () => (selectedTarget ? effectiveConfig(globalCfg, selectedTarget.config) : globalCfg),
    [globalCfg, selectedTarget],
  );

  const needGpu = previewCfg.metrics.some((k) => k.startsWith("gpu."));
  const needFps = previewCfg.metrics.includes("fps");

  // Preview telemetry rides the SHARED pollers (one interval app-wide, skipped
  // while nobody can see the window) instead of this tab's old private 1 Hz
  // loop, which fired 2–4 extra IPCs a second on top of whatever StatusBar and
  // the history recorder were already asking for.
  //
  // `useSharedGpuOc` is subscribed unconditionally because hooks can't be
  // conditional; the value is gated on `needGpu` below so an all-CPU layout
  // still previews without GPU numbers. The subscription itself is cheap: the
  // NVML poller pauses outright while the UI is inactive, and the default
  // metric set contains gpu.* anyway.
  const sharedMetrics = useSharedMetrics();
  const sharedSensors = useSharedSensors();
  const sharedGpu = useSharedGpuOc();

  // Foreground app + frame pacing. These two have no shared poller (the FPS
  // stats are only interesting on this tab and the overlay window), so they keep
  // one local interval — aligned to `pollMs` and gated on `useUiActive` so it
  // goes quiet the moment the window is covered by the game being measured.
  const pollMs = useSettings((s) => s.pollMs);
  const uiActive = useUiActive((s) => s.active);
  const [fg, setFg] = useState<ForegroundInfo | null>(null);
  const [fps, setFps] = useState<OsdFpsStats | null>(null);
  useEffect(() => {
    if (!uiActive) return;
    let alive = true;
    let inFlight = false;
    const tick = async () => {
      // Backpressure: `foreground_info` can take seconds when its library-root
      // cache expires (it shells out to reg.exe). Never queue a second one.
      if (inFlight) return;
      inFlight = true;
      try {
        const [info, stats] = await Promise.all([
          api.foregroundInfo().catch(() => null),
          needFps ? api.osdFpsStats().catch(() => null) : Promise.resolve(null),
        ]);
        if (!alive) return;
        // Two rules here, both learned the hard way:
        //  - A failed read (null) KEEPS the last good value. Letting a transient
        //    backend hiccup reset this to null would flip the status line back
        //    to "detecting the foreground window…", i.e. report a glitch as
        //    "nothing running yet" — the same misrepresentation the injection
        //    status line already guards against.
        //  - An identical reading is dropped instead of re-set. The foreground
        //    barely ever changes while the user sits on this tab, and a fresh
        //    object every tick would re-render the whole editor tree for nothing.
        setFg((prev) => {
          if (!info) return prev;
          return prev && prev.exe === info.exe && prev.pid === info.pid && prev.isGame === info.isGame
            ? prev
            : info;
        });
        setFps((prev) => {
          // Not asking for FPS at all → clear it, so the plate stops showing a
          // frozen number after the user unticks the metric.
          if (!needFps) return null;
          if (!stats) return prev;
          return prev &&
            prev.fps === stats.fps &&
            prev.frametimeMs === stats.frametimeMs &&
            prev.low1 === stats.low1 &&
            prev.low01 === stats.low01
            ? prev
            : stats;
        });
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), Math.max(1000, pollMs));
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [needFps, pollMs, uiActive]);

  const data = useMemo<OsdData>(
    () => ({
      metrics: sharedMetrics,
      sensors: sharedSensors,
      gpu: needGpu ? sharedGpu : null,
      fps: needFps ? fps : null,
    }),
    [sharedMetrics, sharedSensors, sharedGpu, fps, needGpu, needFps],
  );

  // Why the overlay is (or isn't) on screen right now — derived from the SAME
  // resolver the overlay window uses, so this line can't contradict it.
  const visibility = useMemo(
    () => explainOsd(globalCfg, targets, fg?.exe ?? null, fg?.isGame ?? false),
    [globalCfg, targets, fg],
  );

  // NOTE: the standing osd:cfg / osd:targets mirroring now lives in <App> (always
  // mounted, 16 ms-coalesced) so the global hotkey reaches the overlay from any
  // tab. This tab keeps only the transient drag-follow emit below.

  const [overlayErr, setOverlayErr] = useState<string | null>(null);
  function setEnabled(enabled: boolean) {
    osd.setEnabled(enabled);
    setOverlayErr(null);
    // Keep the overlay window up if desktop mode still wants it. Surface an error
    // if the native call fails, but DON'T roll the toggle back — a transient
    // rejection shouldn't silently switch the overlay the user just enabled off
    // (that broke the desktop OSD). The intent persists; the banner shows the issue.
    api.osdSetVisible(enabled || osd.desktopMode).catch(() => {
      setOverlayErr(tf("叠加层窗口打开失败", "Failed to open the overlay window"));
    });
  }

  // Appearance/metric editors operate on either the global default or the
  // selected game's override. Stable identity (it only depends on WHICH target
  // is selected) so `memo(OsdAppearanceControls)` isn't invalidated every tick.
  const editingOverride = selectedTarget !== null;
  const selectedName = selectedTarget?.name ?? null;
  const applyPatch = useCallback(
    (patch: Partial<OsdCfg>) => {
      if (selectedName) updateTargetConfig(selectedName, patch);
      else useOsd.getState().update(patch);
    },
    [selectedName, updateTargetConfig],
  );

  // Preview = a short, to-scale-ish mini-monitor at the real display aspect ratio
  // (window.screen, 16:9 fallback). The plate is scaled toward its real footprint
  // but clamped to a visible-yet-fitting range so the marker is neither an
  // invisible speck nor wider than the box.
  const screenAspect = useMemo(() => {
    const w = window.screen?.width ?? 0;
    const h = window.screen?.height ?? 0;
    return w > 0 && h > 0 ? w / h : 16 / 9;
  }, []);
  const [boxW, setBoxW] = useState(0);
  useEffect(() => {
    const el = previewRef.current;
    if (!el) return;
    const measure = () => setBoxW(el.getBoundingClientRect().width);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Safety net: if the tab unmounts while a free-placement drag is still in
  // flight, tear down its window-level pointer listeners so they can't leak or
  // fire on the unmounted component.
  useEffect(() => () => dragCleanupRef.current?.(), []);
  // Auto-discovered installed-game library (Steam/Epic/GOG) — read-only; the
  // backend matches foreground EXEs against these install roots to detect games.
  const [gameLibrary, setGameLibrary] = useState<GameEntry[]>([]);
  const [libState, setLibState] = useState<"loading" | "ok" | "error">("loading");
  useEffect(() => {
    api
      .gameLibraryList()
      .then((g) => {
        setGameLibrary(g);
        setLibState("ok");
      })
      .catch(() => setLibState("error"));
  }, []);

  const previewScale = Math.min(0.85, Math.max(0.5, boxW > 0 ? boxW / (window.screen?.width || 1920) : 0.5));

  // Free placement: drag the plate within the preview to set its normalized
  // top-left position (clamped to the box). The same coords drive the overlay.
  //
  // While dragging we keep the position in transient local state (`dragPos`) so
  // the preview follows the pointer at full frame rate, and — only for the global
  // default — push the live position straight to the overlay window so it follows
  // too, WITHOUT touching the persisted store. The final position is committed to
  // the store exactly once on pointer-up (a per-frame store write would thrash
  // the tauri-store backed persist on every move).
  function onFreeDragStart(e: React.PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    const box = previewRef.current;
    if (!box) return;
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    let latest = { x: previewCfg.freeX ?? 0, y: previewCfg.freeY ?? 0 };
    const move = (ev: PointerEvent) => {
      const rect = box.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      latest = {
        x: clamp((ev.clientX - rect.left) / rect.width),
        y: clamp((ev.clientY - rect.top) / rect.height),
      };
      setDragPos(latest);
      // Live overlay follow for the global default (the standing `osd:cfg`
      // subscription only ever emits the global config). Per-game drags still
      // preview locally and commit on pointer-up.
      if (!selectedTarget) {
        void emit("osd:cfg", { ...globalCfg, freeX: latest.x, freeY: latest.y });
      }
    };
    const detach = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      dragCleanupRef.current = null;
    };
    const up = () => {
      detach();
      // Commit the final position to the persisted store, then drop transient state.
      applyPatch({ freeX: latest.x, freeY: latest.y });
      setDragPos(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    dragCleanupRef.current = detach;
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
    setProcErr(false);
    try {
      const list = await api.listProcesses();
      setProcs(list);
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
        {/* 显示方式 · MODE — the three overlay layers as ONE decision.
            They used to be three switches in two different cards (window
            overlay + desktop mode here, injection in its own panel below) with
            no statement of how they relate, so "which one do I need?" had no
            answer on screen. Grouped here with a 适用于 line each, then the live
            verdict underneath. */}
        <div className="hud-frame glass hairline rounded-2xl p-4">
          <div className="mb-3 flex items-center gap-2">
            <MonitorPlay size={14} className="shrink-0 text-accent-bright" />
            <span className="hud-label text-[10.5px] text-dim">
              {tf("显示方式 · MODE", "MODE")}
            </span>
            <span className="h-px flex-1 bg-line/50" />
          </div>
          <div className="mb-3 text-[11.5px] leading-relaxed text-dim">
            {tf(
              "三种方式互不冲突，可同时开启：窗口叠加负责无边框 / 窗口化游戏，桌面模式负责非游戏时段，注入负责独占全屏。",
              "The three layers don't conflict and can all be on: the window overlay covers borderless / windowed games, desktop mode covers non-game time, injection covers exclusive fullscreen.",
            )}
          </div>

          {/* Own wrapper so `first:` actually matches the first ModeRow — the
              card header and the intro paragraph are siblings too. */}
          <div>
          <ModeRow
            icon={MonitorPlay}
            title={tf("窗口叠加", "Window overlay")}
            desc={tf(
              "检测到游戏自动在前台显示，切到后台自动隐藏；不注入、最安全。",
              "Appears automatically when a game is in the foreground and hides when it isn't. No injection — the safest path.",
            )}
            applies={tf(
              "适用于：无边框 / 窗口化游戏",
              "Best for: borderless / windowed games",
            )}
            checked={osd.enabled}
            onChange={setEnabled}
          />
          <ModeRow
            icon={Monitor}
            title={tf("桌面模式", "Desktop mode")}
            desc={tf(
              "非游戏时也常驻显示（仅 CPU / GPU / 内存 / 硬盘 / 网络，无 FPS）。",
              "Keeps the overlay up outside games (CPU / GPU / memory / disk / network only — no FPS).",
            )}
            applies={tf("适用于：桌面、办公、看监控数字", "Best for: desktop, work, watching the numbers")}
            checked={osd.desktopMode}
            onChange={(v) => {
              osd.update({ desktopMode: v });
              setOverlayErr(null);
              // Desktop mode needs the overlay window too — show it now (or hide
              // if both this and the in-game master are off). Surface an error on
              // failure but keep the user's choice (don't auto-disable).
              api.osdSetVisible(v || osd.enabled).catch(() => {
                setOverlayErr(tf("叠加层窗口打开失败", "Failed to open the overlay window"));
              });
            }}
          />
          <ModeRow
            icon={Syringe}
            title={tf("游戏内叠加（注入）", "In-game overlay (injection)")}
            desc={tf(
              "绘制在游戏画面内，独占全屏也能显示；检测到反作弊会自动避让。",
              "Drawn inside the game's own frame, so it survives exclusive fullscreen. Backs off automatically when anti-cheat is present.",
            )}
            applies={tf("适用于：独占全屏游戏", "Best for: exclusive-fullscreen games")}
            checked={osd.inject}
            onChange={(v) => osd.update({ inject: v })}
          />
          </div>

          {/* The overlay-window error outranks the status line: if the window
              itself failed to open, nothing below it is meaningful. */}
          {overlayErr ? (
            <div className="mt-3 flex items-center gap-1.5 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2.5 text-[12px] text-danger">
              <AlertTriangle size={13} className="shrink-0" /> {overlayErr}
            </div>
          ) : (
            <OverlayStatusLine
              vis={visibility}
              detecting={fg === null}
              // The position the CURRENT foreground app gets, which a per-game
              // override can move away from the global default shown above.
              position={visibility.config?.position ?? globalCfg.position}
              desktopMode={osd.desktopMode}
            />
          )}

          {/* Live preview = a short, centered mini-monitor at the display aspect
              ratio (fixed height so it always fits the panel above the fold). */}
          <div className="mb-2 mt-4 flex items-center justify-center gap-2">
            <span className="h-px w-8 bg-line/60" />
            <span className="hud-label flex items-center gap-1.5 text-[10px] text-dim">
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-ok" />
              {tf("实时预览 · LIVE PREVIEW", "LIVE PREVIEW")}
            </span>
            <span className="h-px w-8 bg-line/60" />
          </div>
          <div
            className="hud-frame relative mx-auto overflow-hidden rounded-xl border border-line-strong glow-sm"
            style={{ height: 170, width: 170 * screenAspect, maxWidth: "100%" }}
          >
            <div
              ref={previewRef}
              className="absolute inset-0 flex p-2"
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
                    : previewCfg.position === "tc" || previewCfg.position === "bc"
                      ? "center"
                      : previewCfg.position.endsWith("l")
                        ? "flex-start"
                        : "flex-end",
              }}
            >
              {previewCfg.position === "free" ? (
                <div
                  className="absolute cursor-grab touch-none active:cursor-grabbing"
                  style={freePosStyle(
                    dragPos?.x ?? previewCfg.freeX,
                    dragPos?.y ?? previewCfg.freeY,
                  )}
                  onPointerDown={onFreeDragStart}
                >
                  <OsdPlate
                    metrics={previewCfg.metrics}
                    style={previewCfg.style}
                    scale={previewCfg.scale * previewScale}
                    opacity={previewCfg.opacity}
                    rounded={previewCfg.rounded}
                    data={data}
                    taskbar={false}
                    tbColorsEnabled={previewCfg.tbColorsEnabled}
                    tbBg={previewCfg.tbBg}
                    tbLabel={previewCfg.tbLabel}
                    tbSafe={previewCfg.tbSafe}
                    tbWarn={previewCfg.tbWarn}
                    tbCrit={previewCfg.tbCrit}
                    tbWarnLoad={previewCfg.tbWarnLoad}
                    tbCritLoad={previewCfg.tbCritLoad}
                    tbWarnTemp={previewCfg.tbWarnTemp}
                    tbCritTemp={previewCfg.tbCritTemp}
                  />
                </div>
              ) : (
                <OsdPlate
                  metrics={previewCfg.metrics}
                  style={previewCfg.style}
                  scale={previewCfg.scale * previewScale}
                  opacity={previewCfg.opacity}
                  rounded={previewCfg.rounded}
                  data={data}
                  taskbar={false}
                  tbColorsEnabled={previewCfg.tbColorsEnabled}
                  tbBg={previewCfg.tbBg}
                  tbLabel={previewCfg.tbLabel}
                  tbSafe={previewCfg.tbSafe}
                  tbWarn={previewCfg.tbWarn}
                  tbCrit={previewCfg.tbCrit}
                  tbWarnLoad={previewCfg.tbWarnLoad}
                  tbCritLoad={previewCfg.tbCritLoad}
                  tbWarnTemp={previewCfg.tbWarnTemp}
                  tbCritTemp={previewCfg.tbCritTemp}
                />
              )}
            </div>
            <span className="pointer-events-none absolute right-2 top-2 rounded bg-black/40 px-1.5 py-0.5 text-[10px] text-white/60">
              {editingOverride
                ? tf(`预览 · ${selectedTarget?.name}`, `Preview · ${selectedTarget?.name}`)
                : tf("预览 · 默认", "Preview · default")}
            </span>
            {previewCfg.position === "free" && (
              <span className="pointer-events-none absolute left-2 top-2 rounded bg-accent/25 px-1.5 py-0.5 text-[10px] text-white/85">
                {tf("拖动叠加层自由摆放", "Drag the plate to place it freely")}
              </span>
            )}
          </div>
        </div>

        {/* In-frame injection overlay (true fullscreen) + anti-cheat-safe hybrid */}
        <InjectionOverlaySection />

        {/* Auto-discovered installed-game library (read-only) */}
        <div className="glass hairline rounded-2xl p-4">
          <div className="mb-2 flex items-center gap-2">
            <Gamepad2 size={15} className="text-accent-bright" />
            <span className="text-[13.5px] font-semibold text-ink">已识别的游戏库</span>
            <span className="text-[11px] text-dim">{tf(`Steam · Epic · GOG · 共 ${gameLibrary.length} 款`, `Steam · Epic · GOG · ${gameLibrary.length} games`)}</span>
          </div>
          <div className="mb-3 text-[11.5px] leading-relaxed text-dim">
            自动扫描各启动器安装目录;运行其中任意一款都会被判定为游戏(无需手动加白名单)。
          </div>
          {libState === "loading" ? (
            <div className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-line/70 px-3 py-3 text-[12px] text-dim">
              <Loader2 size={13} className="animate-spin" /> {tf("正在扫描已安装游戏…", "Scanning installed games…")}
            </div>
          ) : libState === "error" ? (
            <div className="flex items-center justify-center gap-1.5 rounded-lg border border-dashed border-danger/40 px-3 py-3 text-[12px] text-danger">
              <AlertTriangle size={13} /> {tf("扫描游戏库失败", "Couldn't scan the game library")}
            </div>
          ) : gameLibrary.length === 0 ? (
            <div className="rounded-lg border border-dashed border-line/70 px-3 py-3 text-center text-[12px] text-dim">
              未扫描到已安装游戏（未安装 Steam/Epic/GOG，或装在非默认位置）。
            </div>
          ) : (
            <div className="max-h-44 space-y-1 overflow-y-auto pr-1">
              {gameLibrary.map((g) => (
                <div
                  key={`${g.source}:${g.path}`}
                  className="flex items-center gap-2 rounded-lg border border-line bg-surface2 px-3 py-1.5 text-[12px]"
                >
                  <MonitorPlay size={12} className="shrink-0 text-dim" />
                  <span className="flex-1 truncate text-muted" title={g.path}>
                    {g.name}
                  </span>
                  <span className="shrink-0 rounded bg-surface3 px-1.5 py-0.5 text-[10px] text-dim">
                    {g.source}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

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
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <input
              value={addName}
              onChange={(e) => setAddName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitAdd();
              }}
              placeholder="可执行文件名，如 cyberpunk2077.exe"
              className="no-drag w-72 min-w-0 flex-1 rounded-lg border border-line bg-surface2 px-3 py-1.5 text-[12.5px] text-ink outline-none transition-colors focus:border-accent/50"
            />
            <button
              onClick={submitAdd}
              disabled={!addName.trim()}
              className={cn(
                "no-drag flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-surface2 px-2.5 py-1.5 text-[12px] text-muted transition-colors hover:bg-surface3 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40",
                FOCUS_RING,
              )}
            >
              <Plus size={13} /> 添加
            </button>
            <button
              onClick={() => void openProcessPicker()}
              className={cn(
                "no-drag flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-surface2 px-2.5 py-1.5 text-[12px] text-muted transition-colors hover:bg-surface3 hover:text-ink",
                FOCUS_RING,
              )}
            >
              <ListPlus size={13} /> 从运行中的进程选择
            </button>
            <button
              onClick={() => void pickFromFile()}
              className={cn(
                "no-drag flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-surface2 px-2.5 py-1.5 text-[12px] text-muted transition-colors hover:bg-surface3 hover:text-ink",
                FOCUS_RING,
              )}
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
                      className={cn(
                        "flex flex-1 cursor-pointer items-center gap-2 rounded-md text-left",
                        FOCUS_RING,
                      )}
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
                      className={cn(
                        "grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-lg text-dim transition-colors hover:bg-danger/15 hover:text-danger",
                        FOCUS_RING,
                      )}
                      title="移除"
                      aria-label={tf(`移除 ${t.name}`, `Remove ${t.name}`)}
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
                  {tf(`“${selectedTarget.name}” 的叠加设置`, `Overlay settings for “${selectedTarget.name}”`)}
                </span>
                <button
                  onClick={() => updateTargetConfig(selectedTarget.name, undefined)}
                  disabled={selectedTarget.config === undefined}
                  className={cn(
                    "no-drag flex cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-surface2 px-2.5 py-1 text-[11.5px] text-muted transition-colors hover:bg-surface3 hover:text-ink disabled:cursor-not-allowed disabled:opacity-45",
                    FOCUS_RING,
                  )}
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

        {/* Taskbar Monitor — an INDEPENDENT second overlay docked on the Windows
            taskbar, with its own enable toggle (coexists with the corner/free
            OSD above; turning it on never moves that OSD). All of its settings —
            layout, custom layout, its own metric content, and colors — live in
            ONE foldable panel. Binds DIRECTLY to the global useOsd store (not the
            per-game previewCfg/applyPatch path), because the native taskbar
            monitor is global. */}
        <TaskbarMonitorPanel />

        {/* Monitoring content */}
        <div className="glass hairline rounded-2xl p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <MonitorPlay size={14} className="shrink-0 text-accent-bright" />
              <span className="hud-label truncate text-[10.5px] text-dim">
                {tf("监控内容 · CONTENT", "CONTENT")}{editingOverride ? ` · ${selectedTarget?.name}` : ""}
              </span>
              <span className="rounded bg-surface2 px-1.5 py-0.5 text-[10px] text-dim">
                {tf("已选", "Selected")} <span className="nums text-muted">{previewCfg.metrics.length}</span>
              </span>
            </div>
            <button
              onClick={() => applyPatch({ metrics: [] })}
              disabled={previewCfg.metrics.length === 0}
              className={cn(
                "no-drag flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-surface2 px-2.5 py-1 text-[11.5px] text-muted transition-colors hover:bg-surface3 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40",
                FOCUS_RING,
              )}
            >
              <RotateCcw size={12} /> {tf("全部清空", "Clear all")}
            </button>
          </div>
          <div className="mb-3 flex flex-wrap gap-1.5">
            {OSD_CATEGORIES.map((c) => (
              <button
                key={c.id}
                onClick={() => setCat(c.id)}
                className={cn(
                  "no-drag cursor-pointer rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition-colors",
                  FOCUS_RING,
                  cat === c.id ? "bg-accent/15 text-accent-bright glow-sm" : "text-dim hover:bg-surface3 hover:text-ink",
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
                      FOCUS_RING,
                      !m.supported
                        ? "cursor-not-allowed border-line/60 text-dim opacity-55"
                        : on
                          ? "cursor-pointer border-accent/40 bg-accent/10 text-ink"
                          : "cursor-pointer border-line bg-surface2 text-muted hover:bg-surface3 hover:text-ink",
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
                    className={cn(
                      "no-drag flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-left text-[12.5px] text-muted transition-colors hover:bg-accent/10 hover:text-ink",
                      FOCUS_RING,
                    )}
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


interface ModeRowProps {
  icon: typeof MonitorPlay;
  title: string;
  desc: string;
  /** One-line "适用于 …" — the thing that tells the user WHICH mode they need. */
  applies: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}

/** One row of the 显示方式 · MODE block. Deliberately uniform across the three
 *  layers so they read as alternatives to weigh, not as unrelated features. */
function ModeRow({ icon: Icon, title, desc, applies, checked, onChange }: ModeRowProps) {
  return (
    <div className="flex items-start justify-between gap-3 border-t border-line/60 py-2.5 first:border-t-0 first:pt-0">
      <div className="flex min-w-0 items-start gap-2">
        <Icon
          size={14}
          className={cn("mt-0.5 shrink-0 transition-colors", checked ? "text-accent-bright" : "text-dim")}
        />
        <div className="min-w-0">
          <div className="text-[13.5px] font-medium text-ink">{title}</div>
          <div className="text-[12px] leading-relaxed text-dim">{desc}</div>
          <div className="mt-0.5 text-[11px] leading-relaxed text-dim/80">{applies}</div>
        </div>
      </div>
      <div className="no-drag shrink-0 pt-0.5">
        <Toggle checked={checked} onChange={onChange} />
      </div>
    </div>
  );
}

interface OverlayStatusLineProps {
  vis: OsdVisibility;
  /** True until the first `foreground_info` read lands. */
  detecting: boolean;
  position: OsdCfg["position"];
  desktopMode: boolean;
}

/**
 * The live "is the overlay on screen, and why" line.
 *
 * This is the answer to the report that drove this whole pass: "the OSD
 * disappears after a while". With the default store (`enabled` on, everything
 * else off) an overlay that is simply waiting for a game looks identical to a
 * broken one, and nothing on this tab said which it was — the injection status
 * line below only renders once injection is on, which is exactly the switch
 * such a user has NOT touched.
 */
function OverlayStatusLine({ vis, detecting, position, desktopMode }: OverlayStatusLineProps) {
  const tf = useTf();
  if (detecting) {
    return (
      <div className="mt-3 rounded-lg border border-line bg-surface2 px-3 py-2.5 text-[12px] text-dim">
        {tf("正在检测前台窗口…", "Detecting the foreground window…")}
      </div>
    );
  }
  // `exe` is null when the foreground window can't be resolved (a shell surface,
  // an elevated window we can't open). Name it rather than printing "null".
  const exe = vis.exe ?? tf("前台窗口", "the foreground window");
  const pos = tf(...POSITION_LABEL[position]);

  let text: string;
  switch (vis.kind) {
    case "shown-game":
      text = tf(
        `显示中 · 前台 ${exe} 已识别为游戏 · 位置 ${pos}`,
        `Showing · ${exe} detected as a game · ${pos}`,
      );
      break;
    case "shown-desktop":
      text = tf(`显示中 · 桌面模式 · 位置 ${pos}`, `Showing · desktop mode · ${pos}`);
      break;
    case "hidden-blacklist":
      text = tf(
        `已隐藏 · ${exe} 在黑名单（改为「强制显示」或开启「桌面模式」即可显示）`,
        `Hidden · ${exe} is blacklisted (switch it to "always show", or turn on desktop mode)`,
      );
      break;
    case "hidden-master-off":
      // Two ways to land here, and the fix differs: with desktop mode ON the
      // user reasonably expects it to cover a game too — say that it doesn't.
      text = desktopMode
        ? tf(
            "已隐藏 · 「窗口叠加」未开启（桌面模式只覆盖非游戏前台）",
            'Hidden · the window overlay is off (desktop mode only covers NON-game windows)',
          )
        : tf(
            "已隐藏 · 「窗口叠加」与「桌面模式」都未开启",
            "Hidden · both the window overlay and desktop mode are off",
          );
      break;
    default:
      text = tf(
        `已隐藏 · 前台 ${exe} 未识别为游戏（开启「桌面模式」，或把它加入下方名单并设为「强制显示」）`,
        `Hidden · ${exe} isn't detected as a game (turn on desktop mode, or add it below and set "always show")`,
      );
  }

  const tone = vis.shown
    ? "border-ok/40 bg-ok/10 text-ok"
    : vis.kind === "hidden-master-off"
      ? // The user switched it off themselves — state it, don't alarm.
        "border-line bg-surface2 text-muted"
      : "border-warn/40 bg-warn/10 text-warn";

  return (
    <div className="mt-3">
      <div className={cn("flex items-center gap-2 rounded-lg border px-3 py-2.5 text-[12.5px]", tone)}>
        {vis.shown ? (
          <Eye size={14} className="shrink-0" />
        ) : (
          <EyeOff size={14} className="shrink-0" />
        )}
        <span className="flex-1">{text}</span>
      </div>
      {vis.needsInjectHint && (
        <div className="mt-1.5 flex items-start gap-1.5 px-1 text-[11px] leading-relaxed text-dim">
          <Syringe size={12} className="mt-0.5 shrink-0" />
          {/* We cannot tell exclusive fullscreen from borderless here (no frontend
              signal exposes it), so this stays a hint — never a claim. */}
          {tf(
            "若该游戏是独占全屏（而非无边框窗口），窗口叠加会被游戏画面盖住 — 请同时开启上面的「注入」。",
            "If this game runs in exclusive fullscreen (not borderless), the window overlay is painted over — turn injection on as well.",
          )}
        </div>
      )}
    </div>
  );
}

/**
 * "游戏内叠加（注入）" — the MSI-Afterburner-style in-frame overlay that draws
 * inside the game's own back buffer (so it works in true exclusive fullscreen,
 * unlike the window overlay). It carries the SAFE hybrid: when the foreground
 * game is anti-cheat-protected or uses an API we can't hook, the backend refuses
 * to inject and transparently falls back to the window overlay — this section's
 * status line explains exactly what happened, so a user never gets silently
 * nothing (or, worse, a ban).
 *
 * The on/off switch now lives in the 显示方式 · MODE block above, with the other
 * two layers; this panel is the DETAIL for that one layer (the anti-cheat
 * guarantee + the live per-game status), so the user makes one decision in one
 * place instead of finding a third toggle two cards down.
 */
function InjectionOverlaySection() {
  const tf = useTf();
  // The attach/detach loop runs app-wide in `useOverlayInjection` (<App>), so
  // injection works on any tab / while gaming in the background — not only while
  // this tab is open. This panel just renders the status that driver publishes
  // to `useOverlayStatus`.
  const enabled = useOsd((s) => s.inject);
  const status = useOverlayStatus((s) => s.status);

  return (
    <div className="glass hairline rounded-2xl p-4">
      <div className="mb-3 flex items-center gap-2">
        <Syringe size={15} className="shrink-0 text-accent-bright" />
        <span className="hud-label text-[10.5px] text-dim">
          {tf("注入详情 · INJECTION", "INJECTION")}
        </span>
        <span
          className={cn(
            "rounded px-1.5 py-0.5 text-[10px]",
            enabled ? "bg-accent/15 text-accent-bright" : "bg-surface3 text-dim",
          )}
        >
          {enabled ? tf("已开启", "On") : tf("已关闭", "Off")}
        </span>
        <span className="h-px flex-1 bg-line/50" />
      </div>

      {/* Anti-cheat safety note — always visible so the guarantee is explicit. */}
      <div className="mb-3 flex items-start gap-2 rounded-lg border border-line/60 bg-surface2/50 px-3 py-2">
        <ShieldCheck size={14} className="mt-0.5 shrink-0 text-ok" />
        <span className="text-[11.5px] leading-relaxed text-dim">
          {tf(
            "检测到 EasyAntiCheat / BattlEye / Vanguard 等反作弊时绝不注入，自动改用窗口叠加，避免误判封号。",
            "Never injects when EasyAntiCheat / BattlEye / Vanguard are detected — it falls back to the window overlay so you can't be flagged.",
          )}
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

/**
 * OVL-1 adds bilingual `reasonZh` / `reasonEn` alongside the existing (Chinese)
 * `reason`. Read them structurally so this file compiles both before and after
 * that lands, and fall back to `reason` either way.
 */
type LocalisedStatus = OverlayStatus & { reasonZh?: string; reasonEn?: string };

/** The live status pill: colour + icon follow the resolved overlay mode so the
 *  user instantly sees "injected", "fell back to window (anti-cheat)", etc. */
function InjectionStatusLine({ enabled, status }: InjectionStatusLineProps) {
  const tf = useTf();
  const en = useSettings((s) => s.language) === "en";
  if (!enabled) {
    return (
      <div className="rounded-lg border border-dashed border-line/70 px-3 py-2.5 text-center text-[12px] text-dim">
        {tf(
          "在上方「显示方式」中开启「注入」后，会自动叠加到前台游戏",
          'Turn on "In-game overlay (injection)" under MODE above to attach to the foreground game',
        )}
      </div>
    );
  }
  if (!status) {
    return (
      <div className="rounded-lg border border-line bg-surface2 px-3 py-2.5 text-[12px] text-dim">
        {tf("正在检测前台游戏…", "Detecting the foreground game…")}
      </div>
    );
  }
  const loc = status as LocalisedStatus;
  const reason = (en ? loc.reasonEn : loc.reasonZh) ?? status.reason;
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
      <span className="flex-1">{reason}</span>
      {status.target.pid !== 0 && (
        <span className="shrink-0 rounded bg-surface3 px-1.5 py-0.5 text-[10.5px] text-muted opacity-80">
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
 *  or a selected game's per-game override.
 *
 *  Memoized: the parent re-renders on every telemetry tick to move the preview
 *  plate, and `cfg` / `onChange` are both identity-stable there, so this whole
 *  slider tree can sit that out. */
const OsdAppearanceControls = memo(function OsdAppearanceControls({
  cfg,
  onChange,
}: OsdAppearanceControlsProps) {
  const tf = useTf();
  return (
    <div className="glass hairline rounded-2xl p-4">
      <div className="mb-3 flex items-center gap-2">
        <Palette size={14} className="text-accent-bright" />
        <span className="hud-label text-[10.5px] text-dim">
          {tf("样式 · 位置 · STYLE", "STYLE")}
        </span>
        <span className="h-px flex-1 bg-line/50" />
      </div>
      <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
      <Row label={tf("布局样式", "Layout")}>
        <Segmented
          id="osd-style"
          value={cfg.style}
          onChange={(v) => onChange({ style: v as OsdCfg["style"] })}
          options={[
            { value: "horizontal", label: tf("横向", "Row") },
            { value: "vertical", label: tf("竖排", "Column") },
          ]}
        />
      </Row>
      <div className="sm:col-span-2">
        <Row label={tf("屏幕位置", "Screen position")}>
          <Segmented
            id="osd-pos"
            value={cfg.position}
            onChange={(v) => onChange({ position: v as OsdCfg["position"] })}
            wrap
            options={[
              { value: "tl", label: tf("左上", "Top left") },
              { value: "tc", label: tf("上中", "Top") },
              { value: "tr", label: tf("右上", "Top right") },
              { value: "bl", label: tf("左下", "Bottom left") },
              { value: "bc", label: tf("下中", "Bottom") },
              { value: "br", label: tf("右下", "Bottom right") },
              { value: "free", label: tf("自由", "Free") },
            ]}
          />
        </Row>
      </div>
      {cfg.position === "free" && (
        <>
          <div className="sm:col-span-1">
            <Slider
              label={tf("水平位置 X", "Horizontal X")}
              value={Math.round((cfg.freeX ?? 0) * 100)}
              min={0}
              max={100}
              step={1}
              unit="%"
              onChange={(v) => onChange({ freeX: v / 100 })}
            />
          </div>
          <div className="sm:col-span-1">
            <Slider
              label={tf("垂直位置 Y", "Vertical Y")}
              value={Math.round((cfg.freeY ?? 0) * 100)}
              min={0}
              max={100}
              step={1}
              unit="%"
              onChange={(v) => onChange({ freeY: v / 100 })}
            />
          </div>
        </>
      )}
      <div className="sm:col-span-1">
        <Slider
          label={tf("字体大小", "Font size")}
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
          label={tf("背景不透明度", "Plate opacity")}
          value={Math.round(cfg.opacity * 100)}
          min={0}
          max={90}
          step={5}
          unit="%"
          onChange={(v) => onChange({ opacity: v / 100 })}
        />
      </div>
      <Row label={tf("圆角背板", "Rounded plate")}>
        <Toggle checked={cfg.rounded} onChange={(v) => onChange({ rounded: v })} />
      </Row>
      <Row label={tf("OLED 防烧屏", "OLED anti burn-in")}>
        <Toggle checked={cfg.oledShift} onChange={(v) => onChange({ oledShift: v })} />
      </Row>
      </div>
    </div>
  );
});

/** The metric keys the native taskbar plate (taskbar_mon.rs) can render, in a
 *  sensible default offer order. The picker below offers ONLY these — writing the
 *  taskbar monitor's OWN `tbMetrics` list, independent of the OSD `metrics`. */
/** 1:1 with the desktop OSD content picker — offer EVERY OSD metric so the
 *  taskbar's content options match the regular monitor exactly. The native plate
 *  formats those that have desktop data; game-only metrics (fps / frametime)
 *  simply render nothing on the desktop taskbar, the same as the OSD off-game. */
const TB_METRIC_DEFS = OSD_METRICS;

/** Group the taskbar-supported metrics by category, in OSD_CATEGORIES order, so
 *  the picker reads like the OSD content picker (CPU / GPU / 内存 / 网络). */
const TB_METRIC_GROUPS = OSD_CATEGORIES.map((c) => ({
  cat: c,
  defs: TB_METRIC_DEFS.filter((m) => m.cat === c.id),
})).filter((g) => g.defs.length > 0);

/**
 * ONE foldable panel holding ALL taskbar-monitor settings — the independent
 * second overlay docked on the Windows taskbar. A single Chevron header toggles
 * the whole body open/closed; the enable toggle (Show Taskbar) stays in the
 * header so it's reachable while folded.
 *
 * Sections (all folded together):
 *   1. Layout       — Single Line / Position / Offset
 *   2. Custom Layout — its master + Size / Bold / Item / Inner / Padding
 *   3. Content      — the INDEPENDENT `tbMetrics` picker (this taskbar's own
 *                     metric list, NOT the OSD's `metrics`), with add/remove +
 *                     up/down reorder.
 *   4. Colors       — its master + bg / label / value / warn / crit + thresholds.
 *
 * The native taskbar monitor is a GLOBAL feature (App.tsx pushes only the global
 * `useOsd` state to `tbmon_config`), so every control here reads from AND writes
 * to the global `useOsd` store directly — bypassing the per-game preview/override
 * path, so what the user edits is exactly what reaches the native window (a
 * per-game override here would silently never apply).
 *
 * ponytail: deferred from the reference UI — Style preset, Hover Details,
 * Double-Click action, Monitor selector, Click-Through (always on for this
 * click-through window), and the Font picker (uses the inherited OSD font).
 */
const TaskbarMonitorPanel = memo(function TaskbarMonitorPanel() {
  const tf = useTf();
  const update = useOsd((s) => s.update);
  // Read the GLOBAL store (not the passed per-game previewCfg) so the editor
  // reflects exactly what is pushed to the native taskbar window.
  const cfg = useOsd();
  const [open, setOpen] = useState(false);
  const tbEnabled = cfg.tbEnabled ?? TBMON_DEFAULTS.tbEnabled;
  const customLayout = cfg.tbCustomLayout ?? TBMON_DEFAULTS.tbCustomLayout;
  const colorsOn = cfg.tbColorsEnabled ?? TASKBAR_DEFAULTS.tbColorsEnabled;
  const metrics = cfg.tbMetrics ?? TBMON_DEFAULTS.tbMetrics;

  // The independent tbMetrics editor: toggle add/remove preserves the picker's
  // offer order; reorder nudges a selected key up/down within tbMetrics. All
  // write `tbMetrics` on the GLOBAL store (never the OSD `metrics`).
  //
  // Stable identities (they read the live list off the store, not off a render
  // closure) so `memo(TaskbarMetricsPicker)` — the biggest subtree on this tab —
  // only re-renders when its own `metrics` prop actually moves.
  const toggleTbMetric = useCallback(
    (key: string) => {
      const cur = useOsd.getState().tbMetrics ?? TBMON_DEFAULTS.tbMetrics;
      const next = cur.includes(key)
        ? cur.filter((k) => k !== key)
        : // Insert in the canonical offer order so adding keeps pairs tidy.
          TB_METRIC_DEFS.map((m) => m.key).filter((k) => cur.includes(k) || k === key);
      update({ tbMetrics: [...next] });
    },
    [update],
  );
  const moveTbMetric = useCallback(
    (key: string, dir: -1 | 1) => {
      const cur = [...(useOsd.getState().tbMetrics ?? TBMON_DEFAULTS.tbMetrics)];
      const i = cur.indexOf(key);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= cur.length) return;
      [cur[i], cur[j]] = [cur[j], cur[i]];
      update({ tbMetrics: cur });
    },
    [update],
  );
  const clearTbMetrics = useCallback(() => update({ tbMetrics: [] }), [update]);

  return (
    <div className="glass hairline rounded-2xl p-4">
      {/* Foldable header: chevron + title toggles the whole body; the enable
          toggle stays visible while collapsed. */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className={cn(
            "no-drag flex flex-1 cursor-pointer items-center gap-2 rounded-md text-left",
            FOCUS_RING,
          )}
          aria-expanded={open}
        >
          <ChevronRight
            size={14}
            className={cn("shrink-0 text-dim transition-transform", open && "rotate-90")}
          />
          <MonitorPlay size={14} className="shrink-0 text-accent-bright" />
          <span className="hud-label text-[10.5px] text-dim">
            {tf("任务栏监视器 · TASKBAR MONITOR", "TASKBAR MONITOR")}
          </span>
          {tbEnabled && (
            <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent-bright">
              {tf("已开启", "On")}
            </span>
          )}
        </button>
        <Row label={tf("显示", "Show")}>
          <Toggle
            checked={tbEnabled}
            // The native taskbar window reads `tbEnabled` from the pushed config
            // (App.tsx subscribes to the store and calls api.tbmonConfig), so the
            // toggle only updates the store — no direct window call.
            onChange={(v) => update({ tbEnabled: v })}
          />
        </Row>
      </div>

      {open && (
        <div className="mt-3 border-t border-line/60 pt-3">
          <div className="mb-3 text-[11.5px] leading-relaxed text-dim">
            {tf(
              "停靠在 Windows 任务栏上的独立监视条;与上方角落/桌面 OSD 互不影响,可同时开启。其监控内容独立于上方 OSD。",
              "An independent monitor docked on the Windows taskbar — coexists with the corner / desktop OSD above (both can be on at once). Its monitored content is independent of the OSD above.",
            )}
          </div>

          {/* 1. Layout panel */}
          <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
            <Row label={tf("单行显示", "Single Line")}>
              <Toggle
                checked={cfg.tbSingleLine ?? TBMON_DEFAULTS.tbSingleLine}
                onChange={(v) => update({ tbSingleLine: v })}
              />
            </Row>
            <Row label={tf("停靠位置", "Position")}>
              <Segmented
                id="tbmon-pos"
                value={cfg.tbBarPosition ?? TBMON_DEFAULTS.tbBarPosition}
                onChange={(v) => update({ tbBarPosition: v as TbBarPosition })}
                options={[
                  { value: "left", label: tf("靠左", "Left") },
                  { value: "right", label: tf("靠右", "Right") },
                ]}
              />
            </Row>
            <NumRow
              label={tf("偏移 (px)", "Offset (px)")}
              value={cfg.tbOffset ?? TBMON_DEFAULTS.tbOffset}
              onChange={(v) => update({ tbOffset: v })}
            />
          </div>

          {/* 2. Custom Layout panel */}
          <div className="mb-3 mt-4 flex items-center gap-2 border-t border-line/60 pt-3">
            <span className="hud-label text-[10.5px] text-dim">
              {tf("自定义布局 · CUSTOM LAYOUT", "CUSTOM LAYOUT")}
            </span>
            <span className="h-px flex-1 bg-line/50" />
          </div>
          <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
            <Row label={tf("启用自定义布局", "Custom Layout")}>
              <Toggle checked={customLayout} onChange={(v) => update({ tbCustomLayout: v })} />
            </Row>
            <Row label={tf("加粗", "Bold")}>
              <Toggle
                checked={cfg.tbBold ?? TBMON_DEFAULTS.tbBold}
                onChange={(v) => update({ tbBold: v })}
              />
            </Row>
            <NumRow
              label={tf("字号 (pt)", "Size (pt)")}
              value={cfg.tbSize ?? TBMON_DEFAULTS.tbSize}
              onChange={(v) => update({ tbSize: v })}
            />
            <NumRow
              label={tf("项间距 (px)", "Item Space (px)")}
              value={cfg.tbItemSpace ?? TBMON_DEFAULTS.tbItemSpace}
              onChange={(v) => update({ tbItemSpace: v })}
            />
            <NumRow
              label={tf("内间距 (px)", "Inner Space (px)")}
              value={cfg.tbInnerSpace ?? TBMON_DEFAULTS.tbInnerSpace}
              onChange={(v) => update({ tbInnerSpace: v })}
            />
            <NumRow
              label={tf("内边距 (px)", "Padding (px)")}
              value={cfg.tbPadding ?? TBMON_DEFAULTS.tbPadding}
              onChange={(v) => update({ tbPadding: v })}
            />
          </div>

          {/* 3. Content — the INDEPENDENT tbMetrics picker. */}
          <TaskbarMetricsPicker
            metrics={metrics}
            onToggle={toggleTbMetric}
            onMove={moveTbMetric}
            onClear={clearTbMetrics}
          />

          {/* 4. Colors panel */}
          <div className="mb-3 mt-4 flex items-center gap-2 border-t border-line/60 pt-3">
            <Palette size={14} className="text-accent-bright" />
            <span className="hud-label text-[10.5px] text-dim">{tf("配色 · COLORS", "COLORS")}</span>
            <span className="h-px flex-1 bg-line/50" />
          </div>
          <div className="mb-3 flex items-center justify-between gap-3">
            <span className="text-[12.5px] text-muted">{tf("启用配色", "Enable colors")}</span>
            <Toggle checked={colorsOn} onChange={(v) => update({ tbColorsEnabled: v })} />
          </div>
          <div className="mb-3 flex items-start gap-2 rounded-lg border border-line/60 bg-surface2/50 px-3 py-2">
            <AlertTriangle size={13} className="mt-0.5 shrink-0 text-warn" />
            <span className="text-[11.5px] leading-relaxed text-dim">
              {tf(
                "将背景色设为接近系统任务栏的颜色，边缘才不会露出色块。",
                "Set the background close to your system taskbar color so the plate's edges don't show.",
              )}
            </span>
          </div>
          <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            <ColorRow
              label={tf("背景色", "Background")}
              value={cfg.tbBg ?? TASKBAR_DEFAULTS.tbBg}
              onChange={(v) => update({ tbBg: v })}
            />
            <ColorRow
              label={tf("标签", "Label")}
              value={cfg.tbLabel ?? TASKBAR_DEFAULTS.tbLabel}
              onChange={(v) => update({ tbLabel: v })}
            />
            <ColorRow
              label={tf("数值", "Value")}
              value={cfg.tbSafe ?? TASKBAR_DEFAULTS.tbSafe}
              onChange={(v) => update({ tbSafe: v })}
            />
            <ColorRow
              label={tf("警告", "Warn")}
              value={cfg.tbWarn ?? TASKBAR_DEFAULTS.tbWarn}
              onChange={(v) => update({ tbWarn: v })}
            />
            <ColorRow
              label={tf("危险", "Crit")}
              value={cfg.tbCrit ?? TASKBAR_DEFAULTS.tbCrit}
              onChange={(v) => update({ tbCrit: v })}
            />
          </div>
          <div className="mt-4 grid gap-x-6 gap-y-3 sm:grid-cols-2">
            <NumRow
              label={tf("占用警告 (%)", "Load warn (%)")}
              value={cfg.tbWarnLoad ?? TASKBAR_DEFAULTS.tbWarnLoad}
              onChange={(v) => update({ tbWarnLoad: v })}
            />
            <NumRow
              label={tf("占用危险 (%)", "Load crit (%)")}
              value={cfg.tbCritLoad ?? TASKBAR_DEFAULTS.tbCritLoad}
              onChange={(v) => update({ tbCritLoad: v })}
            />
            <NumRow
              label={tf("温度警告 (°C)", "Temp warn (°C)")}
              value={cfg.tbWarnTemp ?? TASKBAR_DEFAULTS.tbWarnTemp}
              onChange={(v) => update({ tbWarnTemp: v })}
            />
            <NumRow
              label={tf("温度危险 (°C)", "Temp crit (°C)")}
              value={cfg.tbCritTemp ?? TASKBAR_DEFAULTS.tbCritTemp}
              onChange={(v) => update({ tbCritTemp: v })}
            />
          </div>
        </div>
      )}
    </div>
  );
});

interface TaskbarMetricsPickerProps {
  /** The taskbar monitor's OWN selected metric keys, in display order. */
  metrics: string[];
  /** Toggle a key into / out of tbMetrics (writes the global store). */
  onToggle: (key: string) => void;
  /** Reorder a selected key up (-1) / down (+1) within tbMetrics. */
  onMove: (key: string, dir: -1 | 1) => void;
  /** Clear all selected taskbar metrics. */
  onClear: () => void;
}

/**
 * The INDEPENDENT taskbar-monitor content picker. Edits the taskbar's own
 * `tbMetrics` list — NOT the OSD `metrics`. Mirrors the OSD content picker's
 * visual style (category-grouped checkbox tiles), and adds a compact "selected
 * order" strip with up/down reorder so the user can arrange the pair order the
 * native plate renders. Only the taskbar-supported keys are offered.
 */
const TaskbarMetricsPicker = memo(function TaskbarMetricsPicker({
  metrics,
  onToggle,
  onMove,
  onClear,
}: TaskbarMetricsPickerProps) {
  const tf = useTf();
  const selectedDefs = metrics
    .map((k) => TB_METRIC_DEFS.find((m) => m.key === k))
    .filter((m): m is OsdMetricDef => m != null);
  return (
    <div className="mt-4 border-t border-line/60 pt-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <MonitorPlay size={14} className="shrink-0 text-accent-bright" />
          <span className="hud-label truncate text-[10.5px] text-dim">
            {tf("监控内容 · CONTENT", "CONTENT")}
          </span>
          <span className="rounded bg-surface2 px-1.5 py-0.5 text-[10px] text-dim">
            {tf("已选", "Selected")}{" "}
            <span className="nums text-muted">{metrics.length}</span>
          </span>
        </div>
        <button
          onClick={onClear}
          disabled={metrics.length === 0}
          className={cn(
            "no-drag flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-surface2 px-2.5 py-1 text-[11.5px] text-muted transition-colors hover:bg-surface3 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40",
            FOCUS_RING,
          )}
        >
          <RotateCcw size={12} /> {tf("全部清空", "Clear all")}
        </button>
      </div>
      <div className="mb-2 text-[11px] leading-relaxed text-dim">
        {tf(
          "任务栏监视器单独的监控项,与上方 OSD 互不影响。",
          "The taskbar monitor's own metrics — independent of the OSD above.",
        )}
      </div>

      {/* Category-grouped toggle tiles (matches the OSD content picker style). */}
      <div className="space-y-3">
        {TB_METRIC_GROUPS.map((g) => (
          <div key={g.cat.id}>
            <div className="mb-1.5 text-[11px] font-medium text-dim">{g.cat.label}</div>
            <div className="grid gap-2 sm:grid-cols-2">
              {g.defs.map((m) => {
                const on = metrics.includes(m.key);
                return (
                  <button
                    key={m.key}
                    onClick={() => onToggle(m.key)}
                    className={cn(
                      "no-drag flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-[12.5px] transition-colors",
                      FOCUS_RING,
                      on
                        ? "border-accent/40 bg-accent/10 text-ink"
                        : "border-line bg-surface2 text-muted hover:bg-surface3 hover:text-ink",
                    )}
                  >
                    <span
                      className={cn(
                        "grid h-4 w-4 shrink-0 place-items-center rounded border transition-colors",
                        on ? "border-accent bg-accent" : "border-line-strong",
                      )}
                    >
                      {on && <span className="h-2 w-2 rounded-[2px] bg-white" />}
                    </span>
                    <span className="flex-1">
                      <span className="text-dim">{m.tag} </span>
                      {m.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Selected-order strip with up/down reorder — the order here is the order
          the native taskbar plate renders the metric pairs. */}
      {selectedDefs.length > 0 && (
        <div className="mt-3">
          <div className="mb-1.5 text-[11px] font-medium text-dim">
            {tf("显示顺序", "Display order")}
          </div>
          <div className="space-y-1">
            {selectedDefs.map((m, i) => (
              <div
                key={m.key}
                className="flex items-center gap-2 rounded-lg border border-line bg-surface2 px-3 py-1.5 text-[12px]"
              >
                <span className="nums w-5 shrink-0 text-dim">{i + 1}</span>
                <span className="flex-1 truncate text-muted">
                  <span className="text-dim">{m.tag} </span>
                  {m.label}
                </span>
                <button
                  onClick={() => onMove(m.key, -1)}
                  disabled={i === 0}
                  className={cn(
                    "no-drag grid h-6 w-6 shrink-0 cursor-pointer place-items-center rounded text-dim transition-colors hover:bg-surface3 hover:text-ink disabled:cursor-not-allowed disabled:opacity-30",
                    FOCUS_RING,
                  )}
                  title={tf("上移", "Move up")}
                  aria-label={tf(`上移 ${m.label}`, `Move ${m.label} up`)}
                >
                  <ChevronRight size={13} className="-rotate-90" />
                </button>
                <button
                  onClick={() => onMove(m.key, 1)}
                  disabled={i === selectedDefs.length - 1}
                  className={cn(
                    "no-drag grid h-6 w-6 shrink-0 cursor-pointer place-items-center rounded text-dim transition-colors hover:bg-surface3 hover:text-ink disabled:cursor-not-allowed disabled:opacity-30",
                    FOCUS_RING,
                  )}
                  title={tf("下移", "Move down")}
                  aria-label={tf(`下移 ${m.label}`, `Move ${m.label} down`)}
                >
                  <ChevronRight size={13} className="rotate-90" />
                </button>
                <button
                  onClick={() => onToggle(m.key)}
                  className={cn(
                    "no-drag grid h-6 w-6 shrink-0 cursor-pointer place-items-center rounded text-dim transition-colors hover:bg-danger/15 hover:text-danger",
                    FOCUS_RING,
                  )}
                  title={tf("移除", "Remove")}
                  aria-label={tf(`移除 ${m.label}`, `Remove ${m.label}`)}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
});

/** A label + hex text + native color swatch, kept in sync (the screenshot shows
 *  the same "#RRGGBB + swatch" pairing for each color slot). */
function ColorRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <Row label={label}>
      <div className="flex items-center gap-2">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          className="no-drag w-24 rounded-lg border border-line bg-surface2 px-2 py-1 text-[12px] text-ink outline-none transition-colors focus:border-accent/50"
        />
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="no-drag h-7 w-9 cursor-pointer rounded border border-line bg-surface2 p-0.5"
          aria-label={label}
        />
      </div>
    </Row>
  );
}

/** A label + small numeric input, clamped to a sane 0..150 range. */
function NumRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <Row label={label}>
      <input
        type="number"
        min={0}
        max={150}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(Math.min(150, Math.max(0, n)));
        }}
        className="no-drag w-20 rounded-lg border border-line bg-surface2 px-2 py-1 text-[12px] text-ink outline-none transition-colors focus:border-accent/50"
      />
    </Row>
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
