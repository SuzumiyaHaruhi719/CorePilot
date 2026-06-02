import { useEffect, useRef } from "react";
import { api } from "../lib/ipc";
import { useGroups } from "../store/groups";
import { useUi } from "../store/ui";

/**
 * In-app affinity "memory": while CorePilot runs and optimization is enabled,
 * periodically binds newly-launched processes that match a group's patterns to
 * that group's cores/priority. Zero work until at least one group has patterns.
 * (A boot-time background daemon is the planned full version.)
 */
export function useAffinityEnforcer(fullMask: bigint) {
  const optimizationEnabled = useUi((s) => s.optimizationEnabled);
  const applied = useRef<Set<number>>(new Set());

  useEffect(() => {
    if (!optimizationEnabled || fullMask === 0n) {
      applied.current.clear();
      return;
    }
    let alive = true;

    const enforce = async () => {
      const groups = useGroups.getState().groups;
      if (!groups.some((g) => g.patterns.length > 0)) return; // nothing to enforce
      let procs;
      try {
        procs = await api.listProcesses();
      } catch {
        return;
      }
      if (!alive) return;

      const live = new Set(procs.map((p) => p.pid));
      for (const pid of [...applied.current]) {
        if (!live.has(pid)) applied.current.delete(pid);
      }

      for (const p of procs) {
        if (applied.current.has(p.pid)) continue;
        const group = groups.find((g) => g.patterns.includes(p.name.toLowerCase()));
        if (!group) continue;
        const mask = group.mask === 0n ? fullMask : group.mask;
        try {
          await api.setAffinity(p.pid, mask);
          if (group.priority !== 0x20) {
            await api.setPriority(p.pid, group.priority).catch(() => undefined);
          }
          applied.current.add(p.pid);
        } catch {
          /* protected process — skip */
        }
      }
    };

    void enforce();
    const id = window.setInterval(() => void enforce(), 8000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [optimizationEnabled, fullMask]);
}
