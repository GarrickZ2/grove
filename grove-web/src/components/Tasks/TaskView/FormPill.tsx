import { blankAnswer, buildSubmittedMarkdown, answerValue, validationError, type LocalAnswer } from "./surveyAnswers";
/**
 * FormPill — body of the `ask_form` composer panel.
 *
 * Rendered inside TaskChat's composer panel (the same area that hosts the
 * permission / auth / plan panels), not in the chat message stream. The chat
 * stream only shows a chip the user can click to toggle this panel open.
 * Submit ships a markdown body via `onSubmit`; Cancel just dismisses the form
 * locally (no message sent to the agent).
 *
 * Layout (4 lines, per user spec):
 *   L1: [icon] Survey title           [Cancel] [Submit]
 *   L2: Question N of M: <title>      [Prev]   [Next]
 *   L3: question.description (small muted, optional)
 *   L4: question controls
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ListChecks,
  Send,
  Star,
  X,
} from "lucide-react";
import { Button } from "../../ui";
import type {
  AskFormDefinition,
  FormQuestionDef,
  SurveyAnswers,
} from "./formPillTypes";

/* ────────────────── Local answer state ───────────────────────────────── */

/* ────────────────── Component ────────────────────────────────────────── */

interface Props {
  definition: AskFormDefinition;
  onSubmit: (result: { answers: SurveyAnswers; markdown: string }) => void;
  onDismiss: () => void;
  onDecline?: () => void;
  agentName?: string;
  requestMessage?: string;
  disabled?: boolean;
  externalError?: string;
  onChange?: () => void;
}

export function FormPill({
  definition,
  onSubmit,
  onDismiss,
  onDecline,
  agentName,
  requestMessage,
  disabled = false,
  externalError,
  onChange,
}: Props) {
  const [currentTab, setCurrentTab] = useState(0);
  const [answers, setAnswers] = useState<Record<string, LocalAnswer>>(() => {
    const init: Record<string, LocalAnswer> = {};
    for (const q of definition.questions) init[q.id] = blankAnswer(q);
    return init;
  });
  const [error, setError] = useState<string | null>(null);

  const completedRef = useRef(false);
  useEffect(() => {
    if (externalError) completedRef.current = false;
  }, [externalError]);
  const fireSubmit = useCallback(
    (result: { answers: SurveyAnswers; markdown: string }) => {
      if (completedRef.current) return;
      completedRef.current = true;
      onSubmit(result);
    },
    [onSubmit],
  );
  const fireDismiss = useCallback(() => {
    if (completedRef.current) return;
    completedRef.current = true;
    onDismiss();
  }, [onDismiss]);
  const fireDecline = useCallback(() => {
    if (completedRef.current || !onDecline) return;
    completedRef.current = true;
    onDecline();
  }, [onDecline]);

  const total = definition.questions.length;
  const currentQuestion = definition.questions[currentTab];
  const onPrev = () => setCurrentTab((i) => Math.max(0, i - 1));
  const onNext = () => setCurrentTab((i) => Math.min(total - 1, i + 1));
  const isLast = currentTab >= total - 1;

  const updateAnswer = useCallback((id: string, next: LocalAnswer) => {
    setAnswers((prev) => ({ ...prev, [id]: next }));
    setError(null);
    onChange?.();
  }, [onChange]);

  const onSubmitClick = useCallback(() => {
    const nextError = validationError(definition, answers);
    setError(nextError);
    if (nextError) return;
    const values: SurveyAnswers = {};
    for (const question of definition.questions) {
      const value = answerValue(question, answers[question.id]);
      if (value !== undefined) values[question.id] = value;
    }
    fireSubmit({
      answers: values,
      markdown: buildSubmittedMarkdown(definition, answers),
    });
  }, [definition, answers, fireSubmit]);

  /** Enter advances to the next question, or submits on the last one.
   *  Form controls (textarea / input / select) are skipped so Enter inside
   *  them keeps native behavior — newline in textarea, "confirm" in inputs
   *  used for free-text "Custom" answers, etc. */
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== "Enter" || e.shiftKey || e.metaKey || e.ctrlKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return;
      e.preventDefault();
      if (isLast) {
        onSubmitClick();
      } else {
        setCurrentTab((i) => Math.min(total - 1, i + 1));
      }
    },
    [isLast, onSubmitClick, total],
  );

  return (
    <div className="space-y-3" onKeyDown={onKeyDown}>
      {/* Line 1: Survey title + Cancel / Submit */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <ListChecks className="w-4 h-4 text-[var(--color-highlight)] shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-semibold text-[var(--color-text)] truncate">
              {agentName ? `${agentName} requests information` : definition.title}
            </div>
            {agentName && <div className="text-xs text-[var(--color-text-muted)] truncate">{definition.title}</div>}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button variant="ghost" size="sm" disabled={disabled} onClick={fireDismiss}>
            <X className="w-3.5 h-3.5 mr-1" /> Cancel
          </Button>
          {onDecline && (
            <Button variant="ghost" size="sm" disabled={disabled} onClick={fireDecline}>
              Decline
            </Button>
          )}
          <Button variant="primary" size="sm" disabled={disabled} onClick={onSubmitClick}>
            <Send className="w-3.5 h-3.5 mr-1" /> Submit
          </Button>
        </div>
      </div>

      {requestMessage && (
        <p className="text-xs text-[var(--color-text-muted)] whitespace-pre-wrap break-words">
          {requestMessage}
        </p>
      )}
      {definition.description && definition.description !== requestMessage && (
        <p className="text-xs text-[var(--color-text-muted)] whitespace-pre-wrap break-words">
          {definition.description}
        </p>
      )}

      {(error || externalError) && (
        <p className="text-xs text-[var(--color-error)]" role="alert">{error || externalError}</p>
      )}

      {currentQuestion && (
        <>
          {/* Line 2: Question N of M: title + Prev / Next */}
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0 leading-snug">
              <span className="text-xs text-[var(--color-text-muted)]">
                Question {currentTab + 1} of {total}:
              </span>{" "}
              <span className="text-[15px] font-semibold text-[var(--color-text)]">
                {currentQuestion.title}
              </span>
              {currentQuestion.required && (
                <span className="ml-1 text-xs font-medium text-[var(--color-error)]">Required</span>
              )}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <Button
                variant="ghost"
                size="sm"
                onClick={onPrev}
                disabled={currentTab === 0}
              >
                <ChevronLeft className="w-3.5 h-3.5 mr-1" /> Prev
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={onNext}
                disabled={isLast}
              >
                Next <ChevronRight className="w-3.5 h-3.5 ml-1" />
              </Button>
            </div>
          </div>

          {/* Line 3: question.description (optional) */}
          {currentQuestion.description && (
            <p className="text-xs text-[var(--color-text-muted)] whitespace-pre-wrap break-words">
              {currentQuestion.description}
            </p>
          )}

          {/* Line 4: controls */}
          <div>
            <QuestionControls
              question={currentQuestion}
              answer={answers[currentQuestion.id]}
              onChange={(next) => updateAnswer(currentQuestion.id, next)}
            />
          </div>
        </>
      )}
    </div>
  );
}

