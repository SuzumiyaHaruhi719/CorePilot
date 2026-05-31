mod affinity;
mod commands;
mod error;
mod process;
mod state;
mod sysmon;
mod topology;

use state::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .try_init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(AppState::new())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                #[cfg(target_os = "windows")]
                {
                    // Premium Windows 11 acrylic backdrop behind the UI.
                    let _ = window_vibrancy::apply_acrylic(&window, Some((8, 10, 16, 175)));
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_topology,
            commands::get_overview,
            commands::list_processes,
            commands::get_metrics,
            commands::set_affinity,
            commands::get_process_affinity,
            commands::set_priority,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
