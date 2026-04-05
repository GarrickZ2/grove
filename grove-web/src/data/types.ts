// Task status types
export type TaskStatus = 'live' | 'idle' | 'merged' | 'conflict' | 'broken' | 'archived';

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
  additions: number;
  deletions: number;
  filesChanged: number;
  commits: Commit[];
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
  hasOrigin: boolean; // whether the repo has origin for current branch
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
  liveTasks: number;
  idleTasks: number;
  mergedTasks: number;
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
}
