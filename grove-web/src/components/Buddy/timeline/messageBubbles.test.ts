import { expect, it } from "vitest";
import { chatBubbles, splitBubbles, withoutApprovalNotes } from "./messageBubbles";

it("puts each paragraph of a short reply in its own bubble", () => {
  expect(chatBubbles("first thought\n\n\nsecond thought")).toEqual([
    { kind: "text", content: "first thought" },
    { kind: "text", content: "second thought" },
  ]);
  expect(chatBubbles("")).toEqual([]);
});

it("keeps long or structured replies as one plain block", () => {
  expect(chatBubbles("a\n\nb\n\nc\n\nd\n\ne")).toBeNull();
  expect(chatBubbles("x".repeat(141))).toBeNull();
  expect(chatBubbles("Three ways:\n- one\n- two")).toBeNull();
  expect(chatBubbles("## Plan\n\nShip it")).toBeNull();
  expect(chatBubbles("Run this:\n\n```ts\nconst a = 1;\n```")).toBeNull();
  expect(chatBubbles("| a | b |\n|---|---|\n| 1 | 2 |")).toBeNull();
});

it("never splits inside a code fence, even mid-stream", () => {
  expect(splitBubbles("```ts\nconst a = 1;\n\nconst b = 2;\n```")).toHaveLength(1);
  expect(splitBubbles("```\nstill streaming\n\nmore")).toHaveLength(1);
});

it("turns check-mark paragraphs into receipts", () => {
  expect(chatBubbles("✓ **Venue** → marina house booked\n- ✔ Calendar -> invites updated\n✓ Holds\n\nYou're clear until 2pm.")).toEqual([
    { kind: "receipt", items: [
      { label: "Venue", result: "marina house booked" },
      { label: "Calendar", result: "invites updated" },
      { label: "Holds" },
    ] },
    { kind: "text", content: "You're clear until 2pm." },
  ]);
  expect(chatBubbles("Done:\n\n✓ Report → filed")?.[1]).toEqual({ kind: "receipt", items: [{ label: "Report", result: "filed" }] });
});

it("drops automatic approval notes in any wording and keeps the reply", () => {
  const note = "Automatic approval review approved (risk: low, authorization: unknown): Auto-review returned a low-risk allow decision.";
  expect(withoutApprovalNotes(note).trim()).toBe("");
  expect(withoutApprovalNotes(`${note}${note}\n\nDone, tests pass.`)).toBe("Done, tests pass.");
  for (const variant of [
    "Automatic approval review denied (risk: high, authorization: low): Blocked by policy.",
    "automatic approval review approved (risk: medium): Looks safe",
    "Automatic approval review approved: no risk found.",
  ]) expect(withoutApprovalNotes(variant).trim()).toBe("");
  const mention = "Automatic approval review is on for this repo.";
  expect(withoutApprovalNotes(mention)).toBe(mention);
});
