import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Segmented } from "../../components/ui/Segmented";
import { Slider } from "../../components/ui/Slider";
import { Toggle } from "../../components/ui/Toggle";
import { useTf } from "../../lib/i18n";
import { api, withTimeout, type TreeNode, type TreeView } from "../../lib/ipc";
import { useDiskScan, type PerDiskView } from "../../store/diskScan";
import { TreemapCanvas } from "./treemap/TreemapCanvas";
import { Breadcrumb, type CrumbSegment } from "./treemap/Breadcrumb";
import { DetailPanel } from "./DetailPanel";
import type { Metric } from "./treemap/layout";
import type { ColorMode } from "./treemap/colors";

/**
 * Per-disk treemap workspace (spec §4.2 Zone C + §3.4 drill + §3.8 live fill-in +
 * §4.5 toolbar + §4.6 detail).
 *
 * PHASE 5 lifts all per-tab view-state (metric / color / pause / LOD / drill
 * stack) into `diskScan.ts` keyed by `scanId`, so the `SecondaryTabs` strip can
 * switch disks with a pure O(1) store read — no remount, no lost drill state —
 * while every scan keeps running on its own backend thread. This component is now
 * a CONTROLLED view of one `PerDiskView`:
 *
 *  - Drill / metric / color / pause / LOD all read from + write to the store.
 *  - **Active-tab live polling (§3.8/§4.4):** while the scan is still running and
 *    "pause live updates" is OFF, a backpressured ~3 Hz poller re-pulls
 *    `disk_tree` on a NEW snapshot `generation` so folders visibly fill in. A
 *    paused / finished tab stops polling. `mounted` only while this disk is the
 *    active tab, so background tabs never poll (their scan still runs).
 *  - A one-shot ~220ms zoom tween on drill (gated by `data-reduce-motion`; canvas
 *    stays out of any Motion `layout` container — MEMORY: group glow).
 *  - The side detail panel (`disk_top_items` + selection).
 *
 * See docs/superpowers/specs/2026-06-23-disk-space-analyzer-design.md §3.4/§3.8/§4.
 */

interface DiskWorkspaceProps {
  scanId: string;
}

/** LOD density → a `minBytes` floor below which children collapse server-side. */
function minBytesFor(d: number): number {
  // 1 → 0 (show everything); 10 → ~32 MB floor. Geometric so the low end is fine.
  if (d <= 1) return 0;
  return Math.round(64 * 1024 * (1 << (d - 1))); // 64KB..32MB across 2..10
}

