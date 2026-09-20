//! "Can the user actually see the main window?" — the backend signal the
//! frontend gates its polling and animation on.
//!
//! ## Why this module exists
//!
//! `WEBVIEW_ARGS` (see `lib.rs`) deliberately disables Chromium's background /
//! occlusion throttling for EVERY CorePilot webview. That is non-negotiable:
//! a WebView2 page that Chromium marks *hidden* has its task scheduler frozen,
//! which is what silently killed the OSD overlay's metric poll and the perf
//! recorder in the field ("the monitor disappears"). The cost of that switch is
//! the mirror image: while the main window sits hidden in the tray, or behind a
//! fullscreen game, its JS timers keep firing at full rate. Measured on the
//! live machine with the window hidden in the tray and a game in front:
//! `corepilot-sampler` burning 15.8% of a core, purely because the frontend
//! kept asking for `list_processes` every 1.5 s.
//!
//! So we do NOT let Chromium decide. We compute occlusion natively here and
//! publish it as one atomic; the frontend polls [`ui_occluded`] and skips its
//! own work. The page's task loop keeps running either way — nothing is ever
//! hidden, suspended, or occlusion-throttled to achieve this.
//!
//! ## Why the test is not "did we lose focus"
//!
//! Focus alone is WRONG and would be a regression: a user with CorePilot open
//! on a second monitor while gaming on the first must keep seeing live numbers.
//! Hence the foreground term only counts when the foreground window covers its
//! whole monitor AND that is the same monitor the main window lives on.
//!
//! The "covers its whole monitor" shape is deliberately duplicated from
//! `fps.rs::foreground_is_fullscreen` rather than shared: that one is tuned for
//! game detection and is free to change its heuristics (tolerances, extra
//! filters) without silently changing what "the user can't see the UI" means.

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::time::Duration;

use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::System::Threading::GetCurrentProcessId;
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetShellWindow, GetWindowRect, GetWindowThreadProcessId, IsIconic,
    IsWindowVisible,
};

/// Raw HWND of the main window (0 until `setup` publishes it).
static MAIN_HWND: AtomicIsize = AtomicIsize::new(0);

/// True between "closed to tray" and "restored from tray".
///
/// `IsWindowVisible` already reports the same thing, but this flag is ALSO the
/// input `sensors.rs` uses to decide the sidecar's poll rate, and it lets both
/// consumers react on the exact transition instead of up to 2 s later.
static MAIN_HIDDEN: AtomicBool = AtomicBool::new(false);

/// The published answer. Read by the sync `ui_occluded` command (atomic load
/// only — rule 1: sync commands run on the main thread / message pump).
static OCCLUDED: AtomicBool = AtomicBool::new(false);

/// How often the native occlusion test runs. 2 s is fast enough that the user
/// never notices stale numbers after alt-tabbing back (and `app://focus` covers
/// the instant case), and slow enough that the test itself is free.
const TICK: Duration = Duration::from_secs(2);

/// Publish the main window's HWND. Called once from `lib.rs`'s `setup`.
pub fn set_main_hwnd(raw: isize) {
    MAIN_HWND.store(raw, Ordering::Relaxed);
}

/// Record that the main window went to / came back from the tray.
///
/// Also re-evaluates the sensord poll interval right away, so closing to the
/// tray drops the sidecar to its slow cadence immediately rather than on the
/// next tick.
pub fn set_main_hidden(hidden: bool) {
    // Publish the gate on BOTH edges, and OUTSIDE the transition check.
    //
    // Hiding is unambiguous, so gate immediately rather than waiting for a tick.
    // Showing has to clear it here too: the restore path cannot rely on the
    // focus event, because Windows routinely refuses `set_focus()` under the
    // foreground lock — which is the whole reason `show_main` does the
    // always-on-top dance. Leaving OCCLUDED set left a *visible* window frozen
    // for up to TICK plus one frontend poll, on the single interaction this
    // feature promises is instant.
    //
    // Outside the edge check because restoring from MINIMISED never set
    // MAIN_HIDDEN, so the swap is a no-op there while OCCLUDED is true (set by
    // the `IsIconic` term) and would stay true.
    OCCLUDED.store(hidden, Ordering::Relaxed);
    if MAIN_HIDDEN.swap(hidden, Ordering::Relaxed) != hidden {
        crate::sensors::refresh_sidecar_interval();
    }
}

/// Whether the main window is currently hidden to the tray. Read by
/// `sensors.rs` to pick the sidecar poll interval.
pub fn main_hidden() -> bool {
    MAIN_HIDDEN.load(Ordering::Relaxed)
}

/// Main window gained/lost focus (from `lib.rs`'s window-event hook).
///
/// Gaining focus is the one transition the user feels, so un-gate instantly
/// instead of making them stare at frozen numbers for up to `TICK`. Losing
/// focus deliberately does NOTHING here: the periodic test decides, because
/// losing focus to a window on another monitor must NOT gate (see module docs).
pub fn note_focus(focused: bool) {
    if focused {
        MAIN_HIDDEN.store(false, Ordering::Relaxed);
        OCCLUDED.store(false, Ordering::Relaxed);
        crate::sensors::refresh_sidecar_interval();
    }
}

/// The published "user cannot see the main window" flag.
///
/// Rule 1: this is a SYNC command, so it executes on the main thread (the
/// window's message pump). It is a single relaxed atomic load and must stay
/// that way — every ~1 s poll from the frontend lands here.
#[tauri::command]
pub fn ui_occluded() -> bool {
    OCCLUDED.load(Ordering::Relaxed)
}

