import { describe, expect, it } from "vitest";
import type { ResourceFile, WorkDirectoryEntry } from "../../api";
import {
  appendTemplate, breadcrumbTrail, canMoveInto, countInstructionLines, filterFiles,
  joinPath, mergeResourceItems, parentPath, resourceStats,
} from "./resourceModel";

const file = (name: string, extra: Partial<ResourceFile> = {}): ResourceFile => ({
  name, path: name, size: 10, modified_at: "2026-10-01T00:00:00Z", is_dir: false, ...extra,
});
const dir = (name: string): ResourceFile => file(name, { is_dir: true, size: 0 });
const link = (name: string): WorkDirectoryEntry => ({ name, target_path: `/x/${name}`, exists: true });

describe("resourceModel", () => {
  it("counts non-empty instruction lines", () => {
    expect(countInstructionLines("")).toBe(0);
    expect(countInstructionLines("  \n")).toBe(0);
    expect(countInstructionLines("# A\n\n- b\n  \n- c")).toBe(3);
  });

  it("appends a template after a blank line, or replaces empty text", () => {
    expect(appendTemplate("  ", "# T")).toBe("# T");
    expect(appendTemplate("# A\n\n", "# T")).toBe("# A\n\n# T");
  });

  it("joins and splits folder paths", () => {
    expect(joinPath("", "a")).toBe("a");
    expect(joinPath("a/b", "c")).toBe("a/b/c");
    expect(parentPath("a/b/c")).toBe("a/b");
    expect(parentPath("a")).toBe("");
    expect(breadcrumbTrail("")).toEqual([]);
    expect(breadcrumbTrail("brand/logos")).toEqual([{ name: "brand", path: "brand" }, { name: "logos", path: "brand/logos" }]);
  });

  it("refuses moves into the item itself, its subtree, or where it already is", () => {
    expect(canMoveInto("", "a")).toBe(false);
    expect(canMoveInto("a", "a")).toBe(false);
    expect(canMoveInto("a", "a/b")).toBe(false);
    expect(canMoveInto("a/x.png", "a")).toBe(false);
    expect(canMoveInto("a/x.png", "")).toBe(true);
    expect(canMoveInto("x.png", "a")).toBe(true);
    expect(canMoveInto("ab/x.png", "a")).toBe(true);
  });

  it("filters by name and sorts folders first", () => {
    const list = filterFiles([file("b.md"), dir("zeta"), file("a.png"), dir("alpha")], "");
    expect(list.map((f) => f.name)).toEqual(["alpha", "zeta", "a.png", "b.md"]);
    expect(filterFiles([file("Hero.PNG"), file("copy.md")], "hero").map((f) => f.name)).toEqual(["Hero.PNG"]);
  });

  it("merges linked folders with files, folder-like first", () => {
    const items = mergeResourceItems([file("a.md"), dir("brand")], [link("exports")], "");
    expect(items.map((item) => `${item.type}:${item.data.name}`)).toEqual(["file:brand", "workdir:exports", "file:a.md"]);
    expect(mergeResourceItems([file("a.md")], [link("exports")], "exp")).toHaveLength(1);
  });

  it("totals plain files only", () => {
    const stats = resourceStats([
      file("a", { size: 5, modified_at: "2026-10-01T00:00:00Z" }),
      file("b", { size: 7, modified_at: "2026-10-03T00:00:00Z" }),
      file("c", { is_dir: true, size: 100, modified_at: "2026-10-09T00:00:00Z" }),
    ]);
    expect(stats).toEqual({ fileCount: 2, totalBytes: 12, latestUpdate: "2026-10-03T00:00:00Z" });
    expect(resourceStats([]).latestUpdate).toBeNull();
  });
});
