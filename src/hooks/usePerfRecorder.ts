import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { tf } from "../lib/i18n";
import { api, type PerfSessionEvent } from "../lib/ipc";
import {
  downsample,
  gameDisplayName,
  summarize,
  type PerfSession,
} from "../lib/perf";
import { usePerfHistory } from "../store/perfHistory";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useSettings } from "../store/settings";
import { useUi } from "../store/ui";
import { useOsdTargets } from "../store/osd";
import { useRecordTargets } from "../store/recordTargets";

/**
 * Per-game performance session recorder — frontend half.
 *
 * The actual sampling now lives in the **Rust backend** (`perf_recorder.rs`): a
 * native thread is immune to the WebView2 renderer freeze that occurs when a
 * GPU-heavy game holds the foreground (which silently dropped ~1 in 3 sessions
 * when sampling ran here on a `setInterval`). This hook is now purely the
 * persist + present half:
 *
 *  1. **Push config to the backend.** On mount, and whenever the relevant stores
 *     change (`settings.perfRecording`, the record white/black list, the OSD
 *     whitelist), we send the flat, lowercased lists to the recorder thread via
 *     `api.perfRecorderConfig`. The backend never parses the store itself.
 *  2. **Listen for finished sessions.** The backend emits `perf://session` when a
 *     recorded game exits. We build the full `PerfSession` (summarize + downsample
 *     the samples), persist it to history, fire the game notification, and — when
 *     "auto-show report" is on — surface the report.
 *
 * Why the popup timing still works: the listener lives in the MAIN window. When
 * the game closes, the main window returns to the foreground and its renderer
 * un-freezes, so any `perf://session` queued during the freeze is delivered right
 * then — exactly when we want the report to appear.
 */
export function usePerfRecorder(): void {
  useEffect(() => {
    /** Send a Windows system notification (permission-guarded; best-effort). */
    const notify = async (body: string) => {
      if (!useSettings.getState().gameNotify) return;
      try {
        let granted = await isPermissionGranted();
        if (!granted) granted = (await requestPermission()) === "granted";
        if (granted) sendNotification({ title: "CorePilot", body });
      } catch {
        /* notifications unavailable — ignore */
      }
    };

    /**
     * Bring CorePilot to the front and open a just-finalized session's report.
     *
     * A game just exited, so the window may be backgrounded or hidden in the
     * tray. `show()` + `setFocus()` alone is unreliable on Windows (a background
     * process can't call SetForegroundWindow), so we briefly pin always-on-top
     * to force it visibly to the top, then unpin — the same trick as
     * `src-tauri/src/tray.rs`. Navigation (main tab → monitor, sub-tab → 历史,
     * pending report) is set first so the report is already on screen when the
     * window appears. Best-effort: window calls are wrapped so a failure can
     * never break finalize.
     */
    const surfaceReport = async (id: string) => {
      // Drive navigation first (synchronous store writes; can't throw).
      usePerfHistory.getState().setPendingReport(id);
      useUi.getState().setMonitorSub("history");
      useUi.getState().setTab("monitor");
      try {
        const w = getCurrentWindow();
        await w.show();
        await w.unminimize();
        await w.setAlwaysOnTop(true);
        await w.setFocus();
        await w.setAlwaysOnTop(false);
      } catch {
        /* window API unavailable — navigation still happened, just no raise */
      }
    };

    /**
     * Push the current recorder config to the backend. Reads the stores directly
     * (so it's safe to call from a subscribe callback). The backend stores these
     * and applies them on its next tick.
     */
    const pushConfig = () => {
      const enabled = useSettings.getState().perfRecording;
      const recTargets = useRecordTargets.getState().targets;
      const osdTargets = useOsdTargets.getState().targets;
      const white = recTargets.filter((t) => t.list === "white").map((t) => t.name);
      const black = recTargets.filter((t) => t.list === "black").map((t) => t.name);
      const osdWhite = osdTargets.filter((t) => t.list === "white").map((t) => t.name);
      api.perfRecorderConfig({ enabled, white, black, osdWhite }).catch(() => undefined);
    };

    /**
     * Persist + surface a finished session emitted by the backend. Builds the full
     * `PerfSession` the report renders (id/name/refreshHz + summary + downsampled
     * samples) from the backend payload, whose `samples` already match the
     * frontend `PerfSample` shape.
     */
    const onSession = (payload: PerfSessionEvent) => {
      if (!payload.samples || payload.samples.length === 0) return; // nothing to keep
      const session: PerfSession = {
        id: crypto.randomUUID(),
        exe: payload.exe,
        path: payload.path,
        name: gameDisplayName(payload.exe),
        startedAt: payload.startedAt,
        endedAt: payload.endedAt,
        durationSec: payload.durationSec,
        cpuName: payload.cpuName,
        gpuName: payload.gpuName,
        refreshHz: null,
        // Summarize from the FULL series, then downsample for storage (matches the
        // old in-app recorder's finalize exactly).
        summary: summarize(payload.samples),
        samples: downsample(payload.samples),
      };
      usePerfHistory.getState().addSession(session);
      void notify(tf(`${session.name} 性能报告已生成`, `${session.name} performance report generated`));
      if (useSettings.getState().autoShowReport) void surfaceReport(session.id);
    };

    // Push config now and keep the backend in sync with the three stores that
    // affect recording. Each `subscribe` returns its own unsubscribe.
    pushConfig();
    const unsubSettings = useSettings.subscribe(pushConfig);
    const unsubRecord = useRecordTargets.subscribe(pushConfig);
    const unsubOsdTargets = useOsdTargets.subscribe(pushConfig);

    // Listen for finished sessions from the backend recorder. `listen` resolves to
    // an unlisten fn asynchronously. Guard the mount/cleanup race (React 18/19
    // StrictMode double-invokes effects in dev): if cleanup runs before the
    // promise resolves, `unlisten` is still undefined, so the late-resolved
    // listener would leak — and every `perf://session` would be handled twice,
    // persisting duplicate sessions. The `disposed` flag detaches it immediately.
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void listen<PerfSessionEvent>("perf://session", (e) => onSession(e.payload)).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });

    return () => {
      unsubSettings();
      unsubRecord();
      unsubOsdTargets();
      disposed = true;
      unlisten?.();
    };
  }, []);
}
