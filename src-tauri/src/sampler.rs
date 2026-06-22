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
