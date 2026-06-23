import { ArrowLeft, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Segmented } from "../../components/ui/Segmented";
import { Slider } from "../../components/ui/Slider";
import { Toggle } from "../../components/ui/Toggle";
import { useTf } from "../../lib/i18n";
import { api, type TreeNode, type TreeView } from "../../lib/ipc";
import { TreemapCanvas } from "./treemap/TreemapCanvas";
import { Breadcrumb, type CrumbSegment } from "./treemap/Breadcrumb";
import { DetailPanel } from "./DetailPanel";
import type { Metric } from "./treemap/layout";
import type { ColorMode } from "./treemap/colors";

/**
 * Per-disk treemap workspace (spec §4.2 Zone C + §3.4 drill + §4.5 toolbar +
 * §4.6 detail). Phase 4 wires:
 *
 *  - Breadcrumb drill: `onPick` of a drillable container (`path != null`) pushes
 *    its path onto a focus stack and re-pulls `disk_tree(scanId, path)`; the
 *    breadcrumb ascends by popping. A leaf pick selects it for the detail panel.
 *  - A one-shot ~220ms zoom tween on drill (the canvas scales toward the picked
 *    rect, gated by `data-reduce-motion`; never a continuous animation, and the
 *    canvas stays out of any Motion `layout` container — MEMORY: group glow).
 *  - Toolbar controls: Show-by (alloc/logical metric), Color mode (depth/type),
 *    a LOD density slider (min-size knob), and a "pause live updates" toggle.
 *  - The side detail panel (`disk_top_items` + selection).
 *
 * Phase 4 hosts ONE active scan; the per-disk `SecondaryTabs` strip, the live
 * `disk-scan://progress` listener, active-tab polling and the `diskScan.ts` store
 * are Phase 5 (this component takes a `scanId` + an initial `TreeView` and owns
 * only its own drill/view state until then).
 *
 * See docs/superpowers/specs/2026-06-23-disk-space-analyzer-design.md §3.4/§4.
 */

interface DiskWorkspaceProps {
  scanId: string;
  /** Friendly disk root label for the breadcrumb root crumb (e.g. "C:"). */
  rootLabel: string;
  /** Return to the picker (Zone A). */
  onBack: () => void;
}

/** One level on the drill stack: its absolute focus path + the slice shown there. */
interface FocusLevel {
  /** null = the disk root (whole-disk view). */
  path: string | null;
  label: string;
}

