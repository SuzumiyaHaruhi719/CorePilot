//! **Native Win32/GDI taskbar monitor.**
//!
//! A borderless, layered, click-through tool window docked over a free area of
//! the Windows taskbar (TrafficMonitor / LiteMonitor style) showing a compact
//! grid of system metrics: per-metric cells "CPU 26.7%" / "CPU 63.6°C", each a
//! white LABEL + a threshold-colored VALUE, two rows by default (single row when
//! `tbSingleLine`), columns flowing horizontally.
//!
//! **Why native GDI, on its own thread.** A prior attempt drew this surface in a
//! SECOND transparent WebView2 window. That window — like CorePilot's corner OSD
//! window — leaks GDI objects upstream (tauri#11525) AND, crucially, was
//! created / recycled / moved on the Tauri MAIN thread; a transparent WebView2
//! window touched on the main thread is CorePilot's known freeze class (GDI leak
//! + main-thread create-hang). This module replaces it with a pure Win32 layered
//! window that:
//!
//!   * runs on its OWN dedicated `std::thread` with its OWN message loop
//!     (`RegisterClassW` + `CreateWindowExW` + `GetMessageW`/`DispatchMessageW`),
//!   * NEVER calls any Tauri / main-thread API (no `run_on_main_thread`, no
//!     `get_webview_window`) — the main thread never touches this window,
//!   * reads CorePilot's in-process sampler snapshots DIRECTLY each tick
//!     ([`crate::sampler::metrics_snapshot`] / [`crate::sampler::sensors_snapshot`]
//!     / [`crate::gpu::gpu_oc_info_snapshot`]) — no IPC,
//!   * owner-draws via GDI with cached `HFONT`/`HBRUSH` (created once, recreated
//!     only when size/bold/bg change — never per-paint, so no GDI churn / leak),
//!   * color-keys its background ([`SetLayeredWindowAttributes`] `LWA_COLORKEY`)
//!     so it blends into the taskbar.
//!
//! The window is created hidden; each ~1 s timer tick reads [`CONFIG`] and
//! `ShowWindow(SW_SHOWNOACTIVATE)` / `SW_HIDE`s it per `enabled`, so toggling the
//! feature never creates / destroys a window (no create-hang, no GDI churn).
//!
//! **Config** is pushed from the frontend via [`tbmon_config`] (modeled on
//! `perf_recorder::perf_recorder_config`): a flat-args command that overwrites a
//! shared [`CONFIG`] static the render thread reads each tick. Threshold coloring
//! (safe / warn / crit) is computed Rust-side, a port of the frontend
//! `osdThresholds.stateOf`.
//!
//! Docking uses [`SHAppBarMessage`]`(ABM_GETTASKBARPOS)` — robust on Win11 24H2
//! where `TrayNotifyWnd` is NOT a child of `Shell_TrayWnd` (which broke the prior
//! `FindWindowEx` approach). It returns the PRIMARY taskbar's edge + rect, which
//! is exactly where we dock (the spec's "dock on the primary taskbar's monitor").

use std::sync::atomic::{AtomicBool, Ordering};

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use tauri::AppHandle;

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, CreateFontW, CreateSolidBrush, DeleteObject, EndPaint, FillRect,
    GetTextExtentPoint32W, InvalidateRect, SelectObject, SetBkMode, SetTextColor, TextOutW,
    CLEARTYPE_QUALITY, CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET, DEFAULT_PITCH, FF_DONTCARE, FW_BOLD,
    FW_NORMAL, GetDC, HBRUSH, HDC, HFONT, OUT_DEFAULT_PRECIS,
    PAINTSTRUCT, ReleaseDC, TRANSPARENT,
};
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::Shell::{
    SHAppBarMessage, ABM_GETTASKBARPOS, ABE_BOTTOM, ABE_LEFT, ABE_RIGHT, ABE_TOP, APPBARDATA,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, KillTimer,
    LoadCursorW, PostQuitMessage, RegisterClassW, SetLayeredWindowAttributes, SetTimer,
    SetWindowPos, ShowWindow, TranslateMessage, HWND_TOPMOST, IDC_ARROW, MSG,
    SWP_NOACTIVATE, SW_HIDE, SW_SHOWNOACTIVATE, WM_DESTROY, WM_PAINT,
    WM_TIMER, WNDCLASSW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TOPMOST,
    WS_EX_TRANSPARENT, WS_POPUP, LWA_COLORKEY,
};

/// Ensures the native window thread is spawned at most once (mirrors
/// `perf_recorder::RECORDER_STARTED`).
static STARTED: AtomicBool = AtomicBool::new(false);

/// Timer id for the ~1 s repaint / re-dock tick.
const TICK_TIMER: usize = 1;
/// Tick period (ms).
const TICK_MS: u32 = 1000;

