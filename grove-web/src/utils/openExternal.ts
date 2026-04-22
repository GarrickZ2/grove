/**
 * Open an external URL.
 *
 * In a regular browser:  delegates to window.open (target="_blank").
 * In Tauri GUI:          window.open/_blank is swallowed by the webview, so we
 *                        call tauri-plugin-shell's `open` command instead, which
 *                        forwards the URL to the OS default browser.
 */

type TauriInternals = {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
};

function getTauriInternals(): TauriInternals | null {
  const w = window as Window & { __TAURI_INTERNALS__?: TauriInternals };
  return w.__TAURI_INTERNALS__ ?? null;
}

export function openExternalUrl(url: string): void {
  const tauri = getTauriInternals();
  if (tauri) {
    // Prefer our own `open_external_url` command (no capability-scope gotchas).
    // Fall back to tauri-plugin-shell's built-in open if unavailable.
    tauri.invoke("open_external_url", { url }).catch((primaryErr: unknown) => {
      console.warn("[openExternalUrl] custom command failed, falling back:", primaryErr);
      tauri.invoke("plugin:shell|open", { path: url }).catch((err: unknown) => {
        console.error("[openExternalUrl] Tauri shell open failed:", err);
      });
    });
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
