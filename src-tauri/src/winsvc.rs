//! Windows Services + Startup (autorun) management via Win32.
//!
//! - Services: SCM enumeration (`EnumServicesStatusExW`, two-call buffer
//!   pattern) and start/stop/restart control.
//! - Startup: HKCU/HKLM `...\Run` registry values, the user Startup folder, and
//!   the `StartupApproved` enable/disable blobs Windows uses in Task Manager.
//!
//! Everything degrades gracefully: a single unreadable service or registry
//! value is skipped, never panicking and never aborting the whole list. FFI
//! results are checked explicitly (no `unwrap` on Win32 calls).

use crate::error::{CoreError, CoreResult};
use serde::Serialize;
use std::path::PathBuf;
use std::thread::sleep;
use std::time::Duration;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{ERROR_SUCCESS, WIN32_ERROR};
use windows::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegEnumValueW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW,
    HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_SET_VALUE, REG_EXPAND_SZ,
    REG_OPTION_NON_VOLATILE, REG_SZ, REG_VALUE_TYPE,
};
use windows::Win32::System::Services::{
    CloseServiceHandle, ControlService, EnumServicesStatusExW, OpenSCManagerW, OpenServiceW,
    QueryServiceConfig2W, QueryServiceConfigW, QueryServiceStatus, StartServiceW,
    ENUM_SERVICE_STATUS_PROCESSW, QUERY_SERVICE_CONFIGW, SC_ENUM_PROCESS_INFO, SC_HANDLE,
    SC_MANAGER_CONNECT, SC_MANAGER_ENUMERATE_SERVICE, SERVICE_CONFIG_DESCRIPTION,
    SERVICE_CONTROL_STOP, SERVICE_DESCRIPTIONW, SERVICE_PAUSED, SERVICE_QUERY_CONFIG,
    SERVICE_QUERY_STATUS, SERVICE_RUNNING, SERVICE_START, SERVICE_STATE_ALL, SERVICE_STATUS,
    SERVICE_STATUS_CURRENT_STATE, SERVICE_STOP, SERVICE_STOPPED, SERVICE_WIN32,
};

// ---------------------------------------------------------------------------
// Serialized types
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceItem {
    pub name: String,
    pub display: String,
    pub status: String,
    pub start_type: String,
    /// PID of the hosting process, or 0 when the service is not running.
    pub pid: u32,
    /// Service description (may be empty if unreadable or unset).
    pub description: String,
    /// Load-order group (may be empty if unreadable or unset).
    pub group: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupItem {
    pub name: String,
    pub command: String,
    pub location: String,
    pub enabled: bool,
}

// ---------------------------------------------------------------------------
// Small wide-string helper
// ---------------------------------------------------------------------------

/// UTF-16, NUL-terminated copy of `s`, suitable for `PCWSTR(v.as_ptr())`.
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

// ---------------------------------------------------------------------------
// RAII guard so service handles always close, even on early return.
// ---------------------------------------------------------------------------

struct ScHandle(SC_HANDLE);

impl Drop for ScHandle {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            // Best-effort close; nothing actionable on failure.
            unsafe {
                let _ = CloseServiceHandle(self.0);
            }
        }
    }
}

// ===========================================================================
// SERVICES
// ===========================================================================

/// Translate an SCM current-state code into a stable lowercase label.
fn status_label(state: SERVICE_STATUS_CURRENT_STATE) -> String {
    let label = if state == SERVICE_RUNNING {
        "running"
    } else if state == SERVICE_STOPPED {
        "stopped"
    } else if state == SERVICE_PAUSED {
        "paused"
    } else {
        "other"
    };
    label.to_string()
}

/// Map a Win32 `dwStartType` value to a short label (boot/system/auto/manual/
/// disabled), defaulting to "other".
fn start_type_label(t: u32) -> &'static str {
    match t {
        0 => "boot",
        1 => "system",
        2 => "auto",
        3 => "manual",
        4 => "disabled",
        _ => "other",
    }
}

