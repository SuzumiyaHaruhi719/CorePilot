import { useEffect, useSyncExternalStore } from "react";
import { api, withTimeout, type GpuOcInfo, type Metrics, type Sensors } from "../lib/ipc";
import { useSettings } from "../store/settings";
import { useUiActive } from "./useUiActive";

/**
 * Shared, ref-counted singleton pollers for the backend telemetry reads.
 *
 * Previously StatusBar, Monitor, PerfView and the metrics-history hook each ran
 * their own `setInterval` hitting `get_metrics`/`get_sensors`, so when several
 * mounted together they multiplied the IPC + re-render load. These singletons
 * fetch ONCE per interval no matter how many components subscribe (and stop when
 * the last subscriber unmounts). The interval follows `settings.pollMs`.
 *
 * Each poller has TWO subscriber lists, and the difference is load-bearing:
 *
 *   - `subscribe`   — notified on EVERY tick, always. This is the background
 *     recorder's feed; the history rings must keep filling while the window sits
 *     in the tray, otherwise the charts the user comes back to have a hole in
 *     them exactly where the interesting gaming session was.
 *   - `subscribeUi` — notified only while `useUiActive` says someone can see the
 *     window, and only when the payload actually CHANGED. This is React's feed.
 *     Re-rendering the metrics tree behind a fullscreen game is pure waste, and
 *     the backend sampler serves cached `Arc` snapshots, so byte-identical
 *     repeats are common whenever it throttles.
 */
interface PollerOpts {
  /**
   * When this returns true the poller skips the FETCH itself.
   *
   * Only for pollers whose sole consumer is the visible UI (gpuOcInfo). NEVER
   * set this on metrics/sensors: they feed the background history rings, and a
   * paused metrics poller would also freeze the visibility probe that is meant
   * to notice the user un-covering the window (nothing else would ever fire).
   */
  pauseWhen?: () => boolean;
}

/** Every poller built here, so one `useUiActive` subscription can wake them all. */
const ALL_POLLERS: Array<{ kick: () => void }> = [];

