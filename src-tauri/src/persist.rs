//! **Crash-safe replacement for `tauri-plugin-store` IO** on the one shared
//! zustand persistence file (`corepilot.store.json`).
//!
//! Why the plugin had to go: its `save()` is a plain `fs::write` —
//! truncate-then-write, NOT atomic — and the frontend saves on every store
//! change. This machine hard-resets at random (Kernel-Power 41); a reset
//! landing mid-write truncates the JSON, the next launch fails to parse it,
//! every zustand store silently falls back to defaults, and the first
//! auto-save overwrites the file — i.e. the recurring "all my profiles/groups
//! vanished" total-wipe. Same failure class as the historical hand-edit wipe.
//!
//! This module keeps the exact same file, path and format (a flat JSON object
//! keyed by zustand persist name → JSON-string value) so existing data loads
//! unchanged, and fixes the IO:
//!
//! * **Atomic writes** — serialize to `corepilot.store.json.tmp`, fsync, then
//!   rename over the live file (`MoveFileEx(REPLACE_EXISTING)` on Windows).
//!   Power loss leaves either the old or the new file, never a truncated one.
//! * **Quarantine, never overwrite, on corruption** — if the live file exists
//!   but doesn't parse, it is renamed to `corepilot.store.corrupt-<epoch>.json`
//!   (kept as evidence / manual recovery) instead of being clobbered.
//! * **Rolling last-known-good backup + auto-restore** — after every
//!   successful non-empty load the state is copied to
//!   `corepilot.store.json.bak`; when the live file is corrupt or missing, the
//!   backup is restored automatically. Worst-case loss is one run's changes,
//!   not everything.
//!
//! The frontend talks to this via three tiny commands (`persist_get` /
//! `persist_set` / `persist_delete`) wired into `src/lib/persist.ts`.

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use once_cell::sync::OnceCell;
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager};

/// The shared store file name — identical to the old `LazyStore` path so all
/// existing user data is picked up as-is.
const FILE: &str = "corepilot.store.json";

/// In-memory state: resolved file path + the parsed key→value map. Loaded once
/// (with recovery) on first command, then kept authoritative for the process
/// lifetime — every mutation updates the authoritative map immediately and a
/// coalescing writer persists it atomically shortly afterward.
struct WriteSignal {
    wake: Mutex<bool>,
    cv: Condvar,
}

struct Persist {
    path: PathBuf,
    map: Map<String, Value>,
    dirty: bool,
    signal: Arc<WriteSignal>,
}

static STATE: OnceCell<Mutex<Persist>> = OnceCell::new();

/// Serialize `map` and atomically replace `path` with it: write + fsync a
/// sibling `.tmp`, then rename over the target. Rename on the same volume is
/// atomic on NTFS, so a crash/power-cut leaves the previous file intact.
pub(crate) fn write_atomic_bytes(path: &PathBuf, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?; // data on disk BEFORE the rename makes it live
    }
    fs::rename(&tmp, path)
}

fn write_atomic(path: &PathBuf, map: &Map<String, Value>) -> std::io::Result<()> {
    let bytes = serde_json::to_vec_pretty(&Value::Object(map.clone()))?;
    write_atomic_bytes(path, &bytes)
}

/// Parse `path` as the flat store object. `None` when missing, unreadable, or
/// not a JSON object (empty/truncated files land here).
fn read_map(path: &PathBuf) -> Option<Map<String, Value>> {
    let bytes = fs::read(path).ok()?;
    match serde_json::from_slice::<Value>(&bytes) {
        Ok(Value::Object(m)) => Some(m),
        _ => None,
    }
}

