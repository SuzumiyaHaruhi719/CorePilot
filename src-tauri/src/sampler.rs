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

use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, OnceLock,
};
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
static SAMPLER_THREAD: OnceLock<std::thread::Thread> = OnceLock::new();
/// Monotonic millisecond timestamp of the most recent process-list request.
/// A demand stamp wakes the parked sampler without adding a polling thread.
static PROC_DEMAND_MS: AtomicU64 = AtomicU64::new(0);
static LAST_WAKE_MS: AtomicU64 = AtomicU64::new(0);
static DEMAND_EPOCH: OnceLock<Instant> = OnceLock::new();
/// Bumped once per PUBLISHED process snapshot. A cold `proc_snapshot` caller
/// waits for this to advance so it can tell "the roster I'm holding is the one
/// I just asked for" apart from "the roster from before the idle gap".
static PROC_GEN: AtomicU64 = AtomicU64::new(0);

/// Sampler cadence (≈ today's effective UI poll rate). The expensive refresh is
/// the floor; we never busy-loop and always leave a small gap.
const SAMPLE_INTERVAL: Duration = Duration::from_millis(1500);
const MIN_GAP: Duration = Duration::from_millis(100);
/// Cold-start wait budget: enough for the sampler to finish the cycle it is in
/// plus the refresh we just woke it for. On timeout we hand back the old
/// snapshot (exactly today's behaviour) rather than hanging the caller.
const COLD_WAIT_MAX: Duration = Duration::from_millis(1200);
const COLD_WAIT_STEP: Duration = Duration::from_millis(20);

/// Latest process list (O(1) Arc clone). Lazily starts the sampler.
///
/// `Err` means "I could not get you a CURRENT roster" — never a stale one. The
/// callers act by PID (end task, set affinity, set priority), and handing back a
/// pre-idle snapshot that is indistinguishable from a fresh one is exactly how a
/// recycled PID gets acted on. The frontend already treats a failed read as
/// "skip this round" and keeps the last good list on screen.
pub(crate) fn proc_snapshot(app: &AppHandle) -> Result<Arc<Vec<ProcInfo>>, String> {
    let now = monotonic_ms();
    let previous = PROC_DEMAND_MS.swap(now, Ordering::Relaxed);
    let cold = now.saturating_sub(previous) > 2_000;
    // Start BEFORE the cold wait below: on the very first call there is no
    // sampler yet, so nothing would ever bump PROC_GEN and we would burn the
    // whole timeout waiting on a thread that does not exist.
    start(app.clone());
    if cold {
        let generation = PROC_GEN.load(Ordering::Acquire);
        let last_wake = LAST_WAKE_MS.load(Ordering::Relaxed);
        if now.saturating_sub(last_wake) >= 200
            && LAST_WAKE_MS
                .compare_exchange(last_wake, now, Ordering::Relaxed, Ordering::Relaxed)
                .is_ok()
        {
            if let Some(thread) = SAMPLER_THREAD.get() {
                thread.unpark();
            }
        }
        // This branch used to stamp demand, unpark, and then return the PRE-idle
        // snapshot in the same call. Enumeration is on-demand, so after an idle
        // gap that snapshot can be hours old: a cold "pick from running
        // processes" dialog listed dead PIDs and missed live ones with no retry,
        // and `useAffinityEnforcer` (8 s period > the 2 s demand window, so every
        // one of its polls lands here) could pin a RECYCLED pid onto an unrelated
        // process. Wait for the refresh we just asked for instead.
        //
        // Blocking here is safe: the only caller is `list_processes`, which runs
        // this on the BLOCKING pool via `run_blocking_err` — not on the window's
        // message pump (rule 1) and not on an async-runtime worker either, since
        // occupying one of those for a second is its own freeze class. The hot
        // 1 Hz path never reaches it.
        let deadline = Instant::now() + COLD_WAIT_MAX;
        while PROC_GEN.load(Ordering::Acquire) == generation && Instant::now() < deadline {
            std::thread::sleep(COLD_WAIT_STEP);
        }
        if PROC_GEN.load(Ordering::Acquire) == generation {
            // Timed out. Say so rather than returning the pre-idle roster: see
            // the doc comment — silently substituting it is the recycled-PID bug
            // this whole handshake exists to prevent.
            return Err("process list refresh timed out".into());
        }
    }
    Ok(PROC_SNAPSHOT.lock().clone())
}

fn monotonic_ms() -> u64 {
    DEMAND_EPOCH.get_or_init(Instant::now).elapsed().as_millis() as u64
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
        let spawned = std::thread::Builder::new()
            .name("corepilot-sampler".into())
            .spawn(move || loop {
                let started = Instant::now();

                let state = app.state::<AppState>();
                let logical = state.topo.logical_count.max(1) as f32;
                let wanted =
                    monotonic_ms().saturating_sub(PROC_DEMAND_MS.load(Ordering::Relaxed)) <= 2_000;
                // Process enumeration is on-demand: while no consumer asks for
                // rows, avoid Toolhelp/OpenProcess callbacks that used to burn
                // roughly 10% CPU even when the task-manager tab was hidden.
                // Keep the Toolhelp walk outside `state.sys`; otherwise a slow
                // anti-cheat/Defender callback would block overview and recorder
                // commands even though the sampler owns the refresh.
                let threads = wanted.then(|| process::thread_counts().unwrap_or_default());
                let metrics = {
                    let mut sys = state.sys.lock();
                    if let Some(threads) = threads.as_ref() {
                        let procs = process::list(&mut sys, threads, logical);
                        *PROC_SNAPSHOT.lock() = Arc::new(procs);
                        // Publish, then bump: releases any cold caller parked in
                        // `proc_snapshot` waiting for THIS refresh.
                        PROC_GEN.fetch_add(1, Ordering::Release);
                    }
                    sysmon::sample(&mut sys)
                };
                *METRICS_SNAPSHOT.lock() = Arc::new(metrics);

                // Sensors: reads the GPU snapshot (telemetry.rs) + PDH + sidecar;
                // does not touch `state.sys`.
                *SENSORS_SNAPSHOT.lock() = Arc::new(sensors::sample());

                let elapsed = started.elapsed();
                let remaining = SAMPLE_INTERVAL.saturating_sub(elapsed).max(MIN_GAP);
                // park_timeout preserves the normal cadence but lets the first
                // process-list request wake us immediately after an idle gap.
                std::thread::park_timeout(remaining);
            });
        match spawned {
            Ok(handle) => {
                let _ = SAMPLER_THREAD.set(handle.thread().clone());
            }
            Err(e) => {
                // A silent spawn failure leaves every snapshot empty forever — the
                // "all readings disappeared" symptom — so surface it for diagnosis.
                tracing::warn!("corepilot-sampler thread failed to spawn: {e}");
            }
        }
    });
}
