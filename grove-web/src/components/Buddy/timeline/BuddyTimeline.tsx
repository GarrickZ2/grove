import { useEffect, useRef } from "react";
import { File, MessageCircle } from "lucide-react";
import type { Buddy } from "../../../api/buddies";
import { MarkdownRenderer } from "../../ui/MarkdownRenderer";
import { ApprovalCard } from "./ApprovalCard";
import { ActivityLine } from "./ActivityLine";
import { QuestionCard } from "./QuestionCard";
import type { BuddyTimelineState, Question } from "./buddyTimelineState";
import type { SurveyAnswers } from "../../Tasks/TaskView/formPillTypes";
import { parseGroveMetaSegments } from "../../../utils/groveMeta";

export function BuddyTimeline({ buddy, state, connected, loading = false, onRespond, onAnswer, onSkip, onOpenQuestion }: { buddy: Buddy; state: BuddyTimelineState; connected: boolean; loading?: boolean; onRespond: (id: string, option: string) => void; onAnswer: (question: Question, answers: SurveyAnswers, markdown: string) => Promise<void>; onSkip: (question: Question) => void; onOpenQuestion: (question: Question) => void }) {
  const scroll = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  useEffect(() => { if (following.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [state]);
  return <div className="buddy-timeline" aria-label="Conversation" ref={scroll} onScroll={event => { const node = event.currentTarget; following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80; }}><div className="buddy-timeline-content">
    {state.rows.length === 0 && <div className="buddy-empty"><h2>{loading ? "Loading conversation…" : `Say hi to ${buddy.name}`}</h2></div>}
    {state.rows.map(row => {
      if (row.kind === "activity") return <ActivityLine key={row.id} activity={row} buddy={buddy} />;
      if (row.kind === "approval") return <ApprovalCard key={`approval-${row.id}`} approval={row} connected={connected} onRespond={onRespond} />;
      if (row.kind === "question") return <QuestionCard key={`question-${row.id}`} question={row} connected={connected} onSubmit={(answers, markdown) => onAnswer(row, answers, markdown)} onSkip={() => onSkip(row)} onOpen={() => onOpenQuestion(row)} />;
      if (row.kind === "event") return <p className="buddy-event" key={row.id}>{row.text}</p>;
      const message = state.messages[row.index];
      if (message.type === "user" && message.sender && message.sender !== "connect") return null;
      if (message.type === "user") {
        // Session bootstrap stays in the transcript, but is not user-visible text.
        const segments = parseGroveMetaSegments(message.content);
        const visible = segments.filter(segment => !(segment.kind === "meta" && segment.envelope.v === 1 && segment.envelope.type === "grove_session_init"));
        const content = visible.length === segments.length ? message.content : visible.map(segment => segment.kind === "text" ? segment.content : segment.raw).join("").replace(/^\n+/, "");
        if (!content.trim() && !message.attachments?.length) return null;
        return <div key={row.id} className="buddy-user-message">{message.sender === "connect" && <MessageCircle size={13} aria-label="IM Connect" />}{content.trim() && <p>{content}</p>}{message.attachments?.map((file, index) => <span className="buddy-file" key={index}><File size={14} />{file.name || file.label || "Attachment"}</span>)}</div>;
      }
      if (message.type === "assistant") return <div key={row.id} className="buddy-assistant-message"><MarkdownRenderer content={message.content} />{message.blocks?.filter(block => block.type !== "text").map((block, index) => <span className="buddy-file" key={index}><File size={14} />{block.type === "resource_link" ? block.name : block.type === "resource" ? block.uri : block.label || block.type}</span>)}</div>;
      return null;
    })}
  </div></div>;
}
