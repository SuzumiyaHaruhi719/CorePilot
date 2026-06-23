# Disk MFT Fast-Scan — Implementation Spec

Status: DRAFT (research + design phase; no code edits in this phase)
Branch / worktree: `mft-scan` @ `C:/Users/Thomas/Documents/Projects/CorePilot-mft`
Author: subagent (research synthesis)
Date: 2026-06-24
Relates to: `2026-06-23-disk-space-analyzer-design.md`, `2026-06-22-single-owner-sampler-design.md`,
`src-tauri/src/disk_scan.rs`

---

## 0. One-paragraph summary

`disk_scan.rs` currently builds its `Arc<DiskTree>` arena by a per-directory
`FindFirstFileExW` recursive walk. On a multi-million-file NTFS volume this is the
bottleneck vs WizTree / SpaceSniffer / Everything, which instead read the NTFS
**Master File Table ($MFT) directly** — one sequential bulk read of the table that
already holds every file's name, parent reference, logical size, and allocated
size. This spec adds a **new, optional fast path** that, for a fixed local NTFS
volume (admin/elevation permitting), enumerates all file records from the raw
`$MFT` `$DATA` runs, builds the **same arena `Node` tree** with identical size
semantics, and publishes through the **same `Arc<DiskTree>` channel** so the
frontend treemap is byte-for-byte unchanged. Any failure — non-NTFS, not
elevated, volume-handle / FSCTL error, parse anomaly — **cleanly falls back to the
existing `FindFirstFileExW` walk**. The MFT path is purely an optimization; it is
never the only path.

---

## 1. Research findings (concrete Win32 calls + structures)

All symbols below already exist in the pinned `windows = "0.62.2"` crate (verified
in the local registry). **No new crate dependency is required** — only two extra
cargo *features* on the existing `windows` dep (see §6).

### 1.1 Open the raw volume handle

```text
CreateFileW(r"\\.\C:", GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            None, OPEN_EXISTING, 0, None)
```

- Path form is `\\.\C:` (drive-relative device path), **not** `\\?\`. We already
  have the friendly drive letter via `resolve_walk_root` / the `ScanId`.
- Requires the process be **elevated (Administrator)**. Microsoft docs historically
  claimed `FILE_READ_ATTRIBUTES` suffices, but in practice the raw-read FSCTLs need
  `GENERIC_READ` (`FILE_READ_DATA`). Without elevation `CreateFileW` returns
  `ERROR_ACCESS_DENIED` → **fall back**.
- `windows::Win32::Storage::FileSystem::CreateFileW` (already used in `disk_scan.rs`).

### 1.2 Get the NTFS volume layout — `FSCTL_GET_NTFS_VOLUME_DATA`

```text
DeviceIoControl(hVol, FSCTL_GET_NTFS_VOLUME_DATA,
                None, 0,
                &mut NTFS_VOLUME_DATA_BUFFER, size_of, &mut bytesReturned, None)
