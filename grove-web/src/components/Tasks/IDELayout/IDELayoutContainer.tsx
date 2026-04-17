import { useState, useCallback, useRef, forwardRef, useImperativeHandle, useEffect } from "react";
import {
  X,
  Terminal,
  FileCode,
  Code,
  Package,
  BarChart3,
  GitBranch,
  FileText,
  MessageSquare,
} from "lucide-react";
import "./ide-layout.css";
import type {
  IDELayoutContainerProps,
  IDELayoutHandle,
  AuxPanelType,
  InfoTabType,
  ArtifactPreviewRequest,
} from "./IDELayout.types";
import { AUX_PANEL_TYPES, INFO_PANEL_TYPES } from "./IDELayout.types";
import { MultiTabTerminalPanel } from "./MultiTabTerminalPanel";
import type { FileNavRequest } from "../../Review";
import { TaskChat } from "../TaskView/TaskChat";
import { TaskCodeReview } from "../TaskView/TaskCodeReview";
import { TaskEditor } from "../TaskView/TaskEditor";
import {
  ArtifactsTab,
  StatsTab,
  GitTab,
  NotesTab,
  CommentsTab,
} from "../TaskInfoPanel/tabs";
import { useConfig, useProject } from "../../../context";

const AUX_PANEL_CONFIG: Record<AuxPanelType, { label: string; icon: typeof Terminal }> = {
  terminal: { label: "Terminal", icon: Terminal },
  editor: { label: "Editor", icon: FileCode },
  review: { label: "Code Review", icon: Code },
  artifacts: { label: "Artifacts", icon: Package },
};

const INFO_PANEL_CONFIG: Record<InfoTabType, { label: string; icon: typeof BarChart3 }> = {
  stats: { label: "Info", icon: BarChart3 },
  git: { label: "Git", icon: GitBranch },
  notes: { label: "Notes", icon: FileText },
  comments: { label: "Comments", icon: MessageSquare },
};

const TOOLBAR_AUX: { type: AuxPanelType; label: string; shortcut: string; icon: typeof Terminal }[] = [
  { type: "terminal", label: "Terminal", shortcut: "t", icon: Terminal },
  { type: "editor", label: "Editor", shortcut: "e", icon: FileCode },
  { type: "review", label: "Code Review", shortcut: "r", icon: Code },
  { type: "artifacts", label: "Artifacts", shortcut: "f", icon: Package },
];

const TOOLBAR_INFO: { type: InfoTabType; label: string; shortcut: string; icon: typeof BarChart3 }[] = [
  { type: "stats", label: "Info", shortcut: "1", icon: BarChart3 },
  { type: "git", label: "Git", shortcut: "2", icon: GitBranch },
  { type: "notes", label: "Notes", shortcut: "3", icon: FileText },
  { type: "comments", label: "Comments", shortcut: "4", icon: MessageSquare },
];

function ideLayoutStorageKey(projectId: string, taskId: string) {
  return `grove-idelayout-${projectId}-${taskId}`;
}

interface PersistedIDEState {
  auxType: AuxPanelType | null;
  auxVisible: boolean;
  chatVisible: boolean;
  infoType: InfoTabType | null;
  infoVisible: boolean;
  terminalTabs: TerminalTab[];
  terminalActiveId: string;
  auxWidth: number;
  infoWidth: number;
}

function loadPersistedState(projectId: string, taskId: string): Partial<PersistedIDEState> {
  try {
    const raw = localStorage.getItem(ideLayoutStorageKey(projectId, taskId));
    if (!raw) return {};
    return JSON.parse(raw) as Partial<PersistedIDEState>;
  } catch {
    return {};
  }
}

function savePersistedState(projectId: string, taskId: string, state: PersistedIDEState) {
  try {
    localStorage.setItem(ideLayoutStorageKey(projectId, taskId), JSON.stringify(state));
  } catch {
    // ignore storage errors
  }
}

