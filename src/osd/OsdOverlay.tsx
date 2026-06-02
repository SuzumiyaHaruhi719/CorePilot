import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { cn } from "../lib/cn";
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
      metrics: global.metrics,
    },
    targets,
    fg.exe,
    fg.isGame,
  );
  // Master switch off → never show. Otherwise show iff a config resolved.
  const show = global.enabled && effective !== null;
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

  if (!show) return null;

  const isFree = cfg.position === "free";
  const top = cfg.position === "tl" || cfg.position === "tr";
  const left = cfg.position === "tl" || cfg.position === "bl";

  // OLED nudge: inward from the corner (or any small direction in free mode).
  const [ox, oy] = cfg.oledShift ? OLED_OFFSETS[shiftIdx % OLED_OFFSETS.length] : [0, 0];
  const dx = isFree || left ? ox : -ox;
  const dy = isFree || top ? oy : -oy;

  return (
    <div
      className={cn(
        "fixed inset-0",
        !isFree && "flex p-1.5",
        !isFree && (top ? "items-start" : "items-end"),
        !isFree && (left ? "justify-start" : "justify-end"),
      )}
    >
      <div
        style={{
          ...(isFree ? freePosStyle(cfg.freeX, cfg.freeY) : undefined),
          transform: `translate(${dx}px, ${dy}px)`,
          transition: "transform 1.2s ease",
        }}
      >
        <OsdPlate
          metrics={shownMetrics}
          style={cfg.style}
          scale={cfg.scale}
          opacity={cfg.opacity}
          rounded={cfg.rounded}
          data={data}
        />
      </div>
    </div>
  );
}