function makePoller<T>(fetcher: () => Promise<T>, opts: PollerOpts = {}) {
  let value: T | null = null;
  let timer: number | null = null;
  let intervalMs = 1500;
  let inFlight = false; // skip a tick if the previous fetch hasn't resolved
  let gen = 0; // fetch generation — a stale in-flight tick must not clobber refresh()
  let lastUiKey: string | null = null; // payload of the last notification React saw
  const subs = new Set<() => void>(); // always notified
  const uiSubs = new Set<() => void>(); // notified only while the UI is watched

  const emitAll = () => {
    for (const cb of subs) cb();
  };
  /**
   * Notify React. `force` bypasses both gates and is used on re-activation,
   * where the point is precisely to publish the value that piled up while gated.
   */
  const emitUi = (force: boolean) => {
    if (uiSubs.size === 0) return;
    if (!force && !useUiActive.getState().active) return;
    const key = JSON.stringify(value);
    if (!force && key === lastUiKey) return;
    lastUiKey = key;
    for (const cb of uiSubs) cb();
  };

  /** Commit a fetch result unless a newer fetch has started since (see `gen`). */
  const commit = (g: number, v: T, force: boolean) => {
    if (g !== gen) return;
    value = v;
    emitAll();
    emitUi(force);
  };

  const tick = async () => {
    // Backpressure: never pile up invokes on a slow backend. If the previous
    // fetch is still outstanding, skip this tick instead of queuing another.
    if (inFlight) return;
    if (opts.pauseWhen?.()) return;
    const g = ++gen;
    inFlight = true;
    try {
      commit(g, await withTimeout(fetcher()), false);
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
  const live = () => subs.size + uiSubs.size > 0;
  const add = (set: Set<() => void>, cb: () => void): (() => void) => {
    set.add(cb);
    if (subs.size + uiSubs.size === 1) start();
    return () => {
      set.delete(cb);
      if (!live()) stop();
    };
  };

  const poller = {
    /** Raw feed: fires on every tick even while the UI is gated off. */
    subscribe(cb: () => void): () => void {
      return add(subs, cb);
    },
    /** React feed: gated on `useUiActive` + skipped when the payload is unchanged. */
    subscribeUi(cb: () => void): () => void {
      return add(uiSubs, cb);
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
    /**
     * The user can see the window again. Publish whatever accumulated while we
     * were gated (so the first frame they look at is current, not the one from
     * when they minimized), then fetch immediately rather than waiting out the
     * rest of the interval.
     */
    kick() {
      if (!live()) return;
      emitUi(true);
      void tick();
    },
    /**
     * Force an immediate re-read, ignoring `pauseWhen` AND the in-flight guard.
     *
     * For "I just wrote the hardware, re-read it now" callers (GPU apply/reset).
     * Bypassing `inFlight` matters: a tick that started before the apply landed
     * would otherwise be the next thing to commit, and the page would show the
     * PRE-apply clocks as if the apply had done nothing. The `gen` bump makes
     * that older tick discard its result instead.
     */
    async refresh(): Promise<T | null> {
      const g = ++gen;
      try {
        commit(g, await withTimeout(fetcher()), true);
      } catch {
        /* keep last good value */
      }
      return value;
    },
  };
  ALL_POLLERS.push(poller);
  return poller;
}

// One place where "the user is looking again" wakes everything: every poller
// publishes its held value and fetches immediately, so the UI is live the instant
// it is looked at instead of showing the last pre-minimize reading for a second.
// Registered once at module load against a plain store, so it survives remounts.
useUiActive.subscribe((s, prev) => {
  if (!s.active || prev.active) return;
  for (const p of ALL_POLLERS) p.kick();
});

const sensorsPoller = makePoller<Sensors>(api.getSensors);
const metricsPoller = makePoller<Metrics>(api.getMetrics);
// GPU overclock/telemetry snapshot (~20 NVML calls per read). PerfView, GpuDetail
// and GpuTune each ran their OWN interval against it; now there is one per window.
// Safe to pause outright while nobody can see the window: unlike metrics/sensors
// it feeds no background ring and no recorder.
const gpuOcPoller = makePoller<GpuOcInfo>(api.gpuOcInfo, {
  pauseWhen: () => !useUiActive.getState().active,
});

/** Latest sensors from the shared poller (one interval app-wide). */
export function useSharedSensors(): Sensors | null {
  const pollMs = useSettings((s) => s.pollMs);
  useEffect(() => sensorsPoller.setInterval(pollMs), [pollMs]);
  return useSyncExternalStore(sensorsPoller.subscribeUi, sensorsPoller.getSnapshot);
}

/** Latest metrics from the shared poller (one interval app-wide). */
export function useSharedMetrics(): Metrics | null {
  const pollMs = useSettings((s) => s.pollMs);
  useEffect(() => metricsPoller.setInterval(pollMs), [pollMs]);
  return useSyncExternalStore(metricsPoller.subscribeUi, metricsPoller.getSnapshot);
}

/** Latest NVML GPU snapshot from the shared poller (one interval app-wide). */
export function useSharedGpuOc(): GpuOcInfo | null {
  const pollMs = useSettings((s) => s.pollMs);
  useEffect(() => gpuOcPoller.setInterval(pollMs), [pollMs]);
  return useSyncExternalStore(gpuOcPoller.subscribeUi, gpuOcPoller.getSnapshot);
}

/**
 * Re-read the GPU snapshot NOW and publish it to every `useSharedGpuOc` consumer.
 * Call after an apply/reset writes the card so the readout reflects what was just
 * written, instead of the previous interval's values.
 */
export function refreshGpuOc(): Promise<GpuOcInfo | null> {
  return gpuOcPoller.refresh();
}

/**
 * Raw metrics-tick subscription — fires on EVERY poll, including while the UI is
 * gated inactive. This is the heartbeat the visibility probe in <App> rides on;
 * it must keep beating while we believe nobody is looking, because that probe is
 * the only thing that can ever observe the window becoming visible again.
 */
export function onMetricsTick(cb: () => void): () => void {
  return metricsPoller.subscribe(cb);
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
