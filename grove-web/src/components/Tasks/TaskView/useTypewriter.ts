import { useEffect, useRef, useState } from "react";

/**
 * Reveal `target` character-by-character at a smooth rate so chunked
 * WS streams feel like a typewriter rather than text appearing in stutters.
 *
 * Adaptive rate: clears the current backlog within ~`targetLatencyMs`,
 * so small chunks reveal slowly (typewriter feel) while large bursts
 * catch up quickly (don't fall hopelessly behind during fast streams).
 *
 * When `instant` is true (message complete, or non-streaming message
 * loaded from history), the full target is shown immediately.
 */
export function useTypewriter(
  target: string,
  instant: boolean,
  targetLatencyMs = 300,
): string {
  // We track only "how many chars to reveal"; the displayed string is
  // derived. This avoids storing a duplicate of `target` in state and
  // sidesteps the React lint that complains about syncing state in
  // effects.
  const [revealed, setRevealed] = useState<number>(0);
  const targetRef = useRef(target);

  // Detect a non-prefix-extension target swap during render (rather than in an
  // effect) so the slice we return THIS render already reflects the reset.
  // Without this, render N would show `newTarget.slice(0, oldRevealed)` —
  // arbitrary garbled characters — for one frame before the effect fires
  // setRevealed(0) and render N+1 corrects it.
  const prevTarget = targetRef.current;
  const isReset =
    target.length > 0 &&
    !target.startsWith(prevTarget.slice(0, Math.min(prevTarget.length, target.length)));
  const effectiveRevealed = isReset ? 0 : Math.min(revealed, target.length);

  // Sync target ref (must be in effect — refs cannot be mutated during render).
  // Reset state too so the next animation tick starts from 0 instead of the
  // stale revealed count. `isReset` is derived from `target` + `targetRef`
  // every render, so listing only `target` in deps is correct: any time
  // `isReset` could newly be true, `target` has just changed and the effect
  // re-runs.
  useEffect(() => {
    targetRef.current = target;
    if (isReset) {
      setRevealed(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  // Drive the reveal animation. If the target shrinks below the
  // currently revealed length (e.g. message replaced rather than
  // extended), the tick clamps revealed back into range so the next
  // frame starts fresh from the new content.
  useEffect(() => {
    if (instant) return;
    let cancelled = false;
    let rafId: number | null = null;
    let last = performance.now();
    const tick = () => {
      if (cancelled) return;
      const now = performance.now();
      const dt = now - last;
      last = now;
      setRevealed((cur) => {
        const t = targetRef.current;
        // Clamp into range — handles target shrinking under us.
        const safeCur = cur > t.length ? t.length : cur;
        if (safeCur >= t.length) return safeCur;
        const lag = t.length - safeCur;
        // Reveal enough chars to burn down `lag` over targetLatencyMs.
        // Floor of 1/tick keeps the typewriter feel even when lag is tiny.
        const charsPerMs = lag / targetLatencyMs;
        const toReveal = Math.max(1, Math.ceil(charsPerMs * dt));
        return Math.min(t.length, safeCur + toReveal);
      });
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [instant, targetLatencyMs]);

  // Instant mode: the caller wants the full text immediately. Otherwise
  // slice to the revealed length.
  return instant ? target : target.slice(0, effectiveRevealed);
}
