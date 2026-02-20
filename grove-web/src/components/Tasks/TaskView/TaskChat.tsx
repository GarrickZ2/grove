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
  FileText,
  X,
  ShieldCheck,
  ShieldX,
  Plus,
  ListPlus,
  Trash2,
  Pencil,
  Square,
  Paperclip,
  Mic,
  Bot,
  Globe,
  Terminal,
} from "lucide-react";
import { Button, MarkdownRenderer, agentOptions } from "../../ui";
import type { Task } from "../../../data/types";
import { getApiHost } from "../../../api/client";
import { getConfig, listChats, createChat, updateChatTitle, deleteChat, getTaskFiles, checkCommands } from "../../../api";
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
  hideHeader?: boolean;
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

interface Attachment {
  type: "image" | "audio" | "resource";
  data: string;       // base64 for image/audio
  mimeType: string;
  name: string;       // display name
  previewUrl?: string; // blob URL for image preview
}

type ChatMessage =
  | { type: "user"; content: string; attachments?: Attachment[] }
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

interface PromptCaps {
  image: boolean;
  audio: boolean;
  embeddedContext: boolean;
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
  promptCaps: PromptCaps;
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
    promptCaps: { image: false, audio: false, embeddedContext: false },
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

/** Fuzzy match a query against a target string */
function fuzzyMatch(
  query: string,
  target: string,
): { match: boolean; score: number; indices: number[] } {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  let score = 0;
  let lastMatchIndex = -1;
  const indices: number[] = [];

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += ti === lastMatchIndex + 1 ? 2 : 1;
      if (ti === 0 || t[ti - 1] === "/") score += 3;
      lastMatchIndex = ti;
      indices.push(ti);
      qi++;
    }
  }

  return { match: qi === q.length, score, indices };
}

/** Render a file path with fuzzy-matched characters highlighted */
function HighlightedPath({ path, indices }: { path: string; indices: number[] }) {
  const indexSet = new Set(indices);
  return (
    <span>
      {Array.from(path).map((char, i) =>
        indexSet.has(i) ? (
          <span key={i} className="text-[var(--color-warning)] font-semibold">{char}</span>
        ) : (
          <span key={i}>{char}</span>
        ),
      )}
    </span>
  );
}

