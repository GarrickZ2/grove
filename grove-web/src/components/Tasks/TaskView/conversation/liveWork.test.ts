import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../TaskChat";
import type { WorkSummaryItem } from "../chatRenderItems";
import { liveGroupTail, liveToolStep, summarizeLiveWork } from "./liveWork";

type ToolMessage = Extract<ChatMessage, { type: "tool" }>;
const tool = (id: string, overrides: Partial<ToolMessage> = {}): ToolMessage => ({ type: "tool", id, name: "exec_command", title: "exec_command", kind: "execute", status: "completed", collapsed: true, ...overrides });
const items = (...messages: WorkSummaryItem["message"][]): WorkSummaryItem[] => messages.map((message, index) => ({ message, index }));

describe("liveToolStep", () => {
  it("names a running command in the present and a finished one in the past", () => {
    const running = tool("a", { status: "in_progress", input: [{ label: "command", value: "/bin/zsh -lc 'pnpm test'" }] });
    expect(liveToolStep(running)).toMatchObject({ kind: "run", verb: "Running", subject: "pnpm test", mono: true, running: true });
    expect(liveToolStep({ ...running, status: "completed" })).toMatchObject({ verb: "Ran", running: false });
  });

  it("names files by their base name and searches by their query", () => {
    expect(liveToolStep(tool("r", { name: "read_file", kind: "read", locations: [{ path: "src/a/b.ts" }] }))).toMatchObject({ kind: "read", verb: "Read", subject: "b.ts" });
    expect(liveToolStep(tool("e", { name: "edit_file", kind: "edit", status: "running", input: [{ label: "file_path", value: "src/c.tsx" }] }))).toMatchObject({ kind: "edit", verb: "Editing", subject: "c.tsx" });
    expect(liveToolStep(tool("s", { name: "grep", kind: "search", input: [{ label: "pattern", value: "useNow" }] }))).toMatchObject({ kind: "search", verb: "Searched", subject: "useNow" });
    expect(liveToolStep(tool("f", { name: "web_fetch", kind: "fetch", input: [{ label: "url", value: "https://example.com/a" }] }))).toMatchObject({ kind: "fetch", subject: "example.com" });
  });

  it("keeps an unknown tool's descriptive title and flags failures", () => {
    expect(liveToolStep(tool("x", { name: undefined, kind: undefined, title: "Inspect bundle", status: "failed" }))).toMatchObject({ kind: "tool", verb: "", subject: "Inspect bundle", failed: true });
  });
});

describe("summarizeLiveWork", () => {
  it("counts steps without thinking and prefers the running step", () => {
    const summary = summarizeLiveWork(items(
      tool("a", { status: "failed" }),
      tool("think", { kind: "think", status: "failed" }),
      tool("b", { status: "in_progress", input: [{ label: "command", value: "ls" }] }),
      { type: "thinking", content: "**Planning**", complete: false, collapsed: false },
    ), true);
    expect(summary.steps).toBe(2);
    expect(summary.failedSteps).toBe(1);
    expect(summary.current).toMatchObject({ verb: "Running", subject: "ls" });
  });

  it("shows unfinished thinking after the latest tool by its heading", () => {
    const summary = summarizeLiveWork(items(tool("a"), { type: "thinking", content: "x\n**Checking the cache**", complete: false, collapsed: false }), false);
    expect(summary.current).toMatchObject({ kind: "thinking", subject: "Checking the cache" });
  });

  it("reads Thinking between steps at the tail, else the latest finished step", () => {
    const work = items(tool("a", { input: [{ label: "command", value: "make" }] }));
    expect(summarizeLiveWork(work, true).current).toMatchObject({ kind: "thinking", subject: "Thinking" });
    expect(summarizeLiveWork(work, false).current).toMatchObject({ verb: "Ran", subject: "make" });
  });
});

describe("liveGroupTail", () => {
  const group = { kind: "work-summary", live: true };
  it("stays the tail past records and asks, not past agent output", () => {
    expect(liveGroupTail([{ kind: "single", message: { type: "user" } }, group, { kind: "single", message: { type: "permission" } }, { kind: "single", message: { type: "session_notice" } }])).toEqual({ index: 1, atTail: true });
    expect(liveGroupTail([group, { kind: "single", message: { type: "assistant" } }])).toEqual({ index: 0, atTail: false });
    expect(liveGroupTail([group, { kind: "tool-section" }])).toEqual({ index: 0, atTail: false });
    expect(liveGroupTail([{ kind: "work-summary" }])).toEqual({ index: -1, atTail: false });
  });
});

describe("waiting for approval", () => {
  it("names the tool a pending permission is for, ahead of other running tools", () => {
    const work = items(
      tool("ask", { status: "pending", input: [{ label: "command", value: "git push" }] }),
      tool("other", { status: "in_progress", input: [{ label: "command", value: "ls" }] }),
    );
    expect(summarizeLiveWork(work, true, ["ask"]).current).toMatchObject({ verb: "Waiting for approval", subject: "git push" });
    // An id-less (legacy) request falls back to the latest running tool.
    expect(summarizeLiveWork(work, true, [""]).current).toMatchObject({ verb: "Waiting for approval", subject: "ls" });
    // A pending tool with no permission request is simply running.
    expect(summarizeLiveWork(items(tool("p", { status: "pending", input: [{ label: "command", value: "make" }] })), true).current).toMatchObject({ verb: "Running" });
  });
});
