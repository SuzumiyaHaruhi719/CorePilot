# Disk Analyzer — SpaceSniffer Real-Time Parity (Enhancement Spec)

Status: ready-to-implement
Branch: `disk-spacesniffer` (worktree `CorePilot-disk`)
Supersedes nothing — this is an **enhancement** of `docs/superpowers/specs/2026-06-23-disk-space-analyzer-design.md`.
Date: 2026-06-24

---

## 0. Why this exists

The disk analyzer already scans `C:` live, publishes growing `Arc<DiskTree>` snapshots, polls
`disk_tree` at ~3 Hz during the scan, lays out a squarified treemap on a canvas, and supports
single-click drill + breadcrumb. It is **functional but not SpaceSniffer**. The three gaps the
user called out:

1. The treemap **pops** between snapshots — each new `disk_tree` slice replaces the rects
   wholesale, so boxes jump to new sizes/positions instead of *growing and re-sorting* smoothly.
   SpaceSniffer's signature is the *organic* live animation.
2. The visual style is an OKLCH depth-ramp, not the SpaceSniffer **cushioned** look: warm/tan
   folders, blue files, bevel shading, a title bar on top-level boxes.
3. The interaction model is **wrong**: single-click currently *drills* (zooms). The user
   explicitly corrected this — single-click must **select** (highlight + detail panel, no zoom);
   **double-click** zooms; **right-click** opens a context menu. None of those exist yet.

This spec defines the target behavior, ties each rule to existing code, and gives a 2-phase plan.

---

## 1. Research — how SpaceSniffer actually behaves

Concrete UX rules harvested from the official SpaceSniffer user manual + the developer's
tips-and-tricks page (uderzo.it), not marketing copy:

### 1.1 Real-time growing treemap
- On Start, SpaceSniffer **paints rectangles as it measures**, not after completion. Blocks
  *appear, grow, and re-sort* continuously as new size data streams in. Useful info shows up
  before the scan finishes. This live, "organic animation" is its standout property.
- The hierarchy is **nested rectangles** (folders contain their children recursively), each box
  sized strictly proportional to its disk occupation.
- A **recursion/detail limit** caps how many nested layers are rendered to avoid clutter;
  `Ctrl +` / `Ctrl -` raises/lowers it. (We already have the LOD `minBytes` knob + the
  client-side `MIN_SUBDIVIDE`/`MIN_RECT` aggregation — the equivalent.)
- `Ctrl+U` shows an explicit **"not-yet-scanned" block** that *shrinks* as the scan progresses;
  `Ctrl+F` shows a **free-space** block. (Optional nicety — see §8 deferrals.)
- You can **navigate while the scan is still running**; the map keeps rearranging underneath you.

### 1.2 Cushioned rendering
- Each rectangle is drawn with a soft **cushion / bevel** (a radial-ish light-to-dark shade
  giving a 3D "pillow" look), the classic cushion-treemap technique. Folders read as warm
  neutral frames; files as a distinct (blue-ish) fill. Top-level boxes carry a **title bar**
  with the name; smaller boxes get name + size where they fit.

### 1.3 Interaction model (the corrected one)
- **Single-click** = SELECT/inspect. In SpaceSniffer a single click *reveals contents in place*
  (changes the box from showing its name to showing children) — it does **not** take over the
  view. For CorePilot the user's explicit rule is: single-click **selects** the box (bright
  outline) and shows its contents/details in the side `DetailPanel`. It does **not** zoom.
- **Double-click** = ZOOM. The box expands to **fill the entire work area**, exposing smaller
  nested elements previously too small to see. You can keep double-clicking deeper.
- **Zoom out / exit** = toolbar "Go to upper level" + "Home", browser-style Back/Forward, and the
  breadcrumb. We map this to: breadcrumb click, an Esc key, a Back affordance, and a right-click
  "Zoom out" item. Zoom transitions **animate**.
- **Right-click** = context menu (in SpaceSniffer it's the Windows Explorer menu: open, delete,
  properties, reveal). For CorePilot we ship an in-app menu wired to the commands we have, with
  the rest stubbed cleanly.
- Think of the whole thing as a **web browser**: zoomable elements + back/forward/home/breadcrumb.

