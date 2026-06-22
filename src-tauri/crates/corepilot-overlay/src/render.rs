//! The ImGui render loop that draws the OSD into the game's frame.
//!
//! hudhook calls [`OsdRenderLoop::render`] once per presented frame on the
//! game's render thread. We:
//!   1. lazily open the shared-memory reader (and keep retrying if CorePilot
//!      isn't up yet),
//!   2. take a tear-free snapshot of the block,
//!   3. bail out (draw nothing) unless the block is valid, enabled, and either
//!      untargeted or targeted at our own PID,
//!   4. draw a single click-through, decoration-free, transparent window with
//!      only the metric rows the app asked for.
//!
//! Crash safety is paramount: a panic here would unwind across hudhook's FFI
//! boundary and take the game down. The whole body therefore runs inside
//! [`std::panic::catch_unwind`] and never `unwrap`s on anything fallible.

use std::panic::{catch_unwind, AssertUnwindSafe};

use corepilot_osd_ipc::{anchor, row, show, OsdShared, OsdSharedBlock};
use imgui::{Condition, Ui, WindowFlags};
use windows::Win32::System::Threading::GetCurrentProcessId;

use crate::format::{
    bps_or_dash, clock_or_dash, fixed_or_dash, int_or_dash, mem_pair_g, pct_or_dash, rgba_to_f32s,
    temp_or_dash, watts_or_dash,
};

/// Holds the lazily-opened shared-memory reader so the render loop can be
/// `Send + Sync` (required by hudhook's `Hooks::from_render_loop`).
///
/// [`OsdShared`] owns a raw pointer + handle and is therefore `!Send`/`!Sync` by
/// default. That is sound here because the reader is created and read **only**
/// from the single game render thread that hudhook drives — it never crosses
/// threads at runtime. We encapsulate that invariant in this newtype rather than
/// leaking an `unsafe impl` onto the whole render loop.
struct RenderThreadReader(Option<OsdShared>);

// SAFETY: the contained `OsdShared` is constructed and dereferenced exclusively
// on hudhook's render thread (see module docs). hudhook requires the render loop
// to be `Send + Sync` to move it onto that thread once; after that it is never
// shared. The block it points at is in shared memory that outlives the process.
unsafe impl Send for RenderThreadReader {}
unsafe impl Sync for RenderThreadReader {}

/// hudhook render loop for the CorePilot OSD. One instance is moved onto the
/// game's render thread at hook time.
pub struct OsdRenderLoop {
    /// Lazily-opened reader; `None` until CorePilot's shared block exists.
    reader: RenderThreadReader,
    /// Cached PID of the host process (cheap, never changes for our lifetime).
    self_pid: u32,
}

impl OsdRenderLoop {
    /// Construct an un-opened render loop. No shared memory is touched yet — the
    /// reader is opened lazily on the first frame so injection never depends on
    /// CorePilot already running.
    pub fn new() -> Self {
        // SAFETY: GetCurrentProcessId has no preconditions and cannot fail.
        let self_pid = unsafe { GetCurrentProcessId() };
        Self {
            reader: RenderThreadReader(None),
            self_pid,
        }
    }

    /// Ensure the shared-memory reader is open, retrying cheaply each frame until
    /// CorePilot creates the mapping. Returns `None` while it is still absent.
    fn reader(&mut self) -> Option<&OsdShared> {
        if self.reader.0.is_none() {
            // `open()` fails (mapping absent) when CorePilot isn't running; we
            // simply try again next frame. No logging per-frame to avoid spam.
            self.reader.0 = OsdShared::open().ok();
        }
        self.reader.0.as_ref()
    }

