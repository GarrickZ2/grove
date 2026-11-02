import type { NodeStatus, RadioEvent } from "../../api/walkieTalkie";
import type { PermissionOption } from "../../utils/permissionOptions";

/** One live agent session, as the radio channel reports it. */
export interface LiveChat {
  projectId: string;
  taskId: string;
  chatId: string;
  status: NodeStatus;
  waitingForInput: boolean;
  permission: { description: string; options: PermissionOption[] } | null;
  /** The user prompt the agent is working on (only while busy). */
  prompt: string | null;
  agent: string | null;
  chatTitle: string | null;
  todoCompleted: number | null;
  todoTotal: number | null;
  /** When the session entered its current status (ms). */
  since: number;
}

export type LiveChats = Record<string, LiveChat>;

export type LiveChatAction =
  | { type: "snapshot"; chats: unknown[]; now: number }
  | { type: "status"; event: Extract<RadioEvent, { type: "chat_status" }>; now: number }
  | { type: "input"; projectId: string; taskId: string; chatId: string; waiting: boolean; now: number };

export const liveChatKey = (projectId: string, taskId: string, chatId: string) => `${projectId}:${taskId}:${chatId}`;

const STATUSES: NodeStatus[] = ["connecting", "idle", "busy", "permission_required", "disconnected"];

const str = (value: unknown) => (typeof value === "string" && value ? value : null);
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);

function parsePermission(value: unknown): LiveChat["permission"] {
  if (!value || typeof value !== "object") return null;
  const { description, options } = value as { description?: unknown; options?: unknown };
  const parsed = Array.isArray(options)
    ? options.filter((option): option is PermissionOption =>
      !!option && typeof option === "object"
      && typeof (option as PermissionOption).option_id === "string"
      && typeof (option as PermissionOption).name === "string"
      && typeof (option as PermissionOption).kind === "string")
    : [];
  return { description: typeof description === "string" ? description : "", options: parsed };
}

/** A row of `activity_snapshot` (see `acp::snapshot_active_chats`), or null when malformed. */
export function parseSnapshotChat(raw: unknown, now: number, previous?: LiveChat): LiveChat | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const projectId = str(row.project_id);
  const taskId = str(row.task_id);
  const chatId = str(row.chat_id);
  const status = row.status as NodeStatus;
  if (!projectId || !taskId || !chatId || !STATUSES.includes(status)) return null;
  return {
    projectId, taskId, chatId, status,
    waitingForInput: row.waiting_for_input === true,
    permission: status === "permission_required" ? parsePermission(row.permission) : null,
    prompt: status === "busy" ? str(row.prompt) : null,
    agent: str(row.agent) ?? previous?.agent ?? null,
    chatTitle: str(row.chat_title) ?? previous?.chatTitle ?? null,
    todoCompleted: num(row.todo_completed),
    todoTotal: num(row.todo_total),
    since: previous?.status === status ? previous.since : now,
  };
}

export function liveChatsReducer(state: LiveChats, action: LiveChatAction): LiveChats {
  switch (action.type) {
    case "snapshot": {
      // The snapshot is the whole truth: sessions it omits have no live handle.
      const next: LiveChats = {};
      for (const raw of action.chats) {
        const row = raw as Record<string, unknown> | null;
        const key = row ? liveChatKey(String(row.project_id), String(row.task_id), String(row.chat_id)) : "";
        const chat = parseSnapshotChat(raw, action.now, state[key]);
        if (chat && chat.status !== "disconnected") next[liveChatKey(chat.projectId, chat.taskId, chat.chatId)] = chat;
      }
      return next;
    }
    case "status": {
      const { event } = action;
      const key = liveChatKey(event.project_id, event.task_id, event.chat_id);
      if (event.status === "disconnected") {
        if (!state[key]) return state;
        const next = { ...state };
        delete next[key];
        return next;
      }
      const previous = state[key];
      const chat = parseSnapshotChat({ ...event, waiting_for_input: previous?.waitingForInput ?? false }, action.now, previous);
      if (!chat) return state;
      // `chat_status` events only carry the plan on change; keep the last one.
      if (chat.todoTotal == null && previous) {
        chat.todoCompleted = previous.todoCompleted;
        chat.todoTotal = previous.todoTotal;
      }
      return { ...state, [key]: chat };
    }
    case "input": {
      const key = liveChatKey(action.projectId, action.taskId, action.chatId);
      const previous = state[key];
      if (!previous) {
        if (!action.waiting) return state;
        // An input request can arrive before the session's first status.
        const chat = parseSnapshotChat({ project_id: action.projectId, task_id: action.taskId, chat_id: action.chatId, status: "idle", waiting_for_input: true }, action.now);
        return chat ? { ...state, [key]: chat } : state;
      }
      if (previous.waitingForInput === action.waiting) return state;
      return { ...state, [key]: { ...previous, waitingForInput: action.waiting } };
    }
  }
}

/** True while the session is waiting on a human (approval or an answer). */
export const chatNeedsHuman = (chat: LiveChat) => chat.status === "permission_required" || chat.waitingForInput;
