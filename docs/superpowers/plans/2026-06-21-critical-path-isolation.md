# Critical-Path Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Stop the recurring "all readings freeze" class by enforcing the invariant *nothing slow runs on the main thread or a read-path lock* — cut the OSD's per-frame window-resize churn (so the GDI-recycle never fires and its rebuild can't hang), add a main-thread stall tripwire, and move clearly-blocking sync commands off the main thread.

**Architecture:** Three independent workstreams in `src-tauri`: (WS1) a log-only main-thread watchdog + the invariant documented; (WS2) quantize the OSD window size so metric-driven micro-resizes stop triggering WebView2 surface rebuilds (the measured GDI-leak driver); (WS3) `async + spawn_blocking` the sync commands that spawn child processes / do blocking I/O.

**Tech Stack:** Rust / Tauri v2, `tracing`, Win32 (`windows` crate), `std::sync::atomic`.

> **Verification policy (overrides skill TDD):** Owner rule = build/compile only, no functional testing. Gate each task on `cargo check` clean; final gate `npx tauri build`. Hardware/behavior validation is the owner's on the 9950X3D. Close the running instance before `npx tauri build` (rename-trick if the exe is locked).

> **No-downgrade:** no IPC payloads, data, cadences, or visible UI change. WS1 is log-only. WS2 only enlarges the *transparent, click-through* overlay window by ≤ one grid step (invisible). WS3 changes only which thread a command body runs on.

> **Deferred (spec WS2 fallback, conditional):** the non-reentrant OSD *rebuild* fix is NOT implemented now. It is only needed if hardware validation shows GDI still climbs to the 6000 recycle threshold despite WS2. The WS1 watchdog will make that condition observable. Implementing an untestable event-loop restructure now would risk a regression we can't catch under build-only verification.

---

## File Structure

- **Create `src-tauri/src/watchdog.rs`** — log-only main-thread stall detector. One responsibility.
- **Modify `src-tauri/src/lib.rs`** — `pub mod watchdog;`, start the watchdog in setup, add the invariant doc-comment.
- **Modify `src-tauri/src/osd.rs`** — quantize the overlay window size in `osd_set_bounds` to cut resize churn.
- **Modify `src-tauri/src/netfix.rs`** — `network_diagnose`, `network_repair` → async.
- **Modify `src-tauri/src/debug_log.rs`** — `export_debug_logs` → async.
- **Modify `src-tauri/src/commands.rs`** — `control_service` → async.
- **Modify `src-tauri/src/gpu.rs`** — `gpu_oc_apply`, `gpu_oc_reset` → async.

---

## Task 1: Main-thread watchdog + invariant doc (WS1)

**Files:**
- Create: `src-tauri/src/watchdog.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Create the watchdog module**

```rust
// src-tauri/src/watchdog.rs
//! Log-only main-thread stall detector (the critical-path tripwire).
//!
//! Tauri v2 runs the event loop AND routes every window's `invoke()` on the main
//! thread. If anything blocks it (a hung window rebuild, a slow sync command), all
//! readings in all windows freeze at once. Three field freezes were diagnosed only
//! by capturing live kernel dumps. This watchdog turns the next one into an
//! immediate, named log line instead: it asks the main thread to stamp a heartbeat
//! once per interval; if the heartbeat goes stale beyond the threshold, it logs a
//! single WARN naming the stall. It never tries to recover — purely observability,
//! negligible cost (one tiny closure/second), so it runs in release too.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager};

/// Epoch-millis of the last time the MAIN thread ran our heartbeat closure.
static LAST_BEAT_MS: AtomicU64 = AtomicU64::new(0);

