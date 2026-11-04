import { describe, expect, it } from "vitest";
import type { BuddyGroupMessage } from "../../../api/buddyGroups";
import { mergeBuddyList, groupEntry, type BuddyGroup } from "../../../api/buddyGroups";
import type { BuddySummary } from "../../../api/buddies";
import { groupRows, latestGroupReply, quietText } from "./groupTimeline";

const log = (...kinds: [BuddyGroupMessage["sender_kind"], string?][]) => kinds.map(([sender_kind, sender_id], index) => ({ group_id: "g", seq: index + 1, sender_kind, sender_id: sender_id ?? null, text: "", mentions: [], attachments: [], created_at: "" }));
const nameOf = (id: string) => id.toUpperCase();

describe("groupRows", () => {
  it("folds quiet turns into one line", () => {
    const rows = groupRows(log(["user"], ["buddy", "a"], ["quiet", "b"], ["quiet", "c"]), nameOf, false);
    expect(rows.map((row) => row.kind)).toEqual(["user", "buddy", "quiet"]);
    expect(quietText(rows[2] as Extract<typeof rows[number], { kind: "quiet" }>)).toBe("B, C stayed quiet");
  });
  it("says when nobody answered the user, once everyone is done", () => {
    const messages = log(["user"], ["quiet", "a"], ["quiet", "b"]);
    const done = groupRows(messages, nameOf, false)[1];
    expect(quietText(done as Extract<typeof done, { kind: "quiet" }>)).toBe("Nobody replied · A, B stayed quiet");
    const running = groupRows(messages, nameOf, true)[1];
    expect(quietText(running as Extract<typeof running, { kind: "quiet" }>)).toBe("A, B stayed quiet");
  });
  it("keeps a quiet line beside a later reply plain", () => {
    const rows = groupRows(log(["user"], ["quiet", "a"], ["buddy", "b"]), nameOf, false);
    expect(rows[1]).toMatchObject({ kind: "quiet", nobodyReplied: false });
  });
});

describe("mergeBuddyList", () => {
  const buddy = (id: string, sort_position: number | null) => ({ id, sort_position }) as BuddySummary;
  const group = (id: string, sort_position: number | null) => ({ id, name: id, sort_position, members: [], pinned: false, status: "idle", last_message_preview: null, last_activity_at: null, created_at: "" }) as BuddyGroup;
  it("orders by saved position with new entries last", () => {
    expect(mergeBuddyList([buddy("a", 2), buddy("b", null)], [group("g", 1)], null).map((item) => item.id)).toEqual(["g", "a", "b"]);
  });
  it("prefers a reorder made in this session", () => {
    expect(mergeBuddyList([buddy("a", 0)], [group("g", 1)], ["g", "a"]).map((item) => item.id)).toEqual(["g", "a"]);
  });
  it("marks group rows", () => {
    expect(groupEntry(group("g", null)).group?.id).toBe("g");
  });
});

describe("latestGroupReply", () => {
  const message = (sender_kind: string, created_at: string, text: string) => ({ sender_kind, sender_id: "a", text, created_at });
  it("shows the newest reply and counts the rest", () => {
    const messages = [message("buddy", "2026-11-03T10:00:00Z", "old"), message("user", "2026-11-03T10:01:00Z", "ask"), message("buddy", "2026-11-03T10:02:00Z", "one"), message("quiet", "2026-11-03T10:03:00Z", ""), message("buddy", "2026-11-03T10:04:00Z", "two")];
    expect(latestGroupReply(messages, "2026-11-03T10:00:30Z", () => "Mira")).toEqual({ text: "Mira: two", more: 1 });
    expect(latestGroupReply(messages, "2026-11-03T10:05:00Z", () => "Mira")).toBeNull();
  });
});

it("keeps who a member event is about", () => {
  const [removed, back] = log(["system", "b"], ["system", "b"]);
  const rows = groupRows([{ ...removed, text: "Kai was removed" }, { ...back, text: "Kai joined" }], () => "", false);
  expect(rows[0]).toMatchObject({ kind: "system", seq: 1, buddyId: "b", joined: false });
  expect(rows[1]).toMatchObject({ kind: "system", seq: 2, buddyId: "b", joined: true });
});
