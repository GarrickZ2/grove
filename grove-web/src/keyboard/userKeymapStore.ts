import type { KeymapOverride } from "./types";

/**
 * In-memory store for user keymap overrides + disabled command list.
 *
 * Phase 0: pure in-memory. Phase 2 wires this up to the SQLite-backed
 * REST API — `loadFromServer()` populates from a fetch, `setOverride`
 * etc. PUT to the server. UI never talks to the server directly.
 *
 * Subscribers are notified on any mutation so the KeybindingResolver,
 * Settings UI, HelpOverlay, and Command Palette can all stay in sync.
 */
export class UserKeymapStoreImpl {
  private overrides: Map<string, KeymapOverride[]> = new Map();
  private disabled: Set<string> = new Set();
  private listeners: Set<() => void> = new Set();
  // Monotonic counter bumped on every mutation. Subscribers
  // (useSyncExternalStore) read this as their snapshot so React re-renders
  // even when downstream metrics like `overrides.size` don't change
  // (e.g. editing an existing override in place).
  private version = 0;

  /** Monotonic version that bumps on any mutation. Stable across reads. */
  getVersion(): number {
    return this.version;
  }

  /** Replace the full binding set for a command. Empty array clears it. */
  setOverrides(command_id: string, bindings: KeymapOverride[]): void {
    if (bindings.length === 0) this.overrides.delete(command_id);
    else this.overrides.set(command_id, bindings);
    this.notify();
  }

  removeOverride(command_id: string): void {
    if (this.overrides.delete(command_id)) this.notify();
  }

  /** All override bindings for one command (a command may have several). */
  getOverrides(command_id: string): readonly KeymapOverride[] | undefined {
    return this.overrides.get(command_id);
  }

  /** The whole override map, keyed by command id. */
  getAllOverrides(): ReadonlyMap<string, readonly KeymapOverride[]> {
    return this.overrides;
  }

  setDisabled(command_id: string, disabled: boolean): void {
    const changed = disabled
      ? !this.disabled.has(command_id) && (this.disabled.add(command_id), true)
      : this.disabled.delete(command_id);
    if (changed) this.notify();
  }

  isDisabled(command_id: string): boolean {
    return this.disabled.has(command_id);
  }

  getDisabled(): ReadonlySet<string> {
    return this.disabled;
  }

  /** Reset all overrides + disabled flags. */
  reset(): void {
    if (this.overrides.size === 0 && this.disabled.size === 0) return;
    this.overrides.clear();
    this.disabled.clear();
    this.notify();
  }

  /**
   * Bulk load — used when fetching from server. The server returns a flat
   * list of (command_id, key, …) rows; group them by command so a command
   * with multiple bindings comes back as one array.
   */
  load(overrides: KeymapOverride[], disabledIds: string[]): void {
    this.overrides.clear();
    this.disabled.clear();
    for (const o of overrides) {
      const arr = this.overrides.get(o.command_id);
      if (arr) arr.push(o);
      else this.overrides.set(o.command_id, [o]);
    }
    for (const id of disabledIds) this.disabled.add(id);
    this.notify();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    this.version++;
    for (const l of this.listeners) {
      try {
        l();
      } catch (err) {
        console.error("[UserKeymapStore] listener threw:", err);
      }
    }
  }
}

export const userKeymapStore = new UserKeymapStoreImpl();
