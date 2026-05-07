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
  Pencil,
  Network,
} from "lucide-react";
import "./ide-layout.css";
import type {
  IDELayoutContainerProps,
  IDELayoutHandle,
  AuxPanelType,
  InfoTabType,
  ArtifactPreviewRequest,
} from "./IDELayout.types";
import { AUX_PANEL_TYPES } from "./IDELayout.types";
import { MultiTabTerminalPanel } from "./MultiTabTerminalPanel";
import type { FileNavRequest } from "../../Review";
import { TaskChat } from "../TaskView/TaskChat";
import { OptionalPerfProfiler } from "../../../perf/profilerShim";
import { TaskCodeReview } from "../TaskView/TaskCodeReview";
import { TaskEditor } from "../TaskView/TaskEditor";
import { TaskGraph } from "../TaskView/TaskGraph";
import {
  ArtifactsTab,
  StatsTab,
  GitTab,
  NotesTab,
  CommentsTab,
} from "../TaskInfoPanel/tabs";
import { SketchPage } from "../../Studio/SketchPage";
import { OPEN_SKETCH_EVENT, type OpenSketchDetail } from "../../ui/sketchChipCache";
import { useConfig, useProject } from "../../../context";
import { useIsMobile } from "../../../hooks";

const AUX_PANEL_CONFIG: Record<AuxPanelType, { label: string; icon: typeof Terminal }> = {
  terminal: { label: "Terminal", icon: Terminal },
  editor: { label: "Editor", icon: FileCode },
  review: { label: "Code Review", icon: Code },
  graph: { label: "Graph", icon: Network },
  artifacts: { label: "Artifacts", icon: Package },
  sketch: { label: "Sketch", icon: Pencil },
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
  { type: "graph", label: "Graph", shortcut: "g", icon: Network },
  { type: "artifacts", label: "Artifacts", shortcut: "f", icon: Package },
  { type: "sketch", label: "Sketch", shortcut: "k", icon: Pencil },
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
  // Keep-alive: panel types the user has opened at least once. Once a type
  // is in this list it stays mounted (hidden via display:none) so re-opening
  // is instant and doesn't re-fetch data.
  visitedAux: AuxPanelType[];
  visitedInfo: InfoTabType[];
}

