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

export interface RemoteAuthorization {
  signingKey: string;
  deviceId: string | null;
}

/** Share the active authorization with the tray and native banner actions. */
export function handRemoteAuthToShell(authorization: RemoteAuthorization | null): void {
  void invokeQuiet("set_remote_auth", { authorization });
}

/** Does this window talk to a remote backend? Always false outside Tauri. */
export function isRemoteMode(): Promise<boolean> {
  return invokeQuiet<boolean>("is_remote_mode_command").then((v) => v === true);
}

/** Initialize the native menubar tray from the effective backend config.
 * Remote GUI defers this until after authentication because its config lives
 * on the remote backend. No-op in an ordinary browser. */
export function configureDesktopTray(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    // Call invoke directly instead of relying on the global-marker heuristic:
    // custom External webviews can have a working Tauri IPC bridge before the
    // marker globals become observable to application code.
    void invoke("configure_desktop_tray", { enabled }).catch(() => {});
  } catch {
    // Ordinary browser surface — there is no native tray to configure.
  }
}
