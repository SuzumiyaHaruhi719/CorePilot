# Single-owner sampler + self-recovering pollers — kill the freeze class for good

- **Date:** 2026-06-22
- **Status:** Design — approved (autonomous build authorized; owner asleep)
- **Branch:** `telemetry-nvml-fix`

## Problem

"All readings (CPU/GPU/process/sensors) + OSD freeze" has recurred **five** times. Four
targeted fixes each removed one offender, but a new one always surfaced:

1. PDH `\GPU Engine(*)` collect under locks → background GPU collector (shipped).
2. `Nvml::init()` per call under `SAMPLER` → shared NVML handle (shipped).
3. OSD GDI-recycle rebuilding a WebView2 window on the main thread → size quantization (shipped).
4. `list_processes` holding `state.sys` across a slow refresh → single-flight (shipped).
5. **Now:** backend healthy (53 threads, responsive, CLI works) but readings gone — the
   **frontend pollers wedged**. Root: the in-flight guards added in (4) latch permanently —
   `if(inFlight)return; inFlight=true; try{await invoke}finally{inFlight=false}` — if a command
   ever truly hangs (never settles), `finally` never runs, `inFlight` stays `true`, and that
   poller is **dead forever**, even after the backend recovers. Three pollers latching =
   "OSD, GPU, all processes disappeared," with a healthy backend.

This is an **architecture problem**, not five bugs: every reading flows through a shared
read-path lock (`state.sys`, `SAMPLER`) and/or the blocking pool, and many commands hold those
across slow OS/hardware calls — so *any* of them can stall the whole system; and the frontend
has no recovery when a command stalls. Per the debugging discipline, 3+ failed fixes ⇒ stop
patching individual commands and fix the architecture.

## The invariant we will enforce

> **No `#[tauri::command]` may lock `state.sys` or `SAMPLER`, or call hardware (PDH/NVML/DXGI/
> sysinfo/Toolhelp) directly. Those are touched by exactly ONE background thread, which
> publishes immutable snapshots. Commands are O(1) snapshot reads.**
>
> **And: a frontend poller can never be permanently killed by a hung invoke.**

With both halves, a stalled command can neither pile up on a lock (backend) nor permanently
freeze a reading (frontend). The freeze class is closed, not whack-a-moled.

## Goals / non-goals

**Goals**
- One background owner of the `System` + sensor sampling; all read-commands serve snapshots.
- Frontend pollers self-recover from any hung/slow invoke.
- Remove the now-obsolete `list_processes` single-flight hack (superseded by the sampler).
- Visible behavior / data shapes / cadence unchanged (no-downgrade).

**Non-goals**
- The GPU-engine collector (`telemetry.rs`) already follows this pattern and stays as-is.
- Mutating commands (`set_affinity`, `set_priority`, `end_task`, SMU/GPU-OC, fan, network,
  optimize) — they don't read `state.sys`/`SAMPLER` on a poll path; unchanged.
- The OSD layout/opacity oddity (separate, deferred).

## Design

### Backend — a single `sampler` thread owning `System` + sensors

