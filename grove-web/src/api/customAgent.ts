import { apiClient } from './client';
import { agentCatalogReader, invalidateAgentCatalog } from './agentCatalogChanges';
import type { AgentConfigSelection } from './agentConfig';

export interface CustomAgent {
  id: string;
  name: string;
  base_agent: string;
  agent_config: AgentConfigSelection;
  model?: string;
  mode?: string;
  effort?: string;
  duty?: string;
  system_prompt: string;
  created_at: string;
  updated_at: string;
}

export interface CustomAgentInput {
  name: string;
  base_agent: string;
  agent_config?: AgentConfigSelection;
  model?: string | null;
  mode?: string | null;
  effort?: string | null;
  duty?: string | null;
  system_prompt?: string;
}

export interface CustomAgentPatch {
  name?: string;
  base_agent?: string;
  agent_config?: AgentConfigSelection;
  model?: string | null;
  mode?: string | null;
  effort?: string | null;
  duty?: string | null;
  system_prompt?: string;
}

interface ListResponse {
  agents: CustomAgent[];
}

export const listCustomAgents = agentCatalogReader(async (): Promise<CustomAgent[]> => {
  const r = await apiClient.get<ListResponse>('/api/v1/custom-agents');
  return r.agents;
});

export async function createCustomAgent(input: CustomAgentInput): Promise<CustomAgent> {
  const agent = await apiClient.post<CustomAgentInput, CustomAgent>('/api/v1/custom-agents', input);
  invalidateAgentCatalog();
  return agent;
}

export async function updateCustomAgent(id: string, patch: CustomAgentPatch): Promise<CustomAgent> {
  const agent = await apiClient.patch<CustomAgentPatch, CustomAgent>(`/api/v1/custom-agents/${encodeURIComponent(id)}`, patch);
  invalidateAgentCatalog();
  return agent;
}

export async function deleteCustomAgent(id: string): Promise<void> {
  await apiClient.delete(`/api/v1/custom-agents/${encodeURIComponent(id)}`);
  invalidateAgentCatalog();
}
