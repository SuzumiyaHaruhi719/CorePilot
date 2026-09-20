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
//!
//! Z-ORDER INVARIANT (field failure 2026-07..09, "the OSD disappears after a
//! while"): Windows demotes the overlay when a fullscreen (rude) app takes the
//! foreground - the HWND keeps its `WS_EX_TOPMOST` bit but is re-linked BELOW
//! the non-topmost band (observed live: the OSD at z-position 20 under the game
//! and 16 ordinary windows, page + DWM surface fully rendered, zero pixels on
//! screen). Nothing ever raised it again: tao caches its window flags, so the
//! keep-alive's `show()` / `set_always_on_top(true)` are silent no-ops once the
//! cached flag already says visible/topmost. The only cure is an explicit
//! `SetWindowPos(HWND_TOPMOST)` - see [`ensure_topmost`], called from every
//! `osd_set_bounds` (about 1 Hz while showing) and every keep-alive tick.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumChildWindows, GetClassNameW, GetForegroundWindow, GetWindow, GetWindowLongPtrW,
    GetWindowRect, IsWindowVisible, SetWindowLongPtrW, SetWindowPos, ShowWindow, GWL_EXSTYLE,
    GW_HWNDPREV, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SW_SHOWNA, WS_EX_APPWINDOW,
    WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_EX_TRANSPARENT,
};

const OSD_LABEL: &str = "osd";

/// Recycle the OSD window when this process's GDI object count reaches this.
/// Upstream bug (tauri-apps/tauri#11525): the transparent overlay window's host
/// slowly leaks GDI objects (source in tao/wry/WebView2 — every CorePilot GDI
/// call site audits clean). At the 10,000 per-process cap `CreateDIBSection`
/// fails and softbuffer panics the MAIN thread — a silent app death, twice in
/// the field before this guard existed.
///
/// LEAK RATE, re-measured on this machine: ~2 objects/min (1365 objects over
/// 12.5 h). An earlier note here claimed ~32/min and "recycles roughly every
/// 3 h"; that figure predates `OSD_SIZE_QUANTUM` (which removed the per-frame
/// surface resizes that dominated the leak). At the real rate this threshold is
/// reached roughly every 44 h, not every 3 h. The VALUE stays at 6,000: it still
/// leaves 4,000 objects of headroom under the cap, and a rebuild that fires
/// twice a week costs nothing. What the corrected rate does change is that the
/// recycle can no longer be relied on as a general "the OSD heals itself
/// eventually" backstop — hence the page-liveness watch below.
const GDI_RECYCLE_THRESHOLD: u32 = 6_000;

/// Wall-clock ms of the last beat from the overlay PAGE (see [`osd_heartbeat`]),
/// seeded when the window is created.
///
/// This tracks liveness of the RENDERER, not of the HWND. wry installs no
/// WebView2 `ProcessFailed` handler, so when the OSD page's renderer dies the
/// window survives it: a live, transparent, topmost HWND with a dead page behind
/// it. Every existing self-heal looks at the *window* (`osd_set_visible` is
/// idempotent, `ensure_topmost` sees a perfectly healthy z-order), so nothing in
/// the app ever noticed — the only thing that eventually rebuilt it was the GDI
/// recycle, and that is ~44 h away (see [`GDI_RECYCLE_THRESHOLD`]).
static OSD_BEAT_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Whether a `reload()` has already been tried for the CURRENT silent streak.
/// Escalation latch: the first stale tick reloads (cheap, keeps the HWND and its
/// hard-won click-through / topmost styles); only if the page is still silent a
/// tick later do we pay for the full destroy + recreate.
static OSD_RELOAD_TRIED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// How long the overlay page may stay silent before it counts as dead. The page
/// beats every second — including from its idle/parked short-circuit — so this
/// is ~180 missed beats: far beyond any GC pause, monitor switch or occlusion
/// hiccup, yet short enough that a dead OSD heals in minutes instead of never.
const OSD_BEAT_STALE_MS: u64 = 180_000;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Liveness beat from the overlay page (1 Hz, from `OsdOverlay.tsx`).
///
/// Sync on purpose, and the one kind of body that is allowed to be: a single
/// relaxed atomic store, no locks, no IO, no child processes — nanoseconds on
/// the main thread (CLAUDE.md rule 1 guards against slow sync bodies, not
/// against a `store`). Making it async would buy a blocking-pool hop every
/// second to run one instruction.
#[tauri::command]
pub fn osd_heartbeat() {
    OSD_BEAT_MS.store(now_ms(), std::sync::atomic::Ordering::Relaxed);
}

