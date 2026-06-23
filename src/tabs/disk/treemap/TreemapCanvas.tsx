import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TreeView, TreeNode } from "../../../lib/ipc";
import { DISK_FLAG } from "../../../lib/ipc";
import { formatBytes } from "../../../lib/format";
import { useTf } from "../../../lib/i18n";
import { useSettings } from "../../../store/settings";
import {
  layoutTreemap,
  hitTest,
  LABEL_STRIP,
  type DrawRect,
  type Metric,
} from "./layout";
import { readPalette, rectColor, strokeColor, labelColor, type ColorMode, type Palette } from "./colors";

/**
 * Canvas 2D squarified treemap renderer (spec §3.1/§3.2/§3.6/§3.7).
 *
 * A single retina-scaled `<canvas>` filling its sized wrapper. Layout runs OFF
 * the React render path — only on a new `view` identity, a resize, a metric/color
 * change, or a theme switch (mirrors `uPlot`'s imperative drawing). The draw loop
 * iterates the flat `DrawRect[]` once: `fillRect` + `strokeRect` per rect and a
 * handful of `fillText` labels above a legibility threshold.
 *
 * Phase 3 ships the STATIC (post-completion) render + hover tooltip. Drill-down /
 * zoom tween, the breadcrumb, and live-fill interpolation are Phase 4/5; this
 * component already surfaces `onPick` (folder→drill, file→select) so the Phase-4
 * shell can wire breadcrumb navigation without touching the renderer.
 *
 * Honors `data-gpu-render` / `data-reduce-motion` implicitly: it draws only on
 * demand (no continuous rAF here in Phase 3) and uses no box-shadow/keyframes, so
 * it never pegs the compositor (MEMORY: claude-monitor box-shadow DPC storm).
 *
 * See docs/superpowers/specs/2026-06-23-disk-space-analyzer-design.md §3.
 */

/** Canvas label fonts — set explicitly (canvas ignores CSS font-features). */
const NAME_FONT = '600 11px Inter, ui-sans-serif, system-ui, sans-serif';
const SIZE_FONT = '10px "Cascadia Mono", ui-monospace, monospace';
const STRIP_FONT = '600 10px Inter, ui-sans-serif, system-ui, sans-serif';

/** Legibility thresholds (spec §3.6): name+size only above these px dims. */
const LABEL_MIN_W = 54;
const LABEL_MIN_H = 30;
const STRIP_MIN_W = 40;

export interface TreemapCanvasProps {
  /** The LOD slice to render (`nodes[0]` is the focus root). */
  view: TreeView;
  /** Which size metric drives areas (per-tab; spec §2.4). Default "alloc". */
  metric?: Metric;
  /** Color scheme (default "depth" — owner decision §7). */
  colorMode?: ColorMode;
  /**
   * A rect was activated (click): a drillable container (path != null) → caller
   * should re-`diskTree(node.path)`; a leaf → caller selects it. Local node id is
   * -1 for a "… N more" bucket (caller may re-layout that bucket — Phase 4).
   */
  onPick?: (node: TreeNode | null, localId: number) => void;
  /** Hover changed (for an external detail/preview); null when the pointer leaves. */
  onHover?: (node: TreeNode | null, localId: number) => void;
}

interface Hover {
  rect: DrawRect;
  /** Cursor position in CSS px relative to the wrapper (for the tooltip). */
  cx: number;
  cy: number;
}

