import { useRef, useState } from "react";
import "./sidebar-resizer.css";

const WIDTH_KEY = "grove:sidebar-width";
export const SIDEBAR_DEFAULT_WIDTH = 256;
export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH = 420;
// What's left for the content, as Buddy's side panel does.
const CONTENT_MIN_WIDTH = 600;

function inRange(value: number, max = SIDEBAR_MAX_WIDTH): number {
  return Math.round(Math.max(SIDEBAR_MIN_WIDTH, Math.min(max, value)));
}

// Not bounded by the window: it may have no size yet when this runs.
function storedWidth(): number {
  try { return inRange(Number(localStorage.getItem(WIDTH_KEY)) || SIDEBAR_DEFAULT_WIDTH); } catch { return SIDEBAR_DEFAULT_WIDTH; }
}

function applyWidth(value: number): void {
  document.documentElement.style.setProperty("--orbit-sidebar-width", `${value}px`);
}

function saveWidth(value: number): void {
  try { localStorage.setItem(WIDTH_KEY, String(value)); } catch { /* per-viewer convenience only */ }
}

// Set before the first paint, so a resized sidebar doesn't jump on load.
applyWidth(storedWidth());

/** Drag handle on the sidebar's right edge. Orbit and Buddy share one width. */
export function SidebarResizer() {
  const [width, setWidth] = useState(storedWidth);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const resize = (next: number) => {
    const value = inRange(next, Math.min(SIDEBAR_MAX_WIDTH, window.innerWidth - CONTENT_MIN_WIDTH));
    setWidth(value);
    applyWidth(value);
    return value;
  };
  const endDrag = () => {
    if (!drag.current) return;
    drag.current = null;
    document.documentElement.classList.remove("is-resizing-sidebar");
    saveWidth(width);
  };
  return (
    <button
      type="button"
      role="separator"
      aria-label="Resize sidebar"
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={SIDEBAR_MAX_WIDTH}
      title="Drag to resize · double-click to reset"
      className="sidebar-resizer"
      onPointerDown={(event) => {
        drag.current = { x: event.clientX, width };
        event.currentTarget.setPointerCapture(event.pointerId);
        document.documentElement.classList.add("is-resizing-sidebar");
      }}
      onPointerMove={(event) => { if (drag.current) resize(drag.current.width + event.clientX - drag.current.x); }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => saveWidth(resize(SIDEBAR_DEFAULT_WIDTH))}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        saveWidth(resize(width + (event.key === "ArrowRight" ? 20 : -20)));
      }}
    />
  );
}
