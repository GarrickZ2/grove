import { describe, expect, it } from "vitest";
import type { ReviewCommentEntry } from "../../../api";
import { commentLocation, filterComments, plural, splitPath, usageDays } from "./panelModel";
import type { TimeseriesBucket } from "../../../api/statistics";

const bucket = (at: Date, tokens: number, turns = 1): TimeseriesBucket => ({
  bucket_start: Math.floor(at.getTime() / 1000),
  turns,
  tokens_in: tokens,
  tokens_cached: 0,
  tokens_out: 0,
  per_agent: [{ agent: "claude", tokens, turns, cost: 0 }],
  cost_total: 0,
});

describe("usageDays", () => {
  const now = new Date(2026, 9, 26, 18).getTime();

  it("folds hourly buckets into local days, oldest first, zero-filled", () => {
    const days = usageDays([
      bucket(new Date(2026, 9, 26, 9), 400),
      bucket(new Date(2026, 9, 26, 14), 100, 2),
      bucket(new Date(2026, 9, 25, 23), 50),
      bucket(new Date(2026, 9, 1, 10), 9_999),
    ], 3, now);
    expect(days?.map((day) => [day.label, day.tokens, day.turns])).toEqual([
      ["Oct 24", 0, 0],
      ["Yesterday", 50, 1],
      ["Today", 500, 3],
    ]);
  });

  it("is null when nothing was used in the window", () => {
    expect(usageDays([], 14, now)).toBeNull();
    expect(usageDays([bucket(new Date(2026, 8, 1), 10)], 14, now)).toBeNull();
  });
});

describe("commentLocation", () => {
  it("labels inline, file and project comments", () => {
    expect(commentLocation({ file_path: "src/api/tasks.ts", start_line: 12, end_line: 18 })).toEqual({ label: "tasks.ts:L12–18", title: "src/api/tasks.ts L12–18" });
    expect(commentLocation({ file_path: "src/a.ts", start_line: 4, end_line: 4 }).label).toBe("a.ts:L4");
    expect(commentLocation({ comment_type: "file", file_path: "src/a.ts" }).label).toBe("a.ts");
    expect(commentLocation({ comment_type: "project" }).label).toBe("Whole change");
  });
});

describe("filterComments", () => {
  const make = (id: number, status: string) => ({ id, status } as ReviewCommentEntry);
  const all = [make(1, "open"), make(2, "outdated"), make(3, "resolved")];
  it("counts outdated as open", () => {
    expect(filterComments(all, "open").map((c) => c.id)).toEqual([1, 2]);
    expect(filterComments(all, "resolved").map((c) => c.id)).toEqual([3]);
    expect(filterComments(all, "all")).toHaveLength(3);
  });
});

describe("helpers", () => {
  it("splits paths and pluralizes", () => {
    expect(splitPath("src/api/tasks.ts")).toEqual({ dir: "src/api/", name: "tasks.ts" });
    expect(splitPath("README.md")).toEqual({ dir: "", name: "README.md" });
    expect(plural(1, "file")).toBe("1 file");
    expect(plural(3, "edit")).toBe("3 edits");
  });
});
