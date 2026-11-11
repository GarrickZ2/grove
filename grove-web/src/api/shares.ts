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

export interface ShareLink {
  token: string;
  url: string;
  canComment: boolean;
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
  you: { id: string; name: string; kind: 'grove' | 'browser' } | null;
}

export interface SharedCommentReply {
  id: number;
  author: string;
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
  options: { canComment: boolean; expiresInDays: number | null; maxPeople: number | null },
): Promise<ShareLink> {
  const body = { ...options, address: shareAddress() || undefined };
  return apiClient.post<typeof body, ShareLink>(
    `/api/v1/projects/${projectId}/tasks/${encodeURIComponent(taskId)}/shares`,
    body,
  );
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
  /** The design boards, and the base address their pages load files from. */
  designs(): Promise<{ designs: Design[]; comments: DesignComment[]; me: string; filesBase: string }>;
  designPage(design: string, file: string): Promise<string>;
  /** The Task's sketches and the comments on them. */
  sketches(): Promise<{ sketches: SketchMeta[]; comments: SketchComment[]; me: string }>;
  sketchScene(sketchId: string): Promise<unknown>;
}

type SharedSketchData = Awaited<ReturnType<ShareSource['sketches']>>;

const designPagePath = (design: string, file: string) => `designs/${encodeURIComponent(design)}/pages/${encodeURIComponent(file)}`;

export function receivedShareSource(id: string): ShareSource {
  const base = `/api/v1/shared/${id}/host`;
  const q = (path: string) => `path=${encodeURIComponent(path)}`;
  return {
    open: () => apiClient.post<undefined, ShareInfo>(`${base}/open`),
    diff: () => apiClient.get<DiffStatsResult>(`${base}/diff`),
    fileDiff: (path, oldPath) =>
      apiClient.get<DiffFile>(`${base}/diff/file?${q(path)}${oldPath ? `&old_path=${encodeURIComponent(oldPath)}` : ''}`),
    fileContent: async (path) => (await apiClient.get<{ content: string }>(`${base}/diff/content?${q(path)}`)).content,
    files: () => apiClient.get<{ files: SharedFile[] }>(`${base}/files`),
    fileText: (path) => apiClient.getText(`${base}/files/preview?${q(path)}`),
    fileBlob: (path) => apiClient.getBlob(`${base}/files/download?${q(path)}`),
    fileUrl: (path) => `${base}/files/download?${q(path)}`,
    comments: () => apiClient.get<{ comments: SharedComment[] }>(`${base}/comments`),
    addComment: (comment) => apiClient.post<NewSharedComment, { comments: SharedComment[] }>(`${base}/comments`, comment),
    addReply: (id, content) => apiClient.post<{ content: string }, { comments: SharedComment[] }>(`${base}/comments/${id}/replies`, { content }),
    // This Grove relays the calls; a page's frame loads its files from the owner's Grove itself.
    designs: async () => {
      const data = await apiClient.get<SharedDesignData>(`${base}/designs`);
      return { designs: data.designs, comments: data.comments, me: data.me, filesBase: data.filesUrl };
    },
    designPage: (design, file) => apiClient.getText(`${base}/${designPagePath(design, file)}`),
    sketches: () => apiClient.get<SharedSketchData>(`${base}/sketches`),
    sketchScene: (sketchId) => apiClient.get<unknown>(`${base}/sketches/${encodeURIComponent(sketchId)}/scene`),
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

export function publicShareSource(token: string): ShareSource {
  const base = `/api/v1/share/${token}`;
  const q = (path: string) => `path=${encodeURIComponent(path)}`;
  return {
    open: () => publicJson<ShareInfo>(`${base}/open`, { method: 'POST' }),
    diff: () => publicJson<DiffStatsResult>(`${base}/diff`),
    fileDiff: (path, oldPath) =>
      publicJson<DiffFile>(`${base}/diff/file?${q(path)}${oldPath ? `&old_path=${encodeURIComponent(oldPath)}` : ''}`),
    fileContent: async (path) => (await publicJson<{ content: string }>(`${base}/diff/content?${q(path)}`)).content,
    files: () => publicJson<{ files: SharedFile[] }>(`${base}/files`),
    fileText: async (path) => (await publicRequest(`${base}/files/preview?${q(path)}`)).text(),
    fileBlob: async (path) => (await publicRequest(`${base}/files/download?${q(path)}`)).blob(),
    fileUrl: (path) => `${base}/files/download?${q(path)}`,
    comments: () => publicJson<{ comments: SharedComment[] }>(`${base}/comments`),
    addComment: (comment) => publicJson<{ comments: SharedComment[] }>(`${base}/comments`, jsonBody(comment)),
    addReply: (id, content) => publicJson<{ comments: SharedComment[] }>(`${base}/comments/${id}/replies`, jsonBody({ content })),
    designs: async () => {
      const data = await publicJson<SharedDesignData>(`${base}/designs`);
      return { designs: data.designs, comments: data.comments, me: data.me, filesBase: data.filesPath };
    },
    designPage: async (design, file) => (await publicRequest(`${base}/${designPagePath(design, file)}`)).text(),
    sketches: () => publicJson<SharedSketchData>(`${base}/sketches`),
    sketchScene: (sketchId) => publicJson<unknown>(`${base}/sketches/${encodeURIComponent(sketchId)}/scene`),
  };
}
