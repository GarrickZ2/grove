/**
 * Terminal instance cache — keeps xterm.js + WebSocket alive across task switches.
 *
 * Lifecycle:
 *   mount   → getCached() hit? reattach : create new + setCached()
 *   unmount → detachTerminal()  (moves container to hidden holder, WS stays open)
 *   page unload → disposeAllTerminals()
 */
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import type { IDisposable } from "@xterm/xterm";

export interface CachedTerminal {
  terminal: Terminal;
  fitAddon: FitAddon;
  ws: WebSocket | null;
  container: HTMLDivElement;
  dataDisposable: IDisposable;
  /** Whether this terminal is currently attached to a visible component */
  active: boolean;
  /** Callback to fire when WS disconnects while active */
  onDisconnected: (() => void) | null;
  /**
   * True once the shell has emitted `\x1b[?2004h` (bracketed-paste enable).
   * `pasteToTerminal` waits for this flag before sending brackets; otherwise
   * the escape sequences land before the shell's line editor is ready and get
   * echoed as literal text.
   */
  bracketedPasteReady: boolean;
}

const cache = new Map<string, CachedTerminal>();

// Off-screen holder keeps detached terminal DOM alive so xterm state is preserved
let holder: HTMLDivElement | null = null;

function getHolder(): HTMLDivElement {
  if (!holder) {
    holder = document.createElement("div");
    holder.style.cssText =
      "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;overflow:hidden;pointer-events:none";
    document.body.appendChild(holder);
  }
  return holder;
}

export function getCached(key: string): CachedTerminal | undefined {
  return cache.get(key);
}

export function setCached(key: string, entry: CachedTerminal): void {
  cache.set(key, entry);
}

/** Move terminal container to hidden holder. WS stays open, output accumulates. */
export function detachTerminal(key: string): void {
  const entry = cache.get(key);
  if (!entry) return;
  entry.active = false;
  entry.onDisconnected = null;
  if (entry.container.parentElement) {
    getHolder().appendChild(entry.container);
  }
}

/** Fully dispose terminal, close WS, remove from cache. */
export function disposeTerminal(key: string): void {
  const entry = cache.get(key);
  if (!entry) return;
  entry.active = false;
  entry.onDisconnected = null;
  entry.dataDisposable.dispose();
  if (entry.ws && entry.ws.readyState <= WebSocket.OPEN) {
    entry.ws.close();
  }
  entry.terminal.dispose();
  entry.container.remove();
  cache.delete(key);
}

/** Dispose every cached terminal (page unload). */
export function disposeAllTerminals(): void {
  for (const key of [...cache.keys()]) {
    disposeTerminal(key);
  }
  if (holder) {
    holder.remove();
    holder = null;
  }
}

/** Build a deterministic cache key from connection parameters + instance id. */
export function makeTerminalCacheKey(
  connectionKey: string,
  instanceId: string,
): string {
  return `${connectionKey}|${instanceId}`;
}

/**
 * Send text input to a terminal matching a connection key prefix.
 * Prefers the active (visible) terminal; falls back to any with open WS.
 * Returns true if input was sent, false if no matching terminal was found.
 */
export function sendInputToTerminal(connectionKeyPrefix: string, text: string): boolean {
  // Prefer active (visible) terminal
  for (const [key, entry] of cache.entries()) {
    if (key.startsWith(connectionKeyPrefix) && entry.active && entry.ws && entry.ws.readyState === WebSocket.OPEN) {
      entry.ws.send(text);
      return true;
    }
  }
  // Fallback: any matching terminal with open WS
  for (const [key, entry] of cache.entries()) {
    if (key.startsWith(connectionKeyPrefix) && entry.ws && entry.ws.readyState === WebSocket.OPEN) {
      entry.ws.send(text);
      return true;
    }
  }
  return false;
}

/**
 * Find a cached terminal whose key starts with the given prefix.
 * Prefers `active` entries; falls back to any entry.
 */
function findTerminalByPrefix(prefix: string): CachedTerminal | undefined {
  for (const [key, entry] of cache.entries()) {
    if (key.startsWith(prefix) && entry.active) return entry;
  }
  for (const [key, entry] of cache.entries()) {
    if (key.startsWith(prefix)) return entry;
  }
  return undefined;
}

/**
 * Paste text into the matching terminal without auto-executing newlines.
 * Waits for:
 *   1. A cached terminal matching `connectionKeyPrefix` to exist
 *   2. Its WebSocket to be OPEN
 *   3. The shell to have enabled bracketed-paste mode
 *      (signalled by the `\x1b[?2004h` sequence in its output)
 * Then sends the text wrapped with bracketed-paste markers so multi-line
 * content sits on the prompt and the user still presses Enter to run it.
 */
export async function pasteToTerminal(
  connectionKeyPrefix: string,
  text: string,
  timeoutMs = 8_000,
): Promise<boolean> {
  const wrapped = `\x1b[200~${text}\x1b[201~`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const entry = findTerminalByPrefix(connectionKeyPrefix);
    if (
      entry &&
      entry.ws &&
      entry.ws.readyState === WebSocket.OPEN &&
      entry.bracketedPasteReady
    ) {
      entry.ws.send(wrapped);
      // Focus so the user sees where the command landed
      try {
        entry.terminal.focus();
      } catch {
        // ignore — terminal may not be attached to DOM
      }
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

// Clean up all terminals when page unloads
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", disposeAllTerminals);
}
