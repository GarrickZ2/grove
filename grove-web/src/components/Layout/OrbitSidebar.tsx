import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bell, Blocks, Brain, BarChart2, ChevronDown, Folder, FolderOpen,
  LayoutDashboard, Layers, MonitorSmartphone, MoreHorizontal, PanelLeftClose, PanelLeftOpen,
  Plus, Repeat, Search, Settings, Sparkles, SquarePen, Pencil, Archive, Trash2,
} from "lucide-react";
import { listChats, renameTask, archiveTask, deleteTask, archiveChat, deleteChat, updateChatTitle } from "../../api";
import type { ChatSessionResponse } from "../../api/tasks";
import type { NodeStatus } from "../../api/walkieTalkie";
import { useNotifications, useProject, useTheme } from "../../context";
import { useRadioEvents } from "../../hooks";
import { appIconAssetUrl } from "../../data/appIcons";
import { DropdownMenu } from "../ui/DropdownMenu";
import { DialogShell } from "../ui/DialogShell";
import { ConfirmDialog } from "../Dialogs";
import { buildArchiveConfirmMessage, handleArchiveError, type PendingArchiveConfirm } from "../../utils/archiveHelpers";
import { NotificationPopover } from "./NotificationPopover";
import { ProjectSelector } from "./ProjectSelector";
import { LogoBrand } from "./LogoBrand";
import { useGlobalActiveChatId } from "../Tasks/TaskView/useActiveChatId";
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