/** Create a non-editable file chip DOM element */
function createFileChip(filePath: string): HTMLSpanElement {
  const chip = document.createElement("span");
  chip.contentEditable = "false";
  chip.dataset.file = filePath;
  chip.title = filePath;
  chip.style.cssText =
    "display:inline-flex;align-items:center;gap:4px;padding:1px 6px;border-radius:4px;" +
    "background:color-mix(in srgb,var(--color-warning) 15%,transparent);" +
    "border:1px solid color-mix(in srgb,var(--color-warning) 30%,transparent);" +
    "font-size:12px;font-weight:500;color:var(--color-warning);" +
    "margin:0 2px;user-select:none;vertical-align:baseline;line-height:1.5;";

  const label = document.createElement("span");
  label.textContent = filePath.split("/").pop() || filePath;
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
      } else if (node.dataset.file) {
        parts.push(node.dataset.file);
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
  hideHeader = false,
}: TaskChatProps) {
  // ─── Multi-chat state ───────────────────────────────────────────────────
  const [chats, setChats] = useState<ChatSessionResponse[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [showChatMenu, setShowChatMenu] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [editTitleValue, setEditTitleValue] = useState("");
  const chatMenuRef = useRef<HTMLDivElement>(null);
  const [showAgentPicker, setShowAgentPicker] = useState(false);
  const [acpAgentAvailability, setAcpAgentAvailability] = useState<Record<string, boolean>>({});
  const [acpAvailabilityLoaded, setAcpAvailabilityLoaded] = useState(false);
  const [customAgents, setCustomAgents] = useState<CustomAgent[]>([]);
  const agentPickerRef = useRef<HTMLDivElement>(null);

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
  const [showPlan, setShowPlan] = useState(false);
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashFilter, setSlashFilter] = useState("");
  const [slashSelectedIdx, setSlashSelectedIdx] = useState(0);
  const [isTerminalMode, setIsTerminalMode] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
  const [pendingMessages, setPendingMessages] = useState<string[]>([]);
  const [showPendingQueue, setShowPendingQueue] = useState(true);
  const [editingPendingIdx, setEditingPendingIdx] = useState<number | null>(null);
  const [editingPendingValue, setEditingPendingValue] = useState("");
  const [agentLabel, setAgentLabel] = useState("Chat");
  const [AgentIcon, setAgentIcon] = useState<React.ComponentType<{ size?: number; className?: string }> | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const editableRef = useRef<HTMLDivElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const permMenuRef = useRef<HTMLDivElement>(null);
  const slashMenuRef = useRef<HTMLDivElement>(null);
  const [taskFiles, setTaskFiles] = useState<string[]>([]);
  const [showFileMenu, setShowFileMenu] = useState(false);
  const [fileFilter, setFileFilter] = useState("");
  const [fileSelectedIdx, setFileSelectedIdx] = useState(0);
  const fileMenuRef = useRef<HTMLDivElement>(null);
  const [promptCaps, setPromptCaps] = useState<PromptCaps>({ image: false, audio: false, embeddedContext: false });
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isInputExpanded, setIsInputExpanded] = useState(false);

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

  // Filtered files based on @ input
  const filteredFiles = useMemo(() => {
    if (!fileFilter) return taskFiles.slice(0, 15);
    return taskFiles
      .map((path) => {
        const { match, score, indices } = fuzzyMatch(fileFilter, path);
        return { path, score, indices, match };
      })
      .filter((r) => r.match)
      .sort((a, b) => b.score - a.score)
      .slice(0, 15);
  }, [taskFiles, fileFilter]);

  // Check ACP agent availability on mount
  useEffect(() => {
    const checkAvailability = async () => {
      try {
        const acpCheckCmds = new Set<string>();
        for (const opt of agentOptions) {
          if (opt.acpCheck) acpCheckCmds.add(opt.acpCheck);
        }
        const [cmdResults, cfg] = await Promise.all([
          checkCommands([...acpCheckCmds]),
          getConfig(),
        ]);
        setAcpAgentAvailability(cmdResults);
        setCustomAgents(cfg.acp?.custom_agents ?? []);
      } catch { /* fail-open */ }
      setAcpAvailabilityLoaded(true);
    };
    checkAvailability();
  }, []);

  // Compute available ACP agent options
  const acpAgentOptions = useMemo(() => {
    return agentOptions
      .filter(opt => opt.acpCheck)
      .map(opt => {
        if (!acpAvailabilityLoaded) return opt;
        const cmd = opt.acpCheck!;
        if (acpAgentAvailability[cmd] === false) {
          return { ...opt, disabled: true, disabledReason: `${cmd} not found` };
        }
        return opt;
      });
  }, [acpAgentAvailability, acpAvailabilityLoaded]);

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
    } else {
      getConfig()
        .then((cfg) => resolve(cfg.layout.agent_command || "claude", cfg.acp?.custom_agents))
        .catch(() => resolve("claude"));
    }
  }, [activeChat]);

  // Auto-start
  useEffect(() => {
    if (autoStart && !isLive && !sessionStarted) {
      setSessionStarted(true);
      onStartSession();
    }
  }, [autoStart, isLive, sessionStarted, onStartSession]);

  // Load task files for @ mention
  useEffect(() => {
    getTaskFiles(projectId, task.id)
      .then((res) => setTaskFiles(res.files))
      .catch(() => {});
  }, [projectId, task.id]);

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
      if (agentPickerRef.current && !agentPickerRef.current.contains(e.target as Node)) setShowAgentPicker(false);
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
      isConnected, agentLabel, agentIcon: AgentIcon, promptCaps,
    });
  }, [activeChatId, messages, isBusy, selectedModel, permissionLevel, modelOptions, modeOptions, planEntries, slashCommands, isConnected, agentLabel, AgentIcon, promptCaps]);

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
      setPromptCaps(cached.promptCaps);
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
      setPromptCaps({ image: false, audio: false, embeddedContext: false });
    }
    // Reset pending messages — server will send queue_update on reconnect
    setPendingMessages([]);
    // Clear attachments on chat switch
    setAttachments([]);
    // Point wsRef to this chat's WebSocket
    wsRef.current = wsMapRef.current.get(chatId) ?? null;
  }, []);

  // ─── Load chats on mount ───────────────────────────────────────────────

  useEffect(() => {
    if (!showChat) return;
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
  }, [showChat, projectId, task.id]);

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
    if (!activeChatId || !showChat) return;
    connectChatWs(activeChatId);
    wsRef.current = wsMapRef.current.get(activeChatId) ?? null;
  }, [activeChatId, showChat, connectChatWs]);

  // Cleanup all WebSockets on unmount
  useEffect(() => {
    return () => {
      wsMapRef.current.forEach((ws) => ws.close());
      wsMapRef.current.clear();
    };
  }, []);

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
          // Extract prompt capabilities
          if (msg.prompt_capabilities) {
            setPromptCaps({
              image: msg.prompt_capabilities.image ?? false,
              audio: msg.prompt_capabilities.audio ?? false,
              embeddedContext: msg.prompt_capabilities.embedded_context ?? false,
            });
          }
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
          setMessages((prev) => {
            // Upsert: if a tool with same ID already exists, update it (some agents send duplicate ToolCall)
            if (prev.some((m) => m.type === "tool" && m.id === msg.id)) {
              return prev.map((m) =>
                m.type === "tool" && m.id === msg.id
                  ? { ...m, title: msg.title, locations: msg.locations?.length ? msg.locations : m.locations }
                  : m,
              );
            }
            return [...prev, {
              type: "tool", id: msg.id, title: msg.title, status: "running", collapsed: false,
              locations: msg.locations,
            }];
          });
          break;
        case "tool_call_update":
          setMessages((prev) => {
            const exists = prev.some((m) => m.type === "tool" && m.id === msg.id);
            if (exists) {
              return prev.map((m) => m.type === "tool" && m.id === msg.id
                ? { ...m, status: msg.status, content: msg.content,
                    locations: msg.locations?.length ? msg.locations : m.locations } : m);
            }
            // No preceding tool_call (e.g. compacted disk replay) — create entry
            return [...prev, {
              type: "tool", id: msg.id, title: msg.id, status: msg.status,
              content: msg.content, collapsed: true, locations: msg.locations ?? [],
            }];
          });
          break;
        case "permission_request":
          setMessages((prev) => [...prev, {
            type: "permission",
            description: msg.description,
            options: msg.options ?? [],
          }]);
          break;
        case "permission_response":
          setMessages((prev) =>
            prev.map((m) => {
              if (m.type !== "permission" || m.resolved) return m;
              const match = m.options?.find((o: { option_id: string }) => o.option_id === msg.option_id);
              return { ...m, resolved: match?.name ?? msg.option_id };
            }),
          );
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
          setMessages((prev) => [...prev, {
            type: "user", content: msg.text,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            attachments: msg.attachments?.map((a: any) => ({
              type: a.type as "image" | "audio" | "resource",
              data: a.data ?? "",
              mimeType: a.mime_type ?? "",
              name: "",
              previewUrl: a.type === "image" ? `data:${a.mime_type};base64,${a.data}` : undefined,
            })),
          }]);
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
        case "queue_update":
          // Server sends QueuedMessage[]; extract text for display
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          setPendingMessages((msg.messages ?? []).map((m: any) => typeof m === "string" ? m : m.text));
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
        if (msg.prompt_capabilities) {
          state.promptCaps = {
            image: msg.prompt_capabilities.image ?? false,
            audio: msg.prompt_capabilities.audio ?? false,
            embeddedContext: msg.prompt_capabilities.embedded_context ?? false,
          };
        }
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
      case "tool_call": {
        // Upsert: if a tool with same ID already exists, update it (some agents send duplicate ToolCall)
        const toolExists = state.messages.some((m) => m.type === "tool" && m.id === msg.id);
        if (toolExists) {
          state.messages = state.messages.map((m) =>
            m.type === "tool" && m.id === msg.id
              ? { ...m, title: msg.title, locations: msg.locations?.length ? msg.locations : m.locations }
              : m,
          );
        } else {
          state.messages = [...state.messages, { type: "tool", id: msg.id, title: msg.title, status: "running", collapsed: false, locations: msg.locations }];
        }
        break;
      }
      case "thought_chunk": {
        const msgs = state.messages;
        let found = false;
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i];
          if (m.type === "thinking") {
            msgs[i] = { ...m, content: m.content + msg.text };
            found = true;
            break;
          }
          if (m.type === "user" || m.type === "assistant") break;
        }
        if (!found) msgs.push({ type: "thinking", content: msg.text, collapsed: false });
        state.messages = [...msgs];
        break;
      }
      case "tool_call_update": {
        const toolUpdateExists = state.messages.some((m) => m.type === "tool" && m.id === msg.id);
        if (toolUpdateExists) {
          state.messages = state.messages.map((m) =>
            m.type === "tool" && m.id === msg.id ? { ...m, status: msg.status, content: msg.content, locations: msg.locations?.length ? msg.locations : m.locations } : m);
        } else {
          state.messages = [...state.messages, {
            type: "tool", id: msg.id, title: msg.id, status: msg.status,
            content: msg.content, collapsed: true, locations: msg.locations ?? [],
          }];
        }
        break;
      }
      case "permission_request":
        state.messages = [...state.messages, {
          type: "permission", description: msg.description, options: msg.options ?? [],
        }];
        break;
      case "permission_response":
        state.messages = state.messages.map((m) => {
          if (m.type !== "permission" || m.resolved) return m;
          const match = m.options?.find((o: { option_id: string }) => o.option_id === msg.option_id);
          return { ...m, resolved: match?.name ?? msg.option_id };
        });
        break;
      case "complete":
        state.messages = state.messages.map((m) => m.type === "assistant" && !m.complete ? { ...m, complete: true } : m);
        state.isBusy = false;
        break;
      case "queue_update":
        // Server manages queue — ignored for non-active chat cache
        break;
      case "busy":
        state.isBusy = msg.value;
        break;
      case "user_message":
        state.messages = [...state.messages, {
          type: "user", content: msg.text,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          attachments: msg.attachments?.map((a: any) => ({
            type: a.type as "image" | "audio" | "resource",
            data: a.data ?? "",
            mimeType: a.mime_type ?? "",
            name: "",
            previewUrl: a.type === "image" ? `data:${a.mime_type};base64,${a.data}` : undefined,
          })),
        }];
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

  const handleNewChatWithAgent = useCallback(async (agent: string) => {
    setShowAgentPicker(false);
    try {
      const newChat = await createChat(projectId, task.id, undefined, agent);
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

  /** Check if the editable has any content (text, chips, or attachments) */
  const checkContent = useCallback(() => {
    const el = editableRef.current;
    if (!el) { setHasContent(attachments.length > 0); return; }
    const text = el.textContent?.trim() || "";
    const hasChips = el.querySelector("[data-command],[data-file]") !== null;
    setHasContent(text.length > 0 || hasChips || attachments.length > 0);
  }, [attachments.length]);

  /** Convert a File to an Attachment and add to state */
  const addFileAsAttachment = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(",")[1];
      const previewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
      setAttachments(prev => [...prev, {
        type: file.type.startsWith("image/") ? "image" : "audio",
        data: base64,
        mimeType: file.type,
        name: file.name,
        previewUrl,
      }]);
    };
    reader.readAsDataURL(file);
  }, []);

  const removeAttachment = useCallback((index: number) => {
    setAttachments(prev => {
      const att = prev[index];
      if (att?.previewUrl) URL.revokeObjectURL(att.previewUrl);
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const handleSend = useCallback(() => {
    const el = editableRef.current;
    if (!el) return;
    const prompt = getPromptFromEditable(el);
    if ((!prompt && attachments.length === 0) || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    // Shell mode → wrap as terminal command
    const text = isTerminalMode
      ? `Run this command: \`${prompt}\``
      : prompt;

    // Build attachments payload for server
    const contentAttachments = attachments.map(att => ({
      type: att.type,
      data: att.data,
      mime_type: att.mimeType,
    }));

    if (isBusy) {
      // Queue message on server when agent is busy
      wsRef.current.send(JSON.stringify({ type: "queue_message", text, attachments: contentAttachments }));
      el.innerHTML = "";
      setHasContent(false);
      setAttachments([]);
      setShowSlashMenu(false);
      setShowFileMenu(false);
      setIsTerminalMode(false);
      setIsInputExpanded(false);
      setShowPendingQueue(true);
      el.focus();
    } else {
      wsRef.current.send(JSON.stringify({ type: "prompt", text, attachments: contentAttachments }));
      el.innerHTML = "";
      setHasContent(false);
      setAttachments([]);
      setShowSlashMenu(false);
      setShowFileMenu(false);
      setIsTerminalMode(false);
      setIsInputExpanded(false);
      setIsBusy(true);
      el.focus();
    }
  }, [isTerminalMode, isBusy, attachments]);

  /** Cancel current agent work — server auto-sends next queued message after Complete */
  const handleSendNow = useCallback(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "cancel" }));
  }, []);

  /** Stop agent (only shown when no pending messages) */
  const handleStopAgent = useCallback(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "cancel" }));
  }, []);

  const handleEditPending = useCallback((i: number) => {
    setEditingPendingIdx(i);
    setEditingPendingValue(pendingMessages[i]);
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "pause_queue" }));
    }
  }, [pendingMessages]);

  const handleSavePendingEdit = useCallback(() => {
    if (editingPendingIdx === null || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const trimmed = editingPendingValue.trim();
    if (!trimmed) {
      wsRef.current.send(JSON.stringify({ type: "dequeue_message", index: editingPendingIdx }));
    } else {
      wsRef.current.send(JSON.stringify({ type: "update_queued_message", index: editingPendingIdx, text: trimmed }));
    }
    setEditingPendingIdx(null);
    setEditingPendingValue("");
    wsRef.current.send(JSON.stringify({ type: "resume_queue" }));
  }, [editingPendingIdx, editingPendingValue]);

  const handleCancelPendingEdit = useCallback(() => {
    setEditingPendingIdx(null);
    setEditingPendingValue("");
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "resume_queue" }));
    }
  }, []);

  const handleDeletePending = useCallback((i: number) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "dequeue_message", index: i }));
    if (editingPendingIdx === i) {
      setEditingPendingIdx(null);
      setEditingPendingValue("");
    }
  }, [editingPendingIdx]);

  const handleClearPending = useCallback(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "clear_queue" }));
    setEditingPendingIdx(null);
    setEditingPendingValue("");
  }, []);

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

  /** Detect /slash or @file at cursor position in contentEditable */
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
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) {
      setShowSlashMenu(false);
      setShowFileMenu(false);
      return;
    }
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) {
      setShowSlashMenu(false);
      setShowFileMenu(false);
      return;
    }
    const text = node.textContent || "";
    const offset = range.startOffset;
    // Scan backwards from cursor to find "/" or "@"
    let slashIdx = -1;
    let atIdx = -1;
    for (let i = offset - 1; i >= 0; i--) {
      if (text[i] === "/") {
        if (i === 0 || /\s/.test(text[i - 1])) slashIdx = i;
        break;
      }
      if (text[i] === "@") {
        if (i === 0 || /\s/.test(text[i - 1])) atIdx = i;
        break;
      }
      if (/\s/.test(text[i])) break;
    }
    if (atIdx >= 0 && taskFiles.length > 0) {
      setFileFilter(text.slice(atIdx + 1, offset));
      setShowFileMenu(true);
      setFileSelectedIdx(0);
      setShowSlashMenu(false);
    } else if (slashIdx >= 0 && slashCommands.length > 0) {
      setSlashFilter(text.slice(slashIdx + 1, offset));
      setShowSlashMenu(true);
      setSlashSelectedIdx(0);
      setShowFileMenu(false);
    } else {
      setShowSlashMenu(false);
      setShowFileMenu(false);
    }
  }, [checkContent, isTerminalMode, slashCommands.length, taskFiles.length]);

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

  /** Insert a file chip at the current cursor position, replacing the @partial text */
  const insertFileAtCursor = useCallback((filePath: string) => {
    const el = editableRef.current;
    if (!el) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) return;
    const text = node.textContent || "";
    const offset = range.startOffset;
    // Find the "@" start
    let atIdx = -1;
    for (let i = offset - 1; i >= 0; i--) {
      if (text[i] === "@") { if (i === 0 || /\s/.test(text[i - 1])) atIdx = i; break; }
      if (/\s/.test(text[i])) break;
    }
    if (atIdx < 0) return;
    const before = text.slice(0, atIdx);
    const after = text.slice(offset);
    const parent = node.parentNode;
    if (!parent) return;
    const chip = createFileChip(filePath);
    const frag = document.createDocumentFragment();
    if (before) frag.appendChild(document.createTextNode(before));
    frag.appendChild(chip);
    const afterNode = document.createTextNode(after || " ");
    frag.appendChild(afterNode);
    parent.replaceChild(frag, node);
    const newRange = document.createRange();
    newRange.setStart(afterNode, after ? 0 : 1);
    newRange.collapse(true);
    sel.removeAllRanges();
    sel.addRange(newRange);
    setShowFileMenu(false);
    checkContent();
  }, [checkContent]);

  /** Delegated click handler for chip close buttons */
  const handleEditableMouseDown = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.dataset.chipClose || target.closest("[data-chip-close]")) {
      e.preventDefault();
      const chip = target.closest("[data-command],[data-file]");
      if (chip) { chip.remove(); checkContent(); }
    }
  }, [checkContent]);

  /** Strip HTML on paste — insert plain text or handle image paste */
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    // Check for image paste
    const items = Array.from(e.clipboardData.items);
    const imageItem = items.find(i => i.type.startsWith("image/"));
    if (imageItem && promptCaps.image) {
      e.preventDefault();
      const file = imageItem.getAsFile();
      if (file) addFileAsAttachment(file);
      return;
    }
    // Default: plain text paste
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    document.execCommand("insertText", false, text);
    checkContent();
  }, [checkContent, promptCaps.image, addFileAsAttachment]);

  /** Handle file input selection */
  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    files.forEach(file => {
      if (file.type.startsWith("image/") && promptCaps.image) addFileAsAttachment(file);
      else if (file.type.startsWith("audio/") && promptCaps.audio) addFileAsAttachment(file);
    });
    // Reset input so same file can be selected again
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [promptCaps.image, promptCaps.audio, addFileAsAttachment]);

  /** Drag & drop handlers */
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (promptCaps.image || promptCaps.audio) setIsDragging(true);
  }, [promptCaps.image, promptCaps.audio]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // Only set false when leaving the container (not entering a child)
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files);
    files.forEach(file => {
      if (file.type.startsWith("image/") && promptCaps.image) addFileAsAttachment(file);
      else if (file.type.startsWith("audio/") && promptCaps.audio) addFileAsAttachment(file);
    });
  }, [promptCaps.image, promptCaps.audio, addFileAsAttachment]);

  // Re-check hasContent when attachments change
  useEffect(() => { checkContent(); }, [attachments.length, checkContent]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Skip during IME composition (e.g. Chinese/Japanese input)
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;

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
    // Expanded input: Escape → collapse
    if (isInputExpanded && e.key === "Escape") {
      e.preventDefault();
      setIsInputExpanded(false);
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
    // File menu navigation
    if (showFileMenu && filteredFiles.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFileSelectedIdx((prev) => (prev + 1) % filteredFiles.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setFileSelectedIdx((prev) => (prev - 1 + filteredFiles.length) % filteredFiles.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        const item = filteredFiles[fileSelectedIdx];
        insertFileAtCursor(typeof item === "string" ? item : item.path);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setShowFileMenu(false);
        return;
      }
    }
    // Cmd+Option+Backspace → clear pending queue
    if (e.key === "Backspace" && e.metaKey && e.altKey && pendingMessages.length > 0) {
      e.preventDefault();
      handleClearPending();
      return;
    }
    // Expanded mode: Cmd/Ctrl+Enter → send, plain Enter → newline
    // Inline mode: Enter → send, Shift+Enter → newline
    if (isInputExpanded) {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); handleSend(); }
    } else {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
    }
  }, [handleSend, isTerminalMode, isInputExpanded, showSlashMenu, filteredSlashCommands, slashSelectedIdx, insertCommandAtCursor, showFileMenu, filteredFiles, fileSelectedIdx, insertFileAtCursor, pendingMessages, handleClearPending]);

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
        {!hideHeader && (
          <div className="flex items-center justify-between px-3 py-2 bg-[var(--color-bg)] border-b border-[var(--color-border)]">
            <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
              {AgentIcon ? <AgentIcon size={16} /> : <MessageSquare className="w-4 h-4" />}<span>{agentLabel}</span>
            </div>
          </div>
        )}
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
      {!hideHeader && (
      <div className="flex items-center justify-between px-3 py-2 bg-[var(--color-bg-secondary)] border-b border-[var(--color-border)]">
        <div className="flex items-center gap-2 text-sm min-w-0">
          {AgentIcon ? <AgentIcon size={16} className="text-[var(--color-text-muted)] shrink-0" /> : <MessageSquare className="w-4 h-4 text-[var(--color-text-muted)] shrink-0" />}

          {/* Chat title / dropdown */}
          {activeChat ? (
            <div className="relative min-w-0 flex-1" ref={chatMenuRef}>
              {editingTitle ? (
                <input
                  autoFocus
                  value={editTitleValue}
                  onChange={(e) => setEditTitleValue(e.target.value)}
                  onBlur={handleTitleSave}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
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

          {/* New Chat button + Agent Picker */}
          <div className="relative shrink-0" ref={agentPickerRef}>
            <button
              onClick={() => { setShowChatMenu(false); setShowAgentPicker(!showAgentPicker); }}
              className="flex items-center gap-1 px-1.5 py-0.5 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-highlight)] hover:bg-[var(--color-bg-tertiary)] rounded transition-colors"
              title="New Chat"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>

            {showAgentPicker && (
              <div className="absolute top-full left-0 mt-1 min-w-48 max-h-64 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] shadow-lg py-1 z-50">
                {!acpAvailabilityLoaded && (
                  <div className="flex items-center gap-2 px-3 py-2 text-sm text-[var(--color-text-muted)]">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking...
                  </div>
                )}
                {acpAvailabilityLoaded && acpAgentOptions.filter(opt => !opt.disabled).map(opt => {
                  const Icon = opt.icon;
                  return (
                    <button key={opt.id}
                      onClick={() => handleNewChatWithAgent(opt.value)}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)] transition-colors">
                      <div className="w-4 h-4 flex items-center justify-center shrink-0">
                        {Icon ? <Icon size={14} /> : <Bot className="w-3.5 h-3.5" />}
                      </div>
                      <span className="truncate">{opt.label}</span>
                    </button>
                  );
                })}
                {acpAvailabilityLoaded && customAgents.length > 0 && (
                  <>
                    <div className="my-1 border-t border-[var(--color-border)]" />
                    <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">Custom</div>
                    {customAgents.map(agent => (
                      <button key={agent.id}
                        onClick={() => handleNewChatWithAgent(agent.id)}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)] transition-colors">
                        <div className="w-4 h-4 flex items-center justify-center shrink-0">
                          {agent.type === "remote"
                            ? <Globe className="w-3.5 h-3.5 text-[var(--color-info)]" />
                            : <Terminal className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />}
                        </div>
                        <span className="truncate">{agent.name}</span>
                      </button>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
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
      )}

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
              <span className="text-xs text-[var(--color-text-muted)] opacity-60">
                {planEntries.filter((e) => e.status === "completed").length}/{planEntries.length}
              </span>
            </div>
            {planEntries.filter((e) => e.status === "completed").length === planEntries.length && (
              <span className="text-xs text-[var(--color-success)]">All Done</span>
            )}
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

      {/* Pending Queue */}
      {pendingMessages.length > 0 && (
        <div className="border-t border-[var(--color-border)] bg-[var(--color-bg)]">
          <button onClick={() => setShowPendingQueue(!showPendingQueue)}
            className="w-full flex items-center justify-between px-4 py-2 text-sm hover:bg-[var(--color-bg-tertiary)] transition-colors">
            <div className="flex items-center gap-2 text-[var(--color-text-muted)]">
              <motion.div animate={{ rotate: showPendingQueue ? 90 : 0 }} transition={{ duration: 0.15 }}>
                <ChevronRight className="w-3.5 h-3.5" />
              </motion.div>
              <span>{pendingMessages.length} Queued Message{pendingMessages.length > 1 ? "s" : ""}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-[var(--color-text-muted)] opacity-50 font-mono">{"\u2318\u2325\u232B"}</span>
              <button
                onClick={(e) => { e.stopPropagation(); handleClearPending(); }}
                className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-error)] transition-colors"
              >
                Clear All
              </button>
            </div>
          </button>
          <AnimatePresence initial={false}>
            {showPendingQueue && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2, ease: "easeInOut" }}
                className="overflow-hidden"
              >
                <div className="px-4 pb-2 space-y-1">
                  {pendingMessages.map((msg, i) => (
                    <div key={i} className="flex items-center gap-2 py-1 text-sm">
                      <span className="text-xs text-[var(--color-text-muted)] w-4 shrink-0 text-right">{i + 1}</span>
                      {editingPendingIdx === i ? (
                        <input
                          autoFocus
                          value={editingPendingValue}
                          onChange={(e) => setEditingPendingValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                            if (e.key === "Enter") { e.preventDefault(); handleSavePendingEdit(); }
                            if (e.key === "Escape") handleCancelPendingEdit();
                          }}
                          onBlur={handleSavePendingEdit}
                          className="flex-1 min-w-0 text-sm text-[var(--color-text)] bg-[var(--color-bg-secondary)] border border-[var(--color-highlight)] rounded px-2 py-0.5 outline-none"
                        />
                      ) : (
                        <>
                          <span className="flex-1 min-w-0 truncate text-[var(--color-text)]">{msg}</span>
                          <div className="flex items-center gap-1 shrink-0">
                            {i === 0 && (
                              <button
                                onClick={() => handleSendNow()}
                                className="flex items-center gap-1 px-1.5 py-0.5 text-xs text-[var(--color-highlight)] hover:bg-[var(--color-bg-tertiary)] rounded transition-colors"
                                title="Send Now (cancels current, sends this)"
                              >
                                <Send className="w-3 h-3" />
                                <span>Now</span>
                              </button>
                            )}
                            <button
                              onClick={() => handleEditPending(i)}
                              className="p-1 text-[var(--color-text-muted)] hover:text-[var(--color-text)] rounded transition-colors"
                              title="Edit"
                            >
                              <Pencil className="w-3 h-3" />
                            </button>
                            <button
                              onClick={() => handleDeletePending(i)}
                              className="p-1 text-[var(--color-text-muted)] hover:text-[var(--color-error)] rounded transition-colors"
                              title="Delete"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      {/* Input */}
      <div className="border-t border-[var(--color-border)] bg-[var(--color-bg)] px-3 pt-3 pb-2 relative"
        onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
        {/* Drag overlay for input area */}
        {isDragging && !isInputExpanded && (
          <div className="absolute inset-0 bg-[color-mix(in_srgb,var(--color-highlight)_10%,transparent)] border-2 border-dashed border-[var(--color-highlight)] rounded-lg flex items-center justify-center z-50 pointer-events-none">
            <span className="text-[var(--color-highlight)] font-medium text-sm">Drop files here</span>
          </div>
        )}
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

        {/* File @ mention autocomplete popover */}
        <AnimatePresence>
          {showFileMenu && filteredFiles.length > 0 && (
            <motion.div
              ref={fileMenuRef}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4 }}
              transition={{ duration: 0.12 }}
              className="absolute bottom-full left-3 right-3 mb-1 max-h-56 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] shadow-lg z-50"
            >
              {filteredFiles.map((item, i) => {
                const filePath = typeof item === "string" ? item : item.path;
                const indices = typeof item === "string" ? null : item.indices;
                return (
                  <button
                    key={filePath}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => insertFileAtCursor(filePath)}
                    onMouseEnter={() => setFileSelectedIdx(i)}
                    className={`w-full text-left px-3 py-2 flex items-center gap-2.5 transition-colors ${
                      i === fileSelectedIdx ? "bg-[var(--color-bg-tertiary)]" : "hover:bg-[var(--color-bg-secondary)]"
                    }`}
                  >
                    <FileText className="w-3.5 h-3.5 text-[var(--color-warning)] shrink-0" />
                    <span className="text-sm text-[var(--color-text)] font-mono truncate">
                      {indices ? <HighlightedPath path={filePath} indices={indices} /> : filePath}
                    </span>
                  </button>
                );
              })}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Attachment preview strip */}
        {attachments.length > 0 && (
          <div className="flex gap-2 px-1 pb-2 flex-wrap">
            {attachments.map((att, i) => (
              <div key={i} className="relative group">
                {att.type === "image" && att.previewUrl ? (
                  <img src={att.previewUrl} className="w-16 h-16 object-cover rounded border border-[var(--color-border)]" alt={att.name} />
                ) : att.type === "audio" ? (
                  <div className="w-16 h-16 rounded border border-[var(--color-border)] flex items-center justify-center bg-[var(--color-bg-tertiary)]">
                    <Mic className="w-6 h-6 text-[var(--color-text-muted)]" />
                  </div>
                ) : null}
                <button onClick={() => removeAttachment(i)}
                  className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-[var(--color-error)] text-white flex items-center justify-center text-[10px] opacity-0 group-hover:opacity-100 transition-opacity">
                  &times;
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          accept={[promptCaps.image ? "image/*" : "", promptCaps.audio ? "audio/*" : ""].filter(Boolean).join(",")}
          multiple
          className="hidden"
          onChange={handleFileSelect}
        />

        <div className="flex gap-2 items-end">
          {/* Attachment button */}
          {(promptCaps.image || promptCaps.audio) && (
            <button
              onClick={() => fileInputRef.current?.click()}
              className="h-9 w-9 flex items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors shrink-0"
              title="Attach file"
            >
              <Paperclip className="w-4 h-4" />
            </button>
          )}

          <div
            className={`flex-1 relative min-w-0 rounded-lg border bg-[var(--color-bg-secondary)] transition-all ${
              isTerminalMode
                ? "border-[var(--color-warning)] focus-within:border-[var(--color-warning)]"
                : "border-[var(--color-border)] focus-within:border-[var(--color-highlight)]"
            }`}
            onDragOver={isInputExpanded ? handleDragOver : undefined}
            onDragLeave={isInputExpanded ? handleDragLeave : undefined}
            onDrop={isInputExpanded ? handleDrop : undefined}
          >
            {/* Placeholder overlay */}
            {!hasContent && (
              <div className={`absolute ${isInputExpanded ? "top-0 left-0 right-0 h-9" : "inset-0"} flex items-center px-3 text-sm text-[var(--color-text-muted)] pointer-events-none select-none`}>
                {!isConnected
                  ? "Waiting for connection..."
                  : isTerminalMode
                    ? "Enter shell command\u2026"
                    : isBusy
                      ? "Queue a message\u2026"
                      : isInputExpanded
                        ? "Write your message\u2026 (\u2318\u21A9 to send)"
                        : "Message agent\u2026"}
              </div>
            )}
            {/* Terminal mode indicator */}
            {isTerminalMode && !isInputExpanded && (
              <div className="absolute right-8 top-1/2 -translate-y-1/2 text-[10px] font-medium text-[var(--color-warning)] bg-[color-mix(in_srgb,var(--color-warning)_10%,transparent)] px-1.5 py-0.5 rounded pointer-events-none select-none">
                SHELL
              </div>
            )}
            {/* Expand/Collapse toggle */}
            <button
              onClick={() => {
                setIsInputExpanded(v => !v);
                setTimeout(() => editableRef.current?.focus(), 0);
              }}
              className="absolute right-1.5 top-1.5 p-1 text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] rounded transition-colors z-10"
              title={isInputExpanded ? "Collapse input (Esc)" : "Expand input"}
            >
              {isInputExpanded
                ? <Minimize2 className="w-3.5 h-3.5" />
                : <Maximize2 className="w-3.5 h-3.5" />}
            </button>
            {/* Drag overlay for expanded mode */}
            {isInputExpanded && isDragging && (
              <div className="absolute inset-0 bg-[color-mix(in_srgb,var(--color-highlight)_10%,transparent)] border-2 border-dashed border-[var(--color-highlight)] rounded-lg flex items-center justify-center z-20 pointer-events-none">
                <span className="text-[var(--color-highlight)] font-medium text-sm">Drop files here</span>
              </div>
            )}
            <div
              ref={editableRef}
              contentEditable={isConnected}
              suppressContentEditableWarning
              onInput={handleInput}
              onKeyDown={handleKeyDown}
              onMouseDown={handleEditableMouseDown}
              onPaste={handlePaste}
              className={`overflow-y-auto px-3 py-2 pr-8 text-sm text-[var(--color-text)] focus:outline-none ${
                isInputExpanded ? "min-h-[40vh] max-h-[60vh]" : "min-h-[36px] max-h-32"
              } ${!isConnected ? "opacity-50 cursor-not-allowed" : ""}`}
              style={{ wordBreak: "break-word", whiteSpace: "pre-wrap" }}
            />
            {/* Expanded mode: attachment preview + footer inside the box */}
            {isInputExpanded && attachments.length > 0 && (
              <div className="flex gap-2 px-3 pb-2 flex-wrap border-t border-[var(--color-border)]">
                {attachments.map((att, i) => (
                  <div key={i} className="relative group mt-2">
                    {att.type === "image" && att.previewUrl ? (
                      <img src={att.previewUrl} className="w-12 h-12 object-cover rounded border border-[var(--color-border)]" alt={att.name} />
                    ) : att.type === "audio" ? (
                      <div className="w-12 h-12 rounded border border-[var(--color-border)] flex items-center justify-center bg-[var(--color-bg-tertiary)]">
                        <Mic className="w-4 h-4 text-[var(--color-text-muted)]" />
                      </div>
                    ) : null}
                    <button onClick={() => removeAttachment(i)}
                      className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-[var(--color-error)] text-white flex items-center justify-center text-[10px] opacity-0 group-hover:opacity-100 transition-opacity">
                      &times;
                    </button>
                  </div>
                ))}
              </div>
            )}
            {/* Expanded mode footer: hints only */}
            {isInputExpanded && (
              <div className="flex items-center px-3 py-1.5 border-t border-[var(--color-border)]">
                <span className="text-[10px] text-[var(--color-text-muted)] opacity-60">
                  {"\u2318\u21A9"} send &middot; {"\u21A9"} newline &middot; Esc collapse
                </span>
              </div>
            )}
          </div>
          {!isBusy && hasContent ? (
            <Button variant="primary" size="sm" className="h-9 w-9 !p-0" onClick={handleSend} disabled={!isConnected}>
              <Send className="w-4 h-4" />
            </Button>
          ) : isBusy && hasContent ? (
            <Button variant="primary" size="sm" className="h-9 w-9 !p-0" onClick={handleSend}>
              <ListPlus className="w-4 h-4" />
            </Button>
          ) : isBusy && !hasContent ? (
            pendingMessages.length > 0 ? (
              <Button variant="secondary" size="sm" className="h-9 w-9 !p-0" onClick={handleSendNow}>
                <Send className="w-4 h-4" />
              </Button>
            ) : (
              <Button variant="secondary" size="sm" className="h-9 w-9 !p-0" onClick={handleStopAgent}>
                <Square className="w-3.5 h-3.5" />
              </Button>
            )
          ) : (
            <Button variant="primary" size="sm" className="h-9 w-9 !p-0" disabled>
              <Send className="w-4 h-4" />
            </Button>
          )}
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
          <div className="max-w-[85%] rounded-lg px-3 py-2 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] text-sm text-[var(--color-text)]">
            {message.attachments?.map((att, i) => (
              att.type === "image" && att.previewUrl ? (
                <img key={i} src={att.previewUrl} className="max-w-full max-h-48 rounded mb-2 cursor-pointer"
                  onClick={() => window.open(att.previewUrl, '_blank')} alt="" />
              ) : att.type === "audio" ? (
                <audio key={i} controls src={`data:${att.mimeType};base64,${att.data}`} className="max-w-full mb-2" />
              ) : null
            ))}
            {message.content && <div className="whitespace-pre-wrap">{message.content}</div>}
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
  const cleaned = content.trim();
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
