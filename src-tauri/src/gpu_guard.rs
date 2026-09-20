//! "Did this machine just die with the overclock armed?" — the one signal the
//! frontend checks before it re-applies a saved GPU OC profile at startup.
//!
//! ## Why this exists
//!
//! `applyOnStartup` re-arms the persisted GPU profile (on the reporting machine:
//! 600 W power limit, +120 core / +100 mem) a second or two after the window
//! opens. That is correct behaviour right up until the overclock is what killed
//! the box: the System log on this machine shows three `nvlddmkm` 153 bursts in
//! four days and four unclean shutdowns in fourteen, two of them immediately
//! after a startup auto-apply, with WER buckets `LKD_0x141_Tdr:..._Ada_UserOC`
//! leading in. The user cannot break that loop from inside the app, because the
//! re-arm lands before they can reach the toggle.
//!
//! So: read the System log once at startup, and if the previous session ended in
//! an unclean shutdown or a display-driver fault, report `blocked` and let the
//! frontend skip the AUTOMATIC apply. The manual apply path is untouched — this
//! never prevents the user from re-applying deliberately, it only stops the app
//! from doing it for them straight into a machine that just crashed.
//!
//! ## Why there is no persisted marker
//!
//! The obvious design ("write a `crashed` flag, clear it on clean exit") is
//! wrong here and was rejected: CorePilot is killed outright by every normal
//! Windows restart, so the flag would survive a perfectly clean reboot and the
//! user would be nagged after every single one. The event log already holds the
//! ground truth, timestamped, written by the kernel — read that instead and keep
//! zero state. (Rule 3 also means any such marker would have to go through
//! `persist.rs`; not writing one at all is strictly better.)
//!
//! ## Fail-soft direction
//!
//! Every error path returns "not blocked". A false block would silently disable
//! a feature the user switched on; a false pass just leaves today's behaviour.
//! Never invent a block we cannot evidence.

use std::iter::once;

use serde::Serialize;
use windows::core::PCWSTR;
use windows::Win32::System::EventLog::{
    EvtClose, EvtNext, EvtQuery, EvtQueryChannelPath, EvtQueryReverseDirection, EvtRender,
    EvtRenderEventXml, EVT_HANDLE,
};
use windows::Win32::System::SystemInformation::GetTickCount64;

/// Answer handed to the frontend. `reason` is a STABLE MACHINE TAG, never a
/// sentence: rule 7 puts user-visible text in `tf(zh, en)` on the frontend, so
/// the backend must not bake a language in here.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuOcStartupCheck {
    /// True → the frontend skips the automatic startup apply this session.
    pub blocked: bool,
    /// `""` when not blocked; otherwise one of [`REASON_UNCLEAN_SHUTDOWN`],
    /// [`REASON_DISPLAY_FAULT`], [`REASON_UNKNOWN_FAULT`].
    pub reason: String,
    /// Provider + event id of the record that tripped the guard, e.g.
    /// `"nvlddmkm 153"`. Identifier text, identical in every language — shown
    /// verbatim so a support log/screenshot names the actual evidence.
    pub detail: String,
}

/// The machine came up from a shutdown it did not ask for (bugcheck, hard reset,
/// power loss).
pub const REASON_UNCLEAN_SHUTDOWN: &str = "unclean_shutdown";
/// The display driver faulted or was reset (TDR) around the previous shutdown.
pub const REASON_DISPLAY_FAULT: &str = "display_driver_fault";
/// The query matched but the record did not parse — block anyway (the match is
/// the evidence; the parse is only for the label).
pub const REASON_UNKNOWN_FAULT: &str = "recent_fault";

/// How far the boot-marker events may sit from our own idea of the boot instant.
///
/// Kernel-Power 41 / EventLog 6008 are written within seconds of boot, but they
/// are written by the *Event Log service* starting up, and `GetTickCount64`
/// starts counting earlier than that. Two minutes absorbs the service-start lag
/// and small clock corrections without widening into the previous boot.
const BOOT_SLACK_MS: u64 = 120_000;

/// How far BEFORE the boot a display-driver fault still counts as "this is what
/// took the machine down". A TDR storm precedes the reset by seconds to a couple
/// of minutes; 15 minutes covers a user who fought it for a while first.
const PRE_BOOT_FAULT_WINDOW_MS: u64 = 900_000;