export function DiskWorkspace({ scanId, rootLabel, onBack }: DiskWorkspaceProps) {
  const tf = useTf();

  // Per-tab view state (Phase 5 lifts this into `diskScan.ts`).
  const [metric, setMetric] = useState<Metric>("alloc");
  const [colorMode, setColorMode] = useState<ColorMode>("depth");
  const [paused, setPaused] = useState(false);
  // LOD density 1..10 → min-bytes floor (higher = coarser, fewer tiny rects).
  const [lod, setLod] = useState(3);

  // Drill stack: stack[0] is the disk root; the last entry is the current focus.
  const [stack, setStack] = useState<FocusLevel[]>([{ path: null, label: rootLabel }]);
  const [view, setView] = useState<TreeView | null>(null);
  const [selected, setSelected] = useState<TreeNode | null>(null);
  const [hovered, setHovered] = useState<TreeNode | null>(null);
  const [loading, setLoading] = useState(true);

  const zoomRef = useRef<HTMLDivElement>(null);

  /** LOD density → a `minBytes` floor below which children collapse server-side. */
  const minBytesFor = useCallback((d: number): number => {
    // 1 → 0 (show everything); 10 → ~64 MB floor. Geometric so the low end is fine.
    if (d <= 1) return 0;
    return Math.round(64 * 1024 * (1 << (d - 1))); // 64KB..32MB across 1..10
  }, []);

  // Pull the tree for the current focus (top of the drill stack). Re-runs on a
  // drill/ascend or an LOD-knob change. Selection clears on a focus change.
  const focusPath = stack[stack.length - 1]?.path ?? null;
  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .diskTree(scanId, focusPath, { minBytes: minBytesFor(lod) })
      .then((tv) => {
        if (!alive) return;
        setView(tv);
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
  }, [scanId, focusPath, lod, minBytesFor]);

  /** One-shot ~220ms zoom tween toward a picked rect (gated by reduce-motion). */
  const playZoom = useCallback((origin: { x: number; y: number; w: number; h: number } | null) => {
    const el = zoomRef.current;
    if (!el) return;
    if (document.documentElement.dataset.reduceMotion === "true") return;
    const box = el.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return;
    // Scale the source rect up to fill, anchored at its centre, then settle to 1.
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
  // -1) are a no-op in Phase 4 (re-laying out a bucket is a later refinement).
  const onPick = useCallback(
    (node: TreeNode | null) => {
      if (!node) return;
      const drillable = node.path != null && (node.hasMore || (node.flags & 1) !== 0);
      if (drillable && node.path) {
        // Centred zoom tween (the picked rect's screen origin isn't surfaced by
        // the Phase-3 canvas; a full-canvas settle reads as a clean drill-in).
        playZoom(null);
        setStack((prev) => [...prev, { path: node.path, label: node.name }]);
      } else {
        setSelected(node);
      }
    },
    [playZoom],
  );

  // Ascend to a breadcrumb depth (0 = disk root).
  const navigate = useCallback((depth: number) => {
    setStack((prev) => (depth < prev.length - 1 ? prev.slice(0, depth + 1) : prev));
  }, []);

  const crumbs: CrumbSegment[] = stack.map((lvl) => ({ label: lvl.label }));

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Thin toolbar bar above the canvas (spec §4.5). */}
      <div className="flex flex-wrap items-center gap-2.5 border-b border-line px-4 py-2.5">
        <button
          type="button"
          onClick={onBack}
          title={tf("返回磁盘列表", "Back to disks")}
          className="no-drag inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface2 px-2.5 py-1.5 text-[12px] text-muted transition-colors hover:border-line-strong hover:bg-surface3 hover:text-ink"
        >
          <ArrowLeft size={14} />
          {tf("磁盘", "Disks")}
        </button>

        <Breadcrumb segments={crumbs} onNavigate={navigate} />

        <div className="flex items-center gap-2.5">
          <Segmented
            id="disk-metric"
            value={metric}
            onChange={(v) => setMetric(v)}
            options={[
              { value: "alloc", label: "占用空间" },
              { value: "logical", label: "逻辑大小" },
            ]}
          />
          <Segmented
            id="disk-color"
            value={colorMode}
            onChange={(v) => setColorMode(v)}
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
              onChange={setLod}
            />
          </div>
          <label className="flex items-center gap-1.5 text-[11.5px] text-muted">
            <Toggle checked={paused} onChange={setPaused} label={tf("暂停实时更新", "Pause live updates")} />
            <span className="whitespace-nowrap">{tf("暂停", "Pause")}</span>
          </label>
        </div>
      </div>

      {/* Workspace: treemap (left ~70%) + detail panel (right). */}
      <div className="flex min-h-0 flex-1">
        <div ref={zoomRef} className="relative min-w-0 flex-1">
          {view && view.nodes.length > 0 ? (
            <TreemapCanvas
              view={view}
              metric={metric}
              colorMode={colorMode}
              onPick={(node) => onPick(node)}
              onHover={(node) => {
                // Hover previews into the detail panel only when nothing is pinned
                // (a click pins; clicking empty space / leaving clears via onPick).
                if (node) setHovered(node);
                else setHovered(null);
              }}
            />
          ) : (
            <div className="grid h-full place-items-center text-[13px] text-muted">
              {loading ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 size={16} className="animate-spin" />
                  {tf("正在加载树图…", "Loading treemap…")}
                </span>
              ) : (
                tf("暂无可显示的数据", "Nothing to display")
              )}
            </div>
          )}
        </div>

        {view && view.nodes.length > 0 && (
          <DetailPanel
            scanId={scanId}
            view={view}
            selected={selected ?? hovered}
            metric={metric}
          />
        )}
      </div>
    </div>
  );
}
