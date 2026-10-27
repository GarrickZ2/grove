import { Loader2 } from "lucide-react";
import type { InstalledAgentConfig } from "../../api/marketplace";
import { Button } from "../ui";
import { AgentIcon } from "./AgentIcon";
import type { McpScope } from "./mcpManagementState";

export interface McpAccessDraft {
  scope: McpScope;
  agentIds: string[];
}

export interface McpAccessOptions {
  draft: McpAccessDraft;
  onChange: (draft: McpAccessDraft) => void;
  agents: InstalledAgentConfig[];
  projectPath: string | null;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  disabled?: boolean;
  dirtyScopes?: McpScope[];
}

export function McpAgentAccess({
  draft,
  onChange,
  agents,
  projectPath,
  loading,
  error,
  onRetry,
  disabled,
  dirtyScopes = [],
}: McpAccessOptions) {
  return (
    <section className="space-y-3" aria-label="Agent access">
      <div>
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold">Agent access</h3>
          <span className="text-xs text-[var(--color-text-muted)]">
            {draft.agentIds.length} selected
          </span>
        </div>
        <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">
          Choose where this server is available and which Agents can use it.
        </p>
      </div>
      <div>
        <p className="mb-2 text-xs font-medium">Available in</p>
        <div
          className="flex rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/50 p-1"
          aria-label="Binding scope"
        >
          {(["global", "project"] as const).map((scope) => (
            <button
              key={scope}
              type="button"
              aria-pressed={draft.scope === scope}
              disabled={
                disabled || loading || (scope === "project" && !projectPath)
              }
              onClick={() => onChange({ ...draft, scope })}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-highlight)] disabled:opacity-40 ${draft.scope === scope ? "bg-[var(--color-bg)] text-[var(--color-text)] shadow-sm" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}
            >
              {scope === "global" ? "All projects" : "Current project"}
              {dirtyScopes.includes(scope) && (
                <span
                  className="h-1.5 w-1.5 rounded-full bg-[var(--color-highlight)]"
                  aria-label="Unsaved changes"
                />
              )}
            </button>
          ))}
        </div>
        {draft.scope === "project" && (
          <p
            className="mt-2 truncate text-xs text-[var(--color-text-muted)]"
            title={projectPath ?? undefined}
          >
            {projectPath}
          </p>
        )}
      </div>
      {loading ? (
        <p className="flex items-center gap-2 rounded-xl border border-[var(--color-border)] px-4 py-5 text-xs text-[var(--color-text-muted)]">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading Agents…
        </p>
      ) : error ? (
        <div className="space-y-2 rounded-xl border border-[var(--color-border)] p-4">
          <p role="alert" className="text-xs text-[var(--color-error)]">
            {error}
          </p>
          <Button size="sm" variant="secondary" onClick={onRetry}>
            Retry loading Agents
          </Button>
        </div>
      ) : agents.length ? (
        <div className="max-h-52 divide-y divide-[var(--color-border)] overflow-y-auto rounded-xl border border-[var(--color-border)]">
          {agents.map((agent) => (
            <label
              key={agent.id}
              className="flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors hover:bg-[var(--color-bg-secondary)]/50"
            >
              <input
                type="checkbox"
                className="h-4 w-4 shrink-0 accent-[var(--color-highlight)]"
                disabled={disabled}
                checked={draft.agentIds.includes(agent.id)}
                onChange={(event) =>
                  onChange({
                    ...draft,
                    agentIds: event.target.checked
                      ? [...draft.agentIds, agent.id]
                      : draft.agentIds.filter((id) => id !== agent.id),
                  })
                }
              />
              <AgentIcon iconId={agent.id} size={18} />
              <span className="min-w-0 flex-1 truncate text-sm">
                {agent.name}
              </span>
            </label>
          ))}
        </div>
      ) : (
        <p className="rounded-xl border border-dashed border-[var(--color-border)] px-4 py-5 text-xs leading-5 text-[var(--color-text-muted)]">
          Install an ACP Agent before enabling this server.
        </p>
      )}
      <p className="text-xs leading-5 text-[var(--color-text-muted)]">
        {draft.agentIds.length === 0
          ? "Select at least one Agent to enable this server. "
          : ""}
        Takes effect when an Agent next connects. Reconnect an existing Agent to
        apply changes.
      </p>
    </section>
  );
}
