import { expect, test, vi } from "vitest"

// Backend double: first write is slow, so an unchained second write would land first.
const disk: string[] = []
vi.mock("./ipc", () => ({
  api: {
    persistGet: vi.fn(async (name: string) => { if (name === "broken") throw new Error("poisoned"); return null }),
    persistSet: vi.fn(async (_name: string, value: string) => {
      await new Promise((r) => setTimeout(r, value === "v1" ? 1000 : 0))
      disk.push(value)
    }),
  },
}))
vi.stubGlobal("addEventListener", () => {})

test("same-key writes land in order; unreadable keys are never written", async () => {
  vi.useFakeTimers()
  const { backend } = await import("./store")
  const { api } = await import("./ipc")

  backend.setItem("k", "v1")
  await vi.advanceTimersByTimeAsync(300) // v1 in flight (slow)
  backend.setItem("k", "v2")
  await vi.advanceTimersByTimeAsync(300)
  await vi.runAllTimersAsync()
  expect(disk).toEqual(["v1", "v2"])

  expect(await backend.getItem("broken")).toBeNull()
  backend.setItem("broken", "defaults")
  await vi.runAllTimersAsync()
  expect(api.persistSet).not.toHaveBeenCalledWith("broken", "defaults")
})
