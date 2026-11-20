import { useEffect, useState } from "react";

/** A phone half-folded like a book: the crease runs top to bottom. */
export interface BookFold {
  /** Where the left screen ends, in px from the viewport's left edge. */
  left: number;
  /** Width of the crease between the two screens. */
  gap: number;
}

/**
 * What the iOS app's native shell reports from the hinge (`UIHingeInteraction`,
 * iOS 27.1+). It arrives as soon as the hinge moves, without Safari's feature
 * flags or the second-long wait on Viewport Segments. `undefined` outside the app.
 */
export interface NativeFold {
  /** `flat`: one screen, nothing to split around. `tent`: half open with the outer screen lit. */
  posture: "flat" | "book" | "laptop" | "tent";
  /** Where the first screen ends: from the left for `book`, from the top for `laptop`. */
  at: number;
  gap: number;
  /** `tent` only: degrees the page turns its board to stand upright when the app doesn't rotate. */
  turn?: number;
}

/** Fired by the native shell after it updates `window.__GROVE_FOLD__`. */
export const NATIVE_FOLD_EVENT = "grove:fold";

type FoldWindow = Window & {
  viewport?: { segments?: readonly DOMRectReadOnly[] | null };
  __GROVE_FOLD__?: NativeFold;
};

function nativeFold(): NativeFold | undefined {
  return typeof window === "undefined" ? undefined : (window as FoldWindow).__GROVE_FOLD__;
}
type FoldNavigator = Navigator & { devicePosture?: EventTarget & { type?: string } };

/** A phone half-folded like a laptop: the crease runs side to side. */
export interface LaptopFold {
  /** Where the upper screen ends, in px from the viewport's top edge. */
  top: number;
  /** Height of the crease between the two screens. */
  gap: number;
}

/** Sent by the bottom toolbar of a laptop fold, which has no header to hold the sidebar's button. */
export const ORBIT_FOLD_MENU_EVENT = "grove:orbit-fold-menu";

function foldSegments(): readonly [DOMRectReadOnly, DOMRectReadOnly] | null {
  const posture = (navigator as FoldNavigator).devicePosture?.type;
  if (posture && posture !== "folded") return null;
  const segments = (window as FoldWindow).viewport?.segments;
  return segments?.length === 2 ? [segments[0], segments[1]] : null;
}

/**
 * Reads Viewport Segments, checked against Device Posture where there is one
 * so a flat phone never counts as folded. Browsers without these APIs, Safari
 * with its feature flags off among them, read as not folded.
 */
/**
 * The app reports half open; which way the crease runs follows the window as
 * it is now, since a rotation can reach the page before the app's next report.
 */
function nativeHalfOpen(): "book" | "laptop" | null {
  const native = nativeFold();
  if (!native || (native.posture !== "book" && native.posture !== "laptop")) return null;
  return window.innerWidth > window.innerHeight ? "book" : "laptop";
}

export function readBookFold(): BookFold | null {
  const native = nativeFold();
  if (native) return nativeHalfOpen() === "book" ? { left: Math.round(window.innerWidth / 2), gap: native.gap } : null;
  const segments = foldSegments();
  if (!segments) return null;
  const [first, second] = segments;
  if (Math.abs(first.top - second.top) >= 1 || second.left < first.right) return null;
  return { left: first.right, gap: second.left - first.right };
}

export function readLaptopFold(): LaptopFold | null {
  const native = nativeFold();
  if (native) return nativeHalfOpen() === "laptop" ? { top: Math.round(window.innerHeight / 2), gap: native.gap } : null;
  const segments = foldSegments();
  if (!segments) return null;
  const [first, second] = segments;
  if (Math.abs(first.left - second.left) >= 1 || second.top < first.bottom) return null;
  return { top: first.bottom, gap: second.top - first.bottom };
}

/** Re-reads after a posture change, in case the segments' media query stays quiet. */
const SETTLE_DELAYS_MS = [300, 800, 1500, 2500];

/**
 * Calls back as the phone folds, flattens or rotates. Returns the unsubscribe.
 *
 * On iPhone Duo the posture changes first and the segments follow over a
 * second later with no event of their own (seen on iOS 27.2, in an installed
 * web app): reading them on the posture event gets the old ones. The media
 * query below changes with the segments, and the delayed reads back it up.
 */
export function onFoldChange(listener: () => void): () => void {
  const posture = (navigator as FoldNavigator).devicePosture;
  const segments = [
    window.matchMedia?.("(horizontal-viewport-segments: 2)"),
    window.matchMedia?.("(vertical-viewport-segments: 2)"),
  ];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const onPosture = () => {
    listener();
    for (const delay of SETTLE_DELAYS_MS) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        listener();
      }, delay);
      timers.add(timer);
    }
  };
  window.addEventListener("resize", listener);
  window.addEventListener(NATIVE_FOLD_EVENT, listener);
  segments.forEach((query) => query?.addEventListener?.("change", listener));
  posture?.addEventListener("change", onPosture);
  return () => {
    window.removeEventListener("resize", listener);
    window.removeEventListener(NATIVE_FOLD_EVENT, listener);
    segments.forEach((query) => query?.removeEventListener?.("change", listener));
    posture?.removeEventListener("change", onPosture);
    timers.forEach(clearTimeout);
  };
}

function useFold<T extends object>(read: () => T | null): T | null {
  const [fold, setFold] = useState(read);

  useEffect(() => {
    const update = () => {
      const next = read();
      setFold((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    update();
    return onFoldChange(update);
  }, [read]);

  return fold;
}

export function useBookFold(): BookFold | null {
  return useFold(readBookFold);
}

export function useLaptopFold(): LaptopFold | null {
  return useFold(readLaptopFold);
}

/** Half open and stood on a table, the outer screen facing out. Only the iOS app can tell. */
// Only the outer screen stands as a tent: on the inner screen a stale value never counts.
export function readTentFold(): boolean {
  return nativeFold()?.posture === "tent" && Math.max(window.innerWidth, window.innerHeight) < 800;
}

const readTentObject = () => (readTentFold() ? { turn: nativeFold()?.turn ?? 0 } : null);

/** Whether the tent board shows, and the quarter turn it needs, if any. */
export function useTent(): { turn: number } | null {
  return useFold(readTentObject);
}

export function useTentFold(): boolean {
  return !!useTent();
}
