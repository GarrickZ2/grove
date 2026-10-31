import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BuddyAgentFields } from "./BuddyAgentFields";
import { buddyAgentFixtures } from "../../api/buddies.testFixtures";
import { DialogLayerContext } from "../ui/dialogLayerContext";
import type { BuddyAgentConfig } from "../../api/buddies";

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("innerWidth", 390); vi.stubGlobal("innerHeight", 700);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 250, y: 620, top: 620, bottom: 648, left: 250, right: 370, width: 120, height: 28, toJSON: () => ({}) });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(320);
  host = document.createElement("div"); host.style.overflow = "hidden"; document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === text)!;

it("shows brand icons and keeps the agent picker above the dialog edge within the viewport", () => {
  const change = vi.fn();
  act(() => root.render(<DialogLayerContext.Provider value={90}><BuddyAgentFields agents={buddyAgentFixtures()} agent="codex" config={{ source: "default" }} onAgent={change} onConfig={vi.fn()} /></DialogLayerContext.Provider>));
  const trigger = button("Agent · Codex");
  expect(trigger.querySelector(".buddy-agent-brand img")?.getAttribute("src")).toBe("/agent-icon/openai.svg");
  expect(trigger.querySelector(".lucide-bot")).toBeNull();
  act(() => trigger.click());
  const menu = document.body.querySelector<HTMLElement>(".picker-menu")!;
  expect(host.contains(menu)).toBe(false);
  expect(menu.style.position).toBe("fixed"); expect(menu.style.zIndex).toBe("91");
  expect(menu.style.bottom).toBe("84px"); expect(menu.style.left).toBe("122px");
  expect(button("Claude Code").querySelector(".picker-menu__icon img")?.getAttribute("src")).toBe("/agent-icon/claude-color.svg");
  act(() => { button("Claude Code").dispatchEvent(new Event("pointerdown", { bubbles: true })); button("Claude Code").click(); });
  expect(change).toHaveBeenCalledWith("claude-code");
  expect(document.querySelector(".picker-menu")).toBeNull();
});
it("uses the catalog model values and portals configuration menus too", () => {
  const config = vi.fn();
  act(() => root.render(<BuddyAgentFields agents={buddyAgentFixtures()} agent="codex" config={{ source: "config_options", agent_id: "codex", values: { effort: "high" } }} onAgent={vi.fn()} onConfig={config} />));
  act(() => button("ModelExample model").click());
  const menu = document.querySelector<HTMLElement>(".picker-menu")!;
  expect(host.contains(menu)).toBe(false);
  expect(menu.style.bottom).toBe("84px");
  act(() => button("Example model").click());
  expect(config).toHaveBeenCalledWith({ source: "config_options", agent_id: "codex", values: { effort: "high", model: "mock-model" } });
});
it("keeps change confirmation in the portal and closes on outside interaction", () => {
  act(() => root.render(<BuddyAgentFields agents={buddyAgentFixtures()} agent="codex" config={{ source: "default" }} onAgent={vi.fn()} onConfig={vi.fn()} confirmAgentChange confirmation={<button type="button">Confirm change</button>} />));
  act(() => button("Agent · Codex").click());
  expect(document.querySelector(".picker-menu__footer")?.textContent).toContain("Confirm change");
  act(() => button("Confirm change").dispatchEvent(new Event("pointerdown", { bubbles: true })));
  expect(document.querySelector(".picker-menu")).not.toBeNull();
  act(() => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
  expect(document.querySelector(".picker-menu")).toBeNull();
});

it("uses Agent names and current values for all quick categories including mode", () => {
  const agents = buddyAgentFixtures();
  agents[0].capability_snapshot!.config_options![0].name = "Language model";
  agents[0].capability_snapshot!.config_options!.push({ id: "permissions", name: "Approval policy", type: "select", category: "mode", currentValue: "ask", options: [{ value: "ask", name: "Ask first" }, { value: "auto", name: "Automatic" }] });
  const change = vi.fn();
  act(() => root.render(<BuddyAgentFields agents={agents} agent="codex" config={{ source: "config_options", agent_id: "codex", values: { effort: "high" } }} onAgent={vi.fn()} onConfig={change} />));
  expect(button("Language modelExample model")).toBeDefined();
  expect(button("Efforthigh")).toBeDefined();
  expect(change).not.toHaveBeenCalled();
  act(() => button("Approval policyAsk first").click());
  act(() => button("Automatic").click());
  expect(change).toHaveBeenCalledWith({ source: "config_options", agent_id: "codex", values: { effort: "high", permissions: "auto" } });
});

it("shows additional select and boolean configurations and preserves their saved values", () => {
  const agents = buddyAgentFixtures();
  agents[0].capability_snapshot!.config_options!.push(
    { id: "verbosity", name: "Response detail", type: "select", currentValue: "brief", options: [{ group: "detail", name: "Detail levels", options: [{ value: "brief", name: "Brief" }, { value: "full", name: "Full" }] }] },
    { id: "search", name: "Web search", type: "boolean", currentValue: false },
  );
  const change = vi.fn();
  function Harness() {
    const [config, setConfig] = useState<BuddyAgentConfig>({ source: "config_options", agent_id: "codex", values: { effort: "high", search: true } });
    return <BuddyAgentFields agents={agents} agent="codex" config={config} onAgent={vi.fn()} onConfig={(next) => { change(next); setConfig(next); }} />;
  }
  act(() => root.render(<Harness />));
  const open = () => act(() => document.querySelector<HTMLButtonElement>('[aria-label="Session settings"]')!.click());
  open();
  const menu = document.querySelector<HTMLElement>("[data-session-settings-menu]")!;
  expect(host.contains(menu)).toBe(false);
  expect(button("Web search").getAttribute("aria-checked")).toBe("true");
  act(() => { button("Response detailBrief").dispatchEvent(new Event("pointerdown", { bubbles: true })); button("Response detailBrief").click(); });
  expect(menu.textContent).toContain("Detail levels");
  act(() => button("Full").click());
  expect(change).toHaveBeenLastCalledWith({ source: "config_options", agent_id: "codex", values: { effort: "high", search: true, verbosity: "full" } });
  open();
  expect(button("Response detailFull")).toBeDefined();
  act(() => { button("Web search").dispatchEvent(new Event("pointerdown", { bubbles: true })); button("Web search").click(); });
  expect(change).toHaveBeenLastCalledWith({ source: "config_options", agent_id: "codex", values: { effort: "high", search: false, verbosity: "full" } });
  open();
  expect(button("Web search").getAttribute("aria-checked")).toBe("false");
  act(() => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
  expect(document.querySelector("[data-session-settings-menu]")).toBeNull();
});

it("keeps boolean quick categories and uncategorized options accessible without inventing model fields", () => {
  const agents = buddyAgentFixtures();
  agents[0].capability_snapshot!.config_options = [{ id: "reasoning", name: "Reasoning enabled", category: "thought_level", type: "boolean", currentValue: true }];
  const change = vi.fn();
  act(() => root.render(<BuddyAgentFields agents={agents} agent="codex" config={{ source: "default" }} onAgent={vi.fn()} onConfig={change} />));
  expect(host.textContent).not.toContain("Model");
  expect(host.textContent).not.toContain("Effort");
  act(() => document.querySelector<HTMLButtonElement>('[aria-label="Session settings"]')!.click());
  expect(button("Reasoning enabled").getAttribute("aria-checked")).toBe("true");
  act(() => button("Reasoning enabled").click());
  expect(change).toHaveBeenCalledWith({ source: "config_options", agent_id: "codex", values: { reasoning: false } });
});

it("supports legacy Agent modes using the available modes and current selection", () => {
  const agents = buddyAgentFixtures();
  agents[0].capability_snapshot = { uses_config_options: false, modes: { available: [["ask", "Ask"], ["auto", "Automatic"]], current: "ask" } };
  const change = vi.fn();
  act(() => root.render(<BuddyAgentFields agents={agents} agent="codex" config={{ source: "default" }} onAgent={vi.fn()} onConfig={change} />));
  expect(host.textContent).not.toContain("Model");
  act(() => button("ModeAsk").click());
  act(() => button("Automatic").click());
  expect(change).toHaveBeenCalledWith({ source: "modes", agent_id: "codex", mode_id: "auto" });
  act(() => root.render(<BuddyAgentFields agents={agents} agent="codex" config={{ source: "modes", agent_id: "codex", mode_id: "auto" }} onAgent={vi.fn()} onConfig={change} />));
  expect(button("ModeAutomatic")).toBeDefined();
});
