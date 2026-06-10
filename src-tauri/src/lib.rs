pub mod affinity;
pub mod commands;
pub mod debug_log;
pub mod error;
pub mod fan;
pub mod fan_autotune;
pub mod fps;
pub mod game_library;
pub mod gpu;
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
pub mod process;
pub mod process_icon;
pub mod sensors;
pub mod smu;
pub mod serde_u64;
pub mod state;
pub mod sysmon;
pub mod topology;
pub mod tray;
pub mod tweaks;
pub mod winsvc;

use state::AppState;
use tauri::Manager;

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
pub const WEBVIEW_ARGS: &str = "--disable-background-timer-throttling \
     --disable-renderer-backgrounding --disable-backgrounding-occluded-windows \
     --no-proxy-server \
     --disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Full-granularity logging captured since launch. The TeeWriter mirrors every
    // formatted line to stderr AND an in-memory buffer, so the Settings → Debug
    // button can dump the complete session log to the Downloads folder. Our own
    // crates log at TRACE (finest), everything else at INFO (still captures every
    // warning/error). `RUST_LOG` overrides this if set.
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,corepilot=trace,corepilot_lib=trace"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_ansi(false)
        .with_writer(|| debug_log::TeeWriter)
        .try_init();

    // Record panics into the same log stream (so a crash is captured in the debug
    // export) while preserving the default panic output.
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        tracing::error!("PANIC: {info}");
        default_hook(info);
    }));

    tracing::info!("CorePilot {} starting", env!("CARGO_PKG_VERSION"));

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

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState::new())
        .manage(tray::TrayPrefs::default())
        .setup(|app| {
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

            // Start the motherboard fan-control engine. It idles until the
            // frontend pushes a per-fan config (mode/curve), then drives the
            // sidecar's fan controls every ~2s. Safe no-op on locked boards.
            fan::start_engine();

            Ok(())
        })
        .on_window_event(|window, event| {
            // "Close to tray": hide the main window instead of exiting, so the
            // affinity enforcer, GPU auto-OC and OSD keep running in the
            // background. Honoured only when the user has the setting enabled.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
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
            commands::get_sensors,
            commands::reveal_in_explorer,
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
            tray::set_close_to_tray,
            commands::set_acrylic,
            commands::set_window_opacity,
            commands::get_autostart,
            commands::set_autostart,
            commands::smu_status,
            commands::smu_apply_co,
            commands::smu_apply_co_all,
            commands::smu_apply_limit,
            commands::smu_set_scalar,
            commands::smu_force_stock,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
