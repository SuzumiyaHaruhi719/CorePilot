# Telemetry Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the telemetry congestion collapse (all readings freeze after a while) and the
OSD-never-shows symptom, by moving the expensive `\GPU Engine(*)` PDH collect off the request path
into one background collector, enforcing a single app instance, and adding frontend backpressure.

**Architecture:** A background thread runs the single slow GPU-engine + VRAM collect on a cadence
and publishes an immutable `Arc<GpuFullSnapshot>`. `get_sensors`, `list_processes`, and the
`gpu_engine_loads` command read that snapshot (O(1)) instead of each running their own multi-second
collect under a shared lock. `tauri-plugin-single-instance` prevents zombie instances fighting over
the fixed `CorePilot-FPS` ETW session. Two frontend `setInterval` pollers get in-flight guards.

**Tech Stack:** Rust / Tauri v2, Windows PDH (`windows` crate), parking_lot, once_cell; React/TS frontend.

> **Verification policy (overrides skill TDD):** Owner's standing rule is build/compile only — no
> functional testing here. Each task's gate is a clean `cargo check` (backend) or `npm run build`
> (frontend); the final gate is `npx tauri build`. Behavioral + hardware validation is the owner's
> on the 9950X3D. **Close all CorePilot instances before `npx tauri build`** (build locks the exe).

> **No-downgrade:** every IPC payload (`Sensors`, `Metrics`, `ProcInfo` GPU fields, `gpu_engine_loads`)
> keeps its exact shape and values. Only the *location/frequency* of the GPU-engine collect changes.
> The rest of `sample()` (disk/net/CPU-clock/temps) stays request-driven, so those stay fully fresh.

---

## File Structure

- **Create `src-tauri/src/telemetry.rs`** — owns the published `Arc<GpuFullSnapshot>`, the
  accessor `gpu_snapshot()`, and the lazily-started background collector thread `start()`.
- **Modify `src-tauri/src/process.rs`** — extend `GpuSnapshot` (+ `aggregate`, `per_engine`);
  extend `gpu_map()` to fill them; add `pub(crate) fn collect_gpu()`; make `gpu_map`/`gpu_vram_map`/
  `GpuSnapshot`/`GpuFullSnapshot` `pub(crate)`; `list()` reads the published snapshot; the
  `gpu_engine_loads` **command** reads the snapshot (the CLI body `gpu_engine_loads_now()` stays a
  direct collect so the CLI probe is unchanged).
- **Modify `src-tauri/src/sensors.rs`** — drop the `gpu_util` counter from `PdhQuery`; source
  `out.gpu_pct` from the published snapshot.
- **Modify `src-tauri/src/lib.rs`** — `pub mod telemetry;`; register `tauri_plugin_single_instance`
  as the FIRST plugin (focus the `main` window on a second launch); call `telemetry::start()` in setup.
- **Modify `src-tauri/Cargo.toml`** — add `tauri-plugin-single-instance = "2"`.
- **Modify `src/hooks/useSharedTelemetry.ts`** — in-flight guard in `makePoller`.
- **Modify `src/osd/OsdOverlay.tsx`** — in-flight guard in the tick loop.

---

## Task 1: Background GPU collector + published snapshot

**Files:**
- Create: `src-tauri/src/telemetry.rs`
- Modify: `src-tauri/src/process.rs` (extend `GpuSnapshot`, `gpu_map`; add `GpuFullSnapshot`, `collect_gpu`; visibility)
- Modify: `src-tauri/src/lib.rs:31` (add `pub mod telemetry;`)

- [ ] **Step 1: Extend `GpuSnapshot` and make types crate-visible** — `process.rs:332`

