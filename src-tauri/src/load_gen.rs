//! All-core synthetic CPU load for thermal characterization (spec §3 阶段 3):
//! one BELOW_NORMAL-priority thread per logical core running a register-only
//! integer mul-add loop (CPU-Z style — no memory traffic, no AVX power-virus).
//! RAII: dropping the handle stops and joins every worker, so a panicking tune
//! thread can never leave the CPU pinned.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;

pub struct CpuLoad {
    stop: Arc<AtomicBool>,
    handles: Vec<JoinHandle<()>>,
}

impl CpuLoad {
    pub fn start() -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let n = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(8);
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
        Self { stop, handles }
    }
}

impl Drop for CpuLoad {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        for h in self.handles.drain(..) {
            let _ = h.join();
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
}