Add `src-tauri/src/sampler.rs` (mirrors `telemetry.rs`). A lazily-started thread loops at a
fixed cadence (`SAMPLE_INTERVAL = 1500 ms`, matching today's effective poll rate). Each tick,
**off any request path**, it:

1. Locks `state.sys` (the ONLY full-refresh caller now), `refresh_processes(All)` +
   `thread_counts()`, builds the process list via `process::list(...)`, unlocks.
2. `sysmon::sample(&mut sys)` → metrics (reuses the same lock window).
3. `sensors::sample()` → sensors (reads the GPU snapshot from `telemetry.rs` + PDH + sidecar).

Publishes three immutable snapshots behind `Lazy<Mutex<Arc<…>>>` (the `telemetry.rs` pattern;
lock held only to clone-swap the `Arc`):
- `PROC_SNAPSHOT: Arc<Vec<ProcInfo>>`
- `METRICS_SNAPSHOT: Arc<Metrics>`
- `SENSORS_SNAPSHOT: Arc<SensorSample>`

Accessors `proc_snapshot()`, `metrics_snapshot()`, `sensors_snapshot()` clone the `Arc` (O(1))
and lazily start the thread (so the first reader brings it up even if `start()` wasn't called).
`start()` is called eagerly in `lib.rs` setup (next to `telemetry::start()`).

The loop never panics (each source already degrades to defaults/empty on failure). It sleeps
`SAMPLE_INTERVAL.saturating_sub(elapsed)`, never busy-loops.

### Backend — commands become snapshot reads

- `list_processes` → `(*sampler::proc_snapshot()).clone()`; **remove the single-flight hack**
  (`PROC_REFRESHING`/`PROC_CACHE`) — superseded.
- `get_metrics` → `(*sampler::metrics_snapshot()).clone()`.
- `get_sensors` → `(*sampler::sensors_snapshot()).clone()`.
- `get_overview` → compute once, cache in a `OnceLock<Overview>` (CPU name/RAM/topology are
  static); first call may lock `state.sys` once (it is not polled, so it can never pile up).
- `gpu_engine_loads` → unchanged (already reads `telemetry::gpu_snapshot()`).
- `perf_recorder::build_sample` / `cpu_name` → read `sampler::metrics_snapshot()` +
  `sampler::sensors_snapshot()` instead of locking `state.sys` / calling `sensors::sample()`.
  Its targeted `exe_path` (one-PID `refresh_processes(Some)`) stays — cheap, background-thread,
  cannot pile up.

After this, **no command body locks `state.sys` or `SAMPLER`** — only the sampler thread (full
refresh) and perf_recorder's targeted one-PID refresh do, both off the IPC path.

The CLI (`bin/cli.rs`) keeps calling the synchronous bodies (`process::list`,
`sensors::sample`, `sysmon::sample`) directly — it's a separate short-lived process, unaffected.

### Frontend — self-recovering pollers

Add `withTimeout<T>(p: Promise<T>, ms): Promise<T>` (in `src/lib/ipc.ts` or a small util):
`Promise.race([p, reject-after-ms])`. Wrap the polled invokes so a hung invoke **rejects**
after the timeout → the poller's `finally` runs → `inFlight` clears → it retries next tick.
Apply in: `useSharedTelemetry` (`makePoller`), `useProcesses`, `useAffinityEnforcer`, and the
OSD tick (`OsdOverlay`). Timeout generous (e.g. 6 s) so normal slow reads aren't cut off; the
point is recovery, not speed. Last-good values are retained on timeout (existing `catch` keeps
them), so a transient timeout doesn't blank the UI.

## Data flow

```
sampler thread (1.5s):  state.sys.lock → refresh+list+metrics ─┐  sensors::sample ─┐
                                                               ▼                   ▼
                                              PROC/METRICS_SNAPSHOT          SENSORS_SNAPSHOT
commands (O(1) clone): list_processes/get_metrics/get_sensors ─┘  ◄── frontend pollers (withTimeout)
telemetry thread (GPU) ─► GPU_SNAPSHOT ─► gpu_engine_loads + process::list GPU columns + sensors
```

## No-downgrade

Identical IPC payloads (`Vec<ProcInfo>`, `Metrics`, `SensorSample`, `gpu_engine_loads` map).
Readings refresh at the sampler cadence (~1.5 s) vs per-poll — invisible for a monitoring UI
(Task Manager polls ~1 Hz; OSD ~1 Hz). The process list/metrics are arguably smoother (one
steady producer). The `withTimeout` only changes behavior when an invoke would otherwise hang.

## Risks & mitigations

- **First-tick emptiness:** snapshots start empty/default; the first ~1.5 s shows "—"/empty,
  then fills — same graceful contract as the GPU collector; `start()` runs eagerly at setup.
- **Sampler holds `state.sys` during a slow refresh:** only perf_recorder's targeted refresh
  may briefly wait (background thread, harmless). No command waits — they read snapshots.
- **perf_recorder reading slightly-stale metrics/sensors:** ≤1 sampler tick old; acceptable for
  a 5 Hz session recorder (it already tolerates None/missing).
- **Two background threads (telemetry GPU + sampler) both at ~1.5 s:** negligible; they share
  no lock (sampler reads the GPU `Arc`).

## Verification

Build-only (`cargo check` per task, `npx tauri build` final); no functional testing — owner
validates on the 9950X3D. Autonomous-run success criteria I will verify before reporting:
1. `cargo check` + `npm run build` + `npx tauri build` all clean.
2. Relaunched build: threads ~normal (not climbing), Responding=True, idle CPU.
3. CLI backend reads return data.
4. Watch ~60 s: thread count stable, no collapse.

Hardware/sustained validation (Task Manager open during a long 4K borderless game session;
readings stay live; OSD shows) remains the owner's.

## Out of scope / follow-ups

- Merge to `main` — left for the owner.
- OSD `opacity:0` / right-edge layout oddity — separate.
- Folding the GPU collector into the same sampler thread — optional later cleanup.
