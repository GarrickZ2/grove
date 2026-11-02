import { useState } from "react";
import { Edit3, Plus, Trash2 } from "lucide-react";
import type { AgentDef, InstalledSkill } from "../../api";
import { AddAgentDialog } from "../../components/Skills/AddAgentDialog";
import { AgentIcon } from "../../components/Skills/AgentIcon";
import { ConfirmDialog } from "../../components/Dialogs";
import { useSkillAgentActions } from "../../components/Skills/useSkillAgentActions";
import { useCommand } from "../../keyboard";
import { Button, Card, Toggle } from "../ui";

interface AgentsViewProps {
  agents: AgentDef[];
  installed: InstalledSkill[];
  onRefresh: () => Promise<void>;
}

/** Skill agents: where Grove installs skills, and which agents it targets. */
export function AgentsView({ agents, installed, onRefresh }: AgentsViewProps) {
  const [showAdd, setShowAdd] = useState(false);
  const [editAgent, setEditAgent] = useState<AgentDef | null>(null);
  const [removing, setRemoving] = useState<AgentDef | null>(null);
  const { togglingId, installCountByAgent, toggle, remove } = useSkillAgentActions(installed, onRefresh);

  useCommand("skills.agent.add", () => setShowAdd(true), []);

  return (
    <Card className="oex-panel oui-rise" style={{ animationDelay: "60ms" }} aria-label="Agents">
      <div className="oex-ptools">
        <span className="oex-hint oex-grow">Grove installs skills into each enabled agent’s skill folder. Turn off agents you don’t use.</span>
        <Button variant="secondary" size="sm" onClick={() => setShowAdd(true)}><Plus />Custom agent</Button>
      </div>
      <div className="oex-ag-grid oui-scroll">
        {agents.map((agent, index) => {
          const count = installCountByAgent.get(agent.id) ?? 0;
          return (
            <div key={agent.id} className={`oex-agcard${agent.enabled ? "" : " is-off"}`} style={{ animationDelay: `${Math.min(index, 16) * 25 + 60}ms` }}>
              <span className="oex-agic"><AgentIcon iconId={agent.icon_id} size={20} /></span>
              <span className="oex-agcopy">
                <b><span className="oui-truncate">{agent.display_name}</span>{agent.is_builtin ? null : <span className="oex-type">Custom</span>}</b>
                <small className="oui-mono oui-truncate" title={[agent.global_skills_dir, agent.project_skills_dir].filter(Boolean).join("  ·  ")}>{agent.global_skills_dir || agent.project_skills_dir || "No skill folder"}</small>
                <small>{count} {count === 1 ? "skill" : "skills"} installed</small>
              </span>
              {agent.is_builtin ? null : (
                <span className="oex-ractions">
                  <Button variant="ghost" iconOnly size="sm" aria-label={`Edit ${agent.display_name}`} title="Edit" onClick={() => setEditAgent(agent)}><Edit3 /></Button>
                  <Button variant="ghost" iconOnly size="sm" danger aria-label={`Remove ${agent.display_name}`} title="Remove" onClick={() => setRemoving(agent)}><Trash2 /></Button>
                </span>
              )}
              <Toggle checked={agent.enabled} disabled={togglingId === agent.id} label={`Enable ${agent.display_name}`} onChange={() => void toggle(agent.id)} />
            </div>
          );
        })}
      </div>
      <AddAgentDialog
        isOpen={showAdd || editAgent !== null}
        editingAgent={editAgent}
        onClose={() => { setShowAdd(false); setEditAgent(null); }}
        onSaved={async () => { setShowAdd(false); setEditAgent(null); await onRefresh(); }}
      />
      <ConfirmDialog
        isOpen={!!removing}
        title="Remove agent"
        message={removing ? `Remove ${removing.display_name}? Existing Skill files are not deleted.` : ""}
        confirmLabel="Remove"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={() => { const id = removing?.id; setRemoving(null); if (id) void remove(id); }}
        onCancel={() => setRemoving(null)}
      />
    </Card>
  );
}