```

- `FSCTL_GET_NTFS_VOLUME_DATA: u32 = 589924` (`windows::Win32::System::Ioctl`).
- Fills `NTFS_VOLUME_DATA_BUFFER` (`Win32::System::Ioctl`), **exact field layout
  verified in 0.62.2**:

  ```rust
  pub struct NTFS_VOLUME_DATA_BUFFER {
      pub VolumeSerialNumber: i64,
      pub NumberSectors: i64,
      pub TotalClusters: i64,
      pub FreeClusters: i64,
      pub TotalReserved: i64,
      pub BytesPerSector: u32,
      pub BytesPerCluster: u32,           // cluster size for alloc rounding
      pub BytesPerFileRecordSegment: u32, // size of ONE FILE record (usually 1024)
      pub ClustersPerFileRecordSegment: u32,
      pub MftValidDataLength: i64,        // $MFT size in bytes (record count = /BytesPerFileRecordSegment)
      pub MftStartLcn: i64,               // starting LCN of the $MFT
      pub Mft2StartLcn: i64,
      pub MftZoneStart: i64,
      pub MftZoneEnd: i64,
  }
  ```

- A non-NTFS volume makes this FSCTL fail (`ERROR_INVALID_FUNCTION` etc.) → **fall back**.
- `BytesPerCluster` here is the authoritative cluster size — replaces the
  `GetDiskFreeSpaceW`-derived `cluster_size()` used by the walk, and matches it.

### 1.3 Read the `$MFT` itself in bulk (the fast read)

The `$MFT` is itself file record **#0**. Two ways to read it:

1. **Read record #0, parse its `$DATA` (type 0x80) attribute's data runs, then
   sequentially read each run's clusters** off the volume handle (`SetFilePointerEx`
   + `ReadFile`, or `FSCTL_GET_RETRIEVAL_POINTERS` on a handle opened to `$MFT`).
   This is what WizTree/Everything do: a handful of large sequential reads covers
   the whole table. `RETRIEVAL_POINTERS_BUFFER` / `FSCTL_GET_RETRIEVAL_POINTERS`
   (`= 589939`) are present in 0.62.2 if we prefer the FSCTL route over hand-parsing
   record #0's runlist.
2. **`FSCTL_GET_NTFS_FILE_RECORD`** (`= 589928`) one record at a time — simpler but
   one DeviceIoControl per record (millions of syscalls); **rejected for v1** (too
   slow, defeats the purpose). Kept as a noted fallback-of-the-fallback only.

v1 uses approach **(1)**: seek the volume handle to `MftStartLcn * BytesPerCluster`
and read in large chunks (e.g. 1–4 MB), advancing per the `$MFT` `$DATA` runlist.
For simplicity and robustness, v1 MAY read record #0 to recover the full runlist,
**or** (simpler, slightly less robust on a heavily fragmented $MFT) open a handle to
`C:\$MFT` with backup semantics and use `FSCTL_GET_RETRIEVAL_POINTERS` to get the
extent list, then `ReadFile` the volume across those extents. Either yields the raw
record bytes; both are bounded by sequential disk bandwidth, not per-file syscalls.

### 1.4 Parse each FILE record

Each record is `BytesPerFileRecordSegment` bytes (typically 1024). Layout (NTFS
on-disk format, stable since NT 3.1; we hand-parse — no crate):

- **FILE record header** (`FILE_RECORD_SEGMENT_HEADER`):
  - magic `b"FILE"` (skip records that don't match — free/`BAAD`).
  - `UpdateSequenceArrayOffset` + `UpdateSequenceArraySize` → **fixup**: the USA
    overwrites the last 2 bytes of every 512-byte sector with a sequence number;
    we must restore the saved originals before trusting the record bytes.
  - `Flags`: bit0 = in-use (skip if not), bit1 = directory.
  - `FirstAttributeOffset` → start of the attribute list.
  - The record's own number = its MFT index (record N at byte `N * recordSize`).
- **Walk attributes** from `FirstAttributeOffset`; each attribute has a common
  header (`Type: u32`, `Length: u32`, `NonResident: u8`, `NameLength`, …) until
  `Type == 0xFFFFFFFF` (end marker). Attributes we read:
  - **`$FILE_NAME` (0x30)** — resident. Body = `FILE_NAME` struct:
    - `ParentDirectory: u64` — **parent file reference** (low 48 bits = parent MFT
      record number; high 16 = sequence). THIS is how we rebuild the tree.
    - `FileNameLength: u8`, `Namespace: u8` (0=POSIX,1=Win32,2=DOS,3=Win32&DOS),
      then `FileName: [u16; n]`. **Prefer the Win32 / Win32&DOS namespace name**;
      skip the DOS (8.3) short-name alias so a file isn't double-named. A record can
      hold several `$FILE_NAME`s (one per hardlink + the 8.3 alias).
    - `$FILE_NAME` also carries `AllocatedSize`/`RealSize` but they are **only
      updated lazily** — DO NOT trust them for size; use `$DATA` (below).
  - **`$DATA` (0x80)** — the unnamed default `$DATA` stream is the file size:
    - **Resident** (tiny files): logical size = attribute `ValueLength`; allocated
      size = round_to_cluster(ValueLength).
    - **Non-resident**: header carries `AllocatedSize` (on-disk footprint, already
      cluster-granular) and `DataSize`/`RealSize` (logical EOF). Use `DataSize` as
      logical, `AllocatedSize` as alloc. **Ignore named `$DATA` (ADS) streams** for
      the size that matches the existing walk (the walk's `WIN32_FIND_DATAW` size is
      the default stream only) — counting ADS would diverge from fallback parity.
  - **`$ATTRIBUTE_LIST` (0x20)** — present when a file's attributes don't fit one
    record (huge fragmentation / many hardlinks). v1 handling: if a record has an
    `$ATTRIBUTE_LIST`, the `$DATA` may live in another record. **v1 simplification:**
    read what's in the base record; if `$DATA` is missing because it was pushed to an
    extension record, treat size as 0 for that record (rare; bounded undercount).
    A note flags full `$ATTRIBUTE_LIST` resolution as a later refinement. (Acceptable
    because the FULL-volume total is dominated by ordinary files whose `$DATA` is in
    the base record; and the whole MFT path falls back if record parsing trips.)
  - **Reparse**: `FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT` (the `$STANDARD_
    INFORMATION` (0x10) attribute carries `FileAttributes`, or read it from the
    `$FILE_NAME` flags). Set `FLAG_REPARSE`; treat as a **leaf, do not descend**
    (identical to the walk).

### 1.5 Rebuild the directory tree from parent references

Two-pass, exactly the established scanner pattern:

1. **Pass 1 (sequential over the $MFT):** for each in-use record, extract
   `{ mft_no, parent_mft_no, name, is_dir, logical, alloc, flags }`. Store in a
   `Vec` indexed by `mft_no` (the MFT number is dense and bounded by
   `MftValidDataLength / recordSize`, so a flat `Vec<Option<RecordInfo>>` of that
   length is the natural, allocation-cheap container — mirrors the arena's flat
   `Vec` philosophy).
2. **Pass 2 (build arena):** the NTFS root directory is **MFT record #5**. Map each
   MFT number → arena `NodeId` and stitch `parent`/`first_child`/`next_sibling`
   using the existing intrusive-list append helpers. Intern names. Records whose
   parent chain doesn't terminate at #5 (orphans, `$Extend`, metafiles #0–#15) are
   either attached under a synthetic node or skipped (see §3.4).

### 1.6 Why NOT `FSCTL_ENUM_USN_DATA` for v1 (decision)

`FSCTL_ENUM_USN_DATA` (`= 590003`) + `MFT_ENUM_DATA_V0` is the "simple, no
raw-record-parsing" alternative: loop `DeviceIoControl`, walk `USN_RECORD_V2`s,
each carrying `FileReferenceNumber`, `ParentFileReferenceNumber`, `FileAttributes`,
`FileName`. It robustly gives the **tree shape** without NTFS on-disk parsing.

**But `USN_RECORD_V2` carries NO size field** (verified in 0.62.2 — fields are
`RecordLength, MajorVersion, MinorVersion, FileReferenceNumber,
ParentFileReferenceNumber, Usn, TimeStamp, Reason, SourceInfo, SecurityId,
FileAttributes, FileNameLength, FileNameOffset, FileName` — no size, no alloc). A
disk-space analyzer is **all about size**. Getting size from USN enum requires a
per-file `OpenFileById` + `GetFileInformationByHandleEx(FileStandardInfo)` — i.e.
millions of syscalls, which is exactly the per-file cost the MFT trick exists to
avoid. That makes USN-enum **no faster than (often slower than) the existing
`FindFirstFileExW` walk** for our use case, while adding code.

**Decision: v1 = raw `$MFT` `$DATA` parsing (approach §1.3(1)/§1.4).** It is the
only path that delivers both the tree AND both size metrics in one sequential bulk
read — the actual WizTree speedup. USN-enum is documented here and kept as a
*possible* future tree-only/incremental-refresh mechanism, not the v1 fast path.

### 1.7 Correctness parity facts the MFT path inherits

- **Allocated size**: non-resident `$DATA` `AllocatedSize` is already cluster-
  rounded by NTFS (and accounts for NTFS compression/sparse). For resident `$DATA`
  we round up to `BytesPerCluster`. Matches the walk's `round_to_cluster`.
- **Hardlinks**: a hardlinked file is **one MFT record** with multiple `$FILE_NAME`
  attributes (one per link). Because we key by MFT record number, the file's
  `$DATA` size is naturally counted **once** — the dedup is structural, no
  `seen_links` set needed. (We still set `FLAG_HARDLINK` when a record has >1 Win32
  `$FILE_NAME`.) This MATCHES the walk's `(VolumeSerial, FileIndex)` dedup intent.
- **Reparse points**: flagged leaf, not descended (parent links from a reparse
  target's records still point at the real parent dir, so junction loops can't
  occur in MFT space the way they do in path-walk space — another robustness win).

---

## 2. Where this plugs into `disk_scan.rs` (exact integration points)

The MFT path reuses, unchanged: `Node`, `DiskTree`, `Interner`, all `FLAG_*`,
`SENTINEL`, `NODE_CAP`, `TOP_N_PER_DIR`, `round_to_cluster`, `build_snapshot`,
`rollup`, `ScanHandle` + all its atomics, `publish`, the emitter thread, the
publisher thread, `SCANS`, and every Tauri command. The treemap, `disk_tree`,
`disk_top_items`, `disk-scan://progress`, cancel, node cap, truncation — all
untouched.

