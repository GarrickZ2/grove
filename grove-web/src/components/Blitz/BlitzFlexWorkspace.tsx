import { useCallback, useMemo, useRef, useState } from "react";
import { Layout, Model, Actions, DockLocation, TabNode, Node as FlexNode } from "flexlayout-react";
import { Plus, AlignHorizontalSpaceAround } from "lucide-react";
import "flexlayout-react/style/light.css";
import "../Tasks/PanelSystem/flexlayout-theme.css";
import { TaskChat } from "../Tasks/TaskView/TaskChat";
import { ChatPickerDropdown } from "./ChatPickerDropdown";
import { SessionPickerPane } from "./SessionPickerPane";
import type { BlitzTask } from "../../data/types";
import type { SlotAssignment } from "./useBlitzGrid";
import {
  type BlitzTabConfig,
  type OpenTab,
  BLITZ_TAB_COMPONENT,
  GROVE_TASK_MIME,
  buildColumnsModelJson,
  createInitialModel,
  persistModelJson,
  tabNodeFor,
} from "./blitzFlexModel";

/** Column presets: label → number of columns to tile open chats into evenly.
 *  (2 columns with four chats = a 2×2; 3 columns with six = a 3×2.) */
const GRID_PRESETS: ReadonlyArray<{ label: string; cols: number; title: string }> = [
  { label: "1", cols: 1, title: "Single column" },
  { label: "2", cols: 2, title: "Two columns (2×2 with four chats)" },
  { label: "3", cols: 3, title: "Three columns (3×2 with six chats)" },
];

interface BlitzFlexWorkspaceProps {
  blitzTasks: BlitzTask[];
}

/**
 * One pinned chat rendered inside a FlexLayout tab. TaskChat stays MOUNTED
 * even while disconnected so its reconnect machinery keeps running — the
 * "reconnecting" state is a non-blocking overlay, not an unmount (same fix as
 * the old GridSlot).
 */
function BlitzChatPane({
  cfg,
  blitzTasks,
  onPickSession,
  onCancel,
}: {
  cfg: BlitzTabConfig;
  blitzTasks: BlitzTask[];
  onPickSession: (chat: { id: string; name: string }) => void;
  onCancel: () => void;
}) {
  const [stale, setStale] = useState(false);
  const hasConnectedRef = useRef(false);
  // Locally-picked session, so the pane swaps to the chat the instant the user
  // picks — flexlayout's Tab is memoized and won't re-invoke the factory on a
  // config-only change (updateNodeAttributes), so we can't wait for cfg.chatId
  // to propagate. onPickSession still persists it to the node config.
  const [pickedChat, setPickedChat] = useState<{ id: string; name: string } | null>(null);

  const chatId = cfg.chatId ?? pickedChat?.id;
  const chatName = cfg.chatName ?? pickedChat?.name;

  const live = useMemo(
    () => blitzTasks.find((bt) => bt.projectId === cfg.projectId && bt.task.id === cfg.taskId),
    [blitzTasks, cfg.projectId, cfg.taskId],
  );

  // A task dropped from the left list awaits a session pick.
  if (!chatId) {
    if (!cfg.projectId || !cfg.taskId) {
      // Transient frame between tab creation and onDrop filling in the task.
      return (
        <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-muted)]">
          Loading…
        </div>
      );
    }
    return (
      <SessionPickerPane
        projectId={cfg.projectId}
        taskId={cfg.taskId}
        taskName={cfg.taskName}
        onPick={(chat) => {
          setPickedChat(chat); // instant local swap
          onPickSession(chat); // persist to node config
        }}
        onCancel={onCancel}
      />
    );
  }

  if (!live) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--color-text-muted)]">
        Chat unavailable
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full w-full min-h-0 min-w-0 overflow-hidden">
      {/* Context breadcrumb — which project · task · chat this panel is, since
          the tab only shows the chat name and several panels coexist. */}
      <div className="flex items-center gap-1 shrink-0 px-2.5 py-1 text-[11px] leading-none border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] overflow-hidden">
        <span className="shrink-0 text-[var(--color-text-muted)]">{cfg.projectName}</span>
        <span className="shrink-0 text-[var(--color-text-muted)]">·</span>
        <span className="truncate min-w-0 text-[var(--color-text)]">{cfg.taskName}</span>
        <span className="shrink-0 text-[var(--color-text-muted)]">·</span>
        <span className="truncate min-w-0 text-[var(--color-highlight)]">{chatName}</span>
      </div>
      <div className="relative flex flex-1 min-h-0 min-w-0 overflow-hidden">
        <TaskChat
          projectId={live.projectId}
          task={live.task}
          pinnedChatId={chatId}
          hideHeader={true}
          onConnected={() => {
            hasConnectedRef.current = true;
            setStale(false);
          }}
          onDisconnected={() => {
            // Only flag stale after a successful connect — the initial WS setup
            // fires onDisconnected before onConnected.
            if (hasConnectedRef.current) setStale(true);
          }}
        />
        {stale && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-[var(--color-bg)]/80 text-sm text-[var(--color-text-muted)] pointer-events-none">
            Connection lost — reconnecting automatically…
          </div>
        )}
      </div>
    </div>
  );
}

