//! System telemetry sampler: GPU utilization/VRAM (PDH + DXGI), disk activity
//! and throughput (PDH PhysicalDisk), and network throughput (sysinfo).
//!
//! State is kept internally in a `Lazy<Mutex<Sampler>>` so `sample()` can be
//! called repeatedly (~every 1.5s) without touching `AppState`. PDH queries are
//! opened once and re-collected on each call; the first call may read zero for
//! rate-based counters (PDH needs two samples) — that is expected.
//!
//! Fields that require a hardware sensor driver (CPU/GPU power and temperature)
//! are supplied by the `sensord` sidecar (LibreHardwareMonitor), spawned once on
//! the first `sample()` and read on a background thread. If the sidecar is
//! missing or fails to start, those four fields stay `None`. Any data source
//! that fails to initialize or read is left `None` and never fabricated.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::os::windows::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::Once;
use std::time::Instant;

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Serialize;
use sysinfo::Networks;

use windows::core::PCWSTR;
use windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE,
};
use windows::Win32::System::Performance::{
    PdhAddEnglishCounterW, PdhCollectQueryData, PdhGetFormattedCounterArrayW,
    PdhGetFormattedCounterValue, PdhOpenQueryW, PDH_FMT_COUNTERVALUE,
    PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE, PDH_HCOUNTER, PDH_HQUERY, PDH_MORE_DATA,
};

/// PDH success return code (`ERROR_SUCCESS`).
const PDH_SUCCESS: u32 = 0;
/// `DXGI_ADAPTER_FLAG_SOFTWARE` raw bit, used to skip the Microsoft Basic Render adapter.
const DXGI_SOFTWARE_FLAG: u32 = DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32;

/// `CREATE_NO_WINDOW` process-creation flag: run the sidecar without a console window.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// File name of the bundled hardware-sensor sidecar (Tauri strips the target
/// triple from `externalBin`, placing it next to the main executable).
const SIDECAR_EXE: &str = "sensord.exe";

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SensorSample {
    pub gpu_pct: Option<f32>,     // overall GPU utilization %, 0..100
    pub gpu_name: Option<String>, // primary adapter description
    pub vram_used: Option<u64>,   // dedicated VRAM used, bytes
    pub vram_total: Option<u64>,  // dedicated VRAM total, bytes
    pub disk_pct: Option<f32>,    // disk active time %, 0..100 (cap at 100)
    pub disk_read: Option<u64>,   // bytes/sec
    pub disk_write: Option<u64>,  // bytes/sec
    pub net_up: Option<u64>,      // bytes/sec
    pub net_down: Option<u64>,    // bytes/sec
    pub cpu_power: Option<f32>,   // watts
    pub gpu_power: Option<f32>,   // watts
    pub cpu_temp: Option<f32>,    // °C
    pub gpu_temp: Option<f32>,    // °C
}

/// A PDH query handle plus the counters opened against it. PDH handles are raw
/// pointers (`!Send`), so we wrap the sampler and only ever touch it behind the
/// module's mutex.
struct PdhQuery {
    query: PDH_HQUERY,
    disk_read: PDH_HCOUNTER,
    disk_write: PDH_HCOUNTER,
    disk_time: PDH_HCOUNTER,
    gpu_util: PDH_HCOUNTER,      // wildcard array: \GPU Engine(*)\Utilization Percentage
    gpu_mem: Option<PDH_HCOUNTER>, // wildcard array: \GPU Adapter Memory(*)\Dedicated Usage
}

/// Latest power/temperature readings produced by the `sensord` sidecar.
///
/// The sidecar (LibreHardwareMonitor) is the only source of these four values;
/// everything stays `None` until/unless a reader thread parses a line for it.
/// Unlike `Sampler`, this state is plain `Send + Sync` data so the background
/// reader thread can update it directly behind its own mutex.
#[derive(Default, Clone, Copy)]
struct SidecarReadings {
    cpu_power: Option<f32>,
    gpu_power: Option<f32>,
    cpu_temp: Option<f32>,
    gpu_temp: Option<f32>,
}

/// Shared, thread-safe store for the most recent sidecar readings.
static SIDECAR: Lazy<Mutex<SidecarReadings>> = Lazy::new(|| Mutex::new(SidecarReadings::default()));
/// Guards the one-time sidecar spawn so we never launch more than one process.
static SIDECAR_SPAWN: Once = Once::new();

