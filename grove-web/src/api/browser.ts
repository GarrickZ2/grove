import { apiClient, appendHmacToUrl, getApiHost } from "./client";

export type BrowserTarget = "managed" | "personal";

export interface BrowserStatus {
  active: boolean;
  target: BrowserTarget | null;
  connected: BrowserTarget[];
}

const taskPath = (projectId: string, taskId: string) =>
  `/api/v1/browser/${encodeURIComponent(projectId)}/${encodeURIComponent(taskId)}`;

export function getBrowserStatus(projectId: string, taskId: string): Promise<BrowserStatus> {
  return apiClient.get<BrowserStatus>(taskPath(projectId, taskId));
}

export function switchBrowserTab(
  projectId: string,
  taskId: string,
  target: BrowserTarget,
  tab: string,
): Promise<BrowserStatus> {
  return apiClient.post<{ target: BrowserTarget; tab: string }, BrowserStatus>(
    `${taskPath(projectId, taskId)}/tab`,
    { target, tab },
  );
}

export function browserStreamUrl(projectId: string, taskId: string, target: BrowserTarget): Promise<string> {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return appendHmacToUrl(`${protocol}//${getApiHost()}${taskPath(projectId, taskId)}/stream?target=${target}`);
}

// ─── Session approvals ───────────────────────────────────────────────────────

export type Capability = "personal_browser" | "computer";

export interface PendingApproval {
  chatId: string;
  capability: Capability;
}

const approvalsPath = (projectId: string, taskId: string) =>
  `/api/v1/approvals/${encodeURIComponent(projectId)}/${encodeURIComponent(taskId)}`;

/** Chat Sessions in a Task waiting for the user to let them use their browser or computer. */
export function getPendingApprovals(projectId: string, taskId: string): Promise<PendingApproval[]> {
  return apiClient.get<PendingApproval[]>(approvalsPath(projectId, taskId));
}

export function decideApproval(
  projectId: string,
  taskId: string,
  request: PendingApproval & { allow: boolean },
): Promise<PendingApproval[]> {
  return apiClient.post<PendingApproval & { allow: boolean }, PendingApproval[]>(approvalsPath(projectId, taskId), request);
}

// ─── Computer ────────────────────────────────────────────────────────────────

/** One chat Session's latest screenshot of the user's computer. */
export interface ComputerShot {
  chatId: string;
  title: string;
  takenAt: string;
}

const computerPath = (projectId: string, taskId: string) =>
  `/api/v1/computer/${encodeURIComponent(projectId)}/${encodeURIComponent(taskId)}`;

export function getComputerShots(projectId: string, taskId: string): Promise<ComputerShot[]> {
  return apiClient.get<ComputerShot[]>(computerPath(projectId, taskId));
}

/** Stop showing a Session's computer tab. Its next screenshot shows it again. */
export function closeComputerTab(projectId: string, taskId: string, chatId: string): Promise<ComputerShot[]> {
  return apiClient.post<Record<string, never>, ComputerShot[]>(
    `${computerPath(projectId, taskId)}/close?chat=${encodeURIComponent(chatId)}`,
    {},
  );
}

/** What macOS lets Computer Use do, as agent-desktop reports it. `granted` when allowed. */
export interface ComputerPermissions {
  accessibility: string;
  screenRecording: string;
}

/** `null` on systems that ask for no such permissions. */
export function getComputerPermissions(): Promise<ComputerPermissions | null> {
  return apiClient.get<ComputerPermissions | null>("/api/v1/computer-permissions");
}

/** Ask macOS for one permission and open its page in System Settings. */
export type ComputerPermission = "accessibility" | "screenRecording";

export function requestComputerPermission(permission: ComputerPermission): Promise<Record<string, never>> {
  return apiClient.post<{ permission: ComputerPermission }, Record<string, never>>(
    "/api/v1/computer-permissions/request",
    { permission },
  );
}

/** For `<img src>`, through useSignedUrl. `takenAt` keeps each screenshot its own URL. */
export function computerScreenshotPath(projectId: string, taskId: string, shot: ComputerShot): string {
  return `${computerPath(projectId, taskId)}/screenshot?chat=${encodeURIComponent(shot.chatId)}&at=${encodeURIComponent(shot.takenAt)}`;
}

/** A Task's agent started using its browser. Layouts open the panel for it. */
export const OPEN_BROWSER_EVENT = "grove:open-browser";

export interface OpenBrowserDetail {
  projectId: string;
  taskId: string;
}

/** Tool calls render as `mcp.<server>.browser`; `browser_help` only reads docs. */
export function isBrowserToolCall(title: string | undefined): boolean {
  return /(^|[._\s])browser$/.test((title ?? "").trim().split(/[\s(:]/)[0] ?? "");
}
