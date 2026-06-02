import { useEffect, useRef } from "react";
import { api } from "../lib/ipc";
import { fetchOsdData } from "../lib/osd";
import {
  downsample,
  gameDisplayName,
  summarize,
  type PerfSample,
  type PerfSession,
} from "../lib/perf";
import { usePerfHistory } from "../store/perfHistory";

/** Sampling cadence — one ~1 Hz tick per second while a game is foregrounded. */
const SAMPLE_INTERVAL_MS = 1000;

/** Live recording state, held in a ref so ticks never trigger re-renders. */
interface ActiveSession {
  /** Lowercased exe name of the detected game. */
  exe: string;
  /** Foreground PID being tracked. */
  pid: number;
  /** Epoch ms when recording started (also the sample-`t` base). */
  startedAt: number;
  cpuName: string | null;
  gpuName: string | null;
  samples: PerfSample[];
}

/**
 * Per-game performance session recorder.
 *
 * A single ~1 Hz effect that, while a detected game holds the foreground, samples
 * the same metrics the OSD reads (FPS / frame time, CPU & GPU load / temp / power
 * / clock, VRAM & RAM usage) into an in-memory buffer. When the tracked game's
 * process exits — or the user switches to a different game — the buffered session
 * is summarized and persisted to history (store/perfHistory) for the Monitor → 历史
 * report. Alt-tabbing away from a still-running game pauses sampling without
 * finalizing.
 *
 * The active session lives in a `useRef` (not state) so high-frequency sampling
 * never re-renders the app. A `running` guard ref ensures a slow tick (awaiting
 * IPC) can never overlap the next one. Every tick is wrapped in try/catch so a
 * transient IPC failure is swallowed rather than thrown — the recorder degrades
 * silently and can never crash the app.
 */
export function usePerfRecorder(): void {
  const active = useRef<ActiveSession | null>(null);
  const running = useRef(false);

  useEffect(() => {
    /** Summarize + persist a session, or discard it if it captured no samples. */
    const finalize = (session: ActiveSession) => {
      if (session.samples.length === 0) return; // nothing worth keeping
      const endedAt = Date.now();
      const report: PerfSession = {
        id: crypto.randomUUID(),
        exe: session.exe,
        name: gameDisplayName(session.exe),
        startedAt: session.startedAt,
        endedAt,
        durationSec: Math.round((endedAt - session.startedAt) / 1000),
        cpuName: session.cpuName,
        gpuName: session.gpuName,
        refreshHz: null,
        summary: summarize(session.samples),
        samples: downsample(session.samples),
      };
      usePerfHistory.getState().addSession(report);
    };

    /** Begin tracking a freshly-detected foreground game. */
    const start = async (exe: string, pid: number) => {
      const cpuName = await api
        .getOverview()
        .then((o) => o.cpuName)
        .catch(() => null);
      const gpuName = await api
        .gpuOcInfo()
        .then((g) => g.name)
        .catch(() => null);
      active.current = {
        exe: exe.toLowerCase(),
        pid,
        startedAt: Date.now(),
        cpuName,
        gpuName,
        samples: [],
      };
    };

    /** Pull one OSD snapshot and append a sample to the active session. */
    const sample = async (session: ActiveSession) => {
      const d = await fetchOsdData(true, true);
      const memUsed = d.metrics?.memUsed ?? 0;
      const memTotal = d.metrics?.memTotal ?? 0;
      const vramUsed = d.gpu?.memUsedBytes ?? 0;
      const vramTotal = d.gpu?.memTotalBytes ?? 0;
      const s: PerfSample = {
        t: Date.now() - session.startedAt,
        fps: d.fps?.fps ?? null,
        frametimeMs: d.fps?.frametimeMs ?? null,
        cpuLoad: d.metrics?.cpuOverall ?? null,
        cpuTemp: d.sensors?.cpuTemp ?? null,
        cpuPower: d.sensors?.cpuPower ?? null,
        cpuClock: d.sensors?.cpuClock ?? null,
        gpuLoad: d.gpu?.utilizationGpu ?? d.sensors?.gpuPct ?? null,
        gpuTemp: d.gpu?.temperature ?? d.sensors?.gpuTemp ?? null,
        gpuPower: d.gpu?.powerUsageW ?? d.sensors?.gpuPower ?? null,
        gpuClock: d.gpu?.graphicsClock ?? null,
        vramLoad: vramTotal > 0 ? (vramUsed / vramTotal) * 100 : null,
        memLoad: memTotal > 0 ? (memUsed / memTotal) * 100 : null,
      };
      session.samples.push(s);
    };

    const tick = async () => {
      if (running.current) return; // a previous (slow) tick is still in flight
      running.current = true;
      try {
        const fg = await api.foregroundInfo();
        const cur = active.current;

        // Finalize-on-exit / switch: the foreground PID no longer matches the
        // session we're tracking.
        if (cur && fg.pid !== cur.pid) {
          const alive = await api.pidAlive(cur.pid);
          if (!alive) {
            // The game process exited — close out the report.
            finalize(cur);
            active.current = null;
          } else {
            // Still running, just alt-tabbed away — pause without finalizing.
            return;
          }
        }

        // Start: a game is foregrounded and we're not already recording it.
        if (fg.isGame && fg.exe) {
          const exe = fg.exe.toLowerCase();
          const existing = active.current;
          if (!existing || existing.exe !== exe) {
            if (existing) {
              // Different game took over — finalize the old session first.
              finalize(existing);
              active.current = null;
            }
            await start(fg.exe, fg.pid);
          }
        }

        // Sample: append a data point for the live session.
        const live = active.current;
        if (live && fg.pid === live.pid) {
          await sample(live);
        }
      } catch {
        /* transient IPC failure — skip this tick, never throw */
      } finally {
        running.current = false;
      }
    };

    void tick();
    const id = window.setInterval(() => void tick(), SAMPLE_INTERVAL_MS);
    return () => {
      window.clearInterval(id);
      if (active.current) {
        finalize(active.current);
        active.current = null;
      }
    };
  }, []);
}
