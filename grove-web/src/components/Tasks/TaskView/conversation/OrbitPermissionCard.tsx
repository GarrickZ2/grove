import { memo, useRef, useState } from "react";
import { AlertTriangle, Check, Loader2, ShieldAlert, ShieldCheck, ShieldX, X } from "lucide-react";
import { MarkdownRenderer } from "../../../ui";
import { looksLikeMarkdownDocument, permissionLayout, permissionOutcome, type PermissionOptionLike } from "./permissionCard";

export type OrbitPermission = {
  id: string;
  description: string;
  title?: string;
  detail?: string;
  options: PermissionOptionLike[];
  resolved?: string;
};

/**
 * A pending permission request, docked in the Orbit composer: what the agent
 * wants to do, the exact payload, and the agent's options — allowing on the
 * right with the first one primary, rejecting on the left.
 */
export const OrbitPermissionRequest = memo(function OrbitPermissionRequest({
  message,
  onRespond,
}: {
  message: OrbitPermission;
  /** Returns false when the response could not be sent (socket closed). */
  onRespond?: (optionId: string, requestId: string) => boolean | void;
}) {
  // One answer per request: after a click the card waits for the agent to
  // resolve it, so a double click can't send a second, stale response.
  const [chosen, setChosen] = useState<{ request: OrbitPermission; optionId: string } | null>(null);
  const pendingOption = chosen?.request === message ? chosen.optionId : null;
  const heading = message.title || message.description;
  const detail = message.detail?.trim() && message.detail.trim() !== heading.trim() ? message.detail : undefined;
  const { allow, reject, other, stacked } = permissionLayout(message.options);
  // The ref also blocks clicks that land before the state re-renders.
  const answeredRef = useRef<OrbitPermission | null>(null);
  const respond = (option: PermissionOptionLike) => {
    if (answeredRef.current === message) return;
    if (onRespond?.(option.option_id, message.id) === false) return;
    answeredRef.current = message;
    setChosen({ request: message, optionId: option.option_id });
  };
  const optionState = (option: PermissionOptionLike) => ({
    disabled: pendingOption !== null,
    "aria-busy": pendingOption === option.option_id || undefined,
  });
  const primaryId = allow[0]?.option_id;

  return (
    <div className={`ocv-decision${pendingOption !== null ? " is-answered" : ""}`} role="group" aria-label="Permission request">
      <div className="ocv-decision-head">
        <span className="ocv-decision-icon" aria-hidden="true"><ShieldAlert /></span>
        <div className="ocv-decision-text">
          <div className="ocv-decision-eyebrow">Needs your approval</div>
          <div className="ocv-decision-title" tabIndex={0}>{heading}</div>
        </div>
      </div>
      {detail && (
        looksLikeMarkdownDocument(detail) ? (
          <div className="ocv-decision-doc ocv-prose" role="region" aria-label="Request details" tabIndex={0}>
            <MarkdownRenderer content={detail} />
          </div>
        ) : (
          <pre className="ocv-decision-payload" role="region" aria-label="Request details" tabIndex={0}>{detail}</pre>
        )
      )}
      {stacked ? (
        <div className="ocv-decision-list">
          {[...allow, ...other, ...reject].map((option) => {
            const isReject = option.kind.startsWith("reject");
            return (
              <button
                key={option.option_id}
                type="button"
                className={`ocv-decision-option${option.option_id === primaryId ? " is-primary" : ""}${isReject ? " is-reject" : ""}`}
                onClick={() => respond(option)}
                {...optionState(option)}
              >
                {pendingOption === option.option_id ? <Loader2 className="ocv-spin" aria-hidden="true" /> : isReject ? <X aria-hidden="true" /> : <Check aria-hidden="true" />}
                <span>{option.name}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="ocv-decision-actions">
          {reject.map((option) => (
            <button key={option.option_id} type="button" className="ocv-btn is-quiet" onClick={() => respond(option)} {...optionState(option)}>
              {pendingOption === option.option_id && <Loader2 className="ocv-spin" aria-hidden="true" />}
              {option.name}
            </button>
          ))}
          <span className="ocv-decision-spacer" />
          {[...allow].reverse().map((option) => (
            <button
              key={option.option_id}
              type="button"
              className={`ocv-btn${option.option_id === primaryId ? " is-primary" : ""}`}
              onClick={() => respond(option)}
              {...optionState(option)}
            >
              {pendingOption === option.option_id && <Loader2 className="ocv-spin" aria-hidden="true" />}
              {option.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
});

/** A resolved request, as a quiet record in the timeline. */
export const OrbitPermissionRecord = memo(function OrbitPermissionRecord({ message }: { message: OrbitPermission }) {
  const resolved = message.resolved ?? "";
  const outcome = permissionOutcome(resolved);
  const Icon = outcome === "cancelled" ? AlertTriangle : outcome === "allowed" ? ShieldCheck : ShieldX;
  const label = outcome === "cancelled" ? "Cancelled" : outcome === "allowed" ? "Allowed" : "Denied";
  const heading = message.title || message.description;
  return (
    <div className={`ocv-decision-record is-${outcome}`}>
      <Icon className="ocv-decision-record-icon" aria-hidden="true" />
      <span className="ocv-decision-record-outcome">{label}</span>
      <span className="ocv-decision-record-title" title={heading}>{heading}</span>
      {/* A denial needs no restating; an allow says which kind. */}
      {resolved && outcome === "allowed" && (
        <span className="ocv-decision-record-choice" title={resolved}>{resolved}</span>
      )}
    </div>
  );
});
