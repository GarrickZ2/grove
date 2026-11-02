import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, ArrowUpRight, Bell, CheckCircle2, MessageCircleQuestion, ShieldAlert, X } from "lucide-react";
import { Button, Card, shortAgo } from "../ui";
import { labelFor, type PermissionOption } from "../../utils/permissionOptions";
import type { NeedsYouItem, NeedsYouKind } from "./dashboardModel";
import type { InlineForm } from "./usePendingForms";

const KIND_ICON: Record<NeedsYouKind, typeof Bell> = {
  permission: ShieldAlert,
  input: MessageCircleQuestion,
  critical: AlertTriangle,
  warn: AlertTriangle,
  notice: CheckCircle2,
};

const COLLAPSE = { duration: 0.38, ease: [0.25, 1, 0.5, 1] } as const;

interface NeedsYouCardProps {
  items: NeedsYouItem[];
  now: number;
  onAnswer: (item: NeedsYouItem, option: PermissionOption) => void;
  onOpen: (item: NeedsYouItem) => void;
  onDismiss: (item: NeedsYouItem) => void;
  /** The input request's simple form when it can be answered in place. */
  formFor?: (item: NeedsYouItem) => InlineForm | null;
  onAnswerForm?: (item: NeedsYouItem, form: InlineForm, value: string) => void;
}

/** Things waiting on the user, answerable in place where the backend allows it. */
export function NeedsYouCard({ items, now, onAnswer, onOpen, onDismiss, formFor, onAnswerForm }: NeedsYouCardProps) {
  return (
    <Card
      className={`odb-inbox${items.length ? "" : " is-clear"}`}
      aria-label="Needs you"
      title={<>Needs you{items.length ? <span key={items.length} className="odb-count" aria-label={`${items.length} waiting`}>{items.length}</span> : null}</>}
    >
      <div className="odb-inbox-list oui-scroll">
        <AnimatePresence initial={false}>
          {items.map((item) => {
            const Icon = KIND_ICON[item.kind];
            const form = item.kind === "input" && onAnswerForm ? formFor?.(item) ?? null : null;
            const title = form?.message || item.title;
            return (
              <motion.div
                key={item.id}
                className={`odb-item${item.kind === "permission" || item.kind === "input" ? " is-request" : " is-note"}`}
                layout="position"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={COLLAPSE}
              >
                <div className="odb-item-in">
                  <span className={`odb-kind is-${item.kind}`}><Icon aria-hidden="true" /></span>
                  <span className="odb-item-copy">
                    <b title={title}>{title}</b>
                    <span>
                      {item.source}
                      {item.code ? <> · <code className="oui-mono" title={item.code}>{item.code}</code></> : null}
                      {item.kind !== "permission" && item.kind !== "input" && item.at ? <> · {shortAgo(item.at, now)}</> : null}
                    </span>
                  </span>
                  <span className="odb-acts">
                    {item.kind === "permission" && item.options.length ? (
                      <>
                        {[...item.options].reverse().map((option, index, list) => (
                          <Button
                            key={option.option_id}
                            variant={index === list.length - 1 ? "primary" : "secondary"}
                            size="sm"
                            title={labelFor(option)}
                            onClick={() => onAnswer(item, option)}
                          >
                            {shortLabel(option)}
                          </Button>
                        ))}
                        <Button variant="ghost" iconOnly size="sm" aria-label="Open session" title="Open session for all options" onClick={() => onOpen(item)}>
                          <ArrowUpRight />
                        </Button>
                      </>
                    ) : form && onAnswerForm ? (
                      <>
                        <InlineAnswer form={form} onAnswer={(value) => onAnswerForm(item, form, value)} />
                        <Button variant="ghost" iconOnly size="sm" aria-label="Open session" title="Open session" onClick={() => onOpen(item)}>
                          <ArrowUpRight />
                        </Button>
                      </>
                    ) : (
                      <>
                        {item.kind !== "permission" && item.kind !== "input" ? (
                          <Button variant="ghost" iconOnly size="sm" aria-label={`Dismiss ${item.title}`} title="Dismiss" onClick={() => onDismiss(item)}>
                            <X />
                          </Button>
                        ) : null}
                        <Button variant={item.kind === "input" ? "primary" : item.kind === "critical" ? "secondary" : "ghost"} size="sm" onClick={() => onOpen(item)}>
                          {item.kind === "input" ? "Answer" : "Open"}
                        </Button>
                      </>
                    )}
                  </span>
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
        {items.length === 0 ? (
          <div className="odb-clear">
            <span className="odb-clear-mark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg></span>
            <span><b>All clear</b><span>Nothing is waiting on you. Agents keep working in the background.</span></span>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

/** One simple field answered in place: Yes / No, a few choices, or short text. */
function InlineAnswer({ form, onAnswer }: { form: InlineForm; onAnswer: (value: string) => void }) {
  const [text, setText] = useState("");
  const { field } = form;
  if (field.kind === "boolean") {
    return (
      <>
        <Button variant="secondary" size="sm" onClick={() => onAnswer("false")}>No</Button>
        <Button variant="secondary" size="sm" onClick={() => onAnswer("true")}>Yes</Button>
      </>
    );
  }
  if (field.kind === "choice") {
    return (
      <>
        {field.options.map((option) => (
          <Button key={option} variant="secondary" size="sm" title={option} onClick={() => onAnswer(option)}>
            {option.length > 14 ? `${option.slice(0, 13)}…` : option}
          </Button>
        ))}
      </>
    );
  }
  const value = text.trim();
  const canSend = value.length > 0 || !field.required;
  return (
    <form
      className="odb-answer"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend) onAnswer(value);
      }}
    >
      <input
        className="oui-field"
        value={text}
        placeholder={field.label}
        aria-label={field.label}
        title={field.description ?? undefined}
        onChange={(event) => setText(event.target.value)}
      />
      <Button type="submit" variant="primary" size="sm" disabled={!canSend}>Send</Button>
    </form>
  );
}

/** Permission buttons stay short; the agent's full wording is the tooltip. */
function shortLabel(option: PermissionOption) {
  const label = labelFor(option);
  if (label.length <= 14) return label;
  if (option.kind === "allow_once") return "Allow";
  if (option.kind.startsWith("allow")) return "Always allow";
  if (option.kind.startsWith("reject")) return "Deny";
  return `${label.slice(0, 13)}…`;
}
