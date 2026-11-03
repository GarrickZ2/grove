import { describe, expect, it } from "vitest";
import type { MentionItem } from "../../../utils/fileMention";
import { createMentionChip, filterComposerMentions, getPromptFromEditable, mentionCategorySelectors, parseMentionQuery } from "./composerMentions";

const file: MentionItem = { path: "src/main.rs", isDir: false };
const history: MentionItem = { path: "chat:c1", isDir: false, kind: "chat_history", displayName: "Old chat", sessionId: "c1", historyPath: "/h/c1.jsonl", agentName: "codex" };
const spawn: MentionItem = { path: "spawn:codex", isDir: false, kind: "agent_spawn", displayName: "Codex", agentName: "codex" };

function filter(activeCategory: string | null, query: string) {
  return filterComposerMentions({
    items: [spawn, history, file],
    browserTabs: [],
    selectors: mentionCategorySelectors({ studio: false, browserTabs: false }),
    activeCategory,
    filter: query,
    deferredFilter: query,
    projects: [],
    projectContents: {},
    projectsLoading: false,
    projectsError: false,
  });
}

describe("composer @-mentions", () => {
  it("reads the mention being typed, with or without a category", () => {
    expect(parseMentionQuery("see @src/ma", 11, false)).toEqual({ atIdx: 4, category: null, filter: "src/ma" });
    expect(parseMentionQuery("@conversation:old ch", 20, false)).toEqual({ atIdx: 0, category: "conversation", filter: "old ch" });
    // Sketches are a Studio category only.
    expect(parseMentionQuery("@sketch:a", 9, false)?.category).toBeNull();
    expect(parseMentionQuery("@sketch:a", 9, true)?.category).toBe("sketch");
    // An @ inside a word, or a finished mention followed by a space, is not a trigger.
    expect(parseMentionQuery("mail@host", 9, false)).toBeNull();
    expect(parseMentionQuery("@src done", 9, false)).toBeNull();
  });

  it("lists the category rows for a bare @ and narrows to one category", () => {
    expect(filter(null, "").slice(0, 4).map((item) => item.displayName)).toEqual(["Conversation", "Files", "Agents", "Projects"]);
    expect(filter("conversation", "").map((item) => item.path)).toEqual(["chat:c1"]);
    expect(filter("agent", "").map((item) => item.path)).toEqual(["spawn:codex"]);
    expect(filter("file", "main").map((item) => item.path)).toEqual(["src/main.rs"]);
  });

  it("serializes file and history chips into the prompt", () => {
    const el = document.createElement("div");
    el.append("read ", createMentionChip(file, file.path, false, undefined, undefined), " and ", createMentionChip(history, history.path, false, undefined, undefined));
    const prompt = getPromptFromEditable(el);
    expect(prompt.startsWith("read src/main.rs and <grove-meta>")).toBe(true);
    expect(prompt).toContain("mention_chat_history");
    expect(prompt).toContain("/h/c1.jsonl");
  });
});
