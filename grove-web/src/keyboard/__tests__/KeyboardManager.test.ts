import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { KeyboardManagerImpl } from "../KeyboardManager";

function dispatchKey(
  key: string,
  opts: { meta?: boolean; alt?: boolean; ctrl?: boolean; shift?: boolean } = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    metaKey: opts.meta ?? false,
    altKey: opts.alt ?? false,
    ctrlKey: opts.ctrl ?? false,
    shiftKey: opts.shift ?? false,
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(event);
  return event;
}

describe("KeyboardManager — dispatch", () => {
  let mgr: KeyboardManagerImpl;

  beforeEach(() => {
    mgr = new KeyboardManagerImpl();
  });

  afterEach(() => {
    mgr.detach();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });

  it("global command triggers without scope active", () => {
    const handler = vi.fn();
    mgr.registerCommand({ id: "g", key: "g", handler });
    dispatchKey("g");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("scoped command only triggers when its scope is active", () => {
    const handler = vi.fn();
    mgr.registerCommand({ id: "j", key: "j", scope: "list", handler });

    dispatchKey("j");
    expect(handler).not.toHaveBeenCalled();

    const dispose = mgr.pushScope("list");
    dispatchKey("j");
    expect(handler).toHaveBeenCalledOnce();

    dispose();
    dispatchKey("j");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("scope stack: top wins for same key", () => {
    const outer = vi.fn();
    const inner = vi.fn();
    mgr.registerCommand({ id: "out", key: "Escape", scope: "preview", handler: outer });
    mgr.registerCommand({ id: "in", key: "Escape", scope: "preview.modal", handler: inner });

    mgr.pushScope("preview");
    mgr.pushScope("preview.modal");

    dispatchKey("Escape");
    expect(inner).toHaveBeenCalledOnce();
    expect(outer).not.toHaveBeenCalled();
  });

  it("scope stack: falls through when top has no match for that key", () => {
    const outer = vi.fn();
    mgr.registerCommand({ id: "out", key: "Escape", scope: "preview", handler: outer });

    mgr.pushScope("preview");
    mgr.pushScope("preview.modal");

    dispatchKey("Escape");
    expect(outer).toHaveBeenCalledOnce();
  });

  it("enabled() false skips command, continues to next match", () => {
    const top = vi.fn();
    const bottom = vi.fn();
    mgr.registerCommand({ id: "top", key: "f", scope: "top", enabled: () => false, handler: top });
    mgr.registerCommand({ id: "bot", key: "f", scope: "bottom", handler: bottom });

    mgr.pushScope("bottom");
    mgr.pushScope("top");

    dispatchKey("f");
    expect(top).not.toHaveBeenCalled();
    expect(bottom).toHaveBeenCalledOnce();
  });

  it("global scope acts as final fallback after stack exhausted", () => {
    const scoped = vi.fn();
    const global = vi.fn();
    mgr.registerCommand({ id: "s", key: "g", scope: "x", handler: scoped });
    mgr.registerCommand({ id: "g", key: "g", handler: global });

    mgr.pushScope("y"); // no command registered for "y"
    dispatchKey("g");
    expect(scoped).not.toHaveBeenCalled();
    expect(global).toHaveBeenCalledOnce();
  });

  it("scope ref-counting: pushing same id twice keeps it active until both dispose", () => {
    const handler = vi.fn();
    mgr.registerCommand({ id: "x", key: "x", scope: "s", handler });

    const d1 = mgr.pushScope("s");
    const d2 = mgr.pushScope("s");

    d1();
    dispatchKey("x");
    expect(handler).toHaveBeenCalledOnce();

    d2();
    dispatchKey("x");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("unregister removes the command from dispatch", () => {
    const handler = vi.fn();
    const dispose = mgr.registerCommand({ id: "x", key: "x", handler });
    dispose();
    dispatchKey("x");
    expect(handler).not.toHaveBeenCalled();
  });

  it("ignores events already defaultPrevented by earlier listeners", () => {
    const handler = vi.fn();
    mgr.registerCommand({ id: "x", key: "x", handler });

    const event = new KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true });
    event.preventDefault();
    window.dispatchEvent(event);

    expect(handler).not.toHaveBeenCalled();
  });

  it("ignores IME composition events", () => {
    const handler = vi.fn();
    mgr.registerCommand({ id: "x", key: "x", handler });

    const event = new KeyboardEvent("keydown", {
      key: "x", isComposing: true, bubbles: true, cancelable: true,
    });
    window.dispatchEvent(event);

    expect(handler).not.toHaveBeenCalled();
  });

  it("preventDefault by default", () => {
    mgr.registerCommand({ id: "x", key: "x", handler: () => {} });
    const event = dispatchKey("x");
    expect(event.defaultPrevented).toBe(true);
  });

  it("preventDefault: false respects opt-out", () => {
    mgr.registerCommand({ id: "x", key: "x", preventDefault: false, handler: () => {} });
    const event = dispatchKey("x");
    expect(event.defaultPrevented).toBe(false);
  });

  it("getScopeStack returns top-down view", () => {
    mgr.pushScope("a");
    mgr.pushScope("b");
    mgr.pushScope("c");
    expect(mgr.getScopeStack()).toEqual(["c", "b", "a"]);
  });
});

describe("KeyboardManager — text-input suppression", () => {
  let mgr: KeyboardManagerImpl;
  let input: HTMLInputElement;
  let textarea: HTMLTextAreaElement;

  beforeEach(() => {
    mgr = new KeyboardManagerImpl();
    input = document.createElement("input");
    textarea = document.createElement("textarea");
    document.body.appendChild(input);
    document.body.appendChild(textarea);
  });

  afterEach(() => {
    mgr.detach();
    document.body.removeChild(input);
    document.body.removeChild(textarea);
  });

  it("alpha key suppressed when input focused", () => {
    const handler = vi.fn();
    mgr.registerCommand({ id: "j", key: "j", handler });
    input.focus();
    dispatchKey("j");
    expect(handler).not.toHaveBeenCalled();
  });

  it("Escape still works when input focused (not alpha)", () => {
    const handler = vi.fn();
    mgr.registerCommand({ id: "esc", key: "Escape", handler });
    input.focus();
    dispatchKey("Escape");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("all keys suppressed when textarea focused", () => {
    const escHandler = vi.fn();
    mgr.registerCommand({ id: "esc", key: "Escape", handler: escHandler });
    textarea.focus();
    dispatchKey("Escape");
    expect(escHandler).not.toHaveBeenCalled();
  });

  it("APP_OWNED_META_KEYS (Cmd+K) bypasses textarea suppression", () => {
    const handler = vi.fn();
    mgr.registerCommand({ id: "palette", key: "Meta+k", handler });
    textarea.focus();
    dispatchKey("k", { meta: true });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("non-app-owned meta combo (Cmd+F) suppressed in textarea", () => {
    const handler = vi.fn();
    mgr.registerCommand({ id: "find", key: "Meta+f", handler });
    textarea.focus();
    dispatchKey("f", { meta: true });
    expect(handler).not.toHaveBeenCalled();
  });

  it("passThroughTextInput lets command fire in textarea", () => {
    const handler = vi.fn();
    mgr.registerCommand({
      id: "custom", key: "Meta+f", passThroughTextInput: true, handler,
    });
    textarea.focus();
    dispatchKey("f", { meta: true });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("[data-hotkeys-dialog] does NOT suppress dispatch (regression: PoC fix)", () => {
    // Old useHotkeys treats this attribute as 'swallow all'. KeyboardManager
    // intentionally does not — scoped commands should still fire inside
    // dialogs that opt into the legacy attribute for the old system.
    const dialog = document.createElement("div");
    dialog.setAttribute("data-hotkeys-dialog", "true");
    document.body.appendChild(dialog);

    const handler = vi.fn();
    mgr.registerCommand({ id: "esc", key: "Escape", scope: "dialog", handler });
    mgr.pushScope("dialog");

    dispatchKey("Escape");
    expect(handler).toHaveBeenCalledOnce();

    document.body.removeChild(dialog);
  });
});
