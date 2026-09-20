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
//!   if the trace fails to start (no privilege, session-name clash, API error)
//!   the map simply stays empty and every public call returns `None`. We never
//!   panic.
//! * **One trace, started lazily.** The trace is spun up on its own *named*
//!   thread the first time FPS is requested (guarded by a `OnceLock`) and kept
//!   alive for the process lifetime by parking the `UserTrace` handle in a
//!   static — dropping it would stop the session.
//!
//! **Time base (do not change without re-reading this).** Frame pacing is derived
//! from each event's OWN header timestamp, never from when our callback ran. ETW
//! delivers real-time events in *buffers*, so the callback fires on buffer flush:
//! dozens of presents arrive microseconds apart, then one long gap. Deriving frame
//! times from callback arrival therefore fabricated µs-long "frames", and
//! `1000 / 0.005 ms` made the 1% low read in the hundreds of thousands. (This got
//! much worse once the kernel-side event-id filter landed: the per-event decode
//! work it removed had been accidentally spreading the callbacks apart.)
//!
//! Units: ferrisetw opens the session with `ProcessTraceMode =
//! PROCESS_TRACE_MODE_REAL_TIME | PROCESS_TRACE_MODE_EVENT_RECORD` and *without*
//! `PROCESS_TRACE_MODE_RAW_TIMESTAMP` (`native/etw_types.rs`), so the QPC
//! `Wnode.ClientContext = 1` it also sets does NOT apply to what we read: per MSDN
//! the `EVENT_HEADER.TimeStamp` that [`EventRecord::raw_timestamp`] returns is
//! converted to **system time**, i.e. a FILETIME quad of 100 ns ticks. (ferrisetw
//! agrees with itself: its own `timestamp()` accessor feeds the same field to
//! `FileTime::from_quad`.) Hence [`TICKS_PER_MS`] = 10_000 and wall-clock "now"
//! comes from `GetSystemTimePreciseAsFileTime`, the same domain.
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
use windows::Win32::Foundation::{CloseHandle, HWND, RECT};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::System::Threading::{
    GetExitCodeProcess, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowRect, GetWindowThreadProcessId,
};

/// Microsoft-Windows-DxgKrnl provider GUID (PresentMon's primary present source).
const DXGKRNL_GUID: &str = "802ec45a-1e99-4b83-9920-87c98277ba9d";

/// DxgKrnl `Present_Info` event id — one per swap-chain Present() call.
const EVENT_ID_PRESENT_INFO: u16 = 0x00b8;

/// FILETIME ticks per millisecond (a tick is 100 ns). See the module-level
/// "Time base" note for why the event timestamps are in this unit.
const TICKS_PER_MS: f64 = 10_000.0;

/// FILETIME ticks per second.
const TICKS_PER_SEC: i64 = 10_000_000;

/// How long a present timestamp is retained before pruning (10 s, in FILETIME
/// ticks). Sized to the frame-pacing stats window so the 1% / 0.1% low
/// percentiles have enough samples; the 1 s FPS count just filters a sub-range of
/// this same history.
const RETENTION_TICKS: i64 = 10 * TICKS_PER_SEC;

/// FPS counting window (1 s, in FILETIME ticks).
const FPS_WINDOW_TICKS: i64 = TICKS_PER_SEC;

/// Fixed real-time ETW session name. A user-mode ETW session OUTLIVES the process
/// that created it, so an ungracefully-killed CorePilot leaves its session
/// running. Several stale sessions on the same DxgKrnl provider starve our live
/// one of present events, so FPS / game-detection silently break (observed: with
/// ~10 leftover sessions, foreground games read as `is_game=false`, no FPS). Using
/// ONE fixed name and force-stopping any leftover before starting guarantees
/// exactly one session, so capture is always healthy.
pub(crate) const FPS_SESSION_NAME: &str = "CorePilot-FPS";

/// How long a bucket may go without a single delivered present before we call
/// the PID "not presenting" and drop it.
///
/// This is measured on a MONOTONIC arrival clock, not on the event stamps, and
/// it is the only liveness signal in this module (see [`Bucket::last_arrival`]).
/// Sized off ETW's delivery cadence, not off any frame rate: ferrisetw's default
/// flush timer is 1 s and the kernel clamps it there, so a perfectly healthy
/// 165 fps game still hands us its frames in ~1 s batches. 2.5 s leaves room for
/// a late flush without letting a stopped game report a stale rate for long.
const PRESENT_STALE_AFTER: Duration = Duration::from_millis(2500);

/// One PID's present history.
struct Bucket {
    /// Present **event** times as FILETIME ticks, sorted ascending (oldest at the
    /// front). These are the times the frames were presented, NOT the times our
    /// ETW callback ran — see the module "Time base" note.
    stamps: VecDeque<i64>,
    /// When a present for this PID last *arrived* in our callback.
    ///
    /// Deliberately an [`Instant`], i.e. a different clock from `stamps`: it is
    /// immune to the wall-clock steps (NTP, resume from sleep) that move ETW's
    /// conversion anchor out from under the stamps, and it is the thing that
    /// actually answers "is this PID still presenting". Nothing may compare it
    /// against a stamp.
    last_arrival: Instant,
}

impl Default for Bucket {
    fn default() -> Self {
        Self {
            stamps: VecDeque::new(),
            last_arrival: Instant::now(),
        }
    }
}

/// PID → that PID's present history.
static PRESENTS: Lazy<Mutex<HashMap<u32, Bucket>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// Take the lock, drop every PID that has stopped presenting, and hand the
/// caller what is left.
///
/// Sweeping on READ (rather than only on insert) is what keeps [`etw_alive`]
/// honest: `record_present` can only ever remove a bucket it just inserted into,
/// so without this the map is a "has ever presented" latch. `perf_recorder`'s
/// junk filter trusts `etw_alive` to mean "ETW is healthy", and a latched-true
/// reading makes it discard real game sessions at finalize.
///
/// The map holds one entry per presenting process (tens, not thousands), so the
/// sweep is far cheaper than the lock acquisition it piggybacks on.
fn presents_live() -> Option<std::sync::MutexGuard<'static, HashMap<u32, Bucket>>> {
    let mut map = PRESENTS.lock().ok()?;
    map.retain(|_, b| b.last_arrival.elapsed() < PRESENT_STALE_AFTER);
    Some(map)
}

