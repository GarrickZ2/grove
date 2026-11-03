import { useRef, useState, type ReactNode } from "react";
import { MailOpen, Mail, Pin, PinOff, Trash2 } from "lucide-react";

/** Width of each trailing action button. */
const ACTION_WIDTH = 74;
/** A leading swipe past this toggles read state on release. */
const TOGGLE_DISTANCE = 72;

/**
 * A phone list row that swipes like Messages: right toggles read/unread,
 * left reveals Pin and Delete. Only one row stays open at a time (`open`).
 * Vertical scrolling stays native (`touch-action: pan-y`); the swipe takes
 * over only once the finger clearly moves sideways.
 */
export function BuddySwipeRow({ children, unread, pinned, open, onOpen, onToggleRead, onTogglePin, onDelete, blocked }: {
  children: ReactNode; unread: boolean; pinned: boolean; open: boolean; onOpen: (open: boolean) => void;
  onToggleRead: () => void; onTogglePin: () => void; onDelete: () => void;
  /** True while the row is being dragged to reorder. */
  blocked: () => boolean;
}) {
  const trailing = ACTION_WIDTH * 2;
  const start = useRef<{ x: number; y: number; base: number; id: number; locked: boolean | null } | null>(null);
  const [dx, setDx] = useState<number | null>(null);
  /** The side still uncovered while the row slides back to rest. */
  const [settling, setSettling] = useState<"leading" | "trailing" | null>(null);
  const resting = open ? -trailing : 0;
  const offset = dx ?? resting;
  /** Swallow the click that ends a swipe so it doesn't open the conversation. */
  const swiped = useRef(false);
  const end = () => {
    const current = start.current;
    start.current = null;
    if (dx === null) return;
    if (current?.locked) {
      swiped.current = true;
      window.setTimeout(() => { swiped.current = false; }, 0);
    }
    if (dx >= TOGGLE_DISTANCE) onToggleRead();
    onOpen(dx < -trailing / 2.5);
    setSettling(dx > 0 ? "leading" : dx < 0 ? "trailing" : null);
    setDx(null);
  };
  return <div className={`buddy-swipe${dx !== null ? " is-swiping" : ""}`}>
    {/* Action layers exist only while uncovered, so nothing shows through the rounded corners at rest. */}
    <div className="buddy-swipe-leading" aria-hidden={offset <= 0} style={{ opacity: Math.min(1, Math.max(0, offset) / TOGGLE_DISTANCE), visibility: offset > 0 || settling === "leading" ? "visible" : "hidden" }}>
      {unread ? <MailOpen size={20} /> : <Mail size={20} />}<span>{unread ? "Read" : "Unread"}</span>
    </div>
    <div className="buddy-swipe-trailing" style={{ width: trailing, visibility: offset < 0 || settling === "trailing" ? "visible" : "hidden" }} aria-hidden={!open && offset >= 0}>
      <button type="button" className="is-pin" tabIndex={open ? 0 : -1} onClick={() => { setSettling("trailing"); onOpen(false); onTogglePin(); }}>{pinned ? <PinOff size={19} /> : <Pin size={19} />}<span>{pinned ? "Unpin" : "Pin"}</span></button>
      <button type="button" className="is-delete" tabIndex={open ? 0 : -1} onClick={() => { setSettling("trailing"); onOpen(false); onDelete(); }}><Trash2 size={19} /><span>Delete</span></button>
    </div>
    <div className="buddy-swipe-content" style={{ transform: `translateX(${offset}px)` }} onTransitionEnd={() => setSettling(null)}
      onPointerDown={(event) => { if (event.pointerType !== "mouse") start.current = { x: event.clientX, y: event.clientY, base: resting, id: event.pointerId, locked: null }; }}
      onPointerMove={(event) => {
        const current = start.current;
        if (!current || event.pointerId !== current.id) return;
        const mx = event.clientX - current.x, my = event.clientY - current.y;
        if (current.locked === null) {
          if (blocked()) { start.current = null; return; }
          if (Math.abs(mx) < 10 && Math.abs(my) < 10) return;
          current.locked = Math.abs(mx) > Math.abs(my) * 1.2;
          if (!current.locked) { start.current = null; return; }
        }
        // Rubber-band past the actions; the leading side only goes as far as its toggle.
        const raw = current.base + mx;
        setDx(raw < -trailing ? -trailing + (raw + trailing) / 3 : Math.min(raw, TOGGLE_DISTANCE * 1.4));
      }}
      onPointerUp={end} onPointerCancel={end}
      onClickCapture={(event) => {
        if (swiped.current) { event.preventDefault(); event.stopPropagation(); return; }
        // Tapping an open row closes it instead of opening the conversation.
        if (open) { event.preventDefault(); event.stopPropagation(); setSettling("trailing"); onOpen(false); }
      }}>
      {children}
    </div>
  </div>;
}
