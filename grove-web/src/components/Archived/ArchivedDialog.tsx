import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Folder, Loader2, RotateCcw, Search, Trash2, X } from "lucide-react";
import {
  deleteChat, deleteTask, listArchivedChats, listTasks, recoverTask, restoreChat,
  type ChatSessionResponse, type TaskResponse,
} from "../../api";
import { useProject } from "../../context";
import { agentIconComponent } from "../../utils/agentIcon";
import { DialogShell } from "../ui/DialogShell";
import { ConfirmDialog } from "../Dialogs";
import "./archived-dialog.css";

export type ArchivedScope = "all" | "tasks" | "sessions";

type Item =
  | { kind: "task"; key: string; title: string; time: string; task: TaskResponse }
  | { kind: "session"; key: string; title: string; time: string; session: ChatSessionResponse; taskId: string; taskName: string | null };

interface ArchivedDialogProps {
  isOpen: boolean;
  initialScope: ArchivedScope;
  onClose: () => void;
  /** A Session came back into this Task's live list. */
  onSessionRestored: (taskId: string) => void;
}

const scopes: { id: ArchivedScope; label: string }[] = [
  { id: "all", label: "All" },
  { id: "tasks", label: "Tasks" },
  { id: "sessions", label: "Sessions" },
];

const DAY = 86_400_000;

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function timeGroup(value: string, now: Date) {
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return "Earlier";
  const today = startOfDay(now);
  if (time >= today) return "Today";
  if (time >= today - DAY) return "Yesterday";
  if (time >= today - 7 * DAY) return "Previous 7 days";
  if (time >= today - 30 * DAY) return "Previous 30 days";
  return "Earlier";
}

function shortTime(value: string, now: Date) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  if (date.getTime() >= startOfDay(now)) return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return date.toLocaleDateString(undefined, date.getFullYear() === now.getFullYear() ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" });
}

function longTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

const errorMessage = (err: unknown, fallback: string) => (err as { message?: string })?.message || fallback;

