import { describe, expect, it } from "vitest";
import { resolveFileReference, resolveRelativeFilePath, type FileLocation } from "./fileLocation";

describe("resolveRelativeFilePath", () => {
  it("resolves dot segments against the containing file", () => {
    expect(resolveRelativeFilePath("reports/daily/readme.md", "../../images/chart.png")).toEqual({
      path: "images/chart.png",
      suffix: "",
    });
  });

  it("preserves traversal above the declared source root for backend resolution", () => {
    expect(resolveRelativeFilePath("readme.md", "../../internal/chart.html")).toEqual({
      path: "../../internal/chart.html",
      suffix: "",
    });
  });

  it("preserves query and fragment suffixes outside the encoded path", () => {
    expect(resolveRelativeFilePath("docs/readme.md", "image.png?v=2#hero")).toEqual({
      path: "docs/image.png",
      suffix: "?v=2#hero",
    });
  });

  it("resolves references from an absolute containing file", () => {
    expect(resolveRelativeFilePath("/workspace/docs/readme.md", "../images/chart.png")).toEqual({
      path: "/workspace/images/chart.png",
      suffix: "",
    });
  });
});

describe("resolveFileReference", () => {
  const cases: Array<[FileLocation, string]> = [
    [
      { projectId: "p", root: { kind: "task", taskId: "t" }, path: "docs/readme.md" },
      "/api/v1/projects/p/tasks/t/files/raw?path=docs%2Fimage.png",
    ],
    [
      { projectId: "p", root: { kind: "project" }, path: "docs/readme.md" },
      "/api/v1/projects/p/files/raw?path=docs%2Fimage.png",
    ],
    [
      { projectId: "p", root: { kind: "resource" }, path: "docs/readme.md" },
      "/api/v1/projects/p/resource/files/raw?path=docs%2Fimage.png",
    ],
  ];

  it.each(cases)("routes %s references through the owning source", (location, expected) => {
    expect(resolveFileReference(location, "image.png")).toBe(expected);
  });

  it("passes external references through", () => {
    const location = cases[0][0];
    expect(resolveFileReference(location, "https://example.com/image.png")).toBe("https://example.com/image.png");
  });

  it("appends reference queries without replacing the endpoint query", () => {
    const location = cases[0][0];
    expect(resolveFileReference(location, "image.png?v=2#hero")).toBe(
      "/api/v1/projects/p/tasks/t/files/raw?path=docs%2Fimage.png&v=2#hero",
    );
  });

  it("routes worktree references outside the git root through file/raw", () => {
    const location: FileLocation = {
      projectId: "p",
      root: { kind: "task", taskId: "_local" },
      path: "section.md",
    };
    expect(resolveFileReference(location, "../../internal/diagram.html")).toBe(
      "/api/v1/projects/p/tasks/_local/files/raw?path=..%2F..%2Finternal%2Fdiagram.html",
    );
  });

  it("routes cross-directory artifact references to the backend authority", () => {
    const location: FileLocation = {
      projectId: "p",
      root: { kind: "task", taskId: "t" },
      path: "output/section.md",
    };
    expect(resolveFileReference(location, "../input/source.png")).toBe(
      "/api/v1/projects/p/tasks/t/files/raw?path=input%2Fsource.png",
    );
  });
});
