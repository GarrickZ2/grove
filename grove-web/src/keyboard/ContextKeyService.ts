import type { ContextSnapshot } from "./types";

/**
 * ContextKeyService — boolean (and future-typed) variables that drive
 * when-expression evaluation.
 *
 * Components own context keys via createKey() and update them as their
 * state changes. The KeybindingResolver reads a snapshot when dispatching
 * a keystroke. Settings UI uses the live values to preview which commands
 * would currently fire for a given key.
 *
 * v1 values are boolean. The API is `<T = boolean>` so future string /
 * number context keys (e.g. `editorLanguageId == "typescript"`) don't
 * require an API break.
 */

export class ContextKey<T> {
  private readonly name: string;
  private readonly defaultValue: T;
  private readonly service: ContextKeyServiceImpl;

  constructor(name: string, defaultValue: T, service: ContextKeyServiceImpl) {
    this.name = name;
    this.defaultValue = defaultValue;
    this.service = service;
  }

  set(value: T): void {
    this.service._setValue(this.name, value);
  }

  reset(): void {
    this.service._setValue(this.name, this.defaultValue);
  }

  get(): T {
    return this.service._getValue(this.name) as T;
  }
}

export class ContextKeyServiceImpl {
  private values: Map<string, unknown> = new Map();
  private listeners: Set<(changed: ReadonlySet<string>) => void> = new Set();

  createKey<T = boolean>(name: string, defaultValue: T): ContextKey<T> {
    if (!this.values.has(name)) {
      this.values.set(name, defaultValue);
    }
    return new ContextKey(name, defaultValue, this);
  }

  _setValue(name: string, value: unknown): void {
    const prev = this.values.get(name);
    if (prev === value) return;
    this.values.set(name, value);
    this.notify(new Set([name]));
  }

  _getValue(name: string): unknown {
    return this.values.get(name);
  }

  /**
   * Return a snapshot of all known context keys. The KeybindingResolver
   * passes this to the when-expression evaluator.
   *
   * Unknown identifiers in the expression evaluate to false (undefined),
   * so missing keys in the snapshot are not an error.
   */
  getSnapshot(): ContextSnapshot {
    return Object.fromEntries(this.values);
  }

  subscribe(listener: (changed: ReadonlySet<string>) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Test helper — wipe all state. */
  _resetAll(): void {
    this.values.clear();
    this.listeners.clear();
  }

  private notify(changed: ReadonlySet<string>): void {
    for (const l of this.listeners) {
      try {
        l(changed);
      } catch (err) {
        console.error("[ContextKeyService] listener threw:", err);
      }
    }
  }
}

export const contextKeyService = new ContextKeyServiceImpl();
