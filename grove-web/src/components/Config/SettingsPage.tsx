import { useState } from "react";
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
  FolderOpen,
  ExternalLink,
  Package,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Download,
  Palette,
  Settings,
  Code,
} from "lucide-react";
import { Input, Button, Toggle } from "../ui";
import { useTheme, themes } from "../../context";

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

// Popular agents for quick select
const popularAgents = [
  { name: "Claude", command: "claude", color: "#d97706" },
  { name: "Cursor", command: "cursor", color: "#3b82f6" },
  { name: "Aider", command: "aider", color: "#8b5cf6" },
  { name: "Custom", command: "", color: "var(--color-text-muted)" },
];

// Layout presets
const layoutPresets = [
  { id: "single", name: "Single", description: "Shell only", panes: ["Shell"] },
  { id: "agent", name: "Agent", description: "Agent only", panes: ["Agent"] },
  { id: "agent-shell", name: "Agent + Shell", description: "60% + 40%", panes: ["Agent", "Shell"] },
  { id: "agent-grove-shell", name: "3 Panes", description: "Three panes", panes: ["Agent", "Grove", "Shell"] },
  { id: "grove-agent", name: "Grove + Agent", description: "40% + 60%", panes: ["Grove", "Agent"] },
];

// Notification levels
const notificationLevels = [
  { level: "notice", icon: Info, color: "var(--color-info)", title: "Notice" },
  { level: "warn", icon: AlertTriangle, color: "var(--color-warning)", title: "Warning" },
  { level: "critical", icon: AlertCircle, color: "var(--color-error)", title: "Critical" },
];

// Dependencies configuration
interface Dependency {
  id: string;
  name: string;
  description: string;
  required: boolean;
  checkCommand: string;
  installUrl: string;
  installCommand?: string;
  docsUrl?: string;
}

const dependencies: Dependency[] = [
  {
    id: "git",
    name: "Git",
    description: "Version control system",
    required: true,
    checkCommand: "git --version",
    installUrl: "https://git-scm.com/downloads",
    installCommand: "brew install git",
    docsUrl: "https://git-scm.com/doc",
  },
  {
    id: "tmux",
    name: "tmux",
    description: "Terminal multiplexer for session management",
    required: true,
    checkCommand: "tmux -V",
    installUrl: "https://github.com/tmux/tmux/wiki/Installing",
    installCommand: "brew install tmux",
    docsUrl: "https://github.com/tmux/tmux/wiki",
  },
  {
    id: "grove",
    name: "Grove CLI",
    description: "Grove command-line interface",
    required: true,
    checkCommand: "grove --version",
    installUrl: "https://github.com/anthropics/grove",
    installCommand: "cargo install grove",
    docsUrl: "https://github.com/anthropics/grove#readme",
  },
  {
    id: "claude",
    name: "Claude Code",
    description: "AI coding assistant (optional)",
    required: false,
    checkCommand: "claude --version",
    installUrl: "https://claude.ai/download",
    docsUrl: "https://docs.anthropic.com/claude-code",
  },
];

// Mock dependency status (will be replaced with real checks)
type DependencyStatus = "checking" | "installed" | "not_installed" | "error";

interface DependencyState {
  status: DependencyStatus;
  version?: string;
  error?: string;
}

// Initial mock states - simulating different scenarios
const initialDependencyStates: Record<string, DependencyState> = {
  git: { status: "installed", version: "2.43.0" },
  tmux: { status: "installed", version: "3.4" },
  grove: { status: "installed", version: "0.3.1" },
  claude: { status: "not_installed" },
};

// IDE options - brand colors are intentionally hardcoded
const ideOptions = [
  { id: "code", name: "VS Code", command: "code", color: "#007ACC" },
  { id: "cursor", name: "Cursor", command: "cursor", color: "#7c3aed" },
  { id: "rustrover", name: "RustRover", command: "rustrover", color: "#FF6B00" },
  { id: "custom", name: "Custom", command: "", color: "var(--color-text-muted)" },
];