/// Poll cadence and the stall threshold. The threshold is generous so a legitimate
/// one-off main-thread operation (e.g. window creation at startup) never trips it.
const POLL: Duration = Duration::from_secs(2);
const STALL_THRESHOLD_MS: u64 = 8_000;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Spawn the watchdog. Idempotent enough for a single call from `setup`.
pub fn start(app: AppHandle) {
    LAST_BEAT_MS.store(now_ms(), Ordering::SeqCst);
    let _ = std::thread::Builder::new()
        .name("corepilot-mainthread-watchdog".into())
        .spawn(move || {
            let mut warned = false;
            loop {
                std::thread::sleep(POLL);
                // How long since the main thread last stamped the heartbeat?
                let age = now_ms().saturating_sub(LAST_BEAT_MS.load(Ordering::SeqCst));
                if age > STALL_THRESHOLD_MS {
                    if !warned {
                        tracing::warn!(
                            stall_ms = age,
                            "MAIN THREAD STALLED — IPC router blocked >8s; readings will be frozen \
                             (critical-path invariant violated: a slow op is on the main thread)"
                        );
                        warned = true;
                    }
                } else if warned {
                    tracing::warn!(stall_ms = age, "main thread recovered");
                    warned = false;
                }
                // Post a fresh heartbeat request. If the main thread is healthy it
                // runs within ms (so the next check sees a fresh stamp); if wedged,
                // the closure never runs and `age` keeps growing → we log.
                let _ = app.run_on_main_thread(|| {
                    LAST_BEAT_MS.store(now_ms(), Ordering::SeqCst);
                });
            }
        });
}
```

- [ ] **Step 2: Register the module + start it + document the invariant** — `src-tauri/src/lib.rs`

Add the module declaration alongside the others (after `pub mod tweaks;` or wherever alphabetical-ish):

```rust
pub mod watchdog;
```

Add the invariant doc-comment immediately above `pub fn run() {` (before the `#[cfg_attr(...)]` line):

```rust
/// CRITICAL-PATH INVARIANT (see docs/superpowers/specs/2026-06-21-critical-path-isolation-design.md):
/// Tauri v2 runs the event loop AND routes every window's IPC on the MAIN thread.
/// Therefore no main-thread `#[tauri::command]` (a non-`async` command), no
/// `run_on_main_thread` closure, and no holder of a read-path lock (`SAMPLER`,
/// `state.sys`) may perform an operation that can block more than a few ms — doing
/// so freezes ALL readings in ALL windows. Slow/blocking work goes on `async`
/// commands via `spawn_blocking`, or on a dedicated background thread.
```

In the `.setup(|app| { ... })` closure, start the watchdog as the first line (right after the opening, before the telemetry collector start added earlier):

```rust
            // Critical-path tripwire: log loudly if the main thread (the IPC router)
            // ever stalls. Observability only; see crate::watchdog.
            crate::watchdog::start(app.handle().clone());
```

- [ ] **Step 3: Compile gate**

Run: `cd src-tauri && PATH="/c/Users/Thomas/.cargo/bin:$PATH" cargo check`
Expected: compiles clean (0 errors).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/watchdog.rs src-tauri/src/lib.rs
git commit -m "feat(watchdog): log-only main-thread stall tripwire + document critical-path invariant"
```

---

## Task 2: Cut OSD window-resize churn (WS2 primary)

**Files:**
- Modify: `src-tauri/src/osd.rs` (`osd_set_bounds`, ~line 226-259)

**Why:** Live measurement showed GDI flat (0/min) while the OSD was parked, i.e. the
tauri#11525 leak is driven by activity. The only per-frame Win32 op the overlay does is
`osd_set_bounds` → `set_size` (which makes WebView2 rebuild its compositor surface, the leak
source) whenever the rounded plate size changes by ≥1px. During gameplay the plate width
changes constantly as metric digits change width, so `set_size` fires continuously. Quantizing
the window size to a coarse grid (rounding **up**) means tiny metric-driven width changes no
longer cross a grid boundary, so `set_size` fires rarely. The overlay is transparent and
click-through and the plate renders at the window's top-left, so the ≤grid extra width/height
is invisible and captures no input — no visible change.

- [ ] **Step 1: Add the size-quantum constant** — `osd.rs`, near the other OSD constants (after `OSD_MAX_COORD`, ~line 193)

```rust
/// Quantum (logical px) the overlay window size is rounded UP to before resizing.
/// The metrics plate's width jitters by a few px as digits change (e.g. "60"→"119"
/// FPS); without this, every such change triggers a `set_size`, and each WebView2
/// surface resize leaks GDI objects (upstream tauri#11525) — the driver behind the
/// ~3-hourly GDI-recycle whose window rebuild once hung the main thread. Snapping to
/// a grid makes resizes rare. The extra ≤16px is transparent + click-through and the
/// plate sits at the window's top-left, so it is invisible and never moves the plate.
const OSD_SIZE_QUANTUM: f64 = 16.0;
```

- [ ] **Step 2: Quantize size in `osd_set_bounds`** — replace the clamping block

Find (currently ~line 238-241):

```rust
        let cw = w.clamp(OSD_MIN_DIM, max_dim);
        let ch = h.clamp(OSD_MIN_DIM, max_dim);
        let cx = x.clamp(-OSD_MAX_COORD, OSD_MAX_COORD);
        let cy = y.clamp(-OSD_MAX_COORD, OSD_MAX_COORD);
```

Replace with:

```rust
        // Round the requested size UP to the size quantum BEFORE clamping, so small
        // metric-driven width/height jitter doesn't trigger a WebView2 surface resize
        // every frame (the GDI-leak driver). Rounding up keeps the plate fully
        // covered; the extra transparent margin is invisible + click-through.
        let qw = (w / OSD_SIZE_QUANTUM).ceil() * OSD_SIZE_QUANTUM;
        let qh = (h / OSD_SIZE_QUANTUM).ceil() * OSD_SIZE_QUANTUM;
        let cw = qw.clamp(OSD_MIN_DIM, max_dim);
        let ch = qh.clamp(OSD_MIN_DIM, max_dim);
        let cx = x.clamp(-OSD_MAX_COORD, OSD_MAX_COORD);
        let cy = y.clamp(-OSD_MAX_COORD, OSD_MAX_COORD);
```

(The existing `LAST_OSD_SIZE` dedupe below this — keyed on the rounded `cw`/`ch` — then only
fires `set_size` + `force_click_through` when the *quantized* size actually changes, i.e.
rarely. `set_position` still runs every call, so positioning/monitor-follow is unchanged.)

- [ ] **Step 3: Compile gate**

Run: `cd src-tauri && PATH="/c/Users/Thomas/.cargo/bin:$PATH" cargo check`
Expected: compiles clean.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/osd.rs
git commit -m "perf(osd): quantize overlay window size to cut per-frame resize churn (GDI-leak driver)"
```

---

## Task 3: Move blocking sync commands off the main thread (WS3)

**Pattern (applied uniformly):** rename the existing `#[tauri::command] pub fn NAME(args) -> R { BODY }`
to a private sync `fn NAME_impl(args) -> R { BODY }` (delete the `#[tauri::command]` attribute and
the `pub`), then add an `async` command wrapper that runs it via `spawn_blocking`. Bodies are
unchanged. `lib.rs`'s `generate_handler!` already lists these names and supports async commands,
so no registration change is needed. All captured args (`bool`, `String`, `Vec<String>`,
`AppHandle`, `GpuOcSettings`) are `Send + 'static`.

**Files:** `netfix.rs`, `debug_log.rs`, `commands.rs`, `gpu.rs`

- [ ] **Step 1: `netfix.rs` — `network_diagnose` + `network_repair`**

For `network_diagnose`: change `#[tauri::command]\npub fn network_diagnose(en: bool) -> Vec<NetCheck> {`
to `fn network_diagnose_impl(en: bool) -> Vec<NetCheck> {` (drop attribute + `pub`, rename). Then add above it:

```rust
/// Async wrapper: the diagnostic sweep spawns `ipconfig`/`netsh`/`ping` children
/// (seconds) — run it off the main thread so it never stalls the IPC router.
#[tauri::command]
pub async fn network_diagnose(en: bool) -> Vec<NetCheck> {
    tauri::async_runtime::spawn_blocking(move || network_diagnose_impl(en))
        .await
        .unwrap_or_default()
}
```

For `network_repair`: change `#[tauri::command]\npub fn network_repair(actions: Vec<String>, en: bool) -> Vec<NetCheck> {`
to `fn network_repair_impl(actions: Vec<String>, en: bool) -> Vec<NetCheck> {`. Then add above it:

```rust
/// Async wrapper: each repair spawns a `netsh`/`ipconfig` child — keep it off the
/// main thread.
#[tauri::command]
pub async fn network_repair(actions: Vec<String>, en: bool) -> Vec<NetCheck> {
    tauri::async_runtime::spawn_blocking(move || network_repair_impl(actions, en))
        .await
        .unwrap_or_default()
}
```

- [ ] **Step 2: `debug_log.rs` — `export_debug_logs`**

Change `#[tauri::command]\npub fn export_debug_logs(app: tauri::AppHandle, folder_name: String) -> CoreResult<String> {`
to `fn export_debug_logs_impl(app: tauri::AppHandle, folder_name: String) -> CoreResult<String> {`. Add above it:

```rust
/// Async wrapper: writes the full session log to disk (unbounded I/O) — run it off
/// the main thread so the export can't stall the IPC router.
#[tauri::command]
pub async fn export_debug_logs(app: tauri::AppHandle, folder_name: String) -> CoreResult<String> {
    tauri::async_runtime::spawn_blocking(move || export_debug_logs_impl(app, folder_name))
        .await
        .map_err(|e| CoreError::Msg(format!("export task failed: {e}")))?
}
```

Verify `CoreError` is in scope in `debug_log.rs` (it uses `CoreResult`); if only `CoreResult`
is imported, extend the import to `use crate::error::{CoreError, CoreResult};`.

- [ ] **Step 3: `commands.rs` — `control_service`**

Change `#[tauri::command]\npub fn control_service(name: String, action: String) -> CoreResult<()> {`
to `fn control_service_impl(name: String, action: String) -> CoreResult<()> {`. Add above it:

```rust
/// Async wrapper: SCM start/stop can block for seconds — keep it off the main thread.
#[tauri::command]
pub async fn control_service(name: String, action: String) -> CoreResult<()> {
    tauri::async_runtime::spawn_blocking(move || control_service_impl(name, action))
        .await
        .map_err(|e| CoreError::Msg(format!("service control task failed: {e}")))?
}
```

(`commands.rs` already imports `CoreError` and `CoreResult`.)

- [ ] **Step 4: `gpu.rs` — `gpu_oc_apply` + `gpu_oc_reset`**

For `gpu_oc_apply`: change `#[tauri::command]\npub fn gpu_oc_apply(settings: GpuOcSettings) -> Result<(), String> {`
to `fn gpu_oc_apply_impl(settings: GpuOcSettings) -> Result<(), String> {`. Add above it:

```rust
/// Async wrapper: NVML writes can be slow under GPU-tool contention (Armoury Crate /
/// AURA) — keep them off the main thread.
#[tauri::command]
pub async fn gpu_oc_apply(settings: GpuOcSettings) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || gpu_oc_apply_impl(settings))
        .await
        .map_err(|e| format!("gpu oc apply task failed: {e}"))?
}
```

For `gpu_oc_reset`: change `#[tauri::command]\npub fn gpu_oc_reset() -> Result<(), String> {`
to `fn gpu_oc_reset_impl() -> Result<(), String> {`. Add above it:

```rust
/// Async wrapper: NVML writes off the main thread (see gpu_oc_apply).
#[tauri::command]
pub async fn gpu_oc_reset() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(gpu_oc_reset_impl)
        .await
        .map_err(|e| format!("gpu oc reset task failed: {e}"))?
}
```

Confirm `GpuOcSettings` is `Send + 'static` (a plain `#[derive]` struct of `Option<f64>/Option<u32>` — yes). If `gpu_oc_reset_impl` takes no args, `spawn_blocking(gpu_oc_reset_impl)` passes the fn directly.

- [ ] **Step 5: Compile gate**

Run: `cd src-tauri && PATH="/c/Users/Thomas/.cargo/bin:$PATH" cargo check`
Expected: compiles clean. If any `_impl` is reported unused, it means a wrapper didn't call it — fix the call.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/netfix.rs src-tauri/src/debug_log.rs src-tauri/src/commands.rs src-tauri/src/gpu.rs
git commit -m "fix(ipc): run blocking sync commands (network/log/service/gpu-oc) off the main thread"
```

---

## Task 4: Full build

- [ ] **Step 1: Close the running instance** (free the exe lock). Kill `corepilot`/`sensord`; if the exe is locked by a wedged process, rename it aside:

```bash
powershell.exe -NoProfile -Command "Get-Process corepilot,sensord -ErrorAction SilentlyContinue | Stop-Process -Force" 2>&1 | tr -d '\r'
# if a later build step reports the exe is locked:
#   mv src-tauri/target/release/corepilot.exe src-tauri/target/release/corepilot.exe.old
```

- [ ] **Step 2: Build**

Run: `cd /c/Users/Thomas/Documents/Projects/CorePilot && PATH="/c/Users/Thomas/.cargo/bin:$PATH" npx tauri build`
Expected: bundles; no `cargo`/`tsc` errors.

- [ ] **Step 3: Relaunch + hand off to owner** for hardware validation: over a long gaming session, GDI stays well under 6000 (recycle never fires), no main-thread-watchdog WARN lines, readings stay live, OSD shows, network/optimize actions don't stutter.

---

## Self-Review

- **Spec coverage:** WS1 → Task 1 (watchdog + invariant doc). WS2 primary (eliminate recycle via churn cut) → Task 2. WS3 → Task 3 (all confirmed-blocking commands; `set_power_plan` correctly excluded — already async). WS2 fallback (non-reentrant rebuild) → explicitly deferred per spec's conditional, with rationale. Build → Task 4. ✓
- **Placeholder scan:** none — every code step has complete code; `_impl` extractions are precise (rename + drop attribute, body unchanged).
- **Type consistency:** wrappers return the exact original types (`Vec<NetCheck>`, `CoreResult<String>`, `CoreResult<()>`, `Result<(), String>`); `_impl` names used consistently in each wrapper; `LAST_OSD_SIZE` dedupe now keys off the quantized `cw`/`ch` (unchanged mechanism, new inputs).
- **Risk note:** WS2 is a bet that `set_size` is the dominant leak driver (evidence-backed but not proven under build-only); the WS1 watchdog + the still-present GDI-recycle are the backstops, and the deferred non-reentrant rebuild is the next step if validation shows GDI still reaching 6000.
