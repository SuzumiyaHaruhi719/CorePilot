//! Self-update from GitHub Releases.
//!
//! CorePilot ships two flavors and both update themselves, but only one of them
//! has an installer to hand off to:
//!
//! * **Installer** (NSIS `setup.exe`) — the plugin fetches and verifies; we
//!   stage the verified installer in an admin-only directory and launch it
//!   ourselves ([`installer_install`]). The plugin's own `install` writes it to
//!   the user's `%TEMP%` and runs it elevated seconds later — any same-user,
//!   non-elevated process could swap the file in that window and get admin +
//!   ring-0 (PawnIO) with no UAC prompt.
//! * **Portable** (a folder holding the three program files) — there is nothing
//!   to hand off to, so we extract the release zip and swap the files ourselves
//!   ([`portable_install`]).
//!
//! Both paths go through the plugin for the manifest fetch, the semver compare
//! and — the part that matters — the **minisign signature check**. CorePilot
//! runs elevated and reaches ring-0 through the SMU/PawnIO sidecar, so an
//! unverified update payload is not a cosmetic bug, it is arbitrary code with
//! kernel reach. [`tauri_plugin_updater::Update::download`] verifies before it
//! returns the bytes; nothing here extracts, moves or executes anything that
//! did not come out of that call.
//!
//! ## Why the teardown is only two steps
//!
//! Updating means replacing files that live next to the running exe, so
//! anything holding one of them open has to let go first ([`teardown`]):
//!
//! * `corepilot_overlay.dll` may be **mapped into a running game**. A mapped
//!   image cannot be overwritten — but it can be renamed, so it is moved aside
//!   to `.old` (it is never unloaded from outside; that crashed games).
//! * `sensord.exe` is a live child process, and a running image locks its own
//!   file. It is told to hand the fans back to the BIOS (`autoall`), then its
//!   stdin is CLOSED so it reaches that restore before it dies; only a sidecar
//!   still alive after the grace window is terminated (see
//!   [`shutdown_teardown`] for why the old sleep-then-kill lost the race).
//!
//! Nothing else needs teardown, and it is worth writing down why so nobody adds
//! ceremony back: the `CorePilot-FPS` ETW session holds no file handle and the
//! next launch force-stops any stale one anyway (`fps::stop_stale_session`); the
//! taskbar monitor is a window on its own thread with no handle on our files
//! (it does call [`shutdown_teardown`] on `WM_ENDSESSION` — that window is the
//! only thing in this process the session manager delivers to, so it is how a
//! Windows shutdown / logoff / fast-user-switch reaches the fan restore at
//! all); and the store flush lives at real process exit (`RunEvent::Exit` in
//! `lib.rs`), plus one extra flush in [`teardown`] before the file swap. User
//! data in `%APPDATA%\com.corepilot.app` is never touched by any path in this
//! module.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

/// `platforms` key in `latest.json` for the portable zip. The installer uses the
/// stock `windows-x86_64`; the portable build asks for this one instead via
/// `UpdaterBuilder::target`, so ONE manifest serves both flavors.
const PORTABLE_TARGET: &str = "windows-x86_64-portable";

/// The files a portable install consists of, and therefore the complete set the
/// portable update swaps. Kept in sync with the release script's zip contents —
/// a missing member aborts the swap rather than producing a mixed-version folder.
const PORTABLE_FILES: [&str; 3] = ["corepilot.exe", "sensord.exe", "corepilot_overlay.dll"];

/// Where the verified payload is unpacked before anything live is touched.
const STAGING_DIR: &str = ".cp-update";

/// Suffix for the displaced previous version. Renaming a *running* exe is legal
/// on Windows (deleting it is not), which is what makes the in-place swap work.
/// These are cleaned up by the next successful launch, so a botched update
/// leaves the previous binaries sitting right there.
const BACKUP_SUFFIX: &str = "old";

/// Ceiling on the manifest fetch. A dead or captive network must never leave the
/// check spinning — it reports a failure and the user moves on.
const CHECK_TIMEOUT: Duration = Duration::from_secs(15);

/// How long the sidecar gets to run its own fan reset after its stdin closes,
/// before `TerminateProcess`. Sized to cover sensord's worst realistic `Gate`
/// hold — a full LibreHardwareMonitor close+reopen on the stale-bank path —
/// without making a tray quit feel stuck.
const SIDECAR_EXIT_WAIT: Duration = Duration::from_secs(3);

