import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, Clock, File, MessageCircle, Send } from "lucide-react";
import { BuddyAvatar } from "../BuddyAvatar";
import { mentionRuns, readMentions } from "../buddyMentions";
import type { Buddy, BuddySummary } from "../../../api/buddies";
import { MarkdownRenderer } from "../../ui/MarkdownRenderer";
import { ImageLightbox } from "../../ui/ImageLightbox";
import { ApprovalCard } from "./ApprovalCard";
import { ActivityLine } from "./ActivityLine";
import { QuestionCard } from "./QuestionCard";
import { DelegationCard } from "./DelegationCard";
import { BuddyHello } from "./BuddyHello";
import { quietTurnText, visibleRows } from "./visibleRows";
import { useSentPop } from "../../Tasks/TaskView/conversation/sentPop";
import { useOrbitInterface } from "../../../orbit/ui/interfaceContext";
import { MessageActions } from "../../Tasks/TaskView/MessageActionsBar";
import type { BuddyRow, BuddyTimelineState, DelegationRow, Question } from "./buddyTimelineState";
import { useBuddyDelegationsContext } from "../delegations/buddyDelegationsContext";
import { resolveDelegationRows } from "../delegations/delegationFormat";
import { DelegationRequestCards } from "../delegations/DelegationRequestCards";
import type { SurveyAnswers } from "../../Tasks/TaskView/formPillTypes";
import { parseGroveMetaSegments } from "../../../utils/groveMeta";
import { chatBubbles, withoutApprovalNotes } from "./messageBubbles";
import { separatorLabel, timeSeparators } from "./timeSeparators";
import { DELEGATION_NOTICE, promptEvent } from "./promptEvents";
import { TimelineNotice } from "./TimelineNotice";
import { listBuddyRoutines } from "../../../api/buddyResources";
import type { Automation } from "../../../api/automations";

function AssistantBubbles({ content }: { content: string }) {
  const bubbles = useMemo(() => chatBubbles(content), [content]);
  if (!bubbles) return <MarkdownRenderer content={content} />;
  if (!bubbles.length) return null;
  return <div className="buddy-bubbles">{bubbles.map((bubble, index) => bubble.kind === "receipt"
    ? <ul key={index} className="buddy-bubble buddy-receipt">{bubble.items.map((item, line) => <li key={line}><Check size={13} aria-hidden /><span><strong>{item.label}</strong>{item.result && <> → {item.result}</>}</span></li>)}</ul>
    : <div key={index} className="buddy-bubble"><MarkdownRenderer content={bubble.content} /></div>)}</div>;
}

/** An inline image (sent or produced) that opens full size; without its data it is a file chip. */
function TimelineImage({ data, mimeType, name, onOpen }: { data?: string; mimeType: string; name: string; onOpen: (url: string) => void }) {
  if (!data) return <span className="buddy-file"><File size={14} />{name}</span>;
  const url = `data:${mimeType};base64,${data}`;
  return <button type="button" className="buddy-image" aria-label={`Open ${name}`} onClick={() => onOpen(url)}><img src={url} alt={name} loading="lazy" /></button>;
}

