import { useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useReducedMotion } from "framer-motion";
import { GroveIcon } from "../../components/Layout/GroveIcon";
import { isTauriShell } from "../../utils/tauriShell";
import { OrbitInterfaceContext, OrbitInterfaceKnownContext } from "../ui/interfaceContext";
import { playLaunchSound, type LaunchSound } from "./launchSound";
import { claimFirstLaunch } from "./storage";
import "../tokens.css";
import "./launch.css";

/** Full run: the seed lands, the logo grows, the wordmark arrives, then it fades into the app. */
const LEAVE_AT_MS = 2100;
/** Reduced motion: a static fade in, a short hold, and out. */
const REDUCED_LEAVE_AT_MS = 1200;
const LEAVE_MS = 400;
/** The logo grows in after the seed has landed. */
const MARK_AT_MS = 350;

type Phase = "pending" | "playing" | "leaving" | "done";

/**
 * The desktop app's first-launch animation (Launch board). Orbit only, Tauri
 * only, once per install; click, Esc, Enter or "Skip" ends it early. It lies
 * over the app while it loads underneath, so it never delays startup.
 */
export function FirstLaunch() {
  const orbit = useContext(OrbitInterfaceContext);
  const known = useContext(OrbitInterfaceKnownContext);
  const reduced = useReducedMotion() ?? false;
  const [phase, setPhase] = useState<Phase>("pending");
  const [markShown, setMarkShown] = useState(false);
  const soundRef = useRef<LaunchSound | null>(null);
  const skipRef = useRef<HTMLButtonElement>(null);

  // Decide once the interface is known; the claim marks it seen right away.
  if (phase === "pending" && known) {
    setPhase(isTauriShell && orbit && claimFirstLaunch() ? "playing" : "done");
  }

  useEffect(() => {
    if (phase !== "playing") return;
    // Reduced motion is also the no-sound fallback.
    if (!reduced) soundRef.current = playLaunchSound();
    skipRef.current?.focus({ preventScroll: true });
    const mark = window.setTimeout(() => setMarkShown(true), reduced ? 0 : MARK_AT_MS);
    const leave = window.setTimeout(() => setPhase("leaving"), reduced ? REDUCED_LEAVE_AT_MS : LEAVE_AT_MS);
    return () => { window.clearTimeout(mark); window.clearTimeout(leave); };
  }, [phase, reduced]);

  useEffect(() => {
    if (phase !== "leaving") return;
    const done = window.setTimeout(() => setPhase("done"), LEAVE_MS);
    return () => window.clearTimeout(done);
  }, [phase]);

  useEffect(() => {
    if (phase !== "playing") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.stopPropagation();
        skip();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  useEffect(() => () => soundRef.current?.stop(), []);

  function skip() {
    soundRef.current?.stop();
    soundRef.current = null;
    setPhase("leaving");
  }

  if (phase === "pending" || phase === "done") return null;
  return createPortal(
    <div
      className={`orbit-ui ofl${phase === "leaving" ? " is-leaving" : ""}${reduced ? " is-reduced" : ""}`}
      role="presentation"
      onClick={skip}
      data-testid="first-launch"
    >
      <div className="ofl-rays" aria-hidden="true" />
      <div className="ofl-glow" aria-hidden="true" />
      <div className="ofl-seed" aria-hidden="true" />
      <div className="ofl-mark" role="img" aria-label="Grove">
        {markShown && <GroveIcon size={170} grow={!reduced} />}
      </div>
      <div className="ofl-word">
        <h1>Grove</h1>
        <p>Steer agents with context.</p>
      </div>
      <button ref={skipRef} type="button" className="ofl-skip" onClick={(event) => { event.stopPropagation(); skip(); }}>
        Skip<kbd>esc</kbd>
      </button>
    </div>,
    document.body,
  );
}
