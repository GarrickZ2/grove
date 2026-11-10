import { invoke } from "@tauri-apps/api/core";
import { apiClient } from "./api/client";
import { playLaunchSound, type LaunchSound } from "./launch/launchSound";
import { applyLaunchLook, loadLaunchLook } from "./launch/launchTheme";
import "./launch/launch.css";

/**
 * The desktop app's launch window: the Grove mark floats over the desktop on a
 * swelling hum, then hands over to the main window (which the shell keeps
 * hidden until `launch_reveal`). Click, Esc, Enter or Space skips it.
 *
 * The window opens before the backend is ready. A start that takes a moment
 * (first run, a data update) shows the mark waiting over the step in progress,
 * and the main window takes over as soon as the backend answers.
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

/** `GET /api/v1/startup`, answered by the shell before the backend is ready. */
interface StartupStatus { step: string; ready: boolean; error: string | null; first_run: boolean }

/** A start quicker than this plays the animation as if there had been no wait. */
const WAIT_SHOWN_AFTER_MS = 400;
const POLL_MS = 250;

const statusBox = document.querySelector<HTMLElement>(".gl-status")!;
const statusStep = statusBox.querySelector<HTMLElement>(".gl-status-step")!;
const statusNote = statusBox.querySelector<HTMLElement>(".gl-status-note")!;
const quitButton = statusBox.querySelector<HTMLButtonElement>(".gl-status-quit")!;
let backendUp = false;

async function readStartup(): Promise<StartupStatus | null> {
  try {
    return await apiClient.get<StartupStatus>("/api/v1/startup");
  } catch {
    return null;
  }
}

/** Resolves once the backend is ready, with whether the wait was long enough to show. */
async function backendReady(): Promise<boolean> {
  // Remote GUI: this process only proxies, there is nothing to wait for.
  if (new URLSearchParams(window.location.search).has("remote")) return false;
  const started = performance.now();
  let shown = false;
  for (;;) {
    const status = await readStartup();
    // A question that got no answer says nothing about the backend: ask again.
    // (Should the page never hear back, the shell still brings the main window in once the backend is ready.)
    if (!status) {
      await new Promise((resolve) => window.setTimeout(resolve, POLL_MS));
      continue;
    }
    if (status.ready) return shown;
    if (status.error) {
      stage.classList.add("is-waiting");
      statusStep.textContent = "Grove could not start";
      statusNote.textContent = `${status.error} Details are in ~/.grove/gui.log.`;
      quitButton.hidden = false;
      statusBox.hidden = false;
      return new Promise(() => {});
    }
    if (performance.now() - started > WAIT_SHOWN_AFTER_MS) {
      shown = true;
      stage.classList.add("is-waiting");
      statusStep.textContent = status.step ? `${status.step}…` : "Starting Grove…";
      statusNote.textContent = status.first_run ? "The first launch takes a little longer." : "";
      statusBox.hidden = false;
    }
    await new Promise((resolve) => window.setTimeout(resolve, POLL_MS));
  }
}

quitButton.addEventListener("click", () => void invoke("launch_quit").catch(() => {}));

void backendReady().then(async (waited) => {
  backendUp = true;
  statusBox.hidden = true;
  if (waited) {
    // The mark has been on screen for the whole wait: hand over, don't replay the intro.
    stage.classList.remove("is-waiting");
    reveal(false);
    return;
  }
  // Match the user's theme (light/dark, colors) and application icon before starting.
  const look = await loadLaunchLook();
  if (revealed) return;
  applyLaunchLook(look, stage);
  if (reduced) stage.classList.add("is-reduced");
  stage.classList.add("is-playing");
  if (!reduced) sound = playLaunchSound(BLOOM_S);
  timer = window.setTimeout(() => reveal(false), reduced ? REDUCED_REVEAL_AT_MS : REVEAL_AT_MS);
});

// Nothing to skip to until the backend is ready.
window.addEventListener("pointerdown", () => { if (backendUp) reveal(true); });
window.addEventListener("keydown", (event) => {
  if (!backendUp) return;
  if (event.key === "Escape" || event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    reveal(true);
  }
});