/// Beyond this uptime the evidence is stale and the guard goes quiet.
///
/// This is the anti-nag rule. Without it, a machine that has been up for ten
/// days with one pre-boot TDR in its history would block the auto-apply on
/// EVERY manual launch for those ten days — exactly the repeat-nagging failure
/// that got the persisted-marker design rejected. The guard is about the session
/// we just came out of; once the box has been stable for hours, it has made its
/// point and the user's setting wins again.
const MAX_UPTIME_MS: u64 = 6 * 60 * 60 * 1000;

/// Upper bound on the single `EvtNext` wait.
///
/// The no-match case is the slow one: the log engine scans the whole channel
/// before reporting `ERROR_NO_MORE_ITEMS`. Measured on the reporting machine
/// (38k records / 20 MB System log) that is ~180 ms, so 3 s is a generous
/// ceiling that still guarantees the startup path cannot hang. A timeout is
/// treated as "no match" — fail-soft.
const EVT_NEXT_TIMEOUT_MS: u32 = 3_000;

/// First render attempt, in u16s (8 KiB). One event's XML header is ~600 bytes;
/// this only grows for events with large `EventData`, which we then retry once.
const RENDER_BUF_U16: usize = 4096;

/// Refuse to allocate more than this for one event's XML. A pathological record
/// must not turn a startup check into a memory spike in a 24/7 process.
const MAX_RENDER_BYTES: u32 = 256 * 1024;

/// Closes an `EVT_HANDLE` on every exit path.
///
/// The early returns below (no match, render failure) are the reason this is a
/// guard and not a trailing `EvtClose`: leaking a query handle in a process that
/// runs for weeks leaks a kernel object per launch.
struct EvtGuard(EVT_HANDLE);

impl Drop for EvtGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = EvtClose(self.0);
        }
    }
}

/// Is the crash evidence still about the session we just came from?
fn signal_is_fresh(uptime_ms: u64) -> bool {
    uptime_ms <= MAX_UPTIME_MS
}

/// The XPath that DECIDES: did this boot follow a shutdown the machine did not
/// ask for?
///
/// `timediff(@SystemTime)` is "how many ms ago", so larger = older, and the boot
/// instant sits at `uptime_ms`. The markers must land AT the current boot
/// (`uptime ± slack`) — an unqualified "within the last `uptime` ms" would match
/// the 41 written at *previous* boots once the machine has been up a while.
///
/// Providers are pinned by name because event ids are not globally unique —
/// a bare `EventID=41` also matches unrelated providers' event 41.
fn build_boot_query(uptime_ms: u64) -> String {
    let boot_lo = uptime_ms.saturating_sub(BOOT_SLACK_MS);
    let boot_hi = uptime_ms.saturating_add(BOOT_SLACK_MS);
    format!(
        "*[System[\
           ((Provider[@Name='Microsoft-Windows-Kernel-Power'] and EventID=41) \
            or (Provider[@Name='EventLog'] and EventID=6008)) \
           and TimeCreated[timediff(@SystemTime) <= {boot_hi} and timediff(@SystemTime) >= {boot_lo}]\
         ]]"
    )
}

/// The XPath that only LABELS: was a display-driver fault what took it down?
///
/// This must never decide on its own, and used to. OR-ing it into the boot query
/// meant any 153/4101 in a 15-minute window blocked the overclock even when the
/// reboot was perfectly clean — and the single most common instance of that
/// pattern is an NVIDIA driver update, which resets the display driver (logging
/// 153/4101) and then reboots. A textbook clean install read as a crash, and the
/// block is silent unless the user happens to open the GPU tab. A benign TDR
/// from video decode followed by any restart within 15 minutes did the same.
///
/// The lower bound is the boot instant with NO slack, so the window can only
/// ever reach backwards past the boot. With slack it saturated to 0 whenever
/// uptime was under two minutes — i.e. every autostart-at-login run — and the
/// window silently became "any fault from 15 min before boot until right now",
/// picking up this boot's own driver/monitor init.
fn build_fault_query(uptime_ms: u64) -> String {
    let fault_hi = uptime_ms.saturating_add(PRE_BOOT_FAULT_WINDOW_MS);
    format!(
        "*[System[\
           ((Provider[@Name='nvlddmkm'] and EventID=153) \
            or (Provider[@Name='Display'] and EventID=4101)) \
           and TimeCreated[timediff(@SystemTime) <= {fault_hi} and timediff(@SystemTime) >= {uptime_ms}]\
         ]]"
    )
}

