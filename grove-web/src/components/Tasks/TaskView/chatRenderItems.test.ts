import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./TaskChat";
import { backgroundToolLabel, buildRenderItems, buildSequentialRenderItems, buildToolTimelineRows, finalFailedTool, timelineToolLabel, toolTimelineLegacyDiff, toolTimelineExpansionKey, toggleToolTimelineDetail, shouldRenderTimelineTool, toolTimelineRowState, shellTimelineDisplay, toolTimelineWindow, type ToolSectionItem } from "./chatRenderItems";

const user: ChatMessage = { type: "user", content: "Investigate" };
const assistant = (content: string): ChatMessage => ({ type: "assistant", content, complete: true });
type ToolMessage = Extract<ChatMessage, { type: "tool" }>;
const tool = (id: string, overrides: Partial<ToolMessage> = {}): ToolMessage => ({ type: "tool", id, name: "exec_command", title: "exec_command", status: "completed", collapsed: true, ...overrides });
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

describe("tool timeline grouping", () => {
  const entries = (...messages: ToolMessage[]): ToolSectionItem[] => messages.map((message, index) => ({ message, index }));

  it("joins tools across completed thinking without losing source indices", () => {
    const thinking: ChatMessage = { type: "thinking", content: "Reasoning", complete: true, collapsed: true };
    const result = buildSequentialRenderItems([tool("one"), thinking, tool("two")], 10);
    expect(result).toEqual([{ kind: "tool-section", sectionId: "one", tools: [{ message: tool("one"), index: 10 }, { message: tool("two"), index: 12 }], lastToolId: "two" }]);
    expect(buildRenderItems([user, tool("one"), thinking, tool("two")], true).map(label)).toEqual(["user", "tool-section"]);
  });

  it("keeps assistant, unfinished thinking, and authentication boundaries", () => {
    const thinking: ChatMessage = { type: "thinking", content: "Still working", complete: false, collapsed: false };
    const auth: ChatMessage = { type: "auth_required", agentName: "test", status: "idle", methods: [] };
    const result = buildSequentialRenderItems([tool("one"), assistant("Update"), tool("two"), thinking, tool("three"), auth, tool("four")]);
    expect(result.map(label)).toEqual(["tool-section", "Update", "tool-section", "thinking", "tool-section", "tool-section"]);
    expect(result.filter((item) => item.kind === "tool-section").every((item) => item.lastToolId === "four")).toBe(true);
  });

  it("tracks the final tool across rich content and compaction boundaries for live and completed turns", () => {
    const first = tool("first", { status: "failed" });
    const last = tool("last", { status: "error" });
    const divider: ChatMessage = { type: "compaction", id: "c", status: "completed", summary: [] };
    for (const busy of [false, true]) {
      const result = buildRenderItems([user, first, assistant("Retrying"), divider, last, assistant("Answer")], busy);
      const groups = result.filter((item) => item.kind !== "single");
      expect(groups).toHaveLength(2);
      expect(groups.map((item) => item.lastToolId)).toEqual(busy ? [undefined, undefined] : ["last", "last"]);
      expect(finalFailedTool(entries(first), groups[0].lastToolId)).toBeUndefined();
      expect(finalFailedTool(entries(last), groups[1].lastToolId)).toBe(busy ? undefined : last);
    }
  });

  it("resets the final tool at each user turn, including subagent sequences", () => {
    const messages = [user, tool("first"), assistant("Done"), user, tool("second")];
    for (const result of [buildSequentialRenderItems(messages), buildRenderItems(messages)]) {
      expect(result.filter((item) => item.kind !== "single").map((item) => item.lastToolId)).toEqual(["first", "second"]);
    }
  });

  it("keeps a recovered failure neutral and does not infer failure from stderr", () => {
    const failed = tool("failed", { status: "failed", content: "stderr: earlier error" });
    const recovered = tool("recovered", { content: "warning: harmless stderr output" });
    expect(finalFailedTool(entries(failed, recovered), recovered.id)).toBeUndefined();
    expect(finalFailedTool(entries(failed), failed.id)).toBe(failed);
  });

  it("does not mark a failure final until the turn ends, whether live via busy or streaming", () => {
    const failed = tool("failed", { status: "failed" });
    const streaming: ChatMessage = { type: "assistant", content: "Retrying", complete: false };
    for (const [messages, busy] of [
      [[user, failed], true],
      [[user, failed, streaming], false],
      [[failed], true],
      [[failed, streaming], false],
    ] as const) {
      const groups = buildRenderItems([...messages], busy).filter((item) => item.kind === "tool-section");
      expect(groups).toHaveLength(1);
      expect(groups[0].lastToolId).toBeUndefined();
      expect(finalFailedTool(groups[0].tools, groups[0].lastToolId)).toBeUndefined();
    }
    const finished = buildRenderItems([user, failed, assistant("Stopped")]).find((item) => item.kind === "work-summary")!;
    expect(finished.lastToolId).toBe("failed");
    expect(finalFailedTool(entries(failed), finished.lastToolId)).toBe(failed);
    expect(buildSequentialRenderItems([failed], 0, null)[0]).toMatchObject({ lastToolId: undefined });
  });

  it("combines declared background actions while keeping shell and MCP invocations separate", () => {
    const tools = entries(
      tool("read", { name: "read_file", kind: "read", locations: [{ path: "src/a.ts" }, { path: "src/b.ts" }] }),
      tool("shell", { name: "terminal", kind: "execute", input: [{ label: "command", value: "cat src/a.ts && rg error src/" }] }),
      tool("search", { name: "grep", kind: "search" }),
      tool("mcp", { name: "mcp__grove_agent__memory_read", kind: "read" }),
      tool("read-again", { name: "read_file", kind: "read", input: [{ label: "file_path", value: "src/a.ts" }] }),
      tool("list", { name: "list_directory", kind: "read" }),
      tool("fetch", { name: "web_fetch", kind: "fetch" }),
    );
    const rows = buildToolTimelineRows(tools);
    expect(rows.map((row) => row.kind)).toEqual(["background", "tool", "tool"]);
    expect(rows[0].tools.map(({ message }) => message.id)).toEqual(["read", "search", "read-again", "list", "fetch"]);
    expect(backgroundToolLabel(rows[0].tools)).toBe("Read 2 files, 1 search, 1 directory listing, 1 fetch");
    expect(timelineToolLabel(tools[3].message)).toBe("grove_agent · memory_read");
  });

  it("preserves complete commands and never classifies by their text", () => {
    const command = "bytedcli rds ticket create --site boe --vregion US-BOE --id 48213";
    const message = tool("shell", { kind: "execute", input: [{ label: "cmd", value: command }] });
    expect(timelineToolLabel(message)).toBe(command);
    expect(buildToolTimelineRows(entries(message))[0].kind).toBe("tool");
    const snapshot = tool("snapshot", { output: [{ type: "terminal", terminal_id: "term", command }] });
    expect(timelineToolLabel(snapshot)).toBe(command);
    expect(timelineToolLabel(tool("legacy", { title: command }))).toBe(command);
  });

  it("counts array path inputs as files and shows their paths in the background detail list", () => {
    const message = tool("many", { name: "read_many_files", input: [{ label: "file_paths", value: '["src/a.ts","src/b.ts","src/c.ts"]' }] });
    expect(backgroundToolLabel(entries(message))).toBe("Read 3 files");
    expect(timelineToolLabel(message)).toBe("read_many_files · src/a.ts, src/b.ts, src/c.ts");
  });

  it("shows MCP identity even when its declared capability is execute or edit", () => {
    const tools = entries(tool("one", { name: "mcp__server__run_query", kind: "execute" }), tool("two", { name: "mcp__server__edit_file", kind: "edit" }));
    expect(buildToolTimelineRows(tools).map((row) => row.kind)).toEqual(["tool", "tool"]);
    expect(tools.map(({ message }) => timelineToolLabel(message))).toEqual(["server · run_query", "server · edit_file"]);
  });

  it("keeps every file path and attributes structured diffstat to that file", () => {
    const tools = entries(tool("edit", { name: "apply_patch", kind: "edit", output: [
      { type: "diff", path: "src/a.ts", new_text: "a", display_text: "@@ -1 +1 @@\n-old\n+new" },
      { type: "diff", path: "src/b.ts", new_text: "b", display_text: "@@ -0,0 +1 @@\n+added" },
    ] }), tool("again", { name: "edit_file", kind: "edit", input: [{ label: "file_path", value: "src/a.ts" }], content: "@@ -0,0 +1 @@\n+another" }));
    const rows = buildToolTimelineRows(tools);
    expect(rows.map(({ path, additions, deletions }) => ({ path, additions, deletions }))).toEqual([
      { path: "src/a.ts", additions: 2, deletions: 1 },
      { path: "src/b.ts", additions: 1, deletions: 0 },
    ]);
    expect(rows[0].tools.map(({ message }) => message.id)).toEqual(["edit", "again"]);
  });

  it("includes delete and move paths without parsing shell commands", () => {
    const rows = buildToolTimelineRows(entries(
      tool("delete", { name: "delete_file", kind: "delete", locations: [{ path: "src/deleted.ts" }] }),
      tool("move", { name: "move_file", kind: "move", input: [{ label: "source_path", value: "src/old.ts" }, { label: "destination_path", value: "src/new.ts" }] }),
      tool("shell", { kind: "execute", input: [{ label: "command", value: "rm src/other.ts" }] }),
    ));
    expect(rows.map((row) => [row.kind, row.path])).toEqual([["file", "src/deleted.ts"], ["file", "src/old.ts"], ["file", "src/new.ts"], ["tool", undefined]]);
  });

  it("distinguishes unavailable diffstat from a known zero and sums only available diffs", () => {
    const rows = buildToolTimelineRows(entries(
      tool("unknown", { kind: "edit", locations: [{ path: "src/unknown.ts" }], content: "Updated file" }),
      tool("zero", { kind: "move", locations: [{ path: "src/zero.ts" }], content: "diff --git a/src/zero.ts b/src/zero.ts\nsimilarity index 100%" }),
      tool("known", { kind: "edit", locations: [{ path: "src/mixed.ts" }], content: "@@ -1 +1 @@\n-old\n+new" }),
      tool("unknown-again", { kind: "edit", locations: [{ path: "src/mixed.ts" }], content: "No diff available" }),
    ));
    expect(rows.map(({ hasDiffStat, additions, deletions }) => ({ hasDiffStat, additions, deletions }))).toEqual([
      { hasDiffStat: false, additions: 0, deletions: 0 },
      { hasDiffStat: true, additions: 0, deletions: 0 },
      { hasDiffStat: true, additions: 1, deletions: 1 },
    ]);
  });

  it.each(["edit", "delete", "move"])("extracts legacy %s diffs for the selected file", (kind) => {
    const first = "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new";
    const second = "diff --git a/src/b.ts b/src/b.ts\n@@ -1 +0,0 @@\n-removed";
    const message = tool("change", { kind, locations: [{ path: "src/a.ts" }, { path: "src/b.ts" }], content: `${first}\n${second}` });
    expect(toolTimelineLegacyDiff(message, "src/a.ts")).toBe(first);
    expect(toolTimelineLegacyDiff(message, "src/b.ts")).toBe(second);
    expect(toolTimelineLegacyDiff(message)).toBe(`${first}\n\n${second}`);
    expect(toolTimelineLegacyDiff({ ...message, content: "Updated file" })).toBeUndefined();
    expect(toolTimelineLegacyDiff({ ...message, kind: "execute" })).toBeUndefined();
    expect(toolTimelineLegacyDiff({ ...message, name: "mcp__server__edit_file" })).toBeUndefined();
  });

  it("keeps detail accordions exclusive within their section without changing other disclosures", () => {
    const files = toolTimelineExpansionKey("one", "files");
    const background = toolTimelineExpansionKey("one", "background");
    const other = toolTimelineExpansionKey("two", "detail", "first");
    const sections = new Set(["one", files, background, other]);
    const expanded = toggleToolTimelineDetail(sections, "one", "first");
    expect(expanded.has(toolTimelineExpansionKey("one", "detail", "first"))).toBe(true);
    const switched = toggleToolTimelineDetail(expanded, "one", "second");
    expect(switched.has(toolTimelineExpansionKey("one", "detail", "first"))).toBe(false);
    expect(switched.has(toolTimelineExpansionKey("one", "detail", "second"))).toBe(true);
    expect(toggleToolTimelineDetail(switched, "one", "second")).toEqual(sections);
    expect(sections).toEqual(new Set(["one", files, background, other]));
    expect(toolTimelineExpansionKey("one:detail", "detail", "two")).not.toBe(toolTimelineExpansionKey("one", "detail", "detail:two"));
  });

  it("hides think calls by kind without splitting tool groups or matching their title or ID", () => {
    const think = tool("guardian_assessment:one", { kind: "think", title: "Guardian Review" });
    for (const status of ["pending", "running", "completed", "success"]) {
      expect(shouldRenderTimelineTool({ ...think, status })).toBe(false);
    }
    const ordinary = tool("guardian_assessment:ordinary", { title: "Guardian Review", kind: "execute" });
    expect(shouldRenderTimelineTool(ordinary)).toBe(true);
    const result = buildSequentialRenderItems([tool("one"), think, ordinary, { ...think, id: "two", status: "running" }]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: "tool-section", lastToolId: ordinary.id });
    if (result[0].kind !== "tool-section") throw new Error("Missing tool section");
    expect(result[0].tools.map(({ index }) => index)).toEqual([0, 2]);
    expect(buildToolTimelineRows(entries(think))).toEqual([]);
    expect(buildRenderItems([user, tool("one"), assistant("Final answer"), think]).map(label)).toEqual(["user", "work-summary", "Final answer"]);
    const trailingNotice = { ...think, status: "failed" };
    const completed = buildRenderItems([user, tool("one"), assistant("Final answer"), trailingNotice]);
    expect(completed.map(label)).toEqual(["user", "work-summary", "Final answer", "tool-section"]);
    const notices = completed.filter((item) => item.kind === "tool-section").flatMap((item) => item.tools);
    expect(notices.map(({ message }) => message.id)).toEqual([trailingNotice.id]);
  });

  it.each(["failed", "error", "cancelled"])("shows a neutral think %s notice and skips it for final failure", (status) => {
    const action = tool("action", { kind: "execute", status: "failed" });
    const think = tool("think", { kind: "think", status });
    const rows = buildToolTimelineRows(entries(action, think));
    expect(rows).toHaveLength(2);
    expect(rows[1].tools[0].message).toBe(think);
    expect(toolTimelineRowState(rows[1], think.id)).toMatchObject({ failed: undefined, running: false });
    const sections = buildSequentialRenderItems([action, think]);
    expect(sections[0]).toMatchObject({ lastToolId: action.id });
    const summary = buildRenderItems([user, action, think]).find((item) => item.kind === "work-summary")!;
    expect(summary.lastToolId).toBe(action.id);
    expect(finalFailedTool(entries(action, think), summary.lastToolId)).toBe(action);
    expect(toolTimelineWindow([...rows, ...Array.from({ length: 4 }, (_, i) => ({ ...rows[0], key: `extra-${i}` }))], false).earlierCount).toBe(0);
  });

  it("merges only adjacent tool rows with the same complete label and action kind", () => {
    const command = (id: string, value: string, overrides: Partial<ToolMessage> = {}) => tool(id, { kind: "execute", input: [{ label: "cmd", value }], ...overrides });
    const rows = buildToolTimelineRows(entries(
      command("one", "git status"), command("two", "git status"),
      command("three", "git diff"), command("four", "git status"),
      tool("mcp-one", { name: "mcp__server__query", kind: "read" }),
      tool("mcp-two", { name: "mcp__server__query", kind: "execute" }),
    ));
    expect(rows.map((row) => row.tools.map(({ message }) => message.id))).toEqual([["one", "two"], ["three"], ["four"], ["mcp-one", "mcp-two"]]);
    const differentKinds = buildToolTimelineRows(entries(command("bash", "same"), command("output", "same", { name: "bash_output" })));
    expect(differentKinds).toHaveLength(2);
    const rawIdentity = buildToolTimelineRows(entries(command("wrapped", "bash -c 'git status'"), command("plain", "git status")));
    expect(rawIdentity).toHaveLength(2);
    const multiline = buildToolTimelineRows(entries(command("lines-one", "git status\ngit diff"), command("lines-two", "git status\ngit log")));
    expect(multiline).toHaveLength(2);
  });

  it("aggregates running and failure states while keeping recovered repetitions neutral", () => {
    const failed = tool("failed", { status: "failed" });
    const running = tool("running", { status: "running" });
    const completed = tool("completed");
    const row = (...messages: ToolMessage[]) => buildToolTimelineRows(entries(...messages))[0];
    expect(row(failed, running).tools).toHaveLength(2);
    expect(toolTimelineRowState(row(failed, running), failed.id)).toMatchObject({ running: true, hasFailure: true, failed: undefined });
    expect(toolTimelineRowState(row(failed, completed), completed.id)).toMatchObject({ running: false, hasFailure: true, failed: undefined });
    expect(toolTimelineRowState(row(completed, failed), failed.id).failed).toBe(failed);
    expect(toolTimelineRowState(row(completed, failed))).toMatchObject({ hasFailure: true, failed: undefined });
  });

  it.each([
    ['/bin/zsh -lc "git status"', "git status"],
    ["bash -c 'git status'", "git status"],
    ["sh -cl 'pwd'", "pwd"],
    ["/usr/bin/bash -c 'pwd'", "pwd"],
    ['zsh -lc "printf \\"hello\\""', 'printf \\"hello\\"'],
    ["bash -c 'printf \\n'", "printf \\n"],
    ["bash -lc git status", "bash -lc git status"],
    ["bash -ic 'pwd'", "bash -ic 'pwd'"],
    ["fish -c 'pwd'", "fish -c 'pwd'"],
    ["env bash -c 'pwd'", "env bash -c 'pwd'"],
    ["bash -c 'pwd' extra", "bash -c 'pwd' extra"],
    ["bash -c 'one' 'two'", "bash -c 'one' 'two'"],
    ["bash -c 'unclosed", "bash -c 'unclosed"],
  ])("formats shell wrapper %s without unescaping", (command, text) => {
    expect(shellTimelineDisplay(command)).toEqual({ text, additionalLines: 0 });
  });

  it("shows the first nonempty command line and counts only remaining nonempty lines", () => {
    expect(shellTimelineDisplay('/bin/zsh -lc "\n\npwd\n\ngit status\n git diff\n"')).toEqual({ text: "pwd", additionalLines: 2 });
    expect(shellTimelineDisplay("\r\npwd\r\n \r\ngit status\r\n")).toEqual({ text: "pwd", additionalLines: 1 });
    expect(shellTimelineDisplay("pwd\n\n")).toEqual({ text: "pwd", additionalLines: 0 });
  });

  it("folds six merged steps to five, excludes think notices, and preserves the running tail", () => {
    const calls = Array.from({ length: 6 }, (_, i) => tool(`step-${i}`, { status: i === 5 ? "running" : "completed", input: [{ label: "cmd", value: `command-${i}` }] }));
    const five = buildToolTimelineRows(entries(...calls.slice(0, 5)));
    expect(toolTimelineWindow(five, false)).toEqual({ rows: five, earlierCount: 0 });
    const six = buildToolTimelineRows(entries(...calls));
    expect(toolTimelineWindow(six, false)).toEqual({ rows: six.slice(1), earlierCount: 1 });
    expect(toolTimelineRowState(toolTimelineWindow(six, false).rows.at(-1)!).running).toBe(true);
    expect(toolTimelineWindow(six, true)).toEqual({ rows: six, earlierCount: 1 });
    const notice = buildToolTimelineRows(entries(tool("notice", { kind: "think", status: "error" })))[0];
    expect(toolTimelineWindow([notice, ...six], false)).toEqual({ rows: [notice, ...six.slice(1)], earlierCount: 1 });
    const repeated = buildToolTimelineRows(entries(...calls, { ...calls[5], id: "repeat" }));
    expect(repeated).toHaveLength(6);
    expect(toolTimelineWindow(repeated, false).earlierCount).toBe(1);
    const runningBackground = buildToolTimelineRows(entries(tool("background", { kind: "read", name: "read_file", status: "running" })))[0];
    const pinned = toolTimelineWindow([runningBackground, ...six.map((row) => ({ ...row, tools: row.tools.map((item) => ({ ...item, message: { ...item.message, status: "completed" } })) }))], false);
    expect(pinned.rows).toHaveLength(5);
    expect(pinned.rows[0]).toBe(runningBackground);
    expect(pinned.earlierCount).toBe(2);
    expect(toolTimelineExpansionKey("section", "earlier", "segment-one")).not.toBe(toolTimelineExpansionKey("section", "earlier", "segment-two"));
  });
});
