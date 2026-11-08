import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getTaskFiles, listChats, type FileMetadata } from "../../../../api/tasks";
import { listSketches, type SketchMeta } from "../../../../api/sketches";
import { getExtensionStatus, listExtensionTabs } from "../../../../api/extension";
import { buildAgentMentionItems, buildMentionItems, buildStudioMentionItems, type MentionItem } from "../../../../utils/fileMention";

const FILES_TTL_MS = 10_000;

export interface MentionSources {
  /** Agent spawn targets and chat histories, then the Task's files. */
  items: MentionItem[];
  browserTabs: MentionItem[];
  browserTabsAvailable: boolean;
  studio: boolean;
  /** Called when the picker opens: refetches files and chats once they are stale. */
  refresh: () => void;
  /** Called when the Browser Tabs category opens. */
  loadBrowserTabs: () => void;
}

/**
 * @-mention candidates for a composer that has no Session yet (Orbit's New
 * page): the target Task's files and Sessions, plus Agents to spawn. Without
 * a Session there are no agent-graph contacts, so only spawn targets appear.
 */
export function useMentionSources(options: {
  projectId: string | undefined;
  taskId: string;
  studio: boolean;
  spawnAgents: { value: string; label: string }[];
  spawnPersonas: { id: string; name: string; base_agent: string; duty?: string }[];
}): MentionSources {
  const { projectId, taskId, studio, spawnAgents, spawnPersonas } = options;
  const target = projectId ? `${projectId}\u0000${taskId}` : "";
  const [loaded, setLoaded] = useState<{ target: string; files: string[]; meta: FileMetadata[]; sketches: SketchMeta[]; chats: { chat_id: string; name: string; agent: string; history_path: string }[] } | null>(null);
  const [browserTabs, setBrowserTabs] = useState<MentionItem[]>([]);
  const [browserTabsAvailable, setBrowserTabsAvailable] = useState(false);
  const fetchedAt = useRef<{ target: string; at: number }>({ target: "", at: 0 });

  useEffect(() => {
    let cancelled = false;
    void getExtensionStatus().then((connected) => { if (!cancelled) setBrowserTabsAvailable(connected); });
    return () => { cancelled = true; };
  }, []);

  const refresh = useCallback(() => {
    if (!projectId) return;
    const now = Date.now();
    if (fetchedAt.current.target === target && now - fetchedAt.current.at < FILES_TTL_MS) return;
    fetchedAt.current = { target, at: now };
    void Promise.all([
      getTaskFiles(projectId, taskId).catch(() => ({ files: [] as string[], metadata: [] as FileMetadata[] })),
      studio ? listSketches(projectId, taskId).catch(() => [] as SketchMeta[]) : Promise.resolve([] as SketchMeta[]),
      listChats(projectId, taskId).catch(() => []),
    ]).then(([files, sketches, chats]) => {
      // A slower answer for a previous Task never replaces the current one.
      if (fetchedAt.current.target !== target) return;
      setLoaded({
        target,
        files: files.files,
        meta: files.metadata ?? [],
        sketches,
        chats: [...chats]
          .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
          .map((chat) => ({ chat_id: chat.id, name: chat.title, agent: chat.agent, history_path: chat.history_path })),
      });
    });
  }, [projectId, taskId, studio, target]);

  const loadBrowserTabs = useCallback(() => {
    void listExtensionTabs()
      .catch(() => [])
      .then((tabs) => setBrowserTabs(tabs.map((tab) => ({
        path: tab.url,
        displayName: tab.title || tab.url,
        category: "Browser Tab",
        kind: "browsertabs",
        isDir: false,
        sessionId: tab.targetId,
        favIconUrl: tab.favIconUrl,
      }))));
  }, []);

  const current = loaded?.target === target ? loaded : null;
  const items = useMemo(() => [
    ...buildAgentMentionItems({ spawnAgents, spawnPersonas, outgoing: [], siblingChats: current?.chats ?? [] }),
    ...(studio
      ? buildStudioMentionItems(current?.files ?? [], current?.sketches ?? [], current?.meta)
      : buildMentionItems(current?.files ?? [])),
  ], [current, spawnAgents, spawnPersonas, studio]);

  return { items, browserTabs, browserTabsAvailable, studio, refresh, loadBrowserTabs };
}
