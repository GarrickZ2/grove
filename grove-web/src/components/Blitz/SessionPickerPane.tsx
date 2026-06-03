import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { listChats } from "../../api/tasks";

interface SessionPickerPaneProps {
  projectId: string;
  taskId: string;
  taskName: string;
  /** Called with the chosen session; the dropped panel becomes that chat. */
  onPick: (chat: { id: string; name: string }) => void;
  /** Called when the user dismisses without picking (closes the panel). */
  onCancel: () => void;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; chats: Array<{ id: string; name: string; agent: string }> };

/**
 * Shown inside a freshly-dropped panel (a task dragged from the left list)
 * until the user picks which of that task's chat sessions to pin. The pick is
 * the confirmation — no separate modal.
 */
export function SessionPickerPane({ projectId, taskId, taskName, onPick, onCancel }: SessionPickerPaneProps) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    // Each pane is bound to one task, so projectId/taskId don't change over its
    // lifetime — the initial "loading" state covers the single fetch. (Avoid a
    // synchronous setState here per react-hooks/set-state-in-effect.)
    let cancelled = false;
    listChats(projectId, taskId)
      .then((chats) => {
        if (cancelled) return;
        setState({
          kind: "ready",
          chats: chats.map((c) => ({ id: c.id, name: c.title || "Untitled chat", agent: c.agent })),
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({ kind: "error", message: err instanceof Error ? err.message : "Failed to load sessions" });
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, taskId]);

  return (
    <div className="flex flex-col h-full w-full min-h-0 bg-[var(--color-bg)]">
      <div className="flex items-center justify-between gap-2 shrink-0 px-3 py-2 border-b border-[var(--color-border)]">
        <div className="min-w-0">
          <div className="text-sm font-medium truncate text-[var(--color-text)]">{taskName}</div>
          <div className="text-[11px] text-[var(--color-text-muted)]">Pick a session to pin</div>
        </div>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Cancel"
          className="shrink-0 p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {state.kind === "loading" && (
          <div className="p-4 text-sm text-[var(--color-text-muted)]">Loading sessions…</div>
        )}
        {state.kind === "error" && (
          <div className="p-4 text-sm text-[var(--color-error)]">{state.message}</div>
        )}
        {state.kind === "ready" && state.chats.length === 0 && (
          <div className="p-4 text-sm text-[var(--color-text-muted)]">No chat sessions in this task yet.</div>
        )}
        {state.kind === "ready" &&
          state.chats.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onPick({ id: c.id, name: c.name })}
              className="w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left border-b border-[var(--color-border)] hover:bg-[var(--color-highlight)]/10 transition-colors"
            >
              <span className="min-w-0">
                <span className="block text-sm truncate text-[var(--color-text)]">{c.name}</span>
                <span className="block text-[11px] text-[var(--color-text-muted)]">{c.agent}</span>
              </span>
              <span className="shrink-0 text-[11px] font-medium text-[var(--color-highlight)]">pin →</span>
            </button>
          ))}
      </div>
    </div>
  );
}
