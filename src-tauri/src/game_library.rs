//! Installed-game library discovery (Steam / Epic / GOG).
//!
//! This is the "authoritative" half of game detection — the same approach NVIDIA
//! GeForce Experience / AMD Adrenalin / Discord use: rather than guess from a
//! runtime heuristic, enumerate what the storefronts have actually installed and
//! treat any foreground process whose EXE lives under a known game-install root as
//! a game (even at a menu / 0 FPS). The FPS + fullscreen heuristic in `fps.rs` is
//! then only the *fallback* for titles we don't recognise here.
//!
//! Discovery is filesystem-first (Steam library VDF + Epic manifests) and shells
//! out to `reg.exe` for the registry bits (Steam path fallback + GOG), mirroring
//! the existing `logman` call in `fps.rs` so we avoid version-fragile registry
//! FFI. Results are cached and refreshed at most every few minutes.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use serde::Serialize;

/// One installed game: a display name, its install directory (lowercased, no
/// trailing separator — what we prefix-match foreground EXE paths against), and
/// which storefront it came from.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameEntry {
    pub name: String,
    pub path: String,
    pub source: String,
}

struct Cache {
    at: Option<Instant>,
    games: Vec<GameEntry>,
}

static CACHE: Lazy<Mutex<Cache>> = Lazy::new(|| {
    Mutex::new(Cache {
        at: None,
        games: Vec::new(),
    })
});

/// Re-scan the storefronts at most this often (the install set rarely changes).
const REFRESH: Duration = Duration::from_secs(300);

/// (Re)build the cache if it's missing or older than [`REFRESH`]. Scans OUTSIDE
/// the lock so a slow disk/registry walk never stalls the OSD poll; a concurrent
/// double-scan is harmless (idempotent, last writer wins).
fn ensure_fresh() {
    let stale = match CACHE.lock() {
        Ok(c) => c.at.map(|t| t.elapsed() > REFRESH).unwrap_or(true),
        Err(_) => false,
    };
    if !stale {
        return;
    }
    let mut games = scan_steam();
    games.extend(scan_epic());
    games.extend(scan_gog());
    if let Ok(mut c) = CACHE.lock() {
        c.games = games;
        c.at = Some(Instant::now());
    }
}

/// True when `exe_path_lower` (a lowercased full EXE path) lives under any known
/// installed game's directory. This is the authoritative "is a game" signal.
pub fn is_game_path(exe_path_lower: &str) -> bool {
    ensure_fresh();
    CACHE
        .lock()
        .ok()
        .map(|c| c.games.iter().any(|g| under(exe_path_lower, &g.path)))
        .unwrap_or(false)
}

/// Tauri command: the discovered installed games (for a read-only list in the OSD
/// settings). Empty when nothing is found or no storefront is installed.
#[tauri::command]
pub fn game_library_list() -> Vec<GameEntry> {
    ensure_fresh();
    CACHE
        .lock()
        .ok()
        .map(|c| c.games.clone())
        .unwrap_or_default()
}

/// True if `exe` is inside the directory `root` (prefix match on a path boundary,
/// so `…\Doom` does not match `…\Doom2\…`). Both must already be lowercased.
fn under(exe: &str, root: &str) -> bool {
    let root = root.trim_end_matches('\\');
    !root.is_empty() && exe.strip_prefix(root).is_some_and(|rest| rest.starts_with('\\'))
}

// ----------------------------------------------------------------------------
// Steam: <steam>\steamapps\libraryfolders.vdf -> library roots; each
// <root>\steamapps\*.acf -> "name" + "installdir" (game at common\<installdir>).
// ----------------------------------------------------------------------------

fn scan_steam() -> Vec<GameEntry> {
    let Some(steam) = steam_root() else {
        return Vec::new();
    };
    // The Steam root is itself a library; libraryfolders.vdf lists the others.
    let mut roots = vec![steam.clone()];
    let vdf = std::fs::read_to_string(format!("{steam}\\steamapps\\libraryfolders.vdf"))
        .unwrap_or_default();
    roots.extend(vdf_values(&vdf, "path"));
    // The main library shows up both as the Steam root and inside the VDF — dedupe
    // (case-insensitively) so its games aren't scanned/listed twice.
    let mut seen = std::collections::HashSet::new();
    roots.retain(|r| seen.insert(r.to_lowercase()));

    let mut out = Vec::new();
    for root in roots {
        let apps = format!("{root}\\steamapps");
        let Ok(entries) = std::fs::read_dir(&apps) else {
            continue;
        };
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|s| s.to_str()) != Some("acf") {
                continue;
            }
            let Ok(acf) = std::fs::read_to_string(&p) else {
                continue;
            };
            let installdir = vdf_values(&acf, "installdir").into_iter().next();
            let Some(installdir) = installdir.filter(|s| !s.is_empty()) else {
                continue;
            };
            let name = vdf_values(&acf, "name")
                .into_iter()
                .next()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| installdir.clone());
            out.push(GameEntry {
                name,
                path: format!("{apps}\\common\\{installdir}").to_lowercase(),
                source: "Steam".into(),
            });
        }
    }
    out
}

