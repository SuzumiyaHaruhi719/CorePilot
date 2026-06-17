# Telemetry stability: background sampler + single-instance + frontend backpressure

- **Date:** 2026-06-17
- **Status:** Design — awaiting review
- **Author:** Claude (diagnosis + design), Thomas (owner / hardware validation)

## Problem

After CorePilot runs for a while, **all** Task Manager / Monitor readings (CPU, memory,
process list, GPU, sensors) freeze together, the GPU/CPU "can't be detected", tracing goes
quiet, and the **OSD never shows** (even with a game whitelisted). Restarting helps for a
while, then it recurs.

This is **not a crash and not a hard deadlock** — it is a **congestion collapse** of the
telemetry/command system, amplified by **multiple CorePilot instances running at once**.

## Root causes (evidenced 2026-06-16/17)

1. **Expensive `\GPU Engine(*)` PDH collect on the request path, under shared locks.**
   The `\GPU Engine(*)\Utilization Percentage` wildcard collect grows with instance count
   (measured live: **1213 instances for 56 processes, ~5 s cold / ~2.8 s warm**). It is run
   **three** separate times, each on its own query/lock/cadence:
   - `sensors.rs` `PdhQuery.gpu_util` → aggregate `gpuPct`, under `SAMPLER`.
   - `process.rs` `GPU_QUERY` (`gpu_map`) → per-PID GPU% + engine/adapter attribution, under
     `state.sys` (held by `list_processes`; `get_metrics`/`get_overview` block on the same lock).
   - `process.rs` `GPU_ENGINE_QUERY` → per-engine-type totals, via `gpu_engine_loads`.
   Once a collect exceeds the poll interval (1–1.5 s), and because the frontend pollers fire on
   `setInterval` with **no in-flight guard**, invokes pile up and saturate tokio's blocking pool
   (Tauri default = 512). At ~1.5 s/poll, 512 × 1.5 s ≈ 768 s — matching the observed
   `list_processes/get_metrics took 759071 ms` in the field log. Throughput collapses to ≈0.

2. **No single-instance enforcement.** No `single-instance` plugin is registered, so every launch
   spawns a full new instance. Observed: a frozen zombie (PID 79164, **9379 s CPU**) plus a fresh
   instance (93156), plus three `sensord` sidecars. Each instance runs its own pollers, OSD window,
   sensord, and **3× the GPU-engine collects** — multiplying cause #1.

3. **Single fixed-name ETW session fought over by instances.** `fps.rs` uses one fixed session
   name `CorePilot-FPS`; only one session of that name can exist. Two instances stop-and-restart
   each other's session, so present events never accumulate in the instance you are looking at →
   `is_game=false` / no FPS → the OSD's show-gate (`OsdOverlay.tsx` → `foregroundInfo`) never trips.
   The OSD's per-tick `await api.foregroundInfo()` + `fetchOsdData` also depend on the (saturated)
   blocking pool, so even desktop-mode OSD gets no data.

