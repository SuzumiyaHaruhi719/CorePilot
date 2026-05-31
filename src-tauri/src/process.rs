//! Process enumeration with live metrics.

use crate::error::CoreResult;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use sysinfo::{ProcessesToUpdate, System};
use windows::core::PCWSTR;
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
};
use windows::Win32::System::Performance::{
    PdhAddEnglishCounterW, PdhCollectQueryData, PdhGetFormattedCounterArrayW, PdhOpenQueryW,
    PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE, PDH_HCOUNTER, PDH_HQUERY, PDH_MORE_DATA,
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

/// PDH success return code (`ERROR_SUCCESS`).
const PDH_SUCCESS: u32 = 0;

/// Persistent PDH query for per-process GPU utilization.
///
/// PDH exposes `\GPU Engine(*)\Utilization Percentage` with one wildcard
/// instance per (process, adapter, engine). Each instance name encodes the
/// owning PID, e.g. `pid_1234_luid_0x00000000_0x0000C5DE_phys_0_eng_0_engtype_3D`.
/// The query is opened once and re-collected on every call; the first sample may
/// read all zero (PDH needs two collections to compute a rate) — that is fine.
struct GpuQuery {
    query: PDH_HQUERY,
    util: PDH_HCOUNTER, // wildcard array: \GPU Engine(*)\Utilization Percentage
}

// SAFETY: the PDH handles are raw pointers and thus not `Send` by default. They
// are only ever accessed from behind `GPU_QUERY`'s mutex, on whichever thread
// holds the lock. PDH queries are usable across threads when externally
// synchronized, which the mutex guarantees.
unsafe impl Send for GpuQuery {}

impl GpuQuery {
    /// Open the PDH query and add the GPU-engine utilization counter. Returns
    /// `None` on any failure so callers degrade gracefully (GPU% stays 0); never
    /// panics. Written `?`-free intentionally.
    fn open() -> Option<GpuQuery> {
        unsafe {
            let mut query = PDH_HQUERY::default();
            if PdhOpenQueryW(PCWSTR::null(), 0, &mut query) != PDH_SUCCESS {
                return None;
            }

            let path: Vec<u16> = r"\GPU Engine(*)\Utilization Percentage"
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect();
            let mut util = PDH_HCOUNTER::default();
            if PdhAddEnglishCounterW(query, PCWSTR(path.as_ptr()), 0, &mut util) != PDH_SUCCESS {
                return None;
            }

            // Prime the query so the next collection has a baseline to diff.
            let _ = PdhCollectQueryData(query);

            Some(GpuQuery { query, util })
        }
    }
}

/// Persistent GPU PDH query; `None` if PDH failed to initialize (then GPU% is
/// always 0). Opened once, lazily, on first access.
static GPU_QUERY: Lazy<Mutex<Option<GpuQuery>>> = Lazy::new(|| Mutex::new(GpuQuery::open()));

/// Parse the integer PID out of a `\GPU Engine` instance name. The name starts
/// with `pid_<number>_...`; returns `None` if the prefix or number is absent.
fn parse_pid(instance: &str) -> Option<u32> {
    let rest = instance.strip_prefix("pid_")?;
    let end = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len());
    rest[..end].parse::<u32>().ok()
}

/// Collect the GPU-engine utilization counter and aggregate it per PID.
///
/// Reads every wildcard instance via `PdhGetFormattedCounterArrayW`
/// (PDH_FMT_DOUBLE), parses the PID from each instance name, sums the per-engine
/// utilization for that PID, and clamps the total to 100. Returns an empty map
/// if PDH is unavailable or this is the first (priming) sample.
fn gpu_map() -> HashMap<u32, f32> {
    let mut out: HashMap<u32, f32> = HashMap::new();
    let guard = GPU_QUERY.lock();
    let Some(gpu) = guard.as_ref() else {
        return out;
    };

    unsafe {
        if PdhCollectQueryData(gpu.query) != PDH_SUCCESS {
            return out;
        }

        // First call: ask for the required buffer size.
        let mut size: u32 = 0;
        let mut count: u32 = 0;
        let rc = PdhGetFormattedCounterArrayW(gpu.util, PDH_FMT_DOUBLE, &mut size, &mut count, None);
        if rc != PDH_MORE_DATA || size == 0 {
            return out;
        }

        // Allocate the requested bytes and reinterpret as an item array.
        let mut bytes = vec![0u8; size as usize];
        let items_ptr = bytes.as_mut_ptr() as *mut PDH_FMT_COUNTERVALUE_ITEM_W;
        let rc = PdhGetFormattedCounterArrayW(
            gpu.util,
            PDH_FMT_DOUBLE,
            &mut size,
            &mut count,
            Some(items_ptr),
        );
        if rc != PDH_SUCCESS {
            return out;
        }

        let items = std::slice::from_raw_parts(items_ptr, count as usize);
        for item in items {
            if item.FmtValue.CStatus != PDH_SUCCESS || item.szName.is_null() {
                continue;
            }
            let value = item.FmtValue.Anonymous.doubleValue;
            if !value.is_finite() || value <= 0.0 {
                continue;
            }
            let Ok(name) = item.szName.to_string() else {
                continue;
            };
            if let Some(pid) = parse_pid(&name) {
                *out.entry(pid).or_insert(0.0) += value as f32;
            }
        }
    }

    // Clamp each PID's summed engine utilization into 0..100.
    for v in out.values_mut() {
        *v = v.clamp(0.0, 100.0);
    }
    out
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
    // Per-process GPU utilization (0..100), collected once for this snapshot.
    let gpu_by_pid = gpu_map();
    sys.processes()
        .iter()
        .map(|(pid, process)| {
            let id = pid.as_u32();
            let cpu = process.cpu_usage() / logical;
            let gpu = gpu_by_pid.get(&id).copied().unwrap_or(0.0);
            // Relative 0..100 "power impact" index, NOT watts: real wattage
            // requires a kernel/MSR sensor driver. Weighted blend of this
            // process's normalized CPU% and GPU%.
            let power = (cpu * 0.6 + gpu * 0.4).min(100.0);
            ProcInfo {
                pid: id,
                name: process.name().to_string_lossy().to_string(),
                cpu,
                mem: process.memory(),
                threads: threads.get(&id).copied().unwrap_or(0),
                gpu,
                power,
            }
        })
        .collect()
}

/// Terminate a process (End task).
pub fn kill(pid: u32) -> CoreResult<()> {
    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, false.into(), pid)?;
        let result = TerminateProcess(handle, 1);
        let _ = CloseHandle(handle);
        result?;
    }
    Ok(())
}
