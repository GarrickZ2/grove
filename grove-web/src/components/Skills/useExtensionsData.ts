import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentDef, InstalledSkill, SkillSource } from "../../api";
import { getAgentDefs, listInstalled, listSources } from "../../api";

/** Page-level Extensions data shared by the Workbench and Orbit pages:
 *  skill agents, sources and installed skills, plus their refreshers. */
export function useExtensionsData() {
  const [agents, setAgents] = useState<AgentDef[]>([]);
  const [sources, setSources] = useState<SkillSource[]>([]);
  const [installed, setInstalled] = useState<InstalledSkill[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  // Bumped after adds so the catalog reloads its artifacts.
  const [refreshToken, setRefreshToken] = useState(0);

  // Only enabled agents are used for install/display
  const enabledAgents = useMemo(() => agents.filter((a) => a.enabled), [agents]);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const [agentData, sourceData, installedData] = await Promise.all([
        getAgentDefs(),
        listSources(),
        listInstalled(),
      ]);
      setAgents(agentData);
      setSources(sourceData);
      setInstalled(installedData);
    } catch (err) {
      console.error("Failed to load skills data:", err);
    }
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void Promise.resolve().then(loadData);
  }, [loadData]);

  const refreshAgents = useCallback(async () => {
    const data = await getAgentDefs();
    setAgents(data);
  }, []);

  const refreshSources = useCallback(async () => {
    const data = await listSources();
    setSources(data);
  }, []);

  // After an install/update, both the installed set AND per-source update
  // state change (server recomputes `has_remote_updates`/`skill_count`).
  // Refresh both so "Update Available" badges clear promptly.
  const refreshAfterInstall = useCallback(async () => {
    await Promise.all([
      listInstalled().then(setInstalled),
      listSources().then(setSources),
    ]);
  }, []);

  const bumpCatalog = useCallback(() => setRefreshToken((value) => value + 1), []);

  return {
    agents, enabledAgents, sources, installed, isLoading, refreshToken,
    refreshAgents, refreshSources, refreshAfterInstall, bumpCatalog,
  };
}
