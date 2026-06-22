//! Process enumeration with live metrics.

use crate::error::{CoreError, CoreResult};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::ffi::c_void;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use sysinfo::{ProcessesToUpdate, System};
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE};
use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1};
use windows::Win32::Security::{
    GetTokenInformation, LookupAccountSidW, TokenUser, PSID, SID_NAME_USE, TOKEN_QUERY, TOKEN_USER,
};
use windows::Win32::Storage::FileSystem::{
    GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
};
use windows::Win32::System::Performance::{
    PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW,
    PdhOpenQueryW, PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE, PDH_HCOUNTER, PDH_HQUERY,
    PDH_MORE_DATA,
};
use windows::Win32::System::SystemInformation::IMAGE_FILE_MACHINE_UNKNOWN;
use windows::Win32::System::Threading::{
    GetProcessAffinityMask, GetProcessHandleCount, GetProcessTimes, IsWow64Process2, OpenProcess,
    OpenProcessToken, QueryFullProcessImageNameW, TerminateProcess, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_INFORMATION, PROCESS_TERMINATE,
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
    /// Per-process GPU memory (VRAM) in bytes from NVML, or `None` when the
    /// driver/GPU doesn't report it. Serialized as `gpuMem`.
    pub gpu_mem: Option<u64>,
    pub power: f32,
    /// Process CPU affinity mask (allowed logical CPUs); 0 when inaccessible.
    /// Serialized as a decimal string so bits ≥ 53 survive the JS-number (f64)
    /// frontend boundary; see `serde_u64`.
    #[serde(with = "crate::serde_u64::str")]
    pub affinity: u64,
    /// Process owner account name (e.g. "SYSTEM", "Thomas", "LOCAL SERVICE"),
    /// or `None` when the token/SID can't be resolved. Serialized as `userName`.
    #[serde(rename = "userName")]
    pub user: Option<String>,
    /// Open handle count for this process; 0 when inaccessible.
    pub handles: u32,
    /// Total CPU time (kernel + user) consumed by this process, in seconds.
    pub cpu_time: u64,
    /// Process architecture: "64位" or "32位"; `None` when undeterminable.
    pub platform: Option<String>,
    /// Dominant GPU engine label for this process (e.g. "3D", "Compute"), or
    /// `None` when GPU usage is negligible / unattributable.
    pub gpu_engine: Option<String>,
    /// Human name of the GPU adapter this process is primarily using (e.g.
    /// "NVIDIA GeForce RTX 4090"), or `None` when unknown.
    pub gpu_adapter: Option<String>,
    /// Friendly file description from the exe's version resource (e.g. "Google
    /// Chrome") — the name Windows Task Manager shows. `None` for binaries
    /// without version info (most system processes).
    pub description: Option<String>,
    /// Whether this process's CPU affinity can actually be changed (we can
    /// `OpenProcess` with `PROCESS_SET_INFORMATION`). Protected/system
    /// processes (System, Registry, Secure System, some AV) are not settable;
    /// the core-assignment view hides those.
    pub settable: bool,
    /// PID of this process's parent, or 0 when sysinfo can't resolve one (e.g.
    /// the parent has exited). Used by the Task-Manager process view to collapse
    /// child processes under their parent app.
    pub parent_pid: u32,
    /// Full path to the process executable (e.g. `C:\\…\\chrome.exe`), or `None`
    /// when inaccessible (protected/system processes). The Task-Manager view
    /// passes this to `process_icon` to fetch the real per-exe icon, and uses it
    /// to key icon caching. Serialized as `exePath`.
    pub exe_path: Option<String>,
}

/// PDH success return code (`ERROR_SUCCESS`).
const PDH_SUCCESS: u32 = 0;

// ---------------------------------------------------------------------------
// Critical-process guard (shared by end_task / set_priority / set_affinity).
//
// The app runs ELEVATED, so the IPC commands can open and mutate (or terminate)
// any process — including the OS kernel and the user-mode boot/security
// processes whose death blue-screens or hard-hangs Windows. We refuse to
// operate on those regardless of what the frontend sends.
// ---------------------------------------------------------------------------

