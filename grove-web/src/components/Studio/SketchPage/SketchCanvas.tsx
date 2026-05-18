import React, { Suspense, useCallback, useEffect, useRef, useState } from "react";
import type {
  ExcalidrawImperativeAPI,
  LibraryItems,
} from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";
import { apiClient } from "../../../api/client";
import { getLibraryBroadcastTabNonce } from "../../../hooks/useAddLibraryHashHandler";

/** Server response from `GET /api/v1/library`. Mirrors the on-disk
 * `~/.grove/library.excalidrawlib` JSON. Items have additional fields we
 * pass through verbatim. */
interface LibraryFile {
  type: string;
  version: number;
  source?: string;
  libraryItems: unknown[];
}

/**
 * Lazy-load Excalidraw along with a trimmed MainMenu. We render MainMenu
 * inside the Excalidraw tree so that a) its DefaultItems resolve against the
 * same lazy-loaded module, and b) the whole thing stays in the Excalidraw
 * code-split chunk — matching the `perf(sketch): lazy-load Excalidraw` intent.
 *
 * Items we keep: Export image, Find on canvas, Help, Dark mode, Canvas
 * background.
 * Items we drop: Open, Save to... (conflicts with Grove's own storage),
 * Reset the canvas (dangerous, one-click wipe), GitHub/Follow/Discord
 * (irrelevant to Grove users).
 */
interface LazyExcalidrawProps {
  initialData: unknown;
  /** Library items fetched from `GET /api/v1/library` and injected into
   * Excalidraw's library panel. Passed separately from `initialData.elements`
   * because they're sourced from a different backend file (global library,
   * not per-sketch scene). */
  initialLibraryItems: unknown[];
  excalidrawAPI: (api: ExcalidrawImperativeAPI) => void;
  onChange: (
    elements: readonly unknown[],
    appState: unknown,
    files: unknown,
  ) => void;
  /** Fires when the user installs / edits / deletes library items via any
   * Excalidraw UI (Browse libraries hash callback, Open file, drag-to-add,
   * pin/unpin, etc.). We persist by PUT-ing the full current list. */
  onLibraryChange: (libraryItems: readonly unknown[]) => void;
  /** Echoed back by libraries.excalidraw.com when the user clicks "Add to
   * Excalidraw" — sets the redirect target that carries `#addLibrary=...`. */
  libraryReturnUrl: string;
  /** When true, put Excalidraw in view-only mode (no edits). Used while the
   * ACP chat is busy so user edits don't race with AI-authored writes. */
  viewModeEnabled?: boolean;
}

const LazyExcalidraw = React.lazy(async () => {
  const m = await import("@excalidraw/excalidraw");
  const { Excalidraw, MainMenu, convertToExcalidrawElements } = m;
  const Wrapped: React.FC<LazyExcalidrawProps> = (props) => {
    // Expand shorthand elements (notably `label` on shapes) into the
    // fully-bound Excalidraw format (container + separate text element with
    // containerId). AI / MCP writes use the shorthand to save tokens; this
    // pass handles the conversion at load time.
    //
    // Element-by-element routing: only elements that actually carry the
    // `label` shorthand go through `convertToExcalidrawElements`; everything
    // else is handed to Excalidraw verbatim. Two reasons for the split:
    //
    // 1. The converter's `newArrowElement()` hardcodes
    //    `startBinding: null, endBinding: null` in its returned object,
    //    so any arrow that flows through it loses its `startBinding` /
    //    `endBinding` — regardless of whether that specific arrow had a
    //    `label`. Arrows are connective tissue in AI-generated diagrams;
    //    silently stripping their bindings means users drag a shape and
    //    the arrows detach.
    // 2. The converter also isn't idempotent on already-expanded text
    //    elements with `containerId` — re-running it on each load nudges
    //    label coordinates a few pixels, causing cumulative drift across
    //    reloads.
    //
    // Converter is called on a filtered subset only (shorthand-bearing
    // elements) and then we concat the pass-through set behind them so
    // z-order is preserved.
    //
    // Excalidraw only reads `initialData` on first mount — use a lazy
    // `useState` initializer so this runs exactly once per mount.
    const [transformed] = React.useState<
      | {
          elements: unknown[];
          appState?: unknown;
          files?: unknown;
          libraryItems?: unknown[];
        }
      | undefined
    >(() => {
      const data = (props.initialData ?? {}) as {
        elements?: unknown[];
        appState?: unknown;
        files?: unknown;
      };
      const raw = (data.elements ?? []) as unknown[];
      const baseInitial: {
        elements: unknown[];
        appState?: unknown;
        files?: unknown;
        libraryItems?: unknown[];
      } = { ...data, elements: raw, libraryItems: props.initialLibraryItems };
      if (!Array.isArray(raw) || raw.length === 0) {
        return baseInitial;
      }
      const hasShorthand = (el: unknown): boolean =>
        !!el && typeof el === "object" && "label" in (el as object);
      const anyShorthand = raw.some(hasShorthand);
      if (!anyShorthand) {
        return baseInitial;
      }
      // Convert only the shorthand-bearing elements; pass all others
      // through unchanged. Preserve original order so z-order stays
      // correct.
      const result: unknown[] = [];
      for (const el of raw) {
        if (hasShorthand(el)) {
          const converted = convertToExcalidrawElements(
            [el] as Parameters<typeof convertToExcalidrawElements>[0],
            { regenerateIds: false },
          );
          result.push(...converted);
        } else {
          result.push(el);
        }
      }
      return { ...baseInitial, elements: result };
    });
    const {
      initialData: _omitInitial,
      initialLibraryItems: _omitLib,
      ...rest
    } = props;
    void _omitInitial;
    void _omitLib;
    return (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      <Excalidraw {...(rest as any)} initialData={transformed}>
        <MainMenu>
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.SearchMenu />
          <MainMenu.DefaultItems.Help />
          <MainMenu.Separator />
          <MainMenu.DefaultItems.ToggleTheme />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
        </MainMenu>
      </Excalidraw>
    );
  };
  return { default: Wrapped };
});

