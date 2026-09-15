// Thin, guarded wrappers around the Tauri shell.
//
// Everything no-ops outside Tauri (browser surface) so callers stay
// surface-agnostic — the same code runs in the GUI webview and a plain tab.

import { invoke } from "@tauri-apps/api/core";

export const isTauriShell: boolean =
  typeof window !== "undefined" &&
  ("__TAURI_INTERNALS__" in window || "__TAURI__" in window);

/** Invoke a Tauri command; resolves to null outside Tauri or on error. */
export function invokeQuiet<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T | null> {
  if (!isTauriShell) return Promise.resolve(null);
  return invoke<T>(command, args).catch(() => null);
}

/** Hand the remote backend's HMAC secret to the shell so the local proxy can
 *  sign banner click-through actions (`/api/v1/gui/*`) — those POSTs
 *  originate from the OS notifier process, which can't sign. The key never
 *  leaves the shell process. No-op outside Tauri. */
export function handRemoteAuthKeyToShell(secretKey: string): void {
  void invokeQuiet("set_remote_auth_key", { secretKey });
}

/** Does this window talk to a remote backend? Always false outside Tauri. */
export function isRemoteMode(): Promise<boolean> {
  return invokeQuiet<boolean>("is_remote_mode_command").then((v) => v === true);
}
