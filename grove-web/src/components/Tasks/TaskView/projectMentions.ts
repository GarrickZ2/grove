import type { ProjectListItem } from "../../../api/projects";
import type { TaskResponse } from "../../../api/tasks";
import { filterMentionItems, type FilteredMentionItem, type MentionItem } from "../../../utils/fileMention";

export interface ProjectMentionContent {
  files?: string[];
  tasks?: TaskResponse[];
  filesLoading: boolean;
  tasksLoading: boolean;
  filesError?: boolean;
  tasksError?: boolean;
}

export function mentionStatus(path: string, label: string, category = "Loading"): FilteredMentionItem {
  return { path, displayName: label, category, kind: "file", isDir: false, disabled: true, score: 0, indices: [] };
}

export function projectMentionItems(
  project: ProjectListItem,
  content: ProjectMentionContent | undefined,
  query: string,
): FilteredMentionItem[] {
  const root: FilteredMentionItem = {
    path: project.path, displayName: project.name, category: "Project Root",
    kind: "file", isDir: true, sessionId: project.id, score: 9999, indices: [],
  };
  const status: FilteredMentionItem[] = [];
  if (!content || content.filesLoading || content.tasksLoading) {
    status.push(mentionStatus(`loading-${project.id}`, "Loading tasks and files…"));
  } else if (content.filesError || content.tasksError) {
    const missing = [content.tasksError && "tasks", content.filesError && "files"].filter(Boolean).join(" and ");
    status.push(mentionStatus(`error-${project.id}`, `Could not refresh ${missing}. Reopen Projects to retry.`, "Error"));
  }
  const tasks: MentionItem[] = (content?.tasks ?? [])
    .filter(task => !task.is_local && task.id !== "_local" && task.path)
    .map(task => ({ path: task.path, displayName: task.name, category: "Task", kind: "file", isDir: true }));
  const files = content?.files ?? [];
  const dirs = new Set<string>();
  for (const file of files) {
    const normalized = file.replace(/\/+$/, "");
    if (!normalized || normalized.startsWith("/")) continue;
    const parts = normalized.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  const folders: MentionItem[] = Array.from(dirs).sort().map(path => ({
    path: `${project.path}/${path}`, displayName: path, isDir: true, kind: "file",
    category: project.project_type === "studio" ? "Shared Asset · Folder" : "Project Folder",
  }));
  const fileItems: MentionItem[] = files.map(path => ({
    path: `${project.path}/${path}`, displayName: path, isDir: path.endsWith("/"), kind: "file",
    category: project.project_type === "studio" ? "Shared Asset" : "Project File",
  }));
  return [root, ...status, ...filterMentionItems(tasks, query, 20), ...filterMentionItems([...folders, ...fileItems], query, 20)];
}