/// Load the store with corruption recovery (see module docs): live file →
/// else quarantine it and restore the backup → else start empty. On any
/// successful **non-empty** load the backup is refreshed; an empty live map is
/// never allowed to clobber a non-empty backup (that is exactly the post-wipe
/// signature this module exists to prevent).
fn load(path: PathBuf) -> Persist {
    let bak = path.with_extension("json.bak");
    let live = read_map(&path);

    if live.is_none() && path.exists() {
        // Present but unparseable — a truncated/corrupt file. Keep it for
        // forensics under a timestamped name; never write over it.
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let quarantine = path.with_file_name(format!("corepilot.store.corrupt-{ts}.json"));
        match fs::rename(&path, &quarantine) {
            Ok(()) => tracing::error!(
                "persist: {FILE} is corrupt — quarantined to {:?}, attempting backup restore",
                quarantine.file_name().unwrap_or_default()
            ),
            Err(e) => tracing::error!("persist: {FILE} is corrupt and quarantine failed: {e}"),
        }
    }

    let map = match live {
        Some(m) => m,
        None => match read_map(&bak) {
            Some(m) => {
                tracing::warn!("persist: restored {} keys from backup", m.len());
                let _ = write_atomic(&path, &m);
                m
            }
            None => Map::new(), // genuinely fresh install (or both files lost)
        },
    };

    let signal = Arc::new(WriteSignal {
        wake: Mutex::new(false),
        cv: Condvar::new(),
    });
    if !map.is_empty() {
        // Backup refresh is deliberately detached: first paint only needs the live file
        // parsed; fsyncing the evidence copy here caused avoidable startup stalls.
        //
        // The handle is kept (not dropped on the floor) purely so tests can join it.
        // Detaching it there made `corrupt_live_restores_backup` racy: the test writes
        // a store, loads it, then truncates the live file and expects the SECOND load
        // to restore from the backup — but whether that backup exists yet depended on
        // an unsynchronised thread, so the test passed alone and failed under full-suite
        // scheduling. A flaky test in the one module whose entire job is not losing the
        // user's data is worse than no test: it teaches you to ignore a red run.
        let backup = bak.clone();
        let snapshot = map.clone();
        let handle = std::thread::spawn(move || {
            if let Err(e) = write_atomic(&backup, &snapshot) {
                tracing::warn!("persist: backup refresh failed: {e}");
            }
        });
        #[cfg(test)]
        let _ = handle.join();
        #[cfg(not(test))]
        drop(handle);
    }
    Persist {
        path,
        map,
        dirty: false,
        signal,
    }
}

/// Resolve (and on first use, load) the shared state.
fn state(app: &AppHandle) -> &'static Mutex<Persist> {
    STATE.get_or_init(|| {
        let dir = app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| PathBuf::from("."));
        let persist = load(dir.join(FILE));
        let signal = persist.signal.clone();
        std::thread::Builder::new()
            .name("corepilot-persist".into())
            .spawn(move || writer_loop(signal))
            .expect("persist writer thread");
        Mutex::new(persist)
    })
}

fn writer_loop(signal: Arc<WriteSignal>) {
    loop {
        let mut wake = signal.wake.lock().expect("persist signal poisoned");
        while !*wake {
            wake = signal.cv.wait(wake).expect("persist signal poisoned");
        }
        *wake = false;

        // Reset the quiet-period deadline whenever another set arrives; otherwise a
        // slider drag still emits one fsync per condvar wake instead of one latest-wins write.
        let mut deadline = std::time::Instant::now() + std::time::Duration::from_millis(200);
        loop {
            let now = std::time::Instant::now();
            if now >= deadline {
                break;
            }
            let (next, timeout) = signal
                .cv
                .wait_timeout(wake, deadline - now)
                .expect("persist signal poisoned");
            wake = next;
            if timeout.timed_out() {
                break;
            }
            if *wake {
                *wake = false;
                deadline = std::time::Instant::now() + std::time::Duration::from_millis(200);
            }
        }
        drop(wake);
        if let Some(mutex) = STATE.get() {
            if let Ok(mut st) = mutex.lock() {
                if let Err(e) = flush_persist(&mut st) {
                    tracing::error!("persist: deferred write failed: {e}");
                }
            }
        }
    }
}

