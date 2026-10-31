import { useState } from "react";
import { switchBuddyAgent, updateBuddy, type Buddy, type UpdateBuddyInput } from "../../../api/buddies";
import { useBuddyAgents } from "../../../hooks/useBuddyAgents";
import { errorMessage } from "../../../utils/errorMessage";
import { BuddyAgentFields } from "../BuddyAgentFields";
import { BuddyAvatarPicker } from "../BuddyAvatarPicker";
import { resolveBuddyAvatar } from "../buddyAvatarConfig";
import { buddyAgentSelection } from "../buddyAgentSelection";
import { BuddyConnects } from "./BuddyConnects";

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
  return <section className="buddy-panel-section buddy-form" aria-label="Buddy settings">
    <form className="buddy-form" onSubmit={(event) => { event.preventDefault(); void save({ name: name.trim(), role, description: role, system_prompt: prompt }); }}>
      <label>Name<input required value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>Role<input value={role} onChange={(event) => setRole(event.target.value)} /></label>
      <label>System prompt<textarea rows={4} value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label>
      <button type="submit" className="buddy-button" disabled={busy || !name.trim()}>Save details</button>
    </form>
    <h3>Agent</h3>
    <BuddyAgentFields key={buddy.agent} loading={agentsLoading} agents={agents} agent={buddy.agent} config={buddyAgentSelection(buddy, agents.find((item) => item.id === buddy.agent))} onAgent={(id) => setPendingAgent(id === buddy.agent ? null : id)} onConfig={(config) => void save({ agent_config: config })} disabled={busy || !!agentsError} agentDisabled={buddy.status !== "idle"} confirmAgentChange
      confirmation={pendingAgent && <div className="buddy-agent-confirm"><p>Switch to <strong>{pendingName}</strong>? This starts a new context. {pendingName} reads the earlier chat when it needs to. Memory, routines and IM stay as they are.</p><div className="buddy-actions"><button type="button" className="buddy-button" onClick={() => setPendingAgent(null)} disabled={busy}>Cancel</button><button type="button" className="buddy-button is-primary" disabled={busy || agentsLoading || !!agentsError || buddy.status !== "idle" || !agents.some((item) => item.id === pendingAgent)} onClick={() => void switchAgent()}>Switch to {pendingName}</button></div></div>} />
    <p className="buddy-muted">Agent settings apply now. A new Agent starts a new context.</p>
    {buddy.status !== "idle" && <p className="buddy-muted">Stop the current turn to switch Agent</p>}
    {(error || agentsError) && <p role="alert">{error || agentsError}{agentsError && <button type="button" className="buddy-button" onClick={() => void retryAgents()}>Retry Agents</button>}</p>}
    <fieldset disabled={busy}><BuddyAvatarPicker value={resolveBuddyAvatar(buddy.id, buddy.avatar)} onChange={(value) => void save({ avatar: JSON.stringify(value) })} /></fieldset>
    <BuddyConnects buddy={buddy} />
    <button type="button" className="buddy-button is-danger" onClick={onArchive}>Archive Buddy</button>
  </section>;
}
