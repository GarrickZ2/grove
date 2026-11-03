import { createElement, useEffect, useMemo, useRef, useState, type ComponentType, type DragEvent, type ReactNode } from "react";
import { Sparkle, BookOpen, ChevronDown, FileText, FlaskConical, Folder, FolderTree, GitBranch, Globe, Laptop, ListChecks, Mic, Paperclip, PenLine, Terminal, type LucideIcon } from "lucide-react";
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
import { useACPAvailability } from "../Tasks/TaskView/useACPAvailability";
import type { ChatDropdownOption } from "../Tasks/TaskView/ChatConfigMenus";
import { configDropdownValues, quickConfigOptions } from "../Tasks/TaskView/sessionConfigOptions";
import { buildDefaultSessionTitle } from "../Tasks/TaskView/useInitialChatLoad";
import { AttachmentError, attachmentLabel, prepareFileAttachment, type Attachment } from "../Tasks/TaskView/chatAttachments";
import { promptConfigFromSelection } from "./orbitDraftConfig";
import { setOrbitFirstMessage } from "./orbitFirstMessage";
import { hasSeen, markSeen, STARTERS_DONE_KEY } from "../../orbit/firstrun/storage";
import { useRecentSessions } from "../../orbit/dashboard/useRecentSessions";
import { useLiveChats } from "../../orbit/dashboard/useLiveChats";
import { liveChatKey } from "../../orbit/dashboard/liveChats";
import { taskLabel } from "../../orbit/dashboard/dashboardModel";
import { shortAgo } from "../../orbit/ui/format";
import { useNow } from "../../orbit/ui/useNow";
import { OrbitComposer, OrbitSendOrb } from "../Tasks/TaskView/composer/OrbitComposer";
import { OrbitSetupChip, type SetupField, type SetupToggle } from "../Tasks/TaskView/composer/OrbitSetupChip";
import { MentionEditable, type MentionEditableHandle } from "../Tasks/TaskView/composer/MentionEditable";
import { useMentionSources } from "../Tasks/TaskView/composer/useMentionSources";
import "./orbit-new-chat.css";

const LAST_AGENT_KEY = "grove-orbit-new-agent";
/** Composer slide-down before the Session view takes over. */
const HANDOFF_MS = 320;
/** Phone: recent Sessions listed above the composer as quick ways back in. */
const RECENT_LIMIT = 3;

/** First-run starter prompts by project type; a pick only fills the composer. */
const STARTERS: Record<"code" | "studio", { label: string; icon: LucideIcon }[]> = {
  code: [
    { label: "Explain how this project is organized", icon: BookOpen },
    { label: "Find and fix a failing test", icon: FlaskConical },
    { label: "Add a section to the README", icon: FileText },
  ],
  studio: [
    { label: "Summarize the workspace instructions", icon: ListChecks },
    { label: "Suggest how to organize the shared files", icon: FolderTree },
    { label: "Draft an outline I can review", icon: PenLine },
  ],
};
/** Desktop "Continue" row: the project's most recently active Sessions. */
const CONTINUE_LIMIT = 3;
const CLOCK_MS = 30_000;

type RecentSession = { taskId: string; taskName?: string; chatId: string; title: string; agent: string; createdAt: string };

function readLastAgent(): string | null {
  try { return localStorage.getItem(LAST_AGENT_KEY); } catch { return null; }
}

function writeLastAgent(agentId: string): void {
  try { localStorage.setItem(LAST_AGENT_KEY, agentId); } catch { /* per-viewer convenience only */ }
}

// The unsent message survives reloads and leaving the page; cleared once sent.
// Kept as composer markup so @-mention chips survive too; older drafts were plain text.
const DRAFT_KEY = "grove-orbit-new-draft";
const DRAFT_HTML_KEY = "grove-orbit-new-draft-html";

function readDraftHtml(): string {
  try {
    const html = localStorage.getItem(DRAFT_HTML_KEY);
    if (html) return html;
    const text = localStorage.getItem(DRAFT_KEY);
    if (!text) return "";
    const holder = document.createElement("div");
    holder.textContent = text;
    return holder.innerHTML;
  } catch { return ""; }
}

function writeDraftHtml(value: string): void {
  try {
    localStorage.removeItem(DRAFT_KEY);
    if (value) localStorage.setItem(DRAFT_HTML_KEY, value);
    else localStorage.removeItem(DRAFT_HTML_KEY);
  } catch { /* per-viewer convenience only */ }
}

