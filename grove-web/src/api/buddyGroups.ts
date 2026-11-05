import { apiClient, requestAt } from "./client";
import { BUDDIES_MOCK_ENABLED } from "./buddies.mock";
import type { BuddyStatus, BuddySummary } from "./buddies";

export interface BuddyGroupMember {
  buddy_id: string;
  name: string;
  avatar: string | null;
  role: string | null;
  status: BuddyStatus;
  session_id: string;
  project_hash: string;
  task_id: string;
}

export interface BuddyGroup {
  id: string;
  name: string;
  pinned: boolean;
  sort_position: number | null;
  status: BuddyStatus;
  members: BuddyGroupMember[];
  last_message_preview: string | null;
  last_activity_at: string | null;
  created_at: string;
}

export interface BuddyGroupAttachment { name: string; mime_type: string; path: string }

export interface BuddyGroupMessage {
  group_id: string;
  seq: number;
  sender_kind: "user" | "buddy" | "system" | "quiet" | "failed";
  sender_id: string | null;
  text: string;
  mentions: string[];
  attachments: BuddyGroupAttachment[];
  created_at: string;
}

export interface BuddyGroupMessagePage { messages: BuddyGroupMessage[]; has_earlier: boolean }
export interface OutgoingGroupFile { name: string; mime_type: string; data: string }

/** The list shows groups and Buddies side by side; a group entry carries its group. */
export type BuddyListEntry = BuddySummary & { group?: BuddyGroup };

const BASE = "/api/v1/buddy-groups";
const groupPath = (id: string) => `${BASE}/${encodeURIComponent(id)}`;

export const listBuddyGroups = async (): Promise<BuddyGroup[]> => BUDDIES_MOCK_ENABLED ? [] : apiClient.get<BuddyGroup[]>(BASE);
export const listBuddyGroupsAt = (base: string) => requestAt<BuddyGroup[]>(base, BASE);
export const createBuddyGroupAt = (base: string, input: { name?: string; buddy_ids: string[] }) => requestAt<BuddyGroup>(base, BASE, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(input),
});
export const getBuddyGroup = (id: string) => apiClient.get<BuddyGroup>(groupPath(id));
export const createBuddyGroup = (input: { name?: string; buddy_ids: string[] }) => apiClient.post<typeof input, BuddyGroup>(BASE, input);
export const renameBuddyGroup = (id: string, name: string) => apiClient.patch<{ name: string }, BuddyGroup>(groupPath(id), { name });
export const disbandBuddyGroup = async (id: string) => { await apiClient.delete(groupPath(id)); };
export const pinBuddyGroup = (id: string, pinned: boolean) => apiClient.put<{ pinned: boolean }, BuddyGroup>(`${groupPath(id)}/pin`, { pinned });
export const stopBuddyGroup = async (id: string) => { await apiClient.post<undefined, void>(`${groupPath(id)}/stop`); };
export const addBuddyGroupMember = (id: string, buddyId: string) => apiClient.post<{ buddy_id: string }, BuddyGroup>(`${groupPath(id)}/members`, { buddy_id: buddyId });
export const removeBuddyGroupMember = (id: string, buddyId: string) => apiClient.delete<BuddyGroup>(`${groupPath(id)}/members/${encodeURIComponent(buddyId)}`);
export const askBuddyGroupMember = async (id: string, buddyId: string) => { await apiClient.post<undefined, void>(`${groupPath(id)}/members/${encodeURIComponent(buddyId)}/ask`); };
export function listBuddyGroupMessages(id: string, before?: number): Promise<BuddyGroupMessagePage> {
  return apiClient.get<BuddyGroupMessagePage>(`${groupPath(id)}/messages${before ? `?before_seq=${before}` : ""}`);
}
export const sendBuddyGroupMessage = (id: string, text: string, attachments: OutgoingGroupFile[]) =>
  apiClient.post<{ text: string; attachments: OutgoingGroupFile[] }, BuddyGroupMessage>(`${groupPath(id)}/messages`, { text, attachments });

/** A group as a list row. The prefix also marks a group wherever only an id travels (the mini window). */
export const GROUP_REF_PREFIX = "group:";
export function groupEntry(group: BuddyGroup): BuddyListEntry {
  return {
    id: group.id, project_hash: "", name: group.name, avatar: null, description: group.members.map((member) => member.name).join(", "), agent: "", status: group.status,
    last_message_preview: group.last_message_preview ?? "", last_activity_at: group.last_activity_at, active_session_id: "", running_delegations: 0, waiting_delegations: 0,
    pinned: group.pinned, role: "", sort_position: group.sort_position, group,
  };
}

/** Groups and Buddies as one list: a reorder made here first, then the saved positions; new ones last. */
export function mergeBuddyList(buddies: BuddySummary[], groups: BuddyGroup[], order: string[] | null): BuddyListEntry[] {
  const entries: BuddyListEntry[] = [...buddies, ...groups.map(groupEntry)];
  const placed = new Map(order?.map((id, index) => [id, index]));
  const rank = (entry: BuddyListEntry) => placed.get(entry.id) ?? (order ? Number.MAX_SAFE_INTEGER : entry.sort_position ?? Number.MAX_SAFE_INTEGER);
  return entries.map((entry, index) => ({ entry, index })).sort((a, b) => rank(a.entry) - rank(b.entry) || a.index - b.index).map(({ entry }) => entry);
}