```rust
// process.rs — replace the GpuSnapshot definition
pub(crate) struct GpuSnapshot {
    pub(crate) util: HashMap<u32, f32>,
    pub(crate) attribution: HashMap<u32, (String, Option<String>)>,
    /// Whole-GPU utilization (sum of all engine instances, clamped 0..100). `None`
    /// when PDH is unavailable / on the priming sample — mirrors the old gpu_util
    /// behaviour in sensors::sample so `gpuPct` stays null-when-unavailable.
    pub(crate) aggregate: Option<f32>,
    /// Per-engine-type totals (e.g. {"3D": 87.0, ...}), clamped 0..100 — the
    /// `gpu_engine_loads` payload, derived from the SAME collect.
    pub(crate) per_engine: HashMap<String, f64>,
}

/// Everything the one background collect produces: per-PID engine data + per-PID VRAM.
pub(crate) struct GpuFullSnapshot {
    pub(crate) engine: GpuSnapshot,
    pub(crate) vram: HashMap<u32, u64>,
}

impl Default for GpuFullSnapshot {
    fn default() -> Self {
        GpuFullSnapshot {
            engine: GpuSnapshot {
                util: HashMap::new(),
                attribution: HashMap::new(),
                aggregate: None,
                per_engine: HashMap::new(),
            },
            vram: HashMap::new(),
        }
    }
}
```

- [ ] **Step 2: Fill `aggregate` + `per_engine` in `gpu_map()`** — `process.rs:345` and its tail (`:450`)

Make the fn crate-visible and, in the existing item loop, also accumulate a grand total and
per-engtype totals. Add after the per-PID clamp loop (`process.rs:426-428`), before building `attribution`:

```rust
// (signature change)
pub(crate) fn gpu_map() -> GpuSnapshot {
```

```rust
// after `for v in util.values_mut() { *v = v.clamp(0.0, 100.0); }`
// Whole-GPU aggregate: sum every PID's clamped utilization, clamp to 100.
// `None` when nothing was collected (PDH unavailable / priming sample).
let aggregate = if util.is_empty() {
    None
} else {
    Some((util.values().sum::<f32>()).clamp(0.0, 100.0))
};
// Per-engine-type totals, summed across PIDs (same labels as gpu_engine_loads).
let mut per_engine: HashMap<String, f64> = HashMap::new();
for engmap in by_engtype.values() {
    for (engtype, v) in engmap {
        *per_engine.entry(engine_label(engtype)).or_insert(0.0) += *v as f64;
    }
}
for v in per_engine.values_mut() {
    *v = v.clamp(0.0, 100.0);
}
```

And update the final `GpuSnapshot { util, attribution }` return (`process.rs:450`) and the three
early-return stubs (`:353`, `:361`, `:372`) to include `aggregate: None, per_engine: HashMap::new()`.
Extract a helper to avoid repetition:

```rust
fn empty_engine_snapshot() -> GpuSnapshot {
    GpuSnapshot { util: HashMap::new(), attribution: HashMap::new(), aggregate: None, per_engine: HashMap::new() }
}
// use `return empty_engine_snapshot();` at the three early returns, and
// `GpuSnapshot { util, attribution, aggregate, per_engine }` at the success return.
```

- [ ] **Step 3: Add `collect_gpu()` and make `gpu_vram_map` crate-visible** — `process.rs:575`, end of file

```rust
// change signature
pub(crate) fn gpu_vram_map() -> HashMap<u32, u64> {
```

```rust
// add near gpu_map
/// One full GPU sample for the background collector: the per-PID + aggregate +
/// per-engine snapshot (one `\GPU Engine(*)` collect) plus per-PID VRAM (one
/// `\GPU Process Memory(*)` collect). This is the ONLY place these run now.
pub(crate) fn collect_gpu() -> GpuFullSnapshot {
    GpuFullSnapshot { engine: gpu_map(), vram: gpu_vram_map() }
}
```

- [ ] **Step 4: Create `telemetry.rs`** — `src-tauri/src/telemetry.rs`

