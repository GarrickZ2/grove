import { useSyncExternalStore } from "react";
import { getAgentCatalogRevision, subscribeAgentCatalog } from "../api/agentCatalogChanges";
import { useRadioEvents } from "./useRadioEvents";

const callbacks = {};

/** Re-fetch Agent data after any catalog mutation or missed-event window. */
export function useAgentCatalogRevision(): number {
  // Shares the existing event socket, including on pages with no TaskChat.
  useRadioEvents(callbacks);
  return useSyncExternalStore(subscribeAgentCatalog, getAgentCatalogRevision);
}
