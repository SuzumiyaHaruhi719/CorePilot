import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, withTimeout } from "../lib/ipc";
import { fetchOsdData, type OsdData } from "../lib/osd";
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

/** Grid the overlay window's size is snapped up to. MUST stay equal to
 *  `OSD_SIZE_QUANTUM` in src-tauri/src/osd.rs: the backend rounds the requested
 *  size up to it (so metric-driven width jitter stops churning WebView2 surface
 *  resizes, which leak GDI objects upstream), and the centered positions here
 *  round to the same grid so the plate stops sliding sideways as digits change. */
const OSD_SIZE_QUANTUM = 16;

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

  // Throttle native repositioning to ~one update per frame (latest wins). The
  // free-position X/Y sliders fire far faster than the IPC + Win32 SetWindowPos
  // round-trip; without coalescing the calls queue up and the overlay lags then
  // jerks to catch up (the "laggy + twitchy" drag). A trailing 16 ms cap keeps it
  // at ≤~60 Hz and always applies the *latest* target, so the final position is
  // exact and intermediate frames are dropped instead of replayed.
  const setBounds = useMemo(() => {
    let timer: number | null = null;
    let pending: [number, number, number, number] | null = null;
    return (x: number, y: number, w: number, h: number) => {
      pending = [x, y, w, h];
      if (timer != null) return;
      timer = window.setTimeout(() => {
        timer = null;
        const b = pending;
        pending = null;
        if (b) api.osdSetBounds(b[0], b[1], b[2], b[3]).catch(() => {});
      }, 16);
    };
  }, []);

  // Live config push from the main window's config panel (separate webview), so
  // edits in the panel reflect on the overlay without a reload.
  useEffect(() => {
    const unCfg = listen<Partial<OsdConfig>>("osd:cfg", (e) => useOsd.setState(e.payload));
    // The config panel may emit a legacy `{ mode, targets }` shape; we read only
    // `targets` (mode no longer exists).
    const unTargets = listen<{ targets: OsdTarget[] }>("osd:targets", (e) =>
      useOsdTargets.setState({ targets: e.payload.targets }),
    );
    return () => {
      void unCfg.then((f) => f());
      void unTargets.then((f) => f());
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
      autoInject: global.autoInject,
      metrics: global.metrics,
      tbColorsEnabled: global.tbColorsEnabled,
      tbBg: global.tbBg,
      tbLabel: global.tbLabel,
      tbSafe: global.tbSafe,
      tbWarn: global.tbWarn,
      tbCrit: global.tbCrit,
      tbWarnLoad: global.tbWarnLoad,
      tbCritLoad: global.tbCritLoad,
      tbWarnTemp: global.tbWarnTemp,
      tbCritTemp: global.tbCritTemp,
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
  const baseMetrics = fg.isGame ? cfg.metrics : cfg.metrics.filter((k) => !k.startsWith("fps"));
  // Always render network upload (↑) before download (↓), regardless of the order
  // they were toggled on — flips existing saved configs without a re-toggle.
  const shownMetrics = (() => {
    const up = baseMetrics.indexOf("net.up");
    const down = baseMetrics.indexOf("net.down");
    if (up === -1 || down === -1 || up < down) return baseMetrics;
    const out = baseMetrics.filter((k) => k !== "net.up");
    out.splice(out.indexOf("net.down"), 0, "net.up");
    return out;
  })();
  const needGpu = shownMetrics.some((k) => k.startsWith("gpu."));
  // Any FPS-group metric (fps / 1% low / 0.1% low / frametime) needs the stats fetch.
  const needFps = shownMetrics.some((k) => k.startsWith("fps"));

  // Single poll loop: refresh the foreground app and (when it should show) the
  // metric snapshot. When hidden we still track the foreground app cheaply so a
  // game gaining focus brings the overlay up on the next tick.
  useEffect(() => {
    let alive = true;
    let inFlight = false;
    const tick = async () => {
      // Page-liveness beat, FIRST — before every early return below. This is the
      // only signal the backend has that the overlay's RENDERER is still alive:
      // wry installs no WebView2 ProcessFailed handler, so a crashed OSD page
      // leaves a live, transparent, topmost window rendering nothing, and every
      // backend self-heal (keep-alive, z-order re-assert) sees a perfectly
      // healthy window. The Rust guard reloads, then rebuilds, a window whose
      // page stops beating for 180 s. It has to be ahead of BOTH short-circuits:
      // the backpressure return (a wedged backend is not a dead page — reloading
      // would not help) and the idle/parked return below (an overlay parked
      // off-screen is idle by design and must keep beating, or it would be
      // rebuilt every 3 minutes forever).
      api.osdHeartbeat().catch(() => {});
      // Backpressure: never overlap polls. If the previous tick's invokes haven't
      // resolved (slow/wedged backend), skip this one instead of piling up.
      if (inFlight) return;
      inFlight = true;
      try {
      // Idle short-circuit: when the OSD can NEVER show — master switch off,
      // desktop mode off, and no whitelist force-show entries — `resolveOsd`
      // returns null for every possible foreground, so polling the backend is
      // pure waste. Skip the IPC entirely (the window is already parked
      // off-screen); the tick keeps running on cheap synchronous store reads, so
      // flipping any of those flags brings the overlay back within one tick.
      const g = useOsd.getState();
      const tgts = useOsdTargets.getState().targets;
      if (!g.enabled && !g.desktopMode && !tgts.some((t) => t.list === "white")) {
        setFg((p) => (p.exe === null && !p.isGame ? p : { exe: null, isGame: false }));
        setMon((p) => (p === null ? p : null));
        return;
      }
      const info = await withTimeout(api.foregroundInfo()).catch(() => null);
      if (!alive) return;
      const exe = info?.exe ?? null;
      const isGame = info?.isGame ?? false;
      // Resolve visibility from the JUST-fetched foreground info + live store
      // state — NOT the stale `show` closed over from the previous render. This
      // lets a game gaining focus fetch its metrics in the SAME tick, so the
      // overlay appears immediately instead of after one empty poll.
      const freshCfg = resolveOsd(useOsd.getState(), tgts, exe, isGame);
      const showNow = freshCfg !== null;
      // Follow the foreground window's monitor when the OSD is showing FOR that
      // specific app — a detected game OR a whitelisted target — so the overlay
      // tracks it across displays. Desktop mode (general, no match) keeps mon=null
      // and stays on the primary monitor, so it can never be dragged off.
      const n = exe ? exe.trim().toLowerCase() : "";
      const whitelisted = !!n && tgts.some((t) => t.name === n && t.list === "white");
      const followFg = !!info && (isGame || whitelisted);
      const m = followFg ? await api.osdTargetMonitor().catch(() => null) : null;
      let d: OsdData | null = null;
      if (showNow) {
        // Derive the fetch flags from the freshly-resolved config + foreground
        // kind (desktop hides FPS), so the right data is fetched on the first
        // tick a game appears.
        const metrics = isGame
          ? freshCfg.metrics
          : freshCfg.metrics.filter((k) => !k.startsWith("fps"));
        d = await withTimeout(
          fetchOsdData(
            metrics.some((k) => k.startsWith("gpu.")),
            metrics.some((k) => k.startsWith("fps")),
          ),
        );
      }
      if (!alive) return;
      // ATOMIC COMMIT — all three pieces land in ONE render.
      //
      // These used to be committed as they arrived, with an `await` between each,
      // so React flushed a separate render per piece: first the new foreground
      // alongside the PREVIOUS monitor and the PREVIOUS plate data, then the
      // monitor, then the data. The layout effect ran on every one of those, so
      // on each app switch the window was placed using the old monitor and a
      // plate measured from stale (often narrower) values — visibly off, worst of
      // all for a centered position, where x is `(monitorW - plateW) / 2` and a
      // wrong plateW offsets it by half the error. It then jumped into place over
      // the next two renders. Harmless while the overlay was still being demoted
      // behind the game, but `osd_set_bounds` now re-asserts HWND_TOPMOST on every
      // push (see osd.rs), so that first wrong placement became visible.
      // Committing together costs the overlay one data fetch of extra latency on
      // the tick a game appears, and in exchange it appears already correct
      // instead of appearing crooked and sliding over.
      setFg((p) => (p.exe === exe && p.isGame === isGame ? p : { exe, isGame }));
      setMon((p) =>
        p === m || (p && m && p[0] === m[0] && p[1] === m[1] && p[2] === m[2] && p[3] === m[3])
          ? p
          : m,
      );
      if (d) setData(d);
      } finally {
        inFlight = false;
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

  // Drive the native window's size + position from the rendered plate. The window
  // (not CSS) is what sits at the chosen corner now, so we measure the plate and
  // place a content-sized window there. When hidden, park a 1×1 window off-screen.
  useLayoutEffect(() => {
    const margin = 8;
    if (!show) {
      setBounds(-200, -200, 1, 1);
      return;
    }
    const el = plateRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const w = Math.max(1, Math.ceil(r.width));
    const h = Math.max(1, Math.ceil(r.height));
    // Width used ONLY for the centered positions, snapped up to the same grid the
    // backend snaps the window size to (OSD_SIZE_QUANTUM in osd.rs).
    //
    // A centered plate sits at `(monitorW - plateW) / 2`, so every change in plate
    // width moves it by HALF that change — and the plate is as wide as its digits:
    // one FPS reading dropping from three digits to two shrinks it by ~12 px and
    // slides the whole overlay 6 px sideways, several times a second. (The corner
    // positions are immune: they anchor to an edge, so width changes only grow the
    // plate inward.) Snapping the centering width to the 16 px grid means x only
    // moves when the window itself is resized, which the same grid already makes
    // rare. `w` — not centerW — still drives the size and the clamp, so the plate
    // is never clipped and never pushed off the monitor edge.
    const centerW = Math.ceil(w / OSD_SIZE_QUANTUM) * OSD_SIZE_QUANTUM;
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
        ? mx + Math.min(Math.max((mw - centerW) / 2 + ox, 0), Math.max(0, mw - w))
        : left
          ? mx + margin + ox
          : mx + mw - w - margin - ox;
      y = top ? my + margin + oy : my + mh - h - margin - oy;
    }
    setBounds(x, y, w, h);
  }, [show, cfg, data, shownMetrics, shiftIdx, mon, setBounds]);

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
        taskbar={false}
        tbColorsEnabled={cfg.tbColorsEnabled}
        tbBg={cfg.tbBg}
        tbLabel={cfg.tbLabel}
        tbSafe={cfg.tbSafe}
        tbWarn={cfg.tbWarn}
        tbCrit={cfg.tbCrit}
        tbWarnLoad={cfg.tbWarnLoad}
        tbCritLoad={cfg.tbCritLoad}
        tbWarnTemp={cfg.tbWarnTemp}
        tbCritTemp={cfg.tbCritTemp}
      />
    </div>
  );
}
