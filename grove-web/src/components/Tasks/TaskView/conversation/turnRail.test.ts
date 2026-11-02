import { describe, expect, it } from "vitest";
import { nextRailIndex, railPlainText, railPreviewTop, railTickState, railToolSummary } from "./turnRail";

const turn = (overrides = {}) => ({ messageIndex: 4, user: "Fix it", assistant: "Done", isStreaming: false, tools: [], ...overrides });

describe("turn rail", () => {
  it("derives each line's state", () => {
    expect(railTickState(turn({ isStreaming: true }), 4)).toBe("streaming");
    expect(railTickState(turn(), 4)).toBe("active");
    expect(railTickState(turn(), 2)).toBe("answered");
    expect(railTickState(turn({ assistant: "" }), null)).toBe("unanswered");
  });

  it("moves focus with arrows and Home/End, clamped, ignoring other keys", () => {
    expect(nextRailIndex(0, "ArrowDown", 3)).toBe(1);
    expect(nextRailIndex(2, "ArrowDown", 3)).toBe(2);
    expect(nextRailIndex(0, "ArrowUp", 3)).toBe(0);
    expect(nextRailIndex(1, "Home", 3)).toBe(0);
    expect(nextRailIndex(1, "End", 3)).toBe(2);
    expect(nextRailIndex(1, "Enter", 3)).toBeNull();
    expect(nextRailIndex(0, "ArrowDown", 0)).toBeNull();
  });

  it("summarizes tools and keeps the preview inside the viewport", () => {
    expect(railToolSummary([{ label: "Exploration", count: 3 }, { label: "Edit", count: 1 }])).toBe("Exploration ×3 · Edit");
    expect(railToolSummary([{ label: "A", count: 1 }, { label: "B", count: 1 }, { label: "C", count: 1 }, { label: "D", count: 2 }])).toBe("A · B · C · +1 more");
    expect(railPreviewTop(400, 100, 900)).toBe(350);
    expect(railPreviewTop(20, 100, 900)).toBe(12);
    expect(railPreviewTop(890, 100, 900)).toBe(788);
  });
});

describe("railPlainText", () => {
  it("drops Markdown syntax from previews", () => {
    expect(railPlainText("Done. ## What changed - The **rail** uses `code` and [a link](http://x)")).toBe("Done. What changed The rail uses code and a link");
  });
});
