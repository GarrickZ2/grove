import { useEffect, useState } from 'react';
import { getProject, listChats, listTasks, type ChatSessionResponse, type TaskResponse } from '../../api';

// Each result belongs to the project/task that requested it. Cleanup prevents
// a slow request from an old target overwriting the current selection.
export function useConnectTargets(projectId: string, taskId: string, sessionId: string) {
  const [revision, setRevision] = useState(0);
  const [taskResult, setTaskResult] = useState<{ id: string; items: TaskResponse[]; error?: string }>({ id: '', items: [] });
  const [sessionResult, setSessionResult] = useState<{ id: string; items: ChatSessionResponse[]; error?: string }>({ id: '', items: [] });
  const sessionKey = projectId && taskId ? JSON.stringify([projectId, taskId, sessionId]) : '';

  useEffect(() => {
    if (!projectId) return;
    let active = true;
    void Promise.all([listTasks(projectId), getProject(projectId)]).then(([items, detail]) => {
      if (active) setTaskResult({ id: projectId, items: detail.local_task ? [detail.local_task, ...items] : items });
    }).catch((cause) => {
      if (active) setTaskResult({ id: projectId, items: [], error: failure(cause) });
    });
    return () => { active = false; };
  }, [projectId, revision]);

  useEffect(() => {
    if (!sessionKey) return;
    let active = true;
    void listChats(projectId, taskId).then((items) => {
      if (active) setSessionResult({ id: sessionKey, items });
    }).catch((cause) => {
      if (active) setSessionResult({ id: sessionKey, items: [], error: failure(cause) });
    });
    return () => { active = false; };
  }, [projectId, taskId, sessionKey, revision]);

  return {
    tasks: projectId && taskResult.id === projectId ? taskResult.items : [],
    sessions: sessionKey && sessionResult.id === sessionKey ? sessionResult.items : [],
    tasksLoading: Boolean(projectId && taskResult.id !== projectId),
    sessionsLoading: Boolean(sessionKey && sessionResult.id !== sessionKey),
    reloadTargets: () => setRevision((value) => value + 1),
    targetError: (projectId && taskResult.id === projectId && taskResult.error)
      || (sessionKey && sessionResult.id === sessionKey && sessionResult.error) || null,
  };
}

function failure(cause: unknown) {
  return cause instanceof Error ? cause.message : String((cause as { message?: string })?.message ?? 'Could not load target options');
}
