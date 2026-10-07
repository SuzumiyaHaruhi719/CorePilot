//! SMU tuning bridge.
//!
//! Forwards `smu …` commands to the `sensord` sidecar (which owns the PawnIO
//! write host) and parses its `smuStatus` / `smuReply` lines back out. Every
//! write carries a request id (`#<n>`) that sensord echoes in its reply, and
//! [`call`] waits for THAT reply: the UI used to show "已实时应用" as soon as the
//! line reached the pipe, even when the SMU rejected it.
//!
//! IMPORTANT — no automatic reversions. CorePilot's Curve-Optimizer write is a
//! deliberate, *live* override; it is NEVER auto-reset. A bad value is cleared by
//! a **reboot** (which re-applies the user's BIOS Curve-Optimizer offsets, since
//! CorePilot never writes BIOS). Forcing CO to 0 ("stock") is a separate,
//! explicit, user-initiated action — never a silent timer — because zeroing would
//! otherwise wipe a user's existing BIOS undervolt.
//!
//! Which CPUs may be written (the message IDs are Zen4/Zen5-desktop facts) and
//! the value bounds are enforced in sensord, next to the hardware.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use parking_lot::{Condvar, Mutex};
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
    /// This CPU is one sensord will write to (Zen4/Zen5 desktop) AND the module
    /// is loaded. The UI disables apply controls otherwise.
    pub supported: bool,
    pub unsupported_reason: Option<String>,
}

/// Outcome of one SMU write, after the SMU answered (or didn't).
#[derive(Default, Clone, Serialize)]
pub struct SmuApplyResult {
    pub ok: bool,
    pub detail: String,
}

static STATUS: Lazy<Mutex<SmuStatus>> = Lazy::new(|| Mutex::new(SmuStatus::default()));

/// How long a write waits for sensord's reply. An SMU mailbox round-trip is
/// microseconds; this only expires when the sidecar is wedged or gone.
const REPLY_TIMEOUT: Duration = Duration::from_secs(3);
static NEXT_ID: AtomicU32 = AtomicU32::new(0);
/// Replies by request id, plus the condvar writers wait on.
static REPLIES: Lazy<(Mutex<HashMap<u32, SmuApplyResult>>, Condvar)> =
    Lazy::new(|| (Mutex::new(HashMap::new()), Condvar::new()));

/// Read `smuStatus` / `smuReply` out of one sidecar line (parsed once by
/// `crate::sidecar`); anything else is ignored.
pub(crate) fn ingest(v: &serde_json::Value) {
    let str_of = |o: &serde_json::Value, k: &str| o.get(k).and_then(|x| x.as_str()).map(str::to_string);
    if let Some(st) = v.get("smuStatus") {
        let mut s = STATUS.lock();
        s.pawn_io = st.get("pawnIo").and_then(|x| x.as_bool()).unwrap_or(false);
        s.loaded = st.get("loaded").and_then(|x| x.as_bool()).unwrap_or(false);
        s.version = st.get("version").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
        s.version_str = str_of(st, "versionStr").unwrap_or_default();
        s.supported = st.get("supported").and_then(|x| x.as_bool()).unwrap_or(false);
        s.unsupported_reason = str_of(st, "unsupportedReason");
    } else if let Some(rp) = v.get("smuReply") {
        let result = SmuApplyResult {
            ok: rp.get("ok").and_then(|x| x.as_bool()).unwrap_or(false),
            detail: str_of(rp, "detail").unwrap_or_default(),
        };
        {
            let mut s = STATUS.lock();
            s.last_reply = Some(result.detail.clone());
            s.last_reply_ok = result.ok;
        }
        if let Some(id) = rp.get("id").and_then(|x| x.as_u64()) {
            let (map, cv) = &*REPLIES;
            let mut m = map.lock();
            // A reply whose writer already timed out is never collected; keep
            // the map from growing with them.
            let floor = (id as u32).saturating_sub(64);
            m.retain(|k, _| *k >= floor);
            m.insert(id as u32, result);
            cv.notify_all();
        }
    }
}

/// The sidecar exited: wake every waiting writer (they report "no reply").
pub(crate) fn sidecar_gone() {
    REPLIES.1.notify_all();
}

/// Send one `smu …` write and wait for its reply.
fn call(cmd: &str) -> SmuApplyResult {
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed).wrapping_add(1);
    if !crate::sidecar::send(&format!("{cmd} #{id}")) {
        return SmuApplyResult {
            ok: false,
            detail: "sensor service not running".into(),
        };
    }
    let (map, cv) = &*REPLIES;
    let deadline = Instant::now() + REPLY_TIMEOUT;
    let mut m = map.lock();
    loop {
        if let Some(r) = m.remove(&id) {
            return r;
        }
        if cv.wait_until(&mut m, deadline).timed_out() {
            return m.remove(&id).unwrap_or(SmuApplyResult {
                ok: false,
                detail: "no reply from the SMU (timeout)".into(),
            });
        }
    }
}

/// Latest cached SMU status (clone).
pub fn status() -> SmuStatus {
    STATUS.lock().clone()
}

/// Ask the sidecar to emit a fresh `smuStatus` line (arrives async; poll `status`).
pub fn request_status() {
    crate::sidecar::send("smu status");
}

/// Apply a per-core Curve Optimizer margin (live override; no auto-revert).
pub fn apply_co(ccd: i32, core: i32, margin: i32) -> SmuApplyResult {
    call(&format!("smu co {ccd} {core} {margin}"))
}

/// Apply an all-core Curve Optimizer margin (live override; no auto-revert).
pub fn apply_co_all(margin: i32) -> SmuApplyResult {
    call(&format!("smu coall {margin}"))
}

/// Set a PBO limit. `kind` ∈ {ppt, tdc, edc}; `value` in W (PPT) or A (TDC/EDC).
pub fn apply_limit(kind: &str, value: f64) -> SmuApplyResult {
    match kind {
        "ppt" | "tdc" | "edc" if value.is_finite() => call(&format!("smu {kind} {value}")),
        _ => SmuApplyResult {
            ok: false,
            detail: format!("bad limit: {kind}"),
        },
    }
}

/// Set the PBO scalar (1×–10×).
pub fn set_scalar(scalar: i32) -> SmuApplyResult {
    call(&format!("smu scalar {scalar}"))
}

/// Explicit, user-initiated "force stock": set all-core CO to 0. This OVERRIDES
/// any BIOS Curve-Optimizer offsets for the current boot — to restore the BIOS
/// undervolt, reboot. Never called automatically.
pub fn force_stock_co() -> SmuApplyResult {
    call("smu coall 0")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The correlation: a reply only satisfies the writer whose id it echoes.
    #[test]
    fn reply_is_matched_by_id() {
        let line = |id: u32, ok: bool| {
            serde_json::json!({"smuReply": {"cmd": "ppt", "ok": ok, "detail": format!("r{id}"), "id": id}})
        };
        ingest(&line(9001, false));
        ingest(&line(9002, true));
        let (map, _) = &*REPLIES;
        let m = map.lock();
        assert_eq!(m.get(&9002).map(|r| (r.ok, r.detail.as_str())), Some((true, "r9002")));
        assert_eq!(m.get(&9001).map(|r| r.ok), Some(false));
        drop(m);
        assert!(status().last_reply_ok);
    }
}
