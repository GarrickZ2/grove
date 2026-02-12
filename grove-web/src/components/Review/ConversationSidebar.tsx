import { useState, useMemo } from 'react';
import { MessageSquare, CheckCircle, RotateCcw, Reply, Send, FileCode, ChevronDown, ChevronRight, Trash2, Maximize2 } from 'lucide-react';
import type { ReviewCommentEntry } from '../../api/tasks';
import { AgentAvatar } from './AgentAvatar';
import { CommentDetailModal } from './CommentDetailModal';

type StatusFilter = 'all' | 'open' | 'resolved' | 'outdated';

interface ConversationSidebarProps {
  comments: ReviewCommentEntry[];
  visible: boolean;
  onNavigateToComment: (filePath: string, line: number, commentId?: number) => void;
  onResolveComment?: (id: number) => void;
  onReopenComment?: (id: number) => void;
  onReplyComment?: (commentId: number, status: string, message: string) => void;
  onDeleteComment?: (id: number) => void;
  onAddProjectComment?: (content: string) => void;
  onEditComment?: (id: number, content: string) => void;
  onEditReply?: (commentId: number, replyId: number, content: string) => void;
  onDeleteReply?: (commentId: number, replyId: number) => void;
}

export function ConversationSidebar({
  comments,
  visible,
  onNavigateToComment,
  onResolveComment,
  onReopenComment,
  onReplyComment,
  onDeleteComment,
  onAddProjectComment,
  onEditComment,
  onEditReply,
  onDeleteReply,
}: ConversationSidebarProps) {
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  const [projectCommentContent, setProjectCommentContent] = useState('');
  const [expandedCommentId, setExpandedCommentId] = useState<number | null>(null);

  // Derive expanded comment from latest comments array so it stays in sync after reply/resolve
  const expandedComment = expandedCommentId !== null
    ? comments.find((c) => c.id === expandedCommentId) ?? null
    : null;

  // Status counts
  const openCount = comments.filter((c) => c.status === 'open').length;
  const resolvedCount = comments.filter((c) => c.status === 'resolved').length;
  const outdatedCount = comments.filter((c) => c.status === 'outdated').length;

  // Filter
  const filtered = useMemo(() => {
    if (filter === 'all') return comments;
    return comments.filter((c) => c.status === filter);
  }, [comments, filter]);

  // Separate comments by type
  const projectComments = useMemo(
    () => filtered.filter((c) => c.comment_type === 'project'),
    [filtered]
  );

  const fileComments = useMemo(
    () => filtered.filter((c) => c.comment_type === 'file'),
    [filtered]
  );

  const inlineComments = useMemo(
    () => filtered.filter((c) => !c.comment_type || c.comment_type === 'inline'),
    [filtered]
  );

  // Group inline comments by file
  const inlineGrouped = useMemo(() => {
    const map = new Map<string, ReviewCommentEntry[]>();
    for (const c of inlineComments) {
      if (c.file_path) {
        const list = map.get(c.file_path) || [];
        list.push(c);
        map.set(c.file_path, list);
      }
    }
    return map;
  }, [inlineComments]);

  // Group file comments by file
  const fileGrouped = useMemo(() => {
    const map = new Map<string, ReviewCommentEntry[]>();
    for (const c of fileComments) {
      if (c.file_path) {
        const list = map.get(c.file_path) || [];
        list.push(c);
        map.set(c.file_path, list);
      }
    }
    return map;
  }, [fileComments]);

  const toggleFile = (path: string) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const handleSubmitProjectComment = () => {
    if (projectCommentContent.trim() && onAddProjectComment) {
      onAddProjectComment(projectCommentContent.trim());
      setProjectCommentContent('');
    }
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

      {/* Comments grouped by type */}
      <div className="conv-sidebar-list">
        {filtered.length === 0 && (
          <div className="conv-empty">
            <MessageSquare style={{ width: 20, height: 20, opacity: 0.3 }} />
            <span>No comments</span>
          </div>
        )}

        {/* Project-level comments */}
        {projectComments.length > 0 && (
          <div className="conv-section">
            <div className="conv-section-title">
              <MessageSquare style={{ width: 12, height: 12 }} />
              <span>Project Discussion</span>
            </div>
            {projectComments.map((comment) => (
              <ConversationItem
                key={comment.id}
                comment={comment}
                onClick={() => setExpandedCommentId(comment.id)}
                onResolve={onResolveComment}
                onReopen={onReopenComment}
                onReply={onReplyComment}
                onDelete={onDeleteComment}
                onExpand={() => setExpandedCommentId(comment.id)}
              />
            ))}
          </div>
        )}

        {/* File-level comments */}
        {fileGrouped.size > 0 && (
          <div className="conv-section">
            <div className="conv-section-title">
              <FileCode style={{ width: 12, height: 12 }} />
              <span>File Comments</span>
            </div>
            {Array.from(fileGrouped.entries()).map(([filePath, comments]) => {
              const isCollapsed = collapsedFiles.has(`file:${filePath}`);
              const fileName = filePath.split('/').pop() || filePath;

              return (
                <div key={filePath} className="conv-file-group">
                  <button className="conv-file-header" onClick={() => toggleFile(`file:${filePath}`)}>
                    {isCollapsed ? (
                      <ChevronRight style={{ width: 12, height: 12, flexShrink: 0 }} />
                    ) : (
                      <ChevronDown style={{ width: 12, height: 12, flexShrink: 0 }} />
                    )}
                    <span className="conv-file-name" title={filePath}>{fileName}</span>
                    <span className="conv-file-count">{comments.length}</span>
                  </button>

                  {!isCollapsed && comments.map((comment) => (
                    <ConversationItem
                      key={comment.id}
                      comment={comment}
                      onClick={() => comment.file_path && onNavigateToComment(comment.file_path, 0, comment.id)}
                      onResolve={onResolveComment}
                      onReopen={onReopenComment}
                      onReply={onReplyComment}
                      onDelete={onDeleteComment}
                      onExpand={() => setExpandedCommentId(comment.id)}
                    />
                  ))}
                </div>
              );
            })}
          </div>
        )}

        {/* Inline code comments */}
        {inlineGrouped.size > 0 && (
          <div className="conv-section">
            <div className="conv-section-title">
              <FileCode style={{ width: 12, height: 12 }} />
              <span>Code Comments</span>
            </div>
            {Array.from(inlineGrouped.entries()).map(([filePath, comments]) => {
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
                    <span className="conv-file-name" title={filePath}>{fileName}</span>
                    <span className="conv-file-count">{comments.length}</span>
                  </button>

                  {!isCollapsed && comments.map((comment) => (
                    <ConversationItem
                      key={comment.id}
                      comment={comment}
                      onClick={() => comment.file_path && comment.end_line && onNavigateToComment(comment.file_path, comment.end_line, comment.id)}
                      onResolve={onResolveComment}
                      onReopen={onReopenComment}
                      onReply={onReplyComment}
                      onDelete={onDeleteComment}
                      onExpand={() => setExpandedCommentId(comment.id)}
                    />
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Project comment input at bottom */}
      {onAddProjectComment && (
        <div className="conv-sidebar-footer">
          <div className="project-comment-form">
            <textarea
              value={projectCommentContent}
              onChange={(e) => setProjectCommentContent(e.target.value)}
              placeholder="Add a project-level comment..."
              rows={2}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  handleSubmitProjectComment();
                }
              }}
            />
            <button
              onClick={handleSubmitProjectComment}
              disabled={!projectCommentContent.trim()}
              className="project-comment-submit"
            >
              <Send style={{ width: 14, height: 14 }} />
              Comment
            </button>
          </div>
        </div>
      )}

      {/* Comment Detail Modal */}
      {expandedComment && (
        <CommentDetailModal
          comment={expandedComment}
          onClose={() => setExpandedCommentId(null)}
          onResolve={onResolveComment}
          onReopen={onReopenComment}
          onReply={onReplyComment}
          onDelete={onDeleteComment}
          onEdit={onEditComment}
          onEditReply={onEditReply}
          onDeleteReply={onDeleteReply}
        />
      )}
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
  onExpand,
}: {
  comment: ReviewCommentEntry;
  onClick: () => void;
  onResolve?: (id: number) => void;
  onReopen?: (id: number) => void;
  onReply?: (commentId: number, status: string, message: string) => void;
  onDelete?: (id: number) => void;
  onExpand?: () => void;
}) {
  const [showReplyForm, setShowReplyForm] = useState(false);
  const [replyText, setReplyText] = useState('');

  // Truncate content for preview (show first 3 lines or 120 chars)
  const isLongContent = comment.content.length > 120 || comment.content.split('\n').length > 3;
  const truncatedContent = (() => {
    if (!isLongContent) return comment.content;

    const lines = comment.content.split('\n');
    if (lines.length > 3) {
      return lines.slice(0, 3).join('\n') + '...';
    }

    if (comment.content.length > 120) {
      return comment.content.slice(0, 120) + '...';
    }

    return comment.content;
  })();

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
    } else if (type === 'file') {
      return 'File-level';
    } else if (comment.start_line !== undefined && comment.end_line !== undefined) {
      const lineLabel = comment.start_line !== comment.end_line
        ? `L${comment.start_line}-${comment.end_line}`
        : `L${comment.start_line}`;
      return comment.side ? `${comment.side}:${lineLabel}` : lineLabel;
    }
    return '';
  })();

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
        <span className="conv-item-meta" style={{ opacity: 0.6 }}>#{comment.id}</span>
        {locationLabel && <span className="conv-item-meta">{locationLabel}</span>}
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
      <div className="conv-item-content">{truncatedContent}</div>
      {comment.replies.length > 0 && (
        <div className="conv-item-replies">
          {comment.replies.map((reply) => {
            // Truncate long replies
            const isLongReply = reply.content.length > 100 || reply.content.split('\n').length > 2;
            let truncatedReply = reply.content;

            if (isLongReply) {
              const lines = reply.content.split('\n');
              if (lines.length > 2) {
                truncatedReply = lines.slice(0, 2).join('\n') + '...';
              } else if (reply.content.length > 100) {
                truncatedReply = reply.content.slice(0, 100) + '...';
              }
            }

            return (
              <div key={reply.id} className="conv-item-reply">
                <AgentAvatar name={reply.author} size={14} />
                <span className="conv-item-reply-author">{reply.author}</span>
                <span className="conv-item-reply-text">{truncatedReply}</span>
              </div>
            );
          })}
        </div>
      )}
      {/* Action buttons */}
      <div className="conv-item-actions">
        {onExpand && (
          <button
            className="conv-item-resolve-btn"
            onClick={(e) => {
              e.stopPropagation();
              onExpand();
            }}
            title="Expand"
          >
            <Maximize2 style={{ width: 12, height: 12 }} />
          </button>
        )}
        {onReply && (
          <button
            className="conv-item-resolve-btn"
            onClick={(e) => {
              e.stopPropagation();
              setShowReplyForm((v) => !v);
            }}
            title="Reply"
          >
            <Reply style={{ width: 12, height: 12 }} />
          </button>
        )}
        {onResolve && (comment.status === 'open' || comment.status === 'outdated') && (
          <button
            className="conv-item-resolve-btn"
            onClick={(e) => {
              e.stopPropagation();
              onResolve(comment.id);
            }}
            title="Resolve"
          >
            <CheckCircle style={{ width: 12, height: 12 }} />
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
            title="Reopen"
          >
            <RotateCcw style={{ width: 12, height: 12 }} />
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
            title="Delete"
          >
            <Trash2 style={{ width: 12, height: 12 }} />
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
