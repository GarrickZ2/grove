// Agent discovery API

import { apiClient } from "./client";

export interface BaseAgent {
  id: string;
  display_name: string;
  icon_id: string;
  available: boolean;
  unavailable_reason?: string;
  /** Launch modes this agent supports, e.g. ["acp"] or ["acp", "terminal"].
   *  Drives the per-chat ACP-vs-terminal choice in the New-chat picker. */
  supported_launch_modes?: string[];
}

interface BaseAgentsResponse {
  agents: BaseAgent[];
}

export async function listBaseAgents(): Promise<BaseAgent[]> {
  const resp = await apiClient.get<BaseAgentsResponse>("/api/v1/agents/base");
  return resp.agents;
}
