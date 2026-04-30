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
  Info,
  ExternalLink,
  RefreshCw,
  Palette,
  Settings,
  Code,
  Wrench,
  Link,
  Plus,
  X,
  Volume2,
  Bot,
  Server,
  UserCog,
} from "lucide-react";
import { Button, Combobox, AppPicker, AgentPicker, agentOptions, ideAppOptions, terminalAppOptions, CustomAgentModal } from "../ui";
import type { ComboboxOption } from "../ui";
import { useTheme, themes, useConfig } from "../../context";
import {
  getConfig,
  patchConfig,
  previewHookSound,
  checkAllDependencies,
  checkCommands,
  listBaseAgents,
  listApplications,
  listCustomAgents,
  type AppInfo,
  type BaseAgent,
  type CustomAgentServer,
  type CustomAgentPersona,
} from "../../api";
import { LayoutEditor, type CustomLayoutConfig, type PaneType, type LayoutNode, createDefaultLayout, countPanes } from "./LayoutEditor";
import { CustomAgentsModal } from "./CustomAgentsModal";
import {
  setCustomAgentPersonas as setCustomAgentPersonasIconRegistry,
  loadCustomAgentPersonas as loadCustomAgentPersonasIcon,
} from "../../utils/agentIcon";
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

// Note: Agent options are imported from AgentPicker
// IDE and Terminal options are imported from AppPicker

