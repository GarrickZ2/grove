import type { BuddySummary } from "../../api/buddies";
import { buildGroveMetaTag, parseGroveMetaSegments } from "../../utils/groveMeta";

/** Envelope type carrying the Buddies a message @-mentions. */
export const BUDDY_MENTIONS = "buddy_mentions";

/** The picker's stand-in for @everyone in a group. */
export const EVERYONE_ID = "everyone";

export interface MentionedBuddy { id: string; name: string; avatar: string | null; role: string }

/** The `@query` being typed at the caret, if any: where it starts and what follows the @. */
export function mentionAtCaret(text: string, caret: number): { start: number; query: string } | null {
  const match = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
  return match ? { start: caret - match[2].length - 1, query: match[2] } : null;
}

/** Buddies whose name matches what follows the @ (prefix matches first). */
export function mentionCandidates(buddies: BuddySummary[], query: string): BuddySummary[] {
  const q = query.toLowerCase();
  const scored = buddies.flatMap((buddy) => {
    const name = buddy.name.toLowerCase();
    const rank = name.startsWith(q) ? 0 : name.split(/\s+/).some((word) => word.startsWith(q)) ? 1 : name.includes(q) ? 2 : -1;
    return rank < 0 ? [] : [{ buddy, rank }];
  });
  return scored.sort((a, b) => a.rank - b.rank).map(({ buddy }) => buddy).slice(0, 8);
}

/** Buddies the text mentions as `@Name` (whole names, so "@Ada" doesn't count for "Adam"). */
export function mentionedIn(text: string, buddies: BuddySummary[]): BuddySummary[] {
  return buddies.filter((buddy) => new RegExp(`(^|\\s)@${escape(buddy.name)}(?=$|[\\s.,!?;:，。！？；：、)）])`, "iu").test(text));
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The prompt for a message that mentions other Buddies: an envelope first
 * (stripped from previews and `read_session`) telling the Agent who they
 * are and that it can reach them, then the text as typed.
 */
export function withMentions(text: string, buddies: BuddySummary[]): string {
  const mentioned = mentionedIn(text, buddies);
  if (!mentioned.length) return text;
  const data: { buddies: MentionedBuddy[] } = { buddies: mentioned.map(({ id, name, avatar, role }) => ({ id, name, avatar, role })) };
  const who = mentioned.map((buddy) => `@${buddy.name} (Buddy id ${buddy.id}${buddy.role ? `, role: ${buddy.role}` : ""})`).join("; ");
  const note = `The user mentioned ${mentioned.length > 1 ? "other Buddies" : "another Buddy"}: ${who}. They are the user's other Buddies, each with their own area; you can reach them with message_buddy when it helps.`;
  return `${buildGroveMetaTag(BUDDY_MENTIONS, data, note)}\n${text}`;
}

/** A sent message's text without the mentions envelope, and the Buddies it named. */
export function readMentions(content: string): { text: string; buddies: MentionedBuddy[] } {
  const buddies: MentionedBuddy[] = [];
  let found = false;
  const parts = parseGroveMetaSegments(content).flatMap((segment) => {
    if (segment.kind !== "meta" || segment.envelope.type !== BUDDY_MENTIONS) return [segment.kind === "text" ? segment.content : segment.raw];
    found = true;
    const listed = (segment.envelope.data as { buddies?: unknown }).buddies;
    if (Array.isArray(listed)) for (const item of listed) {
      const value = item as Partial<MentionedBuddy>;
      if (typeof value.id === "string" && typeof value.name === "string") buddies.push({ id: value.id, name: value.name, avatar: value.avatar ?? null, role: value.role ?? "" });
    }
    return [];
  });
  return { text: found ? parts.join("").replace(/^\n/, "") : content, buddies };
}

/** Split text into plain runs and `@Name` mentions of the given Buddies. */
export function mentionRuns(text: string, buddies: MentionedBuddy[]): ({ text: string } | { buddy: MentionedBuddy })[] {
  if (!buddies.length) return [{ text }];
  // Longest names first, so "@Release Captain" wins over "@Release".
  const names = [...buddies].sort((a, b) => b.name.length - a.name.length);
  const pattern = new RegExp(`@(${names.map((buddy) => escape(buddy.name)).join("|")})`, "giu");
  const runs: ({ text: string } | { buddy: MentionedBuddy })[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const buddy = names.find((item) => item.name.toLowerCase() === match[1].toLowerCase())!;
    if (match.index > last) runs.push({ text: text.slice(last, match.index) });
    runs.push({ buddy });
    last = match.index + match[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return runs;
}
