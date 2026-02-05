import type { Project, Task, ActivityItem, FileEdit, Stats, Branch, RepoStatus, CommitFileChange, ReviewComment, TaskNotes, AIData } from "./types";

// Helper to create dates relative to now
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000);
const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

// Mock Tasks
const groveTasks: Task[] = [
  {
    id: "grove-1",
    name: "fix-auth-bug",
    branch: "feature/fix-auth-bug",
    target: "main",
    status: "live",
    additions: 45,
    deletions: 12,
    filesChanged: 4,
    commits: [
      { hash: "abc1234", message: "Fix token validation", author: "dev", date: hoursAgo(1) },
      { hash: "def5678", message: "Add unit tests", author: "dev", date: hoursAgo(2) },
    ],
    createdAt: daysAgo(2),
    updatedAt: hoursAgo(1),
  },
  {
    id: "grove-2",
    name: "add-dark-mode",
    branch: "feature/dark-mode",
    target: "main",
    status: "live",
    additions: 234,
    deletions: 56,
    filesChanged: 12,
    commits: [
      { hash: "111aaa", message: "Add theme context", author: "dev", date: hoursAgo(3) },
      { hash: "222bbb", message: "Implement dark colors", author: "dev", date: hoursAgo(4) },
      { hash: "333ccc", message: "Add theme toggle", author: "dev", date: hoursAgo(5) },
    ],
    createdAt: daysAgo(5),
    updatedAt: hoursAgo(3),
  },
  {
    id: "grove-3",
    name: "refactor-api",
    branch: "refactor/api-layer",
    target: "main",
    status: "merged",
    additions: 89,
    deletions: 145,
    filesChanged: 8,
    commits: [
      { hash: "aaa111", message: "Extract API module", author: "dev", date: daysAgo(1) },
    ],
    createdAt: daysAgo(7),
    updatedAt: daysAgo(1),
  },
  {
    id: "grove-4",
    name: "old-experiment",
    branch: "experiment/new-ui",
    target: "main",
    status: "archived",
    additions: 0,
    deletions: 0,
    filesChanged: 0,
    commits: [],
    createdAt: daysAgo(30),
    updatedAt: daysAgo(14),
  },
];

const myAppTasks: Task[] = [
  {
    id: "myapp-1",
    name: "api-refactor",
    branch: "feature/api-v2",
    target: "develop",
    status: "live",
    additions: 567,
    deletions: 234,
    filesChanged: 23,
    commits: [
      { hash: "xyz789", message: "Implement new endpoints", author: "dev", date: hoursAgo(2) },
    ],
    createdAt: daysAgo(3),
    updatedAt: hoursAgo(2),
  },
  {
    id: "myapp-2",
    name: "fix-login-bug",
    branch: "bugfix/login-issue",
    target: "main",
    status: "idle",
    additions: 12,
    deletions: 5,
    filesChanged: 2,
    commits: [
      { hash: "bug123", message: "Fix session handling", author: "dev", date: daysAgo(1) },
    ],
    createdAt: daysAgo(4),
    updatedAt: daysAgo(1),
  },
];

const serverTasks: Task[] = [
  {
    id: "server-1",
    name: "add-monitoring",
    branch: "feature/monitoring",
    target: "main",
    status: "idle",
    additions: 178,
    deletions: 23,
    filesChanged: 7,
    commits: [
      { hash: "mon123", message: "Add prometheus metrics", author: "dev", date: daysAgo(2) },
    ],
    createdAt: daysAgo(6),
    updatedAt: daysAgo(2),
  },
];

// Mock Projects
export const mockProjects: Project[] = [
  {
    id: "proj-1",
    name: "grove",
    path: "/Users/dev/projects/grove",
    currentBranch: "main",
    tasks: groveTasks,
    addedAt: daysAgo(60),
  },
  {
    id: "proj-2",
    name: "my-app",
    path: "/Users/dev/projects/my-app",
    currentBranch: "develop",
    tasks: myAppTasks,
    addedAt: daysAgo(30),
  },
  {
    id: "proj-3",
    name: "api-server",
    path: "/Users/dev/projects/api-server",
    currentBranch: "main",
    tasks: serverTasks,
    addedAt: daysAgo(45),
  },
];

