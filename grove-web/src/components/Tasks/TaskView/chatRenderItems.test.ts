import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./TaskChat";
import { buildRenderItems } from "./chatRenderItems";

const user: ChatMessage = { type: "user", content: "Investigate" };
const assistant = (content: string): ChatMessage => ({ type: "assistant", content, complete: true });
const tool = (id: string): ChatMessage => ({ type: "tool", id, name: "exec_command", title: "exec_command", status: "completed", collapsed: true });
const child: ChatMessage = { type: "subagent", sessionId: "child", parentSessionId: "root", title: "Explore", messages: [] };
const notice: ChatMessage = { type: "session_notice", severity: "warning", title: "Configuration warning" };

function label(item: ReturnType<typeof buildRenderItems>[number]) {
  return item.kind === "single" ? item.message.type === "assistant" ? item.message.content : item.message.type : item.kind;
}

describe("completed work grouping", () => {
  it("folds the ordinary process while keeping notices and subagents outside, with the answer visible", () => {
    const messages: ChatMessage[] = [user, assistant("Investigating"), tool("read"), child, notice, tool("wait"), assistant("Final answer")];
    const result = buildRenderItems(messages);
    expect(result.map(label)).toEqual(["user", "work-summary", "subagent", "session_notice", "Final answer"]);
    const summary = result.find((item) => item.kind === "work-summary")!;
    if (summary.kind !== "work-summary") throw new Error("Missing summary");
    expect(summary.items.map((item) => item.index)).toEqual([1, 2, 5]);
    expect(summary.items.map((item) => item.message.type)).toEqual(["assistant", "tool", "tool"]);
    expect(result.filter((item) => item.kind === "single").map((item) => item.index)).toEqual([0, 3, 4, 6]);
    expect(buildRenderItems(JSON.parse(JSON.stringify(messages)))).toEqual(result);
  });

  it("keeps a live turn chronological and applies folding only after it finishes", () => {
    const messages = [user, assistant("Working"), tool("read"), notice, child, tool("wait")];
    expect(buildRenderItems(messages, true).map(label)).toEqual(["user", "Working", "tool-section", "session_notice", "subagent", "tool-section"]);
    expect(buildRenderItems(messages).map(label)).toEqual(["user", "work-summary", "session_notice", "subagent"]);
  });

  it("keeps context-compaction boundaries and rich content between separate work summaries", () => {
    const divider: ChatMessage = { type: "compaction", id: "c", status: "completed", summary: [] };
    const rich: ChatMessage = { type: "assistant", content: "Image", complete: true, blocks: [{ type: "image", data: "base64", mime_type: "image/png" }] };
    const result = buildRenderItems([user, tool("before"), divider, tool("middle"), rich, tool("after"), assistant("Answer")]);
    expect(result.map(label)).toEqual(["user", "work-summary", "compaction", "work-summary", "Image", "work-summary", "Answer"]);
    expect(result.filter((item) => item.kind === "work-summary").map((item) => item.sectionId)).toEqual(["work-1-1", "work-3-3", "work-5-5"]);
  });

  it("does not hide a turn that only has a notice and a final answer", () => {
    expect(buildRenderItems([user, notice, assistant("Answer")]).map(label)).toEqual(["user", "session_notice", "Answer"]);
  });
});
