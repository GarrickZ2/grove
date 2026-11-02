import { useCallback, useEffect, useRef, useState } from "react";
import { installMcp, listMcpInstallations, type ExtensionArtifact, type McpInstallation } from "../../api/extensions";
import { bindingDraft, type McpBindingDraft, type McpScope } from "../../components/Skills/mcpManagementState";
import { mcpErrorText } from "../../components/Skills/useMcpConnection";

type Drafts = Record<McpScope, McpBindingDraft>;
type Definition = Record<string, unknown>;

/** Header / env definitions of the runtime a binding uses. */
export function runtimeFields(artifact: ExtensionArtifact, runtime: McpBindingDraft["runtime"]): Definition[] {
  const manifest = artifact.manifest ?? {};
  const list = runtime.kind === "remote" ? manifest.remotes : manifest.packages;
  const definition = Array.isArray(list) ? (list[runtime.index] as Definition | undefined) : undefined;
  const fields = runtime.kind === "remote" ? definition?.headers : definition?.environmentVariables;
  return Array.isArray(fields) ? (fields as Definition[]) : [];
}

/** First required field a binding with agents still lacks, if any. */
export function missingRequiredField(draft: McpBindingDraft, fields: Definition[]): string | null {
  if (draft.agentIds.length === 0) return null;
  const missing = fields.find((field) => field.isRequired === true && !draft.values[String(field.name)]?.trim());
  return missing ? String(missing.name) : null;
}

const EMPTY_VALUES: Record<string, string> = {};

/** First scope with bindings (project only when there is one), else global. */
export function initialScope(drafts: Drafts, projectPath: string | null): McpScope {
  if (drafts.global.agentIds.length) return "global";
  if (projectPath && drafts.project.agentIds.length) return "project";
  if (drafts.buddy.agentIds.length) return "buddy";
  return "global";
}

export interface BindingRow {
  targetId: string;
  scope: McpScope;
  /** Set for project bindings. */
  projectPath: string | null;
}

/** Flat "who has it, where" list: this view's scopes plus other projects'. */
export function bindingRows(drafts: Drafts, others: McpInstallation[], projectPath: string | null): BindingRow[] {
  return [
    ...drafts.global.agentIds.map((targetId) => ({ targetId, scope: "global" as const, projectPath: null })),
    ...(projectPath ? drafts.project.agentIds.map((targetId) => ({ targetId, scope: "project" as const, projectPath })) : []),
    ...others.map((item) => ({ targetId: item.agent_id, scope: "project" as const, projectPath: item.project_path })),
    ...drafts.buddy.agentIds.map((targetId) => ({ targetId, scope: "buddy" as const, projectPath: null })),
  ];
}

export function toggleId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id];
}

/**
 * Inline "Available to" editor: every toggle saves immediately (Orbit has no
 * Save button). Saves are queued so rapid toggles land in order; a failed
 * save rolls back to what the server has. Credentials, runtime and display
 * name stay in the full setup drawer.
 */
export function useMcpAccess({ artifact, projectPath, onSaved }: { artifact: ExtensionArtifact; projectPath: string | null; onSaved?: () => void }) {
  const [scope, setScope] = useState<McpScope>("global");
  const [drafts, setDrafts] = useState<Drafts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedCount, setSavedCount] = useState(0);
  const [pending, setPending] = useState(0);
  const [revision, setRevision] = useState(0);
  const [others, setOthers] = useState<McpInstallation[]>([]);
  // Until the user picks a scope, open on the first one that has bindings.
  const scopeTouched = useRef(false);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const latestSaved = useRef(onSaved);
  useEffect(() => { latestSaved.current = onSaved; }, [onSaved]);

  const { repo_key: repoKey, repo_path: repoPath } = artifact;
  const hasRemotes = Array.isArray(artifact.manifest?.remotes) && (artifact.manifest.remotes as unknown[]).length > 0;

  useEffect(() => {
    let active = true;
    void listMcpInstallations()
      .then((items) => {
        if (!active) return;
        const relevant = items.filter((item) => item.repo_key === repoKey && item.repo_path === repoPath);
        const fallback = { kind: hasRemotes ? ("remote" as const) : ("package" as const), index: 0 };
        const next: Drafts = {
          global: bindingDraft(relevant, "global", projectPath, fallback),
          project: bindingDraft(relevant, "project", projectPath, fallback),
          buddy: bindingDraft(relevant, "buddy", projectPath, fallback),
        };
        setDrafts(next);
        setOthers(relevant.filter((item) => item.scope === "project" && item.project_path !== projectPath));
        if (!scopeTouched.current) setScope(initialScope(next, projectPath));
      })
      .catch((cause) => { if (active) setError(mcpErrorText(cause)); });
    return () => { active = false; };
  }, [repoKey, repoPath, projectPath, hasRemotes, revision]);

  const toggle = useCallback((id: string) => {
    if (!drafts) return;
    const current = drafts[scope];
    const next: McpBindingDraft = { ...current, agentIds: toggleId(current.agentIds, id) };
    const missing = missingRequiredField(next, runtimeFields(artifact, next.runtime));
    if (missing) {
      setError(`${missing} is required. Fill it in under Setup first.`);
      return;
    }
    setError(null);
    setDrafts({ ...drafts, [scope]: next });
    setPending((value) => value + 1);
    const savingScope = scope;
    queue.current = queue.current.then(() => installMcp({
      repo_key: repoKey,
      repo_path: repoPath,
      scope: savingScope,
      project_path: savingScope === "project" ? (projectPath ?? undefined) : undefined,
      agent_ids: next.agentIds,
      runtime: next.runtime,
      values: next.values,
    })).then(() => {
      setSavedCount((value) => value + 1);
      latestSaved.current?.();
    }, (cause) => {
      setError(mcpErrorText(cause));
      // Resync with the server instead of guessing which toggles stuck.
      setRevision((value) => value + 1);
    }).finally(() => setPending((value) => value - 1));
  }, [artifact, drafts, projectPath, repoKey, repoPath, scope]);

  return {
    scope,
    setScope: (value: McpScope) => { scopeTouched.current = true; setScope(value); setError(null); },
    /** Agent bindings that only apply to other projects. */
    elsewhere: others.length,
    /** Every binding, live with unsaved-yet-optimistic toggles. */
    bindings: drafts ? bindingRows(drafts, others, projectPath) : [],
    /** Saved header / env values for the scope (used to probe the server). */
    values: drafts?.[scope].values ?? EMPTY_VALUES,
    selected: drafts?.[scope].agentIds ?? [],
    loaded: drafts !== null,
    saving: pending > 0,
    savedCount,
    error,
    toggle,
    retry: () => { setError(null); setRevision((value) => value + 1); },
  };
}