/// Spawn the `sensord` sidecar exactly once and read its line-delimited JSON on
/// a background thread, updating [`SIDECAR`] with each parsed sample.
///
/// Resolves the sidecar next to the current executable (where Tauri places
/// `externalBin`). If the file is missing, spawning fails, or stdout can't be
/// captured, this returns quietly and the four fields simply stay `None` — the
/// app keeps running with power/temperature unavailable. The reader thread never
/// panics: parse failures are ignored and EOF/errors end the thread cleanly.
fn ensure_sidecar() {
    SIDECAR_SPAWN.call_once(|| {
        // Resolve `<dir of current exe>/sensord.exe`.
        let exe_path = match std::env::current_exe() {
            Ok(p) => p,
            Err(_) => return,
        };
        let Some(dir) = exe_path.parent() else {
            return;
        };
        let sidecar = dir.join(SIDECAR_EXE);
        if !sidecar.exists() {
            // Graceful: no sidecar bundled/built — leave readings as None.
            return;
        }

        let child = Command::new(&sidecar)
            .stdout(Stdio::piped())
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();

        let mut child = match child {
            Ok(c) => c,
            Err(_) => return, // spawn failed (e.g. blocked) — stay graceful.
        };

        let Some(stdout) = child.stdout.take() else {
            // Without stdout we can't read anything; let the child run/exit on
            // its own and keep readings None.
            return;
        };

        // Detached reader thread: owns the child handle so it isn't dropped (a
        // dropped Child does not kill the process, but keeping it lets the OS
        // reap it and ties the lifetime to this thread).
        std::thread::Builder::new()
            .name("sensord-reader".into())
            .spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines() {
                    let Ok(line) = line else {
                        break; // read error / pipe closed.
                    };
                    if let Some(readings) = parse_sidecar_line(&line) {
                        *SIDECAR.lock() = readings;
                    }
                }
                // Sidecar stopped emitting (crashed or exited): clear readings so
                // the UI shows power/temp as unavailable ("—") rather than stale
                // last-known values.
                *SIDECAR.lock() = SidecarReadings::default();
                // stdout closed → sidecar exited. Reap it; ignore the result.
                let _ = child.wait();
            })
            .ok();
    });
}

/// Parse one compact JSON line from the sidecar into [`SidecarReadings`].
///
/// Expected shape (any field may be `null`):
/// `{"cpuPower":<num|null>,"cpuTemp":<num|null>,"gpuPower":<num|null>,"gpuTemp":<num|null>}`
/// Returns `None` if the line isn't valid JSON; unknown/missing fields become `None`.
fn parse_sidecar_line(line: &str) -> Option<SidecarReadings> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    let json: serde_json::Value = serde_json::from_str(trimmed).ok()?;

    // Accept JSON numbers; reject NaN/inf and non-finite via f64 -> f32.
    let field = |key: &str| -> Option<f32> {
        let v = json.get(key)?;
        if v.is_null() {
            return None;
        }
        let n = v.as_f64()?;
        if n.is_finite() {
            Some(n as f32)
        } else {
            None
        }
    };

    Some(SidecarReadings {
        cpu_power: field("cpuPower"),
        gpu_power: field("gpuPower"),
        cpu_temp: field("cpuTemp"),
        gpu_temp: field("gpuTemp"),
    })
}

/// Persistent sampler state.
struct Sampler {
    /// PDH query; `None` if PDH failed to initialize (then all PDH fields stay None).
    pdh: Option<PdhQuery>,
    /// Network counters; cumulative byte totals from the previous sample, per interface.
    networks: Networks,
    prev_net: HashMap<String, (u64, u64)>, // name -> (total_received, total_transmitted)
    /// Timestamp of the previous sample, for computing per-second rates.
    last_instant: Option<Instant>,
    /// Cached DXGI adapter info (name + dedicated VRAM); queried once.
    gpu_name: Option<String>,
    vram_total: Option<u64>,
    dxgi_done: bool,
}

// SAFETY: the PDH handles inside `Sampler` are raw pointers and thus not `Send`
// by default. We only ever access `Sampler` from behind the module-global mutex
// below, and the handles are used solely on whichever thread holds that lock.
// PDH queries are documented as usable across threads when externally
// synchronized, which the mutex guarantees.
unsafe impl Send for Sampler {}

static SAMPLER: Lazy<Mutex<Sampler>> = Lazy::new(|| {
    Mutex::new(Sampler {
        pdh: PdhQuery::open(),
        networks: Networks::new_with_refreshed_list(),
        prev_net: HashMap::new(),
        last_instant: None,
        gpu_name: None,
        vram_total: None,
        dxgi_done: false,
    })
});

/// Convert a Rust `&str` into a NUL-terminated UTF-16 buffer for PCWSTR args.
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

