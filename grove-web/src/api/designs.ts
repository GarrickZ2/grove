// Designs API client: HTML pages on a board, in Studio tasks.
// Backend routes are mounted under /api/v1/projects/{id}/tasks/{taskId}/designs

import { apiClient, machineUrl } from './client';
import { replyReviewComment } from './review';

export interface DesignPage {
  file: string;
  title: string;
  x: number;
  y: number;
  /** The viewport the page is designed for. */
  width: number;
  height: number;
  /** How tall the page came out the last time it was rendered. */
  rendered_height?: number;
  /** False when design.json gives no position and Grove placed the page. */
  placed: boolean;
  /** Changes when the page or anything it depends on changes. */
  version: string;
  /** The version the stored render was made from. */
  capture_version?: string;
}

export interface DesignLabel {
  text: string;
  x: number;
  y: number;
  size: 'title' | 'subtitle';
}

/** Something the user wrote or drew on the board. Positions are board pixels. */
export interface DesignMark {
  id: string;
  kind: 'note' | 'text' | 'rect' | 'ellipse' | 'arrow' | 'pen';
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  /** Its stroke, text or note color; the panel's default when absent. */
  color?: string;
  /** How heavy a shape's or pen stroke's line is, in screen pixels; the panel's default when absent. */
  stroke?: number;
  /** A pen stroke: x, y pairs measured from the mark's own corner. An arrow runs from the first pair to the second. */
  points?: number[];
}

export interface Design {
  slug: string;
  name: string;
  is_system: boolean;
  pages: DesignPage[];
  labels: DesignLabel[];
  marks: DesignMark[];
  has_guide: boolean;
  warnings: string[];
}

