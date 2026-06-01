//! Process enumeration with live metrics.

use crate::error::CoreResult;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use sysinfo::{ProcessesToUpdate, System};
use windows::core::PCWSTR;
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1};
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
    /// Dominant GPU engine label for this process (e.g. "3D", "Compute"), or
    /// `None` when GPU usage is negligible / unattributable.
    pub gpu_engine: Option<String>,
    /// Human name of the GPU adapter this process is primarily using (e.g.
    /// "NVIDIA GeForce RTX 4090"), or `None` when unknown.
    pub gpu_adapter: Option<String>,
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
    /// DXGI LUID (HighPart as u32, LowPart) → adapter description. Built once
    /// when the query is opened so we don't re-query DXGI on every `list()`.
    adapters: HashMap<(u32, u32), String>,
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

            Some(GpuQuery {
                query,
                util,
                adapters: enumerate_adapters(),
            })
        }
    }
}

/// Enumerate DXGI adapters once and build a LUID→name map keyed by
/// `(HighPart as u32, LowPart)` to match the hex pair parsed from PDH instance
/// names. Never panics: any DXGI failure yields an empty map (adapters degrade
/// to `None`). Written `?`-free so a single bad adapter doesn't abort the rest.
fn enumerate_adapters() -> HashMap<(u32, u32), String> {
    let mut map = HashMap::new();
    unsafe {
        let Ok(factory) = CreateDXGIFactory1::<IDXGIFactory1>() else {
            return map;
        };
        let mut i = 0u32;
        // EnumAdapters1 returns DXGI_ERROR_NOT_FOUND (Err) past the last adapter.
        while let Ok(adapter) = factory.EnumAdapters1(i) {
            i += 1;
            let Ok(desc) = adapter.GetDesc1() else {
                continue;
            };
            // Description is a NUL-padded UTF-16 array; trim at the first NUL.
            let end = desc
                .Description
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(desc.Description.len());
            let name = String::from_utf16_lossy(&desc.Description[..end]);
            let name = name.trim().to_string();
            if name.is_empty() {
                continue;
            }
            let luid = desc.AdapterLuid;
            map.insert((luid.HighPart as u32, luid.LowPart), name);
        }
    }
    map
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

/// Parse the engine type from a `\GPU Engine` instance name. The raw engtype is
/// everything after the `_engtype_` marker to the end of the name, e.g.
/// `..._engtype_3D` → `"3D"`. Returns `None` if the marker is absent.
fn parse_engtype(instance: &str) -> Option<&str> {
    instance.rsplit_once("_engtype_").map(|(_, t)| t)
}

/// Parse the adapter LUID from a `\GPU Engine` instance name. The name carries
/// `luid_0x{HIGH}_0x{LOW}` (each part hex), e.g. `luid_0x00000000_0x0000C5DE`
/// → `(0x00000000, 0x0000C5DE)`. Returned as `(HIGH, LOW)` so it lines up with
/// the `(HighPart as u32, LowPart)` key used by the adapter map. `None` if the
/// pattern is missing or the hex doesn't parse.
fn parse_luid(instance: &str) -> Option<(u32, u32)> {
    let after = instance.split_once("_luid_0x")?.1;
    let (high_hex, rest) = after.split_once("_0x")?;
    let end = rest
        .find(|c: char| !c.is_ascii_hexdigit())
        .unwrap_or(rest.len());
    let low_hex = &rest[..end];
    let high = u32::from_str_radix(high_hex, 16).ok()?;
    let low = u32::from_str_radix(low_hex, 16).ok()?;
    Some((high, low))
}

/// Map a raw PDH engtype token to a human-friendly label. Known engines get a
/// spaced label; anything else passes through unchanged.
fn engine_label(engtype: &str) -> String {
    match engtype {
        "3D" => "3D",
        "VideoEncode" => "Video Encode",
        "VideoDecode" => "Video Decode",
        "VideoProcessing" => "Video Processing",
        "Compute" => "Compute",
        "Copy" => "Copy",
        "Security" => "Security",
        other => other,
    }
    .to_string()
}

/// Minimum summed GPU utilization (percent) for a PID before we bother
/// attributing a dominant engine/adapter to it.
const GPU_ATTRIBUTION_THRESHOLD: f32 = 0.05;

/// Pick the key with the highest accumulated utilization from a per-key sum map.
fn dominant_key<K: Clone>(sums: &HashMap<K, f32>) -> Option<K> {
    sums.iter()
        .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))
        .map(|(k, _)| k.clone())
}

