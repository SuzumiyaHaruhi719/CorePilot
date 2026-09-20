import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { tf } from "../lib/i18n";
import { api, type PerfSessionEvent } from "../lib/ipc";
import { gameDisplayName } from "../lib/perf";
import { saveSamples, type PerfSessionMeta } from "../lib/perfSamples";
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
 *     recorded game exits. We write its samples to their own file, add the
 *     metadata row to history, fire the game notification, and — when
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
    // Dedupe: this runs on EVERY change of the three stores — including per-frame
    // settings writes like a window-opacity slider drag — but the recorder config
    // almost never changes. Skip the IPC when the payload is identical to the
    // last one sent.
    let lastSent = "";
    const pushConfig = () => {
      const enabled = useSettings.getState().perfRecording;
      const recTargets = useRecordTargets.getState().targets;
      const osdTargets = useOsdTargets.getState().targets;
      const white = recTargets.filter((t) => t.list === "white").map((t) => t.name);
      const black = recTargets.filter((t) => t.list === "black").map((t) => t.name);
      const osdWhite = osdTargets.filter((t) => t.list === "white").map((t) => t.name);
      const payload = { enabled, white, black, osdWhite };
      const key = JSON.stringify(payload);
      if (key === lastSent) return;
      lastSent = key;
      api.perfRecorderConfig(payload).catch(() => undefined);
    };

    /**
     * Persist + surface a finished session emitted by the backend. The row that
     * lands in history is METADATA only (id/name/refreshHz + summary, ~1 KB);
     * the ~1200 downsampled samples go to their own file.
     *
     * Order matters: the samples file is written and AWAITED first, then the
     * history row is added. A crash in that gap leaves an orphan file (swept on
     * the next hydration) — never a history row that charts nothing. If the
     * write fails outright we still keep the session, with its samples inline as
     * a fat row, and the store's post-hydration repair retries the split later;
     * dropping a just-recorded run would be the worse outcome.
     */
    const onSession = async (payload: PerfSessionEvent) => {
      if (!payload.samples || payload.samples.length === 0) return;
      const id = crypto.randomUUID();
      const session: PerfSessionMeta = {
        id, exe: payload.meta.exe, path: payload.meta.path,
        name: gameDisplayName(payload.meta.exe), startedAt: payload.meta.startedAt,
        endedAt: payload.meta.endedAt, durationSec: payload.meta.durationSec,
        cpuName: payload.meta.cpuName, gpuName: payload.meta.gpuName, refreshHz: null,
        summary: payload.summary,
      };
      try {
        await saveSamples(id, payload.samples); // file first; also primes the LRU
      } catch {
        session.samples = payload.samples; // never lose a run over a failed write
      }
      // Wait for the history store to finish hydrating before adding the row.
      // The v1→v2 migrate is multi-second (up to 50 sequential fsync'd sample
      // writes); a game exiting inside that window would add the session to the
      // pre-hydration state, and zustand would then overwrite `sessions` with
      // the migrated blob — silently losing the run that just finished.
      // Bounded, because hydration can never finish at all: when zustand's
      // rehydrate chain rejects (a poisoned persist mutex makes every
      // `persist_set` fail) it calls back with the error and stops — it never
      // flips `hasHydrated` and never fires the finish listeners. An unbounded
      // await there dropped the finished run on the floor, and since the samples
      // file was already written, the next launch's orphan sweep deleted that
      // too: the run was lost twice. Proceeding on timeout is safe — zustand
      // applies the rehydrated state BEFORE persisting it, so the worst case is
      // appending to state that is already correct.
      if (!usePerfHistory.persist.hasHydrated()) {
        await Promise.race([
          new Promise<void>((r) => usePerfHistory.persist.onFinishHydration(() => r())),
          new Promise<void>((r) => setTimeout(r, 20_000)),
        ]);
      }
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
    void listen<PerfSessionEvent>("perf://session", (e) => void onSession(e.payload)).then((fn) => {
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
