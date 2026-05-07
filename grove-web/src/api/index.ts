// API exports

export type { ApiError } from './client';

export { getConfig, patchConfig, listApplications, getAppIconUrl, previewHookSound } from './config';
export type { AppInfo, CustomAgentServer } from './config';

export { listBaseAgents } from './agents';
export type { BaseAgent } from './agents';

export {
  listCustomAgents,
  createCustomAgent,
  updateCustomAgent,
  deleteCustomAgent,
} from './customAgent';
export type {
  CustomAgent as CustomAgentPersona,
  CustomAgentInput,
  CustomAgentPatch,
} from './customAgent';

export { checkAllDependencies, checkCommands } from './env';

export { listProjects, getProject, addProject, deleteProject, renameProject, getProjectStats, getBranches, getRemotes, openIDE, openTerminal, initGitRepo, createNewProject, listResources, uploadResource, deleteResource, previewResource, resourceDownloadUrl, getInstructions, updateInstructions, getMemory, updateMemory, listResourceWorkdirs, addResourceWorkdir, deleteResourceWorkdir, openResourceWorkdir, createResourceFolder, moveResource, createResourceLink, updateResourceLink } from './projects';
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
  activateTask,
  lookupSymbol,
  reindexSymbols,
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
  sendGraphChatMessage,
  getTaskGraph,
  spawnGraphNode,
  addGraphEdge,
  updateGraphChatDuty,
  updateGraphEdgePurpose,
  deleteGraphEdge,
  remindGraphEdge,
  getMentionCandidates,
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
  createArtifactLink,
  updateArtifactLink,
  syncArtifactToResource,
  listArtifactWorkdirs,
  addArtifactWorkdir,
  deleteArtifactWorkdir,
  openArtifactWorkdir,
} from './tasks';
export type {
  TaskResponse,
  SymbolCandidate,
  DiffResponse,
  CommitsResponse,
  ReviewCommentEntry,
  TaskStatsResponse,
  ChatSessionResponse,
  ArtifactFile,
  ArtifactsResponse,
  ArtifactWorkDirectoryEntry,
  DirEntry,
  MentionAgent,
  MentionOutgoing,
  MentionPendingReply,
  MentionCandidatesResponse,
  GraphResponse,
  GraphNodeResponse,
  GraphEdgeResponse,
  GraphPendingMessageInfo,
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

export { renderD2 } from './render';
export { fetchUrlMetadata } from './url';
export type { UrlMetadata } from './url';
export type { RenderD2Error } from './render';

export * from './sketches';
export type { DisplayItem } from './studio-types';

export {
  listTaskGroups,
  createTaskGroup,
  updateTaskGroup,
  deleteTaskGroup,
  upsertTaskSlot,
  removeTaskSlot,
  setSlots,
} from './taskgroups';
