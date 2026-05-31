const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function formatBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1);
  return `${(bytes / 1024 ** i).toFixed(digits)} ${UNITS[i]}`;
}

export function formatPct(value: number, digits = 1): string {
  return `${value.toFixed(digits)}%`;
}

/** Format a logical-CPU mask into a compact list like "0-7, 16, 18". */
export function maskToCpuList(mask: number): string {
  const ids: number[] = [];
  for (let i = 0; i < 64; i++) {
    // Avoid 32-bit signed `<<` overflow: use float division for bit i.
    if (Math.floor(mask / 2 ** i) % 2 === 1) ids.push(i);
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
