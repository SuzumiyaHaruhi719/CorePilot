import { useEffect, useState } from "react";
import { type Metrics } from "../lib/ipc";
import { useSharedMetrics } from "./useSharedTelemetry";

interface MetricsHistory {
  cpu: number[];
  memPct: number[];
  latest: Metrics | null;
}

/** Rolling history buffers for charts, fed by the shared metrics poller (so the
 *  app keeps a single `get_metrics` interval regardless of how many views use it). */
export function useMetricsHistory(points = 60): MetricsHistory {
  const [cpu, setCpu] = useState<number[]>(() => new Array(points).fill(0));
  const [memPct, setMemPct] = useState<number[]>(() => new Array(points).fill(0));
  const latest = useSharedMetrics();

  useEffect(() => {
    if (!latest) return;
    setCpu((prev) => [...prev.slice(1), latest.cpuOverall]);
    setMemPct((prev) => [
      ...prev.slice(1),
      latest.memTotal ? (latest.memUsed / latest.memTotal) * 100 : 0,
    ]);
  }, [latest]);

  return { cpu, memPct, latest };
}
