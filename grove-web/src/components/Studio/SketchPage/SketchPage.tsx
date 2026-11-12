import { useCallback, useEffect, useState } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useSketchList } from "./hooks/useSketchList";
import { useSketchSync } from "./hooks/useSketchSync";
import { useSketchThumbnail } from "./hooks/useSketchThumbnail";
import { SketchBoard } from "./SketchBoard";
import { exportSketchPng } from "./sketchExport";
import { describePlace } from "./sketchAnchor";
import { SketchHistoryDialog } from "./SketchHistoryDialog";
import { OPEN_SKETCH_EVENT, type OpenSketchDetail, setSketchNames } from "../../ui/sketchChipCache";
import { readLastActiveTab, writeLastActiveTab } from "../../../utils/lastActiveTab";
import { useCommand, useContextKey } from "../../../keyboard";
import { createSketchComment, listSketchComments, type SketchAnchor, type SketchComment } from "../../../api";
import { replyReviewComment, updateCommentStatus } from "../../../api/review";
import { targetChatId, useActiveChatTarget } from "../../Review/sendOpenComments";
import { SEND_COMMENT_TO_CHAT_EVENT, type ChatReviewComment } from "../../Tasks/TaskView/reviewCommentPrompt";
import { useBanner } from "../../../context";

interface Props {
  projectId: string;
  taskId: string;
  /** Whether the ACP chat bound to this task is currently running. Used to
   * enable Live Preview polling: while the agent is busy, MCP draws land
   * directly in the task workdir without broadcasting to grove-web (MCP is a
   * separate OS process), so we refetch the scene on a timer to surface the
   * changes. Mirrors the Artifacts tab's live-refresh behavior. */
  isChatBusy?: boolean;
  /** Monotonic timestamp updated when the chat transitions to idle. Used to
   * trigger one final refresh after the agent finishes. */
  lastChatIdleAt?: number;
}

