import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrbitSettingsPage } from "./OrbitSettingsPage";
import { checkAllDependencies, getConfig, listApplications, listCustomAgents, patchConfig } from "../../api";
import { listMarketplace } from "../../api/marketplace";
import { getExtensionStatusDetails } from "../../api/extension";

const configContext = {
  config: { layout: {} },
  updateAvailability: vi.fn(),
  refresh: vi.fn(),
};

vi.mock("../../context", () => ({ useConfig: () => configContext, useTheme: () => ({ theme: { id: "light", name: "Light" } }) }));
vi.mock("../../hooks/useAgentCatalogRevision", () => ({ useAgentCatalogRevision: () => 0 }));
vi.mock("../../keyboard", () => ({ useKeyboardScope: () => undefined }));
vi.mock("../../keyboard/useEscapeScope", () => ({ useEscapeScope: () => undefined }));
vi.mock("../../components/ui", () => ({
  agentOptions: [],
  AgentPicker: ({ value }: { value: string }) => <div data-testid="agent-picker">{value}</div>,
  CustomAgentModal: () => null,
}));
vi.mock("../../components/Config/CustomAgentsModal", () => ({ CustomAgentsModal: () => null }));
vi.mock("../../components/Config/MarketplaceModal", () => ({ MarketplaceModal: () => null }));
vi.mock("../../components/Config/InstallExtensionDialog", () => ({ InstallExtensionDialog: () => null }));
vi.mock("../../components/Config/LayoutEditor", () => ({
  LayoutEditor: () => null,
  createDefaultLayout: () => ({ id: "default", name: "Default", root: { id: "root", type: "pane", paneType: "agent" } }),
}));
vi.mock("./pages/GeneralPage", () => ({ GeneralPage: () => <div>general body</div> }));
const previewTheme = {
  id: "paper", name: "Paper", isLight: true, accentPalette: [],
  colors: { bg: "#fdf6e3", bgSecondary: "#eee8d5", bgTertiary: "#ddd", border: "#ccc", text: "#586e75", textMuted: "#93a1a1",
    highlight: "#2aa198", accent: "#268bd2", success: "#859900", warning: "#b58900", error: "#dc322f", info: "#268bd2" },
};
vi.mock("./pages/AppearancePage", () => ({
  AppearancePage: ({ onPreviewTheme }: { onPreviewTheme: (theme: unknown) => void }) => (
    <>
      <button type="button" onClick={() => onPreviewTheme(previewTheme)}>preview paper</button>
      <button type="button" onClick={() => onPreviewTheme(null)}>revert preview</button>
    </>
  ),
}));
vi.mock("./pages/NotificationsPage", () => ({ NotificationsPage: () => <div>notifications body</div> }));
vi.mock("./pages/ShortcutsPage", () => ({ ShortcutsPage: () => <div>shortcuts body</div> }));
vi.mock("./pages/SystemPage", () => ({ SystemPage: () => <div>system body</div> }));
vi.mock("./pages/voice", () => ({
  VoiceInputPage: () => <div>voice input</div>,
  VoiceControlPage: () => <div>voice control</div>,
  AgentVoicePage: () => <div>agent voice</div>,
  AIProvidersPage: () => <div>ai providers</div>,
}));
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
  indexing: { enabled: true, disabled_languages: ["go"], supported_languages: [
    { id: "rust", display_name: "Rust", extensions: ["rs"] },
    { id: "go", display_name: "Go", extensions: ["go"] },
  ] },
  browser_control: { enabled: true, auto_groups: true },
};

/** Lets tests decide whether the content scroll container overflows. */
let contentHeight = 2000;
const resizeCallbacks = new Set<() => void>();
class FakeResizeObserver {
  private callback: () => void;
  constructor(callback: () => void) {
    this.callback = callback;
  }
  observe() {
    resizeCallbacks.add(this.callback);
    this.callback();
  }
  disconnect() {
    resizeCallbacks.delete(this.callback);
  }
}
function resizeContent(height: number) {
  contentHeight = height;
  act(() => resizeCallbacks.forEach((callback) => callback()));
}

