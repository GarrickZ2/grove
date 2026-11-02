import { describe, expect, it } from "vitest";
import type { ChatSessionResponse } from "../../api";
import { mergeRecentSessions } from "./useRecentSessions";

const chat = (id: string, created: string) => ({ id, title: id, agent: "claude", created_at: created, history_path: "", launch_mode: "acp" }) as ChatSessionResponse;

describe("mergeRecentSessions", () => {
  it("merges every task's sessions newest first, skipping unknown tasks and capping the list", () => {
    const byTask = {
      _local: [chat("a", "2026-11-01T08:00:00Z"), chat("bad", "not a date")],
      t1: [chat("b", "2026-11-01T09:00:00Z")],
      gone: [chat("c", "2026-11-01T10:00:00Z")],
    };
    expect(mergeRecentSessions(byTask, ["_local", "t1"]).map((row) => [row.taskId, row.chat.id])).toEqual([["t1", "b"], ["_local", "a"], ["_local", "bad"]]);
    expect(mergeRecentSessions(byTask, ["_local", "t1"], 1)).toHaveLength(1);
  });

  it("orders by last activity when the server reports it", () => {
    const byTask = {
      _local: [{ ...chat("old-but-active", "2026-10-01T08:00:00Z"), updated_at: "2026-11-01T11:00:00Z" }],
      t1: [chat("new", "2026-11-01T09:00:00Z")],
    };
    const rows = mergeRecentSessions(byTask, ["_local", "t1"]);
    expect(rows.map((row) => row.chat.id)).toEqual(["old-but-active", "new"]);
    expect(rows[0].activeAt).toBe(Date.parse("2026-11-01T11:00:00Z"));
  });
});
