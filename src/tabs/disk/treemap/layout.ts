import type { TreeView, TreeNode } from "../../../lib/ipc";
import { DISK_FLAG } from "../../../lib/ipc";

/**
 * Squarified treemap layout (Bruls/Huizing/van Wijk) — pure, deterministic, off
 * the React render path (spec §3.2). Given a `TreeView` LOD slice (already
 * sliced + collapsed by the backend `disk_tree`) it lays the focus root's
 * descendants into a pixel rect and emits a FLAT array of `DrawRect`s the canvas
 * renderer iterates once per frame.
 *
 * The layout owns the CLIENT-side LOD layer (spec §3.3): it stops recursing into
 * a child once its short side drops below `MIN_SUBDIVIDE` (drawn as a solid leaf
 * block), collapses sibling rects below `MIN_RECT` into one synthetic muted
 * "… N more" tile, and adaptively raises `MIN_RECT` until the rect count is under
 * `MAX_DRAW_RECTS` — a bounded frame budget regardless of fan-out.
 *
 * No colors are decided here — color is a render-time concern (theme tokens read
 * via getComputedStyle, spec §3.5). The layout only carries `depth` + structural
 * flags so the renderer can tint and label.
 *
 * See docs/superpowers/specs/2026-06-23-disk-space-analyzer-design.md §3.2/§3.3.
 */

/** Below this short-side (px) a container is NOT subdivided — drawn as a leaf. */
export const MIN_SUBDIVIDE = 24;
/** Sibling rects whose short side would be under this (px) fold into "… N more". */
export const MIN_RECT = 3;
/** Hard ceiling on emitted draw-rects; `MIN_RECT` is raised adaptively to stay under. */
export const MAX_DRAW_RECTS = 4000;
/** Reserved top label strip (px) so a framed folder's name reads above its children. */
export const LABEL_STRIP = 16;
/** Inner padding (px) inset on every subdivided container before nesting children. */
export const PAD = 1;

/** Which size metric drives the rectangle areas (per-tab, spec §2.4). */
export type Metric = "alloc" | "logical";

/** One laid-out rectangle the canvas draws. Pixel coords are CSS px (pre-DPR). */
export interface DrawRect {
  /** Local node index within the source `TreeView.nodes`, or -1 for a synthetic
   *  "… N more" bucket tile (no backing node). */
  nodeId: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Nesting depth below the focus root (0 = a direct child of the root frame). */
  depth: number;
  /** True when this rect frames nested children (has a label strip + children). */
  isContainer: boolean;
  /** True for the synthetic "… N more (size)" collapse tile. */
  isBucket: boolean;
  /** Folded-child count for a bucket tile (0 otherwise). */
  bucketCount: number;
  /** Summed metric size this rect represents (a node's, or a bucket's total). */
  size: number;
  /**
   * Stable identity ACROSS snapshots — drives the tween's key-match so a box eases
   * to its new geometry instead of popping when the tree grows (spec §3.1). Derived
   * structurally (NOT the local `nodeId`, which is a slice-index that shifts as the
   * tree grows): a node's absolute `path` if present, else `parentKey + "/" + name`,
   * else `parentKey + "#bucket"`. Collisions are harmless — keys only match the
   * animation, never correctness.
   */
  key: string;
}

export interface LayoutInput {
  view: TreeView;
  /** Pixel rect to fill (the canvas content box, CSS px). */
  width: number;
  height: number;
  metric: Metric;
}

export interface LayoutResult {
  rects: DrawRect[];
  /** The effective MIN_RECT after adaptive raising (for diagnostics / detail). */
  minRect: number;
  /** True when adaptive culling kicked in (some siblings were bucketed). */
  culled: boolean;
}

/** Metric accessor for a node. */
function sizeOf(n: TreeNode, metric: Metric): number {
  return metric === "alloc" ? n.allocSize : n.logicalSize;
}

/** Re-nest the flat `TreeView` slice: children-of(local index), size-desc. The
 *  slice is already size-desc globally, but parents can interleave — group +
 *  re-sort per parent so squarify always sees a descending run. */
