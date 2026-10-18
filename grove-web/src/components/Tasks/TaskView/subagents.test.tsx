import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { SubagentsPanel } from "./SubagentsPanel";
import { SubagentAvatar } from "./SubagentAvatar";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SubagentCard } from "./SubagentCard";
import { flattenSubagentMessages, reduceSubagentEvent, resetSubagentActivity, subagentPreview, subagentStatus, type SubagentMessage } from "./subagents";
import type { ChatMessage, ServerEvent } from "./TaskChat";

const announce = (id: string, fields = {}, parent = "root"): ServerEvent => ({ type: "subagent_update", session_id: id, parent_session_id: parent, ...fields });
const scoped = (session: string, event: ServerEvent): ServerEvent => ({ type: "subagent_event", session_id: session, event });
function reduce(messages: ChatMessage[], event: ServerEvent): ChatMessage[] {
  if (["subagent_update", "subagent_event", "session_message"].includes(event.type)) return reduceSubagentEvent(messages, event, reduce);
  if (event.type === "message_chunk") return [...messages, { type: "assistant", content: event.text, complete: false }];
  if (event.type === "permission_request") return [...messages, { type: "permission", id: event.id, description: event.description, options: [] }];
  return messages;
}
function getChild(messages: ChatMessage[], sessionId: string): SubagentMessage {
  return flattenSubagentMessages(messages).find((message): message is SubagentMessage => message.type === "subagent" && message.sessionId === sessionId)!;
}

describe("subagent timeline", () => {
  it("keeps root Todos out of the transcript and restores each child's own Todo", () => {
    const todo = (content: string): ServerEvent => ({ type: "plan_update", entries: [{ content, status: "pending" }] });
    const events = [announce("a"), announce("b", {}, "a"), todo("Root"), scoped("a", todo("Parent child")), scoped("b", todo("Nested child")), todo("Root changed"), scoped("a", todo("Updated child"))];
    const messages = events.reduce(reduce, [] as ChatMessage[]);
    expect(messages.map((message) => message.type)).toEqual(["subagent"]);
    expect(getChild(messages, "a").messages.filter((message) => message.type === "child_plan")).toEqual([
      { type: "child_plan", entries: [{ content: "Updated child", status: "pending" }] },
    ]);
    expect(getChild(messages, "b").messages).toEqual([
      { type: "child_plan", entries: [{ content: "Nested child", status: "pending" }] },
    ]);
  });

  it("keeps delegation at its position and child work out of parent text", () => {
    let messages: ChatMessage[] = [{ type: "assistant", content: "Before", complete: false }];
    messages = reduce(messages, announce("a", { title: "Review", state: { state: "running" } }));
    messages = reduce(messages, { type: "message_chunk", text: "After" });
    messages = reduce(messages, scoped("a", { type: "message_chunk", text: "Child result" }));
    messages = reduce(messages, announce("a", { state: { state: "idle" } }));
    expect(messages.map((message) => message.type)).toEqual(["assistant", "subagent", "assistant"]);
    expect(messages[0]).toMatchObject({ content: "Before", complete: true });
    expect(messages[2]).toMatchObject({ content: "After", complete: false });
    expect(getChild(messages, "a").messages).toEqual([{ type: "assistant", content: "Child result", complete: true }]);
    expect(subagentStatus(getChild(messages, "a"), true)).toBe("Idle");
  });

  it("routes nested children and pending requests to their own cards", () => {
    let messages = reduce([], announce("a"));
    messages = reduce(messages, announce("b"));
    messages = reduce(messages, announce("c", {}, "a"));
    messages = reduce(messages, scoped("c", { type: "permission_request", id: "child-request", description: "c · command" }));
    expect(messages).toHaveLength(2);
    expect(getChild(messages, "a").messages[0]).toMatchObject({ type: "subagent", sessionId: "c" });
    expect(getChild(messages, "b").messages).toEqual([]);
    expect(subagentStatus(getChild(messages, "c"), true)).toBe("Needs your input");
    expect(flattenSubagentMessages(messages).filter((message) => message.type === "permission")).toHaveLength(1);
  });

  it("omitted metadata preserves, null clears, and cancellation capabilities replace", () => {
    let messages = reduce([], announce("a", { title: "Reviewer", description: "Task", capabilities: { cancel: {} }, state: { state: "running" } }));
    messages = reduce(messages, announce("a", { description: "Changed" }));
    expect(getChild(messages, "a")).toMatchObject({ title: "Reviewer", capabilities: { cancel: {} } });
    messages = reduce(messages, announce("a", { title: null, description: null, capabilities: {}, state: null }));
    expect(getChild(messages, "a").title).toBeUndefined();
    expect(getChild(messages, "a").capabilities?.cancel).toBeUndefined();
    expect(subagentStatus(getChild(messages, "a"), true)).toBe("Status unknown");
  });

  it("restores history and lets an idle child resume without duplicating its card", () => {
    const history = [announce("a", { state: { state: "running" } }), scoped("a", { type: "message_chunk", text: "First job" }), announce("a", { state: { state: "idle" } }), announce("a", { state: { state: "running" } }), scoped("a", { type: "message_chunk", text: "Second job" })];
    const restored = history.reduce(reduce, [] as ChatMessage[]);
    expect(restored).toHaveLength(1);
    expect(getChild(restored, "a").messages).toHaveLength(2);
    expect(subagentStatus(getChild(restored, "a"), true)).toBe("Running");
    expect(subagentStatus(getChild(restored, "a"), false)).toBe("Status unknown");
  });

  it("does not resurrect historical running work or cancellation controls after an Agent restart", () => {
    let messages = reduce([], announce("a", { state: { state: "running" }, capabilities: { cancel: {} } }));
    messages = reduce(messages, announce("b", { state: { state: "_completed" } }));
    messages = resetSubagentActivity(messages);
    expect(subagentStatus(getChild(messages, "a"), true)).toBe("Status unknown");
    expect(getChild(messages, "a").capabilities).toBeUndefined();
    expect(subagentStatus(getChild(messages, "b"), true)).toBe("Completed");
    messages = reduce(messages, announce("a", { state: { state: "running" }, capabilities: { cancel: {} } }));
    expect(subagentStatus(getChild(messages, "a"), true)).toBe("Running");
  });

  it("does not mislabel Codex completion as Claude idle or lose terminal status offline", () => {
    const completed = getChild(reduce([], announce("a", { state: { state: "_completed" } })), "a");
    expect(subagentStatus(completed, false)).toBe("Completed");
    expect(subagentStatus({ ...completed, state: { state: "idle" } }, true)).toBe("Idle");
    expect(subagentStatus({ ...completed, state: { state: "_future" } }, true)).toBe("Status unknown");
  });

  it("upserts inter-agent messages independently and preserves streamed content across metadata patches", () => {
    let messages = reduce([], { type: "session_message", id: "m", sender: "root", recipient: "a", content: [{ type: "text", text: "Investigate" }] });
    messages = reduce(messages, { type: "session_message", id: "m", content: [{ type: "text", text: " this" }], append: true });
    messages = reduce(messages, { type: "session_message", id: "m", sender: null });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: "session_exchange", sender: "root", blocks: [{ type: "text", text: "Investigate this" }] });
    messages = reduce(messages, { type: "session_message", id: "m", content: null });
    expect(messages[0]).toMatchObject({ blocks: [] });
  });

  it("does not attach unknown-session activity to the parent transcript", () => {
    const messages = reduce([], scoped("foreign", { type: "message_chunk", text: "Wrong session" }));
    expect(messages).toEqual([]);
  });
});

