import { describe, expect, it } from "vitest";
import {
  INTRO_MS,
  chooseIntro,
  markIntroPlayed,
  markShellRevealed,
  readIntroMode,
  readMotionPaused,
  shouldRevealShell,
  writeMotionPaused,
} from "./brand";

describe("brand intro decision", () => {
  it("plays the full intro on a first visit and a short reveal for a returning visitor", () => {
    expect(chooseIntro({ reducedMotion: false, seenBefore: false, playedThisSession: false })).toBe("full");
    expect(chooseIntro({ reducedMotion: false, seenBefore: true, playedThisSession: false })).toBe("short");
  });

  it("never replays within a session and never plays under reduced motion", () => {
    expect(chooseIntro({ reducedMotion: false, seenBefore: true, playedThisSession: true })).toBe("none");
    for (const seenBefore of [false, true]) {
      for (const playedThisSession of [false, true]) {
        expect(chooseIntro({ reducedMotion: true, seenBefore, playedThisSession })).toBe("none");
      }
    }
  });

  it("keeps the full intro near five seconds and the short one well under two", () => {
    expect(INTRO_MS.full).toBeGreaterThanOrEqual(4000);
    expect(INTRO_MS.full).toBeLessThanOrEqual(6000);
    expect(INTRO_MS.short).toBeLessThan(2000);
    expect(INTRO_MS.none).toBe(0);
  });

  // In Node there is no localStorage/sessionStorage: this exercises the in-memory fallback
  // used when storage is blocked, which must still stop replays within the page.
  it("records a played intro so the next mount (a route change) does not replay it", () => {
    expect(readIntroMode(true)).toBe("none");
    expect(readIntroMode(false)).toBe("full");
    markIntroPlayed();
    expect(readIntroMode(false)).toBe("none");
  });

  it("reveals the sidebar mark once per session", () => {
    expect(shouldRevealShell(true)).toBe(false);
    expect(shouldRevealShell(false)).toBe(true);
    markShellRevealed();
    expect(shouldRevealShell(false)).toBe(false);
  });

  it("remembers that ambient motion was paused", () => {
    expect(readMotionPaused()).toBe(false);
    writeMotionPaused(true);
    expect(readMotionPaused()).toBe(true);
    writeMotionPaused(false);
    expect(readMotionPaused()).toBe(false);
  });
});