/// One drawn metric cell: a white LABEL + a threshold-colored VALUE
/// (e.g. label "CPU", value "26.7%").
struct Cell {
    label: String,
    value: String,
    /// UTF-16 (no trailing NUL) of `label` / `value`, precomputed in `tick` so
    /// `WM_PAINT` reuses them instead of allocating a `Vec<u16>` every paint.
    label_w: Vec<u16>,
    value_w: Vec<u16>,
    color: COLORREF,
}

/// Taskbar-monitor config pushed from the frontend (the tb* OSD store fields).
/// Colors are parsed to `COLORREF` at push time (cheap per-paint reads). Defaults
/// match `store/osd.ts` TASKBAR_DEFAULTS / TBMON_DEFAULTS so the window stays
/// hidden (`enabled = false`) until the frontend pushes a config.
struct TbConfig {
    /// Master switch (`tbEnabled`). Window shows iff this is true.
    enabled: bool,
    /// false = two rows (default), true = one row.
    single_line: bool,
    /// Dock to the left or right end of the bar's free area ("left" / "right").
    bar_right: bool,
    /// Horizontal offset (logical px) nudging the plate along the bar.
    offset: i32,
    /// Custom-layout master switch (size/bold/spacing below only apply when on).
    custom_layout: bool,
    /// Cell font size (pt).
    size: i32,
    /// Bold cell text.
    bold: bool,
    /// Gap between cells / columns (px).
    item_space: i32,
    /// Gap between a cell's label and its value (px).
    inner_space: i32,
    /// Plate padding (px).
    padding: i32,
    /// Threshold value coloring (`tbColorsEnabled`). When false, all values render
    /// in the neutral label color instead of the safe/warn/crit colors.
    colors_enabled: bool,
    /// Background (color-key), label and the three value-state colors.
    bg: COLORREF,
    label: COLORREF,
    safe: COLORREF,
    warn: COLORREF,
    crit: COLORREF,
    /// Load-% / temperature warn+crit thresholds (port of the frontend stateOf).
    warn_load: f64,
    crit_load: f64,
    warn_temp: f64,
    crit_temp: f64,
    /// Enabled metric keys, in pair order (e.g. cpu.util, cpu.temp, …).
    metrics: Vec<String>,
}

impl Default for TbConfig {
    fn default() -> Self {
        // Mirrors store/osd.ts TASKBAR_DEFAULTS + TBMON_DEFAULTS (disabled until
        // pushed). Colors are #RRGGBB → COLORREF (0x00BBGGRR).
        TbConfig {
            enabled: false,
            single_line: false,
            bar_right: false,
            offset: 0,
            custom_layout: true,
            size: 9,
            bold: true,
            item_space: 6,
            inner_space: 8,
            padding: 2,
            colors_enabled: false,
            bg: rgb(0xD2, 0xD2, 0xD2),
            label: rgb(0x14, 0x14, 0x14),
            safe: rgb(0x00, 0x80, 0x40),
            warn: rgb(0xB5, 0x75, 0x00),
            crit: rgb(0xC0, 0x30, 0x30),
            warn_load: 60.0,
            crit_load: 85.0,
            warn_temp: 50.0,
            crit_temp: 70.0,
            metrics: vec![
                "cpu.util".into(),
                "cpu.temp".into(),
                "cpu.freq".into(),
                "mem.used".into(),
                "gpu.util".into(),
                "gpu.temp".into(),
                "net.up".into(),
                "net.down".into(),
            ],
        }
    }
}

/// Pack 8-bit R/G/B into a Win32 `COLORREF` (0x00BBGGRR).
fn rgb(r: u8, g: u8, b: u8) -> COLORREF {
    COLORREF((r as u32) | ((g as u32) << 8) | ((b as u32) << 16))
}

/// Parse a `#RRGGBB` hex string into a `COLORREF`, returning `fallback` on any
/// parse failure (short string, bad hex, …). Tolerates a missing leading `#`.
fn parse_color(s: &str, fallback: COLORREF) -> COLORREF {
    let h = s.trim().trim_start_matches('#');
    // Validate as exactly six ASCII hex digits BEFORE slicing — a 6-BYTE non-ASCII
    // string from the free-text color input would otherwise panic on the byte
    // slices `h[0..2]` etc. (not UTF-8 char boundaries).
    if h.len() != 6 || !h.is_ascii() || !h.bytes().all(|b| b.is_ascii_hexdigit()) {
        return fallback;
    }
    match u32::from_str_radix(h, 16) {
        Ok(v) => rgb(
            ((v >> 16) & 0xFF) as u8,
            ((v >> 8) & 0xFF) as u8,
            (v & 0xFF) as u8,
        ),
        Err(_) => fallback,
    }
}

/// The shared config the render thread reads each tick. Default = disabled, so
/// the window stays hidden until the frontend pushes via [`tbmon_config`].
static CONFIG: Lazy<Mutex<TbConfig>> = Lazy::new(|| Mutex::new(TbConfig::default()));