/// PIDs that must never be touched: 0 (System Idle) and 4 (System / kernel).
const CRITICAL_PIDS: &[u32] = &[0, 4];

/// Image names (lowercase) of user-mode processes critical to Windows; killing,
/// repriotizing, or reaffinitizing any of these can hang or crash the machine.
const CRITICAL_PROCESS_NAMES: &[&str] = &[
    "system",
    "registry",
    "smss.exe",
    "csrss.exe",
    "wininit.exe",
    "services.exe",
    "lsass.exe",
    "winlogon.exe",
];

/// True if an image name (any case) is one of the Windows-critical user-mode
/// processes we refuse to re-affinitize / reprioritize / kill. Cheap (no
/// `OpenProcess`) so the process list can mark these rows non-settable without a
/// syscall — keeping the "settable" flag in sync with [`guard_critical_pid`].
pub fn is_critical_name(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    CRITICAL_PROCESS_NAMES.contains(&n.as_str())
}

/// Resolve a PID's executable file name (e.g. `"lsass.exe"`), lowercased.
/// `None` when the process can't be opened/queried. Never panics.
fn image_name_lower(pid: u32) -> Option<String> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false.into(), pid).ok()?;
        let mut buf = [0u16; 260]; // MAX_PATH
        let mut len = buf.len() as u32; // in/out: capacity in, written length out
        let ok = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut len,
        )
        .is_ok();
        let _ = CloseHandle(handle);
        if !ok || len == 0 {
            return None;
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]).to_lowercase();
        let name = path.rsplit(['\\', '/']).next().unwrap_or(&path).to_string();
        if name.is_empty() {
            None
        } else {
            Some(name)
        }
    }
}

/// Reject any operation targeting a process critical to Windows stability.
///
/// Blocks PIDs 0 and 4 outright, and any process whose image name matches the
/// case-insensitive [`CRITICAL_PROCESS_NAMES`] list (smss/csrss/wininit/
/// services/lsass/winlogon). Returns a clear `Err` so the command surface fails
/// loudly instead of silently destabilizing the OS. Used as the single gate at
/// every mutating command entry point.
pub fn guard_critical_pid(pid: u32) -> CoreResult<()> {
    if CRITICAL_PIDS.contains(&pid) {
        return Err(CoreError::Msg(format!(
            "拒绝操作受保护的系统进程 (PID {pid})"
        )));
    }
    if let Some(name) = image_name_lower(pid) {
        if CRITICAL_PROCESS_NAMES.iter().any(|c| *c == name) {
            return Err(CoreError::Msg(format!("拒绝操作关键系统进程: {name}")));
        }
    }
    Ok(())
}

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
                // Close the query we just opened before bailing, or the handle leaks.
                let _ = PdhCloseQuery(query);
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
    let end = rest
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(rest.len());
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
pub(crate) struct GpuSnapshot {
    pub(crate) util: HashMap<u32, f32>,
    pub(crate) attribution: HashMap<u32, (String, Option<String>)>,
    /// Whole-GPU utilization (sum of all engine instances, clamped 0..100). `None`
    /// when PDH is unavailable / on the priming sample — mirrors the old gpu_util
    /// behaviour in `sensors::sample` so `gpuPct` stays null-when-unavailable.
    pub(crate) aggregate: Option<f32>,
    /// Per-engine-type totals (e.g. `{"3D": 87.0}`), clamped 0..100 — the
    /// `gpu_engine_loads` payload, derived from the SAME collect.
    pub(crate) per_engine: HashMap<String, f64>,
}

/// Everything the single background GPU collect produces: per-PID engine data
/// (+ aggregate + per-engine totals) plus per-PID dedicated VRAM.
pub(crate) struct GpuFullSnapshot {
    pub(crate) engine: GpuSnapshot,
    pub(crate) vram: HashMap<u32, u64>,
}

