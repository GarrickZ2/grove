import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { DesignComment } from "../../../api/designs";
import type { ReviewCommentEntry } from "../../../api/tasks";
import { CommentCard, ReplyForm } from "../../Review/InlineComment";
import { ReviewComments } from "../../Review/ReviewComments";

/** What a thread shows of a comment: Design's and Sketch's comments both have it. */
export type ThreadComment = Pick<DesignComment, "author" | "content" | "timestamp" | "status" | "replies">;

interface Props {
  /** Viewport point the thread opens beside. */
  at: { x: number; y: number };
  /** The thread; absent while writing a new comment. */
  comment?: ReviewCommentEntry;
  /** What the comment is on: "Overview · button.primary". */
  target: string;
  canSend: boolean;
  /** Save a comment or a reply. The agent hears of it only when it is sent. */
  onSubmit: (text: string) => Promise<void>;
  /** Hand the thread to the agent; absent where there is no agent of the reader's. */
  onSend?: () => void;
  onResolve?: () => void;
  onClose: () => void;
  /** False where the thread can only be read. */
  compose?: boolean;
  /** Rewrite the comment, or a reply. */
  onEdit?: (text: string, replyId?: number) => Promise<void>;
  /** Delete a reply, or, without one, the comment and its whole thread. */
  onDelete?: (replyId?: number) => Promise<void>;
}

const WIDTH = 380;

/** A comment thread on an element (a page's or a sketch's): what was said, a reply box, and a way to hand it to the agent. */
export function DesignThread({ at, comment, target, canSend, onSubmit, onSend, onResolve, onClose, compose = true, onEdit, onDelete }: Props) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [replying, setReplying] = useState(false);
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

  const change = async (work: () => Promise<void>, fallback: string) => {
    if (busy) return;
    setBusy(true);
    setFailed(null);
    try {
      await work();
    } catch (cause) {
      setFailed((cause as { message?: string })?.message ?? fallback);
    } finally {
      setBusy(false);
    }
  };
  const left = Math.max(8, Math.min(at.x + 14, window.innerWidth - WIDTH - 8));
  const top = Math.max(8, Math.min(at.y - 12, window.innerHeight - 380));

  return createPortal(
    <div ref={rootRef} className="design-thread" style={{ left, top, width: WIDTH }} role="dialog" aria-label="Comment thread"
      onKeyDown={(event) => {
        // Escape leaves what is being written, not the thread.
        if (comment && event.key === "Escape" && event.target instanceof HTMLTextAreaElement) event.nativeEvent.stopPropagation();
      }}
    >
      <div className="design-thread-head">
        <span className="design-thread-target" title={target}>{target}</span>
        <button type="button" className="design-icon-btn" onClick={onClose} title="Close" aria-label="Close">
          <X size={15} />
        </button>
      </div>
      {comment ? (
        <div className="design-thread-list">
          <ReviewComments>
            <CommentCard
              compact
              comment={comment}
              onResolve={onResolve}
              onReopen={onResolve}
              onSend={onSend && canSend ? onSend : null}
              onReply={compose ? () => setReplying(true) : undefined}
              onEdit={onEdit ? (_id, value) => void change(() => onEdit(value), "Couldn't save the change") : undefined}
              onEditReply={onEdit ? (_id, reply, value) => void change(() => onEdit(value, reply), "Couldn't save the change") : undefined}
              // The thread is gone with its comment.
              onDelete={onDelete ? () => void change(async () => { await onDelete(); onClose(); }, "Couldn't delete it") : undefined}
              onDeleteReply={onDelete ? (_id, reply) => void change(() => onDelete(reply), "Couldn't delete it") : undefined}
            />
            {replying ? (
              <ReplyForm
                commentId={comment.id}
                onCancel={() => setReplying(false)}
                onSubmit={(_id, _status, value) => void change(async () => { await onSubmit(value); setReplying(false); }, "Couldn't save the reply")}
              />
            ) : null}
          </ReviewComments>
        </div>
      ) : null}
      {comment && failed ? <div className="design-thread-error design-thread-pad">{failed}</div> : null}
      {!comment ? (
      <div className="design-thread-compose">
        <textarea
          ref={inputRef}
          value={text}
          rows={3}
          placeholder="Add a comment"
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
          <span />
          <button type="button" className="design-btn is-primary" disabled={!text.trim() || busy} onClick={() => void submit()}>
            Comment
          </button>
        </div>
      </div>
      ) : null}
    </div>,
    document.body,
  );
}
