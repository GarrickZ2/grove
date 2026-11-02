export type PermissionOptionLike = { option_id: string; name: string; kind: string };

export type PermissionOutcome = "allowed" | "denied" | "cancelled";

/** What a resolved request's selected option name means. */
export function permissionOutcome(resolved: string): PermissionOutcome {
  const value = resolved.toLowerCase();
  if (value === "cancelled") return "cancelled";
  return value.includes("allow") || value.includes("yes") ? "allowed" : "denied";
}

export type PermissionLayout = {
  /** Allow options, the first being the primary action. */
  allow: PermissionOptionLike[];
  reject: PermissionOptionLike[];
  /** Options whose kind is neither allow nor reject, in agent order. */
  other: PermissionOptionLike[];
  /** Long or many options read better as a list than a button row. */
  stacked: boolean;
};

/** Split an agent's options into the card's groups, keeping agent order. */
export function permissionLayout(options: readonly PermissionOptionLike[]): PermissionLayout {
  const allow = options.filter((option) => option.kind.startsWith("allow"));
  const reject = options.filter((option) => option.kind.startsWith("reject"));
  const other = options.filter((option) => !option.kind.startsWith("allow") && !option.kind.startsWith("reject"));
  const stacked = options.length > 3 || other.length > 0 || options.some((option) => option.name.length > 24);
  return { allow, reject, other, stacked };
}

/**
 * Whether a request's detail is a Markdown document (a proposed plan) rather
 * than a command or payload: several lines, a heading, and a list.
 */
export function looksLikeMarkdownDocument(detail: string): boolean {
  const lines = detail.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 3) return false;
  const heading = lines.some((line) => /^#{1,4}\s+\S/.test(line));
  const list = lines.some((line) => /^\s*(?:[-*]|\d+\.)\s+\S/.test(line));
  return heading && list;
}

/** Whether a server error means a permission response hit a stale request. */
export function isStalePermissionError(text: string): boolean {
  return text.includes("No pending permission") || text.includes("is no longer pending");
}

/**
 * The request a stale-permission error is about: the id the backend names
 * ("Permission request X is no longer pending"), else the id we last
 * responded to. Empty when neither is known (legacy id-less requests).
 */
export function stalePermissionId(text: string, lastRespondedId: string | undefined): string {
  const named = /Permission request (\S+) is no longer pending/.exec(text)?.[1];
  return named ?? lastRespondedId ?? "";
}

/**
 * Settle only the request the stale error is about. A newer request the
 * backend is still waiting on (it serialises permissions, so it can arrive
 * before the error) keeps its pending state. With no id, only id-less
 * legacy requests are settled.
 */
export function resolveStalePermission<M extends { type: string }>(messages: M[], id: string): M[] {
  let changed = false;
  const next = messages.map((message) => {
    const permission = message as M & { id?: string; resolved?: string };
    if (permission.type !== "permission" || permission.resolved || (permission.id ?? "") !== id) return message;
    changed = true;
    return { ...permission, resolved: "Cancelled" };
  });
  return changed ? next : messages;
}
