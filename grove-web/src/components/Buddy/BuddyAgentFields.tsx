import { createElement, useEffect, useRef, useState, type ReactNode } from "react";
import { Box, Brain, ChevronDown, ShieldCheck } from "lucide-react";
import { agentIconComponent } from "../../utils/agentIcon";
import type { BuddyAgentConfig } from "../../api/buddies";
import type { InstalledAgentConfig } from "../../api/marketplace";
import type { SessionConfigOption } from "../../api/tasks";
import { PickerMenu } from "../ui/PickerMenu";
import { DropdownSelect, SessionSettingsMenu, type ChatDropdownOption } from "../Tasks/TaskView/ChatConfigMenus";
import { configDropdownValues, quickConfigOptions } from "../Tasks/TaskView/sessionConfigOptions";
import { useEscapeScope } from "../../keyboard/useEscapeScope";

const NO_PENDING_CONFIG = new Set<string>();

export function BuddyAgentFields({ agents, agent, config, onAgent, onConfig, disabled = false, agentDisabled = false, loading = false, confirmation, confirmAgentChange = false }: {
  agents: InstalledAgentConfig[]; agent: string; config: BuddyAgentConfig;
  onAgent: (id: string) => void; onConfig: (config: BuddyAgentConfig) => void;
  disabled?: boolean; agentDisabled?: boolean; loading?: boolean; confirmation?: ReactNode; confirmAgentChange?: boolean;
}) {
  const [menu, setMenu] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const agentRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);
  const modeRef = useRef<HTMLDivElement>(null);
  const effortRef = useRef<HTMLDivElement>(null);
  const settingsRef = useRef<HTMLDivElement>(null);
  useEscapeScope(menu !== null && menu !== "settings", () => setMenu(null));
  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node) && !menuRef.current?.contains(event.target as Node)) setMenu(null); };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [menu]);
  const selected = agents.find((item) => item.id === agent);
  const snapshot = selected?.capability_snapshot;
  const configOptions = snapshot?.uses_config_options ? snapshot.config_options ?? [] : [];
  const quick = quickConfigOptions(configOptions);
  const fields = [
    { key: "model", option: quick.model, icon: <Box size={12} /> },
    { key: "mode", option: quick.mode, icon: <ShieldCheck size={12} /> },
    { key: "effort", option: quick.thinking, icon: <Brain size={12} /> },
  ];
  const supported = fields.filter(({ option }) => option?.type === "select" && configDropdownValues(option).length > 0);
  const quickIds = new Set(supported.map(({ option }) => option!.id));
  const overrides = config.source === "config_options" ? config.values : {};
  // Match Orbit/TaskChat: display the Agent's current values, then apply saved overrides.
  const settingsOptions = configOptions.filter((option) => !quickIds.has(option.id)).map((option): SessionConfigOption => {
    const value = overrides[option.id];
    if (option.type === "boolean" && typeof value === "boolean") return { ...option, currentValue: value };
    if (option.type === "select" && typeof value === "string") return { ...option, currentValue: value };
    return option;
  });
  const modes = !snapshot?.uses_config_options ? snapshot?.modes?.available ?? [] : [];
  const setOption = (option: SessionConfigOption, value: string | boolean) => {
    const values = { ...overrides };
    if (config.source === "modes" && quick.mode) values[quick.mode.id] = config.mode_id;
    values[option.id] = value;
    onConfig({ source: "config_options", agent_id: agent, values });
    setMenu(null);
  };
  return <div className="buddy-agent-fields" ref={root}>
    <div className="buddy-agent-menu">
      <button ref={agentRef} type="button" className="buddy-button" disabled={disabled || loading || agentDisabled || !agents.length} aria-expanded={menu === "agent"} onClick={() => setMenu(menu === "agent" ? null : "agent")}><span className="buddy-agent-brand">{createElement(agentIconComponent(agent), { size: 16 })}</span><span>Agent · {loading ? "Loading…" : selected?.name ?? (agent || "Choose")}</span><ChevronDown size={14} /></button>
      {menu === "agent" && !loading && !disabled && !agentDisabled && <PickerMenu anchorRef={agentRef} menuRef={menuRef} footer={confirmation} items={agents.map((item) => ({ id: item.id, label: item.name, icon: createElement(agentIconComponent(item.id), { size: 16 }) }))} selectedId={agent} onSelect={(id) => { onAgent(id); if (!confirmAgentChange) setMenu(null); }} onEscape={() => setMenu(null)} />}
    </div>
    {supported.map(({ key, option, icon }) => {
      if (!option) return null;
      const values = configDropdownValues(option).map((item) => ({ label: item.name, value: item.value, description: item.description, group: item.group }));
      const value = String(overrides[option.id] ?? (key === "mode" && config.source === "modes" ? config.mode_id : option.currentValue));
      const options: ChatDropdownOption[] = [...values];
      if (value && !values.some((item) => item.value === value)) options.push({ label: value, value });
      return <DropdownSelect key={key} ref={key === "model" ? modelRef : key === "mode" ? modeRef : effortRef} icon={icon} portal menuRef={menuRef} label={option.name} options={options} value={value} open={menu === key} disabled={disabled || loading} placement="up-left" onToggle={() => setMenu(menu === key ? null : key)} onSelect={(next) => setOption(option, next)} />;
    })}
    {modes.length > 0 && <DropdownSelect ref={modeRef} icon={<ShieldCheck size={12} />} portal menuRef={menuRef} label="Mode" options={modes.map(([value, label]) => ({ value, label }))} value={config.source === "modes" ? config.mode_id : snapshot?.modes?.current ?? modes[0][0]} open={menu === "mode"} disabled={disabled || loading} placement="up-left" onToggle={() => setMenu(menu === "mode" ? null : "mode")} onSelect={(mode_id) => { onConfig({ source: "modes", agent_id: agent, mode_id }); setMenu(null); }} />}
    {settingsOptions.length > 0 && <SessionSettingsMenu ref={settingsRef} menuRef={menuRef} options={settingsOptions} open={menu === "settings"} disabled={disabled || loading} pendingConfigIds={NO_PENDING_CONFIG} onToggle={() => setMenu(menu === "settings" ? null : "settings")} onSelect={setOption} />}
    {!loading && !agents.length && !disabled && <p className="buddy-muted">No installed Agents. Install an Agent in Grove Settings.</p>}
    {!loading && selected && !snapshot && <p className="buddy-muted">Configuration options become available after this Agent connects in Grove.</p>}
    {!loading && selected && snapshot && !configOptions.length && !modes.length && <p className="buddy-muted">This Agent does not expose configuration options.</p>}
    {!loading && agent && !selected && !disabled && <p className="buddy-muted">This Agent is no longer available. Choose an installed Agent.</p>}
  </div>;
}
