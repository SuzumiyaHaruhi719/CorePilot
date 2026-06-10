//! All-core synthetic CPU load for thermal characterization (spec §3 阶段 3):
//! one BELOW_NORMAL-priority thread per logical core running a register-only
//! integer mul-add loop (CPU-Z style — no memory traffic, no AVX power-virus).
//! RAII: dropping the handle stops and joins every worker, so a panicking tune
//! thread can never leave the CPU pinned.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;

use windows::Win32::System::SystemInformation::GetSystemInfo;
use windows::Win32::System::Threading::{
    GetCurrentProcess, GetProcessAffinityMask, SetProcessAffinityMask,
};

pub struct CpuLoad {
    stop: Arc<AtomicBool>,
    handles: Vec<JoinHandle<()>>,
    /// Original process affinity to restore on drop, when we had to widen it.
    restore_mask: Option<usize>,
}

impl CpuLoad {
    pub fn start() -> Self {
        // Field lesson (9950X3D + CCD-pinning tools): the app can INHERIT a
        // halved affinity mask (e.g. 0xffff0000) from whatever launched it, or
        // be pinned by an affinity-rule tool. The thermal sweep needs the REAL
        // worst case, so temporarily widen our own process affinity to the
        // full system mask and restore the original afterwards. (Single
        // processor group — fine up to 64 logical CPUs; this is a desktop app.)
        let mut restore_mask = None;
        let mut n = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(8);
        unsafe {
            let mut si = Default::default();
            GetSystemInfo(&mut si);
            let sys_cpus = si.dwNumberOfProcessors as usize;
            let (mut proc_mask, mut sys_mask) = (0usize, 0usize);
            if GetProcessAffinityMask(
                GetCurrentProcess(),
                &mut proc_mask as *mut usize,
                &mut sys_mask as *mut usize,
            )
            .is_ok()
                && proc_mask != 0
                && sys_mask != 0
                && proc_mask.count_ones() < sys_mask.count_ones()
            {
                if SetProcessAffinityMask(GetCurrentProcess(), sys_mask).is_ok() {
                    restore_mask = Some(proc_mask);
                }
            }
            n = n.max(sys_cpus);
        }

        let stop = Arc::new(AtomicBool::new(false));
        let handles = (0..n)
            .map(|i| {
                let stop = Arc::clone(&stop);
                std::thread::Builder::new()
                    .name(format!("cpu-load-{i}"))
                    .spawn(move || {
                        lower_thread_priority();
                        let mut acc: u64 = 0x9e37_79b9_7f4a_7c15 ^ i as u64;
                        while !stop.load(Ordering::Relaxed) {
                            // Register-only integer chain; black_box defeats
                            // the optimizer without touching memory.
                            for _ in 0..4096 {
                                acc = acc.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                                acc ^= acc >> 33;
                            }
                            std::hint::black_box(acc);
                        }
                    })
                    .expect("spawn cpu-load worker")
            })
            .collect();
        Self { stop, handles, restore_mask }
    }
}

impl Drop for CpuLoad {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        for h in self.handles.drain(..) {
            let _ = h.join();
        }
        // Hand the user's (or their pinning tool's) affinity choice back.
        if let Some(mask) = self.restore_mask.take() {
            unsafe {
                let _ = SetProcessAffinityMask(GetCurrentProcess(), mask);
            }
        }
    }
}

/// Below-normal priority: workers saturate idle cores but yield instantly to
/// the UI, the sidecar, and the tune thread itself.
fn lower_thread_priority() {
    use windows::Win32::System::Threading::{GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_BELOW_NORMAL};
    unsafe {
        let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn cpu_load_starts_and_stops_promptly() {
        let load = CpuLoad::start();
        std::thread::sleep(Duration::from_millis(150));
        let begin = Instant::now();
        drop(load); // must join every worker quickly
        assert!(begin.elapsed() < Duration::from_secs(2), "drop hung");
    }

    /// Field diagnostic (run manually on the affected machine):
    /// cargo test --lib load_gen -- --ignored --nocapture
    #[test]
    #[ignore]
    fn cpu_load_measured_utilization() {
        use sysinfo::System;
        use windows::Win32::System::Threading::GetCurrentProcess;
        use windows::Win32::System::SystemInformation::GetSystemInfo;

        // Evidence A: what the spawner believes vs what the SYSTEM has.
        let par = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(0);
        let sys_cpus = unsafe {
            let mut si = Default::default();
            GetSystemInfo(&mut si);
            si.dwNumberOfProcessors
        };
        // Evidence B: this process's affinity mask (inherited from the shell).
        let (mut proc_mask, mut sys_mask) = (0usize, 0usize);
        unsafe {
            use windows::Win32::System::Threading::GetProcessAffinityMask;
            let _ = GetProcessAffinityMask(
                GetCurrentProcess(),
                &mut proc_mask as *mut usize,
                &mut sys_mask as *mut usize,
            );
        }
        println!(
            "PARALLELISM available={par} system={sys_cpus} affinity={proc_mask:#x} ({} bits) sysmask={sys_mask:#x}",
            proc_mask.count_ones()
        );

        let mut sys = System::new();
        let sample = |sys: &mut System| -> f32 {
            sys.refresh_cpu_usage();
            std::thread::sleep(Duration::from_millis(600));
            sys.refresh_cpu_usage();
            sys.global_cpu_usage()
        };
        let before = sample(&mut sys);
        let load = CpuLoad::start();
        std::thread::sleep(Duration::from_secs(2));
        let during = sample(&mut sys);
        drop(load);
        println!("UTILIZATION before={before:.0}% during(below-normal)={during:.0}%");
        assert!(during >= 90.0, "below-normal load gen only reached {during:.0}%");
    }
}
