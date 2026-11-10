// Small wording helpers shared by the share surfaces.

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

/** "in 6 days", "in 23 hours", "in 40 minutes". */
export function untilText(at: string, now: number = Date.now()): string {
  const left = new Date(at).getTime() - now;
  if (Number.isNaN(left)) return "";
  if (left <= 0) return "now";
  if (left >= DAY) {
    const days = Math.round(left / DAY);
    return `in ${days} ${days === 1 ? "day" : "days"}`;
  }
  if (left >= HOUR) {
    const hours = Math.round(left / HOUR);
    return `in ${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  const minutes = Math.max(1, Math.round(left / 60000));
  return `in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

/** First letter of a name, for avatars ("周远" → "周", "Garrick" → "G"). */
export function initials(name: string): string {
  const trimmed = name.trim();
  return trimmed ? Array.from(trimmed)[0].toUpperCase() : "?";
}

/** Put text on the clipboard; says whether it worked. Pass a promise when the
 *  text is still being made: the clipboard is claimed right away, while the
 *  click still counts, which Safari and the macOS app need. */
export async function copyText(text: string | Promise<string>): Promise<boolean> {
  if (typeof text !== "string" && typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ "text/plain": text.then((value) => new Blob([value], { type: "text/plain" })) }),
      ]);
      return true;
    } catch {
      // Fall back to copying once the text is there.
    }
  }
  let value: string;
  try {
    value = await text;
  } catch {
    return false;
  }
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    // Older webviews without the async clipboard API.
  }
  const area = document.createElement("textarea");
  area.value = value;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

/** Plain-language reason a share can't be opened, by the code the owner's Grove sent. */
export function stateMessage(state: string | undefined, owner: string): { title: string; body: string } | null {
  switch (state) {
    case "expired":
      return { title: "This link has expired", body: `Ask ${owner || "the owner"} to share it again.` };
    case "exhausted":
      return { title: "This link was for someone else", body: `Ask ${owner || "the owner"} for your own link.` };
    case "revoked":
      return { title: `${owner || "The owner"} stopped sharing`, body: "Comments you already sent stay with them." };
    case "removed":
      return { title: "You were removed from this link", body: `Ask ${owner || "the owner"} if you still need it.` };
    case "missing":
      return { title: "This task is gone", body: `${owner || "The owner"} deleted or archived it.` };
    case "not_found":
      return { title: "This link doesn't exist", body: "Check that you copied the whole link." };
    case "offline":
      return { title: `${owner ? `${owner}'s` : "The owner's"} Grove can't be reached`, body: "You can look again once it's back online." };
    default:
      return null;
  }
}
