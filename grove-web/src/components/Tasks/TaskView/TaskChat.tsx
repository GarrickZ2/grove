import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  MessageSquare,
  Play,
  ChevronRight,
  ChevronDown,
  Maximize2,
  Minimize2,
  Send,
  Loader2,
  CheckCircle2,
  Circle,
  Wrench,
  Brain,
  ListTodo,
} from "lucide-react";
import { Button, MarkdownRenderer } from "../../ui";
import type { Task } from "../../../data/types";
import { getApiHost } from "../../../api/client";

// ─── Types ───────────────────────────────────────────────────────────────────

interface TaskChatProps {
  projectId: string;
  task: Task;
  collapsed?: boolean;
  onExpand?: () => void;
  onStartSession: () => void;
  autoStart?: boolean;
  onConnected?: () => void;
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
}

type ToolMessage = {
  type: "tool";
  id: string;
  title: string;
  status: string;
  content?: string;
  collapsed: boolean;
};

type ChatMessage =
  | { type: "user"; content: string }
  | { type: "assistant"; content: string; complete: boolean }
  | { type: "thinking"; content: string; collapsed: boolean }
  | ToolMessage
  | { type: "system"; content: string };

interface PlanEntry {
  content: string;
  status: string;
}

/** Grouped messages for rendering: consecutive tool calls become a single group */
type RenderGroup =
  | { kind: "message"; message: ChatMessage; index: number }
  | { kind: "tools"; items: { message: ToolMessage; index: number }[] };

// ─── Constants ───────────────────────────────────────────────────────────────


// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Group consecutive tool-call messages for compact rendering */
function groupMessages(messages: ChatMessage[]): RenderGroup[] {
  const groups: RenderGroup[] = [];
  let toolBatch: { message: ToolMessage; index: number }[] = [];

  const flushTools = () => {
    if (toolBatch.length > 0) {
      groups.push({ kind: "tools", items: [...toolBatch] });
      toolBatch = [];
    }
  };

  messages.forEach((msg, i) => {
    if (msg.type === "tool") {
      toolBatch.push({ message: msg, index: i });
    } else {
      flushTools();
      groups.push({ kind: "message", message: msg, index: i });
    }
  });
  flushTools();
  return groups;
}

// ─── Main Component ──────────────────────────────────────────────────────────

