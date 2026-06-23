# Disk Space Analyzer — Design Spec

- **Status:** Design (implementation-ready). Implementation is a separate, phased effort.
- **Date:** 2026-06-23
- **Branch:** `disk-analyzer`
- **Owner verification:** build-only (`npx tauri build`); hardware/functional validation is owner-driven.
- **Scope tag:** new main-nav tab `disk`, a from-scratch background scan engine, a Canvas treemap. No changes to existing tabs.

---

## 1. Overview, Goals, Non-Goals

### 1.1 Summary

A SpaceSniffer-style disk space analyzer, surfaced as a new main-nav tab (`disk`). The user picks one disk (single-click) or several disks (multi-select) and CorePilot scans them **concurrently** on background threads. Each scanned disk gets its own inner tab; the tab body renders a **squarified treemap** where every file/folder is a rectangle sized by its disk usage, with drill-down, labels, size coding, and live fill-in as the scan progresses.

The defining engineering constraint: a full-disk scan is millions of file-stat operations. It **MUST** run on dedicated background threads and publish progress + immutable tree snapshots via the exact single-owner pattern used by `src-tauri/src/sampler.rs` and `telemetry.rs`. Tauri commands stay O(1) (clone an `Arc`, flip an atomic). No shared lock is ever held across slow I/O. This rule is non-negotiable — violating it is the documented cause of 5+ prior app freezes (see `MEMORY.md`: sync-command freeze, NVML lock stall, PDH GPU-Engine bloat).

### 1.2 Goals

1. **One-disk scan** — pick a single volume, scan it, visualize it as a treemap.
2. **Concurrent multi-disk scan** — pick N volumes, scan them in parallel, one independent job each.
3. **Per-disk tabs** — switch between scanned disks instantly (O(1), no remount/recompute, scans keep running in the background).
4. **SpaceSniffer-style treemap** — nested rectangles sized by disk usage, drill-down, sizes/labels, color coding, live fill-in.
5. **Freeze-proof** — every command O(1); all scanning on background threads; no lock across I/O; progress + snapshots via events/snapshots.
6. **Bounded, cancelable, safe** — bounded memory with a hard node cap; cancel is instant and prompt; the scan is strictly read-only.
7. **No-downgrade** — existing tabs, animations, theming, and the GPU-budget escape hatches (`data-gpu-render`, `data-reduce-motion`) are untouched and respected.

### 1.3 Non-Goals (this design / v1 ship)

- **No destructive file operations in v1.** Ship **read-only** first: only *Reveal in Explorer* and *Open* (non-destructive). A guarded *Delete (to Recycle Bin)* is designed here but gated behind an explicit unlock and **deferred to a later phase** (Phase 7). This mirrors `amdTuningUnlocked` in `src/store/ui.ts`.
- **No NTFS MFT/USN fast-path in v1.** Direct MFT enumeration is 10–50× faster but is admin-only, NTFS-only, and high-complexity. Designed as an optional later phase (Phase 8), not v1.
- **No persistent scan cache in v1.** Scans are fresh, in-memory, session-only (matches the session-only ethos of `ui.ts`). A separate-file binary cache is sketched as a future option (Phase 8), explicitly **never** in `corepilot.store.json` (MEMORY: never bloat/hand-edit the live store).
- **No following of reparse points** (symlinks/junctions/mount points) by default — rendered as flagged leaf nodes. An opt-in "follow mount points" is a later toggle, not v1.
- **No network/removable-volume deep support** in v1 beyond listing+gracefully degrading.

---

## 2. Architecture — Backend Scan Engine

New Rust module: `src-tauri/src/disk_scan.rs`. Registered in `lib.rs` alongside the existing subsystems; commands added to the `invoke_handler`.

### 2.1 The single-owner pattern (mirrors `sampler.rs` / `telemetry.rs`)

The engine is a **multi-owner keyed registry** — the single-owner pattern extended to one owner *per disk*:

```rust
static SCANS: Lazy<DashMap<ScanId, Arc<ScanHandle>>> = Lazy::new(DashMap::new);
```

