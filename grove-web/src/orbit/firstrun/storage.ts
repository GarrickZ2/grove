/* Per-browser flags behind the first-run experience. Everything here is a
   convenience: storage that throws or comes back empty only means a first-run
   element shows (or the Orbit look is used), never that the app breaks. */

/** Last interface the config reported, so screens drawn before the config loads (sign-in, splash) can match it. */
export const INTERFACE_KEY = "grove:interface";
/** The Review / Notes hint bubbles after the first finished turn have been shown. */
export const TURN_HINTS_SEEN_KEY = "grove:firstrun.turn-hints";
/** A first message was sent from the New page; starter prompts stop showing. */
export const STARTERS_DONE_KEY = "grove:firstrun.starters";
/** The Marketplace has opened by itself with its one-line intro. */
export const AGENT_INTRO_SEEN_KEY = "grove:firstrun.agent-intro";

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
