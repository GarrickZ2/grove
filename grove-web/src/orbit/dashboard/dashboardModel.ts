import type { HookEntryResponse } from "../../api/hooks";
import type { Task } from "../../data/types";
import { orderOptions, type PermissionOption } from "../../utils/permissionOptions";
import { chatNeedsHuman, liveChatKey, type LiveChat, type LiveChats } from "./liveChats";

export type NeedsYouKind = "permission" | "input" | "critical" | "warn" | "notice";

export interface NeedsYouItem {
  id: string;
  kind: NeedsYouKind;
  title: string;
  /** Where it comes from: task (· session). */
  source: string;
  /** Command / tool text worth showing verbatim. */
  code: string | null;
  projectId: string;
  taskId: string;
  chatId: string | null;
  /** In-place answers for a permission request, primary first. */
  options: PermissionOption[];
  /** Notification timestamp (ms); live requests use when they started. */
  at: number;
}

const LOCAL_TASK_ID = "_local";

export function taskLabel(taskId: string, taskName: string | null | undefined) {
  return taskId === LOCAL_TASK_ID ? "Main checkout" : taskName || taskId;
}

function oneLine(text: string, max: number) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Agent permission descriptions are usually `Title` or `Title: detail`
 * (e.g. "Run command: pnpm vitest run"). Keep the title readable and move
 * the detail into a code chip when it looks like one.
 */
export function splitPermission(description: string): { title: string; code: string | null } {
  const flat = description.replace(/\s+/g, " ").trim();
  const match = /^([^:`]{3,60}):\s+(.+)$/.exec(flat);
  if (match) return { title: match[1], code: oneLine(match[2], 80) };
  return { title: oneLine(flat || "Permission requested", 90), code: null };
}

/** At most two answers inline: the first allow and the first reject. */
export function inlineOptions(options: PermissionOption[]): PermissionOption[] {
  const ordered = orderOptions(options);
  const allow = ordered.find((option) => option.kind.startsWith("allow"));
  const reject = ordered.find((option) => option.kind.startsWith("reject"));
  const picked = [allow, reject].filter((option): option is PermissionOption => !!option);
  return picked.length ? picked : ordered.slice(0, 2);
}

/**
 * The project's "Needs you" inbox: live permission / input requests first
 * (answerable in place), then unread notifications. A notification about a
 * session that is already listed as a live request is folded into it.
 */
export function buildNeedsYou(
  projectId: string,
  chats: LiveChats,
  notifications: HookEntryResponse[],
  taskNames: Map<string, string>,
): NeedsYouItem[] {
  const live: NeedsYouItem[] = [];
  const covered = new Set<string>();
  for (const chat of Object.values(chats)) {
    if (chat.projectId !== projectId || !chatNeedsHuman(chat)) continue;
    covered.add(`${chat.taskId}:${chat.chatId}`);
    covered.add(`${chat.taskId}:`);
    const source = [taskLabel(chat.taskId, taskNames.get(chat.taskId)), chat.chatTitle].filter(Boolean).join(" · ");
    if (chat.status === "permission_required") {
      const { title, code } = splitPermission(chat.permission?.description ?? "");
      live.push({
        id: `perm:${liveChatKey(chat.projectId, chat.taskId, chat.chatId)}`,
        kind: "permission", title, source, code,
        projectId, taskId: chat.taskId, chatId: chat.chatId,
        options: inlineOptions(chat.permission?.options ?? []),
        at: chat.since,
      });
    } else {
      live.push({
        id: `input:${liveChatKey(chat.projectId, chat.taskId, chat.chatId)}`,
        kind: "input", title: "Waiting for your answer", source, code: null,
        projectId, taskId: chat.taskId, chatId: chat.chatId, options: [], at: chat.since,
      });
    }
  }
  live.sort((a, b) => (a.kind === b.kind ? a.at - b.at : a.kind === "permission" ? -1 : 1));

  const notes: NeedsYouItem[] = [];
  for (const hook of notifications) {
    if (hook.project_id !== projectId) continue;
    // Legacy entries have no chat id; fold them into any live request on the task.
    if (covered.has(`${hook.task_id}:${hook.chat_id ?? ""}`)) continue;
    const kind: NeedsYouKind = hook.level === "critical" ? "critical" : hook.level === "warn" ? "warn" : "notice";
    const at = Date.parse(hook.timestamp);
    notes.push({
      id: `hook:${hook.project_id}:${hook.task_id}`,
      kind,
      title: hook.message ? oneLine(hook.message, 90) : kind === "notice" ? "Finished" : "Needs attention",
      source: taskLabel(hook.task_id, taskNames.get(hook.task_id) ?? hook.task_name),
      code: null,
      projectId, taskId: hook.task_id, chatId: hook.chat_id,
      options: [],
      at: Number.isFinite(at) ? at : 0,
    });
  }
  notes.sort((a, b) => b.at - a.at);
  return [...live, ...notes];
}

export type TaskPhase = "waiting" | "live" | "idle";

export interface TaskActivity {
  phase: TaskPhase;
  /** What the task is doing right now, in words. */
  doing: string;
  /** Agent of the most relevant session, when one is live. */
  agent: string | null;
  /** Session to open from the row. */
  chatId: string | null;
}

const PHASE_RANK: Record<TaskPhase, number> = { waiting: 0, live: 1, idle: 2 };

function phaseOf(chat: LiveChat): TaskPhase {
  if (chatNeedsHuman(chat)) return "waiting";
  return chat.status === "busy" || chat.status === "connecting" ? "live" : "idle";
}

function describe(chat: LiveChat, phase: TaskPhase): string {
  if (phase === "waiting") return chat.status === "permission_required" ? "Waiting for approval" : "Waiting for your answer";
  if (chat.status === "connecting") return "Starting session";
  if (phase === "live") {
    const plan = chat.todoTotal ? ` · ${chat.todoCompleted ?? 0}/${chat.todoTotal}` : "";
    return chat.prompt ? `${oneLine(chat.prompt, 80)}${plan}` : `Working${plan}`;
  }
  return "Idle";
}

/** The task's most urgent live session decides its row state. */
export function taskActivity(projectId: string, taskId: string, chats: LiveChats): TaskActivity {
  let best: { chat: LiveChat; phase: TaskPhase } | null = null;
  for (const chat of Object.values(chats)) {
    if (chat.projectId !== projectId || chat.taskId !== taskId) continue;
    const phase = phaseOf(chat);
    if (!best || PHASE_RANK[phase] < PHASE_RANK[best.phase] || (phase === best.phase && chat.since > best.chat.since)) {
      best = { chat, phase };
    }
  }
  if (!best) return { phase: "idle", doing: "Idle", agent: null, chatId: null };
  return { phase: best.phase, doing: describe(best.chat, best.phase), agent: best.chat.agent, chatId: best.chat.chatId };
}

/** In-flight order: needs-you first, then working, then most recently touched. */
export function sortInFlight(tasks: Task[], activity: Map<string, TaskActivity>): Task[] {
  return [...tasks].sort((a, b) => {
    const rank = PHASE_RANK[activity.get(a.id)?.phase ?? "idle"] - PHASE_RANK[activity.get(b.id)?.phase ?? "idle"];
    return rank || b.updatedAt.getTime() - a.updatedAt.getTime();
  });
}
