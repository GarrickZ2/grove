import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useConfig } from "../../context";
import { useAgentCatalogRevision } from "../../hooks/useAgentCatalogRevision";
import {
  getConfig,
  patchConfig,
  checkAllDependencies,
  listApplications,
  listCustomAgents,
  type AppInfo,
  type CustomAgentServer,
  type CustomAgentPersona,
} from "../../api";
import { listMarketplace, type MarketplaceAgent } from "../../api/marketplace";
import { getExtensionStatusDetails, type ExtensionStatus } from "../../api/extension";
import type { BaseAgent } from "../Tasks/TaskView/useACPAvailability";
import { agentOptions } from "../ui";
import { type CustomLayoutConfig, createDefaultLayout } from "./LayoutEditor";
import {
  setCustomAgentPersonas as setCustomAgentPersonasIconRegistry,
  loadCustomAgentPersonas as loadCustomAgentPersonasIcon,
  setMarketplaceIcons,
} from "../../utils/agentIcon";
import { formatShortcut } from "../AI/utils";
import { loadChatHistoryPreferences, saveChatHistoryPreferences } from "../Tasks/TaskView/chatHistoryPreferences";
import { isIosClient } from "../../utils/platform";

// Keep the last successful snapshot across Settings navigation. Every mount
// still refreshes it; background refreshes must not unmount an open picker.
let lastAgentSnapshot: {
  baseAgents: BaseAgent[];
  customAgents: CustomAgentServer[];
} | undefined;

// Default custom layouts - create once and reuse
const defaultCustomLayouts: CustomLayoutConfig[] = [createDefaultLayout()];

type DependencyStatusType = "checking" | "installed" | "not_installed" | "error";

export interface DependencyState {
  status: DependencyStatusType;
  version?: string;
  installCommand: string;
}

/**
 * Settings state shared by the Workbench and Orbit settings UIs: loads the
 * server config, mirrors it into local state, and auto-saves every change
 * (debounced) back through `patchConfig`. Presentation-only state (open
 * sections, dialogs, popover anchors) stays with each UI.
 */