impl Default for GpuFullSnapshot {
    fn default() -> Self {
        GpuFullSnapshot {
            engine: empty_engine_snapshot(),
            vram: HashMap::new(),
        }
    }
}

/// An empty engine snapshot (PDH unavailable / priming sample): no per-PID data
/// and a `None` aggregate so `gpuPct` reads as unavailable rather than 0.
fn empty_engine_snapshot() -> GpuSnapshot {
    GpuSnapshot {
        util: HashMap::new(),
        attribution: HashMap::new(),
        aggregate: None,
        per_engine: HashMap::new(),
    }
}

/// Collect the GPU-engine utilization counter and aggregate it per PID.
///
/// Reads every wildcard instance once via `PdhGetFormattedCounterArrayW`
/// (PDH_FMT_DOUBLE). For each instance it parses the PID, engtype, and adapter
/// LUID from the instance name and accumulates utilization three ways per PID:
/// a flat total (→ `gpu`), per-engtype, and per-LUID. The dominant engtype/LUID
/// then yield the engine label and adapter name. Returns empty maps if PDH is
/// unavailable or this is the first (priming) sample.
pub(crate) fn gpu_map() -> GpuSnapshot {
    let mut util: HashMap<u32, f32> = HashMap::new();
    // Per-PID utilization grouped by engtype and by parsed LUID.
    let mut by_engtype: HashMap<u32, HashMap<String, f32>> = HashMap::new();
    let mut by_luid: HashMap<u32, HashMap<(u32, u32), f32>> = HashMap::new();
    // Whole-GPU total (sum of every instance) to mirror the old `sensors` gpu_util
    // aggregate (sum of all instances, then clamp 100) exactly.
    let mut raw_total: f64 = 0.0;

    let guard = GPU_QUERY.lock();
    let Some(gpu) = guard.as_ref() else {
        return empty_engine_snapshot();
    };

    unsafe {
        if PdhCollectQueryData(gpu.query) != PDH_SUCCESS {
            return empty_engine_snapshot();
        }

        // First call: ask for the required buffer size.
        let mut size: u32 = 0;
        let mut count: u32 = 0;
        let rc =
            PdhGetFormattedCounterArrayW(gpu.util, PDH_FMT_DOUBLE, &mut size, &mut count, None);
        if rc != PDH_MORE_DATA || size == 0 {
            return empty_engine_snapshot();
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
            return empty_engine_snapshot();
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
            // Count every positive instance toward the whole-GPU aggregate, even
            // ones whose name has no parseable PID (matches the old gpu_util sum).
            raw_total += value;
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

    // Per-engine-type totals (summed across PIDs, same labels as the GPU tab) and
    // the whole-GPU aggregate — both derived from THIS one collect, so the
    // background collector feeds the process list, sensors, AND gpu_engine_loads
    // without any extra \GPU Engine(*) collects.
    let mut per_engine: HashMap<String, f64> = HashMap::new();
    for engmap in by_engtype.values() {
        for (engtype, v) in engmap {
            *per_engine.entry(engine_label(engtype)).or_insert(0.0) += *v as f64;
        }
    }
    for v in per_engine.values_mut() {
        *v = v.clamp(0.0, 100.0);
    }
    let aggregate = Some((raw_total as f32).clamp(0.0, 100.0));

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

    GpuSnapshot {
        util,
        attribution,
        aggregate,
        per_engine,
    }
}

/// One full GPU sample for the background telemetry collector: the per-PID +
/// aggregate + per-engine snapshot (one `\GPU Engine(*)` collect) plus per-PID
/// dedicated VRAM (one `\GPU Process Memory(*)` collect). This is the ONLY place
/// these two wildcard collects run now; every command reads the published snapshot.
pub(crate) fn collect_gpu() -> GpuFullSnapshot {
    GpuFullSnapshot {
        engine: gpu_map(),
        vram: gpu_vram_map(),
    }
}

/// Whole-GPU per-engine utilization query, kept separate from [`GPU_QUERY`] so
/// the two PDH rate baselines don't interfere (this one is polled by the
/// Performance view independently of the process list).
struct GpuEngineQuery {
    query: PDH_HQUERY,
    util: PDH_HCOUNTER,
}
// SAFETY: handles are only ever touched behind GPU_ENGINE_QUERY's mutex.
unsafe impl Send for GpuEngineQuery {}

static GPU_ENGINE_QUERY: Lazy<Mutex<Option<GpuEngineQuery>>> =
    Lazy::new(|| Mutex::new(open_gpu_engine_query()));

fn open_gpu_engine_query() -> Option<GpuEngineQuery> {
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
            // Close the query we just opened before bailing, or the handle leaks.
            let _ = PdhCloseQuery(query);
            return None;
        }
        let _ = PdhCollectQueryData(query);
        Some(GpuEngineQuery { query, util })
    }
}

