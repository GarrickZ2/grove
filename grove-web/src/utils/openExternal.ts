import { isIosClient } from "./platform";
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
  return isIosClient ? null : w.__TAURI_INTERNALS__ ?? null;
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

/**
 * Install a document-level click interceptor that routes any <a href="http(s)://…">
 * click through `openExternalUrl`, so OS-default browser handles the URL.
 *
 * Tauri-only: in a regular browser, native <a> behavior is already correct.
 *
 * Why this is needed: Tauri's webview swallows `target="_blank"` /
 * `window.open` calls, leaving plain markdown / 3rd-party-rendered links
 * dead. Intercepting at capture phase covers every component without each
 * one having to wire up its own handler. Components that render to canvas
 * (e.g. xterm) still need their own integration since they don't emit real
 * <a> elements.
 */
export function installExternalLinkInterceptor(): void {
  if (!getTauriInternals()) return;

  document.addEventListener(
    "click",
    (event) => {
      // Let modified clicks (e.g. middle-click, save-as) be handled by us
      // too — Tauri can't honor "open in new tab" anyway, so we collapse
      // every variant onto "open in OS default browser".
      if (event.defaultPrevented) return;
      if (event.button !== 0 && event.button !== 1) return;

      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a");
      if (!anchor) return;

      const href = anchor.getAttribute("href");
      if (!href) return;
      if (!/^https?:\/\//i.test(href)) return;

      event.preventDefault();
      event.stopPropagation();
      openExternalUrl(href);
    },
    true, // capture phase — beat React synthetic-event handlers
  );
}

/**
 * Install a global window-level drag and drop event listener that prevents
 * the default browser behavior of navigating to dropped files. This prevents
 * the entire webview from reloading/navigating and displaying unstyled,
 * raw files (which often results in Mojibake encoding issues).
 */
export function installGlobalDragDropInterceptor(): void {
  window.addEventListener(
    "dragover",
    (event) => {
      event.preventDefault();
    },
    false,
  );

  window.addEventListener(
    "drop",
    (event) => {
      event.preventDefault();
    },
    false,
  );
}

