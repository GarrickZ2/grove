import { useBuddySession } from "../../hooks/useBuddySession";
import { useBuddyComposer } from "../../hooks/useBuddyComposer";
import type { Buddy } from "../../api/buddies";
import type { Question } from "./timeline/buddyTimelineState";
import { BuddyComposer } from "./BuddyComposer";
import { BuddyTimeline } from "./timeline/BuddyTimeline";

export function BuddyConversation({ buddy, onChanged }: { buddy: Buddy; onChanged: () => void }) {
  const session = useBuddySession(buddy);
  const current = { ...buddy, status: session.state.busy ? "working" as const : buddy.status };
  const sent = () => { session.refreshMock(); onChanged(); };
  const composer = useBuddyComposer(current, onChanged);
  const skip = (question: Question) => {
    if (question.snapshot) session.sendEvent({ type: "elicitation_response", id: question.id, action: "cancel" });
    else { session.sendEvent({ type: "ask_form_resolved", id: question.id }); session.dispatch({ type: "ask_form_resolved", id: question.id }); }
  };
  return <div className="buddy-conversation">
    {session.error && <p role="alert">{session.error}<button type="button" className="buddy-button" onClick={session.reconnect}>Reconnect</button></p>}
    <BuddyTimeline buddy={current} state={session.state} connected={session.connected} loading={session.loading}
      onRespond={(id, option) => session.sendEvent({ type: "permission_response", id, option_id: option })}
      onAnswer={async (question, answers, markdown) => {
        if (question.snapshot) { session.dispatch({ type: "buddy_answer", id: question.id, text: markdown }); session.sendEvent({ type: "elicitation_response", id: question.id, action: "accept", content: answers }); }
        else { await composer.send(markdown, []); session.sendEvent({ type: "ask_form_resolved", id: question.id }); session.dispatch({ type: "ask_form_resolved", id: question.id }); }
      }} onSkip={skip} onOpenQuestion={question => {
        const url = question.snapshot?.request.url;
        if (url && /^https?:\/\//i.test(url)) { window.open(url, "_blank", "noopener,noreferrer"); if (!question.snapshot?.opened) session.sendEvent({ type: "elicitation_response", id: question.id, action: "accept" }); }
      }} />
    <BuddyComposer buddy={current} onSent={sent} />
  </div>;
}
