import type { BuddyGroupMessage } from "../../../api/buddyGroups";

export type GroupRow =
  | { kind: "user" | "buddy"; id: string; message: BuddyGroupMessage }
  | { kind: "system"; id: string; seq: number; text: string; buddyId: string | null; joined: boolean }
  | { kind: "failed"; id: string; buddyId: string; name: string }
  | { kind: "quiet"; id: string; names: string[]; nobodyReplied: boolean };

const isSpeech = (message?: BuddyGroupMessage) => message?.sender_kind === "user" || message?.sender_kind === "buddy";

/** What the log shows: runs of quiet turns fold into one line, and when nobody answered the user, that line says so. */
export function groupRows(messages: BuddyGroupMessage[], nameOf: (id: string) => string, anyoneWorking: boolean): GroupRow[] {
  const rows: GroupRow[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index], id = `seq-${message.seq}`;
    if (message.sender_kind === "quiet") {
      const start = index;
      while (messages[index + 1]?.sender_kind === "quiet") index++;
      const run = messages.slice(start, index + 1), last = index === messages.length - 1;
      const names = [...new Set(run.map((item) => nameOf(item.sender_id ?? "")))];
      const unanswered = messages[start - 1]?.sender_kind === "user" && messages[index + 1]?.sender_kind !== "buddy";
      rows.push({ kind: "quiet", id, names, nobodyReplied: unanswered && !(last && anyoneWorking) });
    } else if (message.sender_kind === "failed") rows.push({ kind: "failed", id, buddyId: message.sender_id ?? "", name: nameOf(message.sender_id ?? "") });
    else if (isSpeech(message)) rows.push({ kind: message.sender_kind as "user" | "buddy", id, message });
    else rows.push({ kind: "system", id, seq: message.seq, text: message.text, buddyId: message.sender_id, joined: message.text.endsWith(" joined") });
  }
  return rows;
}

export const quietText = (row: Extract<GroupRow, { kind: "quiet" }>) =>
  row.nobodyReplied ? `Nobody replied · ${row.names.join(", ")} stayed quiet` : `${row.names.join(", ")} stayed quiet`;

/** The latest reply in a group since `since`, and how many others came with it. */
export function latestGroupReply(messages: { sender_kind: string; sender_id: string | null; text: string; created_at: string }[], since: string | null, nameOf: (id: string) => string) {
  const replies = messages.filter((message) => message.sender_kind === "buddy" && (!since || Date.parse(message.created_at) > Date.parse(since)));
  const latest = replies.at(-1);
  return latest ? { text: `${nameOf(latest.sender_id ?? "")}: ${latest.text}`, more: replies.length - 1 } : null;
}
