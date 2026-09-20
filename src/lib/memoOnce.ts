import { api, type CpuTopology, type GameEntry, type Overview } from "./ipc";

/**
 * Cache the first SUCCESSFUL result of a zero-argument async fetch for the rest
 * of the session.
 *
 * Why this exists: App.tsx remounts a tab's entire subtree on every tab switch
 * (`<AnimatePresence mode="wait">` + `key={tab}`). The remount is deliberate —
 * it stops the leaving tab's pollers — but it also re-issued the *static* IPCs
 * on every single visit. CPU topology cannot change while the process lives,
 * the system overview is fixed hardware/OS text, and the game library is
 * already cached for ~5 minutes in the backend. Re-fetching them bought nothing
 * and cost an IPC round-trip plus a visible skeleton / "正在扫描" flash each time.
 *
 * Concurrent callers share the in-flight promise, so two tabs mounting at once
 * still produce ONE backend call.
 *
 * A REJECTED call is deliberately NOT cached: at startup the backend may simply
 * not be ready yet (sampler still warming, sidecar still launching), and
 * memoizing that failure would leave the tab permanently empty until the user
 * restarts the app. The next caller retries.
 */
export function memoOnce<T>(fn: () => Promise<T>): (() => Promise<T>) & { invalidate: () => void } {
  let cached: Promise<T> | null = null;
  const wrapped = () => {
    if (!cached) {
      cached = fn().catch((e: unknown) => {
        cached = null;
        throw e;
      });
    }
    return cached;
  };
  wrapped.invalidate = () => {
    cached = null;
  };
  return wrapped;
}

/** CPU topology — fixed for the lifetime of the process. */
export const getTopologyOnce = memoOnce<CpuTopology>(() => api.getTopology());

/** CPU name / core counts / RAM / OS string — fixed hardware description. */
export const getOverviewOnce = memoOnce<Overview>(() => api.getOverview());

/**
 * Installed-game scan (Steam/Epic/GOG). Unlike the two above this CAN change
 * while the app runs — the user installs a game — so the OSD tab keeps an
 * explicit refresh button: call `gameLibraryListOnce.invalidate()` first, then
 * `gameLibraryListOnce()` (or `api.gameLibraryList()` directly) to re-scan.
 */
export const gameLibraryListOnce = memoOnce<GameEntry[]>(() => api.gameLibraryList());
