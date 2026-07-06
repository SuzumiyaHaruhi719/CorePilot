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
use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumChildWindows, GetForegroundWindow, GetWindowLongPtrW, GetWindowRect, SetWindowLongPtrW,
    GWL_EXSTYLE, WS_EX_APPWINDOW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT,
};

const OSD_LABEL: &str = "osd";

/// Recycle the OSD window when this process's GDI object count reaches this.
/// Upstream bug (tauri-apps/tauri#11525): the transparent overlay window's
/// host slowly leaks GDI objects (~32/min measured on this machine, source in
/// tao/wry/WebView2 — every CorePilot GDI call site audits clean). At the
/// 10,000 per-process cap `CreateDIBSection` fails and softbuffer panics the
/// MAIN thread — a silent app death after ~5 h, twice in the field. 6,000
/// leaves generous headroom and recycles roughly every 3 h.
const GDI_RECYCLE_THRESHOLD: u32 = 6_000;

/// Watchdog for the upstream GDI leak — and the OSD's KEEP-ALIVE: poll our own
/// GDI count once a minute and, near the cap, destroy + recreate the OSD window
/// on the main thread. Destroying the window releases every leaked object
/// (measured: 186 → 19). The recreate is invisible while the overlay is parked
/// off-screen and at worst a one-frame blink in-game.
///
/// Each tick ALSO re-ensures the overlay exists + carries its styles
/// (`osd_set_visible` is idempotent): if the window died through ANY path — a
/// WebView2 crash, a failed recycle, the historical style-reset phantom window
/// the user could close — it is recreated within a minute instead of staying
/// gone until the next app restart, and drifted ex-styles are re-asserted.
pub fn start_gdi_guard(app: AppHandle) {
    std::thread::Builder::new()
        .name("gdi-guard".into())
        .spawn(move || {
            use windows::Win32::System::Threading::{
                GetCurrentProcess, GetGuiResources, GR_GDIOBJECTS,
            };
            loop {
                std::thread::sleep(std::time::Duration::from_secs(60));
                let gdi = unsafe { GetGuiResources(GetCurrentProcess(), GR_GDIOBJECTS) };
                if gdi < GDI_RECYCLE_THRESHOLD {
                    // Keep-alive + style re-assert (cheap window calls, main thread).
                    let handle = app.clone();
                    let _ = app.run_on_main_thread(move || {
                        if let Err(e) = osd_set_visible(handle.clone(), true) {
                            tracing::warn!("OSD keep-alive ensure failed: {e}");
                        }
                    });
                    continue;
                }
                tracing::warn!(
                    gdi,
                    "GDI handles nearing the 10k cap (upstream transparent-window leak, tauri#11525) — recycling the OSD window"
                );
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || {
                    // Recycle the corner/free OSD window — a transparent host that
                    // leaks GDI objects upstream. destroy() skips the close-request
                    // path (the overlay is non-closable for the user). The taskbar
                    // monitor is a native GDI window on its own thread (taskbar_mon.rs)
                    // with cached, never-per-paint GDI objects, so it is NOT part of
                    // this leak class and is left untouched.
                    if let Some(win) = handle.get_webview_window(OSD_LABEL) {
                        let _ = win.destroy();
                    }
                    if let Err(e) = osd_set_visible(handle.clone(), true) {
                        tracing::warn!("OSD recreate after GDI recycle failed: {e}");
                    }
                });
            }
        })
        .ok();
}