### 1.4 Performance
- The recursion/detail limit is the load-bearing perf control on busy drives; multi-threaded
  scan keeps the UI responsive during the live paint. (Our equivalents already exist; we must not
  regress them and must gate the new tween behind reduce-motion.)

Sources: SpaceSniffer User Manual (people.stfx.ca / download.nust.na PDFs); uderzo.it
tips_and_tricks; MakeUseOf SpaceSniffer walkthroughs; Grokipedia "SpaceSniffer".

---

## 2. What already exists (do NOT rewrite)

| Concern | Where | State |
|---|---|---|
| Scan engine, arena tree, `Arc<DiskTree>` snapshot publishing | `src-tauri/src/disk_scan.rs` `run_scan` | publisher thread rebuilds + pointer-swaps a snapshot every `PUBLISH_THROTTLE = 400ms`, bumps `generation` |
| Progress event | `disk-scan://progress`, throttled `PROGRESS_THROTTLE = 200ms`, scalars only (incl. `generation`) | done |
| LOD slice commands | `disk_tree(scanId, focusPath, {depth,minBytes,maxNodes})`, `disk_top_items` | done; server-side LOD + `has_more` |
| Coalesced event listener | `src/hooks/useDiskScanEvents.ts` | buffers per-scanId, flushes on 16ms trailing tick → `setProgress` |
| Per-disk view store | `src/store/diskScan.ts` (`PerDiskView`: metric/colorMode/paused/lod/stack/progress) | done; O(1) tab switch |
| Active-tab live poller | `DiskWorkspace.tsx` — re-pulls `disk_tree` on a new `generation` at 320ms while `scanning && !paused` | done — **this feeds the new tween** |
| Squarified layout | `src/tabs/disk/treemap/layout.ts` — `layoutTreemap()` → flat `DrawRect[]`, adaptive `MIN_RECT`, bucket tiles, `MAX_DRAW_RECTS=4000`, `hitTest()` | done; **keep, extend with a stable key per rect** |
| Canvas renderer | `src/tabs/disk/treemap/TreemapCanvas.tsx` — imperative `useEffect` draw, no rAF loop, hover overlay + tooltip, `onPick`/`onHover` | **the main edit surface** |
| Colors | `src/tabs/disk/treemap/colors.ts` — theme-token palette, `rectColor` depth/type | **extend for cushion + folder/file fills** |
| Breadcrumb | `src/tabs/disk/treemap/Breadcrumb.tsx` — ascend by depth | reuse for zoom-out |
| Detail panel | `src/tabs/disk/DetailPanel.tsx` — selection summary + "largest items here" + Reveal | reuse; selection is already its input |
| Context menu primitive | `src/components/ui/ContextMenu.tsx` — `MenuState{x,y,items:MenuItem[]}`, portal, keyboard nav, glass | **reuse as-is** |
| Reduce-motion | `settings.reduceMotion` → `document.documentElement.dataset.reduceMotion` | gate the tween on this |
| Shell command | `api.revealInExplorer(path)` (`reveal_in_explorer`) | only shell op we have |

### Current behaviors that MUST change
- `TreemapCanvas.onClick` calls `onPick` → `DiskWorkspace.onPick` **drills** on a single click of
  a container. **Wrong.** Single-click must select; drilling moves to double-click.
- The canvas draws each `disk_tree` slice statically. New slices replace `rects` via `useMemo`
  → instant pop. We add a **tweened render**.
- `rectColor` uses a depth ramp; no cushion, no warm-folder/blue-file split, no title bar.

---

## 3. Target model

### 3.1 Real-time growing / animated layout (the tween)

Keep the existing data path exactly: backend publishes snapshots → poller pulls `disk_tree` on a
new `generation` → `tree` state updates. **Add an interpolation layer between `tree` and the
canvas draw** so rects ease toward their new geometry instead of popping.

