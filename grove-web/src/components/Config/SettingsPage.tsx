import React, { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Terminal,
  LayoutGrid,
  Bell,
  Plug,
  ChevronDown,
  Sparkles,
  Check,
  Copy,
  AlertCircle,
  AlertTriangle,
  Info,
  ExternalLink,
  Package,
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
} from "lucide-react";
import { Button, Combobox, AppPicker, AgentPicker, ideAppOptions, terminalAppOptions } from "../ui";
import type { ComboboxOption } from "../ui";
import { useTheme, themes, useTerminalTheme, terminalThemes } from "../../context";
import {
  getConfig,
  patchConfig,
  checkAllDependencies,
  listApplications,
  type AppInfo,
} from "../../api";
import { LayoutEditor, type CustomLayoutConfig, type PaneType, type LayoutNode, createDefaultLayout, countPanes } from "./LayoutEditor";

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
        className="w-full flex items-center gap-4 p-4 bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
      >
        <div
          className="w-9 h-9 rounded-lg flex items-center justify-center"
          style={{ backgroundColor: `${iconColor}15` }}
        >
          <Icon className="w-4 h-4" style={{ color: iconColor }} />
        </div>
        <div className="flex-1 text-left">
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
  { id: "single", name: "Single", description: "Shell only", panes: ["Shell"] },
  { id: "agent", name: "Agent", description: "Agent only", panes: ["Agent"] },
  { id: "agent-shell", name: "Agent + Shell", description: "60% + 40%", panes: ["Agent", "Shell"] },
  { id: "agent-grove-shell", name: "3 Panes", description: "Left + Right split", panes: ["Agent", "Grove", "Shell"], layout: "left-right-split" },
  { id: "grove-agent", name: "Grove + Agent", description: "40% + 60%", panes: ["Grove", "Agent"] },
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
  // Legacy string panes
  Agent: { bg: "var(--color-highlight)", text: "var(--color-highlight)" },
  Grove: { bg: "var(--color-info)", text: "var(--color-info)" },
  Shell: { bg: "var(--color-text-muted)", text: "var(--color-text-muted)" },
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
};

type DependencyStatusType = "checking" | "installed" | "not_installed" | "error";

interface DependencyState {
  status: DependencyStatusType;
  version?: string;
  installCommand: string;
}

