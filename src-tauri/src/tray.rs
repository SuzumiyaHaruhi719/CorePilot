//! System-tray integration and the "close to tray" behaviour.
//!
//! CorePilot installs a tray icon with a small menu (show / quit). When the
//! "close to tray" preference is on (the default), closing the main window
//! hides it to the tray instead of exiting, so the background features — the
//! affinity enforcer, GPU auto-overclock, and the in-game OSD — keep running.
//!
//! The preference itself lives in the frontend (persisted with the other
//! settings) and is mirrored to the backend via [`set_close_to_tray`]; the
//! window close handler in `lib.rs` reads it through [`TrayPrefs`].

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Runtime,
};

/// Backend mirror of the frontend's "close to tray" setting. Read by the window
/// close handler; written by [`set_close_to_tray`]. Defaults to `true` so an
/// accidental window close keeps the app alive even before the frontend has
/// synced its persisted value.
/// A WebView2 renderer that's been HIDDEN (tray) freezes, and after a long stint
/// the OS can discard it (memory saver / "sleeping tabs") → the window restores
/// BLANK/white. We time how long the main window has been hidden so the tray
/// restore can reload it past this threshold.
const TRAY_RELOAD_AFTER_MS: u64 = 120_000;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub struct TrayPrefs {
    close_to_tray: AtomicBool,
    /// Epoch-ms when the main window was hidden to the tray; 0 while it's visible.
    hidden_at_ms: AtomicU64,
}

impl Default for TrayPrefs {
    fn default() -> Self {
        Self { close_to_tray: AtomicBool::new(true), hidden_at_ms: AtomicU64::new(0) }
    }
}

impl TrayPrefs {
    /// Whether closing the main window should hide it to the tray (vs. exit).
    pub fn close_to_tray(&self) -> bool {
        self.close_to_tray.load(Ordering::Relaxed)
    }

    /// Record that the main window was just hidden to the tray.
    pub fn mark_hidden(&self) {
        self.hidden_at_ms.store(now_ms(), Ordering::Relaxed);
    }

    /// Milliseconds the window has been hidden, then clear the marker. Returns 0
    /// when it wasn't hidden via the tray (e.g. a plain show/focus).
    pub fn hidden_ms(&self) -> u64 {
        let at = self.hidden_at_ms.swap(0, Ordering::Relaxed);
        if at == 0 { 0 } else { now_ms().saturating_sub(at) }
    }
}

/// Push the frontend's "close to tray" preference to the backend.
#[tauri::command]
pub fn set_close_to_tray(prefs: tauri::State<'_, TrayPrefs>, enabled: bool) {
    prefs.close_to_tray.store(enabled, Ordering::Relaxed);
}

/// Bring the main window back to the foreground (restore from the tray).
///
/// `show()` + `set_focus()` alone is unreliable on Windows: the OS forbids a
/// background process from calling `SetForegroundWindow`, so the restored window
/// often appears *behind* the current foreground app — to the user it looks like
/// clicking "显示 CorePilot" did nothing. Briefly pinning the window always-on-top
/// forces it visibly to the top (this isn't blocked), then we unpin it so it
/// behaves like a normal window afterwards.
fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        // If it sat hidden long enough that WebView2 may have frozen/discarded the
        // renderer (→ blank/white window on restore), reload the content so it
        // always comes back painted. Quick hide/show toggles stay under the
        // threshold and skip the reload (no flash).
        let reload = app.state::<TrayPrefs>().hidden_ms() > TRAY_RELOAD_AFTER_MS;
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_always_on_top(true);
        let _ = window.set_focus();
        let _ = window.set_always_on_top(false);
        if reload {
            let _ = window.eval("window.location.reload()");
        }
    }
}

/// Build the system-tray icon + menu. Call once from `setup`.
pub fn build_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let show = MenuItemBuilder::with_id("show", "显示 CorePilot").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "退出 CorePilot").build(app)?;
    let menu = MenuBuilder::new(app).items(&[&show, &quit]).build()?;

    let mut builder = TrayIconBuilder::with_id("corepilot-tray")
        .tooltip("CorePilot")
        .menu(&menu)
        // Left click restores the window (Windows-native feel); the context menu
        // is reserved for right click.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });

    // Reuse the app's bundle icon so the tray matches the taskbar/window icon.
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}
