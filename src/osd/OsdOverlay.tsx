import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { api } from "../lib/ipc";
import { fetchOsdData, freePosStyle, type OsdData } from "../lib/osd";
import {
  resolveOsd,
  useOsd,
  useOsdTargets,
  type OsdConfig,
  type OsdTarget,
} from "../store/osd";
import { OsdPlate } from "./OsdPlate";

/**
 * The in-game overlay surface, rendered in a separate transparent, click-through,
 * always-on-top Tauri window (entry: `?osd`). Deliberately lightweight: a single
 * ~1 Hz poll of existing backend commands, minimal DOM, no animation — so it adds
 * negligible overhead while a game runs.
 *
 * Per-process behaviour: each tick we ask the backend for the foreground app
 * (exe + whether it's a detected game) and resolve it against the white/blacklist
 * overrides (`resolveOsd`). By default the plate renders on apps auto-detected as
 * games, using that game's effective config (global default + its per-game
 * override); the white/blacklists force show/hide. The window itself stays
 * created; it simply renders nothing when nothing should show. Config is hydrated from
 * the shared store and kept live via the `osd:cfg` / `osd:targets` events emitted
 * by the config panel (which lives in a different webview).
 *
 * Window geometry: the overlay window is small and content-sized. We render the
 * plate at the window's top-left and, after each render, measure it and drive the
 * native window's size + position (corner / free placement, plus the OLED nudge)
 * via `api.osdSetBounds`. A small window cannot lock the screen if click-through
 * momentarily fails, unlike the previous fullscreen overlay.
 */

const EMPTY: OsdData = { metrics: null, sensors: null, gpu: null, fps: null };

/** Poll interval for the foreground app + metrics (ms). */
const TICK_MS = 1000;

/** OLED anti burn-in: how often to nudge the overlay, and the small inward
 *  pixel offsets it cycles through (kept tiny so the plate never clips). */
const OLED_SHIFT_MS = 45_000;
const OLED_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [4, 2],
  [2, 5],
  [5, 3],
  [1, 4],
  [3, 1],
];

