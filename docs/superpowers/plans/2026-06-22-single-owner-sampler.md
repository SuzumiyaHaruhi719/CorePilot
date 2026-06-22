# Single-Owner Sampler + Self-Recovering Pollers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make every polled read-command an O(1) snapshot read fed by ONE background sampler thread (so no command locks `state.sys`/`SAMPLER` or calls hardware), and make frontend pollers self-recover from any hung invoke — closing the recurring freeze class.

**Architecture:** New `sampler.rs` background thread owns the `System` refresh + sensor sampling and publishes immutable `Arc` snapshots (mirrors the existing `telemetry.rs` GPU collector). `list_processes`/`get_metrics`/`get_sensors` clone snapshots; `get_overview` is cached; `perf_recorder`'s 5 Hz path reads snapshots. Frontend pollers wrap invokes in `withTimeout` so a hung call can't permanently latch a poller.

**Tech Stack:** Rust / Tauri v2, `once_cell`, `parking_lot`, `std::sync` (Arc/OnceLock); React/TS.

> **Verification:** build-only (`cargo check` per task, `npx tauri build` final). No functional tests (owner rule). After build: relaunch + verify threads stable / responsive / CLI reads OK / 60 s no-collapse.

> **No-downgrade:** identical IPC payloads; readings refresh at the sampler cadence (~1.5 s ≈ today's poll rate). `withTimeout` only changes behavior when an invoke would otherwise hang.

---

## File Structure

- **Create `src-tauri/src/sampler.rs`** — background sampler: owns the System refresh + sensor sample, publishes `PROC_SNAPSHOT`/`METRICS_SNAPSHOT`/`SENSORS_SNAPSHOT`; `start()` + accessors.
- **Modify `src-tauri/src/lib.rs`** — `pub mod sampler;` + `sampler::start(app...)` in setup.
- **Modify `src-tauri/src/commands.rs`** — `list_processes`/`get_metrics`/`get_sensors` → snapshot reads; `get_overview` → cached; remove the single-flight hack + now-unused imports.
- **Modify `src-tauri/src/perf_recorder.rs`** — `build_sample` reads metrics/sensors snapshots.
- **Modify `src/lib/ipc.ts`** — add `withTimeout`.
- **Modify `src/hooks/useSharedTelemetry.ts`, `src/hooks/useProcesses.ts`, `src/hooks/useAffinityEnforcer.ts`, `src/osd/OsdOverlay.tsx`** — wrap polled invokes in `withTimeout`.

---

## Task 1: Background sampler module

**Files:** Create `src-tauri/src/sampler.rs`; Modify `src-tauri/src/lib.rs`.

- [ ] **Step 1: Create `sampler.rs`**

```rust
//! Single-owner system sampler.
//!
//! The recurring "all readings freeze" class came from commands holding the
//! `state.sys` / `SAMPLER` locks across slow OS/hardware calls (process refresh,
//! Toolhelp thread scan, PDH, NVML) while the frontend polled them — so calls
//! piled up on the lock and exhausted the blocking pool. This thread is the ONLY
//! caller that does those expensive refreshes; it runs them on a fixed cadence,
//! off any request path, and publishes immutable snapshots that commands clone in
//! O(1). Mirrors `telemetry.rs` (the GPU collector). Never panics: each source
//! already degrades to empty/default on failure.

use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use tauri::{AppHandle, Manager};

use crate::process::{self, ProcInfo};
use crate::sensors::{self, SensorSample};
use crate::state::AppState;
use crate::sysmon::{self, Metrics};

static PROC_SNAPSHOT: Lazy<Mutex<Arc<Vec<ProcInfo>>>> =
    Lazy::new(|| Mutex::new(Arc::new(Vec::new())));
static METRICS_SNAPSHOT: Lazy<Mutex<Arc<Metrics>>> =
    Lazy::new(|| Mutex::new(Arc::new(Metrics::default())));
static SENSORS_SNAPSHOT: Lazy<Mutex<Arc<SensorSample>>> =
    Lazy::new(|| Mutex::new(Arc::new(SensorSample::default())));

static STARTED: OnceLock<()> = OnceLock::new();

/// Sampler cadence (≈ today's effective UI poll rate). The expensive refresh is
/// the floor; we never busy-loop and always leave a small gap.
const SAMPLE_INTERVAL: Duration = Duration::from_millis(1500);
const MIN_GAP: Duration = Duration::from_millis(100);

/// Latest process list (O(1) Arc clone). Lazily starts the sampler.
pub(crate) fn proc_snapshot(app: &AppHandle) -> Arc<Vec<ProcInfo>> {
    start(app.clone());
    PROC_SNAPSHOT.lock().clone()
}
/// Latest CPU/mem metrics.
pub(crate) fn metrics_snapshot() -> Arc<Metrics> {
    METRICS_SNAPSHOT.lock().clone()
}
/// Latest sensors sample.
pub(crate) fn sensors_snapshot() -> Arc<SensorSample> {
    SENSORS_SNAPSHOT.lock().clone()
}

/// Spawn the sampler thread (idempotent).
pub fn start(app: AppHandle) {
    STARTED.get_or_init(|| {
        let _ = std::thread::Builder::new()
            .name("corepilot-sampler".into())
            .spawn(move || loop {
                let started = Instant::now();

                // Process list + metrics: ONE lock window on `state.sys`. This is
                // the only full-refresh caller in the whole app now.
                {
                    let state = app.state::<AppState>();
                    let logical = state.topo.logical_count.max(1) as f32;
                    // Toolhelp thread scan first (independent of the sys lock).
                    let threads = process::thread_counts().unwrap_or_default();
                    let mut sys = state.sys.lock();
                    let procs = process::list(&mut sys, &threads, logical);
                    let metrics = sysmon::sample(&mut sys);
                    drop(sys);
                    *PROC_SNAPSHOT.lock() = Arc::new(procs);
                    *METRICS_SNAPSHOT.lock() = Arc::new(metrics);
                }

                // Sensors: reads the GPU snapshot (telemetry.rs) + PDH + sidecar;
                // does not touch `state.sys`.
                *SENSORS_SNAPSHOT.lock() = Arc::new(sensors::sample());

                let elapsed = started.elapsed();
                std::thread::sleep(SAMPLE_INTERVAL.saturating_sub(elapsed).max(MIN_GAP));
            });
    });
}
```

- [ ] **Step 2: Register + start in `lib.rs`**

Add the module declaration next to the others (after `pub mod process;` / alphabetical-ish):

```rust
pub mod sampler;
```

In the `.setup(|app| { ... })` closure, right after the `crate::telemetry::start();` line, add:

```rust
            // Start the single-owner system sampler (process list / metrics /
            // sensors snapshots). The ONLY caller that refreshes the System or
            // samples sensors; commands read its snapshots. See crate::sampler.
            crate::sampler::start(app.handle().clone());
```

- [ ] **Step 3: Compile gate**

Run: `cd src-tauri && PATH="/c/Users/Thomas/.cargo/bin:$PATH" cargo check`
Expected: compiles (warnings about unused snapshot accessors are fine until Task 2).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/sampler.rs src-tauri/src/lib.rs
git commit -m "feat(sampler): single-owner background System+sensors sampler publishing snapshots"
```

---

## Task 2: Commands read snapshots

**Files:** Modify `src-tauri/src/commands.rs`.

- [ ] **Step 1: Add Clone to `Overview`** — `commands.rs` (the `#[derive(Default, Serialize)]` above `pub struct Overview`)

```rust
#[derive(Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
```

- [ ] **Step 2: Replace `get_overview` with a cached read** — `commands.rs`

Replace the whole `get_overview` function with:

```rust
/// Overview is effectively static (CPU name / core counts / RAM / OS). Compute it
/// once (locking `state.sys` a single time — it is not polled, so it can never
/// pile up) and serve the cached clone thereafter.
static OVERVIEW_CACHE: std::sync::OnceLock<Overview> = std::sync::OnceLock::new();

#[tauri::command]
pub async fn get_overview(app: tauri::AppHandle) -> Overview {
    OVERVIEW_CACHE
        .get_or_init(|| {
            let state = app.state::<AppState>();
            let sys = state.sys.lock();
            let cpu_name = sys
                .cpus()
                .first()
                .map(|c| c.brand().trim().to_string())
                .unwrap_or_else(|| "Unknown CPU".into());
            Overview {
                cpu_name,
                physical_cores: state.topo.physical_cores,
                logical_cpus: state.topo.logical_count,
                ram_total: sys.total_memory(),
                os: System::long_os_version().unwrap_or_default(),
                vcache_ccd: state.topo.vcache_ccd,
                detection: state.topo.detection.clone(),
            }
        })
        .clone()
}
```

- [ ] **Step 3: Replace `list_processes` (remove single-flight) with a snapshot read** — `commands.rs`

Delete the `PROC_REFRESHING`/`PROC_CACHE` statics and the doc-comment block added for them, and replace the whole `list_processes` function (including the single-flight body and the `Guard` struct) with:

```rust
/// O(1) read of the background sampler's latest process snapshot. The expensive
/// refresh runs once per cadence in `crate::sampler`, never on this request path,
/// so this can never block or pile up on `state.sys`.
#[tauri::command]
pub async fn list_processes(app: tauri::AppHandle) -> Vec<ProcInfo> {
    (*crate::sampler::proc_snapshot(&app)).clone()
}
```

- [ ] **Step 4: Replace `get_metrics` with a snapshot read** — `commands.rs`

Replace the whole `get_metrics` function with:

```rust
#[tauri::command]
pub async fn get_metrics() -> Metrics {
    (*crate::sampler::metrics_snapshot()).clone()
}
```

- [ ] **Step 5: Replace `get_sensors` with a snapshot read** — `commands.rs`

Replace the whole `get_sensors` function with:

```rust
#[tauri::command]
pub async fn get_sensors() -> crate::error::CoreResult<crate::sensors::SensorSample> {
    Ok((*crate::sampler::sensors_snapshot()).clone())
}
```

- [ ] **Step 6: Drop now-unused imports** — `commands.rs`

The single-flight used `once_cell::sync::Lazy`, `parking_lot::Mutex`, and
`std::sync::atomic::{AtomicBool, Ordering}`. Remove whichever are now unused (the snapshot
reads don't use them; `get_overview` uses `std::sync::OnceLock` inline). Remove these lines if
present and unused:

```rust
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
```

- [ ] **Step 7: Compile gate**

Run: `cd src-tauri && PATH="/c/Users/Thomas/.cargo/bin:$PATH" cargo check`
Expected: compiles, 0 warnings. If "unused import" warnings appear, remove those imports; if a snapshot accessor signature mismatches (`proc_snapshot` takes `&AppHandle`), fix the call.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "refactor(commands): serve process/metrics/sensors/overview from snapshots (no state.sys/SAMPLER on request path)"
```

---

## Task 3: perf_recorder reads snapshots on its 5 Hz path

**Files:** Modify `src-tauri/src/perf_recorder.rs` (`build_sample`, ~line 224-236).

- [ ] **Step 1: Replace the metrics + sensors acquisition in `build_sample`**

Find:

```rust
    // System CPU + memory (shared `System` in AppState).
    let metrics = {
        let state = app.state::<AppState>();
        let mut sys = state.sys.lock();
        crate::sysmon::sample(&mut sys)
    };
    // Telemetry sidecar + PDH (temps/power/clock/disk/net/vram fallback).
    let sensors = crate::sensors::sample();
    // NVML GPU snapshot (preferred for GPU util/temp/power/clocks/VRAM).
    let gpu = crate::gpu::gpu_oc_info_snapshot();
```

Replace with (keep the `gpu` line unchanged — it's a background NVML read, not freeze-class):

```rust
    // CPU + memory and sensors come from the single-owner sampler snapshots, so
    // this 5 Hz path never locks `state.sys` or re-samples hardware (that pile-up
    // froze the app). ≤1 sampler tick stale — fine for a session recorder.
    let metrics = (*crate::sampler::metrics_snapshot()).clone();
    let sensors = (*crate::sampler::sensors_snapshot()).clone();
    // NVML GPU snapshot (preferred for GPU util/temp/power/clocks/VRAM). Background
    // thread + shared NVML handle, so it cannot stall the IPC router.
    let gpu = crate::gpu::gpu_oc_info_snapshot();
```

- [ ] **Step 2: Compile gate**

Run: `cd src-tauri && PATH="/c/Users/Thomas/.cargo/bin:$PATH" cargo check`
Expected: compiles, 0 warnings. (If `app` becomes unused in `build_sample`, it's still used by `exe_path(app, pid)` later in the function — verify no unused-var warning; if one appears, prefix unused with `_` only if truly unused.)

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/perf_recorder.rs
git commit -m "refactor(perf): read metrics/sensors from sampler snapshots on the 5Hz path"
```

---

## Task 4: Frontend self-recovering pollers

**Files:** Modify `src/lib/ipc.ts`, `src/hooks/useSharedTelemetry.ts`, `src/hooks/useProcesses.ts`, `src/hooks/useAffinityEnforcer.ts`, `src/osd/OsdOverlay.tsx`.

- [ ] **Step 1: Add `withTimeout` to `ipc.ts`** — append near the top exports (after the `invoke` import)

```ts
/** Reject a promise if it hasn't settled within `ms`, so a hung backend invoke
 *  can never permanently latch a poller's in-flight guard. Clears its timer when
 *  the wrapped promise settles first. */
export function withTimeout<T>(p: Promise<T>, ms = 6000): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((_, reject) => {
    t = setTimeout(() => reject(new Error("invoke timeout")), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t)) as Promise<T>;
}
```

- [ ] **Step 2: `useSharedTelemetry.ts` — wrap the fetcher** (`makePoller`, the `tick` body)

Find `value = await fetcher();` and replace with:

```ts
      value = await withTimeout(fetcher());
```

Add the import at the top (it already imports from `../lib/ipc`):

```ts
import { api, withTimeout, type Metrics, type Sensors } from "../lib/ipc";
```

(If the existing import is `import { api, type Metrics, type Sensors } from "../lib/ipc";`, just insert `withTimeout, ` after `api, `.)

- [ ] **Step 3: `useProcesses.ts` — wrap the list call**

Find `const data = await api.listProcesses();` and replace with:

```ts
        const data = await withTimeout(api.listProcesses());
```

Add `withTimeout` to the `../lib/ipc` import (or add `import { withTimeout } from "../lib/ipc";` if processes are imported elsewhere). Check the file's existing import line and extend it.

- [ ] **Step 4: `useAffinityEnforcer.ts` — wrap the list call**

Find `procs = await api.listProcesses();` and replace with:

```ts
        procs = await withTimeout(api.listProcesses());
```

Add `withTimeout` to the `../lib/ipc` import.

- [ ] **Step 5: `OsdOverlay.tsx` — wrap the tick invokes**

Find `const info = await api.foregroundInfo().catch(() => null);` and replace with:

```ts
      const info = await withTimeout(api.foregroundInfo()).catch(() => null);
```

Find the `fetchOsdData(...)` await (inside the tick) and wrap it:

```ts
        const d = await withTimeout(fetchOsdData(
          metrics.some((k) => k.startsWith("gpu.")),
          metrics.some((k) => k.startsWith("fps")),
        ));
```

Add `withTimeout` to the imports (the file imports `{ api } from "../lib/ipc"`); make it `import { api, withTimeout } from "../lib/ipc";`.

- [ ] **Step 6: Build gate**

Run: `npm run build`
Expected: `tsc` + `vite` succeed, 0 type errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/ipc.ts src/hooks/useSharedTelemetry.ts src/hooks/useProcesses.ts src/hooks/useAffinityEnforcer.ts src/osd/OsdOverlay.tsx
git commit -m "fix(ui): withTimeout on polled invokes so a hung call can't permanently latch a poller"
```

---

## Task 5: Full build + verify

- [ ] **Step 1: Close running instance** (`powershell.exe -NoProfile -Command "Get-Process corepilot,sensord -ErrorAction SilentlyContinue | Stop-Process -Force"`).
- [ ] **Step 2: Build** — Run: `PATH="/c/Users/Thomas/.cargo/bin:$PATH" npx tauri build`  Expected: bundles, no errors.
- [ ] **Step 3: Relaunch** the new `target/release/corepilot.exe`; verify: Responding=True, threads ~50-70 (not climbing), idle CPU.
- [ ] **Step 4: CLI backend check** — `target/release/cli.exe sensors|memory|processes` return data.
- [ ] **Step 5: 60 s stability watch** — thread count stays stable, no collapse.

---

## Self-Review

- **Spec coverage:** sampler thread → Task 1; commands read snapshots + overview cache + remove single-flight → Task 2; perf_recorder 5 Hz reads snapshots → Task 3; frontend withTimeout self-recovery → Task 4; build+verify → Task 5. ✓
- **Invariant:** after Task 2+3, no `#[tauri::command]` body locks `state.sys`/`SAMPLER` or calls hardware; only `sampler` (full refresh) + `perf_recorder::exe_path` (targeted one-PID, background) touch `state.sys`. ✓
- **Type consistency:** `proc_snapshot(&AppHandle)->Arc<Vec<ProcInfo>>`, `metrics_snapshot()->Arc<Metrics>`, `sensors_snapshot()->Arc<SensorSample>`; commands deref+clone; `Overview` gains `Clone`; `Metrics`/`SensorSample` already `Default+Clone`. `get_metrics`/`get_sensors` drop the `app` param (frontend calls them with no args — unaffected). ✓
- **Placeholder scan:** none — all steps have concrete code.
- **Risk:** `list_processes` keeps its `app` param (used for `proc_snapshot(&app)` to lazily start the sampler); `get_metrics`/`get_sensors` drop `app` (Tauri only injects it when present). Verified the frontend `api.getMetrics()`/`api.getSensors()` pass no args.
