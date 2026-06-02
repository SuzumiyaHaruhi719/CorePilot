//! PresentMon-style FPS for the foreground game, via real-time ETW.
//!
//! We consume GPU *present* events from the **Microsoft-Windows-DxgKrnl**
//! provider — the same source PresentMon uses — on a single background ETW
//! user-trace. Each present event carries the submitting process id in its
//! `EVENT_HEADER` (exposed by ferrisetw as [`EventRecord::process_id`]), so we
//! bucket present timestamps per-PID and derive FPS for whichever process owns
//! the foreground window.
//!
//! Design constraints:
//! * **Best-effort + graceful degradation.** ETW real-time tracing needs admin;
//!   if `start_and_process` fails (no privilege, session-name clash, API error)
//!   the map simply stays empty and every public call returns `None`. We never
//!   panic.
//! * **One trace, started lazily.** The trace is spun up on its own thread the
//!   first time FPS is requested (guarded by a `OnceLock`) and kept alive for
//!   the process lifetime by leaking the `UserTrace` handle into a static —
//!   dropping it would stop the session.
//!
//! Accuracy note: we count `Present_Info` (DxgKrnl event id 0xB8), which fires
//! once per `IDXGISwapChain::Present` on the *submitting* process — the right
//! signal for the borderless / windowed (DWM-composed) games this overlay
//! targets. We deliberately do not also count the flip/MMIOFlip completion
//! events, since a single frame emits several of those and summing them would
//! inflate the rate. This matches real FPS closely for composed presents; true
//! exclusive-fullscreen flip models may report differently (see module tests /
//! validation notes).

