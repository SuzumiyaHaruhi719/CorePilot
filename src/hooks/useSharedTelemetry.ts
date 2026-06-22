import { useEffect, useSyncExternalStore } from "react";
import { api, withTimeout, type Metrics, type Sensors } from "../lib/ipc";
import { useSettings } from "../store/settings";

/**
 * Shared, ref-counted singleton pollers for the two backend telemetry reads.
 *
 * Previously StatusBar, Monitor, PerfView and the metrics-history hook each ran
 * their own `setInterval` hitting `get_metrics`/`get_sensors`, so when several
 * mounted together they multiplied the IPC + re-render load. These singletons
 * fetch ONCE per interval no matter how many components subscribe (and stop when
 * the last subscriber unmounts). The interval follows `settings.pollMs`.
 */
function makePoller<T>(fetcher: () => Promise<T>) {
  let value: T | null = null;
  let timer: number | null = null;
  let intervalMs = 1500;
  let inFlight = false; // skip a tick if the previous fetch hasn't resolved
  const subs = new Set<() => void>();

  const emit = () => {
    for (const cb of subs) cb();
  };
  const tick = async () => {
    // Backpressure: never pile up invokes on a slow backend. If the previous
    // fetch is still outstanding, skip this tick instead of queuing another.
    if (inFlight) return;
    inFlight = true;
    try {
      value = await withTimeout(fetcher());
      emit();
    } catch {
      /* backend not ready / transient — keep last value */
    } finally {
      inFlight = false;
    }
  };
  const start = () => {
    if (timer != null) return;
    void tick();
    timer = window.setInterval(() => void tick(), intervalMs);
  };
  const stop = () => {
    if (timer != null) {
      window.clearInterval(timer);
      timer = null;
    }
  };

  return {
    subscribe(cb: () => void): () => void {
      subs.add(cb);
      if (subs.size === 1) start();
      return () => {
        subs.delete(cb);
        if (subs.size === 0) stop();
      };
    },
    getSnapshot: (): T | null => value,
    setInterval(ms: number) {
      const next = Math.max(ms, 1000);
      if (next === intervalMs) return;
      intervalMs = next;
      if (timer != null) {
        stop();
        start();
      }
    },
  };
}

const sensorsPoller = makePoller<Sensors>(api.getSensors);
const metricsPoller = makePoller<Metrics>(api.getMetrics);

/** Latest sensors from the shared poller (one interval app-wide). */
export function useSharedSensors(): Sensors | null {
  const pollMs = useSettings((s) => s.pollMs);
  useEffect(() => sensorsPoller.setInterval(pollMs), [pollMs]);
  return useSyncExternalStore(sensorsPoller.subscribe, sensorsPoller.getSnapshot);
}

/** Latest metrics from the shared poller (one interval app-wide). */
export function useSharedMetrics(): Metrics | null {
  const pollMs = useSettings((s) => s.pollMs);
  useEffect(() => metricsPoller.setInterval(pollMs), [pollMs]);
  return useSyncExternalStore(metricsPoller.subscribe, metricsPoller.getSnapshot);
}

// --- background-recorded rolling history -----------------------------------------
// When `settings.bgRecord` is on, an app-level recorder keeps these module-level
// rings filling continuously — even while Task Manager / Monitor are closed — so
// their charts open already full instead of flat-then-filling.

/** History length (matches the charts' point count, default 60). */
const HISTORY_N = 60;
const ring = () => new Array<number>(HISTORY_N).fill(0);
const hist = {
  cpu: ring(), memPct: ring(), gpu: ring(), disk: ring(),
  net: ring(), netUp: ring(), netDown: ring(), power: ring(),
};
// Per-core (logical CPU) history is a 2D ring [coreCount][HISTORY_N], lazily
// sized to the first reading's core count so the Monitor / Task Manager per-core
// graphs also open already-full when background recording is on.
let perCoreHist: number[][] = [];
let recording = false;
const pushRing = (arr: number[], v: number) => {
  arr.shift();
  arr.push(Number.isFinite(v) ? v : 0);
};

/** True while background recording is active (charts seed from history on mount). */
export function isRecording(): boolean {
  return recording;
}

/** Copies of the current history rings, for seeding a chart's buffer on mount. */
export const historySnapshot = {
  cpu: () => hist.cpu.slice(),
  memPct: () => hist.memPct.slice(),
  gpu: () => hist.gpu.slice(),
  disk: () => hist.disk.slice(),
  net: () => hist.net.slice(),
  netUp: () => hist.netUp.slice(),
  netDown: () => hist.netDown.slice(),
  power: () => hist.power.slice(),
  /** Deep copy of the per-core rings ([coreCount][HISTORY_N]); empty until first sample. */
  perCore: () => perCoreHist.map((a) => a.slice()),
};

/**
 * App-level recorder. While `settings.bgRecord` is on, subscribe to the shared
 * metrics + sensors pollers (which also keeps them running) and append every
 * reading to the module-level rings. Mount once in <App>.
 */
export function useLiveHistoryRecorder(): void {
  const bgRecord = useSettings((s) => s.bgRecord);
  useEffect(() => {
    if (!bgRecord) {
      recording = false;
      return;
    }
    recording = true;
    const onM = () => {
      const m = metricsPoller.getSnapshot();
      if (!m) return;
      pushRing(hist.cpu, m.cpuOverall);
      pushRing(hist.memPct, m.memTotal ? (m.memUsed / m.memTotal) * 100 : 0);
      const pc = m.perCore ?? [];
      if (pc.length > 0) {
        if (perCoreHist.length !== pc.length) {
          perCoreHist = Array.from({ length: pc.length }, () => new Array(HISTORY_N).fill(0));
        }
        for (let i = 0; i < pc.length; i += 1) pushRing(perCoreHist[i], pc[i]);
      }
    };
    const onS = () => {
      const s = sensorsPoller.getSnapshot();
      if (!s) return;
      pushRing(hist.gpu, s.gpuPct ?? 0);
      pushRing(hist.disk, (s.diskRead ?? 0) + (s.diskWrite ?? 0));
      pushRing(hist.net, (s.netUp ?? 0) + (s.netDown ?? 0));
      pushRing(hist.netUp, s.netUp ?? 0);
      pushRing(hist.netDown, s.netDown ?? 0);
      pushRing(hist.power, (s.cpuPower ?? 0) + (s.gpuPower ?? 0));
    };
    const unM = metricsPoller.subscribe(onM);
    const unS = sensorsPoller.subscribe(onS);
    return () => {
      unM();
      unS();
      recording = false;
    };
  }, [bgRecord]);
}
