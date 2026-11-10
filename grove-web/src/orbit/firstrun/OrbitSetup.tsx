import { createElement, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Bell, GitBranch, Globe, Hexagon, Loader2, Monitor, PanelTop, RotateCw, X, type LucideIcon } from "lucide-react";
import { invalidateAgentCatalog } from "../../api/agentCatalogChanges";
import { listMarketplace, patchAgent, type MarketplaceAgent } from "../../api/marketplace";
import { requestComputerPermission, type ComputerPermission } from "../../api/browser";
import { getSetupTools, installSetupTool, type SetupTool, type SetupToolId } from "../../api/setup";
import { InstallExtensionDialog } from "../../components/Config/InstallExtensionDialog";
import { MarketplaceModal } from "../../components/Config/MarketplaceModal";
import { isIdeApp, isTerminalApp } from "../../components/Config/settingsConstants";
import { useAppIconSelection } from "../../components/Config/useAppIconSelection";
import { useSettingsState, type SettingsState } from "../../components/Config/useSettingsState";
import { GroveIcon } from "../../components/Layout/GroveIcon";
import type { AppInfo } from "../../api/config";
import { AppIcon, AppPicker, ideAppOptions, pickableApps, terminalAppOptions, type PickableApp } from "../../components/ui";
import { useTheme } from "../../context";
import { APP_ICON_DESIGNS, appIconAssetUrl } from "../../data/appIcons";
import { useAgentCatalogRevision } from "../../hooks/useAgentCatalogRevision";
import { requestBrowserNotificationPermission } from "../../notifications/desktopNotifier";
import { agentIconComponent, setMarketplaceIcons } from "../../utils/agentIcon";
import { openExternalUrl } from "../../utils/openExternal";
import { ACCESS_OPTIONS, access, type Access } from "../settings/pages/access";
import { errorText, useComputerPermissions } from "../settings/pages/useComputerPermissions";
import { Button, DrawnCheck, Group, Lead, Row, Segmented, Toggle, keycapParts } from "../ui";
import "../settings/orbit-settings.css";
import "./setup.css";

type StepId = "welcome" | "check" | "agents" | "shortcut" | "permissions" | "yours";

/** What each tool is called, and the part of Grove that needs it. */
const TOOLS: Record<SetupToolId, { name: string; need: string; icon: LucideIcon }> = {
  node: { name: "Node.js", need: "Agents", icon: Hexagon },
  git: { name: "Git", need: "Coding projects", icon: GitBranch },
};
const INSTALL_POLL_MS = 700;

/**
 * The tools Grove needs on the machine it runs on. `missing` is what was not
 * there on the first look and stays listed once installed; null until that look.
 */
function useSetupTools() {
  const [tools, setTools] = useState<SetupTool[] | null>(null);
  const [missing, setMissing] = useState<SetupToolId[] | null>(null);
  const hadNode = useRef<boolean | null>(null);
  const check = useCallback(() => getSetupTools()
    .then((next) => {
      setTools(next);
      setMissing((known) => known ?? next.filter((tool) => !tool.installed).map((tool) => tool.id));
      // Agents that run through npx become usable the moment Node.js arrives.
      const node = next.find((tool) => tool.id === "node")?.installed ?? null;
      if (hadNode.current === false && node) invalidateAgentCatalog();
      hadNode.current = node;
    })
    // A machine that cannot answer (an older Grove) has nothing to check.
    .catch(() => { setTools((known) => known ?? []); setMissing((known) => known ?? []); }), []);

  useEffect(() => {
    void check();
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [check]);

  const installing = tools?.some((tool) => tool.installing) ?? false;
  useEffect(() => {
    if (!installing) return;
    const timer = window.setInterval(() => void check(), INSTALL_POLL_MS);
    return () => window.clearInterval(timer);
  }, [installing, check]);

  const install = (id: SetupToolId) => {
    setTools((known) => known?.map((tool) => tool.id === id ? { ...tool, installing: true, line: "", error: null } : tool) ?? known);
    void installSetupTool(id).catch(() => {}).then(check);
  };
  return { tools, missing, check, install };
}

function ToolRow({ tool, onInstall }: { tool: SetupTool; onInstall: () => void }) {
  const [copied, setCopied] = useState(false);
  const { name, need, icon: Icon } = TOOLS[tool.id];
  const copy = () => {
    if (!tool.command) return;
    void navigator.clipboard?.writeText(tool.command).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    }).catch(() => {});
  };
  return (
    <div className="oui-row ose-tool">
      <Lead><Icon /></Lead>
      <span className="oui-row-copy">
        <span className="oui-row-title">{name}<span className="ose-need">{need}</span></span>
        {tool.installed ? null : tool.installing ? (
          <span className="ose-log" aria-live="polite">{tool.line || "Starting…"}</span>
        ) : tool.error ? (
          <span className="ose-log is-error" role="alert">{tool.error}</span>
        ) : tool.handed_over ? (
          <span className="ose-log" aria-live="polite">Finish in the installer that opened</span>
        ) : tool.command ? (
          <button type="button" className="ose-cmd" title="Copy" onClick={copy}>{copied ? "Copied" : tool.command}</button>
        ) : null}
      </span>
      {tool.installed ? (
        <span className="ose-state is-here"><i />Installed</span>
      ) : tool.installing ? (
        <span className="ose-state"><Loader2 size={14} className="owl-spin" aria-hidden="true" />Installing</span>
      ) : tool.run ? (
        <Button size="sm" onClick={onInstall}>{tool.error ? "Try again" : "Install"}</Button>
      ) : tool.command ? (
        <Button size="sm" onClick={copy}>{copied ? "Copied" : "Copy"}</Button>
      ) : tool.url ? (
        <Button size="sm" onClick={() => openExternalUrl(tool.url!)}>Download</Button>
      ) : null}
    </div>
  );
}