impl PdhQuery {
    /// Open a PDH query and add all English counters. Returns `None` if the
    /// query or the essential (disk) counters cannot be created.
    fn open() -> Option<PdhQuery> {
        unsafe {
            let mut query = PDH_HQUERY::default();
            if PdhOpenQueryW(PCWSTR::null(), 0, &mut query) != PDH_SUCCESS {
                return None;
            }

            let add = |path: &str| -> Option<PDH_HCOUNTER> {
                let buf = wide(path);
                let mut counter = PDH_HCOUNTER::default();
                let rc = PdhAddEnglishCounterW(query, PCWSTR(buf.as_ptr()), 0, &mut counter);
                if rc == PDH_SUCCESS {
                    Some(counter)
                } else {
                    None
                }
            };

            // Disk counters are the baseline; if they fail, abandon the query.
            let disk_read = add(r"\PhysicalDisk(_Total)\Disk Read Bytes/sec");
            let disk_write = add(r"\PhysicalDisk(_Total)\Disk Write Bytes/sec");
            let disk_time = add(r"\PhysicalDisk(_Total)\% Disk Time");
            let gpu_util = add(r"\GPU Engine(*)\Utilization Percentage");

            let (Some(disk_read), Some(disk_write), Some(disk_time), Some(gpu_util)) =
                (disk_read, disk_write, disk_time, gpu_util)
            else {
                return None;
            };

            // VRAM usage is optional (counter name varies by driver/OS build).
            let gpu_mem = add(r"\GPU Adapter Memory(*)\Dedicated Usage");

            // Prime the query so the first user-facing sample has a baseline.
            let _ = PdhCollectQueryData(query);

            Some(PdhQuery {
                query,
                disk_read,
                disk_write,
                disk_time,
                gpu_util,
                gpu_mem,
            })
        }
    }
}

/// Read a single scalar PDH counter as `f64` (PDH_FMT_DOUBLE). Returns `None`
/// on any error or invalid data.
unsafe fn read_scalar(counter: PDH_HCOUNTER) -> Option<f64> {
    let mut value = PDH_FMT_COUNTERVALUE::default();
    let rc = PdhGetFormattedCounterValue(counter, PDH_FMT_DOUBLE, None, &mut value);
    if rc != PDH_SUCCESS {
        return None;
    }
    // CStatus must be valid for the union value to be meaningful.
    if value.CStatus != PDH_SUCCESS {
        return None;
    }
    Some(value.Anonymous.doubleValue)
}

/// Read all instances of a wildcard PDH counter array as doubles. Returns the
/// list of per-instance values (instances with invalid status are skipped).
unsafe fn read_array(counter: PDH_HCOUNTER) -> Option<Vec<f64>> {
    // First call with a zero-sized buffer to learn the required size.
    let mut size: u32 = 0;
    let mut count: u32 = 0;
    let rc = PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &mut size, &mut count, None);
    if rc != PDH_MORE_DATA || size == 0 {
        return None;
    }

    // Allocate a byte buffer of the requested size and reinterpret as items.
    let mut bytes = vec![0u8; size as usize];
    let items_ptr = bytes.as_mut_ptr() as *mut PDH_FMT_COUNTERVALUE_ITEM_W;
    let rc = PdhGetFormattedCounterArrayW(
        counter,
        PDH_FMT_DOUBLE,
        &mut size,
        &mut count,
        Some(items_ptr),
    );
    if rc != PDH_SUCCESS {
        return None;
    }

    let items = std::slice::from_raw_parts(items_ptr, count as usize);
    let mut out = Vec::with_capacity(count as usize);
    for item in items {
        if item.FmtValue.CStatus == PDH_SUCCESS {
            out.push(item.FmtValue.Anonymous.doubleValue);
        }
    }
    Some(out)
}

/// Query DXGI once for the primary adapter's description and dedicated VRAM.
/// Picks the hardware adapter with the largest `DedicatedVideoMemory`, skipping
/// software adapters (Microsoft Basic Render Driver).
fn query_dxgi() -> (Option<String>, Option<u64>) {
    unsafe {
        let factory: IDXGIFactory1 = match CreateDXGIFactory1() {
            Ok(f) => f,
            Err(_) => return (None, None),
        };

        let mut best_name: Option<String> = None;
        let mut best_vram: Option<u64> = None;
        let mut best_bytes: u64 = 0;

        let mut index = 0u32;
        while let Ok(adapter) = factory.EnumAdapters1(index) {
            index += 1;
            let Ok(desc) = adapter.GetDesc1() else {
                continue;
            };
            // Skip the software/basic-render adapter.
            if desc.Flags & DXGI_SOFTWARE_FLAG != 0 {
                continue;
            }
            let vram = desc.DedicatedVideoMemory as u64;
            if best_name.is_none() || vram > best_bytes {
                best_bytes = vram;
                // Description is a fixed [u16; 128]; trim at first NUL.
                let end = desc
                    .Description
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(desc.Description.len());
                let name = String::from_utf16_lossy(&desc.Description[..end])
                    .trim()
                    .to_string();
                best_name = if name.is_empty() { None } else { Some(name) };
                best_vram = Some(vram);
            }
        }

        (best_name, best_vram)
    }
}

