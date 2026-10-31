vi.hoisted(() => vi.stubEnv("VITE_BUDDIES_MOCK", "true"));
import { listInstalledAgentConfigs } from "../../../api/marketplace";
vi.mock("../../../api/marketplace", () => ({ listInstalledAgentConfigs: vi.fn() }));
vi.mock("../../../hooks/useAgentCatalogRevision", () => ({ useAgentCatalogRevision: () => 0 }));
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BuddySidePanel, type BuddyPanelTab } from "./BuddySidePanel";
import { buddiesMock } from "../../../api/buddies.mock";
import { buddyAgentFixtures } from "../../../api/buddies.testFixtures";
import { listConnectPlatforms } from "../../../api/connects";
vi.mock("../../../api/connects", () => ({ listConnectPlatforms: vi.fn() }));
import * as api from "../../../api/buddies";
vi.mock("../../../keyboard/useEscapeScope", () => ({ useEscapeScope: () => {} }));
vi.mock("../../../hooks/useIsMobile", () => ({ useIsMobile: () => ({ isMobile: false, isTablet: false }) }));
vi.mock("../../../context", () => ({ useProject: () => ({ selectedProject: { projectType: "studio" } }) }));
vi.mock("../../Tasks/TaskView/useACPAvailability", () => ({ useACPAvailability: () => ({ baseAgents: [], customAgents: [], customAgentPersonas: [], acpAvailabilityLoaded: true }) }));
vi.mock("../../ui/MarkdownRenderer", () => ({ MarkdownRenderer: ({ content }: { content: string }) => <p>{content}</p> }));