/** Where a comment sits on its page. */
export interface DesignAnchor {
  selector?: string;
  xpath?: string;
  text?: string;
  /** The element's box in page pixels when the comment was made. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesignReply {
  id: number;
  author: string;
  content: string;
  timestamp: string;
}

export interface DesignComment {
  id: number;
  design: string;
  page: string;
  anchor: DesignAnchor | null;
  author: string;
  content: string;
  timestamp: string;
  status: 'open' | 'resolved';
  via_share: boolean;
  replies: DesignReply[];
}

export interface DesignComments {
  comments: DesignComment[];
  me?: string | null;
}

/** One issue the page check found. */
export interface DesignIssue {
  message: string;
  selector?: string;
}

export interface DesignReport {
  height: number;
  issues: DesignIssue[];
}

/** Designs someone else shared: read through their share link, not this Grove's own tasks. */
export interface SharedDesigns {
  list(): Promise<{ designs: Design[]; comments: DesignComment[]; me: string; filesBase: string }>;
  page(design: string, file: string): Promise<string>;
  addComment(comment: { design: string; page: string; anchor: DesignAnchor | null; content: string }): Promise<void>;
  /** Answer in a thread; absent where the reader can only look. */
  reply?(id: number, content: string): Promise<void>;
}

type SharedList = Awaited<ReturnType<SharedDesigns['list']>>;
const sharedSources = new Map<string, { source: SharedDesigns; pending: Promise<SharedList> | null; filesBase: string }>();

/**
 * Serve the designs of `projectId` from a share link. The Design panel then
 * works as it does for an own task, reading through `source`; pass null when
 * the shared view closes.
 */
export function shareDesignSource(projectId: string, source: SharedDesigns | null): void {
  if (!source) {
    sharedSources.delete(projectId);
    return;
  }
  // Given again for the same share, only what it calls changes: the address
  // its pages load files from is kept, or pages drawn meanwhile lose their styles.
  const existing = sharedSources.get(projectId);
  if (existing) existing.source = source;
  else sharedSources.set(projectId, { source, pending: null, filesBase: '' });
}

const SYSTEM_KEY = 'design-system:';

/**
 * The `projectId` under which the Design panel shows a Project's design
 * system on its own, read from the Project and not from one of its tasks.
 */
export function designSystemKey(projectId: string): string {
  return `${SYSTEM_KEY}${projectId}`;
}

/** A Project's design system as a source: one board, to look at. */
function systemSource(projectId: string): SharedDesigns {
  const path = `/api/v1/projects/${projectId}/design-system`;
  return {
    list: async () => {
      const data = await apiClient.get<{ design: Design | null; token: string; project: string }>(path);
      const files = machineUrl(`/api/v1/design-files/system/${data.token}/${data.project}/`);
      return { designs: data.design ? [data.design] : [], comments: [], me: '', filesBase: new URL(files, window.location.href).href };
    },
    page: (_design, file) => apiClient.getText(`${path}/pages/${encodeURIComponent(file)}`),
    addComment: () => Promise.reject(new Error('The design system is commented on from a task')),
  };
}

/** Where `projectId`'s designs are read from when not from a task of this Grove. */
function sourceOf(projectId: string) {
  let entry = sharedSources.get(projectId);
  if (!entry && projectId.startsWith(SYSTEM_KEY)) {
    entry = { source: systemSource(projectId.slice(SYSTEM_KEY.length)), pending: null, filesBase: '' };
    sharedSources.set(projectId, entry);
  }
  return entry;
}

/** One read serves the designs and their comments, which are asked for together. */
function sharedList(projectId: string): Promise<SharedList> | null {
  const entry = sourceOf(projectId);
  if (!entry) return null;
  if (!entry.pending) {
    const pending = entry.source.list().then((data) => {
      entry.filesBase = data.filesBase;
      return data;
    });
    entry.pending = pending;
    const clear = () => { if (entry.pending === pending) entry.pending = null; };
    pending.then(() => window.setTimeout(clear, 0), clear);
  }
  return entry.pending;
}

const base = (projectId: string, taskId: string) =>
  `/api/v1/projects/${projectId}/tasks/${taskId}/designs`;

/** `watch` tells the server a window is showing the designs right now. */
export async function listDesigns(projectId: string, taskId: string, watch = false): Promise<Design[]> {
  const shared = sharedList(projectId);
  if (shared) return (await shared).designs;
  const data = await apiClient.get<{ designs: Design[] }>(`${base(projectId, taskId)}${watch ? '?watch=true' : ''}`);
  return data.designs;
}

export function getDesignPage(projectId: string, taskId: string, design: string, file: string): Promise<string> {
  const shared = sourceOf(projectId);
  if (shared) return shared.source.page(design, file);
  return apiClient.getText(`${base(projectId, taskId)}/${encodeURIComponent(design)}/pages/${encodeURIComponent(file)}`);
}

/** Whether a write was refused because the file is no longer what the panel read. */
export function isChangedSince(error: unknown): boolean {
  return (error as { status?: number } | null)?.status === 409;
}

/**
 * Replace a page's HTML after an edit made in the panel. `expect` is what the
 * panel read: the write is refused when the file holds something else by now.
 */
export function updateDesignPage(projectId: string, taskId: string, design: string, file: string, html: string, expect: string): Promise<void> {
  return apiClient.put(`${base(projectId, taskId)}/${encodeURIComponent(design)}/pages/${encodeURIComponent(file)}`, { html, expect });
}

/** Replace what the user wrote and drew on a board. */
export function updateDesignMarks(projectId: string, taskId: string, design: string, marks: DesignMark[]): Promise<void> {
  return apiClient.put(`${base(projectId, taskId)}/${encodeURIComponent(design)}/marks`, { marks });
}

/** An empty page where the user drew a frame. */
export function createDesignPage(
  projectId: string, taskId: string, design: string, frame: { x: number; y: number; width: number; height: number },
): Promise<{ file: string }> {
  return apiClient.post(`${base(projectId, taskId)}/${encodeURIComponent(design)}/pages`, frame);
}

/** Replace a stylesheet under `design/` after one of its variables changed. */
export function updateDesignStyle(projectId: string, taskId: string, path: string, css: string, expect: string): Promise<void> {
  return apiClient.put(`${base(projectId, taskId)}/styles`, { path, css, expect });
}

/** The design system's DESIGN.md; null when there is none. */
export async function getDesignGuide(projectId: string, taskId: string): Promise<string | null> {
  const shared = sourceOf(projectId);
  if (shared) {
    const response = await fetch(new URL('system/DESIGN.md', new URL(shared.filesBase, window.location.href)).href).catch(() => null);
    return response?.ok ? response.text() : null;
  }
  try {
    return await apiClient.getText(`${base(projectId, taskId)}/guide`);
  } catch {
    return null;
  }
}

export interface PageChange {
  file: string;
  x?: number;
  y?: number;
  rendered_height?: number;
}

export interface LabelChange {
  index: number;
  text: string;
  x: number;
  y: number;
}

export async function updateDesignLayout(
  projectId: string,
  taskId: string,
  design: string,
  changes: { pages?: PageChange[]; labels?: LabelChange[] },
): Promise<void> {
  await apiClient.patch(`${base(projectId, taskId)}/${encodeURIComponent(design)}/layout`, changes);
}

/** What this window rendered for a page, for the agent to read back. */
export async function uploadDesignCapture(
  projectId: string,
  taskId: string,
  design: string,
  file: string,
  capture: { version: string; image?: string; report: DesignReport },
): Promise<void> {
  await apiClient.post(
    `${base(projectId, taskId)}/${encodeURIComponent(design)}/pages/${encodeURIComponent(file)}/capture`,
    capture,
  );
}

export async function listDesignComments(projectId: string, taskId: string): Promise<DesignComments> {
  const shared = sharedList(projectId);
  if (shared) {
    const data = await shared;
    return { comments: data.comments, me: data.me };
  }
  return apiClient.get<DesignComments>(`${base(projectId, taskId)}/comments`);
}

export function createDesignComment(
  projectId: string,
  taskId: string,
  comment: { design: string; page: string; anchor: DesignAnchor | null; content: string },
): Promise<DesignComments> {
  const shared = sourceOf(projectId);
  if (shared) {
    return shared.source.addComment(comment).then(async () => {
      const data = await shared.source.list();
      return { comments: data.comments, me: data.me };
    });
  }
  return apiClient.post<typeof comment, DesignComments>(`${base(projectId, taskId)}/comments`, comment);
}

/** A path capability for the files pages load from inside their frames. */
export async function createDesignSession(projectId: string, taskId: string): Promise<string> {
  // A share link's files come from a path the owner's Grove hands out with the designs.
  if (sourceOf(projectId)) return 'shared';
  const data = await apiClient.post<undefined, { token: string }>(`${base(projectId, taskId)}/session`);
  return data.token;
}

/** Absolute URL of a design's directory, for a page's `<base href>`. */
export function designFilesBase(token: string, projectId: string, taskId: string, design: string): string {
  const shared = sourceOf(projectId);
  if (shared) return new URL(`${encodeURIComponent(design)}/`, new URL(shared.filesBase, window.location.href)).href;
  const path = machineUrl(`/api/v1/design-files/${token}/${projectId}/${taskId}/${encodeURIComponent(design)}/`);
  return new URL(path, window.location.href).href;
}

/** A design as a zip of its files, the design system beside it. */
export function designExportUrl(projectId: string, taskId: string, design: string): string {
  return `${base(projectId, taskId)}/${encodeURIComponent(design)}/export`;
}

/** One page: as a single HTML file with its files inside, or the image last rendered of it. */
export function designPageExportUrl(projectId: string, taskId: string, design: string, file: string, format: 'html' | 'png'): string {
  return `${base(projectId, taskId)}/${encodeURIComponent(design)}/pages/${encodeURIComponent(file)}/export?format=${format}`;
}

export interface DesignImport {
  /** The designs that were added, by directory name. */
  designs: string[];
  system: 'installed' | 'replaced' | 'kept' | 'none';
}

/**
 * Bring a zip of designs, a design system or both into the task. When the zip
 * has a design system and the Project has one already, nothing is written and
 * the answer is 'system-exists' until `system` says which to keep.
 */
export async function importDesigns(
  projectId: string,
  taskId: string,
  file: File,
  system?: 'skip' | 'overwrite',
): Promise<DesignImport | 'system-exists'> {
  const form = new FormData();
  form.append('file', file);
  try {
    return await apiClient.postFormData<DesignImport>(`${base(projectId, taskId)}/import${system ? `?system=${system}` : ''}`, form);
  } catch (error) {
    if ((error as { status?: number } | null)?.status === 409) return 'system-exists';
    throw error;
  }
}

/** Whether the reader of `projectId`'s designs can answer in a thread. */
export function canReplyToDesignComments(projectId: string): boolean {
  const shared = sourceOf(projectId);
  return shared ? Boolean(shared.source.reply) : true;
}

/** Answer in a comment's thread. */
export async function replyDesignComment(projectId: string, taskId: string, id: number, content: string): Promise<void> {
  const shared = sourceOf(projectId);
  if (shared) {
    if (!shared.source.reply) throw new Error('This link is read-only');
    await shared.source.reply(id, content);
    return;
  }
  await replyReviewComment(projectId, taskId, id, content);
}
