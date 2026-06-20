# Critical-path isolation: stop the recurring "all readings freeze" class

- **Date:** 2026-06-21
- **Status:** Design — awaiting review
- **Author:** Claude (diagnosis + design), Thomas (owner / hardware validation)
- **Branch:** `telemetry-nvml-fix` (stacks on the PDH-collector + shared-NVML fixes)

## Problem

CorePilot has frozen ("all readings — CPU/GPU/process/sensors — stop updating") three
separate times, each traced by live kernel-dump analysis to a **different** stuck point:

1. **PDH `\GPU Engine(*)` collect** (seconds, grew with instance count) run on the request
   path under the `SAMPLER` / `state.sys` locks → blocking-pool congestion collapse. *Fixed*
   (background PDH collector + snapshot reads; merged to `main`).
2. **`Nvml::init()` ~1.8 s per call** (slow under Armoury Crate / AURA / NVIDIA-overlay GPU
   contention) called per-read, including under the `SAMPLER` lock and by the 5 Hz
   perf-recorder → lock held across a multi-second call + a pegged core. *Fixed* (one shared
   `Nvml` handle; `SAMPLER` dropped before the NVML read; commit `4172fc0`).
3. **OSD GDI-recycle rebuilds the WebView2 overlay window synchronously on the main thread**
   and `WebviewWindowBuilder::build()` hung in `wait_with_pump` (confirmed: identical stack
   across 3 live samples / 6 s, idle CPU, store frozen). The main thread is Tauri v2's single
   IPC router for **every** window, so a hung main thread froze all `invoke()` → all readings.
   *This spec.*

## Root cause (the unifying invariant)

All three are the same architectural failure in different places:

> **Something slow ran on a path that every reading depends on.**

Every reading reaches the UI through either (a) the **main thread** (Tauri's event loop +
the single IPC dispatcher for all windows) or (b) a **shared read-path lock** (`SAMPLER`,
`state.sys`). When any unbounded/blocking operation lands on one of those, *all* readings in
*all* windows freeze together. Each prior fix removed one offender; the architecture kept
producing new ones because the invariant was never stated or enforced.