    /// Decide whether this frame should draw, and return the snapshot if so.
    ///
    /// Gates, in order: a readable mapping, a valid+current block, `enabled == 1`,
    /// and PID targeting (`target_pid == 0` means "any process", otherwise it must
    /// match ours). Returning `None` means "draw nothing this frame".
    fn snapshot_if_active(&mut self) -> Option<OsdSharedBlock> {
        let self_pid = self.self_pid;
        let reader = self.reader()?;
        let block = reader.read();
        if !block.is_valid() || block.enabled == 0 {
            return None;
        }
        if block.target_pid != 0 && block.target_pid != self_pid {
            return None;
        }
        Some(block)
    }
}

impl Default for OsdRenderLoop {
    fn default() -> Self {
        Self::new()
    }
}

impl hudhook::ImguiRenderLoop for OsdRenderLoop {
    fn render(&mut self, ui: &mut Ui) {
        // Catch any panic so it can never unwind into hudhook's C/FFI frames and
        // crash the host game. `AssertUnwindSafe` is justified: on a caught panic
        // we draw nothing and drop nothing observable — the worst case is a
        // skipped frame of OSD, and the next frame retries cleanly.
        let _ = catch_unwind(AssertUnwindSafe(|| {
            if let Some(block) = self.snapshot_if_active() {
                draw_overlay(ui, &block);
            }
        }));
    }
}

/// Convert the block's `anchor` + `pos_x/pos_y` into an absolute ImGui screen
/// position and a matching pivot, using the current display size for the
/// right/bottom edges. The pivot makes `ALWAYS_AUTO_RESIZE` windows hug the
/// chosen corner regardless of their (content-driven) size.
fn anchored_position(block: &OsdSharedBlock, display: [f32; 2]) -> ([f32; 2], [f32; 2]) {
    let (dx, dy) = (display[0], display[1]);
    let (px, py) = (block.pos_x, block.pos_y);
    match block.anchor {
        anchor::TOP_RIGHT => ([dx - px, py], [1.0, 0.0]),
        anchor::BOTTOM_LEFT => ([px, dy - py], [0.0, 1.0]),
        anchor::BOTTOM_RIGHT => ([dx - px, dy - py], [1.0, 1.0]),
        // TOP_LEFT and any unknown value fall back to top-left.
        _ => ([px, py], [0.0, 0.0]),
    }
}

/// One OSD row: its rendered text plus the row-type index used to look up a
/// per-row color in `row_colors_rgba` (None = uncategorised, e.g. the custom
/// game-name line, which uses the flat fallback color).
struct Row {
    kind: Option<usize>,
    text: String,
}

