import { memorySource, type MemorySource } from "../components/Memory/memorySource";
import type { Buddy } from "./buddies";
import { BUDDIES_MOCK_ENABLED, buddiesMock } from "./buddies.mock";
import { deleteAutomation, createAutomation, listAutomations, triggerAutomation, updateAutomation, type Automation, type AutomationUpsert } from "./automations";
import { getMemoryOverview, getMemoryEntity, listMemoryEntities } from "./memory";
import { createConnect, listConnects, listConnectPlatforms, verifyConnectCredentials, type ConnectInput } from "./connects";

export async function listBuddyRoutines(buddy: Buddy) {
  return BUDDIES_MOCK_ENABLED ? buddiesMock.routines(buddy.id) : listAutomations(buddy.project_hash);
}
export async function setBuddyRoutineEnabled(buddy: Buddy, routine: Automation, enabled: boolean) {
  if (BUDDIES_MOCK_ENABLED) return buddiesMock.setRoutineEnabled(buddy.id, routine.id, enabled);
  return updateAutomation(buddy.project_hash, routine.id, {
    name: routine.name, enabled, agent_config: routine.agent_config, task_mode: routine.task_mode,
    task_id: routine.task_id, task_template: routine.task_template, session_mode: routine.session_mode,
    chat_id: routine.chat_id, session_template: routine.session_template, prompt: routine.prompt,
    schedule_cron: routine.schedule_cron, event_triggers: routine.event_triggers,
  });
}
export async function runBuddyRoutine(buddy: Buddy, id: string) {
  if (BUDDIES_MOCK_ENABLED) return buddiesMock.runRoutine(buddy.id, id);
  return triggerAutomation(buddy.project_hash, id);
}
export async function listBuddyMemories(buddy: Buddy, query: string) {
  if (BUDDIES_MOCK_ENABLED) return buddiesMock.memories(buddy.id, query);
  return (await listMemoryEntities(buddy.project_hash, query)).items;
}
export async function getBuddyMemory(buddy: Buddy, id: string) {
  return BUDDIES_MOCK_ENABLED ? buddiesMock.memory(buddy.id, id) : getMemoryEntity(buddy.project_hash, id);
}
export async function listBuddyConnects(buddy: Buddy) {
  if (BUDDIES_MOCK_ENABLED) return buddiesMock.connects(buddy.id);
  return (await listConnects()).filter((item) => item.buddy_id === buddy.id || item.project_id === buddy.project_hash);
}
export async function listBuddyConnectPlatforms() {
  return listConnectPlatforms();
}
export async function createBuddyConnect(buddy: Buddy, input: Pick<ConnectInput, "name" | "platform" | "domain" | "adapter_config">) {
  const target = { ...input, enabled: true, target: { kind: "buddy" as const, buddy_id: buddy.id }, project_id: buddy.project_hash, task_id: buddy.local_task_id, session_id: buddy.active_session_id };
  if (BUDDIES_MOCK_ENABLED) return buddiesMock.createConnect(buddy.id, target);
  await verifyConnectCredentials(input);
  return createConnect(target);
}

export async function createBuddyRoutine(buddy: Buddy, template: { name: string; prompt: string; cron: string }) {
  const input = { name: template.name, prompt: template.prompt, schedule_cron: template.cron, enabled: true, agent_config: buddy.agent_config, task_mode: "existing" as const, task_id: buddy.local_task_id, session_mode: "buddy_active" as const, event_triggers: [] };
  if (BUDDIES_MOCK_ENABLED) return buddiesMock.saveRoutine(buddy.id, input);
  return createAutomation(buddy.project_hash, input);
}

export async function saveBuddyRoutine(buddy: Buddy, input: AutomationUpsert, id?: string) {
  const value: AutomationUpsert = { ...input, agent_config: buddy.agent_config, task_mode: "existing", task_id: buddy.local_task_id, session_mode: "buddy_active", chat_id: undefined, task_template: undefined, session_template: undefined };
  if (BUDDIES_MOCK_ENABLED) return buddiesMock.saveRoutine(buddy.id, value, id);
  return id ? updateAutomation(buddy.project_hash, id, value) : createAutomation(buddy.project_hash, value);
}
export async function deleteBuddyRoutine(buddy: Buddy, id: string) {
  if (BUDDIES_MOCK_ENABLED) return buddiesMock.deleteRoutine(buddy.id, id);
  return deleteAutomation(buddy.project_hash, id);
}
export async function getBuddyMemoryCounts(buddy: Buddy) {
  if (BUDDIES_MOCK_ENABLED) return { entity_count: buddiesMock.memories(buddy.id).length, log_count: buddiesMock.logs(buddy.id).length };
  return getMemoryOverview(buddy.project_hash);
}
export function buddyMemorySource(buddy: Buddy): MemorySource {
  if (!BUDDIES_MOCK_ENABLED) return memorySource;
  return {
    listMemoryEntities: async (_project, query) => ({ items: buddiesMock.memories(buddy.id, query) }),
    getMemoryEntity: async (_project, id) => buddiesMock.memory(buddy.id, id),
    deleteMemoryEntity: async (_project, id) => buddiesMock.deleteMemory(buddy.id, id),
    listMemoryRelations: async () => ({ items: [] }),
    listMemoryLogs: async (_project, query) => ({ items: buddiesMock.logs(buddy.id, query) }),
    deleteMemoryLogs: async (_project, ids) => buddiesMock.deleteLogs(buddy.id, ids),
  };
}