/// **Push taskbar-monitor config from the frontend.** Modeled exactly on
/// `perf_recorder::perf_recorder_config`: a flat-args command (no `AppHandle`,
/// never fails) that overwrites the shared [`CONFIG`]. The frontend calls it on
/// mount (reading the persisted store) and whenever the tb* config changes. The
/// native render thread reads `CONFIG` each ~1 s tick. Colors arrive as `#RRGGBB`
/// and are parsed to `COLORREF` here (with the default-palette fallback).
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn tbmon_config(
    enabled: bool,
    single_line: bool,
    bar_position: String,
    offset: i32,
    custom_layout: bool,
    size: i32,
    bold: bool,
    item_space: i32,
    inner_space: i32,
    padding: i32,
    colors_enabled: bool,
    bg: String,
    label: String,
    safe: String,
    warn: String,
    crit: String,
    warn_load: f64,
    crit_load: f64,
    warn_temp: f64,
    crit_temp: f64,
    metrics: Vec<String>,
) {
    let d = TbConfig::default();
    let mut cfg = CONFIG.lock();
    cfg.enabled = enabled;
    cfg.single_line = single_line;
    cfg.bar_right = bar_position.eq_ignore_ascii_case("right");
    // Clamp the offset to the same 0..=150 range the UI enforces so a large
    // persisted value can't overflow / wrap the device-pixel docking math below.
    cfg.offset = offset.clamp(0, 150);
    cfg.custom_layout = custom_layout;
    // Clamp the layout numbers to the same sane 0..150 range the UI enforces so a
    // bad value can't produce a giant font / negative spacing.
    cfg.size = size.clamp(4, 72);
    cfg.bold = bold;
    cfg.item_space = item_space.clamp(0, 150);
    cfg.inner_space = inner_space.clamp(0, 150);
    cfg.padding = padding.clamp(0, 150);
    cfg.colors_enabled = colors_enabled;
    cfg.bg = parse_color(&bg, d.bg);
    cfg.label = parse_color(&label, d.label);
    cfg.safe = parse_color(&safe, d.safe);
    cfg.warn = parse_color(&warn, d.warn);
    cfg.crit = parse_color(&crit, d.crit);
    cfg.warn_load = warn_load;
    cfg.crit_load = crit_load;
    cfg.warn_temp = warn_temp;
    cfg.crit_temp = crit_temp;
    cfg.metrics = metrics;
}

/// A snapshot of the small config fields the render thread needs for one tick,
/// cloned out of the lock so GDI work never holds [`CONFIG`].
struct TickCfg {
    enabled: bool,
    single_line: bool,
    bar_right: bool,
    offset: i32,
    size: i32,
    bold: bool,
    item_space: i32,
    inner_space: i32,
    padding: i32,
    colors_enabled: bool,
    bg: COLORREF,
    label: COLORREF,
    safe: COLORREF,
    warn: COLORREF,
    crit: COLORREF,
    warn_load: f64,
    crit_load: f64,
    warn_temp: f64,
    crit_temp: f64,
    metrics: Vec<String>,
}

impl TickCfg {
    /// Clone the live config under the lock, applying the `custom_layout`
    /// gating the frontend uses (when off, size/bold/spacing fall back to the
    /// TBMON defaults — same gating the frontend's `tbCustomLayout` applies).
    fn read() -> TickCfg {
        let cfg = CONFIG.lock();
        let d = TbConfig::default();
        let custom = cfg.custom_layout;
        TickCfg {
            enabled: cfg.enabled,
            single_line: cfg.single_line,
            bar_right: cfg.bar_right,
            offset: cfg.offset,
            size: if custom { cfg.size } else { d.size },
            bold: if custom { cfg.bold } else { d.bold },
            item_space: if custom { cfg.item_space } else { d.item_space },
            inner_space: if custom { cfg.inner_space } else { d.inner_space },
            padding: if custom { cfg.padding } else { d.padding },
            colors_enabled: cfg.colors_enabled,
            bg: cfg.bg,
            label: cfg.label,
            safe: cfg.safe,
            warn: cfg.warn,
            crit: cfg.crit,
            warn_load: cfg.warn_load,
            crit_load: cfg.crit_load,
            warn_temp: cfg.warn_temp,
            crit_temp: cfg.crit_temp,
            metrics: cfg.metrics.clone(),
        }
    }
}

/// 0 = safe, 1 = warn, 2 = crit — a port of the frontend `osdThresholds.stateOf`
/// (crit wins, then warn, else safe; a missing/non-finite reading is safe).
fn state_of(v: Option<f64>, warn: f64, crit: f64) -> u8 {
    match v {
        Some(v) if v.is_finite() => {
            if v >= crit {
                2
            } else if v >= warn {
                1
            } else {
                0
            }
        }
        _ => 0,
    }
}

/// Threshold kind for a metric key — `Some(true)` = temperature, `Some(false)` =
/// load, `None` = always safe (freq / byte-rates). Port of `thresholdKind`.
fn threshold_temp(key: &str) -> Option<bool> {
    if key == "cpu.temp" || key == "gpu.temp" {
        return Some(true);
    }
    if key.ends_with(".util") || key == "gpu.fan" || key == "gpu.vramPct" {
        return Some(false);
    }
    None
}

