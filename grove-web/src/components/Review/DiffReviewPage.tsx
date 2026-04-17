import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { getDiffStats, getSingleFileDiff, createInlineComment, createFileComment, createProjectComment, deleteComment as apiDeleteComment, replyReviewComment as apiReplyComment, updateCommentStatus as apiUpdateCommentStatus, getFileContent, editComment as apiEditComment, editReply as apiEditReply, deleteReply as apiDeleteReply, bulkDeleteComments as apiBulkDeleteComments } from '../../api/review';
import type { DiffFile, DiffStatsResult } from '../../api/review';
import { getReviewComments, getCommits, getTaskFiles, getTaskDirEntries } from '../../api/tasks';
import type { ReviewCommentEntry, ReviewCommentsResponse, DirEntry } from '../../api/tasks';
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
import { MessageSquare, ChevronUp, ChevronDown, PanelLeftClose, PanelLeftOpen, Crosshair, GitCompare, FileText, RefreshCw, Code, Columns2, Eye } from 'lucide-react';
import { VersionSelector } from './VersionSelector';
import { useIsMobile } from '../../hooks';
import { useHotkeys } from '../../hooks/useHotkeys';
import './diffTheme.css';

/** External navigation request — navigate to a file (optionally at a line) */
export interface FileNavRequest {
  file: string;
  line?: number;
  mode?: 'diff' | 'full';
  /** Monotonic counter so repeated clicks on the same file still trigger */
  seq: number;
}

interface DiffReviewPageProps {
  projectId: string;
  taskId: string;
  embedded?: boolean;
  /** When set, switch mode and scroll to the given file/line */
  navigateToFile?: FileNavRequest | null;
  /** Whether the project is a git repository (non-git projects don't have Changes mode) */
  isGitRepo?: boolean;
}

interface RefetchDiffOptions {
  fromRef?: string;
  toRef?: string;
  keepSelection?: boolean;
  gen?: number;
}

import { getPreviewRenderer } from './previewRenderers';


