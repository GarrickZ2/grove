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
