import { describe, expect, it } from "vitest";
import type { ArtifactFile } from "../../../api";
import {
  artifactDragFiles, arrangeEntries, breadcrumbTrail, defaultSource, existingFolder, fileCount, gridColumns, indexFolders, kindCounts,
  scopeEntries, totalsFor, windowRange,
} from "./artifactsView";

function file(path: string, size = 10, modified = "2026-10-01T00:00:00Z", directory = "output"): ArtifactFile {
  return { name: path.split("/").pop()!, path, size, modified_at: modified, is_dir: false, directory };
}
function dir(path: string, directory = "output"): ArtifactFile {
  return { name: path.split("/").pop()!, path, size: 0, modified_at: "2026-09-01T00:00:00Z", is_dir: true, directory };
}

const TREE: ArtifactFile[] = [
  dir("site"),
  dir("site/images"),
  file("site/images/hero.png", 2000, "2026-10-03T00:00:00Z"),
  file("site/index.html", 300, "2026-10-02T00:00:00Z"),
  file("report.pdf", 1400, "2026-10-04T00:00:00Z"),
  file("notes.md", 20, "2026-10-01T00:00:00Z"),
];

describe("folder index", () => {
  it("totals every folder recursively", () => {
    const index = indexFolders(TREE);
    expect(totalsFor(index, "")).toMatchObject({ files: 4, bytes: 3720 });
    expect(totalsFor(index, "site")).toMatchObject({ files: 2, bytes: 2300 });
    expect(totalsFor(index, "site/images").files).toBe(1);
    expect(totalsFor(index, "site").latest).toBe(new Date("2026-10-03T00:00:00Z").getTime());
    expect(totalsFor(index, "missing").files).toBe(0);
  });

  it("falls back to the deepest folder that still exists", () => {
    const index = indexFolders(TREE);
    expect(existingFolder("site/images", index)).toBe("site/images");
    expect(existingFolder("site/gone/deeper", index)).toBe("site");
    expect(existingFolder("gone", index)).toBe("");
  });
});

describe("scope, filter and sort", () => {
  it("lists direct children without a query", () => {
    expect(scopeEntries(TREE, "", "").map((e) => e.file.path)).toEqual(["site", "report.pdf", "notes.md"]);
    expect(scopeEntries(TREE, "site", "").map((e) => e.rel)).toEqual(["images", "index.html"]);
  });

  it("searches the whole subtree with a query, keeping the relative path", () => {
    const hits = scopeEntries(TREE, "", "HERO");
    expect(hits.map((e) => e.rel)).toEqual(["site/images/hero.png"]);
    expect(scopeEntries(TREE, "site", "e").map((e) => e.rel)).toEqual(["images", "images/hero.png", "index.html"]);
    expect(scopeEntries(TREE, "site/images", "report")).toEqual([]);
  });

  it("counts kinds among files only and filters by kind", () => {
    const scope = scopeEntries(TREE, "", "");
    expect(kindCounts(scope)).toEqual([{ kind: "doc", count: 2 }]);
    const index = indexFolders(TREE);
    expect(arrangeEntries(scope, { kind: "doc", sort: "name" }, index).map((e) => e.file.name)).toEqual(["notes.md", "report.pdf"]);
  });

  it("keeps folders first, then sorts by recency, name or size", () => {
    const index = indexFolders(TREE);
    const scope = scopeEntries(TREE, "", "");
    expect(arrangeEntries(scope, { kind: "all", sort: "recent" }, index).map((e) => e.file.name)).toEqual(["site", "report.pdf", "notes.md"]);
    expect(arrangeEntries(scope, { kind: "all", sort: "name" }, index).map((e) => e.file.name)).toEqual(["site", "notes.md", "report.pdf"]);
    expect(arrangeEntries(scope, { kind: "all", sort: "size" }, index).map((e) => e.file.name)).toEqual(["site", "report.pdf", "notes.md"]);
  });

  it("orders numbered names naturally", () => {
    const frames = [file("frame-10.png"), file("frame-2.png"), file("frame-1.png")];
    const index = indexFolders(frames);
    expect(arrangeEntries(scopeEntries(frames, "", ""), { kind: "all", sort: "name" }, index).map((e) => e.file.name))
      .toEqual(["frame-1.png", "frame-2.png", "frame-10.png"]);
  });

  it("handles a folder of 20,000 files", () => {
    const many = [dir("frames"), ...Array.from({ length: 20_000 }, (_, i) => file(`frames/frame-${i}.png`, 1))];
    const index = indexFolders(many);
    expect(totalsFor(index, "").files).toBe(20_000);
    const scope = scopeEntries(many, "frames", "");
    expect(scope).toHaveLength(20_000);
    const arranged = arrangeEntries(scope, { kind: "all", sort: "name" }, index);
    expect(arranged[0].file.name).toBe("frame-0.png");
    expect(arranged[19_999].file.name).toBe("frame-19999.png");
    expect(scopeEntries(many, "", "frame-1999")).toHaveLength(11);
  });
});

describe("windowing", () => {
  it("mounts the visible rows plus overscan", () => {
    expect(windowRange(0, 440, 44, 10_000, 6)).toEqual({ start: 0, end: 16 });
    expect(windowRange(44 * 500, 440, 44, 10_000, 6)).toEqual({ start: 494, end: 516 });
  });

  it("clamps at the end and for empty lists", () => {
    expect(windowRange(44 * 9_998, 440, 44, 10_000, 6)).toEqual({ start: 9_992, end: 10_000 });
    expect(windowRange(0, 440, 44, 0, 6)).toEqual({ start: 0, end: 0 });
    expect(windowRange(-50, 440, 44, 3, 6)).toEqual({ start: 0, end: 3 });
  });

  it("fits at least two grid columns", () => {
    expect(gridColumns(0, 132, 10)).toBe(2);
    expect(gridColumns(296, 132, 10)).toBe(2);
    expect(gridColumns(696, 132, 10)).toBe(4);
  });
});

describe("misc", () => {
  it("opens on output when the agent wrote files, else on uploads", () => {
    expect(defaultSource({ input: [], output: [] })).toBe("output");
    expect(defaultSource({ input: [file("a.png", 1, undefined, "input")], output: [dir("empty")] })).toBe("input");
    expect(defaultSource({ input: [file("a.png", 1, undefined, "input")], output: [file("b.md")] })).toBe("output");
  });

  it("builds the breadcrumb trail and counts files", () => {
    expect(breadcrumbTrail("a/b/c")).toEqual([{ name: "a", path: "a" }, { name: "b", path: "a/b" }, { name: "c", path: "a/b/c" }]);
    expect(breadcrumbTrail("")).toEqual([]);
    expect(fileCount(TREE)).toBe(4);
  });
});

describe("artifactDragFiles", () => {
  const a = file("a.md");
  const b = file("b.png");
  const folder = dir("assets");
  const selection = (files: ArtifactFile[]) => ({ has: (path: string) => files.some((f) => f.path === path), files });

  it("drags the whole selection, in order, when the row is part of it", () => {
    expect(artifactDragFiles(b, selection([a, folder, b]))).toEqual([a, b]);
  });

  it("drags just the row when it is not selected", () => {
    expect(artifactDragFiles(a, selection([b]))).toEqual([a]);
    expect(artifactDragFiles(a, selection([]))).toEqual([a]);
  });
});
