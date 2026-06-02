//! Shared-memory contract between the CorePilot app (writer) and the injected
//! in-game overlay DLL (reader).
//!
//! Mirrors how MSI Afterburner hands data to RTSS: a separate process samples the
//! metrics and writes them into a named shared-memory block; the code injected
//! into the game reads that block on every presented frame and draws the OSD into
//! the game's own back buffer. CorePilot's main process owns the block; the
//! `corepilot-overlay` DLL opens it read-only.
//!
//! Synchronisation is a **seqlock** (single writer, single/few readers): the
//! writer bumps `seq` to odd before writing and to even after, and the reader
//! retries while `seq` is odd or changed mid-copy. This is wait-free for the
//! writer and never blocks the game's render thread on a kernel object.

use std::sync::atomic::{AtomicU32, Ordering};

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows::Win32::System::Memory::{
    CreateFileMappingW, MapViewOfFile, OpenFileMappingW, UnmapViewOfFile, FILE_MAP_ALL_ACCESS,
    FILE_MAP_READ, MEMORY_MAPPED_VIEW_ADDRESS, PAGE_READWRITE,
};

/// Block signature: ASCII "CPOS" (CorePilot OSD Shared). A reader that sees any
/// other value treats the block as absent/garbage and draws nothing.
pub const COREPILOT_OSD_MAGIC: u32 = 0x4350_4F53;
/// Layout version. Bump on any incompatible change to [`OsdSharedBlock`].
pub const COREPILOT_OSD_VERSION: u32 = 1;

/// Per-session mapping name. `Local\` (not `Global\`) is correct because the game
/// and CorePilot run in the same interactive session; it avoids needing the
/// `SeCreateGlobalPrivilege` that `Global\` requires.
const MAPPING_NAME: PCWSTR = w!(r"Local\CorePilotOSD");

/// Anchor corner for the OSD plate inside the game frame.
pub mod anchor {
    pub const TOP_LEFT: u32 = 0;
    pub const TOP_RIGHT: u32 = 1;
    pub const BOTTOM_LEFT: u32 = 2;
    pub const BOTTOM_RIGHT: u32 = 3;
}

/// Which metric rows the overlay should draw (bitflags in `layout_flags`).
pub mod show {
    pub const FPS: u32 = 1 << 0;
    pub const FRAMETIME: u32 = 1 << 1;
    pub const CPU: u32 = 1 << 2;
    pub const GPU: u32 = 1 << 3;
    pub const VRAM: u32 = 1 << 4;
    pub const RAM: u32 = 1 << 5;
    pub const DISK: u32 = 1 << 6;
    pub const NET: u32 = 1 << 7;
}

/// Fixed-layout, versioned block living in shared memory. `#[repr(C)]` so both
/// crates (compiled separately) agree on the field offsets. All metric fields use
/// `f32`/`u32` and a sentinel (`f32::NAN` / `u32::MAX`) means "unavailable" — the
/// overlay renders `—` rather than a fake value.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct OsdSharedBlock {
    // --- control / handshake ---
    pub magic: u32,
    pub version: u32,
    /// Seqlock counter. Odd = a write is in progress. Never written by readers.
    pub seq: u32,
    /// 0 = hide the overlay, 1 = draw it.
    pub enabled: u32,
    /// PID this block currently targets; the DLL ignores it unless it matches its
    /// own `GetCurrentProcessId` (lets one block be retargeted without races).
    pub target_pid: u32,
    /// Bitfield of [`show`] flags.
    pub layout_flags: u32,

    // --- placement / style ---
    pub anchor: u32,
    pub pos_x: f32,
    pub pos_y: f32,
    pub scale: f32,
    /// Packed 0xRRGGBBAA text colour.
    pub color_rgba: u32,

    // --- metrics (NaN / u32::MAX = unavailable) ---
    pub fps: f32,
    pub frametime_ms: f32,
    pub low1_fps: f32,
    pub low01_fps: f32,
    pub cpu_load: f32,
    pub cpu_temp: f32,
    pub cpu_clock_mhz: f32,
    pub cpu_power_w: f32,
    pub gpu_load: f32,
    pub gpu_temp: f32,
    pub gpu_clock_mhz: f32,
    pub gpu_power_w: f32,
    pub gpu_mem_clock_mhz: f32,
    pub gpu_fan_pct: f32,
    pub vram_used_mb: u32,
    pub vram_total_mb: u32,
    pub ram_used_mb: u32,
    pub ram_total_mb: u32,
    pub disk_pct: f32,
    pub net_down_bps: f32,
    pub net_up_bps: f32,

    /// Optional free-form UTF-8 line (NUL-terminated), e.g. the game's display
    /// name. Kept strictly UTF-8 so non-ASCII (Chinese) names survive.
    pub custom_text: [u8; 256],
}

