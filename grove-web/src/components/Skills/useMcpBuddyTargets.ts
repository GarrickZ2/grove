import { useEffect, useState } from "react";
import { listBuddies } from "../../api/buddies";

/** A Buddy as an MCP binding target. `id` is the stored binding key. */
export interface McpBuddyTarget {
  id: string;
  buddyId: string;
  name: string;
  avatar: string | null;
}

export function mcpBuddyTargetId(buddyId: string): string {
  return `buddy:${buddyId}`;
}

/** Buddies are optional targets: a failed load hides the scope instead of
 *  blocking Agent access. */
export function useMcpBuddyTargets(): McpBuddyTarget[] {
  const [targets, setTargets] = useState<McpBuddyTarget[]>([]);
  useEffect(() => {
    let active = true;
    void listBuddies()
      .then((buddies) => {
        if (!active) return;
        setTargets(
          buddies.map((buddy) => ({
            id: mcpBuddyTargetId(buddy.id),
            buddyId: buddy.id,
            name: buddy.name,
            avatar: buddy.avatar,
          })),
        );
      })
      .catch(() => {
        if (active) setTargets([]);
      });
    return () => {
      active = false;
    };
  }, []);
  return targets;
}
