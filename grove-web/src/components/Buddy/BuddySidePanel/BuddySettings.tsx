import { useState } from "react";
import { switchBuddyAgent, updateBuddy, type Buddy, type UpdateBuddyInput } from "../../../api/buddies";
import { useBuddyAgents } from "../../../hooks/useBuddyAgents";
import { errorMessage } from "../../../utils/errorMessage";
import { BuddyAgentFields } from "../BuddyAgentFields";
import { BuddyAvatarPicker } from "../BuddyAvatarPicker";
import { resolveBuddyAvatar } from "../buddyAvatarConfig";
import { buddyAgentSelection } from "../buddyAgentSelection";
import { BuddyMcpServers } from "./BuddyMcpServers";

export function BuddySettings({ buddy, onChanged, onArchive }: { buddy: Buddy; onChanged: (buddy: Buddy) => void; onArchive: () => void }) {
  const { agents, error: agentsError, loading: agentsLoading, retry: retryAgents } = useBuddyAgents();
  const [name, setName] = useState(buddy.name);
  const [role, setRole] = useState(buddy.role);
  const [prompt, setPrompt] = useState(buddy.system_prompt);
  const [pendingAgent, setPendingAgent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (input: UpdateBuddyInput) => {
    if (busy) return; setBusy(true); setError(null);
    try { onChanged(await updateBuddy(buddy.id, input)); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  };
  const switchAgent = async () => {
    if (!pendingAgent || busy || agentsLoading || agentsError || !agents.some((item) => item.id === pendingAgent)) return;
    setBusy(true); setError(null);
    try { onChanged(await switchBuddyAgent(buddy.id, { agent: pendingAgent })); setPendingAgent(null); }
    catch (reason) { setError(typeof reason === "object" && reason !== null && "status" in reason && reason.status === 409 ? "Stop the current turn to switch Agent" : errorMessage(reason)); }
    finally { setBusy(false); }
  };
  const pendingName = agents.find((agent) => agent.id === pendingAgent)?.name ?? pendingAgent;
  const dirty = name.trim() !== buddy.name || role !== buddy.role || prompt !== buddy.system_prompt;
  return <section className="buddy-panel-section buddy-settings" aria-label="Buddy settings">
    <fieldset disabled={busy} className="buddy-settings-avatar"><BuddyAvatarPicker value={resolveBuddyAvatar(buddy.id, buddy.avatar)} onChange={(value) => void save({ avatar: JSON.stringify(value) })} /></fieldset>
    <form className="buddy-form buddy-settings-group" aria-labelledby="buddy-settings-profile" onSubmit={(event) => { event.preventDefault(); void save({ name: name.trim(), role, description: role, system_prompt: prompt }); }}>
      <h3 id="buddy-settings-profile" className="buddy-field-label">Profile</h3>
      <label>Name<input required value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>Role<input value={role} onChange={(event) => setRole(event.target.value)} /></label>
      <label>Instructions <span className="buddy-muted">(optional)</span><textarea rows={4} value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label>
      {dirty && <div className="buddy-settings-save"><button type="button" className="buddy-button" disabled={busy} onClick={() => { setName(buddy.name); setRole(buddy.role); setPrompt(buddy.system_prompt); }}>Discard</button><button type="submit" className="buddy-button is-primary" disabled={busy || !name.trim()}>Save</button></div>}
    </form>
    <div className="buddy-field-group buddy-settings-group" role="group" aria-labelledby="buddy-settings-agent">
      <h3 id="buddy-settings-agent" className="buddy-field-label">Agent</h3>
      <div className="buddy-agent-panel"><BuddyAgentFields key={buddy.agent} loading={agentsLoading} agents={agents} agent={buddy.agent} config={buddyAgentSelection(buddy, agents.find((item) => item.id === buddy.agent))} onAgent={(id) => setPendingAgent(id === buddy.agent ? null : id)} onConfig={(config) => void save({ agent_config: config })} disabled={busy || !!agentsError} agentDisabled={buddy.status !== "idle"} confirmAgentChange
        confirmation={pendingAgent && <div className="buddy-agent-confirm"><p>Switch to <strong>{pendingName}</strong>? This starts a new context. {pendingName} reads the earlier chat when it needs to. Memory, routines and IM stay as they are.</p><div className="buddy-actions"><button type="button" className="buddy-button" onClick={() => setPendingAgent(null)} disabled={busy}>Cancel</button><button type="button" className="buddy-button is-primary" disabled={busy || agentsLoading || !!agentsError || buddy.status !== "idle" || !agents.some((item) => item.id === pendingAgent)} onClick={() => void switchAgent()}>Switch to {pendingName}</button></div></div>} /></div>
      {buddy.status !== "idle" && <p className="buddy-muted">Stop the current turn to switch Agent.</p>}
    </div>
    <BuddyMcpServers buddy={buddy} />
    {(error || agentsError) && <p role="alert">{error || agentsError}{agentsError && <button type="button" className="buddy-button" onClick={() => void retryAgents()}>Retry Agents</button>}</p>}
    <div className="buddy-settings-group buddy-settings-danger"><div><h3 className="buddy-field-label">Archive Buddy</h3><p className="buddy-muted">History and memory are kept.</p></div><button type="button" className="buddy-button is-danger" aria-label="Archive Buddy" onClick={onArchive}>Archive</button></div>
  </section>;
}
