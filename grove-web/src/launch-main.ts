import { invoke } from "@tauri-apps/api/core";
import { playLaunchSound, type LaunchSound } from "./launch/launchSound";
import { applyLaunchLook, loadLaunchLook } from "./launch/launchTheme";
import "./launch/launch.css";

/**
 * The desktop app's launch window: the Grove mark floats over the desktop on a
 * swelling hum, then hands over to the main window (which the shell keeps
 * hidden until `launch_reveal`). Click, Esc, Enter or Space skips it.
 */

/** Seconds into the hum where the mark resolves (matches the CSS timeline). */
const BLOOM_S = 1.4;
/** The main window takes over here. */
const REVEAL_AT_MS = 3300;
/** Reduced motion: a static fade in, a short hold, and out (no sound). */
const REDUCED_REVEAL_AT_MS = 1200;

const stage = document.querySelector<HTMLElement>(".gl-stage")!;
const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let sound: LaunchSound | null = null;
let revealed = false;

function reveal(skipped: boolean) {
  if (revealed) return;
  revealed = true;
  window.clearTimeout(timer);
  // A skip cuts the hum; a natural end lets its tail ring out.
  if (skipped) sound?.stop();
  stage.classList.remove("is-playing");
  stage.classList.add("is-leaving");
  void invoke("launch_reveal").catch(() => {});
}

let timer = 0;

// Match the user's theme (light/dark, colors) and application icon before starting.
void loadLaunchLook().then((look) => {
  if (revealed) return;
  applyLaunchLook(look, stage);
  if (reduced) stage.classList.add("is-reduced");
  stage.classList.add("is-playing");
  if (!reduced) sound = playLaunchSound(BLOOM_S);
  timer = window.setTimeout(() => reveal(false), reduced ? REDUCED_REVEAL_AT_MS : REVEAL_AT_MS);
});

window.addEventListener("pointerdown", () => reveal(true));
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" || event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    reveal(true);
  }
});
