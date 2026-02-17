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
  Brain,
  ListTodo,
  Slash,
  X,
  ShieldCheck,
  ShieldX,
  Plus,
  Trash2,
} from "lucide-react";
import { Button, MarkdownRenderer, agentOptions } from "../../ui";
import type { Task } from "../../../data/types";
import { getApiHost } from "../../../api/client";
import { getConfig, listChats, createChat, updateChatTitle, deleteChat } from "../../../api";
import type { ChatSessionResponse, CustomAgent } from "../../../api";

// ─── Types ───────────────────────────────────────────────────────────────────

interface TaskChatProps {
  projectId: string;
  task: Task;
  collapsed?: boolean;
  onExpand?: () => void;
  onCollapse?: () => void;
  onStartSession: () => void;
  autoStart?: boolean;
  onConnected?: () => void;
  onDisconnected?: () => void;
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
  locations?: { path: string; line?: number }[];
};

interface PermOption {
  option_id: string;
  name: string;
  kind: string; // "allow_once" | "allow_always" | "reject_once" | "reject_always"
}

type PermissionMessage = {
  type: "permission";
  description: string;
  options: PermOption[];
  resolved?: string; // selected option name when resolved
};

type ChatMessage =
  | { type: "user"; content: string }
  | { type: "assistant"; content: string; complete: boolean }
  | { type: "thinking"; content: string; collapsed: boolean }
  | ToolMessage
  | { type: "system"; content: string }
  | PermissionMessage;

interface PlanEntry {
  content: string;
  status: string;
}

interface SlashCommand {
  name: string;
  description: string;
  input_hint?: string;
}

/** Per-chat cached state (preserved across chat switches) */
interface PerChatState {
  messages: ChatMessage[];
  isBusy: boolean;
  selectedModel: string;
  permissionLevel: string;
  modelOptions: { label: string; value: string }[];
  modeOptions: { label: string; value: string }[];
  planEntries: PlanEntry[];
  slashCommands: SlashCommand[];
  isConnected: boolean;
  agentLabel: string;
  agentIcon: React.ComponentType<{ size?: number; className?: string }> | null;
}

function defaultPerChatState(): PerChatState {
  return {
    messages: [],
    isBusy: false,
    selectedModel: "",
    permissionLevel: "",
    modelOptions: [],
    modeOptions: [],
    planEntries: [],
    slashCommands: [],
    isConnected: false,
    agentLabel: "Chat",
    agentIcon: null,
  };
}

// ─── Render grouping types ───────────────────────────────────────────────────

type ToolSectionItem = { message: ToolMessage; index: number };
type RenderItem =
  | { kind: "single"; message: ChatMessage; index: number }
  | { kind: "tool-section"; sectionId: string; tools: ToolSectionItem[] };

/** Group consecutive tool messages into sections; everything else is a single item */
function buildRenderItems(messages: ChatMessage[]): RenderItem[] {
  const items: RenderItem[] = [];
  let toolBuf: ToolSectionItem[] = [];

  const flush = () => {
    if (toolBuf.length > 0) {
      items.push({ kind: "tool-section", sectionId: toolBuf[0].message.id, tools: [...toolBuf] });
      toolBuf = [];
    }
  };

  messages.forEach((msg, i) => {
    if (msg.type === "tool") {
      toolBuf.push({ message: msg, index: i });
    } else {
      flush();
      items.push({ kind: "single", message: msg, index: i });
    }
  });
  flush();
  return items;
}

// ─── Constants ───────────────────────────────────────────────────────────────


// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Create a non-editable command chip DOM element */
function createCommandChip(name: string): HTMLSpanElement {
  const chip = document.createElement("span");
  chip.contentEditable = "false";
  chip.dataset.command = name;
  chip.style.cssText =
    "display:inline-flex;align-items:center;gap:4px;padding:1px 6px;border-radius:4px;" +
    "background:color-mix(in srgb,var(--color-highlight) 15%,transparent);" +
    "border:1px solid color-mix(in srgb,var(--color-highlight) 30%,transparent);" +
    "font-size:12px;font-weight:500;color:var(--color-highlight);" +
    "margin:0 2px;user-select:none;vertical-align:baseline;line-height:1.5;";

  const label = document.createElement("span");
  label.textContent = `/${name}`;
  chip.appendChild(label);

  const closeBtn = document.createElement("span");
  closeBtn.dataset.chipClose = "true";
  closeBtn.textContent = "\u00d7";
  closeBtn.style.cssText =
    "margin-left:2px;cursor:pointer;opacity:0.6;font-size:13px;line-height:1;";
  chip.appendChild(closeBtn);

  return chip;
}

/** Extract prompt text from a contentEditable element, converting chips to /command */
function getPromptFromEditable(el: HTMLElement): string {
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent || "");
    } else if (node instanceof HTMLElement) {
      if (node.dataset.command) {
        parts.push(`/${node.dataset.command}`);
      } else if (node.tagName === "BR") {
        parts.push("\n");
      } else if (node.tagName === "DIV" || node.tagName === "P") {
        if (parts.length > 0 && parts[parts.length - 1] !== "\n") parts.push("\n");
        node.childNodes.forEach(walk);
      } else {
        node.childNodes.forEach(walk);
      }
    }
  };
  el.childNodes.forEach(walk);
  return parts.join("").trim();
}

// ─── Main Component ──────────────────────────────────────────────────────────