interface Props {
  scene: unknown | null;
  onChange: (next: unknown) => void;
  onExcalidrawAPI?: (api: ExcalidrawImperativeAPI) => void;
  /** When true, lock the canvas (read-only). Surfaced while the ACP chat is
   * busy so the user can't edit concurrently with AI-authored writes
   * (which would otherwise overwrite each other at save time). */
  locked?: boolean;
}

interface ExcalidrawScene {
  elements?: unknown[];
  appState?: Record<string, unknown>;
  files?: Record<string, unknown>;
}

/**
 * Sanitize an appState that came from disk / WebSocket: JSON round-trips strip
 * the `Map` prototype off `collaborators`, which Excalidraw then tries to call
 * `.forEach` on at render time (crashing). Drop the key so Excalidraw's default
 * (an empty Map) is used. Also drop fields that hold transient per-session
 * state we do not want to restore across reloads (selection, in-flight edits).
 */
function sanitizeAppState(
  appState: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const clean: Record<string, unknown> = appState ? { ...appState } : {};
  delete clean.cursorButton;
  // Transient per-session state — persisting these makes every element appear
  // selected when the sketch is reopened, and breaks in-progress edits on
  // mount. Reset to empty.
  clean.selectedElementIds = {};
  clean.selectedGroupIds = {};
  clean.selectedLinearElement = null;
  clean.editingLinearElement = null;
  clean.editingTextElement = null;
  clean.editingGroupId = null;
  // Excalidraw expects a Map; explicitly set an empty Map so merges do not
  // leave a plain-object `{}` collaborators in place.
  clean.collaborators = new Map();
  return clean;
}

/** Debounce window for PUT-ing library changes. Excalidraw fires
 * `onLibraryChange` on every keystroke during item rename / drag-pin /
 * etc.; batching avoids hammering the backend during interactive editing. */
const LIBRARY_PUT_DEBOUNCE_MS = 600;

/** De-bounce window for BroadcastChannel "library-changed" pings from peer
 * tabs. Tabs that install many libraries in quick succession will fire many
 * pings; we coalesce them into one refresh. */
const LIBRARY_BROADCAST_DEBOUNCE_MS = 1000;

/**
 * Module-level cache of the initial `GET /api/v1/library` promise.
 *
 * Several SketchCanvas instances may mount in parallel (e.g. switching
 * Excalidraw tabs in quick succession, or remount via key after a save).
 * Without this cache each mount fires its own fetch and Excalidraw briefly
 * shows an empty library before the late response arrives. Sharing the
 * promise dedupes the request while still letting each canvas await its
 * own initial state.
 *
 * Cleared on `pageshow` with `event.persisted` (bfcache restore) since the
 * cached library may be stale relative to whatever happened in other tabs
 * while this one was frozen.
 */
const initialLibraryCache = new Map<string, Promise<unknown[]>>();
const INITIAL_LIBRARY_CACHE_KEY = "default";

/** Module-level singleton BroadcastChannel for library mutations. Reused
 * across every PUT/DELETE flush so we don't churn a new channel + close per
 * write — at the default 600 ms debounce the cost is negligible, but if a
 * future caller removes the debounce the per-write allocation showed up. We
 * also never call `close()`: the channel lives for the document lifetime,
 * matching peer tabs' listener lifetime. `null` when the API isn't
 * available (SSR / very old browsers / private-mode iframe). */
