//! Background telemetry collector.
//!
//! The `\GPU Engine(*)` PDH wildcard collect grows with the GPU-process count
//! (1000+ instances → seconds per collect). Running it on every `get_sensors`,
//! `list_processes`, and `gpu_engine_loads` request — under the `SAMPLER` /
//! `state.sys` locks — let a single slow collect saturate the blocking pool and
//! freeze ALL telemetry at once (congestion collapse), which also starved the OSD
//! of foreground/metrics data. This thread runs that one collect on a cadence and
//! publishes an immutable snapshot every reader clones in O(1); no request ever
//! performs the collect or holds a lock across it.

use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use parking_lot::Mutex;

use crate::process::{collect_gpu, GpuFullSnapshot};

/// Latest published GPU snapshot. Readers clone the `Arc` (cheap); the lock is held
/// only to swap the pointer. Starts empty so reads before the first collect return
/// "no data" (`gpuPct` None, empty maps) — the same graceful contract as before.
static GPU_SNAPSHOT: Lazy<Mutex<Arc<GpuFullSnapshot>>> =
    Lazy::new(|| Mutex::new(Arc::new(GpuFullSnapshot::default())));

/// Ensures the collector thread is spawned exactly once.
static STARTED: OnceLock<()> = OnceLock::new();

/// Target cadence. The collect itself is the floor (it can take >1 s); we never
/// busy-loop and always leave a small gap so back-to-back slow collects can't peg
/// a core.
const INTERVAL: Duration = Duration::from_millis(1000);
const MIN_GAP: Duration = Duration::from_millis(100);

/// Clone the latest GPU snapshot (O(1) `Arc` clone). Lazily starts the collector,
/// so the first reader is enough to bring it up even if [`start`] was never called.
pub(crate) fn gpu_snapshot() -> Arc<GpuFullSnapshot> {
    start();
    GPU_SNAPSHOT.lock().clone()
}

/// Spawn the collector thread (idempotent; safe to call from `setup` and/or lazily).
pub fn start() {
    STARTED.get_or_init(|| {
        let spawned = std::thread::Builder::new()
            .name("corepilot-telemetry".into())
            .spawn(|| loop {
                let started = Instant::now();
                // `collect_gpu` never panics: PDH failures yield empty maps.
                let snap = Arc::new(collect_gpu());
                *GPU_SNAPSHOT.lock() = snap;
                let elapsed = started.elapsed();
                std::thread::sleep(INTERVAL.saturating_sub(elapsed).max(MIN_GAP));
            });
        if let Err(e) = spawned {
            // A silent spawn failure leaves the GPU snapshot empty forever — the
            // "GPU readings disappeared" symptom — so surface it for diagnosis.
            tracing::warn!("corepilot-telemetry thread failed to spawn: {e}");
        }
    });
}