/// Build the ordered list of metric rows enabled in `layout_flags`. Each row is a
/// single compact line in RTSS style. Pure string-building so it stays cheap.
fn build_rows(block: &OsdSharedBlock) -> Vec<Row> {
    let mut rows: Vec<Row> = Vec::new();
    let flags = block.layout_flags;

    if flags & show::FPS != 0 {
        rows.push(Row {
            kind: Some(row::FPS),
            text: format!("FPS {}", int_or_dash(block.fps)),
        });
    }
    if flags & show::FRAMETIME != 0 {
        // Frametime plus the 1%/0.1% lows when present, e.g. "5.5ms  1% 120  .1% 98".
        let mut line = fixed_or_dash(block.frametime_ms, 1, "ms");
        if block.low1_fps.is_finite() {
            line.push_str(&format!("  1% {}", int_or_dash(block.low1_fps)));
        }
        if block.low01_fps.is_finite() {
            line.push_str(&format!("  .1% {}", int_or_dash(block.low01_fps)));
        }
        rows.push(Row {
            kind: Some(row::FRAMETIME),
            text: line,
        });
    }
    if flags & show::CPU != 0 {
        // CPU 37% 61° 94W 5.5GHz — each field dropped to "—" when unavailable.
        rows.push(Row {
            kind: Some(row::CPU),
            text: format!(
                "CPU {} {} {} {}",
                pct_or_dash(block.cpu_load),
                temp_or_dash(block.cpu_temp),
                watts_or_dash(block.cpu_power_w),
                clock_or_dash(block.cpu_clock_mhz),
            ),
        });
    }
    if flags & show::GPU != 0 {
        // GPU 81% 57° 404W — clock/mem/fan are shown on the GPU line too when set.
        let mut line = format!(
            "GPU {} {} {}",
            pct_or_dash(block.gpu_load),
            temp_or_dash(block.gpu_temp),
            watts_or_dash(block.gpu_power_w),
        );
        if block.gpu_clock_mhz.is_finite() {
            line.push(' ');
            line.push_str(&clock_or_dash(block.gpu_clock_mhz));
        }
        rows.push(Row {
            kind: Some(row::GPU),
            text: line,
        });
    }
    if flags & show::VRAM != 0 {
        rows.push(Row {
            kind: Some(row::VRAM),
            text: format!(
                "VRAM {}",
                mem_pair_g(block.vram_used_mb, block.vram_total_mb)
            ),
        });
    }
    if flags & show::RAM != 0 {
        // RAM as a percentage of total when both sides are known, else a dash.
        let pct = if block.ram_total_mb != u32::MAX
            && block.ram_used_mb != u32::MAX
            && block.ram_total_mb != 0
        {
            (block.ram_used_mb as f32 / block.ram_total_mb as f32) * 100.0
        } else {
            f32::NAN
        };
        rows.push(Row {
            kind: Some(row::RAM),
            text: format!("RAM {}", pct_or_dash(pct)),
        });
    }
    if flags & show::DISK != 0 {
        rows.push(Row {
            kind: Some(row::DISK),
            text: format!("DISK {}", pct_or_dash(block.disk_pct)),
        });
    }
    if flags & show::NET != 0 {
        rows.push(Row {
            kind: Some(row::NET),
            text: format!(
                "NET ↓{} ↑{}",
                bps_or_dash(block.net_down_bps),
                bps_or_dash(block.net_up_bps)
            ),
        });
    }

    // Optional free-form line (e.g. the game's display name), if the app set one.
    let custom = block.custom_text_str();
    if !custom.is_empty() {
        rows.push(Row {
            kind: None,
            text: custom.to_string(),
        });
    }

    rows
}

/// Pick a row's draw color: its per-type slot in `row_colors_rgba` when set
/// (non-zero), else the flat `color_rgba` fallback (also used for uncategorised
/// rows). This is what paints the in-game overlay in the active theme's palette.
fn row_color(block: &OsdSharedBlock, kind: Option<usize>) -> [f32; 4] {
    let rgba = kind
        .and_then(|i| block.row_colors_rgba.get(i).copied())
        .filter(|c| *c != 0)
        .unwrap_or(block.color_rgba);
    rgba_to_f32s(rgba)
}