/// Enumerate all Win32 services (any state). `start_type`, `description`, and
/// `group` are read per service from `QueryServiceConfigW`/`QueryServiceConfig2W`
/// (the start type comes free from the same config struct as the group).
///
/// `pid` comes straight from the enumeration (process id of the hosting
/// process, 0 when stopped). `description` and `group` are read per service via
/// `QueryServiceConfig2W`/`QueryServiceConfigW`; this list loads on demand so
/// the extra per-service queries are acceptable. Any per-service failure leaves
/// those two fields empty and never aborts the list.
pub fn list_services() -> CoreResult<Vec<ServiceItem>> {
    unsafe {
        // Connect + enumerate rights: enough to enumerate and to open each
        // service for SERVICE_QUERY_CONFIG below.
        let scm = OpenSCManagerW(
            PCWSTR::null(),
            PCWSTR::null(),
            SC_MANAGER_ENUMERATE_SERVICE | SC_MANAGER_CONNECT,
        )?;
        let scm = ScHandle(scm);

        // First call: discover the required byte count.
        let mut bytes_needed: u32 = 0;
        let mut services_returned: u32 = 0;
        let probe = EnumServicesStatusExW(
            scm.0,
            SC_ENUM_PROCESS_INFO,
            SERVICE_WIN32,
            SERVICE_STATE_ALL,
            None,
            &mut bytes_needed,
            &mut services_returned,
            None,
            PCWSTR::null(),
        );
        // The probe is expected to fail with ERROR_MORE_DATA; only a *zero* byte
        // requirement (truly empty) is a reason to return early.
        match probe {
            Ok(()) => return Ok(Vec::new()),
            Err(_) if bytes_needed == 0 => return Ok(Vec::new()),
            Err(_) => {}
        }

        // Allocate as the struct type to guarantee correct alignment, then view
        // it as &mut [u8] for the API (which derives cbBufSize from slice len).
        let stride = std::mem::size_of::<ENUM_SERVICE_STATUS_PROCESSW>();
        let count = (bytes_needed as usize).div_ceil(stride).max(1);
        let mut buffer: Vec<ENUM_SERVICE_STATUS_PROCESSW> = Vec::with_capacity(count);
        let byte_len = count * stride;
        let byte_slice = std::slice::from_raw_parts_mut(buffer.as_mut_ptr() as *mut u8, byte_len);

        bytes_needed = 0;
        services_returned = 0;
        EnumServicesStatusExW(
            scm.0,
            SC_ENUM_PROCESS_INFO,
            SERVICE_WIN32,
            SERVICE_STATE_ALL,
            Some(byte_slice),
            &mut bytes_needed,
            &mut services_returned,
            None,
            PCWSTR::null(),
        )?;

        // The API wrote `services_returned` initialized structs into our buffer.
        let written = (services_returned as usize).min(count);
        let entries = std::slice::from_raw_parts(buffer.as_ptr(), written);

        let mut items: Vec<ServiceItem> = Vec::with_capacity(written);
        for entry in entries {
            // A failed name read on one entry must not abort the whole list.
            let name = if entry.lpServiceName.is_null() {
                String::new()
            } else {
                entry.lpServiceName.to_string().unwrap_or_default()
            };
            let display = if entry.lpDisplayName.is_null() {
                name.clone()
            } else {
                entry.lpDisplayName.to_string().unwrap_or_else(|_| name.clone())
            };
            // PID straight from the enumeration; 0 means the service isn't running.
            let pid = entry.ServiceStatusProcess.dwProcessId;
            // Per-service description + load-order group (best-effort, "" on any failure).
            let (description, group, start_type) = if name.is_empty() {
                (String::new(), String::new(), "other".to_string())
            } else {
                read_service_config(scm.0, &name)
            };
            items.push(ServiceItem {
                name,
                display,
                status: status_label(entry.ServiceStatusProcess.dwCurrentState),
                start_type,
                pid,
                description,
                group,
            });
        }

        // Sort by display name (case-insensitive) for a stable UI ordering.
        items.sort_by(|a, b| a.display.to_lowercase().cmp(&b.display.to_lowercase()));
        Ok(items)
    }
}

