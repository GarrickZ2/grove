import { expect, it } from "vitest";
import type { ChatMessage } from "./TaskChat";
import { reduceV2Tool } from "./v2Tools";

it("replays v2 tool snapshots, chunks, clearing and structured diffs", () => {
  let messages: ChatMessage[] = [];
  const apply = (update: Record<string, unknown>) => { messages = reduceV2Tool(messages, { type: "v2_tool_update", update }); };
  apply({ sessionUpdate: "tool_call_update", toolCallId: "t", title: "Edit", status: "in_progress", content: [] });
  apply({ sessionUpdate: "tool_call_content_chunk", toolCallId: "t", content: { type: "diff", changes: [{ operation: "move", oldPath: "/a", path: "/b" }], patch: { format: "git_patch", text: "diff" } } });
  expect(messages[0]).toMatchObject({ type: "tool", id: "t", title: "Edit", output: [{ type: "diff", path: "/b", display_text: "diff" }] });
  apply({ sessionUpdate: "tool_call_update", toolCallId: "t", title: null, content: null, status: "completed" });
  expect(messages[0]).toMatchObject({ type: "tool", title: "t", status: "completed", output: [] });
});

it("renders a raw tool result when structured content is absent", () => {
  const messages = reduceV2Tool([], { type: "v2_tool_update", update: {
    sessionUpdate: "tool_call_update", toolCallId: "t", rawOutput: { result: "done" },
  } });
  expect(messages[0]).toMatchObject({ output: [{ type: "content", content: { type: "text", text: '{\n  "result": "done"\n}' } }] });
});
