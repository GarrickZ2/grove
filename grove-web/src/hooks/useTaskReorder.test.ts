import { describe, expect, it } from "vitest";
import { applyTaskOrder, moveTaskId } from "./useTaskReorder";

describe("moveTaskId", () => {
  const ids = ["a", "b", "c", "d"];

  it("drops before or after the anchor", () => {
    expect(moveTaskId(ids, "d", "b", "before")).toEqual(["a", "d", "b", "c"]);
    expect(moveTaskId(ids, "a", "c", "after")).toEqual(["b", "c", "a", "d"]);
    expect(moveTaskId(ids, "a", "d", "after")).toEqual(["b", "c", "d", "a"]);
  });

  it("leaves the order alone for self drops and unknown ids", () => {
    expect(moveTaskId(ids, "b", "b", "after")).toBe(ids);
    expect(moveTaskId(ids, "x", "b", "after")).toBe(ids);
    expect(moveTaskId(ids, "b", "x", "after")).toBe(ids);
  });
});

describe("applyTaskOrder", () => {
  it("orders by the saved ids and puts unknown tasks first", () => {
    const tasks = [{ id: "a" }, { id: "new" }, { id: "b" }, { id: "c" }];
    expect(applyTaskOrder(tasks, ["c", "a", "b"]).map((task) => task.id)).toEqual(["new", "c", "a", "b"]);
  });

  it("ignores saved ids whose task is gone", () => {
    expect(applyTaskOrder([{ id: "a" }, { id: "b" }], ["b", "gone", "a"]).map((task) => task.id)).toEqual(["b", "a"]);
  });
});
