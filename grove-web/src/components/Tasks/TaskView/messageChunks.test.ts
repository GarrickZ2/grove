import { describe, expect, it } from "vitest";
import type { ChatMessage, ServerEvent } from "./TaskChat";
import { reduceMessageChunk, reduceUserMessage } from "./messageChunks";
import { reduceSubagentEvent } from "./subagents";

const text = (message_id: string | undefined, value: string): ServerEvent => ({ type: "message_chunk", message_id, text: value });
const thought = (message_id: string, value: string): ServerEvent => ({ type: "thought_chunk", message_id, text: value });
const image = (message_id: string): ServerEvent => ({ type: "message_content_chunk", message_id, content: { type: "image", data: "pixels", mime_type: "image/png" } });
const tool: ChatMessage = { type: "tool", id: "read", title: "Read", status: "completed", collapsed: true };

describe("ACP v1 message identities", () => {
  it("joins matching IDs and starts a separate row when the ID changes", () => {
    let messages = reduceMessageChunk([], text("a", "one"));
    messages = reduceMessageChunk(messages, text("a", " two"));
    messages = reduceMessageChunk(messages, text("b", "three"));
    expect(messages).toMatchObject([
      { type: "assistant", messageId: "a", content: "one two", complete: true },
      { type: "assistant", messageId: "b", content: "three", complete: false },
    ]);
  });

  it("updates an earlier ID in place across tools without finishing newer work", () => {
    let messages = reduceMessageChunk([], text("a", "one"));
    messages = reduceMessageChunk([...messages, tool], text("b", "two"));
    messages = reduceMessageChunk(messages, text("a", " tail"));
    expect(messages.map((message) => message.type)).toEqual(["assistant", "tool", "assistant"]);
    expect(messages[0]).toMatchObject({ messageId: "a", content: "one tail", complete: true });
    expect(messages[2]).toMatchObject({ messageId: "b", content: "two", complete: false });
  });

  it("keeps structured blocks ordered in the message identified by the Agent", () => {
    let messages = reduceMessageChunk([], text("a", "before"));
    messages = reduceMessageChunk([...messages, tool], image("a"));
    messages = reduceMessageChunk(messages, text("a", "after"));
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ content: "beforeafter", blocks: [
      { type: "text", text: "before" }, { type: "image", data: "pixels" }, { type: "text", text: "after" },
    ] });
  });

  it("scopes a shared ID to its message type and closes previous reasoning on a new ID", () => {
    let messages = reduceMessageChunk([], thought("shared", "reason"));
    messages = reduceMessageChunk(messages, text("shared", "answer"));
    messages = reduceMessageChunk(messages, thought("next", "new reason"));
    messages = reduceMessageChunk(messages, thought("shared", " tail"));
    expect(messages).toMatchObject([
      { type: "thinking", messageId: "shared", content: "reason tail", complete: true },
      { type: "assistant", messageId: "shared", content: "answer", complete: false },
      { type: "thinking", messageId: "next", content: "new reason", complete: false },
    ]);
  });

  it("retains initial whitespace for an identified message", () => {
    const messages = reduceMessageChunk(reduceMessageChunk([], text("a", " ")), text("a", "answer"));
    expect(messages[0]).toMatchObject({ content: " answer", messageId: "a" });
  });

  it("preserves completed legacy tails, legacy tool boundaries, and old history replay", () => {
    const old: ChatMessage[] = [{ type: "assistant", content: "answer", complete: true }];
    expect(reduceMessageChunk(old, text(undefined, " tail"))[0]).toMatchObject({ content: "answer tail", complete: true });
    const messages = reduceMessageChunk([...old, tool], text(undefined, "next"));
    expect(messages).toHaveLength(3);
    expect(messages[2]).toMatchObject({ content: "next", complete: false });
    expect(reduceMessageChunk([], text(undefined, " "))).toEqual([]);
  });

  it("keeps user chunk IDs separate from Grove's local send IDs", () => {
    const user = (id: string, value: string): ServerEvent => ({ type: "user_message", message_id: id, text: value });
    let messages = reduceUserMessage([], user("u1", "one"), []);
    messages = reduceUserMessage(messages, user("u2", "two"), []);
    messages = reduceUserMessage(messages, user("u1", " tail"), []);
    expect(messages).toMatchObject([{ content: "one tail", messageId: "u1" }, { content: "two", messageId: "u2" }]);
    messages = reduceUserMessage(messages, { type: "user_message", client_message_id: "local", text: "three" }, []);
    expect(messages[2]).toMatchObject({ clientMessageId: "local", content: "three" });
    expect(messages[2]).not.toHaveProperty("messageId", "local");
  });

  it("keeps legacy user replay chunks together and preserves attachments", () => {
    let messages = reduceUserMessage([], { type: "user_message", text: "one" }, []);
    messages = reduceUserMessage(messages, { type: "user_message", text: " two" }, [{ type: "image", data: "pixels", mimeType: "image/png", name: "image", label: "Image #1" }]);
    expect(messages).toMatchObject([{ content: "one two", attachments: [{ data: "pixels" }] }]);
  });

  it("isolates the same ID across root and child transcripts, including history replay", () => {
    function reduce(messages: ChatMessage[], event: ServerEvent): ChatMessage[] {
      return ["subagent_update", "subagent_event"].includes(event.type)
        ? reduceSubagentEvent(messages, event, reduce) : reduceMessageChunk(messages, event);
    }
    const events: ServerEvent[] = [
      text("shared", "root"),
      { type: "subagent_update", session_id: "child", parent_session_id: "root", state: { state: "running" } },
      { type: "subagent_event", session_id: "child", event: text("shared", "child") },
      text("shared", " tail"),
    ];
    const live = events.reduce(reduce, []);
    expect(live[0]).toMatchObject({ content: "root tail", messageId: "shared" });
    expect(live[1]).toMatchObject({ messages: [{ content: "child", messageId: "shared" }] });
    expect((JSON.parse(JSON.stringify(events)) as ServerEvent[]).reduce(reduce, [])).toEqual(live);
  });
});
