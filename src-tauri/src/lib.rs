pub mod affinity;
pub mod commands;
pub mod error;
pub mod gpu;
pub mod nvapi_oc;
pub mod optimize;
pub mod process;
pub mod sensors;
pub mod state;
pub mod sysmon;
pub mod topology;
pub mod winsvc;

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .try_init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::get_topology,
            commands::get_overview,
            commands::list_processes,
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
            gpu::gpu_oc_info,
            gpu::gpu_oc_apply,
            gpu::gpu_oc_reset,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
