import { useState } from 'react';
import { X, Send, MessageSquare, Trash2, Reply, CheckCircle, RotateCcw, Minus, Pencil, Plus } from 'lucide-react';
import type { ReviewCommentEntry } from '../../api/tasks';
import type { CommentAnchor } from './DiffReviewPage';
import { AgentAvatar } from './AgentAvatar';
import { MarkdownRenderer } from '../ui';

/** Format ISO timestamp to human-readable local time, e.g. "2026-02-10 08:37:24" */
function formatTime(ts: string): string {
  try {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return ts;
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch {
    return ts;
  }
}

// ============================================================================
// Comment Card — GitHub/GitLab style with avatar, author, timestamp, replies
// ============================================================================

interface CommentCardProps {
  comment: ReviewCommentEntry;
  onDelete?: (id: number) => void;
  onReply?: (id: number) => void;
  onResolve?: (id: number) => void;
  onReopen?: (id: number) => void;
  onCollapse?: (id: number) => void;
  onExpand?: (id: number) => void;
  onEdit?: (id: number, content: string) => void;
  onEditReply?: (commentId: number, replyId: number, content: string) => void;
  onDeleteReply?: (commentId: number, replyId: number) => void;
  isCollapsed?: boolean;
}

export function CommentCard({ comment, onDelete, onReply, onResolve, onReopen, onCollapse, onExpand, onEdit, onEditReply, onDeleteReply, isCollapsed }: CommentCardProps) {
  const [editingComment, setEditingComment] = useState(false);
  const [editCommentText, setEditCommentText] = useState('');
  const [editingReplyId, setEditingReplyId] = useState<number | null>(null);
  const [editReplyText, setEditReplyText] = useState('');

  const statusColor =
    comment.status === 'resolved'
      ? 'var(--color-success)'
      : comment.status === 'outdated'
        ? 'var(--color-text-muted)'
        : 'var(--color-warning)';

  const statusLabel =
    comment.status === 'resolved'
      ? 'Resolved'
      : comment.status === 'outdated'
        ? 'Outdated'
        : 'Open';

  const lineRange = comment.start_line !== comment.end_line
    ? `L${comment.start_line}-L${comment.end_line}`
    : null;

  const handleStartEditComment = () => {
    setEditCommentText(comment.content);
    setEditingComment(true);
  };

  const handleSaveEditComment = () => {
    if (editCommentText.trim() && onEdit) {
      onEdit(comment.id, editCommentText.trim());
      setEditingComment(false);
    }
  };

  const handleStartEditReply = (replyId: number, content: string) => {
    setEditReplyText(content);
    setEditingReplyId(replyId);
  };

  const handleSaveEditReply = () => {
    if (editReplyText.trim() && onEditReply && editingReplyId !== null) {
      onEditReply(comment.id, editingReplyId, editReplyText.trim());
      setEditingReplyId(null);
    }
  };

  return (
    <div className="diff-comment-card">
      {/* Header: avatar + author + time + line range + status badge + actions */}
      <div className="diff-comment-header">
        <AgentAvatar name={comment.author || '?'} size={24} className="diff-comment-avatar" />
        <span className="diff-comment-author">{comment.author}</span>
        <span className="diff-comment-id">#{comment.id}</span>
        <span className="diff-comment-time">{formatTime(comment.timestamp)}</span>
        {lineRange && (
          <span style={{ fontSize: 10, color: 'var(--color-text-muted)', fontFamily: 'monospace' }}>{lineRange}</span>
        )}
        <span
          className="diff-comment-status-badge"
          style={{
            color: statusColor,
            background: `color-mix(in srgb, ${statusColor} 15%, var(--color-bg))`,
          }}
        >
          {statusLabel}
        </span>
        <span className="diff-comment-actions">
          {onResolve && (comment.status === 'open' || comment.status === 'outdated') && (
            <button
              className="diff-comment-action-btn"
              onClick={() => onResolve(comment.id)}
              title="Resolve"
            >
              <CheckCircle style={{ width: 13, height: 13 }} />
            </button>
          )}
          {onReopen && comment.status === 'resolved' && (
            <button
              className="diff-comment-action-btn"
              onClick={() => onReopen(comment.id)}
              title="Reopen"
            >
              <RotateCcw style={{ width: 13, height: 13 }} />
            </button>
          )}
          {onReply && (
            <button
              className="diff-comment-action-btn"
              onClick={() => onReply(comment.id)}
              title="Reply"
            >
              <Reply style={{ width: 13, height: 13 }} />
            </button>
          )}
          {onEdit && (
            <button
              className="diff-comment-action-btn"
              onClick={handleStartEditComment}
              title="Edit comment"
            >
              <Pencil style={{ width: 13, height: 13 }} />
            </button>
          )}
          {isCollapsed ? (
            onExpand && (
              <button
                className="diff-comment-action-btn"
                onClick={() => onExpand(comment.id)}
                title="Show comment"
              >
                <Plus style={{ width: 13, height: 13 }} />
              </button>
            )
          ) : (
            onCollapse && (
              <button
                className="diff-comment-action-btn"
                onClick={() => onCollapse(comment.id)}
                title="Hide comment"
              >
                <Minus style={{ width: 13, height: 13 }} />
              </button>
            )
          )}
          {onDelete && (
            <button
              className="diff-comment-action-btn"
              onClick={() => onDelete(comment.id)}
              title="Delete comment"
            >
              <Trash2 style={{ width: 13, height: 13 }} />
            </button>
          )}
        </span>
      </div>

      {/* Body — editable or read-only (hidden when collapsed) */}
      {!isCollapsed && (
        <>
          {editingComment ? (
            <div style={{ padding: '4px 0' }}>
              <textarea
                className="diff-reply-textarea"
                value={editCommentText}
                onChange={(e) => setEditCommentText(e.target.value)}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSaveEditComment();
                  if (e.key === 'Escape') setEditingComment(false);
                }}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 4 }}>
                <button
                  onClick={() => setEditingComment(false)}
                  style={{
                    padding: '3px 10px',
                    background: 'var(--color-bg-tertiary)',
                    border: '1px solid var(--color-border)',
                    borderRadius: 6,
                    color: 'var(--color-text-muted)',
                    fontSize: 11,
                    cursor: 'pointer',
                  }}
                >
                  Cancel
                </button>
                <button
                  className="diff-reply-submit-btn"
                  disabled={!editCommentText.trim()}
                  onClick={handleSaveEditComment}
                  style={{ fontSize: 11, padding: '3px 10px' }}
                >
                  Save
                </button>
              </div>
            </div>
          ) : (
            <div style={{ padding: '0 12px 10px 12px', whiteSpace: 'normal' }}>
              <MarkdownRenderer content={comment.content} />
            </div>
          )}

          {/* Replies */}
          {comment.replies.map((reply) => (
            <div key={reply.id} className="diff-comment-reply">
              <div className="diff-comment-header">
                <AgentAvatar name={reply.author} size={18} className="diff-comment-avatar small" />
                <span className="diff-comment-author" style={{ fontSize: 11 }}>{reply.author}</span>
                <span className="diff-comment-time">{formatTime(reply.timestamp)}</span>
                <span className="diff-comment-actions">
                  {onReply && (
                    <button
                      className="diff-comment-action-btn"
                      onClick={() => onReply(comment.id)}
                      title="Reply"
                    >
                      <Reply style={{ width: 11, height: 11 }} />
                    </button>
                  )}
                  {onEditReply && (
                    <button
                      className="diff-comment-action-btn"
                      onClick={() => handleStartEditReply(reply.id, reply.content)}
                      title="Edit reply"
                    >
                      <Pencil style={{ width: 11, height: 11 }} />
                    </button>
                  )}
                  {onDeleteReply && (
                    <button
                      className="diff-comment-action-btn"
                      onClick={() => onDeleteReply(comment.id, reply.id)}
                      title="Delete reply"
                    >
                      <Trash2 style={{ width: 11, height: 11 }} />
                    </button>
                  )}
                </span>
              </div>
              {editingReplyId === reply.id ? (
                <div style={{ padding: '4px 0' }}>
                  <textarea
                    className="diff-reply-textarea"
                    value={editReplyText}
                    onChange={(e) => setEditReplyText(e.target.value)}
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSaveEditReply();
                      if (e.key === 'Escape') setEditingReplyId(null);
                    }}
                  />
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 4 }}>
                    <button
                      onClick={() => setEditingReplyId(null)}
                      style={{
                        padding: '3px 10px',
                        background: 'var(--color-bg-tertiary)',
                        border: '1px solid var(--color-border)',
                        borderRadius: 6,
                        color: 'var(--color-text-muted)',
                        fontSize: 11,
                        cursor: 'pointer',
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      className="diff-reply-submit-btn"
                      disabled={!editReplyText.trim()}
                      onClick={handleSaveEditReply}
                      style={{ fontSize: 11, padding: '3px 10px' }}
                    >
                      Save
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ padding: 0, whiteSpace: 'normal' }}>
                  <MarkdownRenderer content={reply.content} />
                </div>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

// ============================================================================
// Reply Form — inline reply with Resolve + Reply buttons
// ============================================================================

interface ReplyFormProps {
  commentId: number;
  onSubmit: (commentId: number, status: string, message: string) => void;
  onCancel: () => void;
}

export function ReplyForm({ commentId, onSubmit, onCancel }: ReplyFormProps) {
  const [message, setMessage] = useState('');

  return (
    <div className="diff-reply-form">
      <textarea
        className="diff-reply-textarea"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Write a reply..."
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            if (message.trim()) onSubmit(commentId, 'open', message.trim());
          }
          if (e.key === 'Escape') onCancel();
        }}
      />
      <div className="diff-reply-actions">
        <button
          onClick={onCancel}
          style={{
            padding: '4px 12px',
            background: 'var(--color-bg-tertiary)',
            border: '1px solid var(--color-border)',
            borderRadius: 6,
            color: 'var(--color-text-muted)',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          Cancel
        </button>
        <button
          className="diff-reply-submit-btn"
          disabled={!message.trim()}
          onClick={() => {
            if (message.trim()) onSubmit(commentId, 'open', message.trim());
          }}
        >
          Reply
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// Comment Form — add a new comment with CommentAnchor
// ============================================================================

interface CommentFormProps {
  anchor: CommentAnchor;
  onSubmit: (anchor: CommentAnchor, content: string) => void;
  onCancel: () => void;
}

export function CommentForm({ anchor, onSubmit, onCancel }: CommentFormProps) {
  const [content, setContent] = useState('');

  const handleSubmit = () => {
    if (content.trim()) {
      onSubmit(anchor, content.trim());
      setContent('');
    }
  };

  const locationLabel = anchor.startLine !== anchor.endLine
    ? `${anchor.filePath}:${anchor.side}:${anchor.startLine}-${anchor.endLine}`
    : `${anchor.filePath}:${anchor.side}:${anchor.startLine}`;

  return (
    <div
      style={{
        background: 'var(--color-bg-secondary)',
        border: '1px solid var(--color-highlight)',
        borderRadius: 8,
        padding: '8px 12px',
        margin: '6px 16px 6px 60px',
        fontSize: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <MessageSquare style={{ width: 12, height: 12, color: 'var(--color-highlight)' }} />
        <span style={{ color: 'var(--color-text-muted)', fontSize: 11 }}>New comment at {locationLabel}</span>
      </div>
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="Write a comment..."
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSubmit();
          if (e.key === 'Escape') onCancel();
        }}
        className="diff-reply-textarea"
      />
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 6 }}>
        <button
          onClick={onCancel}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '4px 10px',
            background: 'var(--color-bg-tertiary)',
            border: '1px solid var(--color-border)',
            borderRadius: 6,
            color: 'var(--color-text-muted)',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          <X style={{ width: 12, height: 12 }} /> Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={!content.trim()}
          className="diff-reply-submit-btn"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <Send style={{ width: 12, height: 12 }} /> Comment
        </button>
      </div>
    </div>
  );
}
