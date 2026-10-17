import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { ChatMessage, ServerEvent } from "./TaskChat";
import { reducePlanDocumentEvent, sessionPlanDocuments, planFilePath, type PlanDocument } from "./executionPlans";
import { reduceSubagentEvent } from "./subagents";
import { buildRenderItems } from "./chatRenderItems";
import { PlanDocumentsPanel } from "./PlanDocumentsPanel";
import { readFile } from "../../../api";

vi.mock("../../../api", () => ({ readFile: vi.fn() }));
const update = (plan: PlanDocument) => ({ type: "plan_document_update", plan });
const markdown = (id: string, content: string): PlanDocument => ({ type: "markdown", plan_id: id, content });
const reduce = (messages: ChatMessage[], event: ServerEvent): ChatMessage[] => event.type === "subagent_event" || event.type === "subagent_update" ? reduceSubagentEvent(messages, event, reduce) : reducePlanDocumentEvent(messages, event);

describe("native execution plans", () => {
  it("keeps IDs and scopes independent, replaces snapshots, and replays removals", () => {
    let messages: ChatMessage[] = [];
    const events = [update(markdown("a", "first")), update(markdown("b", "other")), update(markdown("a", "")), { type: "subagent_update", session_id: "child", parent_session_id: "root" }, { type: "subagent_event", session_id: "child", event: update(markdown("a", "child")) }, { type: "plan_document_removed", plan_id: "b" }];
    for (const event of events) messages = reduce(messages, event);
    expect(sessionPlanDocuments(messages)).toEqual([markdown("a", "")]);
    const child = messages.find((message) => message.type === "subagent")!;
    if (child.type !== "subagent") throw new Error("Missing child");
    expect(sessionPlanDocuments(child.messages)).toEqual([markdown("a", "child")]);
    expect(JSON.parse(JSON.stringify(events)).reduce(reduce, [])).toEqual(messages);
    const removed = reduce(messages, { type: "plan_document_removed", plan_id: "a" });
    expect(sessionPlanDocuments(removed)).toEqual([]);
    expect(removed).toHaveLength(1);
  });

  it("does not leak plan metadata into work summaries or hide the final answer", () => {
    const messages: ChatMessage[] = [{ type: "user", content: "Work" }, { type: "tool", id: "t", title: "read", status: "completed", collapsed: true }, { type: "plan_document", plan: markdown("a", "# Plan") }, { type: "assistant", content: "Answer", complete: true }];
    expect(buildRenderItems(messages).map((item) => item.kind)).toEqual(["single", "work-summary", "single"]);
  });

  it("only resolves local file URIs, including escaped paths and Windows drives", () => {
    expect(planFilePath("file:///tmp/my%20plan.md")).toBe("/tmp/my plan.md");
    expect(planFilePath("file:///C:/work/plan.md")).toBe("C:/work/plan.md");
    for (const uri of ["https://example.com/p.md", "file://other-host/p.md", "file:///p.md?token=x", "file:///bad%GG"]) expect(planFilePath(uri)).toBeNull();
  });

  it("switches plans without losing selection on streaming updates, and handles removal", async () => {
    const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previous = env.IS_REACT_ACT_ENVIRONMENT; env.IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement("div"); const root = createRoot(host);
    const a = markdown("a", "# Alpha\nAlpha body"); const b = markdown("b", "# Beta\nBeta body");
    try {
      await act(async () => root.render(<PlanDocumentsPanel plans={[a, b]} />));
      expect(host.textContent).toContain("Beta body");
      await act(async () => (host.querySelector('button[title="Alpha"]') as HTMLButtonElement).click());
      await act(async () => root.render(<PlanDocumentsPanel plans={[a, markdown("b", "Changed Beta")]} />));
      expect(host.textContent).toContain("Alpha body");
      expect(host.textContent).not.toContain("Changed Beta");
      await act(async () => root.render(<PlanDocumentsPanel plans={[b]} />));
      expect(host.textContent).toContain("Beta body");
      await act(async () => root.render(<PlanDocumentsPanel plans={[]} />));
      expect(host.textContent).toBe("");
    } finally { await act(async () => root.unmount()); env.IS_REACT_ACT_ENVIRONMENT = previous; }
  });

  it("does not read remote files and ignores stale local file responses", async () => {
    const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previous = env.IS_REACT_ACT_ENVIRONMENT; env.IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement("div"); const root = createRoot(host);
    const pending: Array<(value: { path: string; content: string }) => void> = [];
    vi.mocked(readFile).mockClear().mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    const file = (uri: string): PlanDocument => ({ type: "file", plan_id: "file", uri });
    try {
      await act(async () => root.render(<PlanDocumentsPanel plans={[file("file:///one.md")]} />));
      expect(readFile).not.toHaveBeenCalled();
      await act(async () => root.render(<PlanDocumentsPanel plans={[file("file:///one.md")]} allowLocalFiles />));
      await act(async () => root.render(<PlanDocumentsPanel plans={[file("file:///two.md")]} allowLocalFiles />));
      await act(async () => pending[1]({ path: "/two.md", content: "Current plan" }));
      await act(async () => pending[0]({ path: "/one.md", content: "Stale plan" }));
      expect(host.textContent).toContain("Current plan");
      expect(host.textContent).not.toContain("Stale plan");
    } finally { await act(async () => root.unmount()); env.IS_REACT_ACT_ENVIRONMENT = previous; }
  });
});
