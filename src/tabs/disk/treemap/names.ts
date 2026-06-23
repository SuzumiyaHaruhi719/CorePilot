import { DISK_FLAG, type TreeNode, type ItemRow } from "../../../lib/ipc";

/**
 * i18n-aware display name for a treemap node / item row (spec §3.6 canvas i18n).
 *
 * The backend mints the synthetic "long-tail" aggregate leaf with a
 * language-neutral English name (`"(N more files)"`) baked into the immutable
 * tree — it can't know the UI language. Every user-facing surface (canvas labels,
 * tooltip, detail panel, top-items list) funnels names through this helper so an
 * AGGREGATED node renders via `tf()` from its `fileCount`, while ordinary
 * file/dir names (real on-disk path components) pass through unchanged.
 *
 * Pass the component's `tf` (from `useTf()`); this keeps the canvas-drawn strings
 * out of the DOM i18n walker's blind spot (MEMORY: CorePilot i18n).
 */
export function displayName(
  node: Pick<TreeNode, "name" | "flags" | "fileCount"> | ItemRow,
  tf: (zh: string, en: string) => string,
): string {
  if ((node.flags & DISK_FLAG.aggregated) !== 0) {
    const n = node.fileCount.toLocaleString();
    return tf(`(其余 ${n} 个文件)`, `(${n} more files)`);
  }
  return node.name;
}
