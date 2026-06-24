//! Disk Space Analyzer — backend scan engine.
//!
//! See docs/superpowers/specs/2026-06-23-disk-space-analyzer-design.md.
//!
//! PHASE 1 (Scan engine core) adds the `SCANS` keyed registry, the per-disk
//! `ScanHandle` owner, the dedicated-thread `FindFirstFileExW` walk with a small
//! worker pool (hand-rolled `Mutex`+`Condvar` directory queue — zero new deps),
//! the flat arena `Node` tree + interned names, both size metrics
//! (logical + cluster-rounded allocation), reparse / permission / hardlink
//! correctness, the `AtomicBool` cancel, top-N-per-dir source aggregation, the
//! node cap with a truncation flag, the `disk_scan_start` / `disk_scan_cancel` /
//! `disk_scan_status` commands, and the throttled `disk-scan://progress` event.
//!
//! PHASE 2 (Snapshot + tree IPC) adds the periodic `Arc<DiskTree>` pointer-swap
//! publisher (a scoped thread copying the arena under a short lock, rolling up the
//! COPY outside the lock, and swapping it in at ~2–4 Hz so the frontend can pull a
//! growing tree mid-scan), plus the two LOD commands `disk_tree` (depth /
//! min-bytes / max-nodes-bounded slice — the treemap workhorse) and
//! `disk_top_items` (the "what's eating my space" flat list). Both clone the
//! published snapshot `Arc` (O(1)) and slice/walk the immutable copy on the
//! blocking pool, so the IPC router never stalls.
//!
//! CRITICAL-PATH INVARIANT (mirrors sampler.rs / telemetry.rs): every Tauri
//! command stays O(1) — clone an `Arc`, read/flip an atomic, or insert a handle —
//! and never blocks the main thread. The multi-million-file walk runs on dedicated
//! named `std::thread`s, **off** the `spawn_blocking` pool (so it never starves the
//! O(1) telemetry commands). No shared read-path lock is ever held across slow I/O:
//! the snapshot `Mutex` is taken only to swap an `Arc` pointer, the same proven
//! `sampler.rs` `PROC_SNAPSHOT` contract.

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use dashmap::DashMap;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Serialize;

use crate::error::CoreResult;

/// Stable per-disk key. The volume GUID path (`\\?\Volume{guid}\`) where
/// available, falling back to the drive-letter root (`C:\`). The `SCANS` registry
/// is keyed by this; the UI displays the friendly letter+label.
pub type ScanId = String;

/// One fixed/removable volume surfaced in the disk picker (Zone A).
///
/// `total`/`free` are bytes; `used = total - free`. `supported` is false for
/// volumes we can list but not (yet) scan (locked BitLocker, no free-space info)
/// so the picker can grey them out. Serialized camelCase for the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeInfo {
    /// Stable scan key — volume GUID path when resolvable, else the drive root.
    pub scan_id: ScanId,
    /// Friendly display root, e.g. "C:\\".
    pub root: String,
    /// Drive letter without the trailing separator, e.g. "C:".
    pub letter: String,
    /// Volume label (may be empty).
    pub label: String,
    /// File system, e.g. "NTFS" / "exFAT" (may be empty when unavailable).
    pub file_system: String,
    /// Win32 drive type: "fixed" | "removable" | "remote" | "cdrom" | "ramdisk" | "unknown".
    pub drive_type: String,
    /// Total size in bytes (0 when unavailable).
    pub total: u64,
    /// Free bytes available to the caller (0 when unavailable).
    pub free: u64,
    /// True when this volume can be scanned (has size info and is a real fixed/removable disk).
    pub supported: bool,
}

// =============================================================================
// Arena tree (spec §2.6) — flat Vec<Node> indexed by u32 NodeId.
// =============================================================================

/// `NodeId` sentinel meaning "no node" (no child / no sibling).
pub const SENTINEL: u32 = u32::MAX;

// Node bit flags (spec §2.6).
pub const FLAG_IS_DIR: u8 = 1 << 0;
pub const FLAG_REPARSE: u8 = 1 << 1;
pub const FLAG_DENIED: u8 = 1 << 2;
pub const FLAG_HIDDEN: u8 = 1 << 3;
pub const FLAG_SYSTEM: u8 = 1 << 4;
pub const FLAG_HARDLINK: u8 = 1 << 5;
pub const FLAG_AGGREGATED: u8 = 1 << 6;

/// One arena node (≈ 40 bytes). Never `Box`/`Rc`/`Arc` per node — pointer-chasing
/// + per-alloc overhead blows up at tens of millions of nodes. Children form a
/// `first_child` / `next_sibling` intrusive list; the absolute path is
/// reconstructed on demand by walking `parent` (no per-node full paths).
#[derive(Debug, Clone)]
pub struct Node {
    /// NodeId of the parent (root points at itself).
    pub parent: u32,
    /// Index into the interned-name table.
    pub name_id: u32,
    /// First child NodeId, or `SENTINEL`.
    pub first_child: u32,
    /// Next sibling NodeId, or `SENTINEL`.
    pub next_sibling: u32,
    /// Subtree-aggregated apparent size for dirs; own size for files.
    pub logical_size: u64,
    /// Subtree-aggregated cluster-rounded on-disk footprint.
    pub alloc_size: u64,
    /// Files in the subtree (dirs) or 1 (files); aggregated leaves carry their count.
    pub file_count: u32,
    /// Bit flags: IS_DIR | REPARSE | DENIED | HIDDEN | SYSTEM | HARDLINK | AGGREGATED.
    pub flags: u8,
}

impl Node {
    #[inline]
    pub fn is_dir(&self) -> bool {
        self.flags & FLAG_IS_DIR != 0
    }
}

/// An immutable, published scan tree. Phase 2 slices this with LOD for the
/// `disk_tree` command; Phase 1 publishes it whole on completion so the
/// pointer-swap channel is wired. `names` is the interned-name table indexed by
/// `Node::name_id`; `nodes[0]` is always the root.
#[derive(Debug, Default)]
pub struct DiskTree {
    pub nodes: Vec<Node>,
    pub names: Vec<Box<str>>,
}

impl DiskTree {
    /// Reconstruct a node's absolute path by walking `parent` links (cheap; only
    /// the handful of nodes the UI drills into need it). Root's name is the
    /// display root (e.g. "C:\\").
    pub fn path_of(&self, mut id: u32) -> String {
        let mut parts: Vec<&str> = Vec::new();
        loop {
            let n = &self.nodes[id as usize];
            parts.push(&self.names[n.name_id as usize]);
            if n.parent == id {
                break; // root
            }
            id = n.parent;
        }
        parts.reverse();
        // Root already carries a trailing separator ("C:\\"); join the rest with '\'.
        let mut out = String::new();
        for (i, p) in parts.iter().enumerate() {
            out.push_str(p);
            if i == 0 {
                // root like "C:\\" already ends in a separator
                if !out.ends_with('\\') {
                    out.push('\\');
                }
            } else if i + 1 < parts.len() {
                out.push('\\');
            }
        }
        out
    }
}

/// A complete, self-contained arena produced by the MFT fast-path
/// (`disk_scan_mft::try_build_arena_from_mft`). The builder fills this entirely
/// off the shared scan state, sanity-checks it, and returns it WHOLE — the caller
/// only adopts a `Some(_)`, so a failed/partial MFT attempt never pollutes the
/// fallback `FindFirstFileExW` walk. `nodes[0]` is the root; sizes are NOT yet
/// rolled up (the existing publisher's `rollup` does that, exactly as for the
/// walk), so node sizes here are own-sizes (files) / 0 (dirs).
pub(crate) struct BuiltArena {
    pub(crate) nodes: Vec<Node>,
    pub(crate) names: Vec<Box<str>>,
    pub(crate) files_seen: u64,
    pub(crate) dirs_seen: u64,
    pub(crate) bytes_logical: u64,
    pub(crate) bytes_alloc: u64,
    pub(crate) node_count: u64,
    pub(crate) truncated: bool,
}

// =============================================================================
// LOD-sliced tree IPC (spec §2.9 / §3.3) — `disk_tree` / `disk_top_items`.
// =============================================================================

/// One node in a bounded `TreeView` slice. Flat (the layout module re-nests via
/// `parent` / sibling order). Indices are LOCAL to the slice, NOT arena NodeIds,
/// so the frontend never needs the full arena. `path` is filled only for the
/// focus root + container nodes the UI may drill into (cheap; not every leaf).
/// Serialized camelCase. Byte sizes are plain numbers (a disk can't hold > 2^53
/// bytes ≈ 9 PB), matching the `ScanProgress` precedent.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    /// Local index of this node within `TreeView::nodes` (0 == the focus root).
    pub id: u32,
    /// Local index of the parent within this slice (self for the focus root).
    pub parent: u32,
    /// Display name (interned component, or the synthetic aggregate label).
    pub name: String,
    pub logical_size: u64,
    pub alloc_size: u64,
    pub file_count: u32,
    /// Bit flags (IS_DIR | REPARSE | DENIED | HIDDEN | SYSTEM | HARDLINK | AGGREGATED).
    pub flags: u8,
    /// True when this node is a directory that HAS children the slice did not
    /// expand (depth/min_bytes/max_nodes LOD collapsed it) — the UI shows it as a
    /// drillable container even though no children crossed IPC.
    pub has_more: bool,
    /// Absolute path — present for the focus root + directory containers (so a
    /// drill can re-`disk_tree` on it); `None` for ordinary leaves.
    pub path: Option<String>,
}

/// A bounded LOD slice of a scan tree for one focused container (spec §2.9 /
/// §3.3). `disk_tree` does the server-side LOD so a huge tree never crosses IPC
/// whole. `nodes[0]` is the focus root; children follow in size-desc order.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeView {
    /// The scan this slice came from.
    pub scan_id: ScanId,
    /// Snapshot generation this slice was sliced from (the frontend re-pulls when
    /// the `disk-scan://progress` generation advances).
    pub generation: u64,
    /// Absolute path of the focus root (echoes the request's `focus_path`, or the
    /// disk root when `None` was requested).
    pub focus_path: String,
    /// Flat slice nodes; `nodes[0]` is the focus root.
    pub nodes: Vec<TreeNode>,
    /// True when LOD collapsed at least one subtree (some `has_more` is set).
    pub truncated: bool,
}

