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

  it("retains a displayable image when v2 echoes or replays a user message", () => {
    for (const chunk of [false, true]) {
      let messages: ChatMessage[] = [{ type: "user", content: "", clientMessageId: "local" }];
      messages = reduceV2Message(messages, { type: "v2_message_bind", client_message_id: "local", message_id: "agent" });
      const image = { type: "image", data: "cGl4ZWxz", mimeType: "image/png" };
      messages = reduceV2Message(messages, { type: "v2_message_update", update: {
        sessionUpdate: chunk ? "user_message_chunk" : "user_message",
        messageId: "agent", content: chunk ? image : [image],
      } });
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ attachments: [{ data: "cGl4ZWxz", previewUrl: "data:image/png;base64,cGl4ZWxz" }] });
    }
  });

  it("preserves local image, audio and file labels across partial and complete echoes", () => {
    const attachments = [
      { type: "image" as const, data: "img", mimeType: "image/png", name: "photo.png", label: "Image #1", previewUrl: "data:image/png;base64,img" },
      { type: "audio" as const, data: "aud", mimeType: "audio/wav", name: "voice.wav", label: "Audio #1" },
      { type: "resource" as const, data: "", mimeType: "text/plain", name: "note.txt", label: "File #1", uri: "file:///note.txt" },
    ];
    const blocks = [
      { type: "image", data: "img", mimeType: "image/png" },
      { type: "audio", data: "aud", mimeType: "audio/wav" },
      { type: "resource_link", uri: "file:///note.txt", name: "note.txt", mimeType: "text/plain" },
    ];
    let messages: ChatMessage[] = [{ type: "user", content: "hello", clientMessageId: "local", attachments }];
    messages = reduceV2Message(messages, { type: "v2_message_bind", client_message_id: "local", message_id: "agent" });
    const apply = (content: unknown) => { messages = reduceV2Message(messages, { type: "v2_message_update", update: { sessionUpdate: "user_message_chunk", messageId: "agent", content } }); };
    apply({ type: "text", text: "hello" });
    expect(messages[0]).toMatchObject({ content: "hello", attachments });
    blocks.forEach(apply);
    expect(messages[0]).toMatchObject({ attachments });
    expect((messages[0] as Extract<ChatMessage, { type: "user" }>).attachments).toHaveLength(3);
    messages = reduceV2Message(messages, { type: "v2_message_update", update: { sessionUpdate: "user_message", messageId: "agent", content: blocks } });
    expect(messages[0]).toMatchObject({ attachments });
    messages = reduceV2Message(messages, { type: "v2_message_update", update: { sessionUpdate: "user_message", messageId: "agent", content: null } });
    apply({ type: "text", text: "new" });
    expect(messages[0]).toMatchObject({ content: "new", attachments: [] });
  });

  it("replays omitted image and audio as placeholders for both user and agent", () => {
    for (const kind of ["user_message", "agent_message", "user_message_chunk", "agent_message_chunk"]) {
      const media = [{ type: "image", mimeType: "image/png" }, { type: "audio", mimeType: "audio/wav" }];
      let messages: ChatMessage[] = [];
      for (const content of kind.endsWith("_chunk") ? media : [media]) {
        messages = reduceV2Message(messages, { type: "v2_message_update", update: { sessionUpdate: kind, messageId: "history", content } });
      }
      if (messages[0].type === "user") expect(messages[0].attachments).toMatchObject([{ type: "image", data: "" }, { type: "audio", data: "" }]);
      else if (messages[0].type === "assistant") expect(messages[0].blocks).toMatchObject([{ type: "image" }, { type: "audio" }]);
      else throw new Error("Expected a user or assistant message");
    }
  });

  it("keeps repeated identical attachments distinct while matching echoes", () => {
    const attachment = { type: "image" as const, data: "same", mimeType: "image/png", name: "a.png", label: "Image #1" };
    let messages: ChatMessage[] = [{ type: "user", content: "", clientMessageId: "local", attachments: [attachment, { ...attachment, label: "Image #2" }] }];
    messages = reduceV2Message(messages, { type: "v2_message_bind", client_message_id: "local", message_id: "agent" });
    for (let i = 0; i < 2; i++) messages = reduceV2Message(messages, { type: "v2_message_update", update: { sessionUpdate: "user_message_chunk", messageId: "agent", content: { type: "image", data: "same", mimeType: "image/png" } } });
    expect((messages[0] as Extract<ChatMessage, { type: "user" }>).attachments?.map((item) => item.label)).toEqual(["Image #1", "Image #2"]);
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
