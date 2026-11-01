import type { BuddyDelegation } from "../../../api/buddies";
import { ApprovalCard } from "../timeline/ApprovalCard";
import { QuestionCard } from "../timeline/QuestionCard";
import { requestHandlers } from "../timeline/requestHandlers";
import { useBuddyDelegationsContext } from "./buddyDelegationsContext";

/** Pending requests of a waiting subagent, answered over that subagent's own session. */
export function DelegationRequestCards({ delegation, compact = false }: { delegation: BuddyDelegation; compact?: boolean }) {
  const requests = useBuddyDelegationsContext().requests[delegation.id];
  if (!requests) return null;
  const pending = requests.timeline.rows.filter(row => (row.kind === "approval" || row.kind === "question") && !row.resolved);
  if (!pending.length) return null;
  const handlers = requestHandlers(requests);
  const source = compact ? undefined : `${delegation.title} · subagent`;
  return <div className={`buddy-delegation-requests${compact ? " is-compact" : ""}`}>{pending.map(row => row.kind === "approval"
    ? <ApprovalCard key={`approval-${row.id}`} approval={row} connected={requests.connected} onRespond={handlers.respond} source={source} />
    : row.kind === "question" ? <QuestionCard key={`question-${row.id}`} question={row} connected={requests.connected} onSubmit={(answers, markdown) => handlers.answer(row, answers, markdown)} onSkip={() => handlers.skip(row)} onOpen={() => handlers.open(row)} source={source} /> : null)}</div>;
}
