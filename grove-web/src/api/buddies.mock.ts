import type { Buddy, BuddyAgentConfig, BuddyDelegation, BuddySummary, CreateBuddyInput, SwitchBuddyAgentInput, UpdateBuddyInput } from "./buddies";
import type { ApiError } from "./client";
import type { Automation, AutomationUpsert, TriggerResult } from "./automations";
import type { MemoryEntityDocument, MemoryLog } from "./memory";
import type { ConnectInput, ConnectItem, ConnectPlatform } from "./connects";
import type { BuddyEvent } from "../components/Buddy/timeline/buddyTimelineState";

/** Explicit preview switch: set VITE_BUDDIES_MOCK=true to simulate Buddy REST.
 * Normal builds use existing backend APIs.
 * Mock changes live in memory and reset on page reload. No real projects,
 * sessions, routines or connections are created or changed.
 * Remove this module and its branches in buddies.ts when REST is ready.
 */
export const BUDDIES_MOCK_ENABLED = import.meta.env.VITE_BUDDIES_MOCK === "true";

export interface MockBuddyMessage { id: string; role: "user" | "assistant"; text: string; files: string[] }

const MOCK_NOW = "2026-10-30T18:00:00.000Z";

// §12 fields are all supplied here, including the not-yet-contracted
// running_delegations, project/task identity, config and Segment timestamps.
function seedBuddies(): Buddy[] {
  return [
    { id: "mock-chief", name: "Chief", role: "Help plan the day", status: "idle", agent: "claude-code", preview: "Ready when you are." },
    { id: "mock-release", name: "Release Captain", role: "Keep release work on track", status: "working", agent: "codex", preview: "Checking the release checklist." },
    { id: "mock-inbox", name: "Inbox", role: "Help review incoming requests", status: "waiting", agent: "claude-code", preview: "Please review the proposed reply." },
  ].map((seed): Buddy => ({
    id: seed.id,
    name: seed.name,
    avatar: null,
    description: seed.role,
    role: seed.role,
    system_prompt: "",
    agent: seed.agent,
    agent_config: { source: "default", agent_id: seed.agent },
    status: seed.status as Buddy["status"],
    last_message_preview: seed.preview,
    last_activity_at: MOCK_NOW,
    active_session_id: `${seed.id}-session-1`,
    running_delegations: seed.status === "working" ? 1 : 0,
    project_hash: `${seed.id}-project`,
    local_task_id: "_local",
    segments: [{ session_id: `${seed.id}-session-1`, seq: 1, agent: seed.agent, started_at: MOCK_NOW, ended_at: null }],
  }));
}

function fail(status: number, code: string, message: string): never {
  throw { status, message, data: { code } } satisfies ApiError;
}

function required(value: string, field: string) {
  if (!value.trim()) fail(400, "invalid_input", `${field} is required`);
}

function mergeConfig(current: BuddyAgentConfig, patch?: BuddyAgentConfig): BuddyAgentConfig {
  return structuredClone(patch ?? current);
}

