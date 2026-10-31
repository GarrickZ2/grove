vi.hoisted(() => vi.stubEnv("VITE_BUDDIES_MOCK", "false"));
import { expect, it, vi } from "vitest";
import { saveBuddyRoutine, deleteBuddyRoutine, getBuddyMemoryCounts, buddyMemorySource } from "./buddyResources";
import { createAutomation, updateAutomation, deleteAutomation } from "./automations";
import { getMemoryOverview, listMemoryLogs } from "./memory";
import { createBuddiesMock } from "./buddies.mock";
vi.mock("./automations", () => ({ createAutomation: vi.fn(), updateAutomation: vi.fn(), deleteAutomation: vi.fn(), listAutomations: vi.fn(), triggerAutomation: vi.fn() }));
vi.mock("./memory", () => ({ getMemoryOverview: vi.fn(), listMemoryEntities: vi.fn(), getMemoryEntity: vi.fn(), deleteMemoryEntity: vi.fn(), listMemoryLogs: vi.fn(), deleteMemoryLogs: vi.fn(), listMemoryRelations: vi.fn() }));
it("uses existing project APIs and binds routines to the Buddy's active segment dynamically", async () => {
  const buddy = createBuddiesMock().get("mock-chief");
  const input = { name: "Review", prompt: "Review", enabled: true, schedule_cron: "0 9 * * *", task_mode: "new" as const, session_mode: "new" as const, agent_config: { source: "default" as const }, chat_id: "old", task_template: { name: "unwanted" } };
  await saveBuddyRoutine(buddy, input);
  expect(createAutomation).toHaveBeenCalledWith(buddy.project_hash, expect.objectContaining({ task_mode: "existing", task_id: "_local", session_mode: "buddy_active", chat_id: undefined, task_template: undefined, agent_config: buddy.agent_config }));
  await saveBuddyRoutine(buddy, input, "routine"); expect(updateAutomation).toHaveBeenCalledWith(buddy.project_hash, "routine", expect.anything());
  await deleteBuddyRoutine(buddy, "routine"); expect(deleteAutomation).toHaveBeenCalledWith(buddy.project_hash, "routine");
  await getBuddyMemoryCounts(buddy); expect(getMemoryOverview).toHaveBeenCalledWith(buddy.project_hash);
  await buddyMemorySource(buddy).listMemoryLogs(buddy.project_hash, "query"); expect(listMemoryLogs).toHaveBeenCalledWith(buddy.project_hash, "query");
});
