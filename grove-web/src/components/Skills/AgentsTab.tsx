import { useMemo, useState } from "react";
import { Edit3, Folder, FolderGit2, Plus, Search, Trash2 } from "lucide-react";
import { Button, Switch } from "../ui";
import { ConfirmDialog } from "../Dialogs";
import { AgentIcon } from "./AgentIcon";
import { AddAgentDialog } from "./AddAgentDialog";
import { TableEmpty } from "./ExtensionTable";
import { deleteAgent as apiDeleteAgent, toggleAgentEnabled } from "../../api";
import type { AgentDef, InstalledSkill } from "../../api";
import { useCommand } from "../../keyboard";

interface AgentsTabProps {
  agents: AgentDef[];
  installed: InstalledSkill[];
  onRefresh: () => Promise<void>;
}

export function AgentsTab({ agents, installed, onRefresh }: AgentsTabProps) {
  const [search, setSearch] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [editAgent, setEditAgent] = useState<AgentDef | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<AgentDef | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const installCountByAgent = useMemo(() => {
    const counts = new Map<string, number>();
    installed.forEach((skill) => skill.agents.forEach((binding) => counts.set(binding.agent_id, (counts.get(binding.agent_id) ?? 0) + 1)));
    return counts;
  }, [installed]);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return agents.filter((agent) => !query
      || agent.display_name.toLowerCase().includes(query)
      || agent.id.toLowerCase().includes(query)
      || agent.global_skills_dir.toLowerCase().includes(query)
      || agent.project_skills_dir.toLowerCase().includes(query));
  }, [agents, search]);

  const toggle = async (agentId: string) => {
    setTogglingId(agentId);
    try {
      await toggleAgentEnabled(agentId);
      await onRefresh();
    } finally {
      setTogglingId(null);
    }
  };

  const remove = async () => {
    if (!deleteConfirm) return;
    const id = deleteConfirm.id;
    setDeleteConfirm(null);
    await apiDeleteAgent(id);
    await onRefresh();
  };

  useCommand("skills.agent.add", () => setShowAdd(true), []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-4 flex items-center gap-3">
        <div className="relative min-w-0 max-w-2xl flex-1"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-text-muted)]" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search agents or skill folders" className="h-9 w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] pl-9 pr-3 text-sm outline-none focus:border-[var(--color-highlight)]" /></div>
        <span className="ml-auto text-xs tabular-nums text-[var(--color-text-muted)]">{visible.length} agent{visible.length === 1 ? "" : "s"}</span>
        <Button variant="primary" size="sm" onClick={() => setShowAdd(true)}><Plus className="h-4 w-4 sm:mr-1.5" /><span className="hidden sm:inline">Add agent</span></Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {visible.length === 0 ? <TableEmpty title="No agents found" description="Try another search." /> : <div className="grid grid-cols-1 gap-3 pb-1 sm:grid-cols-[repeat(auto-fill,minmax(340px,1fr))]">
          {visible.map((agent) => (
            <article key={agent.id} className={`group rounded-xl border bg-[var(--color-bg)] p-4 transition-colors ${agent.enabled ? "border-[var(--color-highlight)]/20 hover:border-[var(--color-highlight)]/40" : "border-[var(--color-border)] hover:border-[var(--color-text-muted)]/40"}`}>
              <div className="flex items-start gap-3">
                <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${agent.enabled ? "bg-[var(--color-highlight)]/10" : "bg-[var(--color-bg-secondary)]"}`}><AgentIcon iconId={agent.icon_id} size={24} /></span>
                <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><h3 className="truncate text-sm font-semibold text-[var(--color-text)]">{agent.display_name}</h3>{!agent.is_builtin && <span className="rounded bg-[var(--color-bg-secondary)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-text-muted)]">Custom</span>}</div><p className="mt-0.5 truncate font-mono text-[10px] text-[var(--color-text-muted)]">{agent.id}</p></div>
                <Switch checked={agent.enabled} onChange={() => void toggle(agent.id)} disabled={togglingId === agent.id} label={`${agent.enabled ? "Disable" : "Enable"} ${agent.display_name}`} />
              </div>

              <div className="mt-4 space-y-2 rounded-lg bg-[var(--color-bg-secondary)]/55 px-3 py-2.5">
                <FolderPath icon={Folder} label="Global" value={agent.global_skills_dir} />
                <FolderPath icon={FolderGit2} label="Project" value={agent.project_skills_dir} />
              </div>

              <div className="mt-3 flex items-center justify-between">
                <span className="text-xs text-[var(--color-text-muted)]"><strong className="font-semibold tabular-nums text-[var(--color-text)]">{installCountByAgent.get(agent.id) ?? 0}</strong> installed Skills</span>
                {!agent.is_builtin && <div className="flex items-center gap-1"><button type="button" onClick={() => setEditAgent(agent)} aria-label={`Edit ${agent.display_name}`} className="rounded-md p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text)]"><Edit3 className="h-3.5 w-3.5" /></button><button type="button" onClick={() => setDeleteConfirm(agent)} aria-label={`Remove ${agent.display_name}`} className="rounded-md p-1.5 text-[var(--color-text-muted)] hover:bg-[var(--color-error)]/10 hover:text-[var(--color-error)]"><Trash2 className="h-3.5 w-3.5" /></button></div>}
              </div>
            </article>
          ))}
        </div>}
      </div>

      <AddAgentDialog isOpen={showAdd || editAgent !== null} editingAgent={editAgent} onClose={() => { setShowAdd(false); setEditAgent(null); }} onSaved={async () => { setShowAdd(false); setEditAgent(null); await onRefresh(); }} />
      <ConfirmDialog isOpen={!!deleteConfirm} title="Remove agent" message={deleteConfirm ? `Remove ${deleteConfirm.display_name}? Existing Skill files are not deleted.` : ""} confirmLabel="Remove" cancelLabel="Cancel" variant="danger" onConfirm={() => void remove()} onCancel={() => setDeleteConfirm(null)} />
    </div>
  );
}

function FolderPath({ icon: Icon, label, value }: { icon: typeof Folder; label: string; value: string }) {
  return <div className="grid grid-cols-[16px_48px_minmax(0,1fr)] items-center gap-2"><Icon className="h-3.5 w-3.5 text-[var(--color-text-muted)]" /><span className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">{label}</span><span className={`truncate font-mono text-[11px] ${value ? "text-[var(--color-text-secondary)]" : "italic text-[var(--color-text-muted)]"}`} title={value || undefined}>{value || "Not configured"}</span></div>;
}
