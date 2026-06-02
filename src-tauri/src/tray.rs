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

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Runtime,
};

/// Backend mirror of the frontend's "close to tray" setting. Read by the window
/// close handler; written by [`set_close_to_tray`]. Defaults to `true` so an
/// accidental window close keeps the app alive even before the frontend has
/// synced its persisted value.
pub struct TrayPrefs {
    close_to_tray: AtomicBool,
}

impl Default for TrayPrefs {
    fn default() -> Self {
        Self { close_to_tray: AtomicBool::new(true) }
    }
}

impl TrayPrefs {
    /// Whether closing the main window should hide it to the tray (vs. exit).
    pub fn close_to_tray(&self) -> bool {
        self.close_to_tray.load(Ordering::Relaxed)
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
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_always_on_top(true);
        let _ = window.set_focus();
        let _ = window.set_always_on_top(false);
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