/// Value of a single-quoted-or-double-quoted XML attribute that follows `key`.
fn quoted_value<'a>(xml: &'a str, key: &str) -> Option<&'a str> {
    let at = xml.find(key)? + key.len();
    let rest = xml.get(at..)?;
    let quote = rest.chars().next()?;
    if quote != '\'' && quote != '"' {
        return None;
    }
    let body = rest.get(quote.len_utf8()..)?;
    let end = body.find(quote)?;
    body.get(..end)
}

/// `(provider name, event id)` out of a rendered event's XML.
///
/// Deliberately a string scan, not an XML parser: we need exactly two fields out
/// of a fixed, kernel-generated header, and pulling in an XML dependency for a
/// label would be the tail wagging the dog. The `<EventID` match skips forward
/// to `>` because classic providers (EventLog/6008) emit
/// `<EventID Qualifiers='32768'>6008</EventID>`.
pub(crate) fn parse_event_brief(xml: &str) -> Option<(String, u32)> {
    let provider = quoted_value(xml, "<Provider Name=")?;
    let at = xml.find("<EventID")? + "<EventID".len();
    let rest = xml.get(at..)?;
    let gt = rest.find('>')?;
    let body = rest.get(gt + 1..)?;
    let end = body.find('<')?;
    let id: u32 = body.get(..end)?.trim().parse().ok()?;
    Some((provider.to_string(), id))
}

/// Map a matched record onto its stable reason tag.
fn reason_for(provider: &str, event_id: u32) -> &'static str {
    match (provider, event_id) {
        ("Microsoft-Windows-Kernel-Power", 41) | ("EventLog", 6008) => REASON_UNCLEAN_SHUTDOWN,
        ("nvlddmkm", 153) | ("Display", 4101) => REASON_DISPLAY_FAULT,
        // The query only yields records we asked for, so an unrecognised pair
        // means the label logic drifted from the query — still a real match, so
        // still a block, just without a specific story.
        _ => REASON_UNKNOWN_FAULT,
    }
}

/// Render one event handle to XML.
unsafe fn render_xml(event: EVT_HANDLE) -> windows::core::Result<String> {
    let mut buf = vec![0u16; RENDER_BUF_U16];
    let mut used = 0u32;
    let mut props = 0u32;
    let first = unsafe {
        EvtRender(
            None,
            event,
            EvtRenderEventXml.0,
            (buf.len() * 2) as u32,
            Some(buf.as_mut_ptr().cast()),
            &mut used,
            &mut props,
        )
    };
    if let Err(e) = first {
        // ERROR_INSUFFICIENT_BUFFER leaves the required BYTE count in `used`.
        let needed = used;
        if needed == 0 || needed > MAX_RENDER_BYTES {
            return Err(e);
        }
        buf = vec![0u16; (needed as usize + 1) / 2];
        unsafe {
            EvtRender(
                None,
                event,
                EvtRenderEventXml.0,
                needed,
                Some(buf.as_mut_ptr().cast()),
                &mut used,
                &mut props,
            )?;
        }
    }
    // `used` is BYTES including the terminating NUL.
    let chars = ((used as usize) / 2).saturating_sub(1).min(buf.len());
    Ok(String::from_utf16_lossy(&buf[..chars]))
}

