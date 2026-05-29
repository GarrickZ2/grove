import { describe, it, expect, beforeEach, vi } from "vitest";
import { UserKeymapStoreImpl } from "../userKeymapStore";

describe("UserKeymapStore", () => {
  let store: UserKeymapStoreImpl;

  beforeEach(() => {
    store = new UserKeymapStoreImpl();
  });

  it("setOverrides stores + getOverrides retrieves", () => {
    store.setOverrides("a", [{ command_id: "a", key: "Mod+x" }]);
    expect(store.getOverrides("a")).toEqual([{ command_id: "a", key: "Mod+x" }]);
  });

  it("setOverrides stores multiple bindings for one command", () => {
    store.setOverrides("a", [
      { command_id: "a", key: "Mod+x" },
      { command_id: "a", key: "Mod+y" },
    ]);
    expect(store.getOverrides("a")?.map((o) => o.key)).toEqual(["Mod+x", "Mod+y"]);
  });

  it("setOverrides with empty array clears the command", () => {
    store.setOverrides("a", [{ command_id: "a", key: "x" }]);
    store.setOverrides("a", []);
    expect(store.getOverrides("a")).toBeUndefined();
  });

  it("removeOverride deletes", () => {
    store.setOverrides("a", [{ command_id: "a", key: "x" }]);
    store.removeOverride("a");
    expect(store.getOverrides("a")).toBeUndefined();
  });

  it("setDisabled marks as disabled", () => {
    store.setDisabled("a", true);
    expect(store.isDisabled("a")).toBe(true);
    store.setDisabled("a", false);
    expect(store.isDisabled("a")).toBe(false);
  });

  it("reset clears everything", () => {
    store.setOverrides("a", [{ command_id: "a", key: "x" }]);
    store.setDisabled("b", true);
    store.reset();
    expect(store.getOverrides("a")).toBeUndefined();
    expect(store.isDisabled("b")).toBe(false);
  });

  it("load bulk-populates and groups multiple bindings by command", () => {
    store.load(
      [
        { command_id: "a", key: "x" },
        { command_id: "a", key: "x2" },
        { command_id: "b", key: "y" },
      ],
      ["c", "d"],
    );
    expect(store.getOverrides("a")?.map((o) => o.key)).toEqual(["x", "x2"]);
    expect(store.getOverrides("b")?.map((o) => o.key)).toEqual(["y"]);
    expect(store.isDisabled("c")).toBe(true);
    expect(store.isDisabled("d")).toBe(true);
  });

  it("load replaces previous state", () => {
    store.setOverrides("old", [{ command_id: "old", key: "z" }]);
    store.load([{ command_id: "new", key: "n" }], []);
    expect(store.getOverrides("old")).toBeUndefined();
    expect(store.getOverrides("new")?.[0]?.key).toBe("n");
  });

  it("getAllOverrides returns the whole map", () => {
    store.setOverrides("a", [{ command_id: "a", key: "x" }]);
    store.setOverrides("b", [{ command_id: "b", key: "y" }]);
    expect(store.getAllOverrides().size).toBe(2);
  });

  it("subscribe notified on mutations", () => {
    const listener = vi.fn();
    store.subscribe(listener);
    store.setOverrides("a", [{ command_id: "a", key: "x" }]);
    store.setDisabled("b", true);
    store.removeOverride("a");
    expect(listener.mock.calls.length).toBe(3);
  });

  it("subscribe NOT notified when no-op", () => {
    const listener = vi.fn();
    store.subscribe(listener);
    store.removeOverride("does-not-exist");
    store.setDisabled("a", false); // not currently disabled
    expect(listener).not.toHaveBeenCalled();
  });

  it("reset on empty store is a no-op (no notification)", () => {
    const listener = vi.fn();
    store.subscribe(listener);
    store.reset();
    expect(listener).not.toHaveBeenCalled();
  });

  it("unsubscribe works", () => {
    const listener = vi.fn();
    const dispose = store.subscribe(listener);
    dispose();
    store.setOverrides("a", [{ command_id: "a", key: "x" }]);
    expect(listener).not.toHaveBeenCalled();
  });
});
