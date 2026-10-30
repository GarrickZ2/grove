import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  Bell, Blocks, Brain, BarChart2, ChevronDown, Folder, FolderOpen,
  LayoutDashboard, Layers, MonitorSmartphone, MoreHorizontal, PanelLeftClose, PanelLeftOpen,
  Plus, Repeat, Search, Settings, Sparkles, SquarePen, Pencil, Archive, Trash2, ArrowUp, ArrowDown, Pin, PinOff,
} from "lucide-react";
import { listChats, renameTask, archiveTask, deleteTask, archiveChat, deleteChat, updateChatTitle, setChatPinned } from "../../api";
import type { ChatSessionResponse } from "../../api/tasks";
import type { NodeStatus } from "../../api/walkieTalkie";
import { useNotifications, useProject, useTheme } from "../../context";
import { useRadioEvents } from "../../hooks";
import { useIsMobile } from "../../hooks/useIsMobile";
import { useTaskReorder } from "../../hooks/useTaskReorder";
import { refreshRadioActivity } from "../../hooks/useRadioEvents";
import { appIconAssetUrl } from "../../data/appIcons";
import { DropdownMenu } from "../ui/DropdownMenu";
import { DialogShell } from "../ui/DialogShell";
import { ConfirmDialog } from "../Dialogs";
import { buildArchiveConfirmMessage, handleArchiveError, type PendingArchiveConfirm } from "../../utils/archiveHelpers";
import { OrbitNotificationPopover } from "./OrbitNotificationPopover";
import { OrbitProjectSelector } from "./OrbitProjectSelector";
import { LogoBrand } from "./LogoBrand";
import { useGlobalActiveChatId } from "../Tasks/TaskView/useActiveChatId";
import { promoteSession } from "../Tasks/TaskView/sessionListState";
import { ArchivedDialog, type ArchivedScope } from "../Archived/ArchivedDialog";
import { sessionActivityReducer, type SessionActivityState } from "./orbitSessionActivity";
import "./orbit-sidebar.css";

interface OrbitSidebarProps {
  activeItem: string;
  /** "drawer": the phone's slide-out sidebar. "overlay": opened over the workspace on a narrow window. */
  variant?: "drawer" | "overlay";
  collapsed: boolean;
  onCollapse: () => void;
  onItemClick: (item: string) => void;
  onNavigate: (page: string, data?: Record<string, unknown>) => void;
  onSearch: () => void;
  onProjectSwitch: (projectId?: string) => void;
  onManageProjects: (tab?: "coding" | "studio") => void;
  onAddProject: (studioMode?: "studio") => void;
}

type Selection = { projectId: string; taskId: string; chatId: string };
type Target = { kind: "task" | "session"; projectId: string; taskId: string; name: string; chatId?: string };

type ExpansionState = { sessions: boolean; tasks: boolean; expandedTasks: string[] };
const defaultExpansion: ExpansionState = { sessions: true, tasks: true, expandedTasks: [] };
const expansionKey = (projectId: string) => `grove:orbit-sidebar-expansion:${projectId}`;

function readExpansion(projectId: string): ExpansionState {
  try {
    const value = JSON.parse(localStorage.getItem(expansionKey(projectId)) ?? "null");
    if (!value || typeof value !== "object") return defaultExpansion;
    return {
      sessions: typeof value.sessions === "boolean" ? value.sessions : true,
      tasks: typeof value.tasks === "boolean" ? value.tasks : true,
      expandedTasks: Array.isArray(value.expandedTasks) ? value.expandedTasks.filter((id: unknown): id is string => typeof id === "string") : [],
    };
  } catch {
    return defaultExpansion;
  }
}