/// One row of the "what's eating my space" flat list (`disk_top_items`, spec
/// §2.9 / §4.6). The top-N largest items in the focused (sub)tree by alloc size.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemRow {
    /// Absolute path of the item.
    pub path: String,
    /// Leaf/aggregate name (last path component).
    pub name: String,
    pub logical_size: u64,
    pub alloc_size: u64,
    pub file_count: u32,
    pub flags: u8,
}

impl DiskTree {
    /// Resolve a `focus_path` to an arena NodeId. `None` (or the display root)
    /// resolves to the root (node 0). A case-insensitive walk of the parent→child
    /// links — only the handful of nodes the UI drills into pay this. Returns
    /// `None` when the path doesn't resolve within this tree.
    pub fn node_for_path(&self, focus_path: Option<&str>) -> Option<u32> {
        if self.nodes.is_empty() {
            return None;
        }
        let Some(raw) = focus_path else {
            return Some(0);
        };
        let raw = raw.trim();
        if raw.is_empty() {
            return Some(0);
        }
        // The root's display name (e.g. "C:\\") prefixes every absolute path.
        let root_name: &str = &self.names[self.nodes[0].name_id as usize];
        let norm = raw.trim_end_matches('\\');
        let root_norm = root_name.trim_end_matches('\\');
        if norm.eq_ignore_ascii_case(root_norm) {
            return Some(0);
        }
        // Strip the root prefix, then walk the remaining components child-by-child.
        let rest = if norm.len() > root_norm.len()
            && norm[..root_norm.len()].eq_ignore_ascii_case(root_norm)
        {
            norm[root_norm.len()..].trim_start_matches('\\')
        } else {
            // Not under this root.
            return None;
        };
        let mut cur = 0u32;
        for comp in rest.split('\\').filter(|c| !c.is_empty()) {
            let mut child = self.nodes[cur as usize].first_child;
            let mut found: Option<u32> = None;
            while child != SENTINEL {
                let n = &self.nodes[child as usize];
                let cname: &str = &self.names[n.name_id as usize];
                if cname.eq_ignore_ascii_case(comp) {
                    found = Some(child);
                    break;
                }
                child = n.next_sibling;
            }
            cur = found?;
        }
        Some(cur)
    }

    /// Build a bounded LOD slice rooted at `focus` (spec §2.9 / §3.3). BFS by
    /// alloc size, honoring `depth_limit` (levels below the focus), `min_bytes`
    /// (skip children whose alloc is below it — collapses long tails), and
    /// `max_nodes` (hard ceiling on slice size). A directory with un-expanded
    /// children is flagged `has_more` so the UI renders it as drillable.
    pub fn slice(
        &self,
        scan_id: &str,
        generation: u64,
        focus: u32,
        depth_limit: u8,
        min_bytes: u64,
        max_nodes: u32,
    ) -> TreeView {
        let focus_path = self.path_of(focus);
        let cap = max_nodes.max(1) as usize;
        let mut nodes: Vec<TreeNode> = Vec::new();
        let mut truncated = false;

        // (arena_id, local_parent, depth). Process largest-first so the cap keeps
        // the biggest, most relevant subtrees.
        let mut queue: std::collections::VecDeque<(u32, u32, u8)> =
            std::collections::VecDeque::new();

        // Push the focus root (local id 0, parent == self).
        {
            let n = &self.nodes[focus as usize];
            nodes.push(self.make_tree_node(0, 0, n, true, Some(focus_path.clone())));
            queue.push_back((focus, 0, 0));
        }

        while let Some((arena_id, local_parent, depth)) = queue.pop_front() {
            if depth >= depth_limit {
                // Past the depth budget: mark the parent drillable if it has kids.
                if self.nodes[arena_id as usize].first_child != SENTINEL {
                    nodes[local_parent as usize].has_more = true;
                    truncated = true;
                }
                continue;
            }

            // Collect + size-sort this node's children (desc by alloc).
            let mut kids: Vec<u32> = Vec::new();
            let mut child = self.nodes[arena_id as usize].first_child;
            while child != SENTINEL {
                kids.push(child);
                child = self.nodes[child as usize].next_sibling;
            }
            kids.sort_unstable_by(|&a, &b| {
                self.nodes[b as usize]
                    .alloc_size
                    .cmp(&self.nodes[a as usize].alloc_size)
            });

            for kid in kids {
                let kn = &self.nodes[kid as usize];
                // min_bytes collapse: a child below the threshold (and any below
                // it) folds away. Mark the parent drillable so the UI can zoom in.
                if kn.alloc_size < min_bytes {
                    nodes[local_parent as usize].has_more = true;
                    truncated = true;
                    continue;
                }
                if nodes.len() >= cap {
                    nodes[local_parent as usize].has_more = true;
                    truncated = true;
                    break;
                }
                let local_id = nodes.len() as u32;
                let is_dir = kn.is_dir();
                let path = if is_dir {
                    Some(self.path_of(kid))
                } else {
                    None
                };
                nodes.push(self.make_tree_node(local_id, local_parent, kn, false, path));
                if is_dir && kn.first_child != SENTINEL {
                    queue.push_back((kid, local_id, depth + 1));
                }
            }
        }

        TreeView {
            scan_id: scan_id.to_string(),
            generation,
            focus_path,
            nodes,
            truncated,
        }
    }

    /// Construct a `TreeNode` for the slice from an arena node.
    fn make_tree_node(
        &self,
        local_id: u32,
        local_parent: u32,
        n: &Node,
        is_focus: bool,
        path: Option<String>,
    ) -> TreeNode {
        TreeNode {
            id: local_id,
            parent: local_parent,
            name: self.names[n.name_id as usize].to_string(),
            logical_size: n.logical_size,
            alloc_size: n.alloc_size,
            file_count: n.file_count,
            flags: n.flags,
            // The focus root with children is always drillable-from; otherwise
            // `has_more` is set later when the slice can't expand a subtree.
            has_more: is_focus && n.first_child != SENTINEL,
            path,
        }
    }

    /// Top-N largest direct + descendant items under `focus`, by alloc size
    /// (spec §2.9 / §4.6 — the "what's eating my space" flat list). Walks the
    /// whole subtree (cheap relative to the scan; only invoked on demand) and
    /// keeps the N largest by alloc.
    pub fn top_items(&self, focus: u32, n: u32) -> Vec<ItemRow> {
        let want = n.max(1) as usize;
        // Gather every descendant (excluding the focus root itself).
        let mut all: Vec<u32> = Vec::new();
        let mut stack = vec![focus];
        let mut first = true;
        while let Some(id) = stack.pop() {
            if !first {
                all.push(id);
            }
            first = false;
            let mut child = self.nodes[id as usize].first_child;
            while child != SENTINEL {
                stack.push(child);
                child = self.nodes[child as usize].next_sibling;
            }
        }
        all.sort_unstable_by(|&a, &b| {
            self.nodes[b as usize]
                .alloc_size
                .cmp(&self.nodes[a as usize].alloc_size)
        });
        all.into_iter()
            .take(want)
            .map(|id| {
                let nd = &self.nodes[id as usize];
                ItemRow {
                    path: self.path_of(id),
                    name: self.names[nd.name_id as usize].to_string(),
                    logical_size: nd.logical_size,
                    alloc_size: nd.alloc_size,
                    file_count: nd.file_count,
                    flags: nd.flags,
                }
            })
            .collect()
    }
}

/// Hand-rolled string interner (spec §2.6 — no new dep). Repeated path
/// components (`node_modules`, `.git`, `.dll`) cost one copy.
pub(crate) struct Interner {
    pub(crate) table: Vec<Box<str>>,
    map: std::collections::HashMap<Box<str>, u32>,
}

impl Interner {
    pub(crate) fn new() -> Self {
        Self {
            table: Vec::new(),
            map: std::collections::HashMap::new(),
        }
    }
    pub(crate) fn intern(&mut self, s: &str) -> u32 {
        if let Some(&id) = self.map.get(s) {
            return id;
        }
        let id = self.table.len() as u32;
        let boxed: Box<str> = s.into();
        self.table.push(boxed.clone());
        self.map.insert(boxed, id);
        id
    }
}

/// Round a logical size up to the next whole cluster (the on-disk footprint).
/// Crate-level so both the walk and the MFT fast-path share one definition.
#[inline]
pub(crate) fn round_to_cluster(logical: u64, cluster: u64) -> u64 {
    if cluster == 0 {
        return logical;
    }
    logical.div_ceil(cluster) * cluster
}

// =============================================================================
// Scan status + per-disk owner handle (spec §2.2)
// =============================================================================

/// Lifecycle of one disk scan. Stored as a `u8` atomic on the handle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[repr(u8)]
pub enum ScanStatus {
    Scanning = 0,
    Done = 1,
    Cancelled = 2,
    Error = 3,
}

impl ScanStatus {
    fn from_u8(v: u8) -> ScanStatus {
        match v {
            1 => ScanStatus::Done,
            2 => ScanStatus::Cancelled,
            3 => ScanStatus::Error,
            _ => ScanStatus::Scanning,
        }
    }
    fn as_str(self) -> &'static str {
        match self {
            ScanStatus::Scanning => "scanning",
            ScanStatus::Done => "done",
            ScanStatus::Cancelled => "cancelled",
            ScanStatus::Error => "error",
        }
    }
}

