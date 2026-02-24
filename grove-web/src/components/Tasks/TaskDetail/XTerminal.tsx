import { useEffect, useRef, useMemo } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { useTerminalTheme } from "../../../context";

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
}

export function XTerminal({
  projectId,
  taskId,
  cwd,
  wsUrl,
  onConnected,
  onDisconnected,
}: XTerminalProps) {
  const { terminalTheme } = useTerminalTheme();
  const terminalThemeRef = useRef(terminalTheme);
  terminalThemeRef.current = terminalTheme;
  const containerRef = useRef<HTMLDivElement>(null);
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

  // Initialize terminal and WebSocket
  useEffect(() => {
    if (!containerRef.current) return;

    // Create terminal with theme from context
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily:
        '"SF Mono", "Monaco", "Inconsolata", "Fira Code", "Fira Mono", "Droid Sans Mono", "Source Code Pro", Consolas, "Liberation Mono", Menlo, Courier, monospace',
      theme: terminalThemeRef.current.colors,
      allowProposedApi: true,
    });

    // Add fit addon
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    fitAddonRef.current = fitAddon;

    // Add web links addon
    const webLinksAddon = new WebLinksAddon();
    terminal.loadAddon(webLinksAddon);

    // Open terminal in container
    terminal.open(containerRef.current);
    terminalRef.current = terminal;

    // Fit terminal to container
    fitAddon.fit();

    // Build WebSocket URL
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.host;

    // Get terminal dimensions
    const cols = terminal.cols;
    const rows = terminal.rows;

    // Build query string
    const params = new URLSearchParams();
    params.set("cols", cols.toString());
    params.set("rows", rows.toString());

    let baseUrl: string;
    let isTaskMode = false;
    if (wsUrl) {
      // Use provided wsUrl
      baseUrl = wsUrl;
    } else if (projectId && taskId) {
      // Task terminal mode - connect to tmux session
      baseUrl = `${protocol}//${host}/api/v1/projects/${projectId}/tasks/${taskId}/terminal`;
      isTaskMode = true;
    } else {
      // Simple terminal mode - plain shell
      baseUrl = `${protocol}//${host}/api/v1/terminal`;
      if (cwd) params.set("cwd", cwd);
    }

    const url = `${baseUrl}?${params.toString()}`;

    // Create WebSocket connection
    const ws = new WebSocket(url);
    wsRef.current = ws;

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
      terminal.write(event.data);
    };

    ws.onclose = () => {
      terminal.writeln("");
      terminal.writeln("\x1b[31mDisconnected from terminal\x1b[0m");
      onDisconnectedRef.current?.();
    };

    ws.onerror = (error) => {
      console.error("WebSocket error:", error);
      terminal.writeln("\x1b[31mWebSocket error\x1b[0m");
    };

    // Prevent Escape from bubbling up and causing terminal to lose focus
    terminal.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && e.key === "Escape") {
        e.stopPropagation();
      }
      return true; // let xterm handle all keys
    });

    // Handle terminal input
    terminal.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    // Handle resize with debounce to avoid excessive fits during animations
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!containerRef.current) return;

        // Skip resize when container is hidden (e.g. inactive FlexLayout tab)
        const { offsetWidth, offsetHeight } = containerRef.current;
        if (offsetWidth === 0 || offsetHeight === 0) return;

        fitAddon.fit();

        // Scroll to bottom after fit to ensure latest content is visible
        terminal.scrollToBottom();

        // Send resize message to backend
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          const resizeMsg = JSON.stringify({
            type: "resize",
            cols: terminal.cols,
            rows: terminal.rows,
          });
          wsRef.current.send(resizeMsg);
        }
      }, 250);
    });
    resizeObserver.observe(containerRef.current);

    // Cleanup
    return () => {
      resizeObserver.disconnect();
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [connectionKey]); // Re-run when connection parameters change

  // Live theme switching without reconnecting WebSocket
  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = terminalTheme.colors;
    }
  }, [terminalTheme]);

  return (
    <div
      ref={containerRef}
      data-hotkeys-terminal
      className="w-full h-full"
      style={{ backgroundColor: terminalTheme.colors.background }}
      onClick={() => terminalRef.current?.focus()}
    />
  );
}
