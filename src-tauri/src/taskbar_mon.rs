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

use windows::core::{w, BOOL, PCWSTR};
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, CreateFontW, CreateSolidBrush, DeleteObject, EndPaint, FillRect, GetMonitorInfoW,
    GetTextExtentPoint32W, InvalidateRect, MonitorFromWindow, SelectObject, SetBkMode, SetTextColor,
    TextOutW, ANTIALIASED_QUALITY, CLIP_DEFAULT_PRECIS, DEFAULT_CHARSET, DEFAULT_PITCH, FF_DONTCARE,
    FW_BOLD, FW_NORMAL, GetDC, HBRUSH, HDC, HFONT, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    OUT_DEFAULT_PRECIS, PAINTSTRUCT, ReleaseDC, TRANSPARENT,
};
use windows::Win32::Graphics::Direct2D::Common::{
    D2D1_ALPHA_MODE_IGNORE, D2D1_COLOR_F, D2D1_PIXEL_FORMAT,
};
use windows::Win32::Graphics::Direct2D::{
    D2D1CreateFactory, ID2D1DCRenderTarget, ID2D1Factory, ID2D1SolidColorBrush,
    D2D1_DRAW_TEXT_OPTIONS_NONE, D2D1_FACTORY_TYPE_SINGLE_THREADED, D2D1_FEATURE_LEVEL_DEFAULT,
    D2D1_RENDER_TARGET_PROPERTIES, D2D1_RENDER_TARGET_TYPE_DEFAULT, D2D1_RENDER_TARGET_USAGE_NONE,
    D2D1_TEXT_ANTIALIAS_MODE_GRAYSCALE,
};
use windows::Win32::Graphics::DirectWrite::{
    DWriteCreateFactory, IDWriteFactory, IDWriteTextFormat, IDWriteTextLayout, IDWriteTypography,
    DWRITE_FACTORY_TYPE_SHARED, DWRITE_FONT_FEATURE, DWRITE_FONT_FEATURE_TAG_LINING_FIGURES,
    DWRITE_FONT_FEATURE_TAG_TABULAR_FIGURES, DWRITE_FONT_STRETCH_NORMAL, DWRITE_FONT_STYLE_NORMAL,
    DWRITE_FONT_WEIGHT_BOLD, DWRITE_FONT_WEIGHT_NORMAL, DWRITE_TEXT_METRICS, DWRITE_TEXT_RANGE,
};
use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM;
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::Shell::{
    SHAppBarMessage, SHQueryUserNotificationState, ABE_BOTTOM, ABE_LEFT, ABE_RIGHT, ABE_TOP,
    ABM_GETTASKBARPOS, APPBARDATA, QUNS_RUNNING_D3D_FULL_SCREEN,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, EnumChildWindows, FindWindowW,
    GetClassNameW, GetForegroundWindow, GetMessageW, GetWindowLongW, GetWindowRect, KillTimer,
    LoadCursorW, PostQuitMessage, RegisterClassW, SetLayeredWindowAttributes, SetTimer,
    SetWindowPos, ShowWindow, TranslateMessage, GWL_STYLE, HWND_TOPMOST, IDC_ARROW, MSG,
    SWP_NOACTIVATE, SW_HIDE, SW_SHOWNOACTIVATE, WM_DESTROY, WM_PAINT,
    WM_TIMER, WNDCLASSW, WS_CAPTION, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_MAXIMIZE, WS_POPUP, WS_THICKFRAME, LWA_COLORKEY,
};

/// Ensures the native window thread is spawned at most once (mirrors
/// `perf_recorder::RECORDER_STARTED`).
static STARTED: AtomicBool = AtomicBool::new(false);

/// Timer id for the ~1 s repaint / re-dock tick.
const TICK_TIMER: usize = 1;
/// Tick period (ms).
const TICK_MS: u32 = 1000;

/// One measured, colored text segment — UTF-16 (no trailing NUL) + device-px
/// width, precomputed in `tick` so `WM_PAINT` reuses them (no per-paint alloc).
struct Seg {
    w16: Vec<u16>,
    color: COLORREF,
    width: i32,
    /// Numeric field class (drives fixed worst-case field sizing). Labels use
    /// `FieldClass::Other`; it's only consulted for value segments.
    class: FieldClass,
}

/// One category GROUP, OSD-plate style: a single themed category label (e.g.
/// "CPU") followed by that category's value segments (e.g. "26.7%", "63°C",
/// "5.5GHz"). Replaces the old per-metric label repetition.
struct Group {
    label: Seg,
    values: Vec<Seg>,
    /// label.width + Σ(inner_space + value.width) — the group's drawn width.
    width: i32,
}

/// One drawable unit with its ABSOLUTE field geometry, precomputed in `tick`.
///
/// The plate is laid out as a cursor walk (see `tick`): every label and every
/// value gets an absolute left edge `x` and a fixed field width `field_w`. Labels
/// are LEFT-aligned at `x`; values are RIGHT-aligned inside `[x, x+field_w]` so
/// digits/decimal points/units stack on a constant right edge with one uniform
/// gutter. Field widths come from WORST-CASE template strings (e.g. `100.0%`),
/// not the live reading, so the gutter never breathes tick-to-tick. Corresponding
/// fields across the two rows (CPU util ↔ GPU util, temp ↔ temp, clock ↔ power)
/// share one `x`/`field_w`, so they column-lock; trailing groups (NET/RAM/…) all
/// start at a common `block_b_x`, so their left edges line up too. Owns its UTF-16
/// text so `WM_PAINT` never allocates.
struct Cell {
    w16: Vec<u16>,
    color: COLORREF,
    /// Measured device-px width of THIS cell's live text.
    width: i32,
    /// Absolute left edge (device px) of this cell's field box.
    x: i32,
    /// Field-box width (device px). For values, the cell is right-aligned inside
    /// `[x, x+field_w]`; for labels `field_w == width` (left-aligned at `x`).
    field_w: i32,
    /// true = value cell (right-aligned in its field), false = label (left at `x`).
    is_value: bool,
}

/// OSD category index (matches osdPalette.ts order fps,cpu,gpu,mem,disk,net) →
/// the per-theme color array pushed from the frontend.
const CAT_CPU: usize = 1;
const CAT_GPU: usize = 2;