/// Whole-GPU per-engine utilization (percent), summed across every PDH instance
/// and clamped to 0..100 — e.g. `{"3D": 87.0, "Copy": 1.0, "Video Encode": 0.0}`.
/// Mirrors the Windows Task Manager GPU engine graphs. Empty on the priming
/// sample or when PDH is unavailable.
///
/// Async + blocking-pool: the `\GPU Engine(*)` wildcard collect scales with the
/// process count (seconds on a loaded box) — as a sync command this stalled the
/// main thread on every Performance-view poll tick (the "未响应" stall class).
#[tauri::command]
pub async fn gpu_engine_loads() -> HashMap<String, f64> {
    // Hot path (Performance-view poll): O(1) read of the background snapshot's
    // per-engine totals — no PDH collect, no blocking-pool hop. The direct
    // `gpu_engine_loads_now()` body is kept below for the CLI probe.
    crate::telemetry::gpu_snapshot().engine.per_engine.clone()
}

/// Synchronous body of [`gpu_engine_loads`], for callers already off the main
/// thread (the CLI probe).
pub fn gpu_engine_loads_now() -> HashMap<String, f64> {
    let mut totals: HashMap<String, f64> = HashMap::new();
    let guard = GPU_ENGINE_QUERY.lock();
    let Some(q) = guard.as_ref() else {
        return totals;
    };
    unsafe {
        if PdhCollectQueryData(q.query) != PDH_SUCCESS {
            return totals;
        }
        let mut size: u32 = 0;
        let mut count: u32 = 0;
        let rc = PdhGetFormattedCounterArrayW(q.util, PDH_FMT_DOUBLE, &mut size, &mut count, None);
        if rc != PDH_MORE_DATA || size == 0 {
            return totals;
        }
        let mut bytes = vec![0u8; size as usize];
        let items_ptr = bytes.as_mut_ptr() as *mut PDH_FMT_COUNTERVALUE_ITEM_W;
        if PdhGetFormattedCounterArrayW(
            q.util,
            PDH_FMT_DOUBLE,
            &mut size,
            &mut count,
            Some(items_ptr),
        ) != PDH_SUCCESS
        {
            return totals;
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
            if let Some(engtype) = parse_engtype(&name) {
                *totals.entry(engine_label(engtype)).or_insert(0.0) += value;
            }
        }
    }
    for v in totals.values_mut() {
        *v = v.clamp(0.0, 100.0);
    }
    totals
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

/// Per-process dedicated VRAM (bytes) keyed by PID, via the PDH
/// `\GPU Process Memory(*)\Dedicated Usage` counter — the same source Windows
/// Task Manager uses. NVML does NOT report per-process VRAM on consumer (WDDM)
/// GPUs, so PDH is the portable path. Dedicated Usage is a raw gauge (not a rate),
/// so a single collection suffices; we open + close a short-lived query per
/// snapshot. Returns an empty map on any failure (the column then shows "—").
pub(crate) fn gpu_vram_map() -> HashMap<u32, u64> {
    let mut map: HashMap<u32, u64> = HashMap::new();
    unsafe {
        let mut query = PDH_HQUERY::default();
        if PdhOpenQueryW(PCWSTR::null(), 0, &mut query) != PDH_SUCCESS {
            return map;
        }
        let path: Vec<u16> = r"\GPU Process Memory(*)\Dedicated Usage"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let mut ctr = PDH_HCOUNTER::default();
        if PdhAddEnglishCounterW(query, PCWSTR(path.as_ptr()), 0, &mut ctr) != PDH_SUCCESS {
            let _ = PdhCloseQuery(query);
            return map;
        }
        if PdhCollectQueryData(query) != PDH_SUCCESS {
            let _ = PdhCloseQuery(query);
            return map;
        }
        let mut size: u32 = 0;
        let mut count: u32 = 0;
        let rc = PdhGetFormattedCounterArrayW(ctr, PDH_FMT_DOUBLE, &mut size, &mut count, None);
        if rc == PDH_MORE_DATA && size > 0 {
            let mut buf = vec![0u8; size as usize];
            let items_ptr = buf.as_mut_ptr() as *mut PDH_FMT_COUNTERVALUE_ITEM_W;
            if PdhGetFormattedCounterArrayW(
                ctr,
                PDH_FMT_DOUBLE,
                &mut size,
                &mut count,
                Some(items_ptr),
            ) == PDH_SUCCESS
            {
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
                        *map.entry(pid).or_insert(0) += value as u64;
                    }
                }
            }
        }
        let _ = PdhCloseQuery(query);
    }
    map
}

