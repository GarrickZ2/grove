// Window events and list helpers shared by the share surfaces.

import type { ReceivedShare } from "../../api/shares";

/** Ask Grove to open a share link (from a paste, the palette, a deep link). */
export function openShareLink(url: string) {
  window.dispatchEvent(new CustomEvent("grove:open-share", { detail: { url } }));
}

/** Tell the sidebar the list of shares changed. */
export function sharedListChanged() {
  window.dispatchEvent(new CustomEvent("grove:shared-changed"));
}

const DEAD = new Set(["expired", "exhausted", "revoked", "removed", "missing", "not_found", "join"]);

/** How a share opened here is doing, from the owner's latest answer. */
export function receivedStatus(share: ReceivedShare): "live" | "offline" | "dead" {
  const state = share.live?.state;
  if (state && DEAD.has(state)) return "dead";
  return state === "active" ? "live" : "offline";
}

/** Whether the owner did something since this share was last looked at. */
export function hasNews(share: ReceivedShare): boolean {
  const activity = share.live?.activityAt;
  return !!activity && !!share.seenAt && activity > share.seenAt;
}
