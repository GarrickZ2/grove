import type { ProjectResponse, TaskResponse } from "../../api";
import type { Project } from "../../data/types";
import { shortenPath } from "../../utils/path";
import { formatDay } from "../ui/format";

export type ProjectsTab = "all" | "coding" | "studio" | "archived";

export function isStudioProject(project: Project): boolean {
  return project.projectType === "studio";
}

/** Projects in one tab. Active projects feed All / Coding / Studio; Archived has its own list. */
export function projectsInTab(tab: ProjectsTab, active: Project[], archived: Project[]): Project[] {
  if (tab === "archived") return archived;
  if (tab === "studio") return active.filter(isStudioProject);
  if (tab === "coding") return active.filter((project) => !isStudioProject(project));
  return active;
}

export function tabCounts(active: Project[], archived: Project[]): Record<ProjectsTab, number> {
  const studio = active.filter(isStudioProject).length;
  return { all: active.length, coding: active.length - studio, studio, archived: archived.length };
}

/** Case-insensitive match on name or path; a blank query keeps everything. */
export function matchProjects(projects: Project[], query: string): Project[] {
  const q = query.trim().toLowerCase();
  if (!q) return projects;
  return projects.filter((project) => project.name.toLowerCase().includes(q) || project.path.toLowerCase().includes(q));
}

export function taskCountOf(project: Project): number {
  return project.taskCount ?? project.tasks.length;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Header line: "6 projects · 14 tasks across them". */
export function projectsSummary(active: Project[], archived: Project[]): string {
  if (active.length === 0) {
    return archived.length > 0 ? `No active projects · ${archived.length} archived` : "Add a Git repo or start a Studio to begin.";
  }
  const tasks = active.reduce((sum, project) => sum + taskCountOf(project), 0);
  const missing = active.filter((project) => !project.exists).length;
  const parts = [plural(active.length, "project"), tasks > 0 ? `${plural(tasks, "task")} across them` : "no tasks yet"];
  if (missing > 0) parts.push(`${missing} missing`);
  return parts.join(" · ");
}

export type ProjectHealth = "ok" | "missing" | "not-git";

export function projectHealth(project: Project): ProjectHealth {
  if (!project.exists) return "missing";
  if (!isStudioProject(project) && !project.isGitRepo) return "not-git";
  return "ok";
}

/** "3 tasks" / "No tasks". */
export function taskLine(project: Project): string {
  const n = taskCountOf(project);
  return n === 0 ? "No tasks" : plural(n, "task");
}

export function kindLabel(project: Project): string {
  if (isStudioProject(project)) return "Studio";
  return project.isGitRepo ? "Git repo" : "Folder";
}

/** "Added Oct 26" (year shown outside the current year). */
export function addedLabel(project: Project, now: number = Date.now()): string {
  const at = project.addedAt.getTime();
  if (Number.isNaN(at)) return "";
  return `Added ${formatDay(at, { now })}`;
}

/** Path shown for a project; Studio projects have none worth showing (`studio://…`). */
export function pathLabel(project: Project): string | null {
  if (isStudioProject(project) || project.path.startsWith("studio://")) return null;
  return shortenPath(project.path);
}

export type TaskTone = "live" | "idle" | "ok" | "warn" | "fail";

export interface TaskRow {
  id: string;
  name: string;
  branch: string;
  status: string;
  label: string;
  tone: TaskTone;
  updatedAt: number;
  isLocal: boolean;
}

const STATUS: Record<string, { label: string; tone: TaskTone; rank: number }> = {
  live: { label: "Live", tone: "live", rank: 0 },
  conflict: { label: "Conflict", tone: "warn", rank: 1 },
  broken: { label: "Broken", tone: "fail", rank: 1 },
  idle: { label: "Idle", tone: "idle", rank: 2 },
  merged: { label: "Merged", tone: "ok", rank: 3 },
};

function toRow(task: TaskResponse, isLocal: boolean): TaskRow {
  const meta = STATUS[task.status] ?? STATUS.idle;
  const updated = new Date(task.updated_at).getTime();
  return {
    id: task.id,
    name: task.name,
    branch: task.branch,
    status: task.status,
    label: meta.label,
    tone: meta.tone,
    updatedAt: Number.isNaN(updated) ? 0 : updated,
    isLocal,
  };
}

/** The project's tasks for the detail list: the Local Task first, then live → needs attention → idle → merged, newest first within each. Archived tasks are left out. */
export function taskRows(full: Pick<ProjectResponse, "tasks" | "local_task"> | null): TaskRow[] {
  if (!full) return [];
  const rows = full.tasks.filter((task) => task.status !== "archived").map((task) => toRow(task, false));
  rows.sort((a, b) => (STATUS[a.status]?.rank ?? 2) - (STATUS[b.status]?.rank ?? 2) || b.updatedAt - a.updatedAt);
  return full.local_task ? [toRow(full.local_task, true), ...rows] : rows;
}

/** Counts by tone for the detail's status strip (the Local Task included, matching the list's task count). */
export function taskTally(rows: TaskRow[]): { live: number; attention: number; idle: number; merged: number } {
  const tally = { live: 0, attention: 0, idle: 0, merged: 0 };
  for (const row of rows) {
    if (row.tone === "live") tally.live += 1;
    else if (row.tone === "warn" || row.tone === "fail") tally.attention += 1;
    else if (row.tone === "ok") tally.merged += 1;
    else tally.idle += 1;
  }
  return tally;
}