function CheckStep({ tools, onInstall, onCheck }: { tools: SetupTool[]; onInstall: (id: SetupToolId) => void; onCheck: () => void }) {
  return (
    <>
      <h1>Check your setup</h1>
      <div className="oui-group ose-list" role="group" aria-label="Tools Grove needs">
        {tools.map((tool) => <ToolRow key={tool.id} tool={tool} onInstall={() => onInstall(tool.id)} />)}
      </div>
      <div className="ose-under">
        <button type="button" className="ose-link" onClick={onCheck}><RotateCw size={12} aria-hidden="true" />Check again</button>
      </div>
    </>
  );
}

/** An agent Grove can launch: found on this computer, or fetched the first time it runs. */
interface SetupAgent {
  id: string;
  name: string;
  hidden: boolean;
  /** Already on this computer, as opposed to downloaded on first use. */
  installed: boolean;
}

function toSetupAgent(agent: MarketplaceAgent): SetupAgent {
  const channels = agent.installed?.installations ?? [];
  return {
    id: agent.id,
    name: agent.name,
    hidden: agent.installed?.hidden ?? false,
    installed: agent.install_state === "auto-detected"
      || channels.some((channel) => channel.method === "external" || channel.method === "binary"),
  };
}

function useSetupAgents() {
  const revision = useAgentCatalogRevision();
  const [result, setResult] = useState<{ agents: SetupAgent[]; npx: boolean } | null>(null);
  useEffect(() => {
    let cancelled = false;
    listMarketplace()
      .then((response) => {
        if (cancelled) return;
        setMarketplaceIcons(response.agents.map((agent) => ({ id: agent.id, icon_url: agent.icon_url })));
        const launchable = response.agents.filter((agent) => agent.install_state === "grove-installed" || agent.install_state === "auto-detected");
        setResult({ agents: launchable.map(toSetupAgent), npx: response.npx_available });
      })
      .catch(() => { if (!cancelled) setResult({ agents: [], npx: true }); });
    return () => { cancelled = true; };
  }, [revision]);
  return result;
}

interface AgentChoice {
  picked: Set<string>;
  defaultId: string | null;
  /** The agents listed when this was chosen; one that shows up later was never turned down. */
  listed?: Set<string>;
}