export function OrbitSidebar({ activeItem, variant, collapsed, onCollapse, onItemClick, onNavigate, onSearch, onProjectSwitch, onManageProjects, onAddProject }: OrbitSidebarProps) {
  const { selectedProject, refreshSelectedProject } = useProject();
  const { theme, appIcon } = useTheme();
  const { unreadCount } = useNotifications();
  const activeChatId = useGlobalActiveChatId();
  const [notificationOpen, setNotificationOpen] = useState(false);
  const [expansionByProject, setExpansionByProject] = useState<Record<string, ExpansionState>>({});
  const [moreExpanded, setMoreExpanded] = useState(false);
  const [sessions, setSessions] = useState<Record<string, ChatSessionResponse[]>>({});
  const sessionRefreshGeneration = useRef<Record<string, number>>({});
  const [activity, dispatchActivity] = useReducer(sessionActivityReducer, {});
  const [selection, setSelection] = useState<Selection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<Target | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Target | null>(null);
  const [pendingArchive, setPendingArchive] = useState<PendingArchiveConfirm | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [archivedScope, setArchivedScope] = useState<ArchivedScope | null>(null);
  const projectId = selectedProject?.id;
  // Selection can outlive the visible chat panel (e.g. while reviewing code).
  // Only the visible chat on the current page counts as having been read.
  const viewedChatId = activeItem === "tasks" || activeItem === "work" ? activeChatId : null;
  const viewed = projectId && viewedChatId ? { projectId, chatId: viewedChatId } : null;
  useEffect(() => {
    if (projectId && viewedChatId) dispatchActivity({ type: "viewed", viewed: { projectId, chatId: viewedChatId } });
  }, [projectId, viewedChatId]);
  const expansion = projectId ? expansionByProject[projectId] ?? readExpansion(projectId) : defaultExpansion;
  const { sessions: sessionsExpanded, tasks: tasksExpanded, expandedTasks } = expansion;
  const updateExpansion = (next: ExpansionState) => {
    if (!projectId) return;
    setExpansionByProject((previous) => ({ ...previous, [projectId]: next }));
    try { localStorage.setItem(expansionKey(projectId), JSON.stringify(next)); } catch { /* Storage may be unavailable. */ }
    window.dispatchEvent(new CustomEvent("grove:orbit-sidebar-expansion", { detail: { projectId, expansion: next } }));
  };
  useEffect(() => {
    const sync = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId: string; expansion: ExpansionState }>).detail;
      if (detail) setExpansionByProject((previous) => ({ ...previous, [detail.projectId]: detail.expansion }));
    };
    const syncStorage = (event: StorageEvent) => {
      if (projectId && event.key === expansionKey(projectId)) {
        setExpansionByProject((previous) => ({ ...previous, [projectId]: readExpansion(projectId) }));
      }
    };
    window.addEventListener("grove:orbit-sidebar-expansion", sync);
    window.addEventListener("storage", syncStorage);
    return () => { window.removeEventListener("grove:orbit-sidebar-expansion", sync); window.removeEventListener("storage", syncStorage); };
  }, [projectId]);
  const ready = !!selectedProject && selectedProject.taskCount === undefined && !!selectedProject.localTask;
  const tasks = useMemo(() => selectedProject?.tasks.filter((task) => task.status !== "archived") ?? [], [selectedProject]);
  const taskIds = useMemo(() => ready ? ["_local", ...tasks.map((task) => task.id)] : [], [ready, tasks]);
  const taskKey = taskIds.join("\u0000");
  const { isTouchDevice } = useIsMobile();
  const reorder = useTaskReorder(projectId, tasks, refreshSelectedProject, setError);

  const refreshSessions = useCallback(async (pid: string, tid: string) => {
    const key = `${pid}:${tid}`;
    const generation = (sessionRefreshGeneration.current[key] ?? 0) + 1;
    sessionRefreshGeneration.current[key] = generation;
    try {
      const chats = await listChats(pid, tid);
      if (sessionRefreshGeneration.current[key] !== generation) return;
      setSessions((previous) => ({ ...previous, [key]: chats }));
    } catch (err) {
      if (sessionRefreshGeneration.current[key] !== generation) return;
      console.error("Failed to load Orbit sessions", err);
      setError("Could not load sessions. Try refreshing the project.");
    }
  }, []);
  useEffect(() => {
    if (!projectId) return;
    void Promise.resolve().then(() => {
      for (const tid of taskKey.split("\u0000").filter(Boolean)) void refreshSessions(projectId, tid);
    });
  }, [projectId, taskKey, refreshSessions]);
  useEffect(() => {
    const onActivity = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId: string; taskId: string; chatId: string }>).detail;
      if (!detail || detail.projectId !== projectId) return;
      const key = `${detail.projectId}:${detail.taskId}`;
      sessionRefreshGeneration.current[key] = (sessionRefreshGeneration.current[key] ?? 0) + 1;
      setSessions((previous) => previous[key] ? { ...previous, [key]: promoteSession(previous[key], detail.chatId) } : previous);
    };
    window.addEventListener("grove:session-local-activity", onActivity);
    return () => window.removeEventListener("grove:session-local-activity", onActivity);
  }, [projectId]);
  useRadioEvents({
    onEvent: (event) => {
      if (!event || typeof event !== "object" || !("type" in event)) return;
      if (event.type === "chat_input_status" && "project_id" in event && typeof event.project_id === "string" && "task_id" in event && typeof event.task_id === "string" && "chat_id" in event && typeof event.chat_id === "string" && "waiting_for_input" in event && typeof event.waiting_for_input === "boolean") {
        dispatchActivity({ type: "input", key: `${event.project_id}:${event.task_id}:${event.chat_id}`, projectId: event.project_id, chatId: event.chat_id, waiting: event.waiting_for_input });
        return;
      }
      if (event.type !== "activity_snapshot" || !("chats" in event) || !Array.isArray(event.chats)) return;
      const next: SessionActivityState = {};
      for (const chat of event.chats) {
        if (typeof chat.project_id === "string" && typeof chat.task_id === "string" && typeof chat.chat_id === "string" && ["connecting", "idle", "busy", "permission_required", "disconnected"].includes(chat.status)) {
          next[`${chat.project_id}:${chat.task_id}:${chat.chat_id}`] = { projectId: chat.project_id, chatId: chat.chat_id, status: chat.status as NodeStatus, waitingForInput: chat.waiting_for_input === true, unreadCompletion: false };
        }
      }
      dispatchActivity({ type: "snapshot", chats: next, viewed });
    },
    onChatListChanged: (pid, tid) => { if (pid === projectId) void refreshSessions(pid, tid); },
    onConnected: () => { if (projectId) for (const tid of taskIds) void refreshSessions(projectId, tid); },
    onChatStatus: (pid, tid, cid, status) => {
      dispatchActivity({ type: "status", key: `${pid}:${tid}:${cid}`, projectId: pid, chatId: cid, status, viewed });
    },
  });
  useEffect(() => { if (projectId) refreshRadioActivity(); }, [projectId]);

  const openChat = (taskId: string, chatId: string) => {
    if (!projectId) return;
    setSelection({ projectId, taskId, chatId });
    onNavigate("tasks", { taskId, chatId, viewMode: "terminal" });
  };
  // The Session is created by the New page on first send, with the Agent and
  // config chosen there — not here.
  const newChat = (taskId: string) => {
    if (!projectId || !ready) return;
    setSelection(null);
    onNavigate("new", { taskId });
  };
  const showError = (message: string) => setError(message);
  const beginRename = (target: Target) => { setRenameValue(target.name); setRenameTarget(target); };
  useEffect(() => {
    const rename = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId: string; taskId: string; chatId: string; name: string }>).detail;
      if (detail?.projectId === projectId) beginRename({ kind: "session", ...detail });
    };
    window.addEventListener("grove:orbit-rename-session", rename);
    return () => window.removeEventListener("grove:orbit-rename-session", rename);
  }, [projectId]);
  const saveRename = async () => {
    if (!projectId || !renameTarget || !renameValue.trim() || actionPending) return;
    if (renameTarget.projectId !== projectId) { setRenameTarget(null); showError("Project changed. Please try again."); return; }
    setActionPending(true);
    try {
      if (renameTarget.kind === "task") {
        await renameTask(projectId, renameTarget.taskId, renameValue.trim());
        await refreshSelectedProject();
      } else if (renameTarget.chatId) {
        await updateChatTitle(projectId, renameTarget.taskId, renameTarget.chatId, renameValue.trim());
        await refreshSessions(projectId, renameTarget.taskId);
      }
      setRenameTarget(null);
      setError(null);
    } catch (err) { showError((err as { message?: string })?.message || "Could not rename. Please try again."); }
    finally { setActionPending(false); }
  };
  const afterSessionRemoval = async (taskId: string, chatId: string) => {
    const remaining = (sessions[`${projectId}:${taskId}`] ?? []).filter((session) => session.id !== chatId);
    await refreshSessions(projectId!, taskId);
    const currentChat = (window as Window & { __groveActiveChatId?: string | null }).__groveActiveChatId;
    if (remaining.length && (activeChatId === chatId || currentChat === chatId || selection?.chatId === chatId)) openChat(taskId, remaining[0].id);
  };
  const taskIsOpen = (taskId: string) => {
    if (activeItem !== "tasks") return false;
    const currentChat = activeChatId ?? (window as Window & { __groveActiveChatId?: string | null }).__groveActiveChatId;
    return (selection != null && selection.projectId === projectId && selection.taskId === taskId) || (!!currentChat && (sessions[`${projectId}:${taskId}`] ?? []).some((chat) => chat.id === currentChat));
  };
  const archiveTarget = async (target: Target) => {
    if (!projectId || target.projectId !== projectId) return;
    try {
      if (target.kind === "task") {
        await archiveTask(projectId, target.taskId);
        await refreshSelectedProject();
        if (taskIsOpen(target.taskId)) onNavigate("dashboard");
      } else if (target.chatId) {
        await archiveChat(projectId, target.taskId, target.chatId);
        await afterSessionRemoval(target.taskId, target.chatId);
      }
      setError(null);
    } catch (err) {
      if (target.kind === "task") handleArchiveError(err, projectId, target.taskId, target.name, "normal", buildArchiveConfirmMessage, setPendingArchive, showError);
      else showError((err as { message?: string })?.message || "Could not archive session.");
    }
  };
  const confirmArchive = async () => {
    if (!pendingArchive || actionPending) return;
    setActionPending(true);
    try {
      await archiveTask(pendingArchive.projectId, pendingArchive.taskId, { force: true });
      await refreshSelectedProject();
      if (pendingArchive.projectId === projectId && taskIsOpen(pendingArchive.taskId)) onNavigate("dashboard");
      setPendingArchive(null); setError(null);
    } catch (err) { showError((err as { message?: string })?.message || "Could not archive task."); setPendingArchive(null); }
    finally { setActionPending(false); }
  };
  const confirmDelete = async () => {
    if (!projectId || !deleteTarget || actionPending) return;
    if (deleteTarget.projectId !== projectId) { setDeleteTarget(null); showError("Project changed. Please try again."); return; }
    setActionPending(true);
    try {
      if (deleteTarget.kind === "task") {
        await deleteTask(projectId, deleteTarget.taskId);
        await refreshSelectedProject();
        if (taskIsOpen(deleteTarget.taskId)) onNavigate("dashboard");
      } else if (deleteTarget.chatId) {
        await deleteChat(projectId, deleteTarget.taskId, deleteTarget.chatId, "grove");
        await afterSessionRemoval(deleteTarget.taskId, deleteTarget.chatId);
      }
      setDeleteTarget(null); setError(null);
    } catch (err) { showError((err as { message?: string })?.message || "Could not delete. Please try again."); setDeleteTarget(null); }
    finally { setActionPending(false); }
  };
  const navigation = [
    { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
    ...(selectedProject?.projectType === "studio" ? [{ id: "resource", label: "Studio", icon: Layers }] : []),
    { id: "memory", label: "Memory", icon: Brain },
    { id: "skills", label: "Extensions", icon: Blocks },
  ];
  const moreNavigation = [
    { id: "automation", label: "Automation", icon: Repeat },
    { id: "ai", label: "AI", icon: Sparkles },
    { id: "statistics", label: "Statistics", icon: BarChart2 },
  ];
  const moreOpen = moreExpanded || moreNavigation.some(({ id }) => id === activeItem);
  const renderNavRow = ({ id, label, icon: Icon }: (typeof navigation)[number]) => <button type="button" key={id} className={`orbit-row orbit-nav-row${activeItem === id ? " is-selected" : ""}`} onClick={() => onItemClick(id)}><Icon size={16} strokeWidth={1.6} /><span>{label}</span></button>;
  const drawer = variant === "drawer";
  const hasMacControls = typeof window !== "undefined" && ("__TAURI__" in window || "__TAURI_INTERNALS__" in window) && /Mac/i.test(navigator.platform);
  const togglePinned = async (taskId: string, chat: ChatSessionResponse) => {
    if (!projectId) return;
    try {
      await setChatPinned(projectId, taskId, chat.id, !chat.pinned);
      await refreshSessions(projectId, taskId);
      setError(null);
    } catch (err) { showError((err as { message?: string })?.message || "Could not update the pin."); }
  };
  const renderSessions = (taskId: string) => (sessions[`${projectId}:${taskId}`] ?? []).map((chat) => {
    const sessionActivity = activity[`${projectId}:${taskId}:${chat.id}`];
    const status = sessionActivity?.status;
    const waiting = status === "permission_required" || sessionActivity?.waitingForInput;
    const isViewed = viewedChatId === chat.id;
    const indicator = waiting ? (isViewed ? null : "waiting")
      : status === "busy" || status === "connecting" ? status
      : sessionActivity?.unreadCompletion && !isViewed ? "completed" : null;
    const indicatorLabel = indicator === "waiting" ? "Waiting for your input" : indicator === "completed" ? "Completed — unread" : indicator;
    const isRunning = status === "busy" || status === "permission_required" || status === "connecting";
    const onlySession = (sessions[`${projectId}:${taskId}`] ?? []).length <= 1;
    const selected = (activeItem === "tasks" || activeItem === "work") && (activeChatId ? activeChatId === chat.id : selection?.projectId === projectId && selection?.taskId === taskId && selection?.chatId === chat.id);
    const target: Target = { kind: "session", projectId: projectId ?? "", taskId, chatId: chat.id, name: chat.title || "Untitled session" };
    return (
      <div key={chat.id} className={`orbit-session-row${selected ? " is-selected" : ""}${chat.pinned ? " is-pinned" : ""}`}>
        <button type="button" title={chat.title} onClick={() => openChat(taskId, chat.id)} className={`orbit-row orbit-session${taskId === "_local" ? "" : " orbit-session-nested"}`}>
          <span className="orbit-truncate">{chat.title || "New Chat"}</span>
          {indicator && <span className={`orbit-status${indicator === "waiting" ? " is-waiting" : indicator === "completed" ? " is-completed" : ""}`} title={indicatorLabel ?? undefined} aria-label={indicatorLabel ?? undefined} />}
        </button>
        <button type="button" className="orbit-session-pin" title={chat.pinned ? "Unpin" : "Pin to top"} aria-label={chat.pinned ? `Unpin ${target.name}` : `Pin ${target.name} to top`} aria-pressed={!!chat.pinned} onClick={() => void togglePinned(taskId, chat)}>
          <Pin size={14} strokeWidth={1.7} className="orbit-pin-icon" /><PinOff size={14} strokeWidth={1.7} className="orbit-unpin-icon" />
        </button>
        <div className="orbit-row-menu">
          <div className="orbit-session-fallback"><DropdownMenu portal compact appearance="orbit" placement="bottom" ariaLabel={`More actions for ${target.name}`} triggerClassName="orbit-more-button" items={[
            { id: "rename", label: "Rename", icon: Pencil, onClick: () => beginRename(target) },
            { id: "archive", label: "Archive", icon: Archive, disabled: onlySession || isRunning, onClick: () => void archiveTarget(target) },
            { id: "delete", label: "Delete", icon: Trash2, variant: "danger", dividerBefore: true, disabled: onlySession || isRunning, onClick: () => setDeleteTarget(target) },
          ]} /></div>
          <div className="orbit-session-live-slot" id={`orbit-session-menu-${chat.id}`} />
        </div>
      </div>
    );
  });

  return (
    <aside className={`orbit-sidebar${collapsed ? " is-collapsed" : ""}${hasMacControls ? " has-mac-controls" : ""}${variant ? ` is-${variant}` : ""}`} aria-label="Orbit sidebar">
      {/* A narrowed macOS window: the drawer's header starts below the traffic lights, on a strip that drags the window. */}
      {drawer && hasMacControls && <div className="orbit-drawer-titlebar" data-tauri-drag-region data-window-drag-strip />}
      {!drawer && <div className="orbit-titlebar" data-tauri-drag-region>
        <div className="orbit-titlebar-actions">
          <button className="orbit-icon-button" type="button" title={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} onClick={onCollapse}>{collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}</button>
          {collapsed && <button className="orbit-icon-button" type="button" title="New task" aria-label="New task" disabled={!ready} onClick={() => onNavigate("tasks", { openNewTask: true })}><SquarePen size={17} /></button>}
        </div>
      </div>}
      {!collapsed && <header className="orbit-header">
        <span className="orbit-brand" aria-label="Grove"><LogoBrand mode="zen" icon={appIcon === "classic" ? undefined : <img src={appIconAssetUrl(appIcon, theme.isLight)} width={35} height={35} alt="" />} /></span>
        <div className="orbit-header-actions">
          <button className="orbit-icon-button" type="button" title="Notifications" aria-label="Notifications" aria-expanded={notificationOpen} onMouseDown={(event) => event.stopPropagation()} onClick={() => setNotificationOpen((open) => !open)}><Bell size={17} />{unreadCount > 0 && <span className="orbit-unread" />}</button>
          <button className="orbit-icon-button" type="button" title="Search" aria-label="Search" onClick={onSearch}><Search size={17} /></button>
        </div>
        <OrbitNotificationPopover isOpen={notificationOpen} onClose={() => setNotificationOpen(false)} onNavigate={onNavigate} />
      </header>}
      {!collapsed && <>
        <div className="orbit-project"><OrbitProjectSelector onProjectSwitch={onProjectSwitch} onManageProjects={onManageProjects} onAddProject={onAddProject} /></div>
        <nav className="orbit-navigation" aria-label="Project navigation">
          {!drawer && <button type="button" className={`orbit-row orbit-nav-row${activeItem === "new" ? " is-selected" : ""}`} disabled={!ready} onClick={() => newChat("_local")}><Plus size={16} strokeWidth={1.6} /><span>New</span></button>}
          {navigation.map(renderNavRow)}
          <button type="button" className="orbit-row orbit-nav-row" aria-expanded={moreOpen} onClick={() => setMoreExpanded(!moreOpen)}><MoreHorizontal size={16} strokeWidth={1.6} /><span>More</span><ChevronDown size={13} className={`orbit-more-chevron${moreOpen ? "" : " is-collapsed"}`} /></button>
          {moreOpen && moreNavigation.map(renderNavRow)}
        </nav>
        <section className="orbit-session-area" aria-label="Sessions">
          {error && <p role="alert" className="orbit-error">{error}</p>}
          <div className="orbit-section">
          <div className="orbit-task-section-heading orbit-sessions-heading">
            <button type="button" className="orbit-task-section-toggle" aria-expanded={sessionsExpanded} onClick={() => updateExpansion({ ...expansion, sessions: !sessionsExpanded })}>
              <span>Sessions</span><ChevronDown size={13} className={sessionsExpanded ? "" : "is-collapsed"} />
            </button>
            <div className="orbit-section-actions">
              <button type="button" className="orbit-section-add orbit-section-archive" title="Archived sessions" aria-label="Archived sessions" disabled={!projectId} onClick={() => setArchivedScope("sessions")}><Archive size={15} strokeWidth={1.7} /></button>
            </div>
          </div>
          {sessionsExpanded && renderSessions("_local")}
          </div>
          <div className="orbit-section">
          <div className="orbit-task-section-heading">
            <button type="button" className="orbit-task-section-toggle" aria-expanded={tasksExpanded} onClick={() => updateExpansion({ ...expansion, tasks: !tasksExpanded })}>
              <span>Tasks</span><ChevronDown size={13} className={tasksExpanded ? "" : "is-collapsed"} />
            </button>
            <div className="orbit-section-actions">
              <button type="button" className="orbit-section-add orbit-section-archive" title="Archived tasks" aria-label="Archived tasks" disabled={!projectId} onClick={() => setArchivedScope("tasks")}><Archive size={15} strokeWidth={1.7} /></button>
              <button type="button" className="orbit-section-add" title="New task" aria-label="New task" disabled={!ready} onClick={() => onNavigate("tasks", { openNewTask: true })}><Plus size={17} strokeWidth={1.7} /></button>
            </div>
          </div>
          {tasksExpanded && reorder.orderedTasks.map((task, index, ordered) => {
            const expanded = expandedTasks.includes(task.id);
            const target: Target = { kind: "task", projectId: projectId ?? "", taskId: task.id, name: task.name };
            const drop = reorder.dropTarget?.taskId === task.id && reorder.draggingId !== task.id ? ` is-drop-${reorder.dropTarget.placement}` : "";
            // Touch devices can't drag; they reorder from the row menu instead.
            const moveItems = isTouchDevice ? [
              { id: "move-up", label: "Move up", icon: ArrowUp, disabled: index === 0, onClick: () => reorder.moveBy(task.id, -1) },
              { id: "move-down", label: "Move down", icon: ArrowDown, disabled: index === ordered.length - 1, onClick: () => reorder.moveBy(task.id, 1) },
            ] : [];
            return <div key={task.id} className={`orbit-task${reorder.draggingId === task.id ? " is-dragging" : ""}${drop}`} {...reorder.dropTargetProps(task.id)}>
              <div className="orbit-task-row" {...reorder.dragSourceProps(task.id, !isTouchDevice && ordered.length > 1)}>
                <button type="button" className="orbit-task-toggle" aria-expanded={expanded} onClick={() => updateExpansion({ ...expansion, expandedTasks: expanded ? expandedTasks.filter((id) => id !== task.id) : [...expandedTasks, task.id] })}>
                  {expanded ? <FolderOpen size={17} strokeWidth={1.7} /> : <Folder size={17} strokeWidth={1.7} />}<span className="orbit-truncate">{task.name}</span>
                </button>
                <div className="orbit-row-menu"><DropdownMenu portal compact appearance="orbit" placement="bottom" ariaLabel={`More actions for ${task.name}`} triggerClassName="orbit-more-button" items={[
                  { id: "rename", label: "Rename", icon: Pencil, onClick: () => beginRename(target) },
                  ...moveItems,
                  { id: "archive", label: "Archive", icon: Archive, onClick: () => void archiveTarget(target) },
                  { id: "delete", label: "Delete", icon: Trash2, variant: "danger" as const, dividerBefore: true, onClick: () => setDeleteTarget(target) },
                ]} /></div>
                <button type="button" className="orbit-task-new" aria-label={`New chat in ${task.name}`} title="New chat" onClick={() => { if (!expanded) updateExpansion({ ...expansion, expandedTasks: [...expandedTasks, task.id] }); newChat(task.id); }}><SquarePen size={15} /></button>
              </div>
              {expanded && renderSessions(task.id)}
            </div>;
          })}
          </div>
        </section>
        <footer className="orbit-footer">
          <button type="button" className={`orbit-row orbit-nav-row${activeItem === "settings" ? " is-selected" : ""}`} onClick={() => onItemClick("settings")}><Settings size={16} strokeWidth={1.6} /><span>Settings</span></button>
          <button type="button" className="orbit-icon-button" title="IM Connect" aria-label="IM Connect" onClick={() => onItemClick("connect")}><MonitorSmartphone size={17} strokeWidth={1.6} /></button>
          {drawer && <button type="button" className="orbit-drawer-new" disabled={!ready} onClick={() => newChat("_local")}><Plus size={17} strokeWidth={1.8} /><span>New session</span></button>}
        </footer>
      </>}
      {renameTarget && <DialogShell isOpen onClose={() => setRenameTarget(null)}>
        <form className="orbit-rename-dialog" onSubmit={(event) => { event.preventDefault(); void saveRename(); }}>
          <h2>Rename {renameTarget.kind === "task" ? "task" : "session"}</h2>
          <input aria-label="Name" value={renameValue} onChange={(event) => setRenameValue(event.target.value)} autoFocus />
          <div><button type="button" onClick={() => setRenameTarget(null)}>Cancel</button><button type="submit" disabled={!renameValue.trim() || actionPending}>Save</button></div>
        </form>
      </DialogShell>}
      {deleteTarget && <ConfirmDialog isOpen title={`Delete ${deleteTarget.kind}`} message={deleteTarget.kind === "task" ? `Delete “${deleteTarget.name}” and its associated workspace? This cannot be undone.` : `Delete “${deleteTarget.name}” from Grove? This cannot be undone.`} confirmLabel="Delete" variant="danger" actionsDisabled={actionPending} onCancel={() => setDeleteTarget(null)} onConfirm={() => void confirmDelete()} />}
      <ArchivedDialog isOpen={archivedScope !== null} initialScope={archivedScope ?? "all"} onClose={() => setArchivedScope(null)} onSessionRestored={(taskId) => { if (projectId) void refreshSessions(projectId, taskId); }} />
      {pendingArchive && <ConfirmDialog isOpen title="Archive task" message={pendingArchive.message} confirmLabel="Archive" variant="warning" actionsDisabled={actionPending} onCancel={() => setPendingArchive(null)} onConfirm={() => void confirmArchive()} />}
    </aside>
  );
}
