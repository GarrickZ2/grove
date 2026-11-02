import { createContext, useContext } from "react";

/**
 * Whether the conversation renders its Orbit (desktop) presentation. False by
 * default, so Workbench, phones and anything outside TaskChat keep their
 * existing markup.
 */
export const OrbitConversationContext = createContext(false);

export function useOrbitConversation(): boolean {
  return useContext(OrbitConversationContext);
}