export function TreemapCanvas({
  view,
  metric = "alloc",
  colorMode = "depth",
  onPick,
  onHover,
}: TreemapCanvasProps) {
  const tf = useTf();
  // Re-read theme tokens when the theme / style flips (palette is theme-derived).
  const theme = useSettings((s) => s.theme);
  const themeStyle = useSettings((s) => s.themeStyle);

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<Hover | null>(null);

  // Keep callbacks fresh without forcing relayout.
  const onPickRef = useRef(onPick);
  const onHoverRef = useRef(onHover);
  useEffect(() => {
    onPickRef.current = onPick;
    onHoverRef.current = onHover;
  });

  // Track the wrapper's pixel box.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r && r.width > 0 && r.height > 0) {
        setSize({ w: Math.round(r.width), h: Math.round(r.height) });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Theme-derived palette, recomputed on a theme/style switch.
  const palette = useMemo<Palette>(() => readPalette(), [theme, themeStyle]);

  // Pure layout — off the render path; recomputed only on real inputs.
  const rects = useMemo<DrawRect[]>(() => {
    if (size.w <= 0 || size.h <= 0) return [];
    return layoutTreemap({ view, width: size.w, height: size.h, metric }).rects;
  }, [view, size.w, size.h, metric]);

  // Node lookup by local id (for hover/pick + tooltip).
  const nodeOf = useCallback(
    (localId: number): TreeNode | null =>
      localId >= 0 && localId < view.nodes.length ? view.nodes[localId] : null,
    [view],
  );

  // Imperative draw: clear, paint every rect, then labels. No continuous loop in
  // Phase 3 — redraw only when layout / palette / hover changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = size.w;
    const H = size.h;
    if (W <= 0 || H <= 0) return;

    // Retina backing store.
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const stroke = strokeColor(palette);

    // Pass 1: fills + borders (parents first → children paint on top of frames).
    for (const r of rects) {
      const node = nodeOf(r.nodeId);
      ctx.fillStyle = rectColor(palette, colorMode, r.depth, node);
      ctx.fillRect(r.x, r.y, r.w, r.h);
      if (r.w > 2 && r.h > 2) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 1;
        ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
      }
    }

    // Pass 2: labels (above legibility thresholds, spec §3.6).
    ctx.textBaseline = "top";
    for (const r of rects) {
      const node = nodeOf(r.nodeId);
      if (r.isBucket) {
        if (r.w >= LABEL_MIN_W && r.h >= 18) {
          ctx.fillStyle = labelColor(palette, true);
          ctx.font = STRIP_FONT;
          const txt = tf(`… ${r.bucketCount} 项更多`, `… ${r.bucketCount} more`);
          drawClipped(ctx, txt, r.x + 4, r.y + Math.max(2, (r.h - 12) / 2), r.w - 8);
        }
        continue;
      }
      if (!node) continue;

      if (r.isContainer) {
        // Folder name in the reserved top strip.
        if (r.w >= STRIP_MIN_W && r.h >= LABEL_STRIP + 6) {
          ctx.fillStyle = labelColor(palette, true);
          ctx.font = STRIP_FONT;
          drawClipped(ctx, node.name, r.x + 4, r.y + 3, r.w - 8);
        }
        continue;
      }

      // Leaf: centered name (+ size on a 2nd line above the size threshold).
      if (r.w >= LABEL_MIN_W && r.h >= LABEL_MIN_H) {
        ctx.fillStyle = labelColor(palette, false);
        ctx.font = NAME_FONT;
        ctx.textAlign = "left";
        drawClipped(ctx, node.name, r.x + 4, r.y + 4, r.w - 8);
        ctx.fillStyle = palette.muted;
        ctx.font = SIZE_FONT;
        drawClipped(
          ctx,
          formatBytes(metric === "alloc" ? node.allocSize : node.logicalSize),
          r.x + 4,
          r.y + 18,
          r.w - 8,
        );
      } else if (r.w >= 34 && r.h >= 14) {
        // Medium: size-only.
        ctx.fillStyle = palette.muted;
        ctx.font = SIZE_FONT;
        drawClipped(
          ctx,
          formatBytes(metric === "alloc" ? node.allocSize : node.logicalSize),
          r.x + 3,
          r.y + Math.max(2, (r.h - 10) / 2),
          r.w - 6,
        );
      }
    }

    // Pass 3: hover overlay — lighten + 1px accent stroke (spec §3.7), no relayout.
    if (hover) {
      const r = hover.rect;
      ctx.fillStyle = palette.light ? "oklch(0% 0 0 / 0.06)" : "oklch(100% 0 0 / 0.08)";
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = palette.accent;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(r.x + 0.75, r.y + 0.75, r.w - 1.5, r.h - 1.5);
    }
  }, [rects, palette, colorMode, metric, size.w, size.h, hover, nodeOf, tf]);

  // Hover hit-test (spec §3.7) — O(visible) reverse scan.
  const onMove = useCallback(
    (e: React.PointerEvent) => {
      const el = wrapRef.current;
      if (!el) return;
      const box = el.getBoundingClientRect();
      const px = e.clientX - box.left;
      const py = e.clientY - box.top;
      const hit = hitTest(rects, px, py);
      if (hit) {
        setHover({ rect: hit, cx: px, cy: py });
        onHoverRef.current?.(nodeOf(hit.nodeId), hit.nodeId);
      } else if (hover) {
        setHover(null);
        onHoverRef.current?.(null, -1);
      }
    },
    [rects, hover, nodeOf],
  );

  const onLeave = useCallback(() => {
    if (hover) {
      setHover(null);
      onHoverRef.current?.(null, -1);
    }
  }, [hover]);

  const onClick = useCallback(
    (e: React.MouseEvent) => {
      const el = wrapRef.current;
      if (!el) return;
      const box = el.getBoundingClientRect();
      const hit = hitTest(rects, e.clientX - box.left, e.clientY - box.top);
      if (hit) onPickRef.current?.(nodeOf(hit.nodeId), hit.nodeId);
    },
    [rects, nodeOf],
  );

  const hoverNode = hover ? nodeOf(hover.rect.nodeId) : null;

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden">
      <canvas
        ref={canvasRef}
        style={{ width: size.w, height: size.h, display: "block" }}
        onPointerMove={onMove}
        onPointerLeave={onLeave}
        onClick={onClick}
        className="cursor-pointer"
      />
      {hover && (
        <TreemapTooltip
          tf={tf}
          rect={hover.rect}
          node={hoverNode}
          metric={metric}
          rootSize={metric === "alloc" ? view.nodes[0].allocSize : view.nodes[0].logicalSize}
          cx={hover.cx}
          cy={hover.cy}
          boxW={size.w}
          boxH={size.h}
        />
      )}
    </div>
  );
}

