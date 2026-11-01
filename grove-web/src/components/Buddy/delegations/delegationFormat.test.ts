import { expect, it } from "vitest";
import type { BuddyDelegation } from "../../../api/buddies";
import { delegationStatusLabel, elapsedLabel, resolveDelegationRows } from "./delegationFormat";

const delegation = (id: string, created_at: string, status: BuddyDelegation["status"] = "running"): BuddyDelegation => ({ id, title: id, brief: "", status, from_session: "s", target_project: "p", target_task: "t", target_session: `${id}-session`, last_result: null, created_at, updated_at: created_at, completed_at: null });

it("matches rows by id first, then assigns the rest in creation order", () => {
  const items = [delegation("b", "2026-10-31T10:02:00Z"), delegation("a", "2026-10-31T10:01:00Z"), delegation("c", "2026-10-31T10:03:00Z")];
  const result = resolveDelegationRows([{ id: "r1" }, { id: "r2", delegationId: "c" }, { id: "r3", failed: true }, { id: "r4" }], items);
  expect([...result].map(([row, item]) => [row, item.id])).toEqual([["r1", "a"], ["r2", "c"], ["r4", "b"]]);
});
it("formats elapsed time and statuses", () => {
  const start = "2026-10-31T10:00:00Z";
  expect(elapsedLabel(start, Date.parse(start) + 42_000)).toBe("42s");
  expect(elapsedLabel(start, Date.parse(start) + 125 * 60_000)).toBe("2h 5m");
  expect(delegationStatusLabel(delegation("x", start), Date.parse(start) + 120_000)).toBe("Subagent working · 2m");
  expect(delegationStatusLabel(delegation("x", start, "waiting"))).toBe("Needs you");
});
