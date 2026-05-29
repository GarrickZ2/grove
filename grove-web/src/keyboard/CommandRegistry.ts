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
  private handlers: Map<string, HandlerEntry> = new Map();
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
    const prev = this.handlers.get(id);
    if (prev) {
      console.warn(`[CommandRegistry] handler for "${id}" already registered — replacing`);
    }
    this.handlers.set(id, entry);
    this.notify();
    return () => {
      const current = this.handlers.get(id);
      if (current === entry) {
        this.handlers.delete(id);
        this.notify();
      }
    };
  }

  /**
   * Invoke a command by id. Returns true if a handler ran, false if no
   * handler was registered or the enabled gate said no.
   */
  invoke(id: string, args?: unknown): boolean {
    const entry = this.handlers.get(id);
    if (!entry) return false;
    if (entry.enabled && !entry.enabled()) return false;
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

  /** Get the enabled predicate for a command (if any). KeybindingResolver uses this. */
  getEnabled(id: string): (() => boolean) | undefined {
    return this.handlers.get(id)?.enabled;
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
