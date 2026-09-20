pub mod affinity;
pub mod commands;
pub mod debug_log;
pub mod disk_scan;
pub mod disk_scan_mft;
pub mod error;
pub mod fan;
pub mod fan_autotune;
pub mod fps;
pub mod game_library;
pub mod gpu;
pub mod gpu_guard;
pub mod gpu_load;
pub mod inject;
pub mod load_gen;
pub mod netfix;
pub mod nvapi_oc;
pub mod optimize;
pub mod osd;
pub mod overlay;
pub mod overlay_inject;
pub mod perf_recorder;
pub mod persist;
pub mod process;
pub mod process_icon;
pub mod sampler;
pub mod sensors;
pub mod serde_u64;
pub mod smu;
pub mod state;
pub mod sysmon;
pub mod taskbar_mon;
pub mod telemetry;
pub mod topology;
pub mod tray;
pub mod tweaks;
pub mod ui_visibility;
pub mod updater;
pub mod watchdog;
pub mod winsvc;

use state::AppState;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use tauri::{Emitter, Manager};

pub static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);
static EXIT_CODE: AtomicI32 = AtomicI32::new(0);

/// Chromium / WebView2 command-line flags applied to every CorePilot webview.
///
/// The OSD overlay and the perf recorder must keep their JS timers running while
/// a game holds the foreground — which means CorePilot's own windows are both
/// *backgrounded* and *occluded*. The first three switches disable the regular
/// background timer / renderer throttling. The two `disable-features` are the
/// ones that actually matter for an overlay:
/// * `CalculateNativeWinOcclusion` — without disabling it Chromium detects the
///   occluded window, marks the page **hidden**, and freezes its task scheduler
///   (timers fire at most once, incoming events stall) — exactly our symptom.
/// * `IntensiveWakeUpThrottling` — the "≤1 wake per minute" clamp applied to
///   pages hidden for >5 min.
///
/// `--no-proxy-server` is the third critical one: CorePilot only ever loads LOCAL
/// assets (the embedded UI is served from `http://tauri.localhost`), but WebView2
/// otherwise inherits the system proxy. A system proxy like Clash whose bypass
/// list doesn't cover the dotted `tauri.localhost` host routes the app's own
/// assets through the proxy, which can't serve them — the window comes up black.
/// Disabling the proxy for our local-only WebView fixes that regardless of the
/// user's proxy config (backend network ops are unaffected — they're native).
///
/// INVARIANT: this string MUST stay byte-identical to `additionalBrowserArgs`
/// in `tauri.conf.json` (the main window's args). All webviews share one
/// browser process per user-data-dir, and WebView2 refuses to attach a webview
/// whose requested environment options differ from the running browser's
/// (`ERROR_INVALID_STATE`) — the OSD window then can never be created and its
/// keep-alive fails silently forever. Field failure 2026-07-11: WebView2
/// Runtime 150 stopped merging the `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` env
/// var, so the previously-tolerated drift between the two strings (this one
/// carried `--remote-debugging-port=9222` for release-build CDP diagnosis)
/// became a hard mismatch and the OSD window vanished. Any new switch must be
/// added to BOTH places or neither.
pub const WEBVIEW_ARGS: &str = "--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --no-proxy-server --disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling";

#[cfg(test)]
mod config_tests {
    use super::WEBVIEW_ARGS;

    #[test]
    fn webview_args_match_tauri_conf() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("valid tauri config");
        assert_eq!(
            config["app"]["windows"][0]["additionalBrowserArgs"]
                .as_str()
                .expect("additionalBrowserArgs is a string"),
            WEBVIEW_ARGS
        );
    }
}