/// Open one service (read-only) and return `(description, group)`.
///
/// Best-effort throughout: a failed open or query yields empty strings rather
/// than aborting. Both reads use the documented size-then-fill (two-call)
/// pattern; backing buffers are allocated as the destination struct type so the
/// embedded `PWSTR` pointers are correctly aligned.
///
/// # Safety
/// `scm` must be a valid SCM handle opened with at least `SC_MANAGER_CONNECT`.
unsafe fn read_service_config(scm: SC_HANDLE, name: &str) -> (String, String, String) {
    let empty = (String::new(), String::new(), "other".to_string());

    let name_w = wide(name);
    let svc = match OpenServiceW(scm, PCWSTR(name_w.as_ptr()), SERVICE_QUERY_CONFIG) {
        Ok(h) => ScHandle(h),
        Err(_) => return empty,
    };

    let description = read_service_description(svc.0);
    let (group, start_type) = read_service_group_start(svc.0);
    (description, group, start_type)
}

/// `QueryServiceConfig2W(SERVICE_CONFIG_DESCRIPTION)` two-call read → trimmed
/// description (empty on any failure or when `lpDescription` is null).
///
/// # Safety
/// `svc` must be a valid service handle with `SERVICE_QUERY_CONFIG` access.
unsafe fn read_service_description(svc: SC_HANDLE) -> String {
    // First call: discover the byte count (None buffer is expected to fail).
    let mut bytes_needed: u32 = 0;
    let probe = QueryServiceConfig2W(svc, SERVICE_CONFIG_DESCRIPTION, None, &mut bytes_needed);
    match probe {
        Ok(()) => return String::new(), // succeeded with no buffer → nothing to read
        Err(_) if bytes_needed == 0 => return String::new(),
        Err(_) => {}
    }

    // Back the byte buffer with the destination struct type for correct
    // alignment of the trailing string data the API appends.
    let stride = std::mem::size_of::<SERVICE_DESCRIPTIONW>();
    let count = (bytes_needed as usize).div_ceil(stride).max(1);
    let mut buffer: Vec<SERVICE_DESCRIPTIONW> = Vec::with_capacity(count);
    let byte_len = count * stride;
    let byte_slice = std::slice::from_raw_parts_mut(buffer.as_mut_ptr() as *mut u8, byte_len);

    bytes_needed = 0;
    if QueryServiceConfig2W(
        svc,
        SERVICE_CONFIG_DESCRIPTION,
        Some(byte_slice),
        &mut bytes_needed,
    )
    .is_err()
    {
        return String::new();
    }

    let desc = &*(buffer.as_ptr());
    if desc.lpDescription.is_null() {
        String::new()
    } else {
        desc.lpDescription
            .to_string()
            .map(|s| s.trim().to_string())
            .unwrap_or_default()
    }
}

/// `QueryServiceConfigW` two-call read → `(load-order group, start-type label)`.
/// Group is empty when null/absent; start type maps `dwStartType`
/// (boot/system/auto/manual/disabled), defaulting to "other" on any failure.
///
/// # Safety
/// `svc` must be a valid service handle with `SERVICE_QUERY_CONFIG` access.
unsafe fn read_service_group_start(svc: SC_HANDLE) -> (String, String) {
    let fallback = || (String::new(), "other".to_string());

    // First call: discover the byte count (None buffer is expected to fail).
    let mut bytes_needed: u32 = 0;
    let probe = QueryServiceConfigW(svc, None, 0, &mut bytes_needed);
    match probe {
        Ok(()) => return fallback(),
        Err(_) if bytes_needed == 0 => return fallback(),
        Err(_) => {}
    }

    // Allocate as the struct type (correct alignment for embedded PWSTRs); the
    // API derives capacity from `cbbufsize` in bytes.
    let stride = std::mem::size_of::<QUERY_SERVICE_CONFIGW>();
    let count = (bytes_needed as usize).div_ceil(stride).max(1);
    let mut buffer: Vec<QUERY_SERVICE_CONFIGW> = Vec::with_capacity(count);
    let cb_buf_size = (count * stride) as u32;

    bytes_needed = 0;
    if QueryServiceConfigW(svc, Some(buffer.as_mut_ptr()), cb_buf_size, &mut bytes_needed).is_err() {
        return fallback();
    }

    let cfg = &*(buffer.as_ptr());
    let group = if cfg.lpLoadOrderGroup.is_null() {
        String::new()
    } else {
        cfg.lpLoadOrderGroup
            .to_string()
            .map(|s| s.trim().to_string())
            .unwrap_or_default()
    };
    (group, start_type_label(cfg.dwStartType.0).to_string())
}

