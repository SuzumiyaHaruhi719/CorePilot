const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function formatBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1);
  return `${(bytes / 1024 ** i).toFixed(digits)} ${UNITS[i]}`;
}

export function formatPct(value: number, digits = 1): string {
  return `${value.toFixed(digits)}%`;
}

/** Seconds → "H:MM:SS" (process CPU time). */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Format a logical-CPU mask into a compact list like "0-7, 16, 18". `mask` is a
 *  `bigint` so every one of the 64 possible bits is exact. */
export function maskToCpuList(mask: bigint): string {
  const ids: number[] = [];
  for (let i = 0n; i < 64n; i++) {
    if ((mask >> i) & 1n) ids.push(Number(i));
  }
  if (ids.length === 0) return "—";
  const ranges: string[] = [];
  let start = ids[0];
  let prev = ids[0];
  for (let k = 1; k <= ids.length; k++) {
    const cur = ids[k];
    if (cur === prev + 1) {
      prev = cur;
      continue;
    }
    ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = cur;
    prev = cur;
  }
  return ranges.join(" ");
}