// Sound options for hooks (macOS system sounds)
const soundOptions: ComboboxOption[] = [
  { id: "none", label: "NONE", value: "none" },
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
  // null = unknown until listApplications() resolves — prevents the IDE/Terminal
  // pickers from briefly rendering on Windows/Linux during initial load.
  const [serverPlatform, setServerPlatform] = useState<string | null>(null);

  // ACP / Custom agents state
  const [acpAgent, setAcpAgent] = useState("claude"); // Chat mode agent
  const [customAgents, setCustomAgents] = useState<CustomAgentServer[]>([]);
  const [showCustomAgentModal, setShowCustomAgentModal] = useState(false);
  const [showCustomAgentsModal, setShowCustomAgentsModal] = useState(false);
  const [customAgentPersonas, setCustomAgentPersonas] = useState<CustomAgentPersona[]>([]);
  const [customAgentPersonasLoading, setCustomAgentPersonasLoading] = useState(false);
  const [baseAgents, setBaseAgents] = useState<BaseAgent[]>([]);
  const [baseAgentsLoading, setBaseAgentsLoading] = useState(true);
  const [chatRenderWindowLimit, setChatRenderWindowLimit] = useState(0);
  const [chatRenderWindowTrigger, setChatRenderWindowTrigger] = useState(1500);
  const [chatRenderWindowLimitDraft, setChatRenderWindowLimitDraft] = useState("0");
  const [chatRenderWindowTriggerDraft, setChatRenderWindowTriggerDraft] = useState("1500");

  // Agent command availability: command name → exists on PATH
  const [commandAvailability, setCommandAvailability] = useState<Record<string, boolean>>({});

  // Mode state
  const [terminalMultiplexer, setTerminalMultiplexer] = useState("tmux");
  // Web terminal backend: "multiplexer" (default) | "direct"
  const [webTerminalMode, setWebTerminalMode] = useState("multiplexer");
  const [workspaceLayout, setWorkspaceLayout] = useState<"flex" | "ide">("flex");

  const lastTerminalMuxRef = useRef<string>("tmux");
  const defaultAppliedRef = useRef(false);

  // Layout state
  const [selectedLayout, setSelectedLayout] = useState(config.layout.default);
  const [customLayouts, setCustomLayouts] = useState<CustomLayoutConfig[]>(defaultCustomLayouts);
  const [selectedCustomLayoutId, setSelectedCustomLayoutId] = useState<string | null>(defaultCustomLayouts[0]?.id || null);
  const [customLayoutsLoaded, setCustomLayoutsLoaded] = useState(false); // Track if custom layouts were loaded from API
  const [isLayoutEditorOpen, setIsLayoutEditorOpen] = useState(false);

  const [hooksEnabled, setHooksEnabled] = useState(true);
  const [hooksBanner, setHooksBanner] = useState(true);
  const [hooksResponseSoundEnabled, setHooksResponseSoundEnabled] = useState(true);
  const [hooksResponseSound, setHooksResponseSound] = useState("Glass");
  const [hooksPermissionSoundEnabled, setHooksPermissionSoundEnabled] = useState(true);
  const [hooksPermissionSound, setHooksPermissionSound] = useState("Purr");

  // Notifications (menubar tray + system notifications)
  const [trayEnabled, setTrayEnabled] = useState(true);
  const [trayShowPermission, setTrayShowPermission] = useState(true);
  const [trayShowDone, setTrayShowDone] = useState(true);
  const [trayShowRunning, setTrayShowRunning] = useState(true);
  const [systemNotifEnabled, setSystemNotifEnabled] = useState(false);
  const [systemNotifShowPermission, setSystemNotifShowPermission] = useState(true);
  const [systemNotifShowDone, setSystemNotifShowDone] = useState(true);
  const [systemNotifShowRunning, setSystemNotifShowRunning] = useState(false);

  // MCP state
  const [copiedField, setCopiedField] = useState<string | null>(null);

  // AutoLink state
  const [autoLinkPatterns, setAutoLinkPatterns] = useState<string[]>([]);

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
      setWorkspaceLayout(cfg.web.workspace_layout || "ide");

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
      const renderWindowLimit = cfg.acp?.render_window_limit ?? 0;
      const renderWindowTrigger = cfg.acp?.render_window_trigger ?? 1500;
      setChatRenderWindowLimit(renderWindowLimit);
      setChatRenderWindowTrigger(renderWindowTrigger);
      setChatRenderWindowLimitDraft(String(renderWindowLimit));
      setChatRenderWindowTriggerDraft(String(renderWindowTrigger));

      if (cfg.hooks) {
        setHooksEnabled(cfg.hooks.enabled);
        setHooksBanner(cfg.hooks.banner);
        setHooksResponseSoundEnabled(cfg.hooks.response_sound_enabled);
        setHooksResponseSound(cfg.hooks.response_sound || "Glass");
        setHooksPermissionSoundEnabled(cfg.hooks.permission_sound_enabled);
        setHooksPermissionSound(cfg.hooks.permission_sound || "Purr");
      }

      if (cfg.notifications) {
        setTrayEnabled(cfg.notifications.tray_enabled);
        setTrayShowPermission(cfg.notifications.tray_show_permission);
        setTrayShowDone(cfg.notifications.tray_show_done);
        setTrayShowRunning(cfg.notifications.tray_show_running);
        setSystemNotifEnabled(cfg.notifications.notification_enabled);
        setSystemNotifShowPermission(cfg.notifications.notification_show_permission);
        setSystemNotifShowDone(cfg.notifications.notification_show_done);
        setSystemNotifShowRunning(cfg.notifications.notification_show_running);
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
    }
    try {
      const results = await checkCommands([...cmds]);
      setCommandAvailability(results);
    } catch {
      // API not available, assume all available
    }
  }, []);

  const loadBaseAgents = useCallback(async () => {
    setBaseAgentsLoading(true);
    try {
      const agents = await listBaseAgents();
      setBaseAgents(agents);
    } catch {
      // Fall back to static list so the UI stays functional when the backend is unavailable.
      // Mark all as available (fail-open) — the user will get an error when they actually try to use one.
      setBaseAgents(
        agentOptions
          .filter((opt) => opt.acpCheck)
          .map((opt) => ({
            id: opt.id,
            display_name: opt.label,
            icon_id: opt.id,
            available: true,
          })),
      );
    } finally {
      setBaseAgentsLoading(false);
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
          workspace_layout: workspaceLayout,
        },
        terminal_multiplexer: terminalMultiplexer,
        acp: {
          agent_command: acpAgent || undefined,
          render_window_limit: chatRenderWindowLimit,
          render_window_trigger:
            chatRenderWindowLimit > 0
              ? Math.max(chatRenderWindowTrigger, chatRenderWindowLimit + 1)
              : chatRenderWindowTrigger || 1500,
        },
        auto_link: {
          patterns: autoLinkPatterns,
        },
        hooks: {
          enabled: hooksEnabled,
          banner: hooksBanner,
          response_sound_enabled: hooksResponseSoundEnabled,
          response_sound: hooksResponseSound,
          permission_sound_enabled: hooksPermissionSoundEnabled,
          permission_sound: hooksPermissionSound,
        },
        notifications: {
          tray_enabled: trayEnabled,
          tray_show_permission: trayShowPermission,
          tray_show_done: trayShowDone,
          tray_show_running: trayShowRunning,
          notification_enabled: systemNotifEnabled,
          notification_show_permission: systemNotifShowPermission,
          notification_show_done: systemNotifShowDone,
          notification_show_running: systemNotifShowRunning,
        },
      };
      await patchConfig(patch);
      // Refresh the global config cache so other pages see the changes immediately
      await refreshGlobalConfig();
    } catch {
      console.error("Failed to save config");
    }
  }, [isLoaded, selectedLayout, agentCommand, acpAgent, chatRenderWindowLimit, chatRenderWindowTrigger, customLayouts, selectedCustomLayoutId, customLayoutsLoaded, ideCommand, terminalCommand, terminalMultiplexer, webTerminalMode, workspaceLayout, autoLinkPatterns, hooksEnabled, hooksBanner, hooksResponseSoundEnabled, hooksResponseSound, hooksPermissionSoundEnabled, hooksPermissionSound, trayEnabled, trayShowPermission, trayShowDone, trayShowRunning, systemNotifEnabled, systemNotifShowPermission, systemNotifShowDone, systemNotifShowRunning, refreshGlobalConfig]);

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
  }, [selectedLayout, agentCommand, acpAgent, chatRenderWindowLimit, chatRenderWindowTrigger, customLayouts, selectedCustomLayoutId, customLayoutsLoaded, ideCommand, terminalCommand, terminalMultiplexer, webTerminalMode, workspaceLayout, autoLinkPatterns, hooksEnabled, hooksBanner, hooksResponseSoundEnabled, hooksResponseSound, hooksPermissionSoundEnabled, hooksPermissionSound, trayEnabled, trayShowPermission, trayShowDone, trayShowRunning, systemNotifEnabled, systemNotifShowPermission, systemNotifShowDone, systemNotifShowRunning, isLoaded, saveConfig]);

  // Load applications list
  const loadApplications = useCallback(async () => {
    setIsLoadingApps(true);
    try {
      const { apps, platform } = await listApplications();
      setApplications(apps);
      setServerPlatform(platform);
    } catch {
      console.error("Failed to load applications");
    } finally {
      setIsLoadingApps(false);
    }
  }, []);

  const loadCustomAgentPersonas = useCallback(async () => {
    setCustomAgentPersonasLoading(true);
    try {
      // Centralized loader — collapses concurrent fetches and ensures the
      // most-recent result is the only one written into the icon registry.
      const list = await loadCustomAgentPersonasIcon(() => listCustomAgents());
      setCustomAgentPersonas(list);
    } catch (err) {
      console.error("Failed to load custom agents:", err);
    } finally {
      setCustomAgentPersonasLoading(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    loadConfig();
    checkDependencies();
    loadApplications();
    checkAgentCommands();
    loadBaseAgents();
    loadCustomAgentPersonas();
  }, [loadConfig, checkDependencies, loadApplications, checkAgentCommands, loadBaseAgents, loadCustomAgentPersonas]);

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
  const hasAvailability = Object.keys(commandAvailability).length > 0;
  const baseAgentStatusById = useMemo(() => {
    const map = new Map<string, BaseAgent>();
    for (const agent of baseAgents) {
      map.set(agent.id, agent);
    }
    return map;
  }, [baseAgents]);

  // Terminal Agent 选项（检测 terminalCheck 命令）
  const terminalAgentOptions = useMemo(() => agentOptions.map(a => {
    if (!hasAvailability) return a;
    const cmd = a.terminalCheck;
    if (cmd && commandAvailability[cmd] === false) {
      return { ...a, disabled: true, disabledReason: `${cmd} not found — install to enable` };
    }
    return a;
  }), [commandAvailability, hasAvailability]);

  // Chat Agent 选项：ACP base agent availability comes from backend.
  const chatAgentOptions = useMemo(() => {
    return baseAgents.map((base) => {
      const local = agentOptions.find((a) => a.value === base.id || a.id === base.id);
      const option = local ?? {
        id: base.id,
        label: base.display_name,
        value: base.id,
      };
      return base.available
        ? { ...option, label: base.display_name, value: base.id }
        : {
            ...option,
            label: base.display_name,
            value: base.id,
            disabled: true,
            disabledReason: `${base.unavailable_reason ?? "not available"} — install to enable`,
          };
    });
  }, [baseAgents]);

  // Feature availability (auto-derived from dependencies)
  const isTerminalAvailable = canUseTerminal;
  const isChatAvailable = chatAgentOptions.some(a => !a.disabled) || customAgents.length > 0;

  // Sync availability to ConfigContext for Task panel components
  useEffect(() => {
    if (Object.keys(depStates).length > 0) {
      updateAvailability(isTerminalAvailable);
    }
  }, [depStates, commandAvailability, isTerminalAvailable, updateAvailability]);

  // Auto-correct agent selection: pick first available, or clear if none available
  useEffect(() => {
    if (!isLoaded) return;
    const hasTerminalAvailability = Object.keys(commandAvailability).length > 0;

    // Terminal Agent
    if (hasTerminalAvailability && agentCommand) {
      const currentAgent = agentOptions.find(a => a.id === agentCommand);
      const cmd = currentAgent?.terminalCheck;
      if (cmd && commandAvailability[cmd] === false) {
        const firstAvailable = terminalAgentOptions.find(a => !a.disabled);
        setAgentCommand(firstAvailable?.id ?? "");
      }
    }

    // Chat Agent availability is backend-derived from /agents/base.
    if (baseAgents.length > 0 && acpAgent) {
      const currentBaseAgent = baseAgentStatusById.get(acpAgent);
      if (currentBaseAgent && !currentBaseAgent.available) {
        const firstAvailable = chatAgentOptions.find(a => !a.disabled);
        setAcpAgent(firstAvailable?.value ?? "");
      }
    }
  }, [isLoaded, commandAvailability, agentCommand, acpAgent, terminalAgentOptions, chatAgentOptions, baseAgentStatusById, baseAgents.length]);

  const suggestedChatRenderWindowTrigger = useCallback((limit: number) => {
    return Math.max(limit + 1, Math.ceil(limit * 1.5));
  }, []);

  const commitChatRenderWindowLimit = useCallback((value: string) => {
    const parsed = Number(value);
    const nextLimit = Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
    setChatRenderWindowLimit(nextLimit);
    setChatRenderWindowLimitDraft(String(nextLimit));
    if (nextLimit > 0) {
      setChatRenderWindowTrigger((current) =>
        current > nextLimit ? current : suggestedChatRenderWindowTrigger(nextLimit),
      );
      setChatRenderWindowTriggerDraft((current) => {
        const currentNumber = Number(current);
        const nextTrigger =
          Number.isFinite(currentNumber) && currentNumber > nextLimit
            ? Math.floor(currentNumber)
            : suggestedChatRenderWindowTrigger(nextLimit);
        return String(nextTrigger);
      });
    }
  }, [suggestedChatRenderWindowTrigger]);

  const commitChatRenderWindowTrigger = useCallback((value: string) => {
    const parsed = Number(value);
    const nextTrigger = Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
    const normalizedTrigger =
      chatRenderWindowLimit > 0
        ? Math.max(nextTrigger, chatRenderWindowLimit + 1)
        : nextTrigger || 1500;
    setChatRenderWindowTrigger(normalizedTrigger);
    setChatRenderWindowTriggerDraft(String(normalizedTrigger));
  }, [chatRenderWindowLimit]);

  const setChatRenderWindowMode = useCallback((mode: "unlimited" | "custom") => {
    if (mode === "unlimited") {
      setChatRenderWindowLimit(0);
      setChatRenderWindowLimitDraft("0");
      return;
    }
    setChatRenderWindowLimit((current) => {
      const next = current > 0 ? current : 1000;
      setChatRenderWindowLimitDraft(String(next));
      return next;
    });
    setChatRenderWindowTrigger((current) => {
      const next = current > 1000 ? current : 1500;
      setChatRenderWindowTriggerDraft(String(next));
      return next;
    });
  }, []);

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
        {/* Agent Section */}
        <Section
          id="chat"
          title="Agent"
          description={isChatAvailable ? "Ready" : "Need Setup"}
          icon={Bot}
          iconColor={isChatAvailable ? "var(--color-success)" : "var(--color-warning)"}
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

            {/* Custom Agent entry buttons */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <motion.button
                type="button"
                whileHover={{ scale: 1.01 }}
                whileTap={{ scale: 0.99 }}
                onClick={() => setShowCustomAgentsModal(true)}
                className="flex items-start gap-3 p-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] hover:border-[var(--color-highlight)]/50 transition-colors text-left"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[var(--color-highlight)]/10">
                  <UserCog className="w-4 h-4 text-[var(--color-highlight)]" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-[var(--color-text)]">
                    Custom Agents
                    <span className="ml-2 text-[10px] text-[var(--color-text-muted)] font-normal">
                      {customAgentPersonas.length > 0 ? `${customAgentPersonas.length} configured` : "None"}
                    </span>
                  </div>
                  <div className="text-xs text-[var(--color-text-muted)] mt-0.5">
                    Personas with preset model & system prompt
                  </div>
                </div>
              </motion.button>

              <motion.button
                type="button"
                whileHover={{ scale: 1.01 }}
                whileTap={{ scale: 0.99 }}
                onClick={() => setShowCustomAgentModal(true)}
                className="flex items-start gap-3 p-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] hover:border-[var(--color-highlight)]/50 transition-colors text-left"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[var(--color-info)]/10">
                  <Server className="w-4 h-4 text-[var(--color-info)]" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-[var(--color-text)]">
                    Custom Agent Servers
                    <span className="ml-2 text-[10px] text-[var(--color-text-muted)] font-normal">
                      {customAgents.length > 0 ? `${customAgents.length} configured` : "None"}
                    </span>
                  </div>
                  <div className="text-xs text-[var(--color-text-muted)] mt-0.5">
                    For private or self-hosted ACP deploys
                  </div>
                </div>
              </motion.button>
            </div>

            {/* Chat render window */}
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider select-none">Chat Render Window</div>
                  <div className="mt-0.5 text-xs text-[var(--color-text-muted)]">
                    {chatRenderWindowLimit > 0
                      ? `Keep latest ${chatRenderWindowLimit.toLocaleString()} messages`
                      : "Keep the full conversation in view"}
                  </div>
                </div>
                <div className="inline-flex rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-0.5">
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
                <div className="flex flex-wrap items-center gap-2 text-sm text-[var(--color-text-muted)]">
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
              <p className="text-xs leading-relaxed text-[var(--color-text-muted)]">
                Custom hides older UI messages after a turn completes. Full chat history remains saved.
              </p>
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
            {serverPlatform === null ? (
              <div className="flex items-center gap-3 p-4 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
                <p className="text-sm text-[var(--color-text-muted)]">Detecting platform...</p>
              </div>
            ) : serverPlatform !== "macos" ? (
              <div className="flex items-center gap-3 p-4 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
                <Info className="w-5 h-5 text-[var(--color-text-muted)] shrink-0" />
                <p className="text-sm text-[var(--color-text-muted)]">
                  IDE and terminal application detection is not yet supported on {
                    serverPlatform === "windows" ? "Windows"
                    : serverPlatform === "linux" ? "Linux"
                    : serverPlatform
                  }.
                </p>
              </div>
            ) : (
              <>
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
                      /terminal|iterm|warp|ghostty|kitty|alacritty|hyper|konsole|tilix|wezterm|cmux/i.test(app.name) ||
                      /com\.(apple\.Terminal|googlecode\.iterm|warp|kovidgoyal|wez|feh)|io\.github\.mlfwka/i.test(app.bundle_id || "")
                    }
                  />
                </div>
              </>
            )}

            {/* Workspace Layout */}
            <div>
              <div className="flex items-center gap-2 mb-3 select-none">
                <LayoutGrid className="w-4 h-4 text-[var(--color-warning)]" />
                <span className="text-sm font-medium text-[var(--color-text)]">Workspace Layout</span>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={() => setWorkspaceLayout("flex")}
                  className={`p-3 rounded-lg border text-left transition-all ${
                    workspaceLayout === "flex"
                      ? "border-[var(--color-highlight)] bg-[var(--color-highlight)]/10"
                      : "border-[var(--color-border)] bg-[var(--color-bg-secondary)] hover:border-[var(--color-highlight)]/50"
                  }`}
                >
                  <div className="text-xs font-medium text-[var(--color-text)] mb-1">Free Layout</div>
                  <div className="text-[11px] text-[var(--color-text-muted)]">Drag and arrange panels freely</div>
                </button>
                <button
                  onClick={() => setWorkspaceLayout("ide")}
                  className={`p-3 rounded-lg border text-left transition-all ${
                    workspaceLayout === "ide"
                      ? "border-[var(--color-highlight)] bg-[var(--color-highlight)]/10"
                      : "border-[var(--color-border)] bg-[var(--color-bg-secondary)] hover:border-[var(--color-highlight)]/50"
                  }`}
                >
                  <div className="text-xs font-medium text-[var(--color-text)] mb-1">IDE Layout</div>
                  <div className="text-[11px] text-[var(--color-text-muted)]">Fixed panels with Chat-centric view</div>
                </button>
              </div>
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
          title="Notification"
          description="ACP Chat notification settings"
          icon={Bell}
          iconColor="var(--color-warning)"
          isOpen={openSections.hooks}
          onToggle={() => toggleSection("hooks")}
        >
          <div className="space-y-5">
            <div>
              <div className="text-sm font-medium text-[var(--color-text-muted)] mb-2 select-none">Enabled</div>
              <div className="flex gap-2">
                {[true, false].map((value) => {
                  const isSelected = hooksEnabled === value;
                  return (
                    <motion.button
                      key={value ? "on" : "off"}
                      whileHover={{ scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      onClick={() => setHooksEnabled(value)}
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

            {hooksEnabled && (
              <>
                <div>
                  <div className="text-sm font-medium text-[var(--color-text-muted)] mb-2 select-none">System Banner</div>
                  <div className="flex gap-2">
                    {[true, false].map((value) => {
                      const isSelected = hooksBanner === value;
                      return (
                        <motion.button
                          key={value ? "on" : "off"}
                          whileHover={{ scale: 1.02 }}
                          whileTap={{ scale: 0.98 }}
                          onClick={() => setHooksBanner(value)}
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
                  <div className="text-sm font-medium text-[var(--color-text-muted)] mb-2 select-none">Agent Response</div>
                  <p className="text-xs text-[var(--color-text-muted)] mb-2 select-none">When the agent finishes responding to a prompt</p>
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <Combobox
                        options={soundOptions}
                        value={hooksResponseSoundEnabled ? hooksResponseSound : "none"}
                        onChange={(value) => {
                          if (value === "none") {
                            setHooksResponseSoundEnabled(false);
                            return;
                          }
                          setHooksResponseSoundEnabled(true);
                          setHooksResponseSound(value);
                        }}
                        placeholder="Select sound..."
                        allowCustom={false}
                      />
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => previewHookSound(hooksResponseSound)}
                      title="Preview sound"
                      disabled={!hooksResponseSoundEnabled}
                      className="h-9 w-9 !p-0 rounded-xl"
                    >
                      <Volume2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>

                <div>
                  <div className="text-sm font-medium text-[var(--color-text-muted)] mb-2 select-none">Agent Permission Required</div>
                  <p className="text-xs text-[var(--color-text-muted)] mb-2 select-none">When the agent needs your approval for an action</p>
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <Combobox
                        options={soundOptions}
                        value={hooksPermissionSoundEnabled ? hooksPermissionSound : "none"}
                        onChange={(value) => {
                          if (value === "none") {
                            setHooksPermissionSoundEnabled(false);
                            return;
                          }
                          setHooksPermissionSoundEnabled(true);
                          setHooksPermissionSound(value);
                        }}
                        placeholder="Select sound..."
                        allowCustom={false}
                      />
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => previewHookSound(hooksPermissionSound)}
                      title="Preview sound"
                      disabled={!hooksPermissionSoundEnabled}
                      className="h-9 w-9 !p-0 rounded-xl"
                    >
                      <Volume2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>

                {/* Menubar tray + System notifications — share the same Notification surface */}
                <div className="pt-2 space-y-4 border-t border-[color-mix(in_srgb,var(--color-border)_60%,transparent)]">
                  <div className="text-sm font-medium text-[var(--color-text-muted)] mt-3 select-none">
                    Menubar & System
                  </div>
                  <NotifChannel
                    title="Menubar Tray"
                    subtitle="Persistent popover anchored to the menubar icon"
                    enabled={trayEnabled}
                    onEnabledChange={setTrayEnabled}
                    showPermission={trayShowPermission}
                    onShowPermissionChange={setTrayShowPermission}
                    showDone={trayShowDone}
                    onShowDoneChange={setTrayShowDone}
                    showRunning={trayShowRunning}
                    onShowRunningChange={setTrayShowRunning}
                    note="Disabling the tray takes effect on next Grove launch."
                  />
                  <NotifChannel
                    title="System Notifications"
                    subtitle="Native OS banner / notification center"
                    enabled={systemNotifEnabled}
                    onEnabledChange={setSystemNotifEnabled}
                    showPermission={systemNotifShowPermission}
                    onShowPermissionChange={setSystemNotifShowPermission}
                    showDone={systemNotifShowDone}
                    onShowDoneChange={setSystemNotifShowDone}
                    showRunning={systemNotifShowRunning}
                    onShowRunningChange={setSystemNotifShowRunning}
                    note="Running notifications are off by default — they fire continuously and would be noisy."
                  />
                </div>
              </>
            )}
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

      {/* Custom Agent Servers Modal (existing) */}
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

      {/* Custom Agents (Persona) Modal */}
      <CustomAgentsModal
        isOpen={showCustomAgentsModal}
        onClose={() => setShowCustomAgentsModal(false)}
        agents={customAgentPersonas}
        baseAgentOptions={chatAgentOptions}
        customServers={customAgents}
        loading={customAgentPersonasLoading}
        onChanged={(next) => {
          setCustomAgentPersonas(next);
          setCustomAgentPersonasIconRegistry(next);
        }}
      />
    </motion.div>
  );
}

// ─── Notification channel sub-card ──────────────────────────────────────────

interface NotifChannelProps {
  title: string;
  subtitle: string;
  enabled: boolean;
  onEnabledChange: (v: boolean) => void;
  showPermission: boolean;
  onShowPermissionChange: (v: boolean) => void;
  showDone: boolean;
  onShowDoneChange: (v: boolean) => void;
  showRunning: boolean;
  onShowRunningChange: (v: boolean) => void;
  note?: string;
}

function NotifChannel({
  title,
  subtitle,
  enabled,
  onEnabledChange,
  showPermission,
  onShowPermissionChange,
  showDone,
  onShowDoneChange,
  showRunning,
  onShowRunningChange,
  note,
}: NotifChannelProps) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <div className="text-sm font-semibold text-[var(--color-text)]">{title}</div>
          <div className="text-xs text-[var(--color-text-muted)] mt-0.5">{subtitle}</div>
        </div>
        <ToggleSwitch checked={enabled} onChange={onEnabledChange} />
      </div>
      <AnimatePresence initial={false}>
        {enabled ? (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18 }}
            className="overflow-hidden"
          >
            <div className="mt-2 space-y-2.5 border-t border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] pt-3">
              <CategoryToggle
                label="Permission required"
                description="Pending tool-call approvals"
                accent="var(--color-warning)"
                checked={showPermission}
                onChange={onShowPermissionChange}
              />
              <CategoryToggle
                label="Turn completed"
                description="Hooks fired by finished agent turns"
                accent="var(--color-highlight)"
                checked={showDone}
                onChange={onShowDoneChange}
              />
              <CategoryToggle
                label="Running session"
                description="Tasks actively processing a prompt"
                accent="var(--color-info)"
                checked={showRunning}
                onChange={onShowRunningChange}
              />
            </div>
            {note ? (
              <div className="mt-3 text-[11px] italic text-[var(--color-text-muted)]">{note}</div>
            ) : null}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function CategoryToggle({
  label,
  description,
  accent,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  accent: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <div className="flex items-center gap-2.5">
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: accent, boxShadow: `0 0 6px ${accent}` }}
        />
        <div>
          <div className="text-[13px] text-[var(--color-text)]">{label}</div>
          <div className="text-[11px] text-[var(--color-text-muted)]">{description}</div>
        </div>
      </div>
      <ToggleSwitch checked={checked} onChange={onChange} />
    </div>
  );
}

function ToggleSwitch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="relative h-[20px] w-[34px] rounded-full border transition-all"
      style={{
        background: checked ? "color-mix(in srgb, var(--color-highlight) 70%, transparent)" : "var(--color-bg-tertiary)",
        borderColor: checked ? "var(--color-highlight)" : "var(--color-border)",
      }}
    >
      <motion.span
        className="absolute top-[1px] block h-[16px] w-[16px] rounded-full"
        animate={{ left: checked ? 15 : 1, background: checked ? "#ffffff" : "var(--color-text-muted)" }}
        transition={{ type: "spring", stiffness: 500, damping: 30 }}
      />
    </button>
  );
}