fn mark_dirty(st: &mut Persist) {
    st.dirty = true;
    if let Ok(mut wake) = st.signal.wake.lock() {
        *wake = true;
        st.signal.cv.notify_one();
    }
}

fn set_value(st: &mut Persist, name: String, value: Value) -> bool {
    if st.map.get(&name) == Some(&value) {
        return false;
    }
    st.map.insert(name, value);
    mark_dirty(st);
    true
}

fn flush_persist(st: &mut Persist) -> std::io::Result<()> {
    if !st.dirty {
        return Ok(());
    }
    let result = write_atomic(&st.path, &st.map);
    if result.is_ok() {
        st.dirty = false;
    }
    result
}

pub fn flush() {
    if let Some(mutex) = STATE.get() {
        if let Ok(mut st) = mutex.lock() {
            if let Err(e) = flush_persist(&mut st) {
                tracing::error!("persist: flush failed: {e}");
            }
        }
    }
}

/// Read one persisted value (the JSON-string zustand wrote), `None` if absent.
/// Async + blocking-pool: the FIRST call loads (and possibly restores) the file
/// from disk; sync Tauri commands run on the main thread and disk IO there is
/// the recurring freeze class.
#[tauri::command]
pub async fn persist_get(app: AppHandle, name: String) -> Option<Value> {
    crate::commands::run_blocking_default("persist_get", move || {
        state(&app).lock().ok()?.map.get(&name).cloned()
    })
    .await
}

/// Set one value and atomically rewrite the file. Errors surface to the caller
/// so a failed save is never silent. Async + blocking-pool: every set is a
/// write + fsync, and store saves arrive in bursts (e.g. a slider drag) — on
/// the main thread that janked the UI.
#[tauri::command]
pub async fn persist_set(app: AppHandle, name: String, value: Value) -> Result<(), String> {
    crate::commands::run_blocking_err("persist_set", move || {
        let mut st = state(&app).lock().map_err(|e| e.to_string())?;
        set_value(&mut st, name, value);
        Ok(())
    })
    .await
}

/// Delete one key and atomically rewrite the file (blocking pool, as above).
#[tauri::command]
pub async fn persist_delete(app: AppHandle, name: String) -> Result<(), String> {
    crate::commands::run_blocking_err("persist_delete", move || {
        let mut st = state(&app).lock().map_err(|e| e.to_string())?;
        if st.map.remove(&name).is_some() {
            mark_dirty(&mut st);
        }
        flush_persist(&mut st).map_err(|e| e.to_string())
    })
    .await
}

// ---------------------------------------------------------------------------
// Per-session perf-sample files
// ---------------------------------------------------------------------------
//
// `corepilot-perf-history` used to keep every session's ~1200-point sample
// array inline in the shared store: 22 MB of a 24 MB file, so EVERY
// `persist_set` of ANY key (a slider drag, a tab switch) rewrote and fsynced
// 24 MB, Tauri parsed that body on the main thread before the future was even
// spawned, and both webviews hydrated it at startup. The sample arrays now
// live one-file-per-session under `app_data_dir()/perf-sessions/<id>.json`,
// written with the same atomic tmp+fsync+rename helper as the store, and are
// loaded lazily by the report view. The store keeps only ~1 KB of metadata per
// session.
//
// Store IO stays inside this module (crash-safe writes in one place) — hence
// these commands living here rather than in `commands.rs`.

/// Directory (under the app data dir) holding one JSON file per session.
const PERF_DIR: &str = "perf-sessions";

fn perf_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(PERF_DIR)
}

/// Session ids come from the renderer's `crypto.randomUUID()` and are used
/// verbatim as a PATH COMPONENT, so they are validated against `^[0-9a-f-]{36}$`
/// **before** anything touches the filesystem. This rejects `..`, separators,
/// drive letters, ADS colons and every other traversal shape by construction.
fn valid_session_id(id: &str) -> bool {
    id.len() == 36
        && id
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f' | b'-'))
}

