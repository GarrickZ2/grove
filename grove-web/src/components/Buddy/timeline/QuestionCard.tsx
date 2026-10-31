import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { elicitationToSurvey, type SurveyAnswers } from "../../Tasks/TaskView/formPillTypes";
import { blankAnswer, answerValue, buildSubmittedMarkdown, validationError, type LocalAnswer } from "../../Tasks/TaskView/surveyAnswers";
import type { Question } from "./buddyTimelineState";

export function QuestionCard({ question, connected, onSubmit, onSkip, onOpen }: { question: Question; connected: boolean; onSubmit: (answers: SurveyAnswers, markdown: string) => Promise<void>; onSkip: () => void; onOpen: () => void }) {
  const definition = question.definition ?? (question.snapshot ? elicitationToSurvey(question.snapshot) : null);
  const [answers, setAnswers] = useState<Record<string, LocalAnswer>>(() => Object.fromEntries((definition?.questions ?? []).map(q => [q.id, blankAnswer(q)])));
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  if (question.resolved) return null;
  const change = (id: string, answer: LocalAnswer) => { setAnswers(previous => ({ ...previous, [id]: answer })); setError(null); };
  const submit = async () => {
    if (!definition || sending) return;
    const invalid = validationError(definition, answers); setError(invalid); if (invalid) return;
    setSending(true);
    try { const values: SurveyAnswers = {}; for (const q of definition.questions) { const value = answerValue(q, answers[q.id]); if (value !== undefined) values[q.id] = value; } await onSubmit(values, buildSubmittedMarkdown(definition, answers)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not send answers."); }
    finally { setSending(false); }
  };
  if (!definition) return <section className="buddy-card"><h3>{question.snapshot?.request.message || "Information requested"}</h3><button type="button" className="buddy-button" disabled={!connected} onClick={onOpen}><ExternalLink size={14} />{question.snapshot?.opened ? "Open again" : "Open request"}</button><button type="button" className="buddy-button" disabled={!connected} onClick={onSkip}>Cancel</button></section>;
  return <form className="buddy-card buddy-question" aria-label={definition.title} onSubmit={event => { event.preventDefault(); void submit(); }}><h3>{definition.title}</h3>{definition.description && <p>{definition.description}</p>}
    <fieldset disabled={!connected || sending}>{definition.questions.map(q => {
      const answer = answers[q.id] ?? blankAnswer(q);
      return <div key={q.id} className="buddy-question-field"><label htmlFor={`buddy-question-${question.id}-${q.id}`}>{q.title}{q.required ? " *" : ""}</label>{q.description && <small>{q.description}</small>}
        {(q.type === "single_choice" || q.type === "multi_choice") && (answer.type === "single_choice" || answer.type === "multi_choice") ? <><div className="buddy-choices" role="group" aria-label={q.title}>{q.options.map(option => <button type="button" key={option.id} aria-pressed={answer.type === "single_choice" ? answer.selectedOption === option.id : answer.selectedOptions.includes(option.id)} onClick={() => change(q.id, answer.type === "single_choice" ? { ...answer, selectedOption: option.id, useCustom: false } : { ...answer, selectedOptions: answer.selectedOptions.includes(option.id) ? answer.selectedOptions.filter(id => id !== option.id) : [...answer.selectedOptions, option.id] })}>{option.label}</button>)}</div>{q.allowCustom && <input aria-label={`${q.title}: custom answer`} placeholder="Custom answer" value={answer.customText} onChange={e => change(q.id, { ...answer, useCustom: !!e.target.value, customText: e.target.value })} />}</>
        : answer.type === "boolean" ? <div className="buddy-choices">{[true, false].map(value => <button type="button" key={String(value)} aria-pressed={answer.value === value} onClick={() => change(q.id, { ...answer, value })}>{value ? "Yes" : "No"}</button>)}</div>
        : answer.type === "rating" ? <div className="buddy-choices">{[1, 2, 3, 4, 5].map(value => <button type="button" key={value} aria-label={`${q.title}: ${value}`} aria-pressed={answer.value === value} onClick={() => change(q.id, { ...answer, value })}>{value}</button>)}</div>
        : answer.type === "textarea" ? <textarea id={`buddy-question-${question.id}-${q.id}`} value={answer.value} onChange={e => change(q.id, { ...answer, value: e.target.value })} />
        : answer.type === "text" || answer.type === "number" ? <input id={`buddy-question-${question.id}-${q.id}`} type={q.type === "number" ? "number" : q.type === "text" ? q.inputType ?? "text" : "text"} step={q.type === "number" && q.integer ? 1 : "any"} value={answer.value} required={q.required} onChange={e => change(q.id, { ...answer, value: e.target.value })} /> : null}
      </div>;
    })}</fieldset>
    {(error || question.error) && <p role="alert">{error || question.error}</p>}<div className="buddy-actions">{!definition.questions.some(q => q.required) && <button type="button" className="buddy-button" disabled={!connected || sending} onClick={onSkip}>Skip</button>}<button type="submit" className="buddy-button is-primary" disabled={!connected || sending}>{sending ? "Sending…" : "Send"}</button></div>
  </form>;
}