/// Shown whenever the in-app path can't finish, so there is always a way out.
const RELEASES_URL: &str = "https://github.com/SuzumiyaHaruhi719/CorePilot/releases/latest";

/// Which distribution this process is running as.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Flavor {
    Installer,
    Portable,
}

/// How much a pre-install condition matters.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Severity {
    /// Installing now would fail or leave hardware in a bad state. Refused.
    Block,
    /// Installing now loses work in progress. Allowed, with the cost stated.
    Warn,
}

/// One reason not to install right now.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Blocker {
    pub id: &'static str,
    pub severity: Severity,
    /// User-facing, Chinese (the UI language); translated by the frontend dict.
    pub message: String,
}

/// Result of a check. Deliberately just facts — whether to *prompt* is a policy
/// question (skipped versions, debounce, is a game running) that the frontend
/// owns, matching the one-way config flow the rest of the app uses.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub available: bool,
    pub current_version: String,
    pub latest_version: Option<String>,
    /// Release notes (the GitHub release body), as plain text.
    pub notes: Option<String>,
    pub pub_date: Option<String>,
    pub flavor: Flavor,
    /// A game currently holds the foreground. The frontend suppresses the
    /// automatic prompt on this — interrupting a game to advertise an update is
    /// the worst possible moment — but an explicitly-requested check still
    /// reports normally.
    pub game_foreground: bool,
    pub blockers: Vec<Blocker>,
    pub releases_url: &'static str,
}

/// Progress/phase payload for `update://state`.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StateEvent {
    phase: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// Byte progress for `update://progress`.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent {
    downloaded: u64,
    total: Option<u64>,
}

fn emit_state(app: &AppHandle, phase: &'static str, error: Option<String>) {
    let _ = app.emit("update://state", StateEvent { phase, error });
}

// =============================================================================
// Flavor detection
// =============================================================================

/// Directory the running executable lives in.
fn exe_dir() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("无法定位程序路径: {e}"))?;
    exe.parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "无法定位程序目录".to_string())
}

/// Whether `dir` looks like an NSIS install.
///
/// The signal is a sibling `uninstall.exe`, which Tauri's NSIS installer always
/// writes into the install directory and nothing else produces. We deliberately
/// do NOT consult the uninstall registry key: it survives a manual delete of the
/// install folder and can point at a path we are not running from, so it answers
/// "was this app ever installed" rather than "is *this* directory an install".
///
/// Known edge: unzipping the portable build on top of an old install directory
/// reads as installed. Running the NSIS installer there is still correct-ish
/// (it targets its own recorded path), and the alternative — treating a real
/// install as portable and swapping files under the installer's feet — is worse.
fn flavor_at(dir: &Path) -> Flavor {
    if dir.join("uninstall.exe").is_file() {
        Flavor::Installer
    } else {
        Flavor::Portable
    }
}

/// Flavor of the running process.
pub fn flavor() -> Flavor {
    exe_dir().map(|d| flavor_at(&d)).unwrap_or(Flavor::Portable)
}

/// Where the previous copy of `live` is parked during a swap: the full name plus
/// `.old` (`corepilot.exe` → `corepilot.exe.old`). Appended to the whole file
/// name rather than swapped into the extension, so it never collides with a real
/// name and reads unambiguously in a directory listing.
fn backup_path(live: &Path) -> PathBuf {
    let mut name = live.as_os_str().to_os_string();
    name.push(".");
    name.push(BACKUP_SUFFIX);
    PathBuf::from(name)
}

