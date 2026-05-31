//! Process enumeration with live metrics.

use crate::error::CoreResult;
use serde::Serialize;
use std::collections::HashMap;
use sysinfo::{ProcessesToUpdate, System};
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcInfo {
    pub pid: u32,
    pub name: String,
    pub cpu: f32,
    pub mem: u64,
    pub threads: u32,
    pub gpu: f32,
    pub power: f32,
}

/// One Toolhelp pass: thread count per owning PID.
pub fn thread_counts() -> CoreResult<HashMap<u32, u32>> {
    let mut map = HashMap::new();
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0)?;
        let mut entry: THREADENTRY32 = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
        if Thread32First(snapshot, &mut entry).is_ok() {
            loop {
                *map.entry(entry.th32OwnerProcessID).or_insert(0u32) += 1;
                entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
                if Thread32Next(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
    }
    Ok(map)
}

/// Refresh and snapshot all processes. `logical` is the logical-CPU count
/// used to normalize sysinfo's per-core CPU% into a Task-Manager-style total%.
pub fn list(sys: &mut System, threads: &HashMap<u32, u32>, logical: f32) -> Vec<ProcInfo> {
    sys.refresh_processes(ProcessesToUpdate::All, true);
    sys.processes()
        .iter()
        .map(|(pid, process)| {
            let id = pid.as_u32();
            ProcInfo {
                pid: id,
                name: process.name().to_string_lossy().to_string(),
                cpu: process.cpu_usage() / logical,
                mem: process.memory(),
                threads: threads.get(&id).copied().unwrap_or(0),
                gpu: 0.0,
                power: 0.0,
            }
        })
        .collect()
}
