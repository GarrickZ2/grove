import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Send, X } from "lucide-react";
import type { DesignComment } from "../../../api/designs";
import { relativeText } from "../../../orbit/ui";
import { authorHue, initials } from "./designModel";

/** What a thread shows of a comment: Design's and Sketch's comments both have it. */
export type ThreadComment = Pick<DesignComment, "author" | "content" | "timestamp" | "status" | "replies">;

interface Props {
  /** Viewport point the thread opens beside. */
  at: { x: number; y: number };
  /** The thread; absent while writing a new comment. */
  comment?: ThreadComment;
  /** What the comment is on: "Overview · button.primary". */
  target: string;
  /** The chat's agent, when a chat is open to send to. */
  agent: string | null;
  canSend: boolean;
  /** Save a comment or a reply. The agent hears of it only when it is sent. */
  onSubmit: (text: string) => Promise<void>;
  /** Hand the thread to the agent; absent where there is no agent of the reader's. */
  onSend?: () => void;
  onResolve?: () => void;
  onClose: () => void;
  /** False where the thread can only be read. */
  compose?: boolean;
}

const WIDTH = 320;

export function Avatar({ name, size = 22 }: { name: string; size?: number }) {
  return (
    <span
      className="design-avatar"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42), background: `hsl(${authorHue(name)} 55% 42%)` }}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}

/** A comment thread on an element (a page's or a sketch's): what was said, a reply box, and a way to hand it to the agent. */
export function DesignThread({ at, comment, target, agent, canSend, onSubmit, onSend, onResolve, onClose, compose = true }: Props) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    // After this click: the one that opened the thread must not close it.
    const timer = window.setTimeout(() => window.addEventListener("pointerdown", onDown), 0);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [onClose]);

  const submit = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    setFailed(null);
    try {
      await onSubmit(value);
      setText("");
    } catch (cause) {
      setFailed((cause as { message?: string })?.message ?? "Couldn't save the comment");
    } finally {
      setBusy(false);
    }
  };

  const left = Math.max(8, Math.min(at.x + 14, window.innerWidth - WIDTH - 8));
  const top = Math.max(8, Math.min(at.y - 12, window.innerHeight - 380));
  const who = agent || "the agent";

  return createPortal(
    <div ref={rootRef} className="design-thread" style={{ left, top, width: WIDTH }} role="dialog" aria-label="Comment thread">
      <div className="design-thread-head">
        <span className="design-thread-target" title={target}>{target}</span>
        {comment && onResolve ? (
          <button type="button" className="design-icon-btn" onClick={onResolve} title={comment.status === "open" ? "Resolve" : "Reopen"} aria-label={comment.status === "open" ? "Resolve" : "Reopen"}>
            <Check size={15} className={comment.status === "resolved" ? "design-resolved" : undefined} />
          </button>
        ) : null}
        <button type="button" className="design-icon-btn" onClick={onClose} title="Close" aria-label="Close">
          <X size={15} />
        </button>
      </div>
      {comment ? (
        <div className="design-thread-list">
          {[{ id: 0, author: comment.author, content: comment.content, timestamp: comment.timestamp }, ...comment.replies].map((entry) => (
            <div key={entry.id} className="design-thread-item">
              <Avatar name={entry.author} />
              <div className="design-thread-text">
                <div className="design-thread-meta">
                  <b>{entry.author}</b>
                  <span>{relativeText(entry.timestamp)}</span>
                </div>
                <p>{entry.content}</p>
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {compose ? (
      <div className="design-thread-compose">
        <textarea
          ref={inputRef}
          value={text}
          rows={comment ? 2 : 3}
          placeholder={comment ? "Reply" : "Add a comment"}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        {failed ? <div className="design-thread-error">{failed}</div> : null}
        <div className="design-thread-foot">
          {comment && onSend ? (
            <button type="button" className="design-btn" disabled={!canSend || busy} onClick={onSend} title={canSend ? undefined : "Open the task's chat to send comments to its agent"}>
              <Send size={13} />
              <span className="design-thread-send">Send to {who}</span>
            </button>
          ) : <span />}
          <button type="button" className="design-btn is-primary" disabled={!text.trim() || busy} onClick={() => void submit()}>
            {comment ? "Reply" : "Comment"}
          </button>
        </div>
      </div>
      ) : null}
    </div>,
    document.body,
  );
}
