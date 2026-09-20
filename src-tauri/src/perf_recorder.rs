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
//! launcher-and-game-share-one-exe problem (dcs.exe) together with the
//! handoff check in `finalize` (`has_live_same_exe_child`): the DCS launcher
//! plays a VIDEO background (≥20 fps, so FPS alone can't tell it apart) but
//! always spawns the game as a same-exe child and exits — that signature
//! discards it, while the real game PID passes — no blacklist needed. It
//! also drops storefront-library false positives (Steam installs tools, e.g.
//! Tacview) that idle below a game-like rate. When the ETW present pipeline
//! is down (no admin → every FPS is None), the filter bypasses itself rather
//! than discarding real sessions.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
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

/// How many sessions are live right now. The `active` map itself is thread-local
/// to the recorder loop (deliberately — no lock on the 5 Hz path), so this
/// mirror is how the rest of the app can ask. Written once per tick.
///
/// The self-updater reads it: sessions only finalize when their process exits,
/// so quitting the app to install discards whatever is mid-recording.
static ACTIVE_SESSIONS: AtomicUsize = AtomicUsize::new(0);

/// Number of game sessions currently being recorded.
pub fn active_session_count() -> usize {
    ACTIVE_SESSIONS.load(Ordering::Relaxed)
}

/// One ~5 Hz performance sample. **Field names and nullability mirror the frontend
/// `PerfSample` (`src/lib/perf.ts`) exactly** so the emitted JSON deserializes
/// straight into it. `#[serde(rename_all = "camelCase")]` turns e.g. `frametime_ms`
/// into `frametimeMs`; every metric is `Option<f64>` → `number | null` in TS.
#[derive(Default, Serialize, Clone)]
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

/// Summary statistics computed from the full (pre-downsample) series.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PerfSummaryOut {
    avg_fps: Option<f64>,
    min_fps: Option<f64>,
    max_fps: Option<f64>,
    low1: Option<f64>,
    low01: Option<f64>,
    avg_frametime_ms: Option<f64>,
    avg_cpu_load: Option<f64>,
    avg_cpu_temp: Option<f64>,
    max_cpu_temp: Option<f64>,
    avg_cpu_power: Option<f64>,
    max_cpu_power: Option<f64>,
    avg_cpu_clock: Option<f64>,
    avg_gpu_load: Option<f64>,
    avg_gpu_temp: Option<f64>,
    max_gpu_temp: Option<f64>,
    avg_gpu_power: Option<f64>,
    max_gpu_power: Option<f64>,
    avg_gpu_clock: Option<f64>,
    avg_vram_load: Option<f64>,
    max_vram_load: Option<f64>,
    avg_mem_load: Option<f64>,
    energy_wh: Option<f64>,
    co2_kg: Option<f64>,
}

/// Payload emitted on `perf://session` when a session finalizes.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SessionPayload {
    meta: SessionMeta,
    summary: PerfSummaryOut,
    samples: Vec<PerfSampleOut>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SessionMeta {
    exe: String,
    path: Option<String>,
    started_at: f64,
    ended_at: f64,
    duration_sec: u64,
    cpu_name: Option<String>,
    gpu_name: Option<String>,
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
    should_keep_inner(
        session.rendered_samples,
        whitelisted,
        crate::fps::etw_alive(),
    )
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
        assert!(
            !should_keep_inner(0, false, true),
            "launcher/tool discarded"
        );
        assert!(!should_keep_inner(need - 1, false, true), "below threshold");
        assert!(should_keep_inner(need, false, true), "real game kept");
        assert!(should_keep_inner(0, true, true), "whitelist always kept");
        assert!(should_keep_inner(0, false, false), "ETW down → bypass");
    }
}

/// True when a LIVE process exists whose parent is `pid` and whose exe name
/// (lowercased) equals `exe` — the launcher→game handoff signature. A
/// launcher that shares its exe with the game (dcs.exe: `bin\DCS.exe` shows a
/// CEF launcher whose VIDEO background presents at ≥20 fps, defeating the
/// render filter, then spawns the game and exits) is caught here at finalize:
/// its just-spawned same-exe child is still alive, so the launcher session is
/// discarded regardless of its FPS profile. A real game quitting has no
/// same-exe child, so this never drops genuine sessions — unlike matching on
/// exe name alone, which would eat a quick quit-and-relaunch.
fn has_live_same_exe_child(pid: u32, exe: &str) -> bool {
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return false;
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut found = false;
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                if entry.th32ParentProcessID == pid {
                    let len = entry
                        .szExeFile
                        .iter()
                        .position(|&c| c == 0)
                        .unwrap_or(entry.szExeFile.len());
                    let name = String::from_utf16_lossy(&entry.szExeFile[..len]).to_lowercase();
                    if name == exe {
                        found = true;
                        break;
                    }
                }
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = windows::Win32::Foundation::CloseHandle(snapshot);
        found
    }
}

