//! Full-session debug logging.
//!
//! [`TeeWriter`] is installed as the tracing subscriber's writer in `lib.rs`, so
//! every formatted log line is mirrored to stderr *and* an in-memory buffer that
//! lives for the whole process. The Settings → Debug button calls
//! [`export_debug_logs`], which writes the complete buffer (plus a short system
//! header) into a fresh `Downloads/CorePilot_Debug_…` folder.

use crate::error::{CoreError, CoreResult};
use once_cell::sync::Lazy;
use std::io::Write;
use std::sync::Mutex;
use tauri::Manager;

/// Hard cap so a long-running session can't grow the in-memory log without bound.
const MAX_LOG_BYTES: usize = 16 * 1024 * 1024;

/// Complete capture of the tracing stream since process start.
static LOG_BUFFER: Lazy<Mutex<Vec<u8>>> = Lazy::new(|| Mutex::new(Vec::with_capacity(256 * 1024)));

/// Tracing writer that tees output to stderr and the in-memory [`LOG_BUFFER`].
pub struct TeeWriter;

impl Write for TeeWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let _ = std::io::stderr().write_all(buf);
        if let Ok(mut b) = LOG_BUFFER.lock() {
            if b.len() + buf.len() <= MAX_LOG_BYTES {
                b.extend_from_slice(buf);
            } else if b.len() < MAX_LOG_BYTES {
                let take = MAX_LOG_BYTES - b.len();
                b.extend_from_slice(&buf[..take]);
                b.extend_from_slice(b"\n[log truncated: 16 MB cap reached]\n");
            }
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        std::io::stderr().flush()
    }
}

/// The full session log as a UTF-8 string (lossy for any stray non-UTF-8 bytes).
fn log_snapshot() -> String {
    LOG_BUFFER
        .lock()
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .unwrap_or_default()
}

fn system_info(folder: &str) -> String {
    format!(
        "CorePilot {ver}\n\
         target: {os} {arch}\n\
         export folder: {folder}\n\
         \n\
         corepilot.log contains the complete application log captured since this\n\
         launch (all CorePilot events at TRACE granularity, plus every warning,\n\
         error and panic). Attach the whole folder when reporting an issue.\n",
        ver = env!("CARGO_PKG_VERSION"),
        os = std::env::consts::OS,
        arch = std::env::consts::ARCH,
    )
}

/// Dump the full session log to a fresh folder under the user's Downloads
/// directory. `folder_name` is supplied by the frontend (already timestamped,
/// e.g. `CorePilot_Debug_2026_06_08_143355`). Returns the created folder path.
#[tauri::command]
pub fn export_debug_logs(app: tauri::AppHandle, folder_name: String) -> CoreResult<String> {
    // The frontend builds the name, but sanitize defensively before joining it to
    // a filesystem path.
    let safe: String = folder_name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect();
    let safe = if safe.is_empty() {
        "CorePilot_Debug".to_string()
    } else {
        safe
    };

    let downloads = app
        .path()
        .download_dir()
        .map_err(|e| CoreError::Msg(format!("无法定位下载文件夹: {e}")))?;
    // Use a fresh folder. The name is timestamped to the second, but guard against
    // a same-second double-click by appending a counter rather than overwriting.
    let mut dir = downloads.join(&safe);
    let mut n = 2;
    while dir.exists() {
        dir = downloads.join(format!("{safe}_{n}"));
        n += 1;
    }
    std::fs::create_dir_all(&dir).map_err(|e| CoreError::Msg(format!("创建文件夹失败: {e}")))?;

    std::fs::write(dir.join("corepilot.log"), log_snapshot().as_bytes())
        .map_err(|e| CoreError::Msg(format!("写入日志失败: {e}")))?;
    // Best-effort system header; never fail the export over it.
    let _ = std::fs::write(dir.join("system_info.txt"), system_info(&safe));

    let path = dir.to_string_lossy().into_owned();
    tracing::info!("exported debug logs to {path}");
    Ok(path)
}
