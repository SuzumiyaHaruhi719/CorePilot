import { useEffect, useSyncExternalStore } from "react";
import { api, withTimeout, type ProcInfo } from "../lib/ipc";
import { useSettings } from "../store/settings";
import { useUiActive } from "./useUiActive";

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
 * The single `list_processes` stream for this window.
 *
 * Three failures shaped this module; each guard below names the one it stops.
 *
 * 1. **Backend burn while nobody is looking.** `list_processes` is the most
 *    expensive backend read there is: it wakes `corepilot-sampler` out of its
 *    parked state and makes it run a full Toolhelp walk + per-PID OpenProcess
 *    pass (see `proc_snapshot` / the `wanted` gate in
 *    `src-tauri/src/sampler.rs`). The backend already idles that walk when no
 *    consumer has asked within 2 s — but it never got to idle, because this
 *    hook kept asking every 1.5 s from a window sitting hidden in the tray.
 *    WEBVIEW_ARGS disables Chromium's occlusion throttling process-wide (the
 *    parked OSD overlay needs its timers to keep firing), so a hidden page here
 *    runs its timers at full rate — the browser will not throttle us, we have
 *    to gate ourselves. Measured: the sampler thread sat at 15.8% of one core
 *    behind a fullscreen game. Ticks are therefore skipped while
 *    `useUiActive` reports inactive.
 *
 * 2. **N consumers = N streams.** Previously every mounted consumer ran its own
 *    `setInterval`, so Core Assignment + Task Manager mounted together doubled
 *    the IPC and the re-render load. One module-level poller now serves all of
 *    them, ref-counted: it starts with the first subscriber and stops with the
 *    last.
 *
 * 3. **A fresh object per row per tick.** `api.listProcesses` allocates a new
 *    object (and a new `BigInt` affinity) for every row on every poll, so every
 *    memoized row saw "new props" and re-rendered even when not one displayed
 *    number had moved. Rows whose displayed fields are all unchanged now keep
 *    their previous object identity, which lets `memo` comparators bail out.
 *
 * Deliberately NOT gated: the shared metrics/sensors pollers in
 * `useSharedTelemetry` keep running while inactive — the background history
 * rings feed off them and `bgRecord` users expect full charts when they come
 * back. Only this one (by far the most expensive) read stops.
 */

const EMPTY: ProcInfo[] = [];

/** Current published state. Replaced (never mutated) so `useSyncExternalStore`
 *  can compare by reference; handed out as-is from `getSnapshot`. */
let snapshot: UseProcessesResult = { processes: EMPTY, loading: true, error: false };
/** Last successfully published rows, kept for identity reuse + the enforcer. */
let rows: ProcInfo[] = EMPTY;
/** pid → previous row, rebuilt on every publish (identity-reuse lookup). */
let prevByPid = new Map<number, ProcInfo>();
/** `performance.now()` of the last successful read. Monotonic, so a system
 *  clock change can never make a stale list look fresh. */
let lastOkMs = 0;
let gotData = false;

let timer: number | null = null;
let intervalMs = 1500;
/** In-flight fetch, shared by the timer tick and any `freshProcessList` caller.
 *  Backpressure: `list_processes` can take a while under load and a pile-up of
 *  concurrent calls froze the backend once. Never issue a second one. */
let inFlight: Promise<ProcInfo[] | null> | null = null;
let unsubActive: (() => void) | null = null;
const subs = new Set<() => void>();

/**
 * Are these two rows displaying exactly the same thing?
 *
 * Every field any table actually renders is compared — including `handles` and
 * `cpuTime`, which move independently of `cpu` for an idle process; leaving
 * them out would freeze the Details table's 句柄 / CPU时间 columns on rows
 * sitting at 0% CPU. `name` is compared too: Windows recycles PIDs fast, and a
 * brand-new process inherits plausible defaults (0% CPU, 0 power, full
 * affinity), so matching on the numbers alone could re-use the dead process's
 * row object and keep showing its NAME under the new PID.
 */
export function sameRow(a: ProcInfo, b: ProcInfo): boolean {
  return (
    a.pid === b.pid &&
    a.name === b.name &&
    a.cpu === b.cpu &&
    a.gpu === b.gpu &&
    a.mem === b.mem &&
    a.power === b.power &&
    a.threads === b.threads &&
    a.affinity === b.affinity &&
    a.gpuMem === b.gpuMem &&
    a.handles === b.handles &&
    a.cpuTime === b.cpuTime &&
    a.gpuEngine === b.gpuEngine
  );
}

/** Swap in the previous row object wherever nothing displayed changed, then
 *  re-index. Mutates `next` in place — it is a freshly-decoded array that
 *  nobody else holds yet. */
function adoptUnchanged(next: ProcInfo[]): ProcInfo[] {
  if (prevByPid.size > 0) {
    for (let i = 0; i < next.length; i += 1) {
      const prev = prevByPid.get(next[i].pid);
      if (prev !== undefined && sameRow(prev, next[i])) next[i] = prev;
    }
  }
  const index = new Map<number, ProcInfo>();
  for (const p of next) index.set(p.pid, p);
  prevByPid = index;
  return next;
}

const emit = () => {
  for (const cb of subs) cb();
};

/** Resolves with the freshly-read rows, or `null` when the read failed.
 *  Never rejects, and never hands back the stale cache on failure — a caller
 *  that acts by PID has to be able to tell "here is the live roster" from
 *  "I could not read it", and silently substituting the old list is how a
 *  recycled PID gets acted on. */
