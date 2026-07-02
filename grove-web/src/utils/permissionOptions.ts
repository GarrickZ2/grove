export interface PermissionOption {
  option_id: string;
  name: string;
  /** "allow_once" | "allow_always" | "reject_once" | "reject_always" */
  kind: string;
}

/**
 * ACP's `PermissionOptionKind` only has 4 canonical values (allow/reject ×
 * once/always) — but agents can send *multiple* options that map to the
 * same kind with different real-world meaning (e.g. Codex sends separate
 * "Allow for this session" and "Allow and don't ask again" options, both
 * bucketed as `allow_always` since ACP has no session-vs-permanent
 * distinction). A kind-derived generic label ("Always allow") would render
 * both identically and hide that distinction. Always show the agent's own
 * `name` instead — this is also what the in-chat permission panel does
 * (TaskChat.tsx), so it stays consistent with the source of truth.
 */
export function labelFor(opt: PermissionOption): string {
  return opt.name.replace(/\s+/g, " ").trim() || "Respond";
}

export function orderOptions(opts: PermissionOption[]): PermissionOption[] {
  const rank = (k: string): number => {
    if (k === "allow_once") return 0;
    if (k.startsWith("allow")) return 1;
    if (k === "reject_once") return 2;
    if (k.startsWith("reject")) return 3;
    return 4;
  };
  return [...opts].sort((a, b) => rank(a.kind) - rank(b.kind));
}
