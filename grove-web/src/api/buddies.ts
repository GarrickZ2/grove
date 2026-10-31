import { apiClient } from "./client";
import { BUDDIES_MOCK_ENABLED, buddiesMock } from "./buddies.mock";
import type { AgentConfigSelection } from "./agentConfig";

export type BuddyStatus = "idle" | "working" | "waiting";

export type BuddyAgentConfig = AgentConfigSelection;

export interface BuddySummary {
  id: string;
  name: string;
  avatar: string | null;
  description: string;
  agent: string;
  status: BuddyStatus;
  last_message_preview: string;
  /** ISO 8601; null before the first message. */
  last_activity_at: string | null;
  active_session_id: string;
  running_delegations: number;
}

export interface BuddySegment {
  session_id: string;
  seq: number;
  agent: string;
  started_at: string;
  ended_at: string | null;
}

export interface Buddy extends BuddySummary {
  project_hash: string;
  local_task_id: string;
  role: string;
  system_prompt: string;
  agent_config: BuddyAgentConfig;
  model?: string | null;
  mode?: string | null;
  effort?: string | null;
  segments: BuddySegment[];
}

export interface CreateBuddyInput {
  name: string;
  agent: string;
  avatar?: string | null;
  description?: string;
  role?: string;
  system_prompt?: string;
  agent_config?: BuddyAgentConfig;
}

/** Changing Agent is deliberately separate from a settings patch. */
export type UpdateBuddyInput = Partial<Omit<CreateBuddyInput, "agent">>;

export interface SwitchBuddyAgentInput {
  agent: string;
  agent_config?: BuddyAgentConfig;
}

export interface BuddyDelegation {
  id: string;
  title: string;
  status: "running" | "waiting" | "done" | "failed" | "cancelled";
  target_project: string;
  target_task: string;
  target_session: string;
  last_result: string | null;
  updated_at: string;
}

const BASE = "/api/v1/buddies";
const buddyPath = (id: string) => `${BASE}/${encodeURIComponent(id)}`;

type BuddyWire = Omit<Buddy, "local_task_id" | "running_delegations" | "role"> & {
  role: string | null;
  local_task_id?: string;
  running_delegations?: number;
};

async function summary(wire: BuddyWire): Promise<BuddySummary> {
  const running = wire.running_delegations ?? (await listBuddyDelegations(wire.id)).filter((item) => item.status === "running").length;
  return { ...wire, running_delegations: running };
}
async function detail(wire: BuddyWire): Promise<Buddy> {
  return { ...wire, ...await summary(wire), role: wire.role ?? "", system_prompt: wire.system_prompt ?? "", agent_config: wire.agent_config ?? { source: "default", agent_id: wire.agent },
    // Buddy creation uses the existing LOCAL_TASK_ID; no separate task API.
    local_task_id: wire.local_task_id ?? "_local" };
}

export async function listBuddies(): Promise<BuddySummary[]> {
  if (BUDDIES_MOCK_ENABLED) return buddiesMock.list();
  return Promise.all((await apiClient.get<BuddyWire[]>(BASE)).map(summary));
}

export async function getBuddy(id: string): Promise<Buddy> {
  if (BUDDIES_MOCK_ENABLED) return buddiesMock.get(id);
  return detail(await apiClient.get<BuddyWire>(buddyPath(id)));
}

export async function createBuddy(input: CreateBuddyInput): Promise<Buddy> {
  if (BUDDIES_MOCK_ENABLED) return buddiesMock.create(input);
  return detail(await apiClient.post<CreateBuddyInput, BuddyWire>(BASE, input));
}

export async function updateBuddy(id: string, input: UpdateBuddyInput): Promise<Buddy> {
  if (BUDDIES_MOCK_ENABLED) return buddiesMock.update(id, input);
  return detail(await apiClient.patch<UpdateBuddyInput, BuddyWire>(buddyPath(id), input));
}

export async function switchBuddyAgent(id: string, input: SwitchBuddyAgentInput): Promise<Buddy> {
  if (BUDDIES_MOCK_ENABLED) return buddiesMock.switchAgent(id, input);
  return detail(await apiClient.post<SwitchBuddyAgentInput, BuddyWire>(`${buddyPath(id)}/agent`, input));
}

export async function archiveBuddy(id: string): Promise<void> {
  if (BUDDIES_MOCK_ENABLED) return buddiesMock.archive(id);
  await apiClient.delete(buddyPath(id));
}

export async function reorderBuddies(buddyIds: string[]): Promise<void> {
  if (BUDDIES_MOCK_ENABLED) return buddiesMock.reorder(buddyIds);
  await apiClient.patch<{ ids: string[] }, void>(`${BASE}/order`, { ids: buddyIds });
}

export async function listBuddyDelegations(id: string): Promise<BuddyDelegation[]> {
  if (BUDDIES_MOCK_ENABLED) return buddiesMock.listDelegations(id);
  return apiClient.get<BuddyDelegation[]>(`${buddyPath(id)}/delegations`);
}

export async function cancelBuddyDelegation(id: string, delegationId: string): Promise<void> {
  if (BUDDIES_MOCK_ENABLED) return buddiesMock.cancelDelegation(id, delegationId);
  await apiClient.post<undefined, void>(`${buddyPath(id)}/delegations/${encodeURIComponent(delegationId)}/cancel`);
}
