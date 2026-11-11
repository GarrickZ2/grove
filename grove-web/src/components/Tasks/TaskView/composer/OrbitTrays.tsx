import { useEffect, useState, type ReactNode } from "react";
import { Bot, Database, Pencil, Send, Square, SquareTerminal, Wrench, X } from "lucide-react";
import type { MemoryEntityMetadata } from "../../../../api/memory";
import type { PreviewCommentDraft } from "../../../../context";
import { Segmented } from "../../../../orbit/ui/Segmented";
import { OrbitTrayHead } from "./OrbitComposer";
import { commentAnchor } from "./trayModel";
import { formatElapsed } from "./composerStatus";
import { backgroundWorkLabel, type BackgroundWorkItem } from "../backgroundWork";

/**
 * Orbit Comments tray: the same drafts and actions as the Workbench panel
 * (edit, send one, send all, remove), as flat rows under the shared tray head.
 */
export function OrbitCommentsTray({ drafts, onUpdate, onSend, onRemove, onClose }: {
  drafts: PreviewCommentDraft[];
  onUpdate: (id: string, patch: { comment: string }) => void;
  onSend: (drafts: PreviewCommentDraft[]) => void;
  onRemove: (id: string) => void;
  onClose?: () => void;
}) {
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const stopEditing = () => setEditing(null);
  return (
    <>
      <OrbitTrayHead title="Comments" detail={`${drafts.length}`} onClose={onClose}>
        <button type="button" className="oc-tray-action" onClick={() => onSend(drafts)}>
          <Send aria-hidden="true" />Send all
        </button>
      </OrbitTrayHead>
      <ul className="oc-rows" aria-label="Preview comments">
        {drafts.map((draft, index) => {
          const { label, dir } = commentAnchor(draft);
          const selectedText = draft.locator.text?.trim();
          const context = selectedText || draft.locator.selector || draft.locator.tagName;
          const isEditing = editing?.id === draft.id;
          const text = isEditing ? editing.text.trim() : "";
          return (
            <li key={draft.id} className={`oc-row${isEditing ? " is-editing" : ""}`}>
              <span className="oc-row-n" title="Marker shown in preview">{index + 1}</span>
              <div className="oc-row-main">
                {isEditing ? (
                  <textarea
                    autoFocus
                    rows={3}
                    className="oc-row-edit"
                    aria-label="Edit comment"
                    value={editing.text}
                    onChange={(event) => setEditing({ id: draft.id, text: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        stopEditing();
                      }
                      if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && text) {
                        event.preventDefault();
                        onUpdate(draft.id, { comment: text });
                        stopEditing();
                      }
                    }}
                  />
                ) : (
                  <span className="oc-row-text">{draft.comment}</span>
                )}
                <span className="oc-row-meta" title={draft.filePath}>{label}{dir && <span> · {dir}</span>}</span>
                {context && <span className={`oc-row-quote${selectedText ? "" : " is-code"}`} title={context}>{selectedText ? `“${selectedText}”` : context}</span>}
                {isEditing && (
                  <div className="oc-row-edit-actions">
                    <button type="button" className="oc-text-btn" onClick={stopEditing}>Cancel</button>
                    <button type="button" className="oc-text-btn" disabled={!text} onClick={() => { onUpdate(draft.id, { comment: text }); stopEditing(); }}>Save</button>
                    <button type="button" className="oc-tray-action" disabled={!text} onClick={() => { stopEditing(); onSend([{ ...draft, comment: text }]); }}>
                      <Send aria-hidden="true" />Send
                    </button>
                  </div>
                )}
              </div>
              {!isEditing && (
                <span className="oc-row-actions">
                  <button type="button" className="oc-icon-btn" title="Edit comment" aria-label="Edit comment" onClick={() => setEditing({ id: draft.id, text: draft.comment })}><Pencil /></button>
                  <button type="button" className="oc-icon-btn" title="Send this comment" aria-label="Send this comment" onClick={() => onSend([draft])}><Send /></button>
                  <button type="button" className="oc-icon-btn is-danger" title="Remove" aria-label="Remove comment" onClick={() => onRemove(draft.id)}><X /></button>
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** Orbit Memory tray: what the agent read this turn, as flat rows. */
/** Background tray: what keeps running, for how long, and a way to stop it. */
export function OrbitBackgroundTray({ items, onCancel, onClose }: {
  items: BackgroundWorkItem[];
  /** Absent when this viewer cannot stop work (remote sessions). */
  onCancel?: (item: BackgroundWorkItem) => void;
  onClose?: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <>
      <OrbitTrayHead title="Background" detail={`${items.length} running`} onClose={onClose} />
      <ul className="oc-rows" aria-label="Background work">
        {items.map((item) => {
          const Icon = item.kind === "terminal" ? SquareTerminal : item.kind === "subagent" ? Bot : Wrench;
          const label = backgroundWorkLabel(item);
          return (
            <li key={`${item.kind}:${item.id}`} className="oc-row">
              <Icon className="oc-row-ic" aria-hidden="true" />
              <div className="oc-row-main">
                <span className={`oc-row-text${item.kind === "terminal" ? " is-code" : ""}`} title={label}>{label}</span>
                <span className="oc-row-meta">
                  <span>{formatElapsed(now - item.started_at * 1000)}</span>
                  {item.cwd && <span className="oc-row-id" title={item.cwd}>{item.cwd}</span>}
                </span>
              </div>
              {onCancel && item.cancellable && (
                <button type="button" className="oc-tray-action" onClick={() => onCancel(item)} aria-label={`Cancel ${label}`}><Square aria-hidden="true" />Cancel</button>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

export function OrbitMemoryTray({ memories, onClose }: { memories: MemoryEntityMetadata[]; onClose?: () => void }) {
  return (
    <>
      <OrbitTrayHead title="Memory" detail={`${memories.length} read this turn`} onClose={onClose} />
      <ul className="oc-rows" aria-label="Read memory">
        {memories.map((memory) => (
          <li key={memory.entity_id} className="oc-row">
            <Database className="oc-row-ic" aria-hidden="true" />
            <div className="oc-row-main">
              <span className="oc-row-text">{memory.title}</span>
              <span className="oc-row-meta">
                {memory.tags.map((tag) => <span key={`${tag.key}:${tag.value}`} className="oc-tag-quiet" title={`${tag.key}: ${tag.value}`}>{tag.value}</span>)}
                <span className="oc-row-id" title={memory.entity_id}>{memory.entity_id}</span>
              </span>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

export interface OrbitQueueRow {
  key: string;
  text: string;
  title?: string;
  failed: boolean;
  attachments?: ReactNode;
  /** The row's existing actions (send now, edit, delete, or the retry/edit menu). */
  actions: ReactNode;
}

/** Orbit Queue tray: queued messages in send order with the existing actions and mode. */
export function OrbitQueueTray({ rows, mode, onModeChange, error, onClose }: {
  rows: OrbitQueueRow[];
  mode: "separate" | "compact";
  onModeChange: (mode: "separate" | "compact") => void;
  error?: string | null;
  onClose?: () => void;
}) {
  return (
    <>
      <OrbitTrayHead title="Queued" detail="sent in order when this turn ends" onClose={onClose}>
        <Segmented
          size="sm"
          ariaLabel="How queued messages are sent"
          value={mode}
          onChange={onModeChange}
          options={[
            { value: "separate", label: "Separate", title: "Send queued messages one at a time" },
            { value: "compact", label: "Compact", title: "Merge all queued messages into one when auto-sent" },
          ]}
        />
      </OrbitTrayHead>
      {error && <p className="oc-tray-error" role="alert">{error}</p>}
      {rows.length === 0 ? <p className="oc-tray-empty">No queued messages.</p> : (
        <ul className="oc-rows" aria-label="Queued messages">
          {rows.map((row, index) => (
            <li key={row.key} className={`oc-row${row.failed ? " is-failed" : ""}`}>
              <span className="oc-row-n">{row.failed ? "!" : index + 1}</span>
              {row.attachments}
              <div className="oc-row-main">
                <span className="oc-row-text is-single" title={row.title ?? row.text}>{row.text}</span>
                {row.failed && <span className="oc-row-meta is-error">Failed to send</span>}
              </div>
              <span className={`oc-row-actions${row.failed ? " is-pinned" : ""}`}>{row.actions}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
