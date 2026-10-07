//! The `sensord` sidecar — the ONE owner of its process, pipes and lifecycle.
//!
//! sensord (LibreHardwareMonitor + the PawnIO SMU host) streams one JSON line
//! per poll on stdout and takes line commands on stdin (`set`/`auto`/`autoall`/
//! `forget` for fans, `interval`, `smu …`). Spawn, reader, watchdog, write
//! channel, poll interval, backoff and stop used to be spread over `sensors`,
//! `fan`, `smu`, `updater` and `taskbar_mon`; most of the sidecar bugs came out
//! of the seams between them. Consumers now only:
//!
//! * call [`ensure`] (cheap; spawns when dead and the backoff allows),
//! * [`send`] a command line — a `try_send` into a bounded queue drained by one
//!   writer thread, so no caller ever blocks on, or holds a lock across, a pipe
//!   write (a wedged sensord used to freeze the main thread through
//!   `fan_set_config` / `smu_*`); a full queue drops the line, which the fan
//!   engine's 2 s re-send heals,
//! * receive each line, parsed ONCE, in their `ingest(&Value)`.
//!
//! [`graceful_stop`] is the only stop path (app exit, updater, WM_ENDSESSION):
//! queue `autoall`, close stdin so sensord runs its own reset on EOF, wait, and
//! only then terminate.