function AgentsStep({ agents, npx, choice, onChoice }: {
  agents: SetupAgent[] | null;
  npx: boolean;
  choice: AgentChoice;
  onChoice: (next: AgentChoice) => void;
}) {
  const [marketplaceOpen, setMarketplaceOpen] = useState(false);
  const listed = new Set((agents ?? []).map((agent) => agent.id));
  const toggle = (id: string) => {
    const picked = new Set(choice.picked);
    if (picked.has(id)) picked.delete(id); else picked.add(id);
    const defaultId = choice.defaultId && picked.has(choice.defaultId) ? choice.defaultId : [...picked][0] ?? null;
    onChoice({ picked, defaultId, listed });
  };
  return (
    <>
      <h1>Choose your agents</h1>
      <div className="oui-group ose-list" role="group" aria-label="Coding agents">
        {agents === null ? [0, 1, 2, 3].map((index) => (
          <div key={index} className="oui-row ose-ag is-loading" aria-hidden="true"><span className="oui-lead" /><span className="oui-skel ose-skel" /></div>
        )) : agents.map((agent, index) => {
          const on = choice.picked.has(agent.id);
          const isDefault = choice.defaultId === agent.id;
          return (
            <div
              key={agent.id}
              className="oui-row ose-ag"
              role="checkbox"
              tabIndex={0}
              aria-checked={on}
              aria-label={agent.name}
              style={{ animationDelay: `${index * 40}ms` }}
              onClick={() => toggle(agent.id)}
              onKeyDown={(event) => {
                if (event.target === event.currentTarget && (event.key === " " || event.key === "Enter")) {
                  event.preventDefault();
                  event.stopPropagation();
                  toggle(agent.id);
                }
              }}
            >
              <Lead>{createElement(agentIconComponent(agent.id), { size: 17 })}</Lead>
              <span className="oui-row-copy">
                <span className="oui-row-title">
                  {agent.name}
                  {on ? (
                    <button
                      type="button"
                      className={`ose-default${isDefault ? " is-on" : ""}`}
                      aria-pressed={isDefault}
                      onClick={(event) => { event.stopPropagation(); onChoice({ ...choice, defaultId: agent.id, listed }); }}
                    >
                      {isDefault ? "Default" : "Set default"}
                    </button>
                  ) : null}
                </span>
              </span>
              <span className={`ose-state${agent.installed ? " is-here" : npx ? "" : " is-blocked"}`}>
                <i />{agent.installed ? "Installed" : npx ? "Download" : "Needs Node.js"}
              </span>
              <span className="ose-box" aria-hidden="true">{on ? <DrawnCheck /> : null}</span>
            </div>
          );
        })}
      </div>
      <div className="ose-under">
        <button type="button" className="ose-link" onClick={() => setMarketplaceOpen(true)}>All agents</button>
        <button type="button" className="ose-link" onClick={invalidateAgentCatalog}><RotateCw size={12} aria-hidden="true" />Check again</button>
      </div>
      <MarketplaceModal open={marketplaceOpen} initialTab="explore" onClose={() => { setMarketplaceOpen(false); invalidateAgentCatalog(); }} />
    </>
  );
}

function ShortcutStep({ settings }: { settings: SettingsState }) {
  const { showHideWindowShortcut: value, setShowHideWindowShortcut, isRecordingWindowShortcut: recording, setIsRecordingWindowShortcut } = settings;
  return (
    <>
      <h1>Open Grove from anywhere</h1>
      <div className="ose-keys-wrap">
        <button
          type="button"
          className={`ose-keys${recording ? " is-recording" : ""}${value ? "" : " is-empty"}`}
          aria-label={recording ? "Cancel recording shortcut" : "Record shortcut"}
          onClick={() => setIsRecordingWindowShortcut((current) => !current)}
        >
          {value
            ? keycapParts(value).map((part, index) => <kbd key={`${part}-${index}`} className="ose-key">{part}</kbd>)
            : <span className="ose-key is-blank">{recording ? "…" : "Record"}</span>}
        </button>
        {value && !recording ? (
          <Button variant="ghost" iconOnly aria-label="Clear shortcut" title="Clear shortcut" onClick={() => setShowHideWindowShortcut("")}><X /></Button>
        ) : null}
      </div>
      <p className="ose-hint" aria-live="polite">{recording ? "Press shortcut…" : ""}</p>
    </>
  );
}

