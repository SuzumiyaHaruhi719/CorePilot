//! Tauri command surface (IPC). Affinity masks are u64 on this side but cross
//! the boundary as decimal strings (a JS number only holds integers < 2^53, too
//! few bits for a 64-logical-CPU mask); see `serde_u64`.

use crate::affinity;
use crate::error::CoreResult;
use crate::optimize::{self, CleanResult, MemDetail};
use crate::process::{self, ProcInfo};
use crate::state::AppState;
use crate::sysmon::{self, Metrics};
use crate::topology::CpuTopology;
use serde::Serialize;
use sysinfo::System;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub cpu_name: String,
    pub physical_cores: u32,
    pub logical_cpus: u32,
    pub ram_total: u64,
    pub os: String,
    pub vcache_ccd: Option<u32>,
    pub detection: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AffinityInfo {
    // Affinity masks are serialized as decimal strings so bits ≥ 53 survive the
    // JS-number (f64) frontend boundary; see `serde_u64`.
    #[serde(with = "crate::serde_u64::str")]
    pub proc_mask: u64,
    #[serde(with = "crate::serde_u64::str")]
    pub sys_mask: u64,
}

#[tauri::command]
pub fn get_topology(state: State<AppState>) -> CpuTopology {
    state.topo.clone()
}

#[tauri::command]
pub fn get_overview(state: State<AppState>) -> Overview {
    let sys = state.sys.lock();
    let cpu_name = sys
        .cpus()
        .first()
        .map(|c| c.brand().trim().to_string())
        .unwrap_or_else(|| "Unknown CPU".into());
    Overview {
        cpu_name,
        physical_cores: state.topo.physical_cores,
        logical_cpus: state.topo.logical_count,
        ram_total: sys.total_memory(),
        os: System::long_os_version().unwrap_or_default(),
        vcache_ccd: state.topo.vcache_ccd,
        detection: state.topo.detection.clone(),
    }
}

#[tauri::command]
pub fn list_processes(state: State<AppState>) -> Vec<ProcInfo> {
    let logical = state.topo.logical_count.max(1) as f32;
    let threads = process::thread_counts().unwrap_or_default();
    let mut sys = state.sys.lock();
    process::list(&mut sys, &threads, logical)
}

#[tauri::command]
pub fn get_metrics(state: State<AppState>) -> Metrics {
    let mut sys = state.sys.lock();
    sysmon::sample(&mut sys)
}

/// Pin a process to a logical-CPU mask. The mask arrives as a decimal string
/// (it can exceed 2^53, which a JS number can't represent exactly); parse it to
/// a `u64` before delegating to the affinity setter.
#[tauri::command]
pub fn set_affinity(pid: u32, mask: String) -> CoreResult<()> {
    let mask: u64 = mask
        .parse()
        .map_err(|_| crate::error::CoreError::from(format!("invalid affinity mask: {mask}")))?;
    affinity::set_affinity(pid, mask)
}

#[tauri::command]
pub fn get_process_affinity(pid: u32) -> CoreResult<AffinityInfo> {
    let (proc_mask, sys_mask) = affinity::get_affinity(pid)?;
    Ok(AffinityInfo {
        proc_mask,
        sys_mask,
    })
}

#[tauri::command]
pub fn set_priority(pid: u32, class: u32) -> CoreResult<()> {
    affinity::set_priority(pid, class)
}

#[tauri::command]
pub fn get_memory_detail() -> CoreResult<MemDetail> {
    optimize::memory_detail()
}

#[tauri::command]
pub fn free_working_sets() -> CoreResult<()> {
    optimize::free_working_sets()
}

#[tauri::command]
pub fn purge_standby() -> CoreResult<()> {
    optimize::purge_standby()
}

#[tauri::command]
pub fn clean_temp() -> CoreResult<CleanResult> {
    Ok(optimize::clean_temp())
}

#[tauri::command]
pub fn flush_dns() -> CoreResult<()> {
    optimize::flush_dns()
}

#[tauri::command]
pub fn end_task(pid: u32) -> CoreResult<()> {
    process::kill(pid)
}

#[tauri::command]
pub fn get_sensors() -> crate::error::CoreResult<crate::sensors::SensorSample> {
    Ok(crate::sensors::sample())
}

#[tauri::command]
pub fn get_power_plan() -> CoreResult<String> {
    optimize::get_power_plan()
}

#[tauri::command]
pub fn set_power_plan(plan: String) -> CoreResult<()> {
    optimize::set_power_plan(&plan)
}

#[tauri::command]
pub fn list_services() -> CoreResult<Vec<crate::winsvc::ServiceItem>> {
    crate::winsvc::list_services()
}

#[tauri::command]
pub fn control_service(name: String, action: String) -> CoreResult<()> {
    crate::winsvc::control_service(name, action)
}

#[tauri::command]
pub fn list_startup() -> CoreResult<Vec<crate::winsvc::StartupItem>> {
    crate::winsvc::list_startup()
}

#[tauri::command]
pub fn set_startup_enabled(name: String, location: String, enabled: bool) -> CoreResult<()> {
    crate::winsvc::set_startup_enabled(name, location, enabled)
}