This spec makes the invariant explicit and closes the currently-known violators. Scope is
**principled-targeted** (owner's choice): fix the live violator robustly, harden the clearly
-dangerous latent ones, add a tripwire for the future — *not* a full telemetry rewrite.

**The invariant:**
> No `#[tauri::command]` that runs on the main thread, no main-thread callback (incl.
> `run_on_main_thread` closures), and no holder of a read-path lock (`SAMPLER`, `state.sys`)
> may perform an operation that can block for more than a few milliseconds.

## Evidence grounding WS2

The GDI leak (upstream tauri#11525, historically "~32/min") is **condition-dependent, not
constant**: a live instance at **3.3 h uptime measured GDI = 1290, growing 0/min over 90 s
while the OSD was parked** (no resize churn). A constant 32/min would have reached ~7,700 by
then. This strongly indicates the leak correlates with **OSD activity** — specifically the
per-frame window operations the overlay performs while a game runs and the metrics plate
resizes (numbers changing width ⇒ `osd_set_bounds` size change ⇒ `set_size` +
`set_ignore_cursor_events` + `force_click_through`/`EnumChildWindows`). Cutting that churn
should keep GDI well under the 6,000 recycle threshold, so the window is built **once** and
never rebuilt — making the hang structurally unreachable. (Final rates measured during
implementation: idle vs active-OSD vs resize-storm.)

## Goals / non-goals

**Goals**
- No single stalled operation can freeze all readings.
- The OSD overlay window is created once and not rebuilt under normal long-session use.
- Future violations surface as an immediate, named log warning, not a silent field freeze.
- Visible behavior, data, and update cadence unchanged (no-downgrade).

**Non-goals**
- The already-fixed telemetry path (PDH collector, shared NVML handle) — leave it.
- The full "unified background sampler" rewrite (deferred; not needed for this class).
- Unrelated refactors. The injected-overlay path (`overlay_inject`) is untouched.

## Design

### WS1 — State the invariant + a debug-build main-thread watchdog

- Add the invariant as a module doc-comment in `lib.rs` (where the builder/commands live) and
  a short `CONTRIBUTING`/`AGENTS` note, so it's visible to anyone adding a command.
- Add a **debug-build-only** watchdog thread: it posts a cheap ping to the main thread (via
  `run_on_main_thread` setting an `AtomicU64` heartbeat) every second and logs a `WARN` naming
  the stall if the heartbeat is older than a threshold (e.g. 3 s). Release builds skip it (no
  overhead, no behavior change). This is a tripwire, not a recovery mechanism.
- *Rationale:* turns "diagnose freeze #4 via WinDbg" into "the log already named it."

### WS2 — Eliminate the OSD GDI-recycle (primary) / make rebuild non-reentrant (fallback)

**Step 1 — root-cause (no code):** measure GDI growth in three states (OSD parked; OSD active
with live changing metrics; rapid resize) and confirm the dominant driver. Confirm the hang
mechanism: that `build()` hangs because the rebuild runs **nested inside a WebView2 message
callback** (the recycle closure is dispatched during event-loop message processing).

**Step 2 — primary fix (eliminate the rebuild):** reduce the OSD's per-frame Win32 churn so
GDI stays well under `GDI_RECYCLE_THRESHOLD` and the recycle never fires:
- In `osd_set_bounds` (`osd.rs`): only call `set_size` + `force_click_through` on a **real
  size change** (already deduped via `LAST_OSD_SIZE` — verify it holds for the metric-driven
  micro-resizes; widen the dedupe to ignore sub-pixel/≤1px deltas if those slip through).
- Stop re-asserting click-through when nothing changed; the create-time 6× re-assert loop
  stays (it's bounded and one-shot), but the steady-state path must not churn styles.
- If a residual leak remains even when our churn is gone, it is genuinely upstream → keep the
  GDI watchdog recycle but apply the fallback below so it can't hang.

**Step 3 — fallback (only if the leak proves irreducible):** make the recycle non-hanging by
driving the destroy+rebuild from a **top-level event-loop tick** (a `RunEvent` handler / a
fresh non-nested dispatch) rather than from inside the gdi-guard's `run_on_main_thread`
closure that currently executes nested in message dispatch — so WebView2 creation is not
re-entrant. (`recreate-before-destroy` is explicitly **not** a fix: the freeze is the main
thread stuck *inside* `build()`, independent of window order.)

**Backstop:** the existing GDI watchdog remains; with the WS1 watchdog, a hung rebuild (if it
ever recurs) is logged immediately.

### WS3 — Move clearly-blocking sync commands off the main thread

Criterion: a sync `#[tauri::command]` that **spawns a child process** or does **unbounded
blocking I/O** must become `async` and run its body via `spawn_blocking` (the pattern already
used for `get_sensors`/`list_processes`). Implementation verifies each blocks before
converting; confirmed candidates:

| Command | Blocking work |
|---|---|
| `network_diagnose`, `network_repair` | spawn `netsh`/`ipconfig`/`ping` children (seconds) |
| `export_debug_logs` | writes the full session log to disk |
| `control_service` | SCM start/stop can block for seconds |
| `gpu_oc_apply`, `gpu_oc_reset` | NVML writes (slow under GPU-tool contention) |

(`set_power_plan`/`get_power_plan` are **already** `async` — verified, no change needed.
`list_services`/`list_startup` are SCM/registry enumerations that are usually fast; convert
only if implementation measures them blocking.)

Fast sync commands (e.g. `get_topology`, `set_affinity`, `osd_fps`, `osd_set_bounds`,
`smu_*` which forward to the sidecar) stay sync — they don't block. `osd_set_visible` stays
sync because window creation **must** be on the main thread; WS2 makes its slow path
unreachable rather than moving it.

## Behavior preservation

No IPC payloads, data shapes, cadences, or visible UI change. WS1 is debug-only. WS2 reduces
redundant Win32 calls (invisible) and removes a rare rebuild. WS3 changes only *which thread*
a command body runs on — same inputs, same outputs, same ordering from the caller's view.

## Risks & mitigations

- **WS2 leak proves purely upstream / irreducible** → fallback (non-reentrant rebuild) keeps
  the recycle working without hanging; watchdog backstops. Design carries both paths.
- **Hang mechanism is not re-entrancy** → Step 1 confirms it before committing; if it's
  something else (e.g. WebView2 env contention), the fallback's "top-level dispatch" may not
  suffice and we escalate to the architecture discussion rather than guess again.
- **WS3 async conversion changes timing** → bodies are unchanged; only the executor differs.
  Commands already return `Result`/values the frontend awaits.

## Verification

Build-only here (`cargo check` clean + `npx tauri build`); **no functional testing** — owner
validates on the 9950X3D. Success criteria:
1. GDI count stays flat-ish and well under 6,000 across a long gaming session (OSD active) →
   recycle never fires.
2. No main-thread-watchdog `WARN` lines across a long session.
3. Readings stay live after long uptime + GPU-tool contention; OSD shows; network/optimize
   actions don't stutter the UI.

## Out of scope / follow-ups

- Unified background sampler (all hardware reads behind one snapshot owner) — revisit only if
  a *telemetry-path* freeze recurs.
- Auto-recovery (restart-on-wedge) — intentionally not built; watchdog is log-only.