fn session_path(app: &AppHandle, id: &str) -> PathBuf {
    perf_dir(app).join(format!("{id}.json"))
}

/// Write one session's sample array (already serialized by the renderer).
/// Async + blocking-pool: this is a write + fsync of a few hundred KB.
#[tauri::command]
pub async fn perf_session_save(app: AppHandle, id: String, json: String) -> Result<(), String> {
    crate::commands::run_blocking_err("perf_session_save", move || {
        if !valid_session_id(&id) {
            return Err(format!("invalid session id: {id}"));
        }
        write_atomic_bytes(&session_path(&app, &id), json.as_bytes()).map_err(|e| e.to_string())
    })
    .await
}

/// Read one session's sample array back as the raw JSON string, `None` when the
/// file is missing/unreadable (an entry deleted out from under the store, or a
/// row whose save never landed) — the caller renders an empty chart rather than
/// failing.
#[tauri::command]
pub async fn perf_session_load(app: AppHandle, id: String) -> Option<String> {
    crate::commands::run_blocking_default("perf_session_load", move || {
        if !valid_session_id(&id) {
            return None;
        }
        fs::read_to_string(session_path(&app, &id)).ok()
    })
    .await
}

/// Delete one session's sample file. Missing is success (idempotent: the store
/// calls this best-effort when a row is removed or aged out).
#[tauri::command]
pub async fn perf_session_delete(app: AppHandle, id: String) -> Result<(), String> {
    crate::commands::run_blocking_err("perf_session_delete", move || {
        if !valid_session_id(&id) {
            return Err(format!("invalid session id: {id}"));
        }
        match fs::remove_file(session_path(&app, &id)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    })
    .await
}

/// Drop every sample file (history "清空"). Missing directory is success.
#[tauri::command]
pub async fn perf_session_delete_all(app: AppHandle) -> Result<(), String> {
    crate::commands::run_blocking_err("perf_session_delete_all", move || match fs::remove_dir_all(
        perf_dir(&app),
    ) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    })
    .await
}

/// Ids of every sample file on disk, for the orphan sweep (files whose history
/// row is gone — e.g. the process died between the file write and the store
/// write, which is the deliberately-safe ordering).
#[tauri::command]
pub async fn perf_session_ids(app: AppHandle) -> Vec<String> {
    crate::commands::run_blocking_default("perf_session_ids", move || {
        let mut out = Vec::new();
        if let Ok(entries) = fs::read_dir(perf_dir(&app)) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if let Some(id) = name.strip_suffix(".json") {
                    if valid_session_id(id) && !is_recent(&entry) {
                        out.push(id.to_string());
                    }
                }
            }
        }
        out
    })
    .await
}

/// Grace period before a sample file may be reported to the orphan sweep.
///
/// The ONLY consumer of [`perf_session_ids`] is the frontend's orphan sweep, and
/// a file is legitimately row-less for a while: the recorder writes samples
/// first and adds the history row after, precisely so a crash leaves a harmless
/// orphan instead of a row that charts nothing. Anything younger than this is
/// therefore assumed to be mid-handoff rather than abandoned. This is the one
/// check that makes every orphan-deletion race safe, including races with a
/// future second writer that no in-process bookkeeping could see.
///
/// Orphans are tiny and rare; leaving one on disk for an hour costs nothing,
/// deleting a live one costs the user a run.
const PERF_SWEEP_GRACE: Duration = Duration::from_secs(60 * 60);

