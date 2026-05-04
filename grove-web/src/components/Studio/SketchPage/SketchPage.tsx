import { useCallback, useEffect, useState } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useSketchList } from "./hooks/useSketchList";
import { useSketchSync } from "./hooks/useSketchSync";
import { useSketchThumbnail } from "./hooks/useSketchThumbnail";
import { SketchCanvas } from "./SketchCanvas";
import { SketchTabBar } from "./SketchTabBar";
import { SketchHistoryDialog } from "./SketchHistoryDialog";
import { OPEN_SKETCH_EVENT, type OpenSketchDetail, setSketchNames } from "../../ui/sketchChipCache";
import { readLastActiveTab, writeLastActiveTab } from "../../../utils/lastActiveTab";

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
      const { exportToBlob } = await import("@excalidraw/excalidraw");
      const blob = await exportToBlob({
        elements: apiRef.getSceneElements(),
        appState: apiRef.getAppState(),
        files: apiRef.getFiles(),
        mimeType: "image/png",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${sketches.find((s) => s.id === activeId)?.name ?? "sketch"}.png`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error("sketch export failed", e);
    }
  }, [apiRef, sketches, activeId]);

  return (
    <div
      className="flex flex-col h-full w-full"
      style={{ background: "var(--color-bg)" }}
    >
      <SketchTabBar
        sketches={sketches}
        activeId={activeId}
        onSelect={selectAndPersist}
        onCreate={handleCreate}
        onDelete={remove}
        onRename={rename}
        onExportPng={handleExport}
        onRefresh={() => {
          // Manual refresh = "resync with server". Refresh both the active
          // scene AND the sketch index — otherwise a sketch the agent just
          // created (via MCP, out-of-process) wouldn't appear as a tab.
          void refreshScene();
          void refresh();
        }}
        onOpenHistory={() => setHistoryOpen(true)}
        aiBusy={isChatBusy}
        // Surface real-time-stream state so the user sees when updates are
        // paused. `wsConnected` is `undefined` during the initial connect
        // attempt; the pill only renders when it's explicitly `false`, so
        // there's no flash on first mount.
        wsConnected={wsConnected}
      />
      <div className="flex-1 min-h-0">
        {listLoading ? (
          <CenterMessage>Loading…</CenterMessage>
        ) : sketches.length === 0 ? (
          <EmptyState onCreate={handleCreate} />
        ) : sceneLoading || !activeId ? (
          <CenterMessage>Loading sketch…</CenterMessage>
        ) : (
          <SketchCanvas
            // Force Excalidraw to fully remount on any remote-driven update
            // (polling / refresh / WS). Excalidraw's imperative updateScene
            // merges via version reconciliation and does not reliably apply
            // our cross-process AI-authored writes; remounting with fresh
            // initialData is the same code path as a full page reload, which
            // the user already confirmed works. Local user edits are
            // unaffected because onLocalChange never bumps remoteTick.
            key={`${activeId}-${remoteTick}`}
            scene={scene}
            onChange={onLocalChange}
            onExcalidrawAPI={setApiRef}
            // Lock the canvas while the ACP chat is busy: prevents user
            // edits from racing with AI-authored MCP writes (otherwise the
            // user's debounced PUT would overwrite AI's additions).
            locked={isChatBusy}
          />
        )}
      </div>
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
    </div>
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
