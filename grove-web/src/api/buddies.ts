import { apiClient, requestAt } from "./client";
import { BUDDIES_MOCK_ENABLED, buddiesMock } from "./buddies.mock";
import type { AgentConfigSelection } from "./agentConfig";

export type BuddyStatus = "idle" | "working" | "waiting";

export type BuddyAgentConfig = AgentConfigSelection;

export interface BuddySummary {
  id: string;
  /** The Buddy's own Project. It is never shown in the shell; links to it open the Buddy instead. */
  project_hash: string;
  name: string;
  avatar: string | null;
  description: string;
  agent: string;
  status: BuddyStatus;
  last_message_preview: string;
  /** The latest turn was kept from the user. */
  last_turn_quiet?: boolean;
  /** ISO 8601; null before the first message. */
  last_activity_at: string | null;
  active_session_id: string;
  running_delegations: number;
  /** Delegations whose subagent is waiting on a permission, form, or answer. */
  waiting_delegations: number;
  /** Pinned to the top of the list. */
  pinned: boolean;
  /** What the Buddy is for, in the user's words; empty when unset. */
  role: string;
  sort_position?: number | null;
  /** Lives on another machine, named here; `id` is then its address from this one. */
  machine?: string;
  /** Its id on its own machine, which its avatar is drawn from. */
  avatar_id?: string;
}

export interface BuddySegment {
  session_id: string;
  seq: number;
  agent: string;
  started_at: string;
  ended_at: string | null;
}

export interface Buddy extends BuddySummary {
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

export type BuddyDelegationStatus = "running" | "waiting" | "done" | "failed" | "cancelled";

export interface BuddyDelegation {
  id: string;
  title: string;
  brief: string;
  status: BuddyDelegationStatus;
  from_session: string;
  target_project: string;
  target_task: string;
  target_session: string;
  last_result: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

const BASE = "/api/v1/buddies";
const buddyPath = (id: string) => `${BASE}/${encodeURIComponent(id)}`;

type BuddyWire = Omit<Buddy, "local_task_id" | "running_delegations" | "waiting_delegations" | "role" | "pinned"> & {
  role: string | null;
  pinned?: boolean;
  local_task_id?: string;
  running_delegations?: number;
  waiting_delegations?: number;
};

function summary(wire: BuddyWire): BuddySummary {
  return { ...wire, running_delegations: wire.running_delegations ?? 0, waiting_delegations: wire.waiting_delegations ?? 0, pinned: wire.pinned ?? false, role: wire.role ?? "" };
}
function detail(wire: BuddyWire): Buddy {
  return { ...wire, ...summary(wire), role: wire.role ?? "", system_prompt: wire.system_prompt ?? "", agent_config: wire.agent_config ?? { source: "default", agent_id: wire.agent },
    // Buddy creation uses the existing LOCAL_TASK_ID; no separate task API.
    local_task_id: wire.local_task_id ?? "_local" };
}

export async function listBuddies(): Promise<BuddySummary[]> {
  if (BUDDIES_MOCK_ENABLED) return buddiesMock.list();
  return (await apiClient.get<BuddyWire[]>(BASE)).map(summary);
}

/** The Buddies on a machine other than the one this window is pointed at. */
export async function listBuddiesAt(base: string): Promise<BuddySummary[]> {
  return (await requestAt<BuddyWire[]>(base, BASE)).map(summary);
}

/** Buddies on the machines connected to this one, addressed from here. */
export async function listReachableBuddies(): Promise<BuddySummary[]> {
  if (BUDDIES_MOCK_ENABLED) return [];
  const buddies = await apiClient.get<(Pick<BuddySummary, "id" | "name" | "avatar" | "machine" | "avatar_id" | "status"> & { role?: string | null })[]>(`${BASE}/reachable`);
  return buddies.map((buddy) => ({
    ...buddy, role: buddy.role ?? "", project_hash: "", description: "", agent: "", last_message_preview: "", last_activity_at: null,
    active_session_id: "", running_delegations: 0, waiting_delegations: 0, pinned: false,
  }));
}

export async function createBuddyAt(base: string, input: CreateBuddyInput): Promise<Buddy> {
  return detail(await requestAt<BuddyWire>(base, BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }));
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

/** Remove a Buddy from the list: it is archived (data kept) and its Routines stop. */
export async function deleteBuddy(id: string): Promise<void> {
  if (BUDDIES_MOCK_ENABLED) return buddiesMock.archive(id);
  await apiClient.delete(`${buddyPath(id)}?pause_routines=true`);
}

export async function pinBuddy(id: string, pinned: boolean): Promise<BuddySummary> {
  if (BUDDIES_MOCK_ENABLED) return buddiesMock.pin(id, pinned);
  return summary(await apiClient.put<{ pinned: boolean }, BuddyWire>(`${buddyPath(id)}/pin`, { pinned }));
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
  await apiClient.post<undefined, BuddyDelegation>(`${buddyPath(id)}/delegations/${encodeURIComponent(delegationId)}/cancel`);
}
