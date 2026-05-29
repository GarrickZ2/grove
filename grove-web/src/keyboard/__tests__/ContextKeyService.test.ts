import { describe, it, expect, beforeEach, vi } from "vitest";
import { ContextKeyServiceImpl } from "../ContextKeyService";

describe("ContextKeyService", () => {
  let svc: ContextKeyServiceImpl;

  beforeEach(() => {
    svc = new ContextKeyServiceImpl();
  });

  it("createKey returns a handle with set/get/reset", () => {
    const k = svc.createKey<boolean>("focus", false);
    expect(k.get()).toBe(false);
    k.set(true);
    expect(k.get()).toBe(true);
    k.reset();
    expect(k.get()).toBe(false);
  });

  it("createKey is idempotent — same name returns matching value", () => {
    const k1 = svc.createKey<boolean>("focus", false);
    k1.set(true);
    const k2 = svc.createKey<boolean>("focus", false);
    expect(k2.get()).toBe(true);
  });

  it("getSnapshot returns plain object of all values", () => {
    svc.createKey("a", true);
    svc.createKey("b", false);
    expect(svc.getSnapshot()).toEqual({ a: true, b: false });
  });

  it("subscribe receives changed keys", () => {
    const listener = vi.fn();
    svc.subscribe(listener);
    const k = svc.createKey<boolean>("x", false);
    k.set(true);
    expect(listener).toHaveBeenCalledWith(new Set(["x"]));
  });

  it("subscribe NOT called when value unchanged", () => {
    const k = svc.createKey<boolean>("x", false);
    const listener = vi.fn();
    svc.subscribe(listener);
    k.set(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it("unsubscribe stops notifications", () => {
    const listener = vi.fn();
    const dispose = svc.subscribe(listener);
    dispose();
    const k = svc.createKey<boolean>("x", false);
    k.set(true);
    expect(listener).not.toHaveBeenCalled();
  });

  it("supports typed (non-boolean) keys via generic", () => {
    const k = svc.createKey<string>("editorLang", "");
    k.set("typescript");
    expect(k.get()).toBe("typescript");
    expect(svc.getSnapshot()).toEqual({ editorLang: "typescript" });
  });

  it("listener throws don't break service", () => {
    svc.subscribe(() => {
      throw new Error("boom");
    });
    const ok = vi.fn();
    svc.subscribe(ok);
    const k = svc.createKey<boolean>("x", false);
    k.set(true);
    expect(ok).toHaveBeenCalled();
  });
});
