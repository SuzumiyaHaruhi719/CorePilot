//! OSD overlay window management.
//!
//! The overlay is a separate fullscreen, transparent, always-on-top,
//! click-through window that loads the same frontend bundle with `?osd` (so
//! `main.tsx` renders only the lightweight `OsdOverlay`). It covers the primary
//! monitor and lets CSS place the metrics plate at the chosen corner; being
//! click-through, it never intercepts input meant for the game beneath it.
//!
//! Works over borderless / windowed games (the common default). True exclusive
//! fullscreen would require present-hooking (out of scope), same as any
//! non-injecting overlay.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};

const OSD_LABEL: &str = "osd";

/// Show or hide the overlay window, creating it on first show. Idempotent.
#[tauri::command]
pub fn osd_set_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(OSD_LABEL) {
        if visible {
            let _ = win.show();
            let _ = win.set_always_on_top(true);
        } else {
            let _ = win.hide();
        }
        return Ok(());
    }
    if !visible {
        return Ok(());
    }

    // Logical size of the primary monitor (physical px ÷ scale). Sizing via the
    // builder (rather than post-build set_size / SetWindowPos, which were being
    // clobbered by WebView2's own setup) makes it the creation size — no race.
    let scale = app
        .webview_windows()
        .values()
        .find(|w| w.label() != OSD_LABEL)
        .and_then(|w| w.scale_factor().ok())
        .unwrap_or(1.0)
        .max(0.5);
    let pw = unsafe { GetSystemMetrics(SM_CXSCREEN) };
    let ph = unsafe { GetSystemMetrics(SM_CYSCREEN) };
    let lw = if pw > 0 { pw as f64 / scale } else { 1920.0 };
    let lh = if ph > 0 { ph as f64 / scale } else { 1080.0 };

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
        .inner_size(lw, lh)
        .position(0.0, 0.0)
        .visible(true)
        .build()
        .map_err(|e| e.to_string())?;

    // Click-through so input passes to the game beneath.
    let _ = win.set_ignore_cursor_events(true);
    Ok(())
}