/** Archived Tasks and Sessions of the selected project: browse, recover / restore, or delete for good. */
export function ArchivedDialog({ isOpen, initialScope, onClose, onSessionRestored }: ArchivedDialogProps) {
  const { selectedProject, refreshSelectedProject } = useProject();
  const projectId = selectedProject?.id;
  const [scope, setScope] = useState<ArchivedScope>(initialScope);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [showDetail, setShowDetail] = useState(false);
  const [pending, setPending] = useState(false);
  const [deleteItem, setDeleteItem] = useState<Item | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Archived Sessions live under their (active) Task, plus the project's own Sessions.
  // Keyed by content so a project refresh with the same Tasks doesn't reload.
  const ownerKey = (selectedProject?.tasks ?? []).filter((task) => task.status !== "archived").map((task) => `${task.id}\u0000${task.name}`).join("\u0001");
  const owners = useMemo(() => [
    { id: "_local", name: null as string | null },
    ...ownerKey.split("\u0001").filter(Boolean).map((entry) => {
      const [id, name] = entry.split("\u0000");
      return { id, name: name as string | null };
    }),
  ], [ownerKey]);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    try {
      const [tasks, sessionLists] = await Promise.all([
        listTasks(projectId, "archived"),
        Promise.all(owners.map((owner) => listArchivedChats(projectId, owner.id).catch(() => [] as ChatSessionResponse[]))),
      ]);
      const next: Item[] = [
        ...tasks.map((task): Item => ({ kind: "task", key: `task:${task.id}`, title: task.name, time: task.updated_at, task })),
        ...sessionLists.flatMap((sessions, index) => sessions.map((session): Item => ({
          kind: "session", key: `session:${owners[index].id}:${session.id}`, title: session.title || "Untitled session",
          time: session.created_at, session, taskId: owners[index].id, taskName: owners[index].name,
        }))),
      ];
      next.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
      setItems(next);
    } catch (err) {
      setError(errorMessage(err, "Could not load archived items."));
    } finally {
      setLoading(false);
    }
  }, [projectId, owners]);

  useEffect(() => {
    if (!isOpen) return;
    void Promise.resolve().then(() => {
      setScope(initialScope);
      setQuery("");
      setSelectedKey(null);
      setShowDetail(false);
    });
  }, [isOpen, initialScope]);
  useEffect(() => {
    if (isOpen) void Promise.resolve().then(load);
  }, [isOpen, load]);

  const now = new Date();
  const needle = query.trim().toLowerCase();
  const visible = items.filter((item) => (scope === "all" || (scope === "tasks" ? item.kind === "task" : item.kind === "session"))
    && (!needle || item.title.toLowerCase().includes(needle) || (item.kind === "session" && item.taskName?.toLowerCase().includes(needle))));
  const groups: { label: string; items: Item[] }[] = [];
  for (const item of visible) {
    const label = timeGroup(item.time, now);
    const group = groups[groups.length - 1];
    if (group?.label === label) group.items.push(item);
    else groups.push({ label, items: [item] });
  }
  const selected = visible.find((item) => item.key === selectedKey) ?? visible[0] ?? null;

  const removeItem = (key: string) => setItems((previous) => previous.filter((item) => item.key !== key));

  const bringBack = async (item: Item) => {
    if (!projectId || pending) return;
    setPending(true);
    setError(null);
    try {
      if (item.kind === "task") {
        await recoverTask(projectId, item.task.id);
        await refreshSelectedProject();
      } else {
        await restoreChat(projectId, item.taskId, item.session.id);
        onSessionRestored(item.taskId);
      }
      removeItem(item.key);
      setShowDetail(false);
    } catch (err) {
      setError(errorMessage(err, `Could not ${item.kind === "task" ? "recover" : "restore"} “${item.title}”.`));
    } finally {
      setPending(false);
    }
  };

  const confirmDelete = async () => {
    if (!projectId || !deleteItem || pending) return;
    setPending(true);
    setError(null);
    try {
      if (deleteItem.kind === "task") await deleteTask(projectId, deleteItem.task.id);
      else await deleteChat(projectId, deleteItem.taskId, deleteItem.session.id, "grove");
      removeItem(deleteItem.key);
      setShowDetail(false);
    } catch (err) {
      setError(errorMessage(err, `Could not delete “${deleteItem.title}”.`));
    } finally {
      setDeleteItem(null);
      setPending(false);
    }
  };

  useEffect(() => {
    if (!isOpen || deleteItem) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, deleteItem, onClose]);

  const renderIcon = (item: Item, size: number) => {
    if (item.kind === "task") return <Folder size={size} strokeWidth={1.7} />;
    const AgentIcon = agentIconComponent(item.session.agent);
    return <AgentIcon size={size} />;
  };

  const renderDetail = (item: Item) => {
    return (
      <div className="orbit-archived-detail-body">
        <button type="button" className="orbit-archived-back" onClick={() => setShowDetail(false)}><ArrowLeft size={15} />Archived</button>
        <div className="orbit-archived-detail-icon">{renderIcon(item, 20)}</div>
        <h3 className="orbit-archived-detail-title">{item.title}</h3>
        <p className="orbit-archived-detail-meta">
          {item.kind === "task"
            ? <>Task · archived {longTime(item.time)}</>
            : <>{item.taskName ? <>In {item.taskName}</> : <>Session</>} · started {longTime(item.time)}</>}
        </p>
        <div className="orbit-archived-actions">
          <button type="button" className="orbit-archived-primary" disabled={pending} onClick={() => void bringBack(item)}>
            {pending ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}
            {item.kind === "task" ? "Recover task" : "Restore session"}
          </button>
          <button type="button" className="orbit-archived-danger" disabled={pending} onClick={() => setDeleteItem(item)}><Trash2 size={14} />Delete</button>
        </div>
        {item.kind === "task" && <p className="orbit-archived-hint">Recovering brings the task and its sessions back to the sidebar.</p>}
      </div>
    );
  };

  return (
    <>
      <DialogShell isOpen={isOpen} onClose={onClose} maxWidth="max-w-[760px]">
        <div className={`orbit-archived${showDetail ? " is-detail" : ""}`}>
          <header className="orbit-archived-header">
            <h2>Archived</h2>
            <button type="button" className="orbit-icon-button" aria-label="Close" onClick={onClose}><X size={16} /></button>
          </header>
          <div className="orbit-archived-columns">
            <div className="orbit-archived-list-pane">
              <div className="orbit-archived-search">
                <Search size={14} />
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search archived" aria-label="Search archived" />
              </div>
              <div className="orbit-archived-tabs" role="tablist">
                {scopes.map(({ id, label }) => (
                  <button key={id} type="button" role="tab" aria-selected={scope === id} className={scope === id ? "is-selected" : ""} onClick={() => setScope(id)}>{label}</button>
                ))}
              </div>
              {error && <p role="alert" className="orbit-archived-error">{error}</p>}
              <div className="orbit-archived-list">
                {loading && items.length === 0 && <p className="orbit-archived-empty"><Loader2 size={15} className="animate-spin" /></p>}
                {!loading && visible.length === 0 && (
                  <p className="orbit-archived-empty">{needle ? "No matches." : scope === "tasks" ? "No archived tasks." : scope === "sessions" ? "No archived sessions." : "Nothing archived yet."}</p>
                )}
                {groups.map((group) => (
                  <div key={group.label} className="orbit-archived-group">
                    <p className="orbit-archived-label">{group.label}</p>
                    {group.items.map((item) => (
                      <button
                        key={item.key}
                        type="button"
                        className={`orbit-archived-row${selected?.key === item.key ? " is-selected" : ""}`}
                        onClick={() => { setSelectedKey(item.key); setShowDetail(true); }}
                      >
                        <span className="orbit-archived-row-icon">{renderIcon(item, 15)}</span>
                        <span className="orbit-archived-row-text">
                          <span className="orbit-truncate">{item.title}</span>
                          {item.kind === "session" && item.taskName && <span className="orbit-archived-row-owner orbit-truncate">{item.taskName}</span>}
                        </span>
                        <span className="orbit-archived-row-time">{shortTime(item.time, now)}</span>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            </div>
            <div className="orbit-archived-detail">
              {selected ? renderDetail(selected) : <p className="orbit-archived-empty">{loading ? "" : "Archived tasks and sessions show up here."}</p>}
            </div>
          </div>
        </div>
      </DialogShell>
      {deleteItem && (
        <ConfirmDialog
          isOpen
          title={`Delete ${deleteItem.kind}`}
          message={deleteItem.kind === "task" ? `Delete “${deleteItem.title}” and its sessions for good? This cannot be undone.` : `Delete “${deleteItem.title}” from Grove? This cannot be undone.`}
          confirmLabel="Delete"
          variant="danger"
          actionsDisabled={pending}
          onCancel={() => setDeleteItem(null)}
          onConfirm={() => void confirmDelete()}
        />
      )}
    </>
  );
}
