import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MentionEditable } from "./MentionEditable";
import type { MentionSources } from "./useMentionSources";

vi.mock("../../../../context", () => ({ useTheme: () => ({ theme: { accentPalette: ["#3370ff"], colors: { bg: "#ffffff" } } }) }));
vi.mock("../useProjectMentions", () => ({
  useProjectMentions: () => ({ projects: [], projectsLoading: false, projectsError: false, contents: {} }),
}));

const sources: MentionSources = {
  items: [
    { path: "chat:c1", isDir: false, kind: "chat_history", displayName: "Old chat", sessionId: "c1", historyPath: "/h/c1.jsonl", agentName: "codex" },
    { path: "src/main.rs", isDir: false },
  ],
  browserTabs: [],
  browserTabsAvailable: false,
  studio: false,
  refresh: vi.fn(),
  loadBrowserTabs: vi.fn(),
};

describe("MentionEditable", () => {
  let host: HTMLDivElement;
  let root: Root;
  let onChange: ReturnType<typeof vi.fn<(value: { text: string; html: string }) => void>>;
  let onSubmit: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    // jsdom has no layout; the picker scrolls its selected row into view.
    Element.prototype.scrollIntoView = vi.fn();
    onChange = vi.fn();
    onSubmit = vi.fn();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root.render(<MentionEditable sources={sources} placeholder="Ask" onChange={onChange} onSubmit={onSubmit} />));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  const editor = () => host.querySelector<HTMLElement>('[role="textbox"]')!;
  const rows = () => Array.from(document.querySelectorAll<HTMLButtonElement>("button"));

  /** Type `text` as the editor's whole content, caret at the end. */
  function type(text: string) {
    const el = editor();
    el.textContent = text;
    const range = document.createRange();
    range.setStart(el.firstChild!, text.length);
    range.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    act(() => { el.dispatchEvent(new Event("input", { bubbles: true })); });
  }

  function key(name: string) {
    const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
    act(() => { editor().dispatchEvent(event); });
    return event;
  }

  it("opens the picker on @ and inserts the chosen file as a chip", () => {
    type("look at @main");
    expect(sources.refresh).toHaveBeenCalled();
    expect(rows().some((row) => row.textContent?.includes("src/main.rs"))).toBe(true);
    expect(key("Enter").defaultPrevented).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(editor().querySelector("[data-file]")?.getAttribute("data-file")).toBe("src/main.rs");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ text: "look at src/main.rs" }));
  });

  it("narrows to a category row, then inserts a history chip", () => {
    type("@");
    const conversation = rows().find((row) => row.textContent?.includes("Conversation"))!;
    act(() => conversation.click());
    expect(editor().textContent).toBe("@conversation:");
    key("Enter");
    expect(editor().querySelector("[data-mention-kind]")?.getAttribute("data-mention-kind")).toBe("chat_history");
    expect(onChange.mock.lastCall![0].text).toContain("mention_chat_history");
  });

  it("submits on Enter when no picker is open", () => {
    type("hello");
    expect(key("Enter").defaultPrevented).toBe(true);
    expect(onSubmit).toHaveBeenCalledOnce();
  });
});
