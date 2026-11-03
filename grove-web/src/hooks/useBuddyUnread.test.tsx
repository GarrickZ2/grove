import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import type { BuddySummary } from "../api/buddies";
import { useBuddyUnread } from "./useBuddyUnread";

const summary = (id: string, last_activity_at: string | null): BuddySummary => ({ id, project_hash: `${id}-project`, name: id, avatar: null, description: "", agent: "codex", status: "idle", last_message_preview: "", last_activity_at, active_session_id: `${id}-s`, running_delegations: 0, waiting_delegations: 0, pinned: false, role: "" });

beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); localStorage.clear(); });

it("starts read, marks newer activity unread, and clears it once viewed", () => {
  let unread = new Set<string>();
  function Probe({ items, viewing }: { items: BuddySummary[]; viewing: string }) { unread = useBuddyUnread(items, viewing).unread; return null; }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Probe items={[summary("a", "2026-10-31T10:00:00Z"), summary("b", "2026-10-31T10:00:00Z")]} viewing="a" />));
  expect([...unread]).toEqual([]);
  act(() => root.render(<Probe items={[summary("a", "2026-10-31T10:05:00Z"), summary("b", "2026-10-31T10:05:00Z")]} viewing="a" />));
  expect([...unread]).toEqual(["b"]);
  act(() => root.render(<Probe items={[summary("a", "2026-10-31T10:05:00Z"), summary("b", "2026-10-31T10:05:00Z")]} viewing="b" />));
  expect([...unread]).toEqual([]);
  expect(JSON.parse(localStorage.getItem("grove-buddy-seen") ?? "{}")).toMatchObject({ b: "2026-10-31T10:05:00Z" });
  act(() => root.unmount());
});