/// Refresh and snapshot all processes. `logical` is the logical-CPU count
/// used to normalize sysinfo's per-core CPU% into a Task-Manager-style total%.
pub fn list(sys: &mut System, threads: &HashMap<u32, u32>, logical: f32) -> Vec<ProcInfo> {
    sys.refresh_processes(ProcessesToUpdate::All, true);
    // Per-process GPU utilization/attribution + dedicated VRAM come from the
    // background telemetry collector (ONE shared collect), not a per-call PDH
    // collect under the sys lock — that multi-second collect is what used to
    // freeze the process list (and, via the shared blocking pool, everything else).
    let snap = crate::telemetry::gpu_snapshot();
    let gpu = &snap.engine;
    let gpu_vram = &snap.vram;
    // PIDs seen this refresh, used afterwards to prune the detail cache.
    let mut live_pids: std::collections::HashSet<u32> = std::collections::HashSet::new();
    let out: Vec<ProcInfo> = sys
        .processes()
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
            // One OpenProcess per process for affinity + handles + cpu_time +
            // cached user/platform.
            let details = process_details(id);
            live_pids.insert(id);
            let exe = process.exe();
            // Full exe path (used for both the friendly description and the
            // per-exe icon lookup on the frontend). `None` when inaccessible.
            let exe_path = exe.and_then(|p| {
                if p.as_os_str().is_empty() {
                    None
                } else {
                    Some(p.to_string_lossy().to_string())
                }
            });
            let name = process.name().to_string_lossy().to_string();
            ProcInfo {
                pid: id,
                name: name.clone(),
                cpu,
                mem: process.memory(),
                threads: threads.get(&id).copied().unwrap_or(0),
                gpu: gpu_pct,
                gpu_mem: gpu_vram.get(&id).copied(),
                power,
                affinity: details.affinity,
                user: details.user,
                handles: details.handles,
                cpu_time: details.cpu_time,
                platform: details.platform,
                gpu_engine,
                gpu_adapter,
                description: description_for(exe),
                // A process is only "settable" if we can both open it for
                // SET_INFORMATION *and* aren't refusing it as Windows-critical
                // (lsass/winlogon/services/…). Without the name check, SeDebug
                // lets OpenProcess succeed on those, so they'd look assignable in
                // the UI yet silently fail at the guard — confusing the user.
                settable: settable_for(id) && !is_critical_name(&name),
                parent_pid: process.parent().map(|p| p.as_u32()).unwrap_or(0),
                exe_path,
            }
        })
        .collect();

    // Drop cached user/platform for PIDs that no longer exist so the cache
    // tracks the live process set instead of growing unbounded.
    DETAIL_CACHE.lock().retain(|pid, _| live_pids.contains(pid));
    SETTABLE_CACHE
        .lock()
        .retain(|pid, _| live_pids.contains(pid));

    out
}

