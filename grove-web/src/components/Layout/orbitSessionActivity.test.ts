import { describe, expect, it } from "vitest";
import { sessionActivityReducer as reduce, type SessionActivityState } from "./orbitSessionActivity";

const key = "p:t:c";
const idle = { projectId: "p", chatId: "c", status: "idle" as const, waitingForInput: false, unreadCompletion: false };
const status = (value: "busy" | "idle" | "disconnected") => ({ type: "status" as const, key, projectId: "p", chatId: "c", status: value, viewed: null });

describe("Orbit session attention", () => {
  it("detects completion on reconnect, retains it on repeated snapshots, and clears it on the next run", () => {
    let state = reduce({}, status("busy"));
    const snapshot = { type: "snapshot" as const, chats: { [key]: idle }, viewed: null };
    state = reduce(state, snapshot);
    expect(state[key].unreadCompletion).toBe(true);
    state = reduce(state, snapshot);
    expect(state[key].unreadCompletion).toBe(true);
    state = reduce(state, status("busy"));
    expect(state[key].unreadCompletion).toBe(false);
  });

  it("does not treat disconnection or a missing snapshot entry as completion", () => {
    const busy = reduce({}, status("busy"));
    expect(reduce(busy, status("disconnected"))[key].unreadCompletion).toBe(false);
    const missing = reduce(busy, { type: "snapshot", chats: {}, viewed: null });
    expect(missing[key].status).toBeUndefined();
    expect(reduce(missing, status("idle"))[key].unreadCompletion).toBe(false);
  });

  it("clears only the viewed session in its own project", () => {
    const state: SessionActivityState = {
      [key]: { ...idle, unreadCompletion: true },
      "other:t:c": { ...idle, projectId: "other", unreadCompletion: true },
    };
    const next = reduce(state, { type: "viewed", viewed: { projectId: "p", chatId: "c" } });
    expect(next[key].unreadCompletion).toBe(false);
    expect(next["other:t:c"].unreadCompletion).toBe(true);
  });
});
