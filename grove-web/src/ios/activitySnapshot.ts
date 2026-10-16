import { apiClient } from '../api/client';
import { listProjects, getProject } from '../api/projects';
import { getTaskGraph } from '../api/tasks';

async function boundedMap<T, R>(items: T[], run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({length: Math.min(4, items.length)}, async () => {
    while (next < items.length) { const index = next++; results[index] = await run(items[index]); }
  }));
  return results;
}

/** Whole-server state, independent of the selected page/project/task. */
export async function loadActivitySnapshot(): Promise<{chats: unknown[]}> {
  try { return await apiClient.get('/api/v1/radio/activity'); }
  catch (error) {
    // Older servers have no activity endpoint; use their existing live Graph API.
    // Never use a cached desktop tray mirror as runtime truth.
    if (![404, 405, 200].includes((error as {status?: number}).status ?? 0)) throw error;
  }
  const { projects } = await listProjects();
  const details = await boundedMap(projects.filter(p => !p.archived), p => getProject(p.id));
  const tasks = details.flatMap(p => [...p.tasks, ...(p.local_task ? [p.local_task] : [])]
    .filter(t => t.enableChat).map(t => ({project:p.id, task:t.id, name:t.name})));
  const groups = await boundedMap(tasks, async t => {
    const graph = await getTaskGraph(t.project, t.task);
    return graph.nodes.map(n => ({ project_id:t.project, task_id:t.task, chat_id:n.chat_id,
      task_name:t.name, chat_title:n.name, status:n.status }));
  });
  return {chats:groups.flat()};
}
