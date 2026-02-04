// API exports

export { apiClient, ApiClient } from './client';
export type { ApiError } from './client';

export { getConfig, patchConfig } from './config';
export type { Config, ConfigPatch, ThemeConfig, LayoutConfig, WebConfig } from './config';

export { checkAllDependencies, checkDependency } from './env';
export type { DependencyStatus, EnvCheckResponse } from './env';

export { listProjects, getProject, addProject, deleteProject, getProjectStats, getBranches } from './projects';
export type {
  ProjectListItem,
  ProjectListResponse,
  ProjectResponse,
  AddProjectRequest,
  ProjectStatsResponse,
  BranchInfo,
  BranchesResponse,
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
  getDiff,
  getCommits,
  getReviewComments,
  replyReviewComment,
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
