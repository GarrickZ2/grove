import { useCallback, useEffect, useState } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useSketchList } from "./hooks/useSketchList";
import { useSketchSync } from "./hooks/useSketchSync";
import { useSketchThumbnail } from "./hooks/useSketchThumbnail";
import { SketchCanvas } from "./SketchCanvas";
import { SketchTabBar } from "./SketchTabBar";
import { SketchHistoryDialog } from "./SketchHistoryDialog";
import { OPEN_SKETCH_EVENT, type OpenSketchDetail, setSketchNames } from "../../ui/sketchChipCache";

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
  const {
    sketches,
    loading: listLoading,
    create,
    remove,
    rename,
    refresh,
  } = useSketchList(projectId, taskId);
  const [activeId, setActiveId] = useState<string | null>(null);
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

  // Auto-select first sketch after list loads, and re-pick if active was deleted.
  useEffect(() => {
    if (!activeId && sketches.length > 0) {
      setActiveId(sketches[0].id);
    } else if (activeId && !sketches.find((s) => s.id === activeId)) {
      setActiveId(sketches[0]?.id ?? null);
    }
  }, [sketches, activeId]);

  // Keep the shared SketchChip name cache in sync with the live sketch index
  // so newly created / renamed / deleted sketches surface correctly in chat
  // chips. Replace in place (don't invalidate+refetch) so chips never flash
  // "Unknown sketch" between the cache wipe and the next fetch — reuse
  // useSketchList's already-fetched data directly.
  useEffect(() => {
    setSketchNames(projectId, taskId, sketches);
  }, [projectId, taskId, sketches]);

  // Live Preview: while the ACP chat is busy, MCP can create *new* sketches
  // from its separate OS process. The scene poll in useSketchSync refreshes
  // the active canvas, but not the sketch index — so a freshly-drawn sketch
  // would never appear as a tab until the chat went idle (or the user
  // manually refreshed). Mirror the scene poll by refetching the list on the
  // same cadence; refresh is cheap and dedup'd on the server.
  useEffect(() => {
    if (!isChatBusy) return;
    const timer = window.setInterval(() => {
      void refresh();
    }, 2000);
    return () => window.clearInterval(timer);
  }, [isChatBusy, refresh]);

  // Respond to chip clicks elsewhere in the app that request opening a
  // sketch in this task. Matches on (projectId, taskId); if the requested
  // sketch exists in the current index, switch the active tab to it.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<OpenSketchDetail>).detail;
      if (!detail) return;
      if (detail.projectId !== projectId || detail.taskId !== taskId) return;
      if (!sketches.find((s) => s.id === detail.sketchId)) return;
      setActiveId(detail.sketchId);
    };
    window.addEventListener(OPEN_SKETCH_EVENT, handler);
    return () => window.removeEventListener(OPEN_SKETCH_EVENT, handler);
  }, [projectId, taskId, sketches]);

  const handleCreate = useCallback(async () => {
    try {
      const meta = await create(`Sketch ${sketches.length + 1}`);
      setActiveId(meta.id);
    } catch (e) {
      console.error("create sketch failed", e);
    }
  }, [create, sketches.length]);

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
        onSelect={setActiveId}
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