/// Terminate a process (End task). Refuses critical system processes.
pub fn kill(pid: u32) -> CoreResult<()> {
    guard_critical_pid(pid)?;
    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, false.into(), pid)?;
        let result = TerminateProcess(handle, 1);
        let _ = CloseHandle(handle);
        result?;
    }
    Ok(())
}

/// Per-process detail bundle resolved from a single `OpenProcess` handle.
/// All fields default to zero/`None` when the process can't be opened
/// (protected/system) so callers degrade gracefully.
struct ProcDetails {
    /// CPU affinity mask (allowed logical CPUs); 0 when inaccessible.
    affinity: u64,
    /// Open handle count; 0 when inaccessible.
    handles: u32,
    /// Total CPU time (kernel + user) in seconds.
    cpu_time: u64,
    /// Process owner account name; `None` when unresolved.
    user: Option<String>,
    /// "64位" / "32位"; `None` when undeterminable.
    platform: Option<String>,
}

impl Default for ProcDetails {
    fn default() -> Self {
        ProcDetails {
            affinity: 0,
            handles: 0,
            cpu_time: 0,
            user: None,
            platform: None,
        }
    }
}

/// Cache for the *static* per-PID details (user, platform) keyed by pid:
/// `(user, platform)`. These never change for the lifetime of a process, so we
/// resolve them once (the SID lookup + WoW64 probe are comparatively expensive)
/// and reuse them on every refresh. Pruned in [`list`] to the live PID set.
static DETAIL_CACHE: Lazy<Mutex<HashMap<u32, (Option<String>, Option<String>)>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Cache of pid → affinity-settable. Stable for a process's lifetime, so we
/// probe `OpenProcess(PROCESS_SET_INFORMATION)` once per pid. Pruned in [`list`].
static SETTABLE_CACHE: Lazy<Mutex<HashMap<u32, bool>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// Whether `pid`'s affinity can be set (cached). True when we can open the
/// process with `PROCESS_SET_INFORMATION`.
fn settable_for(pid: u32) -> bool {
    if let Some(&v) = SETTABLE_CACHE.lock().get(&pid) {
        return v;
    }
    let ok = unsafe {
        match OpenProcess(PROCESS_SET_INFORMATION, false.into(), pid) {
            Ok(h) => {
                let _ = CloseHandle(h);
                true
            }
            Err(_) => false,
        }
    };
    SETTABLE_CACHE.lock().insert(pid, ok);
    ok
}

/// Cache of exe-path → friendly FileDescription (e.g. "Google Chrome"), the name
/// Windows Task Manager shows. Keyed by full image path and resolved once per
/// distinct executable (the version-resource read is comparatively expensive).
/// `None` means the binary has no version info / description (common for system
/// processes). Bounded by the set of distinct executables on the machine.
static DESC_CACHE: Lazy<Mutex<HashMap<String, Option<String>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Friendly description for a process image, cached by path. `None` when the
/// path is empty (inaccessible) or the binary carries no FileDescription.
fn description_for(path: Option<&Path>) -> Option<String> {
    let path = path?;
    if path.as_os_str().is_empty() {
        return None;
    }
    let key = path.to_string_lossy().to_string();
    if let Some(cached) = DESC_CACHE.lock().get(&key) {
        return cached.clone();
    }
    let desc = exe_description(path);
    {
        let mut cache = DESC_CACHE.lock();
        // Keyed by exe path, so it's bounded by distinct binaries seen — but guard
        // against unbounded growth over a very long session by clearing past a cap.
        if cache.len() >= 4096 {
            cache.clear();
        }
        cache.insert(key, desc.clone());
    }
    desc
}

