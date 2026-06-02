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
use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, HWND};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

/// Microsoft-Windows-DxgKrnl provider GUID (PresentMon's primary present source).
const DXGKRNL_GUID: &str = "802ec45a-1e99-4b83-9920-87c98277ba9d";

/// DxgKrnl `Present_Info` event id — one per swap-chain Present() call.
const EVENT_ID_PRESENT_INFO: u16 = 0x00b8;

/// How long a present timestamp is retained before pruning (slightly over 1s so
/// the 1s FPS window is always fully populated).
const RETENTION: Duration = Duration::from_millis(1500);

/// FPS counting window.
const FPS_WINDOW: Duration = Duration::from_millis(1000);

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

    let provider = Provider::by_guid(DXGKRNL_GUID)
        .add_callback(|record: &EventRecord, _schema: &SchemaLocator| {
            // Only Present_Info maps 1:1 to a submitted frame; ignore the rest
            // of DxgKrnl's chatter so we don't inflate the rate. The submitting
            // process id comes straight from the event header.
            if record.event_id() == EVENT_ID_PRESENT_INFO {
                record_present(record.process_id());
            }
        })
        .build();

    // `start_and_process` blocks here until the trace stops. Keep the returned
    // handle alive in a static so the session isn't torn down underneath us.
    let trace = UserTrace::new()
        .named("CorePilot-FPS".to_string())
        .enable(provider)
        .start_and_process()?;
    let _ = TRACE.set(trace);
    Ok(())
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

/// Tauri command: best-effort foreground-window FPS (null when unavailable).
#[tauri::command]
pub fn osd_fps() -> Option<f64> {
    foreground_fps()
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
