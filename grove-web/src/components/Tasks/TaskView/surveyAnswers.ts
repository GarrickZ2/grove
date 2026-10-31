import type { AskFormDefinition, FormQuestionDef } from "./formPillTypes";

export type LocalAnswer =
  | {
      type: "single_choice";
      selectedOption: string | null;
      useCustom: boolean;
      customText: string;
    }
  | {
      type: "multi_choice";
      selectedOptions: string[];
      useCustom: boolean;
      customText: string;
    }
  | { type: "text"; value: string }
  | { type: "textarea"; value: string }
  | { type: "number"; value: string }
  | { type: "rating"; value: number }
  | { type: "boolean"; value: boolean | null };

export function blankAnswer(q: FormQuestionDef): LocalAnswer {
  switch (q.type) {
    case "single_choice":
      return {
        type: "single_choice",
        selectedOption: q.default ?? null,
        useCustom: false,
        customText: "",
      };
    case "multi_choice":
      return {
        type: "multi_choice",
        selectedOptions: q.default ?? [],
        useCustom: false,
        customText: "",
      };
    case "text":
      return { type: "text", value: q.default ?? "" };
    case "textarea":
      return { type: "textarea", value: q.default ?? "" };
    case "number":
      return { type: "number", value: q.default?.toString() ?? "" };
    case "rating":
      return { type: "rating", value: 0 };
    case "boolean":
      return { type: "boolean", value: q.default ?? null };
  }
}

export function isAnswered(a: LocalAnswer): boolean {
  switch (a.type) {
    case "single_choice":
      return !!a.selectedOption || (a.useCustom && a.customText.trim() !== "");
    case "multi_choice":
      return (
        a.selectedOptions.length > 0 ||
        (a.useCustom && a.customText.trim() !== "")
      );
    case "text":
    case "textarea":
    case "number":
      return a.value.trim() !== "";
    case "rating":
      return a.value > 0;
    case "boolean":
      return a.value !== null;
  }
}

/* ────────────────── Markdown serialization (Submit only) ─────────────── */

function flattenLine(text: string): string {
  // Keep the prompt readable: collapse newlines (LF/CR) so a single answer
  // stays on its own line. No markdown bolding / italics — LLMs don't gain
  // anything from those tags and they add visual noise for the human reader
  // too.
  return text.replace(/[\r\n]+/g, " ");
}

export function answerToText(
  q: FormQuestionDef,
  a: LocalAnswer | undefined,
): string {
  if (!a || !isAnswered(a)) return "(skipped)";
  switch (a.type) {
    case "single_choice": {
      if (a.useCustom && a.customText.trim() !== "") {
        return `${flattenLine(a.customText.trim())} (custom)`;
      }
      if (q.type === "single_choice" && a.selectedOption) {
        const opt = q.options.find((o) => o.id === a.selectedOption);
        return opt ? flattenLine(opt.label) : a.selectedOption;
      }
      return "(skipped)";
    }
    case "multi_choice": {
      if (q.type !== "multi_choice") return "(skipped)";
      const labels = a.selectedOptions.map((id) => {
        const opt = q.options.find((o) => o.id === id);
        return opt ? flattenLine(opt.label) : id;
      });
      if (a.useCustom && a.customText.trim() !== "") {
        labels.push(`${flattenLine(a.customText.trim())} (custom)`);
      }
      return labels.length > 0 ? labels.join(", ") : "(skipped)";
    }
    case "text":
    case "textarea":
    case "number":
      return a.value.trim() === "" ? "(skipped)" : flattenLine(a.value.trim());
    case "rating":
      return a.value > 0 ? `${a.value}/5` : "(skipped)";
    case "boolean":
      if (a.value === true) return "Yes";
      if (a.value === false) return "No";
      return "(skipped)";
  }
}

export function buildSubmittedMarkdown(
  def: AskFormDefinition,
  answers: Record<string, LocalAnswer>,
): string {
  const lines: string[] = [];
  lines.push(`Here are my answers to ${flattenLine(def.title)}:`);
  lines.push("");
  def.questions.forEach((q, i) => {
    const ans = answerToText(q, answers[q.id]);
    lines.push(`${i + 1}. ${flattenLine(q.title)}: ${ans}`);
  });
  return lines.join("\n");
}

export function answerValue(
  q: FormQuestionDef,
  answer: LocalAnswer | undefined,
): string | number | boolean | string[] | undefined {
  if (!answer || !isAnswered(answer)) return undefined;
  switch (answer.type) {
    case "single_choice":
      return answer.useCustom ? answer.customText.trim() : answer.selectedOption ?? undefined;
    case "multi_choice": {
      const values = [...answer.selectedOptions];
      if (answer.useCustom && answer.customText.trim()) values.push(answer.customText.trim());
      return values;
    }
    case "text":
    case "textarea":
      if (q.type === "text" && q.inputType === "datetime-local") {
        const date = new Date(answer.value);
        return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
      }
      return answer.value;
    case "number": {
      const value = q.type === "number" && q.integer
        ? Number.parseInt(answer.value, 10)
        : Number(answer.value);
      return Number.isFinite(value) ? value : undefined;
    }
    case "rating":
      return answer.value;
    case "boolean":
      return answer.value ?? undefined;
  }
}

export function validationError(
  definition: AskFormDefinition,
  answers: Record<string, LocalAnswer>,
): string | null {
  for (const q of definition.questions) {
    const answer = answers[q.id];
    if (q.required && (!answer || !isAnswered(answer))) return `${q.title} is required.`;
    if (!answer || !isAnswered(answer)) continue;
    if ((q.type === "text" || q.type === "textarea") && (answer.type === "text" || answer.type === "textarea")) {
      if (q.minLength != null && answer.value.length < q.minLength) return `${q.title} is too short.`;
      if (q.maxLength != null && answer.value.length > q.maxLength) return `${q.title} is too long.`;
      if (q.inputType === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(answer.value)) {
        return `${q.title} must be a valid email address.`;
      }
      if (q.inputType === "url") {
        try {
          new URL(answer.value);
        } catch {
          return `${q.title} must be a valid URL.`;
        }
      }
      if (q.inputType === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(answer.value)) {
        return `${q.title} must be a valid date.`;
      }
      if (q.inputType === "datetime-local" && Number.isNaN(new Date(answer.value).getTime())) {
        return `${q.title} must be a valid date and time.`;
      }
    }
    if (q.type === "number" && answer.type === "number") {
      const value = Number(answer.value);
      if (!Number.isFinite(value) || q.integer && !Number.isInteger(value)) return `${q.title} must be a valid ${q.integer ? "integer" : "number"}.`;
      if (q.minimum != null && value < q.minimum) return `${q.title} must be at least ${q.minimum}.`;
      if (q.maximum != null && value > q.maximum) return `${q.title} must be at most ${q.maximum}.`;
    }
    if (q.type === "multi_choice" && answer.type === "multi_choice") {
      const count = answer.selectedOptions.length + (answer.useCustom && answer.customText.trim() ? 1 : 0);
      if (q.minItems != null && count < q.minItems) return `Select at least ${q.minItems} options for ${q.title}.`;
      if (q.maxItems != null && count > q.maxItems) return `Select at most ${q.maxItems} options for ${q.title}.`;
    }
  }
  return null;
}

