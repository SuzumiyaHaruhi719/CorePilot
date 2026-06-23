import {
  AlertTriangle,
  ChevronLeft,
  Copy,
  FolderOpen,
  Loader2,
  Layers,
  PlugZap,
  RefreshCw,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Segmented } from "../../components/ui/Segmented";
import { Slider } from "../../components/ui/Slider";
import { Toggle } from "../../components/ui/Toggle";
import { ContextMenu, type MenuState } from "../../components/ui/ContextMenu";
import { useTf } from "../../lib/i18n";
import {
  api,
  withTimeout,
  DISK_FLAG,
  type ScanProgress,
  type TreeNode,
  type TreeView,
} from "../../lib/ipc";
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
  const [menu, setMenu] = useState<MenuState | null>(null);

  const zoomRef = useRef<HTMLDivElement>(null);

  // The store entry can be momentarily undefined during a close re-target.
  const metric: Metric = view?.metric ?? "alloc";
  const colorMode: ColorMode = view?.colorMode ?? "cushion";
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

  /**
   * One-shot ~220ms zoom tween (gated by reduce-motion). `dir: "in"` grows the
   * new (deeper) view from the picked rect's footprint (spec §3.3); `dir: "out"`
   * plays the inverse — the view shrinks-from-overscale back to 1, so ascending
   * reads as zooming OUT from the child we left.
   */
  const playZoom = useCallback(
    (
      origin: { x: number; y: number; w: number; h: number } | null,
      dir: "in" | "out" = "in",
    ) => {
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
      const frames =
        dir === "in"
          ? [
              { transform: `scale(${sx}, ${sy})`, opacity: 0.35 },
              { transform: "scale(1, 1)", opacity: 1 },
            ]
          : // Inverse: the parent view appears from an over-scaled state (as if we
            // pulled back out of the child) and settles to 1.
            [
              {
                transform: `scale(${1 / Math.max(0.2, sx)}, ${1 / Math.max(0.2, sy)})`,
                opacity: 0.35,
              },
              { transform: "scale(1, 1)", opacity: 1 },
            ];
      el.animate(frames, { duration: 220, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
    },
    [],
  );

  // SINGLE-CLICK → select only (spec §3.3): no navigation, the DetailPanel shows
  // it. Buckets (localId -1, node null) clear the selection.
  const onSelect = useCallback((node: TreeNode | null) => {
    setSelected(node);
  }, []);

  // DOUBLE-CLICK on a drillable container → zoom in (push the drill stack). The
  // canvas already filtered to drillable nodes; we just push + tween (spec §3.3).
  const onZoom = useCallback(
    (node: TreeNode | null, origin: { x: number; y: number; w: number; h: number }) => {
      if (!node || node.path == null) return;
      playZoom(origin, "in");
      const cur = useDiskScan.getState().views[scanId]?.stack ?? [];
      patch({ stack: [...cur, { path: node.path, label: node.name }] });
    },
    [playZoom, patch, scanId],
  );

  // Ascend to a breadcrumb depth (0 = disk root). Plays the inverse zoom-out.
  const navigate = useCallback(
    (depth: number) => {
      const cur = useDiskScan.getState().views[scanId]?.stack ?? [];
      if (depth < cur.length - 1) {
        playZoom(null, "out");
        patch({ stack: cur.slice(0, depth + 1) });
      }
    },
    [patch, scanId, playZoom],
  );

  // Pop ONE level (the back-chevron / Esc / context "Zoom out"). No-op at root.
  const ascend = useCallback(() => {
    const cur = useDiskScan.getState().views[scanId]?.stack ?? [];
    if (cur.length > 1) {
      playZoom(null, "out");
      patch({ stack: cur.slice(0, -1) });
    }
  }, [patch, scanId, playZoom]);

  // Zoom INTO an arbitrary node from the context menu (no rect footprint → center).
  const zoomToNode = useCallback(
    (node: TreeNode | null) => {
      if (!node || node.path == null) return;
      playZoom(null, "in");
      const cur = useDiskScan.getState().views[scanId]?.stack ?? [];
      patch({ stack: [...cur, { path: node.path, label: node.name }] });
    },
    [playZoom, patch, scanId],
  );

  const atRoot = stack.length <= 1;

  // RIGHT-CLICK → build the context menu (spec §3.3 table). Items with no backing
  // (Open-file, Delete) are omitted; items whose `node.path` is null are disabled.
  const onContext = useCallback(
    (node: TreeNode | null, _localId: number, clientX: number, clientY: number) => {
      // Selecting on right-click matches Explorer + keeps the DetailPanel in sync.
      if (node) setSelected(node);
      const hasPath = node != null && node.path != null;
      const isDir = node != null && (node.flags & DISK_FLAG.isDir) !== 0;
      const drillable = hasPath && node != null && (node.hasMore || isDir);
      setMenu({
        x: clientX,
        y: clientY,
        items: [
          {
            label: tf("放大进入", "Zoom in"),
            icon: ZoomIn,
            disabled: !drillable,
            onClick: () => zoomToNode(node),
          },
          {
            label: tf("缩小到上级", "Zoom out / to parent"),
            icon: ZoomOut,
            disabled: atRoot,
            onClick: () => ascend(),
          },
          {
            label: tf("在资源管理器中显示", "Reveal in Explorer"),
            icon: FolderOpen,
            disabled: !hasPath,
            onClick: () => {
              if (node?.path) void api.revealInExplorer(node.path).catch(() => {});
            },
          },
          {
            label: tf("复制路径", "Copy path"),
            icon: Copy,
            disabled: !hasPath,
            onClick: () => {
              if (node?.path) void navigator.clipboard?.writeText(node.path).catch(() => {});
            },
          },
          {
            label: tf("重新扫描", "Rescan"),
            icon: RefreshCw,
            onClick: () => {
              void api.diskScanStart([scanId]).catch(() => {});
            },
          },
        ],
      });
    },
    [tf, atRoot, zoomToNode, ascend, scanId],
  );

  // Esc pops one level — active only when this disk tab is mounted and no context
  // menu is open (the ContextMenu owns Esc while it's up). No-op at root.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || menu) return;
      // Ignore while typing in a field (the toolbar has none today, but be safe).
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const cur = useDiskScan.getState().views[scanId]?.stack ?? [];
      if (cur.length > 1) {
        e.preventDefault();
        ascend();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu, scanId, ascend]);

  const crumbs: CrumbSegment[] = stack.map((lvl) => ({ label: lvl.label }));

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Thin toolbar bar above the canvas (spec §4.5). */}
      <div className="flex flex-wrap items-center gap-2.5 border-b border-line px-4 py-2.5">
        {/* Back affordance (spec §3.3): pop one drill level; disabled at root. */}
        <button
          type="button"
          onClick={ascend}
          disabled={atRoot}
          title={tf("返回上一级", "Back (up one level)")}
          aria-label={tf("返回上一级", "Back")}
          className="no-drag flex shrink-0 items-center justify-center rounded-md p-1 text-muted transition-colors hover:bg-surface3 hover:text-ink disabled:cursor-not-allowed disabled:opacity-30"
        >
          <ChevronLeft size={16} />
        </button>
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
              { value: "cushion", label: "软垫" },
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

          {/* Live progress chip (spec §4.5 / §7): files/sec + elapsed + skipped —
              makes a slow (antivirus-throttled) scan visibly *working*. */}
          <ScanProgressChip progress={progress} />
        </div>
      </div>

      {/* Hardening banners (spec §2.7 truncation / §2.5.5 disconnect). */}
      <ScanBanners progress={progress} />

      {/* Workspace: treemap (left ~70%) + detail panel (right). */}
      <div className="flex min-h-0 flex-1">
        <div ref={zoomRef} className="relative min-w-0 flex-1">
          {tree && tree.nodes.length > 0 ? (
            <TreemapCanvas
              view={tree}
              metric={metric}
              colorMode={colorMode}
              scanning={scanning}
              selected={selected}
              onSelect={(node) => onSelect(node)}
              onZoom={(node, origin) => onZoom(node, origin)}
              onContext={(node, id, x, y) => onContext(node, id, x, y)}
              onHover={(node) => setHovered(node ?? null)}
            />
          ) : progress?.disconnected ? (
            // Dedicated drive-disconnect surface (spec §2.5.5 / §7).
            <div className="grid h-full place-items-center px-6 text-center">
              <div className="flex max-w-sm flex-col items-center gap-2">
                <PlugZap size={28} className="text-warn" />
                <div className="text-[14px] font-semibold text-ink">
                  {tf("驱动器已断开连接", "Drive disconnected")}
                </div>
                <div className="text-[12px] text-muted">
                  {tf(
                    "扫描期间该卷被弹出或断开,已停止。其它磁盘的扫描不受影响。",
                    "The volume was ejected or went offline mid-scan, so this scan stopped. Other disks are unaffected.",
                  )}
                </div>
              </div>
            </div>
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
            skipped={progress?.skipped ?? 0}
          />
        )}
      </div>

      {/* Right-click context menu (spec §3.3) — portaled, closes on outside click. */}
      <ContextMenu state={menu} onClose={() => setMenu(null)} />
    </div>
  );
}

