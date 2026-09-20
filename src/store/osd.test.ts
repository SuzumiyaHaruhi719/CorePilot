import { describe, expect, it, vi } from "vitest";

// The module under test creates persisted zustand stores at import time, which
// hits the Tauri IPC through `lib/persist`. Under vitest there is no webview to
// answer, so stub the bridge — these tests only exercise the pure decision
// helpers, not persistence.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => null),
}));

const { explainOsd, resolveOsd } = await import("./osd");
type OsdCfg = import("./osd").OsdConfig;
type OsdTgt = import("./osd").OsdTarget;

function cfg(patch: Partial<OsdCfg> = {}): OsdCfg {
  return {
    enabled: true,
    style: "horizontal",
    scale: 1,
    opacity: 0.55,
    position: "tl",
    freeX: 0.04,
    freeY: 0.04,
    rounded: true,
    oledShift: false,
    desktopMode: false,
    inject: false,
    metrics: ["fps", "cpu.util"],
    ...patch,
  };
}

const white = (name: string): OsdTgt => ({ name, list: "white" });
const black = (name: string): OsdTgt => ({ name, list: "black" });

// `explainOsd` is the only thing on the OSD tab that answers the question the
// whole session started from ("the OSD disappeared — why?"). Every branch below
// is a state a real user store can be in, so a wrong verdict here sends someone
// hunting a bug that is actually a setting.
describe("explainOsd", () => {
  it("reports the exact default-store blind spot: enabled, no desktop mode, on the desktop", () => {
    // enabled=true / desktopMode=false / inject=false is the reporting user's
    // store. Nothing on the tab used to explain this case at all.
    const v = explainOsd(cfg(), [], "explorer.exe", false);
    expect(v).toMatchObject({ kind: "hidden-not-game", shown: false, treatedAsGame: false });
  });

  it("says showing on a detected game", () => {
    const v = explainOsd(cfg(), [], "cyberpunk2077.exe", true);
    expect(v.kind).toBe("shown-game");
    expect(v.shown).toBe(true);
    expect(v.treatedAsGame).toBe(true);
  });

  it("hints at injection only while showing on a game with injection off", () => {
    expect(explainOsd(cfg(), [], "game.exe", true).needsInjectHint).toBe(true);
    expect(explainOsd(cfg({ inject: true }), [], "game.exe", true).needsInjectHint).toBe(false);
    // Desktop mode on a non-game can't be hidden by exclusive fullscreen.
    expect(
      explainOsd(cfg({ desktopMode: true }), [], "explorer.exe", false).needsInjectHint,
    ).toBe(false);
  });

  it("blames the black list, not game detection, for a blacklisted app", () => {
    const v = explainOsd(cfg(), [black("obs64.exe")], "OBS64.exe", true);
    expect(v.kind).toBe("hidden-blacklist");
    expect(v.treatedAsGame).toBe(false);
  });

  it("keeps the desktop OSD alive on a blacklisted app (blacklist only governs the in-game layer)", () => {
    const v = explainOsd(cfg({ desktopMode: true }), [black("obs64.exe")], "obs64.exe", true);
    expect(v.kind).toBe("shown-desktop");
    expect(v.shown).toBe(true);
  });

  it("shows on a whitelisted non-game", () => {
    const v = explainOsd(cfg(), [white("mpv.exe")], "mpv.exe", false);
    expect(v.kind).toBe("shown-game");
    expect(v.treatedAsGame).toBe(true);
  });

  it("never claims 'showing' when both masters are off, even for a whitelisted app", () => {
    // resolveOsd alone WOULD return a config here (whitelist wins), but the
    // overlay window itself is only created while enabled || desktopMode — so a
    // naive status line would announce an overlay that does not exist.
    const off = cfg({ enabled: false, desktopMode: false });
    expect(resolveOsd(off, [white("mpv.exe")], "mpv.exe", false)).not.toBeNull();
    expect(explainOsd(off, [white("mpv.exe")], "mpv.exe", false)).toMatchObject({
      kind: "hidden-master-off",
      shown: false,
    });
  });

  it("blames the master switch when desktop mode is on but a game is in front", () => {
    // Desktop mode deliberately covers NON-game foregrounds only, so it cannot
    // rescue a game while the in-game master is off.
    const v = explainOsd(cfg({ enabled: false, desktopMode: true }), [], "game.exe", true);
    expect(v.kind).toBe("hidden-master-off");
    expect(v.shown).toBe(false);
  });

  it("matches the exe case-insensitively and survives an unresolved foreground", () => {
    expect(explainOsd(cfg(), [white("Game.EXE".toLowerCase())], "GAME.exe", false).shown).toBe(true);
    expect(explainOsd(cfg(), [], null, false)).toMatchObject({
      kind: "hidden-not-game",
      exe: null,
    });
  });

  it("hands back the per-game config so the status line names the right corner", () => {
    // The tab's editor may be showing the global default while the foreground
    // game has an override; reporting "位置 左上" for a game pinned bottom-right
    // would send the user looking at the wrong corner of their screen.
    const targets: OsdTgt[] = [{ name: "game.exe", list: "white", config: { position: "br" } }];
    expect(explainOsd(cfg({ position: "tl" }), targets, "game.exe", true).config?.position).toBe("br");
    expect(explainOsd(cfg({ position: "tl" }), [], "game.exe", true).config?.position).toBe("tl");
    expect(explainOsd(cfg(), [], "explorer.exe", false).config).toBeNull();
  });

  it("agrees with resolveOsd on every combination it classifies", () => {
    // The status line must never contradict the overlay. Brute-force the switch
    // space instead of trusting the two implementations to stay in step.
    for (const enabled of [false, true]) {
      for (const desktopMode of [false, true]) {
        for (const isGame of [false, true]) {
          for (const targets of [[], [white("a.exe")], [black("a.exe")]] as OsdTgt[][]) {
            const c = cfg({ enabled, desktopMode });
            const v = explainOsd(c, targets, "a.exe", isGame);
            const windowUp = enabled || desktopMode;
            const resolved = windowUp && resolveOsd(c, targets, "a.exe", isGame) !== null;
            expect(v.shown, JSON.stringify({ enabled, desktopMode, isGame, targets })).toBe(
              resolved,
            );
          }
        }
      }
    }
  });
});
