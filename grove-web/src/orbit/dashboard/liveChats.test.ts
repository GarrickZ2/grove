import { describe, expect, it } from "vitest";
import type { RadioEvent } from "../../api/walkieTalkie";
import { liveChatKey, liveChatsReducer, type LiveChats } from "./liveChats";

type ChatStatus = Extract<RadioEvent, { type: "chat_status" }>;
const status = (patch: Partial<ChatStatus>): ChatStatus => ({ type: "chat_status", project_id: "p", task_id: "t", chat_id: "c", status: "busy", ...patch });
const key = liveChatKey("p", "t", "c");

describe("liveChatsReducer", () => {
  it("replaces state from a snapshot and drops malformed or disconnected rows", () => {
    const state = liveChatsReducer({}, {
      type: "snapshot", now: 10, chats: [
        { project_id: "p", task_id: "t", chat_id: "c", status: "permission_required", waiting_for_input: false, agent: "codex", permission: { description: "Run command: ls", options: [{ option_id: "a", name: "Allow", kind: "allow_once" }, { bogus: true }] } },
        { project_id: "p", task_id: "t", chat_id: "gone", status: "disconnected" },
        { project_id: "p", status: "busy" },
      ],
    });
    expect(Object.keys(state)).toEqual([key]);
    expect(state[key].permission).toEqual({ description: "Run command: ls", options: [{ option_id: "a", name: "Allow", kind: "allow_once" }] });
    expect(state[key].agent).toBe("codex");
    expect(state[key].since).toBe(10);
  });

  it("shows the readable prompt, not its envelope", () => {
    const prompt = '<grove-meta>{"v":1,"type":"buddy_message","data":{"name":"Jack"},"system-prompt":"Sent by Jack."}</grove-meta>\nCheck the review';
    const state = liveChatsReducer({}, { type: "status", now: 1, event: status({ prompt }) });
    expect(state[key].prompt).toBe("Check the review");
  });

  it("tracks status changes, keeps the entry time while the status holds, and forgets disconnected sessions", () => {
    let state: LiveChats = liveChatsReducer({}, { type: "status", now: 1, event: status({ prompt: "Fix the build", agent: "claude", todo_completed: 1, todo_total: 3 }) });
    expect(state[key]).toMatchObject({ status: "busy", prompt: "Fix the build", since: 1, todoTotal: 3 });
    state = liveChatsReducer(state, { type: "status", now: 5, event: status({ prompt: "Fix the build" }) });
    expect(state[key]).toMatchObject({ since: 1, agent: "claude", todoCompleted: 1, todoTotal: 3 });
    state = liveChatsReducer(state, { type: "status", now: 9, event: status({ status: "permission_required", permission: { description: "Edit file", options: [] } }) });
    expect(state[key]).toMatchObject({ status: "permission_required", prompt: null, since: 9 });
    state = liveChatsReducer(state, { type: "status", now: 12, event: status({ status: "disconnected" }) });
    expect(state).toEqual({});
  });

  it("records input requests, even before the first status", () => {
    let state = liveChatsReducer({}, { type: "input", projectId: "p", taskId: "t", chatId: "c", waiting: true, now: 3 });
    expect(state[key]).toMatchObject({ status: "idle", waitingForInput: true, since: 3 });
    state = liveChatsReducer(state, { type: "status", now: 4, event: status({}) });
    expect(state[key].waitingForInput).toBe(true);
    state = liveChatsReducer(state, { type: "input", projectId: "p", taskId: "t", chatId: "c", waiting: false, now: 5 });
    expect(state[key].waitingForInput).toBe(false);
    expect(liveChatsReducer({}, { type: "input", projectId: "p", taskId: "t", chatId: "c", waiting: false, now: 1 })).toEqual({});
  });
});
