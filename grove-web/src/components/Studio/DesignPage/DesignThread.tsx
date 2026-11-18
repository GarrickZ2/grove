import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Pencil, Send, Trash2, X } from "lucide-react";
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
  /** Whether the reader may edit and delete an entry: the comment itself
   *  (no reply id) or one of its replies. Absent: none of them. */
  canChange?: (replyId?: number) => boolean;
  /** Rewrite the comment, or a reply. */
  onEdit?: (text: string, replyId?: number) => Promise<void>;
  /** Delete a reply, or, without one, the comment and its whole thread. */
  onDelete?: (replyId?: number) => Promise<void>;
}

/** One entry of the thread: the comment (`reply` undefined) or a reply. */
type Entry = { key: string; reply?: number; author: string; content: string; timestamp: string };

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
export function DesignThread({ at, comment, target, agent, canSend, onSubmit, onSend, onResolve, onClose, compose = true, canChange, onEdit, onDelete }: Props) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  // The entry being rewritten or about to be deleted, by its key.
  const [editing, setEditing] = useState<{ key: string; text: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
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
  const saveEdit = (entry: Entry) => {
    const value = editing?.text.trim();
    if (!value || !onEdit) return;
    if (value === entry.content) {
      setEditing(null);
      return;
    }
    void change(async () => {
      await onEdit(value, entry.reply);
      setEditing(null);
    }, "Couldn't save the change");
  };
  const remove = (entry: Entry) => {
    if (!onDelete) return;
    void change(async () => {
      await onDelete(entry.reply);
      setDeleting(null);
      // The thread is gone with its comment.
      if (entry.reply === undefined) onClose();
    }, "Couldn't delete it");
  };
  const entries: Entry[] = comment
    ? [
        { key: "comment", author: comment.author, content: comment.content, timestamp: comment.timestamp },
        ...comment.replies.map((reply) => ({ key: `reply-${reply.id}`, reply: reply.id, author: reply.author, content: reply.content, timestamp: reply.timestamp })),
      ]
    : [];

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
          {entries.map((entry) => {
            const changeable = Boolean(onEdit && onDelete && canChange?.(entry.reply));
            const isEditing = editing?.key === entry.key;
            return (
              <div key={entry.key} className="design-thread-item">
                <Avatar name={entry.author} />
                <div className="design-thread-text">
                  <div className="design-thread-meta">
                    <b>{entry.author}</b>
                    <span>{relativeText(entry.timestamp)}</span>
                    {changeable && !isEditing && deleting !== entry.key ? (
                      <span className="design-thread-actions">
                        <button type="button" className="design-icon-btn" disabled={busy} onClick={() => { setDeleting(null); setEditing({ key: entry.key, text: entry.content }); }} title="Edit" aria-label="Edit">
                          <Pencil size={12} />
                        </button>
                        <button type="button" className="design-icon-btn" disabled={busy} onClick={() => { setEditing(null); setDeleting(entry.key); }} title="Delete" aria-label="Delete">
                          <Trash2 size={12} />
                        </button>
                      </span>
                    ) : null}
                  </div>
                  {isEditing ? (
                    <div className="design-thread-edit">
                      <textarea
                        autoFocus
                        value={editing.text}
                        rows={2}
                        onChange={(event) => setEditing({ key: entry.key, text: event.target.value })}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                            event.preventDefault();
                            saveEdit(entry);
                          } else if (event.key === "Escape") {
                            // Leave the edit, not the thread.
                            event.stopPropagation();
                            event.nativeEvent.stopImmediatePropagation();
                            setEditing(null);
                          }
                        }}
                      />
                      <div className="design-thread-edit-foot">
                        <button type="button" className="design-btn" disabled={busy} onClick={() => setEditing(null)}>Cancel</button>
                        <button type="button" className="design-btn is-primary" disabled={busy || !editing.text.trim()} onClick={() => saveEdit(entry)}>Save</button>
                      </div>
                    </div>
                  ) : (
                    <p>{entry.content}</p>
                  )}
                  {deleting === entry.key ? (
                    <div className="design-thread-confirm">
                      <span>{entry.reply === undefined && comment.replies.length > 0 ? "Delete this comment and its replies?" : `Delete this ${entry.reply === undefined ? "comment" : "reply"}?`}</span>
                      <button type="button" className="design-btn" disabled={busy} onClick={() => setDeleting(null)}>Cancel</button>
                      <button type="button" className="design-btn is-danger" disabled={busy} onClick={() => remove(entry)}>Delete</button>
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
      {!compose && failed ? <div className="design-thread-error design-thread-pad">{failed}</div> : null}
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
