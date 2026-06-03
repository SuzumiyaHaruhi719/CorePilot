//! **Backend per-game performance-session recorder.**
//!
//! This is the reliable replacement for the old frontend recorder
//! (`src/hooks/usePerfRecorder.ts`). That recorder ran on a `setInterval` inside
//! the main WebView2 window; when a GPU-heavy game holds the foreground,
//! CorePilot's renderer is backgrounded/occluded and Chromium freezes its task
//! scheduler — so ~1 in 3 sessions was silently missed (reproduced on FurMark).
//!
//! A native background thread is immune to that freeze, so the SAMPLING now lives
//! here and the frontend only PERSISTS + DISPLAYS the result:
//!
//! * This thread (~5 Hz, [`SAMPLE_PERIOD`]) watches the foreground app via
//!   [`crate::fps::foreground_info`] and, while a recordable game runs, appends a
//!   [`PerfSampleOut`] (the exact camelCase shape of the frontend `PerfSample`)
//!   pulling the same metric sources the OSD/`fetchOsdData` reads.
//! * Recording config (master switch + record white/black list + OSD whitelist)
//!   is **pushed from the frontend** via [`perf_recorder_config`] — we never parse
//!   the store from Rust. Names are lowercased exe names.
//! * On finalize (game PID exits, a different target takes the foreground, or
//!   recording is disabled) the buffered session is emitted as a single
//!   `perf://session` event. The listener lives in the main window, which
//!   un-freezes the moment the game closes (it returns to the foreground), so the
//!   queued event is delivered exactly when we want the report to pop.
//!
//! The thread mirrors the frontend recorder's record/finalize logic one-for-one
//! so behaviour (blacklist precedence, whitelist force-record, alt-tab pause,
//! discard-empty) is identical — only the execution context changed.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::state::AppState;

/// Sampling cadence — ~5 Hz, matching the spec (the old frontend recorder ran at
/// ~1 Hz). A native thread can sustain this without the renderer-freeze risk.
const SAMPLE_PERIOD: Duration = Duration::from_millis(200);

/// Recording configuration pushed from the frontend. The frontend owns the
/// stores; it lowercases exe names and hands us flat lists so the recorder never
/// has to parse the tauri-store. Defaults: recording ON, empty lists (mirrors
/// `settings.perfRecording = true` and empty record/OSD target lists at startup).
#[derive(Default)]
struct RecorderConfig {
    /// Master switch (`settings.perfRecording`). When false we finalize any active
    /// session and record nothing.
    enabled: bool,
    /// Force-RECORD exe names (record white list — record even if not auto-detected
    /// as a game).
    white: Vec<String>,
    /// NEVER-record exe names (record black list — skip entirely, even if detected
    /// as a game; lets the user kill a false positive).
    black: Vec<String>,
    /// OSD whitelist exe names — also force-record, kept for back-compat so an
    /// existing OSD-whitelist setup (e.g. furmark) keeps recording.
    osd_white: Vec<String>,
}

/// Default config until the frontend pushes one: recording enabled (matches the
/// `perfRecording: true` default) with empty lists. So even if the frontend never
/// calls `perf_recorder_config` (it does, on mount), auto-detected games still
/// record.
static CONFIG: Lazy<Mutex<RecorderConfig>> = Lazy::new(|| {
    Mutex::new(RecorderConfig {
        enabled: true,
        white: Vec::new(),
        black: Vec::new(),
        osd_white: Vec::new(),
    })
});

/// Ensures the recorder thread is spawned at most once.
static RECORDER_STARTED: AtomicBool = AtomicBool::new(false);

