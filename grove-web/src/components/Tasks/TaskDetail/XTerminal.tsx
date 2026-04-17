import { useEffect, useRef, useMemo } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { useTerminalTheme } from "../../../context";
import { appendHmacToUrl } from "../../../api/client";
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
  const { terminalTheme } = useTerminalTheme();
  const terminalThemeRef = useRef(terminalTheme);
  terminalThemeRef.current = terminalTheme;
  const mountRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // Store callbacks in refs to avoid re-render issues
  const onConnectedRef = useRef(onConnected);
  const onDisconnectedRef = useRef(onDisconnected);
  onConnectedRef.current = onConnected;
  onDisconnectedRef.current = onDisconnected;

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
        if (currentCacheKey && getCached(currentCacheKey)) {
          detachTerminal(currentCacheKey);
        }
        terminalRef.current = null;
        fitAddonRef.current = null;
        wsRef.current = null;
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

    const webLinksAddon = new WebLinksAddon();
    terminal.loadAddon(webLinksAddon);

    terminal.open(container);
    terminalRef.current = terminal;
    fitAddon.fit();

    // Prevent Escape from bubbling up and causing terminal to lose focus
    terminal.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && e.key === "Escape") {
        e.stopPropagation();
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
    let isTaskMode = false;
    if (wsUrl) {
      baseUrl = wsUrl;
    } else if (projectId && taskId) {
      baseUrl = `${protocol}//${host}/api/v1/projects/${projectId}/tasks/${taskId}/terminal`;
      isTaskMode = true;
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
        if (isTaskMode) {
          terminal.writeln("\x1b[32mConnected to session\x1b[0m");
        } else {
          terminal.writeln("\x1b[32mConnected to terminal\x1b[0m");
        }
        terminal.writeln("");
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
        terminal.dispose();
        container.remove();
      }

      terminalRef.current = null;
      fitAddonRef.current = null;
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionKey, cacheKey]);

  // Live theme switching without reconnecting WebSocket
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = terminalTheme.colors;
    }
  }, [terminalTheme]);

  return (
    <div
      className="w-full h-full"
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
    </div>
  );
}
