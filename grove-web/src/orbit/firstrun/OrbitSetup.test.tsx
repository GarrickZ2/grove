import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OrbitSetup } from "./OrbitSetup";

const mocks = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  agents: [] as unknown[],
  npx: true,
  patchAgent: vi.fn(async () => ({})),
  tools: [] as unknown[],
  installSetupTool: vi.fn(async () => {}),
  invalidateAgentCatalog: vi.fn(),
  select: vi.fn(async () => {}),
  permissions: null as { accessibility: string; screenRecording: string } | null,
  requestComputerPermission: vi.fn(async () => ({})),
  setAppearance: vi.fn(),
}));

function tool(id: string, installed: boolean, more: Record<string, unknown> = {}) {
  return { id, installed, command: null, run: false, url: null, installing: false, line: "", error: null, handed_over: false, ...more };
}
function app(name: string) {
  return { name, path: `/Applications/${name}.app` };
}

function agent(id: string, name: string, state: string, method: string) {
  return { id, name, icon_url: null, install_state: state, installed: { hidden: false, installations: [{ method }] } };
}

vi.mock("../../components/Config/useSettingsState", () => ({ useSettingsState: () => mocks.settings }));
vi.mock("../../api/marketplace", () => ({
  listMarketplace: vi.fn(async () => ({ agents: mocks.agents, npx_available: mocks.npx })),
  patchAgent: mocks.patchAgent,
}));
vi.mock("../../hooks/useAgentCatalogRevision", () => ({ useAgentCatalogRevision: () => 0 }));
vi.mock("../../components/Config/MarketplaceModal", () => ({ MarketplaceModal: () => null }));
vi.mock("../../components/Layout/GroveIcon", () => ({ GroveIcon: () => null }));
vi.mock("../../api/browser", () => ({
  getComputerPermissions: vi.fn(async () => mocks.permissions),
  requestComputerPermission: mocks.requestComputerPermission,
}));
vi.mock("../../components/Config/InstallExtensionDialog", () => ({
  InstallExtensionDialog: () => <div data-testid="install-companion" />,
}));
vi.mock("../../api/setup", () => ({ getSetupTools: vi.fn(async () => mocks.tools), installSetupTool: mocks.installSetupTool }));
vi.mock("../../api/agentCatalogChanges", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../api/agentCatalogChanges")>(),
  invalidateAgentCatalog: mocks.invalidateAgentCatalog,
}));
vi.mock("../../components/ui/AppIcon", () => ({ AppIcon: () => null }));
vi.mock("../../components/ui", async () => {
  const picker = await vi.importActual<typeof import("../../components/ui/AppPicker")>("../../components/ui/AppPicker");
  return {
    AppIcon: () => null,
    AppPicker: ({ placeholder, value, applications }: { placeholder: string; value: string; applications: unknown[] }) => (
      <div data-testid="app-menu" data-value={value} data-apps={applications.length}>{placeholder}</div>
    ),
    ideAppOptions: picker.ideAppOptions, terminalAppOptions: picker.terminalAppOptions, pickableApps: picker.pickableApps,
  };
});
vi.mock("../../components/Config/useAppIconSelection", () => ({
  useAppIconSelection: () => ({ appIcon: "classic", isLight: true, saving: false, error: null, select: mocks.select }),
}));
vi.mock("../../context", () => ({
  useTheme: () => ({
    mode: "auto", lightThemeId: "light", darkThemeId: "dark", setAppearance: mocks.setAppearance,
    themes: [
      { id: "light", name: "Light", isLight: true, colors: { bg: "#fff", highlight: "#059669" } },
      { id: "nord", name: "Nord", isLight: false, colors: { bg: "#2e3440", highlight: "#88c0d0" } },
    ],
  }),
}));
vi.mock("../../notifications/desktopNotifier", () => ({ requestBrowserNotificationPermission: vi.fn(async () => {}) }));
vi.mock("../../utils/agentIcon", () => ({ agentIconComponent: () => () => null, setMarketplaceIcons: vi.fn() }));

let host: HTMLDivElement;
let root: Root;
let onDone: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.patchAgent.mockClear();
  mocks.installSetupTool.mockClear();
  mocks.invalidateAgentCatalog.mockClear();
  mocks.select.mockClear();
  mocks.requestComputerPermission.mockClear();
  mocks.permissions = null;
  mocks.setAppearance.mockClear();
  mocks.tools = [tool("node", true), tool("git", true)];
  mocks.npx = true;
  mocks.agents = [
    agent("claude-acp", "Claude Agent", "auto-detected", "external"),
    agent("codex-acp", "Codex", "grove-installed", "npx"),
  ];
  mocks.settings = {
    isTauriGui: false,
    acpAgent: "",
    setAcpAgent: vi.fn(),
    setIsRecordingWindowShortcut: vi.fn(),
    showHideWindowShortcut: "",
    serverPlatform: "linux",
    applications: [],
    ideCommand: "",
    setIdeCommand: vi.fn(),
    terminalCommand: "",
    setTerminalCommand: vi.fn(),
    systemNotifEnabled: false,
    trayEnabled: true,
    browserControlEnabled: true,
    browserPersonalAllowed: true,
    browserPersonalBypass: false,
    computerUseAllowed: false,
    computerUseBypass: false,
    extensionCurrent: false,
    extensionNeedsUpdate: false,
  };
  onDone = vi.fn();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const render = () => act(async () => root.render(<OrbitSetup onDone={onDone} />));