/** Live progress chip (spec §4.5 / §7) — files-per-sec + elapsed + skipped, fed
 *  by the throttled progress event. The files/sec + live count make a slow
 *  (e.g. antivirus-throttled) scan visibly *working*, not hung. Hidden once the
 *  scan settles (done/cancelled/error) so it doesn't linger. */
function ScanProgressChip({ progress }: { progress: ScanProgress | null }) {
  const tf = useTf();
  if (!progress || progress.status !== "scanning") return null;
  const secs = progress.elapsedMs / 1000;
  const fps = secs > 0 ? Math.round(progress.filesSeen / secs) : 0;
  return (
    <div className="nums ml-auto flex items-center gap-3 whitespace-nowrap text-[10.5px] text-dim">
      <span>
        <span className="text-muted">{progress.filesSeen.toLocaleString()}</span>{" "}
        {tf("文件", "files")}
      </span>
      <span>
        <span className="text-muted">{fps.toLocaleString()}</span>/s
      </span>
      <span>{formatElapsed(secs)}</span>
      {progress.skipped > 0 && (
        <span className="text-warn">
          {progress.skipped.toLocaleString()} {tf("跳过", "skipped")}
        </span>
      )}
    </div>
  );
}

/** Truncation (memory-cap) + drive-disconnect banners (spec §2.7 / §2.5.5). */
function ScanBanners({ progress }: { progress: ScanProgress | null }) {
  const tf = useTf();
  if (!progress) return null;
  const showTrunc = progress.truncated;
  const showDisc = progress.disconnected;
  if (!showTrunc && !showDisc) return null;
  return (
    <div className="flex flex-col gap-px">
      {showDisc && (
        <div className="flex items-center gap-2 border-b border-warn/30 bg-warn/10 px-4 py-1.5 text-[11.5px] text-warn">
          <PlugZap size={13} className="shrink-0" />
          <span>
            {tf(
              "驱动器在扫描期间断开连接 — 显示的是断开前的部分结果。",
              "Drive disconnected mid-scan — showing the partial result captured before it went offline.",
            )}
          </span>
        </div>
      )}
      {showTrunc && (
        <div className="flex items-center gap-2 border-b border-line bg-surface2/60 px-4 py-1.5 text-[11.5px] text-muted">
          <Layers size={13} className="shrink-0 text-accent" />
          <span>
            {tf(
              "扫描已截断 — 超出节点上限的最深层目录已聚合为占位项。",
              "Scan truncated — directories beyond the node limit were aggregated into placeholders.",
            )}
          </span>
          <AlertTriangle size={12} className="shrink-0 opacity-50" />
        </div>
      )}
    </div>
  );
}

/** Compact mm:ss / hh:mm:ss elapsed formatter for the progress chip. */
function formatElapsed(secs: number): string {
  const s = Math.floor(secs);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
}