/// Has the overlay page gone silent past [`OSD_BEAT_STALE_MS`]? `false` while
/// the stamp is unset (window never created — the keep-alive path covers that),
/// so a missing OSD is never mistaken for a crashed one.
fn osd_page_stale() -> bool {
    let last = OSD_BEAT_MS.load(std::sync::atomic::Ordering::Relaxed);
    last != 0 && now_ms().saturating_sub(last) > OSD_BEAT_STALE_MS
}

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
///
/// …and the PAGE's watchdog: a window that exists and looks healthy can still be
/// hosting a dead renderer (see [`OSD_BEAT_MS`]). A silent page is reloaded on
/// the first stale tick and, if that doesn't revive it, rebuilt on the next —
/// self-healing in ≤3-4 min instead of never.
pub fn start_gdi_guard(app: AppHandle) {
    std::thread::Builder::new()
        .name("gdi-guard".into())
        .spawn(move || {
            use std::sync::atomic::Ordering;
            use windows::Win32::System::Threading::{
                GetCurrentProcess, GetGuiResources, GR_GDIOBJECTS,
            };
            loop {
                std::thread::sleep(std::time::Duration::from_secs(60));
                // Teardown gate: during quit every window call here races tao's and
                // WebView2's own shutdown, and a "helpful" recreate mid-exit builds a
                // window nothing is left to close — the app then hangs on a window it
                // resurrected itself. Do nothing at all once quitting has begun.
                if crate::SHUTTING_DOWN.load(Ordering::SeqCst) {
                    continue;
                }
                let gdi = unsafe { GetGuiResources(GetCurrentProcess(), GR_GDIOBJECTS) };

                // Page liveness. Only meaningful while the window actually exists —
                // when it doesn't, the keep-alive below recreates it anyway, and a
                // recreate reseeds the stamp.
                let mut dead_page = false;
                if app.get_webview_window(OSD_LABEL).is_some() && osd_page_stale() {
                    if OSD_RELOAD_TRIED.swap(true, Ordering::Relaxed) {
                        // Still silent a full tick after the reload: the renderer is
                        // gone for good, so fall through to destroy + recreate below.
                        dead_page = true;
                    } else {
                        tracing::warn!(
                            stale_ms = OSD_BEAT_STALE_MS,
                            "OSD page stopped beating — renderer likely crashed (wry registers no WebView2 ProcessFailed handler); reloading the overlay"
                        );
                        let handle = app.clone();
                        let _ = app.run_on_main_thread(move || {
                            if crate::SHUTTING_DOWN.load(Ordering::SeqCst) {
                                return;
                            }
                            if let Some(win) = handle.get_webview_window(OSD_LABEL) {
                                if let Err(e) = win.reload() {
                                    tracing::warn!("OSD reload failed: {e}");
                                }
                            }
                        });
                        // Give the reload a whole tick to boot and beat before
                        // escalating; a reload keeps the window's click-through and
                        // topmost styles, a rebuild has to re-earn them.
                        continue;
                    }
                } else {
                    OSD_RELOAD_TRIED.store(false, Ordering::Relaxed);
                }

                if gdi < GDI_RECYCLE_THRESHOLD && !dead_page {
                    // Keep-alive + style re-assert (cheap window calls, main thread).
                    let handle = app.clone();
                    let _ = app.run_on_main_thread(move || {
                        if crate::SHUTTING_DOWN.load(Ordering::SeqCst) {
                            return;
                        }
                        if let Err(e) = osd_set_visible(handle.clone(), true) {
                            tracing::warn!("OSD keep-alive ensure failed: {e}");
                        }
                    });
                    continue;
                }
                if dead_page {
                    tracing::warn!(
                        gdi,
                        "OSD page still silent after a reload — rebuilding the overlay window"
                    );
                } else {
                    tracing::warn!(
                        gdi,
                        "GDI handles nearing the 10k cap (upstream transparent-window leak, tauri#11525) — recycling the OSD window"
                    );
                }
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || {
                    if crate::SHUTTING_DOWN.load(Ordering::SeqCst) {
                        return;
                    }
                    // Recycle the corner/free OSD window — a transparent host that
                    // leaks GDI objects upstream. destroy() skips the close-request
                    // path (the overlay is non-closable for the user). The taskbar
                    // monitor is a native GDI window on its own thread (taskbar_mon.rs)
                    // with cached, never-per-paint GDI objects, so it is NOT part of
                    // this leak class and is left untouched.
                    if let Some(win) = handle.get_webview_window(OSD_LABEL) {
                        let _ = win.destroy();
                    }
                    // `destroy()` is POSTED, not immediate (tao routes it through the
                    // event-loop proxy), and tauri only drops the "osd" label once it
                    // processes the resulting Destroyed event. Recreating inline here
                    // therefore found the DYING window still registered,
                    // `ensure_overlay_window` took its idempotent early-return path,
                    // and no replacement was built until the next 60 s tick — the
                    // overlay blanked for a full minute on every recycle. So: wait for
                    // the destroy to land, then recreate.
                    //
                    // The hop through a plain background thread is REQUIRED, not
                    // decorative: `run_on_main_thread` called FROM the main thread runs
                    // its closure INLINE, so sleeping in-place would stall the window's
                    // message pump for 100 ms (the "未响应" class, rules 1 + 2).
                    let h = handle.clone();
                    std::thread::Builder::new()
                        .name("osd-recycle".into())
                        .spawn(move || {
                            std::thread::sleep(std::time::Duration::from_millis(100));
                            if crate::SHUTTING_DOWN.load(Ordering::SeqCst) {
                                return;
                            }
                            let h2 = h.clone();
                            let _ = h.run_on_main_thread(move || {
                                if crate::SHUTTING_DOWN.load(Ordering::SeqCst) {
                                    return;
                                }
                                if let Err(e) = osd_set_visible(h2.clone(), true) {
                                    tracing::warn!("OSD recreate after recycle failed: {e}");
                                }
                            });
                        })
                        .ok();
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

/// Whether the last [`ensure_topmost`] pass found the overlay demoted below a
/// non-topmost window. Edge-triggered logging: one WARN per demotion event (the
/// culprit's class is the field evidence for what triggers it), silence while
/// healthy.
static OSD_DEMOTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Class name of a window, lossy, for log lines only.
pub(crate) unsafe fn class_name(hwnd: HWND) -> String {
    let mut buf = [0u16; 64];
    let n = GetClassNameW(hwnd, &mut buf).max(0) as usize;
    String::from_utf16_lossy(&buf[..n])
}

/// Re-assert the overlay's always-on-top z-order (see the module docs). MUST
/// run on the window's owner thread (the main thread) - every caller is a sync
/// command or a `run_on_main_thread` closure. Cost: a ~20-window `GW_HWNDPREV`
/// walk and, only when we were actually demoted, one `SetWindowPos`; in the
/// steady state it is a pure read loop.
///
/// Trigger: a VISIBLE window above us that lacks `WS_EX_TOPMOST`. That is the
/// exact rude-app demotion signature - Windows re-links the overlay below the
/// whole non-topmost band while leaving its topmost STYLE bit set, so the style
/// alone can never detect it.
///
/// Deliberately NOT triggered by a topmost window sitting above us: CorePilot's
/// own taskbar plate re-asserts `HWND_TOPMOST` once a second
/// (`taskbar_mon.rs`), so "raise whenever anything is above me" made the two
/// windows leapfrog each other forever. Within the topmost band, last-asserter-
/// wins is normal Windows behaviour and the two never overlap on screen.
/// `SWP_NOACTIVATE` keeps focus on the game.
fn ensure_topmost(hwnd_raw: isize) {
    use std::sync::atomic::Ordering;
    if hwnd_raw == 0 {
        return;
    }
    let hwnd = HWND(hwnd_raw as *mut core::ffi::c_void);
    unsafe {
        // A hidden HWND can never be seen no matter its z-order; tao's cached
        // VISIBLE flag makes `win.show()` a no-op, so re-show natively.
        if !IsWindowVisible(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_SHOWNA);
        }
        let mut culprit: Option<HWND> = None;
        let mut cur = GetWindow(hwnd, GW_HWNDPREV).unwrap_or_default();
        while !cur.0.is_null() {
            if IsWindowVisible(cur).as_bool()
                && GetWindowLongPtrW(cur, GWL_EXSTYLE) & WS_EX_TOPMOST.0 as isize == 0
            {
                culprit = Some(cur);
                break; // first non-topmost window above us is proof enough
            }
            cur = GetWindow(cur, GW_HWNDPREV).unwrap_or_default();
        }
        let Some(c) = culprit else {
            OSD_DEMOTED.store(false, Ordering::Relaxed);
            return;
        };
        if !OSD_DEMOTED.swap(true, Ordering::Relaxed) {
            tracing::warn!(
                culprit_class = %class_name(c),
                "OSD overlay found below a non-topmost window (fullscreen-app demotion) - re-asserting HWND_TOPMOST"
            );
        }
        let _ = SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
    }
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
        // NOTE: `show()` / `set_always_on_top(true)` are flag-cached no-ops in tao
        // once set; the native re-assert below is what actually restores a
        // demoted or hidden HWND (see module docs).
        let _ = win.show();
        let _ = win.set_always_on_top(true);
        ensure_topmost(hwnd_of(&win));
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

    // The new window starts at the 64×48 above, but `LAST_OSD_SIZE` still holds
    // the size of the window we just replaced — so the first `osd_set_bounds`
    // after a recreate would dedupe its `set_size` away and leave the plate
    // clipped inside a 64×48 window. Worst while the overlay is parked: park →
    // park never changes the key at all, so the rebuilt window would keep the
    // stale size until the plate's dimensions happened to change. Clear the key
    // so the next bounds call always re-applies the size.
    LAST_OSD_SIZE.store(0, std::sync::atomic::Ordering::Relaxed);
    // Seed the page-liveness stamp: the page needs a few seconds to boot and
    // send its first beat, and a brand-new window must never read as dead (see
    // `OSD_BEAT_MS`) — that would loop rebuild → "stale" → rebuild forever.
    OSD_BEAT_MS.store(now_ms(), std::sync::atomic::Ordering::Relaxed);

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
/// GDI-recycle (see [`GDI_RECYCLE_THRESHOLD`]) whose window rebuild once hung the
/// main thread; quantizing is what took that recycle from hourly to daily. Snapping to
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
        // Z-order keep-alive: this runs about 1 Hz while the plate shows (every
        // data tick re-measures the plate), so a fullscreen-app demotion is
        // undone within a second. See the module docs / `ensure_topmost`.
        //
        // Skipped while the overlay is PARKED. The frontend hides the plate by
        // parking a 1x1 window at (-200,-200) rather than hiding it (a hidden
        // WebView2 page freezes its task loop — the original "monitor
        // disappears" failure). That coordinate is only off-screen on a
        // single-monitor desk: a display arranged to the left of the primary
        // occupies negative x, so on this machine the park spot lands INSIDE the
        // left monitor. Raising a parked window is therefore both pointless and
        // the one case where it could put a stray pixel on a real screen. The
        // next real bounds push — the one that un-parks it — does the re-assert.
        if cw > OSD_MIN_DIM || ch > OSD_MIN_DIM {
            ensure_topmost(hwnd_of(&win));
        }
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