const button = (text: string) => [...host.querySelectorAll("button")].find((item) => item.textContent === text);
const click = (text: string) => act(async () => button(text)!.click());
const row = (name: string) => host.querySelector(`[role="checkbox"][aria-label="${name}"]`)!;
const heading = () => host.querySelector("h1")?.textContent;

it("starts with every agent that can run here, and Continue keeps only the picked ones", async () => {
  await render();
  await click("Get started");
  expect(row("Claude Agent").getAttribute("aria-checked")).toBe("true");
  expect(row("Claude Agent").textContent).toContain("Installed");
  expect(row("Codex").getAttribute("aria-checked")).toBe("true");
  expect(row("Codex").textContent).toContain("Download");

  await act(async () => (row("Codex") as HTMLElement).click());
  await click("Continue");
  expect(mocks.patchAgent).toHaveBeenCalledTimes(1);
  expect(mocks.patchAgent).toHaveBeenCalledWith("codex-acp", { hidden: true });
  expect(mocks.settings.setAcpAgent).toHaveBeenCalledWith("claude-acp");
});

it("makes a picked agent the default when asked", async () => {
  await render();
  await click("Get started");
  await click("Set default");
  await click("Continue");
  expect(mocks.patchAgent).not.toHaveBeenCalled();
  expect(mocks.settings.setAcpAgent).toHaveBeenCalledWith("codex-acp");
});

it("leaves agents that cannot run here as they were when another is picked", async () => {
  mocks.agents = [
    agent("claude-acp", "Claude Agent", "auto-detected", "external"),
    agent("codex-acp", "Codex", "grove-installed", "npx"),
  ];
  mocks.npx = false;
  await render();
  await click("Get started");
  expect(row("Codex").getAttribute("aria-checked")).toBe("false");
  await click("Continue");
  expect(mocks.patchAgent).not.toHaveBeenCalled();
  expect(mocks.settings.setAcpAgent).toHaveBeenCalledWith("claude-acp");
});

it("picks nothing that cannot run, and then changes nothing", async () => {
  mocks.agents = [agent("codex-acp", "Codex", "grove-installed", "npx")];
  mocks.npx = false;
  await render();
  await click("Get started");
  expect(row("Codex").textContent).toContain("Needs Node.js");
  expect(button("Continue")).toBeUndefined();
  await click("Skip");
  expect(mocks.patchAgent).not.toHaveBeenCalled();
  expect(mocks.settings.setAcpAgent).not.toHaveBeenCalled();
  expect(heading()).toBe("Permissions");
});

it("leaves the agents alone when setup is skipped", async () => {
  await render();
  await click("Get started");
  await click("Skip setup");
  expect(onDone).toHaveBeenCalled();
  expect(mocks.patchAgent).not.toHaveBeenCalled();
});

it("asks for a global shortcut only in the desktop app, and ends after the last step", async () => {
  mocks.settings.isTauriGui = true;
  await render();
  await click("Get started");
  await click("Continue");
  expect(heading()).toBe("Open Grove from anywhere");
  await click("Continue");
  expect(heading()).toBe("Permissions");
  await click("Continue");
  expect(heading()).toBe("Make it yours");
  expect(onDone).not.toHaveBeenCalled();
  await click("Continue");
  expect(onDone).toHaveBeenCalled();
});

it("checks the setup only when a tool is missing, and lists just what is missing", async () => {
  mocks.tools = [tool("node", false, { command: "brew install node", run: true }), tool("git", true)];
  await render();
  await click("Get started");
  expect(heading()).toBe("Check your setup");
  expect(host.textContent).toContain("Node.js");
  expect(host.textContent).toContain("brew install node");
  expect(host.textContent).not.toContain("Coding projects");
  expect(button("Continue")).toBeUndefined();
  await click("Skip");
  expect(heading()).toBe("Choose your agents");
});

it("installs a tool on the machine when asked, and lets agents see Node.js once it is there", async () => {
  mocks.tools = [tool("node", false, { command: "brew install node", run: true })];
  await render();
  await click("Get started");
  await click("Install");
  expect(mocks.installSetupTool).toHaveBeenCalledWith("node");

  mocks.tools = [tool("node", true, { command: "brew install node", run: true })];
  await click("Check again");
  expect(host.textContent).toContain("Installed");
  expect(mocks.invalidateAgentCatalog).toHaveBeenCalled();
  expect(button("Skip")).toBeUndefined();
  await click("Continue");
  expect(heading()).toBe("Choose your agents");
});

