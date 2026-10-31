import { useCallback } from "react";
import { listInstalledAgentConfigs } from "../api/marketplace";
import { useAgentCatalogRevision } from "./useAgentCatalogRevision";
import { useBuddyResource } from "./useBuddyResource";

/** Existing installed-Agent API stays live even while Buddy REST is mocked. */
export function useBuddyAgents() {
  const revision = useAgentCatalogRevision();
  const load = useCallback(() => { void revision; return listInstalledAgentConfigs(); }, [revision]);
  const { data, error, loading, refresh } = useBuddyResource(load);
  return { agents: data ?? [], error, loading, retry: refresh };
}
