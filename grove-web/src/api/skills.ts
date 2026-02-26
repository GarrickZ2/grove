// Skills API — Types and real API calls

import { apiClient } from './client';

// ============================================================================
// Types
// ============================================================================

export interface AgentDef {
  id: string;
  display_name: string;
  global_skills_dir: string;
  project_skills_dir: string;
  shared_group: string | null;
  /** Icon key for lobehub icon matching (e.g., "claude", "cursor") */
  icon_id: string | null;
  /** Whether this agent is enabled by the user */
  enabled: boolean;
  /** Built-in vs user-created */
  is_builtin: boolean;
}

export interface AddAgentRequest {
  display_name: string;
  global_skills_dir: string;
  project_skills_dir: string;
}

export interface SkillSource {
  name: string;
  source_type: 'git' | 'local';
  url: string;
  subpath: string | null;
  repo_key: string;
  skill_count: number;
  last_synced: string | null;
  /** Git sources only: true when remote has new commits not yet pulled */
  has_remote_updates: boolean;
}

export interface SkillSummary {
  name: string;
  description: string;
  source: string;
  repo_key: string;
  relative_path: string;
  repo_path: string;
  install_status: 'not_installed' | 'partial' | 'installed';
  installed_agent_count: number;
  total_agents: number;
  license: string | null;
  author: string | null;
}

export interface SkillMetadata {
  // Official spec fields
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  allowed_tools?: string;
  /** Non-standard frontmatter + official metadata block entries */
  fields: Record<string, string>;
}

export interface SkillDetail {
  name: string;
  description: string;
  source: string;
  repo_key: string;
  relative_path: string;
  repo_path: string;
  skill_md_content: string;
  metadata: SkillMetadata;
  install_status: 'not_installed' | 'partial' | 'installed';
  installed_agents: string[];
}

export interface AgentInstall {
  agent_id: string;
  scope: 'global' | 'project';
  symlink_path: string;
  project_path?: string;
}

export interface InstalledSkill {
  skill_name: string;
  repo_key: string;
  source_name: string;
  repo_path: string;
  agents: AgentInstall[];
  installed_at: string;
}

export interface AddSourceRequest {
  name: string;
  source_type: 'git' | 'local';
  url: string;
  subpath?: string;
}

export interface InstallSkillRequest {
  repo_key: string;
  source_name: string;
  skill_name: string;
  repo_path: string;
  relative_path: string;
  scope: 'global' | 'project';
  agents: { agent_id: string }[];
  project_path?: string;
  force?: boolean;
}

// ============================================================================
// API Functions
// ============================================================================

// --- Agents ---

export async function getAgentDefs(): Promise<AgentDef[]> {
  return apiClient.get('/api/v1/skills/agents');
}

export async function toggleAgentEnabled(agentId: string): Promise<AgentDef> {
  return apiClient.post(`/api/v1/skills/agents/${agentId}/toggle`);
}

export async function addAgent(req: AddAgentRequest): Promise<AgentDef> {
  return apiClient.post('/api/v1/skills/agents', req);
}

export async function updateAgent(agentId: string, req: AddAgentRequest): Promise<AgentDef> {
  return apiClient.put(`/api/v1/skills/agents/${agentId}`, req);
}

export async function deleteAgent(agentId: string): Promise<void> {
  return apiClient.delete(`/api/v1/skills/agents/${agentId}`);
}

// --- Sources ---

export async function listSources(): Promise<SkillSource[]> {
  return apiClient.get('/api/v1/skills/sources');
}

export async function addSource(req: AddSourceRequest): Promise<SkillSource> {
  return apiClient.post('/api/v1/skills/sources', req);
}

export async function updateSource(name: string, req: AddSourceRequest): Promise<SkillSource> {
  return apiClient.put(`/api/v1/skills/sources/${encodeURIComponent(name)}`, req);
}

export async function deleteSource(name: string): Promise<void> {
  return apiClient.delete(`/api/v1/skills/sources/${encodeURIComponent(name)}`);
}

export async function syncSource(name: string): Promise<SkillSource> {
  return apiClient.post(`/api/v1/skills/sources/${encodeURIComponent(name)}/sync`);
}

export async function syncAllSources(): Promise<SkillSource[]> {
  return apiClient.post('/api/v1/skills/sources/sync-all');
}

/** Lightweight check: git ls-remote vs local HEAD for each git source */
export async function checkSourceUpdates(): Promise<SkillSource[]> {
  return apiClient.post('/api/v1/skills/sources/check-updates');
}

// --- Skills (Explore & Install) ---

export async function exploreSkills(search?: string, source?: string): Promise<SkillSummary[]> {
  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (source) params.set('source', source);
  const qs = params.toString();
  return apiClient.get(`/api/v1/skills/explore${qs ? `?${qs}` : ''}`);
}

export async function getSkillDetail(source: string, skill: string): Promise<SkillDetail> {
  return apiClient.get(`/api/v1/skills/explore/${encodeURIComponent(source)}/${encodeURIComponent(skill)}`);
}

export async function listInstalled(): Promise<InstalledSkill[]> {
  return apiClient.get('/api/v1/skills/installed');
}

export async function installSkill(req: InstallSkillRequest): Promise<InstalledSkill> {
  return apiClient.post('/api/v1/skills/install', req);
}

export async function uninstallSkill(repoKey: string, repoPath: string): Promise<void> {
  return apiClient.delete(`/api/v1/skills/installed/${encodeURIComponent(repoKey)}/${repoPath}`);
}
