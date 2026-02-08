import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { getFullDiff, createComment, deleteComment as apiDeleteComment, replyReviewComment as apiReplyComment, updateCommentStatus as apiUpdateCommentStatus } from '../../api/review';
import { getReviewComments, getCommits } from '../../api/tasks';
import type { FullDiffResult } from '../../api/review';
import type { ReviewCommentEntry } from '../../api/tasks';

export interface VersionOption {
  id: string;
  label: string;
  ref?: string;  // git ref (commit hash); undefined for 'latest' and 'target'
}

export interface CommentAnchor {
  filePath: string;
  side: 'ADD' | 'DELETE';
  startLine: number;
  endLine: number;
}
import { FileTreeSidebar } from './FileTreeSidebar';
import { DiffFileView } from './DiffFileView';
import { ConversationSidebar } from './ConversationSidebar';
import { MessageSquare, ChevronUp, ChevronDown, PanelLeftClose, PanelLeftOpen, Crosshair } from 'lucide-react';
import { VersionSelector } from './VersionSelector';
import './diffTheme.css';

interface DiffReviewPageProps {
  projectId: string;
  taskId: string;
  embedded?: boolean;
}

export function DiffReviewPage({ projectId, taskId, embedded }: DiffReviewPageProps) {
  const [diffData, setDiffData] = useState<FullDiffResult | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [viewType, setViewType] = useState<'unified' | 'split'>('unified');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [comments, setComments] = useState<ReviewCommentEntry[]>([]);
  const [commentFormAnchor, setCommentFormAnchor] = useState<CommentAnchor | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // New state
  const [currentFileIndex, setCurrentFileIndex] = useState(0);
  const [viewedFiles, setViewedFiles] = useState<Map<string, string>>(new Map()); // path → hash at view time
  const [sidebarSearch, setSidebarSearch] = useState('');
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  const [replyFormCommentId, setReplyFormCommentId] = useState<number | null>(null);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [convSidebarVisible, setConvSidebarVisible] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [fromVersion, setFromVersion] = useState('target');
  const [toVersion, setToVersion] = useState('latest');
  const [collapsedCommentIds, setCollapsedCommentIds] = useState<Set<number>>(new Set());
  const [versions, setVersions] = useState<VersionOption[]>([]);
  const initialCollapseRef = useRef(false);

  // Auto-detect iframe mode
  const isEmbedded = embedded ?? (typeof window !== 'undefined' && window !== window.parent);

  // Compute per-file comment counts
  const fileCommentCounts = useMemo(() => {
    const counts = new Map<string, { total: number; unresolved: number }>();
    for (const c of comments) {
      const existing = counts.get(c.file_path) || { total: 0, unresolved: 0 };
      existing.total++;
      if (c.status !== 'resolved') existing.unresolved++;
      counts.set(c.file_path, existing);
    }
    return counts;
  }, [comments]);

  // Compute file hashes for viewed-state tracking
  const fileHashes = useMemo(() => {
    const hashes = new Map<string, string>();
    if (!diffData) return hashes;
    for (const f of diffData.files) {
      let hash = 5381;
      for (const h of f.hunks) {
        for (const l of h.lines) {
          for (let i = 0; i < l.content.length; i++) {
            hash = ((hash << 5) + hash) + l.content.charCodeAt(i);
            hash = hash & hash;
          }
        }
      }
      hashes.set(f.new_path, hash.toString(36));
    }
    return hashes;
  }, [diffData]);

  // Compute viewed status per file: 'none' | 'viewed' | 'updated'
  const getFileViewedStatus = useCallback((path: string): 'none' | 'viewed' | 'updated' => {
    const savedHash = viewedFiles.get(path);
    if (!savedHash) return 'none';
    const currentHash = fileHashes.get(path);
    if (currentHash && savedHash !== currentHash) return 'updated';
    return 'viewed';
  }, [viewedFiles, fileHashes]);

  // Version options for FROM / TO selectors
  const versionList = versions;
  // FROM: everything except Latest (newest first: Version N..1, Base)
  const fromOptions = useMemo(
    () => versionList.filter((v) => v.id !== 'latest'),
    [versionList],
  );
  // TO: everything except Base (newest first: Latest, Version N..1)
  const toOptions = useMemo(
    () => versionList.filter((v) => v.id !== 'target'),
    [versionList],
  );

  // Refetch diff for a given from/to ref pair
  const refetchDiff = useCallback(async (fromRef?: string, toRef?: string) => {
    try {
      const data = await getFullDiff(projectId, taskId, fromRef, toRef);
      setDiffData(data);
      if (data.files.length > 0) {
        setSelectedFile(data.files[0].new_path);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load diff');
    }
  }, [projectId, taskId]);

  // Version change handlers — directly trigger refetch
  const handleFromVersionChange = useCallback((id: string) => {
    setFromVersion(id);
    if (versions.length === 0) return;
    const fromOpt = versions.find((v) => v.id === id);
    const toOpt = versions.find((v) => v.id === toVersion);
    refetchDiff(fromOpt?.ref, toOpt?.ref);
  }, [versions, toVersion, refetchDiff]);

  const handleToVersionChange = useCallback((id: string) => {
    setToVersion(id);
    if (versions.length === 0) return;
    const fromOpt = versions.find((v) => v.id === fromVersion);
    const toOpt = versions.find((v) => v.id === id);
    refetchDiff(fromOpt?.ref, toOpt?.ref);
  }, [versions, fromVersion, refetchDiff]);

  // Initial load: diff + comments + commits (builds version list)
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        let data: FullDiffResult;
        let reviewComments: ReviewCommentEntry[] = [];

        const [diffResult, reviewData, commitsData] = await Promise.all([
          getFullDiff(projectId, taskId),
          getReviewComments(projectId, taskId).catch(() => null),
          getCommits(projectId, taskId).catch(() => null),
        ]);
        data = diffResult;
        if (reviewData) reviewComments = reviewData.comments;

        // Build version options: Latest, Version N..1, Base (newest first)
        // skip_versions = number of leading commits equivalent to Latest
        {
          const opts: VersionOption[] = [{ id: 'latest', label: 'Latest' }];
          if (commitsData && commitsData.commits.length > 0) {
            const totalCommits = commitsData.commits.length;
            const startIdx = commitsData.skip_versions ?? 1;
            for (let i = startIdx; i < totalCommits; i++) {
              const versionNum = totalCommits - i;
              opts.push({
                id: `v${versionNum}`,
                label: `Version ${versionNum}`,
                ref: commitsData.commits[i].hash,
              });
            }
          }
          opts.push({ id: 'target', label: 'Base' });
          if (!cancelled) setVersions(opts);
        }

        if (!cancelled) {
          setDiffData(data);
          if (data.files.length > 0) {
            setSelectedFile(data.files[0].new_path);
          }
          setComments(reviewComments);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load diff');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => { cancelled = true; };
  }, [projectId, taskId]);

  // Auto-collapse resolved/outdated comments on first load
  useEffect(() => {
    if (!initialCollapseRef.current && comments.length > 0) {
      initialCollapseRef.current = true;
      const ids = new Set(
        comments.filter((c) => c.status === 'resolved' || c.status === 'outdated').map((c) => c.id)
      );
      if (ids.size > 0) setCollapsedCommentIds(ids);
    }
  }, [comments]);

  // Collapse a comment
  const handleCollapseComment = useCallback((id: number) => {
    setCollapsedCommentIds((prev) => new Set([...prev, id]));
  }, []);

  // Expand a comment
  const handleExpandComment = useCallback((id: number) => {
    setCollapsedCommentIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  // Scroll to file when clicking sidebar
  const handleSelectFile = useCallback((path: string) => {
    setSelectedFile(path);
    const el = document.getElementById(`diff-file-${encodeURIComponent(path)}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    // Update file index
    if (diffData) {
      const idx = diffData.files.findIndex((f) => f.new_path === path);
      if (idx >= 0) setCurrentFileIndex(idx);
    }
  }, [diffData]);

  // Track visible file on scroll
  const handleFileVisible = useCallback((path: string) => {
    setSelectedFile(path);
    if (diffData) {
      const idx = diffData.files.findIndex((f) => f.new_path === path);
      if (idx >= 0) setCurrentFileIndex(idx);
    }
  }, [diffData]);

  // File navigation
  const goToNextFile = useCallback(() => {
    if (!diffData || diffData.files.length === 0) return;
    const next = Math.min(currentFileIndex + 1, diffData.files.length - 1);
    setCurrentFileIndex(next);
    handleSelectFile(diffData.files[next].new_path);
  }, [diffData, currentFileIndex, handleSelectFile]);

  const goToPrevFile = useCallback(() => {
    if (!diffData || diffData.files.length === 0) return;
    const prev = Math.max(currentFileIndex - 1, 0);
    setCurrentFileIndex(prev);
    handleSelectFile(diffData.files[prev].new_path);
  }, [diffData, currentFileIndex, handleSelectFile]);

  // Toggle viewed — stores current file hash
  const handleToggleViewed = useCallback((path: string) => {
    setViewedFiles((prev) => {
      const next = new Map(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        const hash = fileHashes.get(path) || '';
        next.set(path, hash);
      }
      return next;
    });
  }, [fileHashes]);

  // Toggle collapse
  const handleToggleCollapse = useCallback((path: string) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // Gutter click — open comment form (side-aware + shift-click multiline)
  const handleGutterClick = useCallback((filePath: string, side: 'ADD' | 'DELETE', line: number, shiftKey: boolean) => {
    setCommentFormAnchor((prev) => {
      if (shiftKey && prev && prev.filePath === filePath && prev.side === side) {
        // Extend range
        const startLine = Math.min(prev.startLine, line);
        const endLine = Math.max(prev.endLine, line);
        return { filePath, side, startLine, endLine };
      }
      // Toggle off if same exact anchor
      if (prev && prev.filePath === filePath && prev.side === side && prev.startLine === line && prev.endLine === line) {
        return null;
      }
      return { filePath, side, startLine: line, endLine: line };
    });
    setReplyFormCommentId(null);
  }, []);

  // Add comment
  const handleAddComment = useCallback(async (anchor: CommentAnchor, content: string) => {
    try {
      const result = await createComment(projectId, taskId, anchor, content);
      setComments(result.comments);
      setCommentFormAnchor(null);
    } catch {
      // Could add toast here
    }
  }, [projectId, taskId]);

  // Delete comment
  const handleDeleteComment = useCallback(async (id: number) => {
    try {
      const result = await apiDeleteComment(projectId, taskId, id);
      setComments(result.comments);
    } catch {
      // Could add toast here
    }
  }, [projectId, taskId]);

  // Cancel comment form
  const handleCancelComment = useCallback(() => {
    setCommentFormAnchor(null);
  }, []);

  // Open reply form
  const handleOpenReplyForm = useCallback((commentId: number) => {
    setReplyFormCommentId(commentId);
    setCommentFormAnchor(null);
  }, []);

  // Cancel reply form
  const handleCancelReply = useCallback(() => {
    setReplyFormCommentId(null);
  }, []);

  // Reply to comment (no status change)
  const handleReplyComment = useCallback(async (commentId: number, _status: string, message: string) => {
    try {
      const result = await apiReplyComment(projectId, taskId, commentId, message);
      setComments(result.comments);
      setReplyFormCommentId(null);
    } catch {
      // Could add toast here
    }
  }, [projectId, taskId]);

  // Resolve comment (mark as resolved + auto-collapse)
  const handleResolveComment = useCallback(async (id: number) => {
    try {
      const result = await apiUpdateCommentStatus(projectId, taskId, id, 'resolved');
      setComments(result.comments);
      setCollapsedCommentIds((prev) => new Set([...prev, id]));
    } catch {
      // Could add toast here
    }
  }, [projectId, taskId]);

  // Reopen comment (mark resolved → open + auto-expand)
  const handleReopenComment = useCallback(async (id: number) => {
    try {
      const result = await apiUpdateCommentStatus(projectId, taskId, id, 'open');
      setComments(result.comments);
      setCollapsedCommentIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } catch {
      // Could add toast here
    }
  }, [projectId, taskId]);

  // Navigate to a comment (from conversation sidebar)
  const handleNavigateToComment = useCallback((filePath: string, _line: number) => {
    // Scroll to the file first
    const el = document.getElementById(`diff-file-${encodeURIComponent(filePath)}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    setSelectedFile(filePath);
    if (diffData) {
      const idx = diffData.files.findIndex((f) => f.new_path === filePath);
      if (idx >= 0) setCurrentFileIndex(idx);
    }
  }, [diffData]);

  // Comments for a specific file
  const getFileComments = (filePath: string) => {
    return comments.filter((c) => c.file_path === filePath);
  };

  // Loading state
  if (loading) {
    return (
      <div className={`diff-review-page ${isEmbedded ? 'embedded' : ''}`}>
        <div className="diff-center-message">
          <div className="spinner" />
          <span>Loading diff...</span>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className={`diff-review-page ${isEmbedded ? 'embedded' : ''}`}>
        <div className="diff-center-message">
          <span style={{ color: 'var(--color-error)', fontSize: 14 }}>{error}</span>
        </div>
      </div>
    );
  }

  const viewedCount = diffData ? diffData.files.filter((f) => getFileViewedStatus(f.new_path) === 'viewed').length : 0;
  const totalFiles = diffData ? diffData.files.length : 0;
  const isEmpty = !diffData || diffData.files.length === 0;

  return (
    <div className={`diff-review-page ${isEmbedded ? 'embedded' : ''}`}>
      {/* Toolbar */}
      <div className="diff-toolbar">
        <div className="diff-toolbar-left">
          <button
            className="diff-toolbar-btn"
            onClick={() => setSidebarVisible((v) => !v)}
            title={sidebarVisible ? 'Hide file tree' : 'Show file tree'}
          >
            {sidebarVisible ? (
              <PanelLeftClose style={{ width: 14, height: 14 }} />
            ) : (
              <PanelLeftOpen style={{ width: 14, height: 14 }} />
            )}
          </button>
          <button
            className={`diff-toggle-pill ${focusMode ? 'active' : ''}`}
            onClick={() => setFocusMode((v) => !v)}
            title="Focus mode — show one file at a time"
          >
            <Crosshair style={{ width: 12, height: 12 }} />
            Focus
          </button>
          <div className="diff-view-toggle">
            <button
              className={viewType === 'unified' ? 'active' : ''}
              onClick={() => setViewType('unified')}
            >
              Unified
            </button>
            <button
              className={viewType === 'split' ? 'active' : ''}
              onClick={() => setViewType('split')}
            >
              Split
            </button>
          </div>
          {fromOptions.length > 0 && toOptions.length > 0 && (
            <div className="diff-version-range">
              <VersionSelector options={fromOptions} selected={fromVersion} onChange={handleFromVersionChange} />
              <span className="diff-version-arrow">&rarr;</span>
              <VersionSelector options={toOptions} selected={toVersion} onChange={handleToVersionChange} />
            </div>
          )}
          <span style={{ fontWeight: 600, color: 'var(--color-text)' }}>
            {totalFiles} file{totalFiles !== 1 ? 's' : ''}
          </span>
          <span className="stat-add">+{diffData?.total_additions ?? 0}</span>
          <span className="stat-del">-{diffData?.total_deletions ?? 0}</span>
        </div>
        <div className="diff-toolbar-right">
          <ViewedProgress viewed={viewedCount} total={totalFiles} />
          <button
            className="diff-toolbar-btn"
            onClick={goToPrevFile}
            title="Previous file"
            disabled={currentFileIndex === 0}
          >
            <ChevronUp style={{ width: 14, height: 14 }} />
          </button>
          <button
            className="diff-toolbar-btn"
            onClick={goToNextFile}
            title="Next file"
            disabled={currentFileIndex === totalFiles - 1}
          >
            <ChevronDown style={{ width: 14, height: 14 }} />
          </button>
          <button
            className={`diff-toolbar-btn ${convSidebarVisible ? 'active' : ''}`}
            onClick={() => setConvSidebarVisible((v) => !v)}
            title={convSidebarVisible ? 'Hide conversation' : 'Show conversation'}
          >
            <MessageSquare style={{ width: 14, height: 14 }} />
          </button>
        </div>
      </div>

      {/* Layout */}
      <div className="diff-layout">
        {isEmpty ? (
          /* Empty diff — keep toolbar visible for version switching */
          <div className="diff-content" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1 }}>
            <span style={{ color: 'var(--color-text-muted)', fontSize: 14 }}>No changes found</span>
          </div>
        ) : (
          <>
            {/* Sidebar */}
            <FileTreeSidebar
              files={diffData!.files}
              selectedFile={selectedFile}
              onSelectFile={handleSelectFile}
              searchQuery={sidebarSearch}
              onSearchChange={setSidebarSearch}
              fileCommentCounts={fileCommentCounts}
              collapsed={!sidebarVisible}
              getFileViewedStatus={getFileViewedStatus}
            />

            {/* Diff content */}
            <div className="diff-content" ref={contentRef}>
              {(focusMode
                ? diffData!.files.filter((f) => f.new_path === selectedFile)
                : diffData!.files
              ).map((file) => (
                <DiffFileView
                  key={file.new_path}
                  file={file}
                  viewType={viewType}
                  isActive={selectedFile === file.new_path}
                  projectId={projectId}
                  taskId={taskId}
                  onVisible={() => handleFileVisible(file.new_path)}
                  comments={getFileComments(file.new_path)}
                  commentFormAnchor={commentFormAnchor}
                  onGutterClick={handleGutterClick}
                  onAddComment={handleAddComment}
                  onDeleteComment={handleDeleteComment}
                  onCancelComment={handleCancelComment}
                  isCollapsed={collapsedFiles.has(file.new_path)}
                  onToggleCollapse={handleToggleCollapse}
                  viewedStatus={getFileViewedStatus(file.new_path)}
                  onToggleViewed={handleToggleViewed}
                  commentCount={fileCommentCounts.get(file.new_path)}
                  replyFormCommentId={replyFormCommentId}
                  onOpenReplyForm={handleOpenReplyForm}
                  onReplyComment={handleReplyComment}
                  onCancelReply={handleCancelReply}
                  onResolveComment={handleResolveComment}
                  onReopenComment={handleReopenComment}
                  collapsedCommentIds={collapsedCommentIds}
                  onCollapseComment={handleCollapseComment}
                  onExpandComment={handleExpandComment}
                />
              ))}
            </div>

            {/* Conversation sidebar */}
            <ConversationSidebar
              comments={focusMode && selectedFile ? comments.filter((c) => c.file_path === selectedFile) : comments}
              visible={convSidebarVisible}
              onNavigateToComment={handleNavigateToComment}
              onResolveComment={handleResolveComment}
              onReopenComment={handleReopenComment}
              onReplyComment={handleReplyComment}
              onDeleteComment={handleDeleteComment}
            />
          </>
        )}
      </div>

    </div>
  );
}

// ============================================================================
// Circular progress ring for viewed files
// ============================================================================

function ViewedProgress({ viewed, total }: { viewed: number; total: number }) {
  const size = 22;
  const stroke = 2.5;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const progress = total > 0 ? viewed / total : 0;
  const offset = circumference * (1 - progress);
  const done = viewed === total && total > 0;

  return (
    <div className="diff-viewed-progress" title={`${viewed}/${total} viewed`}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--color-border)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={done ? 'var(--color-success)' : 'var(--color-highlight)'}
          strokeWidth={stroke}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset 0.3s ease' }}
        />
      </svg>
      <span className="diff-viewed-progress-text">{viewed}/{total}</span>
    </div>
  );
}