/// Start, stop, or restart a service by name.
pub fn control_service(name: String, action: String) -> CoreResult<()> {
    let action = action.to_lowercase();
    if !matches!(action.as_str(), "start" | "stop" | "restart") {
        return Err(CoreError::Msg(format!("unknown action: {action}")));
    }

    unsafe {
        let scm = OpenSCManagerW(PCWSTR::null(), PCWSTR::null(), SC_MANAGER_ENUMERATE_SERVICE)?;
        let scm = ScHandle(scm);

        let name_w = wide(&name);
        let service = OpenServiceW(
            scm.0,
            PCWSTR(name_w.as_ptr()),
            SERVICE_START | SERVICE_STOP | SERVICE_QUERY_STATUS,
        )?;
        let service = ScHandle(service);

        match action.as_str() {
            "start" => start(&service),
            "stop" => stop(&service),
            "restart" => {
                // Stop is best-effort: an already-stopped service should still
                // proceed to start. Then poll briefly for the stop to settle.
                let _ = stop(&service);
                for _ in 0..20 {
                    sleep(Duration::from_millis(150));
                    if current_state(&service) == Some(SERVICE_STOPPED) {
                        break;
                    }
                }
                start(&service)
            }
            _ => unreachable!("validated above"),
        }
    }
}

/// `StartServiceW` with no arguments.
unsafe fn start(service: &ScHandle) -> CoreResult<()> {
    StartServiceW(service.0, None).map_err(CoreError::from)
}

/// `ControlService(SERVICE_CONTROL_STOP)`.
unsafe fn stop(service: &ScHandle) -> CoreResult<()> {
    let mut status = SERVICE_STATUS::default();
    ControlService(service.0, SERVICE_CONTROL_STOP, &mut status).map_err(CoreError::from)
}

/// Query the live current state (side-effect free), or `None` on failure.
unsafe fn current_state(service: &ScHandle) -> Option<SERVICE_STATUS_CURRENT_STATE> {
    let mut status = SERVICE_STATUS::default();
    match QueryServiceStatus(service.0, &mut status) {
        Ok(()) => Some(status.dwCurrentState),
        Err(_) => None,
    }
}

// ===========================================================================
// STARTUP (autorun)
// ===========================================================================

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const APPROVED_RUN: &str =
    r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
const APPROVED_FOLDER: &str =
    r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder";

const LOC_HKCU_RUN: &str = "hkcu_run";
const LOC_HKLM_RUN: &str = "hklm_run";
const LOC_STARTUP_FOLDER: &str = "startup_folder";

/// First byte of a `StartupApproved` blob meaning "disabled".
const APPROVED_DISABLED: u8 = 0x03;
/// First byte meaning "enabled".
const APPROVED_ENABLED: u8 = 0x02;
/// Length of the enable/disable blob Windows writes.
const APPROVED_BLOB_LEN: usize = 12;

/// RAII guard so registry keys always close.
struct RegKey(HKEY);

impl Drop for RegKey {
    fn drop(&mut self) {
        if !self.0.is_invalid() {
            unsafe {
                let _ = RegCloseKey(self.0);
            }
        }
    }
}

/// Open an existing key for the given access; `None` if it does not exist.
fn open_key(root: HKEY, sub: &str, access: windows::Win32::System::Registry::REG_SAM_FLAGS) -> Option<RegKey> {
    let sub_w = wide(sub);
    let mut hkey = HKEY::default();
    let rc = unsafe { RegOpenKeyExW(root, PCWSTR(sub_w.as_ptr()), None, access, &mut hkey) };
    if rc == ERROR_SUCCESS && !hkey.is_invalid() {
        Some(RegKey(hkey))
    } else {
        None
    }
}