/// Newest System-log record matching `query`, or `None` when nothing matches.
fn newest_matching_event(query: &str) -> windows::core::Result<Option<String>> {
    let channel: Vec<u16> = "System".encode_utf16().chain(once(0)).collect();
    let wide: Vec<u16> = query.encode_utf16().chain(once(0)).collect();
    unsafe {
        let query = EvtGuard(EvtQuery(
            None,
            PCWSTR(channel.as_ptr()),
            PCWSTR(wide.as_ptr()),
            // Reverse = newest first, so the single record we pull is the most
            // recent match rather than whichever one is oldest in the channel.
            EvtQueryChannelPath.0 | EvtQueryReverseDirection.0,
        )?);
        let mut handles = [0isize; 1];
        let mut returned = 0u32;
        let next = EvtNext(query.0, &mut handles, EVT_NEXT_TIMEOUT_MS, 0, &mut returned);
        // ERROR_NO_MORE_ITEMS (clean history) and ERROR_TIMEOUT (huge log) are
        // both "no evidence" — neither is worth failing the startup path over.
        if next.is_err() || returned == 0 {
            return Ok(None);
        }
        let event = EvtGuard(EVT_HANDLE(handles[0]));
        render_xml(event.0).map(Some)
    }
}

/// Run the check. Blocking (event-log RPC + a full-channel scan in the no-match
/// case) — rule 1: only ever called from the blocking pool, never inline in a
/// sync command.
pub fn check_now() -> GpuOcStartupCheck {
    let uptime_ms = unsafe { GetTickCount64() };
    if !signal_is_fresh(uptime_ms) {
        return GpuOcStartupCheck::default();
    }
    // Boot markers are the ONLY trigger. A display fault refines the label
    // afterwards; on its own it is not evidence that anything went wrong (see
    // `build_fault_query`).
    match newest_matching_event(&build_boot_query(uptime_ms)) {
        Ok(Some(xml)) => {
            let parsed = parse_event_brief(&xml);
            let (mut reason, mut detail) = match &parsed {
                Some((provider, id)) => (reason_for(provider, *id), format!("{provider} {id}")),
                None => (REASON_UNKNOWN_FAULT, String::new()),
            };
            // We already know we are blocking; this only decides which story the
            // banner tells, so any failure just leaves the generic one.
            if let Ok(Some(fault_xml)) = newest_matching_event(&build_fault_query(uptime_ms)) {
                if let Some((provider, id)) = parse_event_brief(&fault_xml) {
                    reason = reason_for(&provider, id);
                    detail = format!("{provider} {id}");
                }
            }
            tracing::warn!(
                "gpu-oc startup guard: blocking auto-apply (reason={reason}, evidence={detail}, uptime={uptime_ms} ms)"
            );
            GpuOcStartupCheck {
                blocked: true,
                reason: reason.to_string(),
                detail,
            }
        }
        Ok(None) => GpuOcStartupCheck::default(),
        Err(e) => {
            // Event Log service disabled, channel access denied, malformed query
            // after an edit — all of them mean "we learned nothing", which must
            // not turn into "block the user's feature".
            tracing::debug!("gpu-oc startup guard: event-log query failed ({e}); not blocking");
            GpuOcStartupCheck::default()
        }
    }
}