/// The per-disk owner (spec §2.2). Cheap scalar atomics back the O(1) status
/// command; `snapshot` is the `sampler.rs` pointer-swap publish channel — the
/// lock is held **only** to swap the `Arc`, never across the walk.
pub struct ScanHandle {
    pub scan_id: ScanId,
    /// Friendly display root ("C:\\") for the UI and path reconstruction.
    pub root_display: Box<str>,
    /// Filesystem root actually walked (the drive letter root "C:\\").
    walk_root: Box<str>,
    /// Volume file system name ("NTFS"/"exFAT"/...), used to gate the MFT
    /// fast-path. Empty when unavailable → the MFT path is skipped (walk runs).
    file_system: Box<str>,
    status: AtomicU8,
    /// Flipped by `disk_scan_cancel`; checked when popping the queue AND inside
    /// the per-entry enumeration loop (spec §2.3).
    cancel: Arc<AtomicBool>,
    // Progress atomics — cheap scalar reads for the O(1) status command + event.
    files_seen: AtomicU64,
    dirs_seen: AtomicU64,
    bytes_logical: AtomicU64,
    bytes_alloc: AtomicU64,
    /// Permission-denied / unreadable entries — surfaced, never aborts the scan.
    skipped: AtomicU64,
    /// Live node count for the memory cap (spec §2.7).
    node_count: AtomicU64,
    /// Set when the node cap stopped descent — drives the truncation banner.
    truncated: AtomicBool,
    /// Set when a sustained I/O-error streak tripped the drive-disconnect
    /// transition (spec §2.5.5 / §7) — distinguishes "drive ejected" from a plain
    /// user cancel even though both flip `cancel` to drain the workers.
    disconnected: AtomicBool,
    /// Consecutive hard-device-error count; reset by any successful/denied read.
    /// Crossing `DISCONNECT_ERROR_STREAK` trips the disconnect transition.
    io_error_streak: AtomicU64,
    started_at: Instant,
    /// Bumped on each published snapshot swap (the frontend pulls on a new gen).
    generation: AtomicU64,
    /// Optional error message for the `Error` state.
    error: Mutex<Option<String>>,
    /// The directory currently being enumerated (display path) — surfaced in the
    /// progress chip so a slow scan looks visibly working (spec §7). Tiny: just
    /// the one dir, swapped under a short lock, never the tree.
    current_path: Mutex<Arc<str>>,
    /// Pointer-swap publish channel (sampler.rs `PROC_SNAPSHOT` contract).
    snapshot: Mutex<Arc<DiskTree>>,
}

impl ScanHandle {
    fn new(
        scan_id: ScanId,
        root_display: String,
        walk_root: String,
        file_system: String,
    ) -> ScanHandle {
        ScanHandle {
            scan_id,
            root_display: root_display.into(),
            walk_root: walk_root.into(),
            file_system: file_system.into(),
            status: AtomicU8::new(ScanStatus::Scanning as u8),
            cancel: Arc::new(AtomicBool::new(false)),
            files_seen: AtomicU64::new(0),
            dirs_seen: AtomicU64::new(0),
            bytes_logical: AtomicU64::new(0),
            bytes_alloc: AtomicU64::new(0),
            skipped: AtomicU64::new(0),
            node_count: AtomicU64::new(0),
            truncated: AtomicBool::new(false),
            disconnected: AtomicBool::new(false),
            io_error_streak: AtomicU64::new(0),
            started_at: Instant::now(),
            generation: AtomicU64::new(0),
            error: Mutex::new(None),
            current_path: Mutex::new(Arc::from("")),
            snapshot: Mutex::new(Arc::new(DiskTree::default())),
        }
    }

    /// Publish the directory currently being walked (spec §7 antivirus-slow UX).
    /// Strips the `\\?\` extended-length prefix for display. Tiny lock — only the
    /// `Arc<str>` pointer is swapped, never held across I/O.
    #[cfg(target_os = "windows")]
    fn set_current_path(&self, wpath: &[u16]) {
        let end = wpath.iter().position(|&c| c == 0).unwrap_or(wpath.len());
        let s = String::from_utf16_lossy(&wpath[..end]);
        let disp = s
            .strip_prefix("\\\\?\\UNC\\")
            .map(|r| format!("\\\\{r}"))
            .or_else(|| s.strip_prefix("\\\\?\\").map(|r| r.to_string()))
            .unwrap_or(s);
        *self.current_path.lock() = Arc::from(disp.as_str());
    }

    fn status(&self) -> ScanStatus {
        ScanStatus::from_u8(self.status.load(Ordering::Relaxed))
    }
    fn set_status(&self, s: ScanStatus) {
        self.status.store(s as u8, Ordering::Relaxed);
    }

    /// O(1) latest snapshot — clone the `Arc` (Phase 2 LOD-slices it).
    pub fn snapshot(&self) -> Arc<DiskTree> {
        self.snapshot.lock().clone()
    }

    /// Publish running progress from the MFT bulk read so the chip animates during
    /// a multi-second `$MFT` parse (spec §3.3). Scalars only, like the walk.
    pub(crate) fn mft_set_progress(
        &self,
        files_seen: u64,
        dirs_seen: u64,
        bytes_logical: u64,
        bytes_alloc: u64,
        node_count: u64,
    ) {
        self.files_seen.store(files_seen, Ordering::Relaxed);
        self.dirs_seen.store(dirs_seen, Ordering::Relaxed);
        self.bytes_logical.store(bytes_logical, Ordering::Relaxed);
        self.bytes_alloc.store(bytes_alloc, Ordering::Relaxed);
        self.node_count.store(node_count, Ordering::Relaxed);
    }

    /// Swap in a freshly-built tree and bump `generation` (the publish step).
    fn publish(&self, tree: Arc<DiskTree>) {
        *self.snapshot.lock() = tree;
        self.generation.fetch_add(1, Ordering::Relaxed);
    }

    fn build_progress(&self) -> ScanProgress {
        let status = self.status();
        ScanProgress {
            scan_id: self.scan_id.clone(),
            root: self.root_display.to_string(),
            status: status.as_str().to_string(),
            files_seen: self.files_seen.load(Ordering::Relaxed),
            dirs_seen: self.dirs_seen.load(Ordering::Relaxed),
            bytes_alloc: self.bytes_alloc.load(Ordering::Relaxed),
            bytes_logical: self.bytes_logical.load(Ordering::Relaxed),
            skipped: self.skipped.load(Ordering::Relaxed),
            node_count: self.node_count.load(Ordering::Relaxed),
            generation: self.generation.load(Ordering::Relaxed),
            truncated: self.truncated.load(Ordering::Relaxed),
            disconnected: self.disconnected.load(Ordering::Relaxed),
            current_path: self.current_path.lock().to_string(),
            elapsed_ms: self.started_at.elapsed().as_millis() as u64,
            error: self.error.lock().clone(),
        }
    }
}

/// Scalar progress snapshot — the `disk-scan://progress` event payload and the
/// `disk_scan_status` return (spec §2.8). Never carries the tree.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub scan_id: ScanId,
    pub root: String,
    /// "scanning" | "done" | "cancelled" | "error".
    pub status: String,
    pub files_seen: u64,
    pub dirs_seen: u64,
    pub bytes_alloc: u64,
    pub bytes_logical: u64,
    pub skipped: u64,
    pub node_count: u64,
    pub generation: u64,
    pub truncated: bool,
    /// True when a sustained I/O-error streak tripped the drive-disconnect
    /// transition (spec §2.5.5 / §7) — the UI surfaces a dedicated disconnect
    /// banner rather than a plain "cancelled" chip.
    pub disconnected: bool,
    /// The directory currently being walked (display path; empty when idle/done).
    /// Surfaced in the progress chip so a slow scan looks visibly working (spec §7).
    pub current_path: String,
    pub elapsed_ms: u64,
    pub error: Option<String>,
}

/// The multi-owner keyed registry (spec §2.1). `DashMap` gives per-key locking —
/// starting/cancelling/reading disk D never contends with disk C. We never
/// iterate the whole map while holding an entry lock.
static SCANS: Lazy<DashMap<ScanId, Arc<ScanHandle>>> = Lazy::new(DashMap::new);

// =============================================================================
// Engine tunables (spec §2.6 / §2.7)
// =============================================================================

/// Hard node ceiling — stop descending, mark truncated, finish clean. Never OOM.
/// ~20M nodes ≈ 640 MB (spec §2.7, owner decision 2).
pub(crate) const NODE_CAP: u64 = 20_000_000;
/// Within a directory, keep the top-N largest files as real nodes; fold the rest
/// into one synthetic `AGGREGATED` "(other M files)" leaf (spec §2.6). Kept HIGH
/// so big folders (e.g. a 642-file Videos dir) show every file as its own treemap
/// box — SpaceSniffer-style full detail — instead of collapsing 610 of them into
/// one giant aggregate block. The arena NODE_CAP + the disk_tree slice's max_nodes
/// + the client pixel-LOD still bound memory and render cost; only pathological
/// mega-dirs (>2048 files, typically tiny cache files) still aggregate the tail.
pub(crate) const TOP_N_PER_DIR: usize = 2048;
/// Progress-event throttle floor (spec §2.8 — ~4–10 Hz).
const PROGRESS_THROTTLE: Duration = Duration::from_millis(200);
/// Snapshot publish cadence during scanning (~5 Hz). Each tick copies the arena
/// under a SHORT lock, rolls up the copy OUTSIDE the lock, and pointer-swaps it
/// in — the freeze-proof invariant (no roll-up under the lock, no lock across the
/// swap). Tightened from 400ms so folders appear in the treemap noticeably faster
/// during a scan (closer to SpaceSniffer's live growth).
const PUBLISH_THROTTLE: Duration = Duration::from_millis(200);
/// Process-wide walker-permit ceiling (spec §2.10 / owner decision 4). A flat
/// global cap on the TOTAL number of directories being enumerated concurrently
/// across ALL active scans, so N concurrent HDD scans can't thrash the I/O
/// subsystem into a stall. Each worker acquires a permit before its slow
/// `FindFirstFileExW` pass and releases it after. v1 is a flat cap; mapping
/// partitions→physical disks is a noted later refinement.
const GLOBAL_WALKER_PERMITS: usize = 6;
/// Drive-disconnect detection (spec §2.5.5 / §7): when this many consecutive
/// directory enumerations fail with a hard (non-permission) I/O error, the volume
/// is treated as disconnected — the scan transitions to `Error` cleanly, its
/// threads stop, and every OTHER concurrent scan is left untouched.
const DISCONNECT_ERROR_STREAK: u32 = 64;

/// The hand-rolled global walker-permit counter (spec §2.10, owner decision 1 —
/// `parking_lot::Mutex<usize>` + `Condvar`, no new dep). A worker acquires a
/// permit before descending into a slow directory enumeration and releases it
/// after, so the total in-flight walker count across all scans stays ≤
/// `GLOBAL_WALKER_PERMITS`. RAII via `WalkerPermit` guarantees release even on an
/// early return / panic-unwind.
static WALKER_PERMITS: Lazy<WalkerSemaphore> =
    Lazy::new(|| WalkerSemaphore::new(GLOBAL_WALKER_PERMITS));

