import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarketplaceModal } from "./MarketplaceModal";

vi.mock("../../api/marketplace", () => ({
  listMarketplace: vi.fn(async () => ({ agents: [], registry_fetched_at: null, registry_stale: false, curated: [] })),
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