/// Sample current telemetry. Maintains its own persistent state; safe to call
/// repeatedly. Any field whose source is unavailable is left `None`.
pub fn sample() -> SensorSample {
    // Launch the hardware-sensor sidecar on first call (no-op thereafter). If it
    // is missing or fails to start, power/temperature simply stay `None`.
    ensure_sidecar();

    let mut s = SAMPLER.lock();
    let mut out = SensorSample::default();

    // --- DXGI adapter (cached after first successful/attempted query) ---
    if !s.dxgi_done {
        let (name, vram) = query_dxgi();
        s.gpu_name = name;
        s.vram_total = vram;
        s.dxgi_done = true;
    }
    out.gpu_name = s.gpu_name.clone();
    out.vram_total = s.vram_total;

    // --- Network throughput (bytes/sec) via sysinfo cumulative totals ---
    s.networks.refresh(true);
    let now = Instant::now();
    let elapsed = s
        .last_instant
        .map(|prev| now.duration_since(prev).as_secs_f64())
        .unwrap_or(0.0);

    let mut cur_net: HashMap<String, (u64, u64)> = HashMap::new();
    let mut up_delta: u64 = 0;
    let mut down_delta: u64 = 0;
    for (name, data) in s.networks.iter() {
        let rx = data.total_received();
        let tx = data.total_transmitted();
        if let Some(&(prev_rx, prev_tx)) = s.prev_net.get(name) {
            down_delta = down_delta.saturating_add(rx.saturating_sub(prev_rx));
            up_delta = up_delta.saturating_add(tx.saturating_sub(prev_tx));
        }
        cur_net.insert(name.clone(), (rx, tx));
    }
    s.prev_net = cur_net;

    // Only emit a rate once we have a positive elapsed interval (second call on).
    if elapsed > 0.0 {
        out.net_down = Some((down_delta as f64 / elapsed) as u64);
        out.net_up = Some((up_delta as f64 / elapsed) as u64);
    } else {
        out.net_down = Some(0);
        out.net_up = Some(0);
    }
    s.last_instant = Some(now);

    // --- PDH counters (disk + GPU) ---
    if let Some(pdh) = s.pdh.as_ref() {
        unsafe {
            // A single collect updates every counter on the query.
            if PdhCollectQueryData(pdh.query) == PDH_SUCCESS {
                out.disk_read = read_scalar(pdh.disk_read).map(|v| v.max(0.0) as u64);
                out.disk_write = read_scalar(pdh.disk_write).map(|v| v.max(0.0) as u64);
                out.disk_pct =
                    read_scalar(pdh.disk_time).map(|v| (v.max(0.0) as f32).min(100.0));

                // GPU utilization: PDH exposes one instance per engine/queue. We
                // sum the per-instance utilization (each is a 0..100 percentage
                // of that engine) and clamp to 100, i.e. min(100, sum). This
                // reflects "is the GPU busy" without over-counting past 100.
                if let Some(values) = read_array(pdh.gpu_util) {
                    let sum: f64 = values.iter().filter(|v| v.is_finite()).sum();
                    out.gpu_pct = Some((sum as f32).clamp(0.0, 100.0));
                }

                // VRAM used: sum dedicated usage across adapter-memory instances.
                if let Some(mem) = pdh.gpu_mem {
                    if let Some(values) = read_array(mem) {
                        let sum: f64 = values.iter().filter(|v| v.is_finite() && **v >= 0.0).sum();
                        out.vram_used = Some(sum as u64);
                    }
                }
            }
        }
    }

    // CPU power/temperature come from the `sensord` sidecar (LibreHardwareMonitor
    // reading MSRs); NVML can't read those. GPU power/temperature prefer NVML so
    // the Monitor/StatusBar stay consistent with the GPU tab and nvidia-smi
    // (NVML reports the core temp; the sidecar's LHM reports the hotspot, ~15 °C
    // higher). On non-NVIDIA GPUs we fall back to the sidecar.
    {
        let readings = *SIDECAR.lock();
        out.cpu_power = readings.cpu_power;
        out.cpu_temp = readings.cpu_temp;
        let (nvml_temp, nvml_power) = crate::gpu::gpu_temp_power();
        out.gpu_temp = nvml_temp.or(readings.gpu_temp);
        out.gpu_power = nvml_power.or(readings.gpu_power);
    }

    out
}