/// Async + blocking-pool (rule 1): this opens an event-log channel and can scan
/// the whole System log. A sync command would run it on the window's message
/// pump — the "未响应" freeze class — and it fires during startup, when the UI
/// is at its most visibly janky.
#[tauri::command]
pub async fn gpu_oc_startup_check() -> GpuOcStartupCheck {
    crate::commands::run_blocking_default("gpu_oc_startup_check", check_now).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_modern_provider_event() {
        let xml = "<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System>\
                   <Provider Name='Microsoft-Windows-Kernel-Power' Guid='{331c3b3a-...}'/>\
                   <EventID>41</EventID><Version>10</Version></System></Event>";
        assert_eq!(
            parse_event_brief(xml),
            Some(("Microsoft-Windows-Kernel-Power".to_string(), 41))
        );
    }

    /// Classic providers emit `Qualifiers` on `<EventID>`; the scan must skip to
    /// `>` instead of assuming the tag closes immediately.
    #[test]
    fn parses_classic_provider_with_qualifiers() {
        let xml = "<System><Provider Name=\"EventLog\"/>\
                   <EventID Qualifiers=\"32768\">6008</EventID></System>";
        assert_eq!(parse_event_brief(xml), Some(("EventLog".to_string(), 6008)));
    }

    #[test]
    fn parses_nvlddmkm_event() {
        let xml = "<System><Provider Name='nvlddmkm'/><EventID>153</EventID></System>";
        assert_eq!(parse_event_brief(xml), Some(("nvlddmkm".to_string(), 153)));
    }

    #[test]
    fn rejects_garbage_instead_of_guessing() {
        assert_eq!(parse_event_brief(""), None);
        assert_eq!(
            parse_event_brief("<System><Provider Name='x'/></System>"),
            None
        );
        assert_eq!(
            parse_event_brief("<System><EventID>41</EventID></System>"),
            None
        );
        // Unterminated attribute must not panic or slice mid-char.
        assert_eq!(parse_event_brief("<System><Provider Name='nvlddmkm"), None);
    }

    #[test]
    fn maps_every_queried_pair_to_a_reason() {
        assert_eq!(
            reason_for("Microsoft-Windows-Kernel-Power", 41),
            REASON_UNCLEAN_SHUTDOWN
        );
        assert_eq!(reason_for("EventLog", 6008), REASON_UNCLEAN_SHUTDOWN);
        assert_eq!(reason_for("nvlddmkm", 153), REASON_DISPLAY_FAULT);
        assert_eq!(reason_for("Display", 4101), REASON_DISPLAY_FAULT);
        assert_eq!(
            reason_for("Service Control Manager", 7000),
            REASON_UNKNOWN_FAULT
        );
    }

    /// The boot-marker window must be centred on the boot instant, not open all
    /// the way back to it — otherwise a long uptime matches previous boots' 41s.
    #[test]
    fn boot_window_is_centred_on_boot_not_open_ended() {
        let q = build_boot_query(10_000_000);
        assert!(q.contains("timediff(@SystemTime) <= 10120000"));
        assert!(q.contains("timediff(@SystemTime) >= 9880000"));
    }

    /// Freshly booted: the lower bound saturates at 0 instead of wrapping into a
    /// gigantic u64 that would match nothing.
    #[test]
    fn early_boot_lower_bound_saturates() {
        let q = build_boot_query(5_000);
        assert!(q.contains("timediff(@SystemTime) >= 0"));
        assert!(q.contains("timediff(@SystemTime) <= 125000"));
    }

    /// The fault query may only ever look BEFORE the boot.
    ///
    /// Regression guard for the false-positive class: with a slack-adjusted
    /// lower bound this saturated to 0 at low uptime, turning the window into
    /// "anything in the last 15 minutes", which on an autostart-at-login run
    /// meant this boot's own driver init. It must stay anchored at exactly the
    /// boot instant.
    #[test]
    fn fault_window_never_reaches_forward_past_the_boot() {
        for uptime in [0u64, 5_000, 119_999, 10_000_000] {
            let q = build_fault_query(uptime);
            assert!(
                q.contains(&format!("timediff(@SystemTime) >= {uptime}")),
                "uptime {uptime}: fault window must start at the boot instant, got {q}"
            );
            assert!(q.contains(&format!(
                "timediff(@SystemTime) <= {}",
                uptime + PRE_BOOT_FAULT_WINDOW_MS
            )));
        }
    }

    /// A display fault must never be a trigger on its own — only a label.
    ///
    /// Stated structurally, because the decision path is the thing that
    /// regressed: the query that decides must not mention the fault providers,
    /// and the query that mentions them must not mention the boot markers.
    #[test]
    fn only_boot_markers_can_trigger_a_block() {
        let decide = build_boot_query(60_000);
        assert!(
            !decide.contains("nvlddmkm") && !decide.contains("4101"),
            "a driver fault must not be able to block on its own: {decide}"
        );
        let label = build_fault_query(60_000);
        assert!(!label.contains("Kernel-Power") && !label.contains("6008"));
    }

    #[test]
    fn stale_evidence_stops_blocking() {
        assert!(signal_is_fresh(0));
        assert!(signal_is_fresh(MAX_UPTIME_MS));
        assert!(!signal_is_fresh(MAX_UPTIME_MS + 1));
        // Ten days up: never nag, no matter what is in the log.
        assert!(!signal_is_fresh(10 * 24 * 60 * 60 * 1000));
    }

    #[test]
    fn default_is_not_blocked() {
        let d = GpuOcStartupCheck::default();
        assert!(!d.blocked);
        assert!(d.reason.is_empty());
    }
}
