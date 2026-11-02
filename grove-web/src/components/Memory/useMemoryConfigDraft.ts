import { useCallback, useEffect, useMemo, useState } from "react";
import { useBanner } from "../../context";
import { agentOptions, type AgentOption } from "../../data/agents";
import { type MemoryConfig, type MemoryConfigInput, updateMemoryConfig } from "../../api/memory";
import type { InstalledAgentConfig } from "../../api/marketplace";
import { configForAgent, reconcileAgentConfig } from "../../utils/agentConfig";
import { errorMessage } from "./memoryFormat";
import { configToDraft, sameMemoryConfig } from "./memoryModel";

interface MemoryConfigDraftOptions {
  projectId: string;
  config: MemoryConfig | null;
  agents: InstalledAgentConfig[];
  agentsLoading: boolean;
  agentsError: string | null;
  onSaved: (config: MemoryConfig) => void;
}

/** Editable copy of a project's Memory settings, reconciled with installed Agents. */
export function useMemoryConfigDraft({ projectId, config, agents, agentsLoading, agentsError, onSaved }: MemoryConfigDraftOptions) {
  const [draft, setDraft] = useState<MemoryConfigInput>(() => configToDraft(config));
  const [saving, setSaving] = useState(false);
  const { showBanner } = useBanner();

  useEffect(() => {
    const next = configToDraft(config);
    void Promise.resolve().then(() => setDraft(next));
  }, [config]);

  useEffect(() => {
    if (agents.length === 0) return;
    void Promise.resolve().then(() => setDraft((current) => {
      const agentId = current.agent_config.agent_id;
      const agent = agents.find((candidate) => candidate.id === agentId) ?? (
        !agentId && !config ? agents[0] : undefined
      );
      if (!agent) return current;
      return {
        ...current,
        agent_config: agentId
          ? reconcileAgentConfig(current.agent_config, agent)
          : configForAgent(agent),
      };
    }));
  }, [agents, config]);

  useEffect(() => {
    if (agentsError) {
      showBanner(`Could not load installed Agents: ${agentsError}`, "error", 5000);
    }
  }, [agentsError, showBanner]);

  useEffect(() => {
    if (!agentsLoading && !agentsError && agents.length === 0) {
      showBanner(
        "No installed Agent is available. Install and run an Agent once so Grove can learn its configuration capabilities.",
        "error",
        5000,
      );
    }
  }, [agents, agentsError, agentsLoading, showBanner]);

  const savedDraft = useMemo(() => {
    const saved = configToDraft(config);
    const agent = agents.find((candidate) => candidate.id === saved.agent_config.agent_id);
    if (agent) saved.agent_config = reconcileAgentConfig(saved.agent_config, agent);
    return saved;
  }, [agents, config]);
  const isDirty = useMemo(() => !sameMemoryConfig(draft, savedDraft), [draft, savedDraft]);

  const selectedAgentId = draft.agent_config.agent_id ?? "";
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId);
  const options = selectedAgent?.capability_snapshot?.config_options ?? [];
  const modes = selectedAgent?.capability_snapshot?.modes?.available ?? [];
  const installedAgentOptions = useMemo<AgentOption[]>(() => agents.map((agent) => {
    const metadata = agentOptions.find((option) => option.id === agent.id || option.value === agent.id);
    return {
      ...metadata,
      id: agent.id,
      value: agent.id,
      label: agent.name,
    };
  }), [agents]);

  const chooseAgent = useCallback((agentId: string) => {
    const agent = agents.find((item) => item.id === agentId);
    setDraft((current) => ({ ...current, agent_config: agent ? configForAgent(agent) : { source: "default" } }));
  }, [agents]);

  /** Saves `input` (the current draft by default). Resolves true on success; `quiet` skips the success banner. */
  const save = async (input: MemoryConfigInput = draft, quiet = false) => {
    if (input.enabled && !input.agent_config.agent_id) {
      showBanner("Choose an installed Agent first.", "error", 5000);
      return false;
    }
    setSaving(true);
    try {
      const next = await updateMemoryConfig(projectId, input);
      onSaved(next);
      if (!quiet) showBanner("Memory settings saved.", "success");
      return true;
    } catch (reason) {
      showBanner(errorMessage(reason), "error", 5000);
      return false;
    } finally {
      setSaving(false);
    }
  };

  return {
    draft, setDraft, savedDraft, isDirty, saving, save,
    selectedAgentId, selectedAgent, options, modes, installedAgentOptions, chooseAgent,
  };
}

export type MemoryConfigDraftState = ReturnType<typeof useMemoryConfigDraft>;