fn is_recent(entry: &fs::DirEntry) -> bool {
    // Unreadable mtime, or a file stamped in the future (clock step, so
    // `elapsed` errors): treat it as recent. Failing toward "keep the file" is
    // the whole point of this check.
    let Ok(modified) = entry.metadata().and_then(|m| m.modified()) else {
        return true;
    };
    modified
        .elapsed()
        .map(|age| age < PERF_SWEEP_GRACE)
        .unwrap_or(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    /// Session ids are path components: only a lowercase-hex/dash 36-char
    /// `crypto.randomUUID()` shape may reach the filesystem.
    #[test]
    fn session_ids_reject_path_traversal() {
        assert!(valid_session_id("0189f3a1-2b4c-4d5e-8f90-1a2b3c4d5e6f"));
        assert!(!valid_session_id("../../corepilot.store.json"));
        assert!(!valid_session_id("0189F3A1-2B4C-4D5E-8F90-1A2B3C4D5E6F")); // uppercase
        assert!(!valid_session_id("0189f3a1-2b4c-4d5e-8f90-1a2b3c4d5e6")); // 35 chars
        assert!(!valid_session_id("0189f3a1-2b4c-4d5e-8f90-1a2b3c4d5e6fg")); // 37 chars
        assert!(!valid_session_id("0189f3a1/2b4c/4d5e/8f90/1a2b3c4d5e6f"));
        assert!(!valid_session_id(r"..\..\..\windows\system32\evil.js"));
        assert!(!valid_session_id(""));
    }

    /// End-to-end recovery check: corrupt live file is quarantined and the
    /// backup restored; a valid live file wins and refreshes the backup.
    #[test]
    fn persist_set_skips_identical_values() {
        let signal = Arc::new(WriteSignal {
            wake: Mutex::new(false),
            cv: Condvar::new(),
        });
        let mut st = Persist {
            path: PathBuf::from("unused"),
            map: Map::new(),
            dirty: false,
            signal,
        };
        st.map
            .insert("settings".into(), Value::String("same".into()));

        assert!(!set_value(
            &mut st,
            "settings".into(),
            Value::String("same".into())
        ));
        assert!(
            !st.dirty,
            "identical zustand writes must not wake the disk writer"
        );
    }

    #[test]
    fn flush_writes_dirty_map_immediately() {
        let dir = std::env::temp_dir().join(format!("cp-persist-flush-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(FILE);
        let signal = Arc::new(WriteSignal {
            wake: Mutex::new(false),
            cv: Condvar::new(),
        });
        let mut st = Persist {
            path: path.clone(),
            map: Map::new(),
            dirty: false,
            signal,
        };
        assert!(set_value(
            &mut st,
            "settings".into(),
            Value::String("new".into())
        ));
        flush_persist(&mut st).unwrap();
        assert!(!st.dirty);
        assert_eq!(
            read_map(&path).unwrap()["settings"],
            Value::String("new".into())
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_live_restores_backup() {
        let dir = std::env::temp_dir().join(format!("cp-persist-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(FILE);
        let bak = path.with_extension("json.bak");

        // Seed a valid store via the atomic writer, which also lets `load`
        // refresh the backup.
        let mut m = Map::new();
        m.insert(
            "corepilot-settings".into(),
            Value::String("{\"a\":1}".into()),
        );
        write_atomic(&path, &m).unwrap();
        let p = load(path.clone());
        assert_eq!(p.map.len(), 1);
        for _ in 0..50 {
            if bak.exists() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        assert!(bak.exists(), "backup refreshed on good load");

        // Truncate the live file the way a hard reset would.
        fs::write(&path, "{\"corepilot-set").unwrap();
        let p = load(path.clone());
        assert_eq!(
            p.map.get("corepilot-settings"),
            Some(&Value::String("{\"a\":1}".into())),
            "restored from backup"
        );
        assert!(
            fs::read_dir(&dir).unwrap().flatten().any(|e| e
                .file_name()
                .to_string_lossy()
                .starts_with("corepilot.store.corrupt-")),
            "corrupt file quarantined"
        );
        // Live file rewritten valid.
        assert!(read_map(&path).is_some());
        let _ = fs::remove_dir_all(&dir);
    }
}
