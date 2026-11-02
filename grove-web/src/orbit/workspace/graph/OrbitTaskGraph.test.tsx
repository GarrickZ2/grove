import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrbitInterfaceContext } from "../../ui/interfaceContext";
import { TaskGraph } from "../../../components/Tasks/TaskView/TaskGraph";

const getTaskGraph = vi.fn();
const sendGraphChatMessage = vi.fn();
const addGraphEdge = vi.fn();
vi.mock("../../../api", () => ({
  getTaskGraph: (...args: unknown[]) => getTaskGraph(...args),
  sendGraphChatMessage: (...args: unknown[]) => sendGraphChatMessage(...args),
  getConfig: () => Promise.resolve({ acp: { agent_command: "claude" } }),
  updateChatTitle: vi.fn(),
  spawnGraphNode: vi.fn(),
  addGraphEdge: (...args: unknown[]) => addGraphEdge(...args),
  updateGraphChatDuty: vi.fn(),
  updateGraphEdgePurpose: vi.fn(),
  deleteGraphEdge: vi.fn(),
  remindGraphEdge: vi.fn(),
  deleteChat: vi.fn(),
}));
vi.mock("../../../hooks/useRadioEvents", () => ({ useRadioEvents: () => undefined }));
vi.mock("../../../components/Tasks/TaskView/useACPAvailability", () => ({
  useACPAvailability: () => ({ baseAgents: [], customAgents: [], customAgentPersonas: [], acpAvailabilityLoaded: true }),
}));

/** Shaped like `GET /api/v1/projects/{id}/tasks/{task}/graph`. */
const GRAPH = {
  nodes: [
    { chat_id: "c1", name: "Planner", agent: "claude", duty: "Break the request into steps", status: "idle", pending_in: 0, pending_out: 1, pending_messages: [] },
    { chat_id: "c2", name: "Coder", agent: "codex", status: "busy", pending_in: 1, pending_out: 0, pending_messages: [] },
  ],
  edges: [
    { edge_id: 7, from: "c1", to: "c2", purpose: "Implement", state: "in_flight", pending_message: { from: "c1", from_name: "Planner", to: "c2", to_name: "Coder", body_excerpt: "Add paging" } },
  ],
};

