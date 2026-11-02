// Read-only data the Orbit page layers over the shared Automation hooks:
// every row's runs for the "Today" strip, and the existing session a row
// targets (so the detail can name it and its agent).

import { useEffect, useMemo, useState } from "react";
import { listChats } from "../../api/tasks";
import { listAutomationRuns, type Automation, type AutomationRun } from "../../api/automations";

/** Runs per Automation, re-fetched when any row's last run changes or `tick` bumps. */
export function useAllRuns(projectId: string | null, automations: Automation[], tick: number) {
  const [runs, setRuns] = useState<Map<string, AutomationRun[]>>(() => new Map());
  // A row's last_run_at / status moves whenever a run starts or lands, so
  // this key is enough to know the strip is stale.
  const key = useMemo(
    () => automations.map((a) => `${a.id}:${a.last_run_at ?? ""}:${a.last_run_status ?? ""}`).join("|"),
    [automations],
  );
  const ids = useMemo(() => (key ? key.split("|").map((part) => part.split(":")[0]) : []), [key]);

  useEffect(() => {
    if (!projectId || ids.length === 0) {
      void Promise.resolve().then(() => setRuns(new Map()));
      return;
    }
    let alive = true;
    void Promise.all(
      ids.map((id) => listAutomationRuns(projectId, id).then((list) => [id, list] as const).catch(() => [id, [] as AutomationRun[]] as const)),
    ).then((entries) => {
      if (alive) setRuns(new Map(entries));
    });
    return () => { alive = false; };
  }, [projectId, ids, tick]);

  return runs;
}

/** Title and agent of the existing session an Automation posts into. */
export function useTargetChat(projectId: string | null, automation: Automation | null) {
  const taskId = automation?.session_mode === "existing" ? automation.task_id : undefined;
  const chatId = automation?.session_mode === "existing" ? automation.chat_id : undefined;
  const [chat, setChat] = useState<{ key: string; title: string; agent: string } | null>(null);
  const key = taskId && chatId ? `${taskId}/${chatId}` : null;

  useEffect(() => {
    if (!projectId || !taskId || !chatId) return;
    let alive = true;
    listChats(projectId, taskId)
      .then((chats) => {
        const hit = chats.find((c) => c.id === chatId);
        if (alive && hit) setChat({ key: `${taskId}/${chatId}`, title: hit.title, agent: hit.agent });
      })
      .catch(() => { /* the label falls back to the chat id */ });
    return () => { alive = false; };
  }, [projectId, taskId, chatId]);

  return chat && chat.key === key ? chat : null;
}
