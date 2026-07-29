import { describe, expect, it } from "vitest";
import { CHECK_INTERVAL_MS, shouldAutoCheck, shouldPrompt, type PromptContext } from "./useUpdateCheck";
import type { UpdateInfo } from "../lib/ipc";

const NOW = 1_800_000_000_000;

function info(patch: Partial<UpdateInfo> = {}): UpdateInfo {
  return {
    available: true,
    currentVersion: "0.4.0",
    latestVersion: "0.5.0",
    notes: "notes",
    pubDate: null,
    flavor: "installer",
    gameForeground: false,
    blockers: [],
    releasesUrl: "https://example.invalid",
    ...patch,
  };
}

function ctx(patch: Partial<PromptContext> = {}): PromptContext {
  return { skippedVersion: null, windowVisible: true, ...patch };
}

describe("shouldAutoCheck", () => {
  it("checks when the interval has elapsed", () => {
    expect(shouldAutoCheck({ autoCheckUpdates: true, lastUpdateCheck: 0, now: NOW })).toBe(true);
  });

  it("stays quiet inside the debounce window", () => {
    const last = NOW - CHECK_INTERVAL_MS + 1000;
    expect(shouldAutoCheck({ autoCheckUpdates: true, lastUpdateCheck: last, now: NOW })).toBe(false);
  });

  it("checks again exactly at the interval boundary", () => {
    const last = NOW - CHECK_INTERVAL_MS;
    expect(shouldAutoCheck({ autoCheckUpdates: true, lastUpdateCheck: last, now: NOW })).toBe(true);
  });

  it("never checks when the user turned auto-check off", () => {
    expect(shouldAutoCheck({ autoCheckUpdates: false, lastUpdateCheck: 0, now: NOW })).toBe(false);
  });
});

describe("shouldPrompt", () => {
  it("prompts for a newer version", () => {
    expect(shouldPrompt(info(), ctx())).toBe(true);
  });

  it("stays silent when already current", () => {
    expect(shouldPrompt(info({ available: false, latestVersion: null }), ctx())).toBe(false);
  });

  // The rule that matters most: a dialog stealing focus mid-match is the worst
  // thing this feature could do.
  it("never interrupts a running game", () => {
    expect(shouldPrompt(info({ gameForeground: true }), ctx())).toBe(false);
  });

  // Tray mode / silent autostart: a modal on a hidden window is unanswerable.
  it("does not prompt when the window is hidden", () => {
    expect(shouldPrompt(info(), ctx({ windowVisible: false }))).toBe(false);
  });

  it("respects a skipped version", () => {
    expect(shouldPrompt(info({ latestVersion: "0.5.0" }), ctx({ skippedVersion: "0.5.0" }))).toBe(false);
  });

  // Skipping means "not this one", not "never again".
  it("still prompts for a version newer than the skipped one", () => {
    expect(shouldPrompt(info({ latestVersion: "0.6.0" }), ctx({ skippedVersion: "0.5.0" }))).toBe(true);
  });
});
