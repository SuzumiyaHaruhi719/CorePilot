//! Disk Space Analyzer — NTFS `$MFT` fast-scan path.
//!
//! See docs/superpowers/specs/2026-06-24-disk-mft-fastscan.md.
//!
//! This is an OPTIONAL optimization over `disk_scan.rs`'s per-directory
//! `FindFirstFileExW` recursive walk. On a multi-million-file NTFS volume the
//! walk is dominated by per-directory syscalls; WizTree / Everything instead read
//! the NTFS Master File Table (`$MFT`) directly — one sequential bulk read of the
//! table that already holds every file's name, parent reference, logical size and
//! allocated size — then rebuild the tree from parent references. This module does
//! exactly that and produces the SAME arena `Node` tree the walk produces, so the
//! frontend treemap is unchanged.
//!
//! FALLBACK IS THE PRIME DIRECTIVE. `try_build_arena_from_mft` is gated behind
//! every capability check (NTFS, elevation, FSCTL success, parse + sanity) and is
//! side-effect-free on the shared scan state until it has a complete,
//! sanity-checked arena: it builds into a LOCAL `Vec<Node>` + local interner and
//! returns it WHOLE, or returns `None`. The caller (`disk_scan::win::try_run_mft`)
//! only adopts a `Some(_)`; on `None` the proven `FindFirstFileExW` walk runs
//! verbatim. ANY failure — non-NTFS, not elevated, `CreateFileW` denied, FSCTL
//! error, `ReadFile`/runlist/record parse error, GUID-path id, or a post-build
//! sanity-check failure — yields `None`. The parse is panic-guarded so a malformed
//! record is skipped (not a crash) and a flood of malformed records degrades to
//! the walk. A USER cancel returns `None` too, but the caller distinguishes it
//! (it checks the cancel flag) and finalizes as `Cancelled` WITHOUT falling back.

#[cfg(target_os = "windows")]
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(target_os = "windows")]
use crate::disk_scan::{
    round_to_cluster, BuiltArena, Interner, Node, ScanHandle, FLAG_AGGREGATED, FLAG_HARDLINK,
    FLAG_IS_DIR, FLAG_REPARSE, FLAG_SYSTEM, NODE_CAP, SENTINEL, TOP_N_PER_DIR,
};

// =============================================================================
// Non-Windows stub — the MFT path is Windows/NTFS only.
// =============================================================================

#[cfg(not(target_os = "windows"))]
pub(crate) fn try_build_arena_from_mft(
    _walk_root: &str,
    _file_system: &str,
    _root_display: &str,
    _cancel: &std::sync::atomic::AtomicBool,
    _handle: &crate::disk_scan::ScanHandle,
) -> Option<crate::disk_scan::BuiltArena> {
    None
}

// =============================================================================
// Windows / NTFS implementation.
// =============================================================================

