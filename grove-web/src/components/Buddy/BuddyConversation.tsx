import { useBuddySession } from "../../hooks/useBuddySession";
import { useBuddyComposer } from "../../hooks/useBuddyComposer";
import type { Buddy } from "../../api/buddies";
import { requestHandlers } from "./timeline/requestHandlers";
import { BuddyComposer } from "./BuddyComposer";
import { BuddyTimeline } from "./timeline/BuddyTimeline";

export function BuddyConversation({ buddy, onChanged, arriving = false }: { buddy: Buddy; onChanged: () => void; arriving?: boolean }) {
  const session = useBuddySession(buddy);
  const current = { ...buddy, status: session.state.busy ? "working" as const : buddy.status };
  const sent = () => { session.refreshMock(); onChanged(); };
  const composer = useBuddyComposer(current, onChanged);
  const handlers = requestHandlers({ sendEvent: session.sendEvent, dispatch: session.dispatch, sendText: text => composer.send(text, []) });
  return <div className="buddy-conversation">
    {session.error && <p role="alert">{session.error}<button type="button" className="buddy-button" onClick={session.reconnect}>Reconnect</button></p>}
    <BuddyTimeline arriving={arriving} hasEarlier={session.hasEarlier} loadingEarlier={session.loadingEarlier} onLoadEarlier={() => { void session.loadEarlier(); }} buddy={current} state={session.state} connected={session.connected} loading={session.loading}
      onRespond={handlers.respond} onAnswer={handlers.answer} onSkip={handlers.skip} onOpenQuestion={handlers.open} />
    <BuddyComposer buddy={current} onSent={sent} />
  </div>;
}
