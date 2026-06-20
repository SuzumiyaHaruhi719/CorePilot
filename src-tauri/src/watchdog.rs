//! Log-only main-thread stall detector (the critical-path tripwire).
//!
//! Tauri v2 runs the event loop AND routes every window's `invoke()` on the main
//! thread. If anything blocks it (a hung window rebuild, a slow sync command), all
//! readings in all windows freeze at once. Three field freezes were diagnosed only
//! by capturing live kernel dumps. This watchdog turns the next one into an
//! immediate, named log line instead: it asks the main thread to stamp a heartbeat
//! once per interval; if the heartbeat goes stale beyond the threshold, it logs a
//! single WARN naming the stall. It never tries to recover — purely observability,
//! negligible cost (one tiny closure/second), so it runs in release too.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::AppHandle;

/// Epoch-millis of the last time the MAIN thread ran our heartbeat closure.
static LAST_BEAT_MS: AtomicU64 = AtomicU64::new(0);

/// Poll cadence and the stall threshold. The threshold is generous so a legitimate
/// one-off main-thread operation (e.g. window creation at startup) never trips it.
const POLL: Duration = Duration::from_secs(2);
const STALL_THRESHOLD_MS: u64 = 8_000;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Spawn the watchdog. Intended to be called once from `setup`.
pub fn start(app: AppHandle) {
    LAST_BEAT_MS.store(now_ms(), Ordering::SeqCst);
    let _ = std::thread::Builder::new()
        .name("corepilot-mainthread-watchdog".into())
        .spawn(move || {
            let mut warned = false;
            loop {
                std::thread::sleep(POLL);
                // How long since the main thread last stamped the heartbeat?
                let age = now_ms().saturating_sub(LAST_BEAT_MS.load(Ordering::SeqCst));
                if age > STALL_THRESHOLD_MS {
                    if !warned {
                        tracing::warn!(
                            stall_ms = age,
                            "MAIN THREAD STALLED — IPC router blocked >8s; readings will be frozen \
                             (critical-path invariant violated: a slow op is on the main thread)"
                        );
                        warned = true;
                    }
                } else if warned {
                    tracing::warn!(stall_ms = age, "main thread recovered");
                    warned = false;
                }
                // Post a fresh heartbeat request. If the main thread is healthy it
                // runs within ms (so the next check sees a fresh stamp); if wedged,
                // the closure never runs and `age` keeps growing → we log.
                let _ = app.run_on_main_thread(|| {
                    LAST_BEAT_MS.store(now_ms(), Ordering::SeqCst);
                });
            }
        });
}
