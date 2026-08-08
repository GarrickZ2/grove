import type { CommandDef, CommandHandler } from "./types";

/**
 * CommandRegistry — single source of truth for "what commands exist"
 * and "how to invoke them".
 *
 * Three populated paths:
 *   1. setStaticCatalog(defs)   — called once at startup with Phase 1
 *                                 catalog content (catalog/*.ts).
 *   2. contribute(def, handler) — runtime add (animation: useDefineCommand,
 *                                 future plugins, dynamic agent commands).
 *   3. registerHandler(id, ..)  — handler-only attach for a static catalog
 *                                 entry (useCommand).
 *
 * Catalog reads (listCommands, getCommand) merge static + contributed so
 * Settings UI / Palette / HelpOverlay see one unified list regardless of
 * how a command was added.
 */

interface HandlerEntry {
  handler: CommandHandler;
  enabled?: () => boolean;
}

export class CommandRegistryImpl {
  private staticCatalog: Map<string, CommandDef> = new Map();
  private contributed: Map<string, CommandDef> = new Map();
  // A command id can have MORE THAN ONE handler registered at once — e.g. the
  // Blitz grid mounts several TaskChat instances, each registering `chat.send`.
  // We keep them all (most-recent last) and, at invoke time, dispatch to the
  // first whose `enabled()` gate passes. That lets a per-instance focus guard
  // (does this panel contain document.activeElement?) route the key to the
  // focused pane instead of an arbitrary last-write-wins winner.
  private handlers: Map<string, HandlerEntry[]> = new Map();
  private listeners: Set<() => void> = new Set();

  setStaticCatalog(defs: ReadonlyArray<CommandDef>): void {
    this.staticCatalog.clear();
    for (const d of defs) {
      if (this.staticCatalog.has(d.id)) {
        console.warn(`[CommandRegistry] duplicate static catalog id: ${d.id}`);
      }
      this.staticCatalog.set(d.id, d);
    }
    this.notify();
  }

  /** Runtime command registration. Returns dispose function. */
  contribute(def: CommandDef, handler?: CommandHandler, enabled?: () => boolean): () => void {
    this.contributed.set(def.id, def);
    let unregisterHandler: (() => void) | undefined;
    if (handler) {
      unregisterHandler = this.registerHandler(def.id, handler, enabled);
    }
    this.notify();
    return () => {
      this.contributed.delete(def.id);
      unregisterHandler?.();
      this.notify();
    };
  }

  /**
   * Attach a handler to an existing catalog entry. Used by useCommand
   * for static catalog commands. If the id is unknown the handler is
   * still registered but a warning is logged — this lets components
   * mount in any order during development.
   */
  registerHandler(id: string, handler: CommandHandler, enabled?: () => boolean): () => void {
    if (!this.staticCatalog.has(id) && !this.contributed.has(id)) {
      console.warn(`[CommandRegistry] handler registered for unknown command "${id}" — declare it in catalog or use useDefineCommand`);
    }
    const entry: HandlerEntry = { handler, enabled };
    const list = this.handlers.get(id);
    if (list) {
      list.push(entry);
    } else {
      this.handlers.set(id, [entry]);
    }
    this.notify();
    return () => {
      const current = this.handlers.get(id);
      if (!current) return;
      const idx = current.indexOf(entry);
      if (idx === -1) return;
      current.splice(idx, 1);
      if (current.length === 0) this.handlers.delete(id);
      this.notify();
    };
  }

  /**
   * Invoke a command by id. Returns true if a handler ran, false if no
   * handler was registered or the enabled gate said no.
   */
  invoke(id: string, args?: unknown): boolean {
    const list = this.handlers.get(id);
    if (!list || list.length === 0) return false;
    // Most-recently-registered first. Run the first handler whose enabled
    // gate passes; a focus-guarded gate (see TaskChat chat.send) means the
    // focused pane wins. With a single handler this is the old behaviour.
    for (let i = list.length - 1; i >= 0; i--) {
      const entry = list[i];
      if (entry.enabled && !entry.enabled()) continue;
      try {
        const r = entry.handler(args);
        if (r instanceof Promise) {
          r.catch((e) => console.error(`[CommandRegistry] "${id}" async failed:`, e));
        }
      } catch (e) {
        console.error(`[CommandRegistry] "${id}" threw:`, e);
      }
      return true;
    }
    return false;
  }

  /** Look up a CommandDef. Contributed entries shadow static (last-write-wins). */
  getCommand(id: string): CommandDef | undefined {
    return this.contributed.get(id) ?? this.staticCatalog.get(id);
  }

/** Snapshot of all known commands. Static first, then contributed (deduped by id). */
  listCommands(): CommandDef[] {
    const seen = new Set<string>();
    const out: CommandDef[] = [];
    for (const d of this.staticCatalog.values()) {
      seen.add(d.id);
      out.push(d);
    }
    for (const d of this.contributed.values()) {
      if (!seen.has(d.id)) out.push(d);
    }
    return out;
  }

  /**
   * Gate predicate KeyboardManager checks before firing a binding: true if ANY
   * registered handler is currently enabled. (invoke then picks that handler.)
   * Returns undefined when no handler is registered so the manager treats the
   * binding as unhandled and keeps walking the scope stack.
   */
  getEnabled(id: string): (() => boolean) | undefined {
    const list = this.handlers.get(id);
    if (!list || list.length === 0) return undefined;
    return () => list.some((e) => !e.enabled || e.enabled());
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Test helper — wipe all state. */
  _resetAll(): void {
    this.staticCatalog.clear();
    this.contributed.clear();
    this.handlers.clear();
    this.listeners.clear();
  }

  private notify(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch (err) {
        console.error("[CommandRegistry] listener threw:", err);
      }
    }
  }
}

export const commandRegistry = new CommandRegistryImpl();
