import { useCallback, useEffect, useState } from "react";
import { installMcp, listMcpInstallations } from "../../api/extensions";
import {
  bindingDraft,
  sameBindingDraft,
  type McpBindingDraft,
  type McpScope,
} from "./mcpManagementState";
import { mcpErrorText } from "./useMcpConnection";

type Drafts = Record<McpScope, McpBindingDraft>;

export function useMcpBindings({
  repoKey,
  repoPath,
  projectPath,
  hasRemotes,
}: {
  repoKey: string;
  repoPath: string;
  projectPath: string | null;
  hasRemotes: boolean;
}) {
  const [scope, setScope] = useState<McpScope>("global");
  const [drafts, setDrafts] = useState<Drafts | null>(null);
  const [saved, setSaved] = useState<Drafts | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    void listMcpInstallations()
      .then((items) => {
        if (!active) return;
        const relevant = items.filter(
          (item) => item.repo_key === repoKey && item.repo_path === repoPath,
        );
        const fallback = {
          kind: hasRemotes ? ("remote" as const) : ("package" as const),
          index: 0,
        };
        const value = {
          global: bindingDraft(relevant, "global", projectPath, fallback),
          project: bindingDraft(relevant, "project", projectPath, fallback),
        };
        setDrafts(value);
        setSaved(value);
        setError(null);
      })
      .catch((cause) => {
        if (active) setError(mcpErrorText(cause));
      });
    return () => {
      active = false;
    };
  }, [repoKey, repoPath, projectPath, hasRemotes, revision]);

  const updateDraft = useCallback(
    (change: Partial<McpBindingDraft>) => {
      setDrafts((current) =>
        current
          ? { ...current, [scope]: { ...current[scope], ...change } }
          : current,
      );
      setNotice(null);
    },
    [scope],
  );

  const save = async (definitions: Record<string, unknown>[]) => {
    if (!drafts) return false;
    const snapshot = drafts[scope];
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      for (const definition of definitions) {
        if (
          snapshot.agentIds.length &&
          definition.isRequired === true &&
          !snapshot.values[String(definition.name)]?.trim()
        ) {
          throw new Error(`${String(definition.name)} is required.`);
        }
      }
      await installMcp({
        repo_key: repoKey,
        repo_path: repoPath,
        scope,
        project_path:
          scope === "project" ? (projectPath ?? undefined) : undefined,
        agent_ids: snapshot.agentIds,
        runtime: snapshot.runtime,
        values: snapshot.values,
      });
      setSaved((current) =>
        current ? { ...current, [scope]: snapshot } : current,
      );
      setNotice(
        "Agent access saved. Reconnect existing Agents to apply changes.",
      );
      return true;
    } catch (cause) {
      setError(mcpErrorText(cause));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const dirtyScopes =
    drafts && saved
      ? (["global", "project"] as const).filter(
          (key) => !sameBindingDraft(drafts[key], saved[key]),
        )
      : [];
  return {
    scope,
    setScope: (value: McpScope) => {
      setScope(value);
      if (drafts) {
        setError(null);
        setNotice(null);
      }
    },
    draft: drafts?.[scope],
    updateDraft,
    saving,
    save,
    error,
    notice,
    loaded: drafts !== null,
    savedAgentCount: saved
      ? saved.global.agentIds.length + saved.project.agentIds.length
      : 0,
    dirty: dirtyScopes.includes(scope),
    dirtyScopes,
    retry: () => {
      setError(null);
      setRevision((value) => value + 1);
    },
  };
}