/** Separate stores let tests exercise mutations without sharing fixture state. */
export function createBuddiesMock() {
  const buddies = new Map(seedBuddies().map((buddy) => [buddy.id, buddy]));
  const archived = new Set<string>();
  const transcripts = new Map<string, MockBuddyMessage[]>();
  const responses = new Map<string, BuddyEvent[]>();
  const routineStore = new Map<string, Automation[]>();
  const removedMemories = new Set<string>();
  const removedLogs = new Set<string>();
  const connectionStore = new Map<string, ConnectItem[]>();
  let order = [...buddies.keys()];
  const delegations = new Map<string, BuddyDelegation[]>([
    ["mock-release", [{
      id: "mock-release-check", title: "Check release readiness", status: "running",
      target_project: "mock-release-project", target_task: "mock-release-task",
      target_session: "mock-release-delegation-session", last_result: null, updated_at: MOCK_NOW,
    }]],
  ]);

  const get = (id: string): Buddy => {
    const buddy = buddies.get(id);
    if (!buddy) fail(404, "buddy_not_found", "Buddy not found");
    return buddy;
  };

  return {
    saveRoutine(id: string, input: AutomationUpsert, routineId: string = crypto.randomUUID()): Automation {
      const buddy = get(id);
      const existing = routineStore.get(id) ?? [];
      const now = Math.floor(Date.now() / 1000);
      const routine: Automation = { ...input, id: routineId, project: buddy.project_hash, handler_key: "builtin.task_prompt", created_at: now, updated_at: now, next_run_at: input.enabled ? now + 86400 : undefined };
      routineStore.set(id, [...existing.filter(item => item.id !== routineId), routine]);
      return structuredClone(routine);
    },
    deleteRoutine(id: string, routineId: string) {
      get(id); routineStore.set(id, (routineStore.get(id) ?? []).filter(item => item.id !== routineId));
    },
    routines(id: string): Automation[] {
      const buddy = get(id);
      if (!routineStore.has(id)) routineStore.set(id, [{ id: `${id}-daily`, project: buddy.project_hash, name: "Daily check-in", enabled: true, handler_key: "builtin.task_prompt", agent_config: { source: "default", agent_id: buddy.agent }, task_mode: "existing", task_id: buddy.local_task_id, session_mode: "existing", chat_id: buddy.active_session_id, prompt: "Review today's priorities", schedule_cron: "0 9 * * *", next_run_at: Math.floor(Date.now() / 1000) + 86400, created_at: 1793383200, updated_at: 1793383200 }]);
      return structuredClone(routineStore.get(id)!);
    },
    setRoutineEnabled(id: string, routineId: string, enabled: boolean): Automation {
      get(id);
      const routine = routineStore.get(id)?.find((item) => item.id === routineId);
      if (!routine) fail(404, "routine_not_found", "Routine not found");
      routine.enabled = enabled;
      return structuredClone(routine);
    },
    runRoutine(id: string, routineId: string): TriggerResult {
      get(id);
      const routine = routineStore.get(id)?.find((item) => item.id === routineId);
      if (!routine) fail(404, "routine_not_found", "Routine not found");
      routine.last_run_at = Math.floor(Date.now() / 1000); routine.last_run_status = "success";
      return { run_id: crypto.randomUUID(), status: "success" };
    },
    memories(id: string, query = ""): MemoryEntityDocument[] {
      const buddy = get(id);
      const items: MemoryEntityDocument[] = [{ project_id: buddy.project_hash, entity_id: `${id}-preferences`, file_path: "preferences.md", title: `${buddy.name}'s working notes`, description: buddy.role || "Preferred way of working", body: `# Working notes\n\n${buddy.role || "Help with day-to-day work."}\n\nKeep answers clear and confirm decisions with the user.`, tags: [], base_score: 1, access_count: 0, score: 1, created_at: MOCK_NOW, updated_at: MOCK_NOW }];
      return items.filter((item) => !removedMemories.has(item.entity_id)).filter((item) => `${item.title} ${item.description}`.toLowerCase().includes(query.toLowerCase()));
    },
    deleteMemory(id: string, memoryId: string) { get(id); removedMemories.add(memoryId); },
    logs(id: string, query = ""): MemoryLog[] {
      const buddy = get(id);
      return [{ id: `${id}-log`, project_id: buddy.project_hash, task_id: buddy.local_task_id, chat_id: buddy.active_session_id, agent: buddy.agent, title: "Working preferences", description: "Keep answers clear and confirm decisions with the user.", tags: ["preferences"], created_at: MOCK_NOW }].filter(log => !removedLogs.has(log.id) && `${log.title} ${log.description}`.toLowerCase().includes(query.toLowerCase()));
    },
    deleteLogs(id: string, ids: string[]) { get(id); ids.forEach(key => removedLogs.add(key)); return { deleted: ids.length }; },
    memory(id: string, memoryId: string): MemoryEntityDocument {
      const memory = this.memories(id).find((item) => item.entity_id === memoryId);
      if (!memory) fail(404, "memory_not_found", "Memory not found");
      return memory;
    },
    connects(id: string): ConnectItem[] {
      const buddy = get(id);
      return structuredClone((connectionStore.get(id) ?? []).map((item) => ({ ...item, session_id: buddy.active_session_id, target: { ...item.target, agent: buddy.agent } })));
    },
    connectPlatforms(): ConnectPlatform[] {
      return [{ id: "feishu", name: "Feishu", description: "Connect Feishu messages", available: true, setup_modes: ["manual"], config_fields: [{ key: "app_id", label: "App ID", secret: false, required: true, placeholder: "App ID" }, { key: "app_secret", label: "App secret", secret: true, required: true, placeholder: "App secret" }], capabilities: { private_chat: true, group_chat: true, reactions: false, cards: true, qr_registration: false } }];
    },
    createConnect(id: string, input: ConnectInput): ConnectItem {
      const buddy = get(id);
      const item: ConnectItem = { ...input, adapter_config: {}, id: `mock-connect-${crypto.randomUUID()}`, project_id: buddy.project_hash, task_id: buddy.local_task_id, session_id: buddy.active_session_id, created_at: Date.now() / 1000, updated_at: Date.now() / 1000, runtime: { state: "online" }, target: { agent: buddy.agent, state: "idle", queue_mode: "separate" } };
      connectionStore.set(id, [...(connectionStore.get(id) ?? []), item]);
      return structuredClone(item);
    },
    messages(id: string): MockBuddyMessage[] { return structuredClone(transcripts.get(get(id).active_session_id) ?? []); },
    events(id: string): BuddyEvent[] {
      const buddy = get(id);
      const events: BuddyEvent[] = this.messages(id).flatMap(message => message.role === "user" ? [{ type: "user_message", text: message.text, message_id: message.id, attachments: message.files.map(name => ({ type: "resource_link", name })) }] : [{ type: "message_chunk", text: message.text, message_id: message.id }, { type: "complete" }]);
      if (id === "mock-inbox") events.unshift({ type: "permission_request", id: "mock-approval", title: "Send the proposed reply", detail: "Thanks for the update. I will review the request today.", options: [{ option_id: "reject", name: "Reject", kind: "reject_once" }, { option_id: "allow", name: "Allow once", kind: "allow_once" }] });
      if (buddy.status === "working") events.push({ type: "prompt_started" }, { type: "tool_call", id: "mock-check", title: "Checking the release checklist" });
      return [...events, ...(responses.get(buddy.active_session_id) ?? [])];
    },
    respond(id: string, event: BuddyEvent) {
      const buddy = get(id);
      const response = event.type === "elicitation_response" ? { type: "elicitation_resolved", request_id: event.id, action: event.action } : event;
      responses.set(buddy.active_session_id, [...(responses.get(buddy.active_session_id) ?? []), response]);
      buddy.status = "idle";
      return response;
    },
    sendMessage(id: string, text: string, files: string[]): void {
      const buddy = get(id);
      const messages = transcripts.get(buddy.active_session_id) ?? [];
      messages.push({ id: crypto.randomUUID(), role: "user", text, files: [...files] });
      messages.push({ id: crypto.randomUUID(), role: "assistant", text: `I can help with ${buddy.role || "your next step"}. What would you like to focus on?`, files: [] });
      transcripts.set(buddy.active_session_id, messages);
      buddy.last_activity_at = new Date().toISOString(); buddy.last_message_preview = messages.at(-1)!.text; buddy.status = "idle";
    },
    stop(id: string): void { get(id).status = "idle"; },
    list(): BuddySummary[] {
      return order.filter((id) => !archived.has(id)).map((id) => {
        const buddy = get(id);
        return {
          id: buddy.id, name: buddy.name, avatar: buddy.avatar, description: buddy.description,
          agent: buddy.agent, status: buddy.status, last_message_preview: buddy.last_message_preview,
          last_activity_at: buddy.last_activity_at, active_session_id: buddy.active_session_id,
          running_delegations: buddy.running_delegations,
        };
      });
    },
    get(id: string): Buddy { return structuredClone(get(id)); },
    create(input: CreateBuddyInput): Buddy {
      required(input.name, "Name");
      required(input.agent, "Agent");
      const id = `mock-${crypto.randomUUID()}`;
      const now = new Date().toISOString();
      const sessionId = `${id}-session-1`;
      const buddy: Buddy = {
        id, name: input.name.trim(), agent: input.agent, avatar: input.avatar ?? null,
        description: input.description ?? "", role: input.role ?? "", system_prompt: input.system_prompt ?? "",
        agent_config: mergeConfig({ source: "default", agent_id: input.agent }, input.agent_config),
        status: "idle", last_message_preview: "", last_activity_at: null,
        active_session_id: sessionId, running_delegations: 0,
        project_hash: `${id}-project`, local_task_id: "_local",
        segments: [{ session_id: sessionId, seq: 1, agent: input.agent, started_at: now, ended_at: null }],
      };
      buddies.set(id, buddy);
      order.push(id);
      return structuredClone(buddy);
    },
    update(id: string, input: UpdateBuddyInput): Buddy {
      const buddy = get(id);
      if (input.name !== undefined) required(input.name, "Name");
      if (input.name !== undefined) buddy.name = input.name.trim();
      if (input.avatar !== undefined) buddy.avatar = input.avatar;
      if (input.description !== undefined) buddy.description = input.description;
      if (input.role !== undefined) buddy.role = input.role;
      if (input.system_prompt !== undefined) buddy.system_prompt = input.system_prompt;
      if (input.agent_config !== undefined) buddy.agent_config = mergeConfig(buddy.agent_config, input.agent_config);
      return structuredClone(buddy);
    },
    switchAgent(id: string, input: SwitchBuddyAgentInput): Buddy {
      const buddy = get(id);
      required(input.agent, "Agent");
      if (buddy.status !== "idle") fail(409, "buddy_busy", "Stop the current turn to switch Agent");
      if (buddy.agent === input.agent) return structuredClone(buddy);
      const now = new Date().toISOString();
      const current = buddy.segments.find((segment) => segment.session_id === buddy.active_session_id);
      if (current) current.ended_at = now;
      const seq = buddy.segments.length + 1;
      buddy.active_session_id = `${id}-session-${seq}`;
      buddy.agent = input.agent;
      buddy.agent_config = mergeConfig({ source: "default", agent_id: input.agent }, input.agent_config);
      buddy.segments.push({ session_id: buddy.active_session_id, seq, agent: input.agent, started_at: now, ended_at: null });
      return structuredClone(buddy);
    },
    archive(id: string): void {
      get(id);
      archived.add(id);
    },
    reorder(ids: string[]): void {
      const activeIds = order.filter((id) => !archived.has(id));
      if (ids.length !== activeIds.length || new Set(ids).size !== ids.length || ids.some((id) => !activeIds.includes(id))) {
        fail(400, "invalid_order", "Include every active Buddy exactly once");
      }
      order = [...ids, ...order.filter((id) => archived.has(id))];
    },
    listDelegations(id: string): BuddyDelegation[] {
      get(id);
      return structuredClone(delegations.get(id) ?? []);
    },
    cancelDelegation(id: string, delegationId: string): void {
      const buddy = get(id);
      const delegation = delegations.get(id)?.find((item) => item.id === delegationId);
      if (!delegation) fail(404, "delegation_not_found", "Delegation not found");
      if (delegation.status !== "running" && delegation.status !== "waiting") return;
      if (delegation.status === "running") buddy.running_delegations = Math.max(0, buddy.running_delegations - 1);
      delegation.status = "cancelled";
      delegation.updated_at = new Date().toISOString();
    },
  };
}

export const buddiesMock = createBuddiesMock();