/// CRITICAL-PATH INVARIANT (see docs/superpowers/specs/2026-06-21-critical-path-isolation-design.md):
/// Tauri v2 runs the event loop AND routes every window's IPC on the MAIN thread.
/// Therefore no main-thread `#[tauri::command]` (a non-`async` command), no
/// `run_on_main_thread` closure, and no holder of a read-path lock (`SAMPLER`,
/// `state.sys`) may perform an operation that can block more than a few ms — doing
/// so freezes ALL readings in ALL windows. Slow/blocking work goes on `async`
/// commands via `spawn_blocking`, or on a dedicated background thread.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Full-granularity logging captured since launch. The TeeWriter mirrors every
    // formatted line to stderr AND an in-memory buffer, so the Settings → Debug
    // button can dump the complete session log to the Downloads folder. Our own
    // crates log at TRACE (finest), everything else at INFO (still captures every
    // warning/error). `RUST_LOG` overrides this if set.
    let filter = tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        tracing_subscriber::EnvFilter::new("info,corepilot=trace,corepilot_lib=trace")
    });
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_ansi(false)
        .with_writer(|| debug_log::TeeWriter)
        .try_init();

    // Record panics into the same log stream (so a crash is captured in the debug
    // export) while preserving the default panic output. Panics ALSO append to
    // a persistent crash.log next to the store: a main-thread panic kills the
    // app with no WER entry, no dump, no event-log record — without this file a
    // field crash leaves literally zero trace (learned 2026-06-11).
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        tracing::error!("PANIC: {info}");
        let epoch = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let bt = std::backtrace::Backtrace::force_capture();
        if let Ok(appdata) = std::env::var("APPDATA") {
            let dir = std::path::Path::new(&appdata).join("com.corepilot.app");
            let _ = std::fs::create_dir_all(&dir);
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join("crash.log"))
            {
                use std::io::Write;
                let _ = writeln!(
                    f,
                    "[epoch {epoch}] CorePilot {} PANIC: {info}\n{bt}\n---",
                    env!("CARGO_PKG_VERSION")
                );
            }
        }
        default_hook(info);
    }));

    tracing::info!("CorePilot {} starting", env!("CARGO_PKG_VERSION"));

    // Portable self-update handoff. The outgoing instance swaps the program
    // files, spawns this one with `--await-predecessor <pid>`, then exits. We
    // MUST outlast it before the builder below registers the single-instance
    // plugin: otherwise this process finds the old one still alive, hands its
    // argv over to something that is about to die, and quits — leaving no
    // CorePilot running at all. See `updater::portable_install`.
    if let Some(pid) = updater::predecessor_arg(std::env::args()) {
        tracing::info!("waiting for predecessor pid {pid} to exit before starting");
        updater::await_predecessor(pid, std::time::Duration::from_secs(10));
    }

    // Enable SeDebugPrivilege once at startup. Even when CorePilot runs elevated,
    // OpenProcess(PROCESS_SET_INFORMATION) can fail on some processes (services,
    // other-context, or elevated peers like our own sensord sidecar) without this
    // privilege — which is exactly the gate affinity/priority control uses. With
    // it, the settable-probe and set_affinity succeed on the broadest set of
    // processes. Best-effort: log and continue if it can't be enabled.
    if let Err(e) = optimize::enable_privilege("SeDebugPrivilege") {
        tracing::warn!("failed to enable SeDebugPrivilege: {e}");
    }

    // WebView2 / Chromium aggressively throttle (or pause) JS timers in
    // background / occluded windows. But the in-game OSD overlay and the perf
    // recorder both poll on a setInterval and MUST keep running while a *game*
    // holds the foreground (so CorePilot's own windows are in the background).
    // Disable that throttling for every webview, or the OSD goes stale and the
    // recorder stops sampling exactly when it matters.
    std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", WEBVIEW_ARGS);

    let builder = tauri::Builder::default()
        // MUST be the first plugin. A second launch hands its argv to THIS running
        // instance — we focus the existing main window — and then exits, instead of
        // spawning a parallel instance. Parallel instances are what produced the
        // zombie processes fighting over the fixed `CorePilot-FPS` ETW session
        // (game detection broke → OSD never showed) and multiplied the expensive
        // \GPU Engine(*) collects.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
                // Re-open the frontend's polling gate: a second launch is an
                // explicit "show me the app", and this path bypasses `show_main`.
                ui_visibility::set_main_hidden(false);
            } else {
                app.exit(0);
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::new())
        .manage(tray::TrayPrefs::default())
        .setup(|app| {
            // Critical-path tripwire: log loudly if the main thread (the IPC router)
            // ever stalls. Observability only; see crate::watchdog.
            crate::watchdog::start(app.handle().clone());

            // Reaching this point means the current binaries launched, so any
            // `<name>.old` left by a portable update is now provably disposable.
            crate::updater::cleanup_stale();

            // An installer update can land the app somewhere other than where the
            // autostart scheduled task points (a per-user ↔ per-machine install
            // flip moves the exe), and a task aimed at a path that no longer
            // exists fails silently at boot. Re-aim it at the running exe.
            crate::commands::repair_autostart_path();

            // Start the background GPU-engine telemetry collector first (the ONE
            // shared \GPU Engine(*) collect feeding sensors / process list /
            // gpu_engine_loads). It self-starts on first read too, but start it
            // eagerly so the first UI poll already has data.
            crate::telemetry::start();

            // Start the single-owner system sampler (process list / metrics /
            // sensors snapshots). The ONLY caller that refreshes the System or
            // samples sensors; commands read its snapshots. See crate::sampler.
            crate::sampler::start(app.handle().clone());

            // A tray failure must never crash startup; log and continue. The
            // close handler below only hides to the tray when the tray exists,
            // so a missing tray degrades to a normal (exit-on-close) window.
            if let Err(err) = tray::build_tray(app.handle()) {
                tracing::warn!("failed to build system tray: {err}");
            }

            // Bring up the OSD overlay as a KEEP-ALIVE window at startup. A shown,
            // always-on-top WebView2 window keeps the shared renderer's task loop
            // running; without it the renderer freezes whenever CorePilot is
            // backgrounded (e.g. a game holds the foreground), which is what
            // silently killed the overlay's metric poll and the perf recorder.
            // The overlay parks itself off-screen when there is nothing to show.
            let _ = osd::osd_set_visible(app.handle().clone(), true);

            // GDI watchdog: survive the upstream transparent-window GDI leak
            // (tauri#11525) by recycling the OSD window before the 10k cap —
            // without it the app silently dies after ~5 hours (see osd.rs).
            osd::start_gdi_guard(app.handle().clone());

            // Start the in-game OSD sampler. This creates the ONE long-lived
            // shared-memory writer (kept alive for the whole app lifetime so the
            // injected overlay DLL never loses the mapping) and loops at ~3 Hz,
            // publishing metrics while a game is attached and idling otherwise.
            overlay_inject::start_sampler(app.handle().clone());

            // Start the backend per-game performance recorder. This MOVES the
            // perf-session recording off the main webview (which freezes when a
            // GPU-heavy game holds the foreground, silently dropping ~1/3 of
            // sessions) onto a native thread that is immune to that freeze. It
            // samples while a recordable game runs and emits `perf://session` on
            // game exit; the frontend persists + shows the report.
            perf_recorder::start_recorder(app.handle().clone());

            // Start the NATIVE Win32/GDI taskbar monitor on its OWN dedicated
            // thread + message loop. It reads the in-process sampler snapshots
            // directly (no IPC) and owner-draws a docked plate on the taskbar,
            // shown only while its `tbEnabled` config (pushed via tbmon_config)
            // is on. It NEVER touches the Tauri main thread — replacing the prior
            // transparent-WebView2 taskbar window (the main-thread create-hang /
            // GDI-leak freeze class).
            taskbar_mon::start(app.handle().clone());

            // Start the motherboard fan-control engine. It idles until the
            // frontend pushes a per-fan config (mode/curve), then drives the
            // sidecar's fan controls every ~2s. Safe no-op on locked boards.
            fan::start_engine();

            // Publish the main window's HWND and start the native visibility
            // watcher. WEBVIEW_ARGS deliberately disables Chromium's occlusion
            // throttling (the OSD/recorder freeze class), so NOTHING stops the
            // main page's timers while it sits in the tray or behind a game —
            // this is what lets the frontend gate its own polling instead.
            // We never hide/suspend a webview to achieve that.
            if let Some(main) = app.get_webview_window("main") {
                ui_visibility::set_main_hwnd(main.hwnd().map(|h| h.0 as isize).unwrap_or(0));
            }
            ui_visibility::start();

            Ok(())
        })
        .on_window_event(|window, event| {
            // Focus is the one transition the user *feels*: alt-tab back and the
            // numbers must be live on the next frame, not up to 2 s later when
            // the ui-vis thread ticks. So mirror it straight to the frontend
            // (and to the occlusion flag) as an edge.
            //
            // NOTE: only the main window, and only a state update + an emit —
            // never a call into the OSD window from here (rule 2). Losing focus
            // is deliberately NOT a gate: CorePilot on a second monitor while a
            // game owns the first must keep updating, which only the native
            // monitor-equality test in `ui_visibility` can decide.
            if let tauri::WindowEvent::Focused(focused) = event {
                if window.label() == "main" {
                    ui_visibility::note_focus(*focused);
                    let _ = window.app_handle().emit_to("main", "app://focus", *focused);
                }
                return;
            }
            // "Close to tray": hide the main window instead of exiting, so the
            // affinity enforcer, GPU auto-OC and OSD keep running in the
            // background. Honoured only when the user has the setting enabled.
            if let tauri::WindowEvent::Destroyed = event {
                if window.label() == "main" && !SHUTTING_DOWN.load(Ordering::SeqCst) {
                    window.app_handle().exit(0);
                }
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // The OSD overlay must NEVER be user-closable: when WebView2's
                // intermittent ex-style reset let it surface as a focusable
                // phantom window, Alt-F4 destroyed it and the overlay stayed
                // gone until restart (only the GDI-guard recycle recreates it).
                if window.label() == "osd" {
                    api.prevent_close();
                    return;
                }
                if window.label() == "main"
                    && window.state::<tray::TrayPrefs>().close_to_tray()
                    && window.app_handle().tray_by_id("corepilot-tray").is_some()
                {
                    api.prevent_close();
                    let _ = window.hide();
                    // Remember when it went to the tray: a long-hidden WebView2
                    // renderer can be discarded → blank on restore, so show_main
                    // reloads it past a threshold.
                    window.state::<tray::TrayPrefs>().mark_hidden();
                    // Close the frontend's polling gate and drop sensord to its
                    // idle cadence on the transition, not up to 2 s later. This
                    // is the ONLY window we ever hide — the OSD keep-alive
                    // window stays shown so the shared WebView2 renderer's task
                    // loop never freezes (the overlay/recorder death class).
                    ui_visibility::set_main_hidden(true);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            debug_log::export_debug_logs,
            commands::get_topology,
            commands::get_overview,
            commands::list_processes,
            process_icon::process_icon,
            process::gpu_engine_loads,
            commands::get_metrics,
            commands::set_affinity,
            commands::get_process_affinity,
            commands::set_priority,
            commands::get_memory_detail,
            commands::free_working_sets,
            commands::purge_standby,
            commands::clean_temp,
            commands::flush_dns,
            commands::end_task,
            commands::restart_task,
            commands::get_sensors,
            commands::reveal_in_explorer,
            disk_scan::startup_directive,
            disk_scan::disk_list_volumes,
            disk_scan::disk_scan_start,
            disk_scan::disk_scan_cancel,
            disk_scan::disk_scan_status,
            disk_scan::disk_tree,
            disk_scan::disk_top_items,
            commands::get_power_plan,
            commands::set_power_plan,
            commands::list_services,
            commands::control_service,
            commands::list_startup,
            commands::set_startup_enabled,
            commands::pick_exe_files,
            netfix::network_diagnose,
            netfix::network_repair,
            gpu::gpu_oc_info,
            gpu::gpu_oc_apply,
            gpu::gpu_oc_reset,
            gpu_guard::gpu_oc_startup_check,
            fan::fan_info,
            fan::fan_set_config,
            fan::fan_calibrate,
            fan_autotune::fan_autotune_start,
            fan_autotune::fan_autotune_abort,
            fan_autotune::fan_autotune_resynth,
            fan_autotune::passive::fan_passive_configure,
            fan_autotune::passive::fan_passive_status,
            tweaks::tweak_apply,
            tweaks::tweak_revert,
            tweaks::create_restore_point,
            osd::osd_set_visible,
            osd::osd_set_bounds,
            osd::osd_target_monitor,
            osd::osd_heartbeat,
            taskbar_mon::tbmon_config,
            fps::osd_fps,
            fps::osd_fps_stats,
            fps::foreground_process,
            fps::foreground_info,
            fps::pid_alive,
            game_library::game_library_list,
            overlay_inject::overlay_attach,
            overlay_inject::overlay_detach,
            overlay_inject::overlay_status,
            overlay_inject::overlay_set_auto,
            overlay_inject::overlay_set_palette,
            perf_recorder::perf_recorder_config,
            persist::persist_get,
            persist::persist_set,
            persist::persist_delete,
            persist::perf_session_save,
            persist::perf_session_load,
            persist::perf_session_delete,
            persist::perf_session_delete_all,
            persist::perf_session_ids,
            tray::set_close_to_tray,
            ui_visibility::ui_occluded,
            commands::set_acrylic,
            commands::set_window_opacity,
            commands::get_autostart,
            commands::set_autostart,
            updater::update_check,
            updater::update_install,
            commands::smu_status,
            commands::smu_apply_co,
            commands::smu_apply_co_all,
            commands::smu_apply_limit,
            commands::smu_set_scalar,
            commands::smu_force_stock,
        ]);
    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application");
    app.run(|app, event| match event {
        tauri::RunEvent::ExitRequested { code, .. } => {
            SHUTTING_DOWN.store(true, Ordering::SeqCst);
            EXIT_CODE.store(code.unwrap_or(0), Ordering::SeqCst);
        }
        tauri::RunEvent::Exit => {
            SHUTTING_DOWN.store(true, Ordering::SeqCst);
            let code = EXIT_CODE.load(Ordering::SeqCst);
            if code == tauri::RESTART_EXIT_CODE {
                return;
            }
            updater::shutdown_teardown();
            // Flush HERE, not inside `shutdown_teardown`: that body is behind a
            // once-guard, so on the portable-update path (which tears down before
            // the file swap) a flush inside it is already spent by the time the
            // process really exits — and `std::process::exit` below would drop the
            // last debounce window of store writes.
            persist::flush();
            app.cleanup_before_exit();
            std::process::exit(code);
        }
        _ => {}
    });
}