/// Can we actually write into the install directory? Probed rather than inferred
/// from the path, because the answer depends on ACLs, not on where it sits.
fn dir_writable(dir: &Path) -> bool {
    let probe = dir.join(".cp-write-probe");
    match std::fs::write(&probe, b"") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

// =============================================================================
// Pre-install conditions
// =============================================================================

/// Everything standing between the user and a clean install right now.
fn blockers(flavor: Flavor) -> Vec<Blocker> {
    let mut out = Vec::new();

    if crate::fan::exclusive_active() {
        out.push(Blocker {
            id: "fanTuning",
            severity: Severity::Block,
            message: "风扇校准/智能调优正在运行。此时退出会把风扇停在测试转速且无人恢复 — 请先等它结束或中止。"
                .to_string(),
        });
    }

    if flavor == Flavor::Portable {
        if let Ok(dir) = exe_dir() {
            if !dir_writable(&dir) {
                out.push(Blocker {
                    id: "dirReadOnly",
                    severity: Severity::Block,
                    message: format!("便携版目录不可写,无法就地更新: {}", dir.display()),
                });
            }
        }
    }

    if crate::disk_scan::any_scanning() {
        out.push(Blocker {
            id: "diskScanning",
            severity: Severity::Warn,
            message: "存储分析正在扫描,现在更新会丢弃本次扫描结果(需重新扫描)。".to_string(),
        });
    }

    let sessions = crate::perf_recorder::active_session_count();
    if sessions > 0 {
        out.push(Blocker {
            id: "perfRecording",
            severity: Severity::Warn,
            message: format!(
                "正在记录 {sessions} 个游戏性能会话。会话只在游戏退出时才生成报告,现在更新会丢失这些记录。"
            ),
        });
    }

    out
}

// =============================================================================
// Teardown
// =============================================================================

/// Release everything holding a program file open. See the module docs for why
/// this is two steps and not five. Best-effort throughout: a step that cannot
/// complete logs and yields, because a wedged teardown is worse than a slightly
/// dirty one — the swap/installer reports the real failure if a file is still
/// locked afterwards.
static SHUTDOWN_TORN_DOWN: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

pub fn shutdown_teardown() {
    // Portable updates call teardown before app.exit(), which also emits RunEvent::Exit.
    // The once guard prevents duplicate fan/sidecar/ETW/persistence operations.
    use std::sync::atomic::Ordering;
    if SHUTDOWN_TORN_DOWN.swap(true, Ordering::AcqRel) {
        return;
    }
    // Hand the hardware back before the sidecar dies, and let it actually RUN
    // that restore: `graceful_stop` queues `autoall`, closes stdin (sensord's
    // CommandLoop then resets every touched control under its Gate on the way
    // out) and only terminates a sidecar still alive after the grace window.
    // The old sleep-200-ms-then-kill lost that race against a long Gate hold and
    // left the Nuvoton pinned at the last software PWM until a cold boot.
    // Headers whose hand-back was already lost to a sidecar crash are parked at
    // 100 % first instead (see `fan::park_dirty_for_exit`).
    crate::fan::park_dirty_for_exit();
    crate::sidecar::graceful_stop(SIDECAR_EXIT_WAIT);
    crate::overlay_inject::write_disabled();
    crate::fps::stop_capture();
    // NO `persist::flush()` here: this body is behind the once-guard, and the
    // portable-update path runs it long before the process actually exits, which
    // would make the flush at real exit a no-op and drop the last debounce window
    // of store writes. The flush lives in `RunEvent::Exit` (lib.rs) instead, with
    // an explicit pre-swap one in `teardown` below.
}

fn teardown() {
    shutdown_teardown();
    // Explicit, because `shutdown_teardown` no longer flushes (see above) and the
    // update path may never reach `RunEvent::Exit` in a usable state.
    crate::persist::flush();
}

// =============================================================================
// Portable install
// =============================================================================

/// Unpack the verified zip into `staging`, keeping only the files a portable
/// install is made of.
///
/// Entries are matched on their **file name** and written to `staging/<name>`;
/// the archive's own path is never used to build a destination, so a crafted
/// entry like `../../windows/system32/x.dll` has nowhere to go. (The payload is
/// already signature-verified — this is the second lock on the same door.)
fn extract_portable(bytes: &[u8], staging: &Path) -> Result<(), String> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|e| format!("更新包无法打开: {e}"))?;

    for i in 0..zip.len() {
        let mut entry = zip
            .by_index(i)
            .map_err(|e| format!("更新包读取失败: {e}"))?;
        if !entry.is_file() {
            continue;
        }
        let Some(name) = entry
            .enclosed_name()
            .and_then(|p| p.file_name().map(|s| s.to_string_lossy().to_string()))
        else {
            continue;
        };
        if !PORTABLE_FILES.iter().any(|f| f.eq_ignore_ascii_case(&name)) {
            continue;
        }
        let mut out = std::fs::File::create(staging.join(&name))
            .map_err(|e| format!("写入 {name} 失败: {e}"))?;
        std::io::copy(&mut entry, &mut out).map_err(|e| format!("解压 {name} 失败: {e}"))?;
    }

    for name in PORTABLE_FILES {
        let p = staging.join(name);
        let ok = std::fs::metadata(&p).map(|m| m.len() > 0).unwrap_or(false);
        if !ok {
            return Err(format!("更新包缺少 {name},已中止(未改动任何文件)。"));
        }
    }
    Ok(())
}

