vi.mock("./useAgentCatalogRevision", () => ({ useAgentCatalogRevision: () => 0 }));
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { listInstalledAgentConfigs } from "../api/marketplace";
import { useBuddyAgents } from "./useBuddyAgents";
vi.mock("../api/marketplace", () => ({ listInstalledAgentConfigs: vi.fn() }));
afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); });
it("exposes Agent loading failures instead of inventing an available Agent", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(listInstalledAgentConfigs).mockRejectedValue(new Error("Agent catalog unavailable"));
  let result!: ReturnType<typeof useBuddyAgents>;
  function Harness() { result = useBuddyAgents(); return null; }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Harness />));
  expect(result.agents).toEqual([]); expect(result.error).toBe("Agent catalog unavailable");
  act(() => root.unmount());
});
