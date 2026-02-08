import { useState, useMemo } from 'react';
import { MessageSquare, CheckCircle, RotateCcw, Reply, Send, FileCode, ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
import type { ReviewCommentEntry } from '../../api/tasks';
import { AgentAvatar } from './AgentAvatar';

type StatusFilter = 'all' | 'open' | 'resolved' | 'outdated';

interface ConversationSidebarProps {
  comments: ReviewCommentEntry[];
  visible: boolean;
  onNavigateToComment: (filePath: string, line: number) => void;
  onResolveComment?: (id: number) => void;
  onReopenComment?: (id: number) => void;
  onReplyComment?: (commentId: number, status: string, message: string) => void;
  onDeleteComment?: (id: number) => void;
}

export function ConversationSidebar({
  comments,
  visible,
  onNavigateToComment,
  onResolveComment,
  onReopenComment,
  onReplyComment,
  onDeleteComment,
}: ConversationSidebarProps) {
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());

  // Status counts
  const openCount = comments.filter((c) => c.status === 'open').length;
  const resolvedCount = comments.filter((c) => c.status === 'resolved').length;
  const outdatedCount = comments.filter((c) => c.status === 'outdated').length;

  // Filter
  const filtered = useMemo(() => {
    if (filter === 'all') return comments;
    return comments.filter((c) => c.status === filter);
  }, [comments, filter]);

  // Group by file
  const grouped = useMemo(() => {
    const map = new Map<string, ReviewCommentEntry[]>();
    for (const c of filtered) {
      const list = map.get(c.file_path) || [];
      list.push(c);
      map.set(c.file_path, list);
    }
    return map;
  }, [filtered]);

  const toggleFile = (path: string) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div className={`conv-sidebar ${visible ? '' : 'collapsed'}`}>
      {/* Header */}
      <div className="conv-sidebar-header">
        <MessageSquare style={{ width: 14, height: 14 }} />
        <span>Conversation</span>
        <span className="conv-sidebar-count">{comments.length}</span>
      </div>

      {/* Filter tabs */}
      <div className="conv-filter-bar">
        <button
          className={`conv-filter-btn ${filter === 'all' ? 'active' : ''}`}
          onClick={() => setFilter('all')}
        >
          All ({comments.length})
        </button>
        <button
          className={`conv-filter-btn ${filter === 'open' ? 'active' : ''}`}
          onClick={() => setFilter('open')}
        >
          Open ({openCount})
        </button>
        <button
          className={`conv-filter-btn ${filter === 'resolved' ? 'active' : ''}`}
          onClick={() => setFilter('resolved')}
        >
          Resolved ({resolvedCount})
        </button>
        {outdatedCount > 0 && (
          <button
            className={`conv-filter-btn ${filter === 'outdated' ? 'active' : ''}`}
            onClick={() => setFilter('outdated')}
          >
            Outdated ({outdatedCount})
          </button>
        )}
      </div>

      {/* Comments grouped by file */}
      <div className="conv-sidebar-list">
        {filtered.length === 0 && (
          <div className="conv-empty">
            <MessageSquare style={{ width: 20, height: 20, opacity: 0.3 }} />
            <span>No comments</span>
          </div>
        )}
        {Array.from(grouped.entries()).map(([filePath, fileComments]) => {
          const isCollapsed = collapsedFiles.has(filePath);
          const fileName = filePath.split('/').pop() || filePath;

          return (
            <div key={filePath} className="conv-file-group">
              <button className="conv-file-header" onClick={() => toggleFile(filePath)}>
                {isCollapsed ? (
                  <ChevronRight style={{ width: 12, height: 12, flexShrink: 0 }} />
                ) : (
                  <ChevronDown style={{ width: 12, height: 12, flexShrink: 0 }} />
                )}
                <FileCode style={{ width: 12, height: 12, flexShrink: 0, opacity: 0.5 }} />
                <span className="conv-file-name" title={filePath}>{fileName}</span>
                <span className="conv-file-count">{fileComments.length}</span>
              </button>

              {!isCollapsed && fileComments.map((comment) => (
                <ConversationItem
                  key={comment.id}
                  comment={comment}
                  onClick={() => onNavigateToComment(comment.file_path, comment.start_line)}
                  onResolve={onResolveComment}
                  onReopen={onReopenComment}
                  onReply={onReplyComment}
                  onDelete={onDeleteComment}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ConversationItem({
  comment,
  onClick,
  onResolve,
  onReopen,
  onReply,
  onDelete,
}: {
  comment: ReviewCommentEntry;
  onClick: () => void;
  onResolve?: (id: number) => void;
  onReopen?: (id: number) => void;
  onReply?: (commentId: number, status: string, message: string) => void;
  onDelete?: (id: number) => void;
}) {
  const [showReplyForm, setShowReplyForm] = useState(false);
  const [replyText, setReplyText] = useState('');

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

  const lineLabel = comment.start_line !== comment.end_line
    ? `L${comment.start_line}-${comment.end_line}`
    : `L${comment.start_line}`;

  const handleSubmitReply = () => {
    if (replyText.trim() && onReply) {
      // outdated is auto-detected; backend only accepts open/resolved
      const status = comment.status === 'outdated' ? 'open' : comment.status;
      onReply(comment.id, status, replyText.trim());
      setReplyText('');
      setShowReplyForm(false);
    }
  };

  return (
    <div className="conv-item" onClick={onClick}>
      <div className="conv-item-header">
        <AgentAvatar name={comment.author} size={18} className="conv-item-avatar" />
        <span className="conv-item-author">{comment.author}</span>
        <span className="conv-item-meta">{comment.side}:{lineLabel}</span>
        <span
          className="conv-item-status"
          style={{
            color: statusColor,
            background: `color-mix(in srgb, ${statusColor} 15%, var(--color-bg))`,
          }}
        >
          {statusLabel}
        </span>
      </div>
      <div className="conv-item-content">{comment.content}</div>
      {comment.replies.length > 0 && (
        <div className="conv-item-replies">
          {comment.replies.map((reply) => (
            <div key={reply.id} className="conv-item-reply">
              <AgentAvatar name={reply.author} size={14} />
              <span className="conv-item-reply-author">{reply.author}</span>
              <span className="conv-item-reply-text">{reply.content}</span>
            </div>
          ))}
        </div>
      )}
      {/* Action buttons */}
      <div className="conv-item-actions">
        {onReply && (
          <button
            className="conv-item-resolve-btn"
            onClick={(e) => {
              e.stopPropagation();
              setShowReplyForm((v) => !v);
            }}
          >
            <Reply style={{ width: 12, height: 12 }} />
            Reply
          </button>
        )}
        {onResolve && (comment.status === 'open' || comment.status === 'outdated') && (
          <button
            className="conv-item-resolve-btn"
            onClick={(e) => {
              e.stopPropagation();
              onResolve(comment.id);
            }}
          >
            <CheckCircle style={{ width: 12, height: 12 }} />
            Resolve
          </button>
        )}
        {onReopen && comment.status === 'resolved' && (
          <button
            className="conv-item-resolve-btn"
            onClick={(e) => {
              e.stopPropagation();
              onReopen(comment.id);
            }}
            style={{ color: 'var(--color-warning)' }}
          >
            <RotateCcw style={{ width: 12, height: 12 }} />
            Reopen
          </button>
        )}
        {onDelete && (
          <button
            className="conv-item-resolve-btn"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(comment.id);
            }}
            style={{ color: 'var(--color-error)' }}
          >
            <Trash2 style={{ width: 12, height: 12 }} />
            Delete
          </button>
        )}
      </div>
      {/* Inline reply form */}
      {showReplyForm && (
        <div className="conv-item-reply-form" onClick={(e) => e.stopPropagation()}>
          <textarea
            className="conv-reply-textarea"
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            placeholder="Write a reply..."
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSubmitReply();
              if (e.key === 'Escape') { setShowReplyForm(false); setReplyText(''); }
            }}
          />
          <div className="conv-reply-actions">
            <button
              className="conv-reply-cancel"
              onClick={() => { setShowReplyForm(false); setReplyText(''); }}
            >
              Cancel
            </button>
            <button
              className="conv-reply-submit"
              disabled={!replyText.trim()}
              onClick={handleSubmitReply}
            >
              <Send style={{ width: 10, height: 10 }} />
              Reply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
