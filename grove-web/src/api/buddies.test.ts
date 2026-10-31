import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "./client";

vi.mock("./client", () => ({ apiClient: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() } }));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("Buddy API mock switch", () => {
  it("uses mock data only when explicitly enabled", async () => {
    vi.stubEnv("VITE_BUDDIES_MOCK", "true");
    const api = await import("./buddies");
    expect(await api.listBuddies()).toHaveLength(3);
    const created = await api.createBuddy({ name: "Docs", agent: "codex" });
    await api.getBuddy(created.id);
    await api.updateBuddy(created.id, { role: "Maintain docs" });
    await api.switchBuddyAgent(created.id, { agent: "claude-code" });
    const [delegation] = await api.listBuddyDelegations("mock-release");
    await api.cancelBuddyDelegation("mock-release", delegation.id);
    await api.reorderBuddies((await api.listBuddies()).map((buddy) => buddy.id).reverse());
    await api.archiveBuddy(created.id);
    await expect(api.getBuddy("missing")).rejects.toMatchObject({ status: 404 });
    for (const method of Object.values(apiClient)) expect(method).not.toHaveBeenCalled();
  });

  it("uses the documented routes and encodes IDs when mock is disabled", async () => {
    vi.stubEnv("VITE_BUDDIES_MOCK", "false");
    const api = await import("./buddies");
    const id = "buddy/with space";
    const path = "/api/v1/buddies/buddy%2Fwith%20space";
    const detail = { id, name: "Docs", agent: "codex", running_delegations: 0, local_task_id: "_local", role: "", system_prompt: "", agent_config: { source: "default", agent_id: "codex" } };
    vi.mocked(apiClient.get).mockResolvedValueOnce([detail]).mockResolvedValueOnce(detail).mockResolvedValueOnce([]);
    vi.mocked(apiClient.post).mockResolvedValue(detail);
    vi.mocked(apiClient.patch).mockResolvedValue(detail);
    expect(await api.listBuddies()).toEqual([detail]);
    expect(await api.getBuddy(id)).toEqual(detail);
    expect(await api.listBuddyDelegations(id)).toEqual([]);
    expect(apiClient.get).toHaveBeenNthCalledWith(1, "/api/v1/buddies");
    expect(apiClient.get).toHaveBeenNthCalledWith(2, path);
    expect(apiClient.get).toHaveBeenNthCalledWith(3, `${path}/delegations`);

    const input = { name: "Docs", agent: "codex", agent_config: { source: "config_options" as const, agent_id: "codex", values: { reasoning_effort: "high" } } };
    expect(await api.createBuddy(input)).toEqual(detail);
    expect(apiClient.post).toHaveBeenLastCalledWith("/api/v1/buddies", input);
    await api.updateBuddy(id, { role: "Maintain docs" });
    expect(apiClient.patch).toHaveBeenLastCalledWith(path, { role: "Maintain docs" });
    await api.switchBuddyAgent(id, { agent: "claude-code" });
    expect(apiClient.post).toHaveBeenLastCalledWith(`${path}/agent`, { agent: "claude-code" });
    await api.reorderBuddies([id]);
    expect(apiClient.patch).toHaveBeenLastCalledWith("/api/v1/buddies/order", { ids: [id] });
    await api.cancelBuddyDelegation(id, "delegation/id");
    expect(apiClient.post).toHaveBeenLastCalledWith(`${path}/delegations/delegation%2Fid/cancel`);
    await api.archiveBuddy(id);
    expect(apiClient.delete).toHaveBeenCalledWith(path);
  });

  it("preserves backend errors instead of silently falling back to mock", async () => {
    vi.stubEnv("VITE_BUDDIES_MOCK", "false");
    const api = await import("./buddies");
    const busy = { status: 409, message: "Busy", data: { code: "buddy_busy" } };
    vi.mocked(apiClient.post).mockRejectedValue(busy);
    await expect(api.switchBuddyAgent("id", { agent: "codex" })).rejects.toBe(busy);
    const unavailable = { status: 503, message: "Unavailable" };
    vi.mocked(apiClient.get).mockRejectedValue(unavailable);
    await expect(api.listBuddies()).rejects.toBe(unavailable);
  });
});
