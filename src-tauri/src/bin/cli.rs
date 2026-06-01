//! CorePilot headless CLI — exercises the same backend the Tauri app uses, but
//! prints JSON to stdout. Built for debugging/automation without the GUI:
//!
//!   cli gpu-info                      # GPU tuning snapshot (NVML)
//!   cli gpu-apply '{"powerLimitW":300,"tempLimitC":80}'
//!   cli gpu-reset                     # restore stock GPU tuning
//!   cli topology                      # CPU / CCD topology
//!   cli sensors                       # power / temp / GPU / disk / net sample
//!   cli memory                        # physical memory detail
//!   cli services [filter]             # Windows services
//!   cli startup                       # startup entries
//!   cli processes [filter] [limit]    # process list (default top 40 by CPU)
//!
//! Mutating commands (gpu-apply/gpu-reset) require admin, same as the app.

use std::time::Duration;

use corepilot_lib::{affinity, gpu, optimize, process, sensors, topology, winsvc};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let cmd = args.get(1).map(String::as_str).unwrap_or("help");

    match cmd {
        "gpu-info" => print_json(&gpu::gpu_oc_info()),
        "gpu-apply" => {
            let raw = args.get(2).cloned().unwrap_or_default();
            match serde_json::from_str::<gpu::GpuOcSettings>(&raw) {
                Ok(settings) => print_result(gpu::gpu_oc_apply(settings)),
                Err(e) => fail(&format!("invalid settings JSON: {e}")),
            }
        }
        "gpu-reset" => print_result(gpu::gpu_oc_reset()),
        "gpu-temp-probe" => print_json(&gpu::gpu_temp_probe()),
        "gpu-engines" => {
            // PDH rate counters need two samples; prime, wait, then read.
            let _ = process::gpu_engine_loads();
            std::thread::sleep(Duration::from_millis(600));
            print_json(&process::gpu_engine_loads());
        }
        "topology" => print_json(&topology::detect()),
        "sensors" => print_json(&sensors::sample()),
        "memory" => match optimize::memory_detail() {
            Ok(v) => print_json(&v),
            Err(e) => fail(&e.to_string()),
        },
        "power-plan" => match optimize::get_power_plan() {
            Ok(v) => println!("{v}"),
            Err(e) => fail(&e.to_string()),
        },
        "free-ws" => print_result(optimize::free_working_sets().map_err(|e| e.to_string())),
        "purge-standby" => print_result(optimize::purge_standby().map_err(|e| e.to_string())),
        "flush-dns" => print_result(optimize::flush_dns().map_err(|e| e.to_string())),
        "clean-temp" => print_json(&optimize::clean_temp()),
        "set-affinity" => {
            let pid = args.get(2).and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
            let mask = args.get(3).and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
            print_result(affinity::set_affinity(pid, mask).map_err(|e| e.to_string()));
        }
        "set-priority" => {
            let pid = args.get(2).and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
            let class = args.get(3).and_then(|s| s.parse::<u32>().ok()).unwrap_or(0x20);
            print_result(affinity::set_priority(pid, class).map_err(|e| e.to_string()));
        }
        "services" => match winsvc::list_services() {
            Ok(mut v) => {
                if let Some(f) = args.get(2) {
                    let f = f.to_lowercase();
                    v.retain(|s| s.name.to_lowercase().contains(&f) || s.display.to_lowercase().contains(&f));
                }
                print_json(&v);
            }
            Err(e) => fail(&e.to_string()),
        },
        "startup" => match winsvc::list_startup() {
            Ok(v) => print_json(&v),
            Err(e) => fail(&e.to_string()),
        },
        "processes" => processes(&args),
        _ => usage(),
    }
}

fn processes(args: &[String]) {
    let filter = args.get(2).map(|s| s.to_lowercase());
    let limit: usize = args
        .get(3)
        .and_then(|s| s.parse().ok())
        .unwrap_or(if filter.is_some() { 80 } else { 40 });

    let mut sys = sysinfo::System::new();
    sys.refresh_all();
    // Second sample after a short delay so CPU% is meaningful.
    std::thread::sleep(Duration::from_millis(300));
    let threads = process::thread_counts().unwrap_or_default();
    let logical = sys.cpus().len().max(1) as f32;
    let mut list = process::list(&mut sys, &threads, logical);

    if let Some(f) = &filter {
        list.retain(|p| {
            p.name.to_lowercase().contains(f)
                || p.description.as_deref().map(|d| d.to_lowercase().contains(f)).unwrap_or(false)
        });
    }
    list.sort_by(|a, b| b.cpu.partial_cmp(&a.cpu).unwrap_or(std::cmp::Ordering::Equal));
    let total = list.len();
    list.truncate(limit);
    eprintln!("(showing {} of {} processes)", list.len(), total);
    print_json(&list);
}

fn print_json<T: serde::Serialize>(value: &T) {
    match serde_json::to_string_pretty(value) {
        Ok(s) => println!("{s}"),
        Err(e) => fail(&format!("serialize error: {e}")),
    }
}

fn print_result(r: Result<(), String>) {
    match r {
        Ok(()) => println!("{{ \"ok\": true }}"),
        Err(e) => {
            println!("{{ \"ok\": false, \"error\": {} }}", serde_json::to_string(&e).unwrap_or_else(|_| "\"\"".into()));
            std::process::exit(1);
        }
    }
}

fn fail(msg: &str) {
    eprintln!("error: {msg}");
    std::process::exit(1);
}

fn usage() {
    eprintln!("CorePilot CLI");
    eprintln!("  cli gpu-info");
    eprintln!("  cli gpu-apply '<json GpuOcSettings>'   e.g. '{{\"powerLimitW\":300,\"tempLimitC\":80,\"fanSpeedPct\":60}}'");
    eprintln!("  cli gpu-reset");
    eprintln!("  cli topology | sensors | memory | power-plan");
    eprintln!("  cli services [filter] | startup");
    eprintln!("  cli processes [filter] [limit]");
}