use std::io::{BufRead, BufReader, Write};
use std::os::windows::process::CommandExt;
use std::process::{ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use parking_lot::Mutex;

/// File name of the bundled sidecar (Tauri strips the target triple from
/// `externalBin`, placing it next to the main executable).
const SIDECAR_EXE: &str = "sensord.exe";
/// `CREATE_NO_WINDOW`: no console flash for the sidecar.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// Pending command lines. The engine writes a handful every 2 s; 64 only fills
/// when sensord stopped reading, and then dropping is the right answer.
const WRITE_QUEUE: usize = 64;

/// A sidecar that dies younger than this counts as a failed start and doubles
/// the respawn delay ([`BACKOFF_MIN`] … [`BACKOFF_MAX`]); a longer run resets it.
/// Without this a sensord that crashes on start (missing .NET runtime,
/// quarantined driver) was re-created every 1.5 s sampler tick, forever.
const HEALTHY_RUN: Duration = Duration::from_secs(10);
const BACKOFF_MIN: Duration = Duration::from_millis(1500);
const BACKOFF_MAX: Duration = Duration::from_secs(300);
/// Consecutive failed starts before we say so at WARN.
const WARN_AFTER_FAILURES: u32 = 5;

/// Watchdog cadence and patience. It counts its own TICKS without a new line
/// rather than comparing clocks: a wall-clock gap (NTP step, manual change) or
/// a sleep/resume used to read as a 30 s silence and kill a healthy sidecar.
/// A resume now costs at most one tick.
const WATCHDOG_TICK: Duration = Duration::from_secs(5);
const WATCHDOG_MISSES: u32 = 7;

/// How long sensord gets to run its own reset after stdin closes before it is
/// terminated. Covers its worst `Gate` hold (an LHM close+reopen on the
/// stale-bank path).
const EOF_GRACE: Duration = Duration::from_secs(5);

/// Poll cadence while anything consumes the readings, and while idle (the main
/// window in the tray, no recorded game, no fan steered by us). sensord's LHM
/// sweep is the most expensive thing in the idle process (3.1 % of a core at
/// 1400 ms).
const INTERVAL_ACTIVE_MS: u32 = 1400;
const INTERVAL_IDLE_MS: u32 = 3000;
/// A calibration / auto-tune samples at 1 Hz.
const INTERVAL_TUNE_MS: u32 = 1000;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum State {
    /// No process; [`ensure`] may spawn once `next_spawn_at` has passed.
    Dead,
    /// A spawn is in flight (keeps concurrent `ensure` calls from doubling it).
    Starting,
    Live,
    /// [`graceful_stop`] ran: never respawn (the app is exiting or updating).
    Stopped,
}

struct Shared {
    state: State,
    pid: u32,
    /// Bumped per spawned process; threads of an older generation stand down.
    generation: u64,
    writer: Option<SyncSender<String>>,
    next_spawn_at: Option<Instant>,
    backoff: Duration,
    failures: u32,
    /// Interval last pushed to THIS process (0 = none yet).
    interval_ms: u32,
}

static SHARED: Lazy<Mutex<Shared>> = Lazy::new(|| {
    Mutex::new(Shared {
        state: State::Dead,
        pid: 0,
        generation: 0,
        writer: None,
        next_spawn_at: None,
        backoff: BACKOFF_MIN,
        failures: 0,
        interval_ms: 0,
    })
});

/// Lines received from the current process (watchdog liveness signal).
static LINES: AtomicU64 = AtomicU64::new(0);
/// Rate limit for the "queue full" warning (unix seconds of the last one).
static FULL_WARNED_AT: AtomicU64 = AtomicU64::new(0);
/// sensord's own chip-reopen counter, for the "> 3 reopens / min" health warning.
static REOPEN_STATE: Lazy<Mutex<(u64, Instant)>> = Lazy::new(|| Mutex::new((0, Instant::now())));
/// PID of the live process (0 = none), readable without the lock.
static PID: AtomicU32 = AtomicU32::new(0);

/// Spawn the sidecar if it isn't running and the backoff allows. Idempotent and
/// cheap when it is running; safe to call from every sampler tick.
pub fn ensure() {
    {
        let mut sh = SHARED.lock();
        if sh.state != State::Dead {
            return;
        }
        if sh.next_spawn_at.is_some_and(|at| Instant::now() < at) {
            return;
        }
        sh.state = State::Starting;
    }
    // CreateProcess can take hundreds of ms under AV — never under the lock.
    match spawn() {
        Ok(()) => {}
        Err(why) => {
            let mut sh = SHARED.lock();
            note_failure(&mut sh, &why);
            if sh.state == State::Starting {
                sh.state = State::Dead;
            }
        }
    }
}

/// Queue one command line for the sidecar. Never blocks. `false` when no
/// sidecar is running or the queue is full (the line is dropped).
pub fn send(line: &str) -> bool {
    let sh = SHARED.lock();
    let Some(tx) = sh.writer.as_ref() else {
        return false;
    };
    match tx.try_send(line.to_string()) {
        Ok(()) => true,
        Err(TrySendError::Full(_)) => {
            let now = unix_secs();
            if now.saturating_sub(FULL_WARNED_AT.swap(now, Ordering::Relaxed)) >= 60 {
                tracing::warn!("sensord command queue full; dropping commands (sidecar not reading stdin)");
            }
            false
        }
        Err(TrySendError::Disconnected(_)) => false,
    }
}

/// The live sidecar's generation (bumped per spawned process).
pub fn generation() -> u64 {
    SHARED.lock().generation
}

/// Hand fans back and stop the sidecar for good (app exit / update). Blocks up
/// to `timeout`; idempotent.
pub fn graceful_stop(timeout: Duration) {
    let (generation, pid) = {
        let mut sh = SHARED.lock();
        if sh.state == State::Stopped {
            return;
        }
        let was_live = sh.state == State::Live;
        sh.state = State::Stopped;
        if !was_live {
            return;
        }
        // Queued BEFORE the sender drops: the writer drains it, then closes
        // stdin, so sensord runs `autoall` and its own EOF reset in order.
        if let Some(tx) = sh.writer.take() {
            let _ = tx.try_send("autoall".to_string());
        }
        (sh.generation, sh.pid)
    };
    if !wait_gone(generation, timeout) {
        tracing::warn!("sensord (pid {pid}) still running after stdin close; terminating");
        if let Err(e) = crate::process::kill(pid) {
            tracing::warn!("could not stop sensord (pid {pid}): {e}");
        }
        wait_gone(generation, Duration::from_secs(2));
    }
}

// --- poll interval ---------------------------------------------------------------

/// Which cadence the sidecar should run at right now. Anything that CONSUMES
/// readings keeps the fast cadence: the window on screen, a recorded game (its
/// 5 Hz samples interpolate from these), a fan our engine steers (halving its
/// feedback is the one slowdown that could be felt), a tune (1 Hz).
fn desired_interval_ms() -> u32 {
    if crate::fan::exclusive_active() {
        return INTERVAL_TUNE_MS;
    }
    if !crate::ui_visibility::main_hidden() || crate::perf_recorder::active_session_count() > 0 {
        return INTERVAL_ACTIVE_MS;
    }
    let driving_fans = crate::fan::config_snapshot()
        .iter()
        .any(|c| c.mode == "curve" || c.mode == "manual");
    if driving_fans {
        INTERVAL_ACTIVE_MS
    } else {
        INTERVAL_IDLE_MS
    }
}

/// Push the desired interval, only when it changed for this process. Call as
/// often as you like (the visibility thread does every 2 s).
pub fn refresh_interval() {
    let want = desired_interval_ms();
    if SHARED.lock().interval_ms == want {
        return;
    }
    if send(&format!("interval {want}")) {
        SHARED.lock().interval_ms = want;
        tracing::debug!("sensord poll interval -> {want} ms");
    }
}

// --- lifecycle internals -----------------------------------------------------------

fn spawn() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let path = exe
        .parent()
        .ok_or("no exe dir")?
        .join(SIDECAR_EXE);
    if !path.exists() {
        return Err(format!("{} missing", path.display()));
    }
    // `--parent`: sensord exits (resetting fans) even if its stdin pipe outlives
    // a CorePilot crash.
    let mut child = Command::new(&path)
        .arg("--parent")
        .arg(std::process::id().to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("spawn failed: {e}"))?;
    let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        let _ = child.kill();
        let _ = child.wait();
        return Err("no stdio pipes".into());
    };

    let (tx, rx) = sync_channel::<String>(WRITE_QUEUE);
    let generation = {
        let mut sh = SHARED.lock();
        if sh.state != State::Starting {
            // graceful_stop ran while we were spawning: don't leave it running.
            drop(sh);
            let _ = child.kill();
            let _ = child.wait();
            return Ok(());
        }
        sh.generation += 1;
        sh.state = State::Live;
        sh.pid = child.id();
        sh.writer = Some(tx);
        sh.interval_ms = 0;
        sh.generation
    };
    PID.store(child.id(), Ordering::SeqCst);
    LINES.store(0, Ordering::SeqCst);
    let started = Instant::now();

    let _ = std::thread::Builder::new()
        .name("sensord-writer".into())
        .spawn(move || writer_loop(stdin, rx));
    let pid = child.id();
    let reader = std::thread::Builder::new()
        .name("sensord-reader".into())
        .spawn(move || {
            reader_loop(stdout);
            // stdout closed → the process is exiting. Reap it for the verdict.
            let clean = child.wait().map(|s| s.success()).unwrap_or(false);
            on_exit(generation, clean, started.elapsed());
        });
    if reader.is_err() {
        let mut sh = SHARED.lock();
        sh.writer = None;
        sh.state = State::Dead;
        drop(sh);
        let _ = crate::process::kill(pid);
        return Err("reader thread failed to start".into());
    }
    let _ = std::thread::Builder::new()
        .name("sensord-watchdog".into())
        .spawn(move || watchdog_loop(generation, pid));

    refresh_interval();
    Ok(())
}

