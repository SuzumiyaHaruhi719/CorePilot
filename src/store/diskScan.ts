import { create } from "zustand";
import type { ScanProgress } from "../lib/ipc";
import type { Metric } from "../tabs/disk/treemap/layout";
import type { ColorMode } from "../tabs/disk/treemap/colors";

/**
 * Per-disk scan view-state registry (spec §4.3).
 *
 * Mirrors the backend `DashMap<ScanId, Arc<ScanHandle>>`: one `PerDiskView` per
 * scanned disk, keyed by the same `scanId`. ALL per-tab view-state (drill stack,
 * selection, metric/color/LOD/pause, last progress + generation + fetched tree)
 * lives here, so switching the `SecondaryTabs` strip is a pure O(1) store read —
 * no remount, no recompute, no lost drill state — while every scan keeps running
 * on its own backend thread.
 *
 * Session-only (matches `ui.ts`): scans are in-memory, never persisted. There is
 * deliberately NO `persist` here — a restart starts from the picker, and the
 * backend tree is gone with the process anyway.
 *
 * The store is fed by:
 *  - the coalesced `disk-scan://progress` listener (`useDiskScanEvents`) → `setProgress`
 *  - the active-tab `disk_tree` poller (`DiskWorkspace`) → `setView` / per-tab knobs
 *
 * See docs/superpowers/specs/2026-06-23-disk-space-analyzer-design.md §4.3/§4.4.
 */

/** One drill level: its absolute focus path (null = disk root) + display label. */
export interface FocusLevel {
  path: string | null;
  label: string;
}

/** Per-tab view state for one scanned disk. */
export interface PerDiskView {
  scanId: string;
  /** Friendly root label for the breadcrumb root + the tab strip (e.g. "C:"). */
  rootLabel: string;
  /** The volume's used bytes (`total - free`) at scan-start, threaded from the
   *  picker so the tab can show a real progress % (scanned bytes / used bytes).
   *  0 when unknown (then the tab falls back to an indeterminate spinner). */
  usedBytes: number;
  /** Latest scalar progress (fed by the coalesced `disk-scan://progress` listener). */
  progress: ScanProgress | null;
  /** Per-tab size metric (spec §2.4). */
  metric: Metric;
  /** Per-tab color scheme (default "depth" — owner §7). */
  colorMode: ColorMode;
  /** Per-tab "pause live updates" — when true the active-tab poller stops re-pulling. */
  paused: boolean;
  /** LOD density 1..10 (→ a `minBytes` floor; higher = coarser). */
  lod: number;
  /** Drill stack: stack[0] is the disk root; the last entry is the current focus. */
  stack: FocusLevel[];
}

/** A fresh per-disk view at the disk root with the default knobs. */
function freshView(scanId: string, rootLabel: string, usedBytes = 0): PerDiskView {
  return {
    scanId,
    rootLabel,
    usedBytes,
    progress: null,
    metric: "alloc",
    colorMode: "depth",
    paused: false,
    lod: 3,
    stack: [{ path: null, label: rootLabel }],
  };
}

interface DiskScanStore {
  /** All open disk tabs, keyed by scanId. */
  views: Record<string, PerDiskView>;
  /** Tab order for the `SecondaryTabs` strip (open order). */
  order: string[];
  /** Active inner tab (which disk the workspace shows); null → the picker (Zone A). */
  active: string | null;

  /** Open (or focus) a disk tab. Idempotent — re-opening keeps existing view state. */
  openDisk: (scanId: string, rootLabel: string, usedBytes?: number) => void;
  /** Open several disks at once (concurrent multi-disk start) and focus the first. */
  openDisks: (disks: { scanId: string; rootLabel: string; usedBytes?: number }[]) => void;
  /** Switch the active inner tab (O(1); the scan keeps running). */
  setActive: (scanId: string | null) => void;
  /** Close a disk tab (after the backend `disk_scan_close`); re-targets `active`. */
  closeDisk: (scanId: string) => void;

  /** Merge fresh scalar progress for a disk (from the coalesced event). */
  setProgress: (scanId: string, progress: ScanProgress) => void;
  /** Patch a disk's per-tab knobs / drill stack (metric/color/paused/lod/stack). */
  patchView: (scanId: string, patch: Partial<PerDiskView>) => void;
}

export const useDiskScan = create<DiskScanStore>()((set) => ({
  views: {},
  order: [],
  active: null,

  openDisk: (scanId, rootLabel, usedBytes = 0) =>
    set((s) => {
      // Re-opening (e.g. a rescan) keeps view state but refreshes the denominator.
      if (s.views[scanId]) {
        const v = s.views[scanId];
        return {
          views: { ...s.views, [scanId]: { ...v, usedBytes: usedBytes || v.usedBytes } },
          active: scanId,
        };
      }
      return {
        views: { ...s.views, [scanId]: freshView(scanId, rootLabel, usedBytes) },
        order: [...s.order, scanId],
        active: scanId,
      };
    }),

  openDisks: (disks) =>
    set((s) => {
      if (disks.length === 0) return s;
      const views = { ...s.views };
      const order = [...s.order];
      for (const d of disks) {
        if (!views[d.scanId]) {
          views[d.scanId] = freshView(d.scanId, d.rootLabel, d.usedBytes ?? 0);
          order.push(d.scanId);
        } else if (d.usedBytes) {
          // Refresh the denominator on a re-open without clobbering view state.
          views[d.scanId] = { ...views[d.scanId], usedBytes: d.usedBytes };
        }
      }
      return { views, order, active: disks[0].scanId };
    }),

  setActive: (active) => set({ active }),

  closeDisk: (scanId) =>
    set((s) => {
      if (!s.views[scanId]) return s;
      const views = { ...s.views };
      delete views[scanId];
      const order = s.order.filter((id) => id !== scanId);
      // Re-target the active tab to a neighbour (the one before the closed tab),
      // falling back to the picker when nothing remains.
      let active = s.active;
      if (active === scanId) {
        const idx = s.order.indexOf(scanId);
        active = order[Math.min(idx, order.length - 1)] ?? null;
      }
      return { views, order, active };
    }),

  setProgress: (scanId, progress) =>
    set((s) => {
      const v = s.views[scanId];
      if (!v) return s;
      // No-op skip: identical generation + status + counters → don't churn React
      // (the event fires faster than anything visibly changes). The live-path chip
      // (`currentPath`) is deliberately part of the comparison so the antivirus-slow
      // "still working" indicator + the skipped/disconnect surfaces stay current,
      // but the backend already throttles the event to ~5 Hz so this never floods.
      const p = v.progress;
      if (
        p &&
        p.generation === progress.generation &&
        p.status === progress.status &&
        p.filesSeen === progress.filesSeen &&
        p.dirsSeen === progress.dirsSeen &&
        p.bytesAlloc === progress.bytesAlloc &&
        p.skipped === progress.skipped &&
        p.truncated === progress.truncated &&
        p.disconnected === progress.disconnected &&
        p.currentPath === progress.currentPath
      ) {
        return s;
      }
      return { views: { ...s.views, [scanId]: { ...v, progress } } };
    }),

  patchView: (scanId, patch) =>
    set((s) => {
      const v = s.views[scanId];
      if (!v) return s;
      return { views: { ...s.views, [scanId]: { ...v, ...patch } } };
    }),
}));
