import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Terminal,
  LayoutGrid,
  Bell,
  Plug,
  ChevronDown,
  Check,
  Copy,
  AlertCircle,
  AlertTriangle,
  Info,
  ExternalLink,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Palette,
  Settings,
  Code,
  Wrench,
  Link,
  Plus,
  X,
  MessageSquare,
} from "lucide-react";
import { Button, Combobox, AppPicker, AgentPicker, agentOptions, ideAppOptions, terminalAppOptions, CustomAgentModal } from "../ui";
import type { ComboboxOption } from "../ui";
import { useTheme, themes, useConfig } from "../../context";
import {
  getConfig,
  patchConfig,
  checkAllDependencies,
  checkCommands,
  listApplications,
  type AppInfo,
  type CustomAgent,
} from "../../api";
import { LayoutEditor, type CustomLayoutConfig, type PaneType, type LayoutNode, createDefaultLayout, countPanes } from "./LayoutEditor";
import { useIsMobile } from "../../hooks";

interface SettingsPageProps {
  config: {
    agent: { command: string };
    layout: { default: string };
    hooks: { enabled: boolean; scriptPath: string };
    mcp: { name: string; type: string; command: string; args: string[] };
  };
}

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
          className="w-9 h-9 rounded-lg flex items-center justify-center"
          style={{ backgroundColor: `${iconColor}15` }}
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

// Layout presets
interface LayoutPreset {
  id: string;
  name: string;
  description: string;
  panes: string[];
  layout?: "horizontal" | "left-right-split"; // for special layouts
}

const layoutPresets: LayoutPreset[] = [
  { id: "single", name: "Single", description: "Shell only", panes: ["shell"] },
  { id: "agent", name: "Agent", description: "Agent only", panes: ["agent"] },
  { id: "agent-shell", name: "Agent + Shell", description: "60% + 40%", panes: ["agent", "shell"] },
  { id: "agent-grove-shell", name: "3 Panes", description: "Left + Right split", panes: ["agent", "grove", "shell"], layout: "left-right-split" },
  { id: "grove-agent", name: "Grove + Agent", description: "40% + 60%", panes: ["grove", "agent"] },
  { id: "custom", name: "Custom", description: "Configure your own", panes: [] },
];

// Default custom layouts - create once and reuse
const defaultCustomLayouts: CustomLayoutConfig[] = [createDefaultLayout()];

// Map pane type to display info
const paneTypeColors: Record<PaneType | string, { bg: string; text: string }> = {
  agent: { bg: "var(--color-highlight)", text: "var(--color-highlight)" },
  grove: { bg: "var(--color-info)", text: "var(--color-info)" },
  "file-picker": { bg: "var(--color-accent)", text: "var(--color-accent)" },
  shell: { bg: "var(--color-text-muted)", text: "var(--color-text-muted)" },
  custom: { bg: "var(--color-warning)", text: "var(--color-warning)" },
};

const paneTypeLabels: Record<PaneType, string> = {
  agent: "Agent",
  grove: "Grove",
  "file-picker": "FP",
  shell: "Shell",
  custom: "Cmd",
};

// Notification levels
const notificationLevels = [
  { level: "notice", icon: Info, color: "var(--color-info)", title: "Notice" },
  { level: "warn", icon: AlertTriangle, color: "var(--color-warning)", title: "Warning" },
  { level: "critical", icon: AlertCircle, color: "var(--color-error)", title: "Critical" },
];

// Note: Agent options are imported from AgentPicker
// IDE and Terminal options are imported from AppPicker

// Sound options for hooks (macOS system sounds)
const soundOptions: ComboboxOption[] = [
  { id: "off", label: "Off", value: "" },
  { id: "default", label: "Default", value: "default" },
  { id: "Basso", label: "Basso", value: "Basso" },
  { id: "Blow", label: "Blow", value: "Blow" },
  { id: "Bottle", label: "Bottle", value: "Bottle" },
  { id: "Frog", label: "Frog", value: "Frog" },
  { id: "Funk", label: "Funk", value: "Funk" },
  { id: "Glass", label: "Glass", value: "Glass" },
  { id: "Hero", label: "Hero", value: "Hero" },
  { id: "Morse", label: "Morse", value: "Morse" },
  { id: "Ping", label: "Ping", value: "Ping" },
  { id: "Pop", label: "Pop", value: "Pop" },
  { id: "Purr", label: "Purr", value: "Purr" },
  { id: "Sosumi", label: "Sosumi", value: "Sosumi" },
  { id: "Submarine", label: "Submarine", value: "Submarine" },
  { id: "Tink", label: "Tink", value: "Tink" },
];

// Dependency display info
const dependencyInfo: Record<string, { name: string; description: string; docsUrl?: string }> = {
  git: { name: "Git", description: "Version control system", docsUrl: "https://git-scm.com/doc" },
  tmux: { name: "tmux", description: "Terminal multiplexer", docsUrl: "https://github.com/tmux/tmux/wiki" },
  zellij: { name: "Zellij", description: "Terminal multiplexer", docsUrl: "https://zellij.dev/documentation/" },
  fzf: { name: "fzf", description: "Fuzzy finder for file picker", docsUrl: "https://github.com/junegunn/fzf" },
  "claude-agent-acp": { name: "Claude Agent ACP", description: "ACP adapter for Claude Code", docsUrl: "https://github.com/anthropics/claude-code" },
  "claude-code-acp": { name: "Claude Code ACP (deprecated)", description: "Deprecated — please upgrade to claude-agent-acp", docsUrl: "https://github.com/anthropics/claude-code" },
  "codex-acp": { name: "Codex ACP", description: "ACP adapter for OpenAI Codex", docsUrl: "https://github.com/zed-industries/codex-acp" },
};