const CHART_POINTS: usize = 1200;

fn finite_values(samples: &[PerfSampleOut], f: impl Fn(&PerfSampleOut) -> Option<f64>) -> Vec<f64> {
    samples
        .iter()
        .filter_map(f)
        .filter(|v| v.is_finite())
        .collect()
}
fn average(xs: &[f64]) -> Option<f64> {
    if xs.is_empty() {
        None
    } else {
        Some(xs.iter().sum::<f64>() / xs.len() as f64)
    }
}
fn extrema(mut xs: Vec<f64>) -> (Option<f64>, Option<f64>) {
    if xs.is_empty() {
        return (None, None);
    }
    let mut min = xs[0];
    let mut max = xs[0];
    for x in xs.drain(1..) {
        if x < min {
            min = x;
        }
        if x > max {
            max = x;
        }
    }
    (Some(min), Some(max))
}
fn percentile(mut xs: Vec<f64>, p: f64) -> Option<f64> {
    if xs.is_empty() {
        return None;
    }
    xs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let idx = ((p / 100.0) * (xs.len() - 1) as f64).round() as usize;
    Some(xs[idx.min(xs.len() - 1)])
}
fn sum_power(s: &PerfSampleOut) -> Option<f64> {
    match (
        s.cpu_power.filter(|v| v.is_finite()),
        s.gpu_power.filter(|v| v.is_finite()),
    ) {
        (None, None) => None,
        (a, b) => Some(a.unwrap_or(0.0) + b.unwrap_or(0.0)),
    }
}
fn energy_wh(samples: &[PerfSampleOut]) -> Option<f64> {
    if samples.len() < 2 {
        return None;
    }
    let mut wh = 0.0;
    let mut any = false;
    for pair in samples.windows(2) {
        let dt = pair[1].t - pair[0].t;
        if !dt.is_finite() || dt <= 0.0 {
            continue;
        }
        let a = sum_power(&pair[0]);
        let b = sum_power(&pair[1]);
        let Some(avg_w) = (match (a, b) {
            (None, None) => None,
            (Some(x), Some(y)) => Some((x + y) / 2.0),
            (Some(x), None) | (None, Some(x)) => Some(x),
        }) else {
            continue;
        };
        wh += avg_w * (dt / 3_600_000.0);
        any = true;
    }
    any.then_some(wh)
}
fn summarize_rust(samples: &[PerfSampleOut]) -> PerfSummaryOut {
    macro_rules! avg {
        ($f:ident) => {
            average(&finite_values(samples, |s| s.$f))
        };
    }
    macro_rules! ext {
        ($f:ident) => {{
            let (min, max) = extrema(finite_values(samples, |s| s.$f));
            (min, max)
        }};
    }
    let (min_fps, max_fps) = ext!(fps);
    let e = energy_wh(samples);
    PerfSummaryOut {
        avg_fps: avg!(fps),
        min_fps,
        max_fps,
        low1: percentile(finite_values(samples, |s| s.fps), 1.0),
        low01: percentile(finite_values(samples, |s| s.fps), 0.1),
        avg_frametime_ms: avg!(frametime_ms),
        avg_cpu_load: avg!(cpu_load),
        avg_cpu_temp: avg!(cpu_temp),
        max_cpu_temp: ext!(cpu_temp).1,
        avg_cpu_power: avg!(cpu_power),
        max_cpu_power: ext!(cpu_power).1,
        avg_cpu_clock: avg!(cpu_clock),
        avg_gpu_load: avg!(gpu_load),
        avg_gpu_temp: avg!(gpu_temp),
        max_gpu_temp: ext!(gpu_temp).1,
        avg_gpu_power: avg!(gpu_power),
        max_gpu_power: ext!(gpu_power).1,
        avg_gpu_clock: avg!(gpu_clock),
        avg_vram_load: avg!(vram_load),
        max_vram_load: ext!(vram_load).1,
        avg_mem_load: avg!(mem_load),
        energy_wh: e,
        co2_kg: e.map(|v| v / 1000.0 * 0.55),
    }
}
fn quantize(v: Option<f64>) -> Option<f64> {
    v.map(|x| (x * 100.0).round() / 100.0)
}
fn quantize_sample(mut s: PerfSampleOut) -> PerfSampleOut {
    s.t = s.t.round();
    macro_rules! q { ($($f:ident),+) => { $(s.$f = quantize(s.$f);)+ }; }
    q!(
        fps,
        frametime_ms,
        cpu_load,
        cpu_temp,
        cpu_power,
        cpu_clock,
        gpu_load,
        gpu_temp,
        gpu_power,
        gpu_clock,
        vram_load,
        mem_load,
        gpu_mem_clock,
        gpu_mem_ctrl_load,
        gpu_fan,
        disk_load,
        disk_read,
        disk_write,
        net_down,
        net_up
    );
    s
}
fn downsample_rust(samples: Vec<PerfSampleOut>) -> Vec<PerfSampleOut> {
    if samples.len() <= CHART_POINTS {
        return samples.into_iter().map(quantize_sample).collect();
    }
    let step = samples.len() as f64 / CHART_POINTS as f64;
    let mut out: Vec<_> = (0..CHART_POINTS)
        .map(|i| samples[(i as f64 * step).floor() as usize].clone())
        .collect();
    out[CHART_POINTS - 1] = samples[samples.len() - 1].clone();
    out.into_iter().map(quantize_sample).collect()
}

