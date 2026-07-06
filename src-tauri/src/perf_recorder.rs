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
//! Session model (v2): sessions are keyed **per PID** and run concurrently.
//! A session ends ONLY when its process exits, recording is disabled, or its
//! exe gets blacklisted — never because another window (even another game)
//! took the foreground. That is what makes one continuous report per game
//! run: alt-tabbing to anything, including a false-positive "game", no longer
//! finalizes/splits the real session.
//!
//! Junk-session filter: at finalize, a session is persisted only if the user
//! explicitly whitelisted the exe (record- or OSD-whitelist) OR it actually
//! *rendered like a game* — ≥ [`MIN_RENDERED_SECS`] cumulative seconds of
//! samples at ≥ [`crate::fps::GAME_FPS_MIN`] FPS. This is what solves the
//! launcher-and-game-share-one-exe problem (dcs.exe): the DCS launcher is a
//! separate PID that never sustains a game-like present rate, so its session
//! is discarded, while the real game PID passes — no blacklist needed. It
//! also drops storefront-library false positives (Steam installs tools, e.g.
//! Tacview) that idle below a game-like rate. When the ETW present pipeline
//! is down (no admin → every FPS is None), the filter bypasses itself rather
//! than discarding real sessions.

use std::collections::HashMap;
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

/// A finalized session is only persisted if it accumulated at least this many
/// seconds of samples at a game-like present rate (≥ `fps::GAME_FPS_MIN`),
/// unless the exe is explicitly whitelisted. Launchers / tools / menus poked
/// for a moment never reach this; any real play session does.
const MIN_RENDERED_SECS: f64 = 30.0;

