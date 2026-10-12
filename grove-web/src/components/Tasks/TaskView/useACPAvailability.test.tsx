import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { uninstallAgent, patchAgent } from "../../../api/marketplace";
import type { MarketplaceResponse, MarketplaceAgent } from "../../../api/marketplace";
import { useACPAvailability } from "./useACPAvailability";

const api = vi.hoisted(() => ({ get: vi.fn(), delete: vi.fn(), patch: vi.fn() }));
vi.mock("../../../api/client", () => ({
  apiClient: api,
  getApiHost: () => "localhost",
  appendHmacToUrl: async (url: string) => url,
}));
vi.mock("../../../api", () => ({
  getConfig: async () => ({ acp: { custom_agents: [] } }),
  listCustomAgents: async () => [],
}));
vi.mock("../../../utils/agentIcon", () => ({
  setMarketplaceIcons: vi.fn(),
  loadCustomAgentPersonas: (fetcher: () => Promise<unknown[]>) => fetcher(),
}));

class EventSocket {
  static instances: EventSocket[] = [];
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  constructor() { EventSocket.instances.push(this); }
  close() { this.onclose?.(); }
}

function snapshot(ids: string[]): MarketplaceResponse {
  return {
    agents: ids.map((id) => ({
      id, name: id, install_state: "grove-installed",
      installed: { hidden: false },
    }) as MarketplaceAgent),
    curated: [], registry_stale: false, registry_fetched_at: null,
  };
}

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  EventSocket.instances = [];
});

describe("live Agent availability", () => {
  it("updates mounted pickers after uninstall, hide, remote events, and reconnect", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("WebSocket", EventSocket);
    let current = snapshot(["claude-acp", "github-copilot-cli", "qwen-code"]);
    api.get.mockImplementation(async () => current);
    api.delete.mockImplementation(async () => { current = snapshot(["claude-acp", "qwen-code"]); });
    api.patch.mockImplementation(async () => {
      current.agents[1].installed!.hidden = true;
      return current.agents[1].installed;
    });
    const host = document.createElement("div");
    const root = createRoot(host);
    function Picker({ label }: { label: string }) {
      const { baseAgents } = useACPAvailability();
      return <div>{label}:{baseAgents.map((agent) => agent.id).join(",")}</div>;
    }
    try {
      await act(async () => { root.render(<><Picker label="session" /><Picker label="graph" /></>); });
      expect(host.textContent).toContain("session:claude-acp,github-copilot-cli,qwen-code");
      expect(EventSocket.instances).toHaveLength(1);
      await act(async () => { await uninstallAgent("github-copilot-cli", "npx"); vi.advanceTimersByTime(50); });
      expect(host.textContent).toBe("session:claude-acp,qwen-codegraph:claude-acp,qwen-code");
      await act(async () => { await patchAgent("qwen-code", { hidden: true }); vi.advanceTimersByTime(50); });
      expect(host.textContent).toBe("session:claude-acpgraph:claude-acp");

      // Another client installs an Agent, or a background PATH scan adds one.
      current = snapshot(["claude-acp", "hermes"]);
      await act(async () => {
        EventSocket.instances[0].onmessage?.({ data: JSON.stringify({ type: "agents_changed" }) });
        vi.advanceTimersByTime(50);
      });
      expect(host.textContent).toBe("session:claude-acp,hermesgraph:claude-acp,hermes");

      // Resynchronize a mutation missed while disconnected.
      current = snapshot([]);
      await act(async () => { EventSocket.instances[0].onopen?.(); vi.advanceTimersByTime(50); });
      expect(host.textContent).toBe("session:graph:");
    } finally {
      await act(async () => { root.unmount(); });
    }
  });
});
