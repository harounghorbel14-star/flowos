/**
 * When the brand intro plays. The full intro (about five seconds) is for a first visit in this
 * browser; a returning visitor gets a short reveal; nothing replays within a browser session or
 * under reduced motion. The intro never gates anything: the sign-in form works from the start.
 */
export type IntroMode = "full" | "short" | "none";

export const INTRO_MS: Record<IntroMode, number> = { full: 5000, short: 1400, none: 0 };
/** Time scale for the CSS choreography (keyframe delays are written for the full intro). */
export const INTRO_SCALE: Record<IntroMode, number> = { full: 1, short: 0.28, none: 0 };

export function chooseIntro(state: {
  reducedMotion: boolean;
  seenBefore: boolean;
  playedThisSession: boolean;
}): IntroMode {
  if (state.reducedMotion || state.playedThisSession) return "none";
  return state.seenBefore ? "short" : "full";
}

const SEEN_KEY = "flowos.intro.seen"; // localStorage: this browser has seen the intro
const PLAYED_KEY = "flowos.intro.played"; // sessionStorage: it already ran in this session
const SHELL_KEY = "flowos.shell.revealed"; // sessionStorage: the sidebar mark already converged
const MOTION_KEY = "flowos.motion.paused"; // localStorage: ambient brand motion paused by the user

/** Fallbacks for when storage is unavailable (private modes, blocked cookies). */
const memory = new Map<string, string>();

function read(storage: "local" | "session", key: string): string | null {
  try {
    const value = (storage === "local" ? localStorage : sessionStorage).getItem(key);
    if (value !== null) return value;
  } catch {
    /* fall through to memory */
  }
  return memory.get(`${storage}:${key}`) ?? null;
}

function write(storage: "local" | "session", key: string, value: string | null): void {
  if (value === null) memory.delete(`${storage}:${key}`);
  else memory.set(`${storage}:${key}`, value);
  try {
    const s = storage === "local" ? localStorage : sessionStorage;
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
  } catch {
    /* memory holds it for this page */
  }
}

export function readIntroMode(reducedMotion: boolean): IntroMode {
  return chooseIntro({
    reducedMotion,
    seenBefore: read("local", SEEN_KEY) === "1",
    playedThisSession: read("session", PLAYED_KEY) === "1",
  });
}

/** Called once the intro starts, so a route change or reload in this session never replays it. */
export function markIntroPlayed(): void {
  write("session", PLAYED_KEY, "1");
  write("local", SEEN_KEY, "1");
}

/** True the first time the app shell mounts in a session (its mark plays a compact reveal). */
export function shouldRevealShell(reducedMotion: boolean): boolean {
  return !reducedMotion && read("session", SHELL_KEY) !== "1";
}

export function markShellRevealed(): void {
  write("session", SHELL_KEY, "1");
}

export function readMotionPaused(): boolean {
  return read("local", MOTION_KEY) === "1";
}

export function writeMotionPaused(paused: boolean): void {
  write("local", MOTION_KEY, paused ? "1" : null);
}
