import { useEffect, useState } from "react";
import { api, type ProcInfo } from "../lib/ipc";
import { useSettings } from "../store/settings";

/**
 * Polls the live process list while mounted. Tabs unmount when inactive
 * (AnimatePresence), so polling naturally pauses off-screen — lightweight.
 */
export function useProcesses(): { processes: ProcInfo[]; loading: boolean } {
  const [processes, setProcesses] = useState<ProcInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const pollMs = useSettings((s) => s.pollMs);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const data = await api.listProcesses();
        if (alive) {
          setProcesses(data);
          setLoading(false);
        }
      } catch {
        /* ignore transient errors */
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), Math.max(pollMs, 1000));
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [pollMs]);

  return { processes, loading };
}
