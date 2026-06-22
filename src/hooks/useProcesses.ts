import { useEffect, useState } from "react";
import { api, withTimeout, type ProcInfo } from "../lib/ipc";
import { useSettings } from "../store/settings";

export interface UseProcessesResult {
  processes: ProcInfo[];
  /** True until the first poll resolves (or fails). Distinguishes the initial
   *  read from a genuinely empty result so views can show a skeleton. */
  loading: boolean;
  /** Set when the *first* read fails (no data to fall back on). Cleared once a
   *  poll succeeds. Transient errors after data exists are ignored. */
  error: boolean;
}

/**
 * Polls the live process list while mounted. Tabs unmount when inactive
 * (AnimatePresence), so polling naturally pauses off-screen — lightweight.
 */
export function useProcesses(): UseProcessesResult {
  const [processes, setProcesses] = useState<ProcInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const pollMs = useSettings((s) => s.pollMs);

  useEffect(() => {
    let alive = true;
    let gotData = false;
    let inFlight = false;
    const tick = async () => {
      // Backpressure: list_processes can take a while under load; never queue a
      // second call while one is outstanding (that pile-up froze the backend).
      if (inFlight) return;
      inFlight = true;
      try {
        const data = await withTimeout(api.listProcesses());
        if (alive) {
          gotData = true;
          setProcesses(data);
          setError(false);
          setLoading(false);
        }
      } catch {
        // Only surface an error before we have any data to show. Once a read
        // has succeeded, keep the last good list and ignore transient failures.
        if (alive && !gotData) {
          setError(true);
          setLoading(false);
        }
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), Math.max(pollMs, 1000));
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [pollMs]);

  return { processes, loading, error };
}