/// Read the `FileDescription` string from an executable's version resource.
/// Returns `None` when the file has no version info / no description. Never
/// panics; written defensively with no `unwrap`.
fn exe_description(path: &Path) -> Option<String> {
    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        let size = GetFileVersionInfoSizeW(PCWSTR(wide.as_ptr()), None);
        if size == 0 {
            return None;
        }
        let mut data = vec![0u8; size as usize];
        GetFileVersionInfoW(
            PCWSTR(wide.as_ptr()),
            Some(0),
            size,
            data.as_mut_ptr() as *mut c_void,
        )
        .ok()?;

        // Resolve the (language, codepage) translation; fall back to US-English.
        let mut trans_ptr: *mut c_void = std::ptr::null_mut();
        let mut trans_len: u32 = 0;
        let trans_q: Vec<u16> = r"\VarFileInfo\Translation"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let (lang, cp) = if VerQueryValueW(
            data.as_ptr() as *const c_void,
            PCWSTR(trans_q.as_ptr()),
            &mut trans_ptr,
            &mut trans_len,
        )
        .as_bool()
            && !trans_ptr.is_null()
            && trans_len >= 4
        {
            let lang = *(trans_ptr as *const u16);
            let cp = *((trans_ptr as *const u16).add(1));
            (lang, cp)
        } else {
            (0x0409u16, 0x04B0u16)
        };

        let sub = format!("\\StringFileInfo\\{lang:04x}{cp:04x}\\FileDescription");
        let sub_w: Vec<u16> = sub.encode_utf16().chain(std::iter::once(0)).collect();
        let mut val_ptr: *mut c_void = std::ptr::null_mut();
        let mut val_len: u32 = 0;
        if !VerQueryValueW(
            data.as_ptr() as *const c_void,
            PCWSTR(sub_w.as_ptr()),
            &mut val_ptr,
            &mut val_len,
        )
        .as_bool()
            || val_ptr.is_null()
            || val_len == 0
        {
            return None;
        }
        let chars = std::slice::from_raw_parts(val_ptr as *const u16, val_len as usize);
        let text = String::from_utf16_lossy(chars)
            .trim_end_matches('\0')
            .trim()
            .to_string();
        if text.is_empty() {
            None
        } else {
            Some(text)
        }
    }
}

/// Combine a kernel+user [`FILETIME`] pair into total CPU seconds. Each FILETIME
/// is a 64-bit count of 100-ns ticks split across high/low words; summed and
/// divided by 10_000_000 to yield whole seconds.
fn cpu_seconds(kernel: FILETIME, user: FILETIME) -> u64 {
    let to_ticks = |ft: FILETIME| ((ft.dwHighDateTime as u64) << 32) | (ft.dwLowDateTime as u64);
    (to_ticks(kernel) + to_ticks(user)) / 10_000_000
}

