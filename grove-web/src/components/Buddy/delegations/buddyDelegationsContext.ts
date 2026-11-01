import { createContext, useContext } from "react";
import type { BuddyDelegation } from "../../../api/buddies";
import type { DelegationRequests } from "../../../hooks/useBuddyDelegations";

export interface BuddyDelegationsValue {
  items: BuddyDelegation[];
  error: string | null;
  requests: Record<string, DelegationRequests>;
  cancel: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
  /** Opens the Delegations tab with this item expanded. */
  show: (id: string) => void;
  focused: string | null;
}

export const BuddyDelegationsContext = createContext<BuddyDelegationsValue>({ items: [], error: null, requests: {}, cancel: async () => {}, refresh: async () => {}, show: () => {}, focused: null });
export const useBuddyDelegationsContext = () => useContext(BuddyDelegationsContext);
