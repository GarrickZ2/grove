vi.hoisted(() => vi.stubEnv("VITE_BUDDIES_MOCK", "true"));
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BuddyConversation } from "./BuddyConversation";
import { buddiesMock } from "../../api/buddies.mock";
vi.mock("../ui/MarkdownRenderer", () => ({ MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div> }));
vi.mock("./BuddyComposer", () => ({ BuddyComposer: ({ initialText }: { initialText: string }) => <textarea defaultValue={initialText} /> }));
let host: HTMLDivElement; let root: Root;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.createElement("div"); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });
it("renders a standalone Buddy timeline and does not start a prompt on opening", () => {
  const buddy = buddiesMock.create({ name: "Writer", role: "Maintain docs", agent: "codex" });
  act(() => root.render(<BuddyConversation buddy={buddy} onChanged={vi.fn()} />));
  expect(host.textContent).toContain("Say hi to Writer");
  expect(host.textContent).not.toContain("Live chat");
  expect(host.querySelector(".buddy-timeline")).not.toBeNull();
  expect(buddiesMock.messages(buddy.id)).toHaveLength(0);
});
