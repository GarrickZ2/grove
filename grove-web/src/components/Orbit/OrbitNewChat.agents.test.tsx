import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { listInstalledAgentConfigs } from "../../api/marketplace";
import { OrbitNewChat } from "./OrbitNewChat";

const state = vi.hoisted(() => ({ phone: false, revision: 0, base: [] as { id: string; display_name: string; available: boolean }[] }));
vi.mock("../../api", () => ({ createChat: vi.fn(), listChats: vi.fn(async () => []) }));
vi.mock("../../api/marketplace", () => ({ listInstalledAgentConfigs: vi.fn() }));
vi.mock("../../context", () => {
  const project = { id: "project", name: "Project", exists: true, localTask: { id: "_local" }, tasks: [] };
  return {
    useProject: () => ({ projects: [project], selectedProject: project, selectProject: vi.fn() }),
    useTheme: () => ({ theme: { accentPalette: ["#3370ff"] } }),
  };
});
vi.mock("../../hooks", () => ({ useIsMobile: () => ({ isMobile: state.phone }) }));
vi.mock("../../hooks/useAgentCatalogRevision", () => ({ useAgentCatalogRevision: () => state.revision }));
vi.mock("../Config/MarketplaceModal", () => ({
  MarketplaceModal: ({ open, initialTab }: { open: boolean; initialTab?: string }) => open ? <div data-testid="marketplace" data-tab={initialTab} /> : null,
}));
vi.mock("../Tasks/TaskView/useACPAvailability", () => ({
  useACPAvailability: () => ({ baseAgents: state.base, customAgents: [], customAgentPersonas: [], acpAvailabilityLoaded: true }),
}));
vi.mock("../Tasks/TaskView/ChatConfigMenus", () => ({ DropdownSelect: () => null, SessionSettingsMenu: () => null }));
vi.mock("../Tasks/TaskView/composer/useMentionSources", () => ({
  useMentionSources: () => ({ items: [], browserTabs: [], browserTabsAvailable: false, studio: false, refresh: vi.fn(), loadBrowserTabs: vi.fn() }),
}));
vi.mock("../Tasks/TaskView/useInitialChatLoad", () => ({ buildDefaultSessionTitle: () => "New Chat" }));

const claude = { id: "claude-acp", name: "Claude", capability_snapshot: null, capability_updated_at: null };
const codex = { id: "codex-acp", name: "Codex", capability_snapshot: null, capability_updated_at: null };
const available = (...agents: typeof claude[]) => agents.map((agent) => ({ id: agent.id, display_name: agent.name, available: true }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  Object.assign(state, { phone: false, revision: 0, base: available(claude, codex) });
  vi.mocked(listInstalledAgentConfigs).mockResolvedValue([claude, codex]);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const render = () => act(async () => root.render(<OrbitNewChat onNavigate={vi.fn()} />));
const chip = () => host.querySelector<HTMLButtonElement>(".oc-setup-chip")!;
const marketplace = () => host.querySelector('[data-testid="marketplace"]');
const openAgents = async () => {
  await act(async () => chip().click());
  await act(async () => host.querySelector<HTMLButtonElement>('[data-row="agent"]')!.click());
};
const item = (label: string) => [...host.querySelectorAll<HTMLButtonElement>(".oc-sub-item")].find((option) => option.textContent === label);
const catalogChanges = async (...agents: typeof claude[]) => {
  vi.mocked(listInstalledAgentConfigs).mockResolvedValue(agents);
  state.base = available(...agents);
  state.revision += 1;
  await render();
};

it("keeps the chosen Agent when the catalog changes", async () => {
  await render();
  await openAgents();
  await act(async () => item("Codex")!.click());
  expect(chip().textContent).toContain("Codex");

  await catalogChanges(claude, codex);
  expect(listInstalledAgentConfigs).toHaveBeenCalledTimes(2);
  expect(chip().textContent).toContain("Codex");
});

it("moves on when the chosen Agent is gone", async () => {
  await render();
  await openAgents();
  await act(async () => item("Codex")!.click());
  await catalogChanges(claude);
  expect(chip().textContent).toContain("Claude");
});

it("offers Manage agents... under the Agent list", async () => {
  await render();
  await openAgents();
  await act(async () => item("Manage agents...")!.click());
  expect(marketplace()?.getAttribute("data-tab")).toBe("installed");
});

it("offers Add an agent when none are available", async () => {
  state.base = [];
  vi.mocked(listInstalledAgentConfigs).mockResolvedValue([]);
  await render();
  expect(chip().textContent).toBe("Add an agent");
  await act(async () => chip().click());
  expect(marketplace()?.getAttribute("data-tab")).toBe("explore");
});

it("shows neither on a phone", async () => {
  state.phone = true;
  state.base = [];
  vi.mocked(listInstalledAgentConfigs).mockResolvedValue([]);
  await render();
  expect(chip().textContent).not.toContain("Add an agent");
  await act(async () => chip().click());
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>("button")].find((row) => row.textContent?.includes("Agent") && row !== chip())?.click());
  expect(document.body.textContent).not.toContain("Manage agents...");
});
