// Task sharing: links this Grove hands out, links it opened, and what a link
// opens. See src/api/handlers/shares.rs.

import { apiClient, type ApiError } from './client';
import type { Design, DesignComment } from './designs';
import type { SketchComment, SketchMeta } from './sketches';
import type { DiffFile, DiffStatsResult } from './review';

export type ShareState = 'active' | 'expired' | 'exhausted' | 'revoked' | 'removed' | 'missing';

export interface ShareVisitor {
  id: string;
  name: string;
  kind: 'grove' | 'browser';
  device: string;
  lastOpenAt: string | null;
  /** Joined again under a name the owner had removed. */
  rejoined: boolean;
}

/** What a link shows. A kind left out is all of it, later additions too;
 *  a list is those items only. No scope at all is the whole Task. */
export interface ShareScope {
  /** `""` for the Task's own changes, else a linked Project's id. */
  reviews?: string[];
  designs?: string[];
  sketches?: string[];
  /** Paths under output/. */
  files?: string[];
}

export type ShareScopeKind = keyof ShareScope;

/** What a link of a Task can show, to choose from. */
export interface ShareItems {
  reviews: { id: string; name: string }[];
  designs: { id: string; name: string }[];
  sketches: { id: string; name: string }[];
  files: string[];
}

export interface ShareLink {
  token: string;
  url: string;
  canComment: boolean;
  scope: ShareScope | null;
  expiresAt: string | null;
  /** How many people may open it; null for anyone with the link. */
  maxPeople: number | null;
  people: number;
  state: ShareState;
  createdAt: string;
  visitors: ShareVisitor[];
  comments: number;
}

export interface ShareLinks {
  address: string;
  addressSource: 'custom' | 'window';
  links: ShareLink[];
}

export interface ShareProfile {
  name: string | null;
  suggestedName: string;
  device: string;
}

/** What a link is, as the owner's Grove describes it. */
export interface ShareInfo {
  owner: string;
  ownerDevice: string;
  title: string;
  project: string;
  canComment: boolean;
  expiresAt: string | null;
  /** How many people may open it; null for anyone with the link. */
  maxPeople: number | null;
  people: number;
  state: ShareState;
  activityAt: string | null;
  /** Whether the Task has a Code Review of its own (Studio Tasks don't). */
  ownReview?: boolean;
  /** Linked Projects whose Code Review the link also shows. */
  reviews?: { id: string; name: string }[];
  you: { id: string; name: string; kind: 'grove' | 'browser' } | null;
}

export interface SharedCommentReply {
  id: number;
  author: string;
  /** Written by the person reading it, who may edit or delete it. */
  mine: boolean;
  content: string;
  timestamp: string;
}

export interface SharedComment {
  id: number;
  author: string;
  mine: boolean;
  commentType: 'inline' | 'file' | 'project';
  filePath: string | null;
  side: 'ADD' | 'DELETE' | null;
  startLine: number | null;
  endLine: number | null;
  content: string;
  timestamp: string;
  status: 'open' | 'resolved' | 'outdated';
  replies: SharedCommentReply[];
  /** Where in the rendered file a comment made on a preview or a design page sits. */
  anchor?: Record<string, unknown> | null;
}

export interface SharedFile {
  name: string;
  path: string;
  size: number;
  modified_at: string;
  is_dir: boolean;
}

export interface NewSharedComment {
  commentType?: 'inline' | 'file' | 'project';
  filePath?: string;
  side?: 'ADD' | 'DELETE';
  startLine?: number;
  endLine?: number;
  /** For a comment made on a preview or a design page: where it sits. */
  anchor?: unknown;
  content: string;
}

/** The Task's design boards as a share link shows them. */
export interface SharedDesignData {
  designs: Design[];
  comments: DesignComment[];
  me: string;
  /** Where the pages' own files load from, on the owner's Grove: a path, and the same as a full address. */
  filesPath: string;
  filesUrl: string;
}

/** A link this Grove opened. `live` is the owner's answer just now. */
export interface ReceivedShare {
  id: string;
  url: string;
  title: string;
  owner: string;
  project: string;
  canComment: boolean;
  addedAt: string;
  seenAt: string | null;
  live: (Partial<ShareInfo> & { state?: ShareState | 'offline' | string }) | null;
}

