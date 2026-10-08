// 一键优化. Memory goes in RAMMap order (trim working sets → write the modified
// list back → purge standby, so far more becomes free), the safe reversible
// gaming tweaks that aren't on yet are applied with snapshots (they show as
// enabled on 优化 and revert one by one), and the slow disk/network steps run in
// parallel. Every step is named in the UI — the power plan and tweaks persist
// past the click, so nothing may be silent.
import { api } from "./ipc"
import { tf, useProfiles } from "./store"
import { bytes } from "./util"

export type StepId = "free" | "purge" | "temp" | "dns" | "tweaks" | "plan"
export type StepState = "idle" | "run" | "done" | "fail"
export const STEPS: { id: StepId; zh: string; en: string }[] = [
  { id: "free", zh: "释放内存", en: "Free memory" },
  { id: "purge", zh: "清理缓存", en: "Clear cache" },
  { id: "temp", zh: "清理临时文件", en: "Clean temp" },
  { id: "dns", zh: "刷新 DNS", en: "Flush DNS" },
  { id: "tweaks", zh: "推荐的游戏优化", en: "Recommended gaming tweaks" },
  { id: "plan", zh: "卓越性能电源计划", en: "Ultimate Performance plan" },
]
/** Safe, reversible, no reboot — applied by one-click when not already on. */
export const RECOMMENDED = ["game_mode_on", "game_dvr_off", "network_throttling_off", "mmcss_gaming", "foreground_boost"]
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface OneClickResult { ok: boolean; text: string; freed: number; tempFiles: number; tempBytes: number; applied: number; plan: boolean; failed: string[] }

export async function runOneClick(onStep: (id: StepId, s: StepState) => void = () => {}): Promise<OneClickResult> {
  const failed: string[] = []
  const label = (id: StepId) => { const s = STEPS.find((x) => x.id === id)!; return tf(s.zh, s.en) }
  const step = async <T,>(id: StepId, f: () => Promise<T>): Promise<T | undefined> => {
    onStep(id, "run")
    try {
      const v = await f()
      onStep(id, "done")
      return v
    } catch {
      onStep(id, "fail")
      failed.push(label(id))
      return undefined
    }
  }
  const before = await api.memory().catch(() => null)
  await step("free", api.freeWorkingSets)
  // modified → standby first, then purge: the write-back is what lets the purge free most
  await step("purge", async () => { await api.flushModified().catch(() => {}); await api.purgeStandby() })
  // measure right after the RAM steps — later steps take seconds and the trimmed
  // pages get re-faulted, which would net the delta back toward 0
  await wait(400)
  const after = await api.memory().catch(() => null)
  const freed = before && after ? Math.max(0, after.avail - before.avail) : 0
  const [temp] = await Promise.all([step("temp", api.cleanTemp), step("dns", api.flushDns)])
  const applied = await step("tweaks", async () => {
    const have = useProfiles.getState().tweaks
    let n = 0
    for (const id of RECOMMENDED) {
      if (have[id] !== undefined) continue
      const snap = await api.tweakApply(id)
      useProfiles.getState().set({ tweaks: { ...useProfiles.getState().tweaks, [id]: snap } })
      n++
    }
    return n
  })
  const plan = await step("plan", () => api.setPowerPlan("ultimate").then(() => true))
  const note = failed.length ? tf(`（${failed.join("、")}失败）`, ` (failed: ${failed.join(", ")})`) : ""
  return {
    ok: !failed.length, freed, tempFiles: temp?.files ?? 0, tempBytes: temp?.bytes ?? 0, applied: applied ?? 0, plan: plan !== undefined, failed,
    text: tf(`释放 ${bytes(freed)} 内存 · 清理 ${temp?.files ?? 0} 个临时文件（${bytes(temp?.bytes ?? 0)}）`, `Freed ${bytes(freed)} · cleaned ${temp?.files ?? 0} temp files (${bytes(temp?.bytes ?? 0)})`)
      + (applied ? tf(` · 新启用 ${applied} 项游戏优化`, ` · ${applied} gaming tweaks enabled`) : "")
      + (plan !== undefined ? tf(" · 电源计划已切换为卓越性能", " · power plan set to Ultimate Performance") : "") + note,
  }
}
