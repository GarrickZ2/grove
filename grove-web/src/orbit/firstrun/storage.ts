/* Per-browser flags behind the first-run experience. Everything here is a
   convenience: storage that throws or comes back empty only means a first-run
   element shows (or the Orbit look is used), never that the app breaks. */

/** Last interface the config reported, so screens drawn before the config loads (sign-in, splash) can match it. */
export const INTERFACE_KEY = "grove:interface";
/** The first-launch animation has played (or been skipped) on this install. */
export const LAUNCH_SEEN_KEY = "grove:firstrun.launch";
/** The Review / Notes hint bubbles after the first finished turn have been shown. */
export const TURN_HINTS_SEEN_KEY = "grove:firstrun.turn-hints";
/** A first message was sent from the New page; starter prompts stop showing. */
export const STARTERS_DONE_KEY = "grove:firstrun.starters";
/** Written by the app shell on every launch; its presence means Grove ran here before. */
const PRIOR_SESSION_KEY = "grove:navigation";

function read(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

function write(key: string, value: string): void {
  try { window.localStorage.setItem(key, value); } catch { /* per-viewer convenience only */ }
}

export function hasSeen(key: string): boolean {
  return read(key) === "1";
}

export function markSeen(key: string): void {
  write(key, "1");
}

/** With nothing remembered (new browser, cleared storage) this is Orbit, the default for new installs. */
export function readCachedOrbit(): boolean {
  return read(INTERFACE_KEY) !== "workbench";
}

export function writeCachedInterface(value: "orbit" | "workbench"): void {
  if (read(INTERFACE_KEY) !== value) write(INTERFACE_KEY, value);
}

/**
 * Whether Grove had already run in this browser profile when the page loaded.
 * Captured once, before the shell writes its navigation state, so an install
 * that predates the first-launch animation never gets it on upgrade.
 */
const priorSession = typeof window !== "undefined" && read(PRIOR_SESSION_KEY) !== null;

export function ranBefore(): boolean {
  return priorSession;
}

/**
 * The first-launch animation plays once per install: never after it was seen,
 * and never for an install that was already in use before it existed (that
 * install is marked seen on the spot).
 */
let launchClaim: boolean | null = null;

export function claimFirstLaunch(): boolean {
  // Memoized so a double render (StrictMode) can't claim it and then lose it.
  if (launchClaim === null) {
    launchClaim = !hasSeen(LAUNCH_SEEN_KEY) && !ranBefore();
    markSeen(LAUNCH_SEEN_KEY);
  }
  return launchClaim;
}
