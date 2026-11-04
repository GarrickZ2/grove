import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AGENT_INTRO_SEEN_KEY } from "./storage";
import { OrbitWelcome } from "./OrbitWelcome";

const state = vi.hoisted(() => ({ orbit: true, phone: false, tablet: false }));
vi.mock("../../api", () => ({ getVersion: vi.fn(async () => ({ version: "1.0.0" })) }));
vi.mock("../../hooks", () => ({ useIsMobile: () => ({ isMobile: state.phone || state.tablet, isTablet: state.tablet }) }));
vi.mock("../ui/interfaceContext", () => ({ useOrbitInterface: () => state.orbit }));
vi.mock("./useDetectedAgents", () => ({
  useDetectedAgents: () => ({ detection: { status: "ready", agents: [] }, checking: false, recheck: vi.fn() }),
}));
vi.mock("../../components/Layout/GroveIcon", () => ({ GroveIcon: () => null }));
vi.mock("../../components/Config/MarketplaceModal", () => ({
  MarketplaceModal: ({ open, intro, initialTab, onClose }: { open: boolean; intro?: string; initialTab?: string; onClose: () => void }) => open
    ? <div data-testid="marketplace" data-tab={initialTab}><p>{intro}</p><button type="button" onClick={onClose}>Close Marketplace</button></div>
    : null,
}));

const INTRO = "Choose the agents you use. Grove runs them on your machine, and you'll sign in the first time you use each one.";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  Object.assign(state, { orbit: true, phone: false, tablet: false });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (window as unknown as Record<string, unknown>).__GROVE_REMOTE__;
  localStorage.clear();
  vi.unstubAllGlobals();
});

const render = () => act(async () => root.render(<OrbitWelcome onAction={() => {}} />));
const marketplace = () => host.querySelector('[data-testid="marketplace"]');
const button = (text: string) => [...host.querySelectorAll("button")].find((item) => item.textContent === text);

it("opens the Marketplace with its one line on the first visit", async () => {
  await render();
  expect(marketplace()?.textContent).toContain(INTRO);
  expect(marketplace()?.getAttribute("data-tab")).toBe("explore");
});

it("still opens on a tablet or a narrow window", async () => {
  state.tablet = true;
  await render();
  expect(marketplace()?.textContent).toContain(INTRO);
});

it("shows it once, even if the page reloads while it's open", async () => {
  await render();
  act(() => root.unmount());
  root = createRoot(host);
  await render();
  expect(marketplace()).toBeNull();
});

it("doesn't repeat the line when the Marketplace is opened again", async () => {
  await render();
  act(() => button("Close Marketplace")!.click());
  expect(marketplace()).toBeNull();
  act(() => button("Browse agents")!.click());
  expect(marketplace()).not.toBeNull();
  expect(marketplace()?.textContent).not.toContain(INTRO);
});

it.each([
  ["Workbench", () => { state.orbit = false; }],
  ["a phone", () => { state.phone = true; }],
  ["remote access", () => { (window as unknown as Record<string, unknown>).__GROVE_REMOTE__ = true; }],
])("stays closed and unspent on %s", async (_name, arrange) => {
  arrange();
  await render();
  expect(marketplace()).toBeNull();
  expect(localStorage.getItem(AGENT_INTRO_SEEN_KEY)).toBeNull();
});