// Mock Activity
export const mockActivity: ActivityItem[] = [
  { id: "act-1", type: "merge", taskName: "refactor-api", projectName: "grove", timestamp: daysAgo(1) },
  { id: "act-2", type: "create", taskName: "add-dark-mode", projectName: "grove", timestamp: daysAgo(5) },
  { id: "act-3", type: "sync", taskName: "api-refactor", projectName: "my-app", timestamp: hoursAgo(6) },
  { id: "act-4", type: "archive", taskName: "old-experiment", projectName: "grove", timestamp: daysAgo(14) },
  { id: "act-5", type: "create", taskName: "fix-auth-bug", projectName: "grove", timestamp: daysAgo(2) },
  { id: "act-6", type: "create", taskName: "add-monitoring", projectName: "api-server", timestamp: daysAgo(6) },
];

// Mock File Edits
export const mockFileEdits: FileEdit[] = [
  { path: "src/app.rs", editCount: 124, lastEdited: hoursAgo(1) },
  { path: "src/model/worktree.rs", editCount: 89, lastEdited: hoursAgo(2) },
  { path: "src/ui/components/list.rs", editCount: 67, lastEdited: hoursAgo(3) },
  { path: "src/storage/tasks.rs", editCount: 45, lastEdited: hoursAgo(5) },
  { path: "src/git/mod.rs", editCount: 34, lastEdited: daysAgo(1) },
];

// Mock Stats
export const mockStats: Stats = {
  totalTasks: 46,
  liveTasks: 3,
  idleTasks: 7,
  mergedTasks: 24,
  archivedTasks: 12,
  recentActivity: mockActivity,
  fileEdits: mockFileEdits,
  weeklyActivity: [12, 8, 15, 23, 18, 5, 3], // Mon-Sun
};

// Config (existing)
export const mockConfig = {
  agent: {
    command: "claude",
  },
  layout: {
    default: "agent-shell",
    presets: [
      { id: "single", name: "Single", description: "Default shell only" },
      { id: "agent", name: "Agent", description: "Auto-start agent" },
      { id: "agent-shell", name: "Agent + Shell", description: "Agent (60%) + Shell (40%)" },
      { id: "agent-grove-shell", name: "Agent + Grove + Shell", description: "Three pane layout" },
      { id: "grove-agent", name: "Grove + Agent", description: "Grove (40%) + Agent (60%)" },
    ],
    customLayout: null,
  },
  hooks: {
    enabled: true,
    scriptPath: "~/.grove/hooks/notify.sh",
    levels: ["notice", "warn", "critical"],
  },
  mcp: {
    name: "grove",
    type: "stdio",
    command: "grove",
    args: ["mcp"],
  },
};

// Helper functions
export function getAllTasks(): Task[] {
  return mockProjects.flatMap(p => p.tasks);
}

export function getLiveTasks(): Task[] {
  return getAllTasks().filter(t => t.status === "live");
}

export function getProjectById(id: string): Project | undefined {
  return mockProjects.find(p => p.id === id);
}

export function getTaskById(id: string): Task | undefined {
  return getAllTasks().find(t => t.id === id);
}

// Mock Repository Status
export const mockRepoStatus: RepoStatus = {
  currentBranch: "main",
  ahead: 2,
  behind: 0,
  staged: 1,
  unstaged: 3,
  untracked: 1,
  hasConflicts: false,
  hasOrigin: true,
};