impl Default for OsdSharedBlock {
    fn default() -> Self {
        Self {
            magic: COREPILOT_OSD_MAGIC,
            version: COREPILOT_OSD_VERSION,
            seq: 0,
            enabled: 0,
            target_pid: 0,
            layout_flags: show::FPS | show::CPU | show::GPU | show::VRAM | show::RAM,
            anchor: anchor::TOP_LEFT,
            pos_x: 16.0,
            pos_y: 16.0,
            scale: 1.0,
            color_rgba: 0xFFFF_FFFF,
            fps: f32::NAN,
            frametime_ms: f32::NAN,
            low1_fps: f32::NAN,
            low01_fps: f32::NAN,
            cpu_load: f32::NAN,
            cpu_temp: f32::NAN,
            cpu_clock_mhz: f32::NAN,
            cpu_power_w: f32::NAN,
            gpu_load: f32::NAN,
            gpu_temp: f32::NAN,
            gpu_clock_mhz: f32::NAN,
            gpu_power_w: f32::NAN,
            gpu_mem_clock_mhz: f32::NAN,
            gpu_fan_pct: f32::NAN,
            vram_used_mb: u32::MAX,
            vram_total_mb: u32::MAX,
            ram_used_mb: u32::MAX,
            ram_total_mb: u32::MAX,
            disk_pct: f32::NAN,
            net_down_bps: f32::NAN,
            net_up_bps: f32::NAN,
            custom_text: [0; 256],
        }
    }
}

impl OsdSharedBlock {
    /// True when the block is a valid, current-version CorePilot OSD block.
    pub fn is_valid(&self) -> bool {
        self.magic == COREPILOT_OSD_MAGIC && self.version == COREPILOT_OSD_VERSION
    }

    /// Write a NUL-terminated UTF-8 string into `custom_text` (truncated to fit).
    pub fn set_custom_text(&mut self, s: &str) {
        self.custom_text = [0; 256];
        let bytes = s.as_bytes();
        let n = bytes.len().min(self.custom_text.len() - 1);
        self.custom_text[..n].copy_from_slice(&bytes[..n]);
    }

    /// Read `custom_text` back as a `&str` (up to the first NUL; lossless UTF-8).
    pub fn custom_text_str(&self) -> &str {
        let end = self
            .custom_text
            .iter()
            .position(|&b| b == 0)
            .unwrap_or(self.custom_text.len());
        std::str::from_utf8(&self.custom_text[..end]).unwrap_or("")
    }
}

/// A mapped view of the shared block plus the mapping handle. Owns the OS
/// resources and releases them on drop. Not `Sync`/`Send` by default (raw ptr);
/// the writer keeps it on one thread, the reader on the game's render thread.
pub struct OsdShared {
    handle: HANDLE,
    ptr: *mut OsdSharedBlock,
}

impl OsdShared {
    /// Create (or open if it already exists) the mapping and initialise it to a
    /// default, disabled block. Call from the CorePilot **writer** process.
    pub fn create() -> windows::core::Result<Self> {
        unsafe {
            let handle = CreateFileMappingW(
                INVALID_HANDLE_VALUE,
                None,
                PAGE_READWRITE,
                0,
                std::mem::size_of::<OsdSharedBlock>() as u32,
                MAPPING_NAME,
            )?;
            let view = MapViewOfFile(handle, FILE_MAP_ALL_ACCESS, 0, 0, 0);
            let ptr = Self::checked_ptr(handle, view)?;
            // Initialise to a clean, disabled block.
            std::ptr::write(ptr, OsdSharedBlock::default());
            Ok(Self { handle, ptr })
        }
    }

