import { describe, expect, it } from "vitest";
import type { BuddySummary } from "../../api/buddies";
import { createBuddiesMock } from "../../api/buddies.mock";
import { mentionAtCaret, mentionCandidates, mentionRuns, mentionedIn, readMentions, withMentions } from "./buddyMentions";

const buddies = createBuddiesMock().list();

it("finds the @query at the caret only after a space or the start", () => {
  expect(mentionAtCaret("ask @Rel", 8)).toEqual({ start: 4, query: "Rel" });
  expect(mentionAtCaret("@", 1)).toEqual({ start: 0, query: "" });
  expect(mentionAtCaret("mail me@x", 9)).toBeNull();
  expect(mentionAtCaret("ask @Rel done", 13)).toBeNull();
});

it("ranks name prefixes, then word prefixes, then substrings", () => {
  expect(mentionCandidates(buddies, "cap").map((b) => b.name)).toEqual(["Release Captain"]);
  expect(mentionCandidates(buddies, "").length).toBe(buddies.length);
  expect(mentionCandidates(buddies, "zzz")).toEqual([]);
});

it("sends who was mentioned in an envelope and shows it back as chips", () => {
  expect(withMentions("no mentions here", buddies)).toBe("no mentions here");
  expect(mentionedIn("email @Inboxes", buddies)).toEqual([]);
  const prompt = withMentions("ask @Release Captain, then @inbox.", buddies);
  expect(prompt).toContain("message_buddy");
  expect(prompt).toContain("Buddy id mock-release");
  const { text, buddies: mentioned } = readMentions(prompt);
  expect(text).toBe("ask @Release Captain, then @inbox.");
  expect(mentioned.map((b) => b.name)).toEqual(["Release Captain", "Inbox"]);
  expect(mentionRuns(text, mentioned).map((run) => "buddy" in run ? `[${run.buddy.name}]` : run.text).join("")).toBe("ask [Release Captain], then [Inbox].");
});

describe("mentions across machines", () => {
  it("tells the Agent where the Buddy lives and how to address it", () => {
    const remote = { id: "studio/ada", name: "Ada", avatar: null, role: "Design", machine: "Studio Mac" } as BuddySummary;
    const sent = withMentions("ask @Ada", [remote]);
    expect(sent).toContain("Buddy id studio/ada, on the machine Studio Mac, role: Design");
    expect(readMentions(sent).buddies[0].id).toBe("studio/ada");
  });
});