// Mock Branches
export const mockBranches: Branch[] = [
  { name: "main", isLocal: true, isCurrent: true, lastCommit: "abc1234" },
  { name: "feature/dark-mode", isLocal: true, isCurrent: false, lastCommit: "111aaa", aheadBehind: { ahead: 3, behind: 0 } },
  { name: "feature/fix-auth", isLocal: true, isCurrent: false, lastCommit: "def5678", aheadBehind: { ahead: 2, behind: 1 } },
  { name: "refactor/api-layer", isLocal: true, isCurrent: false, lastCommit: "aaa111" },
  { name: "origin/main", isLocal: false, isCurrent: false, lastCommit: "abc1234" },
  { name: "origin/develop", isLocal: false, isCurrent: false, lastCommit: "xyz789" },
  { name: "origin/feature/dark-mode", isLocal: false, isCurrent: false, lastCommit: "111aaa" },
];

// Mock Commit File Changes for expanded view
export const mockCommitFileChanges: Record<string, CommitFileChange[]> = {
  "abc1234": [
    { path: "src/auth/token.rs", additions: 45, deletions: 12, status: "modified" },
    { path: "src/tests/auth_test.rs", additions: 89, deletions: 0, status: "added" },
    { path: "Cargo.toml", additions: 2, deletions: 1, status: "modified" },
  ],
  "def5678": [
    { path: "src/auth/session.rs", additions: 23, deletions: 8, status: "modified" },
    { path: "src/tests/session_test.rs", additions: 56, deletions: 0, status: "added" },
  ],
  "111aaa": [
    { path: "src/theme/mod.rs", additions: 120, deletions: 0, status: "added" },
    { path: "src/theme/colors.rs", additions: 85, deletions: 0, status: "added" },
    { path: "src/app.rs", additions: 15, deletions: 3, status: "modified" },
  ],
  "aaa111": [
    { path: "src/api/mod.rs", additions: 45, deletions: 89, status: "modified" },
    { path: "src/api/client.rs", additions: 34, deletions: 56, status: "modified" },
    { path: "src/api/old_handler.rs", additions: 0, deletions: 120, status: "deleted" },
    { path: "src/api/handler.rs", additions: 95, deletions: 0, status: "added" },
  ],
};

// Enhanced commits with file changes
export const mockCommitsWithChanges = groveTasks[0].commits.map(commit => ({
  ...commit,
  files: mockCommitFileChanges[commit.hash] || [],
}));

// Helper to get file changes for a commit
export function getCommitFileChanges(hash: string): CommitFileChange[] {
  return mockCommitFileChanges[hash] || [];
}

// Mock Review Comments
export const mockReviewComments: Record<string, ReviewComment[]> = {
  "grove-1": [
    {
      id: "review-1",
      file: "src/auth/token.rs",
      line: 42,
      content: "Consider using a constant for the token expiry time instead of hardcoding it.",
      author: "reviewer",
      status: "open",
      createdAt: hoursAgo(1),
    },
    {
      id: "review-2",
      file: "src/auth/token.rs",
      line: 78,
      content: "Good error handling here!",
      author: "reviewer",
      status: "resolved",
      createdAt: hoursAgo(2),
      resolvedAt: hoursAgo(1),
    },
    {
      id: "review-3",
      file: "src/tests/auth_test.rs",
      line: 15,
      content: "Add a test case for expired tokens.",
      author: "reviewer",
      status: "open",
      createdAt: hoursAgo(1),
    },
  ],
  "grove-2": [
    {
      id: "review-4",
      file: "src/theme/colors.rs",
      line: 23,
      content: "The color contrast ratio might not meet WCAG AA standards.",
      author: "reviewer",
      status: "not_resolved",
      createdAt: hoursAgo(3),
    },
  ],
};