/// Format a byte rate the way `osd.ts` `rate()` does: `"<n> <unit>/s"` (0 digits
/// under 1 MiB, else 1). Returns `None` for an unavailable value (→ no cell).
fn fmt_rate(v: Option<u64>) -> Option<String> {
    let v = v? as f64;
    Some(format!("{}/s", fmt_bytes(v, if v < 1024.0 * 1024.0 { 0 } else { 1 })))
}

/// Port of `format.ts` `formatBytes`: largest fitting binary unit, `digits`
/// decimals. `<= 0` → "0 B".
fn fmt_bytes(bytes: f64, digits: usize) -> String {
    const UNITS: [&str; 6] = ["B", "KB", "MB", "GB", "TB", "PB"];
    if !bytes.is_finite() || bytes <= 0.0 {
        return "0 B".into();
    }
    let i = ((bytes.ln() / 1024_f64.ln()).floor() as usize).min(UNITS.len() - 1);
    let scaled = bytes / 1024_f64.powi(i as i32);
    format!("{:.*} {}", digits, scaled, UNITS[i])
}

/// The metric readings the cells are built from, pulled once per tick from the
/// in-process sampler / GPU snapshots (same sources as `osd.ts` / the perf
/// recorder). No IPC, no hardware re-sample.
struct Readings {
    cpu_util: Option<f64>,
    cpu_temp: Option<f64>,
    cpu_clock: Option<f64>,
    mem_used: Option<u64>,
    mem_pct: Option<f64>,
    gpu_util: Option<f64>,
    gpu_temp: Option<f64>,
    gpu_power: Option<f64>,
    net_up: Option<u64>,
    net_down: Option<u64>,
}

impl Readings {
    fn read() -> Readings {
        let metrics = crate::sampler::metrics_snapshot();
        let sensors = crate::sampler::sensors_snapshot();
        let gpu = crate::gpu::gpu_oc_info_snapshot();

        let mem_pct = if metrics.mem_total > 0 {
            Some(metrics.mem_used as f64 / metrics.mem_total as f64 * 100.0)
        } else {
            None
        };
        // GPU util/temp/power: prefer NVML, else the PDH/sidecar aggregate (same
        // precedence as osd.ts).
        let gpu_util = if gpu.available {
            Some(gpu.utilization_gpu as f64)
        } else {
            sensors.gpu_pct.map(|v| v as f64)
        };
        let gpu_temp = if gpu.available {
            Some(gpu.temperature as f64)
        } else {
            sensors.gpu_temp.map(|v| v as f64)
        };
        let gpu_power = if gpu.available {
            Some(gpu.power_usage_w)
        } else {
            sensors.gpu_power.map(|v| v as f64)
        };

        Readings {
            cpu_util: Some(metrics.cpu_overall as f64),
            cpu_temp: sensors.cpu_temp.map(|v| v as f64),
            cpu_clock: sensors.cpu_clock,
            mem_used: Some(metrics.mem_used),
            mem_pct,
            gpu_util,
            gpu_temp,
            gpu_power,
            net_up: sensors.net_up,
            net_down: sensors.net_down,
        }
    }

    /// The raw numeric reading a metric's threshold state is computed from
    /// (mirrors `osdThresholds.rawOf`). `None` for keys with no threshold kind.
    fn raw_of(&self, key: &str) -> Option<f64> {
        match key {
            "cpu.util" => self.cpu_util,
            "cpu.temp" => self.cpu_temp,
            "gpu.util" => self.gpu_util,
            "gpu.temp" => self.gpu_temp,
            "mem.util" => self.mem_pct,
            _ => None,
        }
    }

    /// The display LABEL + VALUE for a metric key (mirrors the OSD cell labels +
    /// `osd.ts` formatters). `None` when momentarily unavailable
    /// (the cell is skipped, matching the React "—" / null handling minus the
    /// dash so the bar stays clean).
    fn cell_text(&self, key: &str) -> Option<(&'static str, String)> {
        match key {
            "cpu.util" => self.cpu_util.map(|v| ("CPU", format!("{:.1}%", v))),
            "cpu.temp" => self.cpu_temp.map(|v| ("CPU", format!("{:.1}°C", v))),
            "cpu.freq" => self
                .cpu_clock
                .map(|v| ("CCLK", format!("{:.2}GHz", v / 1000.0))),
            "cpu.power" => None, // not in the default set; sensors carry W if added
            "mem.used" => self
                .mem_used
                .map(|v| ("RAM", fmt_bytes(v as f64, 1))),
            "mem.util" => self.mem_pct.map(|v| ("RAM", format!("{:.0}%", v))),
            "gpu.util" => self.gpu_util.map(|v| ("GPU", format!("{:.1}%", v))),
            "gpu.temp" => self.gpu_temp.map(|v| ("GPU", format!("{:.1}°C", v))),
            "gpu.power" => self.gpu_power.map(|v| ("GPU", format!("{:.0}W", v))),
            "net.up" => fmt_rate(self.net_up).map(|s| ("\u{25B2}", s)),
            "net.down" => fmt_rate(self.net_down).map(|s| ("\u{25BC}", s)),
            _ => None,
        }
    }