export function SketchPage({ projectId, taskId, isChatBusy, lastChatIdleAt }: Props) {
  "use no memo";
  // Uses dynamic `import()` for the Excalidraw scene module — Compiler 1.0
  // can't lower it. Studio is not on the hot interaction path.

  const {
    sketches,
    loading: listLoading,
    create,
    remove,
    rename,
    refresh,
  } = useSketchList(projectId, taskId);
  const [activeId, setActiveId] = useState<string | null>(null);

  // Setter used for user-driven selection changes: updates state AND persists
  // the new tab so it's restored next time the panel reopens.
  const selectAndPersist = useCallback(
    (id: string) => {
      setActiveId(id);
      writeLastActiveTab("sketch", projectId, taskId, id);
    },
    [projectId, taskId],
  );
  const [apiRef, setApiRef] = useState<ExcalidrawImperativeAPI | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  const onIndexChanged = useCallback(() => {
    void refresh();
  }, [refresh]);

  const {
    scene,
    loading: sceneLoading,
    onLocalChange,
    remoteTick,
    refresh: refreshScene,
    wsConnected,
  } = useSketchSync(projectId, taskId, activeId, onIndexChanged, {
    isChatBusy,
    lastChatIdleAt,
  });

  useSketchThumbnail({
    projectId,
    taskId,
    sketchId: activeId,
    scene,
    excalidrawApi: apiRef,
  });

  // Auto-select first sketch after list loads, and re-pick if the active
  // sketch was deleted. Only act on a non-empty list to avoid jumping the
  // selection to `null` and then immediately back to `sketches[0]` during the
  // transient window after a WS `index_changed` when `useSketchList` is
  // between invalidation and refetch (empty array briefly observed).
  //
  // Implemented as a "derive from props during render" pattern (compare prev
  // sketches/activeId, setState when stale) rather than useEffect to satisfy
  // react-hooks/set-state-in-effect. Same observable behavior.
  const [prevSelSig, setPrevSelSig] = useState<string>("");
  const selSig = `${sketches.length}|${activeId ?? ""}|${sketches.map((s) => s.id).join(",")}`;
  if (selSig !== prevSelSig) {
    setPrevSelSig(selSig);
    if (sketches.length > 0) {
      if (!activeId) {
        const remembered = readLastActiveTab("sketch", projectId, taskId);
        const restoredId =
          remembered && sketches.some((s) => s.id === remembered)
            ? remembered
            : sketches[0].id;
        setActiveId(restoredId);
      } else if (!sketches.some((s) => s.id === activeId)) {
        const fallbackId = sketches[0].id;
        setActiveId(fallbackId);
        writeLastActiveTab("sketch", projectId, taskId, fallbackId);
      }
    }
  }

  // Keep the shared SketchChip name cache in sync with the live sketch index
  // so newly created / renamed / deleted sketches surface correctly in chat
  // chips. Replace in place (don't invalidate+refetch) so chips never flash
  // "Unknown sketch" between the cache wipe and the next fetch — reuse
  // useSketchList's already-fetched data directly.
  useEffect(() => {
    setSketchNames(projectId, taskId, sketches);
  }, [projectId, taskId, sketches]);

  // Live Preview fallback: while the ACP chat is busy, MCP can create *new*
  // sketches from its separate OS process. Normally the WS `index_changed`
  // broadcast routed through useSketchSync → onIndexChanged is what refreshes
  // the tab list. Only poll as a fallback when the WS is NOT connected so we
  // don't double-refresh (and don't flood the server on every task).
  useEffect(() => {
    if (!isChatBusy) return;
    if (wsConnected === true) return;
    const timer = window.setInterval(() => {
      void refresh();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [isChatBusy, refresh, wsConnected]);

  // Respond to chip clicks elsewhere in the app that request opening a
  // sketch in this task. Matches on (projectId, taskId); if the requested
  // sketch exists in the current index, switch the active tab to it.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<OpenSketchDetail>).detail;
      if (!detail) return;
      if (detail.projectId !== projectId || detail.taskId !== taskId) return;
      if (!sketches.find((s) => s.id === detail.sketchId)) return;
      selectAndPersist(detail.sketchId);
    };
    window.addEventListener(OPEN_SKETCH_EVENT, handler);
    return () => window.removeEventListener(OPEN_SKETCH_EVENT, handler);
  }, [projectId, taskId, sketches, selectAndPersist]);

  const handleCreate = useCallback(async () => {
    try {
      const meta = await create(`Sketch ${sketches.length + 1}`);
      selectAndPersist(meta.id);
    } catch (e) {
      console.error("create sketch failed", e);
    }
  }, [create, sketches.length, selectAndPersist]);

  const handleExport = useCallback(async () => {
    if (!apiRef) return;
    try {
      await exportSketchPng(apiRef, sketches.find((s) => s.id === activeId)?.name ?? "sketch");
    } catch (e) {
      console.error("sketch export failed", e);
    }
  }, [apiRef, sketches, activeId]);

  // Comments on the task's sketches. Read again when the agent stops (it
  // answers with grove_reply_review) and when the sketch shown changes.
  const { showBanner } = useBanner();
  const chat = useActiveChatTarget();
  const [comments, setComments] = useState<SketchComment[]>([]);
  const reloadComments = useCallback(async () => {
    try {
      setComments((await listSketchComments(projectId, taskId)).comments);
    } catch (e) {
      console.warn("[SketchPage] couldn't load comments", e);
    }
  }, [projectId, taskId]);
  useEffect(() => {
    void Promise.resolve().then(reloadComments);
  }, [reloadComments, lastChatIdleAt, activeId]);

  const addComment = useCallback(async (sketch: string, anchor: SketchAnchor, content: string) => {
    setComments((await createSketchComment(projectId, taskId, { sketch, anchor, content })).comments);
  }, [projectId, taskId]);

  const sendToAgent = useCallback((list: SketchComment[]) => {
    const details: ChatReviewComment[] = list.map((comment) => ({
      id: comment.id,
      comment_type: "file",
      file_path: `sketch/${comment.sketch}`,
      content: comment.content,
      agent: comment.author,
      status: comment.status,
      sketch: {
        id: comment.sketch,
        name: sketches.find((s) => s.id === comment.sketch)?.name ?? "sketch",
        place: describePlace(comment.anchor),
        replies: comment.replies.map((reply) => `${reply.author}: ${reply.content}`),
      },
    }));
    if (details.length === 0) return;
    const chatId = targetChatId();
    window.dispatchEvent(new CustomEvent(SEND_COMMENT_TO_CHAT_EVENT, { detail: details.length === 1 ? { ...details[0], chatId } : { comments: details, chatId } }));
  }, [sketches]);

  // Catalog-declared sketch commands. Several entries gate on the
  // `sketchSelected` context key — set it from `activeId` so keyboard
  // bindings (and the Settings UI conflict view) evaluate correctly.
  useContextKey("sketchSelected", activeId !== null);

  // Create a new sketch — same handler as the "+" button in the tab bar.
  useCommand(
    "studio.sketch.create",
    () => {
      void handleCreate();
    },
    [handleCreate],
  );

  // Export the active sketch as PNG. Gate on `apiRef` so the binding is
  // inert before the canvas mounts (mirrors handleExport's early return).
  useCommand(
    "studio.sketch.export",
    () => {
      void handleExport();
    },
    { enabled: () => activeId !== null && apiRef !== null },
    [handleExport, activeId, apiRef],
  );

  // Delete the active sketch. Mirrors the tab bar's per-tab delete (which
  // routes through useSketchList.remove); skips the confirm dialog because
  // the keyboard binding is opt-in. Gate on `activeId`.
  useCommand(
    "studio.sketch.delete",
    () => {
      if (activeId !== null) void remove(activeId);
    },
    { enabled: () => activeId !== null },
    [activeId, remove],
  );

  // Open the History dialog for the active sketch — same as the History
  // button in the tab bar.
  useCommand(
    "studio.sketch.history.open",
    () => setHistoryOpen(true),
    { enabled: () => activeId !== null },
    [activeId],
  );

  return (
    <>
      <SketchBoard
        sketches={listLoading ? [] : sketches}
        activeId={activeId}
        onSelect={selectAndPersist}
        scene={scene}
        sceneKey={`${activeId}-${remoteTick}`}
        sceneLoading={sceneLoading}
        owner={{
          onCreate: () => void handleCreate(),
          onRename: (id, name) => void rename(id, name),
          onDelete: (id) => void remove(id),
          onHistory: () => setHistoryOpen(true),
          onChange: onLocalChange,
          aiBusy: isChatBusy,
          // `undefined` while first connecting, so nothing flashes on mount.
          wsConnected,
        }}
        comments={comments}
        onAddComment={addComment}
        onReply={async (id, content) => {
          await replyReviewComment(projectId, taskId, id, content);
          await reloadComments();
        }}
        onResolve={(comment) => {
          const status = comment.status === "open" ? "resolved" : "open";
          setComments((list) => list.map((entry) => (entry.id === comment.id ? { ...entry, status } : entry)));
          updateCommentStatus(projectId, taskId, comment.id, status).catch(() => {
            showBanner("Couldn't update the comment", "error");
            void reloadComments();
          });
        }}
        onSend={sendToAgent}
        agent={chat.agent}
        canSend={Boolean(chat.chatId)}
        onApi={setApiRef}
        empty={listLoading ? <CenterMessage>Loading…</CenterMessage> : <EmptyState onCreate={handleCreate} />}
      />
      {activeId && (
        <SketchHistoryDialog
          isOpen={historyOpen}
          projectId={projectId}
          taskId={taskId}
          sketchId={activeId}
          sketchName={sketches.find((s) => s.id === activeId)?.name ?? "sketch"}
          onClose={() => setHistoryOpen(false)}
          onRestored={() => {
            // Server broadcasts an agent-source sketch_updated event on
            // restore, but belt-and-suspenders: kick a manual refresh in
            // case the WS hasn't delivered yet.
            void refreshScene();
          }}
        />
      )}
    </>
  );
}

function CenterMessage({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex items-center justify-center h-full text-sm"
      style={{ color: "var(--color-text-muted)" }}
    >
      {children}
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex items-center justify-center h-full">
      <button
        type="button"
        onClick={onCreate}
        className="px-4 py-2 rounded-lg text-sm font-medium transition-colors border"
        style={{
          borderColor: "var(--color-border)",
          color: "var(--color-text)",
          background: "var(--color-bg-secondary)",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--color-bg-tertiary)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "var(--color-bg-secondary)";
        }}
      >
        Create your first sketch
      </button>
    </div>
  );
}