/// The kind of numeric field a value occupies, used to size its fixed field box
/// from a WORST-CASE template string (so the right-align gutter never breathes as
/// the live reading changes). `ClockPower` is shared by CPU clock and GPU power so
/// those two column-lock across rows even though their magnitudes differ.
#[derive(Clone, Copy, PartialEq, Eq)]
enum FieldClass {
    /// Utilization %, e.g. `100.0%`.
    Percent,
    /// Temperature, e.g. `100.0°C`.
    Temp,
    /// CPU clock OR GPU power — the shared Block-A 3rd field, e.g. `9999MHz`/`999W`.
    ClockPower,
    /// Memory amount, e.g. `999.9 GB`.
    Mem,
    /// Net rate (normalized to MB/s), e.g. `999.9 MB/s`.
    NetRate,
    /// Anything else — sized to the live string only (no worst-case template).
    Other,
}

/// Map a metric key to its numeric field class (for worst-case field sizing).
fn field_class(key: &str) -> FieldClass {
    match key {
        "cpu.util" | "gpu.util" | "mem.util" | "gpu.fan" | "gpu.vramPct" | "disk.util" => {
            FieldClass::Percent
        }
        "cpu.temp" | "gpu.temp" => FieldClass::Temp,
        "cpu.freq" | "gpu.power" | "cpu.power" | "gpu.coreClock" | "gpu.memClock" => {
            FieldClass::ClockPower
        }
        "mem.used" | "gpu.vramUsed" => FieldClass::Mem,
        "net.up" | "net.down" | "disk.read" | "disk.write" => FieldClass::NetRate,
        _ => FieldClass::Other,
    }
}

/// Worst-case template string for a field class, measured once per tick to fix
/// that field's box width. `None` for `Other` (sized to the live string). The
/// templates are the widest the formatter can produce (`{:.1}%` ≤ `100.0%`, etc.).
#[allow(dead_code)] // kept for reference; live-width field sizing no longer uses templates
fn field_template(class: FieldClass) -> Option<&'static str> {
    match class {
        FieldClass::Percent => Some("100.0%"),
        FieldClass::Temp => Some("100.0\u{00B0}C"),
        FieldClass::ClockPower => Some("9999MHz"), // wider than "999W"
        FieldClass::Mem => Some("999.9 GB"),
        // The ▲/▼ glyph is drawn inline with the rate, so the template includes it
        // (both arrows measure alike → up/down rates right-align on the same edge).
        FieldClass::NetRate => Some("\u{25B2}999.9 MB/s"),
        FieldClass::Other => None,
    }
}

