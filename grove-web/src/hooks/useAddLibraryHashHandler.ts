import { useCallback, useEffect, useState } from "react";
import { apiClient } from "../api/client";

/**
 * `libraries.excalidraw.com` opens "Add to Excalidraw" via `target=_blank`,
 * then redirects the new tab to `<grove-web>/#addLibrary=<lib-url>&token=<id>`
 * when the user confirms. That new tab may land on any grove-web page, so we
 * cannot rely on an Excalidraw component being mounted to consume the hash.
 *
 * This hook returns dialog state for `<AddLibraryHashHandler />` to render.
 * On mount it fetches the `.excalidrawlib` from the URL in the hash (or a
 * parked entry from a prior failed install) and surfaces a confirmation
 * dialog before installing — defense-in-depth, since a direct link bypasses
 * Excalidraw's own confirmation page and the downloaded `name` fields land
 * in agent prompts.
 *
 * Failed downloads / failed PUTs leave the URL in `sessionStorage` (1-hour
 * TTL) so the next mount can retry instead of silently dropping it.
 *
 * The PUT path is the same one SketchCanvas uses for its `onLibraryChange`
 * sync — one canonical write endpoint for both manual edits and remote
 * imports.
 */

const PENDING_KEY = "grove.pendingAddLibrary";
/** Discard parked installs older than this — guards against the pathological
 *  "tab parked URL, then crashed pre-confirm; user later restores session
 *  and gets a stale prompt for a URL they don't remember requesting". */
const PENDING_TTL_MS = 60 * 60 * 1000;
/** Per-tab broadcast nonce so a sketch canvas in the SAME tab as the install
 *  can ignore its own `library-changed` echo. BroadcastChannel does not
 *  deliver to the sending channel instance, but it DOES deliver across two
 *  channel instances in the same tab. */
const TAB_NONCE =
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;
export function getLibraryBroadcastTabNonce(): string {
  return TAB_NONCE;
}

function clearHash(): void {
  const params = new URLSearchParams(window.location.hash.slice(1));
  params.delete("addLibrary");
  params.delete("token");
  const remaining = params.toString();
  window.history.replaceState(
    {},
    "",
    remaining
      ? `${window.location.pathname}${window.location.search}#${remaining}`
      : `${window.location.pathname}${window.location.search}`,
  );
}

