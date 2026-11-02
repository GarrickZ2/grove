import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrbitInterfaceContext } from "../../ui/interfaceContext";
import { TaskGraph } from "../../../components/Tasks/TaskView/TaskGraph";

const getTaskGraph = vi.fn();
const sendGraphChatMessage = vi.fn();
vi.mock("../../../api", () => ({
  getTaskGraph: (...args: unknown[]) => getTaskGraph(...args),
  sendGraphChatMessage: (...args: unknown[]) => sendGraphChatMessage(...args),
  getConfig: () => Promise.resolve({ acp: { agent_command: "claude" } }),
  updateChatTitle: vi.fn(),
  spawnGraphNode: vi.fn(),
  addGraphEdge: vi.fn(),
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
    vi.unstubAllGlobals();
  });

  function render(orbit = true) {
    act(() => root.render(
      <OrbitInterfaceContext.Provider value={orbit}>
        <TaskGraph projectId="p1" taskId="t1" />
      </OrbitInterfaceContext.Provider>,
    ));
  }

  it("renders agent cards with live status and the overview", async () => {
    getTaskGraph.mockResolvedValue(GRAPH);
    render();
    expect(container.querySelector("[role=status][aria-label=\"Loading agent graph\"]")).not.toBeNull();
    await flush();
    const cards = [...container.querySelectorAll<HTMLElement>(".ogr-node")];
    expect(cards.map((c) => c.dataset.graphNode)).toEqual(["c1", "c2"]);
    expect(cards[1].className).toContain("is-busy");
    // One queued message waits for the Coder.
    expect(cards[1].querySelector(".ogr-node-q")?.textContent).toBe("1");
    expect(container.querySelector(".ogr-edge.is-in_flight")).not.toBeNull();
    expect(container.querySelector(".ogr-pane-title small")?.textContent).toBe("2 agents · 1 working · 1 queued");
  });

  it("selects an agent, shows its detail and opens its chat", async () => {
    getTaskGraph.mockResolvedValue(GRAPH);
    const opened = vi.fn();
    window.addEventListener("grove:open-chat", opened);
    render();
    await flush();
    act(() => container.querySelector<HTMLElement>('[data-graph-node="c1"]')!.click());
    expect(container.querySelector(".ogr-pane-title b")?.textContent).toBe("Planner");
    expect(container.textContent).toContain("Break the request into steps");
    const open = [...container.querySelectorAll("button")].find((b) => b.textContent === "Open chat")!;
    act(() => open.click());
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({ chatId: "c1" });
    window.removeEventListener("grove:open-chat", opened);
  });

  it("sends a message from the inline form", async () => {
    getTaskGraph.mockResolvedValue(GRAPH);
    sendGraphChatMessage.mockResolvedValue(undefined);
    render();
    await flush();
    act(() => container.querySelector<HTMLElement>('[data-graph-node="c2"]')!.click());
    act(() => [...container.querySelectorAll("button")].find((b) => b.textContent === "Send")!.click());
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