```rust
//! Background telemetry collector. The `\GPU Engine(*)` PDH wildcard collect grows
//! with GPU-process count (1000+ instances → seconds per collect). Running it on
//! every `get_sensors` / `list_processes` / `gpu_engine_loads` request, under the
//! `SAMPLER` / `state.sys` locks, let a single slow collect saturate the blocking
//! pool and freeze ALL telemetry (congestion collapse). This thread runs that one
//! collect on a cadence and publishes an immutable snapshot every reader clones in
//! O(1); no request ever performs the collect or holds a lock across it.

use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use parking_lot::Mutex;

use crate::process::{collect_gpu, GpuFullSnapshot};

/// Latest published GPU snapshot. Readers clone the `Arc` (cheap); the lock is held
/// only to swap the pointer. Starts empty so reads before the first collect return
/// "no data" (gpuPct None, empty maps) — same graceful contract as before.
static GPU_SNAPSHOT: Lazy<Mutex<Arc<GpuFullSnapshot>>> =
    Lazy::new(|| Mutex::new(Arc::new(GpuFullSnapshot::default())));

/// Ensures the collector thread is spawned exactly once.
static STARTED: OnceLock<()> = OnceLock::new();

/// Target cadence. The collect itself is the floor (it can take >1 s); we never
/// busy-loop and we never run two collects back-to-back without a small gap.
const INTERVAL: Duration = Duration::from_millis(1000);
const MIN_GAP: Duration = Duration::from_millis(100);

/// Clone the latest GPU snapshot (O(1) Arc clone). Lazily starts the collector so
/// the first reader is enough to bring it up even if `start()` was never called.
pub(crate) fn gpu_snapshot() -> Arc<GpuFullSnapshot> {
    start();
    GPU_SNAPSHOT.lock().clone()
}

/// Spawn the collector thread (idempotent).
pub fn start() {
    STARTED.get_or_init(|| {
        let _ = std::thread::Builder::new()
            .name("corepilot-telemetry".into())
            .spawn(|| loop {
                let started = Instant::now();
                // collect_gpu never panics (PDH failures yield empty maps).
                let snap = Arc::new(collect_gpu());
                *GPU_SNAPSHOT.lock() = snap;
                let elapsed = started.elapsed();
                std::thread::sleep(INTERVAL.saturating_sub(elapsed).max(MIN_GAP));
            });
    });
}
```

- [ ] **Step 5: Register the module** — `src-tauri/src/lib.rs:26` (alphabetical, after `sysmon`)

```rust
pub mod telemetry;
```

- [ ] **Step 6: Compile gate**

Run: `cd src-tauri && cargo check`
Expected: compiles. (Warnings about now-unused `GPU_ENGINE_QUERY` are removed in Task 3.)

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/telemetry.rs src-tauri/src/process.rs src-tauri/src/lib.rs
git commit -m "feat(telemetry): background GPU-engine collector + published snapshot"
```

---

## Task 2: Route readers to the snapshot

**Files:**
- Modify: `src-tauri/src/process.rs:633,636` (`list()`), `:495-498` (`gpu_engine_loads` command)
- Modify: `src-tauri/src/sensors.rs` (`PdhQuery`, `sample()`)

- [ ] **Step 1: `list()` reads the snapshot instead of collecting** — `process.rs:631-636`

```rust
    // Per-process GPU utilization/attribution + VRAM come from the background
    // telemetry collector (one shared collect), NOT a per-call PDH collect under
    // the sys lock — that collect is what used to freeze the process list.
    let snap = crate::telemetry::gpu_snapshot();
    let gpu = &snap.engine;
    let gpu_vram = &snap.vram;
