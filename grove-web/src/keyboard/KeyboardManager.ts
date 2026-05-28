import type { CommandDef, ParsedKey } from "./types";
import { parseHotkey, matchesHotkey } from "./keyParser";

const GLOBAL_SCOPE = "__global__";

// Meta combos that bypass focus-based suppression. Preserved from the
// pre-refactor useHotkeys.ts so palette / sidebar still work when focus
// is stuck inside Monaco / xterm / textareas in Tauri's WKWebView.
const APP_OWNED_META_KEYS: ReadonlySet<string> = new Set([
  "k", "p", "o",
  "1", "2", "3", "4", "5", "6", "7", "8", "9",
]);

type Suppression = "all" | "alpha" | false;

interface ScopeEntry {
  id: string;
  refCount: number;
}

interface RegisteredCommand {
  def: CommandDef;
  parsed: ParsedKey;
}

function detectSuppression(e: KeyboardEvent): Suppression {
  if (e.metaKey && APP_OWNED_META_KEYS.has(e.key.toLowerCase())) {
    return false;
  }
  const active = document.activeElement;
  if (active?.closest(".xterm")) return "all";
  if (
    active?.closest(".monaco-editor") ||
    active?.closest(".cm-editor") ||
    active?.closest(".CodeMirror")
  ) {
    return "all";
  }
  // NOTE: Intentionally NOT checking [data-hotkeys-dialog] here. The old
  // useHotkeys.ts uses that attribute as a coarse "swallow everything"
  // signal because it has no scope concept. With scope stacks, dialogs
  // declare their own scope via useKeyboardScope — their commands sit at
  // the stack top and win naturally. Checking this attribute would
  // suppress the dialog's own commands too (the very bug it would be
  // trying to prevent for global ones).
  if (
    active instanceof HTMLTextAreaElement ||
    (active as HTMLElement | null)?.isContentEditable
  ) {
    return "all";
  }
  if (active instanceof HTMLInputElement || active instanceof HTMLSelectElement) {
    return "alpha";
  }
  return false;
}

function isAlphaKey(e: KeyboardEvent): boolean {
  return e.key.length === 1 && !e.altKey && !e.ctrlKey && !e.metaKey;
}

export class KeyboardManagerImpl {
  private scopeStack: ScopeEntry[] = [];
  private commands: Map<string, RegisteredCommand[]> = new Map();
  private listenerAttached = false;

  constructor() {
    this.attach();
  }

  private attach(): void {
    if (this.listenerAttached) return;
    if (typeof window === "undefined") return;
    window.addEventListener("keydown", this.handleKeyDown, true);
    this.listenerAttached = true;
  }

  /** Detach window listener. For tests + teardown only. */
  detach(): void {
    if (!this.listenerAttached) return;
    window.removeEventListener("keydown", this.handleKeyDown, true);
    this.listenerAttached = false;
  }

  /** Push a scope onto the stack. Returns a dispose function. */
  pushScope(id: string): () => void {
    const top = this.scopeStack[this.scopeStack.length - 1];
    if (top && top.id === id) {
      top.refCount++;
    } else {
      this.scopeStack.push({ id, refCount: 1 });
    }
    return () => this.popScope(id);
  }

  private popScope(id: string): void {
    // Walk top-down; same id may sit below if a different scope was pushed
    // on top while this one was still mounted.
    for (let i = this.scopeStack.length - 1; i >= 0; i--) {
      const entry = this.scopeStack[i];
      if (entry.id === id) {
        entry.refCount--;
        if (entry.refCount <= 0) this.scopeStack.splice(i, 1);
        return;
      }
    }
  }

  /** Register a command. Returns a dispose function. */
  registerCommand(def: CommandDef): () => void {
    const scope = def.scope ?? GLOBAL_SCOPE;
    const entry: RegisteredCommand = { def, parsed: parseHotkey(def.key) };
    let list = this.commands.get(scope);
    if (!list) {
      list = [];
      this.commands.set(scope, list);
    }
    list.push(entry);
    return () => {
      const current = this.commands.get(scope);
      if (!current) return;
      const idx = current.indexOf(entry);
      if (idx >= 0) current.splice(idx, 1);
      if (current.length === 0) this.commands.delete(scope);
    };
  }

  /** Test/debug helper: returns the current scope stack ids top-down. */
  getScopeStack(): string[] {
    return this.scopeStack.map((e) => e.id).reverse();
  }

  private handleKeyDown = (e: KeyboardEvent): void => {
    if (e.defaultPrevented) return;
    // IME composition (e.g. CJK input) emits keydown with key="Process" or
    // keyCode 229 — never dispatch.
    if (e.isComposing || e.keyCode === 229) return;

    const suppression = detectSuppression(e);

    // Walk stack top-down, then fall back to global scope.
    for (let i = this.scopeStack.length - 1; i >= 0; i--) {
      if (this.tryDispatch(this.scopeStack[i].id, e, suppression)) return;
    }
    this.tryDispatch(GLOBAL_SCOPE, e, suppression);
  };

  private tryDispatch(
    scope: string,
    e: KeyboardEvent,
    suppression: Suppression,
  ): boolean {
    const list = this.commands.get(scope);
    if (!list) return false;
    for (const { def, parsed } of list) {
      if (!matchesHotkey(e, parsed)) continue;

      // Suppression gates — let native input handle the keystroke unless
      // the command explicitly opts into passing through.
      if (!def.passThroughTextInput) {
        if (suppression === "all") continue;
        if (suppression === "alpha" && isAlphaKey(e)) continue;
      }

      if (def.enabled && !def.enabled()) continue;

      if (def.preventDefault !== false) {
        e.preventDefault();
      }
      def.handler();
      return true;
    }
    return false;
  }
}

export const keyboardManager = new KeyboardManagerImpl();
export { GLOBAL_SCOPE, APP_OWNED_META_KEYS };