function readStoredWidth(fallback: number, persisted?: number): number {
  return typeof persisted === "number" && Number.isFinite(persisted) ? persisted : fallback;
}

function clampWidth(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

interface TerminalTab {
  id: string;
  label: string;
}

interface IDELayoutInternalState {
  auxType: AuxPanelType | null;
  auxVisible: boolean;
  chatVisible: boolean;
  infoType: InfoTabType | null;
  infoVisible: boolean;
  fileNavRequest: FileNavRequest | null;
  artifactPreviewRequest: ArtifactPreviewRequest | null;
  lastChatIdleAt: number | undefined;
  isChatBusy: boolean;
  terminalTabs: TerminalTab[];
  terminalActiveId: string;
}

function Toolbar({
  state,
  update,
  isStudio,
  terminalAvailable,
  chatAvailable,
  leading,
  trailing,
}: {
  state: IDELayoutInternalState;
  update: (partial: Partial<IDELayoutInternalState>) => void;
  isStudio: boolean;
  terminalAvailable: boolean;
  chatAvailable: boolean;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  const hasOpenPanel = state.auxVisible || state.infoVisible;
  const filteredAux = TOOLBAR_AUX.filter(
    ({ type }) =>
      (type !== "artifacts" || isStudio) &&
      (type !== "review" || !isStudio) &&
      (type !== "terminal" || terminalAvailable),
  );
  const filteredInfo = TOOLBAR_INFO.filter(
    ({ type }) => type !== "git" || !isStudio,
  );

  return (
    <div className="ide-toolbar">
      {leading && <div className="ide-toolbar__leading">{leading}</div>}

      {chatAvailable && (
        <>
          <button
            onClick={() =>
              update({ chatVisible: state.chatVisible ? !hasOpenPanel : true })
            }
            disabled={state.chatVisible && !hasOpenPanel}
            className={`ide-toolbar__btn ide-toolbar__btn--chat ${state.chatVisible ? "ide-toolbar__btn--active" : ""}`}
            title={hasOpenPanel ? "Toggle Chat" : "Chat stays visible until another panel is open"}
          >
            <MessageSquare size={13} />
            <span>Chat</span>
          </button>
          <div className="ide-toolbar__separator" />
        </>
      )}

      <div className="ide-toolbar__group">
        {filteredAux.map(({ type, label, shortcut, icon: Icon }) => {
          const isActive = state.auxVisible && state.auxType === type;
          return (
            <button
              key={type}
              onClick={() =>
                isActive
                  ? update({ auxVisible: false })
                  : update({ auxType: type, auxVisible: true })
              }
              className={`ide-toolbar__btn ${isActive ? "ide-toolbar__btn--active" : ""}`}
              title={`${label} (${shortcut})`}
            >
              <Icon size={13} />
              <span>{label}</span>
            </button>
          );
        })}
      </div>

      <div className="ide-toolbar__separator" />

      <div className="ide-toolbar__group">
        {filteredInfo.map(({ type, label, shortcut, icon: Icon }) => {
          const isActive = state.infoVisible && state.infoType === type;
          return (
            <button
              key={type}
              onClick={() =>
                isActive
                  ? update({ infoVisible: false })
                  : update({ infoType: type, infoVisible: true })
              }
              className={`ide-toolbar__btn ${isActive ? "ide-toolbar__btn--active" : ""}`}
              title={`${label} (${shortcut})`}
            >
              <Icon size={13} />
              <span>{label}</span>
            </button>
          );
        })}
      </div>

      {trailing && (
        <>
          <div className="ide-toolbar__spacer" />
          <div className="ide-toolbar__trailing">{trailing}</div>
        </>
      )}
    </div>
  );
}

function PanelSlot({
  title,
  icon: Icon,
  onClose,
  side,
  children,
}: {
  title: string;
  icon: typeof Terminal;
  onClose?: () => void;
  side: "left" | "right";
  children: React.ReactNode;
}) {
  return (
    <div className={`ide-panel-slot ide-panel-slot--${side}`}>
      <div className="ide-panel-slot__header">
        <Icon size={14} className="text-[var(--color-text-muted)]" />
        <span className="ide-panel-slot__title">{title}</span>
        <div className="ide-panel-slot__spacer" />
        {onClose && (
          <div className="ide-panel-slot__actions">
            <button onClick={onClose} title="Close">
              <X size={14} />
            </button>
          </div>
        )}
      </div>
      <div className="ide-panel-slot__body">{children}</div>
    </div>
  );
}

export const IDELayoutContainer = forwardRef<IDELayoutHandle, IDELayoutContainerProps>(
  function IDELayoutContainer({ task, projectId, toolbarLeading, toolbarTrailing }, ref) {
    const { selectedProject } = useProject();
    const { terminalAvailable, chatAvailable } = useConfig();
    const isStudio = selectedProject?.projectType === "studio";
    const isGitRepo = selectedProject?.isGitRepo;

    // Read persisted state once at mount via useState lazy initializer (avoids repeated localStorage reads)
    const [persisted] = useState<Partial<PersistedIDEState>>(() =>
      loadPersistedState(projectId, task.id),
    );

    const [state, setState] = useState<IDELayoutInternalState>(() => {
      const firstTabId = `term-init-${Date.now()}`;
      const terminalTabs = persisted.terminalTabs?.length
        ? persisted.terminalTabs
        : [{ id: firstTabId, label: "Terminal" }];
      const terminalActiveId =
        persisted.terminalActiveId && terminalTabs.some((t) => t.id === persisted.terminalActiveId)
          ? persisted.terminalActiveId
          : terminalTabs[0].id;
      return {
        auxType: persisted.auxType ?? null,
        auxVisible: persisted.auxVisible ?? false,
        chatVisible: persisted.chatVisible ?? true,
        infoType: persisted.infoType ?? null,
        infoVisible: persisted.infoVisible ?? false,
        fileNavRequest: null,
        artifactPreviewRequest: null,
        lastChatIdleAt: undefined,
        isChatBusy: false,
        terminalTabs,
        terminalActiveId,
      };
    });
    const [auxWidth, setAuxWidth] = useState(() => readStoredWidth(520, persisted.auxWidth));
    const [infoWidth, setInfoWidth] = useState(() => readStoredWidth(340, persisted.infoWidth));
    const [auxWasResized, setAuxWasResized] = useState(false);
    const [infoWasResized, setInfoWasResized] = useState(false);
    const navSeqRef = useRef(0);
    const shellRef = useRef<HTMLDivElement>(null);
    // Keep latest state accessible from imperative handle callbacks without
    // invalidating the useImperativeHandle cache on every state change.
    const stateRef = useRef(state);
    useEffect(() => {
      stateRef.current = state;
    }, [state]);

    const update = useCallback(
      (partial: Partial<IDELayoutInternalState>) => {
        setState((prev) => {
          const next = { ...prev, ...partial };
          if (!next.auxVisible && !next.infoVisible && !next.chatVisible) {
            next.chatVisible = true;
          }
          return next;
        });
      },
      [],
    );

    const handleNavigateToFile = useCallback(
      (filePath: string, line?: number, mode?: "diff" | "full") => {
        navSeqRef.current += 1;
        const seq = navSeqRef.current;
        if (isStudio) {
          update({ artifactPreviewRequest: { file: filePath, seq } });
        } else {
          update({ fileNavRequest: { file: filePath, line, mode, seq } });
        }
        if (isStudio) {
          setState((prev) => ({ ...prev, auxType: "artifacts", auxVisible: true }));
        } else {
          setState((prev) => ({ ...prev, auxType: "review", auxVisible: true }));
        }
      },
      [isStudio, update],
    );

    const handleChatBecameIdle = useCallback(() => {
      update({ lastChatIdleAt: Date.now() });
    }, [update]);

    const handleBusyStateChange = useCallback((busy: boolean) => {
      update({ isChatBusy: busy });
    }, [update]);

    const startResize = useCallback((side: "aux" | "info", event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startAuxWidth = auxWidth;
      const startInfoWidth = infoWidth;
      const shellWidth = shellRef.current?.getBoundingClientRect().width ?? window.innerWidth;
      const maxSideWidth = Math.max(320, Math.floor(shellWidth * 0.62));

      const handlePointerMove = (moveEvent: PointerEvent) => {
        if (side === "aux") {
          setAuxWasResized(true);
          const next = clampWidth(startAuxWidth + moveEvent.clientX - startX, 280, maxSideWidth);
          setAuxWidth(next);
        } else {
          setInfoWasResized(true);
          const next = clampWidth(startInfoWidth + startX - moveEvent.clientX, 280, Math.min(maxSideWidth, 760));
          setInfoWidth(next);
        }
      };

      const handlePointerUp = () => {
        document.removeEventListener("pointermove", handlePointerMove);
        document.removeEventListener("pointerup", handlePointerUp);
      };

      document.addEventListener("pointermove", handlePointerMove);
      document.addEventListener("pointerup", handlePointerUp);
    }, [auxWidth, infoWidth]);

    // Persist layout state whenever relevant fields change
    useEffect(() => {
      savePersistedState(projectId, task.id, {
        auxType: state.auxType,
        auxVisible: state.auxVisible,
        chatVisible: state.chatVisible,
        infoType: state.infoType,
        infoVisible: state.infoVisible,
        terminalTabs: state.terminalTabs,
        terminalActiveId: state.terminalActiveId,
        auxWidth: Math.round(auxWidth),
        infoWidth: Math.round(infoWidth),
      });
    }, [
      projectId, task.id,
      state.auxType, state.auxVisible, state.chatVisible,
      state.infoType, state.infoVisible,
      state.terminalTabs, state.terminalActiveId,
      auxWidth, infoWidth,
    ]);

    useImperativeHandle(
      ref,
      () => ({
        focusPanel: (type: AuxPanelType) => {
          setState((prev) => {
            if (prev.auxType === type && prev.auxVisible) return prev;
            return { ...prev, auxType: type, auxVisible: true };
          });
        },
        focusAuxPanel: (type: AuxPanelType) => {
          setState((prev) => ({ ...prev, auxType: type, auxVisible: true }));
        },
        focusInfoPanel: (type: InfoTabType) => {
          setState((prev) => ({ ...prev, infoType: type, infoVisible: true }));
        },
        focusChat: () => {
          setState((prev) => ({ ...prev, chatVisible: true }));
        },
        selectTabByIndex: (index: number) => {
          if (index === 0) {
            setState((prev) => ({ ...prev, chatVisible: true }));
            return "handled" as const;
          }
          const visibleAuxTypes = AUX_PANEL_TYPES.filter((type) =>
            (type !== "artifacts" || isStudio) &&
            (type !== "review" || !isStudio) &&
            (type !== "terminal" || terminalAvailable)
          );
          const visibleInfoTypes = INFO_PANEL_TYPES.filter((type) => type !== "git" || !isStudio);
          if (index >= 1 && index <= visibleAuxTypes.length) {
            const type = visibleAuxTypes[index - 1];
            setState((prev) => ({ ...prev, auxType: type, auxVisible: true }));
            return "handled" as const;
          }
          const infoIndex = index - visibleAuxTypes.length - 1;
          if (infoIndex >= 0 && infoIndex < visibleInfoTypes.length) {
            setState((prev) => ({ ...prev, infoType: visibleInfoTypes[infoIndex], infoVisible: true }));
            return "handled" as const;
          }
          return "out_of_range" as const;
        },
        selectAdjacentTab: (delta: number) => {
          const auxTypes = AUX_PANEL_TYPES.filter((type) =>
            (type !== "artifacts" || isStudio) &&
            (type !== "review" || !isStudio) &&
            (type !== "terminal" || terminalAvailable)
          );
          if (auxTypes.length === 0) return false;
          setState((prev) => {
            if (!prev.auxVisible || !prev.auxType) {
              const idx = delta > 0 ? 0 : auxTypes.length - 1;
              return { ...prev, auxType: auxTypes[idx], auxVisible: true };
            }
            const currentIdx = auxTypes.indexOf(prev.auxType);
            const nextIdx = (currentIdx + delta + auxTypes.length) % auxTypes.length;
            return { ...prev, auxType: auxTypes[nextIdx] };
          });
          return true;
        },
        addTerminalTab: () => {
          const current = stateRef.current;
          const terminalWasOpen =
            current.auxVisible && current.auxType === "terminal";

          // First-time use (user hasn't opened Terminal yet): reuse the
          // auto-created empty tab instead of spawning a second one.
          if (!terminalWasOpen && current.terminalTabs.length > 0) {
            const reusedId = current.terminalTabs[0].id;
            setState((prev) => ({
              ...prev,
              auxType: "terminal",
              auxVisible: true,
              terminalActiveId: reusedId,
            }));
            return reusedId;
          }

          // Terminal is already open — spawn a new tab so we don't clobber
          // whatever the user has running.
          const newId = `term-run-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
          setState((prev) => ({
            ...prev,
            terminalTabs: [...prev.terminalTabs, { id: newId, label: `Terminal (${prev.terminalTabs.length + 1})` }],
            terminalActiveId: newId,
            auxType: "terminal",
            auxVisible: true,
          }));
          return newId;
        },
        closeActiveTab: () => {
          setState((prev) => {
            const next = prev.infoVisible ? { ...prev, infoVisible: false } : { ...prev, auxVisible: false };
            if (!next.auxVisible && !next.infoVisible && !next.chatVisible) {
              next.chatVisible = true;
            }
            return next;
          });
        },
      }),
      [isStudio, terminalAvailable],
    );

    const renderAuxPanel = () => {
      if (!state.auxVisible || !state.auxType) return null;

      // Terminal gets its own multi-tab panel
      if (state.auxType === "terminal" && terminalAvailable) {
        return (
          <MultiTabTerminalPanel
            projectId={projectId}
            task={task}
            side="left"
            tabs={state.terminalTabs}
            activeId={state.terminalActiveId}
            onTabsChange={(tabs, activeId) => update({ terminalTabs: tabs, terminalActiveId: activeId })}
            onClose={() => update({ auxVisible: false })}
          />
        );
      }

      const config = AUX_PANEL_CONFIG[state.auxType];
      return (
        <PanelSlot
          title={config.label}
          icon={config.icon}
          side="left"
          onClose={() => update({ auxVisible: false })}
        >
          {state.auxType === "editor" && (
            <TaskEditor projectId={projectId} taskId={task.id} hideHeader fullscreen onClose={() => update({ auxVisible: false })} />
          )}
          {state.auxType === "review" && !isStudio && (
            <TaskCodeReview
              projectId={projectId} taskId={task.id} navigateToFile={state.fileNavRequest}
              hideHeader fullscreen isGitRepo={isGitRepo} onClose={() => update({ auxVisible: false })}
            />
          )}
          {state.auxType === "artifacts" && isStudio && (
            <ArtifactsTab projectId={projectId} task={task} previewRequest={state.artifactPreviewRequest} lastChatIdleAt={state.lastChatIdleAt} isChatBusy={state.isChatBusy} />
          )}
        </PanelSlot>
      );
    };

    const renderChat = () => {
      if (!chatAvailable && isStudio) {
        return (
          <div className="ide-center-fallback">
            <ArtifactsTab projectId={projectId} task={task} previewRequest={state.artifactPreviewRequest} lastChatIdleAt={state.lastChatIdleAt} isChatBusy={state.isChatBusy} />
          </div>
        );
      }

      if (!chatAvailable) {
        return (
          <div className="ide-center-empty">
            <MessageSquare size={18} />
            <span>Chat is unavailable for this workspace.</span>
          </div>
        );
      }

      return (
        <TaskChat
          projectId={projectId} task={task} fullscreen
          onNavigateToFile={handleNavigateToFile}
          onChatBecameIdle={handleChatBecameIdle}
          onUserMessageSent={handleChatBecameIdle}
          onBusyStateChange={handleBusyStateChange}
        />
      );
    };

    const renderInfoPanel = () => {
      if (!state.infoVisible || !state.infoType) return null;
      const config = INFO_PANEL_CONFIG[state.infoType];
      return (
        <PanelSlot
          title={config.label}
          icon={config.icon}
          side="right"
          onClose={() => update({ infoVisible: false })}
        >
          <div className="ide-info-content">
            {state.infoType === "stats" && <StatsTab projectId={projectId} task={task} />}
            {state.infoType === "git" && !isStudio && <GitTab projectId={projectId} task={task} />}
            {state.infoType === "notes" && <NotesTab projectId={projectId} task={task} />}
            {state.infoType === "comments" && <CommentsTab projectId={projectId} task={task} />}
          </div>
        </PanelSlot>
      );
    };

    const showAux = Boolean(state.auxVisible && state.auxType);
    const showInfo = Boolean(state.infoVisible && state.infoType);
    const showChat = state.chatVisible || (!showAux && !showInfo);
    const isAuxChatPair = showAux && showChat && !showInfo;
    const isChatInfoPair = !showAux && showChat && showInfo;
    const useDefaultAuxPairRatio = isAuxChatPair && !auxWasResized;
    const useDefaultInfoPairRatio = isChatInfoPair && !infoWasResized;
    const auxColumn = useDefaultAuxPairRatio
      ? "minmax(360px, 7fr)"
      : showChat
        ? "minmax(280px, var(--ide-aux-width))"
        : "minmax(360px, 1fr)";
    const chatColumn = useDefaultAuxPairRatio
      ? "minmax(280px, 3fr)"
      : useDefaultInfoPairRatio
        ? "minmax(360px, 6fr)"
        : "minmax(360px, 1fr)";
    const infoColumn = useDefaultInfoPairRatio
      ? "minmax(320px, 4fr)"
      : showChat
        ? "minmax(320px, var(--ide-info-width))"
        : "minmax(360px, 1fr)";
    const gridColumns = [
      showAux ? auxColumn : null,
      showAux && (showChat || showInfo) ? "8px" : null,
      showChat ? chatColumn : null,
      showChat && showInfo ? "8px" : null,
      showInfo ? infoColumn : null,
    ].filter(Boolean).join(" ");
    const toolbar = (
      <Toolbar
        state={state}
        update={update}
        isStudio={isStudio}
        terminalAvailable={terminalAvailable}
        chatAvailable={chatAvailable}
        leading={toolbarLeading}
        trailing={toolbarTrailing}
      />
    );

    return (
      <div className="ide-workbench">
        {toolbar}
        <div
          ref={shellRef}
          className="ide-layout"
          style={{
            "--ide-aux-width": `${auxWidth}px`,
            "--ide-info-width": `${infoWidth}px`,
            gridTemplateColumns: gridColumns,
          } as React.CSSProperties}
        >
          {showAux && renderAuxPanel()}
          {showAux && (showChat || showInfo) && (
            <div className="ide-resizer ide-resizer--aux" onPointerDown={(event) => startResize("aux", event)} />
          )}
          {showChat && (
            <div className="ide-chat-surface">
              {renderChat()}
            </div>
          )}
          {showChat && showInfo && (
            <div className="ide-resizer ide-resizer--info" onPointerDown={(event) => startResize("info", event)} />
          )}
          {showInfo && renderInfoPanel()}
        </div>
      </div>
    );
  },
);
