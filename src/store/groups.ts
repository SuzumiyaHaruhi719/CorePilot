import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { tauriStorage } from "../lib/persist";

/**
 * A process group / affinity rule. Persisted ("memory") and matched against
 * running processes by exe-name patterns. `mask` is the allowed logical-CPU set.
 */
export interface GroupRule {
  id: string;
  name: string;
  hue: number; // OKLCH hue for the group dot/badge
  mask: number; // affinity mask over logical CPUs (0 = unrestricted / all)
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

const GROUP_HUES = [274, 220, 182, 75, 12, 320, 140];

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
        const index = get().groups.length;
        const group: GroupRule = {
          id,
          name: partial?.name ?? "新建分组",
          hue: partial?.hue ?? GROUP_HUES[index % GROUP_HUES.length],
          mask: partial?.mask ?? 0,
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
    { name: "corepilot-groups", version: 1, storage: createJSONStorage(() => tauriStorage) },
  ),
);

/** Find which group claims a given exe name, if any. */
export function groupForProcess(groups: GroupRule[], exeName: string): GroupRule | undefined {
  const name = exeName.toLowerCase();
  return groups.find((g) => g.patterns.includes(name));
}
