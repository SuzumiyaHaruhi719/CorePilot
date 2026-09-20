import { useEffect, useRef } from "react";
import { api } from "../lib/ipc";
import { freshProcessList } from "./useProcesses";
import { useGroups } from "../store/groups";
import { useUi } from "../store/ui";

/**
 * Freshness budget for the roster this hook pins by PID.
 *
 * 2 s mirrors the backend's own demand window: inside it `list_processes`
 * returns the sampler's cached snapshot anyway (see `proc_snapshot` in
 * src-tauri/src/sampler.rs), so re-asking would buy nothing but a second
 * expensive Toolhelp walk. Outside it, `freshProcessList` falls through to a
 * real call that lands on the backend's COLD path and blocks until a NEW
 * snapshot is published — which is the whole reason this hook cannot be allowed
 * to act on a cached list: Windows recycles PIDs fast, and pinning a pre-idle
 * roster's PID lands the affinity mask on an unrelated process.
 */
const MAX_ROSTER_AGE_MS = 2000;

/**
 * In-app affinity "memory": while CorePilot runs and optimization is enabled,
 * periodically binds newly-launched processes that match a group's patterns to
 * that group's cores/priority. Zero work until at least one group has patterns.
 * (A boot-time background daemon is the planned full version.)
 *
 * Deliberately NOT gated on `useUiActive`: this is a correctness feature, not a
 * rendering one. Its whole job is to catch a game that launches while CorePilot
 * sits hidden in the tray — the exact moment the UI is inactive.
 *
 * It no longer runs its own `list_processes` stream either. While the window is
 * visible the process table's shared 1.5 s poller already keeps a roster
 * fresher than this hook's 8 s cadence needs, so reusing it removes one of the
 * two `list_processes` callers entirely; while the window is hidden that poller
 * is parked, so `freshProcessList` issues the read itself and gets the same
 * cold-path guarantee the old direct call had.
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
    let inFlight = false;

    const enforce = async () => {
      // Backpressure: never overlap a run with one already outstanding, so a
      // slow backend can't pile up concurrent sweeps (that pile-up froze the
      // backend). `freshProcessList` de-dupes the IPC itself, but the
      // set_affinity loop below is this hook's own and must not interleave.
      if (inFlight) return;
      inFlight = true;
      try {
        const groups = useGroups.getState().groups;
        if (!groups.some((g) => g.patterns.length > 0)) return; // nothing to enforce
        const procs = await freshProcessList(MAX_ROSTER_AGE_MS);
        // `null` means the read failed — skip this round entirely rather than
        // falling back to the last-known list. An 8 s gap in enforcement is
        // harmless; pinning a mask onto a PID that has since been recycled is
        // not.
        if (!alive || procs === null) return;

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
      } finally {
        inFlight = false;
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
