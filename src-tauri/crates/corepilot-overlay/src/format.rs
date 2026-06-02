//! Pure formatting helpers for the OSD rows.
//!
//! Kept separate from the render/FFI code so they can be unit-tested on any host
//! (no ImGui, no Windows). The style is deliberately terse — RTSS-like — so the
//! plate stays small over the game: `FPS 144`, `CPU 37% 61° 94W 5.5GHz`, etc.
//!
//! Every metric honours the shared-memory sentinels: `f32::NAN` and `u32::MAX`
//! mean "unavailable" and render as the em-dash `—` instead of a fake number.

/// What a missing value renders as. One glyph keeps rows aligned and unambiguous.
pub const UNAVAILABLE: &str = "—";

/// True when an `f32` metric is the "unavailable" sentinel (NaN) — also treats
/// any non-finite value (±inf) as unavailable so a bad sample never prints.
#[inline]
pub fn is_unavail_f32(v: f32) -> bool {
    !v.is_finite()
}

/// True when a `u32` metric is the "unavailable" sentinel (`u32::MAX`).
#[inline]
pub fn is_unavail_u32(v: u32) -> bool {
    v == u32::MAX
}

/// Format an integer-ish `f32` as `"<n>"` (rounded) or `—`. Used for whole-number
/// readouts such as FPS.
pub fn int_or_dash(v: f32) -> String {
    if is_unavail_f32(v) {
        UNAVAILABLE.to_string()
    } else {
        format!("{}", v.round() as i64)
    }
}

/// Format an `f32` with a fixed number of decimals plus a `unit` suffix, or `—`.
/// Example: `fixed_or_dash(5.5, 1, "ms") == "5.5ms"`.
pub fn fixed_or_dash(v: f32, decimals: usize, unit: &str) -> String {
    if is_unavail_f32(v) {
        UNAVAILABLE.to_string()
    } else {
        format!("{:.*}{}", decimals, v, unit)
    }
}

/// Format a percentage (`"37%"`) or `—`.
pub fn pct_or_dash(v: f32) -> String {
    if is_unavail_f32(v) {
        UNAVAILABLE.to_string()
    } else {
        format!("{}%", v.round() as i64)
    }
}

/// Format a temperature in degrees (`"61°"`) or `—`.
pub fn temp_or_dash(v: f32) -> String {
    if is_unavail_f32(v) {
        UNAVAILABLE.to_string()
    } else {
        format!("{}°", v.round() as i64)
    }
}

/// Format power in watts (`"94W"`) or `—`.
pub fn watts_or_dash(v: f32) -> String {
    if is_unavail_f32(v) {
        UNAVAILABLE.to_string()
    } else {
        format!("{}W", v.round() as i64)
    }
}

/// Format a clock in MHz as GHz when ≥ 1000 (`"5.5GHz"`), else MHz (`"900MHz"`),
/// or `—`. Matches how RTSS shows core/mem clocks compactly.
pub fn clock_or_dash(mhz: f32) -> String {
    if is_unavail_f32(mhz) {
        UNAVAILABLE.to_string()
    } else if mhz >= 1000.0 {
        format!("{:.1}GHz", mhz / 1000.0)
    } else {
        format!("{}MHz", mhz.round() as i64)
    }
}

/// Format `used/total` mebibytes as gibibytes (`"12/24G"`). Either side that is
/// unavailable becomes `—` while keeping the `used/total` shape.
pub fn mem_pair_g(used_mb: u32, total_mb: u32) -> String {
    let g = |mb: u32| -> String {
        if is_unavail_u32(mb) {
            UNAVAILABLE.to_string()
        } else {
            // Integer GiB when it divides evenly, else one decimal — keeps "12/24G"
            // tidy while still showing e.g. "10.5/16G".
            let gib = mb as f32 / 1024.0;
            if (gib.fract()).abs() < 0.05 {
                format!("{}", gib.round() as i64)
            } else {
                format!("{:.1}", gib)
            }
        }
    };
    format!("{}/{}G", g(used_mb), g(total_mb))
}