describe("OrbitSettingsPage", () => {
  let container: HTMLDivElement;
  let root: Root;

  async function flush(ms = 0) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }
  const click = (element: Element | null | undefined) => {
    expect(element).toBeTruthy();
    act(() => (element as HTMLElement).click());
  };
  const navItem = (label: string) =>
    [...container.querySelectorAll(".ost-nitem")].find((item) => item.textContent?.includes(label));
  const buttonByText = (label: string) =>
    [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === label);
  const groupLabels = () => [...container.querySelectorAll(".oui-glabel")].map((label) => label.firstChild?.textContent);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    window.localStorage.clear();
    Element.prototype.scrollTo = vi.fn();
    contentHeight = 2000;
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("ost-content") ? contentHeight : 0;
    });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("ost-content") ? 800 : 0;
    });
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
    vi.restoreAllMocks();
    vi.resetAllMocks();
    vi.unstubAllGlobals();
    resizeCallbacks.clear();
    vi.useRealTimers();
  });

  async function render(pageLabel?: string) {
    act(() => root.render(<OrbitSettingsPage />));
    await flush();
    await flush(500);
    if (pageLabel) click(navItem(pageLabel));
  }

  it("always opens on Agents, first in the nav", async () => {
    await render();
    expect(container.querySelector("h1")?.textContent).toBe("Agents");
    expect(container.querySelector(".ost-nitem")?.textContent).toContain("Agents");
  });

  it("shows the Agents sections and flags the missing chat agent", async () => {
    await render();
    expect(container.querySelector("h1")?.textContent).toBe("Agents");
    expect(groupLabels()).toEqual(["Default agent", "Manage", "Browser control", "Chat history", "Render window"]);
    expect(navItem("Agents")?.querySelector('[aria-label="Needs setup"]')).not.toBeNull();
  });

  it("switches pages and saves pattern edits", async () => {
    await render("Workspace");
    expect(container.querySelector("h1")?.textContent).toBe("Workspace");

    const draft = container.querySelector<HTMLInputElement>('input[aria-label="New pattern"]')!;
    act(() => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(draft, "  **/dist ");
      draft.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      draft.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect([...container.querySelectorAll<HTMLInputElement>(".ost-pat-input")].map((input) => input.value)).toEqual(["node_modules", "**/dist"]);
    await flush(500);
    expect(vi.mocked(patchConfig).mock.lastCall?.[0]).toMatchObject({ auto_link: { patterns: ["node_modules", "**/dist"] } });
    expect(container.querySelector(".oui-saved")?.textContent).toContain("Saved");
  });

  it("toggles indexing languages as chips", async () => {
    await render("Workspace");
    const go = [...container.querySelectorAll(".ost-chip")].find((chip) => chip.textContent?.includes("Go"));
    expect(go?.getAttribute("aria-pressed")).toBe("false");
    click(go);
    await flush(500);
    expect(vi.mocked(patchConfig).mock.lastCall?.[0]).toMatchObject({ indexing: { disabled_languages: [] } });
  });

  it("only offers the terminal layout in multiplexer mode", async () => {
    await render("Workspace");
    expect(groupLabels()).toEqual(["Terminal", "Terminal layout", "AutoLink", "Code Indexing"]);
    expect([...container.querySelectorAll(".ost-subs.is-open .ost-sub")].map((sub) => sub.textContent)).toEqual(["Terminal", "Terminal layout", "AutoLink", "Code Indexing"]);
    expect(container.textContent).toContain("Zellij not found");

    click(buttonByText("Direct"));
    expect(groupLabels()).toEqual(["Terminal", "AutoLink", "Code Indexing"]);
    expect([...container.querySelectorAll(".ost-subs.is-open .ost-sub")].map((sub) => sub.textContent)).toEqual(["Terminal", "AutoLink", "Code Indexing"]);
    await flush(500);
    expect(vi.mocked(patchConfig).mock.lastCall?.[0]).toMatchObject({ web: { terminal_mode: "direct" } });
  });

  it("only lists sub-sections while the page content overflows", async () => {
    contentHeight = 800;
    await render();
    const openSubs = () => [...container.querySelectorAll(".ost-subs.is-open .ost-sub")].map((sub) => sub.textContent);
    expect(openSubs()).toEqual([]);
    resizeContent(803);
    expect(openSubs()).toEqual([]);
    resizeContent(1400);
    expect(openSubs()).toEqual(["Default agent", "Manage", "Browser control", "Chat history", "Render window"]);
    resizeContent(700);
    expect(openSubs()).toEqual([]);
  });

  it("shows Browser control inside Agents, without the MCP server group", async () => {
    await render();
    expect(container.querySelector("h1")?.textContent).toBe("Agents");
    expect(container.textContent).toContain("Allow AI browser action");
    expect(container.textContent).not.toContain("MCP");
    expect(navItem("Browser Control")).toBeUndefined();
  });

  it("previews a theme across the whole window, and reverts it", async () => {
    document.documentElement.style.setProperty("--color-bg", "#111111");
    await render("Appearance");
    click(buttonByText("preview paper"));
    expect(document.documentElement.style.getPropertyValue("--color-bg")).toBe("#fdf6e3");
    expect(container.textContent).toContain("Previewing Paper");
    expect(patchConfig).not.toHaveBeenCalledWith(expect.objectContaining({ theme: expect.anything() }));
    click(buttonByText("revert preview"));
    expect(document.documentElement.style.getPropertyValue("--color-bg")).toBe("#111111");
    expect(container.textContent).not.toContain("Previewing");
    document.documentElement.style.removeProperty("--color-bg");
  });

  it("jumps to the shortcuts page when #shortcuts is set", async () => {
    await render();
    act(() => {
      window.location.hash = "#shortcuts";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(container.querySelector("h1")?.textContent).toBe("Keyboard Shortcuts");
    expect(window.location.hash).toBe("");
  });
});
