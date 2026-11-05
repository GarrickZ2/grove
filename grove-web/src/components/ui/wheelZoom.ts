/** Largest zoom change one wheel event can make: a mouse notch. */
const MAX_ZOOM_STEP = 0.15;

/**
 * Zoom factor for one wheel event. Trackpads send many tiny events, so the
 * step must follow the delta: a fixed step per event makes a pinch leap, and
 * flip direction on the small reversals every gesture contains. A pinch arrives
 * as ctrl+wheel with deltas around 1-10; ⌘+wheel sees a mouse's ~100 per notch.
 */
export function wheelZoomFactor(deltaY: number, ctrlKey: boolean): number {
  const step = -deltaY * (ctrlKey ? 0.01 : 0.0015);
  return Math.exp(Math.min(MAX_ZOOM_STEP, Math.max(-MAX_ZOOM_STEP, step)));
}