/** A pointer press + release on `el` (bubbles to the canvas, like a click). */
function pointer(type: string, el: Element, init: MouseEventInit = {}) {
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, ...init }));
}
function pick(el: Element) {
  act(() => {
    pointer("pointerdown", el);
    pointer("pointerup", el);
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("OrbitTaskGraph", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.resetAllMocks();
    // @ts-expect-error -- restore jsdom (it has no elementFromPoint of its own)
    delete document.elementFromPoint;
    vi.unstubAllGlobals();
  });

  function render(orbit = true) {
    act(() => root.render(
      <OrbitInterfaceContext.Provider value={orbit}>
        <TaskGraph projectId="p1" taskId="t1" />
      </OrbitInterfaceContext.Provider>,
    ));
  }

  it("renders round agents with a live status ring", async () => {
    getTaskGraph.mockResolvedValue(GRAPH);
    render();
    expect(container.querySelector("[role=status][aria-label=\"Loading agent graph\"]")).not.toBeNull();
    await flush();
    const cards = [...container.querySelectorAll<HTMLElement>(".ogr-node")];
    expect(cards.map((c) => c.dataset.graphNode)).toEqual(["c1", "c2"]);
    expect(cards[1].className).toContain("is-busy");
    // Working: the turning accent ring; the label reads "Agent · status".
    expect(cards[1].className).toContain("is-work");
    expect(cards[1].querySelector(".ogr-av .ogr-ring")).not.toBeNull();
    expect(cards[1].querySelector(".ogr-nl b")?.textContent).toBe("Coder");
    expect(cards[1].querySelector(".ogr-nl small")?.textContent).toBe("CodeX · Working");
    // One queued message waits for the Coder.
    expect(cards[1].querySelector(".ogr-node-q")?.textContent).toBe("1");
    expect(container.querySelector(".ogr-edge.is-in_flight")).not.toBeNull();
    // Nothing selected: no card over the canvas, just the hover affordances on each agent.
    expect(container.querySelector(".ogr-dock")).toBeNull();
    expect(container.querySelectorAll("[data-graph-handle]")).toHaveLength(2);
  });

  it("selects an agent and switches the chat to it, as Workbench does", async () => {
    getTaskGraph.mockResolvedValue(GRAPH);
    const opened = vi.fn();
    window.addEventListener("grove:open-chat", opened);
    render();
    await flush();
    pick(container.querySelector('[data-graph-node="c1"]')!);
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({ chatId: "c1" });
    expect(container.querySelector(".ogr-dock .ogr-bar-name")?.textContent).toBe("Planner");
    expect(container.querySelector(".ogr-dock")?.textContent).toContain("Break the request into steps");
    expect(container.querySelector(".ogr-dock")?.textContent).toContain("to Coder: Add paging");
    // The selection lights its edges; Open chat in the bar uses the same handler.
    expect(container.querySelector('[data-graph-node="c1"]')!.className).toContain("is-sel");
    expect(container.querySelector(".ogr-edge")!.getAttribute("class")).toContain("is-hot");
    act(() => container.querySelector<HTMLElement>('[aria-label="Open Planner\'s chat"]')!.click());
    expect(opened).toHaveBeenCalledTimes(2);
    window.removeEventListener("grove:open-chat", opened);
  });

  it("dims what the selection doesn't touch, and clears on empty space", async () => {
    getTaskGraph.mockResolvedValue({
      nodes: [...GRAPH.nodes, { chat_id: "c3", name: "Reviewer", agent: "claude", status: "disconnected", pending_in: 0, pending_out: 0, pending_messages: [] }],
      edges: GRAPH.edges,
    });
    render();
    await flush();
    pick(container.querySelector('[data-graph-node="c1"]')!);
    expect(container.querySelector('[data-graph-node="c3"]')!.className).toContain("is-dim");
    expect(container.querySelector('[data-graph-node="c2"]')!.className).not.toContain("is-dim");
    expect(container.querySelector('[data-graph-node="c3"]')!.className).toContain("is-off");
    pick(container.querySelector(".ogr-canvas")!);
    expect(container.querySelector('[data-graph-node="c1"]')!.className).not.toContain("is-sel");
    expect(container.querySelector('[data-graph-node="c3"]')!.className).not.toContain("is-dim");
  });

  it("shows an idle agent's error and done outcomes on its ring", async () => {
    getTaskGraph.mockResolvedValue({
      nodes: [
        { chat_id: "c1", name: "Planner", agent: "claude", status: "idle", pending_in: 0, pending_out: 1, pending_messages: [] },
        { chat_id: "c2", name: "Coder", agent: "codex", status: "idle", outcome: "done", pending_in: 0, pending_out: 0, pending_messages: [] },
        { chat_id: "c3", name: "Reviewer", agent: "claude", status: "idle", outcome: "error", pending_in: 0, pending_out: 0, pending_messages: [] },
        // Replied before, but a new message is waiting for it: not done.
        { chat_id: "c4", name: "Tester", agent: "claude", status: "idle", outcome: "done", pending_in: 1, pending_out: 0, pending_messages: [] },
      ],
      edges: [
        { edge_id: 1, from: "c1", to: "c2", state: "idle" },
        { edge_id: 2, from: "c1", to: "c3", state: "idle" },
        { edge_id: 3, from: "c1", to: "c4", state: "blocked", pending_message: { from: "c1", from_name: "Planner", to: "c4", to_name: "Tester", body_excerpt: "Run it" } },
      ],
    });
    render();
    await flush();
    const done = container.querySelector('[data-graph-node="c2"]')!;
    expect(done.className).toContain("is-done");
    expect(done.querySelector(".ogr-badge.is-done")).not.toBeNull();
    expect(done.getAttribute("aria-label")).toContain("Replied and finished");
    const failed = container.querySelector('[data-graph-node="c3"]')!;
    expect(failed.className).toContain("is-err");
    expect(failed.querySelector(".ogr-badge.is-err")).not.toBeNull();
    expect(failed.getAttribute("aria-label")).toContain("Last turn failed");
    expect(container.querySelector('[data-graph-node="c4"]')!.className).toContain("is-ready");

    pick(failed);
    expect(container.querySelector(".ogr-bar-st")!.textContent).toContain("Error");
  });

  it("drags an agent freely without selecting it, and zooms from the control", async () => {
    getTaskGraph.mockResolvedValue(GRAPH);
    const opened = vi.fn();
    window.addEventListener("grove:open-chat", opened);
    render();
    await flush();
    const node = container.querySelector<HTMLElement>('[data-graph-node="c2"]')!;
    act(() => {
      pointer("pointerdown", node.querySelector(".ogr-av")!, { clientX: 10, clientY: 10 });
      pointer("pointermove", node, { clientX: 90, clientY: 70 });
    });
    expect(node.className).toContain("is-dragged");
    act(() => pointer("pointerup", node, { clientX: 90, clientY: 70 }));
    expect(node.className).not.toContain("is-dragged");
    expect(opened).not.toHaveBeenCalled();
    expect(container.querySelector(".ogr-dock")).toBeNull();
    const pct = () => container.querySelector(".ogr-zoom span")!.textContent;
    const before = pct();
    act(() => container.querySelector<HTMLElement>('[aria-label="Zoom in"]')!.click());
    expect(pct()).not.toBe(before);
    window.removeEventListener("grove:open-chat", opened);
  });

  it("lines agents without delegations up with a hint", async () => {
    getTaskGraph.mockResolvedValue({ nodes: GRAPH.nodes, edges: [] });
    render();
    await flush();
    expect(container.querySelector(".ogr-tip")?.textContent).toContain("No delegations yet");
    pick(container.querySelector('[data-graph-node="c1"]')!);
    expect(container.querySelector(".ogr-tip")).toBeNull();
  });

  it("double-click on an agent opens the edit form", async () => {
    getTaskGraph.mockResolvedValue(GRAPH);
    render();
    await flush();
    act(() => container.querySelector('[data-graph-node="c2"]')!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(container.querySelector(".ogr-dock .ogr-pane-title b")?.textContent).toBe("Edit Coder");
  });

  it("drags a connection from an agent's handle onto another agent", async () => {
    getTaskGraph.mockResolvedValue({
      nodes: [...GRAPH.nodes, { chat_id: "c3", name: "Reviewer", agent: "claude", status: "idle", pending_in: 0, pending_out: 0, pending_messages: [] }],
      edges: GRAPH.edges,
    });
    addGraphEdge.mockResolvedValue({ edge_id: 9 });
    render();
    await flush();
    const handle = container.querySelector('[data-graph-handle="c2"]')!;
    const target = container.querySelector('[data-graph-node="c3"]')!;
    document.elementFromPoint = () => target;
    act(() => {
      pointer("pointerdown", handle);
      pointer("pointermove", handle, { clientX: 40, clientY: 40 });
    });
    expect(target.className).toContain("is-drop-ok");
    act(() => pointer("pointerup", handle, { clientX: 40, clientY: 40 }));
    // The Reviewer has no duty: a small prompt asks for one before connecting.
    const prompt = container.querySelector<HTMLFormElement>(".ogr-bubble")!;
    expect(prompt.getAttribute("aria-label")).toBe("Connect Coder to Reviewer");
    const textarea = prompt.querySelector("textarea")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Review the diff");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { prompt.requestSubmit(); });
    await flush();
    expect(addGraphEdge).toHaveBeenCalledWith("p1", "t1", { from: "c2", to: "c3", duty: "Review the diff", purpose: undefined });
  });

  it("rejects an invalid drop with the reason", async () => {
    getTaskGraph.mockResolvedValue(GRAPH);
    render();
    await flush();
    const handle = container.querySelector('[data-graph-handle="c2"]')!;
    const target = container.querySelector('[data-graph-node="c1"]')!;
    document.elementFromPoint = () => target;
    act(() => {
      pointer("pointerdown", handle);
      pointer("pointermove", handle);
      pointer("pointerup", handle);
    });
    expect(container.querySelector(".ogr-toast")?.textContent).toBe("Reverse edge already exists");
    expect(addGraphEdge).not.toHaveBeenCalled();
  });

  it("sends a message from the inline form", async () => {
    getTaskGraph.mockResolvedValue(GRAPH);
    sendGraphChatMessage.mockResolvedValue(undefined);
    render();
    await flush();
    pick(container.querySelector('[data-graph-node="c2"]')!);
    act(() => container.querySelector<HTMLElement>('[aria-label="Send a message to Coder"]')!.click());
    const textarea = container.querySelector("textarea")!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(textarea, "Ship it");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await flush();
    expect(sendGraphChatMessage).toHaveBeenCalledWith("p1", "t1", "c2", "Ship it");
    expect(container.querySelector(".ogr-toast")?.textContent).toBe("Message sent");
  });

  it("offers a way out of a failed load", async () => {
    getTaskGraph.mockRejectedValueOnce(new Error("Task not found")).mockResolvedValueOnce(GRAPH);
    render();
    await flush();
    expect(container.querySelector("[role=alert]")?.textContent).toContain("Task not found");
    act(() => [...container.querySelectorAll("button")].find((b) => b.textContent === "Try again")!.click());
    await flush();
    expect(container.querySelectorAll(".ogr-node")).toHaveLength(2);
  });

  it("keeps the Workbench graph outside Orbit", async () => {
    getTaskGraph.mockResolvedValue(GRAPH);
    render(false);
    await flush();
    expect(container.querySelector(".ogr")).toBeNull();
    // The Workbench force layout with its floating context toolbar.
    expect(container.querySelector("svg[viewBox='0 0 800 600']")).not.toBeNull();
    expect(container.textContent).toContain("New Session");
  });
});
