import type { ModifierSides, ParsedKey } from "./types";
import { parseHotkey, matchesHotkey } from "./keyParser";
import { parseWhen, type WhenEvaluator } from "./whenExpression";
import { commandRegistry } from "./CommandRegistry";
import { contextKeyService } from "./ContextKeyService";
import { userKeymapStore } from "./userKeymapStore";
import { effectiveBindings } from "./conflict";

const GLOBAL_SCOPE = "";

type Suppression = "all" | "alpha" | false;

interface ScopeEntry {
  id: string;
  refCount: number;
}

/**
 * Pre-resolved binding ready for fast match. Rebuilt whenever the
 * command registry or user keymap changes.
 */
interface ResolvedBinding {
  commandId: string;
  scope: string;
  parsed: ParsedKey;
  when: WhenEvaluator;
  preventDefault: boolean;
  passThroughTextInput: boolean;
  trigger: "keydown" | "keyup";
  ignoreRepeat: boolean;
}

function detectSuppression(): Suppression {
  const active = document.activeElement;
  // Suppress only unmodified printable keys ("alpha") so the focused
  // text surface (xterm / Monaco / textarea / contenteditable / input)
  // gets to type characters. Modifier combinations (Cmd+Y, Ctrl+Shift+P,
  // …) always reach the catalog — they're never plain text input.
  //
  // Commands that need to fire on a bare alpha key while text input is
  // focused (e.g. `chat.send` on Enter inside the composer) opt in with
  // `passThroughTextInput: true`.
  //
  // NOTE: Intentionally NOT checking [data-hotkeys-dialog]. Dialogs
  // declare their own scope via useKeyboardScope; their commands sit
  // at the stack top and win naturally. Checking this attribute would
  // suppress the dialog's own commands too.
  if (
    active?.closest(".xterm") ||
    active?.closest(".monaco-editor") ||
    active?.closest(".cm-editor") ||
    active?.closest(".CodeMirror") ||
    active instanceof HTMLTextAreaElement ||
    active instanceof HTMLInputElement ||
    active instanceof HTMLSelectElement ||
    (active as HTMLElement | null)?.isContentEditable
  ) {
    return "alpha";
  }
  return false;
}

const TEXT_INPUT_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Backspace",
  "Delete",
  "Insert",
]);

function isAlphaKey(e: KeyboardEvent): boolean {
  if (e.altKey || e.ctrlKey || e.metaKey) return false;
  return e.key.length === 1 || TEXT_INPUT_KEYS.has(e.key);
}

export class KeyboardManagerImpl {
  private scopeStack: ScopeEntry[] = [];
  private resolvedCache: ResolvedBinding[] | null = null;
  private listenerAttached = false;
  private unsubRegistry: (() => void) | null = null;
  private unsubKeymap: (() => void) | null = null;
  // Refcount of "recording" sessions (Shortcut edit modal). While > 0,
  // skip all dispatch so the modal can capture raw keystrokes without
  // commands firing first. Refcounted in case of overlapping modals.
  private suppressCount = 0;
  // Physical side (left/right) each modifier is currently held on. Updated on
  // every keydown/keyup from e.code, cleared on window blur. Lets a binding
  // pin to e.g. left Cmd vs right Cmd.
  private modifierSides: ModifierSides = { meta: null, alt: null, ctrl: null, shift: null };

  constructor() {
    this.attach();
    this.unsubRegistry = commandRegistry.subscribe(() => this.invalidateCache());
    this.unsubKeymap = userKeymapStore.subscribe(() => this.invalidateCache());
  }

  private attach(): void {
    if (this.listenerAttached) return;
    if (typeof window === "undefined") return;
    window.addEventListener("keydown", this.handleKeyDown, true);
    window.addEventListener("keyup", this.handleKeyUp, true);
    window.addEventListener("blur", this.handleBlur);
    this.listenerAttached = true;
  }