```

(The downstream reads `gpu.util.get(&id)`, `gpu.attribution.get(&id)`, `gpu_vram.get(&id)` are
unchanged — `gpu`/`gpu_vram` are now borrows, which `.get(...).copied()`/`.clone()` already handle.)

- [ ] **Step 2: `gpu_engine_loads` command reads the snapshot; keep CLI body direct** — `process.rs:495-498`

```rust
#[tauri::command]
pub async fn gpu_engine_loads() -> HashMap<String, f64> {
    // Hot path (Performance view poll): O(1) read of the background snapshot.
    crate::telemetry::gpu_snapshot().engine.per_engine.clone()
}
```

Leave `gpu_engine_loads_now()` (and `GPU_ENGINE_QUERY`) as-is — the CLI probe in `bin/cli.rs`
still calls it directly and must keep doing its own collect.

- [ ] **Step 3: Drop `gpu_util` from the sensors PDH query** — `sensors.rs:79`, `:390`, `:413-422`

Remove the `gpu_util: PDH_HCOUNTER,` field (`:79`); remove the
`let gpu_util = add(r"\GPU Engine(*)\Utilization Percentage");` line and drop `gpu_util` from the
essential-counters tuple/`else` (`:390-399`) so only disk counters remain essential; remove
`gpu_util` from the `PdhQuery { … }` constructor (`:413-422`). Keep `gpu_mem`
(`\GPU Adapter Memory(*)` — per-adapter, cheap) and the disk/CPU-clock counters.

- [ ] **Step 4: Source `gpu_pct` from the snapshot in `sample()`** — `sensors.rs:624-627`

Replace the `read_array(pdh.gpu_util)` block:

```rust
                // (REMOVED the \GPU Engine(*) read here — it now lives in the
                //  background telemetry collector; see crate::telemetry.)
```

and after the `s.pdh` block (near `sensors.rs:653`, outside the `if let Some(pdh)`), set:

```rust
    // Whole-GPU utilization from the background collector (one shared collect).
    out.gpu_pct = crate::telemetry::gpu_snapshot().engine.aggregate;
```

- [ ] **Step 5: Compile gate**

Run: `cd src-tauri && cargo check`
Expected: compiles, no unused-import errors. (If `read_array` becomes unused, keep it — `gpu_mem`
still uses it; verify.)

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/process.rs src-tauri/src/sensors.rs
git commit -m "refactor(telemetry): read GPU data from snapshot in list/sensors/gpu_engine_loads"
```

---

## Task 3: Start the collector + remove dead GPU-engine query duplication

**Files:**
- Modify: `src-tauri/src/lib.rs` (setup), `src-tauri/src/process.rs` (only if `GPU_ENGINE_QUERY` is now unused)

- [ ] **Step 1: Start the collector in setup** — `src-tauri/src/lib.rs:135` (top of the setup closure)

```rust
            // Start the background GPU-engine telemetry collector (one shared
            // collect feeding sensors / process list / gpu_engine_loads). Lazily
            // self-starts on first read too, but start it eagerly so the first UI
            // poll already has data.
            crate::telemetry::start();
```

- [ ] **Step 2: Confirm `GPU_ENGINE_QUERY` is still referenced** — `process.rs`

`gpu_engine_loads_now()` (CLI) still uses `GPU_ENGINE_QUERY`, so keep it. If `cargo check` reports
it unused (CLI excluded from this build target), gate it with `#[allow(dead_code)]` rather than
deleting — the CLI binary needs it. Do NOT remove `gpu_map`/`gpu_vram_map` (the collector uses them).

- [ ] **Step 3: Compile gate**

Run: `cd src-tauri && cargo check`
Expected: compiles clean.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/process.rs
git commit -m "feat(telemetry): start background collector at app setup"
```

---

## Task 4: Single-instance enforcement

**Files:**
- Modify: `src-tauri/Cargo.toml:59` (add dependency)
- Modify: `src-tauri/src/lib.rs:127-131` (register as first plugin)

- [ ] **Step 1: Add the dependency** — `src-tauri/Cargo.toml` (after `tauri-plugin-notification`)

```toml
tauri-plugin-single-instance = "2"
```

- [ ] **Step 2: Register as the FIRST plugin** — `src-tauri/src/lib.rs:127`

```rust
    tauri::Builder::default()
        // MUST be the first plugin. A second launch hands its argv to THIS running
        // instance and exits, instead of spawning a parallel instance — which is
        // what produced zombie instances fighting over the fixed `CorePilot-FPS`
        // ETW session (game detection broke → OSD never showed) and multiplied the
        // GPU-engine collects.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            use tauri::Manager;
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
```

- [ ] **Step 3: Compile gate**

Run: `cd src-tauri && cargo check`
Expected: resolves the new crate and compiles. (`tauri::Manager` is already imported at lib.rs:33;
the inner `use` is harmless/explicit.)

- [ ] **Step 4: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs
git commit -m "feat: enforce single instance (focus existing window on relaunch)"
```

