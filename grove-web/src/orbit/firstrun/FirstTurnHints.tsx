import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useOrbitInterface } from "../ui/interfaceContext";
import { findHintAnchor, snapshot, TURN_HINTS, turnFinished, visibleBar, type TurnHint } from "./hintsModel";
import { hasSeen, markSeen, TURN_HINTS_SEEN_KEY } from "./storage";
import "../tokens.css";
import "./hints.css";

/** How often the workspace toolbar is checked for a turn finishing. */
const POLL_MS = 700;
/** Let the finished turn settle on screen before the first bubble appears. */
const SHOW_DELAY_MS = 600;

/**
 * After the user's first finished turn in an Orbit task, two one-time bubbles
 * point at the toolbar's Review and Notes buttons. Shown once per browser
 * (marked seen as soon as the first appears); Skip or Esc ends both.
 */
export function FirstTurnHints() {
  const orbit = useOrbitInterface();
  const [seen, setSeen] = useState(() => hasSeen(TURN_HINTS_SEEN_KEY));
  const [steps, setSteps] = useState<TurnHint[] | null>(null);
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);

  // Watch for the first finished turn. Polling a few cheap selectors keeps
  // this out of the chat's render path (and out of TaskChat entirely).
  useEffect(() => {
    if (!orbit || seen || steps) return;
    let previous = snapshot(visibleBar());
    let showTimer: number | undefined;
    const timer = window.setInterval(() => {
      const bar = visibleBar();
      const current = snapshot(bar);
      if (bar && turnFinished(previous, current)) {
        const found = TURN_HINTS.filter((hint) => findHintAnchor(bar, hint));
        if (found.length > 0) {
          window.clearInterval(timer);
          showTimer = window.setTimeout(() => {
            markSeen(TURN_HINTS_SEEN_KEY);
            setIndex(0);
            setSteps(found);
          }, SHOW_DELAY_MS);
        }
      }
      previous = current;
    }, POLL_MS);
    return () => { window.clearInterval(timer); window.clearTimeout(showTimer); };
  }, [orbit, seen, steps]);

  const hint = steps?.[index] ?? null;

  // Track the anchor; close if it goes away (task closed, panel removed).
  useEffect(() => {
    if (!hint) return;
    const place = () => {
      const bar = visibleBar();
      const anchor = bar ? findHintAnchor(bar, hint) : null;
      if (!anchor) { setSteps(null); setSeen(true); return; }
      const next = anchor.getBoundingClientRect();
      setRect((prev) => prev && prev.left === next.left && prev.top === next.top && prev.width === next.width ? prev : next);
    };
    place();
    const timer = window.setInterval(place, 250);
    window.addEventListener("resize", place);
    return () => { window.clearInterval(timer); window.removeEventListener("resize", place); };
  }, [hint]);

  useEffect(() => {
    if (!hint) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setSteps(null); setSeen(true); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hint]);

  if (!hint || !rect || !steps) return null;
  const finish = () => { setSteps(null); setSeen(true); };
  const last = index === steps.length - 1;
  const width = 290;
  const margin = 12;
  const centre = rect.left + rect.width / 2;
  const left = Math.max(margin, Math.min(centre - width / 2, window.innerWidth - width - margin));
  const arrow = Math.max(14, Math.min(centre - left - 6, width - 26));

  return createPortal(
    <div className="orbit-ui">
      <span
        className="oth-ring"
        aria-hidden="true"
        style={{ left: rect.left - 3, top: rect.top - 3, width: rect.width + 6, height: rect.height + 6 }}
      />
      <div
        key={hint.tool}
        className="oth-pop"
        role="dialog"
        aria-label="Tip"
        style={{ left, top: rect.bottom + 12, width, ["--arrow" as string]: `${arrow}px` }}
      >
        <b>{hint.title}</b>
        <p>{hint.body}</p>
        <div className="oth-row">
          <small>{steps.length > 1 ? `${index + 1} of ${steps.length}` : "Tip"}</small>
          {!last && <button type="button" className="oth-btn is-ghost" onClick={finish}>Skip</button>}
          <button type="button" className="oth-btn" onClick={() => (last ? finish() : setIndex(index + 1))}>
            {last ? "Got it" : "Next"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