function countTabs(m: Model): number {
  let n = 0;
  m.visitNodes((node) => {
    if (node.getType() === "tab") n += 1;
  });
  return n;
}

/**
 * Blitz grid rebuilt on flexlayout-react: each pinned chat is a tab/panel you
 * can split, resize, rearrange, add, and close — replacing the fixed
 * 1/2/2×2/3×2 presets. Layout (and which chats are pinned where) persists to
 * localStorage; existing preset grids migrate in on first load.
 */
export function BlitzFlexWorkspace({ blitzTasks }: BlitzFlexWorkspaceProps) {
  const [model, setModel] = useState(() => createInitialModel());
  const [isEmpty, setIsEmpty] = useState(() => countTabs(model) === 0);
  const [pickerOpen, setPickerOpen] = useState(false);

  const collectTabs = useCallback((): OpenTab[] => {
    const tabs: OpenTab[] = [];
    model.visitNodes((node) => {
      if (node.getType() === "tab") {
        tabs.push({ id: node.getId(), config: (node as TabNode).getConfig() as BlitzTabConfig });
      }
    });
    return tabs;
  }, [model]);

  // Reset every panel to equal size in place (no reshape, no remount → chats
  // stay connected). adjustWeights on each multi-child row evens columns and,
  // via nested rows, the stacked panels within them.
  const equalize = useCallback(() => {
    const rows: Array<{ id: string; count: number }> = [];
    model.visitNodes((node) => {
      if (node.getType() === "row") {
        const count = node.getChildren().length;
        if (count > 1) rows.push({ id: node.getId(), count });
      }
    });
    rows.forEach(({ id, count }) =>
      model.doAction(Actions.adjustWeights(id, new Array(count).fill(100))),
    );
  }, [model]);

  // Snap open chats into an even grid of `cols` columns (the optional
  // "auto grid"). Tab ids are preserved so panels reconcile instead of
  // remounting — connections survive the re-tile.
  const tileColumns = useCallback(
    (cols: number) => {
      const tabs = collectTabs();
      if (tabs.length === 0) return;
      const json = buildColumnsModelJson(tabs, cols);
      setModel(Model.fromJson(json));
      persistModelJson(json);
      setIsEmpty(false);
    },
    [collectTabs],
  );

  // Fill a needs-session placeholder tab (dropped task) with the chosen chat.
  const assignSession = useCallback(
    (nodeId: string, chat: { id: string; name: string }) => {
      const node = model.getNodeById(nodeId);
      if (!(node instanceof TabNode)) return;
      // If this chat is already pinned in another panel, select it and drop the
      // placeholder rather than duplicating (mirrors the Add chat path).
      const tabs: TabNode[] = [];
      model.visitNodes((n) => {
        if (n.getType() === "tab") tabs.push(n as TabNode);
      });
      const existing = tabs.find(
        (t) => t.getId() !== nodeId && (t.getConfig() as BlitzTabConfig | undefined)?.chatId === chat.id,
      );
      if (existing) {
        model.doAction(Actions.selectTab(existing.getId()));
        model.doAction(Actions.deleteTab(nodeId));
        return;
      }
      const cfg = (node.getConfig() as BlitzTabConfig | undefined) ?? ({} as BlitzTabConfig);
      model.doAction(
        Actions.updateNodeAttributes(nodeId, {
          name: chat.name,
          config: { ...cfg, chatId: chat.id, chatName: chat.name, needsSession: false },
        }),
      );
    },
    [model],
  );

  const factory = useCallback(
    (node: TabNode) => (
      <BlitzChatPane
        cfg={node.getConfig() as BlitzTabConfig}
        blitzTasks={blitzTasks}
        onPickSession={(chat) => assignSession(node.getId(), chat)}
        onCancel={() => model.doAction(Actions.deleteTab(node.getId()))}
      />
    ),
    [blitzTasks, assignSession, model],
  );

  // Accept a task dragged from the left list: drop a placeholder tab where the
  // user aims, then fill in the task (onDrop) so its SessionPickerPane renders.
  // dataTransfer values can't be read during dragenter, only on drop — so the
  // placeholder carries no task until onDrop.
  const onExternalDrag = useCallback(
    (e: React.DragEvent<HTMLElement>) => {
      if (!Array.from(e.dataTransfer.types).includes(GROVE_TASK_MIME)) return undefined;
      return {
        json: {
          type: "tab",
          name: "New chat",
          component: BLITZ_TAB_COMPONENT,
          enableClose: true,
          config: {
            projectId: "",
            projectName: "",
            taskId: "",
            taskName: "",
            needsSession: true,
          } as BlitzTabConfig,
        },
        onDrop: (node?: FlexNode, event?: React.DragEvent<HTMLElement>) => {
          // Act on the dropped node's OWN model, not a captured one: flexlayout
          // keeps a static external-drag state that isn't cleared on cancel, so
          // a closed-over model could be stale after a re-tile (setModel).
          if (!(node instanceof TabNode) || !event) return;
          const targetModel = node.getModel();
          try {
            const data = JSON.parse(event.dataTransfer.getData(GROVE_TASK_MIME)) as {
              projectId: string;
              projectName: string;
              taskId: string;
              taskName: string;
            };
            targetModel.doAction(
              Actions.updateNodeAttributes(node.getId(), {
                name: data.taskName,
                config: {
                  projectId: data.projectId,
                  projectName: data.projectName,
                  taskId: data.taskId,
                  taskName: data.taskName,
                  needsSession: true,
                } as BlitzTabConfig,
              }),
            );
            setIsEmpty(false);
          } catch (err) {
            console.warn("[blitzFlex] invalid task drop", err);
            targetModel.doAction(Actions.deleteTab(node.getId()));
          }
        },
      };
    },
    [],
  );

  const handleModelChange = useCallback((m: Model) => {
    persistModelJson(m.toJson());
    setIsEmpty(countTabs(m) === 0);
  }, []);

  const addChat = useCallback(
    (a: SlotAssignment) => {
      setPickerOpen(false);
      // Already pinned somewhere? Select that tab instead of adding a duplicate.
      const tabs: TabNode[] = [];
      model.visitNodes((node) => {
        if (node.getType() === "tab") tabs.push(node as TabNode);
      });
      const existing = tabs.find(
        (t) => (t.getConfig() as BlitzTabConfig | undefined)?.chatId === a.chatId,
      );
      if (existing) {
        model.doAction(Actions.selectTab(existing.getId()));
        return;
      }
      const cfg: BlitzTabConfig = {
        projectId: a.projectId,
        projectName: a.projectName,
        taskId: a.taskId,
        taskName: a.taskName,
        chatId: a.chatId,
        chatName: a.chatName,
      };
      const active = model.getActiveTabset();
      const targetId = active?.getId() ?? model.getRoot().getId();
      model.doAction(Actions.addNode(tabNodeFor(cfg), targetId, DockLocation.CENTER, -1));
      // handleModelChange fires from the action → persists + clears empty state.
    },
    [model],
  );

  return (
    <div className="flex flex-col h-full bg-[var(--color-bg)]">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-[var(--color-border)]">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={equalize}
            disabled={isEmpty}
            title="Reset all panel sizes to equal"
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] disabled:opacity-40 disabled:pointer-events-none transition-colors"
          >
            <AlignHorizontalSpaceAround className="w-3.5 h-3.5" />
            Equalize
          </button>
          <div className="flex items-center rounded-lg border border-[var(--color-border)] overflow-hidden text-xs">
            <span className="px-2 py-1.5 text-[var(--color-text-muted)] border-r border-[var(--color-border)]">
              Columns
            </span>
            {GRID_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => tileColumns(p.cols)}
                disabled={isEmpty}
                title={p.title}
                className="px-2.5 py-1.5 text-[var(--color-text-muted)] hover:text-[var(--color-highlight)] hover:bg-[var(--color-highlight)]/10 disabled:opacity-40 disabled:pointer-events-none transition-colors border-l border-[var(--color-border)] first:border-l-0"
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <div className="relative">
          <button
            type="button"
            onClick={() => setPickerOpen((v) => !v)}
            aria-haspopup="dialog"
            aria-expanded={pickerOpen}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border border-[var(--color-highlight)]/30 bg-[var(--color-highlight)]/10 text-[var(--color-highlight)] hover:bg-[var(--color-highlight)]/20 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            Add chat
          </button>
          {pickerOpen && (
            <ChatPickerDropdown
              blitzTasks={blitzTasks}
              onSelect={addChat}
              onClose={() => setPickerOpen(false)}
            />
          )}
        </div>
      </div>

      <div className="relative flex-1 min-h-0">
        <div className="absolute inset-0">
          <Layout
            model={model}
            factory={factory}
            onModelChange={handleModelChange}
            onExternalDrag={onExternalDrag}
          />
        </div>
        {isEmpty && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 pointer-events-none text-[var(--color-text-muted)]">
            <span className="text-sm">No chats pinned yet</span>
            <span className="text-xs text-[var(--color-text-faint,var(--color-text-muted))]">
              Drag a task from the list onto the canvas, or use “Add chat”
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
