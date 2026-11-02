import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { nextRailIndex, railPlainText, railPreviewTop, railTickState, railToolSummary, type RailTurn } from "./turnRail";

const HIDE_DELAY_MS = 180;

/**
 * Orbit's conversation rail: one short line per turn in the left gutter.
 * Hover or focus a line to preview that turn's prompt and reply; click (or
 * Enter) jumps to it. The reader's current turn is drawn longer and in ink;
 * a running turn is the accent. Arrow keys move between lines.
 */
function OrbitTurnRailImpl<T extends RailTurn>({
  turns,
  activeMessageIndex,
  onNavigate,
}: {
  turns: T[];
  activeMessageIndex: number | null;
  onNavigate: (turn: T) => void;
}) {
  const navRef = useRef<HTMLElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  // Store the index, not the turn: a streaming turn's preview stays current.
  const [preview, setPreview] = useState<{ messageIndex: number; anchor: DOMRect } | null>(null);
  const [previewTop, setPreviewTop] = useState<number | null>(null);
  const [isScrollable, setIsScrollable] = useState(false);

  const clearHide = useCallback(() => {
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);
  const show = useCallback((messageIndex: number, element: HTMLElement) => {
    clearHide();
    setPreview({ messageIndex, anchor: element.getBoundingClientRect() });
  }, [clearHide]);
  const scheduleHide = useCallback(() => {
    clearHide();
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null;
      setPreview(null);
      setPreviewTop(null);
    }, HIDE_DELAY_MS);
  }, [clearHide]);
  useEffect(() => clearHide, [clearHide]);

  // Edge fades only once the rail actually overflows its max height.
  useEffect(() => {
    const element = navRef.current;
    if (element) setIsScrollable(element.scrollHeight > element.clientHeight + 1);
  }, [turns.length]);

  // Keep the reader's turn in view as they scroll a long conversation.
  useEffect(() => {
    const element = navRef.current;
    if (!element || activeMessageIndex === null) return;
    const active = element.querySelector<HTMLElement>('[data-state="active"]');
    if (!active) return;
    const top = active.offsetTop;
    const bottom = top + active.offsetHeight;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (bottom > element.scrollTop + element.clientHeight) element.scrollTop = bottom - element.clientHeight;
  }, [activeMessageIndex]);

  // Center the preview on its line once its height is known.
  useLayoutEffect(() => {
    if (!preview || !previewRef.current) return;
    const center = preview.anchor.top + preview.anchor.height / 2;
    setPreviewTop(railPreviewTop(center, previewRef.current.offsetHeight, window.innerHeight));
  }, [preview]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const buttons = [...(navRef.current?.querySelectorAll<HTMLButtonElement>("button[data-rail-index]") ?? [])];
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (current < 0) return;
    const next = nextRailIndex(current, event.key, buttons.length);
    if (next === null) return;
    event.preventDefault();
    buttons[next]?.focus();
  };

  if (turns.length < 2) return null;

  const previewTurn = preview ? turns.find((turn) => turn.messageIndex === preview.messageIndex) : undefined;
  const previewNumber = previewTurn ? turns.indexOf(previewTurn) + 1 : 0;

  return (
    <>
      <nav
        ref={navRef}
        aria-label="Conversation turns"
        className={`ocv-rail conversation-minimap-scroll${isScrollable ? " conversation-minimap-fade" : ""}`}
        onKeyDown={onKeyDown}
      >
        {turns.map((turn, index) => {
          const state = railTickState(turn, activeMessageIndex);
          return (
            <button
              key={turn.messageIndex}
              type="button"
              className="ocv-tick"
              data-rail-index={index}
              data-state={state}
              aria-current={turn.messageIndex === activeMessageIndex ? "location" : undefined}
              aria-label={`Turn ${index + 1} of ${turns.length}: ${turn.user}`}
              onMouseEnter={(event) => show(turn.messageIndex, event.currentTarget)}
              onFocus={(event) => show(turn.messageIndex, event.currentTarget)}
              onMouseLeave={scheduleHide}
              onBlur={scheduleHide}
              onClick={() => {
                clearHide();
                setPreview(null);
                setPreviewTop(null);
                onNavigate(turn);
              }}
            >
              <i aria-hidden="true" />
            </button>
          );
        })}
      </nav>
      {preview && previewTurn && typeof document !== "undefined" && createPortal(
        <div
          ref={previewRef}
          role="tooltip"
          className={`ocv-rail-preview${previewTop === null ? " is-measuring" : ""}`}
          style={{
            left: Math.min(preview.anchor.right + 12, window.innerWidth - 352),
            top: previewTop ?? preview.anchor.top,
          }}
        >
          <div className="ocv-rail-preview-head">
            <span>Turn {previewNumber} of {turns.length}</span>
            {previewTurn.isStreaming && <span className="ocv-rail-preview-live"><i aria-hidden="true" />Responding</span>}
          </div>
          <p className="ocv-rail-preview-user">{previewTurn.user}</p>
          <p className="ocv-rail-preview-reply">
            {railPlainText(previewTurn.assistant) || (previewTurn.isStreaming ? "Working…" : "No reply")}
          </p>
          {previewTurn.tools.length > 0 && (
            <div className="ocv-rail-preview-tools">{railToolSummary(previewTurn.tools)}</div>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}

export const OrbitTurnRail = memo(OrbitTurnRailImpl) as typeof OrbitTurnRailImpl;
