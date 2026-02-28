import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { getFullDiff, createInlineComment, createFileComment, createProjectComment, deleteComment as apiDeleteComment, replyReviewComment as apiReplyComment, updateCommentStatus as apiUpdateCommentStatus, getFileContent, editComment as apiEditComment, editReply as apiEditReply, deleteReply as apiDeleteReply } from '../../api/review';
import { getReviewComments, getCommits, getTaskFiles } from '../../api/tasks';
import type { FullDiffResult, DiffFile } from '../../api/review';
import type { ReviewCommentEntry, ReviewCommentsResponse } from '../../api/tasks';
import { buildMentionItems } from '../../utils/fileMention';

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
import { DiffFileView, resetGlobalMatchIndex } from './DiffFileView';
import { ConversationSidebar } from './ConversationSidebar';
import { CodeSearchBar } from './CodeSearchBar';
import { MessageSquare, ChevronUp, ChevronDown, PanelLeftClose, PanelLeftOpen, Crosshair, GitCompare, FileText } from 'lucide-react';
import { VersionSelector } from './VersionSelector';
import { useIsMobile } from '../../hooks';
import { useHotkeys } from '../../hooks/useHotkeys';
import './diffTheme.css';

interface DiffReviewPageProps {
  projectId: string;
  taskId: string;
  embedded?: boolean;
}

type MarkdownPreviewMode = 'diff' | 'diff-preview' | 'full-preview';