export function OsdOverlay() {
  // Global default config (the master switch + the "use default" appearance).
  const global = useOsd();
  // Per-game rules.
  const targets = useOsdTargets((s) => s.targets);

  const [data, setData] = useState<OsdData>(EMPTY);
  // Foreground app snapshot: exe name + whether the backend detects it as a game.
  const [fg, setFg] = useState<{ exe: string | null; isGame: boolean }>({
    exe: null,
    isGame: false,
  });
  // OLED anti burn-in step (advances on a slow timer when enabled).
  const [shiftIdx, setShiftIdx] = useState(0);
  // Logical bounds [x,y,w,h] of the monitor the foreground GAME is on, so the
  // overlay follows the game across monitors. null = stay on the primary monitor
  // (desktop mode), which preserves the original, never-moved behaviour.
  const [mon, setMon] = useState<[number, number, number, number] | null>(null);
  // The plate element — measured each render to size/position the native window.
  const plateRef = useRef<HTMLDivElement>(null);
  // Fullscreen position editor (driven by the config panel via `osd:position-mode`):
  // the backend makes THIS window cover the desktop + interactive; we render a drag
  // canvas, SKIP `osd_set_bounds` (no content-resize → no jitter), and set freeX/freeY
  // by dragging the plate over the real screen (1:1).
  const [posEdit, setPosEdit] = useState(false);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  function exitPosEdit() {
    setPosEdit(false);
    setDragPos(null);
    dragRef.current = null;
    void api.osdPositionMode(false);
    const s = useOsd.getState();
    void emit("osd:position-result", { freeX: s.freeX, freeY: s.freeY });
  }
  function startPosDrag(e: React.PointerEvent) {
    e.preventDefault();
    const move = (ev: PointerEvent) => {
      const x = Math.min(1, Math.max(0, ev.clientX / window.innerWidth));
      const y = Math.min(1, Math.max(0, ev.clientY / window.innerHeight));
      dragRef.current = { x, y };
      setDragPos({ x, y });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const p = dragRef.current;
      if (p) useOsd.setState({ freeX: p.x, freeY: p.y, position: "free" });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  // Live config push from the main window's config panel (separate webview), so
  // edits in the panel reflect on the overlay without a reload.
  useEffect(() => {
    const unCfg = listen<Partial<OsdConfig>>("osd:cfg", (e) => useOsd.setState(e.payload));
    // The config panel may emit a legacy `{ mode, targets }` shape; we read only
    // `targets` (mode no longer exists).
    const unTargets = listen<{ targets: OsdTarget[] }>("osd:targets", (e) =>
      useOsdTargets.setState({ targets: e.payload.targets }),
    );
    const unPos = listen<boolean>("osd:position-mode", (e) => setPosEdit(e.payload));
    return () => {
      void unCfg.then((f) => f());
      void unTargets.then((f) => f());
      void unPos.then((f) => f());
    };
  }, []);

  // Resolve which config (if any) applies to the current foreground app.
  const effective = resolveOsd(
    {
      enabled: global.enabled,
      style: global.style,
      scale: global.scale,
      opacity: global.opacity,
      position: global.position,
      freeX: global.freeX,
      freeY: global.freeY,
      rounded: global.rounded,
      oledShift: global.oledShift,
      desktopMode: global.desktopMode,
      inject: global.inject,
      metrics: global.metrics,
    },
    targets,
    fg.exe,
    fg.isGame,
  );
  // Show iff resolveOsd returned a config — it already gates games on `enabled`
  // and desktop on `desktopMode`; the overlay window only exists when one is on.
  const show = effective !== null;
  const cfg = effective ?? global;

  // Desktop mode: when showing on a non-game (desktop / regular app), FPS is
  // unavailable — hide the FPS-group metrics so only CPU/GPU/mem/disk/net show.
  const shownMetrics = fg.isGame ? cfg.metrics : cfg.metrics.filter((k) => !k.startsWith("fps"));
  const needGpu = shownMetrics.some((k) => k.startsWith("gpu."));
  // Any FPS-group metric (fps / 1% low / 0.1% low / frametime) needs the stats fetch.
  const needFps = shownMetrics.some((k) => k.startsWith("fps"));

  // Single poll loop: refresh the foreground app and (only while showing) the
  // metric snapshot. When hidden we still track the foreground app cheaply so a
  // game gaining focus brings the overlay up on the next tick.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const info = await api.foregroundInfo().catch(() => null);
      if (!alive) return;
      setFg(info ? { exe: info.exe, isGame: info.isGame } : { exe: null, isGame: false });
      // Follow the foreground window's monitor when the OSD is showing FOR that
      // specific app — a detected game OR a whitelisted target — so the overlay
      // tracks it across displays. Desktop mode (general, no match) keeps mon=null
      // and stays on the primary monitor, so it can never be dragged off.
      const n = info?.exe ? info.exe.trim().toLowerCase() : "";
      const whitelisted =
        !!n && useOsdTargets.getState().targets.some((t) => t.name === n && t.list === "white");
      const followFg = !!info && (info.isGame || whitelisted);
      const m = followFg ? await api.osdTargetMonitor().catch(() => null) : null;
      if (alive) setMon(m);
      if (show) {
        const d = await fetchOsdData(needGpu, needFps);
        if (alive) setData(d);
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), TICK_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [needGpu, needFps, show]);

  // OLED anti burn-in: advance the position-nudge step on a slow timer while the
  // overlay is visible and the option is enabled.
  useEffect(() => {
    if (!(show && cfg.oledShift)) return;
    const id = window.setInterval(() => setShiftIdx((i) => i + 1), OLED_SHIFT_MS);
    return () => window.clearInterval(id);
  }, [show, cfg.oledShift]);

  // Esc exits the fullscreen position editor (same as the 完成 button).
  useEffect(() => {
    if (!posEdit) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") exitPosEdit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posEdit]);

  // Drive the native window's size + position from the rendered plate. The window
  // (not CSS) is what sits at the chosen corner now, so we measure the plate and
  // place a content-sized window there. When hidden, park a 1×1 window off-screen.
  useLayoutEffect(() => {
    const margin = 8;
    // The editor owns the window geometry (fullscreen) while active — never resize
    // it, or the content-sizing would fight the drag and the overlay would jitter.
    if (posEdit) return;
    if (!show) {
      api.osdSetBounds(-200, -200, 1, 1).catch(() => {});
      return;
    }
    const el = plateRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const w = Math.max(1, Math.ceil(r.width));
    const h = Math.max(1, Math.ceil(r.height));
    // Anchor to the game's monitor when following one (mon), else the primary
    // monitor's work area. mon is only set for a foreground game (see tick).
    const [mx, my, mw, mh] = mon ?? [0, 0, window.screen.availWidth, window.screen.availHeight];
    // OLED nudge offsets (small, inward from the corner).
    const [ox, oy] = cfg.oledShift ? OLED_OFFSETS[shiftIdx % OLED_OFFSETS.length] : [0, 0];
    const top = cfg.position === "tl" || cfg.position === "tr" || cfg.position === "tc";
    const left = cfg.position === "tl" || cfg.position === "bl";
    const center = cfg.position === "tc" || cfg.position === "bc";
    let x: number;
    let y: number;
    if (cfg.position === "free") {
      x = mx + Math.min(Math.max(cfg.freeX * mw, 0), Math.max(0, mw - w));
      y = my + Math.min(Math.max(cfg.freeY * mh, 0), Math.max(0, mh - h));
    } else {
      x = center
        ? mx + Math.min(Math.max((mw - w) / 2 + ox, 0), Math.max(0, mw - w))
        : left
          ? mx + margin + ox
          : mx + mw - w - margin - ox;
      y = top ? my + margin + oy : my + mh - h - margin - oy;
    }
    api.osdSetBounds(x, y, w, h).catch(() => {});
  }, [show, cfg, data, shownMetrics, shiftIdx, mon, posEdit]);

  // Fullscreen position editor: the window covers the desktop (set by the backend),
  // so we dim it and draw the plate at its REAL size; dragging maps 1:1 to the screen.
  if (posEdit) {
    const fx = dragPos?.x ?? global.freeX;
    const fy = dragPos?.y ?? global.freeY;
    return (
      <div className="fixed inset-0 select-none" style={{ background: "rgba(0,0,0,0.32)" }}>
        <div className="pointer-events-none fixed left-1/2 top-7 -translate-x-1/2 rounded-lg bg-black/75 px-4 py-2 text-[13px] font-medium text-white/90 shadow-lg">
          拖动叠加层到目标位置 · 按 Esc 或点击「完成」保存
        </div>
        <div
          className="absolute cursor-grab touch-none active:cursor-grabbing"
          style={freePosStyle(fx, fy)}
          onPointerDown={startPosDrag}
        >
          <OsdPlate
            metrics={global.metrics}
            style={global.style}
            scale={global.scale}
            opacity={global.opacity}
            rounded={global.rounded}
            data={data}
          />
        </div>
        <button
          onClick={exitPosEdit}
          className="no-drag fixed bottom-9 left-1/2 -translate-x-1/2 rounded-xl bg-accent px-6 py-2.5 text-[14px] font-semibold text-white shadow-xl"
        >
          完成
        </button>
      </div>
    );
  }

  // Keep the component mounted even when hidden so the layout effect can run and
  // park the window off-screen. The window itself is positioned at the corner, so
  // the plate just renders at the wrapper's top-left.
  if (!show) {
    return <div ref={plateRef} style={{ position: "fixed", top: 0, left: 0, width: "max-content" }} />;
  }

  return (
    <div ref={plateRef} style={{ position: "fixed", top: 0, left: 0, width: "max-content" }}>
      <OsdPlate
        metrics={shownMetrics}
        style={cfg.style}
        scale={cfg.scale}
        opacity={cfg.opacity}
        rounded={cfg.rounded}
        data={data}
      />
    </div>
  );
}
