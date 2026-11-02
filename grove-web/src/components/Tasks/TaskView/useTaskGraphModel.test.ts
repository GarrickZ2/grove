import { describe, expect, it } from "vitest";
import type { NodeStatus } from "../../../api/walkieTalkie";
import { checkEdge, edgeLiveState, graphApiError, pendingKey, sanitizeGraph, seedLiveMaps } from "./useTaskGraphModel";

const node = (chat_id: string, status = "idle") => ({ chat_id, name: chat_id, agent: "claude", status, pending_in: 0, pending_out: 0, pending_messages: [] });

describe("task graph model", () => {
  it("fills optional fields and seeds the live maps", () => {
    const data = sanitizeGraph({
      nodes: [{ chat_id: "a", name: "A", agent: "claude", status: "busy" } as never, node("b")],
      edges: [{ edge_id: 1, from: "a", to: "b", state: "blocked", pending_message: { from: "a", from_name: "A", to: "b", to_name: "B", body_excerpt: "hi" } }, { edge_id: 2, from: "b", to: "a", state: "idle" }],
    });
    expect(data.nodes[0]).toMatchObject({ pending_in: 0, pending_out: 0, pending_messages: [] });
    const { statuses, pending } = seedLiveMaps(data);
    expect(statuses.get("a")).toBe("busy");
    expect([...pending]).toEqual([[pendingKey("a", "b"), "hi"]]);
  });

  it("derives in-flight only while the target works", () => {
    const pending = new Map([[pendingKey("a", "b"), "hi"]]);
    const statuses = new Map<string, NodeStatus>([["b", "busy"]]);
    expect(edgeLiveState(pending, statuses, "a", "b")).toBe("in_flight");
    statuses.set("b", "idle");
    expect(edgeLiveState(pending, statuses, "a", "b")).toBe("blocked");
    expect(edgeLiveState(pending, statuses, "b", "a")).toBe("idle");
  });

  it("pre-flights self, duplicate, reverse and cyclic edges", () => {
    const data = sanitizeGraph({ nodes: [node("a"), node("b"), node("c")], edges: [{ edge_id: 1, from: "a", to: "b", state: "idle" }, { edge_id: 2, from: "b", to: "c", state: "idle" }] });
    expect(checkEdge(data, "a", "a").ok).toBe(false);
    expect(checkEdge(data, "a", "b")).toEqual({ ok: false, reason: "Edge already exists" });
    expect(checkEdge(data, "b", "a")).toEqual({ ok: false, reason: "Reverse edge already exists" });
    expect(checkEdge(data, "c", "a")).toEqual({ ok: false, reason: "Would create a cycle" });
    expect(checkEdge(data, "a", "c").ok).toBe(true);
  });

  it("reads backend error codes", () => {
    expect(graphApiError({ data: { code: "name_taken", error: "dup" } })).toEqual({ code: "name_taken", message: "dup" });
    expect(graphApiError(new Error("boom"))).toEqual({ code: "internal_error", message: "boom" });
  });
});