/// Does `hwnd` cover the entirety of the monitor it sits on?
///
/// Same shape as `fps.rs::foreground_is_fullscreen`, copied on purpose (see
/// module docs). A couple of pixels of slop because borderless windows commonly
/// land 1 px off.
unsafe fn covers_its_monitor(hwnd: HWND) -> bool {
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
    const TOL: i32 = 2;
    wr.left <= m.left + TOL
        && wr.top <= m.top + TOL
        && wr.right >= m.right - TOL
        && wr.bottom >= m.bottom - TOL
}

/// Is `hwnd` one of the shell's own monitor-sized surfaces (desktop, taskbar,
/// Start / search / action centre)?
///
/// Matched by window class rather than owning process: the Win11 Start menu
/// lives in `StartMenuExperienceHost.exe`, search in `SearchHost.exe` and the
/// desktop in `explorer.exe`, so "is it explorer" would miss two of the three.
unsafe fn is_shell_surface(hwnd: HWND) -> bool {
    matches!(
        crate::osd::class_name(hwnd).as_str(),
        "Progman"
            | "WorkerW"
            | "Shell_TrayWnd"
            | "Shell_SecondaryTrayWnd"
            | "Windows.UI.Core.CoreWindow"
            | "XamlExplorerHostIslandWindow"
    )
}

/// One evaluation of the occlusion test. Pure reads; no window is ever touched.
fn compute_occluded() -> bool {
    let raw = MAIN_HWND.load(Ordering::Relaxed);
    if raw == 0 {
        // No main window yet (or it's gone). FAIL OPEN: reporting "occluded"
        // with no window to check would gate the whole UI off on a bad read,
        // which is the failure class this project keeps paying for.
        return false;
    }
    let main = HWND(raw as *mut c_void);

    unsafe {
        if !IsWindowVisible(main).as_bool() || IsIconic(main).as_bool() {
            return true;
        }

        // Self-heal a stale tray flag. If some path ever shows the window
        // without going through `show_main` (single-instance relaunch, a future
        // shortcut, a plugin), a stuck `MAIN_HIDDEN` would gate the UI off
        // forever while the user stares at a visible, frozen window. The window
        // is provably on screen here, so the flag is a lie — clear it.
        if MAIN_HIDDEN.swap(false, Ordering::Relaxed) {
            crate::sensors::refresh_sidecar_interval();
        }

        let fg = GetForegroundWindow();
        if fg.0.is_null() || fg.0 == main.0 {
            return false;
        }

        // One of our OWN windows in front (the OSD overlay, a dialog, the
        // taskbar plate) means the user is still looking at CorePilot.
        let mut fg_pid: u32 = 0;
        let _ = GetWindowThreadProcessId(fg, Some(&mut fg_pid));
        if fg_pid == GetCurrentProcessId() {
            return false;
        }

        // The SHELL is not "something covering the UI". Clicking the wallpaper
        // makes Progman (or WorkerW, once a slideshow has run) the foreground
        // window, and the desktop spans the whole monitor by definition — so
        // without this a fully visible window froze the moment the user clicked
        // the desktop, and only a click back on CorePilot thawed it. Same shape
        // for the Win11 Start menu / search, which are monitor-sized XAML
        // surfaces. `fps.rs` gets away without this because its fullscreen test
        // is only ever consulted alongside `is_non_game` and a sustained present
        // rate; this one stands alone, so it needs its own filter.
        //
        // Fail-open bias on purpose (see `start`): a fullscreen UWP app in front
        // costs us a missed optimisation, a stuck gate costs the user readings.
        if fg.0 == GetShellWindow().0 || is_shell_surface(fg) {
            return false;
        }

        // A normal window in front leaves CorePilot at least partly readable,
        // so only a monitor-covering window counts...
        if !covers_its_monitor(fg) {
            return false;
        }

        // ...and only on the SAME monitor. CorePilot on monitor 2 while a game
        // owns monitor 1 must keep updating — that is the whole point of this
        // term, and gating on focus alone would break it.
        let fg_mon = MonitorFromWindow(fg, MONITOR_DEFAULTTONEAREST);
        let main_mon = MonitorFromWindow(main, MONITOR_DEFAULTTONEAREST);
        fg_mon.0 == main_mon.0
    }
}

/// Start the `corepilot-ui-vis` thread. Idempotent-by-convention: called once
/// from `setup`.
///
/// Runs on its own thread — never the main thread and never a Tauri command —
/// and only READS window state (`IsWindowVisible` / `GetWindowRect` / monitor
/// queries). It must never create, move, show, hide or restyle a window: rule 2
/// (touching the transparent OSD window off the main thread is the upstream
/// GDI-leak / create-hang class).
pub fn start() {
    let spawned = std::thread::Builder::new()
        .name("corepilot-ui-vis".into())
        .spawn(|| loop {
            let occluded = compute_occluded();
            OCCLUDED.store(occluded, Ordering::Relaxed);
            // Cheap and edge-triggered inside: only actually writes to the
            // sidecar when the chosen interval changes.
            crate::sensors::refresh_sidecar_interval();
            std::thread::sleep(TICK);
        });
    if let Err(e) = spawned {
        // Degrade to "always visible" rather than killing startup: a missing
        // gate costs CPU, a stuck gate costs the user their readings.
        tracing::warn!("failed to start corepilot-ui-vis thread: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_main_window_never_gates() {
        MAIN_HWND.store(0, Ordering::Relaxed);
        assert!(
            !compute_occluded(),
            "must fail open when the main HWND is unknown"
        );
    }

    #[test]
    fn hidden_flag_round_trips() {
        set_main_hidden(true);
        assert!(main_hidden());
        assert!(ui_occluded(), "closing to tray gates immediately");
        note_focus(true);
        assert!(!main_hidden());
        assert!(!ui_occluded(), "regaining focus un-gates immediately");
    }
}
