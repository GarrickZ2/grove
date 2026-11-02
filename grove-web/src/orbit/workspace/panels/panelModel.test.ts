import { describe, expect, it } from "vitest";
import type { ReviewCommentEntry } from "../../../api";
import { commentLocation, filterComments, latestActivityDay, plural, splitPath } from "./panelModel";

const hour = (y: number, m: number, d: number, h: number) => new Date(y, m, d, h).toISOString();

describe("latestActivityDay", () => {
  const now = new Date(2026, 9, 26, 18).getTime();

  it("buckets the most recent active local day by hour", () => {
    const day = latestActivityDay([
      { hour: hour(2026, 9, 26, 9), buckets: [], total: 4 },
      { hour: hour(2026, 9, 26, 14), buckets: [], total: 10 },
      { hour: hour(2026, 9, 25, 22), buckets: [], total: 7 },
    ], now);
    expect(day?.label).toBe("Today");
    expect(day?.hours[9]).toBe(4);
    expect(day?.hours[14]).toBe(10);
    expect(day?.hours[22]).toBe(0);
    expect(day?.total).toBe(14);
    expect(day?.peak).toBe(10);
  });

  it("names yesterday and older days, and ignores empty hours", () => {
    expect(latestActivityDay([{ hour: hour(2026, 9, 25, 22), buckets: [], total: 2 }, { hour: hour(2026, 9, 26, 8), buckets: [], total: 0 }], now)?.label).toBe("Yesterday");
    expect(latestActivityDay([{ hour: hour(2026, 9, 20, 10), buckets: [], total: 2 }], now)?.label).toBe("Oct 20");
    expect(latestActivityDay([{ hour: hour(2026, 9, 26, 8), buckets: [], total: 0 }], now)).toBeNull();
    expect(latestActivityDay([], now)).toBeNull();
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