/// Per-PID GPU attribution derived from one PDH array read.
///
/// * `util` — summed engine utilization per PID, clamped to 0..100 (drives
///   `ProcInfo.gpu`).
/// * `attribution` — dominant `(engine label, adapter name)` per PID, only for
///   PIDs whose total utilization clears [`GPU_ATTRIBUTION_THRESHOLD`].
struct GpuSnapshot {
    util: HashMap<u32, f32>,
    attribution: HashMap<u32, (String, Option<String>)>,
}

/// Collect the GPU-engine utilization counter and aggregate it per PID.
///
/// Reads every wildcard instance once via `PdhGetFormattedCounterArrayW`
/// (PDH_FMT_DOUBLE). For each instance it parses the PID, engtype, and adapter
/// LUID from the instance name and accumulates utilization three ways per PID:
/// a flat total (→ `gpu`), per-engtype, and per-LUID. The dominant engtype/LUID
/// then yield the engine label and adapter name. Returns empty maps if PDH is
/// unavailable or this is the first (priming) sample.
fn gpu_map() -> GpuSnapshot {
    let mut util: HashMap<u32, f32> = HashMap::new();
    // Per-PID utilization grouped by engtype and by parsed LUID.
    let mut by_engtype: HashMap<u32, HashMap<String, f32>> = HashMap::new();
    let mut by_luid: HashMap<u32, HashMap<(u32, u32), f32>> = HashMap::new();

    let guard = GPU_QUERY.lock();
    let Some(gpu) = guard.as_ref() else {
        return GpuSnapshot {
            util,
            attribution: HashMap::new(),
        };
    };

    unsafe {
        if PdhCollectQueryData(gpu.query) != PDH_SUCCESS {
            return GpuSnapshot {
                util,
                attribution: HashMap::new(),
            };
        }

        // First call: ask for the required buffer size.
        let mut size: u32 = 0;
        let mut count: u32 = 0;
        let rc = PdhGetFormattedCounterArrayW(gpu.util, PDH_FMT_DOUBLE, &mut size, &mut count, None);
        if rc != PDH_MORE_DATA || size == 0 {
            return GpuSnapshot {
                util,
                attribution: HashMap::new(),
            };
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
            return GpuSnapshot {
                util,
                attribution: HashMap::new(),
            };
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
            let Some(pid) = parse_pid(&name) else {
                continue;
            };
            let v = value as f32;
            *util.entry(pid).or_insert(0.0) += v;
            if let Some(engtype) = parse_engtype(&name) {
                *by_engtype
                    .entry(pid)
                    .or_default()
                    .entry(engtype.to_string())
                    .or_insert(0.0) += v;
            }
            if let Some(luid) = parse_luid(&name) {
                *by_luid.entry(pid).or_default().entry(luid).or_insert(0.0) += v;
            }
        }
    }

    // Clamp each PID's summed engine utilization into 0..100.
    for v in util.values_mut() {
        *v = v.clamp(0.0, 100.0);
    }

    // Derive dominant engine + adapter for PIDs with meaningful GPU usage.
    let mut attribution: HashMap<u32, (String, Option<String>)> = HashMap::new();
    for (&pid, &total) in &util {
        if total <= GPU_ATTRIBUTION_THRESHOLD {
            continue;
        }
        let engine = by_engtype
            .get(&pid)
            .and_then(dominant_key)
            .map(|t| engine_label(&t));
        let Some(engine) = engine else {
            continue;
        };
        let adapter = by_luid
            .get(&pid)
            .and_then(dominant_key)
            .and_then(|luid| gpu.adapters.get(&luid).cloned());
        attribution.insert(pid, (engine, adapter));
    }

    GpuSnapshot { util, attribution }
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
    // Per-process GPU utilization + engine/adapter attribution, collected once
    // for this snapshot.
    let gpu = gpu_map();
    sys.processes()
        .iter()
        .map(|(pid, process)| {
            let id = pid.as_u32();
            let cpu = process.cpu_usage() / logical;
            let gpu_pct = gpu.util.get(&id).copied().unwrap_or(0.0);
            // Processes not in the attribution map get None/None.
            let (gpu_engine, gpu_adapter) = match gpu.attribution.get(&id) {
                Some((engine, adapter)) => (Some(engine.clone()), adapter.clone()),
                None => (None, None),
            };
            // Relative 0..100 "power impact" index, NOT watts: real wattage
            // requires a kernel/MSR sensor driver. Weighted blend of this
            // process's normalized CPU% and GPU%.
            let power = (cpu * 0.6 + gpu_pct * 0.4).min(100.0);
            ProcInfo {
                pid: id,
                name: process.name().to_string_lossy().to_string(),
                cpu,
                mem: process.memory(),
                threads: threads.get(&id).copied().unwrap_or(0),
                gpu: gpu_pct,
                power,
                gpu_engine,
                gpu_adapter,
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