export function DiffReviewPage({ projectId, taskId, embedded, navigateToFile, isGitRepo }: DiffReviewPageProps) {
  const { isMobile } = useIsMobile();
  const [diffData, setDiffData] = useState<DiffStatsResult | null>(null);
  const [allFiles, setAllFiles] = useState<string[]>([]); // All git-tracked files for File Mode
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const selectedFileRef = useRef<string | null>(selectedFile);
  selectedFileRef.current = selectedFile;
  const [viewType, setViewType] = useState<'unified' | 'split'>('unified');
  const viewModeStorageKey = `grove:review-mode:${projectId}:${taskId}`;
  const [viewMode, setViewMode] = useState<'diff' | 'full'>(() => {
    // If the caller wants to navigate to a file in a specific mode, honour that.
    if (navigateToFile?.mode) return navigateToFile.mode;
    // Non-git projects always use full mode.
    if (isGitRepo === false) return 'full';
    // Restore last-used mode so reopening the panel keeps the user's context.
    const stored = sessionStorage.getItem(viewModeStorageKey);
    if (stored === 'full' || stored === 'diff') return stored;
    return 'diff';
  });
  // Track per-file user overrides: true = force open, false = force closed, absent = follow displayMode
  const [previewOverrides, setPreviewOverrides] = useState<Map<string, boolean>>(new Map());
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
  const [focusModeWarn, setFocusModeWarn] = useState<string | null>(null);
  const lazyRootDirEntriesRef = useRef<DirEntry[]>([]);
  const [focusFiles, setFocusFiles] = useState<DiffFile[]>([]);
  const fileDiffCacheRef = useRef<Map<string, DiffFile | 'unsupported' | 'error'>>(new Map());
  const loadingDiffsRef = useRef<Set<string>>(new Set());
  const [cacheVersion, setCacheVersion] = useState(0);
  const failedFullFilesRef = useRef<Set<string>>(new Set());
  const [displayMode, setDisplayMode] = useState<'code' | 'split' | 'preview'>('code');
  const [fromVersion, setFromVersion] = useState('target');
  const [toVersion, setToVersion] = useState('latest');
  const [collapsedCommentIds, setCollapsedCommentIds] = useState<Set<number>>(new Set());
  const [versions, setVersions] = useState<VersionOption[]>([]);
  const currentDiffRefs = useMemo(() => {
    const fromOpt = versions.find((v) => v.id === fromVersion);
    const toOpt = versions.find((v) => v.id === toVersion);
    return { fromRef: fromOpt?.ref, toRef: toOpt?.ref };
  }, [versions, fromVersion, toVersion]);
  const currentDiffRefsRef = useRef(currentDiffRefs);
  currentDiffRefsRef.current = currentDiffRefs;
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
  // seq forces re-trigger even when file+line are the same as before
  const [scrollToLine, setScrollToLine] = useState<{file: string; line: number; seq?: number} | null>(null);
  const scrollSeqRef = useRef(0);

  // Track last handled navigateToFile seq to avoid re-processing
  const lastNavSeqRef = useRef(-1);
  // Pending navigation — resolved once displayFiles is available after mode switch
  const pendingNavRef = useRef<{ file: string; line?: number } | null>(null);
  // Track which parent dirs we've already tried to expand for pending navigation (lazy load)
  const expandedForNavRef = useRef<Set<string>>(new Set());

  // Handle external navigateToFile requests — stage the request and switch mode
  useEffect(() => {
    if (!navigateToFile || navigateToFile.seq === lastNavSeqRef.current) return;
    lastNavSeqRef.current = navigateToFile.seq;
    // Store the pending navigation target; reset expansion tracker for the new target
    expandedForNavRef.current.clear();
    pendingNavRef.current = { file: navigateToFile.file, line: navigateToFile.line };
    setViewMode(navigateToFile.mode ?? 'full');
  }, [navigateToFile]);

  // Build mention items from allFiles for @ mention in comment textareas
  const mentionItems = useMemo(() => buildMentionItems(allFiles), [allFiles]);

  const sortTreeOrder = useCallback((files: DiffFile[]): DiffFile[] => {
    interface TreeNode { name: string; path: string; file?: DiffFile; children: TreeNode[] }
    const root: TreeNode = { name: '', path: '', children: [] };

    for (const file of files) {
      const parts = file.new_path.split('/');
      let current = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const dirName = parts[i];
        let existing = current.children.find((c) => !c.file && c.name === dirName);
        if (!existing) {
          existing = { name: dirName, path: parts.slice(0, i + 1).join('/'), children: [] };
          current.children.push(existing);
        }
        current = existing;
      }
      current.children.push({ name: parts[parts.length - 1], path: file.new_path, file, children: [] });
    }

    const sortNodes = (nodes: TreeNode[]) => {
      nodes.sort((a, b) => {
        const aIsDir = !a.file ? 0 : 1;
        const bIsDir = !b.file ? 0 : 1;
        if (aIsDir !== bIsDir) return aIsDir - bIsDir;
        return a.name.localeCompare(b.name);
      });
      for (const n of nodes) sortNodes(n.children);
    };
    sortNodes(root.children);

    const result: DiffFile[] = [];
    const flatten = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        if (n.file) result.push(n.file);
        else flatten(n.children);
      }
    };
    flatten(root.children);
    return result;
  }, []);

  const appendLazyFiles = useCallback((entries: DirEntry[]) => {
    const newFiles = entries.map((e): DiffFile => ({
      old_path: e.is_dir ? '' : e.path,
      new_path: e.is_dir ? e.path + '/' : e.path,
      change_type: 'modified' as const,
      hunks: [],
      is_binary: false,
      additions: 0,
      deletions: 0,
    }));
    if (newFiles.length === 0) return;
    setFocusFiles(prev => {
      const existing = new Set(prev.map(f => f.new_path));
      const merged = [...prev, ...newFiles.filter(f => !existing.has(f.new_path))];
      return sortTreeOrder(merged);
    });
  }, [sortTreeOrder]);

  const sortedDiffFiles = useMemo(() => {
    if (viewMode === 'full') {
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
      const allFileDiffFiles = allFiles.map((path): DiffFile => ({
        old_path: path,
        new_path: path,
        change_type: 'modified',
        hunks: [],
        is_binary: false,
        additions: 0,
        deletions: 0,
      }));
      const existingPaths = new Set(allFiles);
      const uniqueVirtualFiles = temporaryVirtualFiles.filter(vf => !existingPaths.has(vf.new_path));
      return sortTreeOrder([...allFileDiffFiles, ...uniqueVirtualFiles]);
    }
    if (!diffData) return [];
    const statFiles: DiffFile[] = diffData.files.map(e => ({
      old_path: e.path,
      new_path: e.path,
      change_type: (e.status === 'A' || e.status === 'U') ? 'added' : e.status === 'D' ? 'deleted' : e.status === 'R' ? 'renamed' : 'modified',
      hunks: [],
      is_binary: e.is_binary ?? false,
      additions: e.additions,
      deletions: e.deletions,
      is_untracked: e.status === 'U',
    }));
    return sortTreeOrder(statFiles);
  }, [viewMode, allFiles, diffData, temporaryVirtualPaths, sortTreeOrder]);

  const baseFiles = (viewMode === 'full' && focusMode) ? focusFiles : sortedDiffFiles;

  const displayFiles = useMemo(() => {
    void cacheVersion; // re-run when diff cache is updated
    if (viewMode !== 'diff' || baseFiles.length === 0) return baseFiles;
    return baseFiles.map(f => {
      const cached = fileDiffCacheRef.current.get(f.new_path);
      if (!cached) return f;
      if (cached === 'unsupported') return { ...f, hunks: [], additions: 0, deletions: 0, is_unsupported: true };
      if (cached === 'error') return { ...f, hunks: [], additions: 0, deletions: 0, load_error: true };
      return { ...f, hunks: cached.hunks, additions: cached.additions, deletions: cached.deletions, change_type: cached.change_type, is_binary: cached.is_binary };
    });
  }, [viewMode, baseFiles, cacheVersion]);

  // Use ref to access displayFiles in callbacks without dependency issues
  const displayFilesRef = useRef(displayFiles);

  useEffect(() => {
    displayFilesRef.current = displayFiles;
  }, [displayFiles]);

  const activeFilePath = useMemo(() => {
    const found = displayFiles.find((f) => f.new_path === selectedFile && !f.new_path.endsWith('/'));
    if (found) return found.new_path;
    return displayFiles.find((f) => !f.new_path.endsWith('/'))?.new_path || null;
  }, [displayFiles, selectedFile]);


  // Auto-detect iframe mode
  const isEmbedded = embedded ?? (typeof window !== 'undefined' && window !== window.parent);

  // When switching modes or on initial load, ensure selectedFile is valid
  // Skip if there is a pending file navigation (it will set selectedFile itself)
  useEffect(() => {
    if (displayFiles.length === 0) return;
    if (pendingNavRef.current) return; // navigation effect will handle selection
    const firstFile = displayFiles.find((f) => !f.new_path.endsWith('/'));
    if (!selectedFile || !displayFiles.some((f) => f.new_path === selectedFile && !f.new_path.endsWith('/'))) {
      if (firstFile) {
        setSelectedFile(firstFile.new_path);
        setCurrentFileIndex(displayFiles.indexOf(firstFile));
      }
    }
  }, [displayFiles, selectedFile]);

  // Trigger diff load whenever selected file changes in CHANGES mode
  useEffect(() => {
    if (!selectedFile || viewMode !== 'diff') return;
    loadFileDiffRef.current(selectedFile, currentDiffRefs.fromRef, currentDiffRefs.toRef);
  }, [selectedFile, viewMode, currentDiffRefs.fromRef, currentDiffRefs.toRef]);

  // Resolve pending navigation once displayFiles updates (after mode switch)
  // Also re-run when navigateToFile changes (for when Review tab already exists)
  useEffect(() => {
    const pending = pendingNavRef.current;
    if (!pending || displayFiles.length === 0) return;

    // Find matching file — try exact match first, then suffix match in both directions
    const target = pending.file;
    let match = displayFiles.find((f) => f.new_path === target && !f.new_path.endsWith('/'));
    if (!match) {
      // Target is absolute, file is relative: check if target ends with /file
      match = displayFiles.find((f) => !f.new_path.endsWith('/') && target.endsWith('/' + f.new_path));
    }
    if (!match) {
      // File is absolute, target is relative: check if file ends with /target
      match = displayFiles.find((f) => !f.new_path.endsWith('/') && f.new_path.endsWith('/' + target));
    }
    if (!match) {
      // Loose suffix match (either direction)
      match = displayFiles.find((f) => !f.new_path.endsWith('/') && (f.new_path.endsWith(target) || target.endsWith(f.new_path)));
    }

    if (!match && viewMode === 'full' && focusMode) {
      // File not yet in tree — expand parent directories to trigger lazy load.
      // Build all ancestor paths of the target file (relative path assumed).
      const parts = target.replace(/^\//, '').split('/');
      const parentPaths: string[] = [];
      for (let i = 1; i < parts.length; i++) {
        parentPaths.push(parts.slice(0, i).join('/'));
      }
      // Expand any parent that hasn't been tried yet
      for (const dirPath of parentPaths) {
        if (!expandedForNavRef.current.has(dirPath)) {
          expandedForNavRef.current.add(dirPath);
          getTaskDirEntries(projectId, taskId, dirPath)
            .then((result) => appendLazyFilesRef.current(result.entries))
            .catch(console.error);
        }
      }
      // displayFiles will update when appendLazyFiles runs, re-triggering this effect
      return;
    }

    if (match) {
      expandedForNavRef.current.clear();
      pendingNavRef.current = null;
      const resolvedPath = match.new_path;
      setSelectedFile(resolvedPath);
      setCurrentFileIndex(displayFiles.indexOf(match));
      // Uncollapse it if collapsed
      setCollapsedFiles((prev) => {
        if (!prev.has(resolvedPath)) return prev;
        const next = new Set(prev);
        next.delete(resolvedPath);
        return next;
      });
      if (pending.line) {
        // Set scrollToLine — DiffFileView will handle expanding gaps + scrolling to the line
        // Use seq to force re-trigger even for repeated clicks on the same file:line
        setScrollToLine({ file: resolvedPath, line: pending.line, seq: ++scrollSeqRef.current });
      } else {
        // No line number — just scroll the file header into view
        requestAnimationFrame(() => {
          const el = document.getElementById(`diff-file-${encodeURIComponent(resolvedPath)}`);
          el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      }
    }
  }, [displayFiles, navigateToFile, viewMode, focusMode, projectId, taskId]);

  // Load full file content with concurrency control
  const loadFullFileContent = useCallback(async (filePath: string) => {
    if (fullFileContents.has(filePath) || loadingFiles.has(filePath) || failedFullFilesRef.current.has(filePath)) return;

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
          failedFullFilesRef.current.add(path);
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

  const appendLazyFilesRef = useRef(appendLazyFiles);
  appendLazyFilesRef.current = appendLazyFiles;

  // true after initial load completes — prevents double-fetch on mount
  const modeSwitchReadyRef = useRef(false);
  // Monotonic counter — increment before each fetch; stale responses are discarded
  const fetchGenRef = useRef(0);
  // Refs so initial load closure can read the latest mode without re-running
  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;
  const focusModeRef = useRef(focusMode);
  focusModeRef.current = focusMode;

  useEffect(() => {
    if (!modeSwitchReadyRef.current) return;

    const gen = ++fetchGenRef.current;
    setFocusFiles([]);
    setLoading(true);
    // Reset scroll position so the new mode starts at the top
    if (contentRef.current) contentRef.current.scrollTop = 0;
    if (viewMode === 'full' && focusMode) {
      getTaskDirEntries(projectId, taskId, '').then((result) => {
        if (fetchGenRef.current !== gen) return;
        lazyRootDirEntriesRef.current = result.entries;
        appendLazyFilesRef.current(result.entries);
      }).catch(console.error).finally(() => {
        if (fetchGenRef.current === gen) setLoading(false);
      });
    } else if (viewMode === 'full' && !focusMode) {
      getTaskFiles(projectId, taskId).then((result) => {
        if (fetchGenRef.current !== gen) return;
        setAllFiles(result.files);
      }).catch(() => null).finally(() => {
        if (fetchGenRef.current === gen) setLoading(false);
      });
    } else {
      refetchDiffRef.current({ ...currentDiffRefsRef.current, gen }); // pass gen so refetchDiff can discard stale responses
    }
  }, [viewMode, focusMode, projectId, taskId]);

  const handleToggleFocusMode = useCallback(async () => {
    if (!focusMode) {
      // Switching back to Focus — always allowed
      setFocusModeWarn(null);
      setFocusMode(true);
      return;
    }
    // Switching to Un-Focus — check file count first
    let count = allFiles.length;
    if (count === 0) {
      try {
        const result = await getTaskFiles(projectId, taskId);
        count = result.files.length;
      } catch {
        setFocusMode(false);
        return;
      }
    }
    if (count > 1000) {
      setFocusModeWarn(`Too many files (${count}). Un-Focus mode is limited to repos with ≤ 1000 files.`);
      return;
    }
    setFocusModeWarn(null);
    setFocusMode(false);
  }, [focusMode, allFiles, projectId, taskId]);

  const loadFileDiff = useCallback(async (filePath: string, fromRef?: string, toRef?: string) => {
    if (fileDiffCacheRef.current.has(filePath) || loadingDiffsRef.current.has(filePath)) return;
    loadingDiffsRef.current = new Set(loadingDiffsRef.current).add(filePath);
    try {
      const result = await getSingleFileDiff(projectId, taskId, filePath, fromRef, toRef);
      fileDiffCacheRef.current = new Map(fileDiffCacheRef.current).set(filePath, result);
    } catch (e: unknown) {
      const status = (e as { status?: number })?.status;
      const marker = status === 400 || status === 415 || status === 422 ? 'unsupported' : 'error';
      fileDiffCacheRef.current = new Map(fileDiffCacheRef.current).set(filePath, marker);
    } finally {
      const next = new Set(loadingDiffsRef.current);
      next.delete(filePath);
      loadingDiffsRef.current = next;
      setCacheVersion(v => v + 1);
    }
  }, [projectId, taskId]);

  const loadFileDiffRef = useRef(loadFileDiff);
  loadFileDiffRef.current = loadFileDiff;

  const handleExpandDir = useCallback(async (dirPath: string): Promise<DirEntry[]> => {
    const result = await getTaskDirEntries(projectId, taskId, dirPath);
    appendLazyFilesRef.current(result.entries);
    return result.entries;
  }, [projectId, taskId]);

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

    // In Changes mode, compute hash based on cached diff content
    if (!diffData) return hashes;
    for (const f of diffData.files) {
      const cached = fileDiffCacheRef.current.get(f.path);
      let hash = 5381;
      if (cached && typeof cached !== 'string' && cached.hunks) {
        for (const h of cached.hunks) {
          for (const l of h.lines) {
            for (let i = 0; i < l.content.length; i++) {
              hash = ((hash << 5) + hash) + l.content.charCodeAt(i);
              hash = hash & hash;
            }
          }
        }
      } else {
        for (let i = 0; i < f.path.length; i++) {
          hash = ((hash << 5) + hash) + f.path.charCodeAt(i);
          hash = hash & hash;
        }
      }
      hashes.set(f.path, hash.toString(36));
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
  // gen: if provided, discard response when fetchGenRef has advanced past this gen
  const refetchDiff = useCallback(async ({ fromRef, toRef, keepSelection = false, gen }: RefetchDiffOptions = {}) => {
    // If no external gen provided, claim a new one so version-change calls also cancel stale fetches
    if (gen === undefined) {
      gen = ++fetchGenRef.current;
    }

    setLoading(true);
    try {
      fileDiffCacheRef.current = new Map();
      loadingDiffsRef.current = new Set();
      const data = await getDiffStats(projectId, taskId, fromRef, toRef);
      if (fetchGenRef.current !== gen) return; // stale — a newer fetch is running
      setDiffData(data);
      if (!keepSelection) {
        setSelectedFile(null);
      } else {
        const selected = selectedFileRef.current;
        if (selected && data.files.some((f) => f.path === selected)) {
          loadFileDiffRef.current(selected, fromRef, toRef);
        }
      }
    } catch (e) {
      if (fetchGenRef.current !== gen) return;
      setError(e instanceof Error ? e.message : 'Failed to load diff');
    } finally {
      if (fetchGenRef.current === gen) setLoading(false);
    }
  }, [projectId, taskId]);

  const refetchDiffRef = useRef(refetchDiff);
  refetchDiffRef.current = refetchDiff;

  // Version change handlers — directly trigger refetch
  const handleFromVersionChange = useCallback((id: string) => {
    setFromVersion(id);
    if (versions.length === 0) return;
    const fromOpt = versions.find((v) => v.id === id);
    const toOpt = versions.find((v) => v.id === toVersion);
    refetchDiff({ fromRef: fromOpt?.ref, toRef: toOpt?.ref });
  }, [versions, toVersion, refetchDiff]);

  const handleToVersionChange = useCallback((id: string) => {
    setToVersion(id);
    if (versions.length === 0) return;
    const fromOpt = versions.find((v) => v.id === fromVersion);
    const toOpt = versions.find((v) => v.id === id);
    refetchDiff({ fromRef: fromOpt?.ref, toRef: toOpt?.ref });
  }, [versions, fromVersion, refetchDiff]);

  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    requestQueue.current = [];
    activeRequests.current.clear();
    setLoadingFiles(new Set());
    setFullFileContents(new Map());
    fileDiffCacheRef.current = new Map();
    loadingDiffsRef.current = new Set();
    lazyRootDirEntriesRef.current = [];

    const fromOpt = versions.find((v) => v.id === fromVersion);
    const toOpt = versions.find((v) => v.id === toVersion);

    const commentsPromise = getReviewComments(projectId, taskId).then((result) => {
      setComments(result.comments);
      if (result.git_user_name) gitUserNameRef.current = result.git_user_name;
    }).catch(() => null);

    try {
      if (viewMode === 'diff') {
        await Promise.all([
          refetchDiff({ fromRef: fromOpt?.ref, toRef: toOpt?.ref, keepSelection: true }),
          commentsPromise,
        ]);
      } else if (focusMode) {
        await Promise.all([
          commentsPromise,
          getTaskDirEntries(projectId, taskId, '').then((result) => {
            lazyRootDirEntriesRef.current = result.entries;
            appendLazyFiles(result.entries);
          }).catch(() => null),
        ]);
      } else {
        await Promise.all([
          commentsPromise,
          getTaskFiles(projectId, taskId).then((result) => {
            setAllFiles(result.files);
          }).catch(() => null),
        ]);
      }
    } finally {
      setRefreshing(false);
    }
  }, [versions, fromVersion, toVersion, refetchDiff, projectId, taskId, viewMode, focusMode, appendLazyFiles]);

  const handleSetViewMode = useCallback((nextMode: 'diff' | 'full') => {
    sessionStorage.setItem(viewModeStorageKey, nextMode);
    setViewMode(nextMode);
  }, [viewModeStorageKey]);

  // Initial load: diff + comments + commits (builds version list)
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);
      fileDiffCacheRef.current = new Map();
      loadingDiffsRef.current = new Set();
      try {
        let reviewComments: ReviewCommentEntry[] = [];

        const diffPromise = viewMode === 'diff'
          ? getDiffStats(projectId, taskId)
          : Promise.resolve({ files: [], total_additions: 0, total_deletions: 0 } as DiffStatsResult);
        const commitsPromise = viewMode === 'diff'
          ? getCommits(projectId, taskId).catch(() => null)
          : Promise.resolve(null);
        const filesPromise = viewMode === 'full' && !focusMode
          ? getTaskFiles(projectId, taskId).catch(() => null)
          : Promise.resolve(null);
        const dirEntriesPromise = viewMode === 'full' && focusMode
          ? getTaskDirEntries(projectId, taskId, '').catch(() => null)
          : Promise.resolve(null);

        const [diffResult, reviewData, commitsData, filesData, dirEntriesData] = await Promise.all([
          diffPromise,
          getReviewComments(projectId, taskId).catch(() => null),
          commitsPromise,
          filesPromise,
          dirEntriesPromise,
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
          const existingFilePaths = new Set(data.files.map(f => f.path));
          const virtualFilePaths = reviewComments
            .filter(c => c.file_path && !existingFilePaths.has(c.file_path))
            .map(c => c.file_path!)
            .filter((path, idx, arr) => arr.indexOf(path) === idx);

          if (virtualFilePaths.length > 0) {
            const virtualEntries = virtualFilePaths.map(path => ({
              path,
              status: 'A' as const,
              additions: 0,
              deletions: 0,
              is_binary: false,
            }));
            setDiffData({ ...data, files: [...data.files, ...virtualEntries] });
          } else {
            setDiffData(data);
          }
          if (filesData) {
            setAllFiles(filesData.files);
          }
          if (dirEntriesData) {
            lazyRootDirEntriesRef.current = dirEntriesData.entries;
            appendLazyFiles(dirEntriesData.entries);
          }
          setComments(reviewComments);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load diff');
        }
      } finally {
        if (!cancelled) {
          modeSwitchReadyRef.current = true;
          setLoading(false);
          // Race condition: if viewMode switched to 'full' while this diff-mode initial load
          // was in-flight, the mode-switch effect fired but was gated by modeSwitchReady=false.
          // Now that we're ready, trigger the All Files fetch manually.
          if (viewMode === 'diff' && viewModeRef.current === 'full') {
            if (!focusModeRef.current) {
              getTaskFiles(projectId, taskId)
                .then((result) => { if (!cancelled) setAllFiles(result.files); })
                .catch(() => null);
            } else {
              getTaskDirEntries(projectId, taskId, '')
                .then((result) => {
                  if (!cancelled) {
                    lazyRootDirEntriesRef.current = result.entries;
                    appendLazyFilesRef.current(result.entries);
                  }
                })
                .catch(console.error);
            }
          }
          // Auto-focus content area so arrow keys scroll immediately
          requestAnimationFrame(() => contentRef.current?.focus());
        }
      }
    };

    load();
    return () => { cancelled = true; };
  }, [projectId, taskId]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Unfocus mode: batch load diffs for all files after initial load
  useEffect(() => {
    if (viewMode !== 'diff' || focusMode || !diffData || diffData.files.length === 0) return;
    const fromOpt = versions.find(v => v.id === fromVersion);
    const toOpt = versions.find(v => v.id === toVersion);
    const batchSize = 5;
    const files = diffData.files;
    let idx = 0;
    const loadBatch = () => {
      const batch = files.slice(idx, idx + batchSize);
      if (batch.length === 0) return;
      idx += batchSize;
      Promise.all(batch.map(f => {
        if (fileDiffCacheRef.current.has(f.path) || loadingDiffsRef.current.has(f.path)) return Promise.resolve();
        loadingDiffsRef.current = new Set(loadingDiffsRef.current).add(f.path);
        return getSingleFileDiff(projectId, taskId, f.path, fromOpt?.ref, toOpt?.ref)
          .then(result => {
            fileDiffCacheRef.current = new Map(fileDiffCacheRef.current).set(f.path, result);
          })
          .catch((e: unknown) => {
            const status = (e as { status?: number })?.status;
            const marker = status === 400 || status === 415 || status === 422 ? 'unsupported' : 'error';
            fileDiffCacheRef.current = new Map(fileDiffCacheRef.current).set(f.path, marker);
          })
          .finally(() => {
            const next = new Set(loadingDiffsRef.current);
            next.delete(f.path);
            loadingDiffsRef.current = next;
          });
      })).then(() => {
        setCacheVersion(v => v + 1);
        loadBatch();
      });
    };
    loadBatch();
  }, [viewMode, focusMode, diffData, projectId, taskId, versions, fromVersion, toVersion]);


  // Listen for Ctrl+F / Cmd+F to open code search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        setCodeSearchVisible(true);
      }
      // ESC to close code search — skip if a lightbox is open (it handles ESC itself)
      if (e.key === 'Escape' && codeSearchVisible && !document.querySelector('[data-lightbox-active]')) {
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

  // Scroll to file when clicking sidebar — ignore directory placeholders (path ends with '/')
  const handleSelectFile = useCallback((path: string) => {
    if (path.endsWith('/')) return;
    setSelectedFile(path);
    if (viewMode === 'diff') {
      const fromOpt = versions.find(v => v.id === fromVersion);
      const toOpt = versions.find(v => v.id === toVersion);
      loadFileDiff(path, fromOpt?.ref, toOpt?.ref);
    }
    if (focusMode) {
      // Focus mode renders only the selected file — reset scroll to top
      if (contentRef.current) contentRef.current.scrollTop = 0;
    } else {
      const el = document.getElementById(`diff-file-${encodeURIComponent(path)}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    if (isMobile) {
      setSidebarVisible(false);
    }
  }, [isMobile, loadFileDiff, versions, fromVersion, toVersion, focusMode, viewMode]);

  const handleTogglePreview = useCallback((path: string) => {
    setPreviewOverrides((prev) => {
      const next = new Map(prev);
      const renderer = getPreviewRenderer(path);
      const defaultOpen = displayMode !== 'code' && !!renderer;
      const currentlyOpen = prev.has(path) ? prev.get(path)! : defaultOpen;
      if (!currentlyOpen === defaultOpen) {
        // Toggling back to default — remove override
        next.delete(path);
      } else {
        next.set(path, !currentlyOpen);
      }
      return next;
    });
  }, [displayMode]);

  const handleToggleActivePreview = useCallback(() => {
    if (!activeFilePath || !getPreviewRenderer(activeFilePath)) return;
    handleTogglePreview(activeFilePath);
  }, [activeFilePath, handleTogglePreview]);

  // (hotkeys registered below, after goToNextFile/goToPrevFile/handleToggleViewed are defined)

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

  // Toggle viewed status of the active file
  const handleToggleActiveViewed = useCallback(() => {
    if (activeFilePath) handleToggleViewed(activeFilePath);
  }, [activeFilePath, handleToggleViewed]);

  // Toggle Changes / All Files mode
  const handleToggleViewMode = useCallback(() => {
    const nextMode = viewMode === 'diff' ? 'full' : 'diff';
    void handleSetViewMode(nextMode);
  }, [viewMode, handleSetViewMode]);

  // Review panel keyboard shortcuts
  useHotkeys(
    [
      { key: 'j', handler: goToNextFile },
      { key: 'k', handler: goToPrevFile },
      { key: 'v', handler: handleToggleActiveViewed },
      { key: 'r', handler: handleRefresh },
      { key: 'Shift+Tab', handler: handleToggleViewMode, options: { preventDefault: true } },
      { key: 'p', handler: handleToggleActivePreview },
    ],
    [goToNextFile, goToPrevFile, handleToggleActiveViewed, handleRefresh, handleToggleViewMode, handleToggleActivePreview]
  );

  // Toggle collapse — in diff mode, load the diff when expanding a previously-collapsed file
  const handleToggleCollapse = useCallback((path: string) => {
    setCollapsedFiles((prev) => {
      const wasCollapsed = prev.has(path);
      const next = new Set(prev);
      if (wasCollapsed) {
        next.delete(path);
        // Trigger diff load when expanding in diff mode (lazy / ≥1000 case)
        if (viewMode === 'diff') {
          const fromOpt = versions.find(v => v.id === fromVersion);
          const toOpt = versions.find(v => v.id === toVersion);
          loadFileDiff(path, fromOpt?.ref, toOpt?.ref);
        }
      } else {
        next.add(path);
      }
      return next;
    });
  }, [viewMode, versions, fromVersion, toVersion, loadFileDiff]);

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
  }, [projectId, taskId, applyReviewResponse]);

  // Delete comment
  const handleDeleteComment = useCallback(async (id: number) => {
    try {
      const result = await apiDeleteComment(projectId, taskId, id);
      applyReviewResponse(result);
    } catch {
      // Could add toast here
    }
  }, [projectId, taskId, applyReviewResponse]);

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
  }, [projectId, taskId, applyReviewResponse]);

  // Add project comment
  const handleAddProjectComment = useCallback(async (content: string) => {
    try {
      const result = await createProjectComment(projectId, taskId, content, gitUserNameRef.current);
      applyReviewResponse(result);
    } catch {
      // Could add toast here
    }
  }, [projectId, taskId, applyReviewResponse]);

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
  }, [projectId, taskId, applyReviewResponse]);

  // Resolve comment (mark as resolved + auto-collapse)
  const handleResolveComment = useCallback(async (id: number) => {
    try {
      const result = await apiUpdateCommentStatus(projectId, taskId, id, 'resolved');
      applyReviewResponse(result);
      setCollapsedCommentIds((prev) => new Set([...prev, id]));
    } catch {
      // Could add toast here
    }
  }, [projectId, taskId, applyReviewResponse]);

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
  }, [projectId, taskId, applyReviewResponse]);

  // Edit comment content
  const handleEditComment = useCallback(async (id: number, content: string) => {
    try {
      const result = await apiEditComment(projectId, taskId, id, content);
      applyReviewResponse(result);
    } catch {
      // Could add toast here
    }
  }, [projectId, taskId, applyReviewResponse]);

  // Edit reply content
  const handleEditReply = useCallback(async (commentId: number, replyId: number, content: string) => {
    try {
      const result = await apiEditReply(projectId, taskId, commentId, replyId, content);
      applyReviewResponse(result);
    } catch {
      // Could add toast here
    }
  }, [projectId, taskId, applyReviewResponse]);

  // Delete reply
  const handleDeleteReply = useCallback(async (commentId: number, replyId: number) => {
    try {
      const result = await apiDeleteReply(projectId, taskId, commentId, replyId);
      applyReviewResponse(result);
    } catch {
      // Could add toast here
    }
  }, [projectId, taskId, applyReviewResponse]);

  // Bulk delete comments
  const handleBulkDelete = useCallback(async (statuses?: string[], authors?: string[]) => {
    try {
      const result = await apiBulkDeleteComments(projectId, taskId, statuses, authors);
      applyReviewResponse(result);
    } catch {
      // Could add toast here
    }
  }, [projectId, taskId, applyReviewResponse]);

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
          {isGitRepo !== false && (
            <button
              className={viewMode === 'diff' ? 'active' : ''}
              onClick={() => void handleSetViewMode('diff')}
            >
              <GitCompare size={14} />
              <span>Changes</span>
            </button>
          )}
          <button
            className={viewMode === 'full' ? 'active' : ''}
            onClick={() => void handleSetViewMode('full')}
          >
            <FileText size={14} />
            <span>All Files</span>
          </button>
        </div>
        <button
          className="diff-refresh-btn"
          onClick={handleRefresh}
          disabled={refreshing}
          title="Refresh diff"
        >
          <RefreshCw size={14} className={refreshing ? 'spin' : ''} />
        </button>
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
            onClick={() => void handleToggleFocusMode()}
            title="Focus mode — show one file at a time"
          >
            <Crosshair style={{ width: 12, height: 12 }} />
            Focus
          </button>
          {focusModeWarn && (
            <span
              style={{ fontSize: 11, color: 'var(--color-warning)', whiteSpace: 'nowrap', cursor: 'pointer' }}
              onClick={() => setFocusModeWarn(null)}
              title="Click to dismiss"
            >
              {focusModeWarn}
            </span>
          )}
          <button
            className="diff-toggle-pill"
            onClick={() => setDisplayMode((v) => v === 'code' ? 'split' : v === 'split' ? 'preview' : 'code')}
            title={`Display: ${displayMode === 'code' ? 'Code' : displayMode === 'split' ? 'Split' : 'Preview'} — click to cycle`}
          >
            {displayMode === 'code' ? (
              <Code style={{ width: 12, height: 12 }} />
            ) : displayMode === 'split' ? (
              <Columns2 style={{ width: 12, height: 12 }} />
            ) : (
              <Eye style={{ width: 12, height: 12 }} />
            )}
            {displayMode === 'code' ? 'Code' : displayMode === 'split' ? 'Split' : 'Preview'}
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
        {loading ? (
          <div className="diff-content" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: 8 }}>
            <div className="spinner" />
            <span style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>Loading...</span>
          </div>
        ) : isEmpty ? (
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
              onExpandDir={viewMode === 'full' && focusMode ? handleExpandDir : undefined}
              onLoadFileDiff={viewMode === 'full' && focusMode ? loadFileDiff : undefined}
            />

            {/* Diff content */}
            <div className="diff-content" ref={contentRef} tabIndex={-1} style={{ outline: 'none' }}>
              {(() => {
                // Reset global match index before rendering
                resetGlobalMatchIndex();
                return (focusMode
                  ? displayFiles.filter((f) => f.new_path === validSelectedFile)
                  : displayFiles
                ).map((file) => {
                  const renderer = getPreviewRenderer(file.new_path);
                  const defaultOpen = displayMode !== 'code' && !!renderer;
                  const isPreviewOpen = previewOverrides.has(file.new_path)
                    ? previewOverrides.get(file.new_path)!
                    : defaultOpen;
                  return (
                    <DiffFileView
                      key={file.new_path}
                      file={file}
                      viewType={viewType}
                      isActive={validSelectedFile === file.new_path}
                      isPreviewOpen={isPreviewOpen}
                      onTogglePreview={renderer ? handleTogglePreview : undefined}
                      previewRenderer={renderer}
                      defaultExpanded={displayMode === 'preview'}
                      projectId={projectId}
                      taskId={taskId}
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
                      scrollToLine={scrollToLine?.file === file.new_path ? { line: scrollToLine.line, seq: scrollToLine.seq } : undefined}
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
              onBulkDelete={handleBulkDelete}
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
