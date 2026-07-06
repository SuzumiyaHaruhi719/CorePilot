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
use std::sync::Mutex;

use once_cell::sync::OnceCell;
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager};

/// The shared store file name — identical to the old `LazyStore` path so all
/// existing user data is picked up as-is.
const FILE: &str = "corepilot.store.json";

/// In-memory state: resolved file path + the parsed key→value map. Loaded once
/// (with recovery) on first command, then kept authoritative for the process
/// lifetime — every mutation rewrites the file atomically.
struct Persist {
    path: PathBuf,
    map: Map<String, Value>,
}

static STATE: OnceCell<Mutex<Persist>> = OnceCell::new();

/// Serialize `map` and atomically replace `path` with it: write + fsync a
/// sibling `.tmp`, then rename over the target. Rename on the same volume is
/// atomic on NTFS, so a crash/power-cut leaves the previous file intact.
fn write_atomic(path: &PathBuf, map: &Map<String, Value>) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let bytes = serde_json::to_vec_pretty(&Value::Object(map.clone()))?;
    let tmp = path.with_extension("json.tmp");
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(&bytes)?;
        f.sync_all()?; // data on disk BEFORE the rename makes it live
    }
    fs::rename(&tmp, path)
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

    if !map.is_empty() {
        if let Err(e) = write_atomic(&bak, &map) {
            tracing::warn!("persist: backup refresh failed: {e}");
        }
    }
    Persist { path, map }
}

/// Resolve (and on first use, load) the shared state.
fn state(app: &AppHandle) -> &'static Mutex<Persist> {
    STATE.get_or_init(|| {
        let dir = app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| PathBuf::from("."));
        Mutex::new(load(dir.join(FILE)))
    })
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
        st.map.insert(name, value);
        write_atomic(&st.path, &st.map).map_err(|e| e.to_string())
    })
    .await
}

/// Delete one key and atomically rewrite the file (blocking pool, as above).
#[tauri::command]
pub async fn persist_delete(app: AppHandle, name: String) -> Result<(), String> {
    crate::commands::run_blocking_err("persist_delete", move || {
        let mut st = state(&app).lock().map_err(|e| e.to_string())?;
        st.map.remove(&name);
        write_atomic(&st.path, &st.map).map_err(|e| e.to_string())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// End-to-end recovery check: corrupt live file is quarantined and the
    /// backup restored; a valid live file wins and refreshes the backup.
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
        m.insert("corepilot-settings".into(), Value::String("{\"a\":1}".into()));
        write_atomic(&path, &m).unwrap();
        let p = load(path.clone());
        assert_eq!(p.map.len(), 1);
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
