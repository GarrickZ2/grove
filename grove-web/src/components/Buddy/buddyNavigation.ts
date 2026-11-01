import { createContext } from "react";

export const BUDDY_NAVIGATE_EVENT = "grove-buddy-navigate";
export interface BuddyNavigationTarget { projectId: string; taskId: string; chatId: string }
/** Leaves the overlay for a session in an ordinary project. Never the Buddy's own Project: that stays inside Buddy. */
export const BuddyNavigationContext = createContext<{ interfaceName: string; navigate: (target: BuddyNavigationTarget) => Promise<void> }>({ interfaceName: "Grove", navigate: async () => {} });
