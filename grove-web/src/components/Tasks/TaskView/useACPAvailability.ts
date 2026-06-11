import { useEffect, useState } from "react";
import {
  getConfig,
  listCustomAgents,
} from "../../../api";
import { listMarketplace, type MarketplaceAgent } from "../../../api/marketplace";
import {
  loadCustomAgentPersonas as loadCustomAgentPersonasIcon,
  setMarketplaceIcons,
} from "../../../utils/agentIcon";
import type {
  CustomAgentServer,
  CustomAgentPersona,
} from "../../../api";

/** Minimal availability shape consumed downstream — kept compatible with
 *  the old `BaseAgent` shape so call sites don't have to change. Derived
 *  from the marketplace response (the new single source of truth for
 *  "what's installed and launchable"). */
export interface BaseAgent {
  id: string;
  display_name: string;
  icon_id: string;
  icon_url?: string | null;
  available: boolean;
}

interface Result {
  baseAgents: BaseAgent[];
  setBaseAgents: React.Dispatch<React.SetStateAction<BaseAgent[]>>;
  customAgents: CustomAgentServer[];
  setCustomAgents: React.Dispatch<React.SetStateAction<CustomAgentServer[]>>;
  customAgentPersonas: CustomAgentPersona[];
  setCustomAgentPersonas: React.Dispatch<
    React.SetStateAction<CustomAgentPersona[]>
  >;
  acpAvailabilityLoaded: boolean;
}

function isLaunchable(a: MarketplaceAgent): boolean {
  return (
    (a.install_state === "grove-installed" ||
      a.install_state === "auto-detected") &&
    !(a.installed?.hidden ?? false)
  );
}

function toBaseAgent(a: MarketplaceAgent): BaseAgent {
  return {
    id: a.id,
    display_name: a.name,
    icon_id: a.id,
    icon_url: a.icon_url,
    available: true,
  };
}

/**
 * Loads launchable agents from the marketplace on mount, alongside Custom
 * Agent servers and personas. Replaces the old `listBaseAgents()` probe —
 * marketplace data is now the single source of truth for availability.
 */
export function useACPAvailability(): Result {
  const [baseAgents, setBaseAgents] = useState<BaseAgent[]>([]);
  const [acpAvailabilityLoaded, setAcpAvailabilityLoaded] = useState(false);
  const [customAgents, setCustomAgents] = useState<CustomAgentServer[]>([]);
  const [customAgentPersonas, setCustomAgentPersonas] = useState<
    CustomAgentPersona[]
  >([]);

  useEffect(() => {
    let cancelled = false;
    const checkAvailability = async () => {
      let marketplace: Awaited<ReturnType<typeof listMarketplace>> | null = null;
      let cfg: Awaited<ReturnType<typeof getConfig>> | null = null;
      let personas: CustomAgentPersona[] | null = null;
      let failed = false;
      try {
        [marketplace, cfg, personas] = await Promise.all([
          listMarketplace(),
          getConfig(),
          loadCustomAgentPersonasIcon(() =>
            listCustomAgents().catch(() => [] as CustomAgentPersona[]),
          ),
        ]);
      } catch (err) {
        console.warn("[TaskChat] availability check failed, fail-open:", err);
        failed = true;
      }
      if (cancelled) return;
      if (!failed && marketplace && cfg && personas) {
        // Refresh the global icon CDN map so every icon consumer (chat
        // list, Open Sessions popup, agent picker) gets the same priority:
        // bundled brand > marketplace CDN > Bot.
        setMarketplaceIcons(
          marketplace.agents.map((a) => ({ id: a.id, icon_url: a.icon_url })),
        );
        setBaseAgents(marketplace.agents.filter(isLaunchable).map(toBaseAgent));
        const customServers = cfg.acp?.custom_agents ?? [];
        setCustomAgents(customServers);
        setCustomAgentPersonas(personas);
      } else {
        // No fallback list — a stale one would show agents the backend
        // can't actually launch. Better to render empty until retry.
        setBaseAgents([]);
      }
      setAcpAvailabilityLoaded(true);
    };
    checkAvailability();
    return () => {
      cancelled = true;
    };
  }, []);

  return {
    baseAgents,
    setBaseAgents,
    customAgents,
    setCustomAgents,
    customAgentPersonas,
    setCustomAgentPersonas,
    acpAvailabilityLoaded,
  };
}
