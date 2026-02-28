// API exports

export type { ApiError } from './client';

export { getConfig, patchConfig, listApplications, getAppIconUrl } from './config';
export type { Config, ConfigPatch, ThemeConfig, LayoutConfig, WebConfig, AppInfo, CustomAgent, AcpConfig } from './config';

export { checkAllDependencies, checkCommands } from './env';
export type { DependencyStatus, EnvCheckResponse } from './env';

export { listProjects, getProject, addProject, deleteProject, getProjectStats, getBranches, getRemotes, openIDE, openTerminal } from './projects';
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
  getTaskStats,
  getTaskFiles,
  getFileContent,
  writeFileContent,
  createFile,
  createDirectory,
  deleteFileOrDir,
  listChats,
  createChat,
  updateChatTitle,
  deleteChat,
  getChatHistory,
  takeControl,
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
  FsOperationResponse,
  CreateFileRequest,
  CreateDirectoryRequest,
  CopyFileRequest,
  ChatSessionResponse,
  ChatListResponse,
  ChatHistoryResponse,
  TakeControlResponse,
  SessionMetadata,
} from './tasks';

export {
  getGitStatus,
  getGitBranches,
  getGitCommits,
  gitCheckout,
  gitPull,
  gitPush,
  gitFetch,
  gitCommit,
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

export type { DiffLine, DiffHunk, DiffFile, FullDiffResult } from './review';

export type { HookEntryResponse, HooksListResponse } from './hooks';

export { getVersion, checkUpdate } from './version';
export type { VersionResponse, UpdateCheckResponse } from './version';

export {
  getAgentDefs,
  toggleAgentEnabled,
  addAgent,
  updateAgent,
  deleteAgent,
  listSources,
  addSource,
  updateSource,
  deleteSource,
  syncSource,
  syncAllSources,
  exploreSkills,
  getSkillDetail,
  listInstalled,
  installSkill,
  uninstallSkill,
  checkSourceUpdates,
} from './skills';
export type {
  AgentDef,
  AddAgentRequest,
  SkillSource,
  SkillSummary,
  SkillMetadata,
  SkillDetail,
  AgentInstall,
  InstalledSkill,
  AddSourceRequest,
  InstallSkillRequest,
} from './skills';