/// Ensures the ETW trace is started at most once.
static TRACE_STARTED: OnceLock<()> = OnceLock::new();

/// Keeps the running [`UserTrace`] alive for the process lifetime (dropping it
/// stops the session). Only set when the trace started successfully.
static TRACE: OnceLock<ferrisetw::trace::UserTrace> = OnceLock::new();

// NOTE: there is deliberately no `now_filetime()` here any more.
//
// Reading the wall clock and comparing it against ETW event stamps looks
// obviously right and is the bug this module was built around twice. ETW
// converts stamps using the anchor it captured at session start and delivers
// them in ~1 s flush batches, so "now" is always ahead of the newest stamp by an
// unknown amount, and a clock step desyncs the two domains outright. Every
// window in this file is anchored on the newest stamp; liveness uses a
// monotonic `Instant` (see `Bucket::last_arrival`). Keep it that way.

/// Record a present for `pid` at its own event time `ts` (FILETIME ticks from the
/// ETW event header), pruning that bucket's stale entries.
fn record_present(pid: u32, ts: i64) {
    if let Ok(mut map) = PRESENTS.lock() {
        let bucket = map.entry(pid).or_default();
        bucket.last_arrival = Instant::now();
        let dq = &mut bucket.stamps;

        // RESYNC ON A CLOCK STEP. ETW converts event stamps using the anchor it
        // captured when the session started, while the system clock is free to
        // jump (NTP correction, resume from sleep, a manual change). After a
        // step the stamps we already hold and the ones now arriving are in
        // different domains: mixing them makes every new event look older than
        // the retained tail, so the prune below drops it on arrival and the
        // bucket freezes forever. Throw the stale domain away instead — a
        // fraction of a second of history is worth far less than a wedged
        // reading, and this is a once-in-a-blue-moon branch.
        if dq.back().is_some_and(|&last| (last - ts).abs() > RETENTION_TICKS) {
            dq.clear();
        }

        // KEEP THE DEQUE SORTED ON INSERT (rather than sorting the derived
        // interval list later). ETW buffers are per-CPU, so presents submitted
        // from different cores can be dispatched slightly out of order. Sorting
        // only the intervals would not be enough: an out-of-order stamp yields a
        // negative delta (which we drop) AND a compensating oversized one — a
        // phantom stutter that lands straight in the 99th percentile, i.e. the
        // very value we're fixing. Sorting the stamps instead makes every derived
        // interval real, and it is also what lets front-pruning and the 1 s
        // window stay O(1)-correct. Cost on this hot callback path is a single
        // compare in the overwhelmingly common in-order case; the backward scan
        // only runs for the rare inversion, which is local (µs apart).
        if dq.back().is_some_and(|&last| last > ts) {
            let pos = dq.iter().rposition(|&t| t <= ts).map_or(0, |i| i + 1);
            dq.insert(pos, ts);
        } else {
            dq.push_back(ts);
        }

        // Prune against the NEWEST retained event time, not a clock read: this
        // runs once per present event and must stay allocation- and syscall-free.
        // The read paths prune against wall-clock `now_filetime()`, which is what
        // decays a PID that has stopped presenting altogether.
        let cutoff = dq.back().copied().unwrap_or(ts) - RETENTION_TICKS;
        while dq.front().is_some_and(|&t| t < cutoff) {
            dq.pop_front();
        }
        // Dead/idle PIDs are reclaimed by `presents_live`'s sweep on the read
        // path, not here: we just inserted `ts`, so this bucket is non-empty by
        // construction and any "remove if empty" check here is unreachable.
    }
}