`forzahorizon6.exe` lives under `…\Steam\steamapps\common\ForzaHorizon6\` so `is_game_path`
auto-detects it as a game; the whitelist is not the problem, and there is **no separate OSD
detection bug** — the OSD is purely downstream of #1–#3.

## Goals / non-goals

**Goals**
- A single slow hardware call can never again stall the whole telemetry/command system.
- Exactly one CorePilot instance runs; a second launch focuses the existing window.
- OSD shows reliably for detected/whitelisted games (a consequence of the above).
- **Visible behavior, data shapes, and update cadence stay byte-identical** (no-downgrade).
- Keep everything else intact — minimal blast radius.

**Non-goals**
- Reducing the PDH GPU-engine *instance bloat* itself (Windows perflib behavior). The background
  sampler makes its cost irrelevant to responsiveness; instance filtering is a possible later tweak.
- Reworking the sysinfo/process-refresh path, fan engine, OSD rendering, perf recorder, or SMU.
- The unrelated VeryKuai `vktap.sys` BSOD (separate issue, already diagnosed).

## Design

### Part 1 — Background telemetry sampler (fixes #1)

Add a lazily-started (`OnceLock`, like `ensure_trace_started`) background thread
`corepilot-telemetry`. Each tick it performs **one** `\GPU Engine(*)` raw collect, parses the
instance array **once** (reusing the existing `parse_pid`/`parse_engtype`/`parse_luid`/attribution
+ clamping logic verbatim) into all three products, and also runs the rest of the current
`sensors::sample()` work (disk/net/CPU-clock PDH, DXGI, NVML, sidecar merge). It publishes two
immutable snapshots behind the existing `Lazy<Mutex<…>>` pattern (lock held only microseconds to
clone-swap):

- `SENSOR_SNAPSHOT: SensorSample` — the full `get_sensors` payload.
- `GPU_PROC_SNAPSHOT: { per_pid: HashMap<u32, GpuProc>, per_engine: HashMap<String, f64> }`
  where `GpuProc = { util: f32, engine: Option<String>, adapter: Option<String> }`.

Commands become O(1) snapshot reads (no heavy work, no long lock holds):
- `get_sensors` → clone `SENSOR_SNAPSHOT`.
- `gpu_engine_loads` → clone `per_engine`.
- `list_processes` → still refreshes sysinfo under `state.sys` (unchanged), but its GPU columns
  read `per_pid` from the snapshot **instead of calling `gpu_map()` under the lock**. `state.sys`
  is therefore never held across the multi-second collect.

The three old GPU-engine queries are replaced by the one sampler-owned query (consistent PDH rate
baseline). `SAMPLER` and the GPU query are touched only by the sampler thread → zero cross-command
contention.

**Cadence:** loop targets ~1 s but is naturally collect-bound (~2.8 s warm) — matching today's
effective refresh; uses `sleep(interval.saturating_sub(elapsed))`, never busy-loops.
**Startup:** before the first sample completes, commands return the current (default/empty)
snapshot — same graceful-`None` contract, just non-blocking instead of a ~3 s first-call block.
**NVML:** reuse one `Nvml` handle in the sampler instead of `Nvml::init()` per call.
**Never panics:** per-source failures are swallowed exactly as `sample()` does today.

### Part 2 — Single-instance enforcement (fixes #2, and #3 in practice)

Register `tauri-plugin-single-instance` as the **first** plugin in `lib.rs`. Its callback
un-minimizes + focuses the existing main window (and re-shows from tray). A second launch then
exits immediately instead of spawning a parallel instance — eliminating the zombie pile-up, the
duplicate sensord sidecars, the 3× GPU collects, and the ETW session fight. With one instance,
`CorePilot-FPS` has a single owner, present events accumulate, and game detection/FPS are reliable.

Defense-in-depth (small, optional within this work): on a clean exit, stop the `CorePilot-FPS`
session; the fixed-name + stop-stale logic in `fps.rs` already handles a leftover from an ungraceful
exit, so no change is required there beyond what single-instance already guarantees.

### Part 3 — Frontend backpressure (in-flight guards)

- `useSharedTelemetry.ts` `makePoller`: add an in-flight flag; if the previous `invoke` has not
  resolved, skip this tick instead of issuing another. Pure backpressure; UI behavior unchanged.
- `OsdOverlay.tsx` tick loop: same in-flight guard around the per-tick
  `foregroundInfo` + `fetchOsdData` so a transient backend slowdown can't pile up overlay invokes.

These are a safety net; Part 1 removes the slowness that triggers pile-up in the first place.

## Behavior preservation (no-downgrade)

Every IPC payload (`Sensors`, `Metrics`, `ProcInfo` GPU fields, `gpu_engine_loads` map) keeps its
exact shape and values. The numbers come from the same PDH/DXGI/NVML/sysinfo sources; only *where*
and *how often* they are computed changes (once, in the background, vs N times per request). GPU%
refresh stays collect-bound (~2.8 s) as it effectively is today. `get_metrics`/`get_overview` and
the sysinfo/`state.sys` path are untouched.

## Risks & mitigations

- **Snapshot staleness during startup** — commands return empty for ≤ one sampler tick, then fill.
  Matches the existing "show — until data" contract; arguably smoother (non-blocking).
- **Single-instance blocks relaunch while a frozen instance lingers** — Part 1 removes the freeze;
  worst case the user kills one process. Strictly better than today's silent pile-up.
- **PDH rate baseline** after collapsing three queries into one — verify the single query is primed
  once and read at a steady cadence (it is, in the sampler loop).
- **Elevated launch** — single-instance works within the same integrity level; CorePilot launches
  elevated consistently (autostart task), so the guard is effective.

## Validation

Build only (`npx tauri build`, app closed first); **no functional testing here** — Thomas validates
on the 9950X3D: (1) readings stay live after long uptime; (2) `Get-Counter '\GPU Engine(*)'` style
load no longer freezes the UI; (3) launching twice focuses the one window; (4) OSD shows over Forza
(detected via Steam path) and on desktop. Watch CPU of the corepilot process stays low at idle.

## Out of scope / follow-ups

- GPU-engine PDH instance-bloat reduction (instance filtering / shorter retention).
- Auditing the 47 system-wide ETW sessions for unrelated leftovers.