export function DiskWorkspace({ scanId }: DiskWorkspaceProps) {
  const tf = useTf();

  // The per-tab view-state lives in the store now (instant tab-switch, §4.3).
  const view = useDiskScan((s) => s.views[scanId]);
  const patchView = useDiskScan((s) => s.patchView);

  // Transient render state (NOT persisted across tab switches — re-pulled on focus).
  const [tree, setTree] = useState<TreeView | null>(null);
  const [selected, setSelected] = useState<TreeNode | null>(null);
  const [hovered, setHovered] = useState<TreeNode | null>(null);
  const [loading, setLoading] = useState(true);

  const zoomRef = useRef<HTMLDivElement>(null);

  // The store entry can be momentarily undefined during a close re-target.
  const metric: Metric = view?.metric ?? "alloc";
  const colorMode: ColorMode = view?.colorMode ?? "depth";
  const paused = view?.paused ?? false;
  const lod = view?.lod ?? 3;
  const stack = view?.stack ?? [{ path: null, label: "" }];
  const focusPath = stack[stack.length - 1]?.path ?? null;
  const progress = view?.progress ?? null;
  const scanning = progress?.status === "scanning";
  const generation = progress?.generation ?? 0;

  const patch = useCallback(
    (p: Partial<PerDiskView>) => patchView(scanId, p),
    [patchView, scanId],
  );

  // Pull the tree for the current focus. Re-runs on a drill/ascend or an LOD-knob
  // change. Selection clears on a focus change. This is the AUTHORITATIVE fetch;
  // the live poller below only re-fetches the SAME focus on a new generation.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .diskTree(scanId, focusPath, { minBytes: minBytesFor(lod) })
      .then((tv) => {
        if (!alive) return;
        setTree(tv);
        setSelected(null);
        setHovered(null);
        setLoading(false);
      })
      .catch(() => {
        if (!alive) return;
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [scanId, focusPath, lod]);

  // Live fill-in (spec §3.8/§4.4): while THIS active tab's scan is still running
  // and not paused, re-pull `disk_tree` for the CURRENT focus on a new snapshot
  // `generation`, backpressured so a fast scan can't pile up invokes. The same
  // metric/color the canvas already uses just animates the new (larger) sizes via
  // the layout — folders grow as the scan fills in. Paused / done → no polling.
  const lastFetchedGen = useRef(-1);
  useEffect(() => {
    if (!scanning || paused) return;
    let alive = true;
    let inFlight = false;
    const tick = async () => {
      if (!alive || inFlight) return;
      // Only re-fetch when the published snapshot advanced past what we drew.
      const g = useDiskScan.getState().views[scanId]?.progress?.generation ?? 0;
      if (g <= lastFetchedGen.current) return;
      inFlight = true;
      try {
        const fp = useDiskScan.getState().views[scanId]?.stack.slice(-1)[0]?.path ?? null;
        const tv = await withTimeout(api.diskTree(scanId, fp, { minBytes: minBytesFor(lod) }));
        if (!alive) return;
        lastFetchedGen.current = tv.generation;
        setTree(tv);
        setLoading(false);
      } catch {
        /* transient — keep the last tree */
      } finally {
        inFlight = false;
      }
    };
    const id = window.setInterval(() => void tick(), 320);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
    // Re-arm when the active scan status / pause / focus / LOD changes. `generation`
    // is read live inside the tick (not a dep) so we don't thrash the interval.
  }, [scanId, scanning, paused, focusPath, lod]);

  // Reset the fill-in watermark whenever the focus changes (a fresh focus fetch
  // above sets the baseline; the poller then chases gens beyond it).
  useEffect(() => {
    lastFetchedGen.current = generation;
  }, [focusPath, generation]);

  /** One-shot ~220ms zoom tween toward a picked rect (gated by reduce-motion). */
  const playZoom = useCallback((origin: { x: number; y: number; w: number; h: number } | null) => {
    const el = zoomRef.current;
    if (!el) return;
    if (document.documentElement.dataset.reduceMotion === "true") return;
    const box = el.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return;
    const sx = origin ? Math.max(0.001, origin.w / box.width) : 0.86;
    const sy = origin ? Math.max(0.001, origin.h / box.height) : 0.86;
    const ox = origin ? ((origin.x + origin.w / 2) / box.width) * 100 : 50;
    const oy = origin ? ((origin.y + origin.h / 2) / box.height) * 100 : 50;
    el.style.transformOrigin = `${ox}% ${oy}%`;
    el.animate(
      [
        { transform: `scale(${sx}, ${sy})`, opacity: 0.35 },
        { transform: "scale(1, 1)", opacity: 1 },
      ],
      { duration: 220, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
    );
  }, []);

  // Drill into a container, or select a leaf (spec §3.4). Bucket tiles (localId
  // -1) are a no-op in v1 (re-laying out a bucket is a later refinement).
  const onPick = useCallback(
    (node: TreeNode | null) => {
      if (!node) return;
      const drillable = node.path != null && (node.hasMore || (node.flags & 1) !== 0);
      if (drillable && node.path) {
        playZoom(null);
        const cur = useDiskScan.getState().views[scanId]?.stack ?? [];
        patch({ stack: [...cur, { path: node.path, label: node.name }] });
      } else {
        setSelected(node);
      }
    },
    [playZoom, patch, scanId],
  );

  // Ascend to a breadcrumb depth (0 = disk root).
  const navigate = useCallback(
    (depth: number) => {
      const cur = useDiskScan.getState().views[scanId]?.stack ?? [];
      if (depth < cur.length - 1) patch({ stack: cur.slice(0, depth + 1) });
    },
    [patch, scanId],
  );

  const crumbs: CrumbSegment[] = stack.map((lvl) => ({ label: lvl.label }));

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Thin toolbar bar above the canvas (spec §4.5). */}
      <div className="flex flex-wrap items-center gap-2.5 border-b border-line px-4 py-2.5">
        <Breadcrumb segments={crumbs} onNavigate={navigate} />

        <div className="flex items-center gap-2.5">
          <Segmented
            id={`disk-metric-${scanId}`}
            value={metric}
            onChange={(v) => patch({ metric: v })}
            options={[
              { value: "alloc", label: "占用空间" },
              { value: "logical", label: "逻辑大小" },
            ]}
          />
          <Segmented
            id={`disk-color-${scanId}`}
            value={colorMode}
            onChange={(v) => patch({ colorMode: v })}
            options={[
              { value: "depth", label: "按层级" },
              { value: "type", label: "按类型" },
            ]}
          />
          <div className="w-[128px]">
            <Slider
              label={tf("细节密度", "Detail")}
              value={lod}
              min={1}
              max={10}
              onChange={(v) => patch({ lod: v })}
            />
          </div>
          <label className="flex items-center gap-1.5 text-[11.5px] text-muted">
            <Toggle
              checked={paused}
              onChange={(v) => patch({ paused: v })}
              label={tf("暂停实时更新", "Pause live updates")}
            />
            <span className="whitespace-nowrap">{tf("暂停", "Pause")}</span>
          </label>
        </div>
      </div>

      {/* Workspace: treemap (left ~70%) + detail panel (right). */}
      <div className="flex min-h-0 flex-1">
        <div ref={zoomRef} className="relative min-w-0 flex-1">
          {tree && tree.nodes.length > 0 ? (
            <TreemapCanvas
              view={tree}
              metric={metric}
              colorMode={colorMode}
              onPick={(node) => onPick(node)}
              onHover={(node) => setHovered(node ?? null)}
            />
          ) : (
            <div className="grid h-full place-items-center text-[13px] text-muted">
              {loading || scanning ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 size={16} className="animate-spin" />
                  {scanning
                    ? tf("正在扫描…", "Scanning…")
                    : tf("正在加载树图…", "Loading treemap…")}
                </span>
              ) : (
                tf("暂无可显示的数据", "Nothing to display")
              )}
            </div>
          )}
        </div>

        {tree && tree.nodes.length > 0 && (
          <DetailPanel
            scanId={scanId}
            view={tree}
            selected={selected ?? hovered}
            metric={metric}
          />
        )}
      </div>
    </div>
  );
}
