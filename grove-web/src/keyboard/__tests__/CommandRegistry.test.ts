import { describe, it, expect, beforeEach, vi } from "vitest";
import { CommandRegistryImpl } from "../CommandRegistry";
import type { CommandDef } from "../types";

const def = (id: string, extra: Partial<CommandDef> = {}): CommandDef => ({
  id,
  name: id,
  category: "test",
  ...extra,
});

describe("CommandRegistry", () => {
  let reg: CommandRegistryImpl;

  beforeEach(() => {
    reg = new CommandRegistryImpl();
  });

  it("setStaticCatalog populates listCommands", () => {
    reg.setStaticCatalog([def("a"), def("b")]);
    expect(reg.listCommands().map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("setStaticCatalog replaces previous catalog", () => {
    reg.setStaticCatalog([def("a")]);
    reg.setStaticCatalog([def("b"), def("c")]);
    expect(reg.listCommands().map((c) => c.id)).toEqual(["b", "c"]);
  });

  it("contribute adds runtime command + handler", () => {
    const h = vi.fn();
    reg.contribute(def("x"), h);
    expect(reg.getCommand("x")?.id).toBe("x");
    expect(reg.invoke("x")).toBe(true);
    expect(h).toHaveBeenCalledOnce();
  });

  it("contribute dispose removes def + handler", () => {
    const h = vi.fn();
    const dispose = reg.contribute(def("x"), h);
    dispose();
    expect(reg.getCommand("x")).toBeUndefined();
    expect(reg.invoke("x")).toBe(false);
  });

  it("registerHandler attaches handler to existing catalog id", () => {
    reg.setStaticCatalog([def("a")]);
    const h = vi.fn();
    reg.registerHandler("a", h);
    expect(reg.invoke("a")).toBe(true);
    expect(h).toHaveBeenCalledOnce();
  });

  it("registerHandler dispose removes handler", () => {
    reg.setStaticCatalog([def("a")]);
    const dispose = reg.registerHandler("a", vi.fn());
    dispose();
    expect(reg.invoke("a")).toBe(false);
  });

  it("invoke returns false when no handler", () => {
    reg.setStaticCatalog([def("a")]);
    expect(reg.invoke("a")).toBe(false);
  });

  it("invoke returns false when enabled() = false", () => {
    reg.setStaticCatalog([def("a")]);
    const h = vi.fn();
    reg.registerHandler("a", h, () => false);
    expect(reg.invoke("a")).toBe(false);
    expect(h).not.toHaveBeenCalled();
  });

  it("invoke passes args to handler", () => {
    const h = vi.fn();
    reg.contribute(def("x"), h);
    reg.invoke("x", { taskId: 42 });
    expect(h).toHaveBeenCalledWith({ taskId: 42 });
  });

  it("contributed commands shadow static (same id)", () => {
    reg.setStaticCatalog([def("x", { name: "Static" })]);
    reg.contribute(def("x", { name: "Dynamic" }), vi.fn());
    expect(reg.getCommand("x")?.name).toBe("Dynamic");
  });

  it("listCommands merges static + contributed deduped", () => {
    reg.setStaticCatalog([def("a"), def("b")]);
    reg.contribute(def("c"), vi.fn());
    reg.contribute(def("a"), vi.fn());
    expect(reg.listCommands().map((c) => c.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("handler throw is caught (logged) and invoke still returns true", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    reg.contribute(def("x"), () => {
      throw new Error("boom");
    });
    expect(reg.invoke("x")).toBe(true);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("async handler rejection is caught", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    reg.contribute(def("x"), async () => {
      throw new Error("async-boom");
    });
    reg.invoke("x");
    // wait microtask
    await Promise.resolve();
    await Promise.resolve();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("subscribe notified on contribute/dispose/setCatalog", () => {
    const listener = vi.fn();
    reg.subscribe(listener);
    reg.setStaticCatalog([def("a")]);
    reg.contribute(def("b"), vi.fn());
    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("unsubscribe stops notifications", () => {
    const listener = vi.fn();
    const dispose = reg.subscribe(listener);
    dispose();
    reg.setStaticCatalog([def("a")]);
    expect(listener).not.toHaveBeenCalled();
  });

  it("getEnabled reflects the registered enabled predicate", () => {
    reg.contribute(def("x"), vi.fn(), () => false);
    expect(reg.getEnabled("x")?.()).toBe(false);
  });

  it("getEnabled is undefined when no handler is registered", () => {
    reg.setStaticCatalog([def("a")]);
    expect(reg.getEnabled("a")).toBeUndefined();
  });

  it("multiple handlers: invoke runs the first enabled one (most-recent first)", () => {
    reg.setStaticCatalog([def("a")]);
    const h1 = vi.fn();
    const h2 = vi.fn();
    // h1 enabled, h2 disabled — newest (h2) is skipped, h1 runs.
    reg.registerHandler("a", h1, () => true);
    reg.registerHandler("a", h2, () => false);
    expect(reg.invoke("a")).toBe(true);
    expect(h2).not.toHaveBeenCalled();
    expect(h1).toHaveBeenCalledOnce();
  });

  it("multiple handlers: getEnabled is true if ANY handler is enabled", () => {
    reg.setStaticCatalog([def("a")]);
    reg.registerHandler("a", vi.fn(), () => false);
    reg.registerHandler("a", vi.fn(), () => true);
    expect(reg.getEnabled("a")?.()).toBe(true);
  });

  it("multiple handlers: disposing one leaves the other intact", () => {
    reg.setStaticCatalog([def("a")]);
    const h1 = vi.fn();
    const h2 = vi.fn();
    reg.registerHandler("a", h1);
    const dispose2 = reg.registerHandler("a", h2);
    dispose2();
    reg.invoke("a");
    expect(h2).not.toHaveBeenCalled();
    expect(h1).toHaveBeenCalledOnce();
  });
});