function fetchOnce(): Promise<ProcInfo[] | null> {
  if (inFlight) return inFlight;
  const p: Promise<ProcInfo[] | null> = withTimeout(api.listProcesses())
    .then((data): ProcInfo[] | null => {
      const next = adoptUnchanged(data);
      rows = next;
      lastOkMs = performance.now();
      gotData = true;
      snapshot = { processes: next, loading: false, error: false };
      emit();
      return next;
    })
    .catch((): ProcInfo[] | null => {
      // Only surface an error before we have any data to show. Once a read has
      // succeeded, keep the last good list on screen and ignore transient
      // failures — but still report the failure to the caller.
      if (!gotData) {
        snapshot = { processes: EMPTY, loading: false, error: true };
        emit();
      }
      return null;
    })
    .finally(() => {
      if (inFlight === p) inFlight = null;
    });
  inFlight = p;
  return p;
}

function tick(): void {
  // THE gate. Skipping here (rather than clearing the timer) is deliberate: a
  // cleared timer that fails to restart is exactly the "the monitor just
  // stopped updating" class of bug this project keeps paying for, and a
  // callback that returns immediately 0.67 times a second costs nothing.
  if (!useUiActive.getState().active) return;
  dropStaleCache();
  void fetchOnce();
}

/** How old the cached roster may be and still be shown to a view that is only
 *  now mounting. Long enough that a tab switch keeps its rows (no skeleton
 *  flash), short enough that nobody is ever offered a right-click menu over a
 *  list of processes that died minutes ago. */
const SHOW_CACHED_MAX_MS = 10_000;

/** Throw away a roster too old to be shown, let alone acted on.
 *
 *  Must run on EVERY path back to live, not just on first mount. Hiding a Tauri
 *  window does not unmount React, so the common shape is the opposite of a
 *  remount: Task Manager stays mounted, the window goes to the tray for an hour
 *  of gaming, and `start()` never re-runs. Without this on the resume path the
 *  table painted the hour-old roster with live-looking CPU%, and `ProcessView`
 *  offers end-task / set-priority straight off those rows — on PIDs Windows has
 *  long since recycled. */
function dropStaleCache(): void {
  if (gotData && performance.now() - lastOkMs > SHOW_CACHED_MAX_MS) {
    rows = EMPTY;
    prevByPid = new Map();
    gotData = false;
    snapshot = { processes: EMPTY, loading: true, error: false };
    // The subscriber is already registered (see `subscribe`), and React read
    // getSnapshot during render — before this reset. Tell it, or the first
    // frame keeps painting the stale roster we just threw away.
    emit();
  }
}

function start(): void {
  if (timer != null) return;
  // A view mounting against a long-parked cache (tab reopened after sitting
  // elsewhere, window restored from a long tray stint) gets the skeleton it
  // would have got before this poller existed, rather than a table of dead
  // PIDs the user could right-click and act on. Unconditional here because
  // `tick()` below only purges once the gate is open.
  dropStaleCache();
  void tick();
  timer = window.setInterval(tick, intervalMs);
  // Resume instantly instead of waiting out the rest of the interval, so the
  // table is never more than one backend refresh behind after the user brings
  // the window back.
  unsubActive = useUiActive.subscribe((s, prev) => {
    if (s.active && !prev.active) tick();
  });
}

function stop(): void {
  if (timer != null) {
    window.clearInterval(timer);
    timer = null;
  }
  unsubActive?.();
  unsubActive = null;
}

const processesPoller = {
  subscribe(cb: () => void): () => void {
    subs.add(cb);
    if (subs.size === 1) start();
    return () => {
      subs.delete(cb);
      if (subs.size === 0) stop();
    };
  },
  getSnapshot: (): UseProcessesResult => snapshot,
  setInterval(ms: number) {
    const next = Math.max(ms, 1000);
    if (next === intervalMs) return;
    intervalMs = next;
    if (timer != null) {
      window.clearInterval(timer);
      timer = window.setInterval(tick, intervalMs);
    }
  },
};

/**
 * Process rows guaranteed to be no older than `maxAgeMs`, or `null` when a
 * fresh list could not be read.
 *
 * For non-rendering consumers (the affinity enforcer) that must act on a live
 * roster rather than paint one. When the cache is inside the window it is
 * handed back untouched — while the UI is visible that costs zero extra IPC,
 * because the table's own 1.5 s stream already keeps it fresh. When it is not
 * (which is every call once the window goes to the tray and the stream stops),
 * a real `list_processes` is issued: >2 s since the last request puts it on the
 * backend's cold path, which BLOCKS until the sampler publishes a NEW snapshot
 * (see `proc_snapshot` in src-tauri/src/sampler.rs). Never let a caller that
 * acts by PID read the cache without this check, and never let one treat `null`
 * as "no processes" — the whole point of the cold path is that a pre-idle
 * roster can name a recycled PID.
 */
export function freshProcessList(maxAgeMs: number): Promise<ProcInfo[] | null> {
  if (gotData && performance.now() - lastOkMs <= maxAgeMs) return Promise.resolve(rows);
  return fetchOnce();
}

/** Live process list for rendering. One shared stream, paused while hidden. */
export function useProcesses(): UseProcessesResult {
  const pollMs = useSettings((s) => s.pollMs);
  useEffect(() => processesPoller.setInterval(pollMs), [pollMs]);
  return useSyncExternalStore(processesPoller.subscribe, processesPoller.getSnapshot);
}
