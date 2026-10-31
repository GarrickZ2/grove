import { act, useContext, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { BuddyOverlay } from "./BuddyOverlay";
import { BuddyLaunchContext } from "./buddyLaunchContext";
import { useBuddyOpen } from "../../hooks/useBuddyOpen";
import { useCommand } from "../../keyboard/useCommand";
import { commandRegistry } from "../../keyboard/CommandRegistry";
import { buildCommands } from "../../hooks/useCommands";
vi.mock("../../context", () => ({ useConfig: () => ({ config: { web: { interface: "orbit" } } }), useProject: () => ({ applySelectedProject: vi.fn() }) }));
vi.mock("../../hooks/useBuddies", () => ({ useBuddies: () => ({ items: [], refresh: vi.fn() }) }));
vi.mock("../../hooks/useRadioEvents", () => ({ useRadioEvents: () => {} }));
vi.mock("./BuddyApp", () => ({ BuddyApp: ({ onExit }: { onExit: () => void }) => <button onClick={onExit}>Back to Grove</button> }));
vi.mock("../ui/CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("framer-motion", () => ({ AnimatePresence: ({ children }: { children: React.ReactNode }) => children, motion: { div: ({ children, ref, tabIndex }: { children: React.ReactNode; ref: React.Ref<HTMLDivElement>; tabIndex: number }) => <div ref={ref} tabIndex={tabIndex}>{children}</div> } }));
let host: HTMLDivElement, root: Root;
const handled = vi.fn();
function Shell() {
  const launch = useContext(BuddyLaunchContext);
  const [draft, setDraft] = useState("kept draft");
  useCommand("test.hidden-shell", handled);
  return <><button onClick={() => launch.open()}>Buddies</button><input aria-label="Draft" value={draft} onChange={e => setDraft(e.target.value)} /></>;
}
function Harness() {
  const state = useBuddyOpen();
  return <BuddyOverlay open={state.open} onOpen={state.enter} onExit={state.exit}><Shell /></BuddyOverlay>;
}
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear(); handled.mockClear(); commandRegistry.setStaticCatalog([{ id: "test.hidden-shell", name: "Test", category: "Test" }]); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
it("opens, disables shell commands, and exits without remounting the underlying page", async () => {
  await act(async () => root.render(<Harness />));
  const input = host.querySelector("input");
  input!.focus();
  expect(commandRegistry.invoke("test.hidden-shell")).toBe(true);
  await act(async () => host.querySelector("button")!.click());
  expect(localStorage.getItem("grove-buddy-open")).toBe("true");
  expect(commandRegistry.invoke("test.hidden-shell")).toBe(false);
  await act(async () => [...host.querySelectorAll("button")].find(b => b.textContent === "Back to Grove")!.click());
  expect(host.querySelector("input")).toBe(input);
  expect(input?.value).toBe("kept draft");
  expect(document.activeElement).toBe(input);
  expect(localStorage.getItem("grove-buddy-open")).toBe("false");
  expect(commandRegistry.invoke("test.hidden-shell")).toBe(true);
});
it("restores the overlay after a refresh", async () => {
  localStorage.setItem("grove-buddy-open", "true");
  await act(async () => root.render(<Harness />));
  expect(host.textContent).toContain("Back to Grove");
  expect(host.querySelector("[inert]")).not.toBeNull();
});
it("provides open, leave, new and individual Buddy commands", () => {
  const open = vi.fn(), leave = vi.fn();
  const commands = buildCommands({ buddies: { open, items: [{ id: "a", name: "Scout", status: "waiting" }] } });
  commands.find(c => c.id === "nav-buddies")!.handler();
  commands.find(c => c.id === "buddy-a")!.handler();
  commands.find(c => c.id === "buddy-new")!.handler();
  expect(open.mock.calls).toEqual([[], ["a"], [undefined, true]]);
  buildCommands({ buddies: { open, leave, items: [] } })[0].handler();
  expect(leave).toHaveBeenCalledOnce();
});
