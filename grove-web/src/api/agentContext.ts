// Agent context API client: what a new Task's agent session starts with.

import { apiClient } from './client';

export type AgentContextSourceId = 'instructions' | 'memory' | 'mcp' | 'skills';

export interface AgentContextItem {
  name: string;
  /** Estimated tokens; null when unknown until the agent connects. */
  tokens: number | null;
  note?: string;
}

export interface AgentContextSource {
  id: AgentContextSourceId;
  name: string;
  enabled: boolean;
  /** Estimated tokens loaded at session start (known items only). */
  tokens: number;
  /** Some items have no estimate, so the real total is higher. */
  partial: boolean;
  detail: string;
  items: AgentContextItem[];
}

export interface AgentContextResponse {
  /** Canonical id of the agent the MCP / skill sets were resolved for. */
  agent: string;
  agent_label: string;
  total_tokens: number;
  partial: boolean;
  sources: AgentContextSource[];
}

/** GET /api/v1/projects/{id}/agent-context — 404 on servers that predate it. */
export function getAgentContext(projectId: string): Promise<AgentContextResponse> {
  return apiClient.get<AgentContextResponse>(`/api/v1/projects/${projectId}/agent-context`);
}
