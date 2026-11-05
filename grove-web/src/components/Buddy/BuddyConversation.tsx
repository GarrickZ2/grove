import { useEffect, useRef } from "react";
import { useBuddySession } from "../../hooks/useBuddySession";
import { useBuddyComposer } from "../../hooks/useBuddyComposer";
import type { Buddy, BuddySummary } from "../../api/buddies";
import { requestHandlers } from "./timeline/requestHandlers";
import { BuddyComposer } from "./BuddyComposer";
import { AuthRequiredPanel } from "../Tasks/TaskView/AuthRequiredPanel";
import { BuddyTimeline } from "./timeline/BuddyTimeline";
import { SentPopContext, sentPops } from "../Tasks/TaskView/conversation/sentPop";
import { useOrbitInterface } from "../../orbit/ui/interfaceContext";

const LOCAL_TASK_ID = "_local";

export function BuddyConversation({ buddy, onChanged, arriving = false, others = [], open = true }: { buddy: Buddy; onChanged: () => void; arriving?: boolean;
  /** The user's other Buddies, for @-mentions. */
  others?: BuddySummary[];
  /** False while kept alive out of sight (the collapsed mini window). */
  open?: boolean }) {
  const session = useBuddySession(buddy);
  // A connection lost out of sight (the Mac slept) comes back when it is reopened.
  const { error, reconnect } = session;
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open && !wasOpen.current && error) reconnect();
    wasOpen.current = open;
  }, [open, error, reconnect]);
  const orbit = useOrbitInterface();
  const current = { ...buddy, status: session.state.busy ? "working" as const : buddy.status };
  const sent = () => { session.refreshMock(); onChanged(); };
  const composer = useBuddyComposer(current, onChanged, session.promptCaps);
  const handlers = requestHandlers({ sendEvent: session.sendEvent, dispatch: session.dispatch, sendText: text => composer.send(text, []) });
  return <SentPopContext.Provider value={orbit ? sentPops : null}><div className="buddy-conversation">
    {session.error && <p role="alert">{session.error}<button type="button" className="buddy-button" onClick={session.reconnect}>Reconnect</button></p>}
    <BuddyTimeline others={others} arriving={arriving} hasEarlier={session.hasEarlier} loadingEarlier={session.loadingEarlier} onLoadEarlier={() => { void session.loadEarlier(); }} buddy={current} state={session.state} connected={session.connected} loading={session.loading}
      onRespond={handlers.respond} onAnswer={handlers.answer} onSkip={handlers.skip} onOpenQuestion={handlers.open} />
    {session.state.auth && <AuthRequiredPanel message={session.state.auth} index={0} agentLabel={buddy.name} projectId={buddy.project_hash} taskId={LOCAL_TASK_ID} chatId={buddy.active_session_id ?? undefined}
      onAuthLogin={(_, methodId) => {
        session.dispatch({ type: "buddy_auth_progress", method_id: methodId });
        if (session.state.auth?.methods.find((method) => method.id === methodId)?.type !== "terminal") session.sendEvent({ type: "authenticate", method_id: methodId });
      }}
      onAuthRetry={() => { session.dispatch({ type: "buddy_auth_progress" }); session.sendEvent({ type: "retry_authentication" }); }}
      onTerminalEnd={(_, message) => session.dispatch({ type: "buddy_auth_cancelled", message })} />}
    <BuddyComposer buddy={current} onSent={sent} promptCaps={session.promptCaps} mentionable={others} />
  </div></SentPopContext.Provider>;
}
