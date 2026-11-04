import type { ChatReadOnly } from "../../../../api";

/** What to tell the user about a read-only Session, in the voice of its cause. */
export function readOnlyCopy(readonly: ChatReadOnly, agentName: string): { title: string; detail: string } {
  if (readonly.reason === "imported") {
    const source = typeof readonly.meta?.source === "string" ? readonly.meta.source : null;
    return {
      title: source ? `Imported from ${source}` : "Imported session",
      detail: "The history came across, but the agent's session stayed behind.",
    };
  }
  return {
    title: `${agentName} no longer has this session`,
    detail: "The history is still here, but the agent can't pick it up again.",
  };
}
