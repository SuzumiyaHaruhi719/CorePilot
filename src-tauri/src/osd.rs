//! OSD overlay window management.
//!
//! The overlay is a small, content-sized, transparent, always-on-top,
//! click-through window that loads the same frontend bundle with `?osd` (so
//! `main.tsx` renders only the lightweight `OsdOverlay`). The frontend measures
//! the metrics plate and drives the window's size + corner/free position via
//! `osd_set_bounds`; being click-through it never intercepts input meant for the
//! game beneath it. A small window also means that even if click-through fails
//! (WebView2 on Windows resets it intermittently) it can never lock the whole
//! screen the way a fullscreen overlay would.
//!
//! Works over borderless / windowed games (the common default). True exclusive
//! fullscreen would require present-hooking (out of scope), same as any
//! non-injecting overlay.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumChildWindows, GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE,
    WS_EX_TRANSPARENT,
};

const OSD_LABEL: &str = "osd";

/// OR click-through + non-activating extended styles onto one window.
unsafe fn set_through(hwnd: HWND) {
    let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
    // WS_EX_TRANSPARENT → clicks pass to whatever is beneath; WS_EX_NOACTIVATE →
    // the overlay never steals focus. Leave Tauri's layered/transparency bits.
    let want = ex | WS_EX_TRANSPARENT.0 as isize | WS_EX_NOACTIVATE.0 as isize;
    if ex != want {
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, want);
    }
}

unsafe extern "system" fn enum_child_through(child: HWND, _: LPARAM) -> BOOL {
    set_through(child);
    true.into()
}

/// Force the overlay window (by raw HWND, bridged as `isize` so we don't depend
/// on which `windows` crate version Tauri exposes) to be click-through.
///
/// Tauri's `set_ignore_cursor_events` proved unreliable for this transparent
/// WebView2 window: WebView2 hosts its content in **child HWNDs that hit-test
/// independently**, so WS_EX_TRANSPARENT on the top-level alone still lets the
/// children swallow every click. We apply the styles to the top-level window
/// AND every child window.
fn force_click_through(hwnd_raw: isize) {
    if hwnd_raw == 0 {
        return;
    }
    let hwnd = HWND(hwnd_raw as *mut core::ffi::c_void);
    unsafe {
        set_through(hwnd);
        let _ = EnumChildWindows(Some(hwnd), Some(enum_child_through), LPARAM(0));
    }
}

/// Raw HWND of a Tauri window as `isize` (0 if unavailable).
fn hwnd_of(win: &tauri::WebviewWindow) -> isize {
    win.hwnd().map(|h| h.0 as isize).unwrap_or(0)
}

/// Show or hide the overlay window, creating it on first show. Idempotent.
#[tauri::command]
pub fn osd_set_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(OSD_LABEL) {
        if visible {
            let _ = win.show();
            let _ = win.set_always_on_top(true);
            // Re-assert click-through on every show (WebView2 can reset it).
            let _ = win.set_ignore_cursor_events(true);
            force_click_through(hwnd_of(&win));
        } else {
            let _ = win.hide();
        }
        return Ok(());
    }
    if !visible {
        return Ok(());
    }

    // Create the overlay SMALL (content-sized). The frontend measures the plate
    // and resizes/repositions the window via `osd_set_bounds` once it has
    // rendered, so a tiny starting size is fine — and crucially a small window
    // can never lock the whole screen if click-through momentarily fails.
    let win = WebviewWindowBuilder::new(&app, OSD_LABEL, WebviewUrl::App("index.html?osd".into()))
        .title("CorePilot OSD")
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .maximizable(false)
        .minimizable(false)
        .closable(false)
        .shadow(false)
        .focused(false)
        .inner_size(64.0, 48.0)
        .position(0.0, 0.0)
        .visible(true)
        .build()
        .map_err(|e| e.to_string())?;

    // Click-through so input passes to whatever is beneath the overlay. WebView2
    // initializes asynchronously and can reset the window's extended styles
    // (including this click-through flag) shortly after creation. Apply now,
    // then re-apply a few times as the webview settles so it reliably sticks.
    let _ = win.set_ignore_cursor_events(true);
    force_click_through(hwnd_of(&win));
    let w = win.clone();
    tauri::async_runtime::spawn(async move {
        for _ in 0..6 {
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            let _ = w.set_ignore_cursor_events(true);
            force_click_through(hwnd_of(&w));
        }
    });
    Ok(())
}

/// Size + position the overlay window in logical (DPI-independent) pixels. The
/// frontend calls this after measuring the metrics plate so the window hugs the
/// plate at the chosen corner / free position.
#[tauri::command]
pub fn osd_set_bounds(app: AppHandle, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    use tauri::{LogicalPosition, LogicalSize};
    if let Some(win) = app.get_webview_window(OSD_LABEL) {
        let _ = win.set_size(LogicalSize::new(w.max(1.0), h.max(1.0)));
        let _ = win.set_position(LogicalPosition::new(x, y));
        // Re-assert click-through (resize/move + WebView2 can reset it).
        let _ = win.set_ignore_cursor_events(true);
        force_click_through(hwnd_of(&win));
    }
    Ok(())
}