/** The `code` a share error carries (`expired`, `offline`, `name_required`, …). */
export function shareErrorCode(error: unknown): string | undefined {
  const data = (error as ApiError | undefined)?.data as { code?: string } | undefined;
  return data?.code;
}

/** Whose link it was, when the owner's Grove said why it stopped working. */
export function shareErrorOwner(error: unknown): string {
  const data = (error as ApiError | undefined)?.data as { owner?: string } | undefined;
  return data?.owner ?? '';
}

export function shareErrorMessage(error: unknown): string {
  const data = (error as ApiError | undefined)?.data as { error?: string } | undefined;
  return data?.error ?? (error as ApiError | undefined)?.message ?? 'Something went wrong';
}

// ─── The owner's links ─────────────────────────────────────────────────────

export function getShareProfile(): Promise<ShareProfile> {
  return apiClient.get<ShareProfile>('/api/v1/share-profile');
}

export function updateShareProfile(patch: { name: string }): Promise<ShareProfile> {
  return apiClient.put<typeof patch, ShareProfile>('/api/v1/share-profile', patch);
}

const ADDRESS_KEY = 'grove_share_address';

/** The address this window's links use, when it was changed by hand. Kept
 *  per window, so each Grove on a machine keeps its own. */
export function shareAddress(): string {
  try { return localStorage.getItem(ADDRESS_KEY) ?? ''; } catch { return ''; }
}

export function setShareAddress(address: string): void {
  try {
    if (address.trim()) localStorage.setItem(ADDRESS_KEY, address.trim());
    else localStorage.removeItem(ADDRESS_KEY);
  } catch { /* private window */ }
}

export function listShareLinks(projectId: string, taskId: string): Promise<ShareLinks> {
  const address = shareAddress();
  return apiClient.get<ShareLinks>(
    `/api/v1/projects/${projectId}/tasks/${encodeURIComponent(taskId)}/shares${address ? `?address=${encodeURIComponent(address)}` : ''}`,
  );
}

export function createShareLink(
  projectId: string,
  taskId: string,
  options: { canComment: boolean; expiresInDays: number | null; maxPeople: number | null; scope: ShareScope | null },
): Promise<ShareLink> {
  const body = { ...options, address: shareAddress() || undefined };
  return apiClient.post<typeof body, ShareLink>(
    `/api/v1/projects/${projectId}/tasks/${encodeURIComponent(taskId)}/shares`,
    body,
  );
}

export function setShareLinkScope(token: string, scope: ShareScope | null): Promise<void> {
  return apiClient.put<{ scope: ShareScope | null }, void>(`/api/v1/shares/${token}/scope`, { scope });
}

export function getShareItems(projectId: string, taskId: string): Promise<ShareItems> {
  return apiClient.get<ShareItems>(`/api/v1/projects/${projectId}/tasks/${encodeURIComponent(taskId)}/share-items`);
}

export function revokeShareLink(token: string): Promise<void> {
  return apiClient.postNoContent(`/api/v1/shares/${token}/stop`);
}

/** Forget a link and who opened it; their comments stay with the Task. */
export function deleteShareLink(token: string): Promise<void> {
  return apiClient.delete(`/api/v1/shares/${token}`);
}

export function removeShareVisitor(token: string, visitorId: string): Promise<void> {
  return apiClient.delete(`/api/v1/shares/${token}/visitors/${visitorId}`);
}

// ─── Links this Grove opened ───────────────────────────────────────────────

export function listReceivedShares(): Promise<{ shares: ReceivedShare[] }> {
  return apiClient.get<{ shares: ReceivedShare[] }>('/api/v1/shared');
}

export function previewShareLink(url: string): Promise<ShareInfo & { url: string; receivedId?: string; knownHost?: boolean }> {
  return apiClient.post<{ url: string }, ShareInfo & { url: string; receivedId?: string; knownHost?: boolean }>('/api/v1/shared/preview', { url });
}

export function addReceivedShare(url: string): Promise<ReceivedShare> {
  return apiClient.post<{ url: string }, ReceivedShare>('/api/v1/shared', { url });
}