/// Move every staged file into place, displacing the live one to `<name>.old`.
///
/// All-or-nothing: on the first failure every rename already made is undone, so
/// the folder is either fully on the new version or untouched — never a mix of
/// two builds, which for this app means an exe talking to a sidecar and an
/// overlay DLL from a different release.
///
/// `fs::rename` maps to `MoveFileExW(MOVEFILE_REPLACE_EXISTING)` on Windows,
/// which is allowed to rename a *running* image — that is what lets the process
/// replace its own exe while executing it.
fn swap_in(dir: &Path, staging: &Path, names: &[&str]) -> Result<(), String> {
    // (live path, backup path) for each rename already performed, newest last.
    let mut done: Vec<(PathBuf, PathBuf)> = Vec::new();

    let rollback = |done: &[(PathBuf, PathBuf)]| {
        for (live, backup) in done.iter().rev() {
            let _ = std::fs::remove_file(live);
            let _ = std::fs::rename(backup, live);
        }
    };

    for name in names {
        let live = dir.join(name);
        let backup = backup_path(&live);
        let staged = staging.join(name);

        if live.exists() {
            if let Err(e) = std::fs::rename(&live, &backup) {
                rollback(&done);
                return Err(format!("无法移开旧的 {name}: {e}"));
            }
        }
        if let Err(e) = std::fs::rename(&staged, &live) {
            // Undo this file's own backup rename first, then the earlier ones.
            let _ = std::fs::rename(&backup, &live);
            rollback(&done);
            return Err(format!("无法写入新的 {name}: {e}"));
        }
        done.push((live, backup));
    }

    Ok(())
}

/// Extract, tear down, swap, relaunch. Only reached with signature-verified bytes.
fn portable_install(app: &AppHandle, bytes: &[u8]) -> Result<(), String> {
    let dir = exe_dir()?;
    let staging = dir.join(STAGING_DIR);

    emit_state(app, "staging", None);
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| format!("无法创建临时目录: {e}"))?;
    extract_portable(bytes, &staging)?;

    // Point of no return: from here the live files move. Everything above this
    // line is reversible by deleting one directory.
    teardown();

    emit_state(app, "swapping", None);
    swap_in(&dir, &staging, &PORTABLE_FILES)?;
    let _ = std::fs::remove_dir_all(&staging);

    // Hand off to the new binary. It waits for us to actually exit before Tauri's
    // single-instance plugin comes up — otherwise the fresh process would find
    // this one still alive, hand its argv over to a process that is seconds from
    // death, and quit, leaving no CorePilot running at all.
    let new_exe = dir.join(PORTABLE_FILES[0]);
    std::process::Command::new(&new_exe)
        .arg("--await-predecessor")
        .arg(std::process::id().to_string())
        .spawn()
        .map_err(|e| {
            format!(
                "新版本已就位,但启动失败: {e}(请手动运行 {})",
                new_exe.display()
            )
        })?;

    emit_state(app, "ready", None);
    app.exit(0);
    Ok(())
}

// =============================================================================
// Installer install
// =============================================================================

/// Prefix of the per-update staging directory created directly under
/// `%ProgramData%`. A fresh name per update: `CreateDirectoryW` fails on an
/// existing path, so a pre-created (squatted) directory can never be reused.
const INSTALLER_STAGE_PREFIX: &str = "CorePilot-update-";

/// SDDL for the staging directory: owner Administrators, protected DACL granting
/// only SYSTEM and Administrators. A non-elevated process — even the same user,
/// whose Administrators SID is deny-only until elevation — can't create, swap or
/// rename anything in it, which is what makes "verify, then run elevated" sound.
const ADMIN_ONLY_SDDL: windows::core::PCWSTR =
    windows::core::w!("O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)");

/// NSIS arguments for the configured `installMode: "passive"` (tauri.conf.json),
/// exactly what the plugin would pass: passive UI, relaunch the app afterwards.
const NSIS_PASSIVE_ARGS: &str = "/P /R /UPDATE";