    /// Threshold-driven value color for a metric key: non-threshold metrics
    /// always render safe; temp/load use the matching warn/crit thresholds.
    fn color_of(&self, key: &str, cfg: &TickCfg) -> COLORREF {
        // Threshold coloring disabled → render every value in the neutral label
        // color (bg / label stay as configured; only the value color is flattened).
        if !cfg.colors_enabled {
            return cfg.label;
        }
        match threshold_temp(key) {
            None => cfg.safe,
            Some(is_temp) => {
                let raw = self.raw_of(key);
                let st = if is_temp {
                    state_of(raw, cfg.warn_temp, cfg.crit_temp)
                } else {
                    state_of(raw, cfg.warn_load, cfg.crit_load)
                };
                match st {
                    2 => cfg.crit,
                    1 => cfg.warn,
                    _ => cfg.safe,
                }
            }
        }
    }
}

/// Per-thread render state: the window handle, the cached GDI objects, the last
/// config "signature" that drove them (so they're recreated only on change), and
/// the cells + grid geometry computed each tick and consumed by `WM_PAINT`.
struct RenderState {
    hwnd: HWND,
    font: HFONT,
    bg_brush: HBRUSH,
    /// (size, bold, dpi) the cached font was built for — DPI is in the key so a
    /// DPI change rebuilds the font at the new device-pixel height.
    font_key: (i32, bool, u32),
    /// The bg the cached brush + color-key were set for.
    brush_key: COLORREF,
    cells: Vec<Cell>,
    cfg: TickCfg,
    /// Number of columns and rows in the grid (rows = 1 or 2).
    rows: i32,
    cols: i32,
    /// Column width (the widest column) and the per-row height, in device px.
    col_w: i32,
    row_h: i32,
    /// Per-cell measured (label_w, value_w) so paint can place the value after
    /// the label without re-measuring.
    cell_dims: Vec<(i32, i32)>,
}

impl Drop for RenderState {
    /// Release the cached GDI objects when the render state is torn down (on
    /// `WM_DESTROY`). Without this the cached `HFONT`/`HBRUSH` were only ever
    /// deleted on a *rebuild*, so the last live font + brush leaked at shutdown.
    /// Handles are invalidated after delete so a stray rebuild can't double-free.
    fn drop(&mut self) {
        unsafe {
            if !self.font.is_invalid() {
                let _ = DeleteObject(self.font.into());
                self.font = HFONT::default();
            }
            if !self.bg_brush.is_invalid() {
                let _ = DeleteObject(self.bg_brush.into());
                self.bg_brush = HBRUSH::default();
            }
        }
    }
}

// SAFETY: the RenderState lives ONLY on the render thread (created in `start`'s
// closure, passed by raw pointer through the window's wndproc which runs on the
// same thread via `DispatchMessageW`). It is never shared across threads.
thread_local! {
    static RENDER: std::cell::RefCell<Option<RenderState>> = const { std::cell::RefCell::new(None) };
}

