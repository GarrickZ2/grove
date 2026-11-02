import { useCallback, useMemo, useState } from "react";
import { deleteAgent as apiDeleteAgent, toggleAgentEnabled } from "../../api";
import type { InstalledSkill } from "../../api";

/** Installed-skill count per skill agent (each binding counts once). */
export function countInstallsByAgent(installed: InstalledSkill[]): Map<string, number> {
  const counts = new Map<string, number>();
  installed.forEach((skill) => skill.agents.forEach((binding) => counts.set(binding.agent_id, (counts.get(binding.agent_id) ?? 0) + 1)));
  return counts;
}

/** Enable/disable and remove skill agents, then refresh. */
export function useSkillAgentActions(installed: InstalledSkill[], onRefresh: () => Promise<void>) {
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const installCountByAgent = useMemo(() => countInstallsByAgent(installed), [installed]);

  const toggle = useCallback(async (agentId: string) => {
    setTogglingId(agentId);
    try {
      await toggleAgentEnabled(agentId);
      await onRefresh();
    } finally {
      setTogglingId(null);
    }
  }, [onRefresh]);

  const remove = useCallback(async (agentId: string) => {
    await apiDeleteAgent(agentId);
    await onRefresh();
  }, [onRefresh]);

  return { togglingId, installCountByAgent, toggle, remove };
}