/// Locate the Steam install root: default folders first, then the registry.
fn steam_root() -> Option<String> {
    for env in ["ProgramFiles(x86)", "ProgramFiles"] {
        if let Ok(pf) = std::env::var(env) {
            let p = format!("{pf}\\Steam");
            if std::path::Path::new(&format!("{p}\\steamapps")).exists() {
                return Some(p);
            }
        }
    }
    // Registry fallback — SteamPath is stored with forward slashes.
    let out = reg_query("HKCU\\Software\\Valve\\Steam", &["/v", "SteamPath"]);
    for line in out.lines() {
        if let Some(i) = line.find("REG_SZ") {
            let val = line[i + "REG_SZ".len()..].trim().replace('/', "\\");
            if !val.is_empty() && std::path::Path::new(&val).exists() {
                return Some(val);
            }
        }
    }
    None
}

/// Extract every value paired with `"key"` from VDF text (Valve's key/value
/// format), un-escaping the `\\` Steam writes in paths. Minimal but sufficient
/// for the few flat keys we read ("path", "installdir", "name").
fn vdf_values(text: &str, key: &str) -> Vec<String> {
    let needle = format!("\"{key}\"");
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(i) = rest.find(&needle) {
        rest = &rest[i + needle.len()..];
        let Some(q1) = rest.find('"') else { break };
        let after = &rest[q1 + 1..];
        let Some(q2) = after.find('"') else { break };
        out.push(after[..q2].replace("\\\\", "\\"));
        rest = &after[q2 + 1..];
    }
    out
}

// ----------------------------------------------------------------------------
// Epic: %ProgramData%\Epic\EpicGamesLauncher\Data\Manifests\*.item (JSON) ->
// "InstallLocation" + "DisplayName".
// ----------------------------------------------------------------------------

fn scan_epic() -> Vec<GameEntry> {
    let Ok(pd) = std::env::var("ProgramData") else {
        return Vec::new();
    };
    let dir = format!("{pd}\\Epic\\EpicGamesLauncher\\Data\\Manifests");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for e in entries.flatten() {
        let p = e.path();
        if p.extension().and_then(|s| s.to_str()) != Some("item") {
            continue;
        }
        let Ok(txt) = std::fs::read_to_string(&p) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) else {
            continue;
        };
        let loc = v.get("InstallLocation").and_then(|x| x.as_str()).unwrap_or("");
        if loc.is_empty() {
            continue;
        }
        let name = v.get("DisplayName").and_then(|x| x.as_str()).unwrap_or(loc);
        out.push(GameEntry {
            name: name.to_string(),
            path: loc.to_lowercase(),
            source: "Epic".into(),
        });
    }
    out
}

// ----------------------------------------------------------------------------
// GOG: HKLM\SOFTWARE\WOW6432Node\GOG.com\Games\<id> -> "path" + "gameName".
// One recursive `reg query /s` dump, parsed as a flat per-subkey state machine.
// ----------------------------------------------------------------------------

fn scan_gog() -> Vec<GameEntry> {
    let dump = reg_query("HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games", &["/s"]);
    let mut out = Vec::new();
    let mut path: Option<String> = None;
    let mut name: Option<String> = None;
    let mut flush = |path: &mut Option<String>, name: &mut Option<String>| {
        if let Some(p) = path.take() {
            out.push(GameEntry {
                name: name.take().unwrap_or_else(|| "GOG game".into()),
                path: p.to_lowercase(),
                source: "GOG".into(),
            });
        } else {
            *name = None;
        }
    };
    for line in dump.lines() {
        let t = line.trim();
        if t.starts_with("HKEY_") {
            flush(&mut path, &mut name);
            continue;
        }
        if let Some(i) = t.find("REG_SZ") {
            let vname = t[..i].trim();
            let val = t[i + "REG_SZ".len()..].trim().to_string();
            match vname {
                "path" => path = Some(val),
                "gameName" => name = Some(val),
                _ => {}
            }
        }
    }
    flush(&mut path, &mut name);
    out
}

/// Run `reg query <key> <extra…>` with no console window and return its stdout
/// (empty on any failure). Mirrors the existing `logman` shell-out in `fps.rs`.
fn reg_query(key: &str, extra: &[&str]) -> String {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("reg")
        .arg("query")
        .arg(key)
        .args(extra)
        .creation_flags(CREATE_NO_WINDOW)
        .stderr(std::process::Stdio::null())
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default()
}
