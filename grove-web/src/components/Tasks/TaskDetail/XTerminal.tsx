import { useCallback, useEffect, useRef, useMemo, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import { useTerminalTheme } from "../../../context";
import { appendHmacToUrl } from "../../../api/client";
import { openExternalUrl } from "../../../utils/openExternal";
import { PreviewSearchBar } from "../../Review/PreviewSearchBar";
import {
  getCached,
  setCached,
  detachTerminal,
  disposeTerminal,
  makeTerminalCacheKey,
  type CachedTerminal,
} from "./terminalCache";

interface XTerminalProps {
  /** Task terminal mode: provide projectId and taskId to connect to tmux session */
  projectId?: string;
  taskId?: string;
  /** Simple terminal mode: provide cwd for a plain shell */
  cwd?: string;
  /** WebSocket URL (defaults to current host) */
  wsUrl?: string;
  /** Called when terminal is connected */
  onConnected?: () => void;
  /** Called when terminal is disconnected */
  onDisconnected?: () => void;
  /**
   * Unique instance ID for caching (e.g. FlexLayout tab node id).
   * When provided, terminal survives unmount and can be reattached.
   */
  instanceId?: string;
}

export function XTerminal({
  projectId,
  taskId,
  cwd,
  wsUrl,
  onConnected,
  onDisconnected,
  instanceId,
}: XTerminalProps) {
  "use no memo";
  const { terminalTheme } = useTerminalTheme();
  const terminalThemeRef = useRef(terminalTheme);
  const mountRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchTotal, setSearchTotal] = useState(0);
  const [searchCurrent, setSearchCurrent] = useState(-1);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Store callbacks in refs to avoid re-render issues
  const onConnectedRef = useRef(onConnected);
  const onDisconnectedRef = useRef(onDisconnected);

  // Sync prop/context values into refs in effects (cannot mutate refs during
  // render). Refs are only consumed by async ws/event callbacks that run
  // after commit, so the one-tick delay is safe.
  useEffect(() => {
    terminalThemeRef.current = terminalTheme;
  }, [terminalTheme]);
  useEffect(() => {
    onConnectedRef.current = onConnected;
  }, [onConnected]);
  useEffect(() => {
    onDisconnectedRef.current = onDisconnected;
  }, [onDisconnected]);

  // Memoize connection key to detect when we need to reconnect
  const connectionKey = useMemo(() => {
    if (wsUrl) return `url:${wsUrl}`;
    if (projectId && taskId) return `task:${projectId}:${taskId}`;
    return `shell:${cwd || "home"}`;
  }, [wsUrl, projectId, taskId, cwd]);

  const cacheKey = useMemo(
    () => (instanceId ? makeTerminalCacheKey(connectionKey, instanceId) : null),
    [connectionKey, instanceId],
  );

  // Initialize terminal and WebSocket (or reattach from cache)
  useEffect(() => {
    if (!mountRef.current) return;
    const mount = mountRef.current;
    const currentCacheKey = cacheKey;
    let cancelled = false;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;

    // --- Shared resize observer setup ---
    const setupResizeObserver = (
      terminal: Terminal,
      fitAddon: FitAddon,
      getWs: () => WebSocket | null,
    ): ResizeObserver => {
      const observer = new ResizeObserver(() => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          const { offsetWidth, offsetHeight } = mount;
          if (offsetWidth === 0 || offsetHeight === 0) return;
          fitAddon.fit();
          terminal.scrollToBottom();
          const ws = getWs();
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: "resize",
                cols: terminal.cols,
                rows: terminal.rows,
              }),
            );
          }
        }, 250);
      });
      observer.observe(mount);
      return observer;
    };

    // --- Try cache reattach ---
    let cached: CachedTerminal | undefined = currentCacheKey
      ? getCached(currentCacheKey)
      : undefined;

    // If cached WebSocket is dead, dispose stale cache so a fresh terminal is created below
    if (cached && cached.ws?.readyState !== WebSocket.OPEN) {
      disposeTerminal(currentCacheKey!);
      cached = undefined;
    }

    if (cached) {
      // Move cached container back into the visible mount point
      mount.appendChild(cached.container);
      terminalRef.current = cached.terminal;
      fitAddonRef.current = cached.fitAddon;
      wsRef.current = cached.ws;

      if (!cached.searchAddon) {
        cached.searchAddon = new SearchAddon();
        cached.terminal.loadAddon(cached.searchAddon);
      }
      searchAddonRef.current = cached.searchAddon;

      const searchDisposable = cached.searchAddon.onDidChangeResults((event: { resultIndex: number; resultCount: number }) => {
        setSearchTotal(event.resultCount);
        setSearchCurrent(event.resultIndex);
      });

      // Re-bind data handler so it references the current component's wsRef
      cached.dataDisposable.dispose();
      cached.dataDisposable = cached.terminal.onData((data) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(data);
        }
      });

      // Mark active so WS onclose knows to fire callback
      cached.active = true;
      cached.onDisconnected = () => onDisconnectedRef.current?.();

      // Note: addons (WebLinksAddon, FitAddon) persist on the Terminal instance across detach/reattach

      // Apply current theme
      cached.terminal.options.theme = terminalThemeRef.current.colors;

      // Intercept key events for search and Escape bubbling
      cached.terminal.attachCustomKeyEventHandler((e) => {
        if (e.type === "keydown") {
          const isMac = navigator.platform.toLowerCase().includes("mac");
          const isModF = isMac ? (e.metaKey && e.key === "f") : (e.ctrlKey && e.key === "f");
          if (isModF) {
            e.preventDefault();
            e.stopPropagation();
            setSearchOpen(true);
            return false;
          }
          if (e.key === "Escape") {
            e.stopPropagation();
          }
        }
        return true;
      });

      // Fit & notify after layout
      requestAnimationFrame(() => {
        if (cancelled) return;
        cached.fitAddon.fit();
        cached.terminal.scrollToBottom();
        cached.terminal.focus();

        // Send resize to backend (terminal size may have changed)
        if (cached.ws?.readyState === WebSocket.OPEN) {
          cached.ws.send(
            JSON.stringify({
              type: "resize",
              cols: cached.terminal.cols,
              rows: cached.terminal.rows,
            }),
          );
          onConnectedRef.current?.();
        } else {
          // WS died while terminal was cached (shouldn't reach here due to pre-check above)
          onDisconnectedRef.current?.();
        }
      });

      const resizeObserver = setupResizeObserver(
        cached.terminal,
        cached.fitAddon,
        () => wsRef.current,
      );

      return () => {
        cancelled = true;
        resizeObserver.disconnect();
        if (resizeTimer) clearTimeout(resizeTimer);
        searchDisposable.dispose();
        if (currentCacheKey && getCached(currentCacheKey)) {
          detachTerminal(currentCacheKey);
        }
        terminalRef.current = null;
        fitAddonRef.current = null;
        wsRef.current = null;
        searchAddonRef.current = null;
      };
    }

    // --- Create new terminal ---
    // Dispose any stale cache entry with the same key (e.g. tab closed then reopened with recycled ID)
    if (currentCacheKey) {
      disposeTerminal(currentCacheKey);
    }

    const container = document.createElement("div");
    container.style.cssText = "width:100%;height:100%";
    mount.appendChild(container);

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily:
        '"SF Mono", "Monaco", "Inconsolata", "Fira Code", "Fira Mono", "Droid Sans Mono", "Source Code Pro", Consolas, "Liberation Mono", Menlo, Courier, monospace',
      theme: terminalThemeRef.current.colors,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    fitAddonRef.current = fitAddon;

    // Default WebLinksAddon uses window.open(), which is blocked / mis-routed
    // inside the Tauri webview. Route clicks through our IPC opener so the
    // OS default browser handles the URL in both web and GUI modes.
    const webLinksAddon = new WebLinksAddon((event, uri) => {
      // xterm fires this on plain click too — gate on the platform-appropriate
      // modifier (Cmd on macOS, Ctrl elsewhere) to match terminal conventions.
      const isMac = navigator.platform.toLowerCase().includes("mac");
      const modifierHeld = isMac ? event.metaKey : event.ctrlKey;
      if (!modifierHeld) return;
      openExternalUrl(uri);
    });
    terminal.loadAddon(webLinksAddon);

    // Initialize SearchAddon for terminal
    const searchAddon = new SearchAddon();
    terminal.loadAddon(searchAddon);
    searchAddonRef.current = searchAddon;

    const searchDisposable = searchAddon.onDidChangeResults((event: { resultIndex: number; resultCount: number }) => {
      setSearchTotal(event.resultCount);
      setSearchCurrent(event.resultIndex);
    });

    terminal.open(container);

    // GPU-accelerated renderer. Big win for high-throughput output (build
    // logs, streaming AI tokens, large file dumps) and high-DPI displays.
    // Must run AFTER terminal.open() because it needs a real canvas context.
    // Falls back gracefully — if context creation fails or the GPU later
    // drops the context, we just dispose the addon and xterm reverts to
    // the DOM/canvas renderer.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      terminal.loadAddon(webgl);
    } catch (err) {
      console.warn("[xterm] WebGL renderer unavailable, using DOM fallback", err);
    }

    terminalRef.current = terminal;
    fitAddon.fit();

    // Intercept keyboard shortcuts like Ctrl+F or Cmd+F for search and Escape bubbling
    terminal.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown") {
        const isMac = navigator.platform.toLowerCase().includes("mac");
        const isModF = isMac ? (e.metaKey && e.key === "f") : (e.ctrlKey && e.key === "f");
        
        if (isModF) {
          e.preventDefault();
          e.stopPropagation();
          setSearchOpen(true);
          return false;
        }
        
        if (e.key === "Escape") {
          e.stopPropagation();
        }
      }
      return true;
    });

    // Handle terminal input → WS
    const dataDisposable = terminal.onData((data) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(data);
      }
    });

    // Store in cache immediately (ws will be updated once connected)
    if (currentCacheKey) {
      setCached(currentCacheKey, {
        terminal,
        fitAddon,
        searchAddon,
        ws: null,
        container,
        dataDisposable,
        active: true,
        onDisconnected: () => onDisconnectedRef.current?.(),
        bracketedPasteReady: false,
      });
    }

    const resizeObserver = setupResizeObserver(terminal, fitAddon, () =>
      wsRef.current,
    );

    // Build WebSocket URL
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host;
    const cols = terminal.cols;
    const rows = terminal.rows;
    const params = new URLSearchParams();
    params.set("cols", cols.toString());
    params.set("rows", rows.toString());

    let baseUrl: string;
    if (wsUrl) {
      baseUrl = wsUrl;
    } else if (projectId && taskId) {
      baseUrl = `${protocol}//${host}/api/v1/projects/${projectId}/tasks/${taskId}/terminal`;
    } else {
      baseUrl = `${protocol}//${host}/api/v1/terminal`;
      if (cwd) params.set("cwd", cwd);
    }

    // Sign URL and connect WebSocket
    const connect = async () => {
      const url = await appendHmacToUrl(`${baseUrl}?${params.toString()}`);
      if (cancelled) return;

      const ws = new WebSocket(url);
      wsRef.current = ws;

      // Update cache entry with actual WS
      if (currentCacheKey) {
        const entry = getCached(currentCacheKey);
        if (entry) entry.ws = ws;
      }

      ws.onopen = () => {
        terminal.focus();
        onConnectedRef.current?.();
      };

      ws.onmessage = (event) => {
        // Track bracketed-paste readiness so pasteToTerminal can wait for the
        // shell's line editor to be ready. Shell sends `\x1b[?2004h` (on) and
        // `\x1b[?2004l` (off) around prompts.
        if (currentCacheKey && typeof event.data === "string") {
          const entry = getCached(currentCacheKey);
          if (entry) {
            if (event.data.includes("\x1b[?2004h")) entry.bracketedPasteReady = true;
            else if (event.data.includes("\x1b[?2004l")) entry.bracketedPasteReady = false;
          }
        }
        terminal.write(event.data);
      };

      ws.onclose = () => {
        terminal.writeln("");
        terminal.writeln("\x1b[31mDisconnected from terminal\x1b[0m");
        if (currentCacheKey) {
          // Route through cache entry so detached terminals don't fire callback
          const entry = getCached(currentCacheKey);
          if (entry?.active && entry.onDisconnected) {
            entry.onDisconnected();
          }
        } else if (!cancelled) {
          onDisconnectedRef.current?.();
        }
      };

      ws.onerror = (error) => {
        console.error("WebSocket error:", error);
        terminal.writeln("\x1b[31mWebSocket error\x1b[0m");
      };
    };
    connect();

    // Cleanup
    return () => {
      cancelled = true;
      resizeObserver.disconnect();
      if (resizeTimer) clearTimeout(resizeTimer);
      searchDisposable.dispose();

      if (currentCacheKey && getCached(currentCacheKey)) {
        // Cache mode: detach but keep alive
        const entry = getCached(currentCacheKey);
        if (entry) entry.ws = wsRef.current;
        detachTerminal(currentCacheKey);
      } else if (!currentCacheKey) {
        // Non-cached: full dispose
        dataDisposable.dispose();
        if (wsRef.current) {
          wsRef.current.close();
          wsRef.current = null;
        }
        searchAddon.dispose();
        terminal.dispose();
        container.remove();
      }

      terminalRef.current = null;
      fitAddonRef.current = null;
      wsRef.current = null;
      searchAddonRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: connectionKey + cacheKey gate the full reconnect; reading other props live via refs
  }, [connectionKey, cacheKey]);

  // Live theme switching without reconnecting WebSocket
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = terminalTheme.colors;
    }
  }, [terminalTheme]);

  // Global keydown handler to open search
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toLowerCase().includes("mac");
      const isModF = isMac ? (e.metaKey && e.key === "f") : (e.ctrlKey && e.key === "f");
      if (isModF) {
        if (panelRef.current?.contains(document.activeElement)) {
          e.preventDefault();
          e.stopPropagation();
          setSearchOpen(true);
        }
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleGlobalKeyDown, true);
    };
  }, []);

  // Mirror an empty/closed search by zeroing the counters before the
  // imperative effect runs — keeps setState out of the effect body. The
  // effect itself only calls into the addon (clearDecorations / findNext).
  const handleSearchQueryChange = useCallback((q: string) => {
    setSearchQuery(q);
    if (!q) {
      setSearchTotal(0);
      setSearchCurrent(-1);
    }
  }, []);

  // Drive the SearchAddon to reflect query/open state. State synchronization
  // is done at the input boundary (handleSearchQueryChange / handleCloseSearch),
  // so this effect only issues imperative addon calls.
  useEffect(() => {
    const searchAddon = searchAddonRef.current;
    if (!searchAddon) return;

    if (!searchOpen || !searchQuery) {
      searchAddon.clearDecorations();
      return;
    }

    searchAddon.findNext(searchQuery, {
      decorations: {
        matchBackground: "#e5c07b",
        activeMatchBackground: "#528bff",
        matchOverviewRuler: "#e5c07b",
        activeMatchColorOverviewRuler: "#528bff",
      },
      incremental: true,
    });
  }, [searchQuery, searchOpen]);

  const handleSearchNext = () => {
    const searchAddon = searchAddonRef.current;
    if (!searchAddon || !searchQuery) return;
    searchAddon.findNext(searchQuery, {
      decorations: {
        matchBackground: "#e5c07b",
        activeMatchBackground: "#528bff",
        matchOverviewRuler: "#e5c07b",
        activeMatchColorOverviewRuler: "#528bff",
      },
    });
  };

  const handleSearchPrev = () => {
    const searchAddon = searchAddonRef.current;
    if (!searchAddon || !searchQuery) return;
    searchAddon.findPrevious(searchQuery, {
      decorations: {
        matchBackground: "#e5c07b",
        activeMatchBackground: "#528bff",
        matchOverviewRuler: "#e5c07b",
        activeMatchColorOverviewRuler: "#528bff",
      },
    });
  };

  const handleCloseSearch = () => {
    setSearchOpen(false);
    setSearchQuery("");
    setSearchTotal(0);
    setSearchCurrent(-1);

    const searchAddon = searchAddonRef.current;
    if (searchAddon) {
      searchAddon.clearDecorations();
    }

    if (terminalRef.current) {
      terminalRef.current.focus();
    }
  };

  return (
    <div
      ref={panelRef}
      className="w-full h-full relative"
      style={{
        backgroundColor: terminalTheme.colors.background,
        padding: "12px 14px",
      }}
      onClick={() => terminalRef.current?.focus()}
    >
      <div
        ref={mountRef}
        data-hotkeys-terminal
        className="w-full h-full"
      />
      {searchOpen && (
        <PreviewSearchBar
          query={searchQuery}
          onQueryChange={handleSearchQueryChange}
          total={searchTotal}
          current={searchCurrent}
          onNext={handleSearchNext}
          onPrev={handleSearchPrev}
          onClose={handleCloseSearch}
          className="absolute right-6 top-4 z-[60]"
        />
      )}
    </div>
  );
}
