import type { BuddyRow, BuddyTimelineState } from "./buddyTimelineState";

/**
 * Like TaskChat, a finished turn keeps only its answer: the last assistant
 * message. Its activity line, intermediate assistant text and handled
 * approvals/questions drop out; the turn timing lives on the answer message.
 * The turn in progress stays whole so live work and pending requests remain
 * visible. Turns are bounded by user messages, including hidden prompts
 * (routines, delegation results), since each starts its own reply.
 */
export function visibleRows(state: BuddyTimelineState): BuddyRow[] {
  const isUser = (row: BuddyRow) => row.kind === "message" && state.messages[row.index]?.type === "user";
  const isAssistant = (row: BuddyRow) => row.kind === "message" && state.messages[row.index]?.type === "assistant";
  const turns: BuddyRow[][] = [[]];
  for (const row of state.rows) {
    if (isUser(row)) turns.push([row], []);
    else turns[turns.length - 1].push(row);
  }
  const lastTurn = turns.length - 1;
  return turns.flatMap((turn, index) => {
    // A quiet turn is kept from the user; only what still needs them stays.
    const quiet = turn.find(row => row.kind === "quiet");
    if (quiet) return turn.filter(row => row === quiet || ((row.kind === "approval" || row.kind === "question") && !row.resolved));
    if (index === lastTurn && state.busy) return turn;
    const answer = [...turn].reverse().find(isAssistant);
    return turn.filter(row => row.kind === "activity" ? !row.ended : isAssistant(row) ? row === answer : (row.kind !== "approval" && row.kind !== "question") || !row.resolved);
  });
}

/** What the Buddy said in a quiet turn, for whoever opens it. */
export function quietTurnText(state: BuddyTimelineState, id: string): string {
  const end = state.rows.findIndex(row => row.id === id);
  const parts: string[] = [];
  for (let at = end - 1; at >= 0; at--) {
    const row = state.rows[at];
    if (row.kind !== "message") continue;
    const message = state.messages[row.index];
    if (message?.type === "user") break;
    if (message?.type === "assistant") parts.unshift(message.content);
  }
  return parts.join("\n\n").trim();
}