export function TaskChat({
  projectId,
  task,
  collapsed = false,
  onExpand,
  onStartSession,
  autoStart = false,
  onConnected: onConnectedProp,
  fullscreen = false,
  onToggleFullscreen,
}: TaskChatProps) {
  const [isConnected, setIsConnected] = useState(false);
  const [sessionStarted, setSessionStarted] = useState(true);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [selectedModel, setSelectedModel] = useState("");
  const [permissionLevel, setPermissionLevel] = useState("");
  const [modelOptions, setModelOptions] = useState<{label: string; value: string}[]>([]);
  const [modeOptions, setModeOptions] = useState<{label: string; value: string}[]>([]);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [showPermMenu, setShowPermMenu] = useState(false);
  const [planEntries, setPlanEntries] = useState<PlanEntry[]>([]);
  const [showPlan, setShowPlan] = useState(true);
  const wsRef = useRef<WebSocket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const permMenuRef = useRef<HTMLDivElement>(null);

  const isLive = task.status === "live";
  const showChat = isLive || sessionStarted;

  // Group messages for rendering
  const messageGroups = useMemo(() => groupMessages(messages), [messages]);

  // Auto-start
  useEffect(() => {
    if (autoStart && !isLive) setSessionStarted(true);
  }, [autoStart, isLive]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Close dropdown menus when clicking outside
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) setShowModelMenu(false);
      if (permMenuRef.current && !permMenuRef.current.contains(e.target as Node)) setShowPermMenu(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // WebSocket connection
  useEffect(() => {
    if (!showChat) return;

    const host = getApiHost();
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${host}/api/v1/projects/${projectId}/tasks/${task.id}/acp/ws`;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setMessages((prev) => [...prev, { type: "system", content: "Connecting..." }]);
    };
    ws.onmessage = (event) => {
      try { handleServerMessage(JSON.parse(event.data)); } catch { /* ignore */ }
    };
    ws.onclose = () => {
      setIsConnected(false);
    };
    ws.onerror = () => {
      setMessages((prev) => [...prev, { type: "system", content: "Connection error." }]);
    };
    return () => { ws.close(); wsRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showChat, projectId, task.id]);

  // ─── WebSocket message handler ───────────────────────────────────────────

  const handleServerMessage = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (msg: any) => {
      switch (msg.type) {
        case "session_ready":
          setIsConnected(true);
          onConnectedProp?.();
          // Dynamic modes/models from agent
          if (msg.available_modes?.length) {
            setModeOptions(msg.available_modes.map((m: { id: string; name: string }) => ({ label: m.name, value: m.id })));
          }
          if (msg.current_mode_id) setPermissionLevel(msg.current_mode_id);
          if (msg.available_models?.length) {
            setModelOptions(msg.available_models.map((m: { id: string; name: string }) => ({ label: m.name, value: m.id })));
          }
          if (msg.current_model_id) setSelectedModel(msg.current_model_id);
          // Replace "Connecting..." with friendly connected message
          setMessages((prev) => {
            const filtered = prev.filter((m) => !(m.type === "system" && m.content === "Connecting..."));
            return [...filtered, { type: "system", content: "Connected to Claude Code" }];
          });
          break;
        case "message_chunk":
          setMessages((prev) => {
            // Find last incomplete assistant message (may not be the very last)
            for (let i = prev.length - 1; i >= 0; i--) {
              const m = prev[i];
              if (m.type === "assistant" && !m.complete) {
                const updated = [...prev];
                updated[i] = { ...m, content: m.content + msg.text };
                return updated;
              }
              // Stop searching if we hit a user message (new turn)
              if (m.type === "user") break;
            }
            // Don't create new message for whitespace-only chunks
            if (!msg.text.trim()) return prev;
            return [...prev, { type: "assistant", content: msg.text, complete: false }];
          });
          break;
        case "thought_chunk":
          setMessages((prev) => {
            // Find last thinking message (may not be the very last due to interleaved tools)
            for (let i = prev.length - 1; i >= 0; i--) {
              const m = prev[i];
              if (m.type === "thinking") {
                const updated = [...prev];
                updated[i] = { ...m, content: m.content + msg.text };
                return updated;
              }
              if (m.type === "user" || m.type === "assistant") break;
            }
            return [...prev, { type: "thinking", content: msg.text, collapsed: false }];
          });
          break;
        case "tool_call":
          setMessages((prev) => [...prev, {
            type: "tool", id: msg.id, title: msg.title, status: "running", collapsed: true,
          }]);
          break;
        case "tool_call_update":
          setMessages((prev) =>
            prev.map((m) => m.type === "tool" && m.id === msg.id
              ? { ...m, status: msg.status, content: msg.content } : m),
          );
          break;
        case "permission_request":
          setMessages((prev) => [...prev, {
            type: "system", content: `Permission: ${msg.description} (auto-allowed)`,
          }]);
          break;
        case "complete":
          setMessages((prev) =>
            prev.map((m) =>
              m.type === "assistant" && !m.complete ? { ...m, complete: true } : m,
            ),
          );
          setIsBusy(false);
          break;
        case "busy":
          setIsBusy(msg.value);
          break;
        case "error":
          setMessages((prev) => [...prev, { type: "system", content: `Error: ${msg.message}` }]);
          setIsBusy(false);
          break;
        case "user_message":
          setMessages((prev) => [...prev, { type: "user", content: msg.text }]);
          break;
        case "mode_changed":
          setPermissionLevel(msg.mode_id);
          break;
        case "plan_update":
          setPlanEntries(msg.entries ?? []);
          break;
        case "session_ended":
          setIsConnected(false);
          break;
      }
    },
    [onConnectedProp],
  );

  // ─── User actions ────────────────────────────────────────────────────────

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    // User message will be added via backend's UserMessage event (unified for live + replay)
    wsRef.current.send(JSON.stringify({ type: "prompt", text }));
    setInput("");
    setIsBusy(true);
    textareaRef.current?.focus();
  }, [input]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }, [handleSend]);

  const handleStartSession = () => { setSessionStarted(true); onStartSession(); };

  const toggleToolCollapse = (id: string) => {
    setMessages((prev) => prev.map((m) => m.type === "tool" && m.id === id ? { ...m, collapsed: !m.collapsed } : m));
  };

  const toggleThinkingCollapse = (index: number) => {
    setMessages((prev) => prev.map((m, i) => i === index && m.type === "thinking" ? { ...m, collapsed: !m.collapsed } : m));
  };

  // ─── Collapsed mode ──────────────────────────────────────────────────────

  if (collapsed) {
    return (
      <motion.div layout initial={{ width: 48 }} animate={{ width: 48 }}
        transition={{ type: "spring", damping: 25, stiffness: 200 }}
        className="h-full flex flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] overflow-hidden cursor-pointer hover:bg-[var(--color-bg)] transition-colors"
        onClick={onExpand} title="Expand Chat (t)"
      >
        <div className="flex-1 flex flex-col items-center py-2">
          <div className="p-3 text-[var(--color-text-muted)]"><MessageSquare className="w-5 h-5" /></div>
          {isConnected && <div className="p-3"><div className="w-2.5 h-2.5 rounded-full bg-[var(--color-success)] animate-pulse" /></div>}
          <div className="flex-1" />
          <div className="p-3 text-[var(--color-text-muted)]"><ChevronRight className="w-5 h-5" /></div>
        </div>
      </motion.div>
    );
  }

  // ─── Not started ─────────────────────────────────────────────────────────

  if (!showChat) {
    return (
      <motion.div layout className="flex-1 flex flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 bg-[var(--color-bg)] border-b border-[var(--color-border)]">
          <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
            <MessageSquare className="w-4 h-4" /><span>ACP Chat</span>
          </div>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center">
          <MessageSquare className="w-10 h-10 text-[var(--color-text-muted)] mb-3" />
          <p className="text-sm text-[var(--color-text-muted)] mb-3">Chat session not started</p>
          <Button variant="secondary" size="sm" onClick={handleStartSession}>
            <Play className="w-4 h-4 mr-1.5" />Start Chat
          </Button>
        </div>
      </motion.div>
    );
  }

  // ─── Full chat view ──────────────────────────────────────────────────────

  return (
    <motion.div layout initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}
      className={`flex-1 flex flex-col overflow-hidden ${fullscreen ? "" : "rounded-lg border border-[var(--color-border)]"}`}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-[var(--color-bg)] border-b border-[var(--color-border)]">
        <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
          <MessageSquare className="w-4 h-4" /><span>ACP Chat</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className={`w-2.5 h-2.5 rounded-full ${isConnected ? "bg-[var(--color-success)] animate-pulse" : "bg-[var(--color-warning)]"}`} />
          <span className="text-xs text-[var(--color-text-muted)]">{isConnected ? "Connected" : "Connecting..."}</span>
          {onToggleFullscreen && (
            <button onClick={onToggleFullscreen}
              className="ml-1 p-1 text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] rounded transition-colors"
              title={fullscreen ? "Exit Fullscreen" : "Fullscreen"}>
              {fullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            </button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0 bg-[var(--color-bg-secondary)]">
        {messageGroups.map((group, gi) =>
          group.kind === "tools" ? (
            <ToolGroup key={`tg-${gi}`} items={group.items} onToggleItemCollapse={toggleToolCollapse} />
          ) : (
            <MessageItem key={`m-${group.index}`} message={group.message} index={group.index} isBusy={isBusy}
              onToggleToolCollapse={toggleToolCollapse} onToggleThinkingCollapse={toggleThinkingCollapse} />
          )
        )}
        {isBusy && messages[messages.length - 1]?.type !== "assistant" && (
          <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)] py-1">
            <Loader2 className="w-4 h-4 animate-spin" /><span>Thinking...</span>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Plan Section (from ACP Plan notifications) */}
      {planEntries.length > 0 && (
        <div className="border-t border-[var(--color-border)] bg-[var(--color-bg)]">
          <button onClick={() => setShowPlan(!showPlan)}
            className="w-full flex items-center justify-between px-4 py-2 text-sm hover:bg-[var(--color-bg-tertiary)] transition-colors">
            <div className="flex items-center gap-2 text-[var(--color-text-muted)]">
              <motion.div animate={{ rotate: showPlan ? 90 : 0 }} transition={{ duration: 0.15 }}>
                <ChevronRight className="w-3.5 h-3.5" />
              </motion.div>
              <ListTodo className="w-3.5 h-3.5" /><span>Plan</span>
            </div>
            <span className="text-xs text-[var(--color-text-muted)]">
              {planEntries.filter((e) => e.status === "completed").length === planEntries.length
                ? "All Done" : `${planEntries.filter((e) => e.status === "completed").length}/${planEntries.length}`}
            </span>
          </button>
          <AnimatePresence initial={false}>
            {showPlan && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2, ease: "easeInOut" }}
                className="overflow-hidden"
              >
                <div className="px-4 pb-2 space-y-1">
                  {planEntries.map((entry, i) => (
                    <div key={i} className="flex items-center gap-2 py-0.5 text-sm">
                      {entry.status === "completed" ? (
                        <CheckCircle2 className="w-3.5 h-3.5 text-[var(--color-success)] shrink-0" />
                      ) : entry.status === "in_progress" ? (
                        <Loader2 className="w-3.5 h-3.5 text-[var(--color-highlight)] animate-spin shrink-0" />
                      ) : (
                        <Circle className="w-3.5 h-3.5 text-[var(--color-text-muted)] shrink-0" />
                      )}
                      <span className={entry.status === "completed"
                        ? "text-[var(--color-text-muted)] line-through" : "text-[var(--color-text)]"}>
                        {entry.content}
                      </span>
                    </div>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      {/* Input */}
      <div className="border-t border-[var(--color-border)] bg-[var(--color-bg)] px-3 pt-3 pb-2">
        <div className="flex gap-2">
          <textarea ref={textareaRef} value={input}
            onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown}
            placeholder={isConnected ? "Message agent — Enter to send, Shift+Enter for newline" : "Waiting for connection..."}
            disabled={!isConnected || isBusy} rows={1}
            className="flex-1 resize-none rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-highlight)] disabled:opacity-50"
          />
          <Button variant="primary" size="sm" onClick={handleSend} disabled={!isConnected || isBusy || !input.trim()}>
            <Send className="w-4 h-4" />
          </Button>
        </div>

        {/* Bottom Toolbar */}
        {(modelOptions.length > 0 || modeOptions.length > 0) && (
          <div className="flex items-center justify-end mt-2">
            <div className="flex items-center gap-2">
              {modelOptions.length > 0 && (
                <DropdownSelect ref={modelMenuRef} label="Model" options={modelOptions} value={selectedModel}
                  open={showModelMenu} onToggle={() => { setShowModelMenu(!showModelMenu); setShowPermMenu(false); }}
                  onSelect={(v) => { setSelectedModel(v); setShowModelMenu(false); wsRef.current?.readyState === WebSocket.OPEN && wsRef.current.send(JSON.stringify({ type: "set_model", model_id: v })); }} />
              )}
              {modeOptions.length > 0 && (
                <DropdownSelect ref={permMenuRef} label="Mode" options={modeOptions} value={permissionLevel}
                  open={showPermMenu} onToggle={() => { setShowPermMenu(!showPermMenu); setShowModelMenu(false); }}
                  onSelect={(v) => { setPermissionLevel(v); setShowPermMenu(false); wsRef.current?.readyState === WebSocket.OPEN && wsRef.current.send(JSON.stringify({ type: "set_mode", mode_id: v })); }} />
              )}
            </div>
          </div>
        )}
      </div>
    </motion.div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

/** Reusable dropdown selector for bottom toolbar */
const DropdownSelect = ({ ref, label, options, value, open, onToggle, onSelect }: {
  ref: React.RefObject<HTMLDivElement | null>;
  label: string;
  options: { label: string; value: string }[];
  value: string;
  open: boolean;
  onToggle: () => void;
  onSelect: (value: string) => void;
}) => (
  <div className="relative" ref={ref}>
    <button onClick={onToggle}
      className="flex items-center gap-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors px-1.5 py-0.5 rounded hover:bg-[var(--color-bg-tertiary)]">
      <span className="opacity-60">{label}:</span>
      <span>{options.find((o) => o.value === value)?.label ?? "Default"}</span>
      <ChevronDown className="w-3 h-3" />
    </button>
    {open && (
      <div className="absolute bottom-full right-0 mb-1 min-w-44 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] shadow-lg py-1 z-50">
        {options.map((opt) => (
          <button key={opt.value} onClick={() => onSelect(opt.value)}
            className={`w-full text-left px-3 py-1.5 text-sm flex items-center justify-between hover:bg-[var(--color-bg-tertiary)] transition-colors ${
              value === opt.value ? "text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>
            <span>{opt.label}</span>
            {value === opt.value && <span className="text-[var(--color-highlight)]">✓</span>}
          </button>
        ))}
      </div>
    )}
  </div>
);

