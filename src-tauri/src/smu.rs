//! SMU tuning bridge.
//!
//! Forwards `smu …` commands to the `sensord` sidecar (which owns the PawnIO
//! write host) over the same stdin channel the fan engine uses, and parses the
//! sidecar's JSON `smuStatus` / `smuReply` lines back out.
//!
//! Safety: applying a Curve-Optimizer margin arms an **auto-revert watchdog** —
//! the value is reset to 0 after `revert_secs` unless the user confirms (keeps)
//! it first. An unstable undervolt therefore self-heals, and because nothing is
//! ever written to BIOS, a reboot clears any applied SMU state regardless. All
//! values are additionally clamped in the sidecar host.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Serialize;

/// Latest SMU status + last command reply, surfaced to the UI.
#[derive(Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmuStatus {
    /// PawnIO driver installed on the machine.
    pub pawn_io: bool,
    /// The RyzenSMU module loaded successfully (writes possible).
    pub loaded: bool,
    pub version: u32,
    pub version_str: String,
    /// Detail of the most recent `smu` command reply (apply error/success text).
    pub last_reply: Option<String>,
    pub last_reply_ok: bool,
}

static STATUS: Lazy<Mutex<SmuStatus>> = Lazy::new(|| Mutex::new(SmuStatus::default()));

/// Bumped on every CO apply; the watchdog only reverts if its token is still the
/// latest (no newer apply / confirm happened in the meantime).
static CO_TOKEN: AtomicU64 = AtomicU64::new(0);
/// Whether the most recent CO apply has been confirmed (kept) by the user.
static CO_CONFIRMED: AtomicBool = AtomicBool::new(true);

/// Parse an `smuStatus` / `smuReply` line emitted by the sidecar. Called for
/// every sidecar stdout line; ignores anything that isn't one of ours.
pub fn ingest_line(line: &str) {
    let trimmed = line.trim();
    if !trimmed.contains("smuStatus") && !trimmed.contains("smuReply") {
        return;
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) else {
        return;
    };
    if let Some(st) = v.get("smuStatus") {
        let mut s = STATUS.lock();
        s.pawn_io = st.get("pawnIo").and_then(|x| x.as_bool()).unwrap_or(false);
        s.loaded = st.get("loaded").and_then(|x| x.as_bool()).unwrap_or(false);
        s.version = st.get("version").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
        s.version_str = st
            .get("versionStr")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
    } else if let Some(rp) = v.get("smuReply") {
        let mut s = STATUS.lock();
        s.last_reply = rp.get("detail").and_then(|x| x.as_str()).map(str::to_string);
        s.last_reply_ok = rp.get("ok").and_then(|x| x.as_bool()).unwrap_or(false);
    }
}

fn send(cmd: &str) -> bool {
    crate::fan::send_command(cmd)
}

/// Latest cached SMU status (clone).
pub fn status() -> SmuStatus {
    STATUS.lock().clone()
}

/// Ask the sidecar to emit a fresh `smuStatus` line (the reply arrives async on
/// the next sidecar read; callers poll `status()`).
pub fn request_status() {
    send("smu status");
}

/// Apply a per-core Curve Optimizer margin and arm the auto-revert watchdog.
pub fn apply_co(ccd: i32, core: i32, margin: i32, revert_secs: u64) -> bool {
    let ok = send(&format!("smu co {ccd} {core} {margin}"));
    arm_watchdog(revert_secs);
    ok
}

/// Apply an all-core Curve Optimizer margin and arm the auto-revert watchdog.
pub fn apply_co_all(margin: i32, revert_secs: u64) -> bool {
    let ok = send(&format!("smu coall {margin}"));
    arm_watchdog(revert_secs);
    ok
}

/// Set a PBO limit. `kind` ∈ {ppt, tdc, edc}; `value` in W (PPT) or A (TDC/EDC).
pub fn apply_limit(kind: &str, value: f64) -> bool {
    match kind {
        "ppt" | "tdc" | "edc" => send(&format!("smu {kind} {value}")),
        _ => false,
    }
}

/// Set the PBO scalar (1×–10×).
pub fn set_scalar(scalar: i32) -> bool {
    send(&format!("smu scalar {scalar}"))
}

/// Mark the current CO apply as accepted — cancels the pending auto-revert.
pub fn confirm() {
    CO_CONFIRMED.store(true, Ordering::SeqCst);
}

/// Immediately revert Curve Optimizer to 0 (removes any undervolt).
pub fn revert_co() -> bool {
    CO_CONFIRMED.store(true, Ordering::SeqCst);
    send("smu coall 0")
}

/// Arm a one-shot watchdog: after `revert_secs`, if this remains the latest CO
/// apply and the user hasn't confirmed, reset CO to 0. `revert_secs == 0` disables.
fn arm_watchdog(revert_secs: u64) {
    if revert_secs == 0 {
        return;
    }
    let token = CO_TOKEN.fetch_add(1, Ordering::SeqCst) + 1;
    CO_CONFIRMED.store(false, Ordering::SeqCst);
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(revert_secs));
        if CO_TOKEN.load(Ordering::SeqCst) == token && !CO_CONFIRMED.load(Ordering::SeqCst) {
            let _ = send("smu coall 0");
        }
    });
}