/// Last logical size pushed to the overlay window, packed as `w << 32 | h`
/// (rounded). Lets [`osd_set_bounds`] skip the costly resize + click-through
/// re-assert on pure position moves — the per-frame churn that made the
/// free-position slider's live follow stutter. On a move, only the lightweight
/// `set_position` runs.
static LAST_OSD_SIZE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// OR click-through + non-activating + tool-window extended styles onto one
/// window (and drop `WS_EX_APPWINDOW`).
unsafe fn set_through(hwnd: HWND) {
    let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
    // WS_EX_TRANSPARENT → clicks pass to whatever is beneath; WS_EX_NOACTIVATE →
    // the overlay never steals focus; WS_EX_TOOLWINDOW (+ no APPWINDOW) → never a
    // taskbar button or Alt-Tab tile. WebView2 intermittently RESETS the ex-style
    // wholesale; when the earlier re-assert restored only TRANSPARENT|NOACTIVATE,
    // the overlay resurfaced in the taskbar as a phantom "second CorePilot
    // window" the user could focus and close. Leave Tauri's layered bits alone.
    let want = (ex
        | WS_EX_TRANSPARENT.0 as isize
        | WS_EX_NOACTIVATE.0 as isize
        | WS_EX_TOOLWINDOW.0 as isize)
        & !(WS_EX_APPWINDOW.0 as isize);
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

/// Ensure the transparent, click-through, always-on-top corner/free OSD overlay
/// window exists and is shown. Idempotent. (The taskbar monitor is a separate
/// native GDI window on its own thread — see `taskbar_mon.rs` — not a webview.)
fn ensure_overlay_window(
    app: &AppHandle,
    label: &'static str,
    url: &'static str,
    title: &'static str,
) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.show();
        let _ = win.set_always_on_top(true);
        // Re-assert click-through on every show (WebView2 can reset it).
        let _ = win.set_ignore_cursor_events(true);
        force_click_through(hwnd_of(&win));
        return Ok(());
    }

    // Create the overlay SMALL (content-sized). The frontend measures the plate
    // and resizes/repositions the window via `*_set_bounds` once it has rendered,
    // so a tiny starting size is fine — and crucially a small window can never
    // lock the whole screen if click-through momentarily fails.
    let win = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title(title)
        // Keep this background, always-on-top, ALWAYS-occluded overlay's JS timers
        // running. Critically this must disable `CalculateNativeWinOcclusion`, or
        // WebView2 marks the (game-covered) overlay hidden and freezes its task
        // scheduler so the metric poll never ticks. See `crate::WEBVIEW_ARGS`.
        .additional_browser_args(crate::WEBVIEW_ARGS)
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

/// Show or hide the overlay window, creating it on first show. Idempotent.
#[tauri::command]
pub fn osd_set_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    // The overlay is a KEEP-ALIVE window: once created it stays shown and is
    // never hidden. Hiding a WebView2 window freezes its renderer's task loop,
    // which silently stops BOTH the overlay's own metric poll AND the perf
    // recorder (they run in the shared renderer). When there is nothing to
    // display the React overlay parks itself off-screen (1×1 at -200,-200) so it
    // is invisible without being hidden. `visible` is therefore advisory only —
    // we always ensure the window exists and is shown.
    let _ = visible;
    ensure_overlay_window(&app, OSD_LABEL, "index.html?osd", "CorePilot OSD")
}

/// Smallest overlay window we will ever set (logical px). Below this the plate
/// would be unusable and a 0/negative size is rejected by the WM anyway.
const OSD_MIN_DIM: f64 = 1.0;
/// Hard cap on the overlay's width/height (logical px) regardless of what the
/// monitor reports. A hostile/erroneous IPC caller must never be able to size
/// this always-on-top, click-through window into a screen-covering surface.
const OSD_MAX_DIM: f64 = 10_000.0;
/// Hard cap on the magnitude of the overlay's logical x/y. Generous enough for
/// any real multi-monitor layout, small enough that the window can never be
/// flung to an absurd virtual-desktop coordinate.
const OSD_MAX_COORD: f64 = 100_000.0;

/// Quantum (logical px) the overlay window size is rounded UP to before resizing.
/// The metrics plate's width jitters by a few px as digits change (e.g. "60"→"119"
/// FPS); without this, every such change triggers a `set_size`, and each WebView2
/// surface resize leaks GDI objects (upstream tauri#11525) — the driver behind the
/// ~3-hourly GDI-recycle whose window rebuild once hung the main thread. Snapping to
/// a grid makes resizes rare. The extra ≤16px is transparent + click-through and the
/// plate sits at the window's top-left, so it is invisible and never moves the plate.
const OSD_SIZE_QUANTUM: f64 = 16.0;

/// Resolve the upper bound for the overlay's width/height. Prefer the primary
/// monitor's *physical* size converted to logical px (so the overlay can never
/// exceed the actual screen) but never trust it above [`OSD_MAX_DIM`], and fall
/// back to the hard cap when no monitor can be queried.
fn osd_max_dim(win: &tauri::WebviewWindow) -> f64 {
    let monitor_dim = win
        .primary_monitor()
        .ok()
        .flatten()
        .map(|m| {
            let scale = m.scale_factor();
            let scale = if scale.is_finite() && scale > 0.0 {
                scale
            } else {
                1.0
            };
            let size = m.size();
            (size.width.max(size.height) as f64) / scale
        })
        .filter(|d| d.is_finite() && *d >= OSD_MIN_DIM);
    match monitor_dim {
        Some(d) => d.min(OSD_MAX_DIM),
        None => OSD_MAX_DIM,
    }
}

