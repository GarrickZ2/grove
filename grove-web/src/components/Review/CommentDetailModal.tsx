import { useState, useEffect, useRef } from 'react';
import { X, CheckCircle, RotateCcw, Reply, Send, Trash2, Pencil } from 'lucide-react';
import type { ReviewCommentEntry } from '../../api/tasks';
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

interface CommentDetailModalProps {
  comment: ReviewCommentEntry;
  onClose: () => void;
  onResolve?: (id: number) => void;
  onReopen?: (id: number) => void;
  onReply?: (commentId: number, status: string, message: string) => void;
  onDelete?: (id: number) => void;
  onEdit?: (id: number, content: string) => void;
  onEditReply?: (commentId: number, replyId: number, content: string) => void;
  onDeleteReply?: (commentId: number, replyId: number) => void;
}

export function CommentDetailModal({
  comment,
  onClose,
  onResolve,
  onReopen,
  onReply,
  onDelete,
  onEdit,
  onEditReply,
  onDeleteReply,
}: CommentDetailModalProps) {
  const [replyText, setReplyText] = useState('');
  const [showReplyForm, setShowReplyForm] = useState(false);
  const [editingComment, setEditingComment] = useState(false);
  const [editCommentText, setEditCommentText] = useState('');
  const [editingReplyId, setEditingReplyId] = useState<number | null>(null);
  const [editReplyText, setEditReplyText] = useState('');
  const showReplyFormRef = useRef(showReplyForm);
  const editingCommentRef = useRef(editingComment);
  const editingReplyIdRef = useRef(editingReplyId);
  showReplyFormRef.current = showReplyForm;
  editingCommentRef.current = editingComment;
  editingReplyIdRef.current = editingReplyId;

  // Layered Escape: edit forms → reply form → modal, and always stop propagation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (editingReplyIdRef.current !== null) {
          setEditingReplyId(null);
        } else if (editingCommentRef.current) {
          setEditingComment(false);
        } else if (showReplyFormRef.current) {
          setShowReplyForm(false);
          setReplyText('');
        } else {
          onClose();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown, true); // capture phase
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [onClose]);

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

  // Generate location label based on comment type
  const locationLabel = (() => {
    const type = comment.comment_type || 'inline';
    if (type === 'project') {
      return 'Project-level';
    } else if (type === 'file' && comment.file_path) {
      const fileName = comment.file_path.split('/').pop() || comment.file_path;
      return `File: ${fileName}`;
    } else if (comment.start_line !== undefined && comment.end_line !== undefined && comment.file_path) {
      const fileName = comment.file_path.split('/').pop() || comment.file_path;
      const lineLabel = comment.start_line !== comment.end_line
        ? `L${comment.start_line}-${comment.end_line}`
        : `L${comment.start_line}`;
      return `${fileName} ${lineLabel}`;
    }
    return '';
  })();

  const handleSubmitReply = () => {
    if (replyText.trim() && onReply) {
      const status = comment.status === 'outdated' ? 'open' : comment.status;
      onReply(comment.id, status, replyText.trim());
      setReplyText('');
      setShowReplyForm(false);
    }
  };

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
    <div
      className="comment-detail-modal-overlay"
      onClick={onClose}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        className="comment-detail-modal"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--color-bg)',
          borderRadius: 12,
          width: '90%',
          maxWidth: 800,
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 8px 32px rgba(0, 0, 0, 0.3)',
          border: '1px solid var(--color-border)',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 20px',
            borderBottom: '1px solid var(--color-border)',
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <AgentAvatar name={comment.author} size={24} />
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text)', display: 'flex', alignItems: 'center', gap: 8 }}>
                {comment.author}
                <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--color-text-muted)' }}>#{comment.id}</span>
                <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--color-text-muted)' }}>{formatTime(comment.timestamp)}</span>
              </div>
              {locationLabel && (
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 2 }}>
                  {locationLabel}
                </div>
              )}
            </div>
            <span
              style={{
                padding: '2px 8px',
                borderRadius: 4,
                fontSize: 11,
                fontWeight: 600,
                color: statusColor,
                background: `color-mix(in srgb, ${statusColor} 15%, var(--color-bg))`,
              }}
            >
              {statusLabel}
            </span>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              padding: 4,
              color: 'var(--color-text-muted)',
            }}
          >
            <X style={{ width: 20, height: 20 }} />
          </button>
        </div>

        {/* Content */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '20px',
          }}
        >
          {editingComment ? (
            <div>
              <textarea
                value={editCommentText}
                onChange={(e) => setEditCommentText(e.target.value)}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSaveEditComment();
                }}
                style={{
                  width: '100%',
                  minHeight: 100,
                  padding: 12,
                  background: 'var(--color-bg-secondary)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 6,
                  color: 'var(--color-text)',
                  fontSize: 13,
                  fontFamily: 'inherit',
                  resize: 'vertical',
                }}
              />
              <div style={{ display: 'flex', gap: 8, marginTop: 8, justifyContent: 'flex-end' }}>
                <button
                  onClick={() => setEditingComment(false)}
                  style={{
                    padding: '6px 12px',
                    background: 'transparent',
                    border: '1px solid var(--color-border)',
                    borderRadius: 6,
                    color: 'var(--color-text)',
                    cursor: 'pointer',
                    fontSize: 13,
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveEditComment}
                  disabled={!editCommentText.trim()}
                  style={{
                    padding: '6px 12px',
                    background: 'var(--color-highlight)',
                    border: 'none',
                    borderRadius: 6,
                    color: 'var(--color-bg)',
                    cursor: 'pointer',
                    fontSize: 13,
                    fontWeight: 600,
                    opacity: editCommentText.trim() ? 1 : 0.5,
                  }}
                >
                  Save
                </button>
              </div>
            </div>
          ) : (
            <div>
              <MarkdownRenderer content={comment.content} />
            </div>
          )}

          {/* Replies */}
          {comment.replies.length > 0 && (
            <div style={{ marginTop: 20, paddingTop: 20, borderTop: '1px solid var(--color-border)' }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text)', marginBottom: 12 }}>
                Replies ({comment.replies.length})
              </div>
              {comment.replies.map((reply) => (
                <div
                  key={reply.id}
                  style={{
                    padding: '12px',
                    background: 'var(--color-bg-secondary)',
                    borderRadius: 8,
                    marginBottom: 8,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <AgentAvatar name={reply.author} size={18} />
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text)' }}>
                      {reply.author}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{formatTime(reply.timestamp)}</span>
                    <span style={{ flex: 1 }} />
                    {onReply && (
                      <button
                        onClick={() => setShowReplyForm(true)}
                        title="Reply"
                        style={{
                          background: 'transparent',
                          border: 'none',
                          cursor: 'pointer',
                          padding: 2,
                          color: 'var(--color-text-muted)',
                          display: 'flex',
                          alignItems: 'center',
                        }}
                      >
                        <Reply style={{ width: 13, height: 13 }} />
                      </button>
                    )}
                    {onEditReply && (
                      <button
                        onClick={() => handleStartEditReply(reply.id, reply.content)}
                        title="Edit reply"
                        style={{
                          background: 'transparent',
                          border: 'none',
                          cursor: 'pointer',
                          padding: 2,
                          color: 'var(--color-text-muted)',
                          display: 'flex',
                          alignItems: 'center',
                        }}
                      >
                        <Pencil style={{ width: 13, height: 13 }} />
                      </button>
                    )}
                    {onDeleteReply && (
                      <button
                        onClick={() => onDeleteReply(comment.id, reply.id)}
                        title="Delete reply"
                        style={{
                          background: 'transparent',
                          border: 'none',
                          cursor: 'pointer',
                          padding: 2,
                          color: 'var(--color-text-muted)',
                          display: 'flex',
                          alignItems: 'center',
                        }}
                      >
                        <Trash2 style={{ width: 13, height: 13 }} />
                      </button>
                    )}
                  </div>
                  {editingReplyId === reply.id ? (
                    <div>
                      <textarea
                        value={editReplyText}
                        onChange={(e) => setEditReplyText(e.target.value)}
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSaveEditReply();
                        }}
                        style={{
                          width: '100%',
                          minHeight: 60,
                          padding: 8,
                          background: 'var(--color-bg)',
                          border: '1px solid var(--color-border)',
                          borderRadius: 6,
                          color: 'var(--color-text)',
                          fontSize: 13,
                          fontFamily: 'inherit',
                          resize: 'vertical',
                        }}
                      />
                      <div style={{ display: 'flex', gap: 8, marginTop: 6, justifyContent: 'flex-end' }}>
                        <button
                          onClick={() => setEditingReplyId(null)}
                          style={{
                            padding: '4px 10px',
                            background: 'transparent',
                            border: '1px solid var(--color-border)',
                            borderRadius: 6,
                            color: 'var(--color-text)',
                            cursor: 'pointer',
                            fontSize: 12,
                          }}
                        >
                          Cancel
                        </button>
                        <button
                          onClick={handleSaveEditReply}
                          disabled={!editReplyText.trim()}
                          style={{
                            padding: '4px 10px',
                            background: 'var(--color-highlight)',
                            border: 'none',
                            borderRadius: 6,
                            color: 'var(--color-bg)',
                            cursor: 'pointer',
                            fontSize: 12,
                            fontWeight: 600,
                            opacity: editReplyText.trim() ? 1 : 0.5,
                          }}
                        >
                          Save
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ fontSize: 13 }}>
                      <MarkdownRenderer content={reply.content} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Actions */}
        <div
          style={{
            padding: '16px 20px',
            borderTop: '1px solid var(--color-border)',
            display: 'flex',
            gap: 8,
            flexShrink: 0,
          }}
        >
          {onReply && (
            <button
              onClick={() => setShowReplyForm((v) => !v)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 12px',
                background: 'transparent',
                border: '1px solid var(--color-highlight)',
                borderRadius: 6,
                color: 'var(--color-highlight)',
                cursor: 'pointer',
                fontSize: 13,
              }}
            >
              <Reply style={{ width: 14, height: 14 }} />
              Reply
            </button>
          )}
          {onEdit && (
            <button
              onClick={handleStartEditComment}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 12px',
                background: 'transparent',
                border: '1px solid var(--color-border)',
                borderRadius: 6,
                color: 'var(--color-text)',
                cursor: 'pointer',
                fontSize: 13,
              }}
            >
              <Pencil style={{ width: 14, height: 14 }} />
              Edit
            </button>
          )}
          {onResolve && (comment.status === 'open' || comment.status === 'outdated') && (
            <button
              onClick={() => {
                onResolve(comment.id);
                onClose();
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 12px',
                background: 'transparent',
                border: '1px solid var(--color-border)',
                borderRadius: 6,
                color: 'var(--color-success)',
                cursor: 'pointer',
                fontSize: 13,
              }}
            >
              <CheckCircle style={{ width: 14, height: 14 }} />
              Resolve
            </button>
          )}
          {onReopen && comment.status === 'resolved' && (
            <button
              onClick={() => {
                onReopen(comment.id);
                onClose();
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 12px',
                background: 'transparent',
                border: '1px solid var(--color-border)',
                borderRadius: 6,
                color: 'var(--color-warning)',
                cursor: 'pointer',
                fontSize: 13,
              }}
            >
              <RotateCcw style={{ width: 14, height: 14 }} />
              Reopen
            </button>
          )}
          {onDelete && (
            <button
              onClick={() => {
                onDelete(comment.id);
                onClose();
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 12px',
                background: 'transparent',
                border: '1px solid var(--color-border)',
                borderRadius: 6,
                color: 'var(--color-error)',
                cursor: 'pointer',
                fontSize: 13,
                marginLeft: 'auto',
              }}
            >
              <Trash2 style={{ width: 14, height: 14 }} />
              Delete
            </button>
          )}
        </div>

        {/* Reply Form */}
        {showReplyForm && (
          <div
            style={{
              padding: '16px 20px',
              borderTop: '1px solid var(--color-border)',
              background: 'var(--color-bg-secondary)',
            }}
          >
            <textarea
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              placeholder="Write a reply... (Markdown supported)"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSubmitReply();
              }}
              style={{
                width: '100%',
                minHeight: 80,
                padding: 12,
                background: 'var(--color-bg)',
                border: '1px solid var(--color-border)',
                borderRadius: 6,
                color: 'var(--color-text)',
                fontSize: 13,
                fontFamily: 'inherit',
                resize: 'vertical',
              }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 8, justifyContent: 'flex-end' }}>
              <button
                onClick={() => {
                  setShowReplyForm(false);
                  setReplyText('');
                }}
                style={{
                  padding: '6px 12px',
                  background: 'transparent',
                  border: '1px solid var(--color-border)',
                  borderRadius: 6,
                  color: 'var(--color-text)',
                  cursor: 'pointer',
                  fontSize: 13,
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleSubmitReply}
                disabled={!replyText.trim()}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 12px',
                  background: 'var(--color-highlight)',
                  border: 'none',
                  borderRadius: 6,
                  color: 'var(--color-bg)',
                  cursor: 'pointer',
                  fontSize: 13,
                  fontWeight: 600,
                  opacity: replyText.trim() ? 1 : 0.5,
                }}
              >
                <Send style={{ width: 14, height: 14 }} />
                Reply
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
