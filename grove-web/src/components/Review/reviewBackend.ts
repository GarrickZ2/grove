import {
  getDiffStats,
  getSingleFileDiff,
  createInlineComment,
  createFileComment,
  createProjectComment,
  deleteComment,
  replyReviewComment,
  updateCommentStatus,
  getFileContent,
  editComment,
  editReply,
  deleteReply,
  bulkDeleteComments,
} from '../../api/review';
import type { DiffFile, DiffStatsResult } from '../../api/review';
import {
  getReviewComments,
  getCommits,
  getTaskFiles,
  getTaskDirEntries,
  getTask,
  openTaskFile,
  revealTaskFile,
} from '../../api/tasks';
import type { CommitsResponse, DirEntriesResponse, ReviewCommentsResponse } from '../../api/tasks';
import type { ShareSource, SharedComment } from '../../api/shares';

type Comments = Promise<ReviewCommentsResponse>;

/**
 * Where Code Review reads a Task from. The owner's own Task has everything;
 * a Task someone shared has only its changes and comments. What a backend
 * can't do, it refuses, and the flags keep the review from asking.
 */
export interface ReviewBackend {
  /** The owner's own review: reply, resolve, edit, merge, send to the agent. */
  owner: boolean;
  /** New comments (inline, on a file, on the whole Task). */
  canComment: boolean;
  /** All files of the Task, not only its changes, and its commit history. */
  canBrowse: boolean;
  diffStats(fromRef?: string, toRef?: string): Promise<DiffStatsResult>;
  fileDiff(path: string, fromRef?: string, toRef?: string, oldPath?: string): Promise<DiffFile>;
  /** The file as the Task has it now, to expand context around a change. */
  fileContent(path: string): Promise<string>;
  comments(): Comments;
  addInline(anchor: { filePath: string; side: string; startLine: number; endLine: number }, content: string, author?: string): Comments;
  addFileComment(filePath: string, content: string, author?: string): Comments;
  addProjectComment(content: string, author?: string): Comments;
  reply(commentId: number, message: string, author?: string): Comments;
  setStatus(commentId: number, status: 'open' | 'resolved'): Comments;
  deleteComment(commentId: number): Comments;
  editComment(commentId: number, content: string): Comments;
  editReply(commentId: number, replyId: number, content: string): Comments;
  deleteReply(commentId: number, replyId: number): Comments;
  bulkDelete(statuses?: string[], authors?: string[]): Comments;
  commits(): Promise<CommitsResponse>;
  taskFiles(): Promise<{ files: string[] }>;
  dirEntries(dirPath: string): Promise<DirEntriesResponse>;
  taskPath(signal: AbortSignal): Promise<string>;
  openFile(path: string): Promise<void>;
  revealFile(path: string): Promise<void>;
}

export function ownerBackend(projectId: string, taskId: string): ReviewBackend {
  return {
    owner: true,
    canComment: true,
    canBrowse: true,
    diffStats: (fromRef, toRef) => getDiffStats(projectId, taskId, fromRef, toRef),
    fileDiff: (path, fromRef, toRef, oldPath) => getSingleFileDiff(projectId, taskId, path, fromRef, toRef, oldPath),
    comments: () => getReviewComments(projectId, taskId),
    addInline: (anchor, content, author) => createInlineComment(projectId, taskId, anchor, content, author),
    addFileComment: (filePath, content, author) => createFileComment(projectId, taskId, filePath, content, author),
    addProjectComment: (content, author) => createProjectComment(projectId, taskId, content, author),
    fileContent: (path) => getFileContent(projectId, taskId, path),
    reply: (commentId, message, author) => replyReviewComment(projectId, taskId, commentId, message, author),
    setStatus: (commentId, status) => updateCommentStatus(projectId, taskId, commentId, status),
    deleteComment: (commentId) => deleteComment(projectId, taskId, commentId),
    editComment: (commentId, content) => editComment(projectId, taskId, commentId, content),
    editReply: (commentId, replyId, content) => editReply(projectId, taskId, commentId, replyId, content),
    deleteReply: (commentId, replyId) => deleteReply(projectId, taskId, commentId, replyId),
    bulkDelete: (statuses, authors) => bulkDeleteComments(projectId, taskId, statuses, authors),
    commits: () => getCommits(projectId, taskId),
    taskFiles: () => getTaskFiles(projectId, taskId),
    dirEntries: (dirPath) => getTaskDirEntries(projectId, taskId, dirPath),
    taskPath: async (signal) => (await getTask(projectId, taskId, signal)).path,
    openFile: (path) => openTaskFile(projectId, taskId, path),
    revealFile: (path) => revealTaskFile(projectId, taskId, path),
  };
}

function reviewComments(comments: SharedComment[]): ReviewCommentsResponse {
  const entries = comments.map((comment) => ({
    id: comment.id,
    comment_type: comment.commentType,
    file_path: comment.filePath ?? undefined,
    side: comment.side ?? undefined,
    start_line: comment.startLine ?? undefined,
    end_line: comment.endLine ?? undefined,
    content: comment.content,
    // Comment cards show `agent` as the author's name, the same as in the
    // owner's own review.
    agent: comment.author,
    model: '',
    role: '',
    timestamp: comment.timestamp,
    status: comment.status,
    replies: comment.replies.map((reply, index) => ({
      id: index + 1,
      content: reply.content,
      agent: reply.author,
      model: '',
      role: '',
      timestamp: reply.timestamp,
    })),
  }));
  const count = (status: string) => entries.filter((entry) => entry.status === status).length;
  return {
    comments: entries,
    open_count: count('open'),
    resolved_count: count('resolved'),
    outdated_count: count('outdated'),
  };
}

const refused = () => Promise.reject(new Error('Not available on a shared task'));

/** A Task someone shared: its latest changes and comments; new comments if
 *  the link allows. */
export function shareBackend(source: ShareSource, { canComment }: { canComment: boolean }): ReviewBackend {
  const comments = async () => reviewComments((await source.comments()).comments);
  const add = async (comment: Parameters<ShareSource['addComment']>[0]) =>
    canComment ? reviewComments((await source.addComment(comment)).comments) : refused();
  return {
    owner: false,
    canComment,
    canBrowse: false,
    diffStats: () => source.diff(),
    fileDiff: (path, _fromRef, _toRef, oldPath) => source.fileDiff(path, oldPath),
    fileContent: (path) => source.fileContent(path),
    comments,
    addInline: (anchor, content) => add({
      commentType: 'inline',
      filePath: anchor.filePath,
      side: anchor.side === 'DELETE' ? 'DELETE' : 'ADD',
      startLine: anchor.startLine,
      endLine: anchor.endLine,
      content,
    }),
    addFileComment: (filePath, content) => add({ commentType: 'file', filePath, content }),
    addProjectComment: (content) => add({ commentType: 'project', content }),
    reply: refused,
    setStatus: refused,
    deleteComment: refused,
    editComment: refused,
    editReply: refused,
    deleteReply: refused,
    bulkDelete: refused,
    commits: refused,
    taskFiles: refused,
    dirEntries: refused,
    taskPath: refused,
    openFile: refused,
    revealFile: refused,
  };
}
