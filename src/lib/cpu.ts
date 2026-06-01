import type { CpuTopology } from "./ipc";

/** Mask helpers — use float math to stay correct for bits >= 31. */

export function idsFromMask(mask: number): number[] {
  const ids: number[] = [];
  for (let i = 0; i < 64; i++) {
    if (Math.floor(mask / 2 ** i) % 2 === 1) ids.push(i);
  }
  return ids;
}

export function maskFromIds(ids: number[]): number {
  return ids.reduce((mask, id) => mask + 2 ** id, 0);
}

export function maskHas(mask: number, id: number): boolean {
  return Math.floor(mask / 2 ** id) % 2 === 1;
}

export function toggleBit(mask: number, id: number): number {
  return maskHas(mask, id) ? mask - 2 ** id : mask + 2 ** id;
}

export function popcount(mask: number): number {
  return idsFromMask(mask).length;
}

export const PRIORITY_LABELS: Record<number, string> = {
  0x40: "低",
  0x4000: "低于正常",
  0x20: "正常",
  0x8000: "高于正常",
  0x80: "高",
  0x100: "实时",
};

export type CcdKind = "all" | "vcache" | "freq" | "mixed" | "none";

/** Classify a process affinity mask into how many hardware threads it spans and
 *  which CCD(s) — so the user can see CCD usage at a glance. */
export function classifyCcd(mask: number, topo: CpuTopology | null): { count: number; kind: CcdKind } {
  const ids = idsFromMask(mask);
  const count = ids.length;
  if (count === 0) return { count: 0, kind: "none" };
  if (!topo || count >= topo.logicalCount) return { count, kind: "all" };
  const vmap = new Map(topo.logical.map((l) => [l.id, l.isVcache]));
  let v = 0;
  let f = 0;
  for (const id of ids) {
    if (vmap.get(id)) v += 1;
    else f += 1;
  }
  if (v > 0 && f === 0) return { count, kind: "vcache" };
  if (f > 0 && v === 0) return { count, kind: "freq" };
  return { count, kind: "mixed" };
}