/** The user's bubble; under Orbit a just-sent one pops in (see sentPop). */
function UserBubble({ clientMessageId, children }: { clientMessageId?: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useSentPop(ref, clientMessageId);
  return <div ref={ref} className="buddy-user-message">{children}</div>;
}

/** A turn the Buddy kept from the user: one muted line, its words a click away. */
function QuietTurn({ reason, text }: { reason: string; text: string }) {
  const [open, setOpen] = useState(false);
  return <>
    <TimelineNotice lead="Stayed quiet" name={reason} onClick={text ? () => setOpen(!open) : undefined} label={`${open ? "Hide" : "Show"} what was left unsaid`} />
    {open && <div className="buddy-assistant-message buddy-quiet-text"><AssistantBubbles content={text} /></div>}
  </>;
}

export function BuddyTimeline({ buddy, state, connected, loading = false, onRespond, onAnswer, onSkip, onOpenQuestion, arriving = false, hasEarlier = false, loadingEarlier = false, onLoadEarlier, others = [] }: { arriving?: boolean; others?: BuddySummary[]; hasEarlier?: boolean; loadingEarlier?: boolean; onLoadEarlier?: () => void; buddy: Buddy; state: BuddyTimelineState; connected: boolean; loading?: boolean; onRespond: (id: string, option: string) => void; onAnswer: (question: Question, answers: SurveyAnswers, markdown: string) => Promise<void>; onSkip: (question: Question) => void; onOpenQuestion: (question: Question) => void }) {
  const orbit = useOrbitInterface();
  const scroll = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const delegations = useBuddyDelegationsContext();
  const resolved = useMemo(() => resolveDelegationRows(state.rows.filter((row): row is DelegationRow => row.kind === "delegation"), delegations.items), [state.rows, delegations.items]);
  const waiting = delegations.items.filter(item => item.status === "waiting" && delegations.requests[item.id]);
  useEffect(() => { if (following.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [state, waiting.length]);
  // Earlier pages load when the top comes into view. Prepending keeps the
  // distance from the bottom, so what the user was reading stays in place.
  const fromBottom = useRef<number | null>(null);
  const firstRow = state.rows[0]?.id;
  useLayoutEffect(() => {
    const node = scroll.current;
    if (node && fromBottom.current != null) node.scrollTop = node.scrollHeight - fromBottom.current;
    fromBottom.current = null;
  }, [firstRow]);
  const loadEarlier = () => {
    const node = scroll.current;
    if (!node || !hasEarlier || loadingEarlier || !onLoadEarlier) return;
    fromBottom.current = node.scrollHeight - node.scrollTop;
    onLoadEarlier();
  };
  // A short page that doesn't fill the view can't be scrolled, so fetch on.
  useEffect(() => {
    const node = scroll.current;
    if (node && !loading && hasEarlier && !loadingEarlier && node.scrollHeight <= node.clientHeight + 40) loadEarlier();
  });
  const shown = useMemo(() => visibleRows(state), [state]);
  // Routine prompts carry no name; match them against this Buddy's Routines.
  const runsRoutines = state.messages.some(message => message.type === "user" && !!message.sender?.startsWith("automation:"));
  const [routines, setRoutines] = useState<Automation[]>([]);
  const { id: buddyId, project_hash: buddyProject } = buddy;
  useEffect(() => {
    if (!runsRoutines) return;
    let live = true;
    listBuddyRoutines({ id: buddyId, project_hash: buddyProject } as Buddy).then(items => { if (live) setRoutines(items); }).catch(() => {});
    return () => { live = false; };
  }, [runsRoutines, buddyId, buddyProject]);
  const separators = useMemo(() => timeSeparators(shown, state), [shown, state]);
  // Relative times refresh when a message is hovered, as in TaskChat.
  const [now, setNow] = useState(() => Date.now());
  const touch = () => setNow(Date.now());
  const [lightbox, setLightbox] = useState<string | null>(null);
  return <div className="buddy-timeline" aria-label="Conversation" data-sent-pop-pane={orbit || undefined} ref={scroll} onScroll={event => { const node = event.currentTarget; following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80; if (node.scrollTop < 160) loadEarlier(); }}><div className="buddy-timeline-content">
    {hasEarlier && <p className="buddy-earlier" role="status">{loadingEarlier ? "Loading earlier messages…" : <button type="button" onClick={loadEarlier}>Load earlier messages</button>}</p>}
    {state.rows.length === 0 && <BuddyHello buddy={buddy} arriving={arriving && !loading} loading={loading} />}
    {shown.map(row => {
      const content = renderRow(row);
      const time = separators.get(row.id);
      return time != null && content ? <Fragment key={row.id}><p className="buddy-time-separator">{separatorLabel(time)}</p>{content}</Fragment> : content;
    })}
    {waiting.map(item => <DelegationRequestCards key={`requests-${item.id}`} delegation={item} />)}
    <ImageLightbox imageUrl={lightbox} onClose={() => setLightbox(null)} />
  </div></div>;

  function renderRow(row: BuddyRow) {
      if (row.kind === "quiet") return <QuietTurn key={row.id} reason={row.reason} text={withoutApprovalNotes(quietTurnText(state, row.id))} />;
      if (row.kind === "activity") return <ActivityLine key={row.id} activity={row} buddy={buddy} />;
      if (row.kind === "delegation") return <DelegationCard key={row.id} row={row} delegation={resolved.get(row.id)} onOpen={delegations.show} />;
      if (row.kind === "approval") return <ApprovalCard key={`approval-${row.id}`} approval={row} connected={connected} onRespond={onRespond} />;
      if (row.kind === "question") return <QuestionCard key={`question-${row.id}`} question={row} connected={connected} onSubmit={(answers, markdown) => onAnswer(row, answers, markdown)} onSkip={() => onSkip(row)} onOpen={() => onOpenQuestion(row)} />;
      if (row.kind === "event") {
        if (!row.notice) return <p className="buddy-event" key={row.id}>{row.text}</p>;
        const chat = row.id.startsWith("buddy-chat-");
        // A message to another Buddy shows who it went to by their avatar.
        const to = chat ? others.find(item => item.id === row.notice!.buddyId) ?? others.find(item => item.name === row.notice!.name || item.id === row.notice!.name) : undefined;
        const icon = to ? <BuddyAvatar id={to.id} avatar={to.avatar} size={14} /> : chat ? <Send size={13} aria-hidden="true" /> : <Clock size={13} aria-hidden="true" />;
        return <TimelineNotice key={row.id} lead={row.notice.lead} icon={icon} name={to?.name ?? row.notice.name} detail={row.notice.detail} tone={row.notice.tone} />;
      }
      const message = state.messages[row.index];
      if (message.type === "user" && message.sender && message.sender !== "connect") {
        const event = promptEvent(message.sender, message.content);
        if (event?.kind === "chat") return <TimelineNotice key={row.id} lead={event.reply ? "Reply from" : "Message from"} icon={<BuddyAvatar id={event.buddyId} avatar={event.avatar} size={14} />} name={event.name} detail={event.text} />;
        if (event?.kind === "routine") {
          const name = routines.find(routine => routine.prompt.trim() === message.content.trim())?.name;
          return <TimelineNotice key={row.id} lead="Routine ran" icon={<Clock size={13} aria-hidden="true" />} name={name} />;
        }
        if (event?.kind !== "delegation") return null;
        const title = delegations.items.find(item => item.id === event.delegationId)?.title || event.title;
        const { lead, Icon, tone } = DELEGATION_NOTICE[event.status];
        return <TimelineNotice key={row.id} lead={lead} icon={<Icon size={13} aria-hidden="true" />} name={title} tone={tone} onClick={() => delegations.show(event.delegationId)} label={`${lead}: ${title}. Show delegation`} />;
      }
      if (message.type === "user") {
        // Session bootstrap stays in the transcript, but is not user-visible text.
        const segments = parseGroveMetaSegments(message.content);
        const visible = segments.filter(segment => !(segment.kind === "meta" && segment.envelope.v === 1 && segment.envelope.type === "grove_session_init"));
        const shown = visible.length === segments.length ? message.content : visible.map(segment => segment.kind === "text" ? segment.content : segment.raw).join("").replace(/^\n+/, "");
        // @-mentioned Buddies travel in an envelope; show their names as chips instead.
        const { text: content, buddies: mentioned } = readMentions(shown);
        if (!content.trim() && !message.attachments?.length) return null;
        return <div key={row.id} className="buddy-user-turn group/message" onPointerEnter={touch}>{message.sender === "connect" && <span className="buddy-user-via"><MessageCircle size={11} aria-hidden="true" />via IM</span>}<UserBubble clientMessageId={message.clientMessageId}>{content.trim() && <p>{mentionRuns(content, mentioned).map((run, index) => "buddy" in run
          ? <span key={index} className="buddy-mention-chip" title={run.buddy.role || undefined}><BuddyAvatar id={run.buddy.id} avatar={run.buddy.avatar} size={14} />{run.buddy.name}</span>
          : run.text)}</p>}{message.attachments?.map((file, index) => file.type === "image"
          ? <TimelineImage key={index} data={file.data} mimeType={file.mimeType} name={file.name || file.label || "Image"} onOpen={setLightbox} />
          : <span className="buddy-file" key={index}><File size={14} />{file.name || file.label || file.uri?.split("/").pop() || "Attachment"}</span>)}</UserBubble><MessageActions text={content} timestamp={message.sentAt} now={now} alignRight /></div>;
      }
      if (message.type === "assistant") {
        const reply = withoutApprovalNotes(message.content);
        const media = message.blocks?.filter(block => block.type !== "text");
        if (!reply.trim() && !media?.length) return null;
        return <div key={row.id} className="buddy-assistant-message group/message" onPointerEnter={touch}><AssistantBubbles content={reply} />{media?.map((block, index) => block.type === "image"
        ? <TimelineImage key={index} data={block.data} mimeType={block.mime_type} name={block.label || "Image"} onOpen={setLightbox} />
        : <span className="buddy-file" key={index}><File size={14} />{block.type === "resource_link" ? block.name : block.type === "resource" ? block.uri : block.label || block.type}</span>)}{message.complete && message.endTs != null && <MessageActions text={reply} timestamp={message.endTs * 1000} startTs={message.startTs} endTs={message.endTs} now={now} />}</div>;
      }
      return null;
  }
}
