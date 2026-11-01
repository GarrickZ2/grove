import type { SurveyAnswers } from "../../Tasks/TaskView/formPillTypes";
import type { BuddyEvent, Question } from "./buddyTimelineState";

export interface RequestTarget {
  sendEvent: (event: BuddyEvent) => void;
  dispatch: (event: BuddyEvent) => void;
  /** Sends an ask_form answer as an ordinary user message to the asking session. */
  sendText: (text: string) => Promise<void>;
}

export interface RequestHandlers {
  respond: (id: string, option: string) => void;
  answer: (question: Question, answers: SurveyAnswers, markdown: string) => Promise<void>;
  skip: (question: Question) => void;
  open: (question: Question) => void;
}

/** Permission, ask_form and elicitation responses for whichever session raised the request. */
export function requestHandlers(target: RequestTarget): RequestHandlers {
  const resolveForm = (id: string) => { target.sendEvent({ type: "ask_form_resolved", id }); target.dispatch({ type: "ask_form_resolved", id }); };
  return {
    respond: (id, option) => target.sendEvent({ type: "permission_response", id, option_id: option }),
    answer: async (question, answers, markdown) => {
      if (question.snapshot) { target.dispatch({ type: "buddy_answer", id: question.id, text: markdown }); target.sendEvent({ type: "elicitation_response", id: question.id, action: "accept", content: answers }); }
      else { await target.sendText(markdown); resolveForm(question.id); }
    },
    skip: question => {
      if (question.snapshot) target.sendEvent({ type: "elicitation_response", id: question.id, action: "cancel" });
      else resolveForm(question.id);
    },
    open: question => {
      const url = question.snapshot?.request.url;
      if (!url || !/^https?:\/\//i.test(url)) return;
      window.open(url, "_blank", "noopener,noreferrer");
      if (!question.snapshot?.opened) target.sendEvent({ type: "elicitation_response", id: question.id, action: "accept" });
    },
  };
}