/// Enumerate `Run`-style string values under an already-open key.
///
/// Returns (value name, value data) pairs for `REG_SZ` / `REG_EXPAND_SZ`
/// values. Bad or non-string values are skipped, not fatal.
fn enum_run_values(key: &RegKey) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut index: u32 = 0;

    loop {
        // Generous fixed buffers: value names cap at 16,383 wide chars; data we
        // bound conservatively (long commands still fit).
        let mut name_buf = vec![0u16; 16_384];
        let mut name_len: u32 = name_buf.len() as u32; // in chars, incl. NUL space
        let mut value_type: u32 = 0;
        let mut data_buf = vec![0u8; 8_192];
        let mut data_len: u32 = data_buf.len() as u32; // in bytes

        let rc = unsafe {
            RegEnumValueW(
                key.0,
                index,
                Some(windows::core::PWSTR(name_buf.as_mut_ptr())),
                &mut name_len,
                None,
                Some(&mut value_type),
                Some(data_buf.as_mut_ptr()),
                Some(&mut data_len),
            )
        };

        if rc != ERROR_SUCCESS {
            // ERROR_NO_MORE_ITEMS (or any error) ends enumeration.
            break;
        }
        index += 1;

        let rtype = REG_VALUE_TYPE(value_type);
        if rtype != REG_SZ && rtype != REG_EXPAND_SZ {
            continue; // only string-valued autoruns
        }

        let name = String::from_utf16_lossy(&name_buf[..name_len as usize]);
        let command = reg_sz_to_string(&data_buf, data_len);
        if name.is_empty() {
            continue;
        }
        out.push((name, command));
    }

    out
}

/// Decode a REG_SZ/REG_EXPAND_SZ byte buffer (`len` bytes) into a String,
/// dropping a trailing NUL.
fn reg_sz_to_string(data: &[u8], len: u32) -> String {
    let bytes = &data[..(len as usize).min(data.len())];
    // Reinterpret as u16; ignore a dangling odd byte if present.
    let u16_len = bytes.len() / 2;
    let mut wide_chars: Vec<u16> = Vec::with_capacity(u16_len);
    for chunk in bytes.chunks_exact(2) {
        wide_chars.push(u16::from_le_bytes([chunk[0], chunk[1]]));
    }
    // Trim trailing NULs.
    while wide_chars.last() == Some(&0) {
        wide_chars.pop();
    }
    String::from_utf16_lossy(&wide_chars)
}

/// Read a single value's raw bytes from an open key (for StartupApproved).
fn read_value_bytes(key: &RegKey, value_name: &str) -> Option<Vec<u8>> {
    let name_w = wide(value_name);
    let mut data_len: u32 = 0;

    // First call: size.
    let rc = unsafe {
        RegQueryValueExW(
            key.0,
            PCWSTR(name_w.as_ptr()),
            None,
            None,
            None,
            Some(&mut data_len),
        )
    };
    if rc != ERROR_SUCCESS || data_len == 0 {
        return None;
    }

    let mut buf = vec![0u8; data_len as usize];
    let rc = unsafe {
        RegQueryValueExW(
            key.0,
            PCWSTR(name_w.as_ptr()),
            None,
            None,
            Some(buf.as_mut_ptr()),
            Some(&mut data_len),
        )
    };
    if rc != ERROR_SUCCESS {
        return None;
    }
    buf.truncate(data_len as usize);
    Some(buf)
}

/// Resolve the StartupApproved subkey path for a given startup location.
fn approved_path(location: &str) -> &'static str {
    if location == LOC_STARTUP_FOLDER {
        APPROVED_FOLDER
    } else {
        APPROVED_RUN
    }
}

/// Resolve the registry root for a given startup location.
fn root_for(location: &str) -> HKEY {
    if location == LOC_HKLM_RUN {
        HKEY_LOCAL_MACHINE
    } else {
        HKEY_CURRENT_USER
    }
}