function Toolbar({
  state,
  update,
  isStudio,
  terminalAvailable,
  isMobile,
  leading,
  trailing,
}: {
  state: IDELayoutInternalState;
  update: (partial: Partial<IDELayoutInternalState>) => void;
  isStudio: boolean;
  terminalAvailable: boolean;
  isMobile: boolean;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  const hasOpenPanel = state.auxVisible || state.infoVisible;
  const filteredAux = TOOLBAR_AUX.filter(
    ({ type }) =>
      (type !== "artifacts" || isStudio) &&
      (type !== "sketch" || isStudio) &&
      (type !== "review" || !isStudio) &&
      (type !== "terminal" || terminalAvailable),
  );
  const filteredInfo = TOOLBAR_INFO.filter(
    ({ type }) =>
      (type !== "git" || !isStudio) &&
      (type !== "comments" || !isStudio),
  );

  return (
    <div className="ide-toolbar">
      {leading && <div className="ide-toolbar__leading">{leading}</div>}

      <button
        onClick={() => {
          if (isMobile) {
            update({ chatVisible: true, auxVisible: false, infoVisible: false });
          } else {
            update({ chatVisible: state.chatVisible ? !hasOpenPanel : true });
          }
        }}
        disabled={!isMobile && state.chatVisible && !hasOpenPanel}
        className={`ide-toolbar__btn ide-toolbar__btn--chat ${state.chatVisible && !state.auxVisible && !state.infoVisible ? "ide-toolbar__btn--active" : (state.chatVisible && !isMobile ? "ide-toolbar__btn--active" : "")}`}
        title={hasOpenPanel ? "Toggle Chat" : "Chat stays visible until another panel is open"}
      >
        <MessageSquare size={13} />
        <span>Chat</span>
      </button>
      <div className="ide-toolbar__separator" />

      <div className="ide-toolbar__group">
        {filteredAux.map(({ type, label, shortcut, icon: Icon }) => {
          const isActive = state.auxVisible && state.auxType === type;
          return (
            <button
              key={type}
              onClick={() => {
                if (isMobile) {
                  if (isActive) {
                    update({ auxVisible: false, chatVisible: true });
                  } else {
                    update({ auxType: type, auxVisible: true, chatVisible: false, infoVisible: false });
                  }
                } else {
                  if (isActive) update({ auxVisible: false });
                  else update({ auxType: type, auxVisible: true });
                }
              }}
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
              onClick={() => {
                if (isMobile) {
                  if (isActive) {
                    update({ infoVisible: false, chatVisible: true });
                  } else {
                    update({ infoType: type, infoVisible: true, chatVisible: false, auxVisible: false });
                  }
                } else {
                  if (isActive) update({ infoVisible: false });
                  else update({ infoType: type, infoVisible: true });
                }
              }}
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
    const { terminalAvailable } = useConfig();
    const { isMobile } = useIsMobile();
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
        visitedAux: persisted.auxType ? [persisted.auxType] : [],
        visitedInfo: persisted.infoType ? [persisted.infoType] : [],
      };
    });
    const [auxWidth, setAuxWidth] = useState(() => readStoredWidth(520, persisted.auxWidth));
    const [infoWidth, setInfoWidth] = useState(() => readStoredWidth(340, persisted.infoWidth));
    const [auxWasResized, setAuxWasResized] = useState(false);
    const [infoWasResized, setInfoWasResized] = useState(false);
    const navSeqRef = useRef(0);
    const shellRef = useRef<HTMLDivElement>(null);
    // Tracks which side panel was most recently focused so Cmd+W /
    // closeActiveTab closes *that* one instead of always preferring info.
    // Defaults to "info" so behavior matches the previous hardcoded rule
    // until the user explicitly interacts with the aux panel.
    const lastFocusedSideRef = useRef<"aux" | "info">("info");
    // Keep latest state accessible from imperative handle callbacks without
    // invalidating the useImperativeHandle cache on every state change.
    const stateRef = useRef(state);
    useEffect(() => {
      stateRef.current = state;
    }, [state]);

    // Wrap setState so every state transition tags the active panel as
    // "visited" — once visited a panel stays mounted (display:none when
    // hidden) so re-opening is instant and doesn't refetch data.
    const setStateTagged = useCallback(
      (updater: (prev: IDELayoutInternalState) => IDELayoutInternalState) => {
        setState((prev) => {
          const next = updater(prev);
          let visitedAux = next.visitedAux;
          let visitedInfo = next.visitedInfo;
          if (next.auxVisible && next.auxType && !visitedAux.includes(next.auxType)) {
            visitedAux = [...visitedAux, next.auxType];
          }
          if (next.infoVisible && next.infoType && !visitedInfo.includes(next.infoType)) {
            visitedInfo = [...visitedInfo, next.infoType];
          }
          return visitedAux === next.visitedAux && visitedInfo === next.visitedInfo
            ? next
            : { ...next, visitedAux, visitedInfo };
        });
      },
      [],
    );

    const update = useCallback(
      (partial: Partial<IDELayoutInternalState>) => {
        setStateTagged((prev) => {
          const next = { ...prev, ...partial };
          if (!next.auxVisible && !next.infoVisible && !next.chatVisible) {
            next.chatVisible = true;
          }
          return next;
        });
      },
      [setStateTagged],
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
          setStateTagged((prev) => ({ ...prev, auxType: "artifacts", auxVisible: true }));
        } else {
          setStateTagged((prev) => ({ ...prev, auxType: "review", auxVisible: true }));
        }
      },
      [isStudio, update, setStateTagged],
    );

    const handleChatBecameIdle = useCallback(() => {
      update({ lastChatIdleAt: Date.now() });
    }, [update]);

    // Global listener: a SketchChip click dispatches OPEN_SKETCH_EVENT. When
    // the target task is this one, open the Sketch aux panel so the chip
    // feels like navigation. Only Studio tasks have a sketch panel.
    useEffect(() => {
      if (!isStudio) return;
      const handler = (e: Event) => {
        const detail = (e as CustomEvent<OpenSketchDetail>).detail;
        if (!detail) return;
        if (detail.projectId !== projectId || detail.taskId !== task.id) return;
        setStateTagged((prev) => {
          if (prev.auxVisible && prev.auxType === "sketch") return prev;
          return { ...prev, auxType: "sketch", auxVisible: true };
        });
      };
      window.addEventListener(OPEN_SKETCH_EVENT, handler);
      return () => window.removeEventListener(OPEN_SKETCH_EVENT, handler);
    }, [isStudio, projectId, task.id, setStateTagged]);

    useEffect(() => {
      const handler = (e: Event) => {
        const detail = (e as CustomEvent<{ chatId?: string }>).detail;
        update({ chatVisible: true });
        if (detail?.chatId) {
          setTimeout(() => {
            window.dispatchEvent(
              new CustomEvent("grove:select-chat", { detail: { chatId: detail.chatId } }),
            );
          }, 100);
        }
      };
      window.addEventListener("grove:open-chat", handler);
      return () => window.removeEventListener("grove:open-chat", handler);
    }, [update]);

    const handleBusyStateChange = useCallback((busy: boolean) => {
      update({ isChatBusy: busy });
    }, [update]);

    const startResize = useCallback((side: "aux" | "info", event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const shellWidth = shellRef.current?.getBoundingClientRect().width ?? window.innerWidth;
      const maxSideWidth = Math.max(320, Math.floor(shellWidth * 0.62));

      // Use the actually-rendered panel width as the baseline. When the layout
      // is using the default fr-ratio (auxWasResized/infoWasResized = false),
      // auxWidth/infoWidth state doesn't match the visible width, so starting
      // from the state value would cause the panel to jump on first drag.
      // The aux/info side is wrapped in a `display: contents` div, which has
      // no layout box (getBoundingClientRect returns 0). Drill into the first
      // child (or fall back to the sibling itself for non-wrapped panels like
      // chat/terminal).
      const measureSibling = (el: Element | null): number | null => {
        if (!el) return null;
        const node = el as HTMLElement;
        const rect = node.getBoundingClientRect();
        if (rect.width > 0) return rect.width;
        const child = node.firstElementChild as HTMLElement | null;
        return child ? child.getBoundingClientRect().width : null;
      };
      const resizerEl = event.currentTarget;
      const startAuxWidth =
        side === "aux"
          ? measureSibling(resizerEl.previousElementSibling) ?? auxWidth
          : auxWidth;
      const startInfoWidth =
        side === "info"
          ? measureSibling(resizerEl.nextElementSibling) ?? infoWidth
          : infoWidth;

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
          setStateTagged((prev) => {
            if (prev.auxType === type && prev.auxVisible) return prev;
            return { ...prev, auxType: type, auxVisible: true };
          });
        },
        focusAuxPanel: (type: AuxPanelType) => {
          // Toggle semantics — matches the toolbar button (`isActive ? hide :
          // show`). Pressing the same shortcut twice closes the panel the
          // user just opened, which is what shortcut hotkeys are expected to
          // do in every IDE.
          setStateTagged((prev) =>
            prev.auxVisible && prev.auxType === type
              ? { ...prev, auxVisible: false }
              : { ...prev, auxType: type, auxVisible: true },
          );
        },
        focusInfoPanel: (type: InfoTabType) => {
          setStateTagged((prev) =>
            prev.infoVisible && prev.infoType === type
              ? { ...prev, infoVisible: false }
              : { ...prev, infoType: type, infoVisible: true },
          );
        },
        focusChat: () => {
          // Same toggle rule for Chat: pressing `i` again hides it unless
          // that would leave the workbench with no visible surface (no aux,
          // no info), in which case we force it to stay visible.
          setStateTagged((prev) => {
            if (!prev.chatVisible) return { ...prev, chatVisible: true };
            const hasOtherSurface =
              (prev.auxVisible && !!prev.auxType) || (prev.infoVisible && !!prev.infoType);
            if (!hasOtherSurface) return prev;
            return { ...prev, chatVisible: false };
          });
        },
        selectTabByIndex: () => {
          // IDE Layout has no tab concept — Cmd+1..9 should fall through to
          // the outer sidebar navigation instead of trying to focus an aux
          // panel. Returning "no_tabs" tells TasksPage's Cmd+1..9 handler to
          // delegate to onNavByIndex.
          return "no_tabs" as const;
        },
        selectAdjacentTab: (delta: number) => {
          const auxTypes = AUX_PANEL_TYPES.filter((type) =>
            (type !== "artifacts" || isStudio) &&
            (type !== "sketch" || isStudio) &&
            (type !== "review" || !isStudio) &&
            (type !== "terminal" || terminalAvailable)
          );
          if (auxTypes.length === 0) return false;
          setStateTagged((prev) => {
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
            setStateTagged((prev) => ({
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
          setStateTagged((prev) => ({
            ...prev,
            terminalTabs: [...prev.terminalTabs, { id: newId, label: `Terminal (${prev.terminalTabs.length + 1})` }],
            terminalActiveId: newId,
            auxType: "terminal",
            auxVisible: true,
          }));
          return newId;
        },
        closeActiveTab: () => {
          setStateTagged((prev) => {
            // Prefer closing the side that was most recently focused. Fall
            // back to whichever side is visible if the recorded side isn't.
            const preferAux =
              (lastFocusedSideRef.current === "aux" && prev.auxVisible) ||
              (lastFocusedSideRef.current === "info" && !prev.infoVisible && prev.auxVisible);
            const next = preferAux
              ? { ...prev, auxVisible: false }
              : prev.infoVisible
                ? { ...prev, infoVisible: false }
                : { ...prev, auxVisible: false };
            if (!next.auxVisible && !next.infoVisible && !next.chatVisible) {
              next.chatVisible = true;
            }
            return next;
          });
        },
      }),
      [isStudio, terminalAvailable, setStateTagged],
    );

    // Render content for a single aux panel type. Caller wraps this in a
    // pane div whose display toggles between "flex" (active) and "none"
    // (hidden but mounted, so state survives a close/reopen cycle).
    const renderAuxContent = (type: AuxPanelType) => {
      if (type === "terminal" && terminalAvailable) {
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
      const config = AUX_PANEL_CONFIG[type];
      return (
        <PanelSlot
          title={config.label}
          icon={config.icon}
          side="left"
          onClose={() => update({ auxVisible: false })}
        >
          {type === "editor" && (
            <TaskEditor projectId={projectId} taskId={task.id} hideHeader fullscreen onClose={() => update({ auxVisible: false })} />
          )}
          {type === "graph" && (
            <TaskGraph projectId={projectId} taskId={task.id} />
          )}
          {type === "review" && !isStudio && (
            <TaskCodeReview
              projectId={projectId} taskId={task.id} navigateToFile={state.fileNavRequest}
              hideHeader fullscreen isGitRepo={isGitRepo} onClose={() => update({ auxVisible: false })}
            />
          )}
          {type === "artifacts" && isStudio && (
            <ArtifactsTab projectId={projectId} task={task} previewRequest={state.artifactPreviewRequest} lastChatIdleAt={state.lastChatIdleAt} isChatBusy={state.isChatBusy} />
          )}
          {type === "sketch" && isStudio && (
            <SketchPage
              projectId={projectId}
              taskId={task.id}
              isChatBusy={state.isChatBusy}
              lastChatIdleAt={state.lastChatIdleAt}
            />
          )}
        </PanelSlot>
      );
    };

    const renderChat = () => {
      return (
        <OptionalPerfProfiler id="TaskChat">
          <TaskChat
            projectId={projectId} task={task} fullscreen
            onNavigateToFile={handleNavigateToFile}
            onChatBecameIdle={handleChatBecameIdle}
            onUserMessageSent={handleChatBecameIdle}
            onBusyStateChange={handleBusyStateChange}
          />
        </OptionalPerfProfiler>
      );
    };

    const renderInfoContent = (type: InfoTabType) => {
      const config = INFO_PANEL_CONFIG[type];
      return (
        <PanelSlot
          title={config.label}
          icon={config.icon}
          side="right"
          onClose={() => update({ infoVisible: false })}
        >
          <div className="ide-info-content">
            {type === "stats" && <StatsTab projectId={projectId} task={task} />}
            {type === "git" && !isStudio && <GitTab projectId={projectId} task={task} />}
            {type === "notes" && <NotesTab projectId={projectId} task={task} />}
            {type === "comments" && !isStudio && <CommentsTab projectId={projectId} task={task} />}
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
        isMobile={isMobile}
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
          {state.visitedAux.length > 0 && (
            <div
              className="ide-aux-host"
              style={{ display: showAux ? "flex" : "none" }}
              onFocusCapture={() => { lastFocusedSideRef.current = "aux"; }}
              onMouseDownCapture={() => { lastFocusedSideRef.current = "aux"; }}
            >
              {state.visitedAux.map((type) => {
                const isActive = state.auxType === type;
                return (
                  <div
                    key={type}
                    className="ide-aux-pane"
                    style={{ display: isActive ? "flex" : "none" }}
                  >
                    {renderAuxContent(type)}
                  </div>
                );
              })}
            </div>
          )}
          {showAux && (showChat || showInfo) && (
            <div className="ide-resizer ide-resizer--aux" onPointerDown={(event) => startResize("aux", event)} />
          )}
          <div
            className="ide-chat-surface"
            style={{ display: showChat ? "block" : "none" }}
          >
            {renderChat()}
          </div>
          {showChat && showInfo && (
            <div className="ide-resizer ide-resizer--info" onPointerDown={(event) => startResize("info", event)} />
          )}
          {state.visitedInfo.length > 0 && (
            <div
              className="ide-info-host"
              style={{ display: showInfo ? "flex" : "none" }}
              onFocusCapture={() => { lastFocusedSideRef.current = "info"; }}
              onMouseDownCapture={() => { lastFocusedSideRef.current = "info"; }}
            >
              {state.visitedInfo.map((type) => {
                const isActive = state.infoType === type;
                return (
                  <div
                    key={type}
                    className="ide-info-pane"
                    style={{ display: isActive ? "flex" : "none" }}
                  >
                    {renderInfoContent(type)}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  },
);