/// Start the single real-time ETW user-trace (idempotent). Any failure is
/// swallowed: the map stays empty and FPS reads return `None`.
fn ensure_trace_started() {
    TRACE_STARTED.get_or_init(|| {
        // `ProcessTrace` blocks for the whole life of the session, so it gets a
        // dedicated thread — a NAMED one: ferrisetw's `start_and_process` would
        // spawn its own anonymous `std::thread`, and an unnamed thread burning
        // CPU is invisible in Process Explorer / WPA (attributing the ETW
        // consumer's 231 s took a live debugging session).
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
    use ferrisetw::trace::{TraceTrait, UserTrace};
    use ferrisetw::EventRecord;

    // Build a fresh provider (the callback closure is consumed by `build`), so we
    // can rebuild it for the retry below.
    let make_provider = || {
        Provider::by_guid(DXGKRNL_GUID)
            // Kernel-side event-id filter (EVENT_FILTER_TYPE_EVENT_ID, Win 8.1+).
            // Without it ETW delivers EVERY DxgKrnl event (DMA packets, vsync,
            // flips) to user mode just for the callback below to drop all but
            // Present_Info. Measured on an IDLE desktop by the ignored test at the
            // bottom of this file: 3 s unfiltered = 612 Present_Info + 323_346
            // discarded events (~108k/s, a 528:1 waste ratio); 3 s filtered = 425
            // Present_Info + 0 others. That decode cost is what made the ETW
            // processing thread accumulate 231 s of CPU (~0.5% of a core) — plus
            // the kernel-side write cost paid inside the game and DWM.
            //
            // Why this is safe (verified against ferrisetw 1.2.0 + the live
            // DxgKrnl manifest, because a filter that is silently too aggressive
            // would zero FPS and thereby kill game detection, the OSD and the
            // perf recorder):
            // * `ByEventIds` is plumbed through: `to_event_filter_descriptor()` →
            //   `EVENT_FILTER_EVENT_ID { FilterIn: 1, .. }` with
            //   `Type = EVENT_FILTER_TYPE_EVENT_ID` → `ENABLE_TRACE_PARAMETERS
            //   .EnableFilterDesc` → `EnableTraceEx2`. It is NOT a client-side
            //   filter (see ferrisetw `native/evntrace.rs::enable_provider`).
            // * The filter set is exactly the callback's predicate, so the set of
            //   recorded presents is identical with and without it.
            // * `wevtutil gp Microsoft-Windows-DxgKrnl /ge` on Win11 26100: event
            //   184 is task `Present` (107), opcode 0 — i.e. `Present_Info`, the
            //   only event of that task — at level 0 (LogAlways), so the session
            //   level never excludes it.
            // * Degradation is safe in both directions: a filter that fails to
            //   build is silently dropped by ferrisetw (→ unfiltered, i.e. the old
            //   behaviour), and a filter the kernel rejects fails `EnableTraceEx2`
            //   → `start()` errors → we log loudly below. Neither path can
            //   silently deliver zero presents.
            .add_filter(ferrisetw::provider::EventFilter::ByEventIds(vec![
                EVENT_ID_PRESENT_INFO,
            ]))
            .add_callback(|record: &EventRecord, _schema: &SchemaLocator| {
                // Only Present_Info maps 1:1 to a submitted frame; ignore the rest
                // of DxgKrnl's chatter so we don't inflate the rate. The submitting
                // process id comes straight from the event header — and so does the
                // timestamp: this callback runs on BUFFER FLUSH, not on present, so
                // `Instant::now()` here would be the arrival time of a burst, not a
                // frame boundary (see the module "Time base" note).
                if record.event_id() == EVENT_ID_PRESENT_INFO {
                    record_present(record.process_id(), record.raw_timestamp());
                }
            })
            .build()
    };

    // Clear any session leaked by a previous (ungracefully-exited) CorePilot before
    // starting, so exactly ONE `CorePilot-FPS` session exists on the provider —
    // multiple stale sessions starve ours of present events.
    stop_stale_session();
    // `start()` (not `start_and_process()`) so the blocking `ProcessTrace` loop
    // runs on THIS thread, which has a name; `start_and_process` would hand it to
    // an anonymous thread of ferrisetw's own making.
    let (trace, trace_handle) = match UserTrace::new()
        .named(FPS_SESSION_NAME.to_string())
        .enable(make_provider())
        .start()
    {
        Ok(t) => t,
        // A leftover session can linger a moment after the stop request; if the
        // start still races an existing one, force-stop and retry once.
        Err(_) => {
            stop_stale_session();
            UserTrace::new()
                .named(FPS_SESSION_NAME.to_string())
                .enable(make_provider())
                .start()?
        }
    };
    // Park the handle in a static: dropping a `UserTrace` stops its session, and
    // `ProcessTrace` below would then return immediately. (`run_trace` is gated by
    // `TRACE_STARTED`, so this `set` is the only one and never fails.)
    let _ = TRACE.set(trace);
    // Blocks until the session stops — normally only at shutdown, when the
    // teardown stops `FPS_SESSION_NAME`. That return is not a failure, so it is
    // logged at debug: the `warn!` in `ensure_trace_started` must stay reserved
    // for "the trace never started", which is the actionable case.
    if let Err(e) = UserTrace::process_from_handle(trace_handle) {
        tracing::debug!("FPS ETW processing loop ended: {e:?}");
    }
    Ok(())
}

/// `ERROR_WMI_INSTANCE_NOT_FOUND` — "no session by that name", i.e. the normal
/// result on a clean start. `ControlTraceW`'s status reaches us through
/// `windows::core::Error`, which may carry the bare Win32 code or its
/// `HRESULT_FROM_WIN32` form depending on the call path, so accept both.
const ERR_WMI_INSTANCE_NOT_FOUND: i32 = 4201;
const HRESULT_WMI_INSTANCE_NOT_FOUND: i32 = 0x8007_1069_u32 as i32;

/// True when a stop request failed only because there was nothing to stop.
/// Gates the `logman` fallback: without this check the clean-start path (no
/// stale session — the overwhelmingly common case) would spawn a child process
/// on every launch, which is exactly the ~200 ms of startup cost we're removing.
fn is_session_not_found(err: &ferrisetw::trace::TraceError) -> bool {
    use ferrisetw::native::EvntraceNativeError;
    use ferrisetw::trace::TraceError;
    match err {
        TraceError::EtwNativeError(EvntraceNativeError::IoError(io)) => matches!(
            io.raw_os_error(),
            Some(ERR_WMI_INSTANCE_NOT_FOUND) | Some(HRESULT_WMI_INSTANCE_NOT_FOUND)
        ),
        _ => false,
    }
}

/// Force-stop any leftover real-time ETW session named [`FPS_SESSION_NAME`].
/// Best-effort and silent: a user-mode ETW session survives the process that
/// created it, so this clears one left behind by an ungraceful exit.
///
/// In-process first (`ControlTraceW(EVENT_TRACE_CONTROL_STOP)` by name — the
/// same call `logman stop -ets` makes): spawning `logman` cost ~200 ms of
/// child-process startup on the FPS path and put a console-spawning child on the
/// startup path. `logman` stays as a fallback for the case the direct call fails
/// for a reason other than "no such session".
fn stop_stale_session() {
    match ferrisetw::trace::stop_trace_by_name(FPS_SESSION_NAME) {
        // Stopped a leftover session.
        Ok(()) => {}
        // Nothing to stop — the clean-start path. Do NOT spawn logman for this.
        Err(e) if is_session_not_found(&e) => {}
        Err(e) => {
            tracing::debug!("in-process ETW stop failed ({e:?}); falling back to logman");
            stop_stale_session_via_logman();
        }
    }
}

/// Fallback for [`stop_stale_session`]. Runs with no console window — this can
/// fire during startup, and a flashing console is user-visible.
fn stop_stale_session_via_logman() {
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
    let map = presents_live()?;
    Some(fps_from_ticks(&map.get(&pid)?.stamps)? as f64)
}

/// Presents in the last second of EVENT time. Split out so the window anchoring
/// is unit-testable without an ETW session.
///
/// ANCHORED ON THE NEWEST STAMP, never on a clock read. This is the whole fix
/// for the "sawtooth FPS" field bug: ETW hands us frames in ~1 s flush batches,
/// so the newest stamp we hold is up to a full flush period older than `now`.
/// Counting over `[now - 1 s, now]` therefore swept past the frozen batch and
/// decayed toward zero between flushes — a 165 fps game logged a repeating
/// 148 → 115 → 82 → 49 → 16 ramp and averaged 77. Counting over
/// `[newest - 1 s, newest]` measures the same second of *gameplay* no matter
/// when we happen to ask. Liveness is `presents_live`'s job, on its own clock.
fn fps_from_ticks(stamps: &VecDeque<i64>) -> Option<usize> {
    let newest = *stamps.back()?;
    let from = newest - FPS_WINDOW_TICKS;
    // Sorted ascending, so walking back stops at the window edge: O(frames in
    // the window), not O(the whole 10 s retention).
    let count = stamps.iter().rev().take_while(|&&t| t >= from).count();
    (count > 0).then_some(count)
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
///
/// Cheap by construction (rule 1: this runs on the main thread via
/// [`osd_fps_stats`]) — one clock read, one lock, one copy of a bounded deque,
/// then pure arithmetic with the lock released.
fn stats_for(pid: u32) -> FpsStats {
    ensure_trace_started();
    let stamps: Vec<i64> = {
        let Some(map) = presents_live() else {
            return FpsStats::default();
        };
        let Some(bucket) = map.get(&pid) else {
            return FpsStats::default();
        };
        bucket.stamps.iter().copied().collect()
    };
    stats_from_ticks(&stamps)
}

/// The frame-pacing math, split out of [`stats_for`] so it is unit-testable over
/// a synthetic tick series with no ETW session and no hardware.
///
/// `stamps` are present-event times in FILETIME ticks, ascending (the deque is
/// kept sorted on insert — see [`record_present`]). There is deliberately no
/// `now` parameter: every window here is anchored on the newest stamp, in the
/// stamps' own clock domain (see [`fps_from_ticks`]).
fn stats_from_ticks(stamps: &[i64]) -> FpsStats {
    // FPS: presents in the last second of EVENT time, anchored on the newest
    // stamp rather than on a clock read.
    let window_from = stamps.last().copied().unwrap_or(0) - FPS_WINDOW_TICKS;
    let fps_count = stamps.iter().filter(|&&t| t >= window_from).count();
    let fps = (fps_count > 0).then_some(fps_count as f64);

    // Need at least two presents to form a frame-time interval.
    if stamps.len() < 2 {
        return FpsStats {
            fps,
            frametime_ms: fps.map(|f| 1000.0 / f),
            ..Default::default()
        };
    }
    // Tick delta → ms. `saturating_sub` + `max(0)` guard the arithmetic: a
    // backwards system-clock step or an inversion that slipped past the sorted
    // insert yields 0.0, which the `> 0.0` filter below turns into `None` rather
    // than a division blow-up.
    let frametime = |a: i64, b: i64| b.saturating_sub(a).max(0) as f64 / TICKS_PER_MS;

    // Current frame time: mean interval over the last second (fall back to 1/fps).
    let recent: Vec<f64> = stamps
        .windows(2)
        .filter(|w| w[1] >= window_from)
        .map(|w| frametime(w[0], w[1]))
        .collect();
    let frametime_ms = if recent.is_empty() {
        fps.map(|f| 1000.0 / f)
    } else {
        Some(recent.iter().sum::<f64>() / recent.len() as f64)
    };

    // Percentile lows over all retained frame times (sorted ascending: the high
    // percentile is the slow/stutter frame, whose reciprocal is the low FPS).
    let mut all: Vec<f64> = stamps.windows(2).map(|w| frametime(w[0], w[1])).collect();
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

/// Resolve a PID's full executable path, lowercased (e.g.
/// `r"c:\program files (x86)\steam\steamapps\common\foo\foo.exe"`). `None` when
/// the process can't be opened or queried. Never panics. (`pub(crate)`: also
/// used by `commands::restart_task` to relaunch the same image.)
pub(crate) fn process_image_path(pid: u32) -> Option<String> {
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
        let path = String::from_utf16_lossy(&buf[..len as usize]).to_lowercase();
        if path.is_empty() {
            None
        } else {
            Some(path)
        }
    }
}

/// Resolve a PID's executable file name (e.g. `"cyberpunk2077.exe"`), lowercased.
/// `None` when the process can't be opened or queried. Never panics.
fn process_image_name(pid: u32) -> Option<String> {
    let path = process_image_path(pid)?;
    let name = path.rsplit(['\\', '/']).next().unwrap_or(&path).to_string();
    if name.is_empty() {
        None
    } else {
        Some(name)
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
/// `Default` is the "no foreground window" value (exe None / pid 0 / not a
/// game), matching the explicit `None` arm below.
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForegroundInfo {
    /// Lowercased exe name (e.g. "subnautica2-win64-shipping.exe"); null when unresolved.
    pub exe: Option<String>,
    /// Foreground PID (0 when there is no foreground window).
    pub pid: u32,
    /// True when the foreground app is rendering frames (has recent ETW present
    /// events) — our driverless "is a game" signal (same source as FPS).
    pub is_game: bool,
}

/// One call returning everything the OSD/recorder needs about the foreground app
/// (saves three round-trips per poll tick).
/// Lowercased exe names that present frames (so ETW/DxgKrnl sees them) but are
/// NOT games: the Windows shell, system UI, and CorePilot's own webview. Without
/// this they get misdetected as games — e.g. explorer.exe renders the desktop and
/// taskbar, so at startup (explorer foreground) the recorder/OSD would fire a
/// bogus "检测到游戏 explorer.exe". Real games aren't on this list.
fn is_non_game(exe: &str) -> bool {
    const NOT_GAMES: &[&str] = &[
        "explorer.exe",
        "dwm.exe",
        "searchhost.exe",
        "searchapp.exe",
        "shellexperiencehost.exe",
        "startmenuexperiencehost.exe",
        "applicationframehost.exe",
        "textinputhost.exe",
        "systemsettings.exe",
        "sihost.exe",
        "ctfmon.exe",
        "lockapp.exe",
        "taskmgr.exe",
        "snippingtool.exe",
        "screenclippinghost.exe",
        "widgets.exe",
        "widgetservice.exe",
        "corepilot.exe",
        "msedgewebview2.exe",
    ];
    NOT_GAMES.contains(&exe)
}

/// Minimum present rate (frames/sec) for auto game-detection. Many non-game apps
/// (Snipping Tool, Photos, browsers, Electron apps) submit DxgKrnl present frames
/// too, so "has any presents" misfires. A game renders continuously at a real
/// frame rate; a UI app only redraws occasionally. Requiring a sustained rate
/// this high distinguishes them. Capped/menu games below this can still be added
/// via the OSD whitelist (which force-records regardless of FPS).
pub const GAME_FPS_MIN: f64 = 20.0;

/// True when the foreground window covers its ENTIRE monitor (including the strip
/// the taskbar occupies) — i.e. exclusive- or borderless-fullscreen. A *maximised*
/// window only fills the work area (taskbar still visible), so it fails this and
/// is NOT treated as a game — that's what keeps a maximised Paint / browser /
/// Photos out of auto-detection.
fn foreground_is_fullscreen() -> bool {
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return false;
        }
        let mut wr = RECT::default();
        if GetWindowRect(hwnd, &mut wr).is_err() {
            return false;
        }
        let hmon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut mi = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(hmon, &mut mi).as_bool() {
            return false;
        }
        let m = mi.rcMonitor;
        const TOL: i32 = 2; // a couple px of slop
        wr.left <= m.left + TOL
            && wr.top <= m.top + TOL
            && wr.right >= m.right - TOL
            && wr.bottom >= m.bottom - TOL
    }
}

/// True when the present-event pipeline is producing data RIGHT NOW — i.e. the
/// ETW session started and events are still flowing (needs admin). The perf
/// recorder's sustained-render session filter keys off per-PID FPS; when ETW is
/// down every FPS reads `None` and that filter would discard *real* game
/// sessions, so it bypasses itself while this is false.
///
/// Goes through [`presents_live`] on purpose. Reading `!map.is_empty()` directly
/// made this a "has ever presented" latch that could never go false again, which
/// turns any loss of the present stream into "every session silently discarded
/// at finalize" — the fail-safe above inverted into a data-loss bug.
pub fn etw_alive() -> bool {
    presents_live().is_some_and(|m| !m.is_empty())
}

/// Async + blocking-pool: usually µs of window/process queries, but the
/// `is_game_path` check re-scans the storefront library when its 5-minute cache
/// expires — `reg.exe` child processes + VDF/manifest disk walks, i.e. an
/// occasional seconds-long stall. The OSD overlay polls this at ~1 Hz, so as a
/// sync command that rescan landed on the main thread every ~5 minutes (one of
/// the recurring "未响应" sources).
#[tauri::command]
pub async fn foreground_info() -> ForegroundInfo {
    crate::commands::run_blocking_default("foreground_info", foreground_info_now).await
}

/// Synchronous body of [`foreground_info`], for callers already off the main
/// thread (the perf recorder).
pub fn foreground_info_now() -> ForegroundInfo {
    match foreground_pid() {
        Some(pid) => {
            // One process query; derive both the lowercased name and full path.
            let path = process_image_path(pid);
            let exe = path
                .as_deref()
                .map(|p| p.rsplit(['\\', '/']).next().unwrap_or(p).to_string());
            // Never a game if it's a known shell/system presenter (or unresolved).
            let not_shell = exe.as_deref().map(|e| !is_non_game(e)).unwrap_or(false);

            // (C) Authoritative: the EXE lives under a known installed-game root
            // (Steam / Epic / GOG) — counts as a game even at a menu / 0 FPS.
            let in_library = path
                .as_deref()
                .map(crate::game_library::is_game_path)
                .unwrap_or(false);
            // Heuristic fallback for unrecognised apps: presenting at a sustained,
            // game-like rate AND the window covers its whole monitor (exclusive- or
            // borderless-fullscreen). The fullscreen guard is what stops a
            // merely-redrawing UI app (e.g. Paint while you draw) from being
            // misdetected as a game. NOTE: this deliberately does NOT consult
            // `SHQueryUserNotificationState` — that flag is GLOBAL, so while any
            // D3D-fullscreen game was running it turned every presenting app the
            // user alt-tabbed to (Tacview, a browser playing video, …) into a
            // "game", spawning junk perf sessions and splitting the real one.
            let presenting = fps_for(pid).is_some_and(|fps| fps >= GAME_FPS_MIN);
            let heuristic = presenting && foreground_is_fullscreen();

            let is_game = not_shell && (in_library || heuristic);
            ForegroundInfo { exe, pid, is_game }
        }
        None => ForegroundInfo {
            exe: None,
            pid: 0,
            is_game: false,
        },
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// A plausible FILETIME "now" (100 ns ticks since 1601). Value is arbitrary;
    /// only the deltas matter — but using a realistic magnitude proves the math
    /// survives the large absolute offsets real event stamps carry.
    const BASE_TICKS: i64 = 133_000_000_000_000_000;

    /// Build `frames` present stamps at a steady `fps`, then apply `stalls`
    /// `(index, extra_ms)` edits that push every later stamp back by that much —
    /// i.e. a real hitch, not a reordering.
    fn series(frames: usize, fps: f64, stalls: &[(usize, f64)]) -> Vec<i64> {
        let step = (TICKS_PER_SEC as f64 / fps).round() as i64;
        let mut out = Vec::with_capacity(frames);
        let mut t = BASE_TICKS;
        for i in 0..frames {
            if let Some((_, extra_ms)) = stalls.iter().find(|(idx, _)| *idx == i) {
                t += (extra_ms * TICKS_PER_MS) as i64;
            }
            out.push(t);
            t += step;
        }
        out
    }

    /// Regression guard for the reported "1% low reads 200,000 fps" bug.
    ///
    /// A perfectly steady 165 fps stream must report ~165 everywhere. The broken
    /// version derived frame times from ETW *callback arrival*, where a flushed
    /// buffer delivered ~999 presents microseconds apart plus one flush gap; the
    /// 99th-percentile index then landed on a microsecond "frame" and
    /// `1000 / 0.005` produced 200_000. With event timestamps there is no such
    /// value to pick.
    #[test]
    fn steady_series_gives_sane_lows_not_hundreds_of_thousands() {
        let stamps = series(1000, 165.0, &[]);
        let s = stats_from_ticks(&stamps);

        let low1 = s.low1.expect("1000 frames is well past LOW1_MIN_FRAMES");
        let low01 = s.low01.expect("1000 frames is well past LOW01_MIN_FRAMES");
        let ft = s.frametime_ms.expect("frame time must resolve");
        let fps = s.fps.expect("presents land inside the 1 s window");

        // The symptom, stated as the assertion it should have failed on.
        assert!(
            low1 < 1_000.0,
            "1% low blew up again: {low1} fps (arrival-time frame pacing?)"
        );
        assert!((low1 - 165.0).abs() < 1.0, "1% low {low1} should be ~165");
        assert!(
            (low01 - 165.0).abs() < 1.0,
            "0.1% low {low01} should be ~165"
        );
        assert!(
            (ft - 6.06).abs() < 0.05,
            "frame time {ft} ms should be ~6.06"
        );
        // 165 fps over a 1 s window, inclusive of both edges.
        assert!((164.0..=167.0).contains(&fps), "fps {fps} should be ~165");
    }

    /// The property the bug destroyed: a stall must SHOW UP in the lows.
    ///
    /// Two shapes, because the two percentiles catch different things by
    /// construction — the 99th percentile of N frames is the N/100-th worst, so a
    /// lone slow frame genuinely is not a "1% low", it is a "0.1% low".
    #[test]
    fn stalls_drop_the_lows_well_below_the_mean() {
        // (a) One long stall, 300 intervals: at that length the 99.9th-percentile
        //     index IS the worst frame, so `low01` must collapse onto it.
        let stamps = series(301, 165.0, &[(150, 100.0)]);
        let s = stats_from_ticks(&stamps);
        let low01 = s.low01.expect("300 intervals ≥ LOW01_MIN_FRAMES");
        assert!(
            (low01 - 1000.0 / 106.06).abs() < 1.0,
            "a 100 ms stall must pull the 0.1% low to ~9.4 fps, got {low01}"
        );
        // ...and the 1% low must NOT move for a single frame — one frame in 300 is
        // not one percent. (This is also what makes the shape below the right
        // test for `low1`.)
        let low1 = s.low1.expect("300 intervals ≥ LOW1_MIN_FRAMES");
        assert!(
            (low1 - 165.0).abs() < 1.0,
            "one slow frame in 300 must not be the 1% low, got {low1}"
        );

        // (b) A hitch spanning ~2% of the window — 20 slow frames in 1000, which
        //     is what a real shader-comp / streaming stutter looks like. Now the
        //     1% low must be far below the mean frame rate.
        let stalls: Vec<(usize, f64)> = (0..20).map(|i| (100 + i * 40, 20.0)).collect();
        let stamps = series(1000, 165.0, &stalls);
        let s = stats_from_ticks(&stamps);
        let low1 = s.low1.expect("999 intervals ≥ LOW1_MIN_FRAMES");
        // Mean rate over the whole series, for the "well below" comparison.
        let span_ms = (stamps.last().unwrap() - stamps[0]) as f64 / TICKS_PER_MS;
        let mean_fps = (stamps.len() - 1) as f64 * 1000.0 / span_ms;
        assert!(
            low1 < mean_fps * 0.5,
            "1% low {low1} should be far below the mean {mean_fps} fps"
        );
        // 20 ms stall frames → ~38 fps (the 26.06 ms interval they create).
        assert!(
            (low1 - 1000.0 / 26.06).abs() < 2.0,
            "1% low {low1} should land on the stall frames (~38 fps)"
        );
    }

    /// Degenerate input must report `None`, never `inf`/`NaN` — the "report None
    /// rather than fabricate" contract, and the last line of defence against the
    /// division blow-up this file was fixed for.
    #[test]
    fn degenerate_intervals_report_none_not_infinity() {
        // Every present stamped identically (a clock that never advanced).
        let flat = vec![BASE_TICKS; 500];
        let s = stats_from_ticks(&flat);
        assert_eq!(s.low1, None, "zero-length frames must not yield a rate");
        assert_eq!(s.low01, None);
        assert_eq!(s.frametime_ms, Some(0.0));

        // Out-of-order stamps (a sorted-insert miss) must clamp to 0, not go
        // negative and invert the rate.
        let mut jumbled = series(500, 165.0, &[]);
        jumbled.swap(10, 11);
        let s = stats_from_ticks(&jumbled);
        for v in [s.low1, s.low01, s.frametime_ms].into_iter().flatten() {
            assert!(v.is_finite() && v > 0.0, "non-finite/negative stat {v}");
        }

        // Below the sample gates, the lows stay `None` rather than being
        // extrapolated from a handful of frames.
        let few = series(10, 165.0, &[]);
        let s = stats_from_ticks(&few);
        assert_eq!(s.low1, None);
        assert_eq!(s.low01, None);
        assert!(s.frametime_ms.is_some());
    }

    /// `record_present` must keep each PID's deque sorted, so that a present
    /// dispatched late from another CPU cannot manufacture a phantom stutter
    /// (one negative delta plus one oversized one) in the percentile lows.
    #[test]
    fn out_of_order_events_are_inserted_in_time_order() {
        // A PID no real process can own, so this never collides with live capture.
        let pid = 0xFFFF_FFFEu32;
        let base = BASE_TICKS;
        for ts in [base + 300, base + 100, base + 400, base + 200, base] {
            record_present(pid, ts);
        }
        let map = PRESENTS.lock().unwrap();
        let dq = map.get(&pid).expect("bucket must exist");
        let got: Vec<i64> = dq.stamps.iter().copied().collect();
        drop(map);
        PRESENTS.lock().unwrap().remove(&pid);
        assert_eq!(
            got,
            vec![base, base + 100, base + 200, base + 300, base + 400],
            "deque must be sorted by event time"
        );
    }

    /// Entries older than the retention window are pruned by event time, and the
    /// prune must not be fooled by the arrival order.
    #[test]
    fn retention_prunes_by_event_time() {
        let pid = 0xFFFF_FFFDu32;
        let base = BASE_TICKS;
        record_present(pid, base);
        record_present(pid, base + RETENTION_TICKS / 2);
        // A present 11 s after the first: the first must fall out of the 10 s window.
        record_present(pid, base + RETENTION_TICKS + TICKS_PER_SEC);
        let map = PRESENTS.lock().unwrap();
        let got: Vec<i64> = map
            .get(&pid)
            .expect("bucket must exist")
            .stamps
            .iter()
            .copied()
            .collect();
        drop(map);
        PRESENTS.lock().unwrap().remove(&pid);
        assert_eq!(
            got,
            vec![
                base + RETENTION_TICKS / 2,
                base + RETENTION_TICKS + TICKS_PER_SEC
            ],
            "the 11 s-old stamp should have been pruned"
        );
    }

    /// Regression guard for the "sawtooth FPS" field bug.
    ///
    /// ETW delivers presents in ~1 s flush batches, so the newest stamp we hold
    /// is routinely a whole flush period behind the wall clock. The broken
    /// version counted over `[now - 1 s, now]`, so the same batch reported a
    /// lower number the longer it had been since the last flush: a real 165 fps
    /// capture logged a repeating 148 → 115 → 82 → 49 → 16 ramp and averaged 77.
    ///
    /// Stated as the property that forbids it: the answer must depend ONLY on
    /// the frames, never on how stale the batch is. Any reintroduced clock read
    /// breaks this, because `age` would shift the window.
    #[test]
    fn fps_does_not_decay_while_a_batch_waits_for_the_next_flush() {
        let fresh: VecDeque<i64> = series(200, 165.0, &[]).into();
        let baseline = fps_from_ticks(&fresh).expect("a steady stream must report");

        // 165 fps over a 1 s window (the series is ~1.2 s long, so the window
        // clips it rather than the series clipping the window).
        assert!(
            (164..=166).contains(&baseline),
            "steady 165 fps read as {baseline}"
        );

        // The identical frames, delivered late — shifted a full flush period,
        // then two, then ten seconds into the past.
        for late_by_sec in [1, 2, 10] {
            let shifted: VecDeque<i64> = fresh
                .iter()
                .map(|t| t - late_by_sec * TICKS_PER_SEC)
                .collect();
            let got = fps_from_ticks(&shifted).expect("staleness must not empty the window");
            assert_eq!(
                got, baseline,
                "the same {baseline} frames read as {got} when delivered {late_by_sec}s late \
                 — the count window is anchored on a clock again, not on the newest stamp"
            );
        }
    }

    /// A wall-clock step (NTP, resume from sleep) moves ETW's conversion anchor
    /// out from under the stamps already held. Mixing the domains used to wedge
    /// the bucket forever: every new event looked older than the retained tail,
    /// so the prune dropped it on arrival and FPS read `None` for good.
    #[test]
    fn a_clock_step_resyncs_instead_of_wedging_the_bucket() {
        let pid = 0xFFFF_FFFCu32;
        let base = BASE_TICKS;
        for i in 0..5 {
            record_present(pid, base + i * TICKS_PER_SEC / 10);
        }
        // The clock jumps an hour forward; the next frames arrive in the new
        // domain. The bucket must follow them, not reject them.
        let jumped = base + 3600 * TICKS_PER_SEC;
        for i in 0..5 {
            record_present(pid, jumped + i * TICKS_PER_SEC / 10);
        }
        let map = PRESENTS.lock().unwrap();
        let got: Vec<i64> = map
            .get(&pid)
            .expect("bucket must exist")
            .stamps
            .iter()
            .copied()
            .collect();
        drop(map);
        PRESENTS.lock().unwrap().remove(&pid);
        assert_eq!(
            got.len(),
            5,
            "post-step frames must be kept and the pre-step domain dropped, got {got:?}"
        );
        assert!(
            got.iter().all(|&t| t >= jumped),
            "stale-domain stamps survived the resync: {got:?}"
        );
    }

    /// A failed in-process stop must only fall back to `logman` for a REAL
    /// failure. "No session by that name" is the clean-start case, and treating
    /// it as a failure would re-introduce the ~200 ms child-process spawn on
    /// every launch that moving the stop in-process was meant to remove.
    #[test]
    fn nothing_to_stop_does_not_reach_the_logman_fallback() {
        use ferrisetw::native::EvntraceNativeError;
        use ferrisetw::trace::TraceError;

        let io_err = |code: i32| {
            TraceError::EtwNativeError(EvntraceNativeError::IoError(
                std::io::Error::from_raw_os_error(code),
            ))
        };

        // Both encodings ControlTraceW can surface for ERROR_WMI_INSTANCE_NOT_FOUND.
        assert!(is_session_not_found(&io_err(ERR_WMI_INSTANCE_NOT_FOUND)));
        assert!(is_session_not_found(&io_err(
            HRESULT_WMI_INSTANCE_NOT_FOUND
        )));

        // Everything else is a genuine failure and must reach the fallback:
        // ERROR_ACCESS_DENIED (not elevated), ERROR_INVALID_PARAMETER, and the
        // non-native error variant.
        assert!(!is_session_not_found(&io_err(5)));
        assert!(!is_session_not_found(&io_err(87)));
        assert!(!is_session_not_found(&TraceError::InvalidTraceName));
    }

    /// The companion to the test above, against the real API: confirm that
    /// stopping a session that does not exist really reports one of the two
    /// codes [`is_session_not_found`] accepts. If Windows ever reported some
    /// other code here, the gate would silently fall through and spawn `logman`
    /// on every single launch — a regression nothing else would catch.
    ///
    /// Ignored by default: `ControlTraceW` needs elevation (as the app always is).
    #[test]
    #[ignore = "needs elevation; verifies the real ControlTraceW status code"]
    fn missing_session_really_reports_not_found() {
        // A name no session can plausibly own.
        let err = ferrisetw::trace::stop_trace_by_name("CorePilot-FPS-no-such-session")
            .expect_err("stopping a nonexistent session must fail");
        println!("missing-session stop error: {err:?}");
        assert!(
            is_session_not_found(&err),
            "unclassified error {err:?} would make every clean start spawn logman"
        );
    }

    /// Count `(Present_Info, everything-else)` delivered by a short DxgKrnl
    /// session, with or without the kernel-side event-id filter.
    ///
    /// Uses its OWN session name: reusing [`FPS_SESSION_NAME`] would stop the
    /// running app's live capture out from under it.
    fn sample_dxgkrnl(name: &str, filtered: bool, secs: u64) -> (u32, u32) {
        use ferrisetw::provider::{EventFilter, Provider};
        use ferrisetw::schema_locator::SchemaLocator;
        use ferrisetw::trace::UserTrace;
        use ferrisetw::EventRecord;
        use std::sync::atomic::{AtomicU32, Ordering};
        use std::sync::Arc;

        let _ = ferrisetw::trace::stop_trace_by_name(name);

        let present = Arc::new(AtomicU32::new(0));
        let other = Arc::new(AtomicU32::new(0));
        let (p, o) = (present.clone(), other.clone());

        let mut builder = Provider::by_guid(DXGKRNL_GUID);
        if filtered {
            builder = builder.add_filter(EventFilter::ByEventIds(vec![EVENT_ID_PRESENT_INFO]));
        }
        let provider = builder
            .add_callback(move |record: &EventRecord, _: &SchemaLocator| {
                if record.event_id() == EVENT_ID_PRESENT_INFO {
                    p.fetch_add(1, Ordering::Relaxed);
                } else {
                    o.fetch_add(1, Ordering::Relaxed);
                }
            })
            .build();

        let trace = UserTrace::new()
            .named(name.to_string())
            .enable(provider)
            .start_and_process()
            .expect("could not start the ETW session (run the test elevated)");
        thread::sleep(Duration::from_secs(secs));
        let counts = (
            present.load(Ordering::Relaxed),
            other.load(Ordering::Relaxed),
        );
        let _ = trace.stop();
        counts
    }

    /// Live proof that the kernel-side event-id filter neither is a no-op nor
    /// swallows `Present_Info`. This guards the whole downstream chain: no
    /// presents → `fps_for` returns `None` → `foreground_info_now` never sees
    /// `>= GAME_FPS_MIN` → no game detection, no OSD, no perf-recorder session.
    /// A filter that is silently too aggressive fails in exactly that silent
    /// way, which is why this is checked against the live provider rather than
    /// reasoned about.
    ///
    /// Ignored by default: it needs elevation (real-time ETW) and a desktop that
    /// is actually presenting. Re-run it after touching the provider setup:
    ///   `cargo test --lib -- --ignored --nocapture fps::tests::etw_event_id_filter`
    #[test]
    #[ignore = "needs elevation + a live ETW session; verifies real ETW behaviour"]
    fn etw_event_id_filter_still_delivers_present_info() {
        let (raw_presents, raw_others) = sample_dxgkrnl("CorePilot-FPS-selftest-raw", false, 3);
        let (presents, others) = sample_dxgkrnl("CorePilot-FPS-selftest-filtered", true, 3);
        println!(
            "unfiltered: {raw_presents} Present_Info + {raw_others} discarded | \
             filtered: {presents} Present_Info + {others} other"
        );

        // Sanity: the unfiltered session is the one that costs us — if DxgKrnl
        // were quiet, the rest of this test would prove nothing.
        assert!(
            raw_others > raw_presents,
            "expected DxgKrnl chatter to dominate; got {raw_others} vs {raw_presents}"
        );
        // The filter is really applied kernel-side, not just re-checked in the
        // callback: nothing but Present_Info reaches user mode.
        assert_eq!(
            others, 0,
            "filter ignored: {others} non-Present events still arrived"
        );
        // ...and it is not a black hole. DxgKrnl emits Present_Info for every
        // composed present and DWM composes continuously, so even an idle desktop
        // produces plenty; zero here would mean FPS silently reads 0.
        assert!(
            presents > 0,
            "filter swallowed Present_Info — FPS would read 0"
        );
    }
}