export function TaskChat({
  projectId,
  task,
  collapsed = false,
  onExpand,
  onCollapse,
  onStartSession,
  autoStart = false,
  onConnected: onConnectedProp,
  onDisconnected: onDisconnectedProp,
  fullscreen = false,
  onToggleFullscreen,
}: TaskChatProps) {
  // ─── Multi-chat state ───────────────────────────────────────────────────
  const [chats, setChats] = useState<ChatSessionResponse[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [showChatMenu, setShowChatMenu] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [editTitleValue, setEditTitleValue] = useState("");
  const chatMenuRef = useRef<HTMLDivElement>(null);

  // Per-chat state cache (preserved across chat switches)
  const perChatStateRef = useRef<Map<string, PerChatState>>(new Map());
  // Per-chat WebSocket connections
  const wsMapRef = useRef<Map<string, WebSocket>>(new Map());

  // ─── Active chat's live state ─────────────────────────────────────────
  const [isConnected, setIsConnected] = useState(false);
  const [sessionStarted, setSessionStarted] = useState(true);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasContent, setHasContent] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [selectedModel, setSelectedModel] = useState("");
  const [permissionLevel, setPermissionLevel] = useState("");
  const [modelOptions, setModelOptions] = useState<{label: string; value: string}[]>([]);
  const [modeOptions, setModeOptions] = useState<{label: string; value: string}[]>([]);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [showPermMenu, setShowPermMenu] = useState(false);
  const [planEntries, setPlanEntries] = useState<PlanEntry[]>([]);
  const [showPlan, setShowPlan] = useState(true);
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashFilter, setSlashFilter] = useState("");
  const [slashSelectedIdx, setSlashSelectedIdx] = useState(0);
  const [isTerminalMode, setIsTerminalMode] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
  const [agentLabel, setAgentLabel] = useState("Chat");
  const [AgentIcon, setAgentIcon] = useState<React.ComponentType<{ size?: number; className?: string }> | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const editableRef = useRef<HTMLDivElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const permMenuRef = useRef<HTMLDivElement>(null);
  const slashMenuRef = useRef<HTMLDivElement>(null);

  const isLive = task.status === "live";
  const showChat = isLive || sessionStarted;
  const activeChat = chats.find((c) => c.id === activeChatId);

  // Filtered slash commands based on current input
  const filteredSlashCommands = useMemo(() => {
    if (!slashFilter) return slashCommands;
    const lower = slashFilter.toLowerCase();
    return slashCommands.filter(
      (c) => c.name.toLowerCase().includes(lower) || c.description.toLowerCase().includes(lower),
    );
  }, [slashCommands, slashFilter]);

  // Resolve agent label and icon from active chat's agent
  useEffect(() => {
    const resolve = (cmd: string, customAgents?: CustomAgent[]) => {
      const match = agentOptions.find((a) => a.value === cmd);
      if (match) {
        setAgentLabel(match.label);
        if (match.icon) setAgentIcon(() => match.icon!);
      } else {
        // Check custom agents
        const custom = customAgents?.find((a) => a.id === cmd);
        if (custom) {
          setAgentLabel(custom.name);
        } else {
          setAgentLabel(cmd);
        }
      }
    };

    if (activeChat) {
      // Load config to get custom agents for resolution
      getConfig()
        .then((cfg) => resolve(activeChat.agent, cfg.acp?.custom_agents))
        .catch(() => resolve(activeChat.agent));
    } else if (task.multiplexer === "acp") {
      resolve("claude");
    } else {
      getConfig()
        .then((cfg) => resolve(cfg.layout.agent_command || "claude", cfg.acp?.custom_agents))
        .catch(() => resolve("claude"));
    }
  }, [task.multiplexer, activeChat]);

  // Auto-start
  useEffect(() => {
    if (autoStart && !isLive) setSessionStarted(true);
  }, [autoStart, isLive]);

  // Auto-scroll to bottom — only when new messages arrive, not on collapse toggle
  const prevMsgCountRef = useRef(0);
  useEffect(() => {
    if (messages.length > prevMsgCountRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
    prevMsgCountRef.current = messages.length;
  }, [messages]);

  // Close dropdown menus when clicking outside
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) setShowModelMenu(false);
      if (permMenuRef.current && !permMenuRef.current.contains(e.target as Node)) setShowPermMenu(false);
      if (chatMenuRef.current && !chatMenuRef.current.contains(e.target as Node)) setShowChatMenu(false);
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // ─── Save/Restore per-chat state on switch ─────────────────────────────

  /** Save current active chat state to cache */
  const saveCurrentChatState = useCallback(() => {
    if (!activeChatId) return;
    perChatStateRef.current.set(activeChatId, {
      messages, isBusy, selectedModel, permissionLevel,
      modelOptions, modeOptions, planEntries, slashCommands,
      isConnected, agentLabel, agentIcon: AgentIcon,
    });
  }, [activeChatId, messages, isBusy, selectedModel, permissionLevel, modelOptions, modeOptions, planEntries, slashCommands, isConnected, agentLabel, AgentIcon]);

  /** Restore chat state from cache */
  const restoreChatState = useCallback((chatId: string) => {
    const cached = perChatStateRef.current.get(chatId);
    if (cached) {
      setMessages(cached.messages);
      setIsBusy(cached.isBusy);
      setSelectedModel(cached.selectedModel);
      setPermissionLevel(cached.permissionLevel);
      setModelOptions(cached.modelOptions);
      setModeOptions(cached.modeOptions);
      setPlanEntries(cached.planEntries);
      setSlashCommands(cached.slashCommands);
      setIsConnected(cached.isConnected);
      setAgentLabel(cached.agentLabel);
      if (cached.agentIcon) setAgentIcon(() => cached.agentIcon);
    } else {
      // Fresh state for new chat
      setMessages([]);
      setIsBusy(false);
      setSelectedModel("");
      setPermissionLevel("");
      setModelOptions([]);
      setModeOptions([]);
      setPlanEntries([]);
      setSlashCommands([]);
      setIsConnected(false);
    }
    // Point wsRef to this chat's WebSocket
    wsRef.current = wsMapRef.current.get(chatId) ?? null;
  }, []);

  // ─── Load chats on mount ───────────────────────────────────────────────

  useEffect(() => {
    if (!showChat || task.multiplexer !== "acp") return;
    let cancelled = false;

    const init = async () => {
      try {
        let chatList = await listChats(projectId, task.id);
        if (chatList.length === 0) {
          // Auto-create first chat
          const newChat = await createChat(projectId, task.id);
          chatList = [newChat];
        }
        if (cancelled) return;
        setChats(chatList);
        // Select last chat by default
        const lastChat = chatList[chatList.length - 1];
        setActiveChatId(lastChat.id);
      } catch (err) {
        console.error("Failed to load chats:", err);
      }
    };
    init();
    return () => { cancelled = true; };
  }, [showChat, projectId, task.id, task.multiplexer]);

  // ─── Per-chat WebSocket management ─────────────────────────────────────

  /** Connect a WebSocket for a given chat ID (idempotent) */
  const connectChatWs = useCallback((chatId: string) => {
    if (wsMapRef.current.has(chatId)) return; // Already connected

    const host = getApiHost();
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${host}/api/v1/projects/${projectId}/tasks/${task.id}/chats/${chatId}/ws`;

    const ws = new WebSocket(url);
    wsMapRef.current.set(chatId, ws);

    ws.onopen = () => {
      // Update state only for active chat
      if (chatId === activeChatIdRef.current) {
        setMessages((prev) => [...prev, { type: "system", content: "Connecting..." }]);
      } else {
        const cached = perChatStateRef.current.get(chatId) ?? defaultPerChatState();
        cached.messages = [...cached.messages, { type: "system", content: "Connecting..." }];
        perChatStateRef.current.set(chatId, cached);
      }
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (chatId === activeChatIdRef.current) {
          handleServerMessage(data);
        } else {
          // Buffer into per-chat cache
          handleServerMessageForCache(chatId, data);
        }
      } catch { /* ignore */ }
    };

    ws.onclose = () => {
      wsMapRef.current.delete(chatId);
      if (chatId === activeChatIdRef.current) {
        setIsConnected(false);
        onDisconnectedProp?.();
      } else {
        const cached = perChatStateRef.current.get(chatId);
        if (cached) cached.isConnected = false;
      }
    };

    ws.onerror = () => {
      if (chatId === activeChatIdRef.current) {
        setMessages((prev) => [...prev, { type: "system", content: "Connection error." }]);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, task.id]);

  // Ref to track current activeChatId (for use in callbacks)
  const activeChatIdRef = useRef<string | null>(null);
  activeChatIdRef.current = activeChatId;

  // Connect WebSocket when activeChatId changes
  useEffect(() => {
    if (!activeChatId || !showChat || task.multiplexer !== "acp") return;
    connectChatWs(activeChatId);
    wsRef.current = wsMapRef.current.get(activeChatId) ?? null;
  }, [activeChatId, showChat, task.multiplexer, connectChatWs]);

  // Cleanup all WebSockets on unmount
  useEffect(() => {
    return () => {
      wsMapRef.current.forEach((ws) => ws.close());
      wsMapRef.current.clear();
    };
  }, []);

  // Legacy WebSocket for non-ACP tasks
  useEffect(() => {
    if (!showChat || task.multiplexer === "acp") return;

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
    let intentionalClose = false;
    ws.onclose = () => {
      setIsConnected(false);
      if (!intentionalClose) onDisconnectedProp?.();
    };
    ws.onerror = () => {
      setMessages((prev) => [...prev, { type: "system", content: "Connection error." }]);
    };
    return () => { intentionalClose = true; ws.close(); wsRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showChat, projectId, task.id, task.multiplexer]);

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
            return [...filtered, { type: "system", content: "$$CONNECTED$$" }];
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
          console.log('[tool_call]', JSON.stringify(msg, null, 2));
          setMessages((prev) => [...prev, {
            type: "tool", id: msg.id, title: msg.title, status: "running", collapsed: false,
            locations: msg.locations,
          }]);
          break;
        case "tool_call_update":
          console.log('[tool_call_update]', JSON.stringify(msg, null, 2));
          setMessages((prev) =>
            prev.map((m) => m.type === "tool" && m.id === msg.id
              ? { ...m, status: msg.status, content: msg.content,
                  locations: msg.locations?.length ? msg.locations : m.locations } : m),
          );
          break;
        case "permission_request":
          setMessages((prev) => [...prev, {
            type: "permission",
            description: msg.description,
            options: msg.options ?? [],
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
        case "available_commands":
          setSlashCommands(msg.commands ?? []);
          break;
        case "session_ended":
          setIsConnected(false);
          break;
      }
    },
    [onConnectedProp],
  );

  /** Buffer a server message into the per-chat cache (for non-active chats) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleServerMessageForCache = useCallback((chatId: string, msg: any) => {
    const state = perChatStateRef.current.get(chatId) ?? defaultPerChatState();
    switch (msg.type) {
      case "session_ready":
        state.isConnected = true;
        if (msg.available_modes?.length)
          state.modeOptions = msg.available_modes.map((m: { id: string; name: string }) => ({ label: m.name, value: m.id }));
        if (msg.current_mode_id) state.permissionLevel = msg.current_mode_id;
        if (msg.available_models?.length)
          state.modelOptions = msg.available_models.map((m: { id: string; name: string }) => ({ label: m.name, value: m.id }));
        if (msg.current_model_id) state.selectedModel = msg.current_model_id;
        state.messages = [...state.messages.filter((m) => !(m.type === "system" && m.content === "Connecting...")),
          { type: "system", content: "$$CONNECTED$$" }];
        break;
      case "message_chunk": {
        const msgs = state.messages;
        let found = false;
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i];
          if (m.type === "assistant" && !m.complete) {
            msgs[i] = { ...m, content: m.content + msg.text };
            found = true;
            break;
          }
          if (m.type === "user") break;
        }
        if (!found && msg.text.trim()) msgs.push({ type: "assistant", content: msg.text, complete: false });
        state.messages = [...msgs];
        break;
      }
      case "tool_call":
        state.messages = [...state.messages, { type: "tool", id: msg.id, title: msg.title, status: "running", collapsed: false, locations: msg.locations }];
        break;
      case "tool_call_update":
        state.messages = state.messages.map((m) =>
          m.type === "tool" && m.id === msg.id ? { ...m, status: msg.status, content: msg.content, locations: msg.locations?.length ? msg.locations : m.locations } : m);
        break;
      case "complete":
        state.messages = state.messages.map((m) => m.type === "assistant" && !m.complete ? { ...m, complete: true } : m);
        state.isBusy = false;
        break;
      case "busy":
        state.isBusy = msg.value;
        break;
      case "user_message":
        state.messages = [...state.messages, { type: "user", content: msg.text }];
        break;
      case "plan_update":
        state.planEntries = msg.entries ?? [];
        break;
      case "available_commands":
        state.slashCommands = msg.commands ?? [];
        break;
      case "session_ended":
        state.isConnected = false;
        break;
    }
    perChatStateRef.current.set(chatId, state);
  }, []);

  // ─── Chat switching ────────────────────────────────────────────────────

  const switchChat = useCallback((chatId: string) => {
    if (chatId === activeChatId) return;
    saveCurrentChatState();
    setActiveChatId(chatId);
    restoreChatState(chatId);
    setShowChatMenu(false);
    // Connect WS if needed
    connectChatWs(chatId);
    wsRef.current = wsMapRef.current.get(chatId) ?? null;
  }, [activeChatId, saveCurrentChatState, restoreChatState, connectChatWs]);

  // ─── New chat creation ─────────────────────────────────────────────────

  const handleNewChat = useCallback(async () => {
    try {
      const newChat = await createChat(projectId, task.id);
      setChats((prev) => [...prev, newChat]);
      switchChat(newChat.id);
    } catch (err) {
      console.error("Failed to create chat:", err);
    }
  }, [projectId, task.id, switchChat]);

  // ─── Chat title editing ─────────────────────────────────────────────────

  const handleTitleSave = useCallback(async () => {
    if (!activeChatId || !editTitleValue.trim()) {
      setEditingTitle(false);
      return;
    }
    try {
      await updateChatTitle(projectId, task.id, activeChatId, editTitleValue.trim());
      setChats((prev) => prev.map((c) => c.id === activeChatId ? { ...c, title: editTitleValue.trim() } : c));
    } catch (err) {
      console.error("Failed to update chat title:", err);
    }
    setEditingTitle(false);
  }, [activeChatId, editTitleValue, projectId, task.id]);

  // ─── Chat deletion ─────────────────────────────────────────────────────

  const handleDeleteChat = useCallback(async (chatId: string) => {
    if (chats.length <= 1) return; // Don't delete the last chat
    try {
      await deleteChat(projectId, task.id, chatId);
      // Close WebSocket if connected
      const ws = wsMapRef.current.get(chatId);
      if (ws) { ws.close(); wsMapRef.current.delete(chatId); }
      perChatStateRef.current.delete(chatId);
      setChats((prev) => {
        const updated = prev.filter((c) => c.id !== chatId);
        if (chatId === activeChatId && updated.length > 0) {
          const next = updated[updated.length - 1];
          setActiveChatId(next.id);
          restoreChatState(next.id);
        }
        return updated;
      });
    } catch (err) {
      console.error("Failed to delete chat:", err);
    }
    setShowChatMenu(false);
  }, [chats.length, projectId, task.id, activeChatId, restoreChatState]);

  // ─── User actions ────────────────────────────────────────────────────────

  /** Check if the editable has any content (text or chips) */
  const checkContent = useCallback(() => {
    const el = editableRef.current;
    if (!el) { setHasContent(false); return; }
    const text = el.textContent?.trim() || "";
    const hasChips = el.querySelector("[data-command]") !== null;
    setHasContent(text.length > 0 || hasChips);
  }, []);

  const handleSend = useCallback(() => {
    const el = editableRef.current;
    if (!el) return;
    const prompt = getPromptFromEditable(el);
    if (!prompt || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    // Shell mode → wrap as terminal command
    const text = isTerminalMode
      ? `Run this command: \`${prompt}\``
      : prompt;

    wsRef.current.send(JSON.stringify({ type: "prompt", text }));
    el.innerHTML = "";
    setHasContent(false);
    setShowSlashMenu(false);
    setIsTerminalMode(false);
    setIsBusy(true);
    el.focus();
  }, [isTerminalMode]);

  /** Respond to a permission request */
  const handlePermissionResponse = useCallback((optionId: string, optionName: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "permission_response", option_id: optionId }));
    // Mark the permission message as resolved
    setMessages((prev) =>
      prev.map((m) =>
        m.type === "permission" && !m.resolved
          ? { ...m, resolved: optionName }
          : m,
      ),
    );
  }, []);

  /** Detect /slash at cursor position in contentEditable */
  const handleInput = useCallback(() => {
    // Detect "!" typed into empty input → enter shell mode and clear the "!"
    const el = editableRef.current;
    if (el && !isTerminalMode && el.textContent === "!") {
      el.innerHTML = "";
      setHasContent(false);
      setIsTerminalMode(true);
      return;
    }
    checkContent();
    if (slashCommands.length === 0) { setShowSlashMenu(false); return; }
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) { setShowSlashMenu(false); return; }
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) { setShowSlashMenu(false); return; }
    const text = node.textContent || "";
    const offset = range.startOffset;
    // Scan backwards from cursor to find "/"
    let slashIdx = -1;
    for (let i = offset - 1; i >= 0; i--) {
      if (text[i] === "/") {
        if (i === 0 || /\s/.test(text[i - 1])) slashIdx = i;
        break;
      }
      if (/\s/.test(text[i])) break;
    }
    if (slashIdx >= 0) {
      setSlashFilter(text.slice(slashIdx + 1, offset));
      setShowSlashMenu(true);
      setSlashSelectedIdx(0);
    } else {
      setShowSlashMenu(false);
    }
  }, [checkContent, isTerminalMode, slashCommands.length]);

  /** Insert a command chip at the current cursor position, replacing the /partial text */
  const insertCommandAtCursor = useCallback((name: string) => {
    const el = editableRef.current;
    if (!el) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) return;
    const text = node.textContent || "";
    const offset = range.startOffset;
    // Find the "/" start
    let slashIdx = -1;
    for (let i = offset - 1; i >= 0; i--) {
      if (text[i] === "/") { if (i === 0 || /\s/.test(text[i - 1])) slashIdx = i; break; }
      if (/\s/.test(text[i])) break;
    }
    if (slashIdx < 0) return;
    const before = text.slice(0, slashIdx);
    const after = text.slice(offset);
    const parent = node.parentNode;
    if (!parent) return;
    // Build replacement: textBefore + chip + textAfter
    const chip = createCommandChip(name);
    const frag = document.createDocumentFragment();
    if (before) frag.appendChild(document.createTextNode(before));
    frag.appendChild(chip);
    const afterNode = document.createTextNode(after || " ");
    frag.appendChild(afterNode);
    parent.replaceChild(frag, node);
    // Move cursor after chip
    const newRange = document.createRange();
    newRange.setStart(afterNode, after ? 0 : 1);
    newRange.collapse(true);
    sel.removeAllRanges();
    sel.addRange(newRange);
    setShowSlashMenu(false);
    checkContent();
  }, [checkContent]);

  /** Delegated click handler for chip close buttons */
  const handleEditableMouseDown = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.dataset.chipClose || target.closest("[data-chip-close]")) {
      e.preventDefault();
      const chip = target.closest("[data-command]");
      if (chip) { chip.remove(); checkContent(); }
    }
  }, [checkContent]);

  /** Strip HTML on paste — insert plain text only */
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    document.execCommand("insertText", false, text);
    checkContent();
  }, [checkContent]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Shell mode: Backspace on empty input → exit shell mode
    if (isTerminalMode && e.key === "Backspace") {
      const el = editableRef.current;
      if (el && !el.textContent?.trim()) {
        e.preventDefault();
        setIsTerminalMode(false);
        return;
      }
    }
    // Shell mode: Escape → exit shell mode
    if (isTerminalMode && e.key === "Escape") {
      e.preventDefault();
      setIsTerminalMode(false);
      return;
    }
    // Slash menu navigation
    if (showSlashMenu && filteredSlashCommands.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashSelectedIdx((prev) => (prev + 1) % filteredSlashCommands.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashSelectedIdx((prev) => (prev - 1 + filteredSlashCommands.length) % filteredSlashCommands.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        insertCommandAtCursor(filteredSlashCommands[slashSelectedIdx].name);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setShowSlashMenu(false);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }, [handleSend, isTerminalMode, showSlashMenu, filteredSlashCommands, slashSelectedIdx, insertCommandAtCursor]);

  const handleStartSession = () => { setSessionStarted(true); onStartSession(); };

  const toggleToolCollapse = (id: string) => {
    setMessages((prev) => prev.map((m) => m.type === "tool" && m.id === id ? { ...m, collapsed: !m.collapsed } : m));
  };

  const toggleThinkingCollapse = (index: number) => {
    setMessages((prev) => prev.map((m, i) => i === index && m.type === "thinking" ? { ...m, collapsed: !m.collapsed } : m));
  };

  const renderItems = useMemo(() => buildRenderItems(messages), [messages]);

  // Track the message index where the current busy turn started
  const turnStartIndexRef = useRef(0);
  const wasBusyRef = useRef(false);
  if (isBusy && !wasBusyRef.current) {
    turnStartIndexRef.current = messages.length;
  }
  wasBusyRef.current = isBusy;

  const toggleSection = useCallback((sectionId: string, toolIds: string[]) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(sectionId)) {
        next.delete(sectionId);
      } else {
        next.add(sectionId);
        // When expanding: reset all tools in section to expanded
        setMessages((pm) => pm.map((m) =>
          m.type === "tool" && toolIds.includes(m.id) ? { ...m, collapsed: false } : m,
        ));
      }
      return next;
    });
  }, []);

  // ─── Collapsed mode ──────────────────────────────────────────────────────

  if (collapsed) {
    return (
      <motion.div layout initial={{ width: 48 }} animate={{ width: 48 }}
        transition={{ type: "spring", damping: 25, stiffness: 200 }}
        className="h-full flex flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] overflow-hidden cursor-pointer hover:bg-[var(--color-bg)] transition-colors"
        onClick={onExpand} title="Expand Chat (t)"
      >
        <div className="flex-1 flex flex-col items-center py-2">
          <div className="p-3 text-[var(--color-text-muted)]">{AgentIcon ? <AgentIcon size={20} /> : <MessageSquare className="w-5 h-5" />}</div>
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
            {AgentIcon ? <AgentIcon size={16} /> : <MessageSquare className="w-4 h-4" />}<span>{agentLabel}</span>
          </div>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center">
          {AgentIcon ? <AgentIcon size={40} className="mb-3" /> : <MessageSquare className="w-10 h-10 text-[var(--color-text-muted)] mb-3" />}
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
        <div className="flex items-center gap-2 text-sm min-w-0">
          {AgentIcon ? <AgentIcon size={16} className="text-[var(--color-text-muted)] shrink-0" /> : <MessageSquare className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" />}

          {/* Chat title / dropdown (only for ACP multi-chat) */}
          {task.multiplexer === "acp" && activeChat ? (
            <div className="relative min-w-0 flex-1" ref={chatMenuRef}>
              {editingTitle ? (
                <input
                  autoFocus
                  value={editTitleValue}
                  onChange={(e) => setEditTitleValue(e.target.value)}
                  onBlur={handleTitleSave}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleTitleSave();
                    if (e.key === "Escape") setEditingTitle(false);
                  }}
                  className="text-sm text-[var(--color-text)] bg-transparent border-b border-[var(--color-highlight)] outline-none px-0 py-0 min-w-0 w-40"
                />
              ) : (
                <button
                  onClick={() => setShowChatMenu(!showChatMenu)}
                  onDoubleClick={() => {
                    setEditTitleValue(activeChat.title);
                    setEditingTitle(true);
                    setShowChatMenu(false);
                  }}
                  className="flex items-center gap-1 text-sm text-[var(--color-text)] hover:text-[var(--color-highlight)] transition-colors min-w-0"
                  title="Double-click to rename"
                >
                  <span className="truncate">{activeChat.title}</span>
                  <ChevronDown className="w-3 h-3 shrink-0 text-[var(--color-text-muted)]" />
                </button>
              )}

              {/* Chat dropdown menu */}
              {showChatMenu && (
                <div className="absolute top-full left-0 mt-1 min-w-56 max-h-64 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] shadow-lg py-1 z-50">
                  {[...chats].reverse().map((chat) => {
                    const chatAgent = agentOptions.find((a) => a.value === chat.agent);
                    const ChatIcon = chatAgent?.icon;
                    return (
                      <div
                        key={chat.id}
                        className={`flex items-center gap-2 px-3 py-2 text-sm cursor-pointer transition-colors group ${
                          chat.id === activeChatId
                            ? "bg-[var(--color-bg-tertiary)] text-[var(--color-text)]"
                            : "text-[var(--color-text-muted)] hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text)]"
                        }`}
                        onClick={() => switchChat(chat.id)}
                      >
                        {ChatIcon ? <ChatIcon size={14} className="shrink-0" /> : <MessageSquare className="w-3.5 h-3.5 shrink-0" />}
                        <div className="flex-1 min-w-0">
                          <div className="truncate">{chat.title}</div>
                          <div className="text-[10px] text-[var(--color-text-muted)]">
                            {new Date(chat.created_at).toLocaleDateString()}
                          </div>
                        </div>
                        {chat.id === activeChatId && (
                          <span className="text-[var(--color-highlight)] text-xs shrink-0">●</span>
                        )}
                        {chats.length > 1 && (
                          <button
                            onClick={(e) => { e.stopPropagation(); handleDeleteChat(chat.id); }}
                            className="opacity-0 group-hover:opacity-100 p-0.5 text-[var(--color-text-muted)] hover:text-[var(--color-error)] transition-all shrink-0"
                            title="Delete chat"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <span className="text-[var(--color-text-muted)]">{agentLabel}</span>
          )}

          {/* New Chat button (ACP only) */}
          {task.multiplexer === "acp" && (
            <button
              onClick={handleNewChat}
              className="flex items-center gap-1 px-1.5 py-0.5 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-highlight)] hover:bg-[var(--color-bg-tertiary)] rounded transition-colors shrink-0"
              title="New Chat"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <div className={`w-2.5 h-2.5 rounded-full ${isConnected ? "bg-[var(--color-success)] animate-pulse" : "bg-[var(--color-warning)]"}`} />
          <span className="text-xs text-[var(--color-text-muted)]">{isConnected ? "Connected" : "Connecting..."}</span>
          {onToggleFullscreen && (
            <button onClick={onToggleFullscreen}
              className="ml-1 p-1 text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] rounded transition-colors"
              title={fullscreen ? "Exit Fullscreen" : "Fullscreen"}>
              {fullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            </button>
          )}
          {onCollapse && (
            <button onClick={onCollapse}
              className="ml-1 p-1 text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] rounded transition-colors"
              title="Minimize Chat">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0 bg-[var(--color-bg-secondary)]">
        {renderItems.map((item) =>
          item.kind === "single" ? (
            <MessageItem key={`m-${item.index}`} message={item.message} index={item.index} isBusy={isBusy} agentLabel={agentLabel}
              onToggleThinkingCollapse={toggleThinkingCollapse} onPermissionResponse={handlePermissionResponse} />
          ) : (
            <ToolSectionView
              key={`ts-${item.sectionId}`}
              sectionId={item.sectionId}
              tools={item.tools}
              expanded={(isBusy && item.tools[0].index >= turnStartIndexRef.current) || expandedSections.has(item.sectionId)}
              forceExpanded={isBusy && item.tools[0].index >= turnStartIndexRef.current}
              onToggleSection={toggleSection}
              onToggleToolCollapse={toggleToolCollapse}
            />
          ),
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
      <div className="border-t border-[var(--color-border)] bg-[var(--color-bg)] px-3 pt-3 pb-2 relative">
        {/* Slash command autocomplete popover */}
        <AnimatePresence>
          {showSlashMenu && filteredSlashCommands.length > 0 && (
            <motion.div
              ref={slashMenuRef}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4 }}
              transition={{ duration: 0.12 }}
              className="absolute bottom-full left-3 right-3 mb-1 max-h-56 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] shadow-lg z-50"
            >
              {filteredSlashCommands.map((cmd, i) => (
                <button
                  key={cmd.name}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => insertCommandAtCursor(cmd.name)}
                  onMouseEnter={() => setSlashSelectedIdx(i)}
                  className={`w-full text-left px-3 py-2 flex items-start gap-2.5 transition-colors ${
                    i === slashSelectedIdx ? "bg-[var(--color-bg-tertiary)]" : "hover:bg-[var(--color-bg-secondary)]"
                  }`}
                >
                  <Slash className="w-3.5 h-3.5 mt-0.5 text-[var(--color-highlight)] shrink-0" />
                  <div className="min-w-0">
                    <div className="text-sm text-[var(--color-text)] font-medium">/{cmd.name}</div>
                    <div className="text-xs text-[var(--color-text-muted)] truncate">{cmd.description}</div>
                  </div>
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        <div className="flex gap-2 items-end">
          <div className={`flex-1 relative min-w-0 rounded-lg border bg-[var(--color-bg-secondary)] transition-colors ${
            isTerminalMode
              ? "border-[var(--color-warning)] focus-within:border-[var(--color-warning)]"
              : "border-[var(--color-border)] focus-within:border-[var(--color-highlight)]"
          }`}>
            {/* Placeholder overlay */}
            {!hasContent && (
              <div className="absolute inset-0 flex items-center px-3 text-sm text-[var(--color-text-muted)] pointer-events-none select-none">
                {!isConnected
                  ? "Waiting for connection..."
                  : isTerminalMode
                    ? "Enter shell command\u2026"
                    : "Message agent \u2014 type / for commands, ! for shell"}
              </div>
            )}
            {/* Terminal mode indicator */}
            {isTerminalMode && (
              <div className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-medium text-[var(--color-warning)] bg-[color-mix(in_srgb,var(--color-warning)_10%,transparent)] px-1.5 py-0.5 rounded pointer-events-none select-none">
                SHELL
              </div>
            )}
            <div
              ref={editableRef}
              contentEditable={isConnected && !isBusy}
              suppressContentEditableWarning
              onInput={handleInput}
              onKeyDown={handleKeyDown}
              onMouseDown={handleEditableMouseDown}
              onPaste={handlePaste}
              className={`min-h-[36px] max-h-32 overflow-y-auto px-3 py-2 text-sm text-[var(--color-text)] focus:outline-none ${
                (!isConnected || isBusy) ? "opacity-50 cursor-not-allowed" : ""
              }`}
              style={{ wordBreak: "break-word", whiteSpace: "pre-wrap" }}
            />
          </div>
          <Button variant="primary" size="sm" onClick={handleSend} disabled={!isConnected || isBusy || !hasContent}>
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
      <div className="absolute bottom-full right-0 mb-1 min-w-44 max-h-64 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] shadow-lg py-1 z-50">
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

/** Individual message rendering */
function MessageItem({ message, index, isBusy, agentLabel, onToggleThinkingCollapse, onPermissionResponse }: {
  message: ChatMessage; index: number; isBusy: boolean; agentLabel?: string;
  onToggleThinkingCollapse: (index: number) => void;
  onPermissionResponse?: (optionId: string, optionName: string) => void;
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
    case "permission":
      return <PermissionCard message={message} onRespond={onPermissionResponse} />;
    case "tool":
      // Tools are rendered via ToolSectionView; skip here
      return null;
    case "system": {
      const displayContent = message.content === "$$CONNECTED$$"
        ? `Connected to ${agentLabel || "Agent"}`
        : message.content;
      return (
        <div className="text-center text-xs text-[var(--color-text-muted)] py-1">{displayContent}</div>
      );
    }
  }
}

/** Permission request card with action buttons */
function PermissionCard({ message, onRespond }: {
  message: PermissionMessage;
  onRespond?: (optionId: string, optionName: string) => void;
}) {
  const isResolved = !!message.resolved;
  const isAllowed = isResolved && (message.resolved!.toLowerCase().includes("allow") || message.resolved!.toLowerCase().includes("yes"));

  if (isResolved) {
    return (
      <div className="flex items-center gap-2 py-1.5 px-3 rounded-lg text-xs bg-[var(--color-bg-tertiary)] border border-[var(--color-border)]">
        {isAllowed
          ? <ShieldCheck className="w-3.5 h-3.5 text-[var(--color-success)] shrink-0" />
          : <ShieldX className="w-3.5 h-3.5 text-[var(--color-error)] shrink-0" />}
        <span className="text-[var(--color-text-muted)]">{message.description}</span>
        <span className="ml-auto text-[10px] text-[var(--color-text-muted)] opacity-70">{message.resolved}</span>
      </div>
    );
  }

  const allowOptions = message.options.filter((o) => o.kind.startsWith("allow"));
  const rejectOptions = message.options.filter((o) => o.kind.startsWith("reject"));

  return (
    <div className="rounded-lg border-l-3 border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] overflow-hidden"
      style={{ borderLeftColor: "var(--color-warning)", borderLeftWidth: 3 }}>
      <div className="px-3 py-2.5">
        <div className="flex items-center gap-2 mb-2">
          <ShieldCheck className="w-4 h-4 text-[var(--color-warning)] shrink-0" />
          <span className="text-sm text-[var(--color-text)]">Permission Required</span>
        </div>
        <p className="text-xs text-[var(--color-text-muted)] mb-3 ml-6">{message.description}</p>
        <div className="flex items-center gap-2 ml-6 flex-wrap">
          {allowOptions.map((opt) => (
            <button key={opt.option_id} onClick={() => onRespond?.(opt.option_id, opt.name)}
              className="px-3 py-1 rounded-md text-xs font-medium transition-colors bg-[var(--color-success)] text-white hover:opacity-80"
              style={{ backgroundColor: "color-mix(in srgb, var(--color-success) 85%, white)" }}>
              {opt.name}
            </button>
          ))}
          {rejectOptions.map((opt) => (
            <button key={opt.option_id} onClick={() => onRespond?.(opt.option_id, opt.name)}
              className="px-3 py-1 rounded-md text-xs font-medium transition-colors border border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-error)]">
              {opt.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Single tool row used inside ToolSectionView */
function ToolItemRow({ message, onToggleCollapse }: {
  message: ToolMessage;
  onToggleCollapse: (id: string) => void;
}) {
  const isRunning = message.status === "running";
  const loc = message.locations?.[0];
  const shortPath = loc?.path
    ? loc.path.replace(/^.*\/worktrees\/[^/]+\//, "")
    : "";
  const locationLabel = shortPath
    ? `\u2018${shortPath}\u2019${loc?.line ? `:${loc.line}` : ""}`
    : "";
  const hasContent = !!message.content;

  return (
    <div>
      <div
        role={hasContent ? "button" : undefined}
        onClick={hasContent ? () => onToggleCollapse(message.id) : undefined}
        className={`flex items-center gap-1.5 py-1 px-2 rounded-md text-xs w-full text-left min-w-0 ${
          hasContent ? "hover:bg-[var(--color-bg-tertiary)] cursor-pointer" : ""
        } transition-colors`}
      >
        {isRunning
          ? <Loader2 className="w-3.5 h-3.5 text-[var(--color-highlight)] animate-spin shrink-0" />
          : <CheckCircle2 className="w-3.5 h-3.5 text-[var(--color-success)] shrink-0" />}
        {hasContent && (message.collapsed
          ? <ChevronRight className="w-3 h-3 text-[var(--color-text-muted)] shrink-0" />
          : <ChevronDown className="w-3 h-3 text-[var(--color-text-muted)] shrink-0" />)}
        <span className={`shrink-0 ${isRunning ? "text-[var(--color-highlight)]" : "text-[var(--color-text-muted)]"}`}>
          {message.title}
        </span>
        {locationLabel && (
          <span className="text-[var(--color-text-muted)] opacity-60 truncate min-w-0">
            {locationLabel}
          </span>
        )}
        <span className="ml-auto text-[10px] text-[var(--color-text-muted)] shrink-0 capitalize">{message.status}</span>
      </div>
      {hasContent && !message.collapsed && (
        <div className="ml-6 mt-1">
          <ToolContentBlock content={message.content!} />
        </div>
      )}
    </div>
  );
}

/** Collapsible section that groups consecutive tool calls */
function ToolSectionView({ sectionId, tools, expanded, forceExpanded, onToggleSection, onToggleToolCollapse }: {
  sectionId: string;
  tools: ToolSectionItem[];
  expanded: boolean;
  forceExpanded: boolean;
  onToggleSection: (sectionId: string, toolIds: string[]) => void;
  onToggleToolCollapse: (id: string) => void;
}) {
  const total = tools.length;
  const running = tools.filter((t) => t.message.status === "running").length;
  const failed = tools.filter((t) => t.message.status === "error").length;
  const completed = total - running;

  const toolIds = useMemo(() => tools.map((t) => t.message.id), [tools]);

  // Summary label
  let summaryText: string;
  if (running > 0) {
    summaryText = `Running ${running}/${total} tools\u2026`;
  } else if (failed > 0) {
    summaryText = `${completed - failed} completed, ${failed} failed`;
  } else {
    summaryText = `${total} tool${total > 1 ? "s" : ""} completed`;
  }

  // Icon
  const SummaryIcon = running > 0
    ? () => <Loader2 className="w-3.5 h-3.5 text-[var(--color-highlight)] animate-spin shrink-0" />
    : failed > 0
      ? () => <CheckCircle2 className="w-3.5 h-3.5 text-[var(--color-warning)] shrink-0" />
      : () => <CheckCircle2 className="w-3.5 h-3.5 text-[var(--color-success)] shrink-0" />;

  if (!expanded) {
    // Collapsed: single summary row
    return (
      <div
        role="button"
        onClick={() => onToggleSection(sectionId, toolIds)}
        className="flex items-center gap-1.5 py-1.5 px-2 rounded-md text-xs hover:bg-[var(--color-bg-tertiary)] cursor-pointer transition-colors"
      >
        <SummaryIcon />
        <ChevronRight className="w-3 h-3 text-[var(--color-text-muted)] shrink-0" />
        <span className="text-[var(--color-text-muted)]">{summaryText}</span>
      </div>
    );
  }

  // Expanded
  return (
    <div>
      {/* Section header */}
      <div
        role="button"
        onClick={forceExpanded ? undefined : () => onToggleSection(sectionId, toolIds)}
        className={`flex items-center gap-1.5 py-1.5 px-2 rounded-md text-xs ${
          forceExpanded ? "" : "hover:bg-[var(--color-bg-tertiary)] cursor-pointer"
        } transition-colors`}
      >
        <SummaryIcon />
        <ChevronDown className="w-3 h-3 text-[var(--color-text-muted)] shrink-0" />
        <span className="text-[var(--color-text-muted)]">Tools ({total})</span>
      </div>
      {/* Tool items with left border indent */}
      <div className="ml-2 pl-3 border-l-2 border-[var(--color-border)] space-y-0.5">
        {tools.map((t) => (
          <ToolItemRow key={t.message.id} message={t.message} onToggleCollapse={onToggleToolCollapse} />
        ))}
      </div>
    </div>
  );
}

/** Strip system-reminder tags from tool content */
function stripSystemReminders(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
}

/** Lightweight syntax highlighting via regex — returns React nodes with colored spans */
const HL_RE =
  /(\/\/.*$|\/\*[\s\S]*?\*\/|#[^\n{[]*$|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b(?:if|else|for|func|return|defer|var|const|let|type|struct|interface|import|package|range|switch|case|default|break|continue|go|select|chan|map|nil|true|false|fn|pub|mod|use|impl|trait|enum|match|self|class|def|async|await|yield|from|try|catch|throw|finally|new|delete|typeof|instanceof|int|string|bool|byte|error|float64|float32|int64|int32|uint|void|number|boolean)\b|\b\d+(?:\.\d+)?\b)/gm;

function highlightLine(line: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let lastIdx = 0;
  HL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HL_RE.exec(line)) !== null) {
    if (m.index > lastIdx) parts.push(line.slice(lastIdx, m.index));
    const t = m[0];
    let color: string;
    if (t.startsWith("//") || t.startsWith("/*") || t.startsWith("#"))
      color = "var(--color-text-muted)";
    else if (t.startsWith('"') || t.startsWith("'") || t.startsWith("`"))
      color = "var(--color-success)";
    else if (/^\d/.test(t))
      color = "var(--color-warning)";
    else
      color = "var(--color-highlight)";
    parts.push(<span key={m.index} style={{ color }}>{t}</span>);
    lastIdx = HL_RE.lastIndex;
  }
  if (lastIdx < line.length) parts.push(line.slice(lastIdx));
  return parts.length > 0 ? <>{parts}</> : line;
}

/** Detect content type for tool output */
function detectContentType(lines: string[]): "line-numbered" | "diff" | "markdown" | "plain" {
  // Line-numbered: Read File output "  123→\tcontent"
  const lineNumRegex = /^\s*\d+→/;
  const numberedCount = lines.filter((l) => lineNumRegex.test(l)).length;
  if (numberedCount > 0 && numberedCount >= lines.length * 0.5) return "line-numbered";

  // Diff: has @@ hunk markers or ---/+++ headers
  const hasDiffHeaders = lines.some(
    (l) => l.startsWith("@@") || l.startsWith("--- ") || l.startsWith("+++ "),
  );
  if (hasDiffHeaders) return "diff";

  // Markdown: headings, code fences, bold, task lists
  if (/^(#{1,6}\s|```|\*\*|- \[)/m.test(lines.join("\n"))) return "markdown";

  return "plain";
}

/** Check if a line is a truncation marker or code fence artifact */
function isMetaLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "..." || trimmed === "```" || /^```\w*$/.test(trimmed);
}

const PRE_CLASSES =
  "rounded-lg bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] p-3 overflow-x-auto text-xs font-mono text-[var(--color-text)] max-h-64 overflow-y-auto";

/** Tool content renderer with format-aware rendering */
function ToolContentBlock({ content }: { content: string }) {
  const cleaned = stripSystemReminders(content);
  if (!cleaned) return null;

  const lines = cleaned.split("\n");
  const type = detectContentType(lines);

  // Markdown: delegate to MarkdownRenderer
  if (type === "markdown") {
    return (
      <div className="text-xs">
        <MarkdownRenderer content={cleaned} />
      </div>
    );
  }

  // Line-numbered: Read File output → gutter + highlighted code
  if (type === "line-numbered") {
    const lineNumRegex = /^\s*(\d+)→\t?(.*)$/;
    return (
      <pre className={PRE_CLASSES}>
        {lines.map((line, i) => {
          // Truncation / code-fence markers → dimmed ellipsis
          if (isMetaLine(line)) {
            return (
              <div key={i} className="text-center text-[var(--color-text-muted)] opacity-40 leading-relaxed select-none">
                ⋯
              </div>
            );
          }
          const match = lineNumRegex.exec(line);
          if (match) {
            return (
              <div key={i} className="flex leading-relaxed">
                <span className="select-none text-[var(--color-text-muted)] opacity-40 w-8 shrink-0 text-right pr-3 tabular-nums">
                  {match[1]}
                </span>
                <span className="whitespace-pre-wrap">{highlightLine(match[2])}</span>
              </div>
            );
          }
          return (
            <div key={i} className="whitespace-pre-wrap pl-8 leading-relaxed">
              {highlightLine(line)}
            </div>
          );
        })}
      </pre>
    );
  }

  // Diff: line-level coloring for +/- lines
  if (type === "diff") {
    return (
      <pre className={`${PRE_CLASSES} whitespace-pre-wrap`}>
        {lines.map((line, i) => {
          if (isMetaLine(line)) {
            return (
              <div key={i} className="text-center text-[var(--color-text-muted)] opacity-40 select-none">
                ⋯
              </div>
            );
          }
          const isAdd = line.startsWith("+");
          const isDel = line.startsWith("-");
          const isHunk = line.startsWith("@@");
          return (
            <div
              key={i}
              style={
                isAdd
                  ? { background: "color-mix(in srgb, var(--color-success) 15%, transparent)", margin: "0 -12px", padding: "0 12px" }
                  : isDel
                  ? { background: "color-mix(in srgb, var(--color-error) 15%, transparent)", margin: "0 -12px", padding: "0 12px" }
                  : isHunk
                  ? { color: "var(--color-highlight)" }
                  : undefined
              }
            >
              {line || " "}
            </div>
          );
        })}
      </pre>
    );
  }

  // Plain text: highlighted pre block
  return (
    <pre className={`${PRE_CLASSES} whitespace-pre-wrap`}>
      {lines.map((line, i) => (
        <div key={i} className="leading-relaxed">{highlightLine(line) || " "}</div>
      ))}
    </pre>
  );
}
