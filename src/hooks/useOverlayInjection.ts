import { useEffect, useMemo, useRef } from "react";
import { api } from "../lib/ipc";
import { layoutFlagsFromMetrics } from "../lib/osd";
import { useOsd, useOverlayStatus } from "../store/osd";

/** How often we re-check the foreground app + (re)attach while injection is on. */
const POLL_MS = 1500;

/**
 * App-level driver for the in-game (injection) overlay.
 *
 * This MUST live in `<App>` (always mounted), not in the OSD config tab — the
 * earlier version ran the attach/detach loop inside that tab, so it only polled
 * (and only attached) while you were sitting on it. Switching to any other tab —
 * or just gaming with CorePilot in the background — unmounted the loop, so the
 * injected overlay never attached and you got the window-overlay fallback (which
 * is pinned to the primary monitor and doesn't follow the game).
 *
 * While `osd.inject` is on it polls the foreground app: when it's an injectable
 * game it (re)attaches the injected overlay (detaching any previous game first),
 * which then draws inside the game's own frame and follows it across monitors /
 * fullscreen. When the foreground isn't injectable (anti-cheat / unsupported API
 * / no game) the backend has already chosen the window-overlay fallback; we drop
 * any prior attach and publish the explanatory status. The live status is pushed
 * to `useOverlayStatus` for the config panel to render.
 */
export function useOverlayInjection(): void {
  const inject = useOsd((s) => s.inject);
  const metrics = useOsd((s) => s.metrics);

  // Latest layout flags in a ref so the steady-state poll uses the current metric
  // selection without restarting the interval.
  const layoutFlags = useMemo(() => layoutFlagsFromMetrics(metrics), [metrics]);
  const flagsRef = useRef(layoutFlags);
  flagsRef.current = layoutFlags;

  // PID we currently have the injected overlay attached to (0 = none).
  const attachedPid = useRef(0);
  // Layout flags last pushed to the backend for the attached PID. Lets us call
  // overlayAttach again ONLY when the metric selection actually changed, instead
  // of every poll tick (re-attaching an unchanged PID would re-inject the DLL).
  const attachedFlags = useRef(layoutFlags);

  useEffect(() => {
    const setStatus = useOverlayStatus.getState().setStatus;
    const detachCurrent = async () => {
      const pid = attachedPid.current;
      if (pid !== 0) {
        attachedPid.current = 0;
        await api.overlayDetach(pid).catch(() => undefined);
      }
    };

    if (!inject) {
      // Turning off: detach whatever we attached and clear the status.
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
          const pidChanged = attachedPid.current !== st.target.pid;
          const flagsChanged = attachedFlags.current !== flagsRef.current;
          // Attach (which injects on the backend) ONLY when the foreground game
          // changed or we haven't attached yet. When the same game stays in front
          // we must NOT re-attach every tick — that re-ran LoadLibraryW each poll
          // and leaked the DLL. We only re-issue attach to push a layout-flag
          // change, which the backend handles as a cheap shared-memory update
          // (no re-injection). An unchanged pid + unchanged flags does no IPC.
          if (pidChanged) {
            if (attachedPid.current !== 0) await detachCurrent();
            const attached = await api.overlayAttach(st.target.pid, flagsRef.current);
            attachedPid.current = st.target.pid;
            attachedFlags.current = flagsRef.current;
            if (alive) setStatus(attached);
          } else if (flagsChanged) {
            // Same game, new metric selection: backend updates the shared block's
            // layout flags in place rather than re-injecting.
            const attached = await api.overlayAttach(st.target.pid, flagsRef.current);
            attachedFlags.current = flagsRef.current;
            if (alive) setStatus(attached);
          } else if (alive) {
            // Steady state: nothing changed. Refresh the status line only.
            setStatus(st);
          }
        } else {
          // Not injectable (anti-cheat / unsupported / no game): drop any prior
          // attach and surface the reason (backend already chose the fallback).
          if (attachedPid.current !== 0) await detachCurrent();
          if (alive) setStatus(st);
        }
      } catch {
        if (alive) setStatus(null);
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
      // No detach here: App stays mounted for the whole session, so this cleanup
      // only runs when `inject` flips off (handled at the top of the next run).
    };
  }, [inject]);
}