describe("Buddy side panel", () => {
  let host: HTMLDivElement; let root: Root; let buddy: api.Buddy;
  function Harness() {
    const [current, setCurrent] = useState(buddy); const [tab, setTab] = useState<BuddyPanelTab>("settings");
    return <BuddySidePanel buddy={current} tab={tab} onTab={setTab} onChanged={setCurrent} onArchive={vi.fn()} onClose={vi.fn()} />;
  }
  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear();
    vi.mocked(listInstalledAgentConfigs).mockResolvedValue(buddyAgentFixtures());
    vi.mocked(listConnectPlatforms).mockResolvedValue(buddiesMock.connectPlatforms());
    buddy = buddiesMock.create({ name: "Docs", agent: "codex", role: "Maintain docs" });
    host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    await act(async () => root.render(<Harness />));
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });
  const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent === text || item.getAttribute("aria-label") === text)!;
  const field = (label: string) => [...host.querySelectorAll("label")].find((item) => item.firstChild?.textContent === label)!.querySelector("input")!;
  const input = (element: HTMLInputElement, value: string) => act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); });

  it("requires explicit Agent confirmation and starts a new Segment", async () => {
    const switchAgent = vi.spyOn(api, "switchBuddyAgent");
    act(() => button("Agent · Codex").click()); act(() => button("Claude Code").click());
    expect(switchAgent).not.toHaveBeenCalled(); expect(document.body.textContent).toContain("This starts a new context");
    await act(async () => button("Switch to Claude Code").click());
    expect(switchAgent).toHaveBeenCalledWith(buddy.id, { agent: "claude-code" });
    expect(buddiesMock.get(buddy.id).segments).toHaveLength(2);
  });
  it("shows the busy conflict without losing the current Agent", async () => {
    vi.spyOn(api, "switchBuddyAgent").mockRejectedValue({ status: 409, data: { code: "buddy_busy" } });
    act(() => button("Agent · Codex").click()); act(() => button("Claude Code").click());
    await act(async () => button("Switch to Claude Code").click());
    expect(host.textContent).toContain("Stop the current turn to switch Agent");
    expect(buddiesMock.get(buddy.id).agent).toBe("codex");
  });
  it("patches Model immediately without opening a new Segment", async () => {
    const model = [...host.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.includes("Model"))!;
    act(() => model.click()); await act(async () => button("Example model").click());
    expect(buddiesMock.get(buddy.id).agent_config).toMatchObject({ source: "config_options", values: { model: "mock-model" } });
    expect(buddiesMock.get(buddy.id).segments).toHaveLength(1);
  });
  it("toggles and triggers only this Buddy's routine", async () => {
    await act(async () => button("Routines").click());
    await act(async () => button("Enable Daily check-in").click());
    expect(buddiesMock.routines(buddy.id)[0].enabled).toBe(false);
    await act(async () => button("Run Daily check-in now").click());
    expect(host.textContent).toContain("Routine started");
    expect(buddiesMock.routines(buddy.id)[0].last_run_status).toBe("success");
  });
  it("creates a routine through the shared dialog with its Buddy target fixed", async () => {
    await act(async () => button("Routines").click());
    await act(async () => button("New routine").click());
    const dialog = [...document.querySelectorAll('[role="dialog"]')].at(-1)!;
    expect(dialog.textContent).not.toContain("Target Branch");
    expect(dialog.textContent).not.toContain("Session mode");
    input(dialog.querySelector<HTMLInputElement>('input[placeholder="Daily standup summary"]')!, "Weekly review");
    act(() => { const textarea = dialog.querySelector("textarea")!; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Review the week"); textarea.dispatchEvent(new Event("input", { bubbles: true })); });
    input(dialog.querySelector<HTMLInputElement>('[aria-label="Routine event triggers"]')!, "task.finished");
    await act(async () => [...dialog.querySelectorAll("button")].find(item => item.textContent === "Create")!.click());
    expect(buddiesMock.routines(buddy.id).find(item => item.name === "Weekly review")).toMatchObject({ task_id: "_local", session_mode: "buddy_active", agent_config: buddy.agent_config, event_triggers: ["task.finished"] });
    expect(document.querySelector('[aria-label="Close routine"]')).toBeNull();
  });
  it("opens a memory document and searches within this Buddy", async () => {
    await act(async () => button("Memory").click());
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>(".buddy-memory-list button")].find((item) => item.textContent?.includes("Docs's working notes"))!.click());
    expect(host.textContent).toContain("Keep answers clear");
    await act(async () => button("Close Memory document").click());
    await act(async () => input(host.querySelector<HTMLInputElement>('[aria-label="Search memories, descriptions, or tags"]')!, "unmatched"));
    await act(async () => host.querySelector(".buddy-memory-search form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(host.textContent).toContain("No memories match this search.");
  });
  it("shows only Memories and Logs, and confirms bulk log deletion", async () => {
    await act(async () => button("Memory").click());
    expect(host.textContent).toContain("Memories · 1");
    expect(host.textContent).toContain("Logs · 1");
    expect(host.textContent).not.toContain("Organize now");
    await act(async () => button("Logs · 1").click());
    act(() => button("Select loaded").click());
    act(() => button("Delete 1").click());
    expect(buddiesMock.logs(buddy.id)).toHaveLength(1);
    const confirm = [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === "Delete")!;
    await act(async () => confirm.click());
    expect(buddiesMock.logs(buddy.id)).toHaveLength(0);
    expect(host.textContent).toContain("Logs · 0");
  });
  it("creates a connection locked to the Buddy and keeps credentials out of mock storage", async () => {
    act(() => button("Add connection").click());
    input(field("Name"), "Docs");
    const forms = host.querySelectorAll("form"); const connectForm = forms[forms.length - 1];
    const inputs = connectForm.querySelectorAll<HTMLInputElement>("input");
    input(inputs[0], "Docs IM"); input(inputs[1], "app"); input(inputs[2], "secret");
    await act(async () => connectForm.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(buddiesMock.connects(buddy.id)[0]).toMatchObject({ name: "Docs IM", project_id: buddy.project_hash, session_id: buddy.active_session_id, adapter_config: {} });
    expect(host.textContent).toContain("Docs IM");
  });
});