const libraryBroadcast: BroadcastChannel | null = (() => {
  if (typeof BroadcastChannel === "undefined") return null;
  try {
    return new BroadcastChannel("grove-library");
  } catch {
    return null;
  }
})();
function fetchInitialLibrary(): Promise<unknown[]> {
  const cached = initialLibraryCache.get(INITIAL_LIBRARY_CACHE_KEY);
  if (cached) return cached;
  const p = apiClient
    .get<LibraryFile>("/api/v1/library")
    .then((file) => (file.libraryItems ?? []) as unknown[])
    .catch((err) => {
      // Drop the failed promise from the cache so a later mount can retry,
      // rather than every subsequent mount inheriting the same rejection.
      initialLibraryCache.delete(INITIAL_LIBRARY_CACHE_KEY);
      throw err;
    });
  initialLibraryCache.set(INITIAL_LIBRARY_CACHE_KEY, p);
  return p;
}

export function SketchCanvas({
  scene,
  onChange,
  onExcalidrawAPI,
  locked,
}: Props) {
  // Remote-driven updates are surfaced via key-based remount in the parent
  // (SketchPage); nothing to track here.
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);

  // Library is fetched once at mount. `null` until the first fetch resolves;
  // we hold off rendering Excalidraw until then because `initialData` is read
  // exactly once at Excalidraw's mount — late-binding the library would mean
  // it never shows up in the UI without a remount.
  const [initialLibrary, setInitialLibrary] = useState<unknown[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchInitialLibrary()
      .then((items) => {
        if (!cancelled) setInitialLibrary(items);
      })
      .catch((err) => {
        // Don't block the canvas if the backend hiccups — show Excalidraw
        // with an empty library, user can install fresh.
        console.warn("[SketchCanvas] failed to load library, starting empty", err);
        if (!cancelled) setInitialLibrary([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Refresh the live Excalidraw library when a peer tab installs a new
  // library via the "Add to Excalidraw" callback flow. The callback tab
  // posts on a BroadcastChannel after PUT-ing; we react by re-fetching and
  // calling `updateLibrary({ merge: true })` so the new items appear without
  // requiring a manual reload.
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel("grove-library");
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleRefresh = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        apiClient
          .get<LibraryFile>("/api/v1/library")
          .then((file) => {
            const api = apiRef.current;
            if (!api) return;
            api.updateLibrary({
              libraryItems: (file.libraryItems ?? []) as LibraryItems,
              merge: true,
            });
          })
          .catch((err) => {
            console.warn("[SketchCanvas] library refresh failed", err);
          });
      }, LIBRARY_BROADCAST_DEBOUNCE_MS);
    };
    ch.onmessage = (ev) => {
      if (ev.data?.type !== "library-changed") return;
      // Same-tab echo: addLibrary hook posts on its own BroadcastChannel
      // instance, which the spec DOES deliver to other instances in the
      // same tab. Skip those — we already have the latest from the PUT.
      if (ev.data?.tab === getLibraryBroadcastTabNonce()) return;
      // Coalesce bursts of "library-changed" pings (e.g. a peer tab
      // installs three libraries back-to-back) into one refresh.
      scheduleRefresh();
    };
    return () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      ch.close();
    };
  }, []);

  // Debounced PUT of the current library snapshot. We hold the latest items
  // in a ref so the timer's closure always sees the freshest payload without
  // re-creating the timer per change.
  const pendingItemsRef = useRef<readonly unknown[] | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // `keepalive` lets the request survive page unload (browser caps body at
  // ~64 KB; libraries are well under that in practice). Used by the unmount
  // and `pagehide` paths so a quick tab close doesn't drop the user's last
  // library edit.
  const flushLibrary = useCallback((useKeepalive = false) => {
    timerRef.current = null;
    const items = pendingItemsRef.current;
    // Last-write-wins on PUT: clearing pendingItemsRef here means any
    // subsequent edit that fires before this network call resolves will
    // queue a fresh PUT on the next timer. Two flushes can race in flight
    // (no in-flight coalescing) but the server stores whichever response
    // lands second — acceptable, since the user's most recent edit is by
    // definition the source they typed last.
    pendingItemsRef.current = null;
    if (!items) return;
    // After a successful local PUT/DELETE, ping peer Sketch tabs (other
    // browser tabs / windows of the same project) via BroadcastChannel so
    // they re-fetch and reflect the change. The `tab` field carries our
    // per-tab nonce so the broadcast listener in THIS tab can dedupe and
    // not re-fetch our own writes. Without this, a rename in tab A is
    // invisible in tab B until manual reload.
    const broadcast = () => {
      try {
        libraryBroadcast?.postMessage({
          type: "library-changed",
          tab: getLibraryBroadcastTabNonce(),
        });
      } catch {
        // postMessage can throw if the channel was closed by the browser
        // (rare); silent on failure — peer tabs just won't auto-refresh.
      }
    };
    // Reset == empty list. Excalidraw's "Reset library" action (in the
    // library panel's "..." menu) fires onLibraryChange with []; mapping
    // that to DELETE is the only way to actually wipe backend state, since
    // PUT-upsert never removes items by absence.
    if (items.length === 0) {
      apiClient.delete("/api/v1/library")
        .then(broadcast)
        .catch((err) => {
          console.warn("[SketchCanvas] library DELETE failed", err);
        });
      return;
    }
    if (useKeepalive) {
      // pagehide path: fire-and-forget, no broadcast (browser may not run
      // any JS after this point anyway; peer tabs will reconcile on their
      // own next interaction).
      apiClient
        .putKeepalive("/api/v1/library", { libraryItems: items })
        .catch((err) => {
          console.warn("[SketchCanvas] library PUT (keepalive) failed", err);
        });
      return;
    }
    apiClient
      .put<{ libraryItems: readonly unknown[] }, LibraryFile>("/api/v1/library", {
        libraryItems: items,
      })
      .then(broadcast)
      .catch((err) => {
        console.warn("[SketchCanvas] library PUT failed", err);
      });
  }, []);
  // Mirror the latest flushLibrary into a ref so window-level listeners
  // (pagehide / pageshow) always reach the current closure without having
  // to re-bind the listener on every render.
  const flushLibraryRef = useRef(flushLibrary);
  useEffect(() => {
    flushLibraryRef.current = flushLibrary;
  }, [flushLibrary]);
  const handleLibraryChange = (items: readonly unknown[]) => {
    pendingItemsRef.current = items;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => flushLibraryRef.current(false), LIBRARY_PUT_DEBOUNCE_MS);
  };
  // Flush pending changes on tab close (`pagehide` — unmount doesn't fire
  // when the tab is closed) and on component unmount (route change). Both
  // paths use `keepalive` because in either case the fetch may outlive its
  // owning context. Calling `flushLibrary` twice is idempotent: the first
  // call clears `pendingItemsRef`, so a follow-up (e.g. on `location.reload()`
  // where `pagehide` and unmount fire in sequence) is a no-op.
  //
  // Also handle bfcache restore (`pageshow` with `event.persisted`): the
  // page just woke from the back-forward cache, so any in-memory state we
  // held about pending edits is stale relative to whatever happened in
  // other tabs while we were frozen. Drop pending writes and re-fetch the
  // initial library snapshot so the canvas resyncs from disk.
  useEffect(() => {
    const onPageHide = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      flushLibraryRef.current(true);
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      pendingItemsRef.current = null;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      // Bust the module-level cache and re-fetch from the server.
      initialLibraryCache.delete(INITIAL_LIBRARY_CACHE_KEY);
      fetchInitialLibrary()
        .then((items) => {
          const api = apiRef.current;
          if (!api) return;
          api.updateLibrary({
            libraryItems: items as LibraryItems,
            merge: false,
          });
        })
        .catch((err) => {
          console.warn("[SketchCanvas] library refetch after bfcache restore failed", err);
        });
    };
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        flushLibraryRef.current(true);
      }
    };
  }, []);

  const initial = scene as ExcalidrawScene | null;
  return (
    <div className="w-full h-full">
      <Suspense
        fallback={
          <div
            className="flex items-center justify-center h-full text-sm"
            style={{ color: "var(--color-text-muted)" }}
          >
            Loading canvas…
          </div>
        }
      >
        {initialLibrary !== null && (
          <LazyExcalidraw
            initialData={
              initial
                ? {
                    elements: initial.elements ?? [],
                    appState: sanitizeAppState(initial.appState),
                    files: initial.files ?? {},
                  }
                : undefined
            }
            initialLibraryItems={initialLibrary}
            libraryReturnUrl={window.location.href}
            onLibraryChange={handleLibraryChange}
            excalidrawAPI={(api) => {
              apiRef.current = api;
              onExcalidrawAPI?.(api);
            }}
            onChange={(elements, appState, files) => {
              onChange({
                type: "excalidraw",
                version: 2,
                source: "grove",
                elements,
                appState,
                files,
              });
            }}
            viewModeEnabled={locked}
          />
        )}
      </Suspense>
    </div>
  );
}