export function removeReceivedShare(id: string): Promise<void> {
  return apiClient.delete(`/api/v1/shared/${id}`);
}

export function markReceivedShareSeen(id: string): Promise<void> {
  return apiClient.postNoContent(`/api/v1/shared/${id}/seen`);
}

/** Whether text looks like a Grove share link (`…/s/<token>`). */
export function isShareLink(text: string): boolean {
  try {
    const url = new URL(text.trim());
    return /^https?:$/.test(url.protocol) && /^\/s\/[A-Za-z0-9]+\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

// ─── What a link opens ─────────────────────────────────────────────────────

/** Reads one shared Task. In Grove it goes through this Grove's server; in a
 *  browser straight to the owner's, carrying the visitor cookie. */
export interface ShareSource {
  open(): Promise<ShareInfo>;
  diff(): Promise<DiffStatsResult>;
  fileDiff(path: string, oldPath?: string | null): Promise<DiffFile>;
  /** A changed file as the Task has it now. */
  fileContent(path: string): Promise<string>;
  files(): Promise<{ files: SharedFile[] }>;
  fileText(path: string): Promise<string>;
  fileBlob(path: string): Promise<Blob>;
  /** Where an output file's bytes are, for downloads and images. */
  fileUrl(path: string): string;
  comments(): Promise<{ comments: SharedComment[] }>;
  addComment(comment: NewSharedComment): Promise<{ comments: SharedComment[] }>;
  /** Answer in a thread, whoever started it. */
  addReply(id: number, content: string): Promise<{ comments: SharedComment[] }>;
  /** Change or remove what the reader wrote (`mine`); deleting a comment
   *  deletes its thread. */
  editComment(id: number, content: string): Promise<{ comments: SharedComment[] }>;
  deleteComment(id: number): Promise<{ comments: SharedComment[] }>;
  editReply(id: number, replyId: number, content: string): Promise<{ comments: SharedComment[] }>;
  deleteReply(id: number, replyId: number): Promise<{ comments: SharedComment[] }>;
  /** Call `onChange` whenever the comments this source reads change, pushed
   *  by the owner's Grove. Returns how to stop. */
  watchComments(onChange: () => void): () => void;
  /** The design boards, and the base address their pages load files from. */
  designs(): Promise<{ designs: Design[]; comments: DesignComment[]; me: string; filesBase: string }>;
  designPage(design: string, file: string): Promise<string>;
  /** The Task's sketches and the comments on them. */
  sketches(): Promise<{ sketches: SketchMeta[]; comments: SketchComment[]; me: string }>;
  sketchScene(sketchId: string): Promise<unknown>;
  /** The same link, its review calls (changes and comments) reading a
   *  linked Project's Code Review instead of the Task's own. */
  review(projectId: string): ShareSource;
}

type SharedSketchData = Awaited<ReturnType<ShareSource['sketches']>>;

const designPagePath = (design: string, file: string) => `designs/${encodeURIComponent(design)}/pages/${encodeURIComponent(file)}`;

/** `&project=…` / `?project=…` for a linked Project's review, else nothing. */
const reviewParam = (project: string | undefined, first: boolean) =>
  project ? `${first ? '?' : '&'}project=${encodeURIComponent(project)}` : '';

/** `undefined`: the stream reconnected or an event couldn't be read, so
 *  every listener reads again. */
type CommentsChange = (project: string | null | undefined) => void;

/** One stream per link, shared by everything on the page reading it. */
const commentStreams = new Map<string, { listeners: Set<CommentsChange>; stop: () => void }>();

/**
 * Read a link's event stream (server-sent events) and hand each `comments`
 * event to the listeners: `null` for the Task's own comments, a Project id
 * for a linked Project's review. Reconnects with backoff, and on reconnect
 * tells every listener to read again, for what changed meanwhile. Stops for
 * good once the link no longer lets the reader in.
 */
function streamComments(open: (signal: AbortSignal) => Promise<Response>, emit: CommentsChange): () => void {
  const controller = new AbortController();
  void (async () => {
    let delay = 1000;
    let connected = false;
    while (!controller.signal.aborted) {
      try {
        const response = await open(controller.signal);
        if (connected) emit(undefined);
        connected = true;
        delay = 1000;
        const reader = response.body?.getReader();
        if (!reader) return;
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
          let end: number;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const lines = block.split('\n');
            const name = lines.find((line) => line.startsWith('event:'))?.slice(6).trim();
            const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
            if (name !== 'comments') continue;
            try {
              emit((JSON.parse(data) as { project?: string | null }).project ?? null);
            } catch {
              emit(undefined);
            }
          }
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        const status = (error as { status?: number })?.status;
        // The link ended, or the reader was removed: nothing more will come.
        if (status === 401 || status === 403 || status === 404 || status === 410) return;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 30000);
    }
  })();
  return () => controller.abort();
}

/** `onChange` for the comments of `project` (a linked Project's review) or,
 *  without one, the Task's own. */
function watchLink(key: string, open: (signal: AbortSignal) => Promise<Response>, project: string | undefined, onChange: () => void): () => void {
  const listener: CommentsChange = (changed) => {
    if (changed === undefined || changed === (project ?? null)) onChange();
  };
  let stream = commentStreams.get(key);
  if (!stream) {
    const listeners = new Set<CommentsChange>();
    stream = {
      listeners,
      stop: streamComments(open, (changed) => {
        for (const each of listeners) each(changed);
      }),
    };
    commentStreams.set(key, stream);
  }
  stream.listeners.add(listener);
  return () => {
    const current = commentStreams.get(key);
    if (!current) return;
    current.listeners.delete(listener);
    if (current.listeners.size === 0) {
      current.stop();
      commentStreams.delete(key);
    }
  };
}

export function receivedShareSource(id: string, project?: string): ShareSource {
  const base = `/api/v1/shared/${id}/host`;
  const q = (path: string) => `path=${encodeURIComponent(path)}${reviewParam(project, false)}`;
  const r = reviewParam(project, true);
  return {
    open: () => apiClient.post<undefined, ShareInfo>(`${base}/open`),
    diff: () => apiClient.get<DiffStatsResult>(`${base}/diff${r}`),
    fileDiff: (path, oldPath) =>
      apiClient.get<DiffFile>(`${base}/diff/file?${q(path)}${oldPath ? `&old_path=${encodeURIComponent(oldPath)}` : ''}`),
    fileContent: async (path) => (await apiClient.get<{ content: string }>(`${base}/diff/content?${q(path)}`)).content,
    files: () => apiClient.get<{ files: SharedFile[] }>(`${base}/files`),
    fileText: (path) => apiClient.getText(`${base}/files/preview?${q(path)}`),
    fileBlob: (path) => apiClient.getBlob(`${base}/files/download?${q(path)}`),
    fileUrl: (path) => `${base}/files/download?${q(path)}`,
    comments: () => apiClient.get<{ comments: SharedComment[] }>(`${base}/comments${r}`),
    addComment: (comment) => apiClient.post<NewSharedComment, { comments: SharedComment[] }>(`${base}/comments${r}`, comment),
    addReply: (id, content) => apiClient.post<{ content: string }, { comments: SharedComment[] }>(`${base}/comments/${id}/replies${r}`, { content }),
    editComment: (comment, content) => apiClient.patch<{ content: string }, { comments: SharedComment[] }>(`${base}/comments/${comment}${r}`, { content }),
    deleteComment: (comment) => apiClient.delete<{ comments: SharedComment[] }>(`${base}/comments/${comment}${r}`),
    editReply: (comment, reply, content) => apiClient.patch<{ content: string }, { comments: SharedComment[] }>(`${base}/comments/${comment}/replies/${reply}${r}`, { content }),
    deleteReply: (comment, reply) => apiClient.delete<{ comments: SharedComment[] }>(`${base}/comments/${comment}/replies/${reply}${r}`),
    watchComments: (onChange) => watchLink(`received:${id}`, (signal) => apiClient.getResponse(`${base}/events`, signal), project, onChange),
    // This Grove relays the calls; a page's frame loads its files from the owner's Grove itself.
    designs: async () => {
      const data = await apiClient.get<SharedDesignData>(`${base}/designs`);
      return { designs: data.designs, comments: data.comments, me: data.me, filesBase: data.filesUrl };
    },
    designPage: (design, file) => apiClient.getText(`${base}/${designPagePath(design, file)}`),
    sketches: () => apiClient.get<SharedSketchData>(`${base}/sketches`),
    sketchScene: (sketchId) => apiClient.get<unknown>(`${base}/sketches/${encodeURIComponent(sketchId)}/scene`),
    review: (projectId) => receivedShareSource(id, projectId),
  };
}

async function publicRequest(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init });
  if (!response.ok) {
    let data: unknown;
    try { data = await response.json(); } catch { data = undefined; }
    throw { status: response.status, message: (data as { error?: string } | undefined)?.error ?? response.statusText, data } as ApiError;
  }
  return response;
}