/* ────────────────── Per-type controls ─────────────────────────────────── */

interface ControlProps {
  question: FormQuestionDef;
  answer: LocalAnswer;
  onChange: (next: LocalAnswer) => void;
}

function QuestionControls({ question, answer, onChange }: ControlProps) {
  switch (question.type) {
    case "single_choice":
      return (
        <SingleChoiceControl
          question={question}
          answer={answer as Extract<LocalAnswer, { type: "single_choice" }>}
          onChange={onChange}
        />
      );
    case "multi_choice":
      return (
        <MultiChoiceControl
          question={question}
          answer={answer as Extract<LocalAnswer, { type: "multi_choice" }>}
          onChange={onChange}
        />
      );
    case "text": {
      const a = answer as Extract<LocalAnswer, { type: "text" }>;
      return (
        <input
          type={question.inputType ?? "text"}
          value={a.value}
          onChange={(e) => onChange({ type: "text", value: e.target.value })}
          required={question.required}
          minLength={question.minLength}
          maxLength={question.maxLength}
          className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-highlight)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-highlight)_20%,transparent)] transition-colors"
        />
      );
    }
    case "textarea": {
      const a = answer as Extract<LocalAnswer, { type: "textarea" }>;
      return (
        <textarea
          value={a.value}
          onChange={(e) =>
            onChange({ type: "textarea", value: e.target.value })
          }
          rows={4}
          required={question.required}
          minLength={question.minLength}
          maxLength={question.maxLength}
          className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-highlight)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-highlight)_20%,transparent)] resize-y transition-colors"
        />
      );
    }
    case "number": {
      const a = answer as Extract<LocalAnswer, { type: "number" }>;
      return (
        <input
          type="number"
          value={a.value}
          onChange={(e) => onChange({ type: "number", value: e.target.value })}
          required={question.required}
          step={question.integer ? 1 : "any"}
          min={question.minimum}
          max={question.maximum}
          className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text)] focus:outline-none focus:border-[var(--color-highlight)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--color-highlight)_20%,transparent)] transition-colors"
        />
      );
    }
    case "rating": {
      const a = answer as Extract<LocalAnswer, { type: "rating" }>;
      return (
        <div className="flex items-center gap-1.5">
          {[1, 2, 3, 4, 5].map((n) => {
            const filled = n <= a.value;
            return (
              <button
                key={n}
                type="button"
                onClick={() =>
                  onChange({
                    type: "rating",
                    value: a.value === n ? 0 : n,
                  })
                }
                className="p-1 rounded-md hover:bg-[var(--color-bg)] transition-colors"
                aria-label={`${n} of 5`}
              >
                <Star
                  className={`w-5 h-5 transition-colors ${
                    filled
                      ? "text-[var(--color-warning)] fill-[var(--color-warning)]"
                      : "text-[var(--color-text-muted)]"
                  }`}
                />
              </button>
            );
          })}
          {a.value > 0 && (
            <span className="ml-2 text-xs font-medium text-[var(--color-text-muted)]">
              {a.value}/5
            </span>
          )}
        </div>
      );
    }
    case "boolean": {
      const a = answer as Extract<LocalAnswer, { type: "boolean" }>;
      return (
        <div className="flex items-center gap-2">
          {[
            { v: true, label: "Yes" },
            { v: false, label: "No" },
          ].map(({ v, label }) => {
            const active = a.value === v;
            return (
              <button
                key={label}
                type="button"
                onClick={() => onChange({ type: "boolean", value: v })}
                className={`px-4 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                  active
                    ? "bg-[var(--color-highlight)] text-white border-[var(--color-highlight)]"
                    : "bg-[var(--color-bg)] text-[var(--color-text)] border-[var(--color-border)] hover:border-[color-mix(in_srgb,var(--color-highlight)_60%,var(--color-border))]"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      );
    }
  }
}

/* ────────────────── Choice controls (Custom inline) ──────────────────── */

function SingleChoiceControl({
  question,
  answer,
  onChange,
}: {
  question: Extract<FormQuestionDef, { type: "single_choice" }>;
  answer: Extract<LocalAnswer, { type: "single_choice" }>;
  onChange: (next: LocalAnswer) => void;
}) {
  const selectCustom = () =>
    onChange({
      type: "single_choice",
      selectedOption: null,
      useCustom: true,
      customText: answer.customText,
    });

  return (
    <fieldset className="flex flex-col gap-1.5 border-0 p-0 m-0 min-w-0">
      <legend className="sr-only">{question.title}</legend>
      {question.options.map((opt) => {
        const active = answer.selectedOption === opt.id && !answer.useCustom;
        return (
          <label
            key={opt.id}
            className={`flex items-start gap-3 px-3.5 py-2.5 rounded-xl border cursor-pointer transition-all ${
              active
                ? "border-[var(--color-highlight)] bg-[color-mix(in_srgb,var(--color-highlight)_10%,transparent)] ring-2 ring-[color-mix(in_srgb,var(--color-highlight)_18%,transparent)]"
                : "border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-[color-mix(in_srgb,var(--color-bg)_50%,transparent)] hover:border-[color-mix(in_srgb,var(--color-highlight)_50%,var(--color-border))] hover:bg-[var(--color-bg-tertiary)]"
            }`}
          >
            <input
              type="radio"
              name={`form-${question.id}`}
              checked={active}
              onChange={() =>
                onChange({
                  type: "single_choice",
                  selectedOption: opt.id,
                  useCustom: false,
                  customText: answer.customText,
                })
              }
              className="mt-0.5 w-4 h-4 accent-[var(--color-highlight)] cursor-pointer shrink-0"
            />
            <div className="min-w-0 flex-1 text-sm text-[var(--color-text)]">
              <div className="leading-snug font-medium">{opt.label}</div>
              {opt.description && (
                <div className="mt-0.5 text-xs text-[var(--color-text-muted)] whitespace-pre-wrap break-words">
                  {opt.description}
                </div>
              )}
            </div>
          </label>
        );
      })}
      {question.allowCustom !== false && <label
        className={`flex items-center gap-3 px-3.5 py-2.5 rounded-xl border cursor-text transition-all ${
          answer.useCustom
            ? "border-[var(--color-highlight)] bg-[color-mix(in_srgb,var(--color-highlight)_10%,transparent)] ring-2 ring-[color-mix(in_srgb,var(--color-highlight)_18%,transparent)]"
            : "border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-[color-mix(in_srgb,var(--color-bg)_50%,transparent)] hover:border-[color-mix(in_srgb,var(--color-highlight)_50%,var(--color-border))] hover:bg-[var(--color-bg-tertiary)]"
        }`}
      >
        <input
          type="radio"
          name={`form-${question.id}`}
          checked={answer.useCustom}
          onChange={selectCustom}
          className="w-4 h-4 accent-[var(--color-highlight)] cursor-pointer shrink-0"
        />
        <span className="text-sm font-medium text-[var(--color-text)] shrink-0">
          Custom
        </span>
        <input
          type="text"
          value={answer.customText}
          onChange={(e) =>
            onChange({
              type: "single_choice",
              selectedOption: null,
              useCustom: true,
              customText: e.target.value,
            })
          }
          onFocus={() => {
            if (!answer.useCustom) selectCustom();
          }}
          placeholder="Type your answer"
          className="flex-1 min-w-0 bg-transparent border-0 outline-none text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] py-0.5"
        />
      </label>}
    </fieldset>
  );
}

function MultiChoiceControl({
  question,
  answer,
  onChange,
}: {
  question: Extract<FormQuestionDef, { type: "multi_choice" }>;
  answer: Extract<LocalAnswer, { type: "multi_choice" }>;
  onChange: (next: LocalAnswer) => void;
}) {
  const toggle = (id: string) => {
    const has = answer.selectedOptions.includes(id);
    const next = has
      ? answer.selectedOptions.filter((x) => x !== id)
      : [...answer.selectedOptions, id];
    onChange({ ...answer, selectedOptions: next });
  };

  return (
    <fieldset className="flex flex-col gap-1.5 border-0 p-0 m-0 min-w-0">
      <legend className="sr-only">{question.title}</legend>
      {question.options.map((opt) => {
        const checked = answer.selectedOptions.includes(opt.id);
        return (
          <label
            key={opt.id}
            className={`flex items-start gap-3 px-3.5 py-2.5 rounded-xl border cursor-pointer transition-all ${
              checked
                ? "border-[var(--color-highlight)] bg-[color-mix(in_srgb,var(--color-highlight)_10%,transparent)] ring-2 ring-[color-mix(in_srgb,var(--color-highlight)_18%,transparent)]"
                : "border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-[color-mix(in_srgb,var(--color-bg)_50%,transparent)] hover:border-[color-mix(in_srgb,var(--color-highlight)_50%,var(--color-border))] hover:bg-[var(--color-bg-tertiary)]"
            }`}
          >
            <input
              type="checkbox"
              checked={checked}
              onChange={() => toggle(opt.id)}
              className="mt-0.5 w-4 h-4 accent-[var(--color-highlight)] cursor-pointer shrink-0"
            />
            <div className="min-w-0 flex-1 text-sm text-[var(--color-text)]">
              <div className="leading-snug font-medium">{opt.label}</div>
              {opt.description && (
                <div className="mt-0.5 text-xs text-[var(--color-text-muted)] whitespace-pre-wrap break-words">
                  {opt.description}
                </div>
              )}
            </div>
          </label>
        );
      })}
      {question.allowCustom !== false && <label
        className={`flex items-center gap-3 px-3.5 py-2.5 rounded-xl border cursor-text transition-all ${
          answer.useCustom
            ? "border-[var(--color-highlight)] bg-[color-mix(in_srgb,var(--color-highlight)_10%,transparent)] ring-2 ring-[color-mix(in_srgb,var(--color-highlight)_18%,transparent)]"
            : "border-[color-mix(in_srgb,var(--color-border)_60%,transparent)] bg-[color-mix(in_srgb,var(--color-bg)_50%,transparent)] hover:border-[color-mix(in_srgb,var(--color-highlight)_50%,var(--color-border))] hover:bg-[var(--color-bg-tertiary)]"
        }`}
      >
        <input
          type="checkbox"
          checked={answer.useCustom}
          onChange={(e) =>
            onChange({ ...answer, useCustom: e.target.checked })
          }
          className="w-4 h-4 accent-[var(--color-highlight)] cursor-pointer shrink-0"
        />
        <span className="text-sm font-medium text-[var(--color-text)] shrink-0">
          Custom
        </span>
        <input
          type="text"
          value={answer.customText}
          onChange={(e) =>
            onChange({
              ...answer,
              useCustom: true,
              customText: e.target.value,
            })
          }
          onFocus={() => {
            if (!answer.useCustom) onChange({ ...answer, useCustom: true });
          }}
          placeholder="Type your answer"
          className="flex-1 min-w-0 bg-transparent border-0 outline-none text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] py-0.5"
        />
      </label>}
    </fieldset>
  );
}