#[cfg(target_os = "windows")]
mod imp {
    use super::*;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, GENERIC_READ, HANDLE, INVALID_HANDLE_VALUE};
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, ReadFile, SetFilePointerEx, FILE_BEGIN, FILE_SHARE_READ, FILE_SHARE_WRITE,
        OPEN_EXISTING,
    };
    use windows::Win32::System::Ioctl::{FSCTL_GET_NTFS_VOLUME_DATA, NTFS_VOLUME_DATA_BUFFER};
    use windows::Win32::System::IO::DeviceIoControl;

    // NTFS on-disk constants (stable, documented format) ----------------------

    /// `b"FILE"` little-endian magic at the start of every FILE record.
    const FILE_MAGIC: u32 = 0x454C_4946; // 'F''I''L''E'
    /// FILE record `Flags`: bit0 = record in use.
    const FLAG_RECORD_IN_USE: u16 = 0x0001;
    /// FILE record `Flags`: bit1 = directory (has an `$INDEX_ROOT`).
    const FLAG_RECORD_IS_DIR: u16 = 0x0002;

    /// Attribute type codes.
    const ATTR_STANDARD_INFORMATION: u32 = 0x10;
    const ATTR_FILE_NAME: u32 = 0x30;
    const ATTR_DATA: u32 = 0x80;
    const ATTR_END: u32 = 0xFFFF_FFFF;

    /// `$FILE_NAME` namespaces. We prefer Win32/Win32&DOS names and skip the bare
    /// DOS (8.3) alias so a file isn't double-named.
    const NS_POSIX: u8 = 0;
    const NS_WIN32: u8 = 1;
    const NS_DOS: u8 = 2;
    const NS_WIN32_DOS: u8 = 3;

    /// `$STANDARD_INFORMATION` FileAttributes flags we care about.
    const FILE_ATTRIBUTE_SYSTEM: u32 = 0x0000_0004;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;

    /// MFT record number of the NTFS root directory.
    const ROOT_MFT: u64 = 5;
    /// MFT records #0..#15 are NTFS metafiles ($MFT, $LogFile, $Bitmap, …).
    const FIRST_USER_MFT: u64 = 16;

    /// Bulk-read chunk for the sequential `$MFT` read (records per chunk are
    /// `CHUNK_BYTES / record_size`). A handful of MB keeps few large reads.
    const CHUNK_BYTES: usize = 4 * 1024 * 1024;
    /// Poll cancel + republish progress every this many records during the read.
    const PROGRESS_EVERY: u64 = 50_000;
    /// Min gap between mid-scan animation snapshots (a cheap dir-only tree publish).
    /// Small enough that folders visibly appear + grow from ~½ s in; the front-end
    /// tween eases between frames so it reads as continuous fill.
    const PARTIAL_MS: u128 = 350;
    /// If more than this fraction of in-use records fail to parse, treat the parse
    /// as broken and fall back (sanity, spec §3.5).
    const MAX_BAD_RECORD_RATIO: f64 = 0.05;

    // Little-endian byte readers (bounds-checked; None on short slice) ---------

    #[inline]
    fn u16_at(b: &[u8], o: usize) -> Option<u16> {
        b.get(o..o + 2).map(|s| u16::from_le_bytes([s[0], s[1]]))
    }
    #[inline]
    fn u32_at(b: &[u8], o: usize) -> Option<u32> {
        b.get(o..o + 4)
            .map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
    }
    #[inline]
    fn u64_at(b: &[u8], o: usize) -> Option<u64> {
        b.get(o..o + 8).map(|s| {
            u64::from_le_bytes([s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]])
        })
    }

    /// One extracted file record (pass-1 output), indexed by MFT number.
    struct RecordInfo {
        parent_mft: u64,
        name: String,
        is_dir: bool,
        is_reparse: bool,
        is_system: bool,
        hardlink: bool,
        logical: u64,
        alloc: u64,
    }

    /// A `$MFT` `$DATA` extent: `start_lcn` cluster + `clusters` count. A sparse
    /// run (no LCN) is represented with `start_lcn = None`.
    struct Extent {
        start_lcn: Option<i64>,
        clusters: u64,
    }

    /// RAII wrapper closing a Win32 handle on drop.
    struct OwnedHandle(HANDLE);
    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            if self.0 != INVALID_HANDLE_VALUE {
                // SAFETY: self.0 came from CreateFileW and is closed once.
                let _ = unsafe { CloseHandle(self.0) };
            }
        }
    }

    /// UTF-16 NUL-terminated copy for `PCWSTR`.
    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Map a walk root ("C:\\" or a GUID path) to the `\\.\C:` device path. Only
    /// drive-letter roots are supported in v1; a GUID path returns `None` → walk.
    fn device_path(walk_root: &str) -> Option<String> {
        let b = walk_root.as_bytes();
        if b.len() >= 2 && b[1] == b':' && (b[0] as char).is_ascii_alphabetic() {
            Some(format!("\\\\.\\{}:", b[0] as char))
        } else {
            None
        }
    }

    /// Open the raw volume handle. Requires elevation; without it `CreateFileW`
    /// returns ACCESS_DENIED → `None` → caller falls back to the walk.
    fn open_volume(device: &str) -> Option<OwnedHandle> {
        let w = wide(device);
        // SAFETY: `w` is a NUL-terminated wide string; all out-params None.
        let h = unsafe {
            CreateFileW(
                PCWSTR(w.as_ptr()),
                GENERIC_READ.0,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                None,
                OPEN_EXISTING,
                Default::default(),
                None,
            )
        };
        match h {
            Ok(h) if h != INVALID_HANDLE_VALUE => Some(OwnedHandle(h)),
            _ => None,
        }
    }

    /// `FSCTL_GET_NTFS_VOLUME_DATA` → the volume layout. Fails on non-NTFS → None.
    fn ntfs_volume_data(h: HANDLE) -> Option<NTFS_VOLUME_DATA_BUFFER> {
        let mut out = NTFS_VOLUME_DATA_BUFFER::default();
        let mut returned = 0u32;
        // SAFETY: `out` is a valid, correctly-sized out-buffer for the FSCTL.
        let ok = unsafe {
            DeviceIoControl(
                h,
                FSCTL_GET_NTFS_VOLUME_DATA,
                None,
                0,
                Some(&mut out as *mut _ as *mut core::ffi::c_void),
                core::mem::size_of::<NTFS_VOLUME_DATA_BUFFER>() as u32,
                Some(&mut returned),
                None,
            )
        };
        ok.ok().map(|_| out)
    }

    /// Sequentially `ReadFile` `len` bytes starting at byte `offset` on the volume
    /// handle. Returns `false` on any short/failed read.
    fn read_at(h: HANDLE, offset: i64, buf: &mut [u8]) -> bool {
        // SAFETY: seek to an absolute byte offset on the raw volume.
        if unsafe { SetFilePointerEx(h, offset, None, FILE_BEGIN) }.is_err() {
            return false;
        }
        let mut filled = 0usize;
        while filled < buf.len() {
            let mut read = 0u32;
            // SAFETY: `buf[filled..]` is a live, correctly-sized slice.
            let ok = unsafe { ReadFile(h, Some(&mut buf[filled..]), Some(&mut read), None) };
            if ok.is_err() || read == 0 {
                return false;
            }
            filled += read as usize;
        }
        true
    }

    /// Apply the NTFS update-sequence-array fixup IN PLACE to a single record.
    /// The USA replaces the last 2 bytes of every `bytes_per_sector` sector with a
    /// sequence number; the originals live in the USA. We restore them. Returns
    /// `false` if the record's USN doesn't match every sector (corrupt / torn).
    fn apply_fixup(rec: &mut [u8], bytes_per_sector: usize) -> bool {
        let usa_off = match u16_at(rec, 0x04) {
            Some(v) => v as usize,
            None => return false,
        };
        let usa_count = match u16_at(rec, 0x06) {
            Some(v) => v as usize,
            None => return false,
        };
        if usa_count == 0 || bytes_per_sector == 0 {
            return false;
        }
        // First USA u16 is the check value; the remaining (usa_count-1) are the
        // saved originals, one per sector.
        let check = match u16_at(rec, usa_off) {
            Some(v) => v,
            None => return false,
        };
        let sectors = usa_count - 1;
        if rec.len() < sectors * bytes_per_sector {
            return false;
        }
        for i in 0..sectors {
            let sector_end = (i + 1) * bytes_per_sector;
            let tail = sector_end - 2;
            // The 2 bytes at the end of each sector must currently equal `check`.
            let cur = match u16_at(rec, tail) {
                Some(v) => v,
                None => return false,
            };
            if cur != check {
                return false;
            }
            let orig = match u16_at(rec, usa_off + 2 * (i + 1)) {
                Some(v) => v,
                None => return false,
            };
            let ob = orig.to_le_bytes();
            rec[tail] = ob[0];
            rec[tail + 1] = ob[1];
        }
        true
    }

    /// Parse a non-resident attribute's data-run list into extents. `runs` is the
    /// slice from the attribute's `DataRunsOffset` to the attribute end. Returns
    /// `None` on a malformed run header.
    fn parse_runs(runs: &[u8]) -> Option<Vec<Extent>> {
        let mut out = Vec::new();
        let mut i = 0usize;
        let mut prev_lcn: i64 = 0;
        while i < runs.len() {
            let header = runs[i];
            if header == 0 {
                break; // end of run list
            }
            i += 1;
            let len_bytes = (header & 0x0F) as usize;
            let off_bytes = (header >> 4) as usize;
            if len_bytes == 0 || len_bytes > 8 || off_bytes > 8 {
                return None;
            }
            // Run length (unsigned LE, len_bytes wide).
            if i + len_bytes > runs.len() {
                return None;
            }
            let mut length: u64 = 0;
            for j in 0..len_bytes {
                length |= (runs[i + j] as u64) << (8 * j);
            }
            i += len_bytes;
            // Run offset (SIGNED LE, off_bytes wide); 0 width = sparse run.
            let start_lcn = if off_bytes == 0 {
                None
            } else {
                if i + off_bytes > runs.len() {
                    return None;
                }
                let mut off: i64 = 0;
                for j in 0..off_bytes {
                    off |= (runs[i + j] as i64) << (8 * j);
                }
                // Sign-extend from the top byte.
                let shift = 64 - 8 * off_bytes as u32;
                off = (off << shift) >> shift;
                i += off_bytes;
                prev_lcn += off;
                Some(prev_lcn)
            };
            out.push(Extent {
                start_lcn,
                clusters: length,
            });
        }
        Some(out)
    }

    /// Extract the `$MFT`'s own `$DATA` extents from record #0 so we can read the
    /// whole table sequentially. Returns `None` if record #0 doesn't carry a
    /// non-resident `$DATA` (it always does on a real volume).
    fn mft_extents(rec: &[u8]) -> Option<Vec<Extent>> {
        let first_attr = u16_at(rec, 0x14)? as usize;
        let mut off = first_attr;
        while off + 4 <= rec.len() {
            let atype = u32_at(rec, off)?;
            if atype == ATTR_END {
                break;
            }
            let alen = u32_at(rec, off + 4)? as usize;
            if alen == 0 || off + alen > rec.len() {
                return None;
            }
            if atype == ATTR_DATA {
                let name_len = *rec.get(off + 9)?;
                let non_resident = *rec.get(off + 8)?;
                // The unnamed default $DATA stream is the table.
                if name_len == 0 && non_resident == 1 {
                    let runs_off = u16_at(rec, off + 0x20)? as usize;
                    let runs = rec.get(off + runs_off..off + alen)?;
                    return parse_runs(runs);
                }
            }
            off += alen;
        }
        None
    }

    /// Extract the unnamed (default) `$DATA` stream's (logical, alloc) bytes from a
    /// SINGLE record — but only the fragment that carries the real sizes: a
    /// resident value, or a non-resident header with `LowestVcn == 0` (the size
    /// fields are meaningful only there). `(0, 0)` if this record holds no
    /// size-bearing unnamed `$DATA`. Called for BASE *and* EXTENSION records so a
    /// fragmented file's size — which can live in an extension record reached via
    /// `$ATTRIBUTE_LIST` — is captured (the base-only read is what under-counted).
    fn unnamed_data_sizes(rec: &[u8]) -> (u64, u64) {
        let first_attr = match u16_at(rec, 0x14) {
            Some(v) => v as usize,
            None => return (0, 0),
        };
        let mut off = first_attr;
        while off + 4 <= rec.len() {
            let atype = match u32_at(rec, off) {
                Some(v) => v,
                None => break,
            };
            if atype == ATTR_END {
                break;
            }
            let alen = match u32_at(rec, off + 4) {
                Some(v) => v as usize,
                None => break,
            };
            if alen < 0x18 || off + alen > rec.len() {
                break;
            }
            if atype == ATTR_DATA && *rec.get(off + 9).unwrap_or(&0) == 0 {
                let non_resident = *rec.get(off + 8).unwrap_or(&0);
                if non_resident == 0 {
                    if let Some(vlen) = u32_at(rec, off + 0x10) {
                        return (vlen as u64, 0);
                    }
                } else if u64_at(rec, off + 0x10).unwrap_or(1) == 0 {
                    // LowestVcn == 0 fragment: AllocatedSize@0x28, DataSize@0x30.
                    let alloc = u64_at(rec, off + 0x28).unwrap_or(0);
                    let dsize = u64_at(rec, off + 0x30).unwrap_or(0);
                    return (dsize, alloc);
                }
            }
            off += alen;
        }
        (0, 0)
    }

    /// Parse ONE FILE record (already fixed-up) into a `RecordInfo`, or `None` if
    /// it's free / not a file / unparseable. Bounds-checked throughout (a bad
    /// offset yields `None`, never a panic).
    fn parse_record(rec: &[u8]) -> Option<RecordInfo> {
        if u32_at(rec, 0)? != FILE_MAGIC {
            return None;
        }
        let flags = u16_at(rec, 0x16)?;
        if flags & FLAG_RECORD_IN_USE == 0 {
            return None; // free record
        }
        let is_dir = flags & FLAG_RECORD_IS_DIR != 0;
        let first_attr = u16_at(rec, 0x14)? as usize;

        let mut parent_mft: Option<u64> = None;
        let mut name: Option<String> = None;
        let mut best_ns: u8 = 255; // lower namespace rank wins (Win32 over DOS)
        let mut win32_name_count: u32 = 0;
        let mut logical: u64 = 0;
        let mut alloc: u64 = 0;
        let mut have_data = false;
        let mut std_attrs: u32 = 0;

        let mut off = first_attr;
        while off + 4 <= rec.len() {
            let atype = u32_at(rec, off)?;
            if atype == ATTR_END {
                break;
            }
            let alen = u32_at(rec, off + 4)? as usize;
            if alen < 0x18 || off + alen > rec.len() {
                // A length that runs past the record is corrupt — stop walking.
                break;
            }
            let non_resident = *rec.get(off + 8)?;
            let name_len = *rec.get(off + 9)?;

            match atype {
                ATTR_STANDARD_INFORMATION => {
                    // Resident; FileAttributes at body offset 0x20.
                    let content_off = u16_at(rec, off + 0x14)? as usize;
                    if let Some(a) = u32_at(rec, off + content_off + 0x20) {
                        std_attrs = a;
                    }
                }
                ATTR_FILE_NAME => {
                    // Resident. Body = FILE_NAME struct.
                    let content_off = u16_at(rec, off + 0x14)? as usize;
                    let body = off + content_off;
                    let p = u64_at(rec, body)?;
                    let fn_len = *rec.get(body + 0x40)? as usize; // chars
                    let ns = *rec.get(body + 0x41)?;
                    // Decode the UTF-16 name.
                    let name_bytes = body + 0x42;
                    if name_bytes + fn_len * 2 <= rec.len() {
                        let mut units = Vec::with_capacity(fn_len);
                        for k in 0..fn_len {
                            units.push(u16_at(rec, name_bytes + k * 2)?);
                        }
                        let decoded = String::from_utf16_lossy(&units);
                        if ns == NS_WIN32 || ns == NS_WIN32_DOS {
                            win32_name_count += 1;
                        }
                        // Prefer Win32/Win32&DOS (rank 0) over POSIX (rank also
                        // acceptable) over bare DOS 8.3 alias (rank highest →
                        // skipped if anything better exists).
                        let rank = match ns {
                            NS_WIN32 | NS_WIN32_DOS => 0u8,
                            NS_POSIX => 1,
                            NS_DOS => 3,
                            _ => 2,
                        };
                        if rank < best_ns {
                            best_ns = rank;
                            name = Some(decoded);
                            parent_mft = Some(p & 0x0000_FFFF_FFFF_FFFF); // low 48 bits
                        }
                    }
                }
                ATTR_DATA => {
                    // Only the unnamed default $DATA stream is the file size; named
                    // $DATA (ADS) is ignored for walk parity.
                    if name_len == 0 {
                        if non_resident == 0 {
                            // Resident: logical = ValueLength at off+0x10.
                            let vlen = u32_at(rec, off + 0x10)? as u64;
                            logical = vlen;
                            have_data = true;
                        } else {
                            // Non-resident: AllocatedSize at off+0x28, DataSize at
                            // off+0x30.
                            let a_size = u64_at(rec, off + 0x28)?;
                            let d_size = u64_at(rec, off + 0x30)?;
                            logical = d_size;
                            alloc = a_size;
                            have_data = true;
                        }
                    }
                }
                _ => {}
            }
            off += alen;
        }

        // A record with no Win32/POSIX name is unusable for the tree (e.g. a pure
        // 8.3 alias-only entry shouldn't happen, but be defensive).
        let name = name?;
        let parent_mft = parent_mft?;
        let _ = have_data; // resident-less files legitimately have logical 0

        let is_reparse = std_attrs & FILE_ATTRIBUTE_REPARSE_POINT != 0;
        let is_system = std_attrs & FILE_ATTRIBUTE_SYSTEM != 0;

        Some(RecordInfo {
            parent_mft,
            name,
            is_dir,
            is_reparse,
            is_system,
            hardlink: win32_name_count > 1,
            logical,
            // alloc filled below by the caller (needs cluster size for resident).
            alloc,
        })
    }

    /// Build a cheap DIRECTORY-ONLY snapshot tree for a mid-scan animation frame:
    /// every directory reachable in `records[..max_mft]`, each carrying its OWN
    /// accumulated direct-file size from the running per-dir tallies (`own_*`), and
    /// NO individual file leaves. The caller (`ScanHandle::mft_publish_partial`)
    /// rolls subtree sizes up + publishes; the front-end LOD-slices to the visible
    /// top folders and the tween animates folders appearing + resizing as the read
    /// progresses. Kept SEPARATE from `build_arena` (the accurate final build) on
    /// purpose — the animation path must never be able to regress the accurate
    /// result. Sizes here are approximate (pre-$ATTRIBUTE_LIST-resolution, partial
    /// subtree); the final build replaces them exactly.
    fn build_dir_snapshot(
        records: &[Option<RecordInfo>],
        max_mft: u64,
        own_alloc: &[u64],
        own_logical: &[u64],
        own_files: &[u32],
        root_display: &str,
    ) -> (Vec<Node>, Vec<Box<str>>) {
        let n = records.len();
        let mut node_of: Vec<u32> = vec![SENTINEL; n];
        let mut nodes: Vec<Node> = Vec::new();
        let mut interner = Interner::new();
        let root_name = interner.intern(root_display);
        nodes.push(Node {
            parent: 0,
            name_id: root_name,
            first_child: SENTINEL,
            next_sibling: SENTINEL,
            logical_size: 0,
            alloc_size: 0,
            file_count: 0,
            flags: FLAG_IS_DIR,
        });
        node_of[ROOT_MFT as usize] = 0;

        // Build dir `mft` + its ancestor chain to root. Mirrors build_arena's
        // ensure_dir (incl. reparse parity) so the partial converges to the final.
        fn ensure_dir(
            mft: u64,
            records: &[Option<RecordInfo>],
            node_of: &mut [u32],
            nodes: &mut Vec<Node>,
            interner: &mut Interner,
            own_alloc: &[u64],
            own_logical: &[u64],
            own_files: &[u32],
        ) -> Option<u32> {
            match node_of.get(mft as usize) {
                Some(&id) if id != SENTINEL => return Some(id),
                Some(_) => {}
                None => return None,
            }
            let mut chain: Vec<u64> = Vec::new();
            let mut cur = mft;
            let mut guard = 0u32;
            loop {
                if cur == ROOT_MFT {
                    break;
                }
                match node_of.get(cur as usize) {
                    Some(&id) if id != SENTINEL => break,
                    Some(_) => {}
                    None => return None,
                }
                let rec = records.get(cur as usize)?.as_ref()?;
                if !rec.is_dir {
                    return None;
                }
                if cur != mft && rec.is_reparse {
                    return None;
                }
                chain.push(cur);
                cur = rec.parent_mft;
                guard += 1;
                if guard > 1 << 20 {
                    return None;
                }
            }
            let mut parent_id = if cur == ROOT_MFT { 0u32 } else { node_of[cur as usize] };
            for &dmft in chain.iter().rev() {
                if node_of[dmft as usize] != SENTINEL {
                    parent_id = node_of[dmft as usize];
                    continue;
                }
                if nodes.len() as u64 >= NODE_CAP {
                    return None;
                }
                let rec = records[dmft as usize].as_ref()?;
                let name_id = interner.intern(&rec.name);
                let id = nodes.len() as u32;
                let prev_first = nodes[parent_id as usize].first_child;
                let mut flags = FLAG_IS_DIR;
                if rec.is_reparse {
                    flags |= FLAG_REPARSE;
                }
                if rec.is_system {
                    flags |= FLAG_SYSTEM;
                }
                nodes.push(Node {
                    parent: parent_id,
                    name_id,
                    first_child: SENTINEL,
                    next_sibling: prev_first,
                    // Own size = this dir's direct-file tally (set here so we never
                    // need an O(max_mft) pass over ALL records per frame).
                    logical_size: own_logical.get(dmft as usize).copied().unwrap_or(0),
                    alloc_size: own_alloc.get(dmft as usize).copied().unwrap_or(0),
                    file_count: own_files.get(dmft as usize).copied().unwrap_or(0),
                    flags,
                });
                nodes[parent_id as usize].first_child = id;
                node_of[dmft as usize] = id;
                parent_id = id;
            }
            Some(node_of[mft as usize]).filter(|&v| v != SENTINEL)
        }

        let end = max_mft.min(n as u64);
        // Cap each mid-scan frame at a small node budget so it builds in ~tens of ms
        // even late in the scan (the uncapped ~1M-dir build was ~0.2 s, which made
        // frames arrive slowly + irregularly → a choppy fill). The biggest top-level
        // dirs have low MFT numbers so they're built first; deep/small dirs (not
        // visible at the overview scale) wait for the accurate final build. The
        // front-end LOD-slices this down to the visible tiles anyway.
        const PARTIAL_NODE_CAP: usize = 24000;
        for mft in FIRST_USER_MFT..end {
            if nodes.len() >= PARTIAL_NODE_CAP {
                break;
            }
            let Some(rec) = records.get(mft as usize).and_then(|r| r.as_ref()) else {
                continue;
            };
            if rec.is_dir {
                let _ = ensure_dir(
                    mft, records, &mut node_of, &mut nodes, &mut interner, own_alloc, own_logical,
                    own_files,
                );
            }
        }
        // Root's own size = files directly under the drive root.
        nodes[0].alloc_size = own_alloc.get(ROOT_MFT as usize).copied().unwrap_or(0);
        nodes[0].logical_size = own_logical.get(ROOT_MFT as usize).copied().unwrap_or(0);
        nodes[0].file_count = own_files.get(ROOT_MFT as usize).copied().unwrap_or(0);
        (nodes, interner.table)
    }

    /// The full MFT build. Returns `Some(BuiltArena)` on success, `None` for ANY
    /// capability/parse/sanity failure (→ caller runs the walk) OR user cancel
    /// (→ caller finalizes Cancelled). Side-effect-free on shared state except the
    /// progress atomics via `handle.mft_set_progress` (reset by the caller on a
    /// `None` return).
    pub(super) fn build(
        walk_root: &str,
        root_display: &str,
        cancel: &AtomicBool,
        handle: &ScanHandle,
    ) -> Option<BuiltArena> {
        // Gate: drive-letter roots only (GUID paths → walk, spec §3.1.6).
        let device = device_path(walk_root)?;
        let vol = open_volume(&device)?; // ACCESS_DENIED if not elevated → None
        let vdata = ntfs_volume_data(vol.0)?; // non-NTFS → None

        let bytes_per_cluster = vdata.BytesPerCluster as u64;
        let bytes_per_sector = vdata.BytesPerSector as usize;
        let rec_size = vdata.BytesPerFileRecordSegment as usize;
        let total_clusters = vdata.TotalClusters as u64;
        let mft_start = vdata.MftStartLcn;
        let mft_valid = vdata.MftValidDataLength as u64;

        // Plausibility gate on the layout (a wrong record size or absurd table
        // size signals a non-NTFS / corrupt response → walk).
        if rec_size == 0
            || rec_size > 64 * 1024
            || bytes_per_cluster == 0
            || bytes_per_sector == 0
            || rec_size % bytes_per_sector != 0
            || mft_valid == 0
        {
            return None;
        }
        let record_count = mft_valid / rec_size as u64;
        if record_count <= ROOT_MFT {
            return None;
        }

        // --- Read record #0 to recover the $MFT's own $DATA extents -----------
        let mut rec0 = vec![0u8; rec_size];
        if !read_at(vol.0, mft_start * bytes_per_cluster as i64, &mut rec0) {
            return None;
        }
        if !apply_fixup(&mut rec0, bytes_per_sector) {
            return None;
        }
        let extents = mft_extents(&rec0)?;
        if extents.is_empty() {
            return None;
        }

        // --- Pass 1: sequential bulk read + record parse ----------------------
        // Flat `Vec<Option<RecordInfo>>` indexed by MFT number (dense, bounded by
        // record_count) — mirrors the arena's flat-Vec philosophy.
        let cap = record_count as usize;
        let mut records: Vec<Option<RecordInfo>> = Vec::new();
        records.resize_with(cap, || None);
        // (logical, alloc) of the unnamed $DATA found IN each record — base AND
        // extension records alike.
        let mut ext_data: Vec<(u64, u64)> = vec![(0, 0); cap];
        // base MFT# → the unnamed VCN-0 $DATA size carried by one of its EXTENSION
        // records. A file fragmented enough to need an $ATTRIBUTE_LIST keeps its
        // size-bearing $DATA in an extension record, not its base; every extension
        // record points back to its base via BaseFileRecordSegment (header offset
        // 0x20), so we attribute its $DATA to that base — no attribute-list parsing,
        // and it covers BOTH resident and non-resident lists. Without this, those
        // files read size 0 and the volume under-totals (C: 2.06 → 3.5 TiB).
        let mut spilled_data: Vec<(u64, u64)> = vec![(0, 0); cap];

        let recs_per_chunk = (CHUNK_BYTES / rec_size).max(1);
        let chunk_bytes = recs_per_chunk * rec_size;
        let mut chunk = vec![0u8; chunk_bytes];

        let mut mft_index: u64 = 0; // running MFT record number
        let mut in_use_seen: u64 = 0;
        let mut bad_records: u64 = 0;
        let mut files_seen: u64 = 0;
        let mut dirs_seen: u64 = 0;
        let mut bytes_logical: u64 = 0;
        let mut bytes_alloc: u64 = 0;
        // Running per-dir tallies (indexed by MFT#) of DIRECT-child file sizes —
        // accumulated cheaply during the read so build_dir_snapshot can publish a
        // sized dir tree mid-scan for the fill animation, without placing files.
        let mut own_alloc: Vec<u64> = vec![0; cap];
        let mut own_logical: Vec<u64> = vec![0; cap];
        let mut own_files: Vec<u32> = vec![0; cap];
        let mut last_partial = std::time::Instant::now();

        // Walk each $DATA extent; skip sparse runs (holes in the table → those
        // record slots stay None). Read in `chunk_bytes` units.
        'extents: for ext in &extents {
            let Some(start_lcn) = ext.start_lcn else {
                // Sparse: advance the record index past the hole.
                mft_index += (ext.clusters * bytes_per_cluster) / rec_size as u64;
                continue;
            };
            let mut bytes_remaining = ext.clusters * bytes_per_cluster;
            let mut byte_pos = start_lcn * bytes_per_cluster as i64;
            while bytes_remaining > 0 {
                if cancel.load(Ordering::Relaxed) {
                    return None; // user cancel → caller finalizes Cancelled
                }
                let this = chunk_bytes.min(bytes_remaining as usize);
                // Trim to whole records.
                let this = (this / rec_size) * rec_size;
                if this == 0 {
                    break;
                }
                if !read_at(vol.0, byte_pos, &mut chunk[..this]) {
                    return None;
                }
                let mut r = 0;
                while r + rec_size <= this {
                    if mft_index as usize >= cap {
                        break 'extents;
                    }
                    // Fix up + parse the record IN PLACE in the chunk buffer — no
                    // per-record heap copy. On a big volume that copy was ~6M records
                    // × 1 KB ≈ 6 GB of needless alloc+memcpy. apply_fixup writes the
                    // record's USA bytes back into the chunk; the chunk is overwritten
                    // by the next read, so the in-place mutation is harmless.
                    let rec = &mut chunk[r..r + rec_size];
                    // Panic-guard the per-record parse: a malformed record must be
                    // skipped, never crash. A flood of them trips the sanity gate.
                    let parsed = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
                        if !apply_fixup(rec, bytes_per_sector) {
                            return (false, None, (0u64, 0u64), 0u64);
                        }
                        // Distinguish "free record" (None, not bad) from "in-use
                        // but unparseable" by re-checking the in-use flag.
                        let in_use = u16_at(rec, 0x16)
                            .map(|f| f & FLAG_RECORD_IN_USE != 0)
                            .unwrap_or(false);
                        let info = parse_record(rec);
                        // Capture this record's own unnamed $DATA size — for a base
                        // record it's the file's size; for an extension record it's
                        // the spilled fragment a fragmented file points to.
                        let data = unnamed_data_sizes(rec);
                        // BaseFileRecordSegment: 0 ⇒ this IS a base record; else the
                        // MFT# of the base this extension record belongs to.
                        let base_ref = u64_at(rec, 0x20).unwrap_or(0) & 0x0000_FFFF_FFFF_FFFF;
                        (in_use, info, data, base_ref)
                    }))
                    .unwrap_or((false, None, (0, 0), 0));

                    let (in_use, mut info, data, base_ref) = parsed;
                    if in_use {
                        if let Some(slot) = ext_data.get_mut(mft_index as usize) {
                            *slot = data;
                        }
                        // Extension record carrying a size-bearing $DATA → attribute
                        // that size to its base file (resolved after pass 1).
                        if base_ref != 0 && base_ref != mft_index && data != (0, 0) {
                            if let Some(slot) = spilled_data.get_mut(base_ref as usize) {
                                *slot = data;
                            }
                        }
                        in_use_seen += 1;
                        match info.as_mut() {
                            Some(ri) => {
                                // Resident $DATA: round logical up to a cluster for
                                // alloc (matches the walk's round_to_cluster). A
                                // non-resident $DATA already set alloc.
                                if ri.alloc == 0 && ri.logical > 0 {
                                    ri.alloc = round_to_cluster(ri.logical, bytes_per_cluster);
                                }
                                if ri.is_dir {
                                    dirs_seen += 1;
                                } else {
                                    files_seen += 1;
                                    bytes_logical =
                                        bytes_logical.saturating_add(ri.logical);
                                    bytes_alloc = bytes_alloc.saturating_add(ri.alloc);
                                    // Running per-dir tally for the animation frames.
                                    let p = ri.parent_mft as usize;
                                    if let Some(s) = own_alloc.get_mut(p) {
                                        *s = s.saturating_add(ri.alloc);
                                    }
                                    if let Some(s) = own_logical.get_mut(p) {
                                        *s = s.saturating_add(ri.logical);
                                    }
                                    if let Some(s) = own_files.get_mut(p) {
                                        *s = s.saturating_add(1);
                                    }
                                }
                                records[mft_index as usize] = info;
                            }
                            None => {
                                // In-use but no usable name/$DATA. Metafiles #0..#15
                                // legitimately may lack a Win32 name from our parse;
                                // don't count those as parse failures.
                                if mft_index >= FIRST_USER_MFT {
                                    bad_records += 1;
                                }
                            }
                        }
                    }

                    mft_index += 1;
                    r += rec_size;

                    if mft_index % PROGRESS_EVERY == 0 {
                        handle.mft_set_progress(
                            files_seen,
                            dirs_seen,
                            bytes_logical,
                            bytes_alloc,
                            (files_seen + dirs_seen).min(record_count),
                        );
                        // Throttled mid-scan animation frame: a cheap dir-only tree
                        // (own sizes from the running tallies) so the treemap fills
                        // in + resizes as folders are discovered. The full accurate
                        // build still lands at the end.
                        if last_partial.elapsed().as_millis() >= PARTIAL_MS {
                            let (pn, pnm) = build_dir_snapshot(
                                &records,
                                mft_index,
                                &own_alloc,
                                &own_logical,
                                &own_files,
                                root_display,
                            );
                            handle.mft_publish_partial(pn, pnm);
                            last_partial = std::time::Instant::now();
                        }
                    }
                }
                bytes_remaining -= this as u64;
                byte_pos += this as i64;
            }
        }

        // Sanity (spec §3.5): a flood of malformed in-use records → fall back.
        if in_use_seen == 0 {
            return None;
        }
        if (bad_records as f64) > (in_use_seen as f64) * MAX_BAD_RECORD_RATIO {
            return None;
        }
        // Root (#5) must be present and a directory.
        match records.get(ROOT_MFT as usize).and_then(|r| r.as_ref()) {
            Some(r) if r.is_dir => {}
            _ => return None,
        }

        // --- Resolve spilled $DATA sizes (the $ATTRIBUTE_LIST fix) ------------
        // A file fragmented enough to need an $ATTRIBUTE_LIST keeps its real size
        // in an EXTENSION record, so the base-record read above saw 0 — the cause
        // of the volume under-total (C: 2.06 TB via MFT vs 3.5 TB actual). Re-derive
        // each file's size from its own capture, else the size an extension record
        // attributed back to it (spilled_data), and recompute the byte totals.
        // files/dirs counts are unchanged (same record set).
        bytes_logical = 0;
        bytes_alloc = 0;
        for mft in 0..records.len() {
            let Some(ri) = records[mft].as_mut() else {
                continue;
            };
            if ri.is_dir {
                continue;
            }
            let (mut logical, mut alloc) = ext_data.get(mft).copied().unwrap_or((0, 0));
            if logical == 0 && alloc == 0 {
                if let Some(&(l, a)) = spilled_data.get(mft) {
                    logical = l;
                    alloc = a;
                }
            }
            ri.logical = logical;
            ri.alloc = if alloc > 0 {
                alloc
            } else if logical > 0 {
                round_to_cluster(logical, bytes_per_cluster)
            } else {
                0
            };
            bytes_logical = bytes_logical.saturating_add(ri.logical);
            bytes_alloc = bytes_alloc.saturating_add(ri.alloc);
        }

        // --- Pass 2: build the arena from parent references -------------------
        build_arena(
            records,
            root_display,
            cancel,
            handle,
            bytes_per_cluster,
            total_clusters,
            files_seen,
            dirs_seen,
            bytes_logical,
            bytes_alloc,
        )
    }

    /// Pass 2: stitch the flat records into the arena `Node` tree (root = #5),
    /// reusing the same intrusive `first_child`/`next_sibling` list, interner,
    /// flags, top-N-per-dir aggregation and node cap the walk uses. Returns the
    /// fully-built `BuiltArena` (own-sizes only; the caller rolls up), or `None`
    /// on cancel / sanity failure.
    #[allow(clippy::too_many_arguments)]
    fn build_arena(
        records: Vec<Option<RecordInfo>>,
        root_display: &str,
        cancel: &AtomicBool,
        handle: &ScanHandle,
        bytes_per_cluster: u64,
        total_clusters: u64,
        files_seen: u64,
        dirs_seen: u64,
        bytes_logical: u64,
        bytes_alloc: u64,
    ) -> Option<BuiltArena> {
        let n = records.len();

        // mft_no → arena NodeId for every DIRECTORY we will keep (files don't need
        // a mapping; they're terminal). u32::MAX == not yet assigned.
        let mut node_of: Vec<u32> = vec![SENTINEL; n];

        let mut nodes: Vec<Node> = Vec::new();
        let mut interner = Interner::new();

        // Root node 0 (display name e.g. "C:\\").
        let root_name = interner.intern(root_display);
        nodes.push(Node {
            parent: 0,
            name_id: root_name,
            first_child: SENTINEL,
            next_sibling: SENTINEL,
            logical_size: 0,
            alloc_size: 0,
            file_count: 0,
            flags: FLAG_IS_DIR,
        });
        node_of[ROOT_MFT as usize] = 0;
        let mut node_count: u64 = 1;
        let mut truncated = false;

        // Assign an arena node to a directory record, creating ancestor dir nodes
        // on demand by walking parent refs up to the root. Returns the NodeId, or
        // None if the chain doesn't terminate at root (orphan / outside tree) or
        // the cap is hit.
        fn ensure_dir(
            mft: u64,
            records: &[Option<RecordInfo>],
            node_of: &mut [u32],
            nodes: &mut Vec<Node>,
            interner: &mut Interner,
            node_count: &mut u64,
            truncated: &mut bool,
        ) -> Option<u32> {
            // Already assigned?
            if let Some(&id) = node_of.get(mft as usize) {
                if id != SENTINEL {
                    return Some(id);
                }
            } else {
                return None;
            }
            // Bounded recursion via an explicit stack to avoid deep call chains on
            // a long path; collect the ancestor chain until a mapped node/root.
            let mut chain: Vec<u64> = Vec::new();
            let mut cur = mft;
            let mut guard = 0u32;
            loop {
                if cur == ROOT_MFT {
                    break;
                }
                match node_of.get(cur as usize) {
                    Some(&id) if id != SENTINEL => break, // ancestor already built
                    Some(_) => {}
                    None => return None, // out of range
                }
                let rec = records.get(cur as usize)?.as_ref()?;
                if !rec.is_dir {
                    return None; // a file can't be an ancestor dir
                }
                // Reparse parity: a directory living UNDER a reparse point (a
                // strict ancestor is a reparse dir) is never descended into by the
                // walk, so don't build it here either (the reparse dir stays a
                // flagged leaf). `cur != mft` so the reparse dir itself is built.
                if cur != mft && rec.is_reparse {
                    return None;
                }
                chain.push(cur);
                cur = rec.parent_mft;
                guard += 1;
                if guard > 1 << 20 {
                    return None; // cyclic / pathological chain → bail (sanity)
                }
            }
            // `cur` is either ROOT_MFT (node 0) or an already-built ancestor.
            let mut parent_id = if cur == ROOT_MFT {
                0u32
            } else {
                node_of[cur as usize]
            };
            // Build top-down (chain is bottom-up, so reverse).
            for &dmft in chain.iter().rev() {
                if node_of[dmft as usize] != SENTINEL {
                    parent_id = node_of[dmft as usize];
                    continue;
                }
                if *node_count >= NODE_CAP {
                    *truncated = true;
                    return None;
                }
                let rec = records[dmft as usize].as_ref()?;
                let name_id = interner.intern(&rec.name);
                let id = nodes.len() as u32;
                let prev_first = nodes[parent_id as usize].first_child;
                let mut flags = FLAG_IS_DIR;
                if rec.is_reparse {
                    flags |= FLAG_REPARSE;
                }
                if rec.is_system {
                    flags |= FLAG_SYSTEM;
                }
                nodes.push(Node {
                    parent: parent_id,
                    name_id,
                    first_child: SENTINEL,
                    next_sibling: prev_first,
                    logical_size: 0,
                    alloc_size: 0,
                    file_count: 0,
                    flags,
                });
                nodes[parent_id as usize].first_child = id;
                node_of[dmft as usize] = id;
                *node_count += 1;
                parent_id = id;
            }
            Some(node_of[mft as usize]).filter(|&v| v != SENTINEL)
        }

        // First materialize every directory node (so files can attach to a parent
        // dir node that exists). A reparse-point directory is a flagged LEAF — we
        // still create its node but never descend INTO it; in MFT space children
        // of a reparse target point at the real parent dir, so nothing attaches
        // under it anyway. We simply skip building dirs whose parent chain passes
        // through a reparse dir is unnecessary — parent refs already avoid that.
        for mft in (FIRST_USER_MFT..n as u64).chain(std::iter::once(ROOT_MFT)) {
            if cancel.load(Ordering::Relaxed) {
                return None;
            }
            let Some(rec) = records.get(mft as usize).and_then(|r| r.as_ref()) else {
                continue;
            };
            if rec.is_dir {
                let _ = ensure_dir(
                    mft,
                    &records,
                    &mut node_of,
                    &mut nodes,
                    &mut interner,
                    &mut node_count,
                    &mut truncated,
                );
            }
        }

        // Now place files under their parent dirs, applying the SAME
        // top-N-per-dir aggregation the walk uses. Group file records by parent
        // NodeId, keep the N largest as real nodes, fold the rest into one
        // AGGREGATED "(M more files)" leaf — one source of truth for the contract.
        struct Leaf {
            name: String,
            logical: u64,
            alloc: u64,
            flags: u8,
        }
        use std::collections::HashMap;
        let mut by_parent: HashMap<u32, Vec<Leaf>> = HashMap::new();

        for mft in FIRST_USER_MFT..n as u64 {
            let Some(rec) = records.get(mft as usize).and_then(|r| r.as_ref()) else {
                continue;
            };
            if rec.is_dir {
                continue; // dirs already placed
            }
            // Resolve the parent directory's NodeId; if the parent dir wasn't
            // built (orphan / capped), drop the file (its bytes were already
            // counted in the totals — the tree may slightly under-place orphans,
            // same spirit as the walk skipping unreadable dirs).
            let parent_mft = rec.parent_mft;
            // Reparse parity (spec §1.7 / §3.2): a reparse-point directory is a
            // flagged LEAF, never descended — so files whose parent is a reparse
            // dir are NOT placed (matches the walk's `recurse_dir = is_dir &&
            // !is_reparse`). Their bytes already counted in the volume totals.
            if let Some(p) = records.get(parent_mft as usize).and_then(|r| r.as_ref()) {
                if p.is_reparse {
                    continue;
                }
            }
            let parent_id = if parent_mft == ROOT_MFT {
                0u32
            } else {
                match node_of.get(parent_mft as usize) {
                    Some(&id) if id != SENTINEL => id,
                    _ => continue,
                }
            };
            let mut flags = 0u8;
            if rec.is_reparse {
                flags |= FLAG_REPARSE;
            }
            if rec.is_system {
                flags |= FLAG_SYSTEM;
            }
            if rec.hardlink {
                flags |= FLAG_HARDLINK;
            }
            by_parent.entry(parent_id).or_default().push(Leaf {
                name: rec.name.clone(),
                logical: rec.logical,
                alloc: rec.alloc,
                flags,
            });
        }

        for (parent_id, mut leaves) in by_parent {
            if cancel.load(Ordering::Relaxed) {
                return None;
            }
            leaves.sort_unstable_by(|a, b| b.alloc.cmp(&a.alloc));
            let mut agg_files: u64 = 0;
            let mut agg_logical: u64 = 0;
            let mut agg_alloc: u64 = 0;
            for (idx, leaf) in leaves.into_iter().enumerate() {
                if idx < TOP_N_PER_DIR && node_count < NODE_CAP {
                    let name_id = interner.intern(&leaf.name);
                    let id = nodes.len() as u32;
                    let prev_first = nodes[parent_id as usize].first_child;
                    nodes.push(Node {
                        parent: parent_id,
                        name_id,
                        first_child: SENTINEL,
                        next_sibling: prev_first,
                        logical_size: leaf.logical,
                        alloc_size: leaf.alloc,
                        file_count: 1,
                        flags: leaf.flags,
                    });
                    nodes[parent_id as usize].first_child = id;
                    node_count += 1;
                } else {
                    if node_count >= NODE_CAP {
                        truncated = true;
                    }
                    agg_files += 1;
                    agg_logical += leaf.logical;
                    agg_alloc += leaf.alloc;
                }
            }
            if agg_files > 0 {
                let name = format!("({agg_files} more files)");
                let name_id = interner.intern(&name);
                let id = nodes.len() as u32;
                let prev_first = nodes[parent_id as usize].first_child;
                nodes.push(Node {
                    parent: parent_id,
                    name_id,
                    first_child: SENTINEL,
                    next_sibling: prev_first,
                    logical_size: agg_logical,
                    alloc_size: agg_alloc,
                    file_count: agg_files as u32,
                    flags: FLAG_AGGREGATED,
                });
                nodes[parent_id as usize].first_child = id;
                node_count += 1;
            }
        }

        // Final sanity (spec §3.5): summed alloc must not grossly exceed the
        // volume capacity (a parse bug double-counting would blow past this).
        let volume_bytes = total_clusters.saturating_mul(bytes_per_cluster);
        if volume_bytes > 0 && bytes_alloc > volume_bytes.saturating_mul(2) {
            return None;
        }
        if nodes.len() <= 1 {
            return None;
        }

        handle.mft_set_progress(
            files_seen,
            dirs_seen,
            bytes_logical,
            bytes_alloc,
            node_count,
        );

        Some(BuiltArena {
            nodes,
            names: interner.table.clone(),
            files_seen,
            dirs_seen,
            bytes_logical,
            bytes_alloc,
            node_count,
            truncated,
        })
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn try_build_arena_from_mft(
    walk_root: &str,
    file_system: &str,
    root_display: &str,
    cancel: &AtomicBool,
    handle: &ScanHandle,
) -> Option<BuiltArena> {
    // Capability gate (cheap, no handle): NTFS only. The caller already checks
    // this, but re-gate here so the module is self-contained.
    if !file_system.eq_ignore_ascii_case("NTFS") {
        return None;
    }
    // The whole unsafe path is panic-guarded at the top level too: a defect inside
    // the parser degrades to the proven walk rather than crashing the scan thread.
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        imp::build(walk_root, root_display, cancel, handle)
    }))
    .unwrap_or(None)
}