/// One ~5 Hz performance sample. **Field names and nullability mirror the frontend
/// `PerfSample` (`src/lib/perf.ts`) exactly** so the emitted JSON deserializes
/// straight into it. `#[serde(rename_all = "camelCase")]` turns e.g. `frametime_ms`
/// into `frametimeMs`; every metric is `Option<f64>` → `number | null` in TS.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PerfSampleOut {
    /// Milliseconds since session start.
    t: f64,
    fps: Option<f64>,
    frametime_ms: Option<f64>,
    cpu_load: Option<f64>,
    cpu_temp: Option<f64>,
    cpu_power: Option<f64>,
    cpu_clock: Option<f64>,
    gpu_load: Option<f64>,
    gpu_temp: Option<f64>,
    gpu_power: Option<f64>,
    gpu_clock: Option<f64>,
    vram_load: Option<f64>,
    mem_load: Option<f64>,
    gpu_mem_clock: Option<f64>,
    gpu_mem_ctrl_load: Option<f64>,
    gpu_fan: Option<f64>,
    disk_load: Option<f64>,
    disk_read: Option<f64>,
    disk_write: Option<f64>,
    net_down: Option<f64>,
    net_up: Option<f64>,
}

/// Payload emitted on `perf://session` when a session finalizes (≥1 sample). The
/// frontend wraps this into a full `PerfSession` (adds id/name/refreshHz/summary
/// and downsamples `samples`). camelCase to match the frontend's expectations.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SessionPayload {
    /// Lowercased exe, e.g. "subnautica2-win64-shipping.exe".
    exe: String,
    /// Full executable path (for the report's path display + the real exe icon
    /// on the history cards), or null when it couldn't be resolved.
    path: Option<String>,
    /// Epoch ms when recording started.
    started_at: f64,
    /// Epoch ms when the session finalized.
    ended_at: f64,
    /// Whole seconds recorded.
    duration_sec: u64,
    cpu_name: Option<String>,
    gpu_name: Option<String>,
    /// Full (pre-downsample) time series. The frontend summarizes from this and
    /// then downsamples for storage.
    samples: Vec<PerfSampleOut>,
}

/// Live recording state, owned by the recorder thread (never shared). Mirrors the
/// frontend `ActiveSession`.
struct ActiveSession {
    /// Lowercased exe name of the detected game.
    exe: String,
    /// Full executable path, resolved once at session start (icon + path display).
    path: Option<String>,
    /// Foreground PID being tracked.
    pid: u32,
    /// Epoch ms when recording started (also the sample-`t` base).
    started_at: f64,
    cpu_name: Option<String>,
    gpu_name: Option<String>,
    samples: Vec<PerfSampleOut>,
}

/// **Push recorder config from the frontend.** The frontend calls this on mount
/// and whenever the relevant stores (settings.perfRecording, record targets, OSD
/// targets) change. `white`/`black`/`osd_white` are lowercased exe-name lists.
/// Storing into shared state is all this does; the recorder thread reads it each
/// tick. Never fails.
#[tauri::command]
pub fn perf_recorder_config(
    enabled: bool,
    white: Vec<String>,
    black: Vec<String>,
    osd_white: Vec<String>,
) {
    let lower = |v: Vec<String>| v.into_iter().map(|s| s.trim().to_lowercase()).collect();
    let mut cfg = CONFIG.lock();
    cfg.enabled = enabled;
    cfg.white = lower(white);
    cfg.black = lower(black);
    cfg.osd_white = lower(osd_white);
}

/// Current epoch time in milliseconds (f64 so it lands as a plain JS number).
fn now_epoch_ms() -> f64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