    /// Open an existing mapping read-only. Call from the injected **reader** DLL.
    /// Fails (mapping absent) when CorePilot isn't running — the overlay then
    /// simply draws nothing.
    pub fn open() -> windows::core::Result<Self> {
        unsafe {
            let handle = OpenFileMappingW(FILE_MAP_READ.0, false, MAPPING_NAME)?;
            let view = MapViewOfFile(handle, FILE_MAP_READ, 0, 0, 0);
            let ptr = Self::checked_ptr(handle, view)?;
            Ok(Self { handle, ptr })
        }
    }

    unsafe fn checked_ptr(
        handle: HANDLE,
        view: MEMORY_MAPPED_VIEW_ADDRESS,
    ) -> windows::core::Result<*mut OsdSharedBlock> {
        if view.Value.is_null() {
            let err = windows::core::Error::from_thread();
            let _ = CloseHandle(handle);
            return Err(err);
        }
        Ok(view.Value as *mut OsdSharedBlock)
    }

    /// Atomic view of the `seq` field (offset is fixed by `#[repr(C)]`).
    fn seq_atomic(&self) -> &AtomicU32 {
        // SAFETY: `ptr` is a valid, page-aligned mapping for the block's lifetime;
        // `seq` is a `u32` at a 4-aligned offset, shared with the peer process.
        unsafe { AtomicU32::from_ptr(std::ptr::addr_of_mut!((*self.ptr).seq)) }
    }

    /// Writer: publish an update under the seqlock. The closure receives the block
    /// to mutate; it must not touch `seq` (overwritten by the lock).
    pub fn write(&self, f: impl FnOnce(&mut OsdSharedBlock)) {
        let seq = self.seq_atomic();
        let start = seq.load(Ordering::Relaxed);
        seq.store(start.wrapping_add(1), Ordering::Release); // odd: write in progress
        // SAFETY: single writer; readers tolerate the in-progress window via seqlock.
        unsafe {
            f(&mut *self.ptr);
        }
        seq.store(start.wrapping_add(2), Ordering::Release); // even: published
    }

    /// Reader: take a tear-free snapshot. Capped retries so a writer that died
    /// mid-write (seq stuck odd) can never hang the game's render thread — after
    /// the cap we return the (possibly slightly torn) copy rather than spin.
    pub fn read(&self) -> OsdSharedBlock {
        let seq = self.seq_atomic();
        let mut copy = OsdSharedBlock::default();
        for _ in 0..16 {
            let s0 = seq.load(Ordering::Acquire);
            if s0 & 1 != 0 {
                std::hint::spin_loop();
                continue;
            }
            // SAFETY: volatile copy of the whole block; seqlock re-check guards tears.
            copy = unsafe { std::ptr::read_volatile(self.ptr) };
            if seq.load(Ordering::Acquire) == s0 {
                break;
            }
        }
        copy
    }
}

impl Drop for OsdShared {
    fn drop(&mut self) {
        unsafe {
            if !self.ptr.is_null() {
                let _ = UnmapViewOfFile(MEMORY_MAPPED_VIEW_ADDRESS {
                    Value: self.ptr as *mut _,
                });
            }
            let _ = CloseHandle(self.handle);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_through_shared_memory() {
        let writer = OsdShared::create().expect("create mapping");
        writer.write(|b| {
            b.enabled = 1;
            b.fps = 144.0;
            b.cpu_load = 37.5;
            b.set_custom_text("赛博朋克2077");
        });
        let reader = OsdShared::open().expect("open mapping");
        let snap = reader.read();
        assert!(snap.is_valid());
        assert_eq!(snap.enabled, 1);
        assert_eq!(snap.fps, 144.0);
        assert_eq!(snap.cpu_load, 37.5);
        assert_eq!(snap.custom_text_str(), "赛博朋克2077");
    }
}
