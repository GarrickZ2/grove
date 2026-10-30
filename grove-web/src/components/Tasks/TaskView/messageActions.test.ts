import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./TaskChat";
import { showMessageActions } from "./messageActions";

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