/// Map a metric key to its (category index, display label). The category label
/// is shown once per group (OSD-plate style); the index selects the theme color.
fn cat_of(key: &str) -> (usize, &'static str) {
    match key.split('.').next().unwrap_or("") {
        "fps" => (0, "FPS"),
        "cpu" => (CAT_CPU, "CPU"),
        "gpu" => (CAT_GPU, "GPU"),
        "mem" => (3, "RAM"),
        "disk" => (4, "DISK"),
        "net" => (5, "NET"),
        _ => (CAT_CPU, "CPU"),
    }
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
    /// Per-category OSD THEME colors (osdPalette.ts order fps,cpu,gpu,mem,disk,net),
    /// pushed from the frontend so category labels inherit the active OSD theme.
    theme: [COLORREF; 6],
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
            bg: rgb(0x0B, 0x0F, 0x16),
            label: rgb(0x14, 0x14, 0x14),
            safe: rgb(0x00, 0x80, 0x40),
            warn: rgb(0xB5, 0x75, 0x00),
            crit: rgb(0xC0, 0x30, 0x30),
            // Neutral light-grey until the frontend pushes the real OSD theme
            // colors (it does so on mount + on every theme change).
            theme: [rgb(0xE6, 0xE6, 0xE6); 6],
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
    theme_fps: String,
    theme_cpu: String,
    theme_gpu: String,
    theme_mem: String,
    theme_disk: String,
    theme_net: String,
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
    cfg.theme = [
        parse_color(&theme_fps, d.theme[0]),
        parse_color(&theme_cpu, d.theme[1]),
        parse_color(&theme_gpu, d.theme[2]),
        parse_color(&theme_mem, d.theme[3]),
        parse_color(&theme_disk, d.theme[4]),
        parse_color(&theme_net, d.theme[5]),
    ];
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
    theme: [COLORREF; 6],
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
            theme: cfg.theme,
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

/// Format a NET byte rate in a SINGLE fixed unit (always `MB/s`, 1 decimal) so
/// up and down share one field width and align on the decimal point — instead of
/// the old per-magnitude unit (`MB/s` for up, `KB/s` for down) that produced
/// different widths → ragged columns. Sub-0.1 MB/s shows as `0.0 MB/s` (the field
/// stays uniform). Returns `None` for an unavailable value (→ no cell).
fn fmt_rate(v: Option<u64>) -> Option<String> {
    let mb = v? as f64 / (1024.0 * 1024.0);
    Some(format!("{:.1} MB/s", mb))
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
    cpu_power: Option<f64>,
    mem_used: Option<u64>,
    mem_pct: Option<f64>,
    gpu_util: Option<f64>,
    gpu_temp: Option<f64>,
    gpu_power: Option<f64>,
    gpu_core_clock: Option<f64>,
    gpu_mem_clock: Option<f64>,
    gpu_fan: Option<f64>,
    gpu_vram_used: Option<u64>,
    gpu_vram_pct: Option<f64>,
    disk_util: Option<f64>,
    disk_read: Option<u64>,
    disk_write: Option<u64>,
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

        // GPU clocks / fan come only from NVML (no PDH/sidecar equivalent); they're
        // available iff the NVML query succeeded. A 0 clock means "unknown" — treat
        // it as unavailable (matches osd.ts `d.gpu?.graphicsClock ? … : null`).
        let gpu_core_clock = if gpu.available && gpu.graphics_clock > 0 {
            Some(gpu.graphics_clock as f64)
        } else {
            None
        };
        let gpu_mem_clock = if gpu.available && gpu.mem_clock > 0 {
            Some(gpu.mem_clock as f64)
        } else {
            None
        };
        let gpu_fan = if gpu.available {
            Some(gpu.fan_speed_pct as f64)
        } else {
            None
        };
        // VRAM: prefer NVML's used/total, else the PDH/sidecar dedicated-VRAM figures
        // (sensors.vram_used / vram_total). pct + used require a positive total.
        let (vram_used_b, vram_total_b) = if gpu.available && gpu.mem_total_bytes > 0 {
            (Some(gpu.mem_used_bytes), Some(gpu.mem_total_bytes))
        } else {
            (sensors.vram_used, sensors.vram_total)
        };
        let gpu_vram_pct = match (vram_used_b, vram_total_b) {
            (Some(u), Some(t)) if t > 0 => Some(u as f64 / t as f64 * 100.0),
            _ => None,
        };
        let gpu_vram_used = match vram_total_b {
            Some(t) if t > 0 => vram_used_b,
            _ => None,
        };

        Readings {
            cpu_util: Some(metrics.cpu_overall as f64),
            cpu_temp: sensors.cpu_temp.map(|v| v as f64),
            cpu_clock: sensors.cpu_clock,
            cpu_power: sensors.cpu_power.map(|v| v as f64),
            mem_used: Some(metrics.mem_used),
            mem_pct,
            gpu_util,
            gpu_temp,
            gpu_power,
            gpu_core_clock,
            gpu_mem_clock,
            gpu_fan,
            gpu_vram_used,
            gpu_vram_pct,
            disk_util: sensors.disk_pct.map(|v| v as f64),
            disk_read: sensors.disk_read,
            disk_write: sensors.disk_write,
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
            "gpu.fan" => self.gpu_fan,
            "gpu.vramPct" => self.gpu_vram_pct,
            "mem.util" => self.mem_pct,
            "disk.util" => self.disk_util,
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
                .map(|v| ("CCLK", format!("{:.0}MHz", v))),
            "cpu.power" => self.cpu_power.map(|v| ("CPU", format!("{:.0}W", v))),
            "mem.used" => self
                .mem_used
                .map(|v| ("RAM", fmt_bytes(v as f64, 1))),
            "mem.util" => self.mem_pct.map(|v| ("RAM", format!("{:.0}%", v))),
            "gpu.util" => self.gpu_util.map(|v| ("GPU", format!("{:.1}%", v))),
            "gpu.temp" => self.gpu_temp.map(|v| ("GPU", format!("{:.1}°C", v))),
            "gpu.power" => self.gpu_power.map(|v| ("GPU", format!("{:.0}W", v))),
            "gpu.coreClock" => self.gpu_core_clock.map(|v| ("GPU", format!("{:.0}MHz", v))),
            "gpu.memClock" => self.gpu_mem_clock.map(|v| ("GPU", format!("{:.0}MHz", v))),
            "gpu.fan" => self.gpu_fan.map(|v| ("GPU", format!("{:.0}%", v))),
            "gpu.vramPct" => self.gpu_vram_pct.map(|v| ("GPU", format!("{:.0}%", v))),
            "gpu.vramUsed" => self
                .gpu_vram_used
                .map(|v| ("GPU", fmt_bytes(v as f64, 1))),
            "disk.util" => self.disk_util.map(|v| ("DISK", format!("{:.0}%", v))),
            // Disk read/write: a small "R"/"W" mini-label drawn inline with the rate
            // (same inline-glyph pattern as net.up/down's ▲/▼ — see `tick`).
            "disk.read" => fmt_rate(self.disk_read).map(|s| ("R", s)),
            "disk.write" => fmt_rate(self.disk_write).map(|s| ("W", s)),
            "net.up" => fmt_rate(self.net_up).map(|s| ("\u{25B2}", s)),
            "net.down" => fmt_rate(self.net_down).map(|s| ("\u{25BC}", s)),
            // FPS / frame pacing is game-injected only (ETW present events); there is
            // no desktop source, so these stay valid offerable keys that render
            // nothing on the taskbar — exactly like the OSD off-game.
            "fps" | "fps.low1" | "fps.low01" | "fps.frametime" => None,
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
    cfg: TickCfg,
    /// The laid-out plate consumed by `WM_PAINT` (1 or 2 rows). Each row is a flat
    /// sequence of `Cell`s (label + values) carrying ABSOLUTE field geometry
    /// (`x`/`field_w`) computed by the cursor walk in `tick`. Corresponding fields
    /// across rows share `x`/`field_w` (column-lock); trailing groups share a
    /// common `block_b_x`. CPU anchors row 0, GPU anchors row 1.
    cells_layout: Vec<Vec<Cell>>,
    /// Per-row height in device px (the tallest measured segment).
    row_h: i32,
    /// Last GOOD dock geometry `(x, y, plate_w, plate_h)`. On a TRANSIENT dock
    /// query failure we re-show at this instead of hiding, so a single bad tick
    /// (Explorer restart / momentary appbar churn) never blinks the plate off.
    last_good: Option<(i32, i32, i32, i32)>,

    // === Direct2D / DirectWrite text engine (browser-grade glyphs). ===
    /// When true, measure + paint go through D2D/DWrite; when false (any D2D
    /// creation failed), the GDI `HFONT`/`HBRUSH` path above is the fallback.
    use_d2d: bool,
    /// D2D factory (single-threaded — this thread only). `None` until created.
    d2d_factory: Option<ID2D1Factory>,
    /// DirectWrite factory (shared). `None` until created.
    dwrite_factory: Option<IDWriteFactory>,
    /// DC render target bound to the window DC each paint. `None` until created.
    dc_target: Option<ID2D1DCRenderTarget>,
    /// Cached text format for the current (size,bold,dpi). Rebuilt on change.
    text_format: Option<IDWriteTextFormat>,
    /// (size, bold, dpi) the cached text format was built for.
    fmt_key: (i32, bool, u32),
    /// Cached solid brush whose color is re-set per drawn segment.
    d2d_brush: Option<ID2D1SolidColorBrush>,
    /// Cached typography object (tabular + lining figures) applied to every drawn
    /// and measured segment so digits are column-stable. Built once in `init_d2d`.
    d2d_typography: Option<IDWriteTypography>,
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
        // Grayscale AA, NOT ClearType: ClearType's subpixel color fringe looks
        // ugly on a color-keyed layered window (the RGB-tinted edges don't blend
        // with the key). Grayscale edges blend cleanly into the dark key/taskbar.
        ANTIALIASED_QUALITY,
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

/// Convert a Win32 `COLORREF` (0x00BBGGRR) into a D2D `D2D1_COLOR_F` (opaque).
fn colorref_to_d2d(c: COLORREF) -> D2D1_COLOR_F {
    let v = c.0;
    D2D1_COLOR_F {
        r: (v & 0xFF) as f32 / 255.0,
        g: ((v >> 8) & 0xFF) as f32 / 255.0,
        b: ((v >> 16) & 0xFF) as f32 / 255.0,
        a: 1.0,
    }
}

/// Create the D2D factory, DWrite factory, DC render target and solid brush ONCE.
/// Any failure leaves `use_d2d = false` (the GDI fallback then runs) and NEVER
/// panics — every COM Result is matched. Idempotent: returns early if already set.
unsafe fn init_d2d(rs: &mut RenderState) {
    if rs.d2d_factory.is_some() && rs.dwrite_factory.is_some() && rs.dc_target.is_some() {
        return;
    }
    let factory: ID2D1Factory =
        match D2D1CreateFactory(D2D1_FACTORY_TYPE_SINGLE_THREADED, None) {
            Ok(f) => f,
            Err(e) => {
                tracing::warn!("taskbar monitor: D2D1CreateFactory failed: {e}");
                rs.use_d2d = false;
                return;
            }
        };
    let dwrite: IDWriteFactory = match DWriteCreateFactory(DWRITE_FACTORY_TYPE_SHARED) {
        Ok(f) => f,
        Err(e) => {
            tracing::warn!("taskbar monitor: DWriteCreateFactory failed: {e}");
            rs.use_d2d = false;
            return;
        }
    };
    // DC render target: B8G8R8A8 / ALPHA_IGNORE, 96 dpi (1 DIP = 1 px) so all the
    // device-px layout math is unchanged.
    let props = D2D1_RENDER_TARGET_PROPERTIES {
        r#type: D2D1_RENDER_TARGET_TYPE_DEFAULT,
        pixelFormat: D2D1_PIXEL_FORMAT {
            format: DXGI_FORMAT_B8G8R8A8_UNORM,
            alphaMode: D2D1_ALPHA_MODE_IGNORE,
        },
        dpiX: 96.0,
        dpiY: 96.0,
        usage: D2D1_RENDER_TARGET_USAGE_NONE,
        minLevel: D2D1_FEATURE_LEVEL_DEFAULT,
    };
    let target = match factory.CreateDCRenderTarget(&props) {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!("taskbar monitor: CreateDCRenderTarget failed: {e}");
            rs.use_d2d = false;
            return;
        }
    };
    // White brush; color is re-set per segment in paint.
    let brush = match target.CreateSolidColorBrush(
        &D2D1_COLOR_F { r: 1.0, g: 1.0, b: 1.0, a: 1.0 },
        None,
    ) {
        Ok(b) => b,
        Err(e) => {
            tracing::warn!("taskbar monitor: CreateSolidColorBrush failed: {e}");
            rs.use_d2d = false;
            return;
        }
    };
    target.SetTextAntialiasMode(D2D1_TEXT_ANTIALIAS_MODE_GRAYSCALE);

    // Typography: tabular figures (uniform digit advance) + lining figures (no
    // old-style descenders), applied to every measured + drawn segment so numbers
    // are column-stable tick-to-tick. Any failure → GDI fallback (no typography,
    // but Segoe UI's GDI digits are already near-uniform and the fixed-field
    // layout below keeps it tidy).
    let typo: IDWriteTypography = match dwrite.CreateTypography() {
        Ok(t) => t,
        Err(e) => {
            tracing::warn!("taskbar monitor: CreateTypography failed: {e}");
            rs.use_d2d = false;
            return;
        }
    };
    if typo
        .AddFontFeature(DWRITE_FONT_FEATURE {
            nameTag: DWRITE_FONT_FEATURE_TAG_TABULAR_FIGURES,
            parameter: 1,
        })
        .is_err()
        || typo
            .AddFontFeature(DWRITE_FONT_FEATURE {
                nameTag: DWRITE_FONT_FEATURE_TAG_LINING_FIGURES,
                parameter: 1,
            })
            .is_err()
    {
        tracing::warn!("taskbar monitor: AddFontFeature failed");
        rs.use_d2d = false;
        return;
    }

    rs.d2d_factory = Some(factory);
    rs.dwrite_factory = Some(dwrite);
    rs.dc_target = Some(target);
    rs.d2d_brush = Some(brush);
    rs.d2d_typography = Some(typo);
    rs.use_d2d = true;
}

/// Build a short-lived `IDWriteTextLayout` for `s` with the cached typography
/// (tabular + lining figures) applied over the whole string, so measured width ==
/// drawn width and digits are column-stable. `None` on any failure (the caller
/// falls back to the GDI `measure()` / `TextOutW` path). Shared by `measure_d2d`
/// and `paint_d2d`.
unsafe fn layout_seg(rs: &RenderState, text: &[u16]) -> Option<IDWriteTextLayout> {
    let dwrite = rs.dwrite_factory.as_ref()?;
    let fmt = rs.text_format.as_ref()?;
    let layout = dwrite
        .CreateTextLayout(text, fmt, f32::MAX, f32::MAX)
        .ok()?;
    if let Some(typo) = rs.d2d_typography.as_ref() {
        let range = DWRITE_TEXT_RANGE {
            startPosition: 0,
            length: text.len() as u32,
        };
        let _ = layout.SetTypography(typo, range);
    }
    Some(layout)
}

/// (Re)build the cached `IDWriteTextFormat` for size(pt)+bold at the window DPI.
/// Size in DIPs = pt * dpi / 72 (the render target runs at 96 dpi so 1 DIP = 1
/// device px, matching the GDI sizing). Returns false on any failure (no format).
unsafe fn rebuild_text_format(rs: &mut RenderState, size_pt: i32, bold: bool, dpi: u32) -> bool {
    let Some(dwrite) = rs.dwrite_factory.as_ref() else {
        return false;
    };
    let weight = if bold {
        DWRITE_FONT_WEIGHT_BOLD
    } else {
        DWRITE_FONT_WEIGHT_NORMAL
    };
    let size_dip = size_pt as f32 * dpi as f32 / 72.0;
    let family = wide("Segoe UI");
    let locale = wide("");
    match dwrite.CreateTextFormat(
        PCWSTR(family.as_ptr()),
        None,
        weight,
        DWRITE_FONT_STYLE_NORMAL,
        DWRITE_FONT_STRETCH_NORMAL,
        size_dip,
        PCWSTR(locale.as_ptr()),
    ) {
        Ok(fmt) => {
            rs.text_format = Some(fmt);
            rs.fmt_key = (size_pt, bold, dpi);
            true
        }
        Err(e) => {
            tracing::warn!("taskbar monitor: CreateTextFormat failed: {e}");
            rs.text_format = None;
            false
        }
    }
}

/// Measure `s` with the cached DirectWrite text format via an `IDWriteTextLayout`,
/// returning (w, h) in device px (ceil) — the D2D replacement for `measure()`.
/// `None` on any failure (the caller then uses the GDI `measure()` fallback).
unsafe fn measure_d2d(rs: &RenderState, s: &str) -> Option<(i32, i32)> {
    let text: Vec<u16> = s.encode_utf16().collect();
    let layout = layout_seg(rs, &text)?;
    let mut m = DWRITE_TEXT_METRICS::default();
    layout.GetMetrics(&mut m).ok()?;
    Some((m.width.ceil() as i32, m.height.ceil() as i32))
}

/// True ONLY when a GENUINE exclusive / borderless fullscreen GAME is in the
/// foreground — we HIDE the taskbar plate then so this `WS_EX_TOPMOST` surface
/// never draws over a game. Cheap; called each ~1 s tick on the render thread.
///
/// Deliberately MINIMAL (ported from LiteMonitor's philosophy: LiteMonitor is a
/// child of `Shell_TrayWnd` and lets Windows hide the bar — it does NO app-side
/// fullscreen detection at all). CorePilot's plate is a free top-level window so
/// it needs a rule, but the rule must not fire for transient shell states or a
/// merely-maximized normal window:
///   * the ONLY trusted shell positive is `QUNS_RUNNING_D3D_FULL_SCREEN` (true
///     exclusive / fullscreen-optimization game). `QUNS_PRESENTATION_MODE`
///     ("don't disturb": media players, projector mode, some video calls) is
///     NOT a game and is no longer treated as fullscreen.
///   * the monitor-cover test is gated behind a BORDERLESS-style check: a real
///     borderless game is `WS_POPUP` with no caption/thick-frame and is NOT
///     maximized; a maximized Explorer/browser (which keeps a caption/frame and
///     still shows the taskbar) therefore never counts.
unsafe fn foreground_is_fullscreen() -> bool {
    // Exclusive / D3D fullscreen — the only trusted shell positive.
    if let Ok(state) = SHQueryUserNotificationState() {
        if state == QUNS_RUNNING_D3D_FULL_SCREEN {
            return true;
        }
    }
    // Borderless fullscreen: a visible, borderless, monitor-covering foreground
    // window. Anything that fails one of these gates keeps the plate visible.
    let fg = GetForegroundWindow();
    if fg.0.is_null() {
        return false;
    }
    let mut cls = [0u16; 64];
    let n = GetClassNameW(fg, &mut cls);
    let c = String::from_utf16_lossy(&cls[..n.max(0) as usize]);
    // The desktop / shell / our own plate are never games.
    if c == "Progman"
        || c == "WorkerW"
        || c == "Shell_TrayWnd"
        || c == "Shell_SecondaryTrayWnd"
        || c == "CorePilotTaskbarMon"
    {
        return false;
    }
    // Style gate: reject maximized windows and any window that still has a
    // caption or a sizing (thick) frame — i.e. all normal/maximized apps. A
    // borderless fullscreen game has none of these.
    let style = GetWindowLongW(fg, GWL_STYLE) as u32;
    if (style & WS_MAXIMIZE.0) != 0
        || (style & WS_CAPTION.0) != 0
        || (style & WS_THICKFRAME.0) != 0
    {
        return false;
    }
    let mut wr = RECT::default();
    if GetWindowRect(fg, &mut wr).is_err() {
        return false;
    }
    let mon = MonitorFromWindow(fg, MONITOR_DEFAULTTONEAREST);
    let mut mi = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if !GetMonitorInfoW(mon, &mut mi).as_bool() {
        return false;
    }
    let m = mi.rcMonitor;
    // Covers the entire monitor on all four edges → genuine borderless game.
    wr.left <= m.left && wr.top <= m.top && wr.right >= m.right && wr.bottom >= m.bottom
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

        // A fullscreen game is in the foreground → hide so we never draw over it.
        if foreground_is_fullscreen() {
            let _ = ShowWindow(rs.hwnd, SW_HIDE);
            rs.cfg = cfg;
            return;
        }

        let dpi = dpi_of(rs.hwnd);

        // Refresh cached GDI objects only when their inputs changed (never per
        // paint — that was the leak). These stay live as the D2D fallback.
        if rs.font.is_invalid() || rs.font_key != (cfg.size, cfg.bold, dpi) {
            rebuild_font(rs, cfg.size, cfg.bold, dpi);
        }
        if rs.bg_brush.is_invalid() || rs.brush_key != cfg.bg {
            rebuild_brush(rs, cfg.bg);
        }

        // Bring up the D2D/DWrite text engine once (idempotent). On any failure
        // `use_d2d` stays false and the GDI path above renders instead.
        init_d2d(rs);
        // Refresh the cached DirectWrite text format on a (size,bold,dpi) change.
        // If it fails, drop back to GDI for this tick (don't ship a blank plate).
        if rs.use_d2d
            && (rs.text_format.is_none() || rs.fmt_key != (cfg.size, cfg.bold, dpi))
            && !rebuild_text_format(rs, cfg.size, cfg.bold, dpi)
        {
            rs.use_d2d = false;
        }
        let use_d2d = rs.use_d2d;

        // Build category GROUPS from the live readings (OSD-plate style: one
        // themed category label, then that category's values), measured with the
        // cached font in a window DC. Category labels inherit the active OSD theme
        // color; values are white (or threshold-colored when `colors_enabled`).
        let readings = Readings::read();
        let white = rgb(0xF2, 0xF2, 0xF2);
        let inner = cfg.inner_space.max(0);
        let item = cfg.item_space.max(0);
        let pad = cfg.padding.max(0);

        let hdc = GetDC(Some(rs.hwnd));
        let old = SelectObject(hdc, rs.font.into());
        let mut row_h = 1;
        // Groups in first-seen category order; values appended within a category.
        let mut groups: Vec<(usize, Group)> = Vec::new();
        for key in &cfg.metrics {
            let Some((mini_label, value)) = readings.cell_text(key) else {
                continue;
            };
            let (cat, cat_label) = cat_of(key);
            // net keeps its ▲/▼ glyph inline with the rate (e.g. "▲12KB/s"); disk
            // read/write likewise prefix their "R"/"W" mini-label inline with the
            // rate so they share the NetRate fixed field and right-align together.
            let disp = if key.starts_with("net.") || key == "disk.read" || key == "disk.write" {
                format!("{mini_label}{value}")
            } else {
                value
            };
            let vcolor = if cfg.colors_enabled {
                readings.color_of(key, &cfg)
            } else {
                white
            };
            // Measure via DirectWrite when the D2D engine is up, else GDI.
            let (vw, vh) = if use_d2d {
                measure_d2d(rs, &disp).unwrap_or_else(|| measure(hdc, &disp))
            } else {
                measure(hdc, &disp)
            };
            row_h = row_h.max(vh);
            let vseg = Seg {
                w16: disp.encode_utf16().collect(),
                color: vcolor,
                width: vw,
                class: field_class(key),
            };
            if let Some((_, g)) = groups.iter_mut().find(|(c, _)| *c == cat) {
                g.values.push(vseg);
            } else {
                let (lw, lh) = if use_d2d {
                    measure_d2d(rs, cat_label).unwrap_or_else(|| measure(hdc, cat_label))
                } else {
                    measure(hdc, cat_label)
                };
                row_h = row_h.max(lh);
                let label = Seg {
                    w16: cat_label.encode_utf16().collect(),
                    color: cfg.theme[cat],
                    width: lw,
                    class: FieldClass::Other,
                };
                groups.push((cat, Group { label, values: vec![vseg], width: 0 }));
            }
        }

        // Field width = the LIVE measured width. With tabular figures the digit
        // advances are uniform, so corresponding CPU/GPU values measure to the
        // SAME width and their columns still lock WITHOUT any worst-case padding —
        // and that padding was exactly what produced the uneven leading gaps (a
        // short `41.3%` right-aligned inside a `100.0%`-wide box left a big gutter
        // before it). Sizing each field to its live content keeps every gap one of
        // the two constants (`inner` / `item`) → visually uniform spacing. The
        // plate may grow by one digit when a reading crosses 9→10→100, which is
        // fine (it re-docks each tick; tray overlap is acceptable).
        let class_w = |_class: FieldClass, live: i32| -> i32 { live };
        SelectObject(hdc, old);
        let _ = ReleaseDC(Some(rs.hwnd), hdc);

        // Nothing to show — hide rather than dock an empty plate.
        if groups.is_empty() {
            let _ = ShowWindow(rs.hwnd, SW_HIDE);
            rs.cells_layout = Vec::new();
            rs.cfg = cfg;
            return;
        }

        // Finalize each group's drawn width (label + inner-spaced FIXED fields), so
        // the row-balancing distribution below weighs the real on-screen footprint
        // (worst-case field widths, not the momentary live string widths).
        for (_, g) in groups.iter_mut() {
            g.width = g.label.width
                + g
                    .values
                    .iter()
                    .map(|v| inner + class_w(v.class, v.width))
                    .sum::<i32>();
        }

        // Distribute groups across rows. CPU anchors row 0, GPU anchors row 1, and
        // every other category is appended to whichever row is currently narrower,
        // so the two rows stay roughly equal length. `single_line` → one row.
        let rows_layout: Vec<Vec<Group>> = if cfg.single_line {
            vec![groups.into_iter().map(|(_, g)| g).collect()]
        } else {
            let (mut r0, mut r1): (Vec<Group>, Vec<Group>) = (Vec::new(), Vec::new());
            let (mut w0, mut w1) = (0i32, 0i32);
            let mut rest: Vec<Group> = Vec::new();
            for (cat, g) in groups {
                if cat == CAT_CPU && r0.is_empty() {
                    w0 += g.width;
                    r0.push(g);
                } else if cat == CAT_GPU && r1.is_empty() {
                    w1 += g.width;
                    r1.push(g);
                } else {
                    rest.push(g);
                }
            }
            for g in rest {
                if w0 <= w1 {
                    w0 += g.width + item;
                    r0.push(g);
                } else {
                    w1 += g.width + item;
                    r1.push(g);
                }
            }
            match (r0.is_empty(), r1.is_empty()) {
                (false, false) => vec![r0, r1],
                (true, false) => vec![r1],
                _ => vec![r0],
            }
        };

        // === Two-block field layout (the aesthetic fix). ===
        //
        // Each group renders as `[LABEL] [field_0] [field_1] …` where every field
        // is a fixed-width right-aligned box (worst-case template width). Two
        // sub-blocks per plate resolve the "column-lock vs uniform-gutter" tension:
        //
        //   * Block A — the aligned CORE (CPU row 0, GPU row 1). These two groups
        //     correspond field-by-field (util↔util, temp↔temp, clock↔power), so
        //     they share one label width `lw_a` and one set of field widths
        //     `fw_a[i]` (max across both rows) → their columns lock vertically.
        //   * Block B — TRAILING groups (NET/RAM/DISK/…). They do NOT correspond
        //     across rows, so they flow independently; but every Block-B group on
        //     every row STARTS at one shared x-origin `block_b_x`, so their left
        //     edges line up. Within a group, fields stay fixed-width.
        //
        // Exactly two spacings are used everywhere: `inner` (label→field and
        // field→field inside a group) and `item` (between groups / Block A→B), so
        // every gap on the plate is one of two constants → uniform spacing.
        //
        // `single_line` has no cross-row column to lock: groups simply flow left to
        // right with `item` gutters, fields still fixed-width per group.
        let nrows = rows_layout.len() as i32;

        // Is a group the Block-A anchor? (Only when not single-line; CPU/GPU each
        // anchor one row and are known to be the first group on their row.)
        let is_block_a = |g: &Group| -> bool {
            !cfg.single_line
                && g.label
                    .w16
                    .first()
                    .map(|&c| c == b'C' as u16 || c == b'G' as u16)
                    .unwrap_or(false)
                && (g.label.w16 == "CPU".encode_utf16().collect::<Vec<u16>>()
                    || g.label.w16 == "GPU".encode_utf16().collect::<Vec<u16>>())
        };

        // Block-A shared geometry: label width = max(CPU,GPU); field i width =
        // max template/live across both anchors at position i.
        let mut lw_a = 0i32;
        let mut fw_a: Vec<i32> = Vec::new();
        for groups in &rows_layout {
            if let Some(g) = groups.first() {
                if is_block_a(g) {
                    lw_a = lw_a.max(g.label.width);
                    for (i, v) in g.values.iter().enumerate() {
                        let w = class_w(v.class, v.width);
                        if i < fw_a.len() {
                            fw_a[i] = fw_a[i].max(w);
                        } else {
                            fw_a.push(w);
                        }
                    }
                }
            }
        }
        // Block-B origin: just past Block A (label + its fixed fields) + one gutter.
        // Rows with no Block-A anchor start Block B at `pad` (single-line, or a row
        // whose first group isn't CPU/GPU).
        let block_a_w = lw_a + fw_a.iter().map(|w| inner + w).sum::<i32>();
        let block_b_x = if lw_a > 0 { pad + block_a_w + item } else { pad };

        // Cursor walk → absolute `x`/`field_w` per cell. Returns the row's end x.
        let mut cells_layout: Vec<Vec<Cell>> = Vec::with_capacity(rows_layout.len());
        let mut max_end = pad;
        for groups in &rows_layout {
            let mut row_cells: Vec<Cell> = Vec::new();
            let mut x = pad;
            let mut entered_block_b = false;
            for (gi, g) in groups.iter().enumerate() {
                let a = is_block_a(g);
                if gi == 0 {
                    // First group: Block-A anchors start at `pad`; a non-anchor
                    // first group is Block B → start at the shared `block_b_x`.
                    if !a {
                        x = block_b_x;
                        entered_block_b = true;
                    }
                } else {
                    // Entering Block B for the first time on this row → jump to the
                    // shared origin so trailing groups line up across rows; else a
                    // normal `item` gutter between groups.
                    if !a && !entered_block_b {
                        x = block_b_x;
                        entered_block_b = true;
                    } else {
                        x += item;
                    }
                }
                // Label (left-aligned). Block A uses the shared `lw_a`.
                let lw = if a { lw_a } else { g.label.width };
                row_cells.push(Cell {
                    w16: g.label.w16.clone(),
                    color: g.label.color,
                    width: g.label.width,
                    x,
                    field_w: lw,
                    is_value: false,
                });
                x += lw;
                // Fields (right-aligned in fixed boxes). Block A uses shared fw_a[i].
                for (i, v) in g.values.iter().enumerate() {
                    x += inner;
                    let fw = if a && i < fw_a.len() {
                        fw_a[i]
                    } else {
                        class_w(v.class, v.width)
                    };
                    row_cells.push(Cell {
                        w16: v.w16.clone(),
                        color: v.color,
                        width: v.width,
                        x,
                        field_w: fw,
                        is_value: true,
                    });
                    x += fw;
                }
            }
            max_end = max_end.max(x);
            cells_layout.push(row_cells);
        }

        let plate_w = max_end + pad;
        let plate_h = pad * 2 + nrows * row_h + (nrows - 1).max(0) * inner;

        rs.cells_layout = cells_layout;
        rs.row_h = row_h;
        rs.cfg = cfg;

        // Dock over the taskbar's free area. On a SUCCESSFUL query, record the
        // geometry as last-good and show. On a TRANSIENT failure (`None`: bar
        // query failed / auto-hidden / sliver) DO NOT hide on a single bad tick —
        // re-show at the last good geometry instead, so a momentary appbar/tray
        // glitch never blinks the plate off the normal desktop. Only hide when we
        // have never had a good position (nothing to show yet).
        let (x, y, w, h) = match dock_xy(plate_w, plate_h, rs.cfg.bar_right, rs.cfg.offset, dpi) {
            Some((x, y)) => {
                rs.last_good = Some((x, y, plate_w, plate_h));
                (x, y, plate_w, plate_h)
            }
            None => match rs.last_good {
                Some(g) => g,
                None => {
                    let _ = ShowWindow(rs.hwnd, SW_HIDE);
                    return;
                }
            },
        };

        let _ = SetWindowPos(rs.hwnd, Some(HWND_TOPMOST), x, y, w, h, SWP_NOACTIVATE);
        let _ = ShowWindow(rs.hwnd, SW_SHOWNOACTIVATE);
        let _ = InvalidateRect(Some(rs.hwnd), None, true);
    });
}

