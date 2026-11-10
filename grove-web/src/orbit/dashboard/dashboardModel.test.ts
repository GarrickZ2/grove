import { describe, expect, it } from "vitest";
import type { HookEntryResponse } from "../../api/hooks";
import type { Task } from "../../data/types";
import { buildNeedsYou, inlineOptions, sortInFlight, splitPermission, taskActivity } from "./dashboardModel";
import { liveChatKey, type LiveChat, type LiveChats } from "./liveChats";

function chat(patch: Partial<LiveChat>): LiveChat {
  return {
    projectId: "p", taskId: "t1", chatId: "c1", status: "idle", waitingForInput: false, permission: null,
    prompt: null, agent: null, chatTitle: null, todoCompleted: null, todoTotal: null, since: 0, ...patch,
  };
}

function chats(...list: LiveChat[]): LiveChats {
  return Object.fromEntries(list.map((item) => [liveChatKey(item.projectId, item.taskId, item.chatId), item]));
}

function hook(patch: Partial<HookEntryResponse>): HookEntryResponse {
  return { task_id: "t1", task_name: "Task one", level: "notice", timestamp: "2026-11-01T10:00:00Z", message: "Done", project_id: "p", project_name: "grove", chat_id: null, ...patch };
}

const allow = { option_id: "a1", name: "Allow once", kind: "allow_once" };
const always = { option_id: "a2", name: "Always", kind: "allow_always" };
const deny = { option_id: "r1", name: "Reject", kind: "reject_once" };

describe("splitPermission", () => {
  it("moves a command-like detail into the code chip", () => {
    expect(splitPermission("Run command: pnpm vitest run")).toEqual({ title: "Run command", code: "pnpm vitest run" });
    expect(splitPermission("  Edit   src/App.tsx ")).toEqual({ title: "Edit src/App.tsx", code: null });
    expect(splitPermission("")).toEqual({ title: "Permission requested", code: null });
  });
});

describe("inlineOptions", () => {
  it("keeps the first allow and the first reject", () => {
    expect(inlineOptions([deny, always, allow]).map((option) => option.option_id)).toEqual(["a1", "r1"]);
    expect(inlineOptions([{ option_id: "x", name: "Other", kind: "other" }]).map((option) => option.option_id)).toEqual(["x"]);
  });
});

describe("buildNeedsYou", () => {
  const names = new Map([["t1", "Task one"], ["t2", "Task two"]]);

  it("lists permissions, then input requests, then notifications newest first", () => {
    const items = buildNeedsYou("p", chats(
      chat({ taskId: "t2", chatId: "c2", waitingForInput: true, since: 5 }),
      chat({ status: "permission_required", permission: { description: "Run command: ls", options: [deny, allow] }, chatTitle: "Fix", since: 9 }),
      chat({ projectId: "other", status: "permission_required" }),
    ), [
      hook({ task_id: "t3", task_name: "Old", timestamp: "2026-11-01T08:00:00Z" }),
      hook({ task_id: "t4", task_name: "New", level: "warn", message: null, timestamp: "2026-11-01T09:00:00Z" }),
      hook({ project_id: "elsewhere" }),
    ], names);
    expect(items.map((item) => [item.kind, item.title, item.source])).toEqual([
      ["permission", "Run command", "Task one · Fix"],
      ["input", "Waiting for your answer", "Task two"],
      ["warn", "Needs attention", "New"],
      ["notice", "Done", "Old"],
    ]);
    expect(items[0].options.map((option) => option.option_id)).toEqual(["a1", "r1"]);
    expect(items[0].code).toBe("ls");
  });

  it("folds a notification into the live request it announces and labels the Local Task", () => {
    const items = buildNeedsYou("p", chats(chat({ taskId: "_local", chatId: "c9", status: "permission_required" })), [
      hook({ task_id: "_local", chat_id: "c9", level: "warn" }),
      hook({ task_id: "_local", chat_id: null }),
      hook({ task_id: "t2", chat_id: "c1" }),
    ], names);
    expect(items.map((item) => [item.kind, item.source])).toEqual([["permission", ""], ["notice", "Task two"]]);
  });
});

describe("taskActivity", () => {
  it("picks the most urgent live session", () => {
    const state = chats(
      chat({ chatId: "a", status: "busy", prompt: "Refactor the  sidebar", todoCompleted: 2, todoTotal: 5, agent: "claude", since: 3 }),
      chat({ chatId: "b", status: "idle" }),
    );
    expect(taskActivity("p", "t1", state)).toEqual({ phase: "live", doing: "Refactor the sidebar · 2/5", agent: "claude", chatId: "a" });
    const waiting = { ...state, ...chats(chat({ chatId: "c", status: "permission_required", agent: "codex" })) };
    expect(taskActivity("p", "t1", waiting)).toMatchObject({ phase: "waiting", doing: "Waiting for approval", chatId: "c" });
    expect(taskActivity("p", "t2", state)).toEqual({ phase: "idle", doing: "Idle", agent: null, chatId: null });
  });
});

describe("sortInFlight", () => {
  it("orders waiting, then live, then most recently updated", () => {
    const task = (id: string, updated: number) => ({ id, updatedAt: new Date(updated) }) as Task;
    const activity = new Map([
      ["b", { phase: "live" as const, doing: "", agent: null, chatId: null }],
      ["c", { phase: "waiting" as const, doing: "", agent: null, chatId: null }],
    ]);
    expect(sortInFlight([task("a", 1), task("d", 5), task("b", 0), task("c", 0)], activity).map((item) => item.id)).toEqual(["c", "b", "d", "a"]);
  });
});
