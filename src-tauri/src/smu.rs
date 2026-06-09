//! SMU tuning bridge.
//!
//! Forwards `smu …` commands to the `sensord` sidecar (which owns the PawnIO
//! write host) over the same stdin channel the fan engine uses, and parses the
//! sidecar's JSON `smuStatus` / `smuReply` lines back out.
//!
//! IMPORTANT — no automatic reversions. CorePilot's Curve-Optimizer write is a
//! deliberate, *live* override; it is NEVER auto-reset. A bad value is cleared by
//! a **reboot** (which re-applies the user's BIOS Curve-Optimizer offsets, since
//! CorePilot never writes BIOS). Forcing CO to 0 ("stock") is a separate,
//! explicit, user-initiated action — never a silent timer — because zeroing would
//! otherwise wipe a user's existing BIOS undervolt.

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

/// Ask the sidecar to emit a fresh `smuStatus` line (arrives async; poll `status`).
pub fn request_status() {
    send("smu status");
}

/// Apply a per-core Curve Optimizer margin (live override; no auto-revert).
pub fn apply_co(ccd: i32, core: i32, margin: i32) -> bool {
    send(&format!("smu co {ccd} {core} {margin}"))
}

/// Apply an all-core Curve Optimizer margin (live override; no auto-revert).
pub fn apply_co_all(margin: i32) -> bool {
    send(&format!("smu coall {margin}"))
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

/// Explicit, user-initiated "force stock": set all-core CO to 0. This OVERRIDES
/// any BIOS Curve-Optimizer offsets for the current boot — to restore the BIOS
/// undervolt, reboot. Never called automatically.
pub fn force_stock_co() -> bool {
    send("smu coall 0")
}