it("offers a command that needs a password to copy, and a download where there is no command", async () => {
  mocks.tools = [
    tool("node", false, { command: "sudo apt-get install -y nodejs npm" }),
    tool("git", false, { url: "https://git-scm.com/downloads" }),
  ];
  await render();
  await click("Get started");
  expect(button("Install")).toBeUndefined();
  expect(button("Copy")).toBeDefined();
  expect(button("Download")).toBeDefined();
});

async function toYours() {
  await render();
  await click("Get started");
  await click("Continue");
  await click("Continue");
  expect(heading()).toBe("Make it yours");
}
const radio = (label: string) => host.querySelector<HTMLElement>(`[role="radio"][aria-label="${label}"]`);
const group = (label: string) => host.querySelector(`[role="radiogroup"][aria-label="${label}"]`);

const menu = (label: string) => group(label)!.querySelector<HTMLElement>('[data-testid="app-menu"]')!;


it("offers Grove's own themes and icons, and the editors and terminals found on the machine", async () => {
  mocks.settings.applications = [app("Visual Studio Code"), app("Zed"), app("Android Studio"), app("Ghostty"), app("Safari")];
  mocks.settings.ideCommand = "/Applications/Zed.app";
  await toYours();
  expect(radio("System")!.getAttribute("aria-checked")).toBe("true");
  await act(async () => radio("Nord")!.click());
  expect(mocks.setAppearance).toHaveBeenCalledWith({ mode: "dark", darkThemeId: "nord" });
  await act(async () => radio("Moss")!.click());
  expect(mocks.select).toHaveBeenCalledWith("moss");

  const editors = [...group("Editor")!.querySelectorAll('[role="radio"]')];
  expect(editors.map((item) => item.textContent)).toEqual(["VS Code", "Zed"]);
  expect(editors[1].getAttribute("aria-checked")).toBe("true");
  await act(async () => (editors[0] as HTMLElement).click());
  expect(mocks.settings.setIdeCommand).toHaveBeenCalledWith("/Applications/Visual Studio Code.app");
  expect([...group("Terminal")!.querySelectorAll('[role="radio"]')].map((item) => item.textContent)).toEqual(["Ghostty"]);
  // Other installed editors are in the menu beside the known ones; with none left there is no menu.
  expect(menu("Editor").textContent).toBe("Other");
  expect(menu("Editor").dataset.value).toBe("");
  expect(menu("Terminal")).toBeNull();
});

it("offers the menu alone when none of the installed apps is a known editor, showing one picked from it", async () => {
  mocks.settings.applications = [app("Safari"), app("Android Studio")];
  mocks.settings.ideCommand = "/Applications/Android Studio.app";
  await toYours();
  expect(group("Editor")!.querySelectorAll('[role="radio"]')).toHaveLength(0);
  expect(menu("Editor").textContent).toBe("Choose");
  expect(menu("Editor").dataset.value).toBe("/Applications/Android Studio.app");
});

it("leaves the editor and terminal out where the machine reports no apps", async () => {
  await toYours();
  expect(group("Theme")).not.toBeNull();
  expect(group("Application icon")).not.toBeNull();
  expect(group("Editor")).toBeNull();
  expect(group("Terminal")).toBeNull();
});

it("shows a few known apps as chips, keeping the chosen one among them", async () => {
  mocks.settings.applications = ["Visual Studio Code", "Cursor", "Zed", "Sublime Text", "Nova", "Xcode"].map(app);
  mocks.settings.ideCommand = "/Applications/Xcode.app";
  await toYours();
  const names = [...group("Editor")!.querySelectorAll('[role="radio"]')].map((item) => item.textContent);
  expect(names).toEqual(["VS Code", "Cursor", "Xcode"]);
});

async function toPermissions() {
  await render();
  await click("Get started");
  await click("Continue");
  expect(heading()).toBe("Permissions");
}

it("offers the Companion with browser use, and says so once it is connected", async () => {
  await toPermissions();
  expect(host.textContent).toContain("Grove Companion");
  await click("Install");
  expect(host.querySelector('[data-testid="install-companion"]')).not.toBeNull();

  mocks.settings = { ...mocks.settings, extensionCurrent: true };
  await render();
  expect(host.textContent).toContain("Connected");
  expect(button("Install")).toBeUndefined();
});

it("leaves the Companion out when agents may not use the browser", async () => {
  mocks.settings.browserPersonalAllowed = false;
  await toPermissions();
  expect(host.textContent).not.toContain("Grove Companion");
});

it("asks macOS for what computer use needs, only when computer use is on", async () => {
  mocks.permissions = { accessibility: "denied", screenRecording: "granted" };
  await toPermissions();
  expect(host.textContent).not.toContain("Accessibility");

  mocks.settings = { ...mocks.settings, computerUseAllowed: true };
  await render();
  expect(host.textContent).toContain("Accessibility");
  expect(host.textContent).toContain("Screen Recording");
  await click("Set Up");
  expect(mocks.requestComputerPermission).toHaveBeenCalledWith("accessibility");
  expect([...host.querySelectorAll("button")].filter((item) => item.textContent === "Set Up")).toHaveLength(1);
});
