import { describe, expect, it } from "vitest";
import type { ArtifactFile } from "../../../../api";
import { getDirectChildren, parentPath, resolvePreviewTarget } from "./artifactsModel";

function file(directory: string, path: string, isDir = false, modified = "2026-10-01T00:00:00Z"): ArtifactFile {
  return { name: path.split("/").pop()!, path, size: 1, modified_at: modified, is_dir: isDir, directory };
}

const INPUT = [file("input", "brief.md")];
const OUTPUT = [
  file("output", "site", true),
  file("output", "site/index.html"),
  file("output", "brief.md"),
];

describe("resolvePreviewTarget", () => {
  it("honours an input/ or output/ prefix", () => {
    expect(resolvePreviewTarget("output/brief.md", INPUT, OUTPUT)?.directory).toBe("output");
    expect(resolvePreviewTarget("input/brief.md", INPUT, OUTPUT)?.directory).toBe("input");
  });

  it("matches nested paths, ./ prefixes and absolute paths through the task dir", () => {
    expect(resolvePreviewTarget("./site/index.html", INPUT, OUTPUT)?.path).toBe("site/index.html");
    expect(resolvePreviewTarget("/tmp/task/output/site/index.html", INPUT, OUTPUT)?.path).toBe("site/index.html");
  });

  it("falls back to the file name and returns null when nothing matches", () => {
    expect(resolvePreviewTarget("somewhere/index.html", INPUT, OUTPUT)?.path).toBe("site/index.html");
    expect(resolvePreviewTarget("missing.txt", INPUT, OUTPUT)).toBeNull();
    expect(resolvePreviewTarget("  ", INPUT, OUTPUT)).toBeNull();
  });

  it("never resolves to a folder", () => {
    expect(resolvePreviewTarget("output/site", INPUT, OUTPUT)).toBeNull();
  });
});

describe("folder helpers", () => {
  it("lists a folder's direct children, folders first then newest", () => {
    const files = [
      file("output", "a.md", false, "2026-10-01T00:00:00Z"),
      file("output", "b.md", false, "2026-10-03T00:00:00Z"),
      file("output", "dir", true),
      file("output", "dir/c.md"),
    ];
    expect(getDirectChildren(files, "").map((f) => f.path)).toEqual(["dir", "b.md", "a.md"]);
    expect(getDirectChildren(files, "/dir/").map((f) => f.path)).toEqual(["dir/c.md"]);
    expect(parentPath("a/b/c")).toBe("a/b");
    expect(parentPath("a")).toBe("");
  });
});
