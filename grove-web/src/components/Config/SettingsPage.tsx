import React, { useState, useEffect, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  Terminal,
  LayoutGrid,
  Keyboard,
  Bell,
  Plug,
  ChevronDown,
  Check,
  Copy,
  ExternalLink,
  RefreshCw,
  Palette,
  Settings,
  Code,
  Wrench,
  Link,
  Plus,
  Globe,
  X,
  Sparkle,
  Server,
  UserCog,
  Package,
  ChevronRight,
  MonitorSmartphone,
  Activity,
} from "lucide-react";
import { Button, AgentPicker, CustomAgentModal, VSCodeIcon } from "../ui";
import { useTheme } from "../../context";
import { LayoutEditor, type PaneType, type LayoutNode, countPanes } from "./LayoutEditor";
import { CustomAgentsModal } from "./CustomAgentsModal";
import { MarketplaceModal } from "./MarketplaceModal";
import { InstallExtensionDialog } from "./InstallExtensionDialog";
import { ShortcutSettingsPanel } from "./ShortcutSettingsPanel";
import { useKeyboardScope } from "../../keyboard";
import { LoginDevicesPanel } from "./LoginDevicesPanel";
import { ResourceMonitor } from "./ResourceMonitor";
import { useSettingsState } from "./useSettingsState";
import { ToggleSwitch } from "./SettingsControls";
import { AppearanceSettings } from "./AppearanceSettings";
import { GeneralSettings } from "./GeneralSettings";
import { NotificationSettings } from "./NotificationSettings";
import {
  AUTOLINK_PRESETS,
  CLAUDE_CODE_MCP_CONFIG,
  CODEX_MCP_CONFIG,
  MCP_CONNECTION,
  dependencyInfo,
  layoutPresets,
  paneTypeColors,
  paneTypeLabels,
} from "./settingsConstants";

interface SectionProps {
  id: string;
  title: string;
  description: string;
  icon: React.ElementType;
  iconColor: string;
  isOpen: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}