/// Determine whether an item is enabled from its StartupApproved blob.
/// Absent value or a non-0x03 leading byte means enabled.
fn is_enabled(location: &str, name: &str) -> bool {
    let root = root_for(location);
    let Some(key) = open_key(root, approved_path(location), KEY_READ) else {
        return true; // no approval key → treated as enabled
    };
    match read_value_bytes(&key, name) {
        Some(bytes) => bytes.first().copied() != Some(APPROVED_DISABLED),
        None => true,
    }
}

/// Enumerate the `.lnk`/files in the per-user Startup folder.
fn startup_folder_path() -> Option<PathBuf> {
    let appdata = std::env::var_os("APPDATA")?;
    let mut path = PathBuf::from(appdata);
    path.push(r"Microsoft\Windows\Start Menu\Programs\Startup");
    Some(path)
}

fn list_startup_folder() -> Vec<StartupItem> {
    let Some(dir) = startup_folder_path() else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        // Skip desktop.ini and directories; keep files (.lnk, .exe, scripts…).
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            continue;
        }
        let file_name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if file_name.eq_ignore_ascii_case("desktop.ini") {
            continue;
        }
        let stem = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| file_name.clone());
        // StartupApproved keys this item by its file name (with extension).
        let enabled = is_enabled(LOC_STARTUP_FOLDER, &file_name);
        out.push(StartupItem {
            name: stem,
            command: path.to_string_lossy().to_string(),
            location: LOC_STARTUP_FOLDER.to_string(),
            enabled,
        });
    }
    out
}

/// Enumerate Run-key autoruns for a given root + location label.
fn list_run(root: HKEY, location: &str) -> Vec<StartupItem> {
    let Some(key) = open_key(root, RUN_KEY, KEY_READ) else {
        return Vec::new();
    };
    enum_run_values(&key)
        .into_iter()
        .map(|(name, command)| {
            let enabled = is_enabled(location, &name);
            StartupItem {
                name,
                command,
                location: location.to_string(),
                enabled,
            }
        })
        .collect()
}

/// Gather autorun entries from HKCU\Run, HKLM\Run, and the user Startup folder.
pub fn list_startup() -> CoreResult<Vec<StartupItem>> {
    let mut items = Vec::new();
    items.extend(list_run(HKEY_CURRENT_USER, LOC_HKCU_RUN));
    items.extend(list_run(HKEY_LOCAL_MACHINE, LOC_HKLM_RUN));
    items.extend(list_startup_folder());
    Ok(items)
}

/// Enable or disable a startup entry by writing its StartupApproved blob.
pub fn set_startup_enabled(name: String, location: String, enabled: bool) -> CoreResult<()> {
    if !matches!(
        location.as_str(),
        LOC_HKCU_RUN | LOC_HKLM_RUN | LOC_STARTUP_FOLDER
    ) {
        return Err(CoreError::Msg(format!("unknown location: {location}")));
    }

    let root = root_for(&location);
    let sub = approved_path(&location);

    // Create-or-open the StartupApproved subkey with write access.
    let sub_w = wide(sub);
    let mut hkey = HKEY::default();
    let rc = unsafe {
        RegCreateKeyExW(
            root,
            PCWSTR(sub_w.as_ptr()),
            None,
            PCWSTR::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE,
            None,
            &mut hkey,
            None,
        )
    };
    if rc != ERROR_SUCCESS {
        return Err(win32_err(rc, "RegCreateKeyExW"));
    }
    let key = RegKey(hkey);

    // 12-byte blob: byte[0] = state flag, rest zero.
    let mut blob = [0u8; APPROVED_BLOB_LEN];
    blob[0] = if enabled { APPROVED_ENABLED } else { APPROVED_DISABLED };

    let name_w = wide(&name);
    let rc = unsafe {
        RegSetValueExW(
            key.0,
            PCWSTR(name_w.as_ptr()),
            None,
            windows::Win32::System::Registry::REG_BINARY,
            Some(&blob),
        )
    };
    if rc != ERROR_SUCCESS {
        return Err(win32_err(rc, "RegSetValueExW"));
    }
    Ok(())
}

/// Wrap a non-success `WIN32_ERROR` into a `CoreError` with context.
fn win32_err(rc: WIN32_ERROR, what: &str) -> CoreError {
    CoreError::Msg(format!("{what} failed: error {}", rc.0))
}