// Terminal options - brand colors are intentionally hardcoded
const terminalOptions = [
  { id: "system", name: "System", command: "", color: "var(--color-text-muted)" },
  { id: "iterm", name: "iTerm", command: "iterm", color: "#4caf50" },
  { id: "warp", name: "Warp", command: "warp", color: "#01A4FF" },
  { id: "kitty", name: "Kitty", command: "kitty", color: "#8B5CF6" },
  { id: "custom", name: "Custom", command: "", color: "var(--color-text-muted)" },
];

export function SettingsPage({ config }: SettingsPageProps) {
  const { theme, setTheme } = useTheme();

  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    appearance: true,
    environment: false,
    agent: false,
    layout: false,
    hooks: false,
    mcp: false,
  });

  // Environment state
  const [depStates, setDepStates] = useState<Record<string, DependencyState>>(initialDependencyStates);
  const [isChecking, setIsChecking] = useState(false);

  // Agent state
  const [agentCommand, setAgentCommand] = useState(config.agent.command);

  // Layout state
  const [selectedLayout, setSelectedLayout] = useState(config.layout.default);

  // Hooks state
  const [hooksEnabled, setHooksEnabled] = useState(config.hooks.enabled);
  const [scriptPath, setScriptPath] = useState(config.hooks.scriptPath);

  // MCP state
  const [copiedField, setCopiedField] = useState<string | null>(null);

  // IDE & Terminal state
  const [selectedIde, setSelectedIde] = useState("code");
  const [customIdeCommand, setCustomIdeCommand] = useState("");
  const [selectedTerminal, setSelectedTerminal] = useState("system");
  const [customTerminalCommand, setCustomTerminalCommand] = useState("");

  const toggleSection = (id: string) => {
    setOpenSections((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const handleCopy = (field: string, value: string) => {
    navigator.clipboard.writeText(value);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  };

  // Simulate dependency check (will be replaced with real API calls)
  const checkDependencies = () => {
    setIsChecking(true);
    // Simulate checking animation
    setDepStates((prev) => {
      const newStates: Record<string, DependencyState> = {};
      for (const id of Object.keys(prev)) {
        newStates[id] = { status: "checking" };
      }
      return newStates;
    });

    // Simulate async check completion
    setTimeout(() => {
      setDepStates(initialDependencyStates);
      setIsChecking(false);
    }, 1500);
  };

  const getStatusIcon = (status: DependencyStatus) => {
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

  const getStatusText = (dep: Dependency, state: DependencyState) => {
    switch (state.status) {
      case "checking":
        return "Checking...";
      case "installed":
        return state.version ? `v${state.version}` : "Installed";
      case "not_installed":
        return dep.required ? "Not installed" : "Not installed (optional)";
      case "error":
        return state.error || "Error";
    }
  };

  const requiredCount = dependencies.filter(d => d.required).length;
  const requiredInstalled = dependencies.filter(d => d.required && depStates[d.id]?.status === "installed").length;

  const claudeDesktopConfig = JSON.stringify(
    {
      mcpServers: {
        grove: {
          command: config.mcp.command,
          args: config.mcp.args,
        },
      },
    },
    null,
    2
  );

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
              {themes.map((t) => (
                <motion.button
                  key={t.id}
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={() => setTheme(t.id)}
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
                    <div className="w-3 h-3 rounded-full" style={{ backgroundColor: t.colors.highlight }} />
                    <div className="w-3 h-3 rounded-full" style={{ backgroundColor: t.colors.accent }} />
                    <div className="w-3 h-3 rounded-full" style={{ backgroundColor: t.colors.info }} />
                  </div>
                  <div className="text-xs font-medium text-[var(--color-text)]">{t.name}</div>
                </motion.button>
              ))}
            </div>
          </div>
        </Section>

        {/* Environment Section */}
        <Section
          id="environment"
          title="Environment"
          description={`${requiredInstalled}/${requiredCount} required dependencies installed`}
          icon={Package}
          iconColor="var(--color-accent)"
          isOpen={openSections.environment}
          onToggle={() => toggleSection("environment")}
        >
          <div className="space-y-4">
            {/* Status Summary */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {requiredInstalled === requiredCount ? (
                  <>
                    <CheckCircle2 className="w-5 h-5 text-[var(--color-success)]" />
                    <span className="text-sm text-[var(--color-success)]">All required dependencies installed</span>
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

            {/* Dependencies List */}
            <div className="space-y-2">
              {dependencies.map((dep) => {
                const state = depStates[dep.id] || { status: "checking" as DependencyStatus };
                const isInstalled = state.status === "installed";

                return (
                  <motion.div
                    key={dep.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className={`flex items-center justify-between p-4 rounded-lg border transition-all
                      ${isInstalled
                        ? "bg-[var(--color-bg-secondary)] border-[var(--color-border)]"
                        : "bg-[var(--color-warning)]/5 border-[var(--color-warning)]/20"
                      }`}
                  >
                    <div className="flex items-center gap-4">
                      {getStatusIcon(state.status)}
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-[var(--color-text)]">{dep.name}</span>
                          {!dep.required && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-border)] text-[var(--color-text-muted)]">
                              Optional
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-[var(--color-text-muted)]">{dep.description}</div>
                      </div>
                    </div>

                    <div className="flex items-center gap-3">
                      <span className={`text-xs ${isInstalled ? "text-[var(--color-success)]" : "text-[var(--color-warning)]"}`}>
                        {getStatusText(dep, state)}
                      </span>

                      {!isInstalled && state.status !== "checking" && (
                        <div className="flex items-center gap-2">
                          {dep.installCommand && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleCopy(`install-${dep.id}`, dep.installCommand!)}
                            >
                              {copiedField === `install-${dep.id}` ? (
                                <Check className="w-4 h-4 text-[var(--color-success)]" />
                              ) : (
                                <Copy className="w-4 h-4" />
                              )}
                            </Button>
                          )}
                          <a
                            href={dep.installUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-[var(--color-highlight)] hover:opacity-90 text-white transition-opacity"
                          >
                            <Download className="w-3.5 h-3.5" />
                            Install
                          </a>
                        </div>
                      )}

                      {isInstalled && dep.docsUrl && (
                        <a
                          href={dep.docsUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
                        >
                          <ExternalLink className="w-4 h-4" />
                        </a>
                      )}
                    </div>
                  </motion.div>
                );
              })}
            </div>

            {/* Install Commands Reference */}
            <div className="p-4 bg-[var(--color-bg-secondary)] rounded-lg border border-[var(--color-border)]">
              <div className="text-sm font-medium text-[var(--color-text-muted)] mb-3">Quick Install (macOS)</div>
              <div className="space-y-2 font-mono text-xs">
                <div className="flex items-center justify-between p-2 bg-[var(--color-bg)] rounded">
                  <code className="text-[var(--color-text-muted)]">
                    <span className="opacity-50">$</span> brew install git tmux
                  </code>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleCopy("brew-deps", "brew install git tmux")}
                  >
                    {copiedField === "brew-deps" ? (
                      <Check className="w-3.5 h-3.5 text-[var(--color-success)]" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                  </Button>
                </div>
                <div className="flex items-center justify-between p-2 bg-[var(--color-bg)] rounded">
                  <code className="text-[var(--color-text-muted)]">
                    <span className="opacity-50">$</span> cargo install grove
                  </code>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleCopy("cargo-grove", "cargo install grove")}
                  >
                    {copiedField === "cargo-grove" ? (
                      <Check className="w-3.5 h-3.5 text-[var(--color-success)]" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                  </Button>
                </div>
              </div>
            </div>

            {/* Default IDE */}
            <div className="p-4 bg-[var(--color-bg-secondary)] rounded-lg border border-[var(--color-border)]">
              <div className="flex items-center gap-2 mb-3">
                <Code className="w-4 h-4 text-[var(--color-info)]" />
                <div className="text-sm font-medium text-[var(--color-text-muted)]">Default IDE</div>
              </div>
              <div className="grid grid-cols-4 gap-2 mb-3">
                {ideOptions.map((ide) => (
                  <motion.button
                    key={ide.id}
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    onClick={() => setSelectedIde(ide.id)}
                    className={`p-2 rounded-lg border text-center transition-all
                      ${
                        selectedIde === ide.id
                          ? "border-[var(--color-info)] bg-[var(--color-info)]/10"
                          : "border-[var(--color-border)] hover:border-[var(--color-text-muted)] bg-[var(--color-bg)]"
                      }`}
                  >
                    <div className="text-xs text-[var(--color-text)]">{ide.name}</div>
                  </motion.button>
                ))}
              </div>
              {selectedIde === "custom" && (
                <div className="flex gap-2">
                  <Input
                    value={customIdeCommand}
                    onChange={(e) => setCustomIdeCommand(e.target.value)}
                    placeholder="Enter IDE command (e.g., webstorm)"
                  />
                </div>
              )}
            </div>

            {/* Default Terminal */}
            <div className="p-4 bg-[var(--color-bg-secondary)] rounded-lg border border-[var(--color-border)]">
              <div className="flex items-center gap-2 mb-3">
                <Terminal className="w-4 h-4 text-[var(--color-highlight)]" />
                <div className="text-sm font-medium text-[var(--color-text-muted)]">Default Terminal</div>
              </div>
              <div className="grid grid-cols-5 gap-2 mb-3">
                {terminalOptions.map((term) => (
                  <motion.button
                    key={term.id}
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    onClick={() => setSelectedTerminal(term.id)}
                    className={`p-2 rounded-lg border text-center transition-all
                      ${
                        selectedTerminal === term.id
                          ? "border-[var(--color-highlight)] bg-[var(--color-highlight)]/10"
                          : "border-[var(--color-border)] hover:border-[var(--color-text-muted)] bg-[var(--color-bg)]"
                      }`}
                  >
                    <div className="text-xs text-[var(--color-text)]">{term.name}</div>
                  </motion.button>
                ))}
              </div>
              {selectedTerminal === "custom" && (
                <div className="flex gap-2">
                  <Input
                    value={customTerminalCommand}
                    onChange={(e) => setCustomTerminalCommand(e.target.value)}
                    placeholder="Enter terminal command"
                  />
                </div>
              )}
            </div>
          </div>
        </Section>

        {/* Coding Agent Section */}
        <Section
          id="agent"
          title="Coding Agent"
          description="Configure the AI coding agent for your tasks"
          icon={Terminal}
          iconColor="var(--color-highlight)"
          isOpen={openSections.agent}
          onToggle={() => toggleSection("agent")}
        >
          <div className="space-y-4">
            {/* Quick Select */}
            <div>
              <div className="text-sm font-medium text-[var(--color-text-muted)] mb-3">Quick Select</div>
              <div className="grid grid-cols-4 gap-2">
                {popularAgents.map((agent) => (
                  <motion.button
                    key={agent.name}
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    onClick={() => setAgentCommand(agent.command)}
                    className={`p-3 rounded-lg border text-center transition-all
                      ${
                        agentCommand === agent.command
                          ? "border-[var(--color-highlight)] bg-[var(--color-highlight)]/10"
                          : "border-[var(--color-border)] hover:border-[var(--color-text-muted)] bg-[var(--color-bg-secondary)]"
                      }`}
                  >
                    <Sparkles className="w-4 h-4 mx-auto mb-1" style={{ color: agent.color }} />
                    <div className="text-xs text-[var(--color-text)]">{agent.name}</div>
                  </motion.button>
                ))}
              </div>
            </div>

            {/* Command Input */}
            <div>
              <div className="text-sm font-medium text-[var(--color-text-muted)] mb-2">Command</div>
              <div className="flex gap-2">
                <Input
                  value={agentCommand}
                  onChange={(e) => setAgentCommand(e.target.value)}
                  placeholder="Enter agent command"
                />
                <Button variant="primary">Save</Button>
              </div>
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
            {layoutPresets.map((preset) => (
              <motion.button
                key={preset.id}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => setSelectedLayout(preset.id)}
                className={`relative p-3 rounded-lg border text-left transition-all
                  ${
                    selectedLayout === preset.id
                      ? "border-[var(--color-highlight)] bg-[var(--color-highlight)]/5"
                      : "border-[var(--color-border)] hover:border-[var(--color-text-muted)] bg-[var(--color-bg-secondary)]"
                  }`}
              >
                {selectedLayout === preset.id && (
                  <div className="absolute top-2 right-2 w-4 h-4 rounded-full bg-[var(--color-highlight)] flex items-center justify-center">
                    <Check className="w-2.5 h-2.5 text-white" />
                  </div>
                )}
                {/* Preview */}
                <div className="h-10 mb-2 bg-[var(--color-bg)] rounded border border-[var(--color-border)] p-1 flex gap-0.5">
                  {preset.panes.map((pane, i) => (
                    <div
                      key={i}
                      className={`flex-1 rounded text-[8px] flex items-center justify-center
                        ${pane === "Agent" ? "bg-[var(--color-highlight)]/20 text-[var(--color-highlight)]" : ""}
                        ${pane === "Grove" ? "bg-[var(--color-info)]/20 text-[var(--color-info)]" : ""}
                        ${pane === "Shell" ? "bg-[var(--color-text-muted)]/20 text-[var(--color-text-muted)]" : ""}
                      `}
                    >
                      {pane}
                    </div>
                  ))}
                </div>
                <div className="text-xs font-medium text-[var(--color-text)]">{preset.name}</div>
                <div className="text-[10px] text-[var(--color-text-muted)]">{preset.description}</div>
              </motion.button>
            ))}
          </div>
        </Section>

        {/* Hooks Section */}
        <Section
          id="hooks"
          title="Hooks"
          description="Notification hooks for task events"
          icon={Bell}
          iconColor="var(--color-warning)"
          isOpen={openSections.hooks}
          onToggle={() => toggleSection("hooks")}
        >
          <div className="space-y-4">
            <Toggle
              enabled={hooksEnabled}
              onChange={setHooksEnabled}
              label="Enable Hooks"
              description="Receive notifications from agents"
            />

            <div className={!hooksEnabled ? "opacity-50 pointer-events-none" : ""}>
              <div className="text-sm font-medium text-[var(--color-text-muted)] mb-2">Script Path</div>
              <div className="flex gap-2">
                <Input
                  value={scriptPath}
                  onChange={(e) => setScriptPath(e.target.value)}
                  placeholder="~/.grove/hooks/notify.sh"
                />
                <Button variant="secondary">
                  <FolderOpen className="w-4 h-4" />
                </Button>
              </div>
            </div>

            <div className={!hooksEnabled ? "opacity-50" : ""}>
              <div className="text-sm font-medium text-[var(--color-text-muted)] mb-2">Notification Levels</div>
              <div className="flex gap-2">
                {notificationLevels.map(({ level, icon: Icon, color, title }) => (
                  <div
                    key={level}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)]"
                  >
                    <Icon className="w-4 h-4" style={{ color }} />
                    <span className="text-xs text-[var(--color-text-muted)]">{title}</span>
                  </div>
                ))}
              </div>
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
            {/* Config Info */}
            <div className="grid grid-cols-2 gap-2">
              {[
                { label: "Name", value: config.mcp.name },
                { label: "Type", value: config.mcp.type },
                { label: "Command", value: config.mcp.command },
                { label: "Args", value: JSON.stringify(config.mcp.args) },
              ].map(({ label, value }) => (
                <div
                  key={label}
                  className="flex items-center justify-between p-2 rounded bg-[var(--color-bg-secondary)] border border-[var(--color-border)]"
                >
                  <span className="text-xs text-[var(--color-text-muted)]">{label}</span>
                  <code className="text-xs text-[var(--color-highlight)]">{value}</code>
                </div>
              ))}
            </div>

            {/* Copy Configs */}
            <div className="space-y-3">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-[var(--color-text-muted)]">Claude Desktop</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleCopy("desktop", claudeDesktopConfig)}
                  >
                    {copiedField === "desktop" ? (
                      <Check className="w-4 h-4 text-[var(--color-success)]" />
                    ) : (
                      <Copy className="w-4 h-4" />
                    )}
                  </Button>
                </div>
                <pre className="p-3 bg-[var(--color-bg-secondary)] rounded-lg border border-[var(--color-border)] text-xs text-[var(--color-text-muted)] overflow-x-auto">
                  {claudeDesktopConfig}
                </pre>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-[var(--color-text-muted)]">Claude Code</span>
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
              </div>
            </div>

            {/* Docs Link */}
            <div className="flex items-center gap-3 p-3 rounded-lg bg-[var(--color-info)]/5 border border-[var(--color-info)]/20">
              <ExternalLink className="w-4 h-4 text-[var(--color-info)]" />
              <span className="text-sm text-[var(--color-text-muted)]">Learn more about MCP integration</span>
            </div>
          </div>
        </Section>
      </div>
    </motion.div>
  );
}
