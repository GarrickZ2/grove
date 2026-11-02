import { useEffect, useState } from "react";
import { invalidateAgentCatalog } from "../../api/agentCatalogChanges";
import { listMarketplace, type MarketplaceAgent } from "../../api/marketplace";
import { useConfig } from "../../context";
import { useAgentCatalogRevision } from "../../hooks/useAgentCatalogRevision";
import { setMarketplaceIcons } from "../../utils/agentIcon";

export interface DetectedAgent {
  id: string;
  name: string;
  /** Key for `agentIconComponent`. */
  icon: string;
}

export type AgentDetection =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; agents: DetectedAgent[] };

/** Same rule the agent pickers use: installed by Grove or found on PATH, and not hidden. */
export function isLaunchable(agent: MarketplaceAgent): boolean {
  return (agent.install_state === "grove-installed" || agent.install_state === "auto-detected")
    && !(agent.installed?.hidden ?? false);
}

/**
 * The coding agents Grove can launch right now: marketplace agents that are
 * installed or detected, plus Custom Agent servers from the config. Reloads
 * whenever the agent catalog changes (an install, a PATH rescan, focus).
 */
export function useDetectedAgents(): { detection: AgentDetection; checking: boolean; recheck: () => void } {
  const revision = useAgentCatalogRevision();
  const { config } = useConfig();
  const [result, setResult] = useState<{ revision: number; marketplace: MarketplaceAgent[] | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    listMarketplace()
      .then((response) => {
        if (cancelled) return;
        setMarketplaceIcons(response.agents.map((agent) => ({ id: agent.id, icon_url: agent.icon_url })));
        setResult({ revision, marketplace: response.agents });
      })
      .catch(() => { if (!cancelled) setResult({ revision, marketplace: null }); });
    return () => { cancelled = true; };
  }, [revision]);

  let detection: AgentDetection;
  // A result for an older revision still shows (no flicker back to "Looking…" on refocus).
  if (!result) detection = { status: "loading" };
  else if (!result.marketplace) detection = { status: "error" };
  else {
    const custom = (config?.acp?.custom_agents ?? []).map((server) => ({ id: server.id, name: server.name, icon: server.id }));
    detection = {
      status: "ready",
      agents: [...result.marketplace.filter(isLaunchable).map((agent) => ({ id: agent.id, name: agent.name, icon: agent.id })), ...custom],
    };
  }
  return { detection, checking: !!result && result.revision !== revision, recheck: invalidateAgentCatalog };
}
