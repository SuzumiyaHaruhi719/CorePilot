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
import {
  readPalette,
  rectColor,
  strokeColor,
  labelColor,
  bevel,
  titleBarColor,
  type ColorMode,
  type Palette,
} from "./colors";
import { displayName } from "./names";

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
 * Honors `data-gpu-render` / `data-reduce-motion` (spec §3 / §5 GPU budget):
 *  - It draws only on demand (no continuous rAF) and uses no box-shadow/keyframes,
 *    so it never pegs the compositor (MEMORY: claude-monitor box-shadow DPC storm).
 *  - When the in-app `gpuRender` escape hatch is OFF (the "省电 / gaming" mode that
 *    strips blur+orbs to spare the GPU), the retina backing store is capped at 1×
 *    DPR — far fewer pixels to fill per redraw on a 4K panel, so a hover-driven
 *    repaint can't claw back the GPU budget the user just freed.
 *  - The hover overlay is a cheap single-rect repaint (no relayout), and the
 *    drill zoom tween (in `DiskWorkspace`) is already gated by `reduceMotion`.
 *
 * See docs/superpowers/specs/2026-06-23-disk-space-analyzer-design.md §3.
 */

/** Reduce-motion is active when EITHER the in-app flag (`data-reduce-motion`) is
 *  set OR the OS-level `prefers-reduced-motion` media query matches, so users who
 *  only set the OS preference still get snap-to-final geometry, not full tweens. */
function prefersReducedMotion(): boolean {
  if (document.documentElement.dataset.reduceMotion === "true") return true;
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

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
  /** Color scheme (default "cushion" — SpaceSniffer warm-folder/blue-file, §7). */
  colorMode?: ColorMode;
  /** True while the backend scan is still streaming — shows the live "Scanning…"
   *  pill over the canvas; the layout tween animates the growing snapshots. */
  scanning?: boolean;
  /** The currently-selected node (drawn with a bright outline). Owned by the
   *  workspace so selection survives a re-layout / snapshot tick. */
  selected?: TreeNode | null;
  /**
   * SINGLE-CLICK — select a box (spec §3.3). Caller sets `selected` + the side
   * DetailPanel shows it. No navigation. `localId` is -1 for a "… N more" bucket.
   */
  onSelect?: (node: TreeNode | null, localId: number) => void;
  /**
   * DOUBLE-CLICK on a drillable container — zoom into it (spec §3.3). Caller
   * pushes the drill stack + plays the zoom tween. A double-click on a leaf falls
   * back to a plain select (handled here → `onSelect`).
   */
  onZoom?: (node: TreeNode | null, origin: { x: number; y: number; w: number; h: number }) => void;
  /**
   * RIGHT-CLICK — open a context menu (spec §3.3). Caller builds the `MenuItem[]`
   * and renders `<ContextMenu>` at (clientX, clientY).
   */
  onContext?: (node: TreeNode | null, localId: number, clientX: number, clientY: number) => void;
  /** Hover changed (for an external detail/preview); null when the pointer leaves. */
  onHover?: (node: TreeNode | null, localId: number) => void;
}

interface Hover {
  rect: DrawRect;
  /** Cursor position in CSS px relative to the wrapper (for the tooltip). */
  cx: number;
  cy: number;
}

/** Persisted per-key geometry the tween eases between snapshots (`prevByKey`). */
interface AnimRect {
  x: number;
  y: number;
  w: number;
  h: number;
  alpha: number;
  /** True while this key is fading out (no longer in the target slice). */
  gone: boolean;
  /** Last-known depth (so a fading ghost can still be tinted/positioned). */
  depth?: number;
}

/** One interpolated rect handed to the painter — geometry + alpha + draw metadata. */
interface Drawn {
  nodeId: number;
  depth: number;
  isContainer: boolean;
  isBucket: boolean;
  bucketCount: number;
  x: number;
  y: number;
  w: number;
  h: number;
  alpha: number;
  /** Stable rect key (for the selected-outline match — spec §3.3). */
  key: string;
}