export function useSettingsState() {
  const catalogRevision = useAgentCatalogRevision();
  const { config: currentGlobalConfig, updateAvailability, refresh: refreshGlobalConfig } = useConfig();

  // Environment state
  const [depStates, setDepStates] = useState<Record<string, DependencyState>>({});
  const [isChecking, setIsChecking] = useState(false);

  // Config state (from API)
  const [isLoaded, setIsLoaded] = useState(false); // Prevent auto-save during initial load
  // Bumps after each save that changed something, so UIs can confirm it.
  const [savedCount, setSavedCount] = useState(0);
  const lastSavedPatchRef = useRef<string | null>(null);
  const lastSavedPrefsRef = useRef<string | null>(null);

  // Local state for Development Tools
  const [ideCommand, setIdeCommand] = useState("");
  const [terminalCommand, setTerminalCommand] = useState("");
  const [applications, setApplications] = useState<AppInfo[]>([]);
  const [isLoadingApps, setIsLoadingApps] = useState(false);
  // null = unknown until listApplications() resolves — prevents the IDE/Terminal
  // pickers from briefly rendering on Windows/Linux during initial load.
  const [serverPlatform, setServerPlatform] = useState<string | null>(null);

  // ACP / Custom agents state
  const [acpAgent, setAcpAgent] = useState(""); // Chat mode agent — populated from config.acp.agent_command after load
  const [customAgents, setCustomAgents] = useState<CustomAgentServer[]>(() => lastAgentSnapshot?.customAgents ?? []);
  const [customAgentPersonas, setCustomAgentPersonas] = useState<CustomAgentPersona[]>([]);
  const [customAgentPersonasLoading, setCustomAgentPersonasLoading] = useState(false);
  const [baseAgents, setBaseAgents] = useState<BaseAgent[]>(() => lastAgentSnapshot?.baseAgents ?? []);
  const [baseAgentsLoading, setBaseAgentsLoading] = useState(() => !lastAgentSnapshot);
  const [chatRenderWindowLimit, setChatRenderWindowLimit] = useState(0);
  const [chatRenderWindowTrigger, setChatRenderWindowTrigger] = useState(1500);
  const [chatRenderWindowLimitDraft, setChatRenderWindowLimitDraft] = useState("0");
  const [chatRenderWindowTriggerDraft, setChatRenderWindowTriggerDraft] = useState("1500");
  const [chatHistoryRecentTurns, setChatHistoryRecentTurns] = useState(0);
  const [chatHistoryRecentTurnsDraft, setChatHistoryRecentTurnsDraft] = useState("0");
  const [recentSessions, setRecentSessions] = useState(30);
  const [recentSessionsDraft, setRecentSessionsDraft] = useState("30");
  const [chatHistoryIncludeMedia, setChatHistoryIncludeMedia] = useState(true);
  const [chatHistoryIncludeToolDetails, setChatHistoryIncludeToolDetails] = useState(true);
  // Agent command availability: command name → exists on PATH
  const [commandAvailability, setCommandAvailability] = useState<Record<string, boolean>>((): Record<string, boolean> => lastAgentSnapshot ? { __marketplace_loaded__: true } : {});

  // Mode state
  const [terminalMultiplexer, setTerminalMultiplexer] = useState("tmux");
  // Web terminal backend: "multiplexer" (default) | "direct"
  const [webTerminalMode, setWebTerminalMode] = useState("multiplexer");
  const [workspaceLayout, setWorkspaceLayout] = useState<"flex" | "ide">("flex");
  const [showHideWindowShortcut, setShowHideWindowShortcut] = useState("");
  const [isRecordingWindowShortcut, setIsRecordingWindowShortcut] = useState(false);

  // Layout state
  const [selectedLayout, setSelectedLayout] = useState((currentGlobalConfig?.layout.default ?? ""));
  const [customLayouts, setCustomLayouts] = useState<CustomLayoutConfig[]>(defaultCustomLayouts);
  const [selectedCustomLayoutId, setSelectedCustomLayoutId] = useState<string | null>(defaultCustomLayouts[0]?.id || null);
  const [customLayoutsLoaded, setCustomLayoutsLoaded] = useState(false); // Track if custom layouts were loaded from API

  const [hooksResponseSoundEnabled, setHooksResponseSoundEnabled] = useState(true);
  const [hooksResponseSound, setHooksResponseSound] = useState("Glass");
  const [hooksPermissionSoundEnabled, setHooksPermissionSoundEnabled] = useState(true);
  const [hooksPermissionSound, setHooksPermissionSound] = useState("Purr");

  // Notifications (menubar tray + system notifications)
  const [trayEnabled, setTrayEnabled] = useState(true);
  const [trayShowPermission, setTrayShowPermission] = useState(true);
  const [trayShowDone, setTrayShowDone] = useState(true);
  const [trayShowRunning, setTrayShowRunning] = useState(true);
  const [menubarShortcut, setMenubarShortcut] = useState("");
  const [isRecordingMenubarShortcut, setIsRecordingMenubarShortcut] = useState(false);
  const [systemNotifEnabled, setSystemNotifEnabled] = useState(false);
  const [systemNotifShowPermission, setSystemNotifShowPermission] = useState(true);
  const [systemNotifShowElicitation, setSystemNotifShowElicitation] = useState(true);
  const [systemNotifShowDone, setSystemNotifShowDone] = useState(true);
  const [systemNotifShowRunning, setSystemNotifShowRunning] = useState(false);

  // Tray "Done" chat retention. Two-mode UI: `forever` keeps everything
  // until the user dismisses; `expire` auto-prunes done chats after N
  // hours/days. Wire shape matches the Rust enum (externally tagged):
  //   forever → { "forever": null }
  //   expire  → { "expire": { "value": <u32>, "unit": "hours" | "days" } }
  const [trayDoneRetentionMode, setTrayDoneRetentionMode] = useState<"forever" | "expire">("expire");
  const [trayDoneRetentionValue, setTrayDoneRetentionValue] = useState<number>(3);
  const [trayDoneRetentionUnit, setTrayDoneRetentionUnit] = useState<"hours" | "days">("days");

  // MCP state
  const [copiedField, setCopiedField] = useState<string | null>(null);

  // AutoLink state
  const [autoLinkPatterns, setAutoLinkPatterns] = useState<string[]>([]);

  // Symbol indexing state (cmd+click navigation)
  const [indexingEnabled, setIndexingEnabled] = useState(true);
  const [indexingDisabledLangs, setIndexingDisabledLangs] = useState<string[]>([]);
  const [indexingSupportedLangs, setIndexingSupportedLangs] = useState<
    { id: string; display_name: string; extensions: string[] }[]
  >([]);

  // Browser Control state
  const [browserControlEnabled, setBrowserControlEnabled] = useState(true);
  const [browserControlAutoGroups, setBrowserControlAutoGroups] = useState(true);
  // Status polling is deliberately limited to the cheap in-process status
  // endpoint. It never queries Chrome tabs, and lets update/reload state change
  // while the installation dialog is open.
  const [extensionStatus, setExtensionStatus] = useState<ExtensionStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      getExtensionStatusDetails()
        .then((status) => { if (!cancelled) setExtensionStatus(status); })
        .catch(() => { if (!cancelled) setExtensionStatus(null); });
    };
    refresh();
    const timer = window.setInterval(refresh, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);
  const extensionConnected = extensionStatus?.connected ?? false;
  const extensionCurrent = extensionStatus?.compatible && !extensionStatus.updateAvailable;
  const extensionNeedsUpdate = extensionStatus?.updateRequired || extensionStatus?.updateAvailable;
  const extensionStatusLabel = !extensionConnected
    ? "Disconnected"
    : extensionStatus?.handshakeStatus === "pending"
      ? "Checking…"
      : extensionStatus?.updateRequired
        ? "Update required"
        : extensionStatus?.updateAvailable
          ? "Update available"
          : extensionStatus?.compatible
            ? "Connected"
            : "Incompatible";
  const extensionStatusColor = extensionCurrent
    ? "success"
    : extensionConnected
      ? "warning"
      : "error";

  const handleCopy = (field: string, value: string) => {
    navigator.clipboard.writeText(value);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  };

  // Helper: apply config to all state — defined first so loadConfig can list it
  // as a dependency. Kept outside try/catch so optional chaining and ternaries
  // don't bail out the React Compiler.
  const applyLoadedConfig = useCallback((cfg: Awaited<ReturnType<typeof getConfig>>) => {
    setIdeCommand(cfg.web.ide || "");
    setTerminalCommand(cfg.web.terminal || "");
    setSelectedLayout(cfg.layout.default);

    const mux = cfg.terminal_multiplexer || "tmux";
    setTerminalMultiplexer(mux);
    setWebTerminalMode(cfg.web.terminal_mode || "multiplexer");
    setWorkspaceLayout(cfg.web.workspace_layout || "ide");
    setShowHideWindowShortcut(cfg.web.show_hide_window_shortcut || "");

    // NOTE: theme/customThemes loading is owned by ThemeContext (it fetches
    // /api/v1/config on mount + focus). Calling setAppearance here would echo
    // the values back through patchConfig and trigger a redundant Radio
    // ThemeChanged broadcast on every Settings-page mount.

    // Load custom layouts
    if (cfg.layout.custom_layouts) {
      let parsed: unknown = null;
      let parseFailed = false;
      try {
        parsed = JSON.parse(cfg.layout.custom_layouts);
      } catch {
        parseFailed = true;
      }
      if (parseFailed) {
        console.error("Failed to parse custom layouts");
      } else if (Array.isArray(parsed) && parsed.length > 0) {
        // Check if it's an array (Web format) vs object (TUI format)
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
    } else {
      // No existing custom layouts, mark as loaded so we can save new ones
      setCustomLayoutsLoaded(true);
    }

    // Load AutoLink config
    setAutoLinkPatterns(cfg.auto_link.patterns);

    // Load ACP config
    const acp = cfg.acp;
    if (acp?.agent_command) {
      setAcpAgent(acp.agent_command);
    }
    if (acp?.custom_agents) {
      setCustomAgents(acp.custom_agents);
    }
    const preferences = loadChatHistoryPreferences(acp);
    const renderWindowLimit = preferences.renderWindowLimit;
    const renderWindowTrigger = preferences.renderWindowTrigger;
    setChatRenderWindowLimit(renderWindowLimit);
    setChatRenderWindowTrigger(renderWindowTrigger);
    setChatRenderWindowLimitDraft(String(renderWindowLimit));
    setChatRenderWindowTriggerDraft(String(renderWindowTrigger));
    setChatHistoryRecentTurns(preferences.recentTurns);
    setChatHistoryRecentTurnsDraft(String(preferences.recentTurns));
    setRecentSessions(preferences.recentSessions);
    setRecentSessionsDraft(String(preferences.recentSessions));
    setChatHistoryIncludeMedia(preferences.includeMedia);
    setChatHistoryIncludeToolDetails(preferences.includeToolDetails);

    if (cfg.hooks) {
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
      setMenubarShortcut(cfg.notifications.menubar_shortcut || "");
      setSystemNotifEnabled(cfg.notifications.notification_enabled);
      setSystemNotifShowPermission(cfg.notifications.notification_show_permission);
      setSystemNotifShowElicitation(cfg.notifications.notification_show_elicitation ?? true);
      setSystemNotifShowDone(cfg.notifications.notification_show_done);
      setSystemNotifShowRunning(cfg.notifications.notification_show_running);
      const ret = cfg.notifications.tray_done_retention;
      if (ret && "forever" in ret) {
        setTrayDoneRetentionMode("forever");
      } else if (ret && "expire" in ret && ret.expire) {
        setTrayDoneRetentionMode("expire");
        setTrayDoneRetentionValue(Math.max(1, Math.floor(ret.expire.value ?? 3)));
        setTrayDoneRetentionUnit(ret.expire.unit === "hours" ? "hours" : "days");
      }
    }

    if (cfg.indexing) {
      setIndexingEnabled(cfg.indexing.enabled);
      setIndexingDisabledLangs(cfg.indexing.disabled_languages ?? []);
      setIndexingSupportedLangs(cfg.indexing.supported_languages ?? []);
    }

    if (cfg.browser_control) {
      setBrowserControlEnabled(cfg.browser_control.enabled ?? true);
      setBrowserControlAutoGroups(cfg.browser_control.auto_groups ?? true);
    }

    setIsLoaded(true);
  }, []);

  // Load config from API
  const loadConfig = useCallback(async () => {
    let cfg: Awaited<ReturnType<typeof getConfig>> | null = null;
    try {
      cfg = await getConfig();
    } catch {
      cfg = null;
    }
    if (!cfg) {
      // API not available, use props config
      console.warn("Config API not available, using local config");
      setIsLoaded(true);
      return;
    }
    applyLoadedConfig(cfg);
  }, [applyLoadedConfig]);

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

    let response: Awaited<ReturnType<typeof checkAllDependencies>> | null = null;
    let failed = false;
    try {
      response = await checkAllDependencies();
    } catch {
      failed = true;
    }
    if (failed || !response) {
      // API not available, show error state
      setDepStates((prev) => {
        const newStates: Record<string, DependencyState> = {};
        for (const key of Object.keys(prev)) {
          newStates[key] = { ...prev[key], status: "error" };
        }
        return newStates;
      });
    } else {
      const newStates: Record<string, DependencyState> = {};
      for (const dep of response.dependencies) {
        const status: "installed" | "not_installed" = dep.installed ? "installed" : "not_installed";
        const version = dep.version ? dep.version : undefined;
        newStates[dep.name] = {
          status,
          version,
          installCommand: dep.install_command,
        };
      }
      setDepStates(newStates);
    }
    setIsChecking(false);
  }, []);

  const loadBaseAgents = useCallback(async () => {
    try {
      const [resp, cfg] = await Promise.all([listMarketplace(), getConfig()]);
      setCustomAgents(cfg.acp?.custom_agents ?? []);
      setMarketplaceIcons(
        resp.agents.map((a) => ({ id: a.id, icon_url: a.icon_url })),
      );
      const launchable = resp.agents.filter(
        (a: MarketplaceAgent) =>
          (a.install_state === "grove-installed" ||
            a.install_state === "auto-detected") &&
          !(a.installed?.hidden ?? false),
      );
      const snapshot = {
        baseAgents: launchable.map((a) => ({
          id: a.id,
          display_name: a.name,
          icon_id: a.id,
          icon_url: a.icon_url,
          available: true,
        })),
        customAgents: cfg.acp?.custom_agents ?? [],
      };
      lastAgentSnapshot = snapshot;
      setBaseAgents(snapshot.baseAgents);
      // Trigger downstream `hasAvailability` gating that watches a non-empty
      // commandAvailability map. Marker entry stands in for the old probe map.
      setCommandAvailability({ __marketplace_loaded__: true });
    } catch (error) {
      // A transient refresh failure must not erase the last usable catalog.
      console.error("Failed to refresh Settings agents:", error);
      setCommandAvailability({ __marketplace_loaded__: true });
    } finally {
      setBaseAgentsLoading(false);
    }
  }, []);

  // Save config to API (called automatically)
  // Note: themeId parameter allows immediate save with new theme value
  const saveConfig = useCallback(async () => {
    if (!isLoaded) return; // Don't save during initial load

    const layoutExtras = customLayoutsLoaded
      ? {
          custom_layouts: JSON.stringify(customLayouts),
          selected_custom_id: selectedCustomLayoutId ? selectedCustomLayoutId : undefined,
        }
      : {};
    const webIde = ideCommand ? ideCommand : undefined;
    const webTerminal = terminalCommand ? terminalCommand : undefined;
    const acpAgentCommand = acpAgent ? acpAgent : undefined;
    const patch = {
      layout: {
        default: selectedLayout,
        // Only save custom layouts if they were loaded/created in Web format
        // This prevents overwriting TUI's custom layout format
        ...layoutExtras,
      },
      web: {
        ide: webIde,
        terminal: webTerminal,
        terminal_mode: webTerminalMode,
        workspace_layout: workspaceLayout,
        show_hide_window_shortcut: showHideWindowShortcut,
      },
      terminal_multiplexer: terminalMultiplexer,
      acp: {
        agent_command: acpAgentCommand,
      },
      auto_link: {
        patterns: autoLinkPatterns,
      },
      hooks: {
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
        notification_show_elicitation: systemNotifShowElicitation,
        notification_show_done: systemNotifShowDone,
        notification_show_running: systemNotifShowRunning,
        menubar_shortcut: menubarShortcut,
        tray_done_retention:
          trayDoneRetentionMode === "forever"
            ? { forever: null }
            : { expire: { value: Math.max(1, Math.floor(trayDoneRetentionValue)), unit: trayDoneRetentionUnit } },
      },
      indexing: {
        enabled: indexingEnabled,
        disabled_languages: indexingDisabledLangs,
      },
      browser_control: {
        enabled: browserControlEnabled,
        auto_groups: browserControlAutoGroups,
      },
    };
    // The first save after load only echoes what was loaded; it isn't a change.
    const serialized = JSON.stringify(patch);
    const isChange = lastSavedPatchRef.current !== null && lastSavedPatchRef.current !== serialized;
    try {
      await patchConfig(patch);
      lastSavedPatchRef.current = serialized;
      if (isChange) setSavedCount((count) => count + 1);
      // Refresh the global config cache so other pages see the changes immediately
      await refreshGlobalConfig();
    } catch {
      console.error("Failed to save config");
    }
  }, [isLoaded, selectedLayout, acpAgent, customLayouts, selectedCustomLayoutId, customLayoutsLoaded, ideCommand, terminalCommand, terminalMultiplexer, webTerminalMode, workspaceLayout, showHideWindowShortcut, autoLinkPatterns, hooksResponseSoundEnabled, hooksResponseSound, hooksPermissionSoundEnabled, hooksPermissionSound, trayEnabled, trayShowPermission, trayShowDone, trayShowRunning, menubarShortcut, systemNotifEnabled, systemNotifShowPermission, systemNotifShowElicitation, systemNotifShowDone, systemNotifShowRunning, trayDoneRetentionMode, trayDoneRetentionUnit, trayDoneRetentionValue, indexingEnabled, indexingDisabledLangs, browserControlEnabled, browserControlAutoGroups, refreshGlobalConfig]);

  // These preferences belong to this browser, never to the shared Grove server.
  useEffect(() => {
    if (!isLoaded) return;
    const preferences = {
      recentTurns: chatHistoryRecentTurns,
      includeMedia: chatHistoryIncludeMedia,
      includeToolDetails: chatHistoryIncludeToolDetails,
      renderWindowLimit: chatRenderWindowLimit,
      renderWindowTrigger: chatRenderWindowTrigger,
      recentSessions,
    };
    saveChatHistoryPreferences(preferences);
    const serialized = JSON.stringify(preferences);
    const isChange = lastSavedPrefsRef.current !== null && lastSavedPrefsRef.current !== serialized;
    lastSavedPrefsRef.current = serialized;
    if (isChange) void Promise.resolve().then(() => setSavedCount((count) => count + 1));
  }, [isLoaded, chatHistoryRecentTurns, chatHistoryIncludeMedia, chatHistoryIncludeToolDetails, chatRenderWindowLimit, chatRenderWindowTrigger, recentSessions]);

  // Auto-save when any server config value changes (debounced)
  useEffect(() => {
    if (!isLoaded) return;

    const timer = setTimeout(() => {
      saveConfig();
    }, 500); // 500ms debounce

    return () => clearTimeout(timer);
  }, [selectedLayout, acpAgent, customLayouts, selectedCustomLayoutId, customLayoutsLoaded, ideCommand, terminalCommand, terminalMultiplexer, webTerminalMode, workspaceLayout, showHideWindowShortcut, autoLinkPatterns, hooksResponseSoundEnabled, hooksResponseSound, hooksPermissionSoundEnabled, hooksPermissionSound, trayEnabled, trayShowPermission, trayShowDone, trayShowRunning, menubarShortcut, systemNotifEnabled, systemNotifShowPermission, systemNotifShowElicitation, systemNotifShowDone, systemNotifShowRunning, indexingEnabled, indexingDisabledLangs, browserControlEnabled, browserControlAutoGroups, isLoaded, saveConfig]);

  useEffect(() => {
    if (!isRecordingWindowShortcut) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.key === "Escape") {
        setIsRecordingWindowShortcut(false);
        return;
      }

      const shortcut = formatShortcut(event);
      if (!shortcut) return;
      setShowHideWindowShortcut(shortcut);
      setIsRecordingWindowShortcut(false);
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [isRecordingWindowShortcut]);

  useEffect(() => {
    if (!isRecordingMenubarShortcut) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.key === "Escape") {
        setIsRecordingMenubarShortcut(false);
        return;
      }

      const shortcut = formatShortcut(event);
      if (!shortcut) return;
      setMenubarShortcut(shortcut);
      setIsRecordingMenubarShortcut(false);
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [isRecordingMenubarShortcut]);

  // Load applications list
  const loadApplications = useCallback(async () => {
    setIsLoadingApps(true);
    try {
      const { apps, platform } = await listApplications();
      setApplications(apps);
      setServerPlatform(platform);
    } catch {
      console.error("Failed to load applications");
    }
    setIsLoadingApps(false);
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
    }
    setCustomAgentPersonasLoading(false);
  }, []);

  // Initial load
  useEffect(() => {
    void (async () => {
      await Promise.all([
        loadConfig(),
        checkDependencies(),
        loadApplications(),
      ]);
    })();
  }, [loadConfig, checkDependencies, loadApplications]);

  useEffect(() => {
    void Promise.resolve().then(() => {
      void loadBaseAgents();
      void loadCustomAgentPersonas();
    });
  }, [loadBaseAgents, loadCustomAgentPersonas, catalogRevision]);

  // Terminal availability
  const tmuxInstalled = depStates["tmux"]?.status === "installed";
  const zellijInstalled = depStates["zellij"]?.status === "installed";
  const hasMultiplexer = tmuxInstalled || zellijInstalled;
  const canUseTerminal = webTerminalMode === "direct" || hasMultiplexer;

  // (enable states are auto-synced from dependency availability below)

  // Auto-correct on first load:
  // 1. If multiplexer mode but no multiplexer installed → fallback to direct
  // 2. If selected multiplexer not installed but other is → switch
  //
  // Uses the documented "Adjusting state on prop change" pattern (gated on a
  // one-shot state flag) so the corrective setState runs during render rather
  // than inside an effect.
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const [defaultsApplied, setDefaultsApplied] = useState(false);
  if (
    !defaultsApplied &&
    isLoaded &&
    !isChecking &&
    Object.keys(depStates).length > 0
  ) {
    setDefaultsApplied(true);
    if (webTerminalMode === "multiplexer" && !hasMultiplexer) {
      // No multiplexer available → fallback to direct
      setWebTerminalMode("direct");
    } else if (webTerminalMode === "multiplexer") {
      // Auto-correct multiplexer selection.
      if (terminalMultiplexer === "tmux" && !tmuxInstalled && zellijInstalled) {
        setTerminalMultiplexer("zellij");
      } else if (terminalMultiplexer === "zellij" && !zellijInstalled && tmuxInstalled) {
        setTerminalMultiplexer("tmux");
      }
    }
  }
  const baseAgentStatusById = useMemo(() => {
    const map = new Map<string, BaseAgent>();
    for (const agent of baseAgents) {
      map.set(agent.id, agent);
    }
    return map;
  }, [baseAgents]);

  // Chat Agent 选项：ACP base agent availability comes from backend.
  const chatAgentOptions = useMemo(() => {
    // Only surface available agents — the Marketplace modal is the place to
    // see/install everything else. Hiding unavailable ones from the picker
    // gets rid of the long list of `<agent> not found — install to enable`
    // rows that used to fill the dropdown and let users pick something
    // grove couldn't actually launch.
    return baseAgents
      .filter((base) => base.available)
      .map((base) => {
        const local = agentOptions.find(
          (a) => a.value === base.id || a.id === base.id,
        );
        const option = local ?? {
          id: base.id,
          label: base.display_name,
          value: base.id,
        };
        return { ...option, label: base.display_name, value: base.id };
      });
  }, [baseAgents]);

  // Feature availability (auto-derived from dependencies)
  const isTerminalAvailable = canUseTerminal;
  const isChatAvailable = chatAgentOptions.length > 0 || customAgents.length > 0;

  // Sync availability to ConfigContext for Task panel components
  useEffect(() => {
    if (Object.keys(depStates).length > 0) {
      updateAvailability(isTerminalAvailable);
    }
  }, [depStates, commandAvailability, isTerminalAvailable, updateAvailability]);

  // Auto-correct agent selection: pick first available, or clear if none available
  useEffect(() => {
    if (!isLoaded) return;
    // Compute corrections synchronously, but apply them after a microtask so
    // the setStates aren't synchronous within the effect body.
    let nextAcpAgent: string | undefined;
    if (baseAgents.length > 0 && acpAgent) {
      const currentBaseAgent = baseAgentStatusById.get(acpAgent);
      if (currentBaseAgent && !currentBaseAgent.available) {
        const firstAvailable = chatAgentOptions.find(a => !a.disabled);
        nextAcpAgent = firstAvailable?.value ?? "";
      }
    }

    if (nextAcpAgent !== undefined) {
      void Promise.resolve().then(() => setAcpAgent(nextAcpAgent));
    }
  }, [isLoaded, acpAgent, chatAgentOptions, baseAgentStatusById, baseAgents.length]);

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

  const isTauriGui = !isIosClient && !!((window as Window & {
    __TAURI__?: unknown;
    __TAURI_INTERNALS__?: unknown;
  }).__TAURI__ || (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
  const menubarShortcutConflict =
    !!menubarShortcut && menubarShortcut === showHideWindowShortcut;

  const updateCustomLayouts = useCallback((layouts: CustomLayoutConfig[]) => {
    setCustomLayouts(layouts);
    setCustomLayoutsLoaded(true); // Mark as edited, so we can save
  }, []);

  const saveCustomAgentServers = useCallback(async (agents: CustomAgentServer[]) => {
    setCustomAgents(agents);
    try {
      await patchConfig({ acp: { custom_agents: agents } });
      await refreshGlobalConfig();
    } catch {
      console.error("Failed to save custom agents");
    }
  }, [refreshGlobalConfig]);

  const updateCustomAgentPersonas = useCallback((next: CustomAgentPersona[]) => {
    setCustomAgentPersonas(next);
    setCustomAgentPersonasIconRegistry(next);
  }, []);

  return {
    isLoaded,
    savedCount,
    // Environment
    depStates,
    isChecking,
    checkDependencies,
    // Agents
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
    // Chat history + render window (browser-local)
    chatHistoryRecentTurns,
    setChatHistoryRecentTurns,
    chatHistoryRecentTurnsDraft,
    setChatHistoryRecentTurnsDraft,
    recentSessions,
    setRecentSessions,
    recentSessionsDraft,
    setRecentSessionsDraft,
    chatHistoryIncludeMedia,
    setChatHistoryIncludeMedia,
    chatHistoryIncludeToolDetails,
    setChatHistoryIncludeToolDetails,
    chatRenderWindowLimit,
    chatRenderWindowLimitDraft,
    setChatRenderWindowLimitDraft,
    chatRenderWindowTrigger,
    chatRenderWindowTriggerDraft,
    setChatRenderWindowTriggerDraft,
    commitChatRenderWindowLimit,
    commitChatRenderWindowTrigger,
    setChatRenderWindowMode,
    // Terminal
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
    // General
    ideCommand,
    setIdeCommand,
    terminalCommand,
    setTerminalCommand,
    applications,
    isLoadingApps,
    serverPlatform,
    workspaceLayout,
    setWorkspaceLayout,
    showHideWindowShortcut,
    setShowHideWindowShortcut,
    isRecordingWindowShortcut,
    setIsRecordingWindowShortcut,
    isTauriGui,
    // Notifications
    hooksResponseSoundEnabled,
    setHooksResponseSoundEnabled,
    hooksResponseSound,
    setHooksResponseSound,
    hooksPermissionSoundEnabled,
    setHooksPermissionSoundEnabled,
    hooksPermissionSound,
    setHooksPermissionSound,
    trayEnabled,
    setTrayEnabled,
    trayShowPermission,
    setTrayShowPermission,
    trayShowDone,
    setTrayShowDone,
    trayShowRunning,
    setTrayShowRunning,
    menubarShortcut,
    setMenubarShortcut,
    isRecordingMenubarShortcut,
    setIsRecordingMenubarShortcut,
    menubarShortcutConflict,
    systemNotifEnabled,
    setSystemNotifEnabled,
    systemNotifShowPermission,
    setSystemNotifShowPermission,
    systemNotifShowElicitation,
    setSystemNotifShowElicitation,
    systemNotifShowDone,
    setSystemNotifShowDone,
    systemNotifShowRunning,
    setSystemNotifShowRunning,
    trayDoneRetentionMode,
    setTrayDoneRetentionMode,
    trayDoneRetentionValue,
    setTrayDoneRetentionValue,
    trayDoneRetentionUnit,
    setTrayDoneRetentionUnit,
    // Worktrees
    autoLinkPatterns,
    setAutoLinkPatterns,
    indexingEnabled,
    setIndexingEnabled,
    indexingDisabledLangs,
    setIndexingDisabledLangs,
    indexingSupportedLangs,
    // Browser control
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
    // Clipboard feedback
    copiedField,
    handleCopy,
  };
}

export type SettingsState = ReturnType<typeof useSettingsState>;
