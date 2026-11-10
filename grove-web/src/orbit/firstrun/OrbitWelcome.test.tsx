import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OrbitWelcome } from "./OrbitWelcome";

const state = vi.hoisted(() => ({
  orbit: true,
  config: { web: {} } as { web: { setup_done?: boolean } } | null,
  loading: false,
  patchConfig: vi.fn(async () => ({})),
  refresh: vi.fn(async () => {}),
  invokeQuiet: vi.fn(async () => null),
}));
vi.mock("../../api", () => ({ getVersion: vi.fn(async () => ({ version: "1.0.0" })), patchConfig: state.patchConfig }));
vi.mock("../../context", () => ({ useConfig: () => ({ config: state.config, loading: state.loading, refresh: state.refresh }) }));
vi.mock("../../utils/tauriShell", () => ({ invokeQuiet: state.invokeQuiet }));
vi.mock("../ui/interfaceContext", () => ({ useOrbitInterface: () => state.orbit }));
vi.mock("./useDetectedAgents", () => ({
  useDetectedAgents: () => ({ detection: { status: "ready", agents: [] }, checking: false, recheck: vi.fn() }),
}));
vi.mock("../../components/Layout/GroveIcon", () => ({ GroveIcon: () => null }));
vi.mock("../../components/Layout/OrbitMachineMenu", () => ({ OrbitMachineMenu: () => null }));
vi.mock("./OrbitSetup", () => ({
  OrbitSetup: ({ onDone }: { onDone: () => void }) => <div data-testid="setup"><button type="button" onClick={onDone}>Finish setup</button></div>,
}));
vi.mock("../../components/Config/MarketplaceModal", () => ({
  MarketplaceModal: ({ open }: { open: boolean }) => open ? <div data-testid="marketplace" /> : null,
}));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.assign(state, { orbit: true, config: { web: {} }, loading: false });
  state.patchConfig.mockClear();
  state.invokeQuiet.mockClear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (window as unknown as Record<string, unknown>).__GROVE_REMOTE__;
  vi.unstubAllGlobals();
});

const render = () => act(async () => root.render(<OrbitWelcome onAction={() => {}} />));
const setup = () => host.querySelector('[data-testid="setup"]');
const marketplace = () => host.querySelector('[data-testid="marketplace"]');
const button = (text: string) => [...host.querySelectorAll("button")].find((item) => item.textContent === text);

it("starts with setup on a machine that has not been set up, before the ways to add a project", async () => {
  await render();
  expect(setup()).not.toBeNull();
  expect(button("Open a folder")).toBeUndefined();
  expect(marketplace()).toBeNull();
  expect(state.invokeQuiet).not.toHaveBeenCalled();
});

it("moves on to adding a project when setup is finished, and records it on the machine", async () => {
  await render();
  await act(async () => button("Finish setup")!.click());
  expect(setup()).toBeNull();
  expect(button("Open a folder")).toBeDefined();
  expect(state.patchConfig).toHaveBeenCalledWith({ web: { setup_done: true } });
  expect(state.invokeQuiet).toHaveBeenCalledWith("setup_window_end");
});

it("doesn't run setup on a machine that remembers it, whatever this browser has seen", async () => {
  state.config = { web: { setup_done: true } };
  await render();
  expect(setup()).toBeNull();
  expect(button("Open a folder")).toBeDefined();
});

it("runs setup again for another machine that has not been set up", async () => {
  await render();
  await act(async () => button("Finish setup")!.click());
  expect(setup()).toBeNull();
  state.config = { web: {} };
  await render();
  expect(setup()).not.toBeNull();
});

it("draws neither setup nor the project choices until the machine has answered", async () => {
  Object.assign(state, { config: null, loading: true });
  await render();
  expect(setup()).toBeNull();
  expect(button("Open a folder")).toBeUndefined();
  expect(state.invokeQuiet).not.toHaveBeenCalled();
});

it("runs setup over remote access too", async () => {
  (window as unknown as Record<string, unknown>).__GROVE_REMOTE__ = true;
  await render();
  expect(setup()).not.toBeNull();
});

it("opens the Marketplace only when asked", async () => {
  state.config = { web: { setup_done: true } };
  await render();
  expect(marketplace()).toBeNull();
  act(() => button("Browse agents")!.click());
  expect(marketplace()).not.toBeNull();
});

it("skips setup, without spending it, on Workbench", async () => {
  state.orbit = false;
  await render();
  expect(setup()).toBeNull();
  expect(button("Open a folder")).toBeDefined();
  expect(state.patchConfig).not.toHaveBeenCalled();
});