/// UTF-16, NUL-terminated, for the Win32 wide-string text APIs.
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Effective DPI for `hwnd` via `GetDpiForWindow` (the per-monitor DPI of the
/// monitor this window is on — re-read each tick so a DPI change rescales the
/// font + offset). Falls back to 96 when the call returns 0.
unsafe fn dpi_of(hwnd: HWND) -> u32 {
    let dpi = GetDpiForWindow(hwnd);
    if dpi == 0 {
        96
    } else {
        dpi
    }
}

/// Measure a string in `hdc` (font already selected). Returns (w, h) device px.
unsafe fn measure(hdc: HDC, s: &str) -> (i32, i32) {
    let w = wide(s);
    // GetTextExtentPoint32W counts code units excluding the trailing NUL.
    let mut size = windows::Win32::Foundation::SIZE::default();
    let _ = GetTextExtentPoint32W(hdc, &w[..w.len() - 1], &mut size);
    (size.cx, size.cy)
}

/// (Re)build the cached `HFONT` for the given size(pt)+bold, scaled for the
/// window's DPI. Deletes the previous font. Point size → device px via the
/// window's DPI (96 dpi = 1pt ≈ 1.333px; `-MulDiv(pt, dpi, 72)`).
unsafe fn rebuild_font(rs: &mut RenderState, size_pt: i32, bold: bool, dpi: u32) {
    if !rs.font.is_invalid() {
        let _ = DeleteObject(rs.font.into());
    }
    let height = -((size_pt * dpi as i32 + 36) / 72); // round-ish MulDiv
    let weight = if bold { FW_BOLD.0 } else { FW_NORMAL.0 } as i32;
    let face = wide("Segoe UI");
    rs.font = CreateFontW(
        height,
        0,
        0,
        0,
        weight,
        0,
        0,
        0,
        DEFAULT_CHARSET,
        OUT_DEFAULT_PRECIS,
        CLIP_DEFAULT_PRECIS,
        CLEARTYPE_QUALITY,
        (DEFAULT_PITCH.0 | FF_DONTCARE.0) as u32,
        PCWSTR(face.as_ptr()),
    );
    rs.font_key = (size_pt, bold, dpi);
}

/// (Re)build the cached background brush + re-set the color-key for `bg`. Deletes
/// the previous brush.
unsafe fn rebuild_brush(rs: &mut RenderState, bg: COLORREF) {
    if !rs.bg_brush.is_invalid() {
        let _ = DeleteObject(rs.bg_brush.into());
    }
    rs.bg_brush = CreateSolidBrush(bg);
    rs.brush_key = bg;
    // Color-key transparency: the bg color becomes fully transparent so the plate
    // blends into the taskbar (only the text shows). Re-set whenever bg changes.
    let _ = SetLayeredWindowAttributes(rs.hwnd, bg, 0, LWA_COLORKEY);
}

/// One ~1 s tick: read config + readings, (re)build cells + grid geometry,
/// refresh the cached GDI objects on a config change, dock the window over the
/// taskbar, show/hide per `enabled`, and invalidate for a repaint. Runs entirely
/// on the render thread. Never touches the Tauri main thread.
unsafe fn tick() {
    RENDER.with(|cell| {
        let mut borrow = cell.borrow_mut();
        let Some(rs) = borrow.as_mut() else { return };

        let cfg = TickCfg::read();

        // Hidden? Park the window and skip all GDI work.
        if !cfg.enabled {
            let _ = ShowWindow(rs.hwnd, SW_HIDE);
            rs.cfg = cfg;
            return;
        }

        let dpi = dpi_of(rs.hwnd);

        // Refresh cached GDI objects only when their inputs changed (never per
        // paint — that was the leak).
        if rs.font.is_invalid() || rs.font_key != (cfg.size, cfg.bold, dpi) {
            rebuild_font(rs, cfg.size, cfg.bold, dpi);
        }
        if rs.bg_brush.is_invalid() || rs.brush_key != cfg.bg {
            rebuild_brush(rs, cfg.bg);
        }

        // Build the cells from the live readings.
        let readings = Readings::read();
        let mut cells: Vec<Cell> = Vec::new();
        for key in &cfg.metrics {
            if let Some((label, value)) = readings.cell_text(key) {
                let label_w = label.encode_utf16().collect();
                let value_w = value.encode_utf16().collect();
                cells.push(Cell {
                    label: label.to_string(),
                    value,
                    label_w,
                    value_w,
                    color: readings.color_of(key, &cfg),
                });
            }
        }

        // Nothing to show — hide rather than dock an empty plate.
        if cells.is_empty() {
            let _ = ShowWindow(rs.hwnd, SW_HIDE);
            rs.cells = cells;
            rs.cfg = cfg;
            return;
        }

        // Measure every cell with the cached font in a window DC.
        let hdc = GetDC(Some(rs.hwnd));
        let old = SelectObject(hdc, rs.font.into());
        let mut cell_dims: Vec<(i32, i32)> = Vec::with_capacity(cells.len());
        let mut max_cell_w = 1;
        let mut max_cell_h = 1;
        let inner = cfg.inner_space.max(0);
        for c in &cells {
            let (lw, lh) = measure(hdc, &c.label);
            let (vw, vh) = measure(hdc, &c.value);
            let w = lw + inner + vw;
            let h = lh.max(vh);
            cell_dims.push((lw, vw));
            max_cell_w = max_cell_w.max(w);
            max_cell_h = max_cell_h.max(h);
        }
        SelectObject(hdc, old);
        let _ = ReleaseDC(Some(rs.hwnd), hdc);

        // Grid: 2 rows by default (columns of 2, filled column-major), 1 row when
        // single_line. Columns flow horizontally.
        let rows: i32 = if cfg.single_line { 1 } else { 2 };
        let n = cells.len() as i32;
        let cols = (n + rows - 1) / rows;
        let col_w = max_cell_w;
        let row_h = max_cell_h;

        let pad = cfg.padding.max(0);
        let item = cfg.item_space.max(0);
        let plate_w = pad * 2 + cols * col_w + (cols - 1).max(0) * item;
        let plate_h = pad * 2 + rows * row_h + (rows - 1).max(0) * inner;

        rs.cells = cells;
        rs.cell_dims = cell_dims;
        rs.rows = rows;
        rs.cols = cols;
        rs.col_w = col_w;
        rs.row_h = row_h;
        rs.cfg = cfg;

        // Dock over the taskbar's free area. `None` = no valid on-bar placement
        // (bar query failed / auto-hidden / sliver) → hide rather than drop the
        // plate onto a desktop corner.
        let Some((x, y)) = dock_xy(plate_w, plate_h, rs.cfg.bar_right, rs.cfg.offset, dpi) else {
            let _ = ShowWindow(rs.hwnd, SW_HIDE);
            return;
        };

        let _ = SetWindowPos(
            rs.hwnd,
            Some(HWND_TOPMOST),
            x,
            y,
            plate_w,
            plate_h,
            SWP_NOACTIVATE,
        );
        let _ = ShowWindow(rs.hwnd, SW_SHOWNOACTIVATE);
        let _ = InvalidateRect(Some(rs.hwnd), None, true);
    });
}

/// Compute the top-left device-pixel position for a `plate_w` × `plate_h` plate
/// docked over the primary taskbar's free area. Uses `SHAppBarMessage`
/// `(ABM_GETTASKBARPOS)` (robust on Win11 24H2). Handles all four edges:
///   * bottom / top bars dock horizontally (left/right end + offset),
///   * left / right side bars dock vertically (top/bottom end + offset),
/// vertically/horizontally centering across the bar's short axis.
///
/// Returns `None` — meaning "hide the plate" — when no valid on-bar placement can
/// be computed (the bar query failed, or it's an auto-hide / zero-size sliver). We
/// HIDE rather than drop the plate onto a desktop corner, which looked broken.
///
/// `offset` is logical px (scaled by `dpi`). `margin` (the device-pixel end gap)
/// is computed with saturating arithmetic so a large persisted offset can't wrap.
unsafe fn dock_xy(
    plate_w: i32,
    plate_h: i32,
    bar_right: bool,
    offset: i32,
    dpi: u32,
) -> Option<(i32, i32)> {
    let mut abd = APPBARDATA {
        cbSize: std::mem::size_of::<APPBARDATA>() as u32,
        ..Default::default()
    };
    if SHAppBarMessage(ABM_GETTASKBARPOS, &mut abd) == 0 {
        return None;
    }
    let bar = abd.rc;
    let bw = (bar.right - bar.left).max(0);
    let bh = (bar.bottom - bar.top).max(0);
    // Auto-hide / zero-size sliver → no real on-bar room. Hide.
    if bw < 8 || bh < 8 {
        return None;
    }
    let edge = abd.uEdge;
    // `offset` is already clamped to 0..=150 at the IPC boundary; scale to device
    // px with saturating arithmetic so it can never wrap the layout math.
    let off_dev = (offset.max(0) as i64 * dpi as i64 / 96) as i32;
    let margin: i32 = 8;
    let end_gap = margin.saturating_add(off_dev);

    if edge == ABE_LEFT || edge == ABE_RIGHT {
        // Vertical (side) taskbar: dock the plate at the top or bottom end of the
        // bar, centered horizontally across its width. `bar_right` → bottom end.
        let x = bar.left + ((bw - plate_w).max(0)) / 2;
        let y = if bar_right {
            bar.bottom.saturating_sub(plate_h).saturating_sub(end_gap)
        } else {
            bar.top.saturating_add(end_gap)
        };
        let y = y.clamp(bar.top, (bar.bottom - plate_h).max(bar.top));
        return Some((x, y));
    }

    if edge == ABE_TOP || edge == ABE_BOTTOM {
        // Horizontal (top/bottom) taskbar: dock at the left or right end, centered
        // vertically across its height.
        let y = bar.top + ((bh - plate_h).max(0)) / 2;
        let x = if bar_right {
            bar.right.saturating_sub(plate_w).saturating_sub(end_gap)
        } else {
            bar.left.saturating_add(end_gap)
        };
        let x = x.clamp(bar.left, (bar.right - plate_w).max(bar.left));
        return Some((x, y));
    }

    // Unknown edge — fall back on the bar's aspect: treat tall-as-wide as side.
    if bh >= bw {
        let x = bar.left + ((bw - plate_w).max(0)) / 2;
        let y = if bar_right {
            bar.bottom.saturating_sub(plate_h).saturating_sub(end_gap)
        } else {
            bar.top.saturating_add(end_gap)
        };
        let y = y.clamp(bar.top, (bar.bottom - plate_h).max(bar.top));
        Some((x, y))
    } else {
        let y = bar.top + ((bh - plate_h).max(0)) / 2;
        let x = if bar_right {
            bar.right.saturating_sub(plate_w).saturating_sub(end_gap)
        } else {
            bar.left.saturating_add(end_gap)
        };
        let x = x.clamp(bar.left, (bar.right - plate_w).max(bar.left));
        Some((x, y))
    }
}

/// Owner-draw the plate: fill the color-keyed background, then per cell draw the
/// label (label color) + value (threshold color), columns flowing horizontally,
/// rows stacked. Cached `HFONT`/`HBRUSH` are reused (never created here).
unsafe fn paint(rs: &RenderState) {
    let mut ps = PAINTSTRUCT::default();
    let hdc = BeginPaint(rs.hwnd, &mut ps);

    let mut rect = RECT::default();
    let _ = windows::Win32::UI::WindowsAndMessaging::GetClientRect(rs.hwnd, &mut rect);
    // The whole client rect is the color-key bg (so it shows through the taskbar).
    FillRect(hdc, &rect, rs.bg_brush);

    let old = SelectObject(hdc, rs.font.into());
    SetBkMode(hdc, TRANSPARENT);

    let pad = rs.cfg.padding.max(0);
    let item = rs.cfg.item_space.max(0);
    let inner = rs.cfg.inner_space.max(0);

    for (i, cell) in rs.cells.iter().enumerate() {
        // Column-major fill: cell i sits at column i/rows, row i%rows.
        let col = (i as i32) / rs.rows;
        let row = (i as i32) % rs.rows;
        let cx = pad + col * (rs.col_w + item);
        let cy = pad + row * (rs.row_h + inner);

        let (label_w, _vw) = rs.cell_dims.get(i).copied().unwrap_or((0, 0));

        // Label (white / configured label color). Reuse the cached UTF-16 buffer
        // built in `tick` — no per-paint allocation.
        SetTextColor(hdc, rs.cfg.label);
        let _ = TextOutW(hdc, cx, cy, &cell.label_w);

        // Value (threshold-colored), placed after the label + inner gap.
        SetTextColor(hdc, cell.color);
        let _ = TextOutW(hdc, cx + label_w + inner, cy, &cell.value_w);
    }

    SelectObject(hdc, old);
    let _ = EndPaint(rs.hwnd, &ps);
}

/// Window procedure. Runs on the render thread (the only thread that pumps this
/// window's messages). Handles the repaint/re-dock timer, owner-draw paint, and
/// teardown. Everything else falls through to `DefWindowProcW`.
unsafe extern "system" fn wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_TIMER => {
            if wparam.0 == TICK_TIMER {
                tick();
            }
            LRESULT(0)
        }
        WM_PAINT => {
            RENDER.with(|cell| {
                if let Some(rs) = cell.borrow().as_ref() {
                    paint(rs);
                }
            });
            LRESULT(0)
        }
        WM_DESTROY => {
            let _ = KillTimer(Some(hwnd), TICK_TIMER);
            // Drop the render state so its `Drop` releases the cached HFONT/HBRUSH
            // (otherwise the last live font + brush leak at shutdown).
            RENDER.with(|cell| {
                cell.borrow_mut().take();
            });
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

/// Spawn the native taskbar-monitor window on its OWN dedicated thread (once).
/// Idempotent — safe to call from `lib.rs` `setup`. The thread registers the
/// window class, creates the layered tool window (hidden), starts the ~1 s timer
/// and runs its own message loop forever. The `app` handle is accepted to mirror
/// the other `start*` signatures but is intentionally UNUSED: this thread must
/// never call back into Tauri / the main thread.
pub fn start(app: AppHandle) {
    let _ = app; // intentionally unused — never touch the main thread from here
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::Builder::new()
        .name("corepilot-taskbar-mon".into())
        .spawn(move || unsafe {
            let hinstance = windows::Win32::System::LibraryLoader::GetModuleHandleW(None)
                .map(|h| windows::Win32::Foundation::HINSTANCE(h.0))
                .unwrap_or_default();
            let class_name = w!("CorePilotTaskbarMon");

            let mut wc = WNDCLASSW {
                lpfnWndProc: Some(wndproc),
                hInstance: hinstance,
                lpszClassName: class_name,
                ..Default::default()
            };
            wc.hCursor = LoadCursorW(None, IDC_ARROW).unwrap_or_default();
            // Ignore ERROR_CLASS_ALREADY_EXISTS — a 0 atom just means it's
            // registered; CreateWindowExW below still works by class name.
            let _atom = RegisterClassW(&wc);

            let hwnd = match CreateWindowExW(
                WS_EX_LAYERED
                    | WS_EX_TOOLWINDOW
                    | WS_EX_NOACTIVATE
                    | WS_EX_TRANSPARENT
                    | WS_EX_TOPMOST,
                class_name,
                w!("CorePilot Taskbar Monitor"),
                WS_POPUP, // NOT WS_VISIBLE — created hidden, shown by the first tick
                0,
                0,
                10,
                10,
                None,
                None,
                Some(hinstance),
                None,
            ) {
                Ok(h) => h,
                Err(e) => {
                    tracing::warn!("taskbar monitor: CreateWindowExW failed: {e}");
                    return;
                }
            };

            RENDER.with(|cell| {
                *cell.borrow_mut() = Some(RenderState {
                    hwnd,
                    font: HFONT::default(),
                    bg_brush: HBRUSH::default(),
                    font_key: (0, false, 0),
                    brush_key: COLORREF(0xFFFF_FFFF),
                    cells: Vec::new(),
                    cfg: TickCfg::read(),
                    rows: 2,
                    cols: 0,
                    col_w: 0,
                    row_h: 0,
                    cell_dims: Vec::new(),
                });
            });

            // ~1 s repaint / re-dock timer.
            SetTimer(Some(hwnd), TICK_TIMER, TICK_MS, None);
            // Paint once immediately so a pre-enabled config shows without a 1 s wait.
            tick();

            // This thread's OWN message loop. GetMessageW blocks until a message
            // (incl. WM_TIMER) arrives, so the thread idles cheaply between ticks.
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        })
        .ok();
}
