import { useCallback, useEffect, useState } from "react";
import { getProjectLinkedProjects, updateProjectLinkedProjects, type LinkedProjectItem } from "../../api";

export interface ProjectLinksView {
  /** The Project's default links; null while loading or when unavailable. */
  links: LinkedProjectItem[] | null;
  /** False when the server doesn't offer Project-level links (older backend). */
  available: boolean;
  saving: boolean;
  error: string | null;
  save: (projectIds: string[]) => Promise<void>;
}

/** A response is usable only when it has the expected shape: an older server
 *  answers an unknown route with the SPA's index.html instead of a 404. */
export function linksFrom(response: unknown): LinkedProjectItem[] | null {
  const list = (response as { linked_projects?: unknown } | null)?.linked_projects;
  return Array.isArray(list) ? (list as LinkedProjectItem[]) : null;
}

/** The Project's default linked projects, which new tasks copy at creation. */
export function useProjectLinks(projectId: string | undefined): ProjectLinksView {
  const [state, setState] = useState<{ projectId?: string; links: LinkedProjectItem[] | null; available: boolean }>({ links: null, available: false });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    getProjectLinkedProjects(projectId)
      .then((response) => {
        if (cancelled) return;
        const links = linksFrom(response);
        setState({ projectId, links, available: links !== null });
      })
      // Missing route (server not restarted yet) or any failure: hide quietly.
      .catch(() => { if (!cancelled) setState({ projectId, links: null, available: false }); });
    return () => { cancelled = true; };
  }, [projectId]);

  const save = useCallback(async (projectIds: string[]) => {
    if (!projectId) return;
    setSaving(true);
    setError(null);
    try {
      const links = linksFrom(await updateProjectLinkedProjects(projectId, projectIds));
      if (!links) throw new Error("unexpected response");
      setState({ projectId, links, available: true });
    } catch (err) {
      setError((err as { message?: string })?.message || "Couldn’t update linked projects");
    } finally {
      setSaving(false);
    }
  }, [projectId]);

  const current = state.projectId === projectId;
  return { links: current ? state.links : null, available: current && state.available, saving, error: current ? error : null, save };
}
