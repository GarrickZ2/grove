import { ArrowUpRight, CircleAlert, CircleCheck, CircleSlash, CircleX, type LucideIcon } from "lucide-react";
import type { BuddyDelegationStatus } from "../../../api/buddies";
import { parseGroveMetaSegments } from "../../../utils/groveMeta";

// Prompts Grove sends a Buddy on its own (a subagent reporting back, a
// Routine firing) stay hidden as text, but mark where a new reply begins so
// two answers don't read as one.
export type PromptEvent =
  | { kind: "delegation"; delegationId: string; title: string; status: BuddyDelegationStatus }
  | { kind: "routine" }
  /** Another Buddy messaging this one (`reply` when it answers this Buddy's message). */
  | { kind: "chat"; buddyId: string; name: string; avatar?: string | null; text: string; reply: boolean };

const STATUSES: BuddyDelegationStatus[] = ["running", "waiting", "done", "failed", "cancelled"];

export function promptEvent(sender: string | undefined, content: string): PromptEvent | null {
  if (sender?.startsWith("automation:")) return { kind: "routine" };
  if (!sender?.startsWith("buddy:")) return null;
  for (const segment of parseGroveMetaSegments(content)) {
    if (segment.kind !== "meta" || segment.envelope.type !== "buddy_message") continue;
    const data = segment.envelope.data as { delegation_id?: unknown; status?: unknown; chat?: unknown; buddy_id?: unknown; name?: unknown; avatar?: unknown; reply_to?: unknown };
    if (data.chat === true) {
      const text = parseGroveMetaSegments(content).filter(part => part.kind === "text").map(part => part.content).join("").trim();
      return { kind: "chat", buddyId: String(data.buddy_id ?? ""), name: typeof data.name === "string" ? data.name : "Buddy", avatar: typeof data.avatar === "string" ? data.avatar : null, text, reply: typeof data.reply_to === "string" && !!data.reply_to };
    }
    if (typeof data.delegation_id !== "string") return null;
    const status = STATUSES.find(item => item === data.status) ?? "running";
    // Follow-ups read `Follow-up <title>: "<status>"`; titles may contain colons.
    const title = content.match(/^Follow-up (.+): "[a-z_]+"$/m)?.[1] ?? "Delegated work";
    return { kind: "delegation", delegationId: data.delegation_id, title, status };
  }
  return null;
}

export type NoticeTone = "neutral" | "success" | "warning" | "error";

export const DELEGATION_NOTICE: Record<BuddyDelegationStatus, { lead: string; Icon: LucideIcon; tone: NoticeTone }> = {
  done: { lead: "Subagent finished", Icon: CircleCheck, tone: "success" },
  waiting: { lead: "Subagent needs you", Icon: CircleAlert, tone: "warning" },
  failed: { lead: "Subagent failed", Icon: CircleX, tone: "error" },
  cancelled: { lead: "Subagent cancelled", Icon: CircleSlash, tone: "neutral" },
  running: { lead: "Update from subagent", Icon: ArrowUpRight, tone: "neutral" },
};
