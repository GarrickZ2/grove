import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { applyCompactionEvent, compactionSearchText, type CompactionMessage } from "./compactionReducer";
import { CompactionDivider } from "./CompactionDivider";

type Message = CompactionMessage | { type: "assistant"; content: string; complete: boolean } | { type: "tool"; id: string };
const update = (id: string, status: string, fields = {}) => ({ type: "compaction_update", id, status, ...fields });
const chunk = (id: string, text: string) => ({ type: "compaction_summary_chunk", id, content: { type: "text", text } });
const compaction = (messages: Message[], id = "c") => messages.find((message): message is CompactionMessage => message.type === "compaction" && message.id === id)!;

describe("compaction timeline", () => {
  it("fixes the first position and does not split or move later conversation on updates", () => {
    const original: Message[] = [{ type: "assistant", content: "before", complete: false }];
    let messages: Message[] = applyCompactionEvent(original, update("c", "in_progress"));
    messages.push({ type: "assistant", content: "after", complete: false });
    messages = applyCompactionEvent(messages, chunk("c", "retained"));
    messages = applyCompactionEvent(messages, update("c", "completed"));
    messages = applyCompactionEvent(messages, update("next", "completed"));
    expect(messages.map((m) => m.type === "assistant" ? m.content : m.id)).toEqual(["before", "c", "after", "next"]);
    expect(messages[0]).toMatchObject({ complete: true });
    // Updating an earlier compaction did not close text after it. The second
    // compaction creates its own later boundary and closes that text instead.
    expect(messages[2]).toMatchObject({ complete: true });
    expect(original[0]).toMatchObject({ complete: false });
    expect(compaction(messages).summary).toEqual([{ type: "text", text: "retained" }]);
  });

  it("accepts a first-seen summary and updates after terminal status without changing placement", () => {
    let messages: Message[] = applyCompactionEvent([], chunk("c", "one"));
    expect(compaction(messages).status).toBe("in_progress");
    messages = applyCompactionEvent(messages, update("c", "completed"));
    messages.push({ type: "assistant", content: "answer", complete: false });
    messages = applyCompactionEvent(messages, chunk("c", " two"));
    expect(compaction(messages).status).toBe("completed");
    expect(compaction(messages).summary).toEqual([{ type: "text", text: "one two" }]);
    expect(messages[1]).toMatchObject({ complete: false });
  });

  it("preserves omitted fields and replaces or clears explicit patches", () => {
    let messages: Message[] = applyCompactionEvent([], update("c", "failed", { summary: [{ type: "text", text: "old" }], error: "failed", metadata: { a: 1, b: 2 } }));
    messages = applyCompactionEvent(messages, update("c", "_future"));
    expect(compaction(messages)).toMatchObject({ status: "_future", error: "failed", metadata: { a: 1, b: 2 } });
    messages = applyCompactionEvent(messages, update("c", "completed", { summary: [{ type: "text", text: "replacement" }], error: null, metadata: { a: 3 } }));
    expect(compaction(messages)).toMatchObject({ summary: [{ type: "text", text: "replacement" }], metadata: { a: 3 } });
    expect(compaction(messages).error).toBeUndefined();
    messages = applyCompactionEvent(messages, update("c", "completed", { summary: [], metadata: null }));
    expect(compaction(messages).summary).toEqual([]);
    expect(compaction(messages).metadata).toBeUndefined();
    messages = applyCompactionEvent(messages, chunk("c", "fresh"));
    messages = applyCompactionEvent(messages, update("c", "completed", { summary: null }));
    expect(compaction(messages).summary).toEqual([]);
  });

  it("replays rich content and authoritative snapshots without duplication", () => {
    const events = [chunk("c", "first"), { type: "compaction_summary_chunk", id: "c", content: { type: "image", data: "data", mime_type: "image/png" } }, chunk("c", "last"), update("c", "completed")];
    const replay = (items: typeof events) => items.reduce<Message[]>((messages, event) => applyCompactionEvent(messages, event), []);
    const live = replay(events);
    expect(compaction(live).summary.map((block) => block.type)).toEqual(["text", "image", "text"]);
    const restored = replay(JSON.parse(JSON.stringify(events)));
    expect(restored).toEqual(live);
    const snapshot = update("c", "completed", { summary: compaction(live).summary });
    expect(applyCompactionEvent(applyCompactionEvent(restored, snapshot), snapshot)).toEqual(live);
    expect(compactionSearchText(compaction(live))).toContain("first");
    expect(compactionSearchText(compaction(live))).toContain("last");
  });

  it.each(["in_progress", "completed", "failed", "cancelled", "_future"])("renders a retained divider for %s, and animates only in progress", (status) => {
    const message: CompactionMessage = { type: "compaction", id: "c", status, summary: [] };
    const html = renderToStaticMarkup(<CompactionDivider message={message} />);
    expect(html).toContain("border-t");
    expect(html.includes("animate-spin")).toBe(status === "in_progress");
    expect(html).not.toContain("<summary");
    expect(html).not.toContain("Actions complete");
    expect(html).toContain(status === "completed" ? "Compacted" : status === "in_progress" ? "Compacting" : status === "_future" ? "_future" : status);
  });

  it("offers optional retained context and escaped error details", () => {
    const message: CompactionMessage = { type: "compaction", id: "c", status: "failed", error: "<script>error</script>", summary: [{ type: "text", text: "summary" }] };
    const html = renderToStaticMarkup(<CompactionDivider message={message}><p>Summary content</p></CompactionDivider>);
    expect(html).toContain("<details");
    expect(html).toContain("<summary");
    expect(html).toContain("Retained context");
    expect(html).toContain("Summary content");
    expect(html).toContain("&lt;script&gt;error&lt;/script&gt;");
    expect(html).not.toContain(" open=");
  });
});