// Mock Task Notes
export const mockTaskNotes: Record<string, TaskNotes> = {
  "grove-1": {
    taskId: "grove-1",
    content: `# Fix Auth Bug

## Problem
Users are experiencing intermittent authentication failures when their tokens expire.

## Root Cause
The token validation logic was checking expiry time incorrectly.

## Solution
- Update token validation to use proper timezone handling
- Add grace period for nearly-expired tokens
- Improve error messages for expired tokens

## Testing
- [x] Unit tests for token validation
- [ ] Integration tests with mock server
- [ ] Manual testing with real tokens`,
    updatedAt: hoursAgo(1),
  },
  "grove-2": {
    taskId: "grove-2",
    content: `# Dark Mode Implementation

## Requirements
- Support system preference detection
- Allow manual toggle
- Persist user preference
- Smooth transitions between themes

## Implementation Plan
1. Create ThemeContext
2. Define color variables
3. Add toggle component
4. Implement persistence`,
    updatedAt: hoursAgo(3),
  },
};

// Mock AI Data
export const mockAIData: Record<string, AIData> = {
  "grove-1": {
    taskId: "grove-1",
    summary: `Working on fixing the authentication token validation bug. The main issue was in the token expiry check which wasn't handling timezone offsets correctly. I've updated the validation logic and added comprehensive unit tests. Currently addressing review comments about using constants for magic numbers.`,
    todos: [
      { id: "todo-1", text: "Fix token validation timezone handling", completed: true },
      { id: "todo-2", text: "Add unit tests for edge cases", completed: true },
      { id: "todo-3", text: "Address review comment about constants", completed: false },
      { id: "todo-4", text: "Add integration tests", completed: false },
      { id: "todo-5", text: "Update documentation", completed: false },
    ],
    updatedAt: hoursAgo(1),
  },
  "grove-2": {
    taskId: "grove-2",
    summary: `Implementing dark mode support for the application. Created a ThemeContext to manage theme state and added CSS custom properties for all colors. The theme toggle component is complete and persists user preference to localStorage. Working on fixing color contrast issues flagged in review.`,
    todos: [
      { id: "todo-6", text: "Create ThemeContext", completed: true },
      { id: "todo-7", text: "Define CSS color variables", completed: true },
      { id: "todo-8", text: "Implement theme toggle", completed: true },
      { id: "todo-9", text: "Fix color contrast issues", completed: false },
      { id: "todo-10", text: "Add system preference detection", completed: false },
    ],
    updatedAt: hoursAgo(3),
  },
};

// Mock Terminal Output
export const mockTerminalOutput = `\x1b[32m$\x1b[0m claude
\x1b[36m╭─\x1b[0m Claude Code
\x1b[36m│\x1b[0m
\x1b[36m│\x1b[0m  \x1b[1mAnalyzing codebase...\x1b[0m
\x1b[36m│\x1b[0m  Found 3 files to modify
\x1b[36m│\x1b[0m
\x1b[36m│\x1b[0m  \x1b[33mWorking on:\x1b[0m src/auth/token.rs
\x1b[36m│\x1b[0m  \x1b[32m✓\x1b[0m Updated token validation logic
\x1b[36m│\x1b[0m  \x1b[32m✓\x1b[0m Added timezone handling
\x1b[36m│\x1b[0m
\x1b[36m│\x1b[0m  \x1b[33mWorking on:\x1b[0m src/tests/auth_test.rs
\x1b[36m│\x1b[0m  \x1b[32m✓\x1b[0m Added test for expired tokens
\x1b[36m│\x1b[0m  \x1b[32m✓\x1b[0m Added test for timezone edge cases
\x1b[36m│\x1b[0m
\x1b[36m╰─\x1b[0m \x1b[90mWaiting for input...\x1b[0m █`;

// Helper to get review comments for a task
export function getTaskReviewComments(taskId: string): ReviewComment[] {
  return mockReviewComments[taskId] || [];
}

// Helper to get notes for a task
export function getTaskNotes(taskId: string): TaskNotes | undefined {
  return mockTaskNotes[taskId];
}

// Helper to get AI data for a task
export function getTaskAIData(taskId: string): AIData | undefined {
  return mockAIData[taskId];
}
