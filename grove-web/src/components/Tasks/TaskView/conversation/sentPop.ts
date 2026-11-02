import { createContext, useContext, useLayoutEffect, type RefObject } from "react";
import "./sent-pop.css";

/** A sent bubble pops in only this soon after its send (ms). Older ones —
 * history, restored drafts, a chat switched back to — just appear. */
export const SENT_POP_WINDOW_MS = 5000;
/** Queued messages may wait for the running turn; their bubble pops when the
 * queue dispatches them, as long as that happens within this window. */
export const QUEUED_POP_WINDOW_MS = 10 * 60 * 1000;
/** How long a just-sent bubble may wait to be scrolled into view before it
 * simply appears. */
const VISIBLE_WAIT_MS = 700;

type Entry = { at: number; windowMs: number; state: "free" | "active" | "done" };

/**
 * Messages this browser sent, keyed by client message id. Independent of the
 * pending-input list (which the echo may replace or clear) and shared by
 * TaskChat and Buddy, whose composers and timelines are separate components.
 */
export function createSentPopRegistry(now: () => number = Date.now) {
  const entries = new Map<string, Entry>();
  const prune = (at: number) => {
    for (const [id, entry] of entries) {
      if (at - entry.at > entry.windowMs) entries.delete(id);
    }
  };
  return {
    /** Record a local send (or queueing) at the moment it happens. */
    record(id: string, options: { queued?: boolean } = {}) {
      const at = now();
      prune(at);
      entries.set(id, { at, windowMs: options.queued ? QUEUED_POP_WINDOW_MS : SENT_POP_WINDOW_MS, state: "free" });
    },
    /** A bubble for `id` mounted: may it pop? True at most once per id. */
    claim(id: string): boolean {
      const entry = entries.get(id);
      if (!entry || entry.state !== "free") return false;
      if (now() - entry.at > entry.windowMs) return false;
      entry.state = "active";
      return true;
    },
    /** The element popping for `id` went away before it was seen: let its replacement pop. */
    release(id: string) {
      const entry = entries.get(id);
      if (entry?.state === "active") entry.state = "free";
    },
    done(id: string) {
      const entry = entries.get(id);
      if (entry) entry.state = "done";
    },
  };
}

export type SentPopRegistry = ReturnType<typeof createSentPopRegistry>;

/** The app's registry. */
export const sentPops = createSentPopRegistry();

/** Orbit provides the registry; elsewhere (Workbench, phones) nothing pops. */
export const SentPopContext = createContext<SentPopRegistry | null>(null);

/** Whether `element` is on screen and clear of the composer that overlays the list's bottom. */
function inView(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.height === 0) return false;
  const pane = element.closest<HTMLElement>("[data-sent-pop-pane]");
  const paneRect = pane?.getBoundingClientRect();
  const cover = pane?.querySelector<HTMLElement>("[data-sent-pop-cover]")?.getBoundingClientRect();
  const top = paneRect ? paneRect.top : 0;
  const bottom = cover && cover.height > 0 ? cover.top : paneRect ? paneRect.bottom : window.innerHeight;
  return rect.top >= top - 1 && rect.bottom <= bottom + 1;
}

const reducedMotion = () =>
  typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Pop a just-sent bubble in once. The pop waits (hidden) until the list has
 * scrolled the bubble into view above the composer, so it is seen rather
 * than played under the composer; if that takes too long it just appears.
 * Costs one rAF loop for the sent bubble only, nothing per render or chunk.
 */
export function useSentPop(ref: RefObject<HTMLElement | null>, clientMessageId: string | undefined): void {
  const registry = useContext(SentPopContext);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!registry || !element || !clientMessageId || !registry.claim(clientMessageId)) return;
    const id = clientMessageId;
    const started = performance.now();
    let poppedAt: number | null = null;
    // `data-sent-pop` (wait / pop / done / skipped) makes the path inspectable in devtools.
    const finish = (state: "done" | "skipped" = "done") => {
      element.classList.remove("ocv-sent-wait", "ocv-sent-pop");
      element.dataset.sentPop = state;
      registry.done(id);
    };
    const pop = () => {
      poppedAt = performance.now();
      element.classList.remove("ocv-sent-wait");
      element.classList.add("ocv-sent-pop");
      element.dataset.sentPop = "pop";
      const done = () => finish();
      element.addEventListener("animationend", done, { once: true });
      element.addEventListener("animationcancel", done, { once: true });
      // Hidden tabs never fire animationend; never leave the class behind.
      window.setTimeout(done, 1200);
    };
    // Watch the sent bubble for a moment: start the pop once it is in view,
    // and if React replaces it early (the echo, a list re-render), hand the
    // pop to its replacement.
    const watch = () => {
      const now = performance.now();
      if (!element.isConnected) {
        if (poppedAt === null || now - poppedAt < 400) registry.release(id);
        return;
      }
      if (poppedAt === null) {
        if (inView(element)) pop();
        else if (now - started > VISIBLE_WAIT_MS) return;
      } else if (now - poppedAt > 400) {
        return;
      }
      requestAnimationFrame(watch);
    };
    if (reducedMotion() || inView(element)) pop();
    else {
      element.classList.add("ocv-sent-wait");
      element.dataset.sentPop = "wait";
      // rAF can be throttled (background panes); decide on a timer too, and
      // never leave the bubble invisible.
      window.setTimeout(() => {
        if (poppedAt !== null || !element.isConnected || element.dataset.sentPop !== "wait") return;
        if (inView(element)) pop();
        else finish("skipped");
      }, VISIBLE_WAIT_MS);
    }
    requestAnimationFrame(watch);
  }, [ref, clientMessageId, registry]);
}
