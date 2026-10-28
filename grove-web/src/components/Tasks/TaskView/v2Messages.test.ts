import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./TaskChat";
import { reduceV2Message } from "./v2Messages";
import { reduceMessageChunk } from "./messageChunks";
import { buildRenderItems } from "./chatRenderItems";

describe("ACP v2 messages", () => {
  it("replays replacements and interleaved chunks alongside existing v1 history", () => {
    let messages: ChatMessage[] = reduceMessageChunk([], { type: "message_chunk", message_id: "v1", text: "older" });
    const apply = (update: Record<string, unknown>) => { messages = reduceV2Message(messages, { type: "v2_message_update", update }); };
    apply({ sessionUpdate: "agent_message_chunk", messageId: "a", content: { type: "text", text: "old" } });
    apply({ sessionUpdate: "agent_message_chunk", messageId: "b", content: { type: "text", text: "other" } });
    apply({ sessionUpdate: "agent_message", messageId: "a", content: [{ type: "text", text: "new" }] });
    apply({ sessionUpdate: "agent_message_chunk", messageId: "a", content: { type: "text", text: " tail" } });
    expect(messages.map((message) => message.type === "assistant" ? message.content : "")).toEqual(["older", "new tail", "other"]);
    apply({ sessionUpdate: "agent_message", messageId: "a" });
    expect(messages[1]).toMatchObject({ content: "new tail" });
    apply({ sessionUpdate: "agent_message", messageId: "a", content: null });
    expect(messages[1]).toMatchObject({ content: "", blocks: [] });
  });

  it("binds the Agent's user message and replaces the optimistic echo once", () => {
    let messages: ChatMessage[] = [{ type: "user", content: "hello", clientMessageId: "local" }];
    messages = reduceV2Message(messages, { type: "v2_message_bind", client_message_id: "local", message_id: "agent" });
    messages = reduceV2Message(messages, { type: "v2_message_update", update: { sessionUpdate: "user_message_chunk", messageId: "agent", content: { type: "text", text: "hel" } } });
    messages = reduceV2Message(messages, { type: "v2_message_update", update: { sessionUpdate: "user_message_chunk", messageId: "agent", content: { type: "text", text: "lo" } } });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: "user", content: "hello", messageId: "agent" });
  });

  it("retains only the thought heading and ignores thought media", () => {
    let messages: ChatMessage[] = [];
    const apply = (update: Record<string, unknown>) => { messages = reduceV2Message(messages, { type: "v2_message_update", update }); };
    apply({ sessionUpdate: "agent_thought_chunk", messageId: "t", content: { type: "text", text: "**Inspect" } });
    apply({ sessionUpdate: "agent_thought_chunk", messageId: "t", content: { type: "text", text: "ing**\nprivate reasoning" } });
    apply({ sessionUpdate: "agent_thought_chunk", messageId: "t", content: { type: "image", data: "secret", mimeType: "image/png" } });
    expect(messages[0]).toMatchObject({ type: "thinking", content: "**Inspecting**" });
    expect(JSON.stringify(messages)).not.toContain("private reasoning");
    expect(JSON.stringify(messages)).not.toContain("secret");
    apply({ sessionUpdate: "agent_message", messageId: "a", content: [{ type: "image", data: "public", mimeType: "image/png" }] });
    expect(messages[0]).toMatchObject({ type: "thinking", complete: true });
    expect(messages[1]).toMatchObject({ type: "assistant", blocks: [{ type: "image", data: "public" }] });
    const timeline = buildRenderItems([{ type: "user", content: "question" }, ...messages], false);
    expect(timeline.some((item) => item.kind === "single" && item.message.type === "thinking")).toBe(false);
  });
});