export function SettingsPage({ config }: SettingsPageProps) {
  const { theme, setTheme } = useTheme();
  const { terminalTheme, setTerminalTheme } = useTerminalTheme();

  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    appearance: true,
    environment: false,
    devtools: false,
    layout: false,
    hooks: false,
    mcp: false,
    autolink: false,
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

  // Multiplexer state
  const [multiplexer, setMultiplexer] = useState("tmux");

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
  const [autoLinkEnabled, setAutoLinkEnabled] = useState(true);
  const [autoLinkPatterns, setAutoLinkPatterns] = useState<string[]>([]);
  const [autoLinkCheckGitignore, setAutoLinkCheckGitignore] = useState(true);

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
      setMultiplexer(cfg.multiplexer || "tmux");

      // Load theme - sync with context
      // API stores theme id (e.g., "dark", "tokyo-night")
      if (cfg.theme.name && cfg.theme.name.toLowerCase() !== "auto") {
        // Try to match by id (lowercase, with dash)
        const themeId = cfg.theme.name.toLowerCase().replace(/\s+/g, "-");
        setTheme(themeId);
      }

      // Load terminal theme - sync with context
      if (cfg.web.terminal_theme) {
        setTerminalTheme(cfg.web.terminal_theme);
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
          console.log("Failed to parse custom layouts");
        }
      } else {
        // No existing custom layouts, mark as loaded so we can save new ones
        setCustomLayoutsLoaded(true);
      }

      // Load AutoLink config
      setAutoLinkEnabled(cfg.auto_link.enabled);
      setAutoLinkPatterns(cfg.auto_link.patterns);
      setAutoLinkCheckGitignore(cfg.auto_link.check_gitignore);

      setIsLoaded(true);
    } catch {
      // API not available, use props config
      console.log("Config API not available, using local config");
      setIsLoaded(true);
    }
  }, [config.agent.command, setTheme, setTerminalTheme]);

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

  // Save config to API (called automatically)
  // Note: themeId parameter allows immediate save with new theme value
  const saveConfig = useCallback(async (overrideThemeId?: string) => {
    if (!isLoaded) return; // Don't save during initial load

    try {
      await patchConfig({
        theme: {
          name: overrideThemeId || theme.id,
        },
        layout: {
          default: selectedLayout,
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
        },
        multiplexer,
        auto_link: {
          enabled: autoLinkEnabled,
          patterns: autoLinkPatterns,
          check_gitignore: autoLinkCheckGitignore,
        },
      });
    } catch {
      console.error("Failed to save config");
    }
  }, [isLoaded, theme.id, selectedLayout, agentCommand, customLayouts, selectedCustomLayoutId, customLayoutsLoaded, ideCommand, terminalCommand, multiplexer, autoLinkEnabled, autoLinkPatterns, autoLinkCheckGitignore]);

  // Handle theme change with immediate save
  const handleThemeChange = useCallback((newThemeId: string) => {
    setTheme(newThemeId);
    // Save immediately with the new theme ID to avoid stale closure issues
    if (isLoaded) {
      patchConfig({
        theme: { name: newThemeId },
      }).catch(() => console.error("Failed to save theme"));
    }
  }, [setTheme, isLoaded]);

  // Auto-save when any config value changes (debounced)
  useEffect(() => {
    if (!isLoaded) return;

    const timer = setTimeout(() => {
      saveConfig();
    }, 500); // 500ms debounce

    return () => clearTimeout(timer);
  }, [theme.id, selectedLayout, agentCommand, customLayouts, selectedCustomLayoutId, customLayoutsLoaded, ideCommand, terminalCommand, multiplexer, autoLinkEnabled, autoLinkPatterns, autoLinkCheckGitignore, isLoaded, saveConfig]);

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
  }, [loadConfig, checkDependencies, loadApplications]);

  const getStatusIcon = (status: DependencyStatusType) => {
    switch (status) {
      case "checking":
        return <RefreshCw className="w-4 h-4 text-[var(--color-text-muted)] animate-spin" />;
      case "installed":
        return <CheckCircle2 className="w-4 h-4 text-[var(--color-success)]" />;
      case "not_installed":
        return <XCircle className="w-4 h-4 text-[var(--color-warning)]" />;
      case "error":
        return <AlertCircle className="w-4 h-4 text-[var(--color-error)]" />;
    }
  };

  const depKeys = Object.keys(depStates);
  const installedCount = depKeys.filter((k) => depStates[k]?.status === "installed").length;

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
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-xl bg-[var(--color-highlight)]/10 flex items-center justify-center">
          <Settings className="w-5 h-5 text-[var(--color-highlight)]" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-text)]">Settings</h1>
          <p className="text-xs text-[var(--color-text-muted)]">Configure Grove to match your workflow</p>
        </div>
      </div>

      <div className="space-y-3">
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
            <div className="text-sm font-medium text-[var(--color-text-muted)] mb-2">Select Theme</div>
            <div className="grid grid-cols-4 gap-2">
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

          {/* Terminal Color Scheme */}
          <div className="space-y-3 mt-6 pt-6 border-t border-[var(--color-border)]">
            <div className="text-sm font-medium text-[var(--color-text-muted)] mb-2">Terminal Color Scheme</div>
            <div className="grid grid-cols-5 gap-2">
              {terminalThemes.map((tt) => {
                const isSelected = terminalTheme.id === tt.id;
                const previewColors = [tt.colors.red, tt.colors.green, tt.colors.yellow, tt.colors.blue, tt.colors.magenta, tt.colors.cyan];

                return (
                  <motion.button
                    key={tt.id}
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    onClick={() => setTerminalTheme(tt.id)}
                    className={`relative p-3 rounded-lg border text-center transition-all
                      ${isSelected
                        ? "border-[var(--color-highlight)] bg-[var(--color-highlight)]/10"
                        : "border-[var(--color-border)] hover:border-[var(--color-text-muted)] bg-[var(--color-bg-secondary)]"
                      }`}
                  >
                    {isSelected && (
                      <div className="absolute top-1.5 right-1.5 w-4 h-4 rounded-full bg-[var(--color-highlight)] flex items-center justify-center">
                        <Check className="w-2.5 h-2.5 text-white" />
                      </div>
                    )}
                    {/* Mini color bar preview */}
                    <div
                      className="flex gap-0 mb-2 rounded overflow-hidden h-4"
                      style={{ backgroundColor: tt.colors.background }}
                    >
                      {previewColors.map((color, i) => (
                        <div
                          key={i}
                          className="flex-1 h-full"
                          style={{ backgroundColor: color }}
                        />
                      ))}
                    </div>
                    <div className="text-[11px] font-medium text-[var(--color-text)] truncate">{tt.name}</div>
                  </motion.button>
                );
              })}
            </div>
          </div>
        </Section>

        {/* Environment Section */}
        <Section
          id="environment"
          title="Environment"
          description={`${installedCount}/${depKeys.length || 4} dependencies installed`}
          icon={Package}
          iconColor="var(--color-accent)"
          isOpen={openSections.environment}
          onToggle={() => toggleSection("environment")}
        >
          <div className="space-y-4">
            {/* Status Summary */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {installedCount === (depKeys.length || 4) ? (
                  <>
                    <CheckCircle2 className="w-5 h-5 text-[var(--color-success)]" />
                    <span className="text-sm text-[var(--color-success)]">All dependencies installed</span>
                  </>
                ) : (
                  <>
                    <AlertTriangle className="w-5 h-5 text-[var(--color-warning)]" />
                    <span className="text-sm text-[var(--color-warning)]">Some dependencies are missing</span>
                  </>
                )}
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={checkDependencies}
                disabled={isChecking}
              >
                <RefreshCw className={`w-4 h-4 mr-2 ${isChecking ? "animate-spin" : ""}`} />
                {isChecking ? "Checking..." : "Refresh"}
              </Button>
            </div>

            {/* Dependency row renderer */}
            {(() => {
              const allDeps = depKeys.length > 0 ? depKeys : ["git", "tmux", "zellij", "fzf"];
              const baseDeps = allDeps.filter((d) => d !== "tmux" && d !== "zellij");
              const muxDeps = allDeps.filter((d) => d === "tmux" || d === "zellij");

              const renderDepRow = (depName: string) => {
                const state = depStates[depName] || { status: "checking" as DependencyStatusType, installCommand: "" };
                const info = dependencyInfo[depName] || { name: depName, description: "" };
                const isInstalled = state.status === "installed";
                const isMux = depName === "tmux" || depName === "zellij";
                // 只有在已安装时才显示为 Active
                const isMuxActive = isMux && multiplexer === depName && isInstalled;
                const canSwitchMux = isMux && isInstalled && !isMuxActive;

                return (
                  <motion.div
                    key={depName}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    whileHover={canSwitchMux ? { scale: 1.01 } : {}}
                    whileTap={canSwitchMux ? { scale: 0.98 } : {}}
                    onClick={() => { if (canSwitchMux) setMultiplexer(depName); }}
                    className={`flex items-center justify-between p-3 rounded-lg border transition-all duration-200
                      ${canSwitchMux ? "cursor-pointer hover:border-[var(--color-highlight)]/50" : ""}
                      ${isMuxActive
                        ? "border-[var(--color-highlight)] bg-[var(--color-highlight)]/5"
                        : isInstalled
                          ? "bg-[var(--color-bg-secondary)] border-[var(--color-border)]"
                          : "bg-[var(--color-warning)]/5 border-[var(--color-warning)]/20"
                      }`}
                  >
                    <div className="flex items-center gap-3">
                      {getStatusIcon(state.status)}
                      <div>
                        <div className="font-medium text-sm text-[var(--color-text)]">
                          {info.name}
                          {isMuxActive && (
                            <motion.span
                              initial={{ opacity: 0, scale: 0.8 }}
                              animate={{ opacity: 1, scale: 1 }}
                              className="ml-2 text-xs font-normal text-[var(--color-highlight)]"
                            >Active</motion.span>
                          )}
                        </div>
                        <div className="text-xs text-[var(--color-text-muted)]">{info.description}</div>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      {canSwitchMux && (
                        <span className="text-xs text-[var(--color-text-muted)]">Use</span>
                      )}

                      {isInstalled && state.version && (
                        <span className="text-xs text-[var(--color-success)]">v{state.version}</span>
                      )}

                      {!isInstalled && state.status !== "checking" && state.installCommand && (
                        <div title={`Copy: ${state.installCommand}`} onClick={(e) => e.stopPropagation()}>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleCopy(`install-${depName}`, state.installCommand)}
                          >
                            {copiedField === `install-${depName}` ? (
                              <Check className="w-4 h-4 text-[var(--color-success)]" />
                            ) : (
                              <Copy className="w-4 h-4" />
                            )}
                          </Button>
                        </div>
                      )}

                      {isInstalled && info.docsUrl && (
                        <a
                          href={info.docsUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
                        >
                          <ExternalLink className="w-4 h-4" />
                        </a>
                      )}
                    </div>
                  </motion.div>
                );
              };

              return (
                <>
                  {/* Base Dependencies */}
                  <div className="space-y-2">
                    {baseDeps.map(renderDepRow)}
                  </div>

                  {/* Multiplexer Divider + Section */}
                  <div className="flex items-center gap-3 mt-4 mb-2">
                    <div className="flex-1 h-px bg-[var(--color-border)]" />
                    <span className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider">Multiplexer</span>
                    <div className="flex-1 h-px bg-[var(--color-border)]" />
                  </div>
                  <div className="space-y-2">
                    {muxDeps.map(renderDepRow)}
                  </div>
                </>
              );
            })()}
          </div>
        </Section>

        {/* Development Tools Section (NEW - merged Agent + IDE + Terminal) */}
        <Section
          id="devtools"
          title="Development Tools"
          description="Configure your coding agent, IDE, and terminal"
          icon={Wrench}
          iconColor="var(--color-highlight)"
          isOpen={openSections.devtools}
          onToggle={() => toggleSection("devtools")}
        >
          <div className="space-y-6">
            {/* Coding Agent */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Sparkles className="w-4 h-4 text-[var(--color-warning)]" />
                <span className="text-sm font-medium text-[var(--color-text)]">Coding Agent</span>
              </div>
              <AgentPicker
                value={agentCommand}
                onChange={setAgentCommand}
                placeholder="Select agent..."
                customPlaceholder="Enter agent command (e.g., claude --yolo)"
              />
            </div>

            {/* Default IDE */}
            <div>
              <div className="flex items-center gap-2 mb-3">
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
              <div className="flex items-center gap-2 mb-3">
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

        {/* Task Layout Section */}
        <Section
          id="layout"
          title="Task Layout"
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
                        {preset.panes[0]}
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
                            {pane}
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
                          {pane}
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
                  <div className="text-[10px] text-[var(--color-text-muted)]">
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
              <div className="text-sm font-medium text-[var(--color-text-muted)] mb-2">Level</div>
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
                <div className="text-sm font-medium text-[var(--color-text-muted)] mb-2">Banner</div>
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
                <div className="text-sm font-medium text-[var(--color-text-muted)] mb-2">Sound</div>
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
              <div className="text-sm font-medium text-[var(--color-text-muted)] mb-2">Message</div>
              <input
                type="text"
                value={hookMessage}
                onChange={(e) => setHookMessage(e.target.value)}
                placeholder="e.g., Task completed..."
                className="w-full px-3 py-2 text-sm bg-[var(--color-bg-secondary)] text-[var(--color-text)] border border-[var(--color-border)] rounded-lg focus:outline-none focus:ring-1 focus:ring-[var(--color-highlight)] placeholder:text-[var(--color-text-muted)]"
              />
              <p className="text-xs text-[var(--color-text-muted)] mt-1">
                Optional message included with the notification.
              </p>
            </div>

            {/* Generated Command */}
            <div>
              <div className="text-sm font-medium text-[var(--color-text-muted)] mb-2">Generated Command</div>
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
              <p className="text-xs text-[var(--color-text-muted)] mt-2">
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
                  <div className="text-xs text-[var(--color-text-muted)] mb-1">Name</div>
                  <code className="text-sm font-semibold text-[var(--color-highlight)]">{config.mcp.name}</code>
                </div>
                <div>
                  <div className="text-xs text-[var(--color-text-muted)] mb-1">Type</div>
                  <code className="text-sm font-semibold text-[var(--color-text)]">{config.mcp.type}</code>
                </div>
                <div>
                  <div className="text-xs text-[var(--color-text-muted)] mb-1">Command</div>
                  <code className="text-sm font-semibold text-[var(--color-text)]">{config.mcp.command}</code>
                </div>
                <div>
                  <div className="text-xs text-[var(--color-text-muted)] mb-1">Args</div>
                  <code className="text-sm font-semibold text-[var(--color-text)]">{config.mcp.args.join(" ")}</code>
                </div>
              </div>
            </div>

            {/* Claude Code Config */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-[var(--color-text)]">Claude Code Configuration</span>
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
              <p className="text-xs text-[var(--color-text-muted)] mt-2">
                Add to your <code className="text-[var(--color-highlight)]">~/.claude.json</code> file.
              </p>
            </div>

            {/* CodeX Config */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-[var(--color-text)]">CodeX Configuration</span>
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
              <p className="text-xs text-[var(--color-text-muted)] mt-2">
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
              <span className="text-sm text-[var(--color-text)]">Learn more about MCP protocol</span>
            </a>
          </div>
        </Section>

        {/* AutoLink Section */}
        <Section
          id="autolink"
          title="AutoLink"
          description={autoLinkEnabled ? `Enabled (${autoLinkPatterns.length} patterns)` : "Disabled"}
          icon={Link}
          iconColor="var(--color-purple)"
          isOpen={openSections.autolink}
          onToggle={() => toggleSection("autolink")}
        >
          <div className="space-y-6">
            {/* 功能说明 */}
            <div className="p-3 bg-[var(--color-bg-secondary)] rounded-lg">
              <p className="text-xs text-[var(--color-text-muted)]">
                Automatically create symlinks in new worktrees for files/folders from the main repo.
                This saves disk space and avoids rebuilding node_modules, IDE configs, etc.
              </p>
            </div>

            {/* 启用开关 */}
            <div className="flex items-center justify-between">
              <div>
                <h4 className="text-sm font-medium text-[var(--color-text)]">Enable AutoLink</h4>
                <p className="text-xs text-[var(--color-text-muted)] mt-1">
                  Create symlinks when creating new worktrees
                </p>
              </div>
              <button
                onClick={() => setAutoLinkEnabled(!autoLinkEnabled)}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                  autoLinkEnabled ? "bg-[var(--color-accent)]" : "bg-[var(--color-border)]"
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    autoLinkEnabled ? "translate-x-6" : "translate-x-1"
                  }`}
                />
              </button>
            </div>

            {autoLinkEnabled && (
              <>
                {/* Check gitignore 开关 */}
                <div className="flex items-center justify-between pt-4 border-t border-[var(--color-border)]">
                  <div>
                    <h4 className="text-sm font-medium text-[var(--color-text)]">Check Git Ignore</h4>
                    <p className="text-xs text-[var(--color-text-muted)] mt-1">
                      Only link paths that are gitignored (recommended to avoid conflicts)
                    </p>
                  </div>
                  <button
                    onClick={() => setAutoLinkCheckGitignore(!autoLinkCheckGitignore)}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                      autoLinkCheckGitignore ? "bg-[var(--color-accent)]" : "bg-[var(--color-border)]"
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                        autoLinkCheckGitignore ? "translate-x-6" : "translate-x-1"
                      }`}
                    />
                  </button>
                </div>

                {/* Glob 模式列表 */}
                <div className="pt-4 border-t border-[var(--color-border)]">
                  <div className="flex items-center justify-between mb-3">
                    <div>
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
                      <div className="text-center py-4 text-sm text-[var(--color-text-muted)]">
                        No patterns configured. Click "Add" to create one.
                      </div>
                    )}
                  </div>

                  {/* 预设模板 */}
                  <div className="p-3 bg-[var(--color-bg-secondary)] rounded-lg">
                    <h5 className="text-xs font-medium text-[var(--color-text)] mb-2">
                      Quick Add Presets
                    </h5>
                    <div className="flex flex-wrap gap-2">
                      {[
                        { label: "node_modules", pattern: "node_modules" },
                        { label: "**/node_modules", pattern: "**/node_modules" },
                        { label: ".vscode", pattern: ".vscode" },
                        { label: ".idea", pattern: ".idea" },
                        { label: "target", pattern: "target" },
                        { label: "dist", pattern: "dist" },
                        { label: ".next", pattern: ".next" },
                        { label: "packages/*/dist", pattern: "packages/*/dist" },
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
                  <div className="mt-4 p-3 bg-[var(--color-bg-secondary)] rounded-lg">
                    <h5 className="text-xs font-medium text-[var(--color-text)] mb-2">Glob Syntax</h5>
                    <ul className="text-xs text-[var(--color-text-muted)] space-y-1">
                      <li>• <code className="font-mono">*</code> matches any characters (except /)</li>
                      <li>• <code className="font-mono">**</code> matches any path segment</li>
                      <li>• <code className="font-mono">?</code> matches single character</li>
                      <li>• Examples: <code className="font-mono">node_modules</code>, <code className="font-mono">**/dist</code>, <code className="font-mono">packages/*/build</code></li>
                    </ul>
                  </div>
                </div>
              </>
            )}
          </div>
        </Section>
      </div>
    </motion.div>
  );
}