/// Resolve the CPU brand string the way `get_overview` does (so `cpuName` matches
/// what the Overview/report header shows). `None` if unavailable.
fn cpu_name(app: &AppHandle) -> Option<String> {
    let state = app.state::<AppState>();
    let sys = state.sys.lock();
    sys.cpus()
        .first()
        .map(|c| c.brand().trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Resolve the GPU name from NVML (same source as the frontend's `gpuOcInfo().name`).
/// `None` when NVML is unavailable or the name is empty.
fn gpu_name() -> Option<String> {
    let g = crate::gpu::gpu_oc_info();
    if g.available && !g.name.is_empty() {
        Some(g.name)
    } else {
        None
    }
}

/// Resolve the full executable path for `pid`. Targeted-refreshes just this pid
/// in the shared `System` (so it doesn't depend on when the process list was last
/// refreshed), then reads its image path. `None` when the process is already gone
/// or exposes no accessible path.
fn exe_path(app: &AppHandle, pid: u32) -> Option<String> {
    let state = app.state::<AppState>();
    let mut sys = state.sys.lock();
    let p = sysinfo::Pid::from_u32(pid);
    sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[p]), false);
    sys.process(p)
        .and_then(|proc| proc.exe())
        .map(|path| path.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
}

/// Pull one metric snapshot for `pid` and build a [`PerfSampleOut`].
///
/// The metric→field mapping mirrors the frontend `sample()` in
/// `usePerfRecorder.ts` (which reads `fetchOsdData`) and the in-frame OSD sampler
/// (`overlay_inject::publish_metrics`) one-for-one: prefer NVML for GPU
/// util/temp/power/clocks/VRAM, fall back to the PDH/sidecar aggregate; CPU
/// load/mem from the shared `System`; CPU temp/power/clock + disk + net from the
/// sensors sample. Unavailable metrics are `None` (→ `null`), never fabricated.
fn build_sample(app: &AppHandle, session: &ActiveSession, pid: u32) -> PerfSampleOut {
    // System CPU + memory (shared `System` in AppState).
    let metrics = {
        let state = app.state::<AppState>();
        let mut sys = state.sys.lock();
        crate::sysmon::sample(&mut sys)
    };
    // Telemetry sidecar + PDH (temps/power/clock/disk/net/vram fallback).
    let sensors = crate::sensors::sample();
    // NVML GPU snapshot (preferred for GPU util/temp/power/clocks/VRAM).
    let gpu = crate::gpu::gpu_oc_info();
    // Frame pacing for THIS pid (the recorded game, not the foreground).
    let fps = crate::fps::stats_for_pid(pid);

    // GPU util/temp/power: prefer NVML, else the PDH/sidecar aggregate (identical
    // precedence to `osd.ts` / the frontend recorder).
    let gpu_load = if gpu.available {
        Some(gpu.utilization_gpu as f64)
    } else {
        sensors.gpu_pct.map(|v| v as f64)
    };
    let gpu_temp = if gpu.available {
        Some(gpu.temperature as f64)
    } else {
        sensors.gpu_temp.map(|v| v as f64)
    };
    let gpu_power = if gpu.available {
        Some(gpu.power_usage_w)
    } else {
        sensors.gpu_power.map(|v| v as f64)
    };
    // Clocks/fan/mem-ctrl only come from NVML; 0 means "unknown" → null.
    let nonzero = |v: u32| (v != 0).then_some(v as f64);
    let gpu_clock = if gpu.available { nonzero(gpu.graphics_clock) } else { None };
    let gpu_mem_clock = if gpu.available { nonzero(gpu.mem_clock) } else { None };
    let gpu_fan = if gpu.available { Some(gpu.fan_speed_pct as f64) } else { None };
    // GPU memory-controller utilization (NVML `utilization_mem`); the frontend
    // `PerfSample.gpuMemCtrlLoad` is optional and the old recorder never set it,
    // but we populate it when NVML exposes it (the report tolerates extra fields).
    let gpu_mem_ctrl_load = if gpu.available { Some(gpu.utilization_mem as f64) } else { None };

    // VRAM %: prefer NVML used/total, else the PDH/DXGI sidecar values.
    let vram_load = if gpu.available && gpu.mem_total_bytes > 0 {
        Some((gpu.mem_used_bytes as f64 / gpu.mem_total_bytes as f64) * 100.0)
    } else if let (Some(used), Some(total)) = (sensors.vram_used, sensors.vram_total) {
        if total > 0 {
            Some((used as f64 / total as f64) * 100.0)
        } else {
            None
        }
    } else {
        None
    };

    // RAM % from the system sample.
    let mem_load = if metrics.mem_total > 0 {
        Some((metrics.mem_used as f64 / metrics.mem_total as f64) * 100.0)
    } else {
        None
    };

    PerfSampleOut {
        t: now_epoch_ms() - session.started_at,
        fps: fps.fps,
        frametime_ms: fps.frametime_ms,
        cpu_load: Some(metrics.cpu_overall as f64),
        cpu_temp: sensors.cpu_temp.map(|v| v as f64),
        cpu_power: sensors.cpu_power.map(|v| v as f64),
        cpu_clock: sensors.cpu_clock,
        gpu_load,
        gpu_temp,
        gpu_power,
        gpu_clock,
        vram_load,
        mem_load,
        gpu_mem_clock,
        gpu_mem_ctrl_load,
        gpu_fan,
        disk_load: sensors.disk_pct.map(|v| v as f64),
        disk_read: sensors.disk_read.map(|v| v as f64),
        disk_write: sensors.disk_write.map(|v| v as f64),
        net_down: sensors.net_down.map(|v| v as f64),
        net_up: sensors.net_up.map(|v| v as f64),
    }
}

/// Finalize a session: if it captured ≥1 sample, emit `perf://session` for the
/// frontend to persist + display. Empty sessions are discarded (mirrors the
/// frontend's `if (samples.length === 0) return`). Best-effort: an emit failure is
/// logged, never fatal.
fn finalize(app: &AppHandle, session: ActiveSession) {
    if session.samples.is_empty() {
        return; // nothing worth keeping
    }
    let ended_at = now_epoch_ms();
    let payload = SessionPayload {
        exe: session.exe,
        path: session.path,
        started_at: session.started_at,
        ended_at,
        duration_sec: ((ended_at - session.started_at) / 1000.0).round().max(0.0) as u64,
        cpu_name: session.cpu_name,
        gpu_name: session.gpu_name,
        samples: session.samples,
    };
    if let Err(e) = app.emit("perf://session", &payload) {
        tracing::warn!("failed to emit perf://session: {e}");
    }
}

/// Begin tracking a freshly-detected foreground game (resolves CPU/GPU names once,
/// mirrors the frontend `start`).
fn start(app: &AppHandle, exe: &str, pid: u32) -> ActiveSession {
    ActiveSession {
        exe: exe.to_lowercase(),
        path: exe_path(app, pid),
        pid,
        started_at: now_epoch_ms(),
        cpu_name: cpu_name(app),
        gpu_name: gpu_name(),
        samples: Vec::new(),
    }
}

/// One recorder tick. Mirrors the frontend `tick()` record/finalize logic exactly:
///
/// 1. Recording disabled → finalize any active session and stop.
/// 2. Foreground PID changed off the tracked session → finalize if the tracked
///    PID has exited, otherwise pause (alt-tabbed away; keep the session).
/// 3. Blacklist precedence → if the foreground exe is blacklisted, finalize any
///    session we were recording for it and skip.
/// 4. Else, if `is_game || record-white || osd-white`, start a session for a new
///    target (finalizing a previous, different one first).
/// 5. Sample → append a data point when the live session matches the foreground.
///
/// `active` is the recorder thread's single owned session slot.
fn tick(app: &AppHandle, active: &mut Option<ActiveSession>) {
    let fg = crate::fps::foreground_info();
    let (enabled, white, black, osd_white) = {
        let cfg = CONFIG.lock();
        (
            cfg.enabled,
            cfg.white.clone(),
            cfg.black.clone(),
            cfg.osd_white.clone(),
        )
    };

    // 1. Recording disabled — finalize any active session and stop.
    if !enabled {
        if let Some(cur) = active.take() {
            finalize(app, cur);
        }
        return;
    }

    // 2. Finalize ONLY when the recorded game's process exits — never on focus
    //    loss. A backgrounded (alt-tabbed) game is still running and must keep
    //    being recorded; pausing when it isn't the foreground is what punched
    //    gaps into the time series.
    if let Some(cur) = active.as_ref() {
        if !crate::fps::pid_alive(cur.pid) {
            // The game process exited — close out the report.
            let cur = active.take().expect("checked Some above");
            finalize(app, cur);
        }
    }

    // Normalize the foreground exe the way both the backend and Task-Manager rows
    // produce it (trimmed + lowercased) for case-insensitive list matching.
    let exe_lc: Option<String> = fg.exe.as_deref().map(|e| e.trim().to_lowercase());

    // The record white/black list takes precedence over auto-detection:
    //   - black → NEVER record (kill any false-positive).
    //   - white → force-record (even if NOT auto-detected as a game).
    // The OSD whitelist also force-records (back-compat).
    let rec_black = exe_lc.as_ref().is_some_and(|e| black.iter().any(|n| n == e));
    let rec_white = exe_lc.as_ref().is_some_and(|e| white.iter().any(|n| n == e));
    let osd_whitelisted = exe_lc.as_ref().is_some_and(|e| osd_white.iter().any(|n| n == e));

    // 3. Blacklist: never start recording a blacklisted foreground app; if we
    //    were recording IT, finalize. We do NOT bail out here — a *different*
    //    active game must keep being sampled below (don't gap it just because a
    //    blacklisted app grabbed focus).
    if rec_black {
        if let Some(existing) = active.as_ref() {
            if fg.pid == existing.pid {
                let existing = active.take().expect("checked Some above");
                finalize(app, existing);
            }
        }
    } else if (fg.is_game || rec_white || osd_whitelisted) && fg.exe.is_some() {
        // 4. Start / switch: record this foreground game (finalizing a previous,
        //    different one first). While a game is already active and alive it
        //    keeps recording even in the background (step 2 only ends on exit),
        //    so this just picks up the *next* game once the foreground changes.
        let exe = exe_lc.clone().expect("fg.exe is Some");
        let is_new = match active.as_ref() {
            None => true,
            Some(existing) => existing.exe != exe,
        };
        if is_new {
            if let Some(existing) = active.take() {
                finalize(app, existing);
            }
            *active = Some(start(app, &exe, fg.pid));
        }
    }

    // 5. Sample: append a data point for the live session — foreground OR
    //    background. As long as its process is alive we keep sampling, so
    //    alt-tabbing out no longer leaves a hole in the data.
    if let Some(live) = active.as_ref() {
        let s = build_sample(app, live, live.pid);
        if let Some(live) = active.as_mut() {
            live.samples.push(s);
        }
    }
}

/// Start the long-lived recorder thread. Idempotent — safe to call once from
/// `lib.rs` `setup`. Loops at [`SAMPLE_PERIOD`] forever; the owned `active` session
/// slot lives on the thread (never shared), so high-frequency sampling never
/// contends a lock with the rest of the app.
pub fn start_recorder(app: AppHandle) {
    if RECORDER_STARTED.swap(true, Ordering::SeqCst) {
        return; // already running
    }
    std::thread::Builder::new()
        .name("corepilot-perf-recorder".into())
        .spawn(move || {
            let mut active: Option<ActiveSession> = None;
            loop {
                // A transient metric/IPC failure must never kill the recorder. The
                // tick itself uses best-effort reads (each source degrades to
                // None), so this is belt-and-suspenders against an unexpected
                // panic in a dependency.
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    tick(&app, &mut active);
                }));
                if let Err(_e) = result {
                    tracing::warn!("perf recorder tick panicked; continuing");
                }
                std::thread::sleep(SAMPLE_PERIOD);
            }
        })
        .ok();
}
