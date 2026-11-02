import { useCallback, useEffect, useRef, useState } from "react";
import { listChats, type ChatSessionResponse } from "../../api";
import { useRadioEvents } from "../../hooks/useRadioEvents";

export interface RecentSession {
  taskId: string;
  chat: ChatSessionResponse;
  /** Last activity (ms), or the start time on servers without `updated_at`. */
  activeAt: number;
}

const PARALLEL = 4;
const LIMIT = 40;

/** Most recently active first; a malformed date sorts last. */
export function mergeRecentSessions(byTask: Record<string, ChatSessionResponse[]>, taskIds: string[], limit = LIMIT): RecentSession[] {
  const rows: RecentSession[] = [];
  for (const taskId of taskIds) {
    for (const chat of byTask[taskId] ?? []) {
      const activeAt = Date.parse(chat.updated_at ?? chat.created_at);
      rows.push({ taskId, chat, activeAt: Number.isFinite(activeAt) ? activeAt : 0 });
    }
  }
  return rows.sort((a, b) => b.activeAt - a.activeAt).slice(0, limit);
}

/**
 * The project's sessions across the Main checkout and every active task,
 * from the same per-task list the Orbit sidebar shows, refetched when the
 * radio channel says a task's list changed.
 */
export function useRecentSessions(projectId: string | undefined, taskIds: string[]) {
  const [state, setState] = useState<{ projectId: string; byTask: Record<string, ChatSessionResponse[]>; loaded: boolean }>({ projectId: "", byTask: {}, loaded: false });
  const generation = useRef<Record<string, number>>({});
  const idsKey = taskIds.join("\u0000");

  const load = useCallback(async (pid: string, taskId: string) => {
    const key = `${pid}:${taskId}`;
    const current = (generation.current[key] ?? 0) + 1;
    generation.current[key] = current;
    try {
      const chats = await listChats(pid, taskId);
      if (generation.current[key] !== current) return;
      setState((previous) => previous.projectId === pid
        ? { ...previous, byTask: { ...previous.byTask, [taskId]: chats } }
        : { projectId: pid, byTask: { [taskId]: chats }, loaded: false });
    } catch {
      // A task whose sessions can't be listed just contributes none.
    }
  }, []);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    const ids = idsKey ? idsKey.split("\u0000") : [];
    void (async () => {
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(PARALLEL, ids.length) }, async () => {
        while (!cancelled && next < ids.length) await load(projectId, ids[next++]);
      }));
      if (!cancelled) setState((previous) => previous.projectId === projectId ? { ...previous, loaded: true } : { projectId, byTask: {}, loaded: true });
    })();
    return () => { cancelled = true; };
  }, [projectId, idsKey, load]);

  useRadioEvents({
    onChatListChanged: (pid, taskId) => {
      if (pid === projectId && idsKey.split("\u0000").includes(taskId)) void load(pid, taskId);
    },
  });

  const current = state.projectId === projectId ? state : { byTask: {}, loaded: false };
  return { sessions: mergeRecentSessions(current.byTask, taskIds), loaded: current.loaded };
}