/// Draw the single OSD window for this frame. Called only when the block is
/// active. Never panics on its own inputs (all values pre-validated/sanitised).
fn draw_overlay(ui: &Ui, block: &OsdSharedBlock) {
    let display = ui.io().display_size;
    let (pos, pivot) = anchored_position(block, display);

    // Click-through, no chrome, no background, auto-sized to its text. Combined
    // with the IPC contract this is the in-frame "plate" the user sees.
    let flags = WindowFlags::NO_DECORATION
        | WindowFlags::NO_INPUTS
        | WindowFlags::NO_BACKGROUND
        | WindowFlags::NO_NAV
        | WindowFlags::NO_MOVE
        | WindowFlags::ALWAYS_AUTO_RESIZE;

    ui.window("##corepilot_osd")
        .flags(flags)
        .position(pos, Condition::Always)
        .position_pivot(pivot)
        .build(|| {
            // `scale` drives the font size; clamp to a sane range so a bad value
            // can't blow the text up to fill the screen or shrink it to nothing.
            let scale = if block.scale.is_finite() {
                block.scale.clamp(0.5, 4.0)
            } else {
                1.0
            };
            ui.set_window_font_scale(scale);

            // Each row in its own themed color (yellow FPS, cyan/blue GPU, …),
            // falling back to the flat color for unset slots / the custom line.
            for r in build_rows(block) {
                ui.text_colored(row_color(block, r.kind), &r.text);
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_block() -> OsdSharedBlock {
        let mut b = OsdSharedBlock::default();
        b.enabled = 1;
        b
    }

    #[test]
    fn anchored_position_handles_all_corners() {
        let mut b = base_block();
        b.pos_x = 10.0;
        b.pos_y = 20.0;
        let disp = [1920.0, 1080.0];

        b.anchor = anchor::TOP_LEFT;
        assert_eq!(anchored_position(&b, disp), ([10.0, 20.0], [0.0, 0.0]));
        b.anchor = anchor::TOP_RIGHT;
        assert_eq!(anchored_position(&b, disp), ([1910.0, 20.0], [1.0, 0.0]));
        b.anchor = anchor::BOTTOM_LEFT;
        assert_eq!(anchored_position(&b, disp), ([10.0, 1060.0], [0.0, 1.0]));
        b.anchor = anchor::BOTTOM_RIGHT;
        assert_eq!(anchored_position(&b, disp), ([1910.0, 1060.0], [1.0, 1.0]));
    }

    #[test]
    fn rows_respect_layout_flags() {
        let mut b = base_block();
        b.layout_flags = show::FPS; // only FPS
        b.fps = 144.0;
        let rows = build_rows(&b);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].text, "FPS 144");
        assert_eq!(rows[0].kind, Some(row::FPS));
    }

    #[test]
    fn unavailable_metrics_render_dash() {
        let mut b = base_block();
        b.layout_flags = show::CPU;
        // All CPU fields left at NaN default => every field a dash.
        let rows = build_rows(&b);
        assert_eq!(rows[0].text, "CPU — — — —");
        assert_eq!(rows[0].kind, Some(row::CPU));
    }

    #[test]
    fn cpu_row_formats_all_fields() {
        let mut b = base_block();
        b.layout_flags = show::CPU;
        b.cpu_load = 37.0;
        b.cpu_temp = 61.0;
        b.cpu_power_w = 94.0;
        b.cpu_clock_mhz = 5500.0;
        let rows = build_rows(&b);
        assert_eq!(rows[0].text, "CPU 37% 61° 94W 5.5GHz");
    }

    #[test]
    fn vram_row_uses_gib_pair() {
        let mut b = base_block();
        b.layout_flags = show::VRAM;
        b.vram_used_mb = 12 * 1024;
        b.vram_total_mb = 24 * 1024;
        let rows = build_rows(&b);
        assert_eq!(rows[0].text, "VRAM 12/24G");
    }

    #[test]
    fn custom_text_appended_when_present() {
        let mut b = base_block();
        b.layout_flags = show::FPS;
        b.fps = 60.0;
        b.set_custom_text("赛博朋克2077");
        let rows = build_rows(&b);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].text, "FPS 60");
        assert_eq!(rows[1].text, "赛博朋克2077");
        assert_eq!(rows[1].kind, None);
    }

    #[test]
    fn row_color_uses_palette_then_falls_back() {
        let mut b = base_block();
        b.color_rgba = 0xFFFF_FFFF; // white fallback
        b.row_colors_rgba[row::CPU] = 0xFFE600FF; // themed yellow for CPU
                                                  // CPU row uses its palette slot…
        let cpu = row_color(&b, Some(row::CPU));
        assert!((cpu[0] - 1.0).abs() < 1e-3 && (cpu[1] - 0.9).abs() < 0.05 && cpu[2] < 0.05);
        // …an unset slot (GPU = 0) and the custom line (None) use the fallback.
        assert_eq!(row_color(&b, Some(row::GPU)), rgba_to_f32s(0xFFFF_FFFF));
        assert_eq!(row_color(&b, None), rgba_to_f32s(0xFFFF_FFFF));
    }
}