  /** Detach window listener + unsubscribe. Test teardown only. */
  detach(): void {
    if (!this.listenerAttached) return;
    window.removeEventListener("keydown", this.handleKeyDown, true);
    window.removeEventListener("keyup", this.handleKeyUp, true);
    window.removeEventListener("blur", this.handleBlur);
    this.listenerAttached = false;
    this.unsubRegistry?.();
    this.unsubKeymap?.();
    this.unsubRegistry = null;
    this.unsubKeymap = null;
  }

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
    for (let i = this.scopeStack.length - 1; i >= 0; i--) {
      const e = this.scopeStack[i];
      if (e.id === id) {
        e.refCount--;
        if (e.refCount <= 0) this.scopeStack.splice(i, 1);
        return;
      }
    }
  }

  /** Test helper. */
  getScopeStack(): string[] {
    return this.scopeStack.map((e) => e.id).reverse();
  }

  /** Test helper — clear scope stack. */
  _resetScopes(): void {
    this.scopeStack = [];
  }

  private invalidateCache(): void {
    this.resolvedCache = null;
  }

  private buildCache(): ResolvedBinding[] {
    const out: ResolvedBinding[] = [];
    const overrides = userKeymapStore.getAllOverrides();
    const disabled = userKeymapStore.getDisabled();

    for (const def of commandRegistry.listCommands()) {
      if (disabled.has(def.id)) continue;
      const override = overrides.get(def.id);
      const bindings = effectiveBindings(def, override);
      if (bindings.length === 0) continue;

      for (const b of bindings) {
        const scope = b.scope ?? def.scope ?? GLOBAL_SCOPE;
        let parsed: ParsedKey;
        try {
          parsed = parseHotkey(b.key);
        } catch {
          continue;
        }
        let whenEval: WhenEvaluator;
        try {
          whenEval = parseWhen(b.when ?? def.defaultWhen);
        } catch {
          // Invalid when (typically user override) — fall back to
          // always-true so the binding still works; the Settings UI
          // surfaces the parse error.
          whenEval = () => true;
        }
        out.push({
          commandId: def.id,
          scope,
          parsed,
          when: whenEval,
          preventDefault: def.preventDefault !== false,
          passThroughTextInput: def.passThroughTextInput === true,
          trigger: def.trigger ?? "keydown",
          ignoreRepeat: def.ignoreRepeat === true,
        });
      }
    }
    return out;
  }

  private getResolved(): ResolvedBinding[] {
    if (this.resolvedCache === null) {
      this.resolvedCache = this.buildCache();
    }
    return this.resolvedCache;
  }

  /** Pause dispatch (Shortcut editor uses this while recording). */
  pushSuppress(): () => void {
    this.suppressCount++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.suppressCount = Math.max(0, this.suppressCount - 1);
    };
  }

  private handleKeyDown = (e: KeyboardEvent): void => {
    this.updateModifierSides(e);
    this.dispatch(e, "keydown");
  };

  // Keyup-triggered commands are rare (hold-to-release style bindings that
  // fire when the key is let go). A command opts in with `trigger: "keyup"`;
  // everything else defaults to "keydown" and is skipped on this path.
  //
  // Caveat: a keyup event's modifier flags reflect the instant of release,
  // so a multi-key combo bound to keyup can fail to match if the user lifts
  // the modifier before the main key — single-key keyup bindings are the
  // reliable case. Push-to-talk does NOT ride this path; its hold timing,
  // "release any involved key" matching, and window-blur stop live in
  // GlobalAudioRecorder's dedicated raw listener (see the comment there).
  private handleKeyUp = (e: KeyboardEvent): void => {
    this.updateModifierSides(e);
    this.dispatch(e, "keyup");
  };

  private handleBlur = (): void => {
    // Lost focus → we'll miss the modifier keyups, so assume all released.
    this.modifierSides = { meta: null, alt: null, ctrl: null, shift: null };
  };

  /** Track which physical side each modifier is held on, from e.code. */
  private updateModifierSides(e: KeyboardEvent): void {
    const MAP: Record<string, keyof ModifierSides> = {
      MetaLeft: "meta",
      MetaRight: "meta",
      AltLeft: "alt",
      AltRight: "alt",
      ControlLeft: "ctrl",
      ControlRight: "ctrl",
      ShiftLeft: "shift",
      ShiftRight: "shift",
    };
    const mod = MAP[e.code];
    if (!mod) return;
    const side = e.code.endsWith("Right") ? "right" : "left";
    if (e.type === "keydown") {
      this.modifierSides[mod] = side;
    } else if (this.modifierSides[mod] === side) {
      // Only clear if the released side is the one we recorded (the other
      // side might still be held).
      this.modifierSides[mod] = null;
    }
  }

  /** Snapshot of current modifier sides (recorder / external consumers). */
  getModifierSides(): ModifierSides {
    return { ...this.modifierSides };
  }

  private dispatch(e: KeyboardEvent, trigger: "keydown" | "keyup"): void {
    if (this.suppressCount > 0) return;
    if (e.defaultPrevented) return;
    if (e.isComposing || e.keyCode === 229) return;

    const suppression = detectSuppression();
    const ctx = contextKeyService.getSnapshot();
    const resolved = this.getResolved();

    // Walk scope stack top-down, then global.
    for (let i = this.scopeStack.length - 1; i >= 0; i--) {
      if (this.tryDispatch(this.scopeStack[i].id, e, trigger, suppression, ctx, resolved)) return;
    }
    this.tryDispatch(GLOBAL_SCOPE, e, trigger, suppression, ctx, resolved);
  }

  private tryDispatch(
    scope: string,
    e: KeyboardEvent,
    trigger: "keydown" | "keyup",
    suppression: Suppression,
    ctx: Record<string, unknown>,
    resolved: ResolvedBinding[],
  ): boolean {
    for (const r of resolved) {
      if (r.scope !== scope) continue;
      if (r.trigger !== trigger) continue;
      if (!matchesHotkey(e, r.parsed, this.modifierSides)) continue;

      // Auto-repeat (key held) is ignored for toggles and the like.
      if (r.ignoreRepeat && e.repeat) continue;

      if (!r.passThroughTextInput) {
        if (suppression === "all") {
          continue;
        }
        if (suppression === "alpha" && isAlphaKey(e)) {
          continue;
        }
      }

      if (!r.when(ctx)) {
        continue;
      }

      const enabled = commandRegistry.getEnabled(r.commandId);
      if (enabled && !enabled()) {
        continue;
      }

      if (r.preventDefault) e.preventDefault();
      commandRegistry.invoke(r.commandId);
      return true;
    }
    return false;
  }
}

export const keyboardManager = new KeyboardManagerImpl();