function Section({
  title,
  description,
  icon: Icon,
  iconColor,
  isOpen,
  onToggle,
  children,
}: SectionProps) {
  return (
    <div className="border border-[var(--color-border)] rounded-xl overflow-hidden">
      <motion.button
        onClick={onToggle}
        className="w-full flex items-center gap-4 p-4 bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-tertiary)] transition-colors select-none"
      >
        <div
          className="w-9 h-9 shrink-0 rounded-lg flex items-center justify-center"
          style={{ backgroundColor: `color-mix(in srgb, ${iconColor} 10%, transparent)` }}
        >
          <Icon className="w-4 h-4" style={{ color: iconColor }} />
        </div>
        <div className="flex-1 text-left select-none">
          <div className="font-medium text-[var(--color-text)] text-sm">{title}</div>
          <div className="text-xs text-[var(--color-text-muted)]">{description}</div>
        </div>
        <motion.div
          animate={{ rotate: isOpen ? 180 : 0 }}
          transition={{ duration: 0.2 }}
        >
          <ChevronDown className="w-4 h-4 text-[var(--color-text-muted)]" />
        </motion.div>
      </motion.button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <div className="p-4 bg-[var(--color-bg)] border-t border-[var(--color-border)]">
              {children}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function SettingsPage() {
  const { theme, mode } = useTheme();
  const settings = useSettingsState();
  const {
    depStates,
    isChecking,
    checkDependencies,
    acpAgent,
    setAcpAgent,
    customAgents,
    saveCustomAgentServers,
    customAgentPersonas,
    customAgentPersonasLoading,
    updateCustomAgentPersonas,
    baseAgentsLoading,
    loadBaseAgents,
    chatAgentOptions,
    isChatAvailable,
    chatHistoryRecentTurns,
    setChatHistoryRecentTurns,
    chatHistoryRecentTurnsDraft,
    setChatHistoryRecentTurnsDraft,
    chatHistoryIncludeMedia,
    setChatHistoryIncludeMedia,
    chatHistoryIncludeToolDetails,
    setChatHistoryIncludeToolDetails,
    chatRenderWindowLimit,
    chatRenderWindowLimitDraft,
    setChatRenderWindowLimitDraft,
    chatRenderWindowTriggerDraft,
    setChatRenderWindowTriggerDraft,
    commitChatRenderWindowLimit,
    commitChatRenderWindowTrigger,
    setChatRenderWindowMode,
    webTerminalMode,
    setWebTerminalMode,
    terminalMultiplexer,
    setTerminalMultiplexer,
    hasMultiplexer,
    isTerminalAvailable,
    selectedLayout,
    setSelectedLayout,
    customLayouts,
    updateCustomLayouts,
    selectedCustomLayoutId,
    setSelectedCustomLayoutId,
    autoLinkPatterns,
    setAutoLinkPatterns,
    indexingEnabled,
    setIndexingEnabled,
    indexingDisabledLangs,
    setIndexingDisabledLangs,
    indexingSupportedLangs,
    browserControlEnabled,
    setBrowserControlEnabled,
    browserControlAutoGroups,
    setBrowserControlAutoGroups,
    extensionStatus,
    extensionConnected,
    extensionCurrent,
    extensionNeedsUpdate,
    extensionStatusLabel,
    extensionStatusColor,
    copiedField,
    handleCopy,
  } = settings;
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    terminal: false,
    chat: false,
    appearance: false,
    devtools: false,
    autolink: false,
    layout: false,
    hooks: false,
    indexing: false,
    mcp: false,
    browserControl: false,
    shortcuts: false,
    resources: false,
  });
  const [showCustomAgentModal, setShowCustomAgentModal] = useState(false);
  const [showCustomAgentsModal, setShowCustomAgentsModal] = useState(false);
  const [showMarketplaceModal, setShowMarketplaceModal] = useState(false);
  const [isLayoutEditorOpen, setIsLayoutEditorOpen] = useState(false);
  const [installDialogOpen, setInstallDialogOpen] = useState(false);

  const [indexingLangPickerOpen, setIndexingLangPickerOpen] = useState(false);
  const indexingAddBtnRef = useRef<HTMLButtonElement>(null);
  const indexingPickerRef = useRef<HTMLDivElement>(null);
  const [indexingPickerPos, setIndexingPickerPos] = useState<{ top: number; left: number } | null>(null);

  // Anchor the language picker to the trigger button. Wrapped in
  // useCallback so the effect can call it without doing setState
  // directly in its body (matches the Combobox pattern in src/ui).
  const updateIndexingPickerPos = useCallback(() => {
    const rect = indexingAddBtnRef.current?.getBoundingClientRect();
    if (rect) setIndexingPickerPos({ top: rect.bottom + 4, left: rect.left });
  }, []);

  useEffect(() => {
    if (!indexingLangPickerOpen) return;
    updateIndexingPickerPos();
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      // Exclude both the trigger and the portal'd picker — clicking on
      // a picker option must NOT close before its onClick has a chance
      // to run (mousedown fires first, would unmount the option).
      if (indexingAddBtnRef.current?.contains(target)) return;
      if (indexingPickerRef.current?.contains(target)) return;
      setIndexingLangPickerOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [indexingLangPickerOpen, updateIndexingPickerPos]);

  const toggleSection = (id: string) => {
    setOpenSections((prev) => {
      const isCurrentlyOpen = prev[id];

      // If clicking the currently open section, just close it
      if (isCurrentlyOpen) {
        return { ...prev, [id]: false };
      }

      // Otherwise, close all sections and open the clicked one (accordion behavior)
      const newSections: Record<string, boolean> = {};
      for (const key of Object.keys(prev)) {
        newSections[key] = key === id;
      }
      return newSections;
    });
  };

  // Push the `settings` keyboard scope while the page is mounted so the
  // catalog's `settings.close` (Escape) fires only inside the page.
  useKeyboardScope("settings", true);

  return (
    <motion.div>
      {/* Compact Header */}
      <div className="flex items-center gap-3 mb-6 select-none">
        <div className="w-10 h-10 rounded-xl bg-[var(--color-highlight)]/10 flex items-center justify-center">
          <Settings className="w-5 h-5 text-[var(--color-highlight)]" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-text)]">Settings</h1>
          <p className="text-xs text-[var(--color-text-muted)]">Configure Grove to match your workflow</p>
        </div>
      </div>

      <div className="space-y-3">
        {/* Agent Section */}
        <Section
          id="chat"
          title="Agents"
          description={
            baseAgentsLoading
              ? "Loading…"
              : isChatAvailable
                ? "Ready"
                : "Setup required"
          }
          icon={Sparkle}
          iconColor="#a855f7"
          isOpen={openSections.chat}
          onToggle={() => toggleSection("chat")}
        >
          <div className="space-y-5">
            {/* Default Coding Agent */}
            <div>
              <div className="text-xs font-medium text-[var(--color-text-muted)] mb-2 uppercase tracking-wider select-none">Default Coding Agent</div>
              {baseAgentsLoading ? (
                <div className="h-10 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 flex items-center text-sm text-[var(--color-text-muted)]">
                  Loading agents...
                </div>
              ) : (
                <AgentPicker
                  value={acpAgent}
                  onChange={setAcpAgent}
                  options={chatAgentOptions}
                  allowCustom={false}
                  placeholder="Select agent..."
                  customAgents={customAgents}
                />
              )}
            </div>

            {/* Hub entry list — full-width rows so an odd entry count never
                leaves a lonely card stranded in a 2-column grid. Each row is
                Settings-style: icon, label/subtitle, optional count chip,
                right chevron. The legacy per-agent launch-mode toggle has
                moved into the Marketplace modal's per-agent config sheet. */}
            <div className="divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)] overflow-hidden">
              <HubRow
                icon={<Package className="w-4 h-4 text-[var(--color-highlight)]" />}
                iconBg="var(--color-highlight)"
                label="Agent Marketplace"
                subtitle="Browse, install, and configure ACP agents"
                onClick={() => setShowMarketplaceModal(true)}
              />
              <HubRow
                icon={<UserCog className="w-4 h-4 text-[var(--color-highlight)]" />}
                iconBg="var(--color-highlight)"
                label="Custom Agents"
                subtitle="Personas with preset model & system prompt"
                count={customAgentPersonas.length}
                onClick={() => setShowCustomAgentsModal(true)}
              />
              <HubRow
                icon={<Server className="w-4 h-4 text-[var(--color-info)]" />}
                iconBg="var(--color-info)"
                label="Custom Agent Servers"
                subtitle="For private or self-hosted ACP deploys"
                count={customAgents.length}
                onClick={() => setShowCustomAgentModal(true)}
              />
            </div>

            <div>
              <div className="mb-2 text-xs font-medium uppercase tracking-wider text-[var(--color-text-muted)] select-none">Chat History Loading</div>
              <div className="divide-y divide-[var(--color-border)] overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
                <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-[var(--color-text)]">Messages to load</div>
                    <div className="mt-0.5 text-xs text-[var(--color-text-muted)]">Choose how much history this browser downloads.</div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                    <div className="inline-flex shrink-0 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-0.5">
                      <button type="button" onClick={() => { setChatHistoryRecentTurns(0); setChatHistoryRecentTurnsDraft("0"); }} className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${chatHistoryRecentTurns === 0 ? "bg-[var(--color-highlight)] text-white" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>All</button>
                      <button type="button" onClick={() => { if (chatHistoryRecentTurns === 0) { setChatHistoryRecentTurns(50); setChatHistoryRecentTurnsDraft("50"); } }} className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${chatHistoryRecentTurns > 0 ? "bg-[var(--color-highlight)] text-white" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>Recent</button>
                    </div>
                    {chatHistoryRecentTurns > 0 && (
                      <label className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
                        <input type="number" min={1} max={10000} value={chatHistoryRecentTurnsDraft} onChange={(event) => setChatHistoryRecentTurnsDraft(event.target.value)} onBlur={() => {
                          const next = Math.max(1, Math.min(10000, Math.floor(Number(chatHistoryRecentTurnsDraft) || chatHistoryRecentTurns)));
                          setChatHistoryRecentTurns(next);
                          setChatHistoryRecentTurnsDraft(String(next));
                        }} className="h-8 w-20 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-highlight)]" aria-label="Recent chat turns to load" />
                        turns
                      </label>
                    )}
                  </div>
                </div>
                <div className="flex items-center justify-between gap-4 p-4">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-[var(--color-text)]">Images & audio</div>
                    <div className="mt-0.5 text-xs text-[var(--color-text-muted)]">{chatHistoryIncludeMedia ? "Download historical media with messages." : "Show placeholders without downloading media."}</div>
                  </div>
                  <ToggleSwitch checked={chatHistoryIncludeMedia} onChange={setChatHistoryIncludeMedia} label="Include historical images and audio" />
                </div>
                <div className="flex items-center justify-between gap-4 p-4">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-[var(--color-text)]">Tool call details</div>
                    <div className="mt-0.5 text-xs text-[var(--color-text-muted)]">{chatHistoryIncludeToolDetails ? "Include tool inputs and outputs." : "Keep tool names and status only."}</div>
                  </div>
                  <ToggleSwitch checked={chatHistoryIncludeToolDetails} onChange={setChatHistoryIncludeToolDetails} label="Include tool call details" />
                </div>
              </div>
            </div>

            {/* Chat render window */}
            <div>
              <div className="mb-2 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider select-none">Chat Render Window</div>
              <div className="divide-y divide-[var(--color-border)] overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
                <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-[var(--color-text)]">Messages in view</div>
                    <div className="mt-0.5 text-xs text-[var(--color-text-muted)]">
                      {chatRenderWindowLimit > 0
                        ? `Keep latest ${chatRenderWindowLimit.toLocaleString()} messages`
                        : "Keep the full conversation in view"}
                    </div>
                  </div>
                  <div className="inline-flex self-start rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-0.5 sm:self-auto">
                    <button
                      type="button"
                      onClick={() => setChatRenderWindowMode("unlimited")}
                      className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                        chatRenderWindowLimit === 0
                          ? "bg-[var(--color-highlight)] text-white"
                          : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                      }`}
                    >
                      Unlimited
                    </button>
                    <button
                      type="button"
                      onClick={() => setChatRenderWindowMode("custom")}
                      className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                        chatRenderWindowLimit > 0
                          ? "bg-[var(--color-highlight)] text-white"
                          : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                      }`}
                    >
                      Custom
                    </button>
                  </div>
                </div>
                {chatRenderWindowLimit > 0 && (
                  <div className="flex flex-wrap items-center gap-2 p-4 text-sm text-[var(--color-text-muted)]">
                    <span>Prune at</span>
                    <label className="inline-flex items-center">
                      <input
                        type="number"
                        min={1}
                        step={100}
                        value={chatRenderWindowLimitDraft}
                        onChange={(e) => setChatRenderWindowLimitDraft(e.target.value)}
                        onBlur={() => commitChatRenderWindowLimit(chatRenderWindowLimitDraft)}
                        className="h-8 w-24 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-highlight)]"
                        aria-label="Chat render window view size limit"
                      />
                    </label>
                    <span>messages when view reaches</span>
                    <label className="inline-flex items-center">
                      <input
                        type="number"
                        min={chatRenderWindowLimit + 1}
                        step={100}
                        value={chatRenderWindowTriggerDraft}
                        onChange={(e) => setChatRenderWindowTriggerDraft(e.target.value)}
                        onBlur={() => commitChatRenderWindowTrigger(chatRenderWindowTriggerDraft)}
                        className="h-8 w-24 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-2 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-highlight)]"
                        aria-label="Chat render window prune trigger size"
                      />
                    </label>
                    <span>messages.</span>
                  </div>
                )}
              </div>
              <p className="mt-2 text-xs leading-relaxed text-[var(--color-text-muted)]">Older messages are hidden after a turn completes. Full chat history remains saved.</p>
            </div>
          </div>
        </Section>

        {/* Terminal Section */}
        <Section
          id="terminal"
          title="Terminal"
          description={
            baseAgentsLoading ? "Loading…"
              : !isTerminalAvailable ? "Setup required"
              : webTerminalMode === "direct" ? "Direct"
              : `${dependencyInfo[terminalMultiplexer]?.name || terminalMultiplexer}`
          }
          icon={Terminal}
          iconColor="#0ea5e9"
          isOpen={openSections.terminal}
          onToggle={() => toggleSection("terminal")}
        >
          <div className="space-y-5">
            {/* Terminal — two-panel selector */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider select-none">Terminal</div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => { checkDependencies(); loadBaseAgents(); }}
                  disabled={isChecking}
                  className="!p-1 !h-auto"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isChecking ? "animate-spin" : ""}`} />
                </Button>
              </div>
              <div className="flex gap-2">
                {/* Direct card */}
                <motion.div
                  layout
                  onClick={() => setWebTerminalMode("direct")}
                  className={`rounded-lg border cursor-pointer transition-colors overflow-hidden ${
                    webTerminalMode === "direct"
                      ? "border-[var(--color-highlight)] bg-[var(--color-highlight)]/5"
                      : "border-[var(--color-border)] bg-[var(--color-bg-secondary)] hover:border-[var(--color-highlight)]/50"
                  }`}
                  style={{ flex: webTerminalMode === "direct" ? 3 : 2 }}
                  transition={{ duration: 0.25, ease: "easeInOut" }}
                >
                  <div className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
                        webTerminalMode === "direct" ? "bg-[var(--color-highlight)]" : "bg-[var(--color-border)]"
                      }`} />
                      <span className="text-sm font-medium text-[var(--color-text)]">Direct</span>
                    </div>
                    <AnimatePresence>
                      {webTerminalMode === "direct" && (
                        <motion.p
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: "auto" }}
                          exit={{ opacity: 0, height: 0 }}
                          transition={{ duration: 0.2 }}
                          className="text-[11px] text-[var(--color-text-muted)] mt-1.5 ml-4 select-none"
                        >
                          Independent terminal instances, no session persistence
                        </motion.p>
                      )}
                    </AnimatePresence>
                  </div>
                </motion.div>

                {/* Multiplexer card */}
                <motion.div
                  layout
                  onClick={() => {
                    if (webTerminalMode !== "multiplexer" && hasMultiplexer) {
                      setWebTerminalMode("multiplexer");
                    }
                  }}
                  className={`rounded-lg border overflow-hidden transition-colors ${
                    hasMultiplexer ? "cursor-pointer" : "opacity-50 cursor-not-allowed"
                  } ${
                    webTerminalMode === "multiplexer"
                      ? "border-[var(--color-highlight)] bg-[var(--color-highlight)]/5"
                      : `border-[var(--color-border)] bg-[var(--color-bg-secondary)] ${hasMultiplexer ? "hover:border-[var(--color-highlight)]/50" : ""}`
                  }`}
                  style={{ flex: webTerminalMode === "multiplexer" ? 3 : 2 }}
                  transition={{ duration: 0.25, ease: "easeInOut" }}
                >
                  <div className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
                        webTerminalMode === "multiplexer" ? "bg-[var(--color-highlight)]" : "bg-[var(--color-border)]"
                      }`} />
                      <span className="text-sm font-medium text-[var(--color-text)]">Multiplexer</span>
                    </div>
                    <AnimatePresence>
                      {webTerminalMode === "multiplexer" && (
                        <motion.div
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: "auto" }}
                          exit={{ opacity: 0, height: 0 }}
                          transition={{ duration: 0.2 }}
                          className="mt-2 ml-0.5 space-y-1"
                        >
                          {(["tmux", "zellij"] as const).map((mux) => {
                            const state = depStates[mux];
                            const isInstalled = state?.status === "installed";
                            const isMuxActive = terminalMultiplexer === mux && isInstalled;

                            return (
                              <div
                                key={mux}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (isInstalled) {
                                    setTerminalMultiplexer(mux);
                                  }
                                }}
                                className={`flex items-center justify-between px-2.5 py-1.5 rounded-md transition-all ${
                                  isInstalled ? "cursor-pointer" : ""
                                } ${
                                  isMuxActive
                                    ? "bg-[var(--color-highlight)]/10"
                                    : isInstalled
                                      ? "hover:bg-[var(--color-bg-tertiary)]"
                                      : "opacity-50"
                                }`}
                              >
                                <div className="flex items-center gap-2">
                                  <div className={`w-1.5 h-1.5 rounded-full ${
                                    isMuxActive ? "bg-[var(--color-highlight)]"
                                      : isInstalled ? "bg-[var(--color-success)]"
                                      : "bg-[var(--color-text-muted)]"
                                  }`} />
                                  <span className={`text-xs ${isMuxActive ? "font-medium text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>
                                    {dependencyInfo[mux]?.name || mux}
                                  </span>
                                </div>
                                <div className="flex items-center gap-1.5">
                                  {isInstalled && state?.version && state.version !== "installed" && (
                                    <span className="text-[10px] text-[var(--color-text-muted)]">v{state.version}</span>
                                  )}
                                  {!isInstalled && state?.status !== "checking" && state?.installCommand && (
                                    <button
                                      onClick={(e) => { e.stopPropagation(); handleCopy(`install-${mux}`, state.installCommand); }}
                                      className="text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
                                      title={state.installCommand}
                                    >
                                      {copiedField === `install-${mux}` ? (
                                        <Check className="w-3 h-3 text-[var(--color-success)]" />
                                      ) : (
                                        <Copy className="w-3 h-3" />
                                      )}
                                    </button>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </motion.div>
              </div>
            </div>
          </div>
        </Section>

        {/* Browser Control Section */}
        <Section
          id="browserControl"
          title="Browser Control"
          description="Browser automation"
          icon={Globe}
          iconColor="#22a447"
          isOpen={openSections.browserControl}
          onToggle={() => toggleSection("browserControl")}
        >
          <div className="space-y-6">
            {/* AI Browser Action settings — Allow toggle + Sandbox + Tab Groups
                form one logical group: master switch and its two sub-modes.
                Sandbox / Tab Groups rows gray out when the master is off; the
                master row stays interactive. */}
            <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] divide-y divide-[var(--color-border)]">
              {/* Master toggle */}
              <div className="flex items-center justify-between p-4">
                <div>
                  <span className="text-sm font-semibold text-[var(--color-text)] select-none block">
                    Allow AI Browser Action
                  </span>
                  <span className="text-xs text-[var(--color-text-muted)] select-none">
                    Grant AI agents permission to open, read, and interact with web pages inside your active Chrome browser.
                  </span>
                </div>
                <label className="relative inline-flex items-center cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={browserControlEnabled}
                    onChange={(e) => setBrowserControlEnabled(e.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="w-9 h-5 bg-[var(--color-border)] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[var(--color-highlight)]"></div>
                </label>
              </div>

              {/* Tab Groups Organizer */}
              <div className={`flex items-center justify-between p-4 ${!browserControlEnabled ? 'opacity-50 pointer-events-none' : ''}`}>
                <div>
                  <span className="text-sm font-semibold text-[var(--color-text)] select-none block">
                    Tab Groups Organizer
                  </span>
                  <span className="text-xs text-[var(--color-text-muted)] select-none">
                    Automatically organize tabs opened by the AI into project-scoped Chrome Tab Groups to keep your browser neat and tidy.
                  </span>
                </div>
                <label className={`relative inline-flex items-center select-none ${browserControlEnabled ? 'cursor-pointer' : 'cursor-not-allowed'}`}>
                  <input
                    type="checkbox"
                    checked={browserControlAutoGroups}
                    disabled={!browserControlEnabled}
                    onChange={(e) => setBrowserControlAutoGroups(e.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="w-9 h-5 bg-[var(--color-border)] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[var(--color-highlight)] peer-disabled:opacity-50"></div>
                </label>
              </div>
            </div>

            {/* Chrome Companion — independent capability: a runtime status card
                + install entry point, unrelated to the AI Browser Action group. */}
            <div className="p-4 bg-[var(--color-bg-secondary)] rounded-xl border border-[var(--color-border)] space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-sm font-semibold text-[var(--color-text)] select-none block">
                    Chrome Companion (Extension)
                  </span>
                  <span className="text-xs text-[var(--color-text-muted)] select-none">
                    Control active browser sessions via the companion extension, inheriting all SSO login states, cookies, and active forms.
                  </span>
                </div>
                <div className="flex items-center gap-2 px-3 py-1 bg-[var(--color-bg-tertiary)] rounded-full border border-[var(--color-border)]">
                  <div
                    className={`w-2 h-2 rounded-full ${extensionCurrent ? 'animate-pulse' : ''}`}
                    style={{
                      background: `var(--color-${extensionStatusColor})`,
                      boxShadow: `0 0 8px color-mix(in srgb, var(--color-${extensionStatusColor}) 50%, transparent)`,
                    }}
                  />
                  <span className="text-xs font-medium text-[var(--color-text)] select-none">
                    {extensionStatusLabel}
                  </span>
                </div>
              </div>
              <div className="flex items-center justify-between text-xs pt-2 border-t border-[var(--color-border)]">
                <span className="text-[var(--color-text-muted)] select-none">
                  {extensionStatus?.updateRequired
                    ? `Connected Companion is incompatible${extensionStatus.installedVersion ? ` (v${extensionStatus.installedVersion})` : ""}. Install v${extensionStatus.requiredVersion}, then click Reload in chrome://extensions/.`
                    : extensionStatus?.updateAvailable
                      ? `Companion v${extensionStatus.installedVersion ?? "unknown"} is connected; v${extensionStatus.requiredVersion} is bundled with Grove. Update and reload it in Chrome.`
                      : extensionStatus?.compatible
                        ? `Companion v${extensionStatus.installedVersion} is installed, compatible, and connected.`
                        : extensionConnected
                          ? "Companion connected; checking protocol compatibility…"
                          : "Not installed? The bundled installer walks you through it — pick a folder and Grove handles the rest."}
                </span>
                <button
                  type="button"
                  onClick={() => setInstallDialogOpen(true)}
                  className="flex items-center gap-1 text-[var(--color-highlight)] hover:underline"
                >
                  {extensionNeedsUpdate ? "Update Companion" : extensionConnected ? "Reinstall" : "Install Companion"}
                </button>
              </div>
            </div>
          </div>
        </Section>

        {/* Appearance Section */}
        <Section
          id="appearance"
          title="Appearance"
          description={`${mode === "auto" ? "Auto" : mode === "light" ? "Light" : "Dark"} · ${theme.name}`}
          icon={Palette}
          iconColor="#ec4899"
          isOpen={openSections.appearance}
          onToggle={() => toggleSection("appearance")}
        >
          <AppearanceSettings />
        </Section>

        {/* General Section (IDE + Terminal App) */}
        <Section
          id="devtools"
          title="General"
          description="Interface and default applications"
          icon={Wrench}
          iconColor="#64748b"
          isOpen={openSections.devtools}
          onToggle={() => toggleSection("devtools")}
        >
          <GeneralSettings settings={settings} />
        </Section>

        {/* Keyboard Shortcuts Section (moved here, right under General) */}
        <Section
          id="shortcuts"
          title="Keyboard Shortcuts"
          description="Key bindings"
          icon={Keyboard}
          iconColor="#b38a13"
          isOpen={openSections.shortcuts}
          onToggle={() => toggleSection("shortcuts")}
        >
          <ShortcutSettingsPanel />
        </Section>

        {/* AutoLink Section */}
        <Section
          id="autolink"
          title="AutoLink"
          description={`${autoLinkPatterns.length} ${autoLinkPatterns.length === 1 ? "pattern" : "patterns"}`}
          icon={Link}
          iconColor="#6366f1"
          isOpen={openSections.autolink}
          onToggle={() => toggleSection("autolink")}
        >
          <div className="space-y-6">
            {/* 功能说明 */}
            <div className="p-3 bg-[var(--color-bg-secondary)] rounded-lg">
              <p className="text-xs text-[var(--color-text-muted)] select-none">
                Automatically create symlinks in new worktrees for gitignored files/folders.
                Saves disk space and avoids rebuilding node_modules, IDE configs, etc.
              </p>
            </div>

            {/* Glob 模式列表 */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <div className="select-none">
                  <h4 className="text-sm font-medium text-[var(--color-text)]">Path Patterns</h4>
                  <p className="text-xs text-[var(--color-text-muted)] mt-1">
                    Glob patterns to match files/folders (supports *, **, ?)
                  </p>
                </div>
                <Button
                  onClick={() => setAutoLinkPatterns([...autoLinkPatterns, ""])}
                  variant="secondary"
                  size="sm"
                >
                  <Plus className="w-3 h-3 mr-1" />
                  Add
                </Button>
              </div>

              {/* 模式输入列表 */}
              <div className="space-y-2 mb-4">
                {autoLinkPatterns.map((pattern, index) => (
                  <div key={`${index}_${pattern}`} className="flex items-center gap-2">
                    <input
                      type="text"
                      value={pattern}
                      onChange={(e) => {
                        const newPatterns = [...autoLinkPatterns];
                        newPatterns[index] = e.target.value;
                        setAutoLinkPatterns(newPatterns);
                      }}
                      placeholder="e.g., node_modules or **/dist"
                      className="flex-1 px-3 py-2 text-sm bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] font-mono"
                    />
                    <button
                      onClick={() => {
                        setAutoLinkPatterns(autoLinkPatterns.filter((_, i) => i !== index));
                      }}
                      className="p-2 text-[var(--color-text-muted)] hover:text-red-500 transition-colors"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                ))}

                {autoLinkPatterns.length === 0 && (
                  <div className="text-center py-4 text-sm text-[var(--color-text-muted)] select-none">
                    No patterns configured. Click "Add" to create one.
                  </div>
                )}
              </div>

              {/* 预设模板 */}
              <div className="p-3 bg-[var(--color-bg-secondary)] rounded-lg mb-3">
                <h5 className="text-xs font-medium text-[var(--color-text)] mb-2 select-none">
                  Quick Add Presets
                </h5>
                <div className="flex flex-wrap gap-2">
                  {AUTOLINK_PRESETS.map((pattern) => ({ label: pattern, pattern })).map((preset) => (
                    <button
                      key={preset.pattern}
                      onClick={() => {
                        if (!autoLinkPatterns.includes(preset.pattern)) {
                          setAutoLinkPatterns([...autoLinkPatterns, preset.pattern]);
                        }
                      }}
                      disabled={autoLinkPatterns.includes(preset.pattern)}
                      className={`px-2 py-1 text-xs rounded font-mono ${
                        autoLinkPatterns.includes(preset.pattern)
                          ? "bg-[var(--color-border)] text-[var(--color-text-muted)] cursor-not-allowed"
                          : "bg-[var(--color-accent)] text-white hover:opacity-80"
                      }`}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Glob 语法帮助 */}
              <div className="p-3 bg-[var(--color-bg-secondary)] rounded-lg">
                <h5 className="text-xs font-medium text-[var(--color-text)] mb-2 select-none">Glob Syntax</h5>
                <ul className="text-xs text-[var(--color-text-muted)] space-y-1 select-none">
                  <li>• <code className="font-mono">*</code> matches any characters (except /)</li>
                  <li>• <code className="font-mono">**</code> matches any path segment</li>
                  <li>• <code className="font-mono">?</code> matches single character</li>
                  <li>• Examples: <code className="font-mono">node_modules</code>, <code className="font-mono">**/dist</code>, <code className="font-mono">packages/*/build</code></li>
                </ul>
              </div>
            </div>
          </div>
        </Section>

        {/* Terminal Layout Section (仅当 Multiplexer 模式时显示) */}
        {webTerminalMode === "multiplexer" && (
          <>
            <Section
              id="layout"
              title="Terminal Layout"
              description="Default task layout"
              icon={LayoutGrid}
              iconColor="#a67855"
              isOpen={openSections.layout}
              onToggle={() => toggleSection("layout")}
            >
              <div className="grid grid-cols-3 gap-3">
                {layoutPresets.map((preset) => {
                  const isCustom = preset.id === "custom";
                  const isSelected = selectedLayout === preset.id;

                  // Render preview based on layout type
                  const renderPreview = () => {
                    if (isCustom) {
                      // Custom layout preview based on tree structure
                      const currentCustomLayout = customLayouts.find(l => l.id === selectedCustomLayoutId) || customLayouts[0];

                      if (!currentCustomLayout) {
                        return (
                          <div className="h-10 mb-2 bg-[var(--color-bg)] rounded border border-dashed border-[var(--color-border)] flex items-center justify-center">
                            <span className="text-[10px] text-[var(--color-text-muted)]">Click to configure</span>
                          </div>
                        );
                      }

                      // Recursive function to render LayoutNode tree
                      const renderLayoutNode = (node: LayoutNode): React.ReactNode => {
                        if (node.type === "pane") {
                          const colors = paneTypeColors[node.paneType || "shell"] || paneTypeColors.shell;
                          return (
                            <div
                              key={node.id}
                              className="flex-1 rounded text-[8px] flex items-center justify-center min-w-0 min-h-0"
                              style={{ backgroundColor: `${colors.bg}20`, color: colors.text }}
                            >
                              {paneTypeLabels[node.paneType || "shell"] || node.paneType}
                            </div>
                          );
                        }

                        // Split node
                        if (node.children) {
                          const isHorizontal = node.direction === "horizontal";
                          return (
                            <div
                              key={node.id}
                              className={`flex ${isHorizontal ? "flex-row" : "flex-col"} gap-0.5 flex-1 min-w-0 min-h-0`}
                            >
                              {renderLayoutNode(node.children[0])}
                              {renderLayoutNode(node.children[1])}
                            </div>
                          );
                        }

                        return null;
                      };

                      const paneCount = countPanes(currentCustomLayout.root);

                      return (
                        <div className="h-10 mb-2 bg-[var(--color-bg)] rounded border border-[var(--color-border)] p-1 flex">
                          {renderLayoutNode(currentCustomLayout.root)}
                          {paneCount === 0 && (
                            <span className="text-[10px] text-[var(--color-text-muted)] m-auto">Click to configure</span>
                          )}
                        </div>
                      );
                    }

                    // 3 Panes: Left + Right split (left one big, right two stacked)
                    if (preset.layout === "left-right-split") {
                      return (
                        <div className="h-10 mb-2 bg-[var(--color-bg)] rounded border border-[var(--color-border)] p-1 flex gap-0.5">
                          {/* Left pane (60%) */}
                          <div
                            className="w-[60%] rounded text-[8px] flex items-center justify-center"
                            style={{
                              backgroundColor: `${paneTypeColors[preset.panes[0]]?.bg || "var(--color-text-muted)"}20`,
                              color: paneTypeColors[preset.panes[0]]?.text || "var(--color-text-muted)",
                            }}
                          >
                            {paneTypeLabels[preset.panes[0] as PaneType] || preset.panes[0]}
                          </div>
                          {/* Right panes (40%, stacked) */}
                          <div className="w-[40%] flex flex-col gap-0.5">
                            {preset.panes.slice(1).map((pane, i) => (
                              <div
                                key={i}
                                className="flex-1 rounded text-[8px] flex items-center justify-center"
                                style={{
                                  backgroundColor: `${paneTypeColors[pane]?.bg || "var(--color-text-muted)"}20`,
                                  color: paneTypeColors[pane]?.text || "var(--color-text-muted)",
                                }}
                              >
                                {paneTypeLabels[pane as PaneType] || pane}
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    }

                    // Default horizontal layout
                    return (
                      <div className="h-10 mb-2 bg-[var(--color-bg)] rounded border border-[var(--color-border)] p-1 flex gap-0.5">
                        {preset.panes.map((pane, i) => {
                          const colors = paneTypeColors[pane] || paneTypeColors.shell;
                          return (
                            <div
                              key={i}
                              className="flex-1 rounded text-[8px] flex items-center justify-center"
                              style={{ backgroundColor: `${colors.bg}20`, color: colors.text }}
                            >
                              {paneTypeLabels[pane as PaneType] || pane}
                            </div>
                          );
                        })}
                      </div>
                    );
                  };

                  return (
                    <motion.button
                      key={preset.id}
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      onClick={() => {
                        setSelectedLayout(preset.id);
                        if (isCustom) {
                          setIsLayoutEditorOpen(true);
                        }
                      }}
                      className={`relative p-3 rounded-lg border text-left transition-all
                        ${
                          isSelected
                            ? "border-[var(--color-highlight)] bg-[var(--color-highlight)]/5"
                            : "border-[var(--color-border)] hover:border-[var(--color-text-muted)] bg-[var(--color-bg-secondary)]"
                        }`}
                    >
                      {isSelected && (
                        <div className="absolute top-2 right-2 w-4 h-4 rounded-full bg-[var(--color-highlight)] flex items-center justify-center">
                          <Check className="w-2.5 h-2.5 text-white" />
                        </div>
                      )}
                      {renderPreview()}
                      <div className="text-xs font-medium text-[var(--color-text)]">{preset.name}</div>
                      <div className="text-[10px] text-[var(--color-text-muted)] select-none">
                        {isCustom && customLayouts.length > 0
                          ? `${customLayouts.length} layout${customLayouts.length > 1 ? "s" : ""} configured`
                          : preset.description}
                      </div>
                    </motion.button>
                  );
                })}
              </div>

              {/* Edit Custom Layout Button */}
              {selectedLayout === "custom" && (
                <div className="mt-3 flex justify-end">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setIsLayoutEditorOpen(true)}
                  >
                    Edit Custom Layout
                  </Button>
                </div>
              )}
            </Section>
          </>
        )}

        {/* Hooks Section */}
        <Section
          id="hooks"
          title="Notifications"
          description="Chat alerts and sounds"
          icon={Bell}
          iconColor="#f97316"
          isOpen={openSections.hooks}
          onToggle={() => toggleSection("hooks")}
        >
          <NotificationSettings settings={settings} />
        </Section>

        {/* Code Repo Indexing Section */}
        <Section
          id="indexing"
          title="Code Indexing"
          description="Code navigation"
          icon={Code}
          iconColor="#3b82f6"
          isOpen={openSections.indexing ?? false}
          onToggle={() => toggleSection("indexing")}
        >
          <div className="space-y-4">
            <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-[var(--color-text)]">Enable indexing</div>
                  <div className="text-xs text-[var(--color-text-muted)] mt-0.5">
                    When off, cmd+click and the underline hint do nothing for newly opened tasks.
                    Already-running tasks keep their index until grove restarts.
                  </div>
                </div>
                <ToggleSwitch checked={indexingEnabled} onChange={setIndexingEnabled} />
              </div>
            </div>

            {indexingEnabled && (
              <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4">
                <div className="text-sm font-semibold text-[var(--color-text)] mb-1">Languages</div>
                <div className="text-xs text-[var(--color-text-muted)] mb-3">
                  Files with these languages are indexed during build. Removing a chip stops new
                  scans from picking it up; existing rows in the cache are kept until the next
                  manual reindex.
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  {indexingSupportedLangs
                    .filter((l) => !indexingDisabledLangs.includes(l.id))
                    .map((l) => (
                      <span
                        key={l.id}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs bg-[var(--color-info)]/10 text-[var(--color-info)] border border-[var(--color-info)]/30"
                      >
                        {/* Real per-language icon from vscode-icons (same set
                            the file tree uses). Synthesize `index.<ext>` so
                            getIconForFile resolves to the language icon. */}
                        <VSCodeIcon filename={`index.${l.extensions[0] ?? l.id}`} size={14} />
                        {l.display_name}
                        <button
                          onClick={() =>
                            setIndexingDisabledLangs((prev) =>
                              prev.includes(l.id) ? prev : [...prev, l.id],
                            )
                          }
                          className="hover:bg-[var(--color-info)]/20 rounded-full w-4 h-4 flex items-center justify-center"
                          title={`Remove ${l.display_name}`}
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    ))}

                  {indexingSupportedLangs.some((l) => indexingDisabledLangs.includes(l.id)) && (
                    <button
                      ref={indexingAddBtnRef}
                      onClick={() => setIndexingLangPickerOpen((v) => !v)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs border border-dashed border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)]"
                    >
                      <Plus className="w-3 h-3" />
                      Add language
                    </button>
                  )}

                  {indexingSupportedLangs.length === 0 && (
                    <span className="text-xs text-[var(--color-text-muted)]">
                      No supported languages reported by the server.
                    </span>
                  )}
                </div>

                {/* Picker portaled to body so the Section's overflow-hidden
                    doesn't clip the dropdown when there's a section below. */}
                {indexingLangPickerOpen && indexingPickerPos &&
                  createPortal(
                    <div
                      ref={indexingPickerRef}
                      style={{
                        position: "fixed",
                        top: indexingPickerPos.top,
                        left: indexingPickerPos.left,
                        zIndex: 9999,
                      }}
                      className="min-w-[160px] rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] shadow-lg p-1"
                    >
                      {indexingSupportedLangs
                        .filter((l) => indexingDisabledLangs.includes(l.id))
                        .map((l) => (
                          <button
                            key={l.id}
                            onClick={() => {
                              setIndexingDisabledLangs((prev) =>
                                prev.filter((x) => x !== l.id),
                              );
                              setIndexingLangPickerOpen(false);
                            }}
                            className="w-full flex items-center gap-2 text-left px-2 py-1.5 rounded text-xs text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]"
                          >
                            <VSCodeIcon filename={`index.${l.extensions[0] ?? l.id}`} size={14} />
                            {l.display_name}
                          </button>
                        ))}
                    </div>,
                    document.body,
                  )}
              </div>
            )}
          </div>
        </Section>

        {/* MCP Server Section */}
        <Section
          id="mcp"
          title="MCP Server"
          description="Agent integration"
          icon={Plug}
          iconColor="#06a4b5"
          isOpen={openSections.mcp}
          onToggle={() => toggleSection("mcp")}
        >
          <div className="space-y-4">
            {/* Server Info - More Prominent */}
            <div className="p-4 bg-[var(--color-highlight)]/5 rounded-xl border border-[var(--color-highlight)]/20">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="text-xs text-[var(--color-text-muted)] mb-1 select-none">Name</div>
                  <code className="text-sm font-semibold text-[var(--color-highlight)]">{MCP_CONNECTION.name}</code>
                </div>
                <div>
                  <div className="text-xs text-[var(--color-text-muted)] mb-1 select-none">Type</div>
                  <code className="text-sm font-semibold text-[var(--color-text)]">{MCP_CONNECTION.type}</code>
                </div>
                <div>
                  <div className="text-xs text-[var(--color-text-muted)] mb-1 select-none">Command</div>
                  <code className="text-sm font-semibold text-[var(--color-text)]">{MCP_CONNECTION.command}</code>
                </div>
                <div>
                  <div className="text-xs text-[var(--color-text-muted)] mb-1 select-none">Args</div>
                  <code className="text-sm font-semibold text-[var(--color-text)]">{MCP_CONNECTION.args.join(" ")}</code>
                </div>
              </div>
            </div>

            {/* Claude Code Config */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-[var(--color-text)] select-none">Claude Code Configuration</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleCopy("code", CLAUDE_CODE_MCP_CONFIG)}
                >
                  {copiedField === "code" ? (
                    <Check className="w-4 h-4 text-[var(--color-success)]" />
                  ) : (
                    <Copy className="w-4 h-4" />
                  )}
                </Button>
              </div>
              <pre className="p-3 bg-[var(--color-bg-secondary)] rounded-lg border border-[var(--color-border)] text-xs text-[var(--color-text-muted)] overflow-x-auto">
                {CLAUDE_CODE_MCP_CONFIG}
              </pre>
              <p className="text-xs text-[var(--color-text-muted)] mt-2 select-none">
                Add to your <code className="text-[var(--color-highlight)]">~/.claude.json</code> file.
              </p>
            </div>

            {/* CodeX Config */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-[var(--color-text)] select-none">CodeX Configuration</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleCopy("codex", CODEX_MCP_CONFIG)}
                >
                  {copiedField === "codex" ? (
                    <Check className="w-4 h-4 text-[var(--color-success)]" />
                  ) : (
                    <Copy className="w-4 h-4" />
                  )}
                </Button>
              </div>
              <pre className="p-3 bg-[var(--color-bg-secondary)] rounded-lg border border-[var(--color-border)] text-xs text-[var(--color-text-muted)] overflow-x-auto">
                {CODEX_MCP_CONFIG}
              </pre>
              <p className="text-xs text-[var(--color-text-muted)] mt-2 select-none">
                Add to your <code className="text-[var(--color-highlight)]">~/.codex/config.toml</code> file.
              </p>
            </div>

            {/* Docs Link */}
            <a
              href="https://modelcontextprotocol.io/examples"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 p-3 rounded-lg bg-[var(--color-info)]/5 border border-[var(--color-info)]/20 hover:bg-[var(--color-info)]/10 transition-colors"
            >
              <ExternalLink className="w-4 h-4 text-[var(--color-info)]" />
              <span className="text-sm text-[var(--color-text)] select-none">Learn more about MCP protocol</span>
            </a>
          </div>
        </Section>

        <Section id="devices" title="Login Devices" description="Devices and sign-ins"
          icon={MonitorSmartphone} iconColor="#e05270" isOpen={!!openSections.devices}
          onToggle={() => setOpenSections(previous => ({ ...previous, devices: !previous.devices }))}>
          <LoginDevicesPanel />
        </Section>

        <Section id="resources" title="Resource Monitor" description="CPU, memory and storage"
          icon={Activity} iconColor="#0d9488" isOpen={!!openSections.resources}
          onToggle={() => toggleSection("resources")}>
          <ResourceMonitor />
        </Section>
      </div>

      {/* Custom Agent Servers Modal (existing) */}
      <CustomAgentModal
        isOpen={showCustomAgentModal}
        onClose={() => setShowCustomAgentModal(false)}
        agents={customAgents}
        onSave={saveCustomAgentServers}
      />

      {/* Custom Agents (Persona) Modal */}
      <CustomAgentsModal
        isOpen={showCustomAgentsModal}
        onClose={() => setShowCustomAgentsModal(false)}
        agents={customAgentPersonas}
        baseAgentOptions={chatAgentOptions}
        customServers={customAgents}
        loading={customAgentPersonasLoading}
        onChanged={updateCustomAgentPersonas}
      />

      <MarketplaceModal
        open={showMarketplaceModal}
        onClose={() => setShowMarketplaceModal(false)}
      />

      {installDialogOpen && (
        <InstallExtensionDialog onClose={() => setInstallDialogOpen(false)} />
      )}

      {/* Layout Editor Dialog */}
      <LayoutEditor
        isOpen={isLayoutEditorOpen}
        onClose={() => setIsLayoutEditorOpen(false)}
        layouts={customLayouts}
        onChange={updateCustomLayouts}
        selectedLayoutId={selectedCustomLayoutId}
        onSelectLayout={setSelectedCustomLayoutId}
      />

    </motion.div>
  );
}

// ─── Settings-style row used by Agent section hub ──────────────────────────

interface HubRowProps {
  icon: React.ReactNode;
  iconBg: string; // CSS color string (e.g. var(--color-highlight))
  label: string;
  subtitle: string;
  count?: number;
  onClick: () => void;
}

function HubRow({ icon, iconBg, label, subtitle, count, onClick }: HubRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center gap-3 bg-[var(--color-bg-secondary)] px-3.5 py-3 text-left transition-colors hover:bg-[var(--color-bg-tertiary)]"
    >
      <div
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md"
        style={{ backgroundColor: `color-mix(in srgb, ${iconBg} 10%, transparent)` }}
      >
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-[var(--color-text)]">{label}</span>
          {typeof count === "number" && (
            <span className="rounded-full bg-[var(--color-bg)] px-2 py-0.5 text-[10px] text-[var(--color-text-muted)]">
              {count > 0 ? count : "None"}
            </span>
          )}
        </div>
        <div className="mt-0.5 text-xs text-[var(--color-text-muted)]">{subtitle}</div>
      </div>
      <ChevronRight className="h-4 w-4 shrink-0 text-[var(--color-text-muted)] transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}
