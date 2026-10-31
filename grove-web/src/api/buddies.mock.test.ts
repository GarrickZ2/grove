import { beforeEach, describe, expect, it } from "vitest";
import { createBuddiesMock } from "./buddies.mock";

describe("Buddy mock", () => {
  let mock: ReturnType<typeof createBuddiesMock>;
  beforeEach(() => { mock = createBuddiesMock(); });

  it("provides every list state and a distinct project/current Segment per Buddy", () => {
    const list = mock.list();
    expect(list.map((buddy) => buddy.status)).toEqual(["idle", "working", "waiting"]);
    const details = list.map((buddy) => mock.get(buddy.id));
    expect(new Set(details.map((buddy) => buddy.project_hash)).size).toBe(list.length);
    for (const buddy of details) {
      expect(buddy.local_task_id).toBe("_local");
      expect(buddy.agent_config).toEqual({ source: "default", agent_id: buddy.agent });
      expect(buddy.segments).toEqual([expect.objectContaining({ session_id: buddy.active_session_id, agent: buddy.agent, ended_at: null })]);
    }
  });

  it("creates an empty conversation and keeps caller data separate from stored data", () => {
    const config = { source: "config_options" as const, values: { model: "model-a", mode: "default", effort: "high" } };
    const buddy = mock.create({ name: "  Docs  ", agent: "codex", role: "Maintain docs", agent_config: config });
    expect(buddy).toMatchObject({ name: "Docs", role: "Maintain docs", status: "idle", last_message_preview: "", last_activity_at: null, running_delegations: 0 });
    expect(mock.list().at(-1)?.id).toBe(buddy.id);
    config.values.model = "changed by caller";
    buddy.segments[0].agent = "changed by caller";
    expect(mock.get(buddy.id).agent_config).toMatchObject({ values: { model: "model-a" } });
    expect(mock.get(buddy.id).segments[0].agent).toBe("codex");
  });

  it("patches config in place, preserving unedited fields and the current Segment", () => {
    const buddy = mock.create({ name: "Docs", agent: "codex", agent_config: { source: "config_options", values: { model: "model-a", effort: "high" } } });
    const updated = mock.update(buddy.id, { name: "New name", role: "New role", system_prompt: "Be concise", agent_config: { source: "config_options", values: { model: "model-b", effort: "high" } } });
    expect(updated).toMatchObject({ name: "New name", role: "New role", system_prompt: "Be concise", agent_config: { source: "config_options", values: { model: "model-b", effort: "high" } } });
    expect(updated.active_session_id).toBe(buddy.active_session_id);
    expect(updated.segments).toEqual(buddy.segments);
    expect(mock.update(buddy.id, { agent_config: { source: "config_options", values: { model: "model-b" } } }).agent_config).toEqual({ source: "config_options", values: { model: "model-b" } });
  });

  it("switches Agent by ending the old Segment and preserving the Buddy's project and instructions", () => {
    const before = mock.get("mock-chief");
    const after = mock.switchAgent(before.id, { agent: "codex", agent_config: { source: "config_options", values: { effort: "high" } } });
    expect(after.project_hash).toBe(before.project_hash);
    expect(after.role).toBe(before.role);
    expect(after.system_prompt).toBe(before.system_prompt);
    expect(after.segments).toHaveLength(2);
    expect(after.segments[0].session_id).toBe(before.active_session_id);
    expect(after.segments[0].ended_at).toBe(after.segments[1].started_at);
    expect(after.segments[1]).toMatchObject({ session_id: after.active_session_id, seq: 2, agent: "codex", ended_at: null });
    expect(after.active_session_id).not.toBe(before.active_session_id);
    expect(mock.switchAgent(after.id, { agent: "codex" }).segments).toHaveLength(2);
  });

  it.each(["mock-release", "mock-inbox"])("rejects switching %s while busy without changing data", (id) => {
    const before = mock.get(id);
    expect(() => mock.switchAgent(id, { agent: "other" })).toThrow(expect.objectContaining({ status: 409, data: { code: "buddy_busy" } }));
    expect(mock.get(id)).toEqual(before);
  });

  it("archives without deleting details, history or delegations", () => {
    const before = mock.get("mock-release");
    const delegations = mock.listDelegations(before.id);
    mock.archive(before.id);
    expect(mock.list().some((buddy) => buddy.id === before.id)).toBe(false);
    expect(mock.get(before.id)).toEqual(before);
    expect(mock.listDelegations(before.id)).toEqual(delegations);
  });

  it("orders active Buddies and rejects invalid orders atomically", () => {
    mock.archive("mock-inbox");
    mock.reorder(["mock-release", "mock-chief"]);
    const ids = () => mock.list().map((buddy) => buddy.id);
    expect(ids()).toEqual(["mock-release", "mock-chief"]);
    for (const order of [["mock-chief"], ["mock-chief", "mock-chief"], ["mock-chief", "unknown"], ["mock-chief", "mock-inbox"]]) {
      expect(() => mock.reorder(order)).toThrow(expect.objectContaining({ status: 400 }));
      expect(ids()).toEqual(["mock-release", "mock-chief"]);
    }
  });

  it("supplies delegation fields and handles cancellation idempotently", () => {
    const [delegation] = mock.listDelegations("mock-release");
    expect(delegation).toMatchObject({ title: expect.any(String), target_project: expect.any(String), target_task: expect.any(String), target_session: expect.any(String), last_result: null, updated_at: expect.any(String) });
    mock.cancelDelegation("mock-release", delegation.id);
    mock.cancelDelegation("mock-release", delegation.id);
    expect(mock.listDelegations("mock-release")[0].status).toBe("cancelled");
    expect(mock.get("mock-release").running_delegations).toBe(0);
    expect(mock.get("mock-release").status).toBe("working");
  });

  it("rejects missing identities and blank required fields without creating data", () => {
    expect(() => mock.get("missing")).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => mock.create({ name: " ", agent: "codex" })).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => mock.create({ name: "Docs", agent: " " })).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => mock.update("mock-chief", { name: " " })).toThrow(expect.objectContaining({ status: 400 }));
    expect(mock.list()).toHaveLength(3);
    expect(mock.get("mock-chief").name).toBe("Chief");
  });
});
