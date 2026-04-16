// API exports

export type { ApiError } from './client';

export { getConfig, patchConfig, listApplications, getAppIconUrl } from './config';
export type { AppInfo, CustomAgent } from './config';

export { checkAllDependencies, checkCommands } from './env';

export { listProjects, getProject, addProject, deleteProject, getProjectStats, getBranches, getRemotes, openIDE, openTerminal, initGitRepo, createNewProject, listResources, uploadResource, deleteResource, previewResource, resourceDownloadUrl, getInstructions, updateInstructions, getMemory, updateMemory, listResourceWorkdirs, addResourceWorkdir, deleteResourceWorkdir, openResourceWorkdir, createResourceFolder, moveResource } from './projects';
export type {
  ProjectListItem,
  ProjectResponse,
  ProjectStatsResponse,
  ResourceFile,
  WorkDirectoryEntry,
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
  getTaskDirEntries,
  getFileContent,
  writeFileContent,
  createFile,
  createDirectory,
  deleteFileOrDir,
  listChats,
  createChat,
  updateChatTitle,
  deleteChat,
  uploadChatAttachment,
  getChatHistory,
  takeControl,
  readFile,
  listArtifacts,
  previewArtifact,
  artifactDownloadUrl,
  deleteArtifact,
  uploadArtifacts,
  syncArtifactToResource,
  listArtifactWorkdirs,
  addArtifactWorkdir,
  deleteArtifactWorkdir,
  openArtifactWorkdir,
} from './tasks';
export type {
  TaskResponse,
  DiffResponse,
  CommitsResponse,
  ReviewCommentEntry,
  TaskStatsResponse,
  ChatSessionResponse,
  ArtifactFile,
  ArtifactsResponse,
  ArtifactWorkDirectoryEntry,
  DirEntry,
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
  RepoCommitEntry,
} from './git';


export { getVersion, checkUpdate, startAppUpdate, getAppUpdateProgress, installAppUpdate } from './version';
export type { UpdateCheckResponse, AppUpdateProgress } from './version';

export { getAgentUsage } from './agentUsage';
export type { AgentUsage, UsageWindow, ExtraInfo } from './agentUsage';

export {
  listProviders,
  createProvider,
  updateProvider,
  deleteProvider,
  verifyProvider,
  getAudioSettings,
  saveAudioGlobal,
  saveAudioProject,
  transcribeAudio,
} from './ai';
export type { ProviderResponse, TranscribeResult } from './ai';

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
  checkSourceUpdates,
} from './skills';
export type {
  AgentDef,
  SkillSource,
  SkillSummary,
  SkillDetail,
  InstalledSkill,
} from './skills';

export {
  listTaskGroups,
  createTaskGroup,
  updateTaskGroup,
  deleteTaskGroup,
  upsertTaskSlot,
  removeTaskSlot,
  setSlots,
} from './taskgroups';