/** Draw text clipped/ellipsized to `maxW` px. */
function drawClipped(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxW: number,
): void {
  if (maxW <= 4) return;
  if (ctx.measureText(text).width <= maxW) {
    ctx.fillText(text, x, y);
    return;
  }
  const ell = "…";
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + ell).width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  ctx.fillText(lo > 0 ? text.slice(0, lo) + ell : ell, x, y);
}

interface TreemapTooltipProps {
  tf: (zh: string, en: string) => string;
  rect: DrawRect;
  node: TreeNode | null;
  metric: Metric;
  rootSize: number;
  cx: number;
  cy: number;
  boxW: number;
  boxH: number;
}

/** Absolutely-positioned `.glass` tooltip following the cursor (spec §3.7). */
function TreemapTooltip({ tf, rect, node, metric, rootSize, cx, cy, boxW, boxH }: TreemapTooltipProps) {
  const size = node ? (metric === "alloc" ? node.allocSize : node.logicalSize) : rect.size;
  const pctOfRoot = rootSize > 0 ? (size / rootSize) * 100 : 0;

  // Clamp the tooltip inside the canvas box; flip to the cursor's left/top edge
  // when near the right/bottom so it never spills out.
  const TW = 232;
  const left = cx + TW + 16 > boxW ? Math.max(4, cx - TW - 12) : cx + 14;
  const top = cy + 110 > boxH ? Math.max(4, cy - 110) : cy + 14;

  const isDir = node ? (node.flags & DISK_FLAG.isDir) !== 0 : false;
  const denied = node ? (node.flags & DISK_FLAG.denied) !== 0 : false;
  const reparse = node ? (node.flags & DISK_FLAG.reparse) !== 0 : false;

  return (
    <div
      className="glass pointer-events-none absolute z-20 rounded-lg border border-line px-3 py-2 text-[11.5px] shadow-lg"
      style={{ left, top, width: TW }}
    >
      {rect.isBucket ? (
        <div className="font-semibold text-ink">
          {tf(`${rect.bucketCount} 个较小项目`, `${rect.bucketCount} smaller items`)}
        </div>
      ) : (
        <>
          <div className="mb-0.5 truncate font-semibold text-ink">{node?.name ?? "—"}</div>
          {node?.path && <div className="mb-1 truncate text-[10.5px] text-dim">{node.path}</div>}
        </>
      )}
      <div className="flex items-center justify-between text-muted">
        <span>{tf("占用", "Size")}</span>
        <span className="nums text-ink">{formatBytes(size)}</span>
      </div>
      <div className="flex items-center justify-between text-muted">
        <span>{tf("占比", "% of root")}</span>
        <span className="nums text-ink">{pctOfRoot.toFixed(1)}%</span>
      </div>
      {node && (
        <div className="flex items-center justify-between text-muted">
          <span>{isDir ? tf("文件数", "Files") : tf("类型", "Type")}</span>
          <span className="nums text-ink">
            {isDir ? node.fileCount.toLocaleString() : reparse ? tf("链接", "Link") : tf("文件", "File")}
          </span>
        </div>
      )}
      {denied && <div className="mt-0.5 text-[10.5px] text-warn">{tf("无访问权限", "Access denied")}</div>}
    </div>
  );
}