/// `EnumChildWindows` callback: when it reaches the `TrayNotifyWnd` (system
/// notification area), write its left edge to the `*mut i32` passed via `lparam`
/// and stop. Runs on the render thread (called synchronously from `dock_xy`).
unsafe extern "system" fn find_tray_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let mut buf = [0u16; 32];
    let n = GetClassNameW(hwnd, &mut buf);
    if n > 0 && String::from_utf16_lossy(&buf[..n as usize]) == "TrayNotifyWnd" {
        let mut r = RECT::default();
        if GetWindowRect(hwnd, &mut r).is_ok() {
            *(lparam.0 as *mut i32) = r.left;
            return BOOL(0); // found → stop enumerating
        }
    }
    BOOL(1) // keep going
}

/// Left edge (physical px) of the system notification area (`TrayNotifyWnd`), so
/// a right-docked plate can sit just LEFT of the clock/tray icons instead of
/// overlapping them. On Win11 24H2 `TrayNotifyWnd` is a NESTED descendant of
/// `Shell_TrayWnd` (not an immediate child), so we recurse via `EnumChildWindows`
/// rather than `FindWindowEx` (which returns 0). `None` if it can't be located.
unsafe fn tray_notify_left() -> Option<i32> {
    let tray = FindWindowW(w!("Shell_TrayWnd"), PCWSTR::null()).ok()?;
    let mut left: i32 = i32::MIN;
    let _ = EnumChildWindows(
        Some(tray),
        Some(find_tray_cb),
        LPARAM(&mut left as *mut i32 as isize),
    );
    (left != i32::MIN).then_some(left)
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

    // Right-dock boundary for a horizontal bar: the LEFT edge of the notification
    // area (clock/tray icons) so the plate never overlaps it; fall back to the
    // bar's right edge when the tray can't be located.
    let right_bound = tray_notify_left()
        .filter(|&l| l > bar.left + 8 && l <= bar.right)
        .unwrap_or(bar.right);

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
            right_bound.saturating_sub(plate_w).saturating_sub(end_gap)
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
            right_bound.saturating_sub(plate_w).saturating_sub(end_gap)
        } else {
            bar.left.saturating_add(end_gap)
        };
        let x = x.clamp(bar.left, (bar.right - plate_w).max(bar.left));
        Some((x, y))
    }
}