export function DiffReviewPage({ projectId, taskId, embedded }: DiffReviewPageProps) {
  const { isMobile } = useIsMobile();
  const [diffData, setDiffData] = useState<FullDiffResult | null>(null);
  const [allFiles, setAllFiles] = useState<string[]>([]); // All git-tracked files for File Mode
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [viewType, setViewType] = useState<'unified' | 'split'>('unified');
  const [viewMode, setViewMode] = useState<'diff' | 'full'>('diff');
  const [previewMode, setPreviewMode] = useState<MarkdownPreviewMode>('diff-preview');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [comments, setComments] = useState<ReviewCommentEntry[]>([]);
  const [commentFormAnchor, setCommentFormAnchor] = useState<CommentAnchor | null>(null);
  const [fileCommentFormPath, setFileCommentFormPath] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  // Full file content cache
  const [fullFileContents, setFullFileContents] = useState<Map<string, string>>(new Map());
  const [loadingFiles, setLoadingFiles] = useState<Set<string>>(new Set());
  const requestQueue = useRef<string[]>([]);
  const activeRequests = useRef<Set<string>>(new Set());
  const MAX_CONCURRENT = 3;

  // New state
  const [currentFileIndex, setCurrentFileIndex] = useState(0);
  // Viewed files: path → hash at view time, persisted to localStorage
  const viewedStorageKey = `grove:viewed:${projectId}:${taskId}`;
  const [viewedFiles, setViewedFiles] = useState<Map<string, string>>(() => {
    try {
      const stored = localStorage.getItem(viewedStorageKey);
      if (stored) {
        return new Map(JSON.parse(stored) as [string, string][]);
      }
    } catch { /* ignore */ }
    return new Map();
  });
  const [sidebarSearch, setSidebarSearch] = useState('');
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  const [replyFormCommentId, setReplyFormCommentId] = useState<number | null>(null);
  const [sidebarVisible, setSidebarVisible] = useState(!isMobile);
  const [convSidebarVisible, setConvSidebarVisible] = useState(false);

  // Mobile: force unified view and close sidebars when entering mobile mode
  useEffect(() => {
    if (isMobile) {
      setViewType('unified');
      setSidebarVisible(false);
      setConvSidebarVisible(false);
    }
  }, [isMobile]);
  const [focusMode, setFocusMode] = useState(true); // Default to true for better performance
  const [fromVersion, setFromVersion] = useState('target');
  const [toVersion, setToVersion] = useState('latest');
  const [collapsedCommentIds, setCollapsedCommentIds] = useState<Set<number>>(new Set());
  const [versions, setVersions] = useState<VersionOption[]>([]);
  const initialCollapseRef = useRef(false);

  // Code search state (Ctrl+F)
  const [codeSearchVisible, setCodeSearchVisible] = useState(false);
  const [codeSearchQuery, setCodeSearchQuery] = useState('');
  const [codeSearchCaseSensitive, setCodeSearchCaseSensitive] = useState(false);
  const [codeSearchCurrentIndex, setCodeSearchCurrentIndex] = useState(0);
  const [codeSearchTotalMatches, setCodeSearchTotalMatches] = useState(0);

  // Git user name for authoring comments (fetched from API)
  const gitUserNameRef = useRef<string>('You');

  // Temporary virtual files/directories created in current session
  const [temporaryVirtualPaths, setTemporaryVirtualPaths] = useState<Set<string>>(new Set());

  // Scroll to line state for auto-expanding collapsed gaps
  const [scrollToLine, setScrollToLine] = useState<{file: string; line: number} | null>(null);

  // Build mention items from allFiles for @ mention in comment textareas
  const mentionItems = useMemo(() => buildMentionItems(allFiles), [allFiles]);

  // Filter files based on view mode
  const displayFiles = useMemo(() => {
    if (viewMode === 'full') {
      // In All Files Mode: show all git-tracked files + virtual files
      // Extract virtual files from diffData (they have is_virtual flag from comments)
      const virtualFiles = diffData?.files.filter(f => f.is_virtual) || [];

      // Add temporary virtual files (created in current session, not persisted yet)
      const temporaryVirtualFiles: DiffFile[] = Array.from(temporaryVirtualPaths).map(path => ({
        old_path: '',
        new_path: path,
        change_type: 'added' as const,
        hunks: [],
        is_binary: false,
        additions: 0,
        deletions: 0,
        is_virtual: true,
      }));

      // Merge all virtual files (from comments + temporary)
      const allVirtualFiles = [...virtualFiles, ...temporaryVirtualFiles];

      // Get all git-tracked files
      const allFileDiffFiles = allFiles.map((path): DiffFile => ({
        old_path: path,
        new_path: path,
        change_type: 'modified', // Doesn't matter for full file view
        hunks: [], // No hunks in File Mode
        is_binary: false,
        additions: 0,
        deletions: 0,
      }));

      // Create a set of existing file paths to avoid duplicates
      const existingPaths = new Set(allFiles);

      // Only add virtual files that don't already exist as real files
      const uniqueVirtualFiles = allVirtualFiles.filter(vf => !existingPaths.has(vf.new_path));

      return [...allFileDiffFiles, ...uniqueVirtualFiles].sort((a, b) =>
        a.new_path.localeCompare(b.new_path)
      );
    }
    // In Changes Mode (Diff Mode): only show real diff files, NO virtual files
    if (!diffData) return [];
    return [...diffData.files.filter(f => !f.is_virtual)].sort((a, b) =>
      a.new_path.localeCompare(b.new_path)
    );
  }, [viewMode, allFiles, diffData, temporaryVirtualPaths]);

  // Use ref to access displayFiles in callbacks without dependency issues
  const displayFilesRef = useRef(displayFiles);

  useEffect(() => {
    displayFilesRef.current = displayFiles;
  }, [displayFiles]);

  const activeFilePath = useMemo(() => {
    return displayFiles.find((f) => f.new_path === selectedFile)?.new_path || displayFiles[0]?.new_path || null;
  }, [displayFiles, selectedFile]);

  const isMarkdownPath = useCallback((path: string | null | undefined) => {
    if (!path) return false;
    const lower = path.toLowerCase();
    return lower.endsWith('.md') || lower.endsWith('.markdown');
  }, []);

  const isActiveFileMarkdown = useMemo(() => isMarkdownPath(activeFilePath), [activeFilePath, isMarkdownPath]);

  useEffect(() => {
    if (!isActiveFileMarkdown && previewMode !== 'diff') {
      setPreviewMode('diff');
    }
  }, [isActiveFileMarkdown, previewMode]);

  // Auto-detect iframe mode
  const isEmbedded = embedded ?? (typeof window !== 'undefined' && window !== window.parent);

  // When switching modes or on initial load, ensure selectedFile is valid
  useEffect(() => {
    if (displayFiles.length === 0) return;
    if (!selectedFile || !displayFiles.some((f) => f.new_path === selectedFile)) {
      setSelectedFile(displayFiles[0].new_path);
      setCurrentFileIndex(0);
    }
  }, [displayFiles, selectedFile]);

  // Load full file content with concurrency control
  const loadFullFileContent = useCallback(async (filePath: string) => {
    if (fullFileContents.has(filePath) || loadingFiles.has(filePath)) return;

    // Add to queue
    requestQueue.current.push(filePath);

    // Process queue
    const processQueue = async () => {
      while (requestQueue.current.length > 0 && activeRequests.current.size < MAX_CONCURRENT) {
        const path = requestQueue.current.shift()!;
        activeRequests.current.add(path);
        setLoadingFiles(prev => new Set(prev).add(path));

        try {
          const content = await getFileContent(projectId, taskId, path);
          setFullFileContents(prev => new Map(prev).set(path, content));
        } catch (error) {
          console.error(`Failed to load ${path}:`, error);
        } finally {
          setLoadingFiles(prev => {
            const next = new Set(prev);
            next.delete(path);
            return next;
          });
          activeRequests.current.delete(path);
          processQueue(); // Continue processing
        }
      }
    };

    processQueue();
  }, [projectId, taskId, fullFileContents, loadingFiles]);

  // Compute per-file comment counts
  const fileCommentCounts = useMemo(() => {
    const counts = new Map<string, { total: number; unresolved: number }>();
    for (const c of comments) {
      if (c.file_path) {
        const existing = counts.get(c.file_path) || { total: 0, unresolved: 0 };
        existing.total++;
        if (c.status !== 'resolved') existing.unresolved++;
        counts.set(c.file_path, existing);
      }
    }
    return counts;
  }, [comments]);

  // Compute file hashes for viewed-state tracking
  const fileHashes = useMemo(() => {
    const hashes = new Map<string, string>();

    // In All Files mode, compute hash for all displayFiles
    if (viewMode === 'full') {
      for (const file of displayFiles) {
        // For files without hunks (no changes), use file path as stable identifier
        let hash = 5381;
        const pathToHash = file.new_path;
        for (let i = 0; i < pathToHash.length; i++) {
          hash = ((hash << 5) + hash) + pathToHash.charCodeAt(i);
          hash = hash & hash;
        }
        hashes.set(file.new_path, hash.toString(36));
      }
      return hashes;
    }

    // In Changes mode, compute hash based on diff content
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
  }, [diffData, viewMode, displayFiles]);

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
      // Reset selectedFile so the validation effect picks the first sorted file
      setSelectedFile(null);
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
        let reviewComments: ReviewCommentEntry[] = [];

        const [diffResult, reviewData, commitsData, filesData] = await Promise.all([
          getFullDiff(projectId, taskId),
          getReviewComments(projectId, taskId).catch(() => null),
          getCommits(projectId, taskId).catch(() => null),
          getTaskFiles(projectId, taskId).catch(() => null),
        ]);
        const data = diffResult;
        if (reviewData) {
          reviewComments = reviewData.comments;
          if (reviewData.git_user_name) {
            gitUserNameRef.current = reviewData.git_user_name;
          }
        }

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
          // Detect virtual files (files with comments but not in diff)
          // Include all comment types (file, inline) - any comment with a file_path
          const existingFilePaths = new Set(data.files.map(f => f.new_path));
          const virtualFilePaths = reviewComments
            .filter(c => c.file_path && !existingFilePaths.has(c.file_path))
            .map(c => c.file_path!)
            .filter((path, idx, arr) => arr.indexOf(path) === idx); // unique

          // Create virtual file entries
          const virtualFiles: DiffFile[] = virtualFilePaths.map(path => ({
            old_path: '',
            new_path: path,
            change_type: 'added' as const,
            hunks: [],
            is_binary: false,
            additions: 0,
            deletions: 0,
            is_virtual: true, // mark as virtual
          }));

          // Merge virtual files with real files
          const allDiffFiles = [...data.files, ...virtualFiles];

          setDiffData({ ...data, files: allDiffFiles });
          if (filesData) {
            setAllFiles(filesData.files);
          }
          // selectedFile will be set by the displayFiles validation effect (sorted order)
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

  // Auto-collapse resolved comments on first load
  useEffect(() => {
    if (!initialCollapseRef.current && comments.length > 0) {
      initialCollapseRef.current = true;
      const ids = new Set(
        comments.filter((c) => c.status === 'resolved').map((c) => c.id)
      );
      if (ids.size > 0) setCollapsedCommentIds(ids);
    }
  }, [comments]);

  // Listen for Ctrl+F / Cmd+F to open code search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        setCodeSearchVisible(true);
      }
      // ESC to close code search
      if (e.key === 'Escape' && codeSearchVisible) {
        setCodeSearchVisible(false);
        setCodeSearchQuery('');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [codeSearchVisible]);

  // Update match count and handle navigation
  useEffect(() => {
    if (!codeSearchQuery) {
      setCodeSearchTotalMatches(0);
      setCodeSearchCurrentIndex(0);
      return;
    }

    // Small delay to allow DOM to update
    const timer = setTimeout(() => {
      const matches = document.querySelectorAll('.code-search-match');
      setCodeSearchTotalMatches(matches.length);

      // Highlight current match
      matches.forEach((el, idx) => {
        if (idx === codeSearchCurrentIndex) {
          el.classList.add('code-search-current');
          // Scroll to current match
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else {
          el.classList.remove('code-search-current');
        }
      });
    }, 100);

    return () => clearTimeout(timer);
  }, [codeSearchQuery, codeSearchCaseSensitive, codeSearchCurrentIndex, diffData]);

  // Navigate to previous match
  const handleSearchPrevious = useCallback(() => {
    if (codeSearchTotalMatches === 0) return;
    setCodeSearchCurrentIndex((prev) => (prev === 0 ? codeSearchTotalMatches - 1 : prev - 1));
  }, [codeSearchTotalMatches]);

  // Navigate to next match
  const handleSearchNext = useCallback(() => {
    if (codeSearchTotalMatches === 0) return;
    setCodeSearchCurrentIndex((prev) => (prev === codeSearchTotalMatches - 1 ? 0 : prev + 1));
  }, [codeSearchTotalMatches]);

  // Reset current index when query changes
  useEffect(() => {
    setCodeSearchCurrentIndex(0);
  }, [codeSearchQuery, codeSearchCaseSensitive]);

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
    // On mobile, close sidebar after selecting a file
    if (isMobile) {
      setSidebarVisible(false);
    }
  }, [isMobile]);

  const handleMarkdownPreviewModeChange = useCallback((path: string, mode: MarkdownPreviewMode) => {
    setPreviewMode(mode);
    if (path !== selectedFile) {
      handleSelectFile(path);
    }
  }, [handleSelectFile, selectedFile]);

  const handleCyclePreviewMode = useCallback(() => {
    if (!activeFilePath || !isMarkdownPath(activeFilePath)) return;
    const order: MarkdownPreviewMode[] = ['diff', 'diff-preview', 'full-preview'];
    const currentIndex = order.indexOf(previewMode);
    const nextMode = order[(currentIndex + 1) % order.length] ?? 'diff';
    handleMarkdownPreviewModeChange(activeFilePath, nextMode);
  }, [activeFilePath, isMarkdownPath, previewMode, handleMarkdownPreviewModeChange]);

  useHotkeys(
    [
      { key: 'v', handler: handleCyclePreviewMode },
    ],
    [handleCyclePreviewMode]
  );

  // Track topmost visible file on scroll (non-focus mode)
  useEffect(() => {
    const container = contentRef.current;
    if (!container || focusMode) return;

    let rafId: number | null = null;

    const handleScroll = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const files = displayFilesRef.current;
        if (files.length === 0) return;

        const containerTop = container.getBoundingClientRect().top;
        let bestFile = files[0].new_path;

        for (const file of files) {
          const el = document.getElementById(`diff-file-${encodeURIComponent(file.new_path)}`);
          if (!el) continue;
          if (el.getBoundingClientRect().top <= containerTop + 10) {
            bestFile = file.new_path;
          }
        }

        setSelectedFile(bestFile);
      });
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    // Set initial selection
    handleScroll();

    return () => {
      container.removeEventListener('scroll', handleScroll);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [focusMode, displayFiles]); // re-attach when files change

  // Track visible file on scroll
  const handleFileVisible = useCallback((path: string) => {
    setSelectedFile(path);
  }, []);

  // File navigation using refs to avoid dependency issues
  const goToNextFile = useCallback(() => {
    const files = displayFilesRef.current;
    if (files.length === 0) return;

    setCurrentFileIndex((prevIndex) => {
      const next = Math.min(prevIndex + 1, files.length - 1);
      setSelectedFile(files[next].new_path);
      const el = document.getElementById(`diff-file-${encodeURIComponent(files[next].new_path)}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return next;
    });
  }, []);

  const goToPrevFile = useCallback(() => {
    const files = displayFilesRef.current;
    if (files.length === 0) return;

    setCurrentFileIndex((prevIndex) => {
      const prev = Math.max(prevIndex - 1, 0);
      setSelectedFile(files[prev].new_path);
      const el = document.getElementById(`diff-file-${encodeURIComponent(files[prev].new_path)}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return prev;
    });
  }, []);

  // Toggle viewed — stores current file hash and auto-collapses when marked as viewed
  const handleToggleViewed = useCallback((path: string) => {
    setViewedFiles((prev) => {
      const next = new Map(prev);
      if (next.has(path)) {
        next.delete(path);
        // When unmarking as viewed, keep current collapsed state
      } else {
        const hash = fileHashes.get(path) || '';
        next.set(path, hash);
        // Auto-collapse when marking as viewed
        setCollapsedFiles((prevCollapsed) => new Set(prevCollapsed).add(path));
      }
      // Persist to localStorage
      try {
        localStorage.setItem(viewedStorageKey, JSON.stringify(Array.from(next.entries())));
      } catch { /* ignore quota errors */ }
      return next;
    });
  }, [fileHashes, viewedStorageKey]);

  // Toggle collapse
  const handleToggleCollapse = useCallback((path: string) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // Create virtual file/directory (temporary, only persisted if comment is added)
  const handleCreateVirtualPath = useCallback((path: string) => {
    setTemporaryVirtualPaths(prev => new Set(prev).add(path));
    // Auto-select the newly created virtual file
    setSelectedFile(path);
  }, []);

  // Helper: apply ReviewCommentsResponse (update comments + refresh git_user_name)
  const applyReviewResponse = useCallback((result: ReviewCommentsResponse) => {
    setComments(result.comments);
    if (result.git_user_name) {
      gitUserNameRef.current = result.git_user_name;
    }
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
      const result = await createInlineComment(projectId, taskId, anchor, content, gitUserNameRef.current);
      applyReviewResponse(result);
      setCommentFormAnchor(null);
    } catch {
      // Could add toast here
    }
  }, [projectId, taskId]);

  // Delete comment
  const handleDeleteComment = useCallback(async (id: number) => {
    try {
      const result = await apiDeleteComment(projectId, taskId, id);
      applyReviewResponse(result);
    } catch {
      // Could add toast here
    }
  }, [projectId, taskId]);

  // Cancel comment form
  const handleCancelComment = useCallback(() => {
    setCommentFormAnchor(null);
  }, []);

  // File comment handlers
  const handleAddFileComment = useCallback((filePath: string) => {
    setFileCommentFormPath(filePath);
  }, []);

  const handleCancelFileComment = useCallback(() => {
    setFileCommentFormPath(null);
  }, []);

  const handleSubmitFileComment = useCallback(async (filePath: string, content: string) => {
    try {
      const result = await createFileComment(projectId, taskId, filePath, content, gitUserNameRef.current);
      applyReviewResponse(result);
      setFileCommentFormPath(null);
    } catch {
      // Could add toast here
    }
  }, [projectId, taskId]);

  // Add project comment
  const handleAddProjectComment = useCallback(async (content: string) => {
    try {
      const result = await createProjectComment(projectId, taskId, content, gitUserNameRef.current);
      applyReviewResponse(result);
    } catch {
      // Could add toast here
    }
  }, [projectId, taskId]);

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
      const result = await apiReplyComment(projectId, taskId, commentId, message, gitUserNameRef.current);
      applyReviewResponse(result);
      setReplyFormCommentId(null);
    } catch {
      // Could add toast here
    }
  }, [projectId, taskId]);

  // Resolve comment (mark as resolved + auto-collapse)
  const handleResolveComment = useCallback(async (id: number) => {
    try {
      const result = await apiUpdateCommentStatus(projectId, taskId, id, 'resolved');
      applyReviewResponse(result);
      setCollapsedCommentIds((prev) => new Set([...prev, id]));
    } catch {
      // Could add toast here
    }
  }, [projectId, taskId]);

  // Reopen comment (mark resolved → open + auto-expand)
  const handleReopenComment = useCallback(async (id: number) => {
    try {
      const result = await apiUpdateCommentStatus(projectId, taskId, id, 'open');
      applyReviewResponse(result);
      setCollapsedCommentIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    } catch {
      // Could add toast here
    }
  }, [projectId, taskId]);

  // Edit comment content
  const handleEditComment = useCallback(async (id: number, content: string) => {
    try {
      const result = await apiEditComment(projectId, taskId, id, content);
      applyReviewResponse(result);
    } catch {
      // Could add toast here
    }
  }, [projectId, taskId]);

  // Edit reply content
  const handleEditReply = useCallback(async (commentId: number, replyId: number, content: string) => {
    try {
      const result = await apiEditReply(projectId, taskId, commentId, replyId, content);
      applyReviewResponse(result);
    } catch {
      // Could add toast here
    }
  }, [projectId, taskId]);

  // Delete reply
  const handleDeleteReply = useCallback(async (commentId: number, replyId: number) => {
    try {
      const result = await apiDeleteReply(projectId, taskId, commentId, replyId);
      applyReviewResponse(result);
    } catch {
      // Could add toast here
    }
  }, [projectId, taskId]);

  // Navigate to a comment (from conversation sidebar)
  const handleNavigateToComment = useCallback((filePath: string, line: number, commentId?: number) => {
    setSelectedFile(filePath);
    // Auto-expand file if it's collapsed
    setCollapsedFiles((prev) => {
      if (prev.has(filePath)) {
        const next = new Set(prev);
        next.delete(filePath);
        return next;
      }
      return prev;
    });
    // Auto-expand comment if it's collapsed
    if (commentId !== undefined) {
      setCollapsedCommentIds((prev) => {
        if (prev.has(commentId)) {
          const next = new Set(prev);
          next.delete(commentId);
          return next;
        }
        return prev;
      });
    }
    // Set scroll target to trigger gap expansion
    if (line > 0) {
      setScrollToLine({file: filePath, line});
    }

    // Retry mechanism for finding the line element (gap expansion may take time)
    const tryScroll = (attempt: number) => {
      const fileEl = document.getElementById(`diff-file-${encodeURIComponent(filePath)}`);
      if (!fileEl) {
        if (attempt < 5) {
          setTimeout(() => tryScroll(attempt + 1), 100);
        }
        return;
      }

      if (line > 0) {
        const lineEl = fileEl.querySelector(`tr[data-line="${line}"]`) || fileEl.querySelector(`td[data-line="${line}"]`);
        if (lineEl) {
          lineEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          setScrollToLine(null);
          return;
        } else if (attempt < 5) {
          // Line not found yet, retry (gap might still be expanding)
          setTimeout(() => tryScroll(attempt + 1), 100);
          return;
        }
      }

      // Fallback: scroll to file
      fileEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setScrollToLine(null);
    };

    // Start with initial delay to allow React to render
    setTimeout(() => tryScroll(1), 150);
  }, []);

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

  const viewedCount = displayFiles.filter((f) => getFileViewedStatus(f.new_path) === 'viewed').length;
  const totalFiles = displayFiles.length;
  const isEmpty = displayFiles.length === 0;

  // Ensure selectedFile is valid - if not, use first file
  const validSelectedFile = activeFilePath;

  return (
    <div className={`diff-review-page ${isEmbedded ? 'embedded' : ''}`}>
      {/* Page Header with Mode Selector */}
      <div className="diff-page-header">
        <div className="diff-page-title">Code Review</div>
        <div className="diff-mode-selector">
          <button
            className={viewMode === 'diff' ? 'active' : ''}
            onClick={() => setViewMode('diff')}
          >
            <GitCompare size={14} />
            <span>Changes</span>
          </button>
          <button
            className={viewMode === 'full' ? 'active' : ''}
            onClick={() => setViewMode('full')}
          >
            <FileText size={14} />
            <span>All Files</span>
          </button>
        </div>
      </div>

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
          {viewMode === 'diff' && (
            <div className="diff-view-toggle">
              <button
                className={viewType === 'unified' ? 'active' : ''}
                onClick={() => setViewType('unified')}
              >
                Unified
              </button>
              {!isMobile && (
                <button
                  className={viewType === 'split' ? 'active' : ''}
                  onClick={() => setViewType('split')}
                >
                  Split
                </button>
              )}
            </div>
          )}
          {viewMode === 'diff' && fromOptions.length > 0 && toOptions.length > 0 && (
            <div className="diff-version-range">
              <VersionSelector options={fromOptions} selected={fromVersion} onChange={handleFromVersionChange} />
              <span className="diff-version-arrow">&rarr;</span>
              <VersionSelector options={toOptions} selected={toVersion} onChange={handleToVersionChange} />
            </div>
          )}
          <span style={{ fontWeight: 600, color: 'var(--color-text)' }}>
            {totalFiles} file{totalFiles !== 1 ? 's' : ''}
          </span>
          {viewMode === 'diff' && (
            <>
              <span className="stat-add">+{diffData?.total_additions ?? 0}</span>
              <span className="stat-del">-{diffData?.total_deletions ?? 0}</span>
            </>
          )}
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
            {/* Mobile overlay backdrop */}
            {isMobile && (sidebarVisible || convSidebarVisible) && (
              <div
                style={{
                  position: 'fixed',
                  inset: 0,
                  background: 'rgba(0,0,0,0.4)',
                  zIndex: 15,
                }}
                onClick={() => {
                  setSidebarVisible(false);
                  setConvSidebarVisible(false);
                }}
              />
            )}

            {/* Sidebar */}
            <FileTreeSidebar
              files={displayFiles}
              selectedFile={validSelectedFile}
              onSelectFile={handleSelectFile}
              searchQuery={sidebarSearch}
              onSearchChange={setSidebarSearch}
              fileCommentCounts={fileCommentCounts}
              collapsed={!sidebarVisible}
              getFileViewedStatus={getFileViewedStatus}
              onCreateVirtualPath={handleCreateVirtualPath}
              viewMode={viewMode}
            />

            {/* Diff content */}
            <div className="diff-content" ref={contentRef}>
              {(() => {
                // Reset global match index before rendering
                resetGlobalMatchIndex();
                return (focusMode
                  ? displayFiles.filter((f) => f.new_path === validSelectedFile)
                  : displayFiles
                ).map((file) => {
                  const isMarkdownFile = isMarkdownPath(file.new_path);
                  return (
                    <DiffFileView
                      key={file.new_path}
                      file={file}
                      viewType={viewType}
                      isActive={validSelectedFile === file.new_path}
                      markdownPreviewMode={isMarkdownFile ? previewMode : undefined}
                      onMarkdownPreviewModeChange={isMarkdownFile ? handleMarkdownPreviewModeChange : undefined}
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
                      viewMode={viewMode}
                      fullFileContent={fullFileContents.get(file.new_path)}
                      isLoadingFullFile={loadingFiles.has(file.new_path)}
                      onRequestFullFile={loadFullFileContent}
                      onAddFileComment={handleAddFileComment}
                      fileCommentFormPath={fileCommentFormPath}
                      onCancelFileComment={handleCancelFileComment}
                      onSubmitFileComment={handleSubmitFileComment}
                      onEditComment={handleEditComment}
                      onEditReply={handleEditReply}
                      onDeleteReply={handleDeleteReply}
                      codeSearchQuery={codeSearchQuery}
                      codeSearchCaseSensitive={codeSearchCaseSensitive}
                      scrollToLine={scrollToLine?.file === file.new_path ? scrollToLine.line : undefined}
                      mentionItems={mentionItems}
                    />
                  );
                });
              })()}
            </div>

            {/* Conversation sidebar */}
            <ConversationSidebar
              comments={viewMode === 'diff'
                ? comments.filter(c => !c.file_path || displayFiles.some(f => f.new_path === c.file_path))
                : comments
              }
              visible={convSidebarVisible}
              onAddProjectComment={handleAddProjectComment}
              onNavigateToComment={handleNavigateToComment}
              onResolveComment={handleResolveComment}
              onReopenComment={handleReopenComment}
              onReplyComment={handleReplyComment}
              onDeleteComment={handleDeleteComment}
              onEditComment={handleEditComment}
              onEditReply={handleEditReply}
              onDeleteReply={handleDeleteReply}
              mentionItems={mentionItems}
            />
          </>
        )}
      </div>

      {/* Code Search Bar (Ctrl+F) */}
      <CodeSearchBar
        visible={codeSearchVisible}
        query={codeSearchQuery}
        caseSensitive={codeSearchCaseSensitive}
        currentIndex={codeSearchCurrentIndex}
        totalMatches={codeSearchTotalMatches}
        onQueryChange={setCodeSearchQuery}
        onCaseSensitiveToggle={() => setCodeSearchCaseSensitive((v) => !v)}
        onPrevious={handleSearchPrevious}
        onNext={handleSearchNext}
        onClose={() => {
          setCodeSearchVisible(false);
          setCodeSearchQuery('');
          setCodeSearchCurrentIndex(0);
        }}
      />
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
