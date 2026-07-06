//! Per-executable icon extraction for the Task-Manager process view.
//!
//! Windows Task Manager shows each process's real shell icon. We replicate that
//! by pulling the small (16×16) icon for an executable via `SHGetFileInfoW`,
//! rasterizing it into a 32-bit top-down DIB with `DrawIconEx`, converting the
//! GDI BGRA pixels to RGBA, and PNG-encoding the result as a base64 `data:` URL
//! the frontend can drop straight into an `<img src>`.
//!
//! Icons are stable for the lifetime of a binary, so every distinct exe path is
//! resolved exactly once and cached (the extraction touches the shell + GDI and
//! is comparatively expensive). `None`/empty results are cached too, so a binary
//! without an icon (or one we can't read) is never re-probed.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::ffi::c_void;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use windows::core::PCWSTR;
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC, SelectObject,
    BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
};
use windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES;
use windows::Win32::UI::Shell::{
    SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_SMALLICON, SHGFI_USEFILEATTRIBUTES,
};
use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, DrawIconEx, DI_NORMAL, HICON};

/// Edge length (px) of the extracted icon — matches Task Manager's small icon.
const ICON_SIZE: i32 = 16;

/// Cache of exe-path → optional base64 PNG `data:` URL. `None` means "no icon /
/// unreadable" so we don't keep re-probing. Bounded by the set of distinct
/// executables seen on the machine; icons never change for a given binary.
static ICON_CACHE: Lazy<Mutex<HashMap<String, Option<String>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Return the process icon for `exe_path` as a base64-encoded PNG `data:` URL
/// (e.g. `data:image/png;base64,iVBOR…`), or `None` when the path is empty or no
/// icon could be extracted. Cached per path; the frontend falls back to a
/// generic glyph on `None`.
///
/// Async + blocking-pool: a cache miss does disk IO + GDI icon extraction, and
/// a fresh process list misses for every new exe at once — as a sync command
/// that serialized main-thread stalls (the "未响应" class).
#[tauri::command]
pub async fn process_icon(exe_path: String) -> Option<String> {
    crate::commands::run_blocking_default("process_icon", move || process_icon_blocking(exe_path))
        .await
}

fn process_icon_blocking(exe_path: String) -> Option<String> {
    if exe_path.trim().is_empty() {
        return None;
    }
    if let Some(cached) = ICON_CACHE.lock().get(&exe_path) {
        return cached.clone();
    }
    let result = extract_icon_data_url(Path::new(&exe_path));
    {
        let mut cache = ICON_CACHE.lock();
        // Bounded by distinct exe paths, but cap it so a very long session can't
        // grow the cache without bound; clear (rather than evict) past the cap.
        if cache.len() >= 1024 {
            cache.clear();
        }
        cache.insert(exe_path, result.clone());
    }
    result
}

/// Fetch the small shell icon for `path` and encode it to a PNG data URL.
/// Returns `None` on any failure; never panics (no `unwrap` on FFI).
fn extract_icon_data_url(path: &Path) -> Option<String> {
    let hicon = small_icon(path)?;
    // Always destroy the icon, even if rasterization fails partway.
    let rgba = rasterize_icon(hicon);
    unsafe {
        let _ = DestroyIcon(hicon);
    }
    let rgba = rgba?;
    let png = encode_png(&rgba, ICON_SIZE as u32, ICON_SIZE as u32)?;
    Some(format!("data:image/png;base64,{}", BASE64.encode(png)))
}

/// Resolve the small (16×16) `HICON` for an executable path via the shell.
/// Uses `SHGFI_USEFILEATTRIBUTES` so the lookup works from the path alone
/// without touching the file, and falls back to the generic file icon when the
/// binary has none. The caller owns the returned icon and must `DestroyIcon` it.
fn small_icon(path: &Path) -> Option<HICON> {
    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        let mut info = SHFILEINFOW::default();
        let ret = SHGetFileInfoW(
            PCWSTR(wide.as_ptr()),
            FILE_FLAGS_AND_ATTRIBUTES(0),
            Some(&mut info),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_SMALLICON | SHGFI_USEFILEATTRIBUTES,
        );
        if ret == 0 || info.hIcon.is_invalid() {
            return None;
        }
        Some(info.hIcon)
    }
}

/// Draw `hicon` into a freshly created 32bpp top-down DIB and return its pixels
/// converted from GDI BGRA to RGBA (`ICON_SIZE²` × 4 bytes). `None` on any GDI
/// failure. All GDI objects are released before returning.
fn rasterize_icon(hicon: HICON) -> Option<Vec<u8>> {
    unsafe {
        // Screen DC → memory DC to host the bitmap while we draw.
        let screen = GetDC(None);
        if screen.is_invalid() {
            return None;
        }
        let mem_dc = CreateCompatibleDC(Some(screen));
        // The screen DC is only needed to spawn the compatible DC.
        ReleaseDC(None, screen);
        if mem_dc.is_invalid() {
            return None;
        }

        // 32bpp top-down (negative height) DIB so row 0 is the top and channel
        // order is BGRA — exactly what DrawIconEx writes.
        let mut bmi = BITMAPINFO::default();
        bmi.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: ICON_SIZE,
            biHeight: -ICON_SIZE,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0 as u32,
            ..Default::default()
        };

        let mut bits: *mut c_void = std::ptr::null_mut();
        let dib = match CreateDIBSection(Some(mem_dc), &bmi, DIB_RGB_COLORS, &mut bits, None, 0) {
            Ok(h) if !h.is_invalid() && !bits.is_null() => h,
            _ => {
                let _ = DeleteDC(mem_dc);
                return None;
            }
        };

        let old = SelectObject(mem_dc, HGDIOBJ(dib.0));
        let drawn = DrawIconEx(
            mem_dc, 0, 0, hicon, ICON_SIZE, ICON_SIZE, 0, None, DI_NORMAL,
        )
        .is_ok();

        let rgba = if drawn {
            Some(bgra_bits_to_rgba(bits))
        } else {
            None
        };

        // Restore + free every GDI object regardless of outcome.
        SelectObject(mem_dc, old);
        let _ = DeleteObject(HGDIOBJ(dib.0));
        let _ = DeleteDC(mem_dc);
        rgba
    }
}

/// Copy `ICON_SIZE²` BGRA pixels out of a DIB section and swap to RGBA.
///
/// # Safety
/// `bits` must point to at least `ICON_SIZE² × 4` initialized bytes (the DIB
/// section CreateDIBSection handed back).
unsafe fn bgra_bits_to_rgba(bits: *const c_void) -> Vec<u8> {
    let count = (ICON_SIZE * ICON_SIZE) as usize;
    let src = std::slice::from_raw_parts(bits as *const u8, count * 4);
    let mut out = vec![0u8; count * 4];
    for i in 0..count {
        let s = i * 4;
        out[s] = src[s + 2]; // R ← B
        out[s + 1] = src[s + 1]; // G
        out[s + 2] = src[s]; // B ← R
        out[s + 3] = src[s + 3]; // A
    }
    out
}

/// PNG-encode an RGBA8 buffer. `None` if the `png` encoder errors (shouldn't for
/// a fixed-size in-memory buffer, but handled rather than `unwrap`ed).
fn encode_png(rgba: &[u8], width: u32, height: u32) -> Option<Vec<u8>> {
    let mut buf: Vec<u8> = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut buf, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().ok()?;
        writer.write_image_data(rgba).ok()?;
    }
    Some(buf)
}