- `DashMap` (already a dependency, `Cargo.toml`) gives **per-key locking**: starting/cancelling/reading disk D never contends with disk C. We **never iterate the whole map while holding an entry lock**.
- `ScanId` is a stable per-disk key: the **volume GUID path** (`\\?\Volume{guid}\`) where available, falling back to the drive-letter root (`C:\`). Using the GUID makes a job stable across drive-letter remaps; the UI displays the friendly letter+label.
- Each scan runs on its **own dedicated, named `std::thread`** (`std::thread::Builder::new().name("corepilot-scan-C")`), **NOT** the Tauri `spawn_blocking` pool. A multi-million-file walk would monopolize blocking workers and starve the existing O(1) telemetry commands (`get_metrics`, `get_sensors`, `list_processes` all route through `spawn_blocking`). Dedicated threads are fully isolated from that pool.

### 2.2 `ScanHandle` (the per-disk owner)

```rust
pub struct ScanHandle {
    scan_id: ScanId,
    root_display: Box<str>,            // "C:\" for the UI
    status: AtomicU8,                  // ScanStatus enum
    cancel: Arc<AtomicBool>,           // flipped by cancel_scan; checked in the walk
    // progress atomics (cheap scalar reads for the O(1) status command):
    files_seen: AtomicU64,
    dirs_seen: AtomicU64,
    bytes_logical: AtomicU64,
    bytes_alloc: AtomicU64,
    skipped: AtomicU64,                // permission-denied / unreadable entries
    node_count: AtomicU64,             // for the memory cap
    started_at: Instant,
    current_path: Mutex<Arc<str>>,     // tiny: just the dir currently being walked
    snapshot: Mutex<Arc<DiskTree>>,    // pointer-swap publish channel (sampler.rs pattern)
    generation: AtomicU64,             // bumped on each snapshot swap
}

#[repr(u8)]
pub enum ScanStatus { Scanning = 0, Done = 1, Cancelled = 2, Error = 3 }
```

- `snapshot: Mutex<Arc<DiskTree>>` is the **exact `sampler.rs` `PROC_SNAPSHOT` contract**: readers clone the `Arc` in O(1); the lock is held **only** to swap the pointer, never across the walk.
- `cancel: Arc<AtomicBool>` is the **exact proven `fan_autotune` abort-flag pattern**.

### 2.3 The walk

- **Iterative, stack-based** (an explicit `Vec<DirTask>` work queue), **never recursive** — avoids stack overflow on pathologically deep trees.
- **Worker pool per scan:** the scan's owner thread fans out to a bounded set of worker threads. Disk I/O, not CPU, is the bottleneck, so the pool is small: `min(physical_cores, 8)` workers, capped. Oversubscription thrashes the queue, especially on HDDs.
- **Directory-granularity queue** (not per-file): workers pop a directory, enumerate its entries in one pass, push child directories back, and accumulate per-directory results. A `parking_lot::Mutex<Vec<DirTask>>` + `Condvar` is the dep-free queue (decision: hand-roll, no `crossbeam` — see §11). Contention is negligible at directory granularity.
- **Enumeration uses Win32 `FindFirstFileExW` + `FindExInfoBasic` + `FIND_FIRST_EX_LARGE_FETCH`** (`Win32_Storage_FileSystem` is already enabled in `Cargo.toml`). One syscall returns name, attributes, size, and reparse tag together — far fewer syscalls than `std::fs::read_dir` + per-entry `metadata()`. Paths are built as **wide strings, always `\\?\`-prefixed** (`\\?\UNC\` for shares) to defeat `MAX_PATH`.
- **Cancel is checked inside the entry-enumeration loop, not only per-directory** — a single directory with 1M entries must still cancel promptly. Workers also check it when popping the queue.

### 2.4 Size semantics

Capture **both** sizes per entry from the find data:

- **Logical size** — `nFileSizeHigh/Low` (apparent file size).
- **Allocation size** — cluster-rounded on-disk footprint ("what frees space"). Taken from the find data's allocation hint; for files flagged compressed/sparse we accept the find-data value in v1 (a `GetCompressedFileSizeW` fallback is a noted accuracy refinement, not v1 — see Risks).

**Default treemap metric = allocation size** (matches SpaceSniffer, answers "what frees space"). A toolbar `Segmented` toggles logical vs allocation. The toggle is **per-tab** (each disk can show a different metric independently).

### 2.5 Correctness defaults (baked in from day one)

1. **Reparse points** (`FILE_ATTRIBUTE_REPARSE_POINT`): read the tag; **do not recurse** into symlinks/junctions/mount-points (prevents loops + double-counting). Render as a flagged leaf "link" node. Opt-in following is post-v1.
2. **Hardlink dedup:** for files with `nNumberOfLinks > 1` only, open a handle for `BY_HANDLE_FILE_INFORMATION` and record `(VolumeSerial, FileIndexHigh/Low)` in a per-scan `dashmap` seen-set; count bytes once. Files with link count 1 (the vast majority) skip the extra handle entirely. A "skip dedup (fast)" mode is available if dedup I/O dominates.
3. **Permission-denied / sharing-violation:** catch per-entry/per-dir, increment `skipped`, attach an error flag to the node, **continue** — never abort the scan.
4. **Hidden/system files:** included by default but flagged so the UI can dim/filter them.
5. **Drive removed/unmounted mid-scan** (USB eject): the walker hits a burst of I/O errors → transition that handle to `Error` cleanly, stop its threads, surface "drive disconnected", and **leave all other concurrent scans alive**.
6. **Never panic:** lossy path handling, per-entry `catch`/`continue`. One bad entry never aborts the scan (the sampler's "degrade, don't die" discipline).

### 2.6 Data model — the arena tree (memory-bounded)

The tree is a **flat `Vec<Node>` arena indexed by `u32 NodeId`** — never `Box`/`Rc`/`Arc` per node (pointer-chasing + per-alloc overhead blows up at 10M nodes).

```rust
struct Node {
    parent: u32,         // NodeId of parent (self for root)
    name_id: u32,        // index into the interned-name table
    first_child: u32,    // NodeId or SENTINEL
    next_sibling: u32,   // NodeId or SENTINEL
    logical_size: u64,   // subtree-aggregated at publish time for dirs; own size for files
    alloc_size: u64,
    file_count: u32,     // files in subtree (dirs) or 1 (files)
    flags: u8,           // bit flags: IS_DIR | REPARSE | DENIED | HIDDEN | SYSTEM | HARDLINK | AGGREGATED
}
```

≈ 32 bytes/node → **10M nodes ≈ 320 MB**. Bounded and acceptable.

- **Name interning:** path components are interned in a `Vec<Box<str>>` + `HashMap<Box<str>, u32>`. Millions of repeated names (`node_modules`, `.git`, `.dll`) cost one copy. (Hand-rolled interner — no new dep.)
- **No per-node full paths.** A node's absolute path is reconstructed on demand by walking `parent` links (cheap; only the handful of nodes the UI drills into or selects need it).
- **Aggregated subtree sizes** roll **up** at publish time (or incrementally as directories complete), so a published snapshot is always internally consistent (sizes grow monotonically across snapshots).
- **Long-tail aggregation at the source:** the engine does **not** keep an individual node for every tiny file. Within a directory it keeps the **top-N largest files** (e.g. 32) as real nodes and folds the rest into one synthetic `AGGREGATED` "(other M files, X)" leaf. This is the single biggest memory and IPC win — a `node_modules` with 40k tiny files becomes ~33 nodes, not 40k.

### 2.7 Memory cap + truncation UX

- **Hard node cap** (default ~20M nodes ≈ 640 MB; tunable constant). When `node_count` crosses the cap, the scan **stops descending into new directories**, marks the deepest unscanned dirs as `AGGREGATED`/truncated, sets a `truncated` flag on the handle, and finishes cleanly with what it has — **never OOM**.
- The UI shows a "scan truncated — N items beyond the size/depth limit were aggregated" banner. Combined with §2.6 top-N aggregation, real C: drives stay well under the cap in practice; the cap is the backstop, not the common path.

### 2.8 Snapshot cadence & publishing (the freeze-proof core)

Two channels, exactly as the codebase does it:

1. **Throttled scalar progress event** — `disk-scan://progress`, emitted via `app.emit` (the `perf_recorder.rs:343` pattern), **at most ~4–10 Hz** (throttle in Rust: emit only if >100–250 ms elapsed AND counters changed). Payload is **scalars only, never the tree**:
   ```ts
   { scanId, status, filesSeen, dirsSeen, bytesAlloc, bytesLogical,
     skipped, currentPath, generation, truncated }
   ```
   Multi-disk scans multiply event volume (4 disks × 4 Hz = 16/s); coalesce on the frontend (§4.4). If it ever floods, raise the per-job throttle.

2. **`Arc<DiskTree>` pointer-swap** — the scan thread rebuilds/copies-on-publish an immutable `DiskTree` and swaps it under the handle's `Mutex` ~**2–4 Hz** during scanning and **once on completion**, bumping `generation`. To avoid an O(N) re-walk every tick, size roll-up is **incremental** (each completed directory bubbles its delta up the `parent` spine), and the publish copies only the dirty spine plus appends, not the whole arena. (If incremental proves fiddly, the fallback is: cheap top-level aggregate during scan, full detail snapshot only on completion — see Risks.)

The frontend **pulls** the tree via an O(1) command; it is **never pushed** over events. This is the sampler pull model.

### 2.9 Tauri command surface (all O(1) / non-blocking)

| Command | Signature | Behavior |
|---|---|---|
| `disk_list_volumes` | `() -> Vec<VolumeInfo>` | Enumerate fixed drives + label/filesystem/total/free via Win32. Cheap; may use a short-lived cache. |
| `disk_scan_start` | `(scan_ids: Vec<ScanId>) -> Vec<ScanId>` | Insert handles, spawn one owner thread per disk, return the keys. Returns immediately. |
| `disk_scan_cancel` | `(scan_id: ScanId) -> ()` | Flip the `cancel` atomic. O(1). |
| `disk_scan_rescan` | `(scan_id: ScanId) -> ()` | Cancel-if-running, reset, respawn. O(1) from the caller's view. |
| `disk_scan_close` | `(scan_id: ScanId) -> ()` | Cancel + remove from `SCANS` → drops the `Arc<DiskTree>`, freeing the tree. O(1). |
| `disk_scan_status` | `(scan_id: ScanId) -> ScanProgress` | Read the atomics. O(1). (Event is the live channel; this is for cold reads / reconnect.) |
| `disk_tree` | `(scan_id, focus_path: Option<String>, depth_limit: u8, min_bytes: u64, max_nodes: u32) -> TreeView` | Clone the `Arc`, slice to the focused subtree, apply LOD (collapse children below `min_bytes` into a synthetic node, cap depth + node count). Returns a **bounded** view so a huge tree never crosses IPC whole. |
| `disk_top_items` | `(scan_id, focus_path: Option<String>, n: u32) -> Vec<ItemRow>` | Top-N largest files/folders in (sub)tree — the "what's eating my space" flat list. |
| `disk_reveal` | `(scan_id, node_path: String) -> ()` | Reuse the existing guarded `reveal_in_explorer` command path; validate the path resolves under the scanned root. |
| *(Phase 7, gated)* `disk_delete` | `(scan_id, node_path: String, to_recycle: bool) -> DeleteResult` | See §6.3. Deferred. |

`disk_tree` is the workhorse: **the backend does the LOD slicing**, so the rendered set is bounded **regardless of total tree size**. Drill-down = re-call `disk_tree` with a new `focus_path`.

### 2.10 Concurrency policy across disks

- Each selected disk = one owner thread + its own small worker pool → genuine parallelism (requirement 2).
- **Global walker budget:** a process-wide permit counter (a `parking_lot` `Mutex<usize>` + `Condvar`, or `tokio::sync::Semaphore` which is already available) caps **total** concurrent walker threads across all jobs (hard cap ~6) so 4 concurrent HDD scans don't thrash the I/O subsystem into a stall. Each worker acquires a permit before descending.
- **v1 simplification:** a flat global cap. Mapping partitions→physical disks (so two partitions on one HDD share a budget while two SSDs run free) is a noted refinement (Open Question), not v1.

---

## 3. Treemap Visualization

### 3.1 Render technology — Canvas 2D (decided)

A single full-tab `<canvas>` element, retina-scaled via `devicePixelRatio`. **Not SVG, not WebGL/regl.**

- **SVG is disqualified:** 100k+ `<rect>`/`<text>` = 100k+ live DOM nodes; WebView2/Chromium chokes on layout/paint/hit-test, and it would re-create the documented **DWM-GPU / `nvlddmkm` DPC input-lag storm** (MEMORY: claude-monitor box-shadow). `index.css` even ships a `data-gpu-render=false` mode that strips blur/orbs to spare the GPU while gaming — a compositor-pegging tab would defeat that escape hatch.
- **WebGL/regl is unjustified:** a heavy new dep with painful text rendering, and the win only matters past ~500k visible rects — which LOD guarantees we never draw.
- **Canvas 2D fits:** after LOD culling we draw at most ~2–4k rectangles per frame (a 1080p tab is ~2M px; nothing below ~16px² is drawn, so the visible ceiling is naturally a few thousand). A few thousand `fillRect` + `strokeRect` + a handful of `fillText` is sub-1ms; 60fps is trivial. `uplot` already proves the project is comfortable with imperative canvas inside a sized React wrapper.

### 3.2 Layout — squarified treemap

- Algorithm: **squarified treemap (Bruls/Huizing/van Wijk)** — keeps rectangles near 1:1 aspect (SpaceSniffer's look), which also makes labels readable and hit-testing stable.
- Implemented in a **pure, memoized TS module** `src/tabs/disk/treemap/layout.ts`. Layout runs **only** on: drill (zoom-root change), tab resize, or an accepted streaming snapshot — **never on the React render path** (mirrors `uplot`'s imperative drawing).
- Input is the `TreeView` for the **currently-zoomed container only** (sliced + LOD'd by `disk_tree`). We lay out one container's children into its pixel rect and recurse only into child rects that survive the threshold — typically 2–4 nested levels before rects get too small.
- Each container is padded ~1px and reserves a ~16px top **label strip** so the parent name reads and children nest visibly (SpaceSniffer's framed-folder look). Children sorted by size desc before squarifying.
- Output is a **flat array** of draw-rects `{ nodeId, x, y, w, h, depth, color }` that the canvas iterates once per frame.

### 3.3 Level-of-detail / aggregation

Two LOD layers, server + client:

- **Server (`disk_tree`):** depth cap, `min_bytes` collapse, and `max_nodes` cap — plus the source-level top-N aggregation from §2.6. The view crossing IPC is already small.
- **Client (layout):** stop recursing into a child once its rect short-side falls below `MIN_SUBDIVIDE` (~24px) → draw as a solid leaf block. Within any container, collapse remaining children whose rects would each be `< MIN_RECT` (~3px) into one synthetic muted **"… N more (X GB)"** tile. A hard `MAX_DRAW_RECTS` (~4000); if a layout would exceed it, raise `MIN_RECT` adaptively until under cap → **bounded frame budget regardless of fan-out**.
- Clicking a "… N more" tile re-lays-out just that bucket as its own treemap (stays SpaceSniffer-style; no separate list component required — the flat list lives in the detail panel instead).

### 3.4 Drill-down / zoom

- **Click a folder rect** → push it as the zoom root onto a per-tab breadcrumb path; re-call `disk_tree(focus_path)` and re-layout to fill the canvas. **Click a file** → select + populate the detail panel (no zoom).
- **Breadcrumb bar** above the canvas (`Root › Users › Thomas › … current`), each segment clickable to ascend. `Backspace` / a back button / right-click pops one level.
- Zoom transition is a **one-shot ~220ms Motion canvas tween** (source rect expands to fill) using `var(--ease-out-quint)`, **gated by `html[data-reduce-motion]`** (the app's in-app reduce-motion flag). **Never a continuous animation.** The canvas stays **out of any Motion `layout`-animated container** to avoid the documented stale-`boxShadow` glow quirk (MEMORY: group glow).

### 3.5 Color coding (theme-native)

Reuse the existing `@theme` tokens in `index.css` — **no new palette**. Colors are read from CSS custom properties via `getComputedStyle` at layout time, cached per draw-rect, and **re-read on theme/theme-style change** (the app already drives `data-theme` / `data-theme-style` on `<html>` and emits theme changes), so the treemap auto-retints across graphite/cyberpunk/midnight/light for free.

- **Default mode "by type":** extension classes → existing signal hues — code/text → `--color-accent`, images → `--color-cyan`, video/archives → `--color-vcache`, executables/system → `--color-freq` (amber), folders → neutral `--color-surface2/3` frames, other → `--color-dim`. A small legend + a `Segmented` switches scheme.
- **Alt mode "by depth":** oklch lightness ramp off `--color-accent` (SpaceSniffer's nested-shade look; cheapest, most theme-portable).
- **(optional) "by age":** last-modified ramp.
- Selected rect → accent ring/glow vocabulary; hovered rect → lighten + 1px accent stroke (drawn on an overlay pass, never a relayout).

### 3.6 Labels

- Draw **name** (+ **size** on a second line) only above a legibility threshold (~`w>54 && h>30`); size-only when medium; nothing when small. Ellipsize to width.
- Sizes use an explicit **monospace font + manual tabular alignment** (the project's `.nums` convention — canvas ignores CSS font-features, so it's set explicitly); names use Inter. Folder names go in the reserved top strip; large leaves show centered name+size.
- **i18n:** every canvas-drawn string is funneled through `t()`/`tf(zh,en)` explicitly (the DOM i18n walker can't see canvas text — MEMORY: CorePilot i18n). Size/percent strings use `tf(zh,en)`.

### 3.7 Hover + selection

- Hit-test is O(visible) over the flat draw-rect array (a coarse spatial grid is the fallback only if a dense folder needs it). `pointermove` → find rect → an HTML `.glass` tooltip (absolutely-positioned div following the cursor) showing full path, exact bytes + human size, %-of-parent, file count.
- Selection persists in per-tab state and drives the side detail panel.

### 3.8 Streaming updates (live fill-in)

- The frontend keeps the **latest snapshot generation in a ref** and recomputes layout on a **rAF/throttle (~4–6 Hz)** — a fast scan can't thrash relayout. Between relayouts, each rect's `w/h` is **interpolated toward its new target** over a couple of frames, so folders visibly **grow** as the scan fills in (SpaceSniffer's live feel) without a full relayout per frame.
- A **"pause live updates"** toggle freezes relayout (sizes can visually jump during rapid early growth; pausing gives a stable view).
- **Inactive tabs pause their rAF loop** entirely while their backend scan keeps running.

---

## 4. UI / Nav Integration

### 4.1 Nav entry

- `src/store/ui.ts`: extend `TabId` with `"disk"`.
- `src/App.tsx`: add `disk: DiskAnalyzer` to the `TABS` map; import `DiskAnalyzer` from `src/tabs/DiskAnalyzer.tsx`.
- `src/components/shell/NavRail.tsx`: add `{ id: "disk", label: "存储分析", icon: HardDrive }` to `ITEMS`, slotted **after `optimize`, before `settings`** (`HardDrive` from `lucide-react`).
- i18n: dict entry `存储分析 → "Disk"` (or "Storage") plus the analyzer's static strings; interpolated size/percent strings via `tf(zh,en)`.
- **No-downgrade check:** this adds exactly one rail item. The rail already scrolls on short viewports (`overflow-y-auto`, `min-h-0`); verify the active pill still fits without clipping at ~10 items.

### 4.2 Three-zone screen, inside the standard `TabHeader` shell

Built almost entirely from existing primitives (`Button`, `Segmented`, `SecondaryTabs`, `Modal`, `TabHeader`) so only the treemap is bespoke → zero downgrade.

**Zone A — Disk picker (landing, when no scan active):** a vertical list of volume rows, each a glass card (`border border-line bg-surface2 rounded-xl`) showing drive letter + label, model/filesystem, total/used/free, and a usage bar (reuse PerfView bar styling; warn-tint when >85% full). A leading checkbox enables **multi-select**; a primary `grad-accent` **"扫描 / Scan"** button scans all checked disks concurrently. **Single-click on a row body** scans just that one disk. Unsupported volumes (network, BitLocker-locked) are greyed/disabled.

**Zone B — Per-disk tab strip (once ≥1 scan exists):** the existing **`SecondaryTabs`** (`layoutId="disk-sec"`), one inner tab per scanning/scanned disk. Tab label = `C:` + a tiny progress ring/% while scanning, check/total size when done. A leading **"+"** reopens the picker as a `Modal` to add disks. Switching inner tabs is **O(1)** — just swaps which snapshot the canvas reads (scans keep running). The inner tab strip must **not** remount-on-switch (per-tab state lives in the store, §4.3), unlike the main-nav `AnimatePresence mode="wait"` which is fine because it remounts only the outer tab.

**Zone C — Workspace:** treemap canvas (left, ~70%) + side detail panel (right, ~30%), with the toolbar in `TabHeader.actions` plus a thin bar above the canvas.

### 4.3 Frontend state — `src/store/diskScan.ts` (new zustand store)

Mirrors the backend registry: `Map<ScanId, PerDiskView>` where:

```ts
interface PerDiskView {
  status; progress;                 // fed by the disk-scan://progress event
  generation;                       // last seen snapshot generation
  treeView;                         // last fetched TreeView for the current focus
  breadcrumb: string[];             // drill path (focus_path stack)
  selection?: NodeRef;
  metric: "alloc" | "logical";      // per-tab
  colorMode: "type" | "depth" | "age";
  paused: boolean;
}
```

Per-tab view-state (tree + drill viewport + selection + scroll) lives **per disk in this store**, so switching tabs is a pure store read — **instant, no remount, no recompute, no lost drill state**. Session-only (matches `ui.ts`); no persistence in v1.

### 4.4 Event + poll wiring

- **One app-level listener** for `disk-scan://progress` (ref-counted singleton like `useSharedTelemetry.ts`), using the project's **mount-race-guarded `listen()`** pattern from `usePerfRecorder.ts`:
  `void listen<T>("disk-scan://progress").then(fn => mounted ? unlisten = fn : fn())`.
  It updates per-disk progress in the store. **Coalesce** updates on a trailing ~16ms tick (like `App.tsx`'s `osd:cfg` emitter) so high-frequency progress can't churn React renders into janking the very canvas it drives.
- **Only the ACTIVE inner tab polls `disk_tree`** (~1–4 Hz, backpressured like `makePoller` in `useSharedTelemetry.ts`) to refresh its `TreeView` on a new `generation`. Background tabs rely on the progress event + their last snapshot. Done tabs stop polling. This keeps IPC + large-payload serialization to one tree at a time.

### 4.5 Toolbar (`TabHeader.actions` + thin bar)

- **Rescan** (`ghost` `Button`) → `disk_scan_rescan`.
- **Cancel** (`danger` `Button`, visible only while scanning) → `disk_scan_cancel` (the visible wiring of the backend cancel atomic).
- **Show-by** `Segmented`: allocation ↔ logical (per-tab metric).
- **Color-mode** `Segmented`: by type / by depth / by age.
- **LOD density** slider (min-size / depth) tuning the client LOD knobs.
- **"Pause live updates"** `Toggle`.
- Live **progress chip**: files scanned / bytes / files-per-sec / elapsed / skipped, fed by the throttled event.

### 4.6 Side detail panel

Selected item: full resolved path, allocation vs logical size, % of disk + % of parent, file count, modified date; a mini **"largest items here"** list (top-N children as bars, from `disk_top_items` on the focus). Also a global **"Top 20 largest files/folders on this disk"** list (the SpaceSniffer "what's eating my space" answer) reachable from the panel. Action buttons: **Reveal**, **Open** (unconfirmed); **Delete** appears only when the Phase-7 unlock is on (§6.3).

---

## 5. Performance / Scale / Memory Bounds

| Concern | Bound / Mechanism |
|---|---|
| Command latency | Every command O(1): `Arc` clone, atomic read/flip, or a bounded slice. Never blocks. |
| Scan threads | Dedicated named `std::thread`s, off the `spawn_blocking` pool → telemetry commands never starved. |
| Cross-disk I/O | Global walker-permit cap (~6 total workers) so N concurrent scans don't stall the I/O subsystem. |
| Tree memory | ~32 B/node arena + interned names + **source-level top-N-per-dir aggregation** → tens of MB typical, ~320 MB at 10M nodes. |
| Hard cap | ~20M-node ceiling → stop descending, mark truncated, finish clean. **Never OOM.** |
| IPC payload | `disk_tree` returns a depth/min-bytes/max-nodes-bounded **slice** — never the whole tree. Tree never crosses events. |
| Event volume | `disk-scan://progress` throttled to ~4–10 Hz/job, scalars only; frontend coalesces on a trailing tick. |
| Snapshot cost | Incremental size roll-up + copy-on-publish of the dirty spine → not O(N) per tick. Fallback: full snapshot only on completion. |
| Render frame | Canvas LOD caps visible rects ~4000 (`MAX_DRAW_RECTS`, adaptive `MIN_RECT`) → sub-1ms draw, 60fps. |
| Relayout | Coalesced to ~4–6 Hz rAF; size interpolation between relayouts; inactive tabs pause rAF. |
| GPU budget | Canvas respects `data-gpu-render=false` and `data-reduce-motion`; no keyframed box-shadow; canvas kept out of `layout`-animated containers. |

---

## 6. Safety

### 6.1 Read-only scan

The scan opens entries for **metadata only** — it **never reads file contents**. There is no code path from scanning to mutation.

### 6.2 Unreadable / skipped entries

ACL-denied, in-use, or erroring entries are caught per-entry, counted (`skipped`), flagged on the node, and **surfaced** in a collapsible "skipped N items" panel — never abort the scan.

### 6.3 Destructive actions — deferred + guarded (Phase 7)

v1 ships **read-only**: only `disk_reveal` (reuses the existing guarded `reveal_in_explorer`) and Open. When delete is added later, it is the single highest-risk surface in an **elevated** app and is gated by **all** of:

1. A separate **unlock** flag (`diskDeleteUnlocked` in `ui.ts`, OFF + persisted, like `amdTuningUnlocked`). The Delete control is hidden until unlocked.
2. A **danger confirm `Modal`** that echoes the **exact resolved absolute path** + size, and offers **Recycle Bin (default) vs permanent**.
3. **Path validation:** the resolved path must be **under the scanned root**; reject a **denylist** of system-critical roots (`C:\Windows`, `C:\Program Files`, `C:\ProgramData`, the volume root itself, any path with no recycle-bin target).
4. Recycle-bin route via `SHFileOperationW` `FOF_ALLOWUNDO` — **never** a hard `unlink` by default.
5. **No bulk / no multi-select / no one-click delete.** One item per confirm.
6. After a delete, the affected subtree is invalidated and a **targeted partial rescan** refreshes sizes.

---

## 7. Error Handling & Cancellation

- **Cancellation:** `disk_scan_cancel` flips `cancel`; workers check it when popping the queue **and inside the per-entry enumeration loop**, draining promptly even mid-giant-directory. The command itself is O(1).
- **Drive disconnect mid-scan:** I/O-error burst → handle → `Error` status, threads stop, "drive disconnected" surfaced, **other scans unaffected**.
- **Long paths / odd filenames / reparse loops:** `\\?\` wide paths + lossy handling + per-entry `catch`/`continue` + no reparse recursion. One bad entry never aborts.
- **Spawn failure:** like `sampler.rs`, a failed thread spawn is **logged** (`tracing::warn!`) and the handle goes to `Error` with a message — never a silent empty-forever state.
- **Frontend reconnect:** if the progress listener mounts mid-scan, `disk_scan_status` gives the current snapshot; the poll picks up the latest `generation`.
- **Antivirus slowdown:** nothing to fix in-app, but the progress chip's files/sec + current-path makes a slow scan visibly *working*, not hung.

---

## 8. Phased Implementation Plan

Each phase builds + (owner) hardware-validates before the next. Build verification is `npx tauri build` (never bare `cargo build` — MEMORY).

- **Phase 0 — Skeleton & nav.** Add `disk` to `TabId`/`TABS`/`NavRail`; stub `DiskAnalyzer.tsx`; `disk_list_volumes` command + the picker (Zone A) listing volumes with sizes. No scanning yet. *Verify: builds, tab appears, volumes list.*
- **Phase 1 — Backend scan engine core.** `disk_scan.rs`: `SCANS` registry, `ScanHandle`, dedicated-thread walk over `FindFirstFileExW`, arena tree + interned names, both size metrics, reparse/permission/hardlink correctness, the AtomicBool cancel, top-N-per-dir source aggregation, node cap. `disk_scan_start`/`cancel`/`status` commands + the `disk-scan://progress` event. *Verify: builds; scans a small folder tree; cancels promptly; progress event fires.*
- **Phase 2 — Snapshot + tree IPC.** Incremental roll-up + `Arc<DiskTree>` pointer-swap publishing; `disk_tree` LOD-sliced command; `disk_top_items`. *Verify: builds; `disk_tree` returns bounded slices for a real drive.*
- **Phase 3 — Treemap render.** `treemap/layout.ts` squarify + the Canvas renderer + theme-token colors + labels + hit-test/tooltip. Static (post-completion) tree first. *Verify: builds; a completed scan renders a treemap; hover works.*
- **Phase 4 — Drill-down + detail panel + toolbar.** Breadcrumb drill (`focus_path`), zoom tween, detail panel, Reveal/Open, Show-by/Color/LOD/Pause controls. *Verify: builds; drill in/out, reveal works.*
- **Phase 5 — Live streaming + per-disk tabs.** `diskScan.ts` store; the coalesced progress listener; active-tab `disk_tree` polling; live fill-in interpolation; `SecondaryTabs` per-disk strip; concurrent multi-disk start. *Verify: builds; multi-disk concurrent scan fills in live; tab-switch instant; cancel/rescan/close work.*
- **Phase 6 — Hardening & scale.** Memory-cap truncation UX, drive-disconnect handling, skipped-items panel, global walker-permit cap, antivirus-slow UX, i18n pass (canvas strings), `data-gpu-render`/`reduce-motion` honoring. *Verify: builds; full C: scan stays bounded; truncation/disconnect surfaces cleanly.*
- **Phase 7 — (deferred) Guarded delete.** `diskDeleteUnlocked` flag + Settings unlock; `disk_delete` with denylist + path-under-root validation + Recycle Bin + confirm Modal; targeted partial rescan. *Verify: builds; delete only with unlock; denylist + confirm enforced.*
- **Phase 8 — (optional, future) Fast-path & cache.** NTFS MFT/USN enumeration fast scan; separate-file binary result cache under APPDATA (never the live store); reparse-follow toggle; per-physical-disk walker budget.

---

## 9. Key Decisions (summary)

1. From-scratch parallel walk over Win32 `FindFirstFileExW` + dedicated `std::thread`s — **no jwalk/walkdir/ignore/rayon/crossbeam** (none vendored; Windows specifics need below-abstraction control; anti-new-dep culture). One small allowance reconsidered only if hand-rolling proves unreasonable (Open Question §11).
2. Mirror `sampler.rs`/`telemetry.rs` verbatim: per-disk `Arc<DiskTree>` pointer-swap under a short `Mutex`; O(1) commands; AtomicBool cancel; graceful degradation; no lock across I/O.
3. `DashMap<ScanId, Arc<ScanHandle>>` keyed by volume GUID → per-disk isolation; frontend per-disk tabs map 1:1 to scan ids.
4. ~32-byte arena nodes + interned names + **top-N-per-dir source aggregation** + node cap → bounded memory, no per-node paths.
5. Default metric = allocation size (per-tab toggle to logical).
6. Pull, don't push, the tree: throttled scalar progress event + O(1) `disk_tree` LOD slice; tree never crosses events.
7. **Canvas 2D** treemap (not SVG, not WebGL), squarified, memoized off the React render path, LOD-capped to ~4000 rects.
8. One main-nav `disk` tab hosting `SecondaryTabs`; per-disk view-state in a `diskScan.ts` store → instant O(1) tab switching, no remount.
9. Theme-token colors read via `getComputedStyle` (auto-retint across themes); canvas strings via `t()`/`tf()`; canvas honors `data-gpu-render`/`data-reduce-motion` and stays out of `layout`-animated containers.
10. **Read-only v1**; guarded Recycle-Bin delete deferred to Phase 7 behind an unlock + denylist + path validation + confirm.

---

## 10. Self-Review

- No placeholders/TBD remain; every section is concrete.
- Internally consistent: the same `ScanId`/`ScanHandle`/`DiskTree`/`disk_tree`/`disk-scan://progress` vocabulary is used across backend, IPC, and frontend sections.
- Single coherent scope: one new tab, one backend module, one new frontend store, one bespoke canvas component; everything else reuses existing primitives.
- Honors every hard constraint: no-main-thread-block (O(1) commands, background threads, no lock across I/O), no-downgrade (one rail item, existing tabs/animations/escape-hatches untouched), build-only verification, never-bloat-the-live-store, never-recurse-reparse, cancelable + bounded + read-only.

---

## 11. Open Questions (for the owner)

1. **Dep purity:** hand-roll the directory work-queue (parking_lot `Mutex`+`Condvar`) and the string interner (assumed in this spec), or accept one small dep (`crossbeam-deque` / `string-interner`) for cleaner code? Spec assumes hand-rolled, zero-new-dep.
2. **Memory cap value:** confirm the ~20M-node (~640 MB) ceiling and the truncation behavior (aggregate-deepest-unscanned, as specced) vs a lower cap.
3. **Snapshot cadence model:** confirm pull (`disk_tree` on the frontend's own cadence, as specced — matches sampler/OSD precedent) over pushing the pruned root tree in the event (perf_recorder precedent).
4. **Per-disk vs global walker budget:** v1 flat global cap (~6) as specced, or map partitions→physical disks now?
5. **Allocation-size accuracy:** accept find-data allocation size (v1) or add the `GetCompressedFileSizeW` fallback for compressed/sparse/dedup files?
6. **Delete in scope when reached:** confirm delete stays out of v1 entirely (read-only ship), enabled later only behind the Phase-7 unlock.
7. **Color default:** by-type (informative, needs an extension→class map to maintain) vs by-depth (cheapest, most SpaceSniffer-authentic, auto-themes) as the v1 default.
8. **NTFS MFT fast-path / result cache:** in for a later phase (Phase 8) or out entirely?