/// Resolve the owning account name for an open process handle via its token
/// user SID. Two-call `GetTokenInformation` then `LookupAccountSidW`. Returns
/// just the account name (e.g. "Thomas" / "SYSTEM"); `None` on any failure.
/// Never panics; no `unwrap` on FFI.
fn resolve_user(handle: HANDLE) -> Option<String> {
    unsafe {
        let mut token = HANDLE::default();
        if OpenProcessToken(handle, TOKEN_QUERY, &mut token).is_err() {
            return None;
        }

        // First call sizes the TOKEN_USER buffer (expected to fail with the
        // required length written back).
        let mut len: u32 = 0;
        let _ = GetTokenInformation(token, TokenUser, None, 0, &mut len);
        if len == 0 {
            let _ = CloseHandle(token);
            return None;
        }

        let mut buf = vec![0u8; len as usize];
        let ok = GetTokenInformation(
            token,
            TokenUser,
            Some(buf.as_mut_ptr() as *mut core::ffi::c_void),
            len,
            &mut len,
        )
        .is_ok();
        let _ = CloseHandle(token);
        if !ok {
            return None;
        }

        let token_user = &*(buf.as_ptr() as *const TOKEN_USER);
        let sid = PSID(token_user.User.Sid.0);
        if sid.0.is_null() {
            return None;
        }

        // First LookupAccountSidW sizes the name + domain buffers.
        let mut name_len: u32 = 0;
        let mut domain_len: u32 = 0;
        let mut sid_use = SID_NAME_USE::default();
        let _ = LookupAccountSidW(
            PCWSTR::null(),
            sid,
            None,
            &mut name_len,
            None,
            &mut domain_len,
            &mut sid_use,
        );
        if name_len == 0 {
            return None;
        }

        let mut name = vec![0u16; name_len as usize];
        let mut domain = vec![0u16; domain_len.max(1) as usize];
        if LookupAccountSidW(
            PCWSTR::null(),
            sid,
            Some(PWSTR(name.as_mut_ptr())),
            &mut name_len,
            Some(PWSTR(domain.as_mut_ptr())),
            &mut domain_len,
            &mut sid_use,
        )
        .is_err()
        {
            return None;
        }

        let end = name.iter().position(|&c| c == 0).unwrap_or(name.len());
        let account = String::from_utf16_lossy(&name[..end]);
        if account.is_empty() {
            None
        } else {
            Some(account)
        }
    }
}

/// Determine process architecture ("64位"/"32位") for an open handle. Uses
/// `IsWow64Process2`: a non-`UNKNOWN` *process* machine means the process is
/// running under WoW64 (32-bit on 64-bit Windows). `None` on failure.
fn resolve_platform(handle: HANDLE) -> Option<String> {
    unsafe {
        let mut process_machine = IMAGE_FILE_MACHINE_UNKNOWN;
        let mut native_machine = IMAGE_FILE_MACHINE_UNKNOWN;
        if IsWow64Process2(handle, &mut process_machine, Some(&mut native_machine)).is_err() {
            return None;
        }
        if process_machine != IMAGE_FILE_MACHINE_UNKNOWN {
            Some("32位".to_string())
        } else {
            Some("64位".to_string())
        }
    }
}

/// Open a process once and gather affinity + handle count + CPU time, plus the
/// statically-cached owner and architecture. Returns all-default values when the
/// process can't be opened (protected/system). Never panics; no `unwrap` on FFI.
fn process_details(pid: u32) -> ProcDetails {
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false.into(), pid) else {
            return ProcDetails::default();
        };

        // Affinity (cheap; recomputed each refresh as it can change).
        let mut proc_mask: usize = 0;
        let mut sys_mask: usize = 0;
        let affinity = if GetProcessAffinityMask(handle, &mut proc_mask, &mut sys_mask).is_ok() {
            proc_mask as u64
        } else {
            0
        };

        // Open handle count.
        let mut count: u32 = 0;
        let handles = if GetProcessHandleCount(handle, &mut count).is_ok() {
            count
        } else {
            0
        };

        // Total CPU time (kernel + user) in seconds.
        let mut creation = FILETIME::default();
        let mut exit = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user_time = FILETIME::default();
        let cpu_time = if GetProcessTimes(
            handle,
            &mut creation,
            &mut exit,
            &mut kernel,
            &mut user_time,
        )
        .is_ok()
        {
            cpu_seconds(kernel, user_time)
        } else {
            0
        };

        // Static fields (owner + architecture): resolve once per PID, then cache.
        let (user, platform) = {
            let mut cache = DETAIL_CACHE.lock();
            if let Some(cached) = cache.get(&pid) {
                cached.clone()
            } else {
                let resolved = (resolve_user(handle), resolve_platform(handle));
                cache.insert(pid, resolved.clone());
                resolved
            }
        };

        let _ = CloseHandle(handle);

        ProcDetails {
            affinity,
            handles,
            cpu_time,
            user,
            platform,
        }
    }
}