/// Owner-draw the plate: fill the color-keyed background, then per cell draw the
/// label (label color) + value (threshold color), columns flowing horizontally,
/// rows stacked. Tries the Direct2D/DirectWrite engine first (browser-grade
/// glyphs); on any D2D failure falls back to the GDI `HFONT`/`HBRUSH` path. The
/// color-key bg + same (x,y) positions are identical between the two engines.
unsafe fn paint(rs: &RenderState) {
    let mut ps = PAINTSTRUCT::default();
    let hdc = BeginPaint(rs.hwnd, &mut ps);

    let mut rect = RECT::default();
    let _ = windows::Win32::UI::WindowsAndMessaging::GetClientRect(rs.hwnd, &mut rect);

    // Direct2D path (preferred). Returns false on any failure → GDI fallback below.
    let drawn = if rs.use_d2d {
        paint_d2d(rs, hdc, &rect)
    } else {
        false
    };

    if !drawn {
        paint_gdi(rs, hdc, &rect);
    }

    let _ = EndPaint(rs.hwnd, &ps);
}

/// Direct2D/DirectWrite owner-draw. Binds the cached DC render target to the
/// window DC, clears to the color-key bg, then draws each segment with the cached
/// solid brush (its color re-set per segment) at the SAME device-px positions the
/// GDI path uses. Returns `false` (→ GDI fallback) on any D2D error; never panics.
unsafe fn paint_d2d(rs: &RenderState, hdc: HDC, rect: &RECT) -> bool {
    let (Some(target), Some(fmt), Some(brush)) = (
        rs.dc_target.as_ref(),
        rs.text_format.as_ref(),
        rs.d2d_brush.as_ref(),
    ) else {
        return false;
    };

    let _ = fmt; // format is used via `layout_seg`; kept in the tuple for the guard.

    if target.BindDC(hdc, rect).is_err() {
        return false;
    }
    target.BeginDraw();
    // Same bg the LWA_COLORKEY keys out → plate clears to transparent on the bar.
    target.Clear(Some(&colorref_to_d2d(rs.cfg.bg)));

    let pad = rs.cfg.padding.max(0);
    let inner = rs.cfg.inner_space.max(0);

    // Draw one segment at device-px (x,y) via a typography-enabled IDWriteTextLayout
    // (tabular + lining figures) → DrawTextLayout, so digits are column-stable and
    // measured width == drawn width. `DrawTextLayout`'s origin is a
    // `windows_numerics::Vector2` (a transitive type we can't name here); it's a
    // `#[repr(C)]` pair of f32, so we build it by transmuting `[x as f32, y as f32]`
    // (size/layout identical; the target type is inferred from the parameter).
    let draw = |x: i32, y: i32, w16: &[u16], color: COLORREF| {
        let Some(layout) = layout_seg(rs, w16) else {
            return;
        };
        brush.SetColor(&colorref_to_d2d(color));
        let origin = core::mem::transmute::<[f32; 2], _>([x as f32, y as f32]);
        target.DrawTextLayout(origin, &layout, brush, D2D1_DRAW_TEXT_OPTIONS_NONE);
    };

    // Two-block field layout (computed in `tick`): labels LEFT-aligned at `cell.x`,
    // values RIGHT-aligned inside the fixed field `[cell.x, cell.x+cell.field_w]`
    // (so decimal points / units stack on a constant edge with a uniform gutter).
    // Vertically center the row's text in its band (no-op at one font, but safe).
    for (r, cells) in rs.cells_layout.iter().enumerate() {
        let cy = pad + r as i32 * (rs.row_h + inner);
        for cell in cells {
            let cx = if cell.is_value {
                cell.x + (cell.field_w - cell.width).max(0)
            } else {
                cell.x
            };
            draw(cx, cy, &cell.w16, cell.color);
        }
    }

    // A device loss (D2DERR_RECREATE_TARGET) returns an Err here; report failure so
    // the caller draws GDI this frame and we keep the resources for next paint.
    target.EndDraw(None, None).is_ok()
}

