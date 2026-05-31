import { useEffect, useState } from "react";
import { api, type Metrics } from "../lib/ipc";
import { useSettings } from "../store/settings";

interface MetricsHistory {
  cpu: number[];
  memPct: number[];
  latest: Metrics | null;
}

/** Polls system metrics and keeps rolling history buffers for charts. */
export function useMetricsHistory(points = 60): MetricsHistory {
  const [cpu, setCpu] = useState<number[]>(() => new Array(points).fill(0));
  const [memPct, setMemPct] = useState<number[]>(() => new Array(points).fill(0));
  const [latest, setLatest] = useState<Metrics | null>(null);
  const pollMs = useSettings((s) => s.pollMs);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const m = await api.getMetrics();
        if (!alive) return;
        setLatest(m);
        setCpu((prev) => [...prev.slice(1), m.cpuOverall]);
        setMemPct((prev) => [...prev.slice(1), (m.memUsed / m.memTotal) * 100]);
      } catch {
        /* ignore */
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), Math.max(pollMs, 1000));
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [pollMs, points]);

  return { cpu, memPct, latest };
}
