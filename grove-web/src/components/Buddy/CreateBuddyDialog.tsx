import { CalendarClock, X } from "lucide-react";
import type { BuddyTemplate } from "./buddyTemplates";
import { createBuddyRoutine } from "../../api/buddyResources";
import { useState } from "react";
import { useConfig } from "../../context";
import type { Buddy, BuddyAgentConfig, CreateBuddyInput } from "../../api/buddies";
import { useBuddyAgents } from "../../hooks/useBuddyAgents";
import { errorMessage } from "../../utils/errorMessage";
import { useEscapeScope } from "../../keyboard/useEscapeScope";
import { DialogShell } from "../ui/DialogShell";
import { BuddyAvatarPicker } from "./BuddyAvatarPicker";
import { BuddyAgentFields } from "./BuddyAgentFields";
import { resolveBuddyAvatar } from "./buddyAvatarConfig";
import { configForAgent } from "../../utils/agentConfig";
import { resolveAgentIcon } from "../../utils/agentIcon";
import { createClientMessageId } from "../../utils/clientMessageId";

export function CreateBuddyDialog({ onClose, onCreate, template, machine }: {
  template?: BuddyTemplate; onClose: () => void; onCreate: (input: CreateBuddyInput) => Promise<Buddy>;
  /** Creating on another machine: its Agents, shown without leaving this one. */
  machine?: { name: string; base: string };
}) {
  const { config: global } = useConfig();
  const { agents, error: agentError, loading: agentsLoading, retry: retryAgents } = useBuddyAgents(machine?.base);
  const [avatar, setAvatar] = useState(() => template?.avatar ?? resolveBuddyAvatar(createClientMessageId()));
  const [name, setName] = useState(template?.name ?? "");
  const [role, setRole] = useState(template?.role ?? "");
  const [instructions, setInstructions] = useState(template?.instructions ?? "");
  const [chosenAgent, setAgent] = useState<string | null>(null);
  const [config, setConfig] = useState<BuddyAgentConfig | null>(null);
  const [routine, setRoutine] = useState(template?.routine);
  const [created, setCreated] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preferred = global?.acp.agent_command;
  const agent = chosenAgent ?? agents.find((item) => item.id === preferred || (preferred && resolveAgentIcon(item.id).canonicalKey === resolveAgentIcon(preferred).canonicalKey))?.id ?? agents[0]?.id ?? "";
  const selectedAgent = agents.find((item) => item.id === agent);
  const selection = config?.agent_id === agent ? config : selectedAgent ? configForAgent(selectedAgent) : { source: "default" as const, agent_id: agent };
  const canCreate = !!name.trim() && !agentsLoading && !agentError && agents.some((item) => item.id === agent);
  useEscapeScope(!saving, onClose);
  const submit = async () => {
    if (saving || created || !canCreate) return;
    setSaving(true); setError(null);
    try { const buddy = await onCreate({ name: name.trim(), role, description: role, system_prompt: instructions, agent, agent_config: selection, avatar: JSON.stringify(avatar) }); setCreated(true); if (routine) { try { await createBuddyRoutine(buddy, routine); } catch (reason) { setError(`Buddy created. Routine could not be added: ${errorMessage(reason)}`); setSaving(false); return; } } onClose(); }
    catch (reason) { setError(errorMessage(reason)); setSaving(false); }
  };
  return <DialogShell isOpen onClose={() => { if (!saving) onClose(); }} maxWidth="max-w-[540px]">
    <form className="buddy-dialog buddy-form buddy-create-dialog" onSubmit={(event) => { event.preventDefault(); void submit(); }} aria-label="Create Buddy">
      <div className="buddy-dialog-heading"><h2>{machine ? `Create Buddy on ${machine.name}` : "Create Buddy"}</h2><button type="button" className="orbit-icon-button" aria-label="Close create Buddy" disabled={saving} onClick={onClose}><X size={18} /></button></div>
      <div className="buddy-create-body"><fieldset disabled={saving || created} className="buddy-form">
        <BuddyAvatarPicker value={avatar} onChange={setAvatar} />
        <label>Name<input required value={name} onChange={(event) => setName(event.target.value)} autoFocus /></label>
        <label>Role<input value={role} onChange={(event) => setRole(event.target.value)} placeholder="Keeps Grove docs in sync with what ships" /></label>
        <label>Instructions <span className="buddy-muted">(optional)</span><textarea rows={4} value={instructions} onChange={(event) => setInstructions(event.target.value)} /></label>
        <div className="buddy-field-group" role="group" aria-labelledby="create-buddy-agent-label">
          <span id="create-buddy-agent-label" className="buddy-field-label">Agent</span>
          <div className="buddy-agent-panel"><BuddyAgentFields loading={agentsLoading} disabled={!!agentError} agents={agents} agent={agent} config={selection} onAgent={(id) => { setAgent(id); setConfig(null); }} onConfig={setConfig} /></div>
          <p className="buddy-muted">Delegated work and memory upkeep use the same Agent.</p>
        </div>
        {routine && <div className="buddy-field-group" role="group" aria-labelledby="create-buddy-routine-label">
          <span id="create-buddy-routine-label" className="buddy-field-label">Routine</span>
          <div className="buddy-template-routine"><span className="buddy-template-routine-icon" aria-hidden="true"><CalendarClock size={16} /></span>
            <span className="buddy-template-routine-copy"><strong>{routine.name}</strong><small>{/^\d+ \d+ \* \* \*$/.test(routine.cron) ? `Every day at ${routine.time}` : routine.time} · from template</small></span>
            <button type="button" className="buddy-icon-button" aria-label={`Remove routine ${routine.name}`} title="Remove routine" onClick={() => setRoutine(undefined)}><X size={15} /></button>
          </div>
        </div>}
      </fieldset></div>
      {(error || agentError) && <p role="alert">{error || agentError}{agentError && <button type="button" className="buddy-button" onClick={() => void retryAgents()}>Retry Agents</button>}</p>}
      <div className="buddy-actions"><button className="buddy-button" type="button" disabled={saving} onClick={onClose}>{created ? "Done" : "Cancel"}</button><button className="buddy-button is-primary" type="submit" disabled={saving || created || !canCreate}>{saving ? "Creating…" : "Create Buddy"}</button></div>
    </form>
  </DialogShell>;
}