export function OrbitSidebar({ activeItem, variant, collapsed, onCollapse, onItemClick, onNavigate, onSearch, onProjectSwitch, onManageProjects, onAddProject }: OrbitSidebarProps) {
  const { selectedProject, refreshSelectedProject } = useProject();
  const { theme, appIcon } = useTheme();
  const { unreadCount } = useNotifications();
  const activeChatId = useGlobalActiveChatId();
  const [notificationOpen, setNotificationOpen] = useState(false);
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(() => new Set());
  const [tasksExpanded, setTasksExpanded] = useState(true);
  const [sessionsExpanded, setSessionsExpanded] = useState(true);
  const [moreExpanded, setMoreExpanded] = useState(false);
  const [sessions, setSessions] = useState<Record<string, ChatSessionResponse[]>>({});
  const [statuses, setStatuses] = useState<Record<string, NodeStatus>>({});
  const [selection, setSelection] = useState<Selection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<Target | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Target | null>(null);
  const [pendingArchive, setPendingArchive] = useState<PendingArchiveConfirm | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const projectId = selectedProject?.id;
  const ready = !!selectedProject && selectedProject.taskCount === undefined && !!selectedProject.localTask;
  const tasks = useMemo(() => selectedProject?.tasks.filter((task) => task.status !== "archived") ?? [], [selectedProject]);
  const taskIds = useMemo(() => ready ? ["_local", ...tasks.map((task) => task.id)] : [], [ready, tasks]);
  const taskKey = taskIds.join("\u0000");

  const refreshSessions = useCallback(async (pid: string, tid: string) => {
    try {
      const chats = await listChats(pid, tid);
      setSessions((previous) => ({ ...previous, [`${pid}:${tid}`]: chats }));
    } catch (err) {
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
  useRadioEvents({
    onChatListChanged: (pid, tid) => { if (pid === projectId) void refreshSessions(pid, tid); },
    onConnected: () => { if (projectId) for (const tid of taskIds) void refreshSessions(projectId, tid); },
    onChatStatus: (pid, tid, cid, status) => {
      if (pid === projectId) setStatuses((previous) => ({ ...previous, [`${pid}:${tid}:${cid}`]: status }));
    },
  });

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
  const renderSessions = (taskId: string) => (sessions[`${projectId}:${taskId}`] ?? []).map((chat) => {
    const status = statuses[`${projectId}:${taskId}:${chat.id}`];
    const isRunning = status === "busy" || status === "permission_required" || status === "connecting";
    const onlySession = (sessions[`${projectId}:${taskId}`] ?? []).length <= 1;
    const selected = (activeItem === "tasks" || activeItem === "work") && (activeChatId ? activeChatId === chat.id : selection?.projectId === projectId && selection?.taskId === taskId && selection?.chatId === chat.id);
    const target: Target = { kind: "session", projectId: projectId ?? "", taskId, chatId: chat.id, name: chat.title || "Untitled session" };
    return (
      <div key={chat.id} className={`orbit-session-row${selected ? " is-selected" : ""}`}>
        <button type="button" title={chat.title} onClick={() => openChat(taskId, chat.id)} className={`orbit-row orbit-session${taskId === "_local" ? "" : " orbit-session-nested"}`}>
          <span className="orbit-truncate">{chat.title || "New Chat"}</span>
          {status && status !== "idle" && status !== "disconnected" && <span className={`orbit-status${status === "permission_required" ? " is-waiting" : ""}`} title={status} aria-label={status} />}
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
      </header>}
      {!collapsed && <>
        <div className="orbit-project"><ProjectSelector collapsed={false} onProjectSwitch={onProjectSwitch} onManageProjects={onManageProjects} onAddProject={onAddProject} /></div>
        <nav className="orbit-navigation" aria-label="Project navigation">
          {!drawer && <button type="button" className={`orbit-row orbit-nav-row${activeItem === "new" ? " is-selected" : ""}`} disabled={!ready} onClick={() => newChat("_local")}><Plus size={16} strokeWidth={1.6} /><span>New</span></button>}
          {navigation.map(renderNavRow)}
          <button type="button" className="orbit-row orbit-nav-row" aria-expanded={moreOpen} onClick={() => setMoreExpanded(!moreOpen)}><MoreHorizontal size={16} strokeWidth={1.6} /><span>More</span><ChevronDown size={13} className={`orbit-more-chevron${moreOpen ? "" : " is-collapsed"}`} /></button>
          {moreOpen && moreNavigation.map(renderNavRow)}
        </nav>
        <section className="orbit-session-area" aria-label="Sessions">
          {error && <p role="alert" className="orbit-error">{error}</p>}
          <div className="orbit-task-section-heading orbit-sessions-heading">
            <button type="button" className="orbit-task-section-toggle" aria-expanded={sessionsExpanded} onClick={() => setSessionsExpanded((value) => !value)}>
              <span>Sessions</span><ChevronDown size={13} className={sessionsExpanded ? "" : "is-collapsed"} />
            </button>
          </div>
          {sessionsExpanded && renderSessions("_local")}
          <div className="orbit-task-section-heading">
            <button type="button" className="orbit-task-section-toggle" aria-expanded={tasksExpanded} onClick={() => setTasksExpanded((value) => !value)}>
              <span>Tasks</span><ChevronDown size={13} className={tasksExpanded ? "" : "is-collapsed"} />
            </button>
            <button type="button" className="orbit-section-add" title="New task" aria-label="New task" disabled={!ready} onClick={() => onNavigate("tasks", { openNewTask: true })}><Plus size={17} strokeWidth={1.7} /></button>
          </div>
          {tasksExpanded && tasks.map((task) => {
            const expanded = expandedTasks.has(task.id);
            const target: Target = { kind: "task", projectId: projectId ?? "", taskId: task.id, name: task.name };
            return <div key={task.id} className="orbit-task">
              <div className="orbit-task-row">
                <button type="button" className="orbit-task-toggle" aria-expanded={expanded} onClick={() => setExpandedTasks((previous) => { const next = new Set(previous); if (next.has(task.id)) next.delete(task.id); else next.add(task.id); return next; })}>
                  {expanded ? <FolderOpen size={17} strokeWidth={1.7} /> : <Folder size={17} strokeWidth={1.7} />}<span className="orbit-truncate">{task.name}</span>
                </button>
                <div className="orbit-row-menu"><DropdownMenu portal compact appearance="orbit" placement="bottom" ariaLabel={`More actions for ${task.name}`} triggerClassName="orbit-more-button" items={[
                  { id: "rename", label: "Rename", icon: Pencil, onClick: () => beginRename(target) },
                  { id: "archive", label: "Archive", icon: Archive, onClick: () => void archiveTarget(target) },
                  { id: "delete", label: "Delete", icon: Trash2, variant: "danger", dividerBefore: true, onClick: () => setDeleteTarget(target) },
                ]} /></div>
                <button type="button" className="orbit-task-new" aria-label={`New chat in ${task.name}`} title="New chat" onClick={() => { setExpandedTasks((previous) => new Set(previous).add(task.id)); newChat(task.id); }}><SquarePen size={15} /></button>
              </div>
              {expanded && renderSessions(task.id)}
            </div>;
          })}
        </section>
        <footer className="orbit-footer">
          <button type="button" className={`orbit-row orbit-nav-row${activeItem === "settings" ? " is-selected" : ""}`} onClick={() => onItemClick("settings")}><Settings size={16} strokeWidth={1.6} /><span>Settings</span></button>
          <button type="button" className="orbit-icon-button" title="IM Connect" aria-label="IM Connect" onClick={() => onItemClick("connect")}><MonitorSmartphone size={17} strokeWidth={1.6} /></button>
          {drawer && <button type="button" className="orbit-drawer-new" disabled={!ready} onClick={() => newChat("_local")}><Plus size={17} strokeWidth={1.8} /><span>New session</span></button>}
        </footer>
      </>}
      <NotificationPopover isOpen={notificationOpen && !collapsed} onClose={() => setNotificationOpen(false)} onNavigate={onNavigate} variant="orbit" anchorStyle={{ top: drawer ? (hasMacControls ? 100 : 56) : hasMacControls ? 88 : 76, left: 12, bottom: "auto", width: drawer ? "min(300px, calc(100vw - 24px))" : 300 }} />
      {renameTarget && <DialogShell isOpen onClose={() => setRenameTarget(null)}>
        <form className="orbit-rename-dialog" onSubmit={(event) => { event.preventDefault(); void saveRename(); }}>
          <h2>Rename {renameTarget.kind === "task" ? "task" : "session"}</h2>
          <input aria-label="Name" value={renameValue} onChange={(event) => setRenameValue(event.target.value)} autoFocus />
          <div><button type="button" onClick={() => setRenameTarget(null)}>Cancel</button><button type="submit" disabled={!renameValue.trim() || actionPending}>Save</button></div>
        </form>
      </DialogShell>}
      {deleteTarget && <ConfirmDialog isOpen title={`Delete ${deleteTarget.kind}`} message={deleteTarget.kind === "task" ? `Delete “${deleteTarget.name}” and its associated workspace? This cannot be undone.` : `Delete “${deleteTarget.name}” from Grove? This cannot be undone.`} confirmLabel="Delete" variant="danger" actionsDisabled={actionPending} onCancel={() => setDeleteTarget(null)} onConfirm={() => void confirmDelete()} />}
      {pendingArchive && <ConfirmDialog isOpen title="Archive task" message={pendingArchive.message} confirmLabel="Archive" variant="warning" actionsDisabled={actionPending} onCancel={() => setPendingArchive(null)} onConfirm={() => void confirmArchive()} />}
    </aside>
  );
}