/// Upper bound on simultaneously-tracked sessions — belt-and-suspenders so a
/// pathological detection storm can't grow sample buffers without limit.
const MAX_CONCURRENT: usize = 4;

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
    /// (The session's PID is its key in the recorder's `active` map.)
    path: Option<String>,
    /// Epoch ms when recording started (also the sample-`t` base).
    started_at: f64,
    cpu_name: Option<String>,
    gpu_name: Option<String>,
    samples: Vec<PerfSampleOut>,
    /// Samples whose FPS was ≥ `fps::GAME_FPS_MIN` — the "actually rendered
    /// like a game" evidence the finalize filter checks (each ≙ one
    /// [`SAMPLE_PERIOD`] of game-rate rendering).
    rendered_samples: u32,
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
    let g = crate::gpu::gpu_oc_info_snapshot();
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
fn build_sample(session: &ActiveSession, pid: u32) -> PerfSampleOut {
    // CPU + memory and sensors come from the single-owner sampler snapshots, so
    // this 5 Hz path never locks `state.sys` or re-samples hardware (that pile-up
    // froze the app). ≤1 sampler tick stale — fine for a session recorder. Read
    // through the Arc — no struct clone needed at 5 Hz × sessions.
    let metrics = crate::sampler::metrics_snapshot();
    let sensors = crate::sampler::sensors_snapshot();
    // NVML GPU snapshot (preferred for GPU util/temp/power/clocks/VRAM). Background
    // thread + shared NVML handle, so it cannot stall the IPC router.
    let gpu = crate::gpu::gpu_oc_info_snapshot();
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
    let gpu_clock = if gpu.available {
        nonzero(gpu.graphics_clock)
    } else {
        None
    };
    let gpu_mem_clock = if gpu.available {
        nonzero(gpu.mem_clock)
    } else {
        None
    };
    let gpu_fan = if gpu.available {
        Some(gpu.fan_speed_pct as f64)
    } else {
        None
    };
    // GPU memory-controller utilization (NVML `utilization_mem`); the frontend
    // `PerfSample.gpuMemCtrlLoad` is optional and the old recorder never set it,
    // but we populate it when NVML exposes it (the report tolerates extra fields).
    let gpu_mem_ctrl_load = if gpu.available {
        Some(gpu.utilization_mem as f64)
    } else {
        None
    };

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

/// True when a finished `session` deserves a persisted report. Explicit user
/// intent (record- or OSD-whitelist) always keeps it; otherwise it must have
/// rendered at a game-like rate for ≥ [`MIN_RENDERED_SECS`] cumulative — this
/// is what silently drops launcher PIDs (dcs.exe launcher), storefront tools
/// (Steam-installed Tacview) and other junk. With the ETW present pipeline
/// down every FPS is `None`, so the render test would discard REAL sessions —
/// bypass it then (pre-filter behavior).
fn should_keep(session: &ActiveSession, white: &[String], osd_white: &[String]) -> bool {
    let whitelisted =
        white.iter().any(|n| *n == session.exe) || osd_white.iter().any(|n| *n == session.exe);
    should_keep_inner(session.rendered_samples, whitelisted, crate::fps::etw_alive())
}

/// Pure decision core of [`should_keep`] (split out for unit testing).
fn should_keep_inner(rendered_samples: u32, whitelisted: bool, etw_alive: bool) -> bool {
    whitelisted
        || !etw_alive
        || f64::from(rendered_samples) * SAMPLE_PERIOD.as_secs_f64() >= MIN_RENDERED_SECS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn junk_filter() {
        let need = (MIN_RENDERED_SECS / SAMPLE_PERIOD.as_secs_f64()) as u32; // 150
        assert!(!should_keep_inner(0, false, true), "launcher/tool discarded");
        assert!(!should_keep_inner(need - 1, false, true), "below threshold");
        assert!(should_keep_inner(need, false, true), "real game kept");
        assert!(should_keep_inner(0, true, true), "whitelist always kept");
        assert!(should_keep_inner(0, false, false), "ETW down → bypass");
    }
}

/// Finalize a session: if it captured ≥1 sample AND passes [`should_keep`],
/// emit `perf://session` for the frontend to persist + display. Empty and
/// junk (never-rendered) sessions are discarded. Best-effort: an emit failure
/// is logged, never fatal.
fn finalize(app: &AppHandle, session: ActiveSession) {
    if session.samples.is_empty() {
        return; // nothing worth keeping
    }
    {
        let cfg = CONFIG.lock();
        if !should_keep(&session, &cfg.white, &cfg.osd_white) {
            tracing::info!(
                "perf recorder: discarding junk session for {} ({} samples, {} game-rate)",
                session.exe,
                session.samples.len(),
                session.rendered_samples
            );
            return;
        }
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
        started_at: now_epoch_ms(),
        cpu_name: cpu_name(app),
        gpu_name: gpu_name(),
        samples: Vec::new(),
        rendered_samples: 0,
    }
}

/// One recorder tick over the pid-keyed session map:
///
/// 1. Recording disabled → finalize everything and stop.
/// 2. Reap: finalize every session whose process has exited — the ONLY normal
///    end of a session. Focus changes never finalize anything, so alt-tabbing
///    (even to another detected game) can no longer split a session.
/// 3. Blacklist: DISCARD (not persist) any session whose exe is blacklisted —
///    the user just told us this app must never be recorded — and never start
///    one for a blacklisted foreground.
/// 4. Start: foreground is a recordable target with no live session for its
///    PID → open one alongside whatever else is recording. Same exe under a
///    new PID (launcher → game handoff) gets its own session.
/// 5. Sample every live session — foreground or background — so the time
///    series has no holes.
fn tick(app: &AppHandle, active: &mut HashMap<u32, ActiveSession>) {
    let fg = crate::fps::foreground_info_now();
    let (enabled, white, black, osd_white) = {
        let cfg = CONFIG.lock();
        (
            cfg.enabled,
            cfg.white.clone(),
            cfg.black.clone(),
            cfg.osd_white.clone(),
        )
    };

    // 1. Recording disabled — finalize all active sessions and stop.
    if !enabled {
        for (_, cur) in active.drain() {
            finalize(app, cur);
        }
        return;
    }

    // 2. Reap exited processes → finalize their reports.
    let dead: Vec<u32> = active
        .keys()
        .copied()
        .filter(|&pid| !crate::fps::pid_alive(pid))
        .collect();
    for pid in dead {
        if let Some(cur) = active.remove(&pid) {
            finalize(app, cur);
        }
    }

    // 3. Blacklist wins over everything: drop (silently — the user said NEVER
    //    record this) any session whose exe is now blacklisted. Handles both a
    //    list edit mid-session and a false positive being killed live.
    active.retain(|_, s| !black.iter().any(|n| *n == s.exe));

    // Normalize the foreground exe the way both the backend and Task-Manager rows
    // produce it (trimmed + lowercased) for case-insensitive list matching.
    let exe_lc: Option<String> = fg.exe.as_deref().map(|e| e.trim().to_lowercase());

    // The record white/black list takes precedence over auto-detection:
    //   - black → NEVER record.
    //   - white / OSD whitelist → force-record (even if NOT auto-detected).
    let rec_black = exe_lc
        .as_ref()
        .is_some_and(|e| black.iter().any(|n| n == e));
    let rec_white = exe_lc
        .as_ref()
        .is_some_and(|e| white.iter().any(|n| n == e));
    let osd_whitelisted = exe_lc
        .as_ref()
        .is_some_and(|e| osd_white.iter().any(|n| n == e));

    // 4. Start a session for a newly-foregrounded recordable target. Existing
    //    sessions keep running untouched (no finalize-on-switch).
    if !rec_black
        && (fg.is_game || rec_white || osd_whitelisted)
        && fg.pid != 0
        && !active.contains_key(&fg.pid)
        && active.len() < MAX_CONCURRENT
    {
        if let Some(exe) = exe_lc {
            active.insert(fg.pid, start(app, &exe, fg.pid));
        }
    }

    // 5. Sample every live session (its own PID's FPS; system metrics are
    //    machine-wide by nature) and tally game-rate evidence for the
    //    finalize filter.
    for (pid, live) in active.iter_mut() {
        let s = build_sample(live, *pid);
        if s.fps.is_some_and(|f| f >= crate::fps::GAME_FPS_MIN) {
            live.rendered_samples += 1;
        }
        live.samples.push(s);
    }
}

/// Start the long-lived recorder thread. Idempotent — safe to call once from
/// `lib.rs` `setup`. Loops at [`SAMPLE_PERIOD`] forever; the owned `active` session
/// map lives on the thread (never shared), so high-frequency sampling never
/// contends a lock with the rest of the app.
pub fn start_recorder(app: AppHandle) {
    if RECORDER_STARTED.swap(true, Ordering::SeqCst) {
        return; // already running
    }
    std::thread::Builder::new()
        .name("corepilot-perf-recorder".into())
        .spawn(move || {
            let mut active: HashMap<u32, ActiveSession> = HashMap::new();
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
