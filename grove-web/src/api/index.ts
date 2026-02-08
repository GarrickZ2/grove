// API exports

export { apiClient, ApiClient } from './client';
export type { ApiError } from './client';

export { getConfig, patchConfig, listApplications, getAppIconUrl } from './config';
export type { Config, ConfigPatch, ThemeConfig, LayoutConfig, WebConfig, AppInfo } from './config';

export { checkAllDependencies, checkDependency } from './env';
export type { DependencyStatus, EnvCheckResponse } from './env';

export { listProjects, getProject, addProject, deleteProject, getProjectStats, getBranches, openIDE, openTerminal } from './projects';
export type {
  ProjectListItem,
  ProjectListResponse,
  ProjectResponse,
  AddProjectRequest,
  ProjectStatsResponse,
  BranchInfo,
  BranchesResponse,
  OpenResponse,
} from './projects';

export {
  listTasks,
  getTask,
  createTask,
  archiveTask,
  recoverTask,
  deleteTask,
  getNotes,
  updateNotes,
  syncTask,
  commitTask,
  mergeTask,
  resetTask,
  rebaseToTask,
  getDiff,
  getCommits,
  getReviewComments,
  replyReviewComment,
  getTaskStats,
  getTaskFiles,
  getFileContent,
  writeFileContent,
} from './tasks';
export type {
  CommitResponse,
  TaskResponse,
  TaskListResponse,
  CreateTaskRequest,
  TaskFilter,
  NotesResponse,
  UpdateNotesRequest,
  CommitRequest,
  GitOperationResponse,
  DiffFileEntry,
  DiffResponse,
  CommitEntry,
  CommitsResponse,
  ReviewCommentEntry,
  ReviewCommentsResponse,
  ReplyCommentRequest,
  RebaseToRequest,
  FilesResponse,
  FileContentResponse,
  WriteFileRequest,
  FileEditEntry,
  ActivityEntry,
  TaskStatsResponse,
} from './tasks';

export {
  getGitStatus,
  getGitBranches,
  getGitCommits,
  gitCheckout,
  gitPull,
  gitPush,
  gitFetch,
  gitStash,
  createBranch,
  deleteBranch,
  renameBranch,
} from './git';
export type {
  RepoStatusResponse,
  BranchDetailInfo,
  BranchesDetailResponse,
  RepoCommitEntry,
  RepoCommitsResponse,
  GitOpResponse,
} from './git';

export { getFullDiff, createComment, deleteComment } from './review';
export type { DiffLine, DiffHunk, DiffFile, FullDiffResult } from './review';

export { listAllHooks, dismissHook } from './hooks';
export type { HookEntryResponse, HooksListResponse } from './hooks';

export { getVersion } from './version';
export type { VersionResponse } from './version';