fn create_admin_only_dir(dir: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
    use windows::Win32::Storage::FileSystem::CreateDirectoryW;

    let wide: Vec<u16> = dir.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe {
        let mut sd = PSECURITY_DESCRIPTOR::default();
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            ADMIN_ONLY_SDDL,
            SDDL_REVISION_1,
            &mut sd,
            None,
        )
        .map_err(|e| format!("无法创建安全描述符: {e}"))?;
        let sa = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: sd.0,
            bInheritHandle: false.into(),
        };
        let made = CreateDirectoryW(windows::core::PCWSTR(wide.as_ptr()), Some(&sa));
        let _ = LocalFree(Some(HLOCAL(sd.0)));
        made.map_err(|e| format!("无法创建更新目录 {}: {e}", dir.display()))
    }
}

/// Write the verified installer into a fresh admin-only directory.
fn stage_installer(bytes: &[u8], version: &str) -> Result<PathBuf, String> {
    use std::io::Write;
    if !bytes.starts_with(b"MZ") {
        return Err("更新包不是有效的安装程序,已拒绝安装。".to_string());
    }
    let root = std::env::var_os("ProgramData")
        .map(PathBuf::from)
        .ok_or_else(|| "无法定位 %ProgramData%".to_string())?;
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = root.join(format!(
        "{INSTALLER_STAGE_PREFIX}{:x}{:x}",
        std::process::id(),
        nonce
    ));
    create_admin_only_dir(&dir)?;
    let path = dir.join(format!("CorePilot_{version}_x64-setup.exe"));
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| format!("写入安装程序失败: {e}"))?;
    f.write_all(bytes)
        .and_then(|()| f.sync_all())
        .map_err(|e| format!("写入安装程序失败: {e}"))?;
    Ok(path)
}

/// Quote one argument for NSIS's command-line parser, matching the plugin's
/// escaping: `/` also forces quotes so NSIS never reads it as a switch.
fn nsis_quote(arg: &str) -> String {
    if !arg.is_empty() && !arg.contains([' ', '\t', '/', '"']) {
        return arg.to_string();
    }
    let mut out = String::from('"');
    let mut backslashes = 0usize;
    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                out.extend(std::iter::repeat_n('\\', backslashes + 1));
                backslashes = 0;
            }
            _ => backslashes = 0,
        }
        out.push(c);
    }
    out.extend(std::iter::repeat_n('\\', backslashes));
    out.push('"');
    out
}

/// The installer's parameter string: mode switches, then our own arguments
/// after `/ARGS` so the relaunched app starts the way this one did.
fn nsis_parameters<I: IntoIterator<Item = String>>(current_args: I) -> String {
    let mut p = format!("{NSIS_PASSIVE_ARGS} /ARGS");
    for a in current_args {
        p.push(' ');
        p.push_str(&nsis_quote(&a));
    }
    p
}

/// Stage, tear down, hand off to NSIS, exit. Only reached with verified bytes.
fn installer_install(app: &AppHandle, bytes: &[u8], version: &str) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOW;

    emit_state(app, "staging", None);
    let setup = stage_installer(bytes, version)?;

    // Point of no return: the hardware is handed back and the sidecar stops.
    teardown();

    emit_state(app, "swapping", None);
    if crate::overlay_inject::dll_maybe_mapped() {
        if let Ok(dir) = exe_dir() {
            let dll = dir.join(PORTABLE_FILES[2]);
            let backup = backup_path(&dll);
            let _ = std::fs::remove_file(&backup);
            if let Err(e) = std::fs::rename(&dll, &backup) {
                tracing::warn!("updater: could not move overlay DLL aside: {e}");
            }
        }
    }

    let file: Vec<u16> = setup.as_os_str().encode_wide().chain(Some(0)).collect();
    let params: Vec<u16> = nsis_parameters(std::env::args().skip(1))
        .encode_utf16()
        .chain(Some(0))
        .collect();
    // ShellExecute (not CreateProcess) so an installer that requests elevation
    // still launches if this process somehow isn't elevated.
    let code = unsafe {
        ShellExecuteW(
            None,
            windows::core::w!("open"),
            windows::core::PCWSTR(file.as_ptr()),
            windows::core::PCWSTR(params.as_ptr()),
            windows::core::PCWSTR::null(),
            SW_SHOW,
        )
    };
    if code.0 as usize <= 32 {
        return Err(format!(
            "无法启动安装程序(代码 {}),请从发布页手动下载: {RELEASES_URL}",
            code.0 as usize
        ));
    }
    emit_state(app, "ready", None);
    app.exit(0);
    Ok(())
}

