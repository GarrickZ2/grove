import { describe, expect, it } from "vitest";
import { linksFrom } from "./useProjectLinks";

describe("linksFrom", () => {
  it("accepts the linked-projects response", () => {
    const item = { id: "a", name: "A", exists: true, project_type: "repo", is_git_repo: true, review_task_id: null };
    expect(linksFrom({ linked_projects: [item] })).toEqual([item]);
    expect(linksFrom({ linked_projects: [] })).toEqual([]);
  });

  it("treats anything else as unavailable (older server without the route)", () => {
    expect(linksFrom("<!doctype html>")).toBeNull();
    expect(linksFrom(null)).toBeNull();
    expect(linksFrom({})).toBeNull();
  });
});
