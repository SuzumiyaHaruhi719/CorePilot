import type { ProcInfo } from "../../lib/ipc";
import type { SortKey } from "../cores/ProcessTable";

/**
 * Task-Manager process grouping.
 *
 * Windows Task Manager collapses every instance of the same application under a
 * single expandable row that shows the aggregated CPU / GPU / memory / power.
 * We mirror that: processes are grouped by a stable application key, the parent
 * row carries the summed metrics, and the children are revealed on expand.
 *
 * Grouping key: the friendly file description ("Google Chrome") when present —
 * this is exactly the app name Task Manager labels the group with — otherwise
 * the executable name ("msedgewebview2.exe"). Keying on the description means
 * the dozens of `chrome.exe` / `msedgewebview2.exe` instances collapse into one
 * row even though they are separate process trees, matching Task Manager.
 */

/** An application group: one or more processes sharing an app key. */
export interface ProcGroup {
  /** Stable key for this group (description or exe name); used as React key. */
  key: string;
  /** Display label for the parent row (the app's friendly name). */
  label: string;
  /** Member processes (already sorted within the group). */
  members: ProcInfo[];
  /** Aggregated metrics — the sum across all members. */
  cpu: number;
  gpu: number;
  mem: number;
  power: number;
  threads: number;
  /**
   * Representative exe path for the group icon (the members share one binary in
   * the common case). `null` when no member exposed a path.
   */
  exePath: string | null;
  /** True when the group has more than one member (renders a chevron). */
  isGroup: boolean;
}

/** App key for a process: friendly description, else exe name (lowercased). */
function appKey(p: ProcInfo): string {
  const desc = p.description?.trim();
  if (desc) return `d:${desc.toLowerCase()}`;
  return `n:${p.name.toLowerCase()}`;
}

/** Human label for a group, taken from the first member. */
function appLabel(p: ProcInfo): string {
  return p.description?.trim() || p.name;
}

/** The numeric field a sort key compares; `name` has no numeric field. */
function metric(p: ProcInfo, key: SortKey): number {
  switch (key) {
    case "cpu":
      return p.cpu;
    case "gpu":
      return p.gpu;
    case "mem":
      return p.mem;
    case "power":
      return p.power;
    case "threads":
      return p.threads;
    default:
      return 0;
  }
}

/** Compare two processes by the active sort key + direction (for within-group order). */
function compareProc(a: ProcInfo, b: ProcInfo, key: SortKey, dir: "asc" | "desc"): number {
  const r = key === "name" ? a.name.localeCompare(b.name) : metric(a, key) - metric(b, key);
  return dir === "asc" ? r : -r;
}

/** Aggregate value for a group under the active sort key (drives group ordering). */
function groupMetric(g: ProcGroup, key: SortKey): number {
  switch (key) {
    case "cpu":
      return g.cpu;
    case "gpu":
      return g.gpu;
    case "mem":
      return g.mem;
    case "power":
      return g.power;
    case "threads":
      return g.threads;
    default:
      return 0;
  }
}

/**
 * Build sorted application groups from a flat process list.
 *
 * Members are summed into the parent's aggregate metrics, members are ordered by
 * the active sort key, and the groups themselves are ordered by the same key on
 * their aggregate (by `label` for the `name` key). Pure — returns fresh objects.
 */
export function buildProcGroups(
  processes: readonly ProcInfo[],
  sortKey: SortKey,
  sortDir: "asc" | "desc",
): ProcGroup[] {
  const byKey = new Map<string, ProcInfo[]>();
  for (const p of processes) {
    const key = appKey(p);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(p);
    else byKey.set(key, [p]);
  }

  const groups: ProcGroup[] = [];
  for (const [key, rawMembers] of byKey) {
    const members = [...rawMembers].sort((a, b) => compareProc(a, b, sortKey, sortDir));
    const cpu = members.reduce((s, p) => s + p.cpu, 0);
    const gpu = members.reduce((s, p) => s + p.gpu, 0);
    const mem = members.reduce((s, p) => s + p.mem, 0);
    const power = members.reduce((s, p) => s + p.power, 0);
    const threads = members.reduce((s, p) => s + p.threads, 0);
    const exePath = members.find((p) => p.exePath)?.exePath ?? null;
    groups.push({
      key,
      label: appLabel(members[0]),
      members,
      cpu,
      gpu,
      mem,
      power,
      threads,
      exePath,
      isGroup: members.length > 1,
    });
  }

  groups.sort((a, b) => {
    const r =
      sortKey === "name"
        ? a.label.localeCompare(b.label)
        : groupMetric(a, sortKey) - groupMetric(b, sortKey);
    return sortDir === "asc" ? r : -r;
  });

  return groups;
}
