import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./TaskChat";
import { forkTarget, reduceForkPoint, showMessageActions } from "./messageActions";

const user = (content: string): ChatMessage => ({ type: "user", content });
const assistant = (content: string): ChatMessage => ({ type: "assistant", content, complete: true });
const thinking: ChatMessage = { type: "thinking", content: "working", collapsed: false, complete: false };

describe("assistant message actions", () => {
  it("hides actions on an intermediate message while the current turn is busy", () => {
    expect(showMessageActions([user("question"), assistant("progress"), thinking], 1, true)).toBe(false);
  });
  it("shows actions on the final message once the turn ends", () => {
    const messages = [user("question"), assistant("progress"), assistant("answer")];
    expect(showMessageActions(messages, 1, false)).toBe(false);
    expect(showMessageActions(messages, 2, false)).toBe(true);
  });
  it("keeps actions on previous finished turns while a later turn is busy", () => {
    const messages = [user("first"), assistant("answer"), user("second"), assistant("progress"), thinking];
    expect(showMessageActions(messages, 1, true)).toBe(true);
    expect(showMessageActions(messages, 3, true)).toBe(false);
  });
});

describe("fork from a reply", () => {
  const point = (cursor_id: string, available = true) => ({ type: "fork_point", cursor_id, available });
  it("forks the whole session at the last reply and at a cursor before that", () => {
    let messages = [user("one"), assistant("first"), user("two")];
    messages = reduceForkPoint(messages, point("c2"));
    messages = [...messages, assistant("second"), user("three"), assistant("third")];
    expect(forkTarget(messages, 1)).toBe("c2");
    expect(forkTarget(messages, 3)).toBeUndefined();
    expect(forkTarget(messages, 5)).toBeNull();
    expect(forkTarget(messages, 0)).toBeUndefined();
  });
  it("stops offering a withdrawn cursor", () => {
    const messages = reduceForkPoint([user("one"), assistant("first"), user("two")], point("c2"));
    expect(forkTarget(reduceForkPoint(messages, point("c2", false)), 1)).toBeUndefined();
  });
});
