import { createContext } from "react";

/** Opens a child session from inside the transcript; absent where there is no Subagents panel. */
export const SubagentLinkContext = createContext<{ open: (sessionId: string) => void; titles: ReadonlyMap<string, string> } | null>(null);