/// Finalize a session: if it captured ≥1 sample AND passes [`should_keep`]
/// AND is not a launcher that just handed off to a same-exe child (see
/// [`has_live_same_exe_child`]), emit `perf://session` for the frontend to
/// persist + display. Empty and junk sessions are discarded. Best-effort: an
/// emit failure is logged, never fatal. `pid` is the session's process id
/// (its key in the recorder's map).
fn finalize(app: &AppHandle, pid: u32, session: ActiveSession) {
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
    if has_live_same_exe_child(pid, &session.exe) {
        tracing::info!(
            "perf recorder: discarding launcher session for {} (pid {pid} handed off to a same-exe child)",
            session.exe
        );
        return;
    }
    let ended_at = now_epoch_ms();
    let summary = summarize_rust(&session.samples);
    let payload = SessionPayload {
        meta: SessionMeta {
            exe: session.exe,
            path: session.path,
            started_at: session.started_at,
            ended_at,
            duration_sec: ((ended_at - session.started_at) / 1000.0).round().max(0.0) as u64,
            cpu_name: session.cpu_name,
            gpu_name: session.gpu_name,
        },
        summary,
        samples: downsample_rust(session.samples),
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
        for (pid, cur) in active.drain() {
            finalize(app, pid, cur);
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
            finalize(app, pid, cur);
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

    // Publish the count for readers outside this thread (see ACTIVE_SESSIONS).
    ACTIVE_SESSIONS.store(active.len(), Ordering::Relaxed);
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

#[cfg(test)]
mod parity_tests {
    use super::*;

    fn sample(t: f64, fps: Option<f64>, cpu_power: Option<f64>) -> PerfSampleOut {
        PerfSampleOut {
            t,
            fps,
            cpu_power,
            ..Default::default()
        }
    }

    #[test]
    fn summary_and_downsample_match_ts_fixture() {
        // Fixture mirrors the TypeScript reference: finite-only aggregates,
        // round(p / 100 * (n - 1)) percentile index, trapezoid energy, and
        // first/last-preserving evenly spaced downsampling.
        let input = vec![
            sample(0.0, Some(10.0), Some(100.0)),
            sample(1000.0, Some(20.0), Some(200.0)),
            sample(2000.0, None, None),
            sample(3000.0, Some(30.0), Some(300.0)),
        ];
        let out = summarize_rust(&input);
        assert_eq!(out.avg_fps, Some(20.0));
        assert_eq!(out.min_fps, Some(10.0));
        assert_eq!(out.max_fps, Some(30.0));
        assert_eq!(out.low1, Some(10.0));
        assert_eq!(out.low01, Some(10.0));
        assert!((out.energy_wh.unwrap() - 0.18055555555555555).abs() < 1e-15);
        assert!((out.co2_kg.unwrap() - 0.00009930555555555556).abs() < 1e-16);
        assert_eq!(downsample_rust(input.clone()).len(), input.len());
        let q = quantize_sample(sample(1.234, Some(12.3456), None));
        assert_eq!(q.t, 1.0);
        assert_eq!(q.fps, Some(12.35));
    }
}
