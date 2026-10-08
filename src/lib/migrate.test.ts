import { expect, test, vi } from "vitest"

vi.mock("./ipc", () => ({ api: { persistGet: vi.fn(async () => null), persistSet: vi.fn(async () => {}) } }))
vi.stubGlobal("addEventListener", () => {})

test("settings v1 → v2 keeps user choices and converts the OSD", async () => {
  const { migrateSettings } = await import("./store")
  const v1 = { lang: "en", theme: "dark", accent: "ember", osd: { mode: "inject", corner: 3, rows: { fps: true, cpu: true, net: false }, targets: ["a.exe"] }, taskbar: { enabled: true, themeCpu: "#ff8a3d" } }
  const s = migrateSettings(v1, 1)
  expect(s.lang).toBe("en")
  expect(s.style).toBe("graphite") // ember accent → graphite style
  expect(s.osd.position).toBe("br")
  expect(s.osd.mode).toBe("inject")
  expect(s.osd.targets).toEqual(["a.exe"])
  expect(s.osd.metrics).toEqual(["fps", "fps.low1", "cpu.util", "cpu.temp"])
  expect("rows" in s.osd || "corner" in s.osd || "theme" in s).toBe(false)
  expect(s.taskbar.enabled).toBe(true)
  expect(s.taskbar.themeCpu).toBe("") // follows the theme now
})

test("settings v2 → v3 roomier plate spacing only replaces the old defaults", async () => {
  const { migrateSettings } = await import("./store")
  const old = migrateSettings({ lang: "zh", taskbar: { enabled: true, itemSpace: 14, innerSpace: 6, padding: 2, size: 11 } }, 2)
  expect(old.taskbar).toMatchObject({ enabled: true, itemSpace: 22, innerSpace: 10, padding: 3, size: 11 })
  const custom = migrateSettings({ taskbar: { itemSpace: 30, innerSpace: 6, padding: 2 } }, 2)
  expect(custom.taskbar).toMatchObject({ itemSpace: 30, innerSpace: 6, padding: 2 })
})

test("profiles v1 → v2 buckets rules into groups without losing any exe", async () => {
  const { migrateProfiles } = await import("./store")
  const v1 = { rules: [
    { exe: "a.exe", mask: "255", priority: 32768, on: true },
    { exe: "b.exe", mask: "255", priority: 32768, on: true },
    { exe: "c.exe", mask: "65280", priority: null, on: false },
  ], fans: { x: 1 } }
  const p = migrateProfiles(v1, 1)
  expect(p.groups.map((g) => g.patterns)).toEqual([["a.exe", "b.exe"], ["c.exe"]])
  expect(p.groups[0].mask).toBe("255")
  expect(p.optimizeOnStartup).toBe(true)
  expect(p.legacy2).toBe(false)
  expect((p as unknown as { fans: unknown }).fans).toEqual({ x: 1 })
  expect("rules" in p).toBe(false)
})