function PermissionsStep({ settings }: { settings: SettingsState }) {
  const browser: Access = settings.browserControlEnabled ? access(settings.browserPersonalAllowed, settings.browserPersonalBypass) : "off";
  const setBrowser = (value: Access) => {
    if (value !== "off") settings.setBrowserControlEnabled(true);
    settings.setBrowserPersonalAllowed(value !== "off");
    settings.setBrowserPersonalBypass(value === "allow");
  };
  const setComputer = (value: Access) => {
    settings.setComputerUseAllowed(value !== "off");
    settings.setComputerUseBypass(value === "allow");
  };
  const trayName = settings.serverPlatform === "macos" ? "Menu bar icon" : "Tray icon";
  // What each choice needs before it works: the Companion in the browser, and macOS's own permissions.
  const [installOpen, setInstallOpen] = useState(false);
  const computerOn = settings.computerUseAllowed;
  const system = useComputerPermissions(computerOn);
  const askSystem = (permission: ComputerPermission) => {
    requestComputerPermission(permission).catch((cause) => system.setError(errorText(cause)));
  };
  const systemRow = (title: string, permission: ComputerPermission, state: string) => (
    <div className="oui-row ose-sub">
      <span className="oui-row-copy"><span className="oui-row-title">{title}</span></span>
      {state === "granted"
        ? <span className="ose-state is-here"><i />Allowed</span>
        : <Button size="sm" onClick={() => askSystem(permission)}>Set Up</Button>}
    </div>
  );
  return (
    <>
      <h1>Permissions</h1>
      <div className="ose-list">
        <Group>
          <Row leading={<Lead><Bell /></Lead>} title="Notifications">
            <Toggle
              checked={settings.systemNotifEnabled}
              label="Notifications"
              onChange={(enabled) => {
                settings.setSystemNotifEnabled(enabled);
                if (enabled) void requestBrowserNotificationPermission();
              }}
            />
          </Row>
          {settings.isTauriGui ? (
            <Row leading={<Lead><PanelTop /></Lead>} title={trayName}>
              <Toggle checked={settings.trayEnabled} onChange={settings.setTrayEnabled} label={trayName} />
            </Row>
          ) : null}
        </Group>
        <Group>
          <Row leading={<Lead><Globe /></Lead>} title="Agents use your browser">
            <Segmented value={browser} options={ACCESS_OPTIONS} onChange={setBrowser} ariaLabel="Agents use your browser" size="sm" />
          </Row>
          {browser !== "off" ? (
            <div className="oui-row ose-sub">
              <span className="oui-row-copy"><span className="oui-row-title">Grove Companion</span></span>
              {settings.extensionCurrent
                ? <span className="ose-state is-here"><i />Connected</span>
                : <Button size="sm" onClick={() => setInstallOpen(true)}>{settings.extensionNeedsUpdate ? "Update" : "Install"}</Button>}
            </div>
          ) : null}
          <Row leading={<Lead><Monitor /></Lead>} title="Agents use your computer">
            <Segmented
              value={access(settings.computerUseAllowed, settings.computerUseBypass)}
              options={ACCESS_OPTIONS}
              onChange={setComputer}
              ariaLabel="Agents use your computer"
              size="sm"
            />
          </Row>
          {computerOn && system.permissions ? (
            <>
              {systemRow("Accessibility", "accessibility", system.permissions.accessibility)}
              {systemRow("Screen Recording", "screenRecording", system.permissions.screenRecording)}
            </>
          ) : null}
          {computerOn && system.error ? (
            <div className="oui-row ose-sub"><span className="ose-log is-error" role="alert">{system.error}</span></div>
          ) : null}
        </Group>
      </div>
      {installOpen ? <InstallExtensionDialog onClose={() => setInstallOpen(false)} /> : null}
    </>
  );
}

/** Known apps shown as chips; every other installed app is in the menu beside them. */
const APP_CHIP_LIMIT = 3;
const KNOWN_ONLY = () => false;

/**
 * One job's app, from what the machine reports: the apps Grove knows as chips,
 * and a menu of everything else installed. Left out where no apps are reported.
 */