/// Size + position the overlay window in logical (DPI-independent) pixels. The
/// frontend calls this after measuring the metrics plate so the window hugs the
/// plate at the chosen corner / free position.
///
/// `x`/`y`/`w`/`h` arrive straight off the IPC boundary, so they are untrusted:
/// non-finite values (NaN/±Inf) are rejected outright and finite values are
/// clamped to sane bounds before being applied. This keeps a buggy or hostile
/// caller from turning the always-on-top, click-through overlay into a
/// screen-covering window or flinging it off into the virtual-desktop void.
#[tauri::command]
pub fn osd_set_bounds(app: AppHandle, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    let label = OSD_LABEL;
    let last_size = &LAST_OSD_SIZE;
    use std::sync::atomic::Ordering;
    use tauri::{LogicalPosition, LogicalSize};
    // Reject any non-finite input without touching the window. Returning Ok (not
    // Err) keeps the per-frame caller quiet; a bad frame is simply ignored.
    if !x.is_finite() || !y.is_finite() || !w.is_finite() || !h.is_finite() {
        return Ok(());
    }
    if let Some(win) = app.get_webview_window(label) {
        let max_dim = osd_max_dim(&win);
        // Clamp size into [MIN, max_dim] and position into the coordinate cap.
        // Round the requested size UP to the size quantum BEFORE clamping, so small
        // metric-driven width/height jitter doesn't trigger a WebView2 surface resize
        // every frame (the GDI-leak driver). Rounding up keeps the plate fully
        // covered; the extra transparent margin is invisible + click-through.
        let qw = (w / OSD_SIZE_QUANTUM).ceil() * OSD_SIZE_QUANTUM;
        let qh = (h / OSD_SIZE_QUANTUM).ceil() * OSD_SIZE_QUANTUM;
        let cw = qw.clamp(OSD_MIN_DIM, max_dim);
        let ch = qh.clamp(OSD_MIN_DIM, max_dim);
        let cx = x.clamp(-OSD_MAX_COORD, OSD_MAX_COORD);
        let cy = y.clamp(-OSD_MAX_COORD, OSD_MAX_COORD);

        // Only resize — and re-assert click-through, which WebView2 resets on a
        // *resize*, not a move — when the plate size actually changed. During a
        // free-position slider drag the size is constant, so every frame does just
        // the cheap `set_position`; that is what keeps the live follow smooth
        // instead of churning a resize + EnumChildWindows 60×/s.
        let wk = cw.round() as u64;
        let hk = ch.round() as u64;
        let key = (wk << 32) | (hk & 0xFFFF_FFFF);
        if last_size.swap(key, Ordering::Relaxed) != key {
            let _ = win.set_size(LogicalSize::new(cw, ch));
            let _ = win.set_ignore_cursor_events(true);
            force_click_through(hwnd_of(&win));
        }
        let _ = win.set_position(LogicalPosition::new(cx, cy));
    }
    Ok(())
}

/// Logical (DPI-scaled) bounds `(x, y, w, h)` of the monitor the FOREGROUND
/// window (the game) currently sits on, so the overlay can place itself on the
/// game's monitor instead of always the primary one. `None` if it can't be
/// resolved (no foreground window, or it isn't on a known monitor).
#[tauri::command]
pub fn osd_target_monitor(app: AppHandle) -> Option<(f64, f64, f64, f64)> {
    let hwnd = unsafe { GetForegroundWindow() };
    let mut rect = RECT::default();
    if unsafe { GetWindowRect(hwnd, &mut rect) }.is_err() {
        return None;
    }
    // Center of the foreground window, in physical (device) pixels.
    let cx = (rect.left as i64 + rect.right as i64) / 2;
    let cy = (rect.top as i64 + rect.bottom as i64) / 2;
    let win = app.get_webview_window(OSD_LABEL)?;
    // available_monitors() reports each monitor's physical position+size, which
    // tiles the virtual desktop without the per-monitor DPI gaps the logical
    // coordinate space has — so the center hit-test is reliable. We return the
    // matched monitor's LOGICAL bounds (physical / scale) for `osd_set_bounds`.
    for m in win.available_monitors().ok()? {
        let p = m.position();
        let s = m.size();
        let (mx, my) = (p.x as i64, p.y as i64);
        let (mw, mh) = (s.width as i64, s.height as i64);
        if cx >= mx && cx < mx + mw && cy >= my && cy < my + mh {
            let scale = m.scale_factor();
            return Some((
                p.x as f64 / scale,
                p.y as f64 / scale,
                s.width as f64 / scale,
                s.height as f64 / scale,
            ));
        }
    }
    None
}
