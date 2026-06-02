import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { hueDistance, pickDistinctHue } from "../lib/colors";
import { tauriStorage } from "../lib/persist";

/**
 * Marker used to encode a `bigint` inside JSON (which has no bigint type and
 * whose `JSON.stringify` throws on one). A group's affinity `mask` is a bigint,
 * so the persist layer needs this to round-trip it through the JSON file.
 */
const BIGINT_TAG = "$bigint";

/**
 * JSON replacer handed to `createJSONStorage`: encode any `bigint` as
 * `{ "$bigint": "<decimal>" }`. Without this, persisting a `GroupRule.mask`
 * (a bigint) would make `JSON.stringify` throw.
 */
function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? { [BIGINT_TAG]: value.toString() } : value;
}

/**
 * JSON reviver handed to `createJSONStorage`: turn a
 * `{ "$bigint": "<decimal>" }` placeholder back into a real `bigint`.
 */
function bigintReviver(_key: string, value: unknown): unknown {
  if (
    value != null &&
    typeof value === "object" &&
    BIGINT_TAG in value &&
    typeof (value as Record<string, unknown>)[BIGINT_TAG] === "string"
  ) {
    return BigInt((value as Record<string, string>)[BIGINT_TAG]);
  }
  return value;
}

/** Coerce a `mask` of unknown vintage to bigint: bigint (current), number
 *  (v1/v2 persisted state, or an imported file from before bigint), or decimal
 *  string (current export format) all map cleanly; anything else falls back to
 *  `0n` (unrestricted / all cores). Exported for the import path in
 *  CoreAssignment, which reads user-supplied JSON. */
export function maskToBigInt(mask: unknown): bigint {
  if (typeof mask === "bigint") return mask;
  if (typeof mask === "number" && Number.isFinite(mask)) return BigInt(Math.trunc(mask));
  if (typeof mask === "string" && mask.trim() !== "") {
    try {
      return BigInt(mask);
    } catch {
      return 0n;
    }
  }
  return 0n;
}

/**
 * A process group / affinity rule. Persisted ("memory") and matched against
 * running processes by exe-name patterns. `mask` is the allowed logical-CPU set.
 */
export interface GroupRule {
  id: string;
  name: string;
  hue: number; // OKLCH hue for the group dot/badge
  mask: bigint; // affinity mask over logical CPUs (0n = unrestricted / all)
  priority: number; // Windows priority class value (0x20 = normal)
  patterns: string[]; // lowercased exe-name patterns this group claims
  builtin?: boolean;
}

interface GroupsState {
  groups: GroupRule[];
  selectedId: string | null;
  seeded: boolean;
  addGroup: (partial?: Partial<GroupRule>) => string;
  updateGroup: (id: string, patch: Partial<GroupRule>) => void;
  removeGroup: (id: string) => void;
  select: (id: string | null) => void;
  /** Add an exe pattern to a group (and remove it from any other group). */
  assignProcess: (groupId: string, exeName: string) => void;
  removeProcess: (exeName: string) => void;
  markSeeded: () => void;
  importGroups: (groups: GroupRule[]) => void;
}

function newId(): string {
  return crypto.randomUUID();
}

export const useGroups = create<GroupsState>()(
  persist(
    (set, get) => ({
      groups: [],
      selectedId: null,
      seeded: false,
      addGroup: (partial) => {
        const id = partial?.id ?? newId();
        const group: GroupRule = {
          id,
          name: partial?.name ?? "新建分组",
          // Auto-pick a hue distinct from existing groups so colors never collide.
          hue: partial?.hue ?? pickDistinctHue(get().groups.map((g) => g.hue)),
          mask: partial?.mask ?? 0n,
          priority: partial?.priority ?? 0x20,
          patterns: partial?.patterns ?? [],
          builtin: partial?.builtin,
        };
        set((s) => ({ groups: [...s.groups, group], selectedId: id }));
        return id;
      },
      updateGroup: (id, patch) =>
        set((s) => ({
          groups: s.groups.map((g) => (g.id === id ? { ...g, ...patch } : g)),
        })),
      removeGroup: (id) =>
        set((s) => ({
          groups: s.groups.filter((g) => g.id !== id),
          selectedId: s.selectedId === id ? null : s.selectedId,
        })),
      select: (selectedId) => set({ selectedId }),
      assignProcess: (groupId, exeName) => {
        const name = exeName.toLowerCase();
        set((s) => ({
          groups: s.groups.map((g) => {
            const patterns = g.patterns.filter((p) => p !== name);
            return g.id === groupId ? { ...g, patterns: [...patterns, name] } : { ...g, patterns };
          }),
        }));
      },
      removeProcess: (exeName) => {
        const name = exeName.toLowerCase();
        set((s) => ({
          groups: s.groups.map((g) => ({ ...g, patterns: g.patterns.filter((p) => p !== name) })),
        }));
      },
      markSeeded: () => set({ seeded: true }),
      importGroups: (groups) => set({ groups, selectedId: null }),
    }),
    {
      name: "corepilot-groups",
      version: 3,
      // `replacer`/`reviver` make the persisted JSON bigint-safe: `GroupRule.mask`
      // is a bigint, which plain `JSON.stringify` can't emit. They encode it as
      // `{"$bigint":"<dec>"}` on write and revive it on read.
      storage: createJSONStorage(() => tauriStorage, {
        replacer: bigintReplacer,
        reviver: bigintReviver,
      }),
      migrate: (persisted, version) => {
        const state = persisted as GroupsState;
        if (!state || !Array.isArray(state.groups)) return state;
        // v1 → v2: v1 assigned group hues from a fixed cycling palette, so groups
        // could share a color (e.g. the seeded 游戏 and a user group both landing
        // on 182). Give any group that collides with an earlier one a distinct hue.
        if (version < 2) {
          const seen: number[] = [];
          state.groups = state.groups.map((g) => {
            const collides = seen.some((h) => hueDistance(h, g.hue) < 12);
            const hue = collides ? pickDistinctHue(seen) : g.hue;
            seen.push(hue);
            return { ...g, hue };
          });
        }
        // → v3: masks were stored as plain numbers before bigint. Coerce every
        // persisted `mask` to bigint (numbers ≤ 2^53 round-trip exactly, so a
        // 32-logical-CPU machine sees identical masks).
        if (version < 3) {
          state.groups = state.groups.map((g) => ({
            ...g,
            mask: maskToBigInt((g as { mask: unknown }).mask),
          }));
        }
        return state;
      },
    },
  ),
);

/** Find which group claims a given exe name, if any. */
export function groupForProcess(groups: GroupRule[], exeName: string): GroupRule | undefined {
  const name = exeName.toLowerCase();
  return groups.find((g) => g.patterns.includes(name));
}
