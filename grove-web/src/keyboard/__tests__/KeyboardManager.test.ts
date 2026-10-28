import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { KeyboardManagerImpl } from "../KeyboardManager";
import { CommandRegistryImpl } from "../CommandRegistry";
import { ContextKeyServiceImpl } from "../ContextKeyService";
import { UserKeymapStoreImpl } from "../userKeymapStore";

// The KeyboardManager singleton reaches into the module-level singletons
// of CommandRegistry / ContextKeyService / userKeymapStore. To get a
// clean slate per test we reset their state via the imported singletons.
import { commandRegistry } from "../CommandRegistry";
import { contextKeyService } from "../ContextKeyService";
import { userKeymapStore } from "../userKeymapStore";

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
    commandRegistry._resetAll();
    userKeymapStore.reset();
    contextKeyService._resetAll();
    mgr = new KeyboardManagerImpl();
  });

  afterEach(() => {
    mgr.detach();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });

  it("global command triggers without scope active", () => {
    const handler = vi.fn();
    commandRegistry.contribute(
      { id: "g", name: "g", category: "t", defaultBindings: [{ key: "g" }] },
      handler,
    );
    dispatchKey("g");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("scoped command only triggers when its scope is active", () => {
    const handler = vi.fn();
    commandRegistry.contribute(
      { id: "j", name: "j", category: "t", defaultBindings: [{ key: "j" }], scope: "list" },
      handler,
    );
    dispatchKey("j");
    expect(handler).not.toHaveBeenCalled();

    const dispose = mgr.pushScope("list");
    dispatchKey("j");
    expect(handler).toHaveBeenCalledOnce();

    dispose();
    dispatchKey("j");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("scope stack top wins for same key", () => {
    const outer = vi.fn();
    const inner = vi.fn();
    commandRegistry.contribute(
      { id: "out", name: "out", category: "t", defaultBindings: [{ key: "Escape" }], scope: "preview" },
      outer,
    );
    commandRegistry.contribute(
      { id: "in", name: "in", category: "t", defaultBindings: [{ key: "Escape" }], scope: "preview.modal" },
      inner,
    );

    mgr.pushScope("preview");
    mgr.pushScope("preview.modal");

    dispatchKey("Escape");
    expect(inner).toHaveBeenCalledOnce();
    expect(outer).not.toHaveBeenCalled();
  });

  it("lets Monaco close its visible find widget before the workspace", () => {
    const handler = vi.fn();
    commandRegistry.contribute(
      { id: "close", name: "close", category: "t", defaultBindings: [{ key: "Escape" }], scope: "workspace" },
      handler,
    );
    mgr.pushScope("workspace");
    const editor = document.createElement("div");
    editor.className = "monaco-editor";
    editor.innerHTML = '<div class="find-widget visible"><input></div>';
    document.body.appendChild(editor);
    const input = editor.querySelector("input")!;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(handler).not.toHaveBeenCalled();
    editor.querySelector(".find-widget")!.classList.remove("visible");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(handler).toHaveBeenCalledOnce();
    editor.remove();
  });

  it("falls through to next scope when top has no match", () => {
    const outer = vi.fn();
    commandRegistry.contribute(
      { id: "out", name: "out", category: "t", defaultBindings: [{ key: "Escape" }], scope: "preview" },
      outer,
    );

    mgr.pushScope("preview");
    mgr.pushScope("preview.modal");

    dispatchKey("Escape");
    expect(outer).toHaveBeenCalledOnce();
  });

  it("enabled() false skips command and falls through", () => {
    const top = vi.fn();
    const bottom = vi.fn();
    commandRegistry.contribute(
      { id: "top", name: "top", category: "t", defaultBindings: [{ key: "f" }], scope: "top" },
      top,
      () => false,
    );
    commandRegistry.contribute(
      { id: "bot", name: "bot", category: "t", defaultBindings: [{ key: "f" }], scope: "bottom" },
      bottom,
    );

    mgr.pushScope("bottom");
    mgr.pushScope("top");

    dispatchKey("f");
    expect(top).not.toHaveBeenCalled();
    expect(bottom).toHaveBeenCalledOnce();
  });

  it("global fallback after all scopes", () => {
    const scoped = vi.fn();
    const global = vi.fn();
    commandRegistry.contribute(
      { id: "s", name: "s", category: "t", defaultBindings: [{ key: "g" }], scope: "x" },
      scoped,
    );
    commandRegistry.contribute(
      { id: "g", name: "g", category: "t", defaultBindings: [{ key: "g" }] },
      global,
    );

    mgr.pushScope("y");
    dispatchKey("g");
    expect(scoped).not.toHaveBeenCalled();
    expect(global).toHaveBeenCalledOnce();
  });

  it("scope ref-counting: pushed twice → both must dispose", () => {
    const handler = vi.fn();
    commandRegistry.contribute(
      { id: "x", name: "x", category: "t", defaultBindings: [{ key: "x" }], scope: "s" },
      handler,
    );

    const d1 = mgr.pushScope("s");
    const d2 = mgr.pushScope("s");

    d1();
    dispatchKey("x");
    expect(handler).toHaveBeenCalledOnce();

    d2();
    dispatchKey("x");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("ignores defaultPrevented", () => {
    const handler = vi.fn();
    commandRegistry.contribute(
      { id: "x", name: "x", category: "t", defaultBindings: [{ key: "x" }] },
      handler,
    );
    const event = new KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true });
    event.preventDefault();
    window.dispatchEvent(event);
    expect(handler).not.toHaveBeenCalled();
  });

  it("ignores IME composition", () => {
    const handler = vi.fn();
    commandRegistry.contribute(
      { id: "x", name: "x", category: "t", defaultBindings: [{ key: "x" }] },
      handler,
    );
    const event = new KeyboardEvent("keydown", {
      key: "x", isComposing: true, bubbles: true, cancelable: true,
    });
    window.dispatchEvent(event);
    expect(handler).not.toHaveBeenCalled();
  });

  it("preventDefault default true", () => {
    commandRegistry.contribute(
      { id: "x", name: "x", category: "t", defaultBindings: [{ key: "x" }] },
      () => {},
    );
    const event = dispatchKey("x");
    expect(event.defaultPrevented).toBe(true);
  });

  it("preventDefault: false respected", () => {
    commandRegistry.contribute(
      { id: "x", name: "x", category: "t", defaultBindings: [{ key: "x" }], preventDefault: false },
      () => {},
    );
    const event = dispatchKey("x");
    expect(event.defaultPrevented).toBe(false);
  });

  it("data-hotkeys-dialog does NOT suppress (regression)", () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("data-hotkeys-dialog", "true");
    document.body.appendChild(dialog);

    const handler = vi.fn();
    commandRegistry.contribute(
      { id: "esc", name: "esc", category: "t", defaultBindings: [{ key: "Escape" }], scope: "dialog" },
      handler,
    );
    mgr.pushScope("dialog");
    dispatchKey("Escape");
    expect(handler).toHaveBeenCalledOnce();

    document.body.removeChild(dialog);
  });
});

describe("KeyboardManager — when expression", () => {
  let mgr: KeyboardManagerImpl;

  beforeEach(() => {
    commandRegistry._resetAll();
    userKeymapStore.reset();
    contextKeyService._resetAll();
    mgr = new KeyboardManagerImpl();
  });

  afterEach(() => {
    mgr.detach();
  });

  it("command with when=true context fires", () => {
    contextKeyService.createKey("canOperate", false).set(true);
    const handler = vi.fn();
    commandRegistry.contribute(
      { id: "c", name: "c", category: "t", defaultBindings: [{ key: "c" }], defaultWhen: "canOperate" },
      handler,
    );
    dispatchKey("c");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("command with when=false context doesn't fire", () => {
    contextKeyService.createKey("canOperate", false).set(false);
    const handler = vi.fn();
    commandRegistry.contribute(
      { id: "c", name: "c", category: "t", defaultBindings: [{ key: "c" }], defaultWhen: "canOperate" },
      handler,
    );
    dispatchKey("c");
    expect(handler).not.toHaveBeenCalled();
  });

  it("binding-level when overrides command default", () => {
    contextKeyService.createKey("a", false).set(true);
    contextKeyService.createKey("b", false).set(false);
    const handler = vi.fn();
    commandRegistry.contribute(
      {
        id: "c",
        name: "c",
        category: "t",
        defaultBindings: [{ key: "c", when: "b" }],
        defaultWhen: "a",
      },
      handler,
    );
    dispatchKey("c");
    expect(handler).not.toHaveBeenCalled(); // binding when=b is false
  });

  it("complex when expression with parens", () => {
    contextKeyService.createKey("a", false).set(true);
    contextKeyService.createKey("b", false).set(false);
    contextKeyService.createKey("c", false).set(true);
    const handler = vi.fn();
    commandRegistry.contribute(
      {
        id: "x",
        name: "x",
        category: "t",
        defaultBindings: [{ key: "x" }],
        defaultWhen: "a && (b || c)",
      },
      handler,
    );
    dispatchKey("x");
    expect(handler).toHaveBeenCalledOnce();
  });
});

describe("KeyboardManager — user keymap overrides", () => {
  let mgr: KeyboardManagerImpl;

  beforeEach(() => {
    commandRegistry._resetAll();
    userKeymapStore.reset();
    contextKeyService._resetAll();
    mgr = new KeyboardManagerImpl();
  });

  afterEach(() => {
    mgr.detach();
  });

  it("override replaces default key", () => {
    const handler = vi.fn();
    commandRegistry.contribute(
      { id: "j", name: "j", category: "t", defaultBindings: [{ key: "j" }] },
      handler,
    );
    userKeymapStore.setOverrides("j", [{ command_id: "j", key: "n" }]);

    dispatchKey("j");
    expect(handler).not.toHaveBeenCalled(); // default key disabled

    dispatchKey("n");
    expect(handler).toHaveBeenCalledOnce(); // user override active
  });

  it("disabled command never fires", () => {
    const handler = vi.fn();
    commandRegistry.contribute(
      { id: "j", name: "j", category: "t", defaultBindings: [{ key: "j" }] },
      handler,
    );
    userKeymapStore.setDisabled("j", true);
    dispatchKey("j");
    expect(handler).not.toHaveBeenCalled();
  });

  it("re-enable command resumes default binding", () => {
    const handler = vi.fn();
    commandRegistry.contribute(
      { id: "j", name: "j", category: "t", defaultBindings: [{ key: "j" }] },
      handler,
    );
    userKeymapStore.setDisabled("j", true);
    userKeymapStore.setDisabled("j", false);
    dispatchKey("j");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("override with custom scope routes to that scope", () => {
    const handler = vi.fn();
    commandRegistry.contribute(
      { id: "j", name: "j", category: "t", defaultBindings: [{ key: "j" }], scope: "list" },
      handler,
    );
    userKeymapStore.setOverrides("j", [
      {
        command_id: "j",
        key: "j",
        scope: "diff",
      },
    ]);

    mgr.pushScope("list");
    dispatchKey("j");
    expect(handler).not.toHaveBeenCalled(); // moved out of list scope

    mgr.pushScope("diff");
    dispatchKey("j");
    expect(handler).toHaveBeenCalledOnce();
  });
});

describe("KeyboardManager — text input suppression", () => {
  let mgr: KeyboardManagerImpl;
  let input: HTMLInputElement;
  let textarea: HTMLTextAreaElement;

  beforeEach(() => {
    commandRegistry._resetAll();
    userKeymapStore.reset();
    contextKeyService._resetAll();
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

  it("alpha key suppressed in input", () => {
    const handler = vi.fn();
    commandRegistry.contribute(
      { id: "j", name: "j", category: "t", defaultBindings: [{ key: "j" }] },
      handler,
    );
    input.focus();
    dispatchKey("j");
    expect(handler).not.toHaveBeenCalled();
  });

  it("Escape still works in input (not alpha)", () => {
    const handler = vi.fn();
    commandRegistry.contribute(
      { id: "esc", name: "esc", category: "t", defaultBindings: [{ key: "Escape" }] },
      handler,
    );
    input.focus();
    dispatchKey("Escape");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("alpha keys suppressed in textarea (so user can type)", () => {
    const handler = vi.fn();
    commandRegistry.contribute(
      { id: "a", name: "a", category: "t", defaultBindings: [{ key: "a" }] },
      handler,
    );
    textarea.focus();
    dispatchKey("a");
    expect(handler).not.toHaveBeenCalled();
  });

  it("non-alpha keys (Escape, Tab, …) NOT suppressed in textarea", () => {
    // Escape, Arrow keys etc. aren't text input — they're control keys,
    // so commands bound to them should still fire even with text focus
    // (e.g. dialog Escape-to-close).
    const handler = vi.fn();
    commandRegistry.contribute(
      { id: "esc", name: "esc", category: "t", defaultBindings: [{ key: "Escape" }] },
      handler,
    );
    textarea.focus();
    dispatchKey("Escape");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("unmodified navigation and editing control keys (ArrowUp, ArrowDown, Backspace, Delete) are suppressed in textarea", () => {
    const arrowUpHandler = vi.fn();
    const arrowDownHandler = vi.fn();
    const backspaceHandler = vi.fn();
    const deleteHandler = vi.fn();

    commandRegistry.contribute(
      { id: "arrowUp", name: "arrowUp", category: "t", defaultBindings: [{ key: "ArrowUp" }] },
      arrowUpHandler,
    );
    commandRegistry.contribute(
      { id: "arrowDown", name: "arrowDown", category: "t", defaultBindings: [{ key: "ArrowDown" }] },
      arrowDownHandler,
    );
    commandRegistry.contribute(
      { id: "backspace", name: "backspace", category: "t", defaultBindings: [{ key: "Backspace" }] },
      backspaceHandler,
    );
    commandRegistry.contribute(
      { id: "delete", name: "delete", category: "t", defaultBindings: [{ key: "Delete" }] },
      deleteHandler,
    );

    textarea.focus();
    dispatchKey("ArrowUp");
    dispatchKey("ArrowDown");
    dispatchKey("Backspace");
    dispatchKey("Delete");

    expect(arrowUpHandler).not.toHaveBeenCalled();
    expect(arrowDownHandler).not.toHaveBeenCalled();
    expect(backspaceHandler).not.toHaveBeenCalled();
    expect(deleteHandler).not.toHaveBeenCalled();
  });

  it("bare Enter suppressed in textarea (dialog field doesn't leak Enter to page scopes)", () => {
    // Regression: with the New Task dialog open, pressing Enter in the
    // notes textarea fell through the `dialog.newTask` scope and fired
    // `task.open` (bare Enter, tasks scope), entering the selected
    // task's workspace behind the dialog. Enter is text input — it must
    // be suppressed like alpha keys unless the command opts in.
    const handler = vi.fn();
    commandRegistry.contribute(
      { id: "task.open", name: "open", category: "t", defaultBindings: [{ key: "Enter" }], scope: "tasks" },
      handler,
    );
    mgr.pushScope("tasks");
    textarea.focus();
    dispatchKey("Enter");
    expect(handler).not.toHaveBeenCalled();

    // Focus outside any text field (e.g. task list) → still fires.
    (document.activeElement as HTMLElement).blur();
    dispatchKey("Enter");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("Enter fires in textarea with passThroughTextInput (chat.send / palette execute)", () => {
    const handler = vi.fn();
    commandRegistry.contribute(
      {
        id: "chat.send",
        name: "send",
        category: "t",
        defaultBindings: [{ key: "Enter" }],
        passThroughTextInput: true,
      },
      handler,
    );
    textarea.focus();
    dispatchKey("Enter");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("passThroughTextInput overrides suppression", () => {
    const handler = vi.fn();
    commandRegistry.contribute(
      {
        id: "palette",
        name: "palette",
        category: "t",
        defaultBindings: [{ key: "Meta+k" }],
        passThroughTextInput: true,
      },
      handler,
    );
    textarea.focus();
    dispatchKey("k", { meta: true });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("dispatches to the enabled owner when keep-alive components share a command", () => {
    const visible = vi.fn();
    const hidden = vi.fn();
    commandRegistry.setStaticCatalog([
      {
        id: "chat.send",
        name: "send",
        category: "t",
        defaultBindings: [{ key: "Enter" }],
        scope: "workspace",
        passThroughTextInput: true,
      },
    ]);
    commandRegistry.registerHandler("chat.send", visible, () => true);
    commandRegistry.registerHandler("chat.send", hidden, () => false);
    mgr.pushScope("workspace");

    textarea.focus();
    dispatchKey("Enter");

    expect(visible).toHaveBeenCalledOnce();
    expect(hidden).not.toHaveBeenCalled();
  });

  it("modifier combos always pass through in textarea", () => {
    // Modifier combos (Cmd+F, Ctrl+S, …) are never plain text input,
    // so they should reach the command catalog regardless of focus.
    // Users who bind Cmd+A etc. accept overriding browser defaults.
    const handler = vi.fn();
    commandRegistry.contribute(
      { id: "find", name: "find", category: "t", defaultBindings: [{ key: "Meta+f" }] },
      handler,
    );
    textarea.focus();
    dispatchKey("f", { meta: true });
    expect(handler).toHaveBeenCalledOnce();
  });
});

describe("KeyboardManager — Mod alias cross-platform", () => {
  let mgr: KeyboardManagerImpl;

  beforeEach(() => {
    commandRegistry._resetAll();
    userKeymapStore.reset();
    contextKeyService._resetAll();
    mgr = new KeyboardManagerImpl();
  });

  afterEach(() => {
    mgr.detach();
  });

  it("Mod+f fires on Meta+f (mac)", () => {
    const handler = vi.fn();
    commandRegistry.contribute(
      { id: "f", name: "f", category: "t", defaultBindings: [{ key: "Mod+f" }] },
      handler,
    );
    dispatchKey("f", { meta: true });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("Mod+f fires on Ctrl+f (linux/win)", () => {
    const handler = vi.fn();
    commandRegistry.contribute(
      { id: "f", name: "f", category: "t", defaultBindings: [{ key: "Mod+f" }] },
      handler,
    );
    dispatchKey("f", { ctrl: true });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("Mod+f doesn't fire on bare f", () => {
    const handler = vi.fn();
    commandRegistry.contribute(
      { id: "f", name: "f", category: "t", defaultBindings: [{ key: "Mod+f" }] },
      handler,
    );
    dispatchKey("f");
    expect(handler).not.toHaveBeenCalled();
  });
});

// Pull in unused imports so TS doesn't whinge in strict mode
void CommandRegistryImpl;
void ContextKeyServiceImpl;
void UserKeymapStoreImpl;