function AppRow({ title, options, others, applications, loading, value, onChange }: {
  title: string;
  options: typeof ideAppOptions;
  /** Which of the other installed apps the menu offers. */
  others: (app: AppInfo) => boolean;
  applications: AppInfo[];
  loading: boolean;
  value: string;
  onChange: (path: string) => void;
}) {
  const known = useMemo(() => pickableApps(options, applications, KNOWN_ONLY), [options, applications]);
  const all = useMemo(() => pickableApps(options, applications, others), [options, applications, others]);
  if (all.length === 0) return null;
  const isPicked = (item: PickableApp) => item.app.path === value || (!!value && item.command === value) || (!value && item.id === "system");
  let chips = known.slice(0, APP_CHIP_LIMIT);
  const picked = known.find(isPicked);
  if (picked && !chips.includes(picked)) chips = [...chips.slice(0, APP_CHIP_LIMIT - 1), picked];
  const chipPaths = chips.map((item) => item.app.path);
  return (
    <div className="oui-row ose-pick">
      <span className="oui-row-title">{title}</span>
      <div className="ose-chips" role="radiogroup" aria-label={title}>
        {chips.map((item) => (
          <button key={item.app.path} type="button" role="radio" aria-checked={isPicked(item)} className="ose-chip" onClick={() => onChange(item.app.path)}>
            <AppIcon app={item.app} className="ose-app" />{item.id === "system" ? item.app.name : item.label}
          </button>
        ))}
        {/* The menu holds what the chips do not, and is left out when they hold everything. */}
        {all.length > chips.length ? (
          <div className={`ose-menu${chips.length ? "" : " is-alone"}`}>
            <AppPicker
              options={options}
              value={picked && chips.includes(picked) ? "" : value}
              onChange={onChange}
              placeholder={chips.length ? "Other" : "Choose"}
              applications={applications}
              isLoadingApps={loading}
              appFilter={others}
              exclude={chipPaths}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function YoursStep({ settings }: { settings: SettingsState }) {
  const { mode, lightThemeId, darkThemeId, themes, setAppearance } = useTheme();
  const { appIcon, isLight, saving, select } = useAppIconSelection();
  const activeId = mode === "auto" ? "auto" : mode === "light" ? lightThemeId : darkThemeId;
  return (
    <>
      <h1>Make it yours</h1>
      <div className="ose-list">
        <Group>
          <div className="oui-row ose-stack">
            <div className="ose-stack-head">
              <span>Theme</span>
              <b>{activeId === "auto" ? "System" : themes.find((theme) => theme.id === activeId)?.name}</b>
            </div>
            <div className="ose-tiles" role="radiogroup" aria-label="Theme">
              <button type="button" role="radio" aria-checked={activeId === "auto"} aria-label="System" title="System" className="ose-swatch is-system" onClick={() => void setAppearance({ mode: "auto" })} />
              {themes.map((theme) => (
                <button
                  key={theme.id}
                  type="button"
                  role="radio"
                  aria-checked={activeId === theme.id}
                  aria-label={theme.name}
                  title={theme.name}
                  className="ose-swatch"
                  style={{ "--sw-bg": theme.colors.bg, "--sw-ac": theme.colors.highlight } as CSSProperties}
                  onClick={() => void setAppearance(theme.isLight ? { mode: "light", lightThemeId: theme.id } : { mode: "dark", darkThemeId: theme.id })}
                />
              ))}
            </div>
          </div>
          <div className="oui-row ose-stack">
            <div className="ose-stack-head">
              <span>Icon</span>
              <b>{APP_ICON_DESIGNS.find((design) => design.id === appIcon)?.name}</b>
            </div>
            <div className="ose-tiles is-spread" role="radiogroup" aria-label="Application icon" aria-busy={saving}>
              {APP_ICON_DESIGNS.map((design) => (
                <button
                  key={design.id}
                  type="button"
                  role="radio"
                  aria-checked={appIcon === design.id}
                  aria-label={design.name}
                  title={design.name}
                  className="ose-icon"
                  onClick={() => void select(design.id)}
                >
                  <img src={appIconAssetUrl(design.id, isLight)} alt="" />
                </button>
              ))}
            </div>
          </div>
          <AppRow title="Editor" options={ideAppOptions} others={isIdeApp} applications={settings.applications} loading={settings.isLoadingApps} value={settings.ideCommand} onChange={settings.setIdeCommand} />
          <AppRow title="Terminal" options={terminalAppOptions} others={isTerminalApp} applications={settings.applications} loading={settings.isLoadingApps} value={settings.terminalCommand} onChange={settings.setTerminalCommand} />
        </Group>
      </div>
    </>
  );
}

/**
 * First-run setup: a few full-screen steps before the first project. Every
 * choice is an ordinary setting, saved as it is made; only the agent choice
 * waits for Continue, so skipping leaves the agents as they were.
 */
export function OrbitSetup({ onDone }: { onDone: () => void }) {
  const settings = useSettingsState();
  const catalog = useSetupAgents();
  const { tools, missing, check, install } = useSetupTools();
  // The check is a step only when something is missing, and only if that is known before the Welcome step is left.
  const [pastWelcomeUnchecked, setPastWelcomeUnchecked] = useState(false);
  const hasCheck = !!missing?.length && !pastWelcomeUnchecked;
  const steps = useMemo<StepId[]>(
    () => ["welcome", ...(hasCheck ? ["check" as const] : []), "agents", ...(settings.isTauriGui ? ["shortcut" as const] : []), "permissions", "yours"],
    [hasCheck, settings.isTauriGui],
  );
  const [index, setIndex] = useState(0);
  const [back, setBack] = useState(false);
  const step = steps[Math.min(index, steps.length - 1)];
  const checked = (tools ?? []).filter((tool) => missing?.includes(tool.id));

  // What the person picked, once they touch the list; until then, every agent that can run here.
  const [edited, setEdited] = useState<AgentChoice | null>(null);
  const suggested = useMemo<AgentChoice>(() => {
    const usable = (catalog?.agents ?? []).filter((agent) => !agent.hidden && (agent.installed || catalog?.npx));
    const picked = new Set(usable.map((agent) => agent.id));
    const current = settings.acpAgent && picked.has(settings.acpAgent) ? settings.acpAgent : null;
    return { picked, defaultId: current ?? [...picked][0] ?? null };
  }, [catalog, settings.acpAgent]);
  // An agent that appeared after the person chose (installed from "All agents", or usable now that Node.js is there) joins the choice.
  const choice = useMemo<AgentChoice>(() => {
    if (!edited) return suggested;
    const picked = new Set(edited.picked);
    for (const id of suggested.picked) if (!edited.listed?.has(id)) picked.add(id);
    return { ...edited, picked, defaultId: edited.defaultId ?? [...picked][0] ?? null };
  }, [edited, suggested]);

  const applyAgents = () => {
    if (!catalog || choice.picked.size === 0) return;
    for (const agent of catalog.agents) {
      const picked = choice.picked.has(agent.id);
      // One that cannot run here yet was never offered as a choice: leave it as it is.
      if (!picked && !agent.installed && !catalog.npx) continue;
      if (picked === agent.hidden) void patchAgent(agent.id, { hidden: !picked }).catch(() => {});
    }
    if (choice.defaultId) settings.setAcpAgent(choice.defaultId);
  };

  const go = (next: number) => {
    if (step === "welcome" && missing === null) setPastWelcomeUnchecked(true);
    if (step === "agents" && next > index) applyAgents();
    settings.setIsRecordingWindowShortcut(false);
    if (next >= steps.length) return onDone();
    setBack(next < index);
    setIndex(next);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || event.defaultPrevented) return;
      if ((event.target as HTMLElement | null)?.closest?.("button, a, input, select, textarea, [role=dialog]")) return;
      go(index + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="ose">
      <div className="ose-top" data-tauri-drag-region>
        <div className="ose-prog" aria-hidden="true">
          {steps.map((id, position) => <i key={id} className={position <= index ? "is-done" : undefined} />)}
        </div>
        <button type="button" className="ose-skip" onClick={onDone}>Skip setup</button>
      </div>
      <div className="ose-steps">
        <div key={step} className={`ose-step${back ? " is-back" : ""}${step === "welcome" ? " is-welcome" : ""}`}>
          {step === "welcome" ? (
            <>
              <div className="owl-mark"><GroveIcon size={104} /></div>
              <h1>Steer agents with context.</h1>
              <div className="ose-go"><Button variant="primary" className="ose-start" onClick={() => go(1)}>Get started</Button></div>
            </>
          ) : step === "check" ? (
            <CheckStep tools={checked} onInstall={install} onCheck={() => void check()} />
          ) : step === "agents" ? (
            <AgentsStep agents={catalog?.agents ?? null} npx={catalog?.npx ?? true} choice={choice} onChoice={setEdited} />
          ) : step === "shortcut" ? (
            <ShortcutStep settings={settings} />
          ) : step === "permissions" ? (
            <PermissionsStep settings={settings} />
          ) : (
            <YoursStep settings={settings} />
          )}
        </div>
      </div>
      <div className="ose-foot">
        {index > 0 ? <Button variant="ghost" onClick={() => go(index - 1)}>Back</Button> : <span />}
        {index > 0 ? (
          <Button variant="primary" onClick={() => go(index + 1)}>
            {(step === "agents" && catalog && choice.picked.size === 0) || (step === "check" && checked.some((tool) => !tool.installed)) ? "Skip" : "Continue"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