function buildChildIndex(view: TreeView, metric: Metric): Map<number, number[]> {
  const kids = new Map<number, number[]>();
  for (let i = 1; i < view.nodes.length; i++) {
    const p = view.nodes[i].parent;
    let arr = kids.get(p);
    if (!arr) kids.set(p, (arr = []));
    arr.push(i);
  }
  for (const arr of kids.values()) {
    arr.sort((a, b) => sizeOf(view.nodes[b], metric) - sizeOf(view.nodes[a], metric));
  }
  return kids;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Worst aspect ratio of a row of areas laid into a strip of side `side`. */
function worst(row: number[], side: number, sum: number): number {
  if (row.length === 0 || side <= 0 || sum <= 0) return Infinity;
  const s2 = side * side;
  const sum2 = sum * sum;
  let max = -Infinity;
  let min = Infinity;
  for (const a of row) {
    if (a > max) max = a;
    if (a < min) min = a;
  }
  return Math.max((s2 * max) / sum2, sum2 / (s2 * min));
}

/**
 * Squarify a list of weighted items into `rect`, calling `place(item, r)` for
 * each. Classic Bruls/Huizing/van Wijk: accumulate a row while it keeps the
 * worst aspect ratio improving, then lay the row across the shorter side and
 * recurse into the remaining strip.
 */
function squarify<T>(
  items: Array<{ item: T; area: number }>,
  rect: Rect,
  place: (item: T, r: Rect) => void,
): void {
  // Filter zero/negative areas defensively (a collapsed-to-zero child).
  const live = items.filter((it) => it.area > 0);
  if (live.length === 0) return;

  let r: Rect = { ...rect };
  let i = 0;
  while (i < live.length) {
    let side = Math.min(r.w, r.h);
    if (side <= 0) break;
    const row: number[] = [];
    const rowItems: T[] = [];
    let rowSum = 0;
    let j = i;
    // Grow the row while it improves (lowers) the worst aspect ratio.
    while (j < live.length) {
      const next = live[j].area;
      const cur = worst(row, side, rowSum);
      const withNext = worst([...row, next], side, rowSum + next);
      if (row.length > 0 && withNext > cur) break;
      row.push(next);
      rowItems.push(live[j].item);
      rowSum += next;
      j++;
    }

    // Lay this row across the shorter side; advance the remaining strip.
    const total = r.w * r.h;
    const rowFrac = total > 0 ? rowSum / total : 0;
    if (r.w <= r.h) {
      // Horizontal strip across the top, height proportional to the row's area.
      const stripH = r.h * rowFrac;
      let cx = r.x;
      for (let k = 0; k < rowItems.length; k++) {
        const wFrac = rowSum > 0 ? row[k] / rowSum : 0;
        const w = r.w * wFrac;
        place(rowItems[k], { x: cx, y: r.y, w, h: stripH });
        cx += w;
      }
      r = { x: r.x, y: r.y + stripH, w: r.w, h: r.h - stripH };
    } else {
      // Vertical strip down the left, width proportional to the row's area.
      const stripW = r.w * rowFrac;
      let cy = r.y;
      for (let k = 0; k < rowItems.length; k++) {
        const hFrac = rowSum > 0 ? row[k] / rowSum : 0;
        const h = r.h * hFrac;
        place(rowItems[k], { x: r.x, y: cy, w: stripW, h });
        cy += h;
      }
      r = { x: r.x + stripW, y: r.y, w: r.w - stripW, h: r.h };
    }
    side = Math.min(r.w, r.h);
    i = j;
  }
}

/**
 * Lay out one `TreeView` slice into a pixel rect. The result is a flat array of
 * `DrawRect`s in draw order (parents before children, so the renderer paints a
 * frame then nests children on top).
 */
export function layoutTreemap(input: LayoutInput): LayoutResult {
  const { view, width, height, metric } = input;
  const kids = buildChildIndex(view, metric);

  // Adaptive MIN_RECT: lay out, and if we blow the rect budget, raise the floor
  // and retry. Geometric backoff converges in a handful of passes.
  let minRect = MIN_RECT;
  for (let attempt = 0; attempt < 8; attempt++) {
    const rects: DrawRect[] = [];
    let culled = false;

    const recurse = (localId: number, rect: Rect, depth: number, parentKey: string): void => {
      if (rects.length >= MAX_DRAW_RECTS) return;
      const children = kids.get(localId);
      const node = view.nodes[localId];
      const short = Math.min(rect.w, rect.h);
      // Stable structural key (spec §3.1): prefer the absolute path, else qualify
      // the name under the parent's key so it survives re-slicing as the tree grows.
      const selfKey = node.path != null ? node.path : `${parentKey}/${node.name}`;

      // No children, too small to subdivide, or budget hit → solid leaf block.
      const isDir = (node.flags & DISK_FLAG.isDir) !== 0;
      const drillable = node.hasMore && node.path != null;
      const subdividable =
        children != null &&
        children.length > 0 &&
        short >= MIN_SUBDIVIDE &&
        // Reserve room for the label strip + padding before nesting.
        rect.h > LABEL_STRIP + PAD * 2 + MIN_SUBDIVIDE * 0.5;

      if (!subdividable) {
        rects.push({
          nodeId: localId,
          x: rect.x,
          y: rect.y,
          w: rect.w,
          h: rect.h,
          depth,
          isContainer: false,
          isBucket: false,
          bucketCount: 0,
          size: sizeOf(node, metric),
          key: selfKey,
        });
        // A dir we chose not to subdivide but still has un-expanded children is
        // a drillable leaf; the renderer marks it (hasMore handled at draw).
        void isDir;
        void drillable;
        return;
      }

      // Container frame: emit the frame, then nest children inside the inner box.
      rects.push({
        nodeId: localId,
        x: rect.x,
        y: rect.y,
        w: rect.w,
        h: rect.h,
        depth,
        isContainer: true,
        isBucket: false,
        bucketCount: 0,
        size: sizeOf(node, metric),
        key: selfKey,
      });

      const inner: Rect = {
        x: rect.x + PAD,
        y: rect.y + LABEL_STRIP,
        w: Math.max(0, rect.w - PAD * 2),
        h: Math.max(0, rect.h - LABEL_STRIP - PAD),
      };
      const innerShort = Math.min(inner.w, inner.h);
      if (innerShort <= 0) return;

      // Partition children: big enough to draw individually vs. fold into a bucket.
      const childAreaScale = innerArea(inner) / Math.max(1e-9, sumSizes(children, view, metric));
      const drawn: number[] = [];
      let bucketSize = 0;
      let bucketCount = 0;
      for (const c of children) {
        const cArea = sizeOf(view.nodes[c], metric) * childAreaScale;
        // Estimate the child's short side if it took a square-ish cell.
        const est = Math.sqrt(Math.max(0, cArea));
        if (est < minRect) {
          bucketSize += sizeOf(view.nodes[c], metric);
          bucketCount += view.nodes[c].fileCount > 0 ? 1 : 1;
        } else {
          drawn.push(c);
        }
      }
      if (bucketCount > 0) culled = true;

      // Build the squarify item list: drawn children + one synthetic bucket.
      const items: Array<{ item: number; area: number; size: number }> = drawn.map((c) => ({
        item: c,
        area: sizeOf(view.nodes[c], metric),
        size: sizeOf(view.nodes[c], metric),
      }));
      if (bucketSize > 0) {
        items.push({ item: -1, area: bucketSize, size: bucketSize });
      }

      squarify(
        items.map((it) => ({ item: it, area: it.area })),
        inner,
        (it, r) => {
          if (rects.length >= MAX_DRAW_RECTS) return;
          if (it.item === -1) {
            rects.push({
              nodeId: -1,
              x: r.x,
              y: r.y,
              w: r.w,
              h: r.h,
              depth: depth + 1,
              isContainer: false,
              isBucket: true,
              bucketCount,
              size: it.size,
              key: `${selfKey}#bucket`,
            });
            return;
          }
          recurse(it.item, r, depth + 1, selfKey);
        },
      );
    };

    // The focus root is a frame filling the whole canvas; its children fill the
    // inner box below the root label strip.
    const rootRect: Rect = { x: 0, y: 0, w: width, h: height };
    const rootChildren = kids.get(0);
    // Root key: the focus root's absolute path (stable across snapshots).
    const rootKey = view.nodes[0]?.path ?? view.focusPath ?? "root";
    if (!rootChildren || rootChildren.length === 0 || width <= 0 || height <= 0) {
      // Degenerate: nothing to nest — draw the root as a single block.
      rects.push({
        nodeId: 0,
        x: 0,
        y: 0,
        w: width,
        h: height,
        depth: 0,
        isContainer: false,
        isBucket: false,
        bucketCount: 0,
        size: sizeOf(view.nodes[0], metric),
        key: rootKey,
      });
      return { rects, minRect, culled };
    }

    const inner: Rect = {
      x: rootRect.x + PAD,
      y: rootRect.y + LABEL_STRIP,
      w: Math.max(0, rootRect.w - PAD * 2),
      h: Math.max(0, rootRect.h - LABEL_STRIP - PAD),
    };
    const scale = innerArea(inner) / Math.max(1e-9, sumSizes(rootChildren, view, metric));
    const drawn: number[] = [];
    let bucketSize = 0;
    let bucketCount = 0;
    for (const c of rootChildren) {
      const est = Math.sqrt(Math.max(0, sizeOf(view.nodes[c], metric) * scale));
      if (est < minRect) {
        bucketSize += sizeOf(view.nodes[c], metric);
        bucketCount += 1;
      } else {
        drawn.push(c);
      }
    }
    if (bucketCount > 0) culled = true;

    const items: Array<{ item: number; area: number; size: number }> = drawn.map((c) => ({
      item: c,
      area: sizeOf(view.nodes[c], metric),
      size: sizeOf(view.nodes[c], metric),
    }));
    if (bucketSize > 0) items.push({ item: -1, area: bucketSize, size: bucketSize });

    squarify(
      items.map((it) => ({ item: it, area: it.area })),
      inner,
      (it, r) => {
        if (rects.length >= MAX_DRAW_RECTS) return;
        if (it.item === -1) {
          rects.push({
            nodeId: -1,
            x: r.x,
            y: r.y,
            w: r.w,
            h: r.h,
            depth: 1,
            isContainer: false,
            isBucket: true,
            bucketCount,
            size: it.size,
            key: `${rootKey}#bucket`,
          });
          return;
        }
        recurse(it.item, r, 1, rootKey);
      },
    );

    if (rects.length < MAX_DRAW_RECTS) {
      return { rects, minRect, culled };
    }
    // Over budget — raise the floor and retry with coarser culling.
    minRect = Math.ceil(minRect * 1.6) + 1;
  }

  // Exhausted retries (pathological fan-out): return whatever the last coarse
  // pass produced, capped. (Unreachable in practice — MIN_RECT growth is fast.)
  return { rects: [], minRect, culled: true };
}

function innerArea(r: Rect): number {
  return Math.max(0, r.w) * Math.max(0, r.h);
}

function sumSizes(ids: number[], view: TreeView, metric: Metric): number {
  let s = 0;
  for (const id of ids) s += sizeOf(view.nodes[id], metric);
  return s;
}

/**
 * Hit-test a flat draw-rect list at (px,py) in CSS px. Returns the TOPMOST
 * (deepest, last-drawn) rect under the point, or null. O(visible) reverse scan —
 * the deepest nested rect is drawn last so it sits on top (spec §3.7).
 */
export function hitTest(rects: DrawRect[], px: number, py: number): DrawRect | null {
  for (let i = rects.length - 1; i >= 0; i--) {
    const r = rects[i];
    // Containers are frames: only their label strip + border are "theirs"; the
    // inner area belongs to children drawn on top. Since children are later in
    // the array, a reverse scan naturally returns the child first, so a plain
    // bounds test is correct for leaves/buckets and for a container's strip.
    if (px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h) return r;
  }
  return null;
}