**Stable identity.** Today `DrawRect.nodeId` is a *local slice index* — unstable across snapshots
(a node's local id changes as the tree grows). Animation needs a key that survives re-slicing.

- Add `key: string` to `DrawRect` (layout.ts). Derive it from something stable across snapshots:
  - container/leaf with a `path` → use `path`.
  - leaf without a path (most files) → `parentPath + "/" + name` (we can synthesize parentPath by
    threading it down the `recurse`; cheap, no backend change).
  - bucket tile → `parentKey + "#bucket"`.
  Collisions are acceptable (worst case: two same-named siblings tween together) — keys only drive
  the *animation match*, never correctness.

**Interpolation (TreemapCanvas).** Introduce an animation controller that owns:
- `prevByKey: Map<string, {x,y,w,h,alpha}>` — last *rendered* geometry per key.
- A target = the freshly laid-out `rects`.
- A single owned `requestAnimationFrame` loop **active only while a tween is in flight** (start it
  on a new target, stop it when all rects reach their target within ε). This respects the existing
  "no continuous rAF" rule — the loop self-terminates; idle cost stays zero.
- Per frame, for each target rect: ease current→target geometry with a critically-damped lerp
  (`cur += (target - cur) * k` where `k ≈ 1 - exp(-dt/τ)`, `τ ≈ 90ms`). New keys (just appeared)
  **fade + grow in** from their target center at `alpha 0→1`. Disappeared keys (folded into a
  bucket / no longer in slice) **fade out** over ~120ms then drop. Easing target reuses the
  existing `cubic-bezier(0.22,1,0.36,1)` feel.
- Draw uses the *interpolated* rects, not the raw layout. Labels/cushion read from the same.

**Re-sort.** Because squarify already sorts children size-desc per snapshot, a box that overtakes a
sibling lands in a new cell; the lerp animates it across — exactly SpaceSniffer's "blocks shift and
grow." No extra sort logic needed; the key-matched lerp does the visual work.

**Cadence.** Backend `PUBLISH_THROTTLE=400ms` + poller `320ms` already give ~2.5–3 Hz of new
targets. The 90ms τ tween visibly settles between snapshots without lag. No backend change needed
for v1. (If growth feels choppy, lower `PUBLISH_THROTTLE` to 250ms — single-constant, noted as a
follow-up, not required.)

**Freeze-proof invariants.** The rAF loop lives entirely in the renderer; layout stays pure and off
the React render path; no shared read lock is held across the tween; the loop is O(visible rects)
per frame and bounded by `MAX_DRAW_RECTS`. Nothing blocks the main thread beyond a normal canvas
paint.

### 3.2 Cushioned squarified visuals

Layout stays squarified-by-size (already correct: `buildChildIndex` sorts size-desc, `squarify`
is Bruls/Huizing/van Wijk). Visual upgrades in `colors.ts` + `TreemapCanvas` draw pass:

- **Folder vs file fill via theme tokens** (new `rectColor` mode or a refactor of "type"):
  - Folders → a **warm tan/neutral** frame. Derive from a warm hue token; since the palette is
    accent-violet by default, synthesize tan as `oklch(L 0.045 70)` (hue 70 = warm amber/tan) at a
    theme-aware L, OR reuse `--color-freq` (amber) at low chroma so it stays on-theme. Folders get
    progressively deeper L as they nest (the frame recedes).
  - Files → a **blue** fill from `--color-cyan` (already a teal/blue token), chroma-modulated.
  - "by type" mode (code/image/video/exec hues) is **retained** as an alternate color mode; the new
    folder-tan/file-blue becomes the default SpaceSniffer-look mode. Add it as a third segment
    value (e.g. `"cushion"`) OR make it the meaning of the existing default — owner pick in §7.
- **Cushion / bevel.** After the flat `fillRect`, paint a cheap bevel without per-pixel work:
  - a top-left→bottom-right linear-gradient overlay per rect (light at top-left, dark at
    bottom-right) using `ctx.createLinearGradient` cached by size bucket, OR
  - two 1px inner strokes (light top+left, dark bottom+right) — the *engraved* look, far cheaper
    and DPR-stable. **Prefer the 2-stroke bevel for v1** (no gradient object churn; respects the
    GPU-budget rule). The gradient cushion is an optional richer pass gated by `gpuRender`.
- **Title bar on top-level boxes.** Containers already reserve a `LABEL_STRIP` (16px) for the name.
  Render it as a faint filled bar (slightly darker than the frame fill) so it reads as a header,
  with the folder name + (where room) its size. Depth-0/1 containers get the bar; deeper ones keep
  the plain strip to avoid clutter.
- **Labels.** Keep existing legibility thresholds + ellipsis clipping. Add the size to container
  title bars when width allows (SpaceSniffer shows folder size in the header).
- **Selection outline.** Selected box gets a **bright white/accent 2px outline** (distinct from the
  thinner hover outline) — see §3.3.
- **Scanning indicator.** Keep the existing "Scanning…" spinner state, but also show a small
  persistent **"Scanning…" pill** over the canvas (top-right) while `scanning` so the live-growth is
  clearly in-progress, not a stuck render. Optional faint shimmer on the most-recently-grown
  region is a deferral (§8).

### 3.3 Interaction model (corrected)

All pointer logic lives in `TreemapCanvas` (it owns the hit-test) and surfaces intent via callbacks
to `DiskWorkspace` (which owns the store/stack). Rename/replace `onPick` with explicit intents:

- `onSelect(node, localId)` — **single-click**. Sets `selected` in `DiskWorkspace`; the canvas
  draws the bright outline; `DetailPanel` already renders `selected`. **No navigation.**
- `onZoom(node)` — **double-click** on a container (or a `has_more` dir) → push onto the drill
  `stack` (existing logic, moved off single-click) and play the zoom tween. Double-click a leaf =
  select (no zoom). Continue double-clicking to go deeper.
- `onContext(node, localId, clientX, clientY)` — **right-click** → `DiskWorkspace` opens
  `ContextMenu` with `MenuState{x,y,items}`.

**Click vs double-click disambiguation.** A naive `onClick`+`onDoubleClick` fires select *then*
zoom. Use the standard guard: on click, start a ~220ms timer that commits the *select*; if a second
click (dblclick) arrives first, cancel the timer and run *zoom*. Implement with a small ref-held
timer in the canvas. (Selecting-then-zooming is actually acceptable since select has no side effect
beyond detail+outline, but the timer keeps it clean and avoids a flash of the wrong detail.)

**Zoom animate.** Reuse `DiskWorkspace.playZoom()` (already a one-shot WAAPI scale tween gated by
reduce-motion). Trigger it on zoom-in. For zoom-**out** (breadcrumb/Esc/Back/menu), play the
inverse (scale from >1 down to 1, origin = the child we came from) — small addition to `playZoom`.

**Exit-zoom affordances** (all map to popping the stack):
- Breadcrumb segment click — exists (`navigate(depth)`).
- **Esc** — pop one level (no-op at root). Add a keydown handler on the workspace, active only when
  the disk tab is focused and no menu/filter is open.
- **Back affordance** — a small back-chevron button in the toolbar (left of breadcrumb) that pops
  one level; disabled at root. (Forward is a deferral §8.)
- Right-click **"Zoom out / to parent"** menu item.

**Right-click context menu items** (build in `DiskWorkspace`, render via `ContextMenu`):
| Item | Action | Backing |
|---|---|---|
| Zoom in | push node onto stack (containers only) | existing stack logic |
| Zoom out / to parent | pop one stack level | existing `navigate` |
| Reveal in Explorer | `api.revealInExplorer(node.path)` | exists |
| Open | folder → reveal; file → reveal (Open-file is a stub until a shell-open command exists) | partial — note in §7 |
| Copy path | `navigator.clipboard.writeText(node.path)` | browser API, no backend |
| Rescan | re-run `disk_scan_start([scanId])` (master rescan) | exists (`diskScanStart`) |
Items with no backing (Open-file, Delete) are **omitted or disabled**, never fake-wired. Disable
any item whose `node.path` is null (buckets, synthetic aggregates).

### 3.4 Performance / LOD / reduce-motion

- LOD untouched: server `minBytes` (the Detail slider) + client `MIN_SUBDIVIDE`/`MIN_RECT` bucket
  aggregation + `MAX_DRAW_RECTS=4000` cap all stay. The tween iterates only the already-capped rect
  set, so cost is bounded.
- **Reduce-motion**: when `data-reduce-motion === "true"`, the rAF tween is **disabled** — render
  the target geometry directly (instant snap on each snapshot, as today), and `playZoom` already
  early-returns. New boxes appear with no fade. This is the existing contract; do not break it.
- **GPU budget**: no box-shadow, no keyframes, no continuous rAF when idle (loop self-terminates).
  The DPR cap (`gpuRender ? min(dpr,2) : 1`) stays. The optional gradient cushion is gated behind
  `gpuRender` so the "省电"/gaming mode never pays for it. (MEMORY: box-shadow DPC storm — we add
  none.)
- The tween touches only canvas geometry; React state churn is unchanged (still one `setTree` per
  new generation). The rAF loop reads `rects`/`prevByKey` via refs, never via React state, so it
  doesn't re-render the component per frame.

---

## 4. Phase A — Real-time growth + cushioned visuals

Goal: the treemap *grows and re-sorts smoothly* during a scan, with the SpaceSniffer cushion look.
No interaction changes yet (single-click still drills — fixed in Phase B).

### A1. Stable rect keys — `src/tabs/disk/treemap/layout.ts`
- Add `key: string` to `DrawRect`.
- Thread a `parentPath`/`parentKey` through `recurse` and the root pass; compute `key` per rect
  (path, else `parentKey + "/" + name`, else `+ "#bucket"`). No backend change.
- `hitTest` unchanged (still index-based on the *current* layout).

### A2. Tween controller — `src/tabs/disk/treemap/TreemapCanvas.tsx`
- Add a `useRef` animation controller: `prevByKey`, `rafId`, `lastTs`.
- On a new `rects` target: diff keys (new/persisting/removed), seed `prevByKey` for new keys at
  target-center+alpha0, mark removed keys fading, start the rAF loop if not running.
- rAF step: critically-damped lerp geometry + alpha toward target; drop fully-faded removed keys;
  stop the loop when every rect is within ε of target and no fades remain.
- Draw pass consumes interpolated rects. Gate the whole controller on
  `dataset.reduceMotion !== "true"` (else draw target directly, as today).
- Keep the existing imperative `useEffect` draw for the *non-animated* (reduce-motion / settled)
  path so nothing regresses.

### A3. Cushion + folder/file colors — `src/tabs/disk/treemap/colors.ts`
- Add the SpaceSniffer color mode (warm-tan folders via amber/`--color-freq` low-chroma; blue files
  via `--color-cyan`). Make it the default; keep `depth`/`type` selectable.
- Export a `bevel(palette)` helper returning the light/dark inner-stroke colors (theme-aware).

### A4. Cushion bevel + title bar draw — `TreemapCanvas.tsx`
- After each `fillRect`, paint the 2-stroke bevel (light top/left, dark bottom/right) for rects
  above a min size.
- Render the container title bar (filled strip, name + size) for depth ≤ 1 containers.
- Add the persistent **"Scanning…" pill** overlay (DOM element over the canvas, shown while
  `scanning`).

### A5. Color-mode segment — `src/tabs/disk/DiskWorkspace.tsx` + `store/diskScan.ts`
- Add the new mode to the color `Segmented` options and the `ColorMode` union; default the store's
  `colorMode` to it. (Or repurpose the existing default — see §7.)

**Phase A verification:** `cargo check` (no backend change expected — should be a no-op compile) +
`npx tsc --noEmit`. Build-only; never launch the app.

### Phase A touched files
- `src/tabs/disk/treemap/layout.ts` (add `key`)
- `src/tabs/disk/treemap/TreemapCanvas.tsx` (tween controller, bevel, title bar, scanning pill)
- `src/tabs/disk/treemap/colors.ts` (cushion mode + bevel helper)
- `src/tabs/disk/DiskWorkspace.tsx` (color segment option)
- `src/store/diskScan.ts` (ColorMode default; type union via colors.ts)
- (no `disk_scan.rs` change in Phase A)

---

## 5. Phase B — Interactions (select / zoom / context menu)

Goal: single-click selects, double-click zooms in/out with animation + exit affordances,
right-click opens a wired context menu.

### B1. Canvas intents — `TreemapCanvas.tsx`
- Replace `onPick` with `onSelect`, `onZoom`, `onContext` props.
- Implement click/double-click disambiguation (ref-held ~220ms timer): single → `onSelect`,
  double on a container/`has_more` dir → `onZoom`, double on a leaf → `onSelect`.
- `onContextMenu` handler: hit-test, `e.preventDefault()`, call `onContext(node, id, clientX,
  clientY)`.
- Draw the **selected** rect with a bright 2px white/accent outline (distinct from hover).

### B2. Workspace wiring — `src/tabs/disk/DiskWorkspace.tsx`
- `onSelect(node)` → `setSelected(node)` (no nav). DetailPanel already consumes `selected`.
- `onZoom(node)` → existing drill logic (push stack + `playZoom`), now off double-click only.
- Add **zoom-out**: a back-chevron toolbar button (pop one level, disabled at root) + an **Esc**
  keydown handler (active when the tab is focused, menu/filter closed) that pops one level.
- Extend `playZoom` to play an inverse (zoom-out) tween when ascending.
- `onContext(node,id,x,y)` → build `MenuItem[]` (§3.3 table) and set local `MenuState`; render
  `<ContextMenu state=… onClose=…/>`. Disable items whose `node.path` is null. Wire Reveal/Copy
  path/Zoom in/Zoom out/Rescan; omit or disable Open-file/Delete.

### B3. Context menu actions
- Reveal → `api.revealInExplorer(node.path)`.
- Copy path → `navigator.clipboard.writeText(node.path)`.
- Zoom in/out → reuse the stack push/pop.
- Rescan → `api.diskScanStart([scanId])` (master rescan of this disk).

**Phase B verification:** `npx tsc --noEmit` (+ `cargo check` if any command is touched — none
expected; all actions reuse existing commands). Build-only.

### Phase B touched files
- `src/tabs/disk/treemap/TreemapCanvas.tsx` (intents, dblclick guard, selection outline, contextmenu)
- `src/tabs/disk/DiskWorkspace.tsx` (select/zoom/context wiring, back button, Esc, ContextMenu render,
  inverse zoom tween)
- (reuse `src/components/ui/ContextMenu.tsx`, `Breadcrumb.tsx`, `DetailPanel.tsx` unchanged)
- (no `disk_scan.rs` change in Phase B)

---

## 6. Final build gate
After both phases: prepend `C:/Users/Thomas/.cargo/bin` to PATH; the orchestrator runs the real
`npx tauri build`. Do **not** run `tauri dev` / launch `corepilot.exe` at any point during
development — `cargo check` + `npx tsc --noEmit` only.

---

## 7. Owner decisions (defaults chosen; revisit if needed)
1. **Default color mode**: add a new `"cushion"` mode (warm folders / blue files) and make it the
   default, keeping `depth` + `type` selectable. (Alternative: silently change the meaning of the
   current default — rejected; an explicit segment is clearer and reversible.)
2. **Bevel style v1**: 2-stroke engraved bevel (cheap, DPR-stable). Gradient "pillow" cushion is a
   `gpuRender`-gated optional pass, not v1.
3. **Open menu item**: no generic shell-open command exists (only `reveal_in_explorer`). v1 maps
   "Open" on a folder → reveal; a file → reveal-in-Explorer (selects it). True file-open is a
   deferral until a `shell_open` command is added — do not fake it.
4. **Tween τ = 90ms, zoom = existing 220ms**; tune by feel during Phase A. Reduce-motion snaps.

## 8. Deferrals (out of scope for this enhancement)
- `Ctrl+F` free-space / `Ctrl+U` unscanned-space blocks.
- Color-tagging (Ctrl+1..4) overlays.
- Forward navigation (we ship Back + breadcrumb + Esc only).
- Delete / file-open shell commands (need new backend commands + a confirm gate).
- Gradient/radial "pillow" cushion (vs. the v1 2-stroke bevel).
- Lowering `PUBLISH_THROTTLE` below 400ms (only if growth feels choppy).

---

## 9. Invariant checklist (must hold after both phases)
- [ ] Background scan work stays off the main thread (no change to `run_scan` threading).
- [ ] Commands stay O(1)/async; no shared read lock held across slow work (no backend change).
- [ ] rAF tween self-terminates when settled; zero idle GPU cost; no box-shadow/keyframes.
- [ ] Reduce-motion disables the tween + zoom (instant snap), no regression.
- [ ] LOD caps (`MIN_SUBDIVIDE`/`MIN_RECT`/`MAX_DRAW_RECTS`) unchanged.
- [ ] Colors read from theme tokens (auto-retint across graphite/cyberpunk/midnight/light).
- [ ] Single-click selects (no nav); double-click zooms; right-click menu; Esc/Back/breadcrumb exit.
- [ ] Context-menu items with no backing are disabled/omitted, never fake-wired.
- [ ] `cargo check` + `npx tsc --noEmit` clean before the final `npx tauri build`.