export function TreemapCanvas({
  view,
  metric = "alloc",
  colorMode = "cushion",
  scanning = false,
  selected = null,
  onSelect,
  onZoom,
  onContext,
  onHover,
}: TreemapCanvasProps) {
  const tf = useTf();
  // Re-read theme tokens when the theme / style flips (palette is theme-derived).
  const theme = useSettings((s) => s.theme);
  const themeStyle = useSettings((s) => s.themeStyle);
  // GPU-budget escape hatch: when OFF, cap the retina backing store at 1× DPR so
  // a hover repaint can't peg the GPU the "省电" mode just freed (spec §3 / §5).
  const gpuRender = useSettings((s) => s.gpuRender);

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<Hover | null>(null);
  // Single- vs double-click disambiguation (spec §3.3): a single click arms a
  // ~220ms timer that commits the SELECT; a second click within the window cancels
  // it and runs the ZOOM instead, so select never flashes before a drill.
  const clickTimer = useRef(0);

  // Keep callbacks fresh without forcing relayout.
  const onSelectRef = useRef(onSelect);
  const onZoomRef = useRef(onZoom);
  const onContextRef = useRef(onContext);
  const onHoverRef = useRef(onHover);
  useEffect(() => {
    onSelectRef.current = onSelect;
    onZoomRef.current = onZoom;
    onContextRef.current = onContext;
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

  // ---- Tween controller (spec §3.1) -------------------------------------------
  // Boxes ease toward each new snapshot's geometry instead of popping, and freshly
  // appeared boxes fade+grow in from their target center. The whole thing lives in
  // refs (never React state) so per-frame work doesn't re-render, and the rAF loop
  // is started on a new target and SELF-TERMINATES once settled — zero idle GPU
  // (MEMORY: no continuous rAF / box-shadow DPC storm). Gated on reduce-motion.
  const prevByKey = useRef<Map<string, AnimRect>>(new Map());
  const rafId = useRef(0);
  const lastTs = useRef(0);
  // Latest inputs read inside the rAF loop via refs (so the loop never closes over
  // stale state and we don't re-arm the loop on every prop change).
  const targetRef = useRef<DrawRect[]>(rects);
  const paletteRef = useRef(palette);
  const colorModeRef = useRef(colorMode);
  const metricRef = useRef(metric);
  const hoverRef = useRef(hover);
  const sizeRef = useRef(size);
  const gpuRef = useRef(gpuRender);
  const tfRef = useRef(tf);
  // The selected rect's stable key (spec §3.3) — paint draws its bright outline.
  // Match by the node's absolute `path` (stable across snapshots); leaves with no
  // path fall back to the synthesized `parentKey/name` key the layout uses, so we
  // resolve it from the live rects by node identity below.
  const selectedKeyRef = useRef<string | null>(null);
  targetRef.current = rects;
  paletteRef.current = palette;
  colorModeRef.current = colorMode;
  metricRef.current = metric;
  hoverRef.current = hover;
  sizeRef.current = size;
  gpuRef.current = gpuRender;
  tfRef.current = tf;

  // Resolve the selected node → its rect key against the CURRENT layout. A node's
  // `path` is the stable key when present; otherwise find the live rect whose
  // backing node is referentially the selected one and reuse its synthesized key.
  const selectedKey = useMemo<string | null>(() => {
    if (!selected) return null;
    if (selected.path != null) return selected.path;
    for (const r of rects) {
      if (r.nodeId >= 0 && view.nodes[r.nodeId] === selected) return r.key;
    }
    return null;
  }, [selected, rects, view]);
  selectedKeyRef.current = selectedKey;

  // Paint one frame from an explicit interpolated rect list. Pure draw — no layout.
  const paint = useCallback((draw: Drawn[]) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const sz = sizeRef.current;
    const W = sz.w;
    const H = sz.h;
    if (W <= 0 || H <= 0) return;
    // Cap DPR at 2× normally; at 1× when the GPU-render escape hatch is off so a
    // 4K panel fills a quarter of the pixels per redraw (spec §3 / §5 GPU budget).
    const dpr = gpuRef.current ? Math.min(window.devicePixelRatio || 1, 2) : 1;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const p = paletteRef.current;
    const mode = colorModeRef.current;
    const met = metricRef.current;
    const tfn = tfRef.current;
    const stroke = strokeColor(p);
    const bv = bevel(p);
    const barFill = titleBarColor(p);

    // Pass 1: fills + bevel (parents first → children paint on top of frames).
    for (const r of draw) {
      if (r.w <= 0.5 || r.h <= 0.5) continue;
      const node = nodeOf(r.nodeId);
      ctx.globalAlpha = r.alpha;
      ctx.fillStyle = rectColor(p, mode, r.depth, node);
      ctx.fillRect(r.x, r.y, r.w, r.h);

      // Engraved 2-stroke cushion bevel: light top/left, dark bottom/right (spec §3.2).
      // Only on rects big enough to read the bevel — keeps the draw cheap.
      if (r.w >= 4 && r.h >= 4) {
        ctx.lineWidth = 1;
        ctx.strokeStyle = bv.light;
        ctx.beginPath();
        ctx.moveTo(r.x + 0.5, r.y + r.h - 0.5);
        ctx.lineTo(r.x + 0.5, r.y + 0.5);
        ctx.lineTo(r.x + r.w - 0.5, r.y + 0.5);
        ctx.stroke();
        ctx.strokeStyle = bv.dark;
        ctx.beginPath();
        ctx.moveTo(r.x + r.w - 0.5, r.y + 0.5);
        ctx.lineTo(r.x + r.w - 0.5, r.y + r.h - 0.5);
        ctx.lineTo(r.x + 0.5, r.y + r.h - 0.5);
        ctx.stroke();
      } else if (r.w > 1.5 && r.h > 1.5) {
        // Small boxes: a single dark separating edge so they don't merge into a blob.
        ctx.strokeStyle = bv.dark;
        ctx.lineWidth = 1;
        ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
      }
      void stroke;

      // Header/title bar on top-level containers (spec §3.2): a faint band behind
      // the name strip so it reads as a folder header.
      if (r.isContainer && r.depth <= 1 && r.w >= STRIP_MIN_W && r.h >= LABEL_STRIP + 6) {
        ctx.fillStyle = barFill;
        ctx.fillRect(r.x + 1, r.y + 1, r.w - 2, LABEL_STRIP - 1);
      }
    }
    ctx.globalAlpha = 1;

    // Pass 2: labels (above legibility thresholds, spec §3.6).
    ctx.textBaseline = "top";
    for (const r of draw) {
      const node = nodeOf(r.nodeId);
      ctx.globalAlpha = r.alpha;
      if (r.isBucket) {
        if (r.w >= LABEL_MIN_W && r.h >= 18) {
          ctx.fillStyle = labelColor(p, true);
          ctx.font = STRIP_FONT;
          const txt = tfn(`… ${r.bucketCount} 项更多`, `… ${r.bucketCount} more`);
          drawClipped(ctx, txt, r.x + 4, r.y + Math.max(2, (r.h - 12) / 2), r.w - 8);
        }
        continue;
      }
      if (!node) continue;

      if (r.isContainer) {
        // Folder name in the reserved top strip; add the size on the top-level
        // header bar where there's room (SpaceSniffer shows folder size in headers).
        if (r.w >= STRIP_MIN_W && r.h >= LABEL_STRIP + 6) {
          ctx.fillStyle = labelColor(p, true);
          ctx.font = STRIP_FONT;
          const nm = displayName(node, tfn);
          if (r.depth <= 1 && r.w >= 120) {
            const szTxt = formatBytes(met === "alloc" ? node.allocSize : node.logicalSize);
            const szW = ctx.measureText(szTxt).width;
            drawClipped(ctx, nm, r.x + 4, r.y + 3, r.w - 12 - szW);
            ctx.fillText(szTxt, r.x + r.w - 4 - szW, r.y + 3);
          } else {
            drawClipped(ctx, nm, r.x + 4, r.y + 3, r.w - 8);
          }
        }
        continue;
      }

      // Leaf: centered name (+ size on a 2nd line above the size threshold).
      if (r.w >= LABEL_MIN_W && r.h >= LABEL_MIN_H) {
        ctx.fillStyle = labelColor(p, false);
        ctx.font = NAME_FONT;
        ctx.textAlign = "left";
        drawClipped(ctx, displayName(node, tfn), r.x + 4, r.y + 4, r.w - 8);
        ctx.fillStyle = p.muted;
        ctx.font = SIZE_FONT;
        drawClipped(
          ctx,
          formatBytes(met === "alloc" ? node.allocSize : node.logicalSize),
          r.x + 4,
          r.y + 18,
          r.w - 8,
        );
      } else if (r.w >= 34 && r.h >= 14) {
        // Medium: size-only.
        ctx.fillStyle = p.muted;
        ctx.font = SIZE_FONT;
        drawClipped(
          ctx,
          formatBytes(met === "alloc" ? node.allocSize : node.logicalSize),
          r.x + 3,
          r.y + Math.max(2, (r.h - 10) / 2),
          r.w - 6,
        );
      }
    }
    ctx.globalAlpha = 1;

    // Pass 3: hover overlay — lighten + 1px accent stroke (spec §3.7), no relayout.
    const hv = hoverRef.current;
    if (hv) {
      const r = hv.rect;
      ctx.fillStyle = p.light ? "oklch(0% 0 0 / 0.06)" : "oklch(100% 0 0 / 0.08)";
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = p.accent;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(r.x + 0.75, r.y + 0.75, r.w - 1.5, r.h - 1.5);
    }

    // Pass 4: SELECTION outline (spec §3.3) — a bright 2px white frame, distinct
    // from the thinner accent hover stroke, drawn last so it sits on top. Matched
    // by the stable rect key against the interpolated geometry (tween-friendly).
    const selKey = selectedKeyRef.current;
    if (selKey) {
      const sel = draw.find((d) => d.key === selKey);
      if (sel && sel.w > 1 && sel.h > 1) {
        ctx.strokeStyle = p.light ? "oklch(18% 0.02 285)" : "oklch(100% 0 0 / 0.92)";
        ctx.lineWidth = 2;
        ctx.strokeRect(sel.x + 1, sel.y + 1, sel.w - 2, sel.h - 2);
      }
    }
  }, [nodeOf]);

  // Drive the tween toward `targetRef`. Critically-damped lerp of geometry+alpha
  // per key; new keys grow+fade from their target center; removed keys fade out
  // then drop. Self-terminates when every rect is within ε of target (spec §3.1).
  const step = useCallback(
    (ts: number) => {
      const dt = lastTs.current ? Math.min(64, ts - lastTs.current) : 16;
      lastTs.current = ts;
      const target = targetRef.current;
      const prev = prevByKey.current;
      const TAU = 90; // ms — critically-damped feel (cubic-bezier(0.22,1,0.36,1)-ish)
      const k = 1 - Math.exp(-dt / TAU);
      const FADE = 1 - Math.exp(-dt / 120); // removed-key fade-out

      // Mark every persisting key seen this frame; new keys seed at target center.
      const seen = new Set<string>();
      const draw: Drawn[] = [];
      for (const t of target) {
        seen.add(t.key);
        let a = prev.get(t.key);
        if (!a) {
          // New box — grow from its center at alpha 0.
          a = {
            x: t.x + t.w / 2,
            y: t.y + t.h / 2,
            w: 0,
            h: 0,
            alpha: 0,
            gone: false,
            depth: t.depth,
          };
          prev.set(t.key, a);
        }
        a.gone = false;
        a.depth = t.depth;
        a.x += (t.x - a.x) * k;
        a.y += (t.y - a.y) * k;
        a.w += (t.w - a.w) * k;
        a.h += (t.h - a.h) * k;
        a.alpha += (1 - a.alpha) * k;
        draw.push({
          nodeId: t.nodeId,
          depth: t.depth,
          isContainer: t.isContainer,
          isBucket: t.isBucket,
          bucketCount: t.bucketCount,
          x: a.x,
          y: a.y,
          w: a.w,
          h: a.h,
          alpha: a.alpha,
          key: t.key,
        });
      }

      // Removed keys: fade out in place, then drop. Draw them under the new set —
      // they're appended last but with shrinking alpha so they recede.
      for (const [key, a] of prev) {
        if (seen.has(key)) continue;
        a.gone = true;
        a.alpha -= a.alpha * FADE;
        if (a.alpha < 0.02) {
          prev.delete(key);
          continue;
        }
        // Removed rects have no live node — draw as a faded ghost (nodeId -2 → null).
        draw.push({
          nodeId: -2,
          depth: a.depth ?? 1,
          isContainer: false,
          isBucket: false,
          bucketCount: 0,
          x: a.x,
          y: a.y,
          w: a.w,
          h: a.h,
          alpha: a.alpha,
          key,
        });
      }

      paint(draw);

      // Settled? Every persisting key within ε of its target and no fades pending.
      let settled = true;
      for (const t of target) {
        const a = prev.get(t.key);
        if (!a) {
          settled = false;
          break;
        }
        if (
          Math.abs(a.x - t.x) > 0.5 ||
          Math.abs(a.y - t.y) > 0.5 ||
          Math.abs(a.w - t.w) > 0.5 ||
          Math.abs(a.h - t.h) > 0.5 ||
          1 - a.alpha > 0.01
        ) {
          settled = false;
          break;
        }
      }
      // Any lingering fade-outs keep the loop alive.
      if (settled) {
        for (const [key, a] of prev) {
          if (!seen.has(key) && a.alpha >= 0.02) {
            settled = false;
            break;
          }
        }
      }

      if (settled) {
        // Snap exactly to target and stop — zero idle GPU.
        for (const t of target) {
          const a = prev.get(t.key);
          if (a) {
            a.x = t.x;
            a.y = t.y;
            a.w = t.w;
            a.h = t.h;
            a.alpha = 1;
            a.depth = t.depth;
          }
        }
        rafId.current = 0;
        lastTs.current = 0;
        return;
      }
      rafId.current = requestAnimationFrame(step);
    },
    [paint],
  );

  // On a new target (layout) / palette / size: either tween toward it (motion on)
  // or snap-draw it directly (reduce-motion / settled path — no regression).
  useEffect(() => {
    const reduce = prefersReducedMotion();
    if (reduce) {
      // Instant: clear any in-flight tween, set prev = target, draw once.
      if (rafId.current) {
        cancelAnimationFrame(rafId.current);
        rafId.current = 0;
        lastTs.current = 0;
      }
      const map = new Map<string, AnimRect>();
      const draw: Drawn[] = [];
      for (const t of rects) {
        map.set(t.key, { x: t.x, y: t.y, w: t.w, h: t.h, alpha: 1, gone: false, depth: t.depth });
        draw.push({
          nodeId: t.nodeId,
          depth: t.depth,
          isContainer: t.isContainer,
          isBucket: t.isBucket,
          bucketCount: t.bucketCount,
          x: t.x,
          y: t.y,
          w: t.w,
          h: t.h,
          alpha: 1,
          key: t.key,
        });
      }
      prevByKey.current = map;
      paint(draw);
      return;
    }
    // Motion on: kick the loop if it isn't already running. `step` reads `targetRef`
    // (kept fresh above), so a new target mid-flight is picked up without a re-arm.
    if (!rafId.current) {
      lastTs.current = 0;
      rafId.current = requestAnimationFrame(step);
    }
  }, [rects, palette, size.w, size.h, paint, step]);

  // Hover repaints: when settled (no tween running) the rAF loop won't redraw, so
  // paint a single frame from the last-rendered geometry to show/clear the overlay.
  useEffect(() => {
    if (rafId.current) return; // the live loop already repaints with the overlay
    const draw: Drawn[] = [];
    for (const t of rects) {
      const a = prevByKey.current.get(t.key);
      draw.push({
        nodeId: t.nodeId,
        depth: t.depth,
        isContainer: t.isContainer,
        isBucket: t.isBucket,
        bucketCount: t.bucketCount,
        x: a ? a.x : t.x,
        y: a ? a.y : t.y,
        w: a ? a.w : t.w,
        h: a ? a.h : t.h,
        alpha: 1,
        key: t.key,
      });
    }
    paint(draw);
  }, [hover, colorMode, selectedKey, paint, rects]);

  // Cleanup the loop on unmount.
  useEffect(() => {
    return () => {
      if (rafId.current) cancelAnimationFrame(rafId.current);
      rafId.current = 0;
    };
  }, []);

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

  // Hit-test the live `rects` (NOT the interpolated geometry) at a client point.
  const hitAt = useCallback(
    (clientX: number, clientY: number): DrawRect | null => {
      const el = wrapRef.current;
      if (!el) return null;
      const box = el.getBoundingClientRect();
      return hitTest(rects, clientX - box.left, clientY - box.top);
    },
    [rects],
  );

  // SINGLE-CLICK → select (deferred ~220ms so a double-click can pre-empt it).
  const onClick = useCallback(
    (e: React.MouseEvent) => {
      const hit = hitAt(e.clientX, e.clientY);
      const node = hit ? nodeOf(hit.nodeId) : null;
      const localId = hit ? hit.nodeId : -1;
      if (clickTimer.current) window.clearTimeout(clickTimer.current);
      clickTimer.current = window.setTimeout(() => {
        clickTimer.current = 0;
        onSelectRef.current?.(node, localId);
      }, 220);
    },
    [hitAt, nodeOf],
  );

  // DOUBLE-CLICK → zoom a drillable container (else fall back to select). Cancels
  // the pending single-click select so it doesn't fire first.
  const onDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (clickTimer.current) {
        window.clearTimeout(clickTimer.current);
        clickTimer.current = 0;
      }
      const hit = hitAt(e.clientX, e.clientY);
      const node = hit ? nodeOf(hit.nodeId) : null;
      const localId = hit ? hit.nodeId : -1;
      const drillable =
        node != null &&
        node.path != null &&
        (node.hasMore || (node.flags & DISK_FLAG.isDir) !== 0);
      if (drillable && hit) {
        onZoomRef.current?.(node, { x: hit.x, y: hit.y, w: hit.w, h: hit.h });
      } else {
        onSelectRef.current?.(node, localId);
      }
    },
    [hitAt, nodeOf],
  );

  // RIGHT-CLICK → context menu at the cursor.
  const onContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      if (clickTimer.current) {
        window.clearTimeout(clickTimer.current);
        clickTimer.current = 0;
      }
      const hit = hitAt(e.clientX, e.clientY);
      const node = hit ? nodeOf(hit.nodeId) : null;
      const localId = hit ? hit.nodeId : -1;
      onContextRef.current?.(node, localId, e.clientX, e.clientY);
    },
    [hitAt, nodeOf],
  );

  // Clear any pending click timer on unmount.
  useEffect(() => {
    return () => {
      if (clickTimer.current) window.clearTimeout(clickTimer.current);
    };
  }, []);

  const hoverNode = hover ? nodeOf(hover.rect.nodeId) : null;

  return (
    <div ref={wrapRef} className="relative min-h-0 w-full flex-1 overflow-hidden">
      <canvas
        ref={canvasRef}
        style={{ width: size.w, height: size.h, display: "block" }}
        onPointerMove={onMove}
        onPointerLeave={onLeave}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
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
      {/* Persistent live-growth indicator (spec §3.2) — a static pill (no keyframe
          spin → no GPU/DPC churn) that makes the streaming layout clearly in-progress. */}
      {scanning && (
        <div className="glass pointer-events-none absolute right-3 top-3 z-20 flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[10.5px] font-medium text-muted shadow-sm">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />
          {tf("正在扫描…", "Scanning…")}
        </div>
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
          <div className="mb-0.5 truncate font-semibold text-ink">
            {node ? displayName(node, tf) : "—"}
          </div>
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