fn writer_loop(mut stdin: ChildStdin, rx: Receiver<String>) {
    for mut line in rx {
        line.push('\n');
        if stdin.write_all(line.as_bytes()).and_then(|()| stdin.flush()).is_err() {
            break;
        }
    }
    // Dropping stdin here is the EOF sensord resets on.
}

fn reader_loop(stdout: std::process::ChildStdout) {
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else {
            break;
        };
        LINES.fetch_add(1, Ordering::Relaxed);
        let Ok(json) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
            continue;
        };
        note_reopens(&json);
        crate::sensors::ingest(&json);
        crate::fan::ingest(&json);
        crate::smu::ingest(&json);
    }
}

/// The process of `generation` exited (`clean` = exit code 0, i.e. sensord ran
/// its own fan reset on the way out).
fn on_exit(generation: u64, clean: bool, lived: Duration) {
    crate::sensors::sidecar_gone();
    crate::fan::sidecar_gone(clean);
    crate::smu::sidecar_gone();
    let mut sh = SHARED.lock();
    if sh.generation != generation {
        return;
    }
    sh.pid = 0;
    sh.writer = None;
    PID.store(0, Ordering::SeqCst);
    if sh.state == State::Stopped {
        return;
    }
    sh.state = State::Dead;
    if lived < HEALTHY_RUN {
        note_failure(&mut sh, &format!("exited after {} ms", lived.as_millis()));
    } else {
        sh.backoff = BACKOFF_MIN;
        sh.failures = 0;
        sh.next_spawn_at = None;
        if !clean {
            tracing::warn!("sensord exited uncleanly after {} s; respawning", lived.as_secs());
        }
    }
}

