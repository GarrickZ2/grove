import { createContext } from "react";
import type { BuddySummary } from "../../api/buddies";
export const BuddyLaunchContext = createContext({ items: [] as BuddySummary[], open: (_id?: string, _create?: boolean) => { void _id; void _create; } });
