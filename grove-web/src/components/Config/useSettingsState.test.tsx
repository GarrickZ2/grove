import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsState, type SettingsState } from "./useSettingsState";
import { checkAllDependencies, getConfig, listApplications, listCustomAgents, patchConfig } from "../../api";
import { listMarketplace } from "../../api/marketplace";
import { getExtensionStatusDetails } from "../../api/extension";

const configContext = {
  config: { layout: {} },
  updateAvailability: vi.fn(),
  refresh: vi.fn(),
};

vi.mock("../../context", () => ({ useConfig: () => configContext }));
vi.mock("../../hooks/useAgentCatalogRevision", () => ({ useAgentCatalogRevision: () => 0 }));
vi.mock("../ui", () => ({ agentOptions: [] }));
vi.mock("../../api", () => ({
  getConfig: vi.fn(),
  patchConfig: vi.fn(),
  checkAllDependencies: vi.fn(),
  listApplications: vi.fn(),
  listCustomAgents: vi.fn(),
}));
vi.mock("../../api/marketplace", () => ({ listMarketplace: vi.fn() }));
vi.mock("../../api/extension", () => ({ getExtensionStatusDetails: vi.fn() }));

const serverConfig = {
  layout: { default: "agent-shell" },
  web: { ide: "", terminal: "", terminal_mode: "multiplexer", workspace_layout: "ide", show_hide_window_shortcut: "" },
  terminal_multiplexer: "tmux",
  auto_link: { patterns: ["node_modules"] },
  acp: { agent_command: "claude", custom_agents: [] },
  indexing: { enabled: true, disabled_languages: [], supported_languages: [] },
  browser_control: { enabled: true, auto_groups: true },
};

describe("useSettingsState", () => {
  let container: HTMLDivElement;
  let root: Root;
  let state: SettingsState;

  function Probe() {
    state = useSettingsState();
    return null;
  }

  async function flush(ms = 0) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    window.localStorage.clear();
    configContext.refresh.mockResolvedValue(undefined);
    vi.mocked(getConfig).mockResolvedValue(serverConfig as never);
    vi.mocked(patchConfig).mockResolvedValue(undefined as never);
    vi.mocked(checkAllDependencies).mockResolvedValue({
      dependencies: [
        { name: "tmux", installed: true, version: "3.4", install_command: "brew install tmux" },
        { name: "zellij", installed: false, version: null, install_command: "brew install zellij" },
      ],
    } as never);
    vi.mocked(listApplications).mockResolvedValue({ apps: [], platform: "macos" } as never);
    vi.mocked(listCustomAgents).mockResolvedValue([]);
    vi.mocked(listMarketplace).mockResolvedValue({ agents: [] } as never);
    vi.mocked(getExtensionStatusDetails).mockResolvedValue(null as never);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.resetAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("loads server config into state and reports terminal availability", async () => {
    act(() => root.render(<Probe />));
    await flush();
    expect(state.isLoaded).toBe(true);
    expect(state.acpAgent).toBe("claude");
    expect(state.autoLinkPatterns).toEqual(["node_modules"]);
    expect(state.webTerminalMode).toBe("multiplexer");
    expect(state.hasMultiplexer).toBe(true);
    expect(state.isTerminalAvailable).toBe(true);
    expect(configContext.updateAvailability).toHaveBeenCalledWith(true);
  });

  it("auto-saves changes after the debounce and only counts real changes as saved", async () => {
    act(() => root.render(<Probe />));
    await flush();
    await flush(500);
    // The first save after load just echoes what was loaded.
    expect(patchConfig).toHaveBeenCalledTimes(1);
    expect(state.savedCount).toBe(0);

    act(() => state.setIndexingEnabled(false));
    await flush(499);
    expect(patchConfig).toHaveBeenCalledTimes(1);
    await flush(1);
    expect(patchConfig).toHaveBeenCalledTimes(2);
    expect(vi.mocked(patchConfig).mock.calls[1][0]).toMatchObject({ indexing: { enabled: false } });
    expect(state.savedCount).toBe(1);
  });

  it("keeps chat history preferences in this browser and confirms them", async () => {
    act(() => root.render(<Probe />));
    await flush();
    await flush(500);
    const serverSaves = vi.mocked(patchConfig).mock.calls.length;

    act(() => state.setChatHistoryIncludeMedia(false));
    await flush(500);
    expect(vi.mocked(patchConfig).mock.calls.length).toBe(serverSaves);
    expect(JSON.parse(window.localStorage.getItem("grove:chat-history-preferences:v1") ?? "{}")).toMatchObject({ includeMedia: false });
    expect(state.savedCount).toBe(1);
  });

  it("falls back to direct terminals when no multiplexer is installed", async () => {
    vi.mocked(checkAllDependencies).mockResolvedValue({
      dependencies: [
        { name: "tmux", installed: false, version: null, install_command: "brew install tmux" },
        { name: "zellij", installed: false, version: null, install_command: "brew install zellij" },
      ],
    } as never);
    act(() => root.render(<Probe />));
    await flush();
    expect(state.webTerminalMode).toBe("direct");
    expect(state.isTerminalAvailable).toBe(true);
  });
});
