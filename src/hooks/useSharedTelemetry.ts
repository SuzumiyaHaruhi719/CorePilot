import { useEffect, useSyncExternalStore } from "react";
import { api, type Metrics, type Sensors } from "../lib/ipc";
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
  const subs = new Set<() => void>();

  const emit = () => {
    for (const cb of subs) cb();
  };
  const tick = async () => {
    try {
      value = await fetcher();
      emit();
    } catch {
      /* backend not ready / transient — keep last value */
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
