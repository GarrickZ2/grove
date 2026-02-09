import { useState, useEffect, useRef } from 'react';
import { X, CheckCircle, RotateCcw, Reply, Send, Trash2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ReviewCommentEntry } from '../../api/tasks';
import { AgentAvatar } from './AgentAvatar';

interface CommentDetailModalProps {
  comment: ReviewCommentEntry;
  onClose: () => void;
  onResolve?: (id: number) => void;
  onReopen?: (id: number) => void;
  onReply?: (commentId: number, status: string, message: string) => void;
  onDelete?: (id: number) => void;
}

export function CommentDetailModal({
  comment,
  onClose,
  onResolve,
  onReopen,
  onReply,
  onDelete,
}: CommentDetailModalProps) {
  const [replyText, setReplyText] = useState('');
  const [showReplyForm, setShowReplyForm] = useState(false);
  const showReplyFormRef = useRef(showReplyForm);
  showReplyFormRef.current = showReplyForm;

  // Layered Escape: reply form → modal, and always stop propagation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (showReplyFormRef.current) {
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
              <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text)' }}>
                {comment.author}
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
          <div className="markdown-content">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {comment.content}
            </ReactMarkdown>
          </div>

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
                  </div>
                  <div className="markdown-content" style={{ fontSize: 13 }}>
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {reply.content}
                    </ReactMarkdown>
                  </div>
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
