import { useEffect, useState } from "react";
import {
  listBaseAgents,
  getConfig,
  listCustomAgents,
} from "../../../api";
import { loadCustomAgentPersonas as loadCustomAgentPersonasIcon } from "../../../utils/agentIcon";
import { agentOptions } from "../../../data/agents";
import type {
  BaseAgent,
  CustomAgentServer,
  CustomAgentPersona,
} from "../../../api";

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

/**
 * Loads ACP agent availability from the backend on mount and exposes the
 * results. Pulled out of TaskChat so its captured-mutable `cancelled` flag
 * lives in a small hook React Compiler analyzes independently.
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
      let agents: BaseAgent[] | null = null;
      let cfg: Awaited<ReturnType<typeof getConfig>> | null = null;
      let personas: CustomAgentPersona[] | null = null;
      let failed = false;
      try {
        [agents, cfg, personas] = await Promise.all([
          listBaseAgents(),
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
      if (!failed && agents && cfg && personas) {
        setBaseAgents(agents);
        const customServers = cfg.acp?.custom_agents ?? [];
        setCustomAgents(customServers);
        setCustomAgentPersonas(personas);
      } else {
        const fallback = agentOptions
          .filter((opt) => opt.acpCheck)
          .map((opt) => ({
            id: opt.id,
            display_name: opt.label,
            icon_id: opt.id,
            available: true,
          }));
        setBaseAgents(fallback);
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
