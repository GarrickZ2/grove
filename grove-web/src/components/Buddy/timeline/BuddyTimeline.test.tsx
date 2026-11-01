import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBuddiesMock } from "../../../api/buddies.mock";
import { buildGroveMetaTag } from "../../../utils/groveMeta";
import { BuddyTimeline } from "./BuddyTimeline";
import { emptyBuddyTimeline, reduceBuddyEvent, type BuddyEvent, type BuddyTimelineState } from "./buddyTimelineState";

vi.mock("../../ui/MarkdownRenderer", () => ({ MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div> }));

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const init = buildGroveMetaTag("grove_session_init", { kind: "buddy" }, "Internal instructions\nPersona instructions");
const render = (state: BuddyTimelineState) => act(() => root.render(<BuddyTimeline buddy={createBuddiesMock().get("mock-release")} state={state} connected onRespond={vi.fn()} onAnswer={vi.fn()} onSkip={vi.fn()} onOpenQuestion={vi.fn()} />));
const fromEvents = (events: BuddyEvent[]) => events.reduce((state, event) => reduceBuddyEvent(state, event), emptyBuddyTimeline());

it.each(["user_message", "v2_message_update"])("hides bootstrap metadata in %s, including replayed history, without changing the transcript", (type) => {
  const text = `${init}\n\nhi\n  keep indentation`;
  const event = type === "user_message"
    ? { type, text, message_id: "user-1" }
    : { type, update: { messageId: "user-1", sessionUpdate: "user_message", content: [{ type: "text", text }] } };
  const state = fromEvents([event]);
  render(state);
  expect(host.querySelector(".buddy-user-message")?.textContent).toBe("hi\n  keep indentation");
  expect(host.textContent).not.toContain("Internal instructions");
  expect(state.messages[0]).toMatchObject({ type: "user", content: text });
  render(fromEvents([event]));
  expect(host.querySelector(".buddy-user-message")?.textContent).toBe("hi\n  keep indentation");
});

it("does not render an empty bootstrap bubble, but retains attachments and the IM badge", () => {
  render(fromEvents([{ type: "user_message", text: init }]));
  expect(host.querySelector(".buddy-user-message")).toBeNull();
  render(fromEvents([{ type: "user_message", text: init, sender: "connect", attachments: [{ type: "resource", name: "notes.txt", uri: "file:///notes.txt" }] }]));
  expect(host.querySelector(".buddy-user-message")?.textContent).toBe("notes.txt");
  expect(host.querySelector('[aria-label="IM Connect"]')).not.toBeNull();
});

it("preserves literal malformed tags and other metadata instead of deleting user content", () => {
  const text = `Explain <grove-meta>{invalid}</grove-meta>\n${buildGroveMetaTag("example", {}, "Keep this example")}`;
  render(fromEvents([{ type: "user_message", text }]));
  expect(host.querySelector(".buddy-user-message")?.textContent).toBe(text);
});

it("keeps non-human prompts hidden and does not filter assistant answers", () => {
  render(fromEvents([{ type: "user_message", text: `${init}\nRoutine`, sender: "automation" }, { type: "message_chunk", text: "Here is your summary" }]));
  expect(host.querySelector(".buddy-user-message")).toBeNull();
  expect(host.querySelector(".buddy-assistant-message")?.textContent).toBe("Here is your summary");
});

it("renders an assistant reply as one bubble per paragraph, with receipts", () => {
  render(fromEvents([{ type: "message_chunk", text: "✓ **Report** → filed\n\nAll clear.\n\nAnything else?" }]));
  const bubbles = host.querySelectorAll(".buddy-assistant-message .buddy-bubble");
  expect([...bubbles].map(node => node.textContent)).toEqual(["Report → filed", "All clear.", "Anything else?"]);
  expect(bubbles[0].classList.contains("buddy-receipt")).toBe(true);
});

it("renders a long reply as plain prose without bubbles", () => {
  render(fromEvents([{ type: "message_chunk", text: "one\n\ntwo\n\nthree\n\nfour\n\nfive" }]));
  expect(host.querySelector(".buddy-bubble")).toBeNull();
  expect(host.querySelector(".buddy-assistant-message")?.textContent).toContain("five");
});

it("shows only the answer of a finished turn, with copy, time and duration on hover instead of a Worked-for line", () => {
  const at = (event: BuddyEvent, ms: number) => [event, ms] as const;
  const state = ([
    at({ type: "user_message", text: "Check my repo" }, 1_000),
    at({ type: "prompt_started" }, 2_000),
    at({ type: "tool_call", id: "t", title: "Read" }, 3_000),
    at({ type: "message_chunk", text: "Interim note" }, 4_000),
    at({ type: "tool_call", id: "u", title: "Bash" }, 5_000),
    at({ type: "message_chunk", text: "Final answer" }, 6_000),
    at({ type: "complete" }, 74_000),
  ] as const).reduce((value, [event, ms]) => reduceBuddyEvent(value, event, ms), emptyBuddyTimeline());
  render(state);
  expect(host.textContent).not.toContain("Worked for");
  expect(host.textContent).not.toContain("Interim note");
  const answer = host.querySelector(".buddy-assistant-message")!;
  expect(answer.textContent).toContain("Final answer");
  expect(answer.querySelector('[aria-label="Copy message"]')).not.toBeNull();
  expect(answer.textContent).toContain("1m12s");
  expect(host.querySelector('.buddy-user-turn [aria-label="Copy message"]')).not.toBeNull();
});

it("marks where a subagent reported back, between two answers", () => {
  const followUp = `${buildGroveMetaTag("buddy_message", { buddy_id: "b", name: "Jack", delegation_id: "d1", status: "done" }, "")}\nFollow-up Plan: design doc: "done"\nAll eight sections written.`;
  render(fromEvents([
    { type: "user_message", text: "Plan it" }, { type: "message_chunk", text: "On it." }, { type: "complete" },
    { type: "user_message", text: followUp, sender: "buddy:b", message_id: "f1" }, { type: "message_chunk", text: "Read it, looks good." }, { type: "complete" },
    { type: "user_message", text: "Daily check", sender: "automation:r1", message_id: "r1" },
  ]));
  const events = [...host.querySelectorAll(".buddy-notice")].map(node => [...node.children].map(child => child.textContent));
  expect(events).toEqual([["Subagent finished", "Plan: design doc"], ["Routine ran"]]);
  expect(host.textContent).not.toContain("All eight sections");
});
