import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import type { ScanProgress } from "../lib/ipc";
import { useDiskScan } from "../store/diskScan";

/**
 * App-level coalesced `disk-scan://progress` listener (spec §4.4).
 *
 * The backend throttles the event to ~4–10 Hz PER job, and a multi-disk scan
 * multiplies that (4 disks × ~6 Hz = ~24/s). Each event is scalars only (never
 * the tree). We buffer the latest payload PER scanId and flush them all on a
 * single trailing ~16 ms tick (the `App.tsx` `osd:cfg` coalescing pattern), so a
 * high-frequency progress stream can't churn React renders into janking the very
 * canvas it drives. The tree itself is PULLED via `disk_tree` by the active tab
 * (see `DiskWorkspace`), never pushed here.
 *
 * Mount ONCE in <App>. The `listen()` promise resolves to its unlisten fn
 * asynchronously; we guard the mount/cleanup race the same way `usePerfRecorder`
 * does so a late-resolved listener can't leak in StrictMode.
 *
 * See docs/superpowers/specs/2026-06-23-disk-space-analyzer-design.md §4.4.
 */
export function useDiskScanEvents(): void {
  useEffect(() => {
    // Buffer the latest payload per scanId; flush on a trailing tick.
    const pending = new Map<string, ScanProgress>();
    let timer: number | null = null;

    const flush = () => {
      timer = null;
      if (pending.size === 0) return;
      const { setProgress } = useDiskScan.getState();
      for (const [scanId, progress] of pending) setProgress(scanId, progress);
      pending.clear();
    };

    const onProgress = (p: ScanProgress) => {
      pending.set(p.scanId, p);
      if (timer == null) timer = window.setTimeout(flush, 16);
    };

    let unlisten: (() => void) | undefined;
    let disposed = false;
    void listen<ScanProgress>("disk-scan://progress", (e) => onProgress(e.payload)).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });

    return () => {
      disposed = true;
      unlisten?.();
      if (timer != null) clearTimeout(timer);
    };
  }, []);
}