use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use serde::Serialize;
use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, HWND};
use windows::Win32::System::Threading::{
    GetExitCodeProcess, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

/// Microsoft-Windows-DxgKrnl provider GUID (PresentMon's primary present source).
const DXGKRNL_GUID: &str = "802ec45a-1e99-4b83-9920-87c98277ba9d";

/// DxgKrnl `Present_Info` event id — one per swap-chain Present() call.
const EVENT_ID_PRESENT_INFO: u16 = 0x00b8;

/// How long a present timestamp is retained before pruning. Sized to the
/// frame-pacing stats window (10s) so the 1% / 0.1% low percentiles have enough
/// samples; the 1s FPS count just filters a sub-range of this same history.
const RETENTION: Duration = Duration::from_millis(10_000);

/// FPS counting window.
const FPS_WINDOW: Duration = Duration::from_millis(1000);

/// Fixed real-time ETW session name. A user-mode ETW session OUTLIVES the process
/// that created it, so an ungracefully-killed CorePilot leaves its session
/// running. Several stale sessions on the same DxgKrnl provider starve our live
/// one of present events, so FPS / game-detection silently break (observed: with
/// ~10 leftover sessions, foreground games read as `is_game=false`, no FPS). Using
/// ONE fixed name and force-stopping any leftover before starting guarantees
/// exactly one session, so capture is always healthy.
const FPS_SESSION_NAME: &str = "CorePilot-FPS";

/// PID → recent present timestamps (newest pushed at the back).
static PRESENTS: Lazy<Mutex<HashMap<u32, VecDeque<Instant>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Ensures the ETW trace is started at most once.
static TRACE_STARTED: OnceLock<()> = OnceLock::new();

/// Keeps the running [`UserTrace`] alive for the process lifetime (dropping it
/// stops the session). Only set when the trace started successfully.
static TRACE: OnceLock<ferrisetw::trace::UserTrace> = OnceLock::new();

/// Record a present for `pid`, pruning that bucket's stale entries.
fn record_present(pid: u32) {
    let now = Instant::now();
    if let Ok(mut map) = PRESENTS.lock() {
        let dq = map.entry(pid).or_default();
        dq.push_back(now);
        while dq.front().is_some_and(|t| now.duration_since(*t) > RETENTION) {
            dq.pop_front();
        }
    }
}

/// Start the single real-time ETW user-trace (idempotent). Any failure is
/// swallowed: the map stays empty and FPS reads return `None`.
fn ensure_trace_started() {
    TRACE_STARTED.get_or_init(|| {
        // Build the trace off-thread; `start_and_process` blocks while the
        // session runs, so the processing loop lives on a dedicated thread.
        thread::Builder::new()
            .name("corepilot-etw-fps".into())
            .spawn(|| {
                if let Err(e) = run_trace() {
                    tracing::warn!("FPS ETW trace unavailable: {e:?}");
                }
            })
            .ok();
    });
}

/// Configure + run the DxgKrnl present trace. Returns on error or when the
/// session ends. The callback runs on this same (processing) thread.
/// (`TraceError` implements neither `Display` nor `std::error::Error`, so we
/// surface it directly rather than boxing.)
fn run_trace() -> Result<(), ferrisetw::trace::TraceError> {
    use ferrisetw::provider::Provider;
    use ferrisetw::schema_locator::SchemaLocator;
    use ferrisetw::trace::UserTrace;
    use ferrisetw::EventRecord;

    // Build a fresh provider (the callback closure is consumed by `build`), so we
    // can rebuild it for the retry below.
    let make_provider = || {
        Provider::by_guid(DXGKRNL_GUID)
            .add_callback(|record: &EventRecord, _schema: &SchemaLocator| {
                // Only Present_Info maps 1:1 to a submitted frame; ignore the rest
                // of DxgKrnl's chatter so we don't inflate the rate. The submitting
                // process id comes straight from the event header.
                if record.event_id() == EVENT_ID_PRESENT_INFO {
                    record_present(record.process_id());
                }
            })
            .build()
    };

    // Clear any session leaked by a previous (ungracefully-exited) CorePilot before
    // starting, so exactly ONE `CorePilot-FPS` session exists on the provider —
    // multiple stale sessions starve ours of present events. `start_and_process`
    // then blocks here until the trace stops; the returned handle is kept alive in
    // a static so the session isn't torn down underneath us.
    stop_stale_session();
    let trace = match UserTrace::new()
        .named(FPS_SESSION_NAME.to_string())
        .enable(make_provider())
        .start_and_process()
    {
        Ok(t) => t,
        // A leftover session can linger a moment after `logman stop`; if the start
        // still races an existing one, force-stop and retry once.
        Err(_) => {
            stop_stale_session();
            UserTrace::new()
                .named(FPS_SESSION_NAME.to_string())
                .enable(make_provider())
                .start_and_process()?
        }
    };
    let _ = TRACE.set(trace);
    Ok(())
}

/// Force-stop any leftover real-time ETW session named [`FPS_SESSION_NAME`].
/// Best-effort and silent: a user-mode ETW session survives the process that
/// created it, so this clears one left behind by an ungraceful exit. Uses the
/// built-in `logman` so we need no extra ETW-control FFI; runs with no console.
fn stop_stale_session() {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let _ = std::process::Command::new("logman")
        .args(["stop", FPS_SESSION_NAME, "-ets"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

/// Live FPS for `pid`: number of presents in the last second. `None` when the
/// PID is unknown or has had zero recent presents.
pub fn fps_for(pid: u32) -> Option<f64> {
    ensure_trace_started();
    let now = Instant::now();
    let mut map = PRESENTS.lock().ok()?;
    let dq = map.get_mut(&pid)?;
    // Prune stale entries on read so idle/dead PIDs decay to None.
    while dq.front().is_some_and(|t| now.duration_since(*t) > RETENTION) {
        dq.pop_front();
    }
    let count = dq
        .iter()
        .filter(|t| now.duration_since(**t) <= FPS_WINDOW)
        .count();
    if count == 0 {
        None
    } else {
        Some(count as f64)
    }
}

/// PID of the process owning the current foreground window, or `None` when there
/// is no foreground window (e.g. the desktop is focused) or it can't be resolved.
fn foreground_pid() -> Option<u32> {
    let hwnd: HWND = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() {
        return None;
    }
    let mut pid: u32 = 0;
    let tid = unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    if tid == 0 || pid == 0 {
        None
    } else {
        Some(pid)
    }
}

/// FPS for the process owning the current foreground window, or `None`.
pub fn foreground_fps() -> Option<f64> {
    fps_for(foreground_pid()?)
}

/// PID of the current foreground window's process (0 when there is none). Public
/// wrapper over the internal `foreground_pid` for the overlay-injector status
/// command, which targets the foreground game by default.
pub fn foreground_pid_public() -> u32 {
    foreground_pid().unwrap_or(0)
}

/// Tauri command: best-effort foreground-window FPS (null when unavailable).
#[tauri::command]
pub fn osd_fps() -> Option<f64> {
    foreground_fps()
}

/// Frame-pacing statistics for the foreground game, derived from the same ETW
/// present stream as [`osd_fps`]. Every field is `None` when unavailable so the
/// overlay shows "—" rather than fabricating a value.
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FpsStats {
    /// Presents in the last second.
    pub fps: Option<f64>,
    /// Mean frame time (ms) over the last second.
    pub frametime_ms: Option<f64>,
    /// 1% low FPS: reciprocal of the 99th-percentile frame time.
    pub low1: Option<f64>,
    /// 0.1% low FPS: reciprocal of the 99.9th-percentile frame time.
    pub low01: Option<f64>,
}

/// Minimum frame samples before a percentile-low is meaningful. Below these the
/// value would be dominated by one or two frames, so we report `None` and let it
/// appear once enough history has accumulated.
const LOW1_MIN_FRAMES: usize = 60;
const LOW01_MIN_FRAMES: usize = 200;

/// Compute frame-pacing stats for `pid` from its retained present timestamps.
fn stats_for(pid: u32) -> FpsStats {
    ensure_trace_started();
    let now = Instant::now();
    let map = match PRESENTS.lock() {
        Ok(m) => m,
        Err(_) => return FpsStats::default(),
    };
    let Some(dq) = map.get(&pid) else {
        return FpsStats::default();
    };

    // FPS: presents within the last second.
    let fps_count = dq
        .iter()
        .filter(|t| now.duration_since(**t) <= FPS_WINDOW)
        .count();
    let fps = (fps_count > 0).then_some(fps_count as f64);

    // Need at least two presents to form a frame-time interval.
    let stamps: Vec<Instant> = dq.iter().copied().collect();
    if stamps.len() < 2 {
        return FpsStats {
            fps,
            frametime_ms: fps.map(|f| 1000.0 / f),
            ..Default::default()
        };
    }
    let frametime = |a: &Instant, b: &Instant| b.duration_since(*a).as_secs_f64() * 1000.0;

    // Current frame time: mean interval over the last second (fall back to 1/fps).
    let recent: Vec<f64> = stamps
        .windows(2)
        .filter(|w| now.duration_since(w[1]) <= FPS_WINDOW)
        .map(|w| frametime(&w[0], &w[1]))
        .collect();
    let frametime_ms = if recent.is_empty() {
        fps.map(|f| 1000.0 / f)
    } else {
        Some(recent.iter().sum::<f64>() / recent.len() as f64)
    };

    // Percentile lows over all retained frame times (sorted ascending: the high
    // percentile is the slow/stutter frame, whose reciprocal is the low FPS).
    let mut all: Vec<f64> = stamps.windows(2).map(|w| frametime(&w[0], &w[1])).collect();
    all.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let percentile_fps = |p: f64, min_frames: usize| -> Option<f64> {
        if all.len() < min_frames {
            return None;
        }
        let idx = ((p / 100.0) * (all.len() as f64 - 1.0)).round() as usize;
        all.get(idx).filter(|ft| **ft > 0.0).map(|ft| 1000.0 / ft)
    };

    FpsStats {
        fps,
        frametime_ms,
        low1: percentile_fps(99.0, LOW1_MIN_FRAMES),
        low01: percentile_fps(99.9, LOW01_MIN_FRAMES),
    }
}

/// Tauri command: frame-pacing stats (FPS, frame time, 1% / 0.1% low) for the
/// foreground window. All-`None` when no FPS data is available.
#[tauri::command]
pub fn osd_fps_stats() -> FpsStats {
    match foreground_pid() {
        Some(pid) => stats_for(pid),
        None => FpsStats::default(),
    }
}

/// Frame-pacing stats for a *specific* `pid` (not necessarily the foreground).
/// Used by the injection-overlay sampler, which targets the injected game's PID
/// directly rather than whatever currently holds the foreground. All-`None` when
/// that PID has no recent present events.
pub fn stats_for_pid(pid: u32) -> FpsStats {
    if pid == 0 {
        return FpsStats::default();
    }
    stats_for(pid)
}

/// Resolve a PID's executable file name (e.g. `"cyberpunk2077.exe"`), lowercased.
/// `None` when the process can't be opened or queried. Never panics.
fn process_image_name(pid: u32) -> Option<String> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false.into(), pid).ok()?;
        // QueryFullProcessImageNameW writes the full image path; `len` is in/out
        // (capacity in, written length out).
        let mut buf = [0u16; 260]; // MAX_PATH
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut len,
        )
        .is_ok();
        let _ = CloseHandle(handle);
        if !ok || len == 0 {
            return None;
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        // Take just the file name (after the last path separator).
        let name = path
            .rsplit(['\\', '/'])
            .next()
            .unwrap_or(&path)
            .to_lowercase();
        if name.is_empty() {
            None
        } else {
            Some(name)
        }
    }
}

/// Tauri command: the foreground window's process EXE name, lowercased (e.g.
/// `"cyberpunk2077.exe"`). `None` when there's no foreground app or it can't be
/// resolved (graceful degradation — the OSD simply treats this as "no target").
#[tauri::command]
pub fn foreground_process() -> Option<String> {
    process_image_name(foreground_pid()?)
}

/// Foreground app snapshot for OSD targeting + the perf-session recorder.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForegroundInfo {
    /// Lowercased exe name (e.g. "subnautica2-win64-shipping.exe"); null when unresolved.
    exe: Option<String>,
    /// Foreground PID (0 when there is no foreground window).
    pid: u32,
    /// True when the foreground app is rendering frames (has recent ETW present
    /// events) — our driverless "is a game" signal (same source as FPS).
    is_game: bool,
}

/// One call returning everything the OSD/recorder needs about the foreground app
/// (saves three round-trips per poll tick).
#[tauri::command]
pub fn foreground_info() -> ForegroundInfo {
    match foreground_pid() {
        Some(pid) => ForegroundInfo {
            exe: process_image_name(pid),
            pid,
            is_game: fps_for(pid).is_some(),
        },
        None => ForegroundInfo { exe: None, pid: 0, is_game: false },
    }
}

/// Whether a process is still running. Used by the perf recorder to detect when
/// a game has exited (→ finalize its session report). Best-effort; never panics.
#[tauri::command]
pub fn pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false.into(), pid) else {
            return false;
        };
        let mut code: u32 = 0;
        let ok = GetExitCodeProcess(handle, &mut code).is_ok();
        let _ = CloseHandle(handle);
        // STILL_ACTIVE (259) means the process has not exited.
        ok && code == 259
    }
}
