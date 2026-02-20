import { useState } from "react";
import { motion } from "framer-motion";
import { Plus, Trash2, Edit3 } from "lucide-react";
import { Button } from "../ui";
import { AgentIcon } from "./AgentIcon";
import { AddAgentDialog } from "./AddAgentDialog";
import { toggleAgentEnabled, deleteAgent as apiDeleteAgent } from "../../api";
import type { AgentDef } from "../../api";

interface AgentsTabProps {
  agents: AgentDef[];
  onRefresh: () => Promise<void>;
}

export function AgentsTab({ agents, onRefresh }: AgentsTabProps) {
  const [showAdd, setShowAdd] = useState(false);
  const [editAgent, setEditAgent] = useState<AgentDef | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const enabledCount = agents.filter((a) => a.enabled).length;

  const handleToggle = async (agentId: string) => {
    setTogglingId(agentId);
    try {
      await toggleAgentEnabled(agentId);
      await onRefresh();
    } catch (err) {
      console.error("Toggle failed:", err);
    } finally {
      setTogglingId(null);
    }
  };

  const handleDelete = async (agentId: string) => {
    try {
      await apiDeleteAgent(agentId);
      await onRefresh();
    } catch (err) {
      console.error("Delete failed:", err);
    }
  };

  const handleSaved = async () => {
    setShowAdd(false);
    setEditAgent(null);
    await onRefresh();
  };

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-[var(--color-text)]">Agents</h2>
          <p className="text-sm text-[var(--color-text-muted)] mt-0.5">
            {enabledCount} of {agents.length} agents enabled. Skills will be installed to enabled agents.
          </p>
        </div>
        <Button variant="primary" size="sm" onClick={() => setShowAdd(true)}>
          <Plus className="w-4 h-4 mr-1.5" />
          Add Custom Agent
        </Button>
      </div>

      {/* Agent List */}
      <div className="space-y-1">
        {agents.map((agent) => (
          <motion.div
            key={agent.id}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            className={`flex items-center gap-4 px-4 py-3 rounded-lg border transition-colors ${
              agent.enabled
                ? "border-[var(--color-border)] bg-[var(--color-bg-secondary)]"
                : "border-transparent bg-[var(--color-bg-secondary)]/50 opacity-60"
            }`}
          >
            {/* Icon */}
            <div className="w-8 h-8 flex items-center justify-center flex-shrink-0">
              <AgentIcon iconId={agent.icon_id} size={24} />
            </div>

            {/* Info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-[var(--color-text)]">
                  {agent.display_name}
                </span>
                {!agent.is_builtin && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-[var(--color-info)]/10 text-[var(--color-info)]">
                    Custom
                  </span>
                )}
              </div>
              <div className="flex gap-4 mt-0.5">
                <span className="text-[10px] text-[var(--color-text-muted)] font-mono truncate">
                  Global: {agent.global_skills_dir}
                </span>
                <span className="text-[10px] text-[var(--color-text-muted)] font-mono truncate">
                  Project: {agent.project_skills_dir}
                </span>
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-2 flex-shrink-0">
              {!agent.is_builtin && (
                <>
                  <motion.button
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    onClick={() => setEditAgent(agent)}
                    title="Edit"
                    className="p-1.5 rounded-md hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                  </motion.button>
                  <motion.button
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    onClick={() => handleDelete(agent.id)}
                    title="Remove"
                    className="p-1.5 rounded-md hover:bg-[var(--color-error)]/10 text-[var(--color-text-muted)] hover:text-[var(--color-error)] transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </motion.button>
                </>
              )}

              {/* Toggle */}
              <button
                onClick={() => handleToggle(agent.id)}
                disabled={togglingId === agent.id}
                className={`relative w-10 h-5.5 rounded-full transition-colors duration-200 ${
                  agent.enabled
                    ? "bg-[var(--color-highlight)]"
                    : "bg-[var(--color-bg-tertiary)] border border-[var(--color-border)]"
                } disabled:opacity-50`}
                style={{ minWidth: 40, height: 22 }}
              >
                <motion.div
                  animate={{ x: agent.enabled ? 20 : 2 }}
                  transition={{ type: "spring", stiffness: 500, damping: 30 }}
                  className={`absolute top-[2px] w-[18px] h-[18px] rounded-full ${
                    agent.enabled ? "bg-white" : "bg-[var(--color-text-muted)]"
                  }`}
                />
              </button>
            </div>
          </motion.div>
        ))}
      </div>

      {/* Add / Edit Dialog */}
      <AddAgentDialog
        isOpen={showAdd || editAgent !== null}
        editingAgent={editAgent}
        onClose={() => { setShowAdd(false); setEditAgent(null); }}
        onSaved={handleSaved}
      />
    </div>
  );
}
