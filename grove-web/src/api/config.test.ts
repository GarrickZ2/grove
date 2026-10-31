import { beforeEach, expect, it, vi } from "vitest";
import { getConfig, patchConfig, type Config } from "./config";
import { apiClient } from "./client";
import { invalidateAgentCatalog } from "./agentCatalogChanges";
vi.mock("./client", () => ({ apiClient: { get: vi.fn(), patch: vi.fn() } }));
vi.mock("./agentCatalogChanges", () => ({ invalidateAgentCatalog: vi.fn() }));
beforeEach(() => { vi.resetAllMocks(); });
it("reads the server config unchanged and forwards cancellation", async () => {
  const config = { web: { interface: "orbit" } } as Config;
  vi.mocked(apiClient.get).mockResolvedValue(config);
  const signal = new AbortController().signal;
  expect(await getConfig(signal)).toBe(config);
  expect(apiClient.get).toHaveBeenCalledWith("/api/v1/config", signal);
});
it("saves interface changes through the existing config API", async () => {
  const config = { web: { interface: "workbench" } } as Config;
  const patch = { web: { interface: "workbench" as const, terminal_mode: "direct" } };
  vi.mocked(apiClient.patch).mockResolvedValue(config);
  expect(await patchConfig(patch)).toBe(config);
  expect(apiClient.patch).toHaveBeenCalledWith("/api/v1/config", patch);
  expect(invalidateAgentCatalog).not.toHaveBeenCalled();
});
it("preserves Agent catalog invalidation after saving ACP settings", async () => {
  vi.mocked(apiClient.patch).mockResolvedValue({} as Config);
  await patchConfig({ acp: { agent_command: "codex-acp" } });
  expect(invalidateAgentCatalog).toHaveBeenCalledOnce();
});