/// GDI owner-draw fallback (the original engine). Fills the color-keyed bg with
/// the cached brush, selects the cached font, and `TextOutW`s each segment.
unsafe fn paint_gdi(rs: &RenderState, hdc: HDC, rect: &RECT) {
    // The whole client rect is the color-key bg (so it shows through the taskbar).
    FillRect(hdc, rect, rs.bg_brush);

    let old = SelectObject(hdc, rs.font.into());
    SetBkMode(hdc, TRANSPARENT);

    let pad = rs.cfg.padding.max(0);
    let inner = rs.cfg.inner_space.max(0);

    // SAME two-block field layout as `paint_d2d` (identical `cell.x`/`field_w`),
    // so the two engines draw pixel-identically: labels left-aligned at `cell.x`,
    // values right-aligned inside `[cell.x, cell.x+cell.field_w]`. GDI can't apply
    // OpenType tabular figures, but Segoe UI's GDI digit advances are already
    // near-uniform and the fixed-field boxes keep columns tidy regardless — the
    // only difference from the D2D path is sub-pixel digit jitter, not layout.
    for (r, cells) in rs.cells_layout.iter().enumerate() {
        let cy = pad + r as i32 * (rs.row_h + inner);
        for cell in cells {
            let cx = if cell.is_value {
                cell.x + (cell.field_w - cell.width).max(0)
            } else {
                cell.x
            };
            // Reuse the cached UTF-16 buffer built in `tick` — no per-paint alloc.
            SetTextColor(hdc, cell.color);
            let _ = TextOutW(hdc, cx, cy, &cell.w16);
        }
    }

    SelectObject(hdc, old);
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
                    cfg: TickCfg::read(),
                    cells_layout: Vec::new(),
                    row_h: 0,
                    last_good: None,
                    use_d2d: false,
                    d2d_factory: None,
                    dwrite_factory: None,
                    dc_target: None,
                    text_format: None,
                    fmt_key: (0, false, 0),
                    d2d_brush: None,
                    d2d_typography: None,
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