describe("subagent presentation", () => {
  const child = (): SubagentMessage => ({ type: "subagent", sessionId: "unique-a", parentSessionId: "root", title: "Reviewer", state: { state: "running" }, capabilities: { cancel: {} }, messages: [{ type: "assistant", content: "**Inspect** `Task` and [terminal](src/terminal.rs)", complete: false }] });

  it("keeps the timeline lightweight and produces a clean activity preview", () => {
    const message = child();
    const html = renderToStaticMarkup(<SubagentCard message={message} connected onOpen={() => {}} />);
    expect(html).toContain("View Reviewer");
    expect(html).not.toContain("<details");
    expect(html).not.toContain("tool calls");
    expect(subagentPreview(message)).toBe("Inspect Task and terminal");
  });

  it("shows the process only after selecting an agent and gates its stop control", () => {
    const agent = child();
    const render = (selectedId?: string, connected = true, capabilities = agent.capabilities) => renderToStaticMarkup(<SubagentsPanel agents={[{ ...agent, capabilities }]} selectedId={selectedId} connected={connected} onSelect={() => {}} onClose={() => {}} onCancel={() => {}} onOpenRequest={() => {}} renderActivity={() => <p>Full process</p>} />);
    expect(render()).not.toContain("Full process");
    expect(render(agent.sessionId)).toContain("Full process");
    expect(render(agent.sessionId)).toContain("Stop</button>");
    expect(render(agent.sessionId, false)).not.toContain("Stop</button>");
    expect(render(agent.sessionId, true, {})).not.toContain("Stop</button>");
    expect(render("other-chat-agent")).not.toContain("Full process");
  });

  it("assigns stable distinct faces to different session IDs", () => {
    const face = (sessionId: string) => renderToStaticMarkup(<SubagentAvatar sessionId={sessionId} />);
    expect(face("a")).toBe(face("a"));
    expect(face("a")).not.toBe(face("b"));
    expect(face("a")).toContain("<svg");
  });

  it("supports selecting, returning to the list, stopping and opening a pending request", () => {
    const agent = child();
    agent.messages.push({ type: "permission", id: "request-a", description: "Allow command", options: [] });
    const stop = vi.fn(); const request = vi.fn();
    const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previous = env.IS_REACT_ACT_ENVIRONMENT; env.IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container);
    function Harness() {
      const [selected, setSelected] = useState<string>();
      const [open, setOpen] = useState(true);
      return open ? <SubagentsPanel agents={[agent]} selectedId={selected} connected onSelect={setSelected} onClose={() => setOpen(false)} onCancel={stop} onOpenRequest={request} renderActivity={() => <p>Full process</p>} /> : null;
    }
    const click = (button: Element | null | undefined) => { expect(button).toBeTruthy(); act(() => button!.dispatchEvent(new MouseEvent("click", { bubbles: true }))); };
    try {
      act(() => root.render(<Harness />));
      expect(container.textContent).not.toContain("Full process");
      click([...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Reviewer")));
      expect(container.textContent).toContain("Full process");
      click([...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Permission requested")));
      expect(request).toHaveBeenCalledWith("permission");
      click([...container.querySelectorAll("button")].find((button) => button.textContent === "Stop"));
      expect(stop).toHaveBeenCalledWith(agent.sessionId);
      click(container.querySelector('[aria-label="All subagents"]'));
      expect(container.textContent).not.toContain("Full process");
      click(container.querySelector('[aria-label="Close subagents panel"]'));
      expect(container.textContent).toBe("");
    } finally { act(() => root.unmount()); container.remove(); env.IS_REACT_ACT_ENVIRONMENT = previous; }
  });
});
