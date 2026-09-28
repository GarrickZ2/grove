import { describe, expect, it } from "vitest";
import { filesystemBasename, filesystemBreadcrumbs, isAbsoluteFilesystemPath, joinFilesystemPath } from "./filesystemPath";
import { compactPath } from "./pathUtils";

describe("server filesystem paths", () => {
  it("accepts absolute Windows, UNC, Unix and home paths", () => {
    expect(isAbsoluteFilesystemPath("C:\\work\\repo")).toBe(true);
    expect(isAbsoluteFilesystemPath("D:/work/repo")).toBe(true);
    expect(isAbsoluteFilesystemPath("\\\\server\\share\\repo")).toBe(true);
    expect(isAbsoluteFilesystemPath("/home/dev/repo")).toBe(true);
    expect(isAbsoluteFilesystemPath("~/repo")).toBe(true);
    expect(isAbsoluteFilesystemPath("C:relative")).toBe(false);
    expect(isAbsoluteFilesystemPath("~someone/repo")).toBe(false);
    expect(isAbsoluteFilesystemPath("repo/subdir")).toBe(false);
  });

  it("keeps Windows separators when deriving and joining paths", () => {
    expect(filesystemBasename("C:\\work\\repo\\")).toBe("repo");
    expect(filesystemBasename("\\\\server\\share\\repo")).toBe("repo");
    expect(joinFilesystemPath("C:\\", "repo")).toBe("C:\\repo");
    expect(joinFilesystemPath("/home/dev/", "repo")).toBe("/home/dev/repo");
  });

  it("preserves the drive or network share in compact labels", () => {
    expect(compactPath("C:\\Users\\dev\\projects\\repo", 24)).toMatch(/^C:\\/);
    expect(compactPath("\\\\server\\share\\projects\\repo", 30)).toMatch(/^\\\\server\\share\\/);
  });

  it("builds navigable Windows and network-share breadcrumbs", () => {
    expect(filesystemBreadcrumbs("C:/Users/dev").map((entry) => entry.path))
      .toEqual(["C:\\", "C:\\Users", "C:\\Users\\dev"]);
    expect(filesystemBreadcrumbs("\\\\server\\share\\repo").map((entry) => entry.path))
      .toEqual(["\\\\server\\share\\", "\\\\server\\share\\repo"]);
    expect(filesystemBreadcrumbs("//server/share/repo").map((entry) => entry.path))
      .toEqual(["\\\\server\\share\\", "\\\\server\\share\\repo"]);
    expect(filesystemBreadcrumbs("/home/dev").map((entry) => entry.path))
      .toEqual(["/", "/home", "/home/dev"]);
  });
});