type DependencyStatusType = "checking" | "installed" | "not_installed" | "error";

interface DependencyState {
  status: DependencyStatusType;
  version?: string;
  installCommand: string;
}

export function SettingsPage({ config }: SettingsPageProps) {
  const { theme, setTheme } = useTheme();
  const { updateAvailability, refresh: refreshGlobalConfig } = useConfig();
  const { isMobile } = useIsMobile();

  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    terminal: false,
    chat: false,
    appearance: false,
    devtools: false,
    autolink: false,
    layout: false,
    hooks: false,
    mcp: false,
  });

  // Environment state
  const [depStates, setDepStates] = useState<Record<string, DependencyState>>({});
  const [isChecking, setIsChecking] = useState(false);

  // Config state (from API)
  const [isLoaded, setIsLoaded] = useState(false); // Prevent auto-save during initial load

  // Local state for Development Tools
  const [agentCommand, setAgentCommand] = useState(config.agent.command);
  const [ideCommand, setIdeCommand] = useState("");
  const [terminalCommand, setTerminalCommand] = useState("");
  const [applications, setApplications] = useState<AppInfo[]>([]);
  const [isLoadingApps, setIsLoadingApps] = useState(false);

  // ACP / Custom agents state
  const [acpAgent, setAcpAgent] = useState("claude"); // Chat mode agent
  const [customAgents, setCustomAgents] = useState<CustomAgent[]>([]);
  const [showCustomAgentModal, setShowCustomAgentModal] = useState(false);

  // Agent command availability: command name → exists on PATH
  const [commandAvailability, setCommandAvailability] = useState<Record<string, boolean>>({});

  // Mode state
  const [terminalMultiplexer, setTerminalMultiplexer] = useState("tmux");
  // Web terminal backend: "multiplexer" (default) | "direct"
  const [webTerminalMode, setWebTerminalMode] = useState("multiplexer");

  const lastTerminalMuxRef = useRef<string>("tmux");
  const defaultAppliedRef = useRef(false);

  // Layout state
  const [selectedLayout, setSelectedLayout] = useState(config.layout.default);
  const [customLayouts, setCustomLayouts] = useState<CustomLayoutConfig[]>(defaultCustomLayouts);
  const [selectedCustomLayoutId, setSelectedCustomLayoutId] = useState<string | null>(defaultCustomLayouts[0]?.id || null);
  const [customLayoutsLoaded, setCustomLayoutsLoaded] = useState(false); // Track if custom layouts were loaded from API
  const [isLayoutEditorOpen, setIsLayoutEditorOpen] = useState(false);

  // Hooks state - for command generator
  const [hookLevel, setHookLevel] = useState<"notice" | "warn" | "critical">("notice");
  const [hookBanner, setHookBanner] = useState(true);
  const [hookSound, setHookSound] = useState("default"); // empty = off, or sound name
  const [hookMessage, setHookMessage] = useState("");

  // MCP state
  const [copiedField, setCopiedField] = useState<string | null>(null);

  // AutoLink state
  const [autoLinkPatterns, setAutoLinkPatterns] = useState<string[]>([]);

  // Generate hook command based on selections
  const hookCommand = `grove hooks ${hookLevel}${hookBanner ? " --banner" : ""}${hookSound ? ` --sound ${hookSound}` : ""}${hookMessage ? ` --message "${hookMessage}"` : ""}`;

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

  const handleCopy = (field: string, value: string) => {
    navigator.clipboard.writeText(value);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  };

  // Load config from API
  const loadConfig = useCallback(async () => {
    try {
      const cfg = await getConfig();
      setAgentCommand(cfg.layout.agent_command || config.agent.command);
      setIdeCommand(cfg.web.ide || "");
      setTerminalCommand(cfg.web.terminal || "");
      setSelectedLayout(cfg.layout.default);

      setTerminalMultiplexer(cfg.terminal_multiplexer || "tmux");
      lastTerminalMuxRef.current = cfg.terminal_multiplexer || "tmux";
      setWebTerminalMode(cfg.web.terminal_mode || "multiplexer");

      // Load theme - sync with context
      // API stores theme id (e.g., "dark", "tokyo-night")
      if (cfg.theme.name && cfg.theme.name.toLowerCase() !== "auto") {
        // Try to match by id (lowercase, with dash)
        const themeId = cfg.theme.name.toLowerCase().replace(/\s+/g, "-");
        setTheme(themeId);
      }

      // Load custom layouts
      if (cfg.layout.custom_layouts) {
        try {
          const parsed = JSON.parse(cfg.layout.custom_layouts);
          // Check if it's an array (Web format) vs object (TUI format)
          if (Array.isArray(parsed) && parsed.length > 0) {
            const layouts = parsed as CustomLayoutConfig[];
            setCustomLayouts(layouts);
            setCustomLayoutsLoaded(true); // Mark as loaded from Web format
            // Use saved selected_custom_id or fallback to first layout
            const savedId = cfg.layout.selected_custom_id;
            if (savedId && layouts.some(l => l.id === savedId)) {
              setSelectedCustomLayoutId(savedId);
            } else {
              setSelectedCustomLayoutId(layouts[0].id);
            }
          }
          // If it's TUI format (object), keep the default customLayouts
          // customLayoutsLoaded stays false, so we won't overwrite TUI data
        } catch {
          console.error("Failed to parse custom layouts");
        }
      } else {
        // No existing custom layouts, mark as loaded so we can save new ones
        setCustomLayoutsLoaded(true);
      }

      // Load AutoLink config
      setAutoLinkPatterns(cfg.auto_link.patterns);

      // Load ACP config
      if (cfg.acp?.agent_command) {
        setAcpAgent(cfg.acp.agent_command);
      }
      if (cfg.acp?.custom_agents) {
        setCustomAgents(cfg.acp.custom_agents);
      }

      setIsLoaded(true);
    } catch {
      // API not available, use props config
      console.warn("Config API not available, using local config");
      setIsLoaded(true);
    }
  }, [config.agent.command, setTheme]);

  // Check dependencies via API
  const checkDependencies = useCallback(async () => {
    setIsChecking(true);

    // Set all to checking
    setDepStates((prev) => {
      const newStates: Record<string, DependencyState> = {};
      for (const key of Object.keys(prev)) {
        newStates[key] = { ...prev[key], status: "checking" };
      }
      // Also add expected deps if not present
      for (const name of ["git", "tmux", "zellij", "fzf"]) {
        if (!newStates[name]) {
          newStates[name] = { status: "checking", installCommand: "" };
        }
      }
      return newStates;
    });

    try {
      const response = await checkAllDependencies();
      const newStates: Record<string, DependencyState> = {};

      for (const dep of response.dependencies) {
        newStates[dep.name] = {
          status: dep.installed ? "installed" : "not_installed",
          version: dep.version || undefined,
          installCommand: dep.install_command,
        };
      }

      setDepStates(newStates);
    } catch {
      // API not available, show error state
      setDepStates((prev) => {
        const newStates: Record<string, DependencyState> = {};
        for (const key of Object.keys(prev)) {
          newStates[key] = { ...prev[key], status: "error" };
        }
        return newStates;
      });
    } finally {
      setIsChecking(false);
    }
  }, []);

  // Check agent command availability
  const checkAgentCommands = useCallback(async () => {
    const cmds = new Set<string>();
    for (const opt of agentOptions) {
      if (opt.terminalCheck) cmds.add(opt.terminalCheck);
      if (opt.acpCheck) cmds.add(opt.acpCheck);
      if (opt.acpFallback) cmds.add(opt.acpFallback);
    }
    try {
      const results = await checkCommands([...cmds]);
      setCommandAvailability(results);
    } catch {
      // API not available, assume all available
    }
  }, []);

  // Save config to API (called automatically)
  // Note: themeId parameter allows immediate save with new theme value
  const saveConfig = useCallback(async () => {
    if (!isLoaded) return; // Don't save during initial load

    try {
      const patch = {
        layout: {
          default: selectedLayout,
          // 仅当 Terminal 启用时保存 agent_command
          agent_command: agentCommand || undefined,
          // Only save custom layouts if they were loaded/created in Web format
          // This prevents overwriting TUI's custom layout format
          ...(customLayoutsLoaded ? {
            custom_layouts: JSON.stringify(customLayouts),
            selected_custom_id: selectedCustomLayoutId || undefined,
          } : {}),
        },
        web: {
          ide: ideCommand || undefined,
          terminal: terminalCommand || undefined,
          terminal_mode: webTerminalMode,
        },
        terminal_multiplexer: terminalMultiplexer,
        acp: {
          agent_command: acpAgent || undefined,
        },
        auto_link: {
          patterns: autoLinkPatterns,
        },
      };
      await patchConfig(patch);
      // Refresh the global config cache so other pages see the changes immediately
      await refreshGlobalConfig();
    } catch {
      console.error("Failed to save config");
    }
  }, [isLoaded, selectedLayout, agentCommand, acpAgent, customLayouts, selectedCustomLayoutId, customLayoutsLoaded, ideCommand, terminalCommand, terminalMultiplexer, webTerminalMode, autoLinkPatterns, refreshGlobalConfig]);

  // Handle theme change with immediate save
  const handleThemeChange = useCallback((newThemeId: string) => {
    setTheme(newThemeId);
    // Save immediately with the new theme ID to avoid stale closure issues
    if (isLoaded) {
      patchConfig({
        theme: { name: newThemeId },
      }).then(() => refreshGlobalConfig()).catch(() => console.error("Failed to save theme"));
    }
  }, [setTheme, isLoaded, refreshGlobalConfig]);

  // Auto-save when any config value changes (debounced)
  useEffect(() => {
    if (!isLoaded) return;

    const timer = setTimeout(() => {
      saveConfig();
    }, 500); // 500ms debounce

    return () => clearTimeout(timer);
  }, [selectedLayout, agentCommand, acpAgent, customLayouts, selectedCustomLayoutId, customLayoutsLoaded, ideCommand, terminalCommand, terminalMultiplexer, webTerminalMode, autoLinkPatterns, isLoaded, saveConfig]);

  // Load applications list
  const loadApplications = useCallback(async () => {
    setIsLoadingApps(true);
    try {
      const apps = await listApplications();
      setApplications(apps);
    } catch {
      console.error("Failed to load applications");
    } finally {
      setIsLoadingApps(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    loadConfig();
    checkDependencies();
    loadApplications();
    checkAgentCommands();
  }, [loadConfig, checkDependencies, loadApplications, checkAgentCommands]);

  // Terminal availability
  const tmuxInstalled = depStates["tmux"]?.status === "installed";
  const zellijInstalled = depStates["zellij"]?.status === "installed";
  const hasMultiplexer = tmuxInstalled || zellijInstalled;
  const canUseTerminal = webTerminalMode === "direct" || hasMultiplexer;

  // (enable states are auto-synced from dependency availability below)

  // Auto-correct on first load:
  // 1. If multiplexer mode but no multiplexer installed → fallback to direct
  // 2. If selected multiplexer not installed but other is → switch
  useEffect(() => {
    if (defaultAppliedRef.current || !isLoaded || isChecking) return;
    if (Object.keys(depStates).length === 0) return;
    defaultAppliedRef.current = true;

    if (webTerminalMode === "multiplexer" && !hasMultiplexer) {
      // No multiplexer available → fallback to direct
      setWebTerminalMode("direct");
    } else if (webTerminalMode === "multiplexer") {
      // Auto-correct multiplexer selection
      if (terminalMultiplexer === "tmux" && !tmuxInstalled && zellijInstalled) {
        setTerminalMultiplexer("zellij");
        lastTerminalMuxRef.current = "zellij";
      } else if (terminalMultiplexer === "zellij" && !zellijInstalled && tmuxInstalled) {
        setTerminalMultiplexer("tmux");
        lastTerminalMuxRef.current = "tmux";
      }
    }
  }, [isLoaded, isChecking, depStates, webTerminalMode, hasMultiplexer, terminalMultiplexer, tmuxInstalled, zellijInstalled]);

  // Filter and mark agent options based on mode + command availability
  const customAgentIds = customAgents.map(a => a.id);
  const hasAvailability = Object.keys(commandAvailability).length > 0;

  // Terminal Agent 选项（检测 terminalCheck 命令）
  const terminalAgentOptions = useMemo(() => agentOptions.map(a => {
    if (!hasAvailability) return a;
    const cmd = a.terminalCheck;
    if (cmd && commandAvailability[cmd] === false) {
      return { ...a, disabled: true, disabledReason: `${cmd} not found — install to enable` };
    }
    return a;
  }), [commandAvailability, hasAvailability]);

  // Chat Agent 选项（仅 ACP 兼容 + 检测 acpCheck 命令，支持 fallback）
  const chatAgentOptions = useMemo(() => agentOptions
    .filter(a => !!a.acpCheck || customAgentIds.includes(a.id))
    .map(a => {
      if (!hasAvailability) return a;
      const cmd = a.acpCheck;
      const fallback = a.acpFallback;
      const available = (cmd && commandAvailability[cmd] === true) || (fallback && commandAvailability[fallback] === true);
      if (cmd && !available) {
        return { ...a, disabled: true, disabledReason: `${cmd} not found — install to enable` };
      }
      return a;
    }), [commandAvailability, hasAvailability, customAgentIds]);

  // Feature availability (auto-derived from dependencies)
  const isTerminalAvailable = canUseTerminal;
  const isChatAvailable = chatAgentOptions.some(a => !a.disabled) || customAgents.length > 0;

  // Sync availability to ConfigContext for Task panel components
  useEffect(() => {
    if (Object.keys(depStates).length > 0) {
      updateAvailability(isTerminalAvailable, isChatAvailable);
    }
  }, [depStates, commandAvailability, isTerminalAvailable, isChatAvailable, updateAvailability]);

  // Auto-correct agent selection: pick first available, or clear if none available
  useEffect(() => {
    if (!isLoaded || Object.keys(commandAvailability).length === 0) return;

    // Terminal Agent
    if (agentCommand) {
      const currentAgent = agentOptions.find(a => a.id === agentCommand);
      const cmd = currentAgent?.terminalCheck;
      if (cmd && commandAvailability[cmd] === false) {
        const firstAvailable = terminalAgentOptions.find(a => !a.disabled);
        setAgentCommand(firstAvailable?.id ?? "");
      }
    }

    // Chat Agent (check both acpCheck and acpFallback)
    if (acpAgent) {
      const currentAgent = agentOptions.find(a => a.id === acpAgent);
      const cmd = currentAgent?.acpCheck;
      const fallback = currentAgent?.acpFallback;
      const available = (cmd && commandAvailability[cmd] === true) || (fallback && commandAvailability[fallback] === true);
      if (cmd && !available) {
        const firstAvailable = chatAgentOptions.find(a => !a.disabled);
        setAcpAgent(firstAvailable?.id ?? "");
      }
    }
  }, [isLoaded, commandAvailability, agentCommand, acpAgent, terminalAgentOptions, chatAgentOptions]);

  const claudeCodeConfig = JSON.stringify(
    {
      mcpServers: {
        grove: {
          type: config.mcp.type,
          command: config.mcp.command,
          args: config.mcp.args,
        },
      },
    },
    null,
    2
  );

  const codexConfig = `[mcp_servers.grove]
command = "${config.mcp.command}"
args = ${JSON.stringify(config.mcp.args)}
env_vars = [
  "GROVE_TASK_ID",
  "GROVE_TASK_NAME",
  "GROVE_BRANCH",
  "GROVE_TARGET",
  "GROVE_WORKTREE",
  "GROVE_PROJECT_NAME",
  "GROVE_PROJECT"
]`;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
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
        {/* Chat Section */}
        <Section
          id="chat"
          title="Chat"
          description={isChatAvailable ? "Ready" : "Need Setup"}
          icon={MessageSquare}
          iconColor={isChatAvailable ? "var(--color-success)" : "var(--color-warning)"}
          isOpen={openSections.chat}
          onToggle={() => toggleSection("chat")}
        >
          <div className="space-y-5">
            {/* Chat Coding Agent */}
            <div>
              <div className="text-xs font-medium text-[var(--color-text-muted)] mb-2 uppercase tracking-wider select-none">Chat Coding Agent</div>
              <AgentPicker
                value={acpAgent}
                onChange={setAcpAgent}
                options={chatAgentOptions}
                allowCustom={false}
                placeholder="Select agent..."
                customAgents={customAgents}
                onManageCustomAgents={() => setShowCustomAgentModal(true)}
              />
            </div>

            {/* ACP Adapter */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider select-none">ACP Adapter</div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => { checkDependencies(); checkAgentCommands(); }}
                  disabled={isChecking}
                  className="!p-1 !h-auto"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isChecking ? "animate-spin" : ""}`} />
                </Button>
              </div>
              {(() => {
                const agentAcpInstalled = depStates["claude-agent-acp"]?.status === "installed";
                const codeAcpInstalled = depStates["claude-code-acp"]?.status === "installed";
                const codexAcpInstalled = depStates["codex-acp"]?.status === "installed";
                const needsUpgrade = !agentAcpInstalled && codeAcpInstalled;

                return (
                  <div className="space-y-1.5">
                    {needsUpgrade && (
                      <div className="flex items-center justify-between px-3 py-2.5 rounded-lg border border-[var(--color-warning)]/30 bg-[var(--color-warning)]/5">
                        <div className="flex items-center gap-2.5">
                          <AlertCircle className="w-3.5 h-3.5 text-[var(--color-warning)]" />
                          <div>
                            <span className="text-sm text-[var(--color-text)]">Claude Agent ACP</span>
                            <div className="text-[11px] text-[var(--color-warning)]">
                              <code className="text-[11px]">claude-code-acp</code> renamed — upgrade to <code className="text-[11px]">claude-agent-acp</code>
                            </div>
                          </div>
                        </div>
                        <button
                          onClick={() => handleCopy("upgrade-acp", "npm install -g @agentclientprotocol/claude-agent-acp")}
                          className="flex items-center gap-1.5 px-2 py-1 text-xs rounded bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-border)] transition-colors"
                        >
                          <code className="text-[11px] text-[var(--color-text-muted)]">npm i -g @agentclientprotocol/claude-agent-acp</code>
                          {copiedField === "upgrade-acp" ? (
                            <Check className="w-3 h-3 text-[var(--color-success)]" />
                          ) : (
                            <Copy className="w-3 h-3 text-[var(--color-text-muted)]" />
                          )}
                        </button>
                      </div>
                    )}
                    {!needsUpgrade && (
                      <div className={`flex items-center justify-between px-3 py-2.5 rounded-lg border transition-all ${
                        agentAcpInstalled
                          ? "border-[var(--color-border)] bg-[var(--color-bg-secondary)]"
                          : "border-[var(--color-border)]/50 bg-[var(--color-bg-secondary)]"
                      }`}>
                        <div className="flex items-center gap-2.5">
                          {depStates["claude-agent-acp"]?.status === "checking"
                            ? <RefreshCw className="w-3.5 h-3.5 text-[var(--color-text-muted)] animate-spin" />
                            : agentAcpInstalled
                              ? <CheckCircle2 className="w-3.5 h-3.5 text-[var(--color-success)]" />
                              : <XCircle className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
                          }
                          <span className="text-sm text-[var(--color-text)]">Claude Agent ACP</span>
                        </div>
                        {!agentAcpInstalled && depStates["claude-agent-acp"]?.installCommand && (
                          <button
                            onClick={() => handleCopy("install-claude-agent-acp", depStates["claude-agent-acp"].installCommand)}
                            className="flex items-center gap-1.5 px-2 py-1 text-xs rounded bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-border)] transition-colors"
                            title={depStates["claude-agent-acp"].installCommand}
                          >
                            <code className="text-[11px] text-[var(--color-text-muted)]">{depStates["claude-agent-acp"].installCommand}</code>
                            {copiedField === "install-claude-agent-acp" ? (
                              <Check className="w-3 h-3 text-[var(--color-success)]" />
                            ) : (
                              <Copy className="w-3 h-3 text-[var(--color-text-muted)]" />
                            )}
                          </button>
                        )}
                        {agentAcpInstalled && depStates["claude-agent-acp"]?.version && (
                          <span className="text-xs text-[var(--color-text-muted)]">v{depStates["claude-agent-acp"].version}</span>
                        )}
                      </div>
                    )}
                    <div className={`flex items-center justify-between px-3 py-2.5 rounded-lg border transition-all ${
                      codexAcpInstalled
                        ? "border-[var(--color-border)] bg-[var(--color-bg-secondary)]"
                        : "border-[var(--color-border)]/50 bg-[var(--color-bg-secondary)]"
                    }`}>
                      <div className="flex items-center gap-2.5">
                        {depStates["codex-acp"]?.status === "checking"
                          ? <RefreshCw className="w-3.5 h-3.5 text-[var(--color-text-muted)] animate-spin" />
                          : codexAcpInstalled
                            ? <CheckCircle2 className="w-3.5 h-3.5 text-[var(--color-success)]" />
                            : <XCircle className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
                        }
                        <span className="text-sm text-[var(--color-text)]">Codex ACP</span>
                      </div>
                      {!codexAcpInstalled && depStates["codex-acp"]?.installCommand && (
                        <button
                          onClick={() => handleCopy("install-codex-acp", depStates["codex-acp"].installCommand)}
                          className="flex items-center gap-1.5 px-2 py-1 text-xs rounded bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-border)] transition-colors"
                          title={depStates["codex-acp"].installCommand}
                        >
                          <code className="text-[11px] text-[var(--color-text-muted)]">{depStates["codex-acp"].installCommand}</code>
                          {copiedField === "install-codex-acp" ? (
                            <Check className="w-3 h-3 text-[var(--color-success)]" />
                          ) : (
                            <Copy className="w-3 h-3 text-[var(--color-text-muted)]" />
                          )}
                        </button>
                      )}
                      {codexAcpInstalled && depStates["codex-acp"]?.version && (
                        <span className="text-xs text-[var(--color-text-muted)]">v{depStates["codex-acp"].version}</span>
                      )}
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        </Section>

        {/* Terminal Section */}
        <Section
          id="terminal"
          title="Terminal"
          description={
            !isTerminalAvailable ? "Need Setup"
              : webTerminalMode === "direct" ? "Direct"
              : `${dependencyInfo[terminalMultiplexer]?.name || terminalMultiplexer}`
          }
          icon={Terminal}
          iconColor={isTerminalAvailable ? "var(--color-success)" : "var(--color-warning)"}
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
                  onClick={() => { checkDependencies(); checkAgentCommands(); }}
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
                                    lastTerminalMuxRef.current = mux;
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

            {/* Terminal Coding Agent (only for multiplexer mode) */}
            {webTerminalMode === "multiplexer" && (
              <div>
                <div className="text-xs font-medium text-[var(--color-text-muted)] mb-2 uppercase tracking-wider select-none">Terminal Coding Agent</div>
                <AgentPicker
                  value={agentCommand}
                  onChange={setAgentCommand}
                  options={terminalAgentOptions}
                  allowCustom={true}
                  placeholder="Select agent..."
                />
              </div>
            )}
          </div>
        </Section>

        {/* Appearance Section */}
        <Section
          id="appearance"
          title="Appearance"
          description={`Theme: ${theme.name}`}
          icon={Palette}
          iconColor="var(--color-highlight)"
          isOpen={openSections.appearance}
          onToggle={() => toggleSection("appearance")}
        >
          <div className="space-y-3">
            <div className="text-sm font-medium text-[var(--color-text-muted)] mb-2 select-none">Select Theme</div>
            <div className={`grid ${isMobile ? "grid-cols-3" : "grid-cols-4"} gap-2`}>
              {themes.map((t) => {
                const isAuto = t.id === "auto";
                // For Auto theme, show half dark / half light preview
                const darkTheme = themes.find((th) => th.id === "dark");
                const lightTheme = themes.find((th) => th.id === "light");

                return (
                  <motion.button
                    key={t.id}
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    onClick={() => handleThemeChange(t.id)}
                    className={`relative p-3 rounded-lg border text-center transition-all
                      ${theme.id === t.id
                        ? "border-[var(--color-highlight)] bg-[var(--color-highlight)]/10"
                        : "border-[var(--color-border)] hover:border-[var(--color-text-muted)] bg-[var(--color-bg-secondary)]"
                      }`}
                  >
                    {theme.id === t.id && (
                      <div className="absolute top-1.5 right-1.5 w-4 h-4 rounded-full bg-[var(--color-highlight)] flex items-center justify-center">
                        <Check className="w-2.5 h-2.5 text-white" />
                      </div>
                    )}
                    {/* Color Preview */}
                    <div className="flex gap-1 mb-2 justify-center">
                      {isAuto ? (
                        // Auto theme: show half dark / half light
                        <>
                          <div className="w-3 h-3 rounded-full overflow-hidden flex">
                            <div className="w-1.5 h-3" style={{ backgroundColor: darkTheme?.colors.highlight }} />
                            <div className="w-1.5 h-3" style={{ backgroundColor: lightTheme?.colors.highlight }} />
                          </div>
                          <div className="w-3 h-3 rounded-full overflow-hidden flex">
                            <div className="w-1.5 h-3" style={{ backgroundColor: darkTheme?.colors.accent }} />
                            <div className="w-1.5 h-3" style={{ backgroundColor: lightTheme?.colors.accent }} />
                          </div>
                          <div className="w-3 h-3 rounded-full overflow-hidden flex">
                            <div className="w-1.5 h-3" style={{ backgroundColor: darkTheme?.colors.info }} />
                            <div className="w-1.5 h-3" style={{ backgroundColor: lightTheme?.colors.info }} />
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="w-3 h-3 rounded-full" style={{ backgroundColor: t.colors.highlight }} />
                          <div className="w-3 h-3 rounded-full" style={{ backgroundColor: t.colors.accent }} />
                          <div className="w-3 h-3 rounded-full" style={{ backgroundColor: t.colors.info }} />
                        </>
                      )}
                    </div>
                    <div className="text-xs font-medium text-[var(--color-text)]">{t.name}</div>
                  </motion.button>
                );
              })}
            </div>
          </div>

        </Section>

        {/* General Section (IDE + Terminal App) */}
        <Section
          id="devtools"
          title="General"
          description="Default IDE and terminal application"
          icon={Wrench}
          iconColor="var(--color-highlight)"
          isOpen={openSections.devtools}
          onToggle={() => toggleSection("devtools")}
        >
          <div className="space-y-6">
            {/* Default IDE */}
            <div>
              <div className="flex items-center gap-2 mb-3 select-none">
                <Code className="w-4 h-4 text-[var(--color-info)]" />
                <span className="text-sm font-medium text-[var(--color-text)]">Default IDE</span>
              </div>
              <AppPicker
                options={ideAppOptions}
                value={ideCommand}
                onChange={setIdeCommand}
                placeholder="Select IDE..."
                applications={applications}
                isLoadingApps={isLoadingApps}
                appFilter={(app) =>
                  // Filter for common IDEs/editors
                  /code|studio|idea|storm|rider|cursor|zed|sublime|atom|vim|emacs|nova|bbedit|textmate|xcode/i.test(app.name) ||
                  /com\.(microsoft|jetbrains|apple|sublimehq|github)/i.test(app.bundle_id || "")
                }
              />
            </div>

            {/* Default Terminal */}
            <div>
              <div className="flex items-center gap-2 mb-3 select-none">
                <Terminal className="w-4 h-4 text-[var(--color-accent)]" />
                <span className="text-sm font-medium text-[var(--color-text)]">Default Terminal</span>
              </div>
              <AppPicker
                options={terminalAppOptions}
                value={terminalCommand}
                onChange={setTerminalCommand}
                placeholder="System Default"
                applications={applications}
                isLoadingApps={isLoadingApps}
                appFilter={(app) =>
                  // Filter for terminals
                  /terminal|iterm|warp|kitty|alacritty|hyper|konsole|tilix/i.test(app.name) ||
                  /com\.(apple\.Terminal|googlecode\.iterm|warp|kovidgoyal)/i.test(app.bundle_id || "")
                }
              />
            </div>
          </div>
        </Section>

        {/* AutoLink Section */}
        <Section
          id="autolink"
          title="AutoLink"
          description={`${autoLinkPatterns.length} patterns configured`}
          icon={Link}
          iconColor="var(--color-purple)"
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
                  <div key={index} className="flex items-center gap-2">
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
                  {[
                    { label: "**/node_modules", pattern: "**/node_modules" },
                    { label: "target", pattern: "target" },
                    { label: "build", pattern: "build" },
                    { label: "dist", pattern: "dist" },
                    { label: ".next", pattern: ".next" },
                    { label: ".nuxt", pattern: ".nuxt" },
                    { label: ".turbo", pattern: ".turbo" },
                    { label: ".cache", pattern: ".cache" },
                    { label: "vendor", pattern: "vendor" },
                    { label: "**/venv", pattern: "**/venv" },
                    { label: "**/__pycache__", pattern: "**/__pycache__" },
                  ].map((preset) => (
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
              description="Default pane layout for new tasks"
              icon={LayoutGrid}
              iconColor="var(--color-info)"
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

            {/* Layout Editor Dialog */}
            <LayoutEditor
              isOpen={isLayoutEditorOpen}
              onClose={() => setIsLayoutEditorOpen(false)}
              layouts={customLayouts}
              onChange={(layouts) => {
                setCustomLayouts(layouts);
                setCustomLayoutsLoaded(true); // Mark as edited, so we can save
              }}
              selectedLayoutId={selectedCustomLayoutId}
              onSelectLayout={setSelectedCustomLayoutId}
            />
          </>
        )}

        {/* Hooks Section */}
        <Section
          id="hooks"
          title="Hooks"
          description="Generate notification commands for agents"
          icon={Bell}
          iconColor="var(--color-warning)"
          isOpen={openSections.hooks}
          onToggle={() => toggleSection("hooks")}
        >
          <div className="space-y-4">
            {/* Level Selection */}
            <div>
              <div className="text-sm font-medium text-[var(--color-text-muted)] mb-2 select-none">Level</div>
              <div className="flex gap-2">
                {notificationLevels.map(({ level, icon: Icon, color, title }) => {
                  const isSelected = hookLevel === level;
                  return (
                    <motion.button
                      key={level}
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      onClick={() => setHookLevel(level as "notice" | "warn" | "critical")}
                      className={`flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg border transition-all
                        ${isSelected
                          ? "border-[var(--color-highlight)] bg-[var(--color-highlight)]/10"
                          : "border-[var(--color-border)] bg-[var(--color-bg-secondary)] hover:border-[var(--color-text-muted)]"
                        }`}
                    >
                      <Icon className="w-4 h-4" style={{ color: isSelected ? color : "var(--color-text-muted)" }} />
                      <span className={`text-sm ${isSelected ? "text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>
                        {title}
                      </span>
                    </motion.button>
                  );
                })}
              </div>
            </div>

            {/* Banner & Sound Options */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-sm font-medium text-[var(--color-text-muted)] mb-2 select-none">Banner</div>
                <div className="flex gap-2">
                  {[true, false].map((value) => {
                    const isSelected = hookBanner === value;
                    return (
                      <motion.button
                        key={value ? "on" : "off"}
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.98 }}
                        onClick={() => setHookBanner(value)}
                        className={`flex-1 px-3 py-2 rounded-lg border text-sm transition-all
                          ${isSelected
                            ? "border-[var(--color-highlight)] bg-[var(--color-highlight)]/10 text-[var(--color-text)]"
                            : "border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)] hover:border-[var(--color-text-muted)]"
                          }`}
                      >
                        {value ? "On" : "Off"}
                      </motion.button>
                    );
                  })}
                </div>
              </div>
              <div>
                <div className="text-sm font-medium text-[var(--color-text-muted)] mb-2 select-none">Sound</div>
                <Combobox
                  options={soundOptions}
                  value={hookSound}
                  onChange={setHookSound}
                  placeholder="Select sound..."
                  allowCustom={false}
                />
              </div>
            </div>

            {/* Message */}
            <div>
              <div className="text-sm font-medium text-[var(--color-text-muted)] mb-2 select-none">Message</div>
              <input
                type="text"
                value={hookMessage}
                onChange={(e) => setHookMessage(e.target.value)}
                placeholder="e.g., Task completed..."
                className="w-full px-3 py-2 text-sm bg-[var(--color-bg-secondary)] text-[var(--color-text)] border border-[var(--color-border)] rounded-lg focus:outline-none focus:ring-1 focus:ring-[var(--color-highlight)] placeholder:text-[var(--color-text-muted)]"
              />
              <p className="text-xs text-[var(--color-text-muted)] mt-1 select-none">
                Optional message included with the notification.
              </p>
            </div>

            {/* Generated Command */}
            <div>
              <div className="text-sm font-medium text-[var(--color-text-muted)] mb-2 select-none">Generated Command</div>
              <div className="flex items-center gap-2 p-3 bg-[var(--color-bg-secondary)] rounded-lg border border-[var(--color-border)]">
                <code className="flex-1 text-sm text-[var(--color-highlight)] font-mono">{hookCommand}</code>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleCopy("hook-command", hookCommand)}
                >
                  {copiedField === "hook-command" ? (
                    <Check className="w-4 h-4 text-[var(--color-success)]" />
                  ) : (
                    <Copy className="w-4 h-4" />
                  )}
                </Button>
              </div>
              <p className="text-xs text-[var(--color-text-muted)] mt-2 select-none">
                Add this command to your agent's workflow to send notifications to Grove.
              </p>
            </div>
          </div>
        </Section>

        {/* MCP Server Section */}
        <Section
          id="mcp"
          title="MCP Server"
          description="AI agent integration via MCP protocol"
          icon={Plug}
          iconColor="#8b5cf6"
          isOpen={openSections.mcp}
          onToggle={() => toggleSection("mcp")}
        >
          <div className="space-y-4">
            {/* Server Info - More Prominent */}
            <div className="p-4 bg-[var(--color-highlight)]/5 rounded-xl border border-[var(--color-highlight)]/20">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="text-xs text-[var(--color-text-muted)] mb-1 select-none">Name</div>
                  <code className="text-sm font-semibold text-[var(--color-highlight)]">{config.mcp.name}</code>
                </div>
                <div>
                  <div className="text-xs text-[var(--color-text-muted)] mb-1 select-none">Type</div>
                  <code className="text-sm font-semibold text-[var(--color-text)]">{config.mcp.type}</code>
                </div>
                <div>
                  <div className="text-xs text-[var(--color-text-muted)] mb-1 select-none">Command</div>
                  <code className="text-sm font-semibold text-[var(--color-text)]">{config.mcp.command}</code>
                </div>
                <div>
                  <div className="text-xs text-[var(--color-text-muted)] mb-1 select-none">Args</div>
                  <code className="text-sm font-semibold text-[var(--color-text)]">{config.mcp.args.join(" ")}</code>
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
                  onClick={() => handleCopy("code", claudeCodeConfig)}
                >
                  {copiedField === "code" ? (
                    <Check className="w-4 h-4 text-[var(--color-success)]" />
                  ) : (
                    <Copy className="w-4 h-4" />
                  )}
                </Button>
              </div>
              <pre className="p-3 bg-[var(--color-bg-secondary)] rounded-lg border border-[var(--color-border)] text-xs text-[var(--color-text-muted)] overflow-x-auto">
                {claudeCodeConfig}
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
                  onClick={() => handleCopy("codex", codexConfig)}
                >
                  {copiedField === "codex" ? (
                    <Check className="w-4 h-4 text-[var(--color-success)]" />
                  ) : (
                    <Copy className="w-4 h-4" />
                  )}
                </Button>
              </div>
              <pre className="p-3 bg-[var(--color-bg-secondary)] rounded-lg border border-[var(--color-border)] text-xs text-[var(--color-text-muted)] overflow-x-auto">
                {codexConfig}
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

      </div>

      {/* Custom Agent Modal */}
      <CustomAgentModal
        isOpen={showCustomAgentModal}
        onClose={() => setShowCustomAgentModal(false)}
        agents={customAgents}
        onSave={async (agents) => {
          setCustomAgents(agents);
          try {
            await patchConfig({ acp: { custom_agents: agents } });
            await refreshGlobalConfig();
          } catch {
            console.error("Failed to save custom agents");
          }
        }}
      />
    </motion.div>
  );
}