/** Grouped tool calls rendered as a single collapsible block */
function ToolGroup({ items, onToggleItemCollapse }: {
  items: { message: ToolMessage; index: number }[];
  onToggleItemCollapse: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const runningCount = items.filter((t) => t.message.status === "running").length;
  const isAllDone = runningCount === 0;

  // Single tool: render inline (no group header)
  if (items.length === 1) {
    const { message } = items[0];
    return (
      <div className="flex justify-start">
        <div className="w-full">
          <button onClick={() => onToggleItemCollapse(message.id)}
            className="flex items-center gap-1.5 py-1 px-2 rounded-md text-xs hover:bg-[var(--color-bg-tertiary)] transition-colors w-full text-left">
            {message.status === "running"
              ? <Loader2 className="w-3 h-3 text-[var(--color-highlight)] animate-spin shrink-0" />
              : <Wrench className="w-3 h-3 text-[var(--color-text-muted)] shrink-0" />}
            {message.collapsed
              ? <ChevronRight className="w-3 h-3 text-[var(--color-text-muted)] shrink-0" />
              : <ChevronDown className="w-3 h-3 text-[var(--color-text-muted)] shrink-0" />}
            <span className="text-[var(--color-text-muted)] truncate">{message.title}</span>
            <span className="ml-auto text-[10px] text-[var(--color-text-muted)] shrink-0 capitalize">{message.status}</span>
          </button>
          {!message.collapsed && message.content && (
            <div className="ml-6 mt-1 rounded px-2 py-1.5 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] text-xs text-[var(--color-text-muted)] font-mono whitespace-pre-wrap max-h-40 overflow-y-auto">
              {message.content}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Multiple tools: collapsible group
  return (
    <div className="flex justify-start">
      <div className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] overflow-hidden">
        {/* Group header */}
        <button onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1.5 py-1.5 px-3 text-xs w-full text-left hover:bg-[var(--color-bg-tertiary)] transition-colors">
          {runningCount > 0
            ? <Loader2 className="w-3 h-3 text-[var(--color-highlight)] animate-spin shrink-0" />
            : <Wrench className="w-3 h-3 text-[var(--color-text-muted)] shrink-0" />}
          {expanded
            ? <ChevronDown className="w-3 h-3 text-[var(--color-text-muted)] shrink-0" />
            : <ChevronRight className="w-3 h-3 text-[var(--color-text-muted)] shrink-0" />}
          <span className="text-[var(--color-text)]">
            {items.length} tool call{items.length > 1 ? "s" : ""}
          </span>
          <span className="ml-auto text-[10px] text-[var(--color-text-muted)] shrink-0">
            {isAllDone ? "Completed" : `${runningCount} running`}
          </span>
        </button>
        {/* Expanded: individual items */}
        {expanded && (
          <div className="border-t border-[var(--color-border)]">
            {items.map(({ message }) => (
              <div key={message.id}>
                <button onClick={() => onToggleItemCollapse(message.id)}
                  className="flex items-center gap-1.5 py-1 px-3 text-xs w-full text-left hover:bg-[var(--color-bg-tertiary)] transition-colors">
                  {message.status === "running"
                    ? <Loader2 className="w-3 h-3 text-[var(--color-highlight)] animate-spin shrink-0" />
                    : <CheckCircle2 className="w-3 h-3 text-[var(--color-success)] shrink-0" />}
                  {message.collapsed
                    ? <ChevronRight className="w-2.5 h-2.5 text-[var(--color-text-muted)] shrink-0" />
                    : <ChevronDown className="w-2.5 h-2.5 text-[var(--color-text-muted)] shrink-0" />}
                  <span className="text-[var(--color-text-muted)] truncate">{message.title}</span>
                  <span className="ml-auto text-[10px] text-[var(--color-text-muted)] shrink-0 capitalize">{message.status}</span>
                </button>
                {!message.collapsed && message.content && (
                  <div className="mx-3 mb-1 rounded px-2 py-1 bg-[var(--color-bg-tertiary)] text-[10px] text-[var(--color-text-muted)] font-mono whitespace-pre-wrap max-h-32 overflow-y-auto">
                    {message.content}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Individual non-tool message rendering */
function MessageItem({ message, index, isBusy, onToggleToolCollapse, onToggleThinkingCollapse }: {
  message: ChatMessage; index: number; isBusy: boolean;
  onToggleToolCollapse: (id: string) => void;
  onToggleThinkingCollapse: (index: number) => void;
}) {
  switch (message.type) {
    case "user":
      return (
        <div className="flex justify-end">
          <div className="max-w-[85%] rounded-lg px-3 py-2 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] text-sm text-[var(--color-text)] whitespace-pre-wrap">
            {message.content}
          </div>
        </div>
      );
    case "assistant":
      // Skip empty/whitespace-only assistant messages
      if (!message.content.trim()) return null;
      return (
        <div className="flex justify-start">
          <div className="max-w-[90%] text-sm text-[var(--color-text)]">
            <MarkdownRenderer content={message.content} />
            {!message.complete && isBusy && (
              <span className="inline-block w-1.5 h-4 ml-0.5 bg-[var(--color-text-muted)] animate-pulse rounded-sm" />
            )}
          </div>
        </div>
      );
    case "thinking":
      return (
        <div className="flex justify-start">
          <div className="max-w-[90%] w-full">
            <button onClick={() => onToggleThinkingCollapse(index)}
              className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors mb-1">
              <Brain className="w-3 h-3" />
              {message.collapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              <span className="italic">Thinking</span>
            </button>
            {!message.collapsed && (
              <div className="ml-5 rounded-lg px-3 py-2 bg-[var(--color-bg-tertiary)] text-xs text-[var(--color-text-muted)] italic whitespace-pre-wrap max-h-40 overflow-y-auto">
                {message.content}
              </div>
            )}
          </div>
        </div>
      );
    case "tool":
      // Single tool (should be handled by ToolGroup, but fallback)
      return (
        <div className="flex justify-start">
          <div className="w-full">
            <button onClick={() => onToggleToolCollapse(message.id)}
              className="flex items-center gap-1.5 py-1 px-2 rounded-md text-xs hover:bg-[var(--color-bg-tertiary)] transition-colors w-full text-left">
              <Wrench className="w-3 h-3 text-[var(--color-text-muted)] shrink-0" />
              <span className="text-[var(--color-text-muted)] truncate">{message.title}</span>
            </button>
          </div>
        </div>
      );
    case "system":
      return (
        <div className="text-center text-xs text-[var(--color-text-muted)] py-1">{message.content}</div>
      );
  }
}