The ONLY new seam is **how the arena gets populated**: today `run_scan` seeds the
root + a `DirTask` and fans out `worker()`s. The MFT path is an **alternative arena
builder** invoked at the top of `run_scan` (or just before the worker fan-out):

```text
pub fn run_scan(handle, app):
    seed arena+queue+emitter (as today)
    spawn emitter thread (as today)
    if try_mft_build(&handle, &arena, &cluster_from_volume_data) == Ok(()):
        # arena now fully populated from the $MFT
        publish final snapshot; set Done/Cancelled; stop emitter; return
    else:
        # MFT unavailable/failed/partial → existing path, ZERO behavior change
        std::thread::scope { workers + publisher }   # current code, verbatim
        ... current finalize ...
```

`try_mft_build` returns `Err`/`false` for: non-NTFS, `CreateFileW \\.\C:` denied
(not elevated) or failed, `FSCTL_GET_NTFS_VOLUME_DATA` failed, any read/parse error,
or a sanity-check failure (see §3.5). On `Err` the arena must be **reset to just the
root node** (so a partial MFT fill doesn't pollute the fallback walk) before the
walk runs — or, cleaner, `try_mft_build` builds into a *local* arena and only swaps
it into the shared `Arena` on full success.

**Recommended structure:** put the whole MFT path in a new module
`src-tauri/src/disk_scan_mft.rs` (sibling of `disk_scan.rs`), exposing one function:

```rust
#[cfg(target_os = "windows")]
pub(crate) fn try_build_arena_from_mft(
    walk_root: &str,                 // "C:\\"
    file_system: &str,               // must be "NTFS" else early-return None
    cancel: &std::sync::atomic::AtomicBool,
    // progress hooks mirroring the walk's atomics:
    on_progress: &dyn Fn(MftProgress),     // files_seen/dirs_seen/bytes_* updates, throttled by caller
) -> Option<BuiltArena>;            // None = caller falls back to the walk
```

where `BuiltArena { nodes: Vec<Node>, names: Vec<Box<str>>, files_seen, dirs_seen,
bytes_logical, bytes_alloc, node_count, truncated }`. `disk_scan.rs` keeps the
`Node`/`DiskTree`/flag definitions public-in-crate so the new module reuses them.
This keeps the unsafe NTFS parsing isolated and the existing file's diff minimal
(just the `try_mft_build` branch in `run_scan` + `file_system` plumbed onto
`ScanHandle`).

`ScanHandle` needs the volume's `file_system` string to gate NTFS. Today
`run_scan` only has `walk_root`/`root_display`. **Add a `file_system: Box<str>`
field** to `ScanHandle` (populated in `disk_scan_start` from the same
`GetVolumeInformationW` the picker already calls, or re-query once in `run_scan`).
Small, additive.

---

## 3. Baked-in critical requirements

### 3.1 FALLBACK (the prime directive)

The MFT path is gated behind **every** of these, ANY failure → existing
`FindFirstFileExW` walk, scan never breaks:

1. `file_system != "NTFS"` (case-insensitive) → `None` before any handle open.
2. `CreateFileW(\\.\C:)` fails (ACCESS_DENIED when not elevated, or other) → `None`.
3. `FSCTL_GET_NTFS_VOLUME_DATA` fails or returns implausible layout → `None`.
4. Any `ReadFile` / seek / runlist parse error mid-build → `None` (drop the partial
   local arena).
5. A post-build **sanity check** fails (§3.5) → `None`.
6. `walk_root` is a volume-GUID path with no resolvable drive letter for the
   `\\.\X:` device form → v1 returns `None` (GUID-path raw open is a later
   refinement; the GUID-path case is rare and the walk handles it fine).

Implementation rule: `try_build_arena_from_mft` is **side-effect-free on the shared
state** until it has a *complete, sanity-checked* arena. It builds into a local
`Vec<Node>` + local interner and returns it whole, or returns `None`. The caller
only adopts a `Some(_)`. This guarantees a failed MFT attempt is indistinguishable
from "MFT path disabled" — the walk runs exactly as it does today.

### 3.2 Reparse points / hardlinks

- Reparse: `FILE_ATTRIBUTE_REPARSE_POINT` from `$STANDARD_INFORMATION` → set
  `FLAG_REPARSE`, treat as leaf, **never descend** (§1.7). Identical semantics to
  the walk's `recurse_dir = is_dir && !is_reparse`.
- Hardlinks: counted once structurally (one MFT record = one `$DATA`), set
  `FLAG_HARDLINK` when >1 Win32 `$FILE_NAME` (§1.7). The walk's `seen_links` dedup
  becomes unnecessary in MFT space but the OUTPUT (bytes counted once, flag set) is
  identical. **Parity note for verification:** total `bytes_alloc` from MFT must
  match the walk within hardlink/ADS rounding tolerance on a test volume.

### 3.3 Cancel + progress + cap parity

- **Cancel**: `try_build_arena_from_mft` polls the SAME `&AtomicBool` cancel
  (checked each MFT chunk read and periodically during pass-2 stitching). On
  cancel → return `None` *or* a partial-with-`truncated` arena? **Decision:** on
  cancel return `None` and let the caller finalize as `Cancelled` WITHOUT running
  the walk (caller checks `cancel` before falling back). I.e. fallback only happens
  for *capability* failures, not for user cancel. The `run_scan` branch:
  `if cancel → finalize Cancelled; elif mft Some → adopt; else → walk`.
- **Progress**: the same emitter thread already polls `ScanHandle`'s atomics on
  `PROGRESS_THROTTLE`. The MFT builder updates those atomics (`files_seen`,
  `bytes_logical`, `bytes_alloc`, `node_count`; `dirs_seen` as directory records are
  seen) as it goes, so the progress chip animates during a long MFT read with **zero
  emitter changes**. `current_path` can be set to a synthetic "(reading $MFT…)" then
  cleared, reusing `set_current_path`/the `Mutex<Arc<str>>`.
- **Snapshot publishing**: the MFT build is fast enough that v1 MAY publish only the
  final snapshot (the existing publisher thread still ticks and will publish the
  growing-then-final arena). For "real-time treemap during scan" parity, the builder
  populates the SHARED `Arena` incrementally under the same lock so the existing
  publisher thread snapshots it at ~2–4 Hz unchanged. **Decision:** build into a
  local arena for fallback safety (§3.1), but on success swap it into the shared
  `Arena` and let the normal publisher emit it. (A multi-second MFT read on a huge
  volume can optionally publish intermediate progress, but v1 keeps it simple:
  parse → swap → publish, mirroring the walk's final publish.)
- **Node cap / truncation**: enforce the SAME `NODE_CAP`. If the volume has more
  records than the cap, stop adding nodes, set `truncated`, mark the cutoff subtree
  `FLAG_AGGREGATED` — same contract as the walk. `TOP_N_PER_DIR` aggregation: apply
  the SAME top-N-leaves-per-directory fold in pass-2 so a directory with 100k files
  produces the same "(N more files)" aggregate node the walk produces. (Reuse
  `push_child_file` / `push_child_dir` / `push_aggregated` logic — factor the
  per-directory aggregation out of `worker()` so both paths call it, OR replicate it
  in pass-2. Prefer factoring to keep one source of truth.)

### 3.4 Metafiles / orphans

MFT records #0–#15 are NTFS metafiles (`$MFT`, `$MFTMirr`, `$LogFile`, `$Volume`,
`$AttrDef`, `.` (root #5), `$Bitmap`, `$Boot`, `$BadClus`, `$Secure`, `$UpCase`,
`$Extend`). WizTree surfaces these (their `$DATA` is real on-disk space — e.g.
`$LogFile`, `$Bitmap` can be large) under a synthetic node or under root. **v1
decision:** attach records whose parent resolves outside the visible tree (#0–#15
except #5, plus any orphan) under root as ordinary entries IF they carry a Win32
name and real `$DATA`; otherwise skip. This keeps the volume total honest (matches
WizTree, which famously accounts for `$MFT`/`$LogFile`) without inventing a special
UI. The reserved/system bytes the walk *misses* are exactly why MFT totals can
slightly EXCEED the walk — documented expected delta.

### 3.5 Sanity check before adopting the MFT arena (anti-corruption)

Before returning `Some(arena)`, verify:
- root (#5) node exists and is a directory;
- node_count > 1 and ≤ NODE_CAP (else truncated handling already applied);
- summed `bytes_alloc` ≤ volume `TotalClusters * BytesPerCluster` (a gross
  over-count signals a parse bug → `None`, fall back);
- no panic during parse (wrap the parse in a guard; any slice-out-of-bounds is a
  malformed record → that record skipped, not a crash; a *flood* of malformed
  records → `None`).

This makes a subtle NTFS-format parsing bug **degrade to the proven walk** rather
than ship a wrong tree.

---

## 4. File-level implementation plan

| # | File | Change |
|---|------|--------|
| 1 | `src-tauri/Cargo.toml` | Add features `"Win32_System_Ioctl"` (FSCTL consts + `NTFS_VOLUME_DATA_BUFFER`) and `"Win32_System_IO"` (`DeviceIoControl`) to the existing `windows` dep. **No new crate.** `Win32_Storage_FileSystem` is already enabled (`CreateFileW`, `SetFilePointer*`, `ReadFile`). |
| 2 | `src-tauri/src/disk_scan.rs` | (a) make `Node`, `DiskTree`, `Interner`, `FLAG_*`, `SENTINEL`, `NODE_CAP`, `TOP_N_PER_DIR`, `round_to_cluster` reachable from the new module (`pub(crate)` / move `round_to_cluster` out of `mod win`). (b) Add `file_system: Box<str>` to `ScanHandle` + `ScanHandle::new` + populate in `disk_scan_start`. (c) In `mod win::run_scan`, insert the `try_build_arena_from_mft` branch BEFORE the worker fan-out, with the `cancel / Some(adopt) / None(walk)` dispatch (§3.3). Factor per-directory top-N aggregation into a shared fn if practical. |
| 3 | `src-tauri/src/disk_scan_mft.rs` (NEW) | The entire MFT fast path, `#[cfg(target_os = "windows")]`: `try_build_arena_from_mft(...) -> Option<BuiltArena>`; volume open (`\\.\X:`), `FSCTL_GET_NTFS_VOLUME_DATA`, `$MFT` runlist acquisition (record #0 `$DATA` runlist OR `FSCTL_GET_RETRIEVAL_POINTERS` on a `C:\$MFT` handle), bulk `ReadFile` loop, FILE-record fixup + attribute walk (`$STANDARD_INFORMATION` 0x10, `$FILE_NAME` 0x30, `$DATA` 0x80), two-pass tree build with interner + flags + top-N/cap parity, sanity check. Non-Windows stub returns `None`. |
| 4 | `src-tauri/src/lib.rs` (or wherever modules are declared) | `mod disk_scan_mft;` declaration. |
| 5 | (verification) | `cargo check` (at `C:/Users/Thomas/.cargo/bin`) only — no `tauri build`, no app launch. |

### 4.1 Concrete symbols to import (all in `windows = 0.62.2`)

- `windows::Win32::Storage::FileSystem::{CreateFileW, ReadFile, SetFilePointerEx,
  GENERIC_READ, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
  FILE_FLAG_BACKUP_SEMANTICS, FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_DIRECTORY}`
- `windows::Win32::System::IO::DeviceIoControl`  *(needs `Win32_System_IO` feature)*
- `windows::Win32::System::Ioctl::{FSCTL_GET_NTFS_VOLUME_DATA (=589924),
  NTFS_VOLUME_DATA_BUFFER, FSCTL_GET_RETRIEVAL_POINTERS (=589939),
  RETRIEVAL_POINTERS_BUFFER}`  *(needs `Win32_System_Ioctl` feature)*
- `windows::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE,
  GetLastError, ERROR_ACCESS_DENIED}`
- NTFS on-disk structs (`FILE_RECORD_SEGMENT_HEADER`, attribute headers, `$FILE_NAME`,
  resident/non-resident `$DATA` headers) are **not** in the windows crate — define
  small `#[repr(C)]` parsing structs locally in `disk_scan_mft.rs` (read via byte
  offsets; no new dep). These are stable documented NTFS layouts.

---

## 5. Verification (build-only this phase; functional later)

- Phase gate now: **`cargo check`** in the worktree only (`C:/Users/Thomas/.cargo/bin/cargo`).
  Do NOT run `tauri build` / launch the elevated app (per project rules + MEMORY).
- Later (explicit ask + hardware): on the 9950X3D, compare an MFT scan vs a
  walk scan of the same NTFS volume — assert `bytes_alloc` parity within a small
  delta (MFT may exceed by metafile/`$MFT` bytes per §3.4), tree shape parity for
  user dirs, and a large speedup on `C:`. Confirm graceful fallback by running
  non-elevated (expect identical results via the walk) and on an exFAT/FAT volume.

---

## 6. Dependency justification

**No new crate.** The only `Cargo.toml` change is enabling two additional *features*
on the already-present `windows = "0.62.2"` dependency: `Win32_System_Ioctl`
(FSCTL constants + `NTFS_VOLUME_DATA_BUFFER`, verified present at lines 2541/3849 of
the crate's `Ioctl/mod.rs`) and `Win32_System_IO` (`DeviceIoControl`). The NTFS
on-disk record structs are hand-rolled `#[repr(C)]` locals (the format is fixed and
documented); pulling an `ntfs`/`mft` parsing crate would add a dependency for code
we can write in ~150 lines, and several such crates carry GPL/uncertain licenses
which violates the project's no-GPL-in-tree stance — so hand-rolling is also the
license-safe choice.

---

## 7. Open questions / deferred (noted, not v1 blockers)

- `$ATTRIBUTE_LIST` resolution for files whose `$DATA` spilled to an extension
  record (§1.4) — v1 undercounts these rare cases; full resolution is a refinement.
- Volume-GUID-path scan ids (no drive letter) — v1 MFT path returns `None` → walk.
- Incremental refresh via the USN journal (`FSCTL_READ_USN_JOURNAL`) for cheap
  rescans — a natural future feature now that the volume-handle plumbing exists.
- Optional intermediate snapshot publishing during a multi-second MFT read on very
  large volumes (v1 publishes final-only for simplicity).

---

## Sources

- [WizTree — The Fastest Disk Space Analyzer (MFT direct read)](https://www.diskanalyzer.com/)
- [FSCTL_GET_NTFS_VOLUME_DATA — Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ni-winioctl-fsctl_get_ntfs_volume_data)
- [FSCTL_GET_NTFS_FILE_RECORD — Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ni-winioctl-fsctl_get_ntfs_file_record)
- [Master File Table (Local File Systems) — Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/fileio/master-file-table)
- [FSCTL_ENUM_USN_DATA — Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ni-winioctl-fsctl_enum_usn_data)
- [MFT_ENUM_DATA_V0 — Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ns-winioctl-mft_enum_data_v0)
- [USN_RECORD_V2 — Microsoft Learn (no size field)](https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ns-winioctl-usn_record_v2)
- [Walking a Buffer of Change Journal Records — Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/fileio/walking-a-buffer-of-change-journal-records)
- [NTFSDirect (Volume.cs) — USN enum reference impl](https://github.com/rasberry/NTFSDirect/blob/master/Volume.cs)