function draftText(html: string): string {
  const holder = document.createElement("div");
  holder.innerHTML = html;
  return holder.textContent ?? "";
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
  const [initialDraftHtml] = useState(readDraftHtml);
  // The prompt as it will be sent: @-mention chips already serialized.
  const [text, setText] = useState(() => draftText(initialDraftHtml));
  // Starters only until the first message is sent from here.
  const [startersDone, setStartersDone] = useState(() => hasSeen(STARTERS_DONE_KEY));
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
  const [inputFocused, setInputFocused] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<MentionEditableHandle>(null);

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
    // On a phone, focusing would throw the keyboard up before the user asks for it.
    // A restored draft continues where it left off (focus puts the caret at the end).
    if (!phone) inputRef.current?.focus();
  }, [phone]);

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
    : <Sparkle className="h-3 w-3 shrink-0 text-[var(--color-highlight)]" />;
  const iconOf = (type: ComponentType<{ size?: number; className?: string }> | null | undefined) =>
    type ? createElement(type, { size: 15 }) : <Sparkle className="h-3.5 w-3.5" />;
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
  };

  const configOptions = selection.source === "config_options" ? snapshot?.config_options ?? [] : [];
  const quick = quickConfigOptions(configOptions);
  const quickIds = new Set([quick.model, quick.mode, quick.thinking].flatMap((option) => option ? [option.id] : []));
  const valueOf = (option: SessionConfigOption | undefined) => {
    if (!option || selection.source !== "config_options") return "";
    return String(selection.values[option.id] ?? option.currentValue);
  };
  const setOption = (option: SessionConfigOption, value: string | boolean) => {
    if (selection.source === "config_options") setSelection({ ...selection, values: { ...selection.values, [option.id]: value } });
  };
  const modes = selection.source === "modes" ? snapshot?.modes?.available ?? [] : [];
  // Desktop: every setting lives in the composer's one setup chip.
  const setupFields: SetupField[] = [
    { id: "agent", kind: "agent", label: "Agent", value: agentId, onSelect: chooseAgent,
      options: agentItems.map((item) => ({ value: item.id, label: item.label, group: item.group, icon: item.icon })) },
    ...([quick.model, quick.mode, quick.thinking] as const).flatMap((option, index): SetupField[] => option ? [{
      id: option.id, kind: (["model", "mode", "thinking"] as const)[index], label: option.name,
      options: dropdownValues(option), value: valueOf(option), onSelect: (value: string) => setOption(option, value),
    }] : []),
    ...(modes.length > 0 && selection.source === "modes" ? [{
      id: "mode", kind: "mode" as const, label: "Mode", options: modes.map(([id, name]) => ({ label: name, value: id })), value: selection.mode_id,
      onSelect: (modeId: string) => { setSelection({ ...selection, mode_id: modeId }); },
    }] : []),
    ...configOptions.filter((option) => !quickIds.has(option.id) && option.type === "select").map((option): SetupField => ({
      id: option.id, kind: "option", label: option.name, options: dropdownValues(option), value: valueOf(option), onSelect: (value) => setOption(option, value),
    })),
  ];
  const setupToggles: SetupToggle[] = configOptions.filter((option) => !quickIds.has(option.id) && option.type === "boolean").map((option) => ({
    id: option.id, label: option.name, description: option.description,
    value: selection.source === "config_options" && option.id in selection.values ? !!selection.values[option.id] : !!option.currentValue,
    onToggle: (value) => setOption(option, value),
  }));

  const projectReady = !!selectedProject && selectedProject.taskCount === undefined && !!selectedProject.localTask;
  const tasks = useMemo(() => selectedProject?.tasks.filter((task) => task.status !== "archived") ?? [], [selectedProject]);

  // Desktop: the Dashboard's recent-session source, with live dots from the radio channel.
  const continueTaskIds = useMemo(() => ["_local", ...tasks.map((task) => task.id)], [tasks]);
  const continueSessions = useRecentSessions(!phone && projectReady ? selectedProject?.id : undefined, continueTaskIds).sessions.slice(0, CONTINUE_LIMIT);
  const liveChats = useLiveChats();
  const now = useNow(CLOCK_MS);
  const taskNames = new Map(tasks.map((task) => [task.id, task.name]));

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
  const spawnAgents = useMemo(() => pickerOptions.map((option) => ({ value: option.value, label: option.label })), [pickerOptions]);
  const spawnPersonas = useMemo(() => customAgentPersonas.map((item) => ({ id: item.id, name: item.name, base_agent: item.base_agent, duty: item.duty })), [customAgentPersonas]);
  const mentionSources = useMentionSources({
    projectId: projectReady ? selectedProject?.id : undefined,
    taskId: effectiveTaskId,
    studio: selectedProject?.projectType === "studio",
    spawnAgents,
    spawnPersonas,
  });
  const canSend = (!!text.trim() || attachments.length > 0) && !!agentId && projectReady && !sending;

  const send = async () => {
    if (!canSend || !selectedProject) return;
    setSending(true);
    setError(null);
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
      writeDraftHtml("");
      markSeen(STARTERS_DONE_KEY);
      setStartersDone(true);
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

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); };
  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    const files = Array.from(event.dataTransfer.files);
    if (files.length === 0) return;
    event.preventDefault();
    addFiles(files);
  };
  const attachmentList = (
    <>
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
    </>
  );
  const fileInput = (
    <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(event) => {
      addFiles(Array.from(event.target.files ?? []));
      event.target.value = "";
    }} />
  );
  // Same @ picker as the Session composer; the chips serialize into the first prompt.
  const composerInput = (
    <MentionEditable
      ref={inputRef}
      sources={mentionSources}
      initialHtml={initialDraftHtml}
      placeholder="Ask anything… use @ for mentions"
      onFocus={() => setInputFocused(true)}
      onBlur={() => setInputFocused(false)}
      onChange={({ text: prompt, html }) => { setText(prompt); writeDraftHtml(html); }}
      onSubmit={() => void send()}
      // Copied files and screenshots become attachments; text pastes as plain text.
      onPasteFiles={addFiles}
      className="orbit-new__input block min-h-[56px] max-h-32 w-full overflow-y-auto whitespace-pre-wrap break-words bg-transparent px-4 py-2 text-sm leading-6 text-[var(--color-text)] outline-none"
    />
  );

  return (
    <div ref={rootRef} className={`orbit-new${phone ? " is-phone" : ""}${handoffOffset !== null ? " is-handing-off" : ""}`}>
      {!phone && <div className="orbit-new__glow" aria-hidden="true"><i /><i /><i /></div>}
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
            <OrbitComposer
              shellRef={composerRef}
              className="chatbox-bubble orbit-new__composer"
              running={false}
              phone={phone}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              tools={(
                <button type="button" className="oc-tool" onClick={() => fileInputRef.current?.click()} title="Attach file" aria-label="Attach file">
                  <Paperclip />
                </button>
              )}
              hint={!phone && text.trim() && inputFocused ? "\u23CE send \u00b7 \u21E7\u23CE newline" : null}
              setup={<OrbitSetupChip agentLabel={agentLabel || (acpAvailabilityLoaded ? "Choose agent" : "Loading\u2026")} agentIcon={agentIcon} fields={setupFields} toggles={setupToggles} emptyNote={agent && !snapshot ? `${agent.name} hasn't connected yet, so it starts with its defaults.` : undefined} sheet={phone} />}
              orb={<OrbitSendOrb action={text.trim() || attachments.length > 0 ? "send" : "idle"} disabled={!canSend} busy={sending} onSend={() => void send()} sendTitle="Send (Enter)" />}
            >
              {attachmentList}
              {fileInput}
              {composerInput}
            </OrbitComposer>
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
          {/* Starters stay put while typing (dimmed) so the page never jumps. */}
          {!phone && !startersDone && selectedProject && (
            <div className={`orbit-new__starters${text || attachments.length > 0 ? " is-quiet" : ""}`} aria-label="Starter prompts">
              {STARTERS[selectedProject.projectType === "studio" ? "studio" : "code"].map(({ label, icon: Icon }, index) => (
                <button
                  key={label}
                  type="button"
                  className="orbit-new__starter"
                  style={{ animationDelay: `${120 + index * 60}ms` }}
                  onClick={() => {
                    inputRef.current?.setText(label);
                  }}
                >
                  <Icon size={13} strokeWidth={1.8} aria-hidden="true" />{label}
                </button>
              ))}
            </div>
          )}
          {agent && !snapshot && (
            <p className="orbit-new__hint">{agent.name} hasn't connected yet, so it starts with its default model and mode. Options show up here after its first session.</p>
          )}
          {error && <p role="alert" className="orbit-new__error">{error}</p>}
        </div>
        {continueSessions.length > 0 && (
          <section className="orbit-new__continue" aria-label="Continue">
            <h2>Continue</h2>
            <ul>
              {continueSessions.map(({ taskId, chat, activeAt }) => {
                const live = selectedProject ? liveChats[liveChatKey(selectedProject.id, taskId, chat.id)] : undefined;
                const running = live?.status === "busy" || live?.status === "connecting";
                return (
                  <li key={`${taskId}:${chat.id}`}>
                    <button type="button" onClick={() => onNavigate("tasks", { taskId, chatId: chat.id, viewMode: "terminal" })}>
                      {createElement(agentIconComponent(chat.agent), { size: 15, className: "orbit-new__continue-icon" })}
                      <span className="orbit-new__continue-copy">
                        <b title={chat.title}>{chat.title || "Untitled session"}</b>
                        <span>{taskLabel(taskId, taskNames.get(taskId))}</span>
                      </span>
                      {running && <i className="orbit-new__live" role="img" aria-label="Running" />}
                      <span className="orbit-new__continue-ago">{activeAt ? shortAgo(activeAt, now) : ""}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
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
