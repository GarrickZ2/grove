import { useEffect, useRef, useMemo } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";

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

    // Create terminal
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily:
        '"SF Mono", "Monaco", "Inconsolata", "Fira Code", "Fira Mono", "Droid Sans Mono", "Source Code Pro", Consolas, "Liberation Mono", Menlo, Courier, monospace',
      theme: {
        background: "#0d0d0d",
        foreground: "#f8f8f2",
        cursor: "#f8f8f2",
        cursorAccent: "#0d0d0d",
        selectionBackground: "#44475a",
        black: "#21222c",
        red: "#ff5555",
        green: "#50fa7b",
        yellow: "#f1fa8c",
        blue: "#bd93f9",
        magenta: "#ff79c6",
        cyan: "#8be9fd",
        white: "#f8f8f2",
        brightBlack: "#6272a4",
        brightRed: "#ff6e6e",
        brightGreen: "#69ff94",
        brightYellow: "#ffffa5",
        brightBlue: "#d6acff",
        brightMagenta: "#ff92df",
        brightCyan: "#a4ffff",
        brightWhite: "#ffffff",
      },
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
        terminal.writeln("\x1b[32mConnected to tmux session\x1b[0m");
      } else {
        terminal.writeln("\x1b[32mConnected to terminal\x1b[0m");
      }
      terminal.writeln("");
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

    // Handle terminal input
    terminal.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      // Send resize message to backend
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        const resizeMsg = JSON.stringify({
          type: "resize",
          cols: terminal.cols,
          rows: terminal.rows,
        });
        wsRef.current.send(resizeMsg);
      }
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

  return (
    <div
      ref={containerRef}
      className="w-full h-full"
      style={{ backgroundColor: "#0d0d0d" }}
    />
  );
}
