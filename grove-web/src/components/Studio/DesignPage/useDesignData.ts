import { useCallback, useEffect, useRef, useState } from "react";
import {
  createDesignSession,
  getDesignPage,
  listDesignComments,
  listDesigns,
  type Design,
  type DesignComment,
} from "../../../api/designs";

/** While the agent works, its file writes show up this often. */
const BUSY_POLL_MS = 2500;
/** Otherwise: often enough to keep "a window is showing the designs" true. */
const IDLE_POLL_MS = 8000;

interface Options {
  isChatBusy?: boolean;
  lastChatIdleAt?: number;
}

/**
 * The task's designs and their comments, kept current. The agent edits the
 * files directly, so this polls: quickly while the chat is busy, slowly
 * otherwise, and not at all while the window is hidden (a hidden window
 * cannot render pages for the agent, so it should not claim to be watching).
 */
export function useDesignData(projectId: string, taskId: string, { isChatBusy, lastChatIdleAt }: Options) {
  const scope = `${projectId}/${taskId}`;
  const [data, setData] = useState<{ scope: string; designs: Design[]; comments: DesignComment[]; me: string | null } | null>(null);
  const [session, setSession] = useState<{ scope: string; token: string } | null>(null);
  const [failure, setFailure] = useState<{ scope: string; message: string } | null>(null);
  const live = useRef(scope);

  const reload = useCallback(async () => {
    const asked = `${projectId}/${taskId}`;
    try {
      const [designs, thread] = await Promise.all([
        listDesigns(projectId, taskId, true),
        listDesignComments(projectId, taskId),
      ]);
      if (live.current !== asked) return;
      const next = { scope: asked, designs, comments: thread.comments, me: thread.me ?? null };
      // Polls mostly bring nothing new; keeping the same object keeps frames from re-rendering.
      setData((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next));
      setFailure(null);
    } catch (cause) {
      if (live.current !== asked) return;
      setFailure({ scope: asked, message: (cause as { message?: string })?.message ?? "Couldn't load designs" });
    }
  }, [projectId, taskId]);

  useEffect(() => {
    live.current = scope;
    let cancelled = false;
    createDesignSession(projectId, taskId)
      .then((token) => { if (!cancelled) setSession({ scope, token }); })
      .catch(() => { if (!cancelled) setFailure({ scope, message: "Couldn't open the designs for viewing" }); });
    return () => { cancelled = true; };
  }, [projectId, taskId, scope]);

  useEffect(() => {
    let timer: number | undefined;
    const tick = () => {
      if (!document.hidden) void reload();
      timer = window.setTimeout(tick, isChatBusy ? BUSY_POLL_MS : IDLE_POLL_MS);
    };
    tick();
    const onVisible = () => { if (!document.hidden) void reload(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [reload, isChatBusy, lastChatIdleAt]);

  const current = data?.scope === scope ? data : null;

  /** Change the designs or comments in place, ahead of the next poll. */
  const patch = useCallback((change: (value: { designs: Design[]; comments: DesignComment[] }) => { designs?: Design[]; comments?: DesignComment[] }) => {
    setData((previous) => (previous ? { ...previous, ...change(previous) } : previous));
  }, []);

  return {
    designs: current?.designs ?? null,
    comments: current?.comments ?? EMPTY_COMMENTS,
    me: current?.me ?? null,
    token: session?.scope === scope ? session.token : null,
    error: failure?.scope === scope ? failure.message : null,
    reload,
    patch,
  };
}

const EMPTY_COMMENTS: DesignComment[] = [];

const pageCache = new Map<string, Promise<string>>();
const PAGE_CACHE_LIMIT = 80;

/** A page's HTML at one version. Versions never change, so they cache. */
export function loadPageHtml(projectId: string, taskId: string, design: string, file: string, version: string): Promise<string> {
  const key = `${projectId}/${taskId}/${design}/${file}@${version}`;
  let cached = pageCache.get(key);
  if (!cached) {
    cached = getDesignPage(projectId, taskId, design, file);
    cached.catch(() => pageCache.delete(key));
    pageCache.set(key, cached);
    if (pageCache.size > PAGE_CACHE_LIMIT) pageCache.delete(pageCache.keys().next().value as string);
  }
  return cached;
}

export interface LoadedPage {
  html: string;
  /** The version this HTML was read at. */
  version: string;
}

/** One page's HTML, reloaded when its version changes. Null until the first load. */
export function usePageHtml(projectId: string, taskId: string, design: string, file: string, version: string): LoadedPage | null {
  const page = `${projectId}/${taskId}/${design}/${file}`;
  const [loaded, setLoaded] = useState<(LoadedPage & { page: string }) | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadPageHtml(projectId, taskId, design, file, version)
      .then((html) => { if (!cancelled) setLoaded({ page, html, version }); })
      .catch(() => {
        if (!cancelled) setLoaded({ page, version, html: "<p style=\"font:14px system-ui;padding:24px\">This page could not be loaded.</p>" });
      });
    return () => { cancelled = true; };
  }, [projectId, taskId, design, file, version, page]);
  // The previous version stays up until the new one arrives: no blank flash.
  return loaded?.page === page ? loaded : null;
}
