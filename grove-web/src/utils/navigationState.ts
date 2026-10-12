import { REPO_NAV_IDS, STUDIO_NAV_IDS } from "../data/nav";
import type { TaskFilter } from "../data/types";

export type NavigationMode = "zen" | "blitz";

export interface NavigationState {
  page: string;
  projectId: string | null;
  tasksMode: NavigationMode;
  hasExitedWelcome: boolean;
}

export interface TaskPageLocation {
  projectId: string;
  taskId: string | null;
  inWorkspace: boolean;
  showDetail: boolean;
  filter: TaskFilter;
}

const NAVIGATION_KEY = "grove:navigation";
const pages = new Set<string>([...REPO_NAV_IDS, ...STUDIO_NAV_IDS, "settings", "projects"]);

function read(key: string): unknown {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Navigation remains usable when browser storage is unavailable.
  }
}

export function readNavigationState(): NavigationState | null {
  const value = read(NAVIGATION_KEY);
  if (!value || typeof value !== "object") return null;
  const state = value as Partial<NavigationState>;
  if (typeof state.page !== "string" || (!pages.has(state.page) && !/^plugin:.+/.test(state.page))) return null;
  if (state.projectId !== null && typeof state.projectId !== "string") return null;
  if (state.tasksMode !== "zen" && state.tasksMode !== "blitz") return null;
  if (typeof state.hasExitedWelcome !== "boolean") return null;
  return state as NavigationState;
}

export function writeNavigationState(state: NavigationState): void {
  write(NAVIGATION_KEY, state);
}

function taskKey(mode: NavigationMode, projectId?: string): string {
  return mode === "blitz" ? "grove:task-location:blitz" : `grove:task-location:zen:${projectId}`;
}

export function readTaskPageLocation(mode: NavigationMode, projectId?: string): TaskPageLocation | null {
  const value = read(taskKey(mode, projectId));
  if (!value || typeof value !== "object") return null;
  const state = value as Partial<TaskPageLocation>;
  if (typeof state.projectId !== "string" || (mode === "zen" && state.projectId !== projectId)) return null;
  if (state.taskId !== null && typeof state.taskId !== "string") return null;
  if (typeof state.inWorkspace !== "boolean" || typeof state.showDetail !== "boolean") return null;
  if (state.filter !== "active" && state.filter !== "archived") return null;
  return state as TaskPageLocation;
}

export function writeTaskPageLocation(mode: NavigationMode, state: TaskPageLocation): void {
  write(taskKey(mode, state.projectId), state);
}

export function restoredTaskNavigation(state: NavigationState | null): Record<string, unknown> | null {
  if (!state || (state.tasksMode === "zen" && state.page !== "tasks")) return null;
  const location = readTaskPageLocation(state.tasksMode, state.projectId ?? undefined);
  if (!location) return null;
  return {
    projectId: location.projectId,
    taskId: location.taskId ?? undefined,
    viewMode: location.inWorkspace && location.taskId ? "terminal" : undefined,
    taskFilter: location.filter,
    showDetail: location.showDetail,
    restore: true,
  };
}