function pickPendingUrl(): string | null {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash;
  if (hash.includes("addLibrary=")) {
    const params = new URLSearchParams(hash.slice(1));
    const fromHash = params.get("addLibrary");
    if (fromHash) {
      // Park before clearing the hash so a mid-flight reload still finds it.
      try {
        window.sessionStorage.setItem(
          PENDING_KEY,
          JSON.stringify({ url: fromHash, ts: Date.now() }),
        );
      } catch {
        /* sessionStorage unavailable — fall through */
      }
      clearHash();
      return fromHash;
    }
  }
  try {
    const raw = window.sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    // Tolerate the legacy plain-string format from earlier versions.
    let url: string | null = null;
    let ts = 0;
    try {
      const parsed = JSON.parse(raw) as { url?: string; ts?: number };
      url = parsed.url ?? null;
      ts = parsed.ts ?? 0;
    } catch {
      url = raw;
    }
    if (!url || (ts > 0 && Date.now() - ts > PENDING_TTL_MS)) {
      dropPending();
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

/** Pull a useful message out of either a real Error or the `ApiError` plain
 *  object thrown by `apiClient.*`. Returns null when nothing meaningful is
 *  available so the caller can fall back to its own default text. */
function extractErrorMessage(err: unknown): string | null {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string" && m.length > 0) return m;
  }
  return null;
}

function dropPending(): void {
  try {
    window.sessionStorage.removeItem(PENDING_KEY);
  } catch {
    /* ignore */
  }
}

/** Best-effort REAL name derived from item content, or null if none.
 *  v2 items carry their own `name`; v1 items don't (the format only stored
 *  elements arrays), so fall back to the first text element's content.
 *  Returns null when no real name exists — callers decide whether to
 *  substitute a positional fallback for display, but we never PERSIST a
 *  fake name (the agent-facing MCP listing should honestly show the item
 *  is unnamed rather than be misled by a synthesized "Item 7"). */
function deriveRealName(item: {
  name?: unknown;
  elements?: unknown;
}): string | null {
  if (typeof item.name === "string" && item.name.trim().length > 0) {
    return item.name.trim();
  }
  if (Array.isArray(item.elements)) {
    for (const el of item.elements) {
      if (
        el &&
        typeof el === "object" &&
        "type" in el &&
        (el as { type?: unknown }).type === "text" &&
        typeof (el as { text?: unknown }).text === "string"
      ) {
        const text = (el as { text: string }).text.trim();
        if (text.length > 0) {
          return text.length > 80 ? text.slice(0, 80) : text;
        }
      }
    }
  }
  return null;
}


export interface PendingLibraryInstall {
  kind: "install";
  url: string;
  items: unknown[];
  /** Total items in the file. */
  total: number;
  /** Items that have a real name (their own `name` field, or first text
   *  element content as a backfill). Only these will be visible to coding
   *  agents via MCP — unnamed items still install for human use in the
   *  canvas, but agents cannot reference them by semantic intent. */
  namedCount: number;
}

export interface AddLibraryError {
  kind: "error";
  url: string;
  /** Short user-facing message. */
  message: string;
  /** Whether the entry is still parked for retry on next mount. */
  retryable: boolean;
}

export type AddLibraryState = PendingLibraryInstall | AddLibraryError | null;

/**
 * Drives the add-library install flow. Resolves to either:
 *   - install-ready state with parsed items
 *   - error state when fetch/parse failed or the library was empty
 *   - null when there is nothing to act on
 *
 * Caller renders the actual UI.
 */
export function useAddLibraryHashHandler(): {
  state: AddLibraryState;
  confirm: () => Promise<void>;
  dismiss: () => void;
} {
  const [state, setState] = useState<AddLibraryState>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const libUrl = pickPendingUrl();
    if (!libUrl) return;
    let cancelled = false;

    (async () => {
      try {
        // Reject non-http(s) schemes (javascript:, file:, data:, blob:, ...)
        // before fetch — defense-in-depth, since libUrl may come from the
        // URL hash and we feed its contents into agent prompts later.
        let parsed: URL;
        try {
          parsed = new URL(libUrl);
        } catch {
          setState({
            kind: "error",
            url: libUrl,
            message: "The provided library URL is not a valid URL.",
            retryable: false,
          });
          dropPending();
          return;
        }
        const host = window.location.hostname;
        const isLocalHost = host === "localhost" || host === "127.0.0.1";
        const isHttps = parsed.protocol === "https:";
        const isHttpLocal = parsed.protocol === "http:" && isLocalHost;
        if (!isHttps && !isHttpLocal) {
          setState({
            kind: "error",
            url: libUrl,
            message: `URL scheme "${parsed.protocol}" is not allowed. Only https:// URLs are accepted.`,
            retryable: false,
          });
          dropPending();
          return;
        }
        const res = await fetch(libUrl);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} ${res.statusText}`);
        }
        // Read as text first so we can detect HTML responses (servers
        // commonly answer "library not found" with a 200 + HTML page,
        // which would otherwise crash JSON.parse with a useless
        // "Unexpected token '<'" message).
        const body = await res.text();
        const trimmed = body.trimStart();
        const contentType = res.headers.get("content-type") ?? "";
        const looksHtml =
          /^text\/html\b/i.test(contentType) ||
          trimmed.startsWith("<!doctype") ||
          trimmed.startsWith("<!DOCTYPE") ||
          trimmed.startsWith("<html");
        if (looksHtml) {
          throw new Error(
            "The URL returned a webpage instead of a library file. The library may have been moved, renamed, or never existed at this path.",
          );
        }
        let file: {
          version?: number;
          libraryItems?: { name?: unknown; elements?: unknown }[];
          library?: unknown[][];
        };
        try {
          file = JSON.parse(body);
        } catch {
          throw new Error(
            "The downloaded file is not valid JSON. The URL may not be pointing at an .excalidrawlib file.",
          );
        }
        // Excalidraw .excalidrawlib has TWO formats:
        //   v2: { libraryItems: [{ id, elements, name, ... }, ...] }
        //   v1: { library:      [[element, ...], ...] }   (array of element arrays)
        // Backend stores v2; convert v1 → v2 here so the install path is uniform.
        let items: {
          name?: unknown;
          id?: unknown;
          elements?: unknown;
        }[] = [];
        if (Array.isArray(file.libraryItems)) {
          // v2 items already carry their own name when present; for ones that
          // don't (older v2 producers also sometimes omit it), backfill from
          // element text so MCP / agent prompts get a real reference name.
          items = file.libraryItems.map((it) => {
            const real = deriveRealName(it);
            return real && (typeof it.name !== "string" || !it.name.trim())
              ? { ...it, name: real }
              : it;
          });
        } else if (Array.isArray(file.library)) {
          items = file.library.map((elements, idx) => {
            const synthetic = { elements };
            const real = deriveRealName(synthetic);
            return {
              id: `v1-import-${Date.now()}-${idx}`,
              status: "published",
              elements,
              created: Date.now(),
              // Persist real name only — never a synthesized "Item N", since
              // agents would otherwise be told the item is named "Item 7".
              ...(real ? { name: real } : {}),
            };
          });
        }
        if (cancelled) return;
        if (items.length === 0) {
          setState({
            kind: "error",
            url: libUrl,
            message:
              "The downloaded file contained no library items. The file may be corrupted or use an unsupported format.",
            retryable: false,
          });
          dropPending();
          return;
        }
        const namedCount = items.filter(
          (it) => deriveRealName(it) !== null,
        ).length;
        setState({
          kind: "install",
          url: libUrl,
          items,
          total: items.length,
          namedCount,
        });
      } catch (err) {
        console.error("[addLibrary] download failed", err);
        if (cancelled) return;
        setState({
          kind: "error",
          url: libUrl,
          message:
            extractErrorMessage(err) ??
            "Could not fetch the library. Check your network and try again.",
          retryable: true,
        });
        // Keep the pending entry so a reload retries.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const confirm = useCallback(async () => {
    if (state?.kind !== "install") return;
    const installState = state;
    try {
      await apiClient.put("/api/v1/library", { libraryItems: installState.items });
      dropPending();
      try {
        const ch = new BroadcastChannel("grove-library");
        ch.postMessage({ type: "library-changed", tab: TAB_NONCE });
        ch.close();
      } catch {
        /* not supported — peer tabs will pick up on next mount */
      }
      setState(null);
    } catch (err) {
      console.error("[addLibrary] install failed", err);
      // Surface the failure instead of silently closing.
      setState({
        kind: "error",
        url: installState.url,
        message:
          extractErrorMessage(err) ?? "Could not save the library. Try again.",
        retryable: true,
      });
    }
  }, [state]);

  const dismiss = () => {
    // For non-retryable errors and explicit cancels we drop the parked entry
    // so a reload doesn't immediately re-prompt; for retryable errors we
    // keep it so the user can refresh to try again.
    if (state?.kind !== "error" || !state.retryable) {
      dropPending();
    }
    setState(null);
  };

  return { state, confirm, dismiss };
}