/// A counting semaphore: `available` permits guarded by a `Mutex`, waiters parked
/// on a `Condvar`. Hand-rolled (no `tokio::sync::Semaphore` — these are blocking
/// `std::thread` workers, not async tasks).
struct WalkerSemaphore {
    available: Mutex<usize>,
    cv: parking_lot::Condvar,
}

impl WalkerSemaphore {
    fn new(n: usize) -> WalkerSemaphore {
        WalkerSemaphore {
            available: Mutex::new(n),
            cv: parking_lot::Condvar::new(),
        }
    }

    /// Block until a permit is free, decrement, and hand back an RAII guard. The
    /// `cancel` flag is polled while parked so a cancelled scan's workers don't
    /// wait forever for a permit (they bail and drain). Returns `None` if cancel
    /// fired before a permit was acquired.
    fn acquire(&self, cancel: &AtomicBool) -> Option<WalkerPermit<'_>> {
        let mut avail = self.available.lock();
        loop {
            if cancel.load(Ordering::Relaxed) {
                return None;
            }
            if *avail > 0 {
                *avail -= 1;
                return Some(WalkerPermit { sem: self });
            }
            // Wake periodically to re-check the cancel flag even with no release.
            self.cv
                .wait_for(&mut avail, Duration::from_millis(50));
        }
    }
}

/// RAII permit — returns one slot to the global pool on drop (spec §2.10).
struct WalkerPermit<'a> {
    sem: &'a WalkerSemaphore,
}

impl Drop for WalkerPermit<'_> {
    fn drop(&mut self) {
        *self.sem.available.lock() += 1;
        self.sem.cv.notify_one();
    }
}

// =============================================================================
// Win32 walk (spec §2.3) — only compiled on Windows.
// =============================================================================

