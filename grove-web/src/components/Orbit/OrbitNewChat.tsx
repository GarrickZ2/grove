import { createElement, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { Bot, Box, Brain, ChevronDown, Folder, GitBranch, Globe, Laptop, Loader2, Mic, Paperclip, Send, ShieldCheck, Terminal } from "lucide-react";
import { createChat, listChats } from "../../api";
import type { AgentConfigSelection } from "../../api/agentConfig";
import { listInstalledAgentConfigs, type InstalledAgentConfig } from "../../api/marketplace";
import type { SessionConfigOption } from "../../api/tasks";
import { useProject, useTheme } from "../../context";
import { useIsMobile } from "../../hooks";
import { agentOptions, type AgentOption } from "../../data/agents";
import { configForAgent } from "../../utils/agentConfig";
import { agentIconComponent } from "../../utils/agentIcon";
import { getProjectStyle } from "../../utils/projectStyle";
import { formatTimeAgo } from "../../utils/notificationFormat";
import { PickerMenu, type PickerMenuItem } from "../ui/PickerMenu";
import { Button } from "../ui/Button";
import { useACPAvailability } from "../Tasks/TaskView/useACPAvailability";
import { DropdownSelect, SessionSettingsMenu, type ChatDropdownOption } from "../Tasks/TaskView/ChatConfigMenus";
import { configDropdownValues, quickConfigOptions } from "../Tasks/TaskView/sessionConfigOptions";
import { buildDefaultSessionTitle } from "../Tasks/TaskView/useInitialChatLoad";
import { AttachmentError, attachmentLabel, prepareFileAttachment, type Attachment } from "../Tasks/TaskView/chatAttachments";
import { promptConfigFromSelection } from "./orbitDraftConfig";
import { setOrbitFirstMessage } from "./orbitFirstMessage";
import "./orbit-new-chat.css";

const LAST_AGENT_KEY = "grove-orbit-new-agent";
/** Composer slide-down before the Session view takes over. */
const HANDOFF_MS = 320;
const NO_PENDING_CONFIG = new Set<string>();
/** Phone: recent Sessions listed above the composer as quick ways back in. */
const RECENT_LIMIT = 3;

type RecentSession = { taskId: string; taskName?: string; chatId: string; title: string; agent: string; createdAt: string };

type MenuId = "agent" | "model" | "mode" | "thinking" | "settings";

function readLastAgent(): string | null {
  try { return localStorage.getItem(LAST_AGENT_KEY); } catch { return null; }
}

function writeLastAgent(agentId: string): void {
  try { localStorage.setItem(LAST_AGENT_KEY, agentId); } catch { /* per-viewer convenience only */ }
}

// The unsent message survives reloads and leaving the page; cleared once sent.
const DRAFT_KEY = "grove-orbit-new-draft";

function readDraft(): string {
  try { return localStorage.getItem(DRAFT_KEY) ?? ""; } catch { return ""; }
}

function writeDraft(value: string): void {
  try {
    if (value) localStorage.setItem(DRAFT_KEY, value);
    else localStorage.removeItem(DRAFT_KEY);
  } catch { /* per-viewer convenience only */ }
}

function dropdownValues(option: SessionConfigOption | undefined): ChatDropdownOption[] {
  return option?.type === "select"
    ? configDropdownValues(option).map((value) => ({ label: value.name, value: value.value, description: value.description, group: value.group }))
    : [];
}

/**
 * Cross-fade into the Session view: this page unmounts on navigation, so leave
 * a non-interactive copy of the docked composer in place, then move it onto
 * the Session composer's measured rect while it fades out. Measuring (instead
 * of assuming a dock position) keeps the hand-off exact across window chrome
 * and side panels.
 */
function leaveComposerGhost(composer: HTMLElement | null): void {
  if (!composer) return;
  const rect = composer.getBoundingClientRect();
  // Cloning a textarea keeps its typed value, so the text stays put during the fade.
  const ghost = composer.cloneNode(true) as HTMLElement;
  Object.assign(ghost.style, {
    position: "fixed", left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`,
    margin: "0", transform: "none", overflow: "hidden", zIndex: "60", pointerEvents: "none",
    transition: ["left", "top", "width", "height", "opacity"].map((property) => `${property} ${HANDOFF_MS}ms cubic-bezier(.25, 1, .5, 1)`).join(", "),
  });
  ghost.setAttribute("aria-hidden", "true");
  document.body.appendChild(ghost);
  // The Session view mounts after navigation; wait (a few frames at most) for its composer.
  const settle = (frame: number) => {
    const target = Array.from(document.querySelectorAll<HTMLElement>("main .chatbox-bubble"))
      .find((element) => element.offsetParent !== null && !element.classList.contains("orbit-new__composer"));
    if (!target && frame < 30) {
      requestAnimationFrame(() => settle(frame + 1));
      return;
    }
    if (target) {
      const to = target.getBoundingClientRect();
      Object.assign(ghost.style, { left: `${to.left}px`, top: `${to.top}px`, width: `${to.width}px`, height: `${to.height}px` });
    }
    ghost.style.opacity = "0";
    window.setTimeout(() => ghost.remove(), HANDOFF_MS + 200);
  };
  requestAnimationFrame(() => settle(0));
}

interface OrbitNewChatProps {
  /** Target Task; "_local" (default) is the project's Local Task. */
  initialTaskId?: string;
  onNavigate: (page: string, data?: Record<string, unknown>) => void;
}

/**
 * Orbit's New page: the chat composer, centered, that only creates the
 * Session when the first message is sent — with the Agent / config /
 * project / Task picked here. Config options come from the Agent's persisted
 * capability snapshot, so an Agent that has never connected starts with its
 * defaults.
 */
export function OrbitNewChat({ initialTaskId = "_local", onNavigate }: OrbitNewChatProps) {
  const { projects, selectedProject, selectProject } = useProject();
  const { theme } = useTheme();
  // In Orbit only phones are "mobile"; tablets keep the desktop layout.
  const { isMobile: phone } = useIsMobile();
  const { baseAgents, customAgents, customAgentPersonas, acpAvailabilityLoaded } = useACPAvailability();
  const [agents, setAgents] = useState<InstalledAgentConfig[]>([]);
  const [selection, setSelection] = useState<AgentConfigSelection>({ source: "default" });
  const [taskId, setTaskId] = useState(initialTaskId);
  const [text, setText] = useState(readDraft);
  const [sending, setSending] = useState(false);
  const [handoffOffset, setHandoffOffset] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Kept in memory only (a reload drops them); uploaded by TaskChat when the first prompt is sent.
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const attachCountersRef = useRef({ image: 0, audio: 0, resource: 0 });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const addFiles = (files: File[]) => {
    for (const file of files) {
      void prepareFileAttachment(file)
        .then((prepared) => {
          attachCountersRef.current[prepared.type] += 1;
          const label = attachmentLabel(prepared.type, attachCountersRef.current[prepared.type]);
          setAttachments((previous) => [...previous, { ...prepared, label }]);
        })
        .catch((reason) => { if (reason instanceof AttachmentError) setError(reason.message); });
    }
  };
  const removeAttachment = (index: number) => setAttachments((previous) => {
    const removed = previous[index];
    if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
    return previous.filter((_, i) => i !== index);
  });
  const [openMenu, setOpenMenu] = useState<MenuId | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const agentMenuRef = useRef<HTMLDivElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const modeMenuRef = useRef<HTMLDivElement>(null);
  const thinkingMenuRef = useRef<HTMLDivElement>(null);
  const settingsMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    listInstalledAgentConfigs()
      .then((installed) => {
        if (disposed) return;
        setAgents(installed);
        const preferred = installed.find((agent) => agent.id === readLastAgent()) ?? installed[0];
        if (preferred) setSelection(configForAgent(preferred));
      })
      .catch((reason) => {
        console.error("Failed to load installed Agents", reason);
        if (!disposed) setError("Could not load installed Agents.");
      })
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    const input = inputRef.current;
    // On a phone, focusing would throw the keyboard up before the user asks for it.
    if (!input || phone) return;
    input.focus();
    // A restored draft continues where it left off.
    input.setSelectionRange(input.value.length, input.value.length);
  }, [phone]);

  // Footer menus are controlled here (as in TaskChat), so close them on outside clicks.
  useEffect(() => {
    if (!openMenu) return;
    const refs = { agent: agentMenuRef, model: modelMenuRef, mode: modeMenuRef, thinking: thinkingMenuRef, settings: settingsMenuRef };
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (refs[openMenu].current?.contains(target)) return;
      // SessionSettingsMenu renders its panel in a portal.
      if ((target as Element).closest?.("[data-session-settings-menu]")) return;
      setOpenMenu(null);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [openMenu]);

  const agentId = selection.agent_id ?? "";
  // Only built-in Agents have a capability snapshot; Custom Agents carry their own config.
  const agent = agents.find((candidate) => candidate.id === agentId);
  const snapshot = agent?.capability_snapshot;
  // Same option list as TaskChat's New Session picker.
  const pickerOptions = useMemo<AgentOption[]>(() => baseAgents
    .filter((base) => base.available)
    .map((base) => ({ ...(agentOptions.find((option) => option.value === base.id || option.id === base.id) ?? { id: base.id }), label: base.display_name, value: base.id })), [baseAgents]);
  const persona = customAgentPersonas.find((item) => item.id === agentId);
  const customServer = customAgents.find((item) => item.id === agentId);
  const agentLabel = persona?.name ?? customServer?.name ?? pickerOptions.find((option) => option.value === agentId)?.label ?? agent?.name ?? "";
  const agentIconType = customServer ? (customServer.type === "remote" ? Globe : Terminal) : agentIconComponent(agentId);
  // createElement: the icon is looked up from a static registry, not defined during render.
  const agentIcon = agentIconType
    ? createElement(agentIconType, { size: 12, className: "shrink-0 text-[var(--color-highlight)]" })
    : <Bot className="h-3 w-3 shrink-0 text-[var(--color-highlight)]" />;
  const iconOf = (type: ComponentType<{ size?: number; className?: string }> | null | undefined) =>
    type ? createElement(type, { size: 15 }) : <Bot className="h-3.5 w-3.5" />;
  // Same entries as TaskChat's New Session picker: Agents and Agent servers, then Custom Agents.
  const agentItems: PickerMenuItem[] = [
    // Static catalog first, then the icon registry — the same fallback AgentPickerMenuItems uses.
    ...pickerOptions.map((option) => ({ id: option.value, label: option.label, icon: iconOf(option.icon ?? agentIconComponent(option.value)) })),
    ...customAgents.map((server) => ({ id: server.id, label: server.name, icon: iconOf(server.type === "remote" ? Globe : Terminal) })),
    ...customAgentPersonas.map((item) => ({ id: item.id, label: item.name, group: "Custom Agents", icon: iconOf(agentIconComponent(item.base_agent)) })),
  ];
  const chooseAgent = (id: string) => {
    const installed = agents.find((candidate) => candidate.id === id);
    setSelection(installed ? configForAgent(installed) : { source: "default", agent_id: id });
    setOpenMenu(null);
  };

  const configOptions = selection.source === "config_options" ? snapshot?.config_options ?? [] : [];
  const quick = quickConfigOptions(configOptions);
  const quickIds = new Set([quick.model, quick.mode, quick.thinking].flatMap((option) => option ? [option.id] : []));
  // Phone: quick options that don't fit beside Send fold into the settings menu
  // (Thinking first, then Mode, then Model), as in the Session composer.
  const [quickKept, setQuickKept] = useState(3);
  const kept = phone ? quickKept : 3;
  const showModel = !!quick.model && kept >= 1;
  const showMode = !!quick.mode && kept >= 2;
  const showThinking = !!quick.thinking && kept >= 3;
  const folded = [!showModel && quick.model, !showMode && quick.mode, !showThinking && quick.thinking]
    .filter((option): option is SessionConfigOption => !!option);
  const settingsOptions = [...folded, ...configOptions.filter((option) => !quickIds.has(option.id))];
  const footerRef = useRef<HTMLDivElement>(null);
  const quickWidthsRef = useRef({ model: 0, mode: 0, thinking: 0 });
  useEffect(() => {
    const footer = footerRef.current;
    // Legacy "modes" Agents have no config options to fold (and their Mode menu can't live in settings).
    if (!phone || selection.source !== "config_options" || !footer || typeof ResizeObserver === "undefined") return;
    const chips = [["model", modelMenuRef], ["mode", modeMenuRef], ["thinking", thinkingMenuRef]] as const;
    const fit = () => {
      const right = footer.querySelector<HTMLElement>(".chatbox-footer-right");
      const left = footer.querySelector<HTMLElement>(".chatbox-footer-left");
      if (!right) return;
      const widths = quickWidthsRef.current;
      // A folded chip keeps its last measured width; one the Agent doesn't offer takes none.
      chips.forEach(([key, ref], index) => {
        if (ref.current?.isConnected) widths[key] = ref.current.offsetWidth;
        else if (index < quickKept) widths[key] = 0;
      });
      const GAP = 6;
      const others = Array.from(right.children).filter((child) => !chips.some(([, ref]) => ref.current === child)) as HTMLElement[];
      // The settings button appears once something is folded; reserve its room up front.
      const settingsReserve = right.querySelector(".chatbox-session-settings") ? 0 : 40 + GAP;
      let budget = footer.clientWidth - (left?.offsetWidth ?? 0) - 8
        - others.reduce((sum, child) => sum + child.offsetWidth + GAP, 0) - settingsReserve;
      let next = 0;
      for (const [key] of chips) {
        const width = widths[key];
        if (width > 0 && width + GAP > budget) break;
        budget -= width > 0 ? width + GAP : 0;
        next += 1;
      }
      setQuickKept(next);
    };
    const observer = new ResizeObserver(fit);
    observer.observe(footer);
    // A chip's width follows its value, so watch the visible ones too.
    const watchChips = () => { for (const [, ref] of chips) if (ref.current) observer.observe(ref.current); };
    watchChips();
    // Chips that appear or relabel later don't resize the footer (it just overflows); refit on any change.
    let frame = 0;
    const mutations = new MutationObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; watchChips(); fit(); });
    });
    mutations.observe(footer, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      mutations.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [phone, quickKept, agentId, selection.source]);
  const valueOf = (option: SessionConfigOption | undefined) => {
    if (!option || selection.source !== "config_options") return "";
    return String(selection.values[option.id] ?? option.currentValue);
  };
  const setOption = (option: SessionConfigOption, value: string | boolean) => {
    if (selection.source === "config_options") setSelection({ ...selection, values: { ...selection.values, [option.id]: value } });
    setOpenMenu(null);
  };
  // SessionSettingsMenu reads currentValue, so show the draft's overrides through it.
  const settingsWithDraft = settingsOptions.map((option) => selection.source === "config_options" && option.id in selection.values
    ? { ...option, currentValue: selection.values[option.id] } as SessionConfigOption
    : option);
  const modes = selection.source === "modes" ? snapshot?.modes?.available ?? [] : [];

  const projectReady = !!selectedProject && selectedProject.taskCount === undefined && !!selectedProject.localTask;
  const tasks = useMemo(() => selectedProject?.tasks.filter((task) => task.status !== "archived") ?? [], [selectedProject]);

  const [recentState, setRecent] = useState<{ projectId: string; sessions: RecentSession[] } | null>(null);
  const recentProjectId = phone && projectReady ? selectedProject?.id : undefined;
  const recentTaskKey = tasks.map((task) => `${task.id}\u0000${task.name}`).join("\u0001");
  useEffect(() => {
    if (!recentProjectId) return;
    let disposed = false;
    const sources = [{ id: "_local", name: undefined as string | undefined }, ...tasks.map((task) => ({ id: task.id, name: task.name }))];
    void Promise.all(sources.map(({ id, name }) => listChats(recentProjectId, id)
      .then((chats) => chats.map((chat) => ({ taskId: id, taskName: name, chatId: chat.id, title: chat.title, agent: chat.agent, createdAt: chat.created_at })))
      .catch(() => [] as RecentSession[])))
      .then((lists) => {
        if (disposed) return;
        setRecent({ projectId: recentProjectId, sessions: lists.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, RECENT_LIMIT) });
      });
    return () => { disposed = true; };
    // recentTaskKey stands in for `tasks`, whose identity changes on every project refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recentProjectId, recentTaskKey]);
  // A list fetched for another project is never shown.
  const recent = recentState && recentState.projectId === recentProjectId ? recentState.sessions : [];
  // A Task picked for one project is meaningless after switching to another.
  const effectiveTaskId = taskId === "_local" || tasks.some((task) => task.id === taskId) ? taskId : "_local";
  const canSend = (!!text.trim() || attachments.length > 0) && !!agentId && projectReady && !sending;

  const send = async () => {
    if (!canSend || !selectedProject) return;
    setSending(true);
    setError(null);
    setOpenMenu(null);
    // Slide the composer to where the Session view docks it: TaskChat's composer
    // (chat-only layout) ends 12px above the bottom of <main>, same width and center.
    const main = rootRef.current?.closest("main")?.getBoundingClientRect();
    const composer = composerRef.current?.getBoundingClientRect();
    if (main && composer) setHandoffOffset(Math.max(0, main.bottom - 12 - composer.bottom));
    try {
      const [chat] = await Promise.all([
        createChat(selectedProject.id, effectiveTaskId, buildDefaultSessionTitle(), agentId),
        new Promise((resolve) => window.setTimeout(resolve, HANDOFF_MS)),
      ]);
      setOrbitFirstMessage(chat.id, { text: text.trim(), config: promptConfigFromSelection(selection), chat, attachments });
      writeLastAgent(agentId);
      writeDraft("");
      leaveComposerGhost(composerRef.current);
      // Switch an already-mounted (keep-alive) TaskChat to the new chat before
      // its page becomes visible; a not-yet-mounted one picks up the pending chat.
      const target = { projectId: selectedProject.id, taskId: effectiveTaskId, chatId: chat.id };
      (window as unknown as Record<string, unknown>).__grove_pending_chat = target;
      window.dispatchEvent(new CustomEvent("grove:switch-chat", { detail: { ...target, chat } }));
      onNavigate("tasks", { taskId: effectiveTaskId, chatId: chat.id, viewMode: "terminal", orbitHandoff: true });
    } catch (reason) {
      console.error("Failed to create session", reason);
      setError((reason as { message?: string })?.message || "Could not create a session. Please try again.");
      setHandoffOffset(null);
      setSending(false);
    }
  };

  const projectItems = projects.filter((project) => project.exists && !project.archived);
  // Same colored glyph the sidebar's project selector uses.
  const projectIcon = (projectId: string) => {
    const { color, Icon } = getProjectStyle(projectId, theme.accentPalette);
    return <span className="orbit-new__project-icon" style={{ backgroundColor: color.bg }}><Icon className="h-3 w-3" style={{ color: color.fg }} /></span>;
  };

  return (
    <div ref={rootRef} className={`orbit-new${phone ? " is-phone" : ""}${handoffOffset !== null ? " is-handing-off" : ""}`}>
      <div className="orbit-new__inner">
        <h1 className="orbit-new__title">What should we work on?</h1>
        {recent.length > 0 && (
          <ul className="orbit-new__recent" aria-label="Recent sessions">
            {recent.map((session) => (
              <li key={session.chatId}>
                <button type="button" onClick={() => onNavigate("tasks", { taskId: session.taskId, chatId: session.chatId, viewMode: "terminal" })}>
                  {/* The Session's own Agent, so the list shows who's behind each one. */}
                  {createElement(agentIconComponent(session.agent), { size: 16, className: "orbit-new__recent-icon" })}
                  <span className="orbit-new__recent-title">{session.title || "New Chat"}</span>
                  <span className="orbit-new__recent-meta">
                    {session.taskName && <span className="orbit-new__recent-task">{session.taskName}</span>}
                    <span>{formatTimeAgo(session.createdAt)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="orbit-new__stack" style={handoffOffset !== null ? { transform: `translateY(${handoffOffset}px)` } : undefined}>
          <div
            ref={composerRef}
            className="chatbox-bubble orbit-new__composer relative min-w-0 rounded-[30px] border border-[color-mix(in_srgb,var(--color-border)_62%,transparent)] bg-[color-mix(in_srgb,var(--color-bg-secondary)_78%,transparent)] px-3 pt-2 pb-3 shadow-[0_22px_60px_rgba(0,0,0,0.18)] backdrop-blur-md transition-colors focus-within:border-[color-mix(in_srgb,var(--color-highlight)_82%,white_8%)]"
            onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
            onDrop={(event) => {
              const files = Array.from(event.dataTransfer.files);
              if (files.length === 0) return;
              event.preventDefault();
              addFiles(files);
            }}
          >
            <div className="chatbox-header mb-2 flex items-center gap-2">
              {/* Same pill as the chat composer header. */}
              <div ref={agentMenuRef} className="relative">
                <button
                  type="button"
                  onClick={() => setOpenMenu(openMenu === "agent" ? null : "agent")}
                  aria-expanded={openMenu === "agent"}
                  className="chatbox-agent-pill inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full bg-[var(--color-bg)] px-2.5 py-1 text-[11px] text-[var(--color-text)] transition-colors hover:bg-[var(--color-bg-tertiary)]"
                >
                  {agentIcon}
                  <span className="shrink-0 text-[var(--color-text-muted)]">Agent</span>
                  <span className="truncate font-medium">{agentLabel || (acpAvailabilityLoaded ? "Choose" : "Loading…")}</span>
                  <ChevronDown className="h-3 w-3 shrink-0 opacity-70" />
                </button>
                {openMenu === "agent" && (acpAvailabilityLoaded
                  ? <PickerMenu items={agentItems} selectedId={agentId} onSelect={chooseAgent} placement="up-left" searchPlaceholder="Search agents" onEscape={() => setOpenMenu(null)} />
                  : <div className="picker-menu picker-menu--up-left"><div className="picker-menu__empty flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking…</div></div>)}
              </div>
            </div>
            {attachments.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-2 select-none">
                {attachments.map((attachment, index) => (
                  <div key={`${attachment.label}-${index}`} className="group relative flex max-w-full items-center gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-2.5 py-2 pr-7">
                    {attachment.type === "image" && attachment.previewUrl ? (
                      <img src={attachment.previewUrl} className="h-8 w-8 shrink-0 rounded-md border border-[var(--color-border)] object-cover" alt={attachment.label} title={attachment.label} />
                    ) : (
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-bg-tertiary)]">
                        {attachment.type === "audio" ? <Mic className="h-4 w-4 text-[var(--color-text-muted)]" /> : <Paperclip className="h-4 w-4 text-[var(--color-text-muted)]" />}
                      </div>
                    )}
                    <div className="min-w-0">
                      <div className="max-w-40 truncate text-xs font-medium text-[var(--color-text)]">{attachment.label}</div>
                      <div className="max-w-40 truncate text-[10px] text-[var(--color-text-muted)]">{attachment.name}</div>
                    </div>
                    <button type="button" onClick={() => removeAttachment(index)} aria-label={`Remove ${attachment.label}`} className="absolute top-1.5 right-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-[var(--color-error)] text-[10px] text-white opacity-0 transition-opacity group-hover:opacity-100">&times;</button>
                  </div>
                ))}
              </div>
            )}
            <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(event) => {
              addFiles(Array.from(event.target.files ?? []));
              event.target.value = "";
            }} />
            <textarea
              ref={inputRef}
              value={text}
              rows={2}
              placeholder="Ask anything…"
              onChange={(event) => { setText(event.target.value); writeDraft(event.target.value); }}
              onPaste={(event) => {
                // Copied files and screenshots become attachments; text pastes normally.
                const files = Array.from(event.clipboardData.files);
                if (files.length === 0) return;
                event.preventDefault();
                addFiles(files);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void send();
                }
              }}
              className="orbit-new__input block min-h-[56px] max-h-32 w-full resize-none bg-transparent px-4 py-2 text-sm leading-6 text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)]"
            />
            <div ref={footerRef} className="chatbox-footer mt-2 flex items-center justify-between gap-2 select-none">
              <div className="chatbox-footer-left flex min-w-0 items-center gap-2">
                <button type="button" onClick={() => fileInputRef.current?.click()} title="Attach file" aria-label="Attach file" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[var(--color-bg)] text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)]">
                  <Paperclip className="h-4 w-4" />
                </button>
                {!phone && <span className="truncate text-[10px] text-[var(--color-text-muted)]">Enter send</span>}
              </div>
              <div className="chatbox-footer-right flex shrink-0 items-center gap-2">
                {showModel && quick.model && (
                  <DropdownSelect ref={modelMenuRef} label={quick.model.name} icon={<Box className="h-3 w-3" />} options={dropdownValues(quick.model)} value={valueOf(quick.model)}
                    open={openMenu === "model"} onToggle={() => setOpenMenu(openMenu === "model" ? null : "model")} onSelect={(value) => setOption(quick.model!, value)} />
                )}
                {showMode && quick.mode && (
                  <DropdownSelect ref={modeMenuRef} label={quick.mode.name} icon={<ShieldCheck className="h-3 w-3" />} options={dropdownValues(quick.mode)} value={valueOf(quick.mode)}
                    open={openMenu === "mode"} onToggle={() => setOpenMenu(openMenu === "mode" ? null : "mode")} onSelect={(value) => setOption(quick.mode!, value)} />
                )}
                {modes.length > 0 && selection.source === "modes" && (
                  <DropdownSelect ref={modeMenuRef} label="Mode" icon={<ShieldCheck className="h-3 w-3" />} options={modes.map(([id, name]) => ({ label: name, value: id }))} value={selection.mode_id}
                    open={openMenu === "mode"} onToggle={() => setOpenMenu(openMenu === "mode" ? null : "mode")} onSelect={(modeId) => { setSelection({ ...selection, mode_id: modeId }); setOpenMenu(null); }} />
                )}
                {showThinking && quick.thinking && (
                  <DropdownSelect ref={thinkingMenuRef} label={quick.thinking.name} icon={<Brain className="h-3 w-3" />} options={dropdownValues(quick.thinking)} value={valueOf(quick.thinking)}
                    open={openMenu === "thinking"} onToggle={() => setOpenMenu(openMenu === "thinking" ? null : "thinking")} onSelect={(value) => setOption(quick.thinking!, value)} />
                )}
                {settingsWithDraft.length > 0 && (
                  <span className="chatbox-session-settings">
                    <SessionSettingsMenu ref={settingsMenuRef} options={settingsWithDraft} open={openMenu === "settings"} disabled={false} pendingConfigIds={NO_PENDING_CONFIG}
                      onToggle={() => setOpenMenu(openMenu === "settings" ? null : "settings")} onSelect={setOption} />
                  </span>
                )}
                <Button variant="primary" size="sm" className="h-9 w-9 !p-0 rounded-xl shadow-sm" disabled={!canSend} onClick={() => void send()} title="Send (Enter)">
                  {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                </Button>
              </div>
            </div>
          </div>
          <div className="orbit-new__context">
            <TrayPicker
              icon={selectedProject ? projectIcon(selectedProject.id) : <Folder size={14} strokeWidth={1.7} />}
              label={selectedProject?.name ?? "Choose project"}
              searchPlaceholder="Search projects"
              opensUp={phone}
              items={projectItems.map((project) => ({ id: project.id, label: project.name, icon: projectIcon(project.id) }))}
              selectedId={selectedProject?.id}
              onSelect={(id) => {
                const project = projectItems.find((item) => item.id === id);
                if (project && project.id !== selectedProject?.id) selectProject(project);
              }}
            />
            <TrayPicker
              icon={effectiveTaskId === "_local" ? <Laptop size={14} strokeWidth={1.7} /> : <GitBranch size={14} strokeWidth={1.7} />}
              label={effectiveTaskId === "_local" ? "Local" : tasks.find((task) => task.id === effectiveTaskId)?.name ?? "Local"}
              searchPlaceholder="Search tasks"
              opensUp={phone}
              items={[
                { id: "_local", label: "Local", icon: <Laptop size={14} strokeWidth={1.7} /> },
                ...tasks.map((task) => ({ id: task.id, label: task.name, icon: <GitBranch size={14} strokeWidth={1.7} /> })),
              ]}
              selectedId={effectiveTaskId}
              onSelect={setTaskId}
            />
          </div>
          {agent && !snapshot && (
            <p className="orbit-new__hint">{agent.name} hasn't connected yet, so it starts with its default model and mode. Options show up here after its first session.</p>
          )}
          {error && <p role="alert" className="orbit-new__error">{error}</p>}
        </div>
      </div>
    </div>
  );
}

/**
 * Chip in the tray under the composer; opens the shared picker downward, or
 * upward (spanning the tray, see CSS) on a phone where the tray sits at the bottom.
 */
function TrayPicker({ icon, label, items, selectedId, searchPlaceholder, opensUp, onSelect }: {
  icon: ReactNode;
  label: string;
  items: PickerMenuItem[];
  selectedId?: string;
  searchPlaceholder: string;
  opensUp?: boolean;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [open]);

  return (
    <div ref={rootRef} className="orbit-new__tray-picker relative">
      <button type="button" className="orbit-new__chip" aria-expanded={open} onClick={() => setOpen(!open)}>
        {icon}<span className="orbit-new__label">{label}</span><ChevronDown size={12} />
      </button>
      {open && (
        <PickerMenu items={items} selectedId={selectedId} placement={opensUp ? "up-left" : "down-left"} searchPlaceholder={searchPlaceholder} onEscape={() => setOpen(false)}
          onSelect={(id) => { onSelect(id); setOpen(false); }} />
      )}
    </div>
  );
}
