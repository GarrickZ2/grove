import type { BuddyGroup } from "../../api/buddyGroups";
import type { Buddy, BuddySummary } from "../../api/buddies";

/** What a machine's Buddies page last showed. Going to a machine rebuilds the
 *  app, so the page starts from this and refreshes, as it does between Buddies. */
export interface BuddyMachineSnapshot {
  items: BuddySummary[];
  groups: BuddyGroup[];
  detail: Buddy | null;
}

const snapshots = new Map<string, BuddyMachineSnapshot>();

export const readBuddySnapshot = (base: string) => snapshots.get(base);
export const writeBuddySnapshot = (base: string, snapshot: BuddyMachineSnapshot) => { snapshots.set(base, snapshot); };
export const clearBuddySnapshots = () => snapshots.clear();