/// Delete staging directories left by earlier installer updates. Best-effort:
/// the installer may still be running (it relaunches us before it exits).
fn remove_installer_stages() {
    let Some(root) = std::env::var_os("ProgramData").map(PathBuf::from) else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(&root) else {
        return;
    };
    for e in entries.flatten() {
        if e.file_name()
            .to_string_lossy()
            .starts_with(INSTALLER_STAGE_PREFIX)
        {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

// =============================================================================
// Startup housekeeping
// =============================================================================

/// Remove what a previous update left behind: the displaced `<name>.old` files
/// and the staging directory. Best-effort — reaching this code at all means the
/// new version launched, which is the evidence that the old one is disposable.
pub fn cleanup_stale() {
    remove_installer_stages();
    let Ok(dir) = exe_dir() else { return };
    let _ = std::fs::remove_dir_all(dir.join(STAGING_DIR));
    // An installer update that died after the overlay DLL was moved aside leaves
    // only the `.old` copy; put it back so the overlay still works.
    let dll = dir.join(PORTABLE_FILES[2]);
    if !dll.exists() {
        let _ = std::fs::rename(backup_path(&dll), &dll);
    }
    for name in PORTABLE_FILES {
        let backup = backup_path(&dir.join(name));
        if backup.exists() {
            match std::fs::remove_file(&backup) {
                Ok(()) => tracing::info!("updater: removed {}", backup.display()),
                // Still locked (e.g. the predecessor is mid-exit) — next launch
                // gets it. Never worth failing startup over.
                Err(e) => tracing::debug!("updater: {} not removed yet: {e}", backup.display()),
            }
        }
    }
}

/// Block until `pid` exits (or the deadline passes), for the portable relaunch
/// handoff. Called from `lib.rs` BEFORE the Tauri builder — in particular before
/// the single-instance plugin — so the new process never races the old one.
pub fn await_predecessor(pid: u32, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    while crate::fps::pid_alive(pid) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Parse `--await-predecessor <pid>` out of the process arguments.
pub fn predecessor_arg<I: IntoIterator<Item = String>>(args: I) -> Option<u32> {
    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        if a == "--await-predecessor" {
            return it.next().and_then(|v| v.parse().ok());
        }
        if let Some(v) = a.strip_prefix("--await-predecessor=") {
            return v.parse().ok();
        }
    }
    None
}

// =============================================================================
// Commands
// =============================================================================

/// Turn a plugin error into something a user can act on. The generic
/// "check failed" message is exactly what makes update problems unreportable.
fn explain(e: tauri_plugin_updater::Error) -> String {
    use tauri_plugin_updater::Error as E;
    match e {
        E::Minisign(_) | E::Base64(_) | E::SignatureUtf8(_) => {
            format!("更新包签名校验失败,已拒绝安装(文件被篡改或发布有误): {e}")
        }
        E::TargetNotFound(t) => {
            format!("发布清单里没有当前版本对应的平台条目 `{t}` — 请从发布页手动下载。")
        }
        E::ReleaseNotFound => {
            "无法获取有效的发布清单(latest.json) — 最新发布可能仍是草稿,或网络被拦截。".to_string()
        }
        E::Reqwest(_) | E::Network(_) => format!("网络请求失败: {e}"),
        other => format!("更新失败: {other}"),
    }
}

/// Build an updater bound to this flavor's manifest entry.
fn updater_for(app: &AppHandle, flavor: Flavor) -> Result<tauri_plugin_updater::Updater, String> {
    let mut b = app.updater_builder().timeout(CHECK_TIMEOUT);
    if flavor == Flavor::Portable {
        // Read the portable zip's entry out of the same manifest instead of the
        // stock windows-x86_64 installer entry.
        b = b.target(PORTABLE_TARGET);
    }
    b.build().map_err(explain)
}

/// Ask GitHub whether a newer release exists. Reports facts only; see [`UpdateInfo`].
///
/// `async` + the plugin's own async client: this runs off the main thread, so a
/// slow or captive network never touches the window's message pump.
#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<UpdateInfo, String> {
    let flavor = flavor();
    emit_state(&app, "checking", None);

    let current = app.package_info().version.to_string();
    let game_foreground = crate::fps::foreground_info_now().is_game;

    let result = updater_for(&app, flavor)?.check().await;
    let update = match result {
        Ok(u) => u,
        Err(e) => {
            let msg = explain(e);
            emit_state(&app, "failed", Some(msg.clone()));
            return Err(msg);
        }
    };

    emit_state(&app, "idle", None);
    Ok(match update {
        Some(u) => UpdateInfo {
            available: true,
            current_version: current,
            latest_version: Some(u.version.clone()),
            notes: u.body.clone(),
            pub_date: u.date.map(|d| d.to_string()),
            flavor,
            game_foreground,
            blockers: blockers(flavor),
            releases_url: RELEASES_URL,
        },
        None => UpdateInfo {
            available: false,
            current_version: current,
            latest_version: None,
            notes: None,
            pub_date: None,
            flavor,
            game_foreground,
            blockers: Vec::new(),
            releases_url: RELEASES_URL,
        },
    })
}

/// Download the update and install it.
///
/// Re-checks rather than carrying an `Update` across the IPC boundary: the
/// object is cheap to rebuild, and the safety conditions must be evaluated at
/// install time anyway (a game can have launched while the prompt sat on screen).
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    let flavor = flavor();

    if let Some(b) = blockers(flavor)
        .into_iter()
        .find(|b| b.severity == Severity::Block)
    {
        emit_state(&app, "failed", Some(b.message.clone()));
        return Err(b.message);
    }

    let updater = updater_for(&app, flavor)?;
    let update = match updater.check().await {
        Ok(Some(u)) => u,
        Ok(None) => return Err("已是最新版本。".to_string()),
        Err(e) => {
            let msg = explain(e);
            emit_state(&app, "failed", Some(msg.clone()));
            return Err(msg);
        }
    };

    emit_state(&app, "downloading", None);
    let mut downloaded: u64 = 0;
    let progress_app = app.clone();
    let verify_app = app.clone();
    // `download` verifies the minisign signature before it hands the bytes back;
    // an unverified payload never reaches the code below. The finish callback
    // fires immediately BEFORE that verification, which is what makes it the
    // honest moment to show "正在校验签名…".
    let bytes = update
        .download(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = progress_app.emit("update://progress", ProgressEvent { downloaded, total });
            },
            move || emit_state(&verify_app, "verifying", None),
        )
        .await
        .map_err(|e| {
            let msg = explain(e);
            emit_state(&app, "failed", Some(msg.clone()));
            msg
        })?;

    match flavor {
        Flavor::Portable => {
            // Runs on the blocking pool: extraction and the swap are synchronous
            // filesystem work, and this command is awaited from the UI.
            let app2 = app.clone();
            let outcome =
                tauri::async_runtime::spawn_blocking(move || portable_install(&app2, &bytes))
                    .await
                    .map_err(|e| format!("更新任务失败: {e}"))?;

            if let Err(msg) = outcome {
                emit_state(&app, "failed", Some(msg.clone()));
                return Err(msg);
            }
        }
        Flavor::Installer => {
            let app2 = app.clone();
            let version = update.version.clone();
            let outcome = tauri::async_runtime::spawn_blocking(move || {
                installer_install(&app2, &bytes, &version)
            })
            .await
            .map_err(|e| format!("更新任务失败: {e}"))?;
            if let Err(msg) = outcome {
                emit_state(&app, "failed", Some(msg.clone()));
                return Err(msg);
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cp-updater-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn nsis_args_match_plugin_escaping() {
        assert_eq!(nsis_parameters(Vec::<String>::new()), "/P /R /UPDATE /ARGS");
        assert_eq!(
            nsis_parameters(["--x".to_string(), "a b".into(), "c/d".into(), "".into()]),
            r#"/P /R /UPDATE /ARGS --x "a b" "c/d" """#
        );
        assert_eq!(nsis_quote(r#"say "hi""#), r#""say \"hi\"""#);
        assert_eq!(nsis_quote(r"C:\dir x\"), r#""C:\dir x\\""#);
        assert_eq!(nsis_quote(r"plain"), "plain");
    }

    #[test]
    fn flavor_follows_uninstaller_presence() {
        let dir = tmp("flavor");
        assert_eq!(flavor_at(&dir), Flavor::Portable);
        std::fs::write(dir.join("uninstall.exe"), b"x").unwrap();
        assert_eq!(flavor_at(&dir), Flavor::Installer);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn swap_replaces_all_and_keeps_backups() {
        let dir = tmp("swap-ok");
        let staging = dir.join(STAGING_DIR);
        std::fs::create_dir_all(&staging).unwrap();
        for name in PORTABLE_FILES {
            std::fs::write(dir.join(name), b"old").unwrap();
            std::fs::write(staging.join(name), b"new").unwrap();
        }

        swap_in(&dir, &staging, &PORTABLE_FILES).unwrap();

        for name in PORTABLE_FILES {
            assert_eq!(std::fs::read(dir.join(name)).unwrap(), b"new");
        }
        // The displaced build is still on disk until the next launch cleans it.
        assert_eq!(
            std::fs::read(dir.join("corepilot.exe.old")).unwrap(),
            b"old"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The invariant that matters: a swap that dies partway leaves the previous
    /// version intact, not a folder holding half of each build.
    #[test]
    fn swap_rolls_back_when_a_file_is_missing() {
        let dir = tmp("swap-rollback");
        let staging = dir.join(STAGING_DIR);
        std::fs::create_dir_all(&staging).unwrap();
        for name in PORTABLE_FILES {
            std::fs::write(dir.join(name), b"old").unwrap();
        }
        // Only the first file is staged, so the second rename fails.
        std::fs::write(staging.join(PORTABLE_FILES[0]), b"new").unwrap();

        let err = swap_in(&dir, &staging, &PORTABLE_FILES).unwrap_err();
        assert!(err.contains(PORTABLE_FILES[1]), "unexpected error: {err}");

        for name in PORTABLE_FILES {
            assert_eq!(
                std::fs::read(dir.join(name)).unwrap(),
                b"old",
                "{name} was not restored"
            );
        }
        for name in PORTABLE_FILES {
            let backup = dir.join(format!("{}.{BACKUP_SUFFIX}", name));
            assert!(!backup.exists(), "{} left behind", backup.display());
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn extract_takes_only_known_files_and_ignores_archive_paths() {
        let dir = tmp("extract");
        let staging = dir.join("s");
        std::fs::create_dir_all(&staging).unwrap();

        let mut buf = Vec::new();
        {
            let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let opts = zip::write::SimpleFileOptions::default();
            use std::io::Write;
            // Nested paths and a traversal attempt: both must land as bare names
            // in the staging dir (or be dropped), never outside it.
            for name in [
                "nested/corepilot.exe",
                "sensord.exe",
                "corepilot_overlay.dll",
            ] {
                w.start_file(name, opts).unwrap();
                w.write_all(b"payload").unwrap();
            }
            w.start_file("../../evil.dll", opts).unwrap();
            w.write_all(b"nope").unwrap();
            w.finish().unwrap();
        }

        extract_portable(&buf, &staging).unwrap();
        for name in PORTABLE_FILES {
            assert_eq!(std::fs::read(staging.join(name)).unwrap(), b"payload");
        }
        assert!(!dir.join("evil.dll").exists());
        assert!(!staging.join("evil.dll").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn extract_refuses_an_incomplete_package() {
        let dir = tmp("extract-partial");
        let staging = dir.join("s");
        std::fs::create_dir_all(&staging).unwrap();

        let mut buf = Vec::new();
        {
            let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let opts = zip::write::SimpleFileOptions::default();
            use std::io::Write;
            w.start_file("corepilot.exe", opts).unwrap();
            w.write_all(b"payload").unwrap();
            w.finish().unwrap();
        }

        let err = extract_portable(&buf, &staging).unwrap_err();
        assert!(err.contains("sensord.exe"), "unexpected error: {err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn predecessor_arg_parses_both_forms() {
        let a = ["corepilot.exe", "--await-predecessor", "4242"].map(String::from);
        assert_eq!(predecessor_arg(a), Some(4242));
        let b = ["corepilot.exe", "--await-predecessor=17"].map(String::from);
        assert_eq!(predecessor_arg(b), Some(17));
        let c = ["corepilot.exe", "--other"].map(String::from);
        assert_eq!(predecessor_arg(c), None);
    }
}
