import { useEffect, useState } from "react";

/** A phone half-folded like a book: the crease runs top to bottom. */
export interface BookFold {
  /** Where the left screen ends, in px from the viewport's left edge. */
  left: number;
  /** Width of the crease between the two screens. */
  gap: number;
}

type FoldWindow = Window & { viewport?: { segments?: readonly DOMRectReadOnly[] | null } };
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
export function readBookFold(): BookFold | null {
  const segments = foldSegments();
  if (!segments) return null;
  const [first, second] = segments;
  if (Math.abs(first.top - second.top) >= 1 || second.left < first.right) return null;
  return { left: first.right, gap: second.left - first.right };
}

export function readLaptopFold(): LaptopFold | null {
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
  segments.forEach((query) => query?.addEventListener?.("change", listener));
  posture?.addEventListener("change", onPosture);
  return () => {
    window.removeEventListener("resize", listener);
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
