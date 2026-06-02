pub mod affinity;
pub mod commands;
pub mod error;
pub mod fps;
pub mod gpu;
pub mod inject;
pub mod netfix;
pub mod nvapi_oc;
pub mod optimize;
pub mod osd;
pub mod overlay;
pub mod overlay_inject;
pub mod process;
pub mod process_icon;
pub mod sensors;
pub mod serde_u64;
pub mod state;
pub mod sysmon;
pub mod topology;
pub mod tray;
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
pub const WEBVIEW_ARGS: &str = "--disable-background-timer-throttling \
     --disable-renderer-backgrounding --disable-backgrounding-occluded-windows \
     --disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .try_init();

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
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
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
            osd::osd_set_visible,
            osd::osd_set_bounds,
            fps::osd_fps,
            fps::osd_fps_stats,
            fps::foreground_process,
            fps::foreground_info,
            fps::pid_alive,
            overlay_inject::overlay_attach,
            overlay_inject::overlay_detach,
            overlay_inject::overlay_status,
            tray::set_close_to_tray,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