async function publicJson<T>(path: string, init?: RequestInit): Promise<T> {
  return (await publicRequest(path, init)).json() as Promise<T>;
}

const jsonBody = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export function publicShareInfo(token: string): Promise<ShareInfo> {
  return publicJson<ShareInfo>(`/api/v1/share/${token}`);
}

export function joinPublicShare(token: string, name: string): Promise<ShareInfo> {
  return publicJson<ShareInfo>(`/api/v1/share/${token}/join`, jsonBody({ name, kind: 'browser' }));
}

export function publicShareSource(token: string, project?: string): ShareSource {
  const base = `/api/v1/share/${token}`;
  const q = (path: string) => `path=${encodeURIComponent(path)}${reviewParam(project, false)}`;
  const r = reviewParam(project, true);
  return {
    open: () => publicJson<ShareInfo>(`${base}/open`, { method: 'POST' }),
    diff: () => publicJson<DiffStatsResult>(`${base}/diff${r}`),
    fileDiff: (path, oldPath) =>
      publicJson<DiffFile>(`${base}/diff/file?${q(path)}${oldPath ? `&old_path=${encodeURIComponent(oldPath)}` : ''}`),
    fileContent: async (path) => (await publicJson<{ content: string }>(`${base}/diff/content?${q(path)}`)).content,
    files: () => publicJson<{ files: SharedFile[] }>(`${base}/files`),
    fileText: async (path) => (await publicRequest(`${base}/files/preview?${q(path)}`)).text(),
    fileBlob: async (path) => (await publicRequest(`${base}/files/download?${q(path)}`)).blob(),
    fileUrl: (path) => `${base}/files/download?${q(path)}`,
    comments: () => publicJson<{ comments: SharedComment[] }>(`${base}/comments${r}`),
    addComment: (comment) => publicJson<{ comments: SharedComment[] }>(`${base}/comments${r}`, jsonBody(comment)),
    addReply: (id, content) => publicJson<{ comments: SharedComment[] }>(`${base}/comments/${id}/replies${r}`, jsonBody({ content })),
    editComment: (comment, content) => publicJson<{ comments: SharedComment[] }>(`${base}/comments/${comment}${r}`, { ...jsonBody({ content }), method: 'PATCH' }),
    deleteComment: (comment) => publicJson<{ comments: SharedComment[] }>(`${base}/comments/${comment}${r}`, { method: 'DELETE' }),
    editReply: (comment, reply, content) => publicJson<{ comments: SharedComment[] }>(`${base}/comments/${comment}/replies/${reply}${r}`, { ...jsonBody({ content }), method: 'PATCH' }),
    deleteReply: (comment, reply) => publicJson<{ comments: SharedComment[] }>(`${base}/comments/${comment}/replies/${reply}${r}`, { method: 'DELETE' }),
    watchComments: (onChange) => watchLink(`public:${token}`, (signal) => publicRequest(`${base}/events`, { signal }), project, onChange),
    designs: async () => {
      const data = await publicJson<SharedDesignData>(`${base}/designs`);
      return { designs: data.designs, comments: data.comments, me: data.me, filesBase: data.filesPath };
    },
    designPage: async (design, file) => (await publicRequest(`${base}/${designPagePath(design, file)}`)).text(),
    sketches: () => publicJson<SharedSketchData>(`${base}/sketches`),
    sketchScene: (sketchId) => publicJson<unknown>(`${base}/sketches/${encodeURIComponent(sketchId)}/scene`),
    review: (projectId) => publicShareSource(token, projectId),
  };
}
