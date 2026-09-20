//! Full-session debug logging.
//!
//! [`TeeWriter`] is installed as the tracing subscriber's writer in `lib.rs`, so
//! every formatted log line is mirrored to stderr *and* an in-memory buffer that
//! lives for the whole process. The Settings → Debug button calls
//! [`export_debug_logs`], which writes the complete buffer (plus a short system
//! header) into a fresh `Downloads/CorePilot_Debug_…` folder.
//!
//! The in-memory buffer dies with the process, so [`disk_sink`] additionally
//! mirrors just the WARN/ERROR records to a rolling file next to the store —
//! the only log that is still there after a crash, a kill, or a restart.

use crate::error::{CoreError, CoreResult};
use once_cell::sync::Lazy;
use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

/// Hard cap so a long-running session can't grow the in-memory log without bound.
const MAX_LOG_BYTES: usize = 4 * 1024 * 1024;
/// Keep post-crash evidence bounded independently of the user-data store.
const DISK_LOG_MAX_BYTES: u64 = 1024 * 1024;
const DISK_LOG_NAME: &str = "corepilot.warn.log";
const DISK_LOG_OLD_NAME: &str = "corepilot.warn.log.1";

/// Complete capture of the tracing stream since process start.
static LOG_BUFFER: Lazy<Mutex<Vec<u8>>> = Lazy::new(|| Mutex::new(Vec::with_capacity(256 * 1024)));

struct DiskSink {
    path: PathBuf,
    file: BufWriter<File>,
    bytes: u64,
}

struct DiskSinkState {
    sink: Option<DiskSink>,
    attempted: bool,
}

/// Lazy and best-effort: startup must still work when APPDATA is unavailable.
static DISK_SINK: Lazy<Mutex<DiskSinkState>> = Lazy::new(|| {
    Mutex::new(DiskSinkState {
        sink: None,
        attempted: false,
    })
});

fn is_warn_or_error(buf: &[u8]) -> bool {
    // Match level tokens, rather than words in messages, so INFO lines do not
    // fill the crash evidence files merely because their text says "error".
    buf.windows(6).any(|w| w == b" WARN ") || buf.windows(7).any(|w| w == b" ERROR ")
}

fn disk_sink_dir() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(|appdata| {
        PathBuf::from(appdata)
            .join("com.corepilot.app")
            .join("logs")
    })
}

fn rotate_disk_sink(sink: &mut DiskSink) -> std::io::Result<()> {
    sink.file.flush()?;
    let old_path = sink.path.with_file_name(DISK_LOG_OLD_NAME);
    // Windows rename does not replace an existing destination.
    let _ = std::fs::remove_file(&old_path);
    std::fs::rename(&sink.path, &old_path)?;
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&sink.path)?;
    sink.file = BufWriter::new(file);
    sink.bytes = 0;
    Ok(())
}

fn open_disk_sink() -> Option<DiskSink> {
    let dir = disk_sink_dir()?;
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join(DISK_LOG_NAME);
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .ok()?;
    let mut sink = DiskSink {
        bytes: file.metadata().ok()?.len(),
        path,
        file: BufWriter::new(file),
    };
    if sink.bytes >= DISK_LOG_MAX_BYTES {
        rotate_disk_sink(&mut sink).ok()?;
    }
    Some(sink)
}

fn write_disk_log(buf: &[u8]) {
    if !is_warn_or_error(buf) {
        return;
    }
    let Ok(mut state) = DISK_SINK.lock() else {
        return;
    };
    if state.sink.is_none() && !state.attempted {
        state.attempted = true;
        state.sink = open_disk_sink();
    }
    let Some(sink) = state.sink.as_mut() else {
        return;
    };
    if sink.bytes + buf.len() as u64 > DISK_LOG_MAX_BYTES && rotate_disk_sink(sink).is_err() {
        // A logging failure must never panic or block the app.
        return;
    }
    if sink.file.write_all(buf).is_ok() {
        sink.bytes += buf.len() as u64;
        // Flush each record because this sink exists for crash evidence.
        let _ = sink.file.flush();
    }
}

/// Tracing writer that tees output to stderr and the in-memory [`LOG_BUFFER`].
pub struct TeeWriter;

impl Write for TeeWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let _ = std::io::stderr().write_all(buf);
        write_disk_log(buf);
        if let Ok(mut b) = LOG_BUFFER.lock() {
            if b.len() + buf.len() <= MAX_LOG_BYTES {
                b.extend_from_slice(buf);
            } else if b.len() < MAX_LOG_BYTES {
                let take = MAX_LOG_BYTES - b.len();
                b.extend_from_slice(&buf[..take]);
                b.extend_from_slice(b"\n[log truncated: 4 MB cap reached]\n");
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

/// Async wrapper: writes the full session log to disk (unbounded I/O) — run it off
/// the main thread so the export can't stall the IPC router.
#[tauri::command]
pub async fn export_debug_logs(app: tauri::AppHandle, folder_name: String) -> CoreResult<String> {
    tauri::async_runtime::spawn_blocking(move || export_debug_logs_impl(app, folder_name))
        .await
        .map_err(|e| CoreError::Msg(format!("export task failed: {e}")))?
}

/// Dump the full session log to a fresh folder under the user's Downloads
/// directory. `folder_name` is supplied by the frontend (already timestamped,
/// e.g. `CorePilot_Debug_2026_06_08_143355`). Returns the created folder path.
fn export_debug_logs_impl(app: tauri::AppHandle, folder_name: String) -> CoreResult<String> {
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
