import { useEffect, useState } from "react";
import { isIosClient } from "../utils/platform";
import { NATIVE_FOLD_EVENT } from "./useBookFold";

/**
 * iPhone Duo keeps an 84pt column beside its screens for the phone's own
 * status. In the iOS app the page runs full bleed, so the column is Grove's:
 * it becomes a rail of Grove's controls under the system pill. A sideways
 * iPhone's Dynamic Island side (59pt) is narrower, so it never counts. With
 * the inner screen upright the column becomes a strip across the top, the
 * pill at its right end: the header moves into it.
 */
const COLUMN_MIN_PX = 70;

/** Workspace tools portal here when the rail is up. */
export const ORBIT_DUO_RAIL_SLOT = "orbit-duo-rail-tools";

let probe: HTMLDivElement | null = null;

function insets(): { top: number; right: number; left: number } {
  if (typeof document === "undefined") return { top: 0, right: 0, left: 0 };
  if (!probe) {
    probe = document.createElement("div");
    probe.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) 0 env(safe-area-inset-left)";
    document.body.appendChild(probe);
  }
  const style = getComputedStyle(probe);
  return { top: parseFloat(style.paddingTop) || 0, right: parseFloat(style.paddingRight) || 0, left: parseFloat(style.paddingLeft) || 0 };
}

/** The right safe-area inset in px: iPhone Duo's column in the iOS app, else usually 0. */
export function rightInset(): number {
  return insets().right;
}

type DuoColumn = "right" | "left" | "top" | null;

const isDuo = () => isIosClient && !!(window as Window & { __GROVE_DUO__?: boolean }).__GROVE_DUO__;
const keyboardUp = () => document.documentElement.classList.contains("grove-keyboard-open");

function readDuoColumn(): DuoColumn {
  if (!isDuo()) return null;
  const { top, right, left } = insets();
  if (right >= COLUMN_MIN_PX) return "right";
  // The outer screen turned sideways puts the column on the left.
  if (left >= COLUMN_MIN_PX) return "left";
  if (top >= COLUMN_MIN_PX) return "top";
  return null;
}

function useDuoColumn(): DuoColumn {
  const [column, setColumn] = useState(readDuoColumn);
  useEffect(() => {
    if (!isIosClient) return;
    // The keyboard can briefly change the insets; the column itself stays.
    const update = () => { if (!keyboardUp()) setColumn(readDuoColumn()); };
    update();
    // env(safe-area-inset-*) reads 0 until the first layout, and nothing fires after it.
    // A rotation resizes the page before the insets follow: read again once they have.
    const timers = new Set<number>();
    const settle = () => {
      update();
      for (const delay of [150, 400]) {
        const timer = window.setTimeout(() => { timers.delete(timer); update(); }, delay);
        timers.add(timer);
      }
    };
    const frame = requestAnimationFrame(settle);
    window.addEventListener("resize", settle);
    window.addEventListener(NATIVE_FOLD_EVENT, settle);
    // The insets can also change on their own (the app sets them again after
    // launch): the probe's padding follows them, so its size tells.
    insets();
    const watcher = typeof ResizeObserver === "undefined" || !probe ? null : new ResizeObserver(update);
    if (watcher && probe) watcher.observe(probe, { box: "border-box" });
    return () => {
      watcher?.disconnect();
      cancelAnimationFrame(frame);
      timers.forEach((timer) => window.clearTimeout(timer));
      window.removeEventListener("resize", settle);
      window.removeEventListener(NATIVE_FOLD_EVENT, settle);
    };
  }, []);
  return column;
}

/** The column stands beside the screen: Grove's rail goes in it. */
export function useDuoRail(): boolean {
  const column = useDuoColumn();
  return column === "right" || column === "left";
}

/** Which side the rail stands on, when there is one. */
export function useDuoRailSide(): "right" | "left" | null {
  const column = useDuoColumn();
  return column === "right" || column === "left" ? column : null;
}

/** The column runs across the top: the header sits in it, left of the pill. */
export function useDuoTopStrip(): boolean {
  return useDuoColumn() === "top";
}
