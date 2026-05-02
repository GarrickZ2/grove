// Project type
export type ProjectType = 'repo' | 'studio';

// Task status types — grove-web only uses two states:
// 'archived' = explicitly archived; 'active' = everything else
export type TaskStatus = 'active' | 'archived';

export interface Commit {
  hash: string;
  message: string;
  author: string;
  date?: Date;
  timeAgo?: string;  // pre-formatted time string from API (e.g., "2 hours ago")
  files?: CommitFileChange[];  // expanded view shows file changes
}

export interface Task {
  id: string;
  name: string;
  branch: string;
  target: string;
  status: TaskStatus;
  createdAt: Date;
  updatedAt: Date;
  multiplexer: string;
  createdBy?: string;
  isLocal?: boolean;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  currentBranch: string;
  /** Worktree tasks only (Local Task is on `localTask`). */
  tasks: Task[];
  /** The project's single Local Task (every project has exactly one, always). */
  localTask: Task | null;
  addedAt: Date;
  // From ProjectListItem, used for display before full project is loaded
  taskCount?: number;
  /** Whether this project is backed by a git repository */
  isGitRepo: boolean;
  /**
   * Whether the project's filesystem path still exists. When false, the
   * project is in a "missing" state — UI should show a warning badge and
   * only allow Delete to clean up stale metadata.
   */
  exists: boolean;
  /** Project type: 'repo' for code repositories, 'studio' for AI agent workspaces */
  projectType: ProjectType;
}

export type ActivityType = 'create' | 'merge' | 'sync' | 'archive' | 'recover';

export interface ActivityItem {
  id: string;
  type: ActivityType;
  taskName: string;
  projectName: string;
  timestamp: Date;
}

export interface FileEdit {
  path: string;
  editCount: number;
  lastEdited: Date;
}

// Branch information
export interface Branch {
  name: string;
  isLocal: boolean;
  isCurrent: boolean;
  lastCommit?: string;
  aheadBehind?: { ahead: number; behind: number };
}

// Repository status
export interface RepoStatus {
  currentBranch: string;
  ahead: number;      // commits ahead of origin
  behind: number;     // commits behind origin
  staged: number;     // staged files count
  unstaged: number;   // modified but not staged
  untracked: number;  // untracked files count
  hasConflicts: boolean;
  hasOrigin: boolean; // whether the current branch has an upstream on origin
  hasRemote: boolean; // whether the repo has an `origin` remote configured
}

// Commit file change details
export interface CommitFileChange {
  path: string;
  additions: number;
  deletions: number;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
}

export interface Stats {
  totalTasks: number;
  archivedTasks: number;
  recentActivity: ActivityItem[];
  fileEdits: FileEdit[];
  weeklyActivity: number[];
}


// Task filter type
export type TaskFilter = 'active' | 'archived';

// Blitz mode: task with project context
export interface BlitzTask {
  task: Task;
  projectId: string;
  projectName: string;
  /** Project type — use this instead of checking task.branch to detect Studio tasks. */
  projectType: ProjectType;
}

// ─── TaskGroup (Walkie-Talkie) ───────────────────────────────────────────────

/** System group ID for the main (worktree) tasks group. */
export const MAIN_GROUP_ID = "_main";
/** System group ID for local workspace tasks. */
export const LOCAL_GROUP_ID = "_local";

export interface TaskSlot {
  /** Slot position — any positive integer (u16 on backend). */
  position: number;
  project_id: string;
  task_id: string;
  target_chat_id?: string;
}

export interface TaskGroup {
  id: string;
  name: string;
  color?: string;
  slots: TaskSlot[];
  created_at: string;
}

export interface SlotStatus {
  agent_status: "idle" | "busy" | "disconnected";
  task_name: string;
  project_name: string;
}

export interface GroupSnapshot {
  id: string;
  name: string;
  color?: string;
  slots: TaskSlot[];
  created_at: string;
  slot_statuses: Record<number, SlotStatus>;
}

export interface ChatRef {
  id: string;
  agent: string;
  title: string;
}
