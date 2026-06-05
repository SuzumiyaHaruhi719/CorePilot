import { useEffect, useState } from "react";
import { type Sensors } from "../lib/ipc";
import { useSharedSensors } from "./useSharedTelemetry";

/** Rolling sensor history for the perf views, fed by the shared sensors poller
 *  (one `get_sensors` interval app-wide instead of one per consuming view).
 *
 * History arrays are fixed-length ring buffers (length `points`) updated on each
 * new reading. Network up/down are kept as separate series (for the dual-axis 网络
 * chart) in addition to the combined `netHist`; `powerHist` is the live CPU+GPU
 * total used by the 总功耗 chart. */
export function useSensors(points = 60): {
  latest: Sensors | null;
  gpuHist: number[];
  diskHist: number[];
  netHist: number[];
  netUpHist: number[];
  netDownHist: number[];
  powerHist: number[];
} {
  const latest = useSharedSensors();
  const [gpuHist, setGpuHist] = useState<number[]>(() => new Array(points).fill(0));
  const [diskHist, setDiskHist] = useState<number[]>(() => new Array(points).fill(0));
  const [netHist, setNetHist] = useState<number[]>(() => new Array(points).fill(0));
  const [netUpHist, setNetUpHist] = useState<number[]>(() => new Array(points).fill(0));
  const [netDownHist, setNetDownHist] = useState<number[]>(() => new Array(points).fill(0));
  const [powerHist, setPowerHist] = useState<number[]>(() => new Array(points).fill(0));

  useEffect(() => {
    if (!latest) return;
    const s = latest;
    setGpuHist((prev) => [...prev.slice(1), s.gpuPct ?? 0]);
    setDiskHist((prev) => [...prev.slice(1), (s.diskRead ?? 0) + (s.diskWrite ?? 0)]);
    setNetHist((prev) => [...prev.slice(1), (s.netUp ?? 0) + (s.netDown ?? 0)]);
    setNetUpHist((prev) => [...prev.slice(1), s.netUp ?? 0]);
    setNetDownHist((prev) => [...prev.slice(1), s.netDown ?? 0]);
    setPowerHist((prev) => [...prev.slice(1), (s.cpuPower ?? 0) + (s.gpuPower ?? 0)]);
  }, [latest]);

  return { latest, gpuHist, diskHist, netHist, netUpHist, netDownHist, powerHist };
}
