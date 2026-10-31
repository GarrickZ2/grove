import { createContext } from "react";
import type { Buddy } from "../../api/buddies";

export const BUDDY_NAVIGATE_EVENT = "grove-buddy-navigate";
export const BuddyNavigationContext = createContext<{ interfaceName: string; navigate: (page: "tasks" | "memory", buddy: Buddy) => Promise<void> }>({ interfaceName: "Orbit", navigate: async () => {} });
