import { useEffect, useState } from "react";
import { api, type Sensors } from "../lib/ipc";
import { useSettings } from "../store/settings";

/** Polls hardware sensors (GPU / disk / network / power) for the perf view. */
export function useSensors(points = 60): {
  latest: Sensors | null;
  gpuHist: number[];
  diskHist: number[];
  netHist: number[];
} {
  const [latest, setLatest] = useState<Sensors | null>(null);
  const [gpuHist, setGpuHist] = useState<number[]>(() => new Array(points).fill(0));
  const [diskHist, setDiskHist] = useState<number[]>(() => new Array(points).fill(0));
  const [netHist, setNetHist] = useState<number[]>(() => new Array(points).fill(0));
  const pollMs = useSettings((s) => s.pollMs);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const s = await api.getSensors();
        if (!alive) return;
        setLatest(s);
        setGpuHist((prev) => [...prev.slice(1), s.gpuPct ?? 0]);
        setDiskHist((prev) => [...prev.slice(1), (s.diskRead ?? 0) + (s.diskWrite ?? 0)]);
        setNetHist((prev) => [...prev.slice(1), (s.netUp ?? 0) + (s.netDown ?? 0)]);
      } catch {
        /* command may not be available yet */
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), Math.max(pollMs, 1000));
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [pollMs, points]);

  return { latest, gpuHist, diskHist, netHist };
}
