import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listMarketplace, patchAgent, type InstalledAgentView, type MarketplaceAgent, type MarketplaceResponse } from "../../api/marketplace";
import { openExternalUrl } from "../../utils/openExternal";
import { MarketplaceModal } from "./MarketplaceModal";

vi.mock("../../utils/openExternal", () => ({ openExternalUrl: vi.fn() }));

vi.mock("../../api/marketplace", () => ({
  listMarketplace: vi.fn(async () => ({ agents: [], registry_fetched_at: null, registry_stale: false, curated: [], npx_available: true, uvx_available: true })),
  refreshRegistry: vi.fn(), installAgent: vi.fn(), uninstallAgent: vi.fn(), patchAgent: vi.fn(),
}));

describe("MarketplaceModal initial tab", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  const selected = () => Array.from(document.querySelectorAll("button"))
    .find((b) => (b.textContent === "installed" || b.textContent === "explore") && b.className.includes("bg-[var(--color-highlight)]"))?.textContent;

  it("opens on Installed by default", async () => {
    await act(async () => root.render(<MarketplaceModal open onClose={() => {}} />));
    expect(selected()).toBe("installed");
  });

  it("opens on the named tab, again after a reopen", async () => {
    await act(async () => root.render(<MarketplaceModal open initialTab="explore" onClose={() => {}} />));
    expect(selected()).toBe("explore");
    const installed = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "installed")!;
    act(() => installed.click());
    expect(selected()).toBe("installed");
    await act(async () => root.render(<MarketplaceModal open={false} initialTab="explore" onClose={() => {}} />));
    await act(async () => root.render(<MarketplaceModal open initialTab="explore" onClose={() => {}} />));
    expect(selected()).toBe("explore");
  });
});

describe("MarketplaceModal installed agents", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  const installation = (method: "npx" | "uvx" | "external") => ({ method, version: "1.0.0", install_path: null, status: "installed" as const, failure_reason: null, installed_at: "2026-01-01T00:00:00Z" });
  const agent = (name: string, method: "npx" | "uvx" | "external", installed: Partial<InstalledAgentView> = {}) => ({
    id: name.toLowerCase(), name, description: "", version: "1.0.0", repository: null, website: null, authors: [], license: null, icon_url: null,
    available_install_methods: [], install_state: "grove-installed", binary: null,
    installed: { installations: [installation(method)], selected_install_method: method, args_override: [], env_override: {}, acp_protocol_version: 1, auto_update: true, capability_snapshot: null, capability_updated_at: null, hidden: false, ...installed },
  } as MarketplaceAgent);
  const response = (agents: MarketplaceAgent[], available: Partial<MarketplaceResponse> = {}): MarketplaceResponse => ({ agents, registry_fetched_at: null, registry_stale: false, curated: [], npx_available: true, uvx_available: true, ...available });
  const open = (props = {}) => act(async () => root.render(<MarketplaceModal open onClose={() => {}} {...props} />));
  const button = (text: string) => Array.from(document.querySelectorAll("button")).find((item) => item.textContent === text);
  const openDetail = (name: string) => act(async () => { Array.from(document.querySelectorAll("button")).find((item) => item.textContent?.includes(name))!.click(); });

  it("offers each missing runtime an installed Agent uses, then checks again", async () => {
    vi.mocked(listMarketplace).mockResolvedValueOnce(response([agent("Claude", "npx"), agent("Hermes", "uvx")], { npx_available: false, uvx_available: false }));
    await open();
    expect(document.body.textContent).toContain("Claude needs Node.js");
    expect(document.body.textContent).toContain("Hermes needs uv");
    act(() => button("Install uv")!.click());
    expect(openExternalUrl).toHaveBeenCalledWith("https://docs.astral.sh/uv/getting-started/installation/");

    vi.mocked(listMarketplace).mockResolvedValueOnce(response([agent("Claude", "npx")], { uvx_available: false }));
    const check = Array.from(document.querySelectorAll("button")).filter((item) => item.textContent === "Check again")[0];
    await act(async () => check.click());
    expect(button("Install Node.js")).toBeUndefined();
    expect(button("Install uv")).toBeUndefined();
  });

  it("stays quiet about runtimes nothing visible needs", async () => {
    vi.mocked(listMarketplace).mockResolvedValueOnce(response([agent("Local", "external"), agent("Hidden", "npx", { hidden: true })], { npx_available: false, uvx_available: false }));
    await open();
    expect(button("Install Node.js")).toBeUndefined();
    expect(button("Install uv")).toBeUndefined();
  });

  it("saves Auto update", async () => {
    vi.mocked(listMarketplace).mockResolvedValueOnce(response([agent("Claude", "npx")]));
    await open();
    await openDetail("Claude");
    const toggle = document.querySelector<HTMLButtonElement>('[aria-label="Auto update"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    await act(async () => toggle.click());
    expect(patchAgent).toHaveBeenCalledWith("claude", { auto_update: false });
  });

  it("hides Auto update for an agent only found on PATH", async () => {
    vi.mocked(listMarketplace).mockResolvedValueOnce(response([agent("Local", "external")]));
    await open();
    await openDetail("Local");
    expect(document.body.textContent).toContain("Installations");
    expect(document.querySelector('[aria-label="Auto update"]')).toBeNull();
  });
});
