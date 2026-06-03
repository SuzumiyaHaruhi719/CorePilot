import { useEffect, useState } from "react";
import { api, type Sensors } from "../lib/ipc";
import { useSettings } from "../store/settings";

/** Polls hardware sensors (GPU / disk / network / power) for the perf view.
 *
 * History arrays are fixed-length ring buffers (length `points`) updated each
 * poll, so charts can render a stable rolling window. Network up/down are kept
 * as separate series (for the dual-axis 网络 chart) in addition to the combined
 * `netHist`; `powerHist` is the live CPU+GPU total used by the 总功耗 chart. */
export function useSensors(points = 60): {
  latest: Sensors | null;
  gpuHist: number[];
  diskHist: number[];
  netHist: number[];
  netUpHist: number[];
  netDownHist: number[];
  powerHist: number[];
} {
  const [latest, setLatest] = useState<Sensors | null>(null);
  const [gpuHist, setGpuHist] = useState<number[]>(() => new Array(points).fill(0));
  const [diskHist, setDiskHist] = useState<number[]>(() => new Array(points).fill(0));
  const [netHist, setNetHist] = useState<number[]>(() => new Array(points).fill(0));
  const [netUpHist, setNetUpHist] = useState<number[]>(() => new Array(points).fill(0));
  const [netDownHist, setNetDownHist] = useState<number[]>(() => new Array(points).fill(0));
  const [powerHist, setPowerHist] = useState<number[]>(() => new Array(points).fill(0));
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
        setNetUpHist((prev) => [...prev.slice(1), s.netUp ?? 0]);
        setNetDownHist((prev) => [...prev.slice(1), s.netDown ?? 0]);
        setPowerHist((prev) => [...prev.slice(1), (s.cpuPower ?? 0) + (s.gpuPower ?? 0)]);
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

  return { latest, gpuHist, diskHist, netHist, netUpHist, netDownHist, powerHist };
}