---

## Task 5: Frontend in-flight guards (backpressure)

**Files:**
- Modify: `src/hooks/useSharedTelemetry.ts:14-35`
- Modify: `src/osd/OsdOverlay.tsx:156-221`

- [ ] **Step 1: Guard `makePoller`** — `useSharedTelemetry.ts:23-35`

```ts
function makePoller<T>(fetcher: () => Promise<T>) {
  let value: T | null = null;
  let timer: number | null = null;
  let intervalMs = 1500;
  let inFlight = false; // skip a tick if the previous fetch hasn't resolved
  const subs = new Set<() => void>();

  const emit = () => {
    for (const cb of subs) cb();
  };
  const tick = async () => {
    if (inFlight) return; // backpressure: never pile up invokes on a slow backend
    inFlight = true;
    try {
      value = await fetcher();
      emit();
    } catch {
      /* backend not ready / transient — keep last value */
    } finally {
      inFlight = false;
    }
  };
  // start()/stop()/return unchanged …
```

- [ ] **Step 2: Guard the OSD tick** — `OsdOverlay.tsx:156-221`

Add an in-flight latch around the per-tick fetches so a slow backend can't queue overlapping
overlay polls:

```tsx
  useEffect(() => {
    let alive = true;
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        // … existing tick body unchanged …
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), TICK_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [needGpu, needFps, show]);
```

(Wrap the existing body in the `try`; keep every existing line, including the `if (!alive) return;`
guards and the `setFg`/`setMon`/`setData` calls.)

- [ ] **Step 3: Build gate**

Run: `npm run build`
Expected: `tsc` + `vite` succeed with no type errors.

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useSharedTelemetry.ts src/osd/OsdOverlay.tsx
git commit -m "fix(ui): in-flight guards on telemetry + OSD pollers (backpressure)"
```

---

## Task 6: Full build

- [ ] **Step 1: Close all CorePilot instances** (the build locks `corepilot.exe`).

- [ ] **Step 2: Build** — overlay DLL already exists in `target/release`; if a clean build complains
about the missing `corepilot_overlay.dll` resource, build it first per `Cargo.toml`'s header
(`cargo build -p corepilot-overlay --release`), then:

Run: `npx tauri build`
Expected: bundles successfully; no `cargo`/`tsc` errors.

- [ ] **Step 3: Hand off to owner** for hardware validation on the 9950X3D (readings stay live under
long uptime + GPU load; two launches focus one window; OSD shows over Forza + on desktop; idle CPU low).

---

## Self-Review

- **Spec coverage:** Part 1 (background sampler) → Tasks 1–3; Part 2 (single-instance) → Task 4;
  Part 3 (frontend backpressure) → Task 5. Build/validation → Task 6. ✓
- **Refinement vs spec:** only the `\GPU Engine(*)` collect (+ VRAM) moves to the background; the rest
  of `sample()` stays request-driven so disk/net/temps keep full freshness (strictly ≥ spec, no downgrade).
- **Type consistency:** `GpuSnapshot` gains `aggregate: Option<f32>` + `per_engine: HashMap<String,f64>`;
  `GpuFullSnapshot { engine, vram }`; `collect_gpu() -> GpuFullSnapshot`; `gpu_snapshot() -> Arc<GpuFullSnapshot>`.
  `sample()` sets `out.gpu_pct = …aggregate` (Option→Option, matches the old None-when-unavailable). ✓
- **CLI intact:** `gpu_engine_loads_now()` + `GPU_ENGINE_QUERY` retained for the CLI probe. ✓
- **Placeholder scan:** none.