#[cfg(target_os = "windows")]
mod win {
    use super::*;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{
        CloseHandle, GetLastError, GENERIC_READ, HANDLE, INVALID_HANDLE_VALUE,
    };
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, FindClose, FindExInfoBasic, FindExSearchNameMatch, FindFirstFileExW,
        FindNextFileW, GetDiskFreeSpaceExW, GetDiskFreeSpaceW, GetDriveTypeW, GetFileInformationByHandle,
        GetLogicalDrives, GetVolumeInformationW, GetVolumeNameForVolumeMountPointW,
        BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_HIDDEN,
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_SYSTEM,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE, FIND_FIRST_EX_LARGE_FETCH, OPEN_EXISTING,
        WIN32_FIND_DATAW,
    };

    // Win32 DRIVE_* return codes from GetDriveTypeW (winbase.h). The windows crate
    // returns a plain u32 and doesn't export the named constants in this version, so
    // we match the documented numeric values directly.
    const DRIVE_REMOVABLE: u32 = 2;
    const DRIVE_FIXED: u32 = 3;
    const DRIVE_REMOTE: u32 = 4;
    const DRIVE_CDROM: u32 = 5;
    const DRIVE_RAMDISK: u32 = 6;

    /// UTF-16, NUL-terminated copy of `s`, suitable for `PCWSTR(v.as_ptr())`.
    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Lossy `String` from a NUL-terminated wide buffer.
    fn from_wide_nul(buf: &[u16]) -> String {
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        String::from_utf16_lossy(&buf[..end])
    }

    fn drive_type_str(root_w: &[u16]) -> &'static str {
        // SAFETY: `root_w` is a valid NUL-terminated wide string.
        match unsafe { GetDriveTypeW(PCWSTR(root_w.as_ptr())) } {
            DRIVE_FIXED => "fixed",
            DRIVE_REMOVABLE => "removable",
            DRIVE_REMOTE => "remote",
            DRIVE_CDROM => "cdrom",
            DRIVE_RAMDISK => "ramdisk",
            _ => "unknown",
        }
    }

    /// Resolve the stable volume-GUID path for a drive root (`C:\`). Falls back to
    /// the root itself when the mount point can't be resolved (e.g. a network share
    /// or an empty removable bay).
    fn volume_guid_path(root_w: &[u16]) -> Option<String> {
        let mut buf = [0u16; 64]; // "\\?\Volume{GUID}\" is 49 wide chars + NUL.
        // SAFETY: `root_w` is NUL-terminated; `buf` is sized for the documented output.
        let ok = unsafe { GetVolumeNameForVolumeMountPointW(PCWSTR(root_w.as_ptr()), &mut buf) };
        if ok.is_ok() {
            let s = from_wide_nul(&buf);
            if !s.is_empty() {
                return Some(s);
            }
        }
        None
    }

    /// Read label + filesystem for a drive root. Returns ("", "") when unavailable
    /// (locked / disconnected volume) — the caller then marks the volume unsupported.
    fn volume_information(root_w: &[u16]) -> (String, String) {
        let mut label = [0u16; 256];
        let mut fs = [0u16; 256];
        // SAFETY: all pointers reference live, correctly-sized stack buffers; the
        // unused out-params (serial/flags/max-component) are passed as None.
        let ok = unsafe {
            GetVolumeInformationW(
                PCWSTR(root_w.as_ptr()),
                Some(&mut label),
                None,
                None,
                None,
                Some(&mut fs),
            )
        };
        if ok.is_ok() {
            (from_wide_nul(&label), from_wide_nul(&fs))
        } else {
            (String::new(), String::new())
        }
    }

    /// (total, free-available) bytes for a drive root, or (0, 0) when the volume
    /// can't report sizes (no media, locked, disconnected).
    fn disk_space(root_w: &[u16]) -> (u64, u64) {
        let mut free_avail = 0u64;
        let mut total = 0u64;
        // SAFETY: out-params point at live u64s; `root_w` is NUL-terminated.
        let ok = unsafe {
            GetDiskFreeSpaceExW(
                PCWSTR(root_w.as_ptr()),
                Some(&mut free_avail),
                Some(&mut total),
                None,
            )
        };
        if ok.is_ok() {
            (total, free_avail)
        } else {
            (0, 0)
        }
    }

    /// Cluster (allocation-unit) size in bytes for a drive root. Allocation size
    /// is the logical size rounded up to this; v1 uses this find-data-derived
    /// value (owner decision 5 — no `GetCompressedFileSizeW`). Falls back to 4096.
    fn cluster_size(root_w: &[u16]) -> u64 {
        let mut spc = 0u32; // sectors per cluster
        let mut bps = 0u32; // bytes per sector
        // SAFETY: out-params point at live u32s; `root_w` is NUL-terminated.
        let ok = unsafe {
            GetDiskFreeSpaceW(
                PCWSTR(root_w.as_ptr()),
                Some(&mut spc),
                Some(&mut bps),
                None,
                None,
            )
        };
        let cl = (spc as u64) * (bps as u64);
        if ok.is_ok() && cl > 0 {
            cl
        } else {
            4096
        }
    }

    /// Enumerate the machine's logical drives (A:..Z:) and describe each as a
    /// `VolumeInfo`. Cheap Win32 calls; called from a `spawn_blocking` task so a
    /// slow removable/network probe never stalls the IPC router.
    pub fn list_volumes() -> Vec<VolumeInfo> {
        // SAFETY: no arguments; returns a bitmask of present logical drives.
        let mask = unsafe { GetLogicalDrives() };
        let mut out = Vec::new();
        for i in 0..26u32 {
            if mask & (1 << i) == 0 {
                continue;
            }
            let letter_char = (b'A' + i as u8) as char;
            let root = format!("{letter_char}:\\");
            let letter = format!("{letter_char}:");
            let root_w = wide(&root);

            let drive_type = drive_type_str(&root_w);
            // v1 picker lists fixed + removable disks only; network/optical/RAM
            // drives are out of scope (network deep support is a non-goal).
            if drive_type != "fixed" && drive_type != "removable" {
                continue;
            }

            let (label, file_system) = volume_information(&root_w);
            let (total, free) = disk_space(&root_w);
            let scan_id = volume_guid_path(&root_w).unwrap_or_else(|| root.clone());
            // Scannable only when we got real size info AND a filesystem (a locked
            // BitLocker volume or an empty removable bay reports neither).
            let supported = total > 0 && !file_system.is_empty();

            out.push(VolumeInfo {
                scan_id,
                root,
                letter,
                label,
                file_system,
                drive_type: drive_type.to_string(),
                total,
                free,
                supported,
            });
        }
        out
    }

    /// Resolve the friendly walk root ("C:\\") for a `ScanId`. A drive-root key is
    /// already the walk root; a GUID-path key is mapped back to its drive letter by
    /// matching `GetVolumeNameForVolumeMountPointW` across present drives. Falls
    /// back to the key itself (a GUID path is a valid `FindFirstFileExW` root too).
    pub fn resolve_walk_root(scan_id: &str) -> String {
        if scan_id.len() >= 2 && scan_id.as_bytes()[1] == b':' {
            // Already a drive-letter root like "C:\\".
            return if scan_id.ends_with('\\') {
                scan_id.to_string()
            } else {
                format!("{scan_id}\\")
            };
        }
        // GUID path — find the drive letter that maps to it.
        let mask = unsafe { GetLogicalDrives() };
        for i in 0..26u32 {
            if mask & (1 << i) == 0 {
                continue;
            }
            let root = format!("{}:\\", (b'A' + i as u8) as char);
            if let Some(g) = volume_guid_path(&wide(&root)) {
                if g == scan_id {
                    return root;
                }
            }
        }
        // Fallback: the GUID path itself enumerates fine; ensure a trailing sep.
        if scan_id.ends_with('\\') {
            scan_id.to_string()
        } else {
            format!("{scan_id}\\")
        }
    }

    /// Query the volume's file-system name for a walk root ("C:\\" / GUID path).
    /// Used to gate the MFT fast-path (NTFS only). Returns "" when unavailable.
    pub fn volume_file_system(walk_root: &str) -> String {
        let root = if walk_root.ends_with('\\') {
            walk_root.to_string()
        } else {
            format!("{walk_root}\\")
        };
        let (_label, fs) = volume_information(&wide(&root));
        fs
    }

    // -------------------------------------------------------------------------
    // Worker pool + directory queue (spec §2.3) — hand-rolled, zero new deps.
    // -------------------------------------------------------------------------

    /// One unit of work: a directory to enumerate, identified by its arena
    /// NodeId and its `\\?\`-prefixed wide path (sans the trailing `\*`).
    struct DirTask {
        node: u32,
        /// `\\?\C:\dir` wide string, NUL-terminated, WITHOUT a trailing separator.
        wpath: Vec<u16>,
    }

    /// The shared, hand-rolled work queue (spec §2.3 — `Mutex<Vec>` + `Condvar`,
    /// no crossbeam). `pending` tracks in-flight + queued tasks so workers know
    /// when the whole walk is drained (queue empty AND nothing being processed).
    struct Queue {
        stack: Vec<DirTask>,
        pending: usize,
        done: bool,
    }

    /// Per-entry result a worker accumulates for one directory, merged into the
    /// arena under the arena lock (keeps the arena critical section tiny).
    struct ChildResult {
        name: String,
        flags: u8,
        logical: u64,
        alloc: u64,
        is_dir: bool,
        /// `\\?\`-prefixed wide path of this child (for dirs we push back).
        wpath: Vec<u16>,
    }

    /// Shared mutable scan state guarded by one `parking_lot::Mutex`. Held only
    /// for the small arena-merge critical section — never across `FindNextFileW`.
    struct Arena {
        nodes: Vec<Node>,
        interner: Interner,
        /// Hardlink dedup seen-set: (VolumeSerial, FileIndex) → counted once.
        seen_links: std::collections::HashSet<(u32, u64)>,
    }

    /// Build the `\\?\`-prefixed wide root for `FindFirstFileExW`. `C:\\` →
    /// `\\?\C:` (no trailing sep). A GUID path `\\?\Volume{..}\` is already
    /// extended-length; we just strip the trailing separator.
    fn ext_root_w(walk_root: &str) -> Vec<u16> {
        let trimmed = walk_root.trim_end_matches('\\');
        let s = if trimmed.starts_with("\\\\?\\") {
            trimmed.to_string()
        } else {
            format!("\\\\?\\{trimmed}")
        };
        wide(&s)
    }

    /// Open a handle for `BY_HANDLE_FILE_INFORMATION` (hardlink dedup, dir count).
    /// Returns None on any failure (denied / in-use) — the caller degrades.
    fn handle_info(wpath: &[u16]) -> Option<BY_HANDLE_FILE_INFORMATION> {
        // SAFETY: `wpath` is a NUL-terminated wide path; flags request metadata
        // only (no content read), open-reparse so we stat the link itself, and
        // backup-semantics so directories can be opened.
        let h: HANDLE = match unsafe {
            CreateFileW(
                PCWSTR(wpath.as_ptr()),
                GENERIC_READ.0,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                None,
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                None,
            )
        } {
            Ok(h) if h != INVALID_HANDLE_VALUE => h,
            _ => return None,
        };
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        // SAFETY: `h` is a live handle; `info` is a valid out-param.
        let ok = unsafe { GetFileInformationByHandle(h, &mut info) };
        // SAFETY: `h` came from CreateFileW and is closed exactly once.
        let _ = unsafe { CloseHandle(h) };
        ok.is_ok().then_some(info)
    }

    // Win32 error codes (winerror.h) used to tell a benign permission/sharing
    // failure (skip the entry, keep scanning) from a hard device error that, in a
    // sustained streak, means the volume disconnected (spec §2.5.5 / §7).
    const ERROR_ACCESS_DENIED: u32 = 5;
    const ERROR_SHARING_VIOLATION: u32 = 32;
    const ERROR_LOCK_VIOLATION: u32 = 33;

    /// Why a directory enumeration failed (spec §2.5). `Denied` is benign — flag
    /// the node, bump `skipped`, continue. `Device` is a hard I/O error (the
    /// volume may have been ejected mid-scan); a sustained streak of these trips
    /// the disconnect transition.
    enum EnumError {
        /// Permission / sharing / lock — degrade this one entry, keep scanning.
        Denied,
        /// Hard device / path error — counts toward the disconnect streak.
        Device,
    }

    /// Enumerate ONE directory's entries in a single `FindFirstFileExW` pass.
    /// Returns the per-entry results; a benign permission/sharing failure bumps
    /// `skipped` and returns `Err(EnumError::Denied)` (the dir node is flagged
    /// DENIED by the caller); a hard device error returns `Err(EnumError::Device)`
    /// so the caller can detect a drive disconnect. Cancel is checked inside the
    /// loop (spec §2.3 / §2.5).
    fn enumerate_dir(
        dir_wpath: &[u16],
        cluster: u64,
        handle: &ScanHandle,
        arena: &Mutex<Arena>,
    ) -> Result<Vec<ChildResult>, EnumError> {
        // Build the search pattern: "<dir>\*".
        let mut pattern: Vec<u16> = dir_wpath.to_vec();
        // dir_wpath is NUL-terminated; drop the NUL, append "\*\0".
        if pattern.last() == Some(&0) {
            pattern.pop();
        }
        pattern.push(b'\\' as u16);
        pattern.push(b'*' as u16);
        pattern.push(0);

        let mut data = WIN32_FIND_DATAW::default();
        // SAFETY: `pattern` is a NUL-terminated wide string; `data` is a valid
        // out-buffer of the correct type. FindExInfoBasic skips the (unused)
        // alternate 8.3 name; LARGE_FETCH batches directory reads.
        let find = unsafe {
            FindFirstFileExW(
                PCWSTR(pattern.as_ptr()),
                FindExInfoBasic,
                &mut data as *mut WIN32_FIND_DATAW as *mut core::ffi::c_void,
                FindExSearchNameMatch,
                None,
                FIND_FIRST_EX_LARGE_FETCH,
            )
        };
        let hfind = match find {
            Ok(h) if h != INVALID_HANDLE_VALUE => h,
            _ => {
                // Classify: a benign permission/sharing failure is skipped+continue;
                // anything else is a hard device error (counts toward disconnect).
                // SAFETY: GetLastError takes no args and reads thread-local state.
                let code = unsafe { GetLastError() }.0;
                if matches!(
                    code,
                    ERROR_ACCESS_DENIED | ERROR_SHARING_VIOLATION | ERROR_LOCK_VIOLATION
                ) {
                    handle.skipped.fetch_add(1, Ordering::Relaxed);
                    return Err(EnumError::Denied);
                }
                return Err(EnumError::Device);
            }
        };

        let mut out: Vec<ChildResult> = Vec::new();
        loop {
            if handle.cancel.load(Ordering::Relaxed) {
                break;
            }
            let attrs = data.dwFileAttributes;
            let name = from_wide_nul(&data.cFileName);
            // Skip the "." and ".." pseudo-entries.
            if name != "." && name != ".." {
                let is_dir = attrs & FILE_ATTRIBUTE_DIRECTORY.0 != 0;
                let is_reparse = attrs & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0;
                let mut flags = 0u8;
                if is_dir {
                    flags |= FLAG_IS_DIR;
                }
                if is_reparse {
                    flags |= FLAG_REPARSE;
                }
                if attrs & FILE_ATTRIBUTE_HIDDEN.0 != 0 {
                    flags |= FLAG_HIDDEN;
                }
                if attrs & FILE_ATTRIBUTE_SYSTEM.0 != 0 {
                    flags |= FLAG_SYSTEM;
                }

                let logical =
                    ((data.nFileSizeHigh as u64) << 32) | (data.nFileSizeLow as u64);

                // Child's extended-length wide path (for dirs we push back; for
                // hardlinked files we open it for dedup).
                let child_wpath = {
                    let mut p: Vec<u16> = dir_wpath.to_vec();
                    if p.last() == Some(&0) {
                        p.pop();
                    }
                    p.push(b'\\' as u16);
                    p.extend(name.encode_utf16());
                    p.push(0);
                    p
                };

                // Reparse points (symlink/junction/mount): treat as a flagged
                // LEAF — do NOT recurse (prevents loops + double-counting,
                // spec §2.5.1). Counted with zero subtree bytes.
                let recurse_dir = is_dir && !is_reparse;

                // Files only: dedup hardlinks (link count > 1) so shared bytes
                // count once (spec §2.5.2). Link-count-1 files skip the handle.
                let mut counted_logical = if is_dir { 0 } else { logical };
                let mut counted_alloc = if is_dir {
                    0
                } else {
                    round_to_cluster(logical, cluster)
                };
                if !is_dir {
                    // Cheap probe: open for BY_HANDLE info only when the file might
                    // be hardlinked. We can't know link count without the handle,
                    // so only pay it when dedup matters by checking after open.
                    if let Some(info) = handle_info(&child_wpath) {
                        if info.nNumberOfLinks > 1 {
                            let key = (
                                info.dwVolumeSerialNumber,
                                ((info.nFileIndexHigh as u64) << 32)
                                    | (info.nFileIndexLow as u64),
                            );
                            let mut a = arena.lock();
                            if !a.seen_links.insert(key) {
                                // Already counted this physical file — zero it.
                                counted_logical = 0;
                                counted_alloc = 0;
                            }
                            drop(a);
                            flags |= FLAG_HARDLINK;
                        }
                    }
                }

                out.push(ChildResult {
                    name,
                    flags,
                    logical: counted_logical,
                    alloc: counted_alloc,
                    is_dir: recurse_dir,
                    wpath: child_wpath,
                });
            }

            // Advance; FindNextFileW returns Err at end-of-enumeration.
            // SAFETY: `hfind` is live; `data` is a valid out-buffer.
            if unsafe { FindNextFileW(hfind, &mut data) }.is_err() {
                break;
            }
        }
        // SAFETY: `hfind` came from FindFirstFileExW and is closed exactly once.
        let _ = unsafe { FindClose(hfind) };
        Ok(out)
    }

    /// One worker loop: pop a directory, enumerate it, merge children into the
    /// arena (top-N aggregation), push child dirs back. Exits when the queue is
    /// drained or cancel is set.
    fn worker(
        queue: &Mutex<Queue>,
        cv: &parking_lot::Condvar,
        arena: &Mutex<Arena>,
        handle: &ScanHandle,
        cluster: u64,
    ) {
        loop {
            // --- pop (or wait / exit) -----------------------------------------
            let task = {
                let mut q = queue.lock();
                loop {
                    if handle.cancel.load(Ordering::Relaxed) || q.done {
                        return;
                    }
                    if let Some(t) = q.stack.pop() {
                        break t;
                    }
                    if q.pending == 0 {
                        // Nothing in flight and nothing queued → walk complete.
                        q.done = true;
                        cv.notify_all();
                        return;
                    }
                    cv.wait(&mut q);
                }
            };

            if handle.cancel.load(Ordering::Relaxed) {
                // Account for the popped task and bail.
                let mut q = queue.lock();
                q.pending -= 1;
                cv.notify_all();
                continue;
            }

            // Publish the directory we're about to walk so a slow (e.g.
            // antivirus-throttled) scan looks visibly *working*, not hung
            // (spec §7 antivirus-slow UX). Tiny lock, swapped only here.
            handle.set_current_path(&task.wpath);

            // --- acquire a GLOBAL walker permit before the slow I/O ----------
            // Caps total concurrent enumerations across ALL scans (spec §2.10),
            // so N concurrent HDD scans can't thrash the I/O subsystem. The
            // permit is held ONLY across the enumeration and released (RAII)
            // before the arena merge. A cancelled scan stops waiting (None).
            let children = {
                let Some(_permit) = WALKER_PERMITS.acquire(&handle.cancel) else {
                    // Cancelled while waiting for a permit — account + drain.
                    let mut q = queue.lock();
                    q.pending -= 1;
                    cv.notify_all();
                    continue;
                };
                // --- enumerate (NO arena/queue lock held across this slow I/O) -
                enumerate_dir(&task.wpath, cluster, handle, arena)
            };
            handle.dirs_seen.fetch_add(1, Ordering::Relaxed);

            // Drive-disconnect detection (spec §2.5.5 / §7): a sustained streak of
            // hard device errors (NOT permission denials) means the volume was
            // ejected/disconnected mid-scan. Trip the disconnect → the scan ends
            // as `Error`; every OTHER concurrent scan is untouched.
            match &children {
                Err(EnumError::Device) => {
                    let streak = handle.io_error_streak.fetch_add(1, Ordering::Relaxed) + 1;
                    if streak as u32 >= DISCONNECT_ERROR_STREAK
                        && !handle.cancel.load(Ordering::Relaxed)
                    {
                        *handle.error.lock() = Some(
                            "drive disconnected (sustained I/O errors)".to_string(),
                        );
                        handle.disconnected.store(true, Ordering::Relaxed);
                        // Flip cancel so all this scan's workers drain promptly.
                        handle.cancel.store(true, Ordering::Relaxed);
                        let mut q = queue.lock();
                        q.pending -= 1;
                        cv.notify_all();
                        continue;
                    }
                }
                _ => {
                    // A successful (or merely-denied) read clears the streak.
                    handle.io_error_streak.store(0, Ordering::Relaxed);
                }
            }

            let denied = children.is_err();
            let mut children = children.unwrap_or_default();

            // --- merge into arena (small critical section) --------------------
            let mut new_dirs: Vec<DirTask> = Vec::new();
            {
                let mut a = arena.lock();
                if denied {
                    a.nodes[task.node as usize].flags |= FLAG_DENIED;
                }

                // Top-N-per-dir source aggregation (spec §2.6): keep the N largest
                // LEAVES (files + non-recursed reparse points) as real nodes; fold
                // the rest into one AGGREGATED leaf. Real directories (is_dir, the
                // ones we descend) always become real nodes — they may hold big
                // subtrees — so they partition out here.
                let (mut files, dirs): (Vec<ChildResult>, Vec<ChildResult>) =
                    children.drain(..).partition(|c| !c.is_dir);
                files.sort_unstable_by(|a, b| b.alloc.cmp(&a.alloc));

                let mut agg_files: u64 = 0;
                let mut agg_logical: u64 = 0;
                let mut agg_alloc: u64 = 0;

                for (idx, c) in files.into_iter().enumerate() {
                    if idx < TOP_N_PER_DIR {
                        ScanHandle::push_child_file(&mut a, handle, task.node, &c);
                    } else {
                        agg_files += 1;
                        agg_logical += c.logical;
                        agg_alloc += c.alloc;
                        // Still account bytes/files in the running totals.
                        handle.files_seen.fetch_add(1, Ordering::Relaxed);
                        handle.bytes_logical.fetch_add(c.logical, Ordering::Relaxed);
                        handle.bytes_alloc.fetch_add(c.alloc, Ordering::Relaxed);
                    }
                }
                if agg_files > 0 {
                    ScanHandle::push_aggregated(&mut a, handle, task.node, agg_files, agg_logical, agg_alloc);
                }

                // Directories: real nodes, queued for descent (unless capped).
                let capped =
                    handle.node_count.load(Ordering::Relaxed) >= NODE_CAP;
                for c in dirs {
                    let child = ScanHandle::push_child_dir(&mut a, handle, task.node, &c);
                    if let Some(child_id) = child {
                        if capped {
                            handle.truncated.store(true, Ordering::Relaxed);
                            a.nodes[child_id as usize].flags |= FLAG_AGGREGATED;
                        } else {
                            new_dirs.push(DirTask {
                                node: child_id,
                                wpath: c.wpath,
                            });
                        }
                    }
                }
            }

            // --- requeue child dirs -------------------------------------------
            {
                let mut q = queue.lock();
                q.pending -= 1; // this task done
                let n = new_dirs.len();
                q.pending += n;
                q.stack.extend(new_dirs);
                if n > 0 {
                    cv.notify_all();
                } else {
                    // We may have been the last in-flight task.
                    cv.notify_all();
                }
            }
        }
    }

    impl ScanHandle {
        /// Append a file leaf to the arena. Caller holds the arena lock.
        fn push_child_file(a: &mut Arena, handle: &ScanHandle, parent: u32, c: &ChildResult) {
            let name_id = a.interner.intern(&c.name);
            let id = a.nodes.len() as u32;
            let prev_first = a.nodes[parent as usize].first_child;
            a.nodes.push(Node {
                parent,
                name_id,
                first_child: SENTINEL,
                next_sibling: prev_first,
                logical_size: c.logical,
                alloc_size: c.alloc,
                file_count: 1,
                flags: c.flags & !FLAG_IS_DIR,
            });
            a.nodes[parent as usize].first_child = id;
            handle.node_count.fetch_add(1, Ordering::Relaxed);
            handle.files_seen.fetch_add(1, Ordering::Relaxed);
            handle.bytes_logical.fetch_add(c.logical, Ordering::Relaxed);
            handle.bytes_alloc.fetch_add(c.alloc, Ordering::Relaxed);
        }

        /// Append a directory node; returns its NodeId. Caller holds the lock.
        fn push_child_dir(
            a: &mut Arena,
            handle: &ScanHandle,
            parent: u32,
            c: &ChildResult,
        ) -> Option<u32> {
            let name_id = a.interner.intern(&c.name);
            let id = a.nodes.len() as u32;
            let prev_first = a.nodes[parent as usize].first_child;
            a.nodes.push(Node {
                parent,
                name_id,
                first_child: SENTINEL,
                next_sibling: prev_first,
                logical_size: 0,
                alloc_size: 0,
                file_count: 0,
                flags: c.flags | FLAG_IS_DIR,
            });
            a.nodes[parent as usize].first_child = id;
            handle.node_count.fetch_add(1, Ordering::Relaxed);
            Some(id)
        }

        /// Append the synthetic "(other M files)" aggregated leaf. Caller holds
        /// the lock. Its name carries the count so the UI can render it directly.
        fn push_aggregated(
            a: &mut Arena,
            handle: &ScanHandle,
            parent: u32,
            files: u64,
            logical: u64,
            alloc: u64,
        ) {
            let name = format!("({files} more files)");
            let name_id = a.interner.intern(&name);
            let id = a.nodes.len() as u32;
            let prev_first = a.nodes[parent as usize].first_child;
            a.nodes.push(Node {
                parent,
                name_id,
                first_child: SENTINEL,
                next_sibling: prev_first,
                logical_size: logical,
                alloc_size: alloc,
                file_count: files as u32,
                flags: FLAG_AGGREGATED,
            });
            a.nodes[parent as usize].first_child = id;
            handle.node_count.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Roll subtree sizes UP the parent spine so the published tree is internally
    /// consistent (spec §2.6). Single post-order pass over the arena: because
    /// children were always appended after their parent, indices are NOT in
    /// topo order, so we accumulate by walking parents from the back.
    fn rollup(nodes: &mut [Node]) {
        // Iterate from the last-added node back to the root; each node adds its
        // OWN size into its parent. Files/aggregated leaves already carry size;
        // dirs start at 0 and receive their children's contributions. Processing
        // back-to-front guarantees a child is fully summed before its parent is
        // visited (a parent always has a smaller index than its children).
        for i in (1..nodes.len()).rev() {
            let (logical, alloc, count, parent) = {
                let n = &nodes[i];
                (n.logical_size, n.alloc_size, n.file_count, n.parent)
            };
            let p = &mut nodes[parent as usize];
            p.logical_size = p.logical_size.saturating_add(logical);
            p.alloc_size = p.alloc_size.saturating_add(alloc);
            p.file_count = p.file_count.saturating_add(count);
        }
    }

    /// Copy the live arena into an immutable `DiskTree` and roll up subtree sizes
    /// — the publish step (spec §2.8). The arena `Mutex` is held ONLY for the
    /// cheap `Vec` clone (no I/O, no roll-up); the O(N) roll-up runs on the COPY
    /// outside the lock, so a worker never blocks on a slow read path. This is the
    /// `sampler.rs` "lock only to copy, work on the clone" contract.
    fn build_snapshot(arena: &Mutex<Arena>) -> DiskTree {
        let (mut nodes, names) = {
            let a = arena.lock();
            (a.nodes.clone(), a.interner.table.clone())
        };
        rollup(&mut nodes);
        DiskTree { nodes, names }
    }

    /// Attempt the MFT fast-path for this scan. Returns `true` when the scan was
    /// fully serviced from the `$MFT` (arena adopted, snapshot published, status
    /// finalized) OR was cancelled mid-build; returns `false` when the MFT path is
    /// unavailable/failed and the caller must run the `FindFirstFileExW` walk.
    ///
    /// On a `false` return NOTHING was published and the status is still
    /// `Scanning`, so the walk proceeds exactly as today. While the (potentially
    /// multi-second) bulk read runs, a throttled emitter animates the same
    /// progress atomics the MFT builder updates — zero emitter changes.
    fn try_run_mft(
        handle: &Arc<ScanHandle>,
        app: &tauri::AppHandle,
        walk_root: &str,
        root_display: &str,
    ) -> bool {
        // Capability gate #1 (cheap, no handle): NTFS only.
        if !handle.file_system.eq_ignore_ascii_case("NTFS") {
            return false;
        }

        // Drive the progress chip during the bulk read with the same throttled
        // emitter the walk uses. It stops as soon as `mft_done` flips.
        let mft_done = Arc::new(AtomicBool::new(false));
        let emit_handle = {
            let handle = Arc::clone(handle);
            let app = app.clone();
            let mft_done = Arc::clone(&mft_done);
            std::thread::Builder::new()
                .name(format!("corepilot-scan-mft-emit-{}", handle.scan_id))
                .spawn(move || {
                    use tauri::Emitter;
                    let mut last = ScanProgressKey::default();
                    while !mft_done.load(Ordering::Relaxed) {
                        std::thread::sleep(PROGRESS_THROTTLE);
                        let p = handle.build_progress();
                        let key = ScanProgressKey::from(&p);
                        if key != last {
                            last = key;
                            let _ = app.emit("disk-scan://progress", p);
                        }
                    }
                })
                .ok()
        };

        *handle.current_path.lock() = Arc::from("(reading $MFT…)");

        // The whole unsafe NTFS path lives in `disk_scan_mft`; it builds into a
        // LOCAL arena and returns it whole or `None` (capability/parse/sanity
        // failure), polling the same cancel flag per chunk.
        let built = crate::disk_scan_mft::try_build_arena_from_mft(
            walk_root,
            &handle.file_system,
            root_display,
            &handle.cancel,
            handle.as_ref(),
        );

        // Stop the MFT emitter regardless of outcome.
        mft_done.store(true, Ordering::Relaxed);
        if let Some(h) = emit_handle {
            let _ = h.join();
        }
        *handle.current_path.lock() = Arc::from("");

        // User-cancelled mid-build: do NOT fall back to the walk. Let the caller's
        // cancel branch finalize as Cancelled.
        if handle.cancel.load(Ordering::Relaxed) {
            return false;
        }

        let Some(built) = built else {
            // Capability/parse/sanity failure → caller runs the proven walk. The
            // builder left the shared state untouched; reset the progress atomics
            // it may have bumped so the walk starts from a clean slate.
            handle.files_seen.store(0, Ordering::Relaxed);
            handle.dirs_seen.store(0, Ordering::Relaxed);
            handle.bytes_logical.store(0, Ordering::Relaxed);
            handle.bytes_alloc.store(0, Ordering::Relaxed);
            handle.node_count.store(0, Ordering::Relaxed);
            return false;
        };

        // Success — adopt the built arena. Mirror the walk's final publish: build
        // the immutable `DiskTree`, roll subtree sizes UP the parent spine (the
        // builder leaves own-sizes only, exactly like the live walk arena), and
        // pointer-swap it into the publish channel.
        let BuiltArena {
            mut nodes,
            names,
            files_seen,
            dirs_seen,
            bytes_logical,
            bytes_alloc,
            node_count,
            truncated,
        } = built;
        rollup(&mut nodes);
        handle.files_seen.store(files_seen, Ordering::Relaxed);
        handle.dirs_seen.store(dirs_seen, Ordering::Relaxed);
        handle.bytes_logical.store(bytes_logical, Ordering::Relaxed);
        handle.bytes_alloc.store(bytes_alloc, Ordering::Relaxed);
        handle.node_count.store(node_count, Ordering::Relaxed);
        if truncated {
            handle.truncated.store(true, Ordering::Relaxed);
        }
        handle.publish(Arc::new(DiskTree { nodes, names }));
        handle.set_status(ScanStatus::Done);

        use tauri::Emitter;
        let _ = app.emit("disk-scan://progress", handle.build_progress());
        true
    }

    /// Run the whole scan for one disk on this (already-dedicated) thread. Builds
    /// the arena via a small worker pool, rolls up sizes, publishes one snapshot.
    pub fn run_scan(handle: Arc<ScanHandle>, app: tauri::AppHandle) {
        let walk_root = handle.walk_root.to_string();
        let root_display = handle.root_display.to_string();
        let root_w = ext_root_w(&walk_root);
        let cluster = cluster_size(&wide(&walk_root));

        // --- MFT fast-path (spec §2/§3) ---------------------------------------
        // Try the raw $MFT bulk read FIRST. It is gated behind every capability
        // check (NTFS, elevation, FSCTL, parse + sanity), is side-effect-free on
        // the shared scan state until it returns a complete, sanity-checked arena,
        // and returns `None` for ANY failure → we fall through to the proven
        // `FindFirstFileExW` walk below with ZERO behavior change. A user cancel
        // mid-MFT finalizes as `Cancelled` WITHOUT falling back (capability
        // failures fall back; user cancel does not — spec §3.3).
        // MFT fast-path is OPT-IN (COREPILOT_MFT=1) — close, not yet exact. Ground
        // truth (SpaceSniffer + the complete walk) on the 9950X3D C: = 3.5 TiB,
        // Users 1.8 TiB. It is ~8× faster than the walk (full C: in ~33 s vs ~281 s)
        // and DISPLAYS (DiskWorkspace finish-fetch). The resident-$ATTRIBUTE_LIST
        // fix (disk_scan_mft) recovered the big undercount — Users is now 1.82 TB
        // (was 1.0 TB), awa/Program Files/War Thunder match the walk within 1-3% —
        // but two gaps keep it opt-in:
        //   • pass-2 PLACEMENT still drops ~0.8 TB (resolved totals 4.03 TB vs tree
        //     3.22 TB): files whose parent dir node wasn't built (orphan /
        //     reparse-ancestor / cap) are counted but not placed.
        //   • NON-RESIDENT $ATTRIBUTE_LIST is not yet followed (v1 reads resident
        //     lists only), so a few huge fragmented trees (e.g. Program Files (x86)
        //     590 vs 729 GB) still read short.
        // Close both (place every counted file; read non-resident attr-lists) before
        // making MFT the default — until then the proven walk runs.
        if std::env::var("COREPILOT_MFT").is_ok()
            && try_run_mft(&handle, &app, &walk_root, &root_display)
        {
            return;
        }
        if handle.cancel.load(Ordering::Relaxed) {
            // Cancelled during the MFT attempt before any partial build — finalize
            // as Cancelled rather than running the walk on a cancelled scan.
            handle.publish(Arc::new(DiskTree::default()));
            handle.set_status(ScanStatus::Cancelled);
            use tauri::Emitter;
            let _ = app.emit("disk-scan://progress", handle.build_progress());
            return;
        }

        // Seed the arena with the root node (name = display root, e.g. "C:\\").
        let mut interner = Interner::new();
        let root_name_id = interner.intern(&root_display);
        let arena = Mutex::new(Arena {
            nodes: vec![Node {
                parent: 0,
                name_id: root_name_id,
                first_child: SENTINEL,
                next_sibling: SENTINEL,
                logical_size: 0,
                alloc_size: 0,
                file_count: 0,
                flags: FLAG_IS_DIR,
            }],
            interner,
            seen_links: std::collections::HashSet::new(),
        });
        handle.node_count.store(1, Ordering::Relaxed);

        let queue = Mutex::new(Queue {
            stack: vec![DirTask {
                node: 0,
                wpath: root_w,
            }],
            pending: 1,
            done: false,
        });
        let cv = parking_lot::Condvar::new();

        // Worker count: I/O-bound, so small (spec §2.3). min(cores, 8).
        let workers = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
            .clamp(1, 8);

        // Progress emitter — a separate thread polling the atomics on a throttle
        // (spec §2.8); scalars only, never the tree. Stops when the walk ends.
        let walk_done = Arc::new(AtomicBool::new(false));
        let emit_handle = {
            let handle = Arc::clone(&handle);
            let app = app.clone();
            let walk_done = Arc::clone(&walk_done);
            std::thread::Builder::new()
                .name(format!("corepilot-scan-emit-{}", handle.scan_id))
                .spawn(move || {
                    use tauri::Emitter;
                    let mut last = ScanProgressKey::default();
                    while !walk_done.load(Ordering::Relaxed) {
                        std::thread::sleep(PROGRESS_THROTTLE);
                        let p = handle.build_progress();
                        let key = ScanProgressKey::from(&p);
                        if key != last {
                            last = key;
                            let _ = app.emit("disk-scan://progress", p);
                        }
                    }
                })
                .ok()
        };

        // Fan out workers + ONE incremental publisher on dedicated threads scoped
        // to this scan. The publisher copies the arena under a short lock, rolls
        // up the copy outside the lock, and pointer-swaps it in at ~2–4 Hz
        // (spec §2.8) so the frontend can pull a growing tree mid-scan. It exits
        // when the queue drains (`done`) or cancel is set; the scope then returns.
        std::thread::scope(|s| {
            for w in 0..workers {
                let queue = &queue;
                let cv = &cv;
                let arena = &arena;
                let handle = &handle;
                std::thread::Builder::new()
                    .name(format!("corepilot-scan-{}-w{w}", handle.scan_id))
                    .spawn_scoped(s, move || worker(queue, cv, arena, handle, cluster))
                    .ok();
            }
            {
                let queue = &queue;
                let arena = &arena;
                let handle = &handle;
                std::thread::Builder::new()
                    .name(format!("corepilot-scan-{}-pub", handle.scan_id))
                    .spawn_scoped(s, move || loop {
                        std::thread::sleep(PUBLISH_THROTTLE);
                        let finished = handle.cancel.load(Ordering::Relaxed)
                            || queue.lock().done;
                        // Publish (even on the final iteration) so the last
                        // mid-scan view reflects the latest growth; the post-scope
                        // publish below produces the authoritative final tree.
                        let tree = build_snapshot(arena);
                        handle.publish(Arc::new(tree));
                        if finished {
                            return;
                        }
                    })
                    .ok();
            }
        });

        // Walk done (or cancelled / disconnected). Roll up + publish the
        // authoritative snapshot so the partial tree is still viewable.
        let cancelled = handle.cancel.load(Ordering::Relaxed);
        let disconnected = handle.disconnected.load(Ordering::Relaxed);
        {
            let tree = build_snapshot(&arena);
            handle.publish(Arc::new(tree));
        }

        // A drive disconnect ends as Error (its own banner); a user cancel ends as
        // Cancelled; a clean drain ends as Done (spec §2.5.5 / §7).
        handle.set_status(if disconnected {
            ScanStatus::Error
        } else if cancelled {
            ScanStatus::Cancelled
        } else {
            ScanStatus::Done
        });
        // Clear the live-path chip once the walk ends.
        *handle.current_path.lock() = Arc::from("");

        // Stop the emitter and fire one final progress event.
        walk_done.store(true, Ordering::Relaxed);
        if let Some(h) = emit_handle {
            let _ = h.join();
        }
        {
            use tauri::Emitter;
            let _ = app.emit("disk-scan://progress", handle.build_progress());
        }
    }
}

/// Cheap change-detection key so the emitter only fires when counters actually
/// move (spec §2.8: "emit only if … counters changed").
#[derive(Default, PartialEq, Eq)]
struct ScanProgressKey {
    status: u8,
    files: u64,
    dirs: u64,
    gen: u64,
    truncated: bool,
}

impl From<&ScanProgress> for ScanProgressKey {
    fn from(p: &ScanProgress) -> Self {
        ScanProgressKey {
            status: match p.status.as_str() {
                "done" => 1,
                "cancelled" => 2,
                "error" => 3,
                _ => 0,
            },
            files: p.files_seen,
            dirs: p.dirs_seen,
            gen: p.generation,
            truncated: p.truncated,
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod win {
    use super::*;
    pub fn list_volumes() -> Vec<VolumeInfo> {
        Vec::new()
    }
    pub fn resolve_walk_root(scan_id: &str) -> String {
        scan_id.to_string()
    }
    pub fn volume_file_system(_walk_root: &str) -> String {
        String::new()
    }
    pub fn run_scan(handle: Arc<ScanHandle>, _app: tauri::AppHandle) {
        handle.set_status(ScanStatus::Done);
    }
}

// =============================================================================
// Tauri commands (spec §2.9) — all O(1) / non-blocking.
// =============================================================================

/// Startup directive from the `COREPILOT_STARTUP` env var (empty when unset).
/// The frontend reads this on mount to optionally jump to a tab + auto-scan — a
/// hook for automated/headless verification (e.g. `COREPILOT_STARTUP=disk` opens
/// the Disk Analyzer and scans the system drive). No effect for normal launches.
#[tauri::command]
pub fn startup_directive() -> Option<String> {
    std::env::var("COREPILOT_STARTUP").ok().filter(|s| !s.is_empty())
}

/// Enumerate fixed + removable volumes for the disk-picker landing (Zone A).
///
/// O(1) from the IPC router's perspective: the Win32 enumeration runs on the
/// blocking pool so a slow/disconnected volume can never stall the main thread.
#[tauri::command]
pub async fn disk_list_volumes() -> CoreResult<Vec<VolumeInfo>> {
    tauri::async_runtime::spawn_blocking(win::list_volumes)
        .await
        .map_err(|e| crate::error::CoreError::Msg(format!("task failed: {e}")))
}

/// Start scanning each requested disk. Inserts a `ScanHandle` and spawns one
/// dedicated owner thread per disk (NOT the `spawn_blocking` pool). Returns the
/// keys immediately — O(1) from the caller's view. A `scan_id` that is already
/// scanning is left untouched (idempotent re-start is `disk_scan_rescan`, Phase 5).
#[tauri::command]
pub fn disk_scan_start(app: tauri::AppHandle, scan_ids: Vec<ScanId>) -> CoreResult<Vec<ScanId>> {
    let mut started = Vec::new();
    for scan_id in scan_ids {
        // Skip a scan that is already in flight for this key.
        if let Some(existing) = SCANS.get(&scan_id) {
            if existing.status() == ScanStatus::Scanning {
                started.push(scan_id);
                continue;
            }
        }
        let walk_root = win::resolve_walk_root(&scan_id);
        let root_display = walk_root.clone();
        let file_system = win::volume_file_system(&walk_root);
        let handle = Arc::new(ScanHandle::new(
            scan_id.clone(),
            root_display,
            walk_root,
            file_system,
        ));
        SCANS.insert(scan_id.clone(), Arc::clone(&handle));

        let app = app.clone();
        let spawned = std::thread::Builder::new()
            .name(format!("corepilot-scan-{scan_id}"))
            .spawn(move || win::run_scan(handle, app));
        if let Err(e) = spawned {
            // A failed spawn must not leave a forever-scanning handle (spec §7).
            if let Some(h) = SCANS.get(&scan_id) {
                *h.error.lock() = Some(format!("scan thread failed to spawn: {e}"));
                h.set_status(ScanStatus::Error);
            }
            tracing::warn!("corepilot-scan-{scan_id} thread failed to spawn: {e}");
        }
        started.push(scan_id);
    }
    Ok(started)
}

/// Flip the per-disk cancel atomic. O(1); the walk drains promptly (checked when
/// popping the queue AND inside the per-entry loop). No-op for an unknown key.
#[tauri::command]
pub fn disk_scan_cancel(scan_id: ScanId) -> CoreResult<()> {
    if let Some(h) = SCANS.get(&scan_id) {
        h.cancel.store(true, Ordering::Relaxed);
    }
    Ok(())
}

/// Read the per-disk progress atomics. O(1). The event is the live channel; this
/// is for cold reads / reconnect (spec §7). Errors for an unknown key.
#[tauri::command]
pub fn disk_scan_status(scan_id: ScanId) -> CoreResult<ScanProgress> {
    match SCANS.get(&scan_id) {
        Some(h) => Ok(h.build_progress()),
        None => Err(crate::error::CoreError::Msg(format!(
            "no scan for {scan_id}"
        ))),
    }
}

/// Internal accessor for the per-disk handle (Phase 2 `disk_tree` / `disk_top_items`
/// clone the published `Arc<DiskTree>` through this).
pub fn scan_handle(scan_id: &str) -> Option<Arc<ScanHandle>> {
    SCANS.get(scan_id).map(|h| Arc::clone(&h))
}

/// Default LOD knobs for `disk_tree` when the frontend omits them (the treemap's
/// initial pull). The client tunes these via the toolbar LOD slider (spec §4.5).
// Deep + large by default so the treemap fills like SpaceSniffer (a full-disk
// overview, not just the top 4 levels). The CLIENT treemap has its own pixel-LOD
// (stops recursing into sub-pixel rects) and a draw-count cap, so a big/deep slice
// renders densely where pixels allow without over-drawing — container interiors
// (e.g. a huge `Videos/`) fill with their contents instead of staying empty.
const DEFAULT_DEPTH_LIMIT: u8 = 16;
const DEFAULT_MAX_NODES: u32 = 16000;

/// Return a bounded LOD slice of a scan's published tree (spec §2.9). The backend
/// does the slicing so a huge tree never crosses IPC whole; the workhorse for the
/// treemap. Clones the published `Arc<DiskTree>` (O(1)) then slices on the COPY —
/// no scan lock is held — on the blocking pool so the IPC router never stalls.
///
/// `focus_path` is `None`/empty for the disk root, else an absolute path under the
/// root (drill-down). `depth_limit` caps levels below the focus; `min_bytes`
/// collapses children below that alloc size; `max_nodes` hard-caps the slice.
#[tauri::command]
pub async fn disk_tree(
    scan_id: ScanId,
    focus_path: Option<String>,
    depth_limit: Option<u8>,
    min_bytes: Option<u64>,
    max_nodes: Option<u32>,
) -> CoreResult<TreeView> {
    let handle = scan_handle(&scan_id)
        .ok_or_else(|| crate::error::CoreError::Msg(format!("no scan for {scan_id}")))?;
    let depth = depth_limit.unwrap_or(DEFAULT_DEPTH_LIMIT).max(1);
    let min_bytes = min_bytes.unwrap_or(0);
    let max_nodes = max_nodes.unwrap_or(DEFAULT_MAX_NODES).max(1);

    tauri::async_runtime::spawn_blocking(move || {
        // O(1) Arc clone of the published snapshot; slice the immutable copy.
        let tree = handle.snapshot();
        let generation = handle.generation.load(Ordering::Relaxed);
        let focus = tree
            .node_for_path(focus_path.as_deref())
            .ok_or_else(|| crate::error::CoreError::Msg("focus path not in tree".into()))?;
        Ok(tree.slice(&scan_id, generation, focus, depth, min_bytes, max_nodes))
    })
    .await
    .map_err(|e| crate::error::CoreError::Msg(format!("task failed: {e}")))?
}

/// Top-N largest items in a scan's focused (sub)tree, by alloc size (spec §2.9 /
/// §4.6 — the "what's eating my space" flat list). Clones the published `Arc`
/// (O(1)) and walks the immutable copy on the blocking pool.
#[tauri::command]
pub async fn disk_top_items(
    scan_id: ScanId,
    focus_path: Option<String>,
    n: Option<u32>,
) -> CoreResult<Vec<ItemRow>> {
    let handle = scan_handle(&scan_id)
        .ok_or_else(|| crate::error::CoreError::Msg(format!("no scan for {scan_id}")))?;
    let n = n.unwrap_or(20).max(1);

    tauri::async_runtime::spawn_blocking(move || {
        let tree = handle.snapshot();
        let focus = tree
            .node_for_path(focus_path.as_deref())
            .ok_or_else(|| crate::error::CoreError::Msg("focus path not in tree".into()))?;
        Ok(tree.top_items(focus, n))
    })
    .await
    .map_err(|e| crate::error::CoreError::Msg(format!("task failed: {e}")))?
}
