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

/** Backend cluster kinds, plus the synthetic spans used for affinity masks. */
export type CcdKind = "all" | "vcache" | "freq" | "standard" | "pcore" | "ecore" | "mixed" | "none";

interface ClusterLike {
  ccdId: number;
  kind: string;
  label: string;
}

/** True when this CPU actually has a distinct 3D V-Cache CCD. On non-X3D AMD,
 *  Intel, or single-cluster CPUs this is false, and the V-Cache / 频率 labels
 *  must not be used (they'd be misleading). */
export function hasVcache(topo: CpuTopology | null): boolean {
  return !!topo && topo.vcacheCcd != null;
}

/** Human display name for a CPU cluster, generalized across hardware:
 *  Intel P/E → "性能核"/"能效核"; multi-CCD → "CCD N"; single cluster → "全部核心". */
export function clusterName(topo: CpuTopology | null, ccd: ClusterLike): string {
  if (ccd.kind === "pcore" || ccd.kind === "ecore") return ccd.label;
  if (!topo || topo.ccds.length <= 1) return "全部核心";
  return `CCD${ccd.ccdId}`;
}

/** Contrast tag shown beside the name on X3D parts; empty on other hardware. */
export function clusterTag(ccd: ClusterLike): string {
  if (ccd.kind === "vcache") return "3D V-Cache";
  if (ccd.kind === "freq") return "频率核心";
  return "";
}

export type ClusterTone = "vcache" | "freq" | "neutral";

/** Coarse color family for a cluster: performance clusters (V-Cache, P-cores)
 *  share the teal tone; secondary clusters (frequency CCD, E-cores) the amber
 *  tone; anything else is neutral. */
export function clusterTone(kind: string): ClusterTone {
  if (kind === "vcache" || kind === "pcore") return "vcache";
  if (kind === "freq" || kind === "ecore") return "freq";
  return "neutral";
}

/** Classify a process affinity mask: how many hardware threads it spans and
 *  which cluster — trusting the backend's per-cluster `kind` so it's correct on
 *  AMD V-Cache, Intel P/E, and homogeneous CPUs alike. */
export function classifyCcd(
  mask: number,
  topo: CpuTopology | null,
): { count: number; kind: CcdKind; ccdId: number | null } {
  const ids = idsFromMask(mask);
  const count = ids.length;
  if (count === 0) return { count: 0, kind: "none", ccdId: null };
  if (!topo || count >= topo.logicalCount) return { count, kind: "all", ccdId: null };

  // Which cluster(s) does the mask touch?
  const ccdOf = new Map(topo.logical.map((l) => [l.id, l.ccdId]));
  const touched = new Set<number>();
  for (const id of ids) {
    const c = ccdOf.get(id);
    if (c !== undefined) touched.add(c);
  }
  if (touched.size !== 1) return { count, kind: "mixed", ccdId: null };

  const ccdId = [...touched][0];
  const ccd = topo.ccds.find((c) => c.ccdId === ccdId);
  return { count, kind: (ccd?.kind as CcdKind) ?? "standard", ccdId };
}
