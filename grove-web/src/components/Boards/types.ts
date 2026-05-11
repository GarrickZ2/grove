export type BoardMode = "offline" | "online";

export type SyncStatus = "synced" | "syncing" | "offline" | "failed";

export type MemberRole = "manager" | "operator" | "viewer";

export interface BoardMember {
  email: string;
  name: string;
  avatarColor: string;
  role: MemberRole;
}

export interface ProjectRef {
  /** Stable identifier — local path for offline, origin URL for online. */
  id: string;
  name: string;
  /** True if this project is the Primary (board host). */
  primary: boolean;
}

export interface BoardColumn {
  id: string;
  name: string;
  /** Anchor columns are immovable (Backlog / Done). */
  anchor?: "backlog" | "done";
}

export type SessionStatus = "working" | "idle" | "done" | "failed";

export interface SessionBinding {
  id: string;
  taskId: string;
  taskName: string;
  /** Whether the parent Task has a worktree. */
  taskKind: "worktree" | "local";
  status: SessionStatus;
  /** Owner email — who started/runs this session locally. */
  ownerEmail: string;
  /** Agent id (matches agentOptions in data/agents.ts). */
  agentId?: string;
  /** Short one-line preview of last user prompt or message. */
  preview?: string;
  /** Elapsed seconds for working/idle states (since session started). */
  elapsedSeconds?: number;
  /** Total duration in seconds for done sessions. */
  durationSeconds?: number;
  /** Plan progress (Tray-style). */
  todoCompleted?: number;
  todoTotal?: number;
}

export interface BoardCardModel {
  id: string;
  boardId: string;
  columnId: string;
  title: string;
  description?: string;
  assigneeEmail?: string;
  /** When the work is expected to start. */
  startAt?: string;
  /** When the work is due. */
  dueAt?: string;
  sessions: SessionBinding[];
  /** Email of the operator who claimed this card. Unowned when null. */
  ownerEmail: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BoardSummary {
  id: string;
  name: string;
  mode: BoardMode;
  /** For online boards: the configured sync branch name. */
  branch?: string;
  /** Primary project display name (host of the board branch). */
  primaryProjectName: string;
  linkedProjectCount: number;
  memberCount: number;
  cardCount: number;
  sessionCount: number;
  sync: SyncStatus;
  /** ISO timestamp of last activity. */
  lastActiveAt: string;
}

export interface BoardDetail extends BoardSummary {
  columns: BoardColumn[];
  members: BoardMember[];
  projects: ProjectRef[];
  /** Email of the current viewing user (mock-only — backend will derive from auth). */
  currentUserEmail: string;
}