/// Format a byte/s throughput compactly with binary-ish scaling: `B/s`, `K/s`,
/// `M/s`, `G/s`, or `—`. Used for the network rows.
pub fn bps_or_dash(bps: f32) -> String {
    if is_unavail_f32(bps) {
        return UNAVAILABLE.to_string();
    }
    let b = bps.max(0.0);
    if b < 1024.0 {
        format!("{}B/s", b.round() as i64)
    } else if b < 1024.0 * 1024.0 {
        format!("{:.0}K/s", b / 1024.0)
    } else if b < 1024.0 * 1024.0 * 1024.0 {
        format!("{:.1}M/s", b / (1024.0 * 1024.0))
    } else {
        format!("{:.1}G/s", b / (1024.0 * 1024.0 * 1024.0))
    }
}

/// Unpack a packed `0xRRGGBBAA` colour into ImGui's `[r, g, b, a]` floats in
/// `0.0..=1.0`. A fully-transparent colour (alpha 0) is treated as "use opaque
/// white" so a mis-set block never renders invisible text.
pub fn rgba_to_f32s(color_rgba: u32) -> [f32; 4] {
    let r = ((color_rgba >> 24) & 0xFF) as f32 / 255.0;
    let g = ((color_rgba >> 16) & 0xFF) as f32 / 255.0;
    let b = ((color_rgba >> 8) & 0xFF) as f32 / 255.0;
    let a = (color_rgba & 0xFF) as f32 / 255.0;
    if a <= 0.0 {
        [1.0, 1.0, 1.0, 1.0]
    } else {
        [r, g, b, a]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nan_and_u32_max_render_as_dash() {
        assert_eq!(int_or_dash(f32::NAN), UNAVAILABLE);
        assert_eq!(pct_or_dash(f32::INFINITY), UNAVAILABLE);
        assert_eq!(temp_or_dash(f32::NAN), UNAVAILABLE);
        assert_eq!(watts_or_dash(f32::NAN), UNAVAILABLE);
        assert_eq!(clock_or_dash(f32::NAN), UNAVAILABLE);
        assert_eq!(bps_or_dash(f32::NAN), UNAVAILABLE);
        assert_eq!(mem_pair_g(u32::MAX, u32::MAX), "—/—G");
    }

    #[test]
    fn whole_numbers_round() {
        assert_eq!(int_or_dash(143.6), "144");
        assert_eq!(pct_or_dash(37.4), "37%");
        assert_eq!(temp_or_dash(60.5), "61°"); // round-half-to-even-ish; 60.5 -> 61
        assert_eq!(watts_or_dash(94.2), "94W");
    }

    #[test]
    fn clock_scales_to_ghz() {
        assert_eq!(clock_or_dash(900.0), "900MHz");
        assert_eq!(clock_or_dash(5500.0), "5.5GHz");
    }

    #[test]
    fn frametime_keeps_decimal() {
        assert_eq!(fixed_or_dash(5.5, 1, "ms"), "5.5ms");
    }

    #[test]
    fn vram_pair_formats_gib() {
        assert_eq!(mem_pair_g(12 * 1024, 24 * 1024), "12/24G");
        // Non-even GiB shows one decimal on the affected side.
        assert_eq!(mem_pair_g(10 * 1024 + 512, 16 * 1024), "10.5/16G");
    }

    #[test]
    fn throughput_scales() {
        assert_eq!(bps_or_dash(512.0), "512B/s");
        assert_eq!(bps_or_dash(2.0 * 1024.0), "2K/s");
        assert_eq!(bps_or_dash(3.0 * 1024.0 * 1024.0), "3.0M/s");
    }

    #[test]
    fn rgba_unpacks_and_guards_zero_alpha() {
        // 0xRRGGBBAA: pure red, full alpha.
        let c = rgba_to_f32s(0xFF00_00FF);
        assert!((c[0] - 1.0).abs() < 1e-6 && c[1] == 0.0 && c[2] == 0.0 && c[3] == 1.0);
        // Zero alpha falls back to opaque white so text never vanishes.
        assert_eq!(rgba_to_f32s(0x1234_5600), [1.0, 1.0, 1.0, 1.0]);
    }
}