fn note_failure(sh: &mut Shared, why: &str) {
    sh.failures += 1;
    let delay = sh.backoff;
    sh.next_spawn_at = Some(Instant::now() + delay);
    sh.backoff = (sh.backoff * 2).min(BACKOFF_MAX);
    if sh.failures == WARN_AFTER_FAILURES || (sh.failures > WARN_AFTER_FAILURES && delay == BACKOFF_MAX) {
        tracing::warn!(
            failures = sh.failures,
            "sensord keeps failing ({why}); next try in {} s",
            delay.as_secs()
        );
    } else {
        tracing::debug!("sensord start failed ({why}); retry in {} ms", delay.as_millis());
    }
}

fn watchdog_loop(generation: u64, pid: u32) {
    let mut last = LINES.load(Ordering::Relaxed);
    let mut misses = 0;
    loop {
        std::thread::sleep(WATCHDOG_TICK);
        if SHARED.lock().generation != generation || PID.load(Ordering::SeqCst) != pid {
            return;
        }
        let now = LINES.load(Ordering::Relaxed);
        if now != last {
            last = now;
            misses = 0;
            continue;
        }
        misses += 1;
        if misses < WATCHDOG_MISSES {
            continue;
        }
        // Hung (a blocking LHM read never returns). Close stdin first so a
        // merely-slow sensord still runs its fan reset; terminate only after.
        tracing::warn!("sensord (pid {pid}) silent for {misses} watchdog ticks; restarting it");
        {
            let mut sh = SHARED.lock();
            if sh.generation == generation {
                sh.writer = None;
            }
        }
        if !wait_gone(generation, EOF_GRACE) {
            let _ = crate::process::kill(pid);
        }
        return;
    }
}

/// Wait until the process of `generation` has been reaped (or `timeout`).
fn wait_gone(generation: u64, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        {
            let sh = SHARED.lock();
            if sh.generation != generation || sh.pid == 0 {
                return true;
            }
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn note_reopens(json: &serde_json::Value) {
    let Some(reopens) = json.get("reopens").and_then(|v| v.as_u64()) else {
        return;
    };
    let mut state = REOPEN_STATE.lock();
    let now = Instant::now();
    if now.duration_since(state.1) >= Duration::from_secs(60) {
        *state = (reopens, now);
    } else if reopens > state.0 + 3 {
        tracing::warn!(reopens, "sensord chip reopens advanced by more than 3/min");
        state.0 = reopens;
    }
}

fn unix_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> Shared {
        Shared {
            state: State::Dead,
            pid: 0,
            generation: 0,
            writer: None,
            next_spawn_at: None,
            backoff: BACKOFF_MIN,
            failures: 0,
            interval_ms: 0,
        }
    }

    #[test]
    fn failed_starts_back_off_exponentially_to_the_cap() {
        let mut sh = fresh();
        let mut delays = Vec::new();
        for _ in 0..12 {
            delays.push(sh.backoff);
            note_failure(&mut sh, "test");
        }
        assert_eq!(delays[0], BACKOFF_MIN);
        assert_eq!(delays[1], BACKOFF_MIN * 2);
        assert_eq!(delays[2], BACKOFF_MIN * 4);
        assert_eq!(*delays.last().unwrap(), BACKOFF_MAX);
        assert!(delays.windows(2).all(|w| w[1] >= w[0]));
        assert!(sh.next_spawn_at.is_some());
        assert_eq!(sh.failures, 12);
    }

    /// Real round trip against the shipped sensord: spawn, first lines, an SMU
    /// write correlated by id (out of range, so sensord refuses it before the
    /// SMU), then the graceful stop. Ignored: it needs
    /// `binaries/sensord-x86_64-pc-windows-msvc.exe` copied next to the test
    /// binary as `target/debug/deps/sensord.exe`, and spawns a real process.
    #[test]
    #[ignore]
    fn real_sidecar_round_trip() {
        ensure();
        std::thread::sleep(Duration::from_secs(4));
        assert_eq!(SHARED.lock().state, State::Live, "sensord did not start");
        assert!(LINES.load(Ordering::Relaxed) > 0, "no lines from sensord");
        let refused = crate::smu::apply_limit("ppt", 10.0);
        assert!(!refused.ok);
        assert!(refused.detail.starts_with("out of range"), "{}", refused.detail);
        let pid = SHARED.lock().pid;
        let t = Instant::now();
        graceful_stop(Duration::from_secs(3));
        assert!(t.elapsed() < Duration::from_secs(3), "stop fell back to terminate");
        assert!(!crate::fps::pid_alive(pid), "sensord still running");
        ensure();
        assert_eq!(SHARED.lock().state, State::Stopped, "respawned after stop");
    }
}
