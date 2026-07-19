import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { getDiffStats, getSingleFileDiff, createInlineComment, createFileComment, createProjectComment, deleteComment as apiDeleteComment, replyReviewComment as apiReplyComment, updateCommentStatus as apiUpdateCommentStatus, getFileContent, editComment as apiEditComment, editReply as apiEditReply, deleteReply as apiDeleteReply, bulkDeleteComments as apiBulkDeleteComments } from '../../api/review';
import type { DiffFile, DiffStatsResult } from '../../api/review';
import { getReviewComments, getCommits, getTaskFiles, getTaskDirEntries, getTask, openTaskFile } from '../../api/tasks';
import type { ReviewCommentEntry, ReviewCommentsResponse, DirEntry, CommitsResponse } from '../../api/tasks';
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

/** Build VersionOption[] from a commits response: Latest + Version N..1 + Base. */
function buildVersionOpts(commitsData: CommitsResponse | null | undefined): VersionOption[] {
  const opts: VersionOption[] = [{ id: 'latest', label: 'Latest' }];
  // Every commit between Base..HEAD gets its own Version entry. When working
  // tree is clean the newest commit (commits[0]) ends up identical to Latest;
  // selecting it produces a diff of 0, which is fine — users explicitly want
  // each commit pickable in the selector. (Previous logic skipped the leading
  // commits with the same tree as HEAD via `skip_versions`, which silently
  // dropped commits[0] in the common clean-worktree case.)
  if (commitsData && commitsData.commits.length > 0) {
    const totalCommits = commitsData.commits.length;
    for (let i = 0; i < totalCommits; i++) {
      const versionNum = totalCommits - i;
      opts.push({
        id: `v${versionNum}`,
        label: `Version ${versionNum}`,
        ref: commitsData.commits[i].hash,
      });
    }
  }
  opts.push({ id: 'target', label: 'Base' });
  return opts;
}

/** Validate that fromVersion/toVersion still exist in opts; fall back to Base/Latest if not. */
function reconcileVersionSelection(
  opts: VersionOption[],
  fromVersion: string,
  toVersion: string,
): { from: string; to: string; changed: boolean } {
  let from = fromVersion;
  let to = toVersion;
  let changed = false;
  if (!opts.some((v) => v.id === fromVersion)) {
    from = 'target';
    changed = true;
  }
  if (!opts.some((v) => v.id === toVersion)) {
    to = 'latest';
    changed = true;
  }
  return { from, to, changed };
}
import { FileTreeSidebar } from './FileTreeSidebar';
import { DiffFileView, resetGlobalMatchIndex } from './DiffFileView';
import { ConversationSidebar } from './ConversationSidebar';
import { CodeSearchBar } from './CodeSearchBar';
import { MessageSquare, ChevronUp, ChevronDown, PanelLeftClose, PanelLeftOpen, Crosshair, GitCompare, FileText, RefreshCw, Code, Columns2, Eye, ZoomIn, ZoomOut } from 'lucide-react';
import { VersionSelector } from './VersionSelector';
import { useIsMobile } from '../../hooks';
import { useKeyboardScope, useCommand, useContextKey } from '../../keyboard';
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
  isChatBusy?: boolean;
}

interface RefetchDiffOptions {
  fromRef?: string;
  toRef?: string;
  keepSelection?: boolean;
  gen?: number;
  silent?: boolean;
}

import { getPreviewRenderer } from './previewRenderers';


export function DiffReviewPage({ projectId, taskId, embedded, navigateToFile, isGitRepo, isChatBusy }: DiffReviewPageProps) {
  const { isMobile } = useIsMobile();
  const [diffData, setDiffData] = useState<DiffStatsResult | null>(null);
  const [taskPath, setTaskPath] = useState<string | null>(null);
  useEffect(() => {
    const ac = new AbortController();
    // Fetch by id rather than scanning the task list: `listTasks` omits the
    // Local Task (`_local`), which left `taskPath` null and greyed out "Copy
    // Full Path". `getTask` resolves both worktree-backed and local tasks.
    getTask(projectId, taskId, ac.signal)
      .then((task) => {
        if (!ac.signal.aborted) setTaskPath(task.path);
      })
      .catch(() => {
        // Aborted requests / transient errors — fine to swallow.
        // "Copy Full Path" briefly unavailable; next render will retry.
      });
    return () => ac.abort();
  }, [projectId, taskId]);
  const [allFiles, setAllFiles] = useState<string[]>([]); // All git-tracked files for File Mode
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const selectedFileRef = useRef<string | null>(selectedFile);
  useEffect(() => {
    selectedFileRef.current = selectedFile;
  }, [selectedFile]);
  // Cached header/version options (workspace + task ID). Memoized so we don't
  // re-read + re-parse localStorage on every render — the parsed value only
  // feeds useState lazy initializers below, so once-per-key is enough.
  const headerOptionsStorageKey = `grove:review-options:${projectId}:${taskId}`;
  const initialCachedOptions = useMemo(() => {
    try {
      const stored = localStorage.getItem(headerOptionsStorageKey);
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  }, [headerOptionsStorageKey]);

  const [viewTypeState, setViewType] = useState<'unified' | 'split'>(() => {
    if (initialCachedOptions && (initialCachedOptions.viewType === 'unified' || initialCachedOptions.viewType === 'split')) {
      return initialCachedOptions.viewType;
    }
    return 'unified';
  });
  // On mobile, force unified view (split mode is hidden on mobile anyway).
  const viewType: 'unified' | 'split' = isMobile ? 'unified' : viewTypeState;
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

  // currentFileIndex is derived below from activeFilePath
  // Viewed files: path → hash at view time, persisted to localStorage
  const viewedStorageKey = `grove:viewed:${projectId}:${taskId}`;
  const [viewedFiles, setViewedFiles] = useState<Map<string, string>>(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(viewedStorageKey);
    } catch {
      return new Map();
    }
    if (!stored) return new Map();
    try {
      return new Map(JSON.parse(stored) as [string, string][]);
    } catch {
      return new Map();
    }
  });

  const [autoViewedRules, setAutoViewedRules] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem(`grove:project:${projectId}:autoViewedRules`);
      return stored ? JSON.parse(stored) as string[] : [];
    } catch {
      return [];
    }
  });
  const [sidebarSearch, setSidebarSearch] = useState('');
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  const [replyFormCommentId, setReplyFormCommentId] = useState<number | null>(null);
  // Sidebar state is split into desktop/mobile so we can derive the effective value
  // without setState-in-effect. Each track its own open/closed user intent; switching
  // viewport size restores whichever side's previous state.
  const [desktopSidebarVisible, setDesktopSidebarVisible] = useState(true);
  const [mobileSidebarVisible, setMobileSidebarVisible] = useState(false);
  const [desktopConvSidebarVisible, setDesktopConvSidebarVisible] = useState(false);
  const [mobileConvSidebarVisible, setMobileConvSidebarVisible] = useState(false);
  const sidebarVisible = isMobile ? mobileSidebarVisible : desktopSidebarVisible;
  const convSidebarVisible = isMobile ? mobileConvSidebarVisible : desktopConvSidebarVisible;
  const setSidebarVisible = useCallback((next: boolean | ((prev: boolean) => boolean)) => {
    if (isMobile) setMobileSidebarVisible(next);
    else setDesktopSidebarVisible(next);
  }, [isMobile]);
  const setConvSidebarVisible = useCallback((next: boolean | ((prev: boolean) => boolean)) => {
    if (isMobile) setMobileConvSidebarVisible(next);
    else setDesktopConvSidebarVisible(next);
  }, [isMobile]);

  // Resizable sidebar widths (desktop only — mobile uses fixed overlays).
  // Persisted per task so reopening the panel keeps the user's layout.
  const DEFAULT_SIDEBAR_WIDTH = 280;
  const DEFAULT_CONV_SIDEBAR_WIDTH = 320;
  const SIDEBAR_MIN_WIDTH = 180;
  const SIDEBAR_MAX_RATIO = 0.5;
  const sidebarWidthStorageKey = `grove:diff-review-sidebar-width:${projectId}:${taskId}`;

  const readStoredSidebarWidth = (fallback: number, persisted: number | undefined): number => {
    return typeof persisted === 'number' && Number.isFinite(persisted) && persisted >= SIDEBAR_MIN_WIDTH
      ? persisted
      : fallback;
  };

  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(sidebarWidthStorageKey);
      if (!raw) return DEFAULT_SIDEBAR_WIDTH;
      const parsed = JSON.parse(raw) as { sidebarWidth?: number; convSidebarWidth?: number };
      return readStoredSidebarWidth(DEFAULT_SIDEBAR_WIDTH, parsed.sidebarWidth);
    } catch {
      return DEFAULT_SIDEBAR_WIDTH;
    }
  });
  const [convSidebarWidth, setConvSidebarWidth] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(sidebarWidthStorageKey);
      if (!raw) return DEFAULT_CONV_SIDEBAR_WIDTH;
      const parsed = JSON.parse(raw) as { sidebarWidth?: number; convSidebarWidth?: number };
      return readStoredSidebarWidth(DEFAULT_CONV_SIDEBAR_WIDTH, parsed.convSidebarWidth);
    } catch {
      return DEFAULT_CONV_SIDEBAR_WIDTH;
    }
  });

  useEffect(() => {
    try {
      const raw = localStorage.getItem(sidebarWidthStorageKey);
      const parsed: { sidebarWidth?: number; convSidebarWidth?: number } = raw
        ? JSON.parse(raw)
        : {};
      parsed.sidebarWidth = Math.round(sidebarWidth);
      parsed.convSidebarWidth = Math.round(convSidebarWidth);
      localStorage.setItem(sidebarWidthStorageKey, JSON.stringify(parsed));
    } catch {
      // ignore storage errors
    }
  }, [sidebarWidth, convSidebarWidth, sidebarWidthStorageKey]);

  // Min width the diff content keeps when a sidebar is dragged to its max, so
  // the two sidebars can't jointly squeeze the content to near-zero.
  const MIN_CONTENT_WIDTH = 320;
  // `otherWidth` is the currently-visible opposite sidebar's width (0 if hidden);
  // we reserve it plus MIN_CONTENT_WIDTH so the dragged sidebar can't overlap it.
  const clampSidebarWidth = (value: number, layoutWidth: number, otherWidth = 0): number => {
    const ratioMax = Math.floor(layoutWidth * SIDEBAR_MAX_RATIO);
    const fitMax = layoutWidth - otherWidth - MIN_CONTENT_WIDTH;
    const max = Math.max(SIDEBAR_MIN_WIDTH, Math.min(ratioMax, fitMax));
    return Math.min(max, Math.max(SIDEBAR_MIN_WIDTH, value));
  };

  const startSidebarResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const layoutEl = event.currentTarget.parentElement;
    if (!layoutEl) return;
    const layoutWidth = layoutEl.getBoundingClientRect().width;
    if (layoutWidth <= 0) return;
    const startX = event.clientX;
    const startWidth = sidebarWidth;

    const otherWidth = convSidebarVisible ? convSidebarWidth : 0;
    const handlePointerMove = (moveEvent: PointerEvent) => {
      const next = clampSidebarWidth(
        startWidth + (moveEvent.clientX - startX),
        layoutWidth,
        otherWidth,
      );
      setSidebarWidth(next);
    };
    const handlePointerUp = () => {
      document.body.classList.remove('grove-resizing');
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerUp);
    };
    // While dragging, disable pointer events on iframes so the drag doesn't
    // stutter when crossing an embedded preview. See index.css body.grove-resizing.
    document.body.classList.add('grove-resizing');
    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerup', handlePointerUp);
  }, [sidebarWidth, convSidebarWidth, convSidebarVisible]);

  const startConvSidebarResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const layoutEl = event.currentTarget.parentElement;
    if (!layoutEl) return;
    const layoutWidth = layoutEl.getBoundingClientRect().width;
    if (layoutWidth <= 0) return;
    const startX = event.clientX;
    const startWidth = convSidebarWidth;

    const otherWidth = sidebarVisible ? sidebarWidth : 0;
    const handlePointerMove = (moveEvent: PointerEvent) => {
      // Right-side resizer: dragging left grows the sidebar.
      const next = clampSidebarWidth(
        startWidth + (startX - moveEvent.clientX),
        layoutWidth,
        otherWidth,
      );
      setConvSidebarWidth(next);
    };
    const handlePointerUp = () => {
      document.body.classList.remove('grove-resizing');
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerUp);
    };
    document.body.classList.add('grove-resizing');
    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerup', handlePointerUp);
  }, [convSidebarWidth, sidebarWidth, sidebarVisible]);
  const [focusMode, setFocusMode] = useState<boolean>(() => {
    if (initialCachedOptions && typeof initialCachedOptions.focusMode === 'boolean') {
      return initialCachedOptions.focusMode;
    }
    return true; // Default to true for better performance
  });
  const [focusModeWarn, setFocusModeWarn] = useState<string | null>(null);
  const lazyRootDirEntriesRef = useRef<DirEntry[]>([]);
  const [focusFiles, setFocusFiles] = useState<DiffFile[]>([]);
  const [fileDiffCache, setFileDiffCache] = useState<Map<string, DiffFile | 'unsupported' | 'error'>>(() => new Map());
  const fileDiffCacheRef = useRef(fileDiffCache);
  useEffect(() => {
    fileDiffCacheRef.current = fileDiffCache;
  }, [fileDiffCache]);
  const loadingDiffsRef = useRef<Set<string>>(new Set());
  // Bumped every time fileDiffCache is wiped (refresh / mode switch / initial load).
  // The auto-load effect below keys off this so it re-fires even when
  // activeFilePath resolves to the same string as before the cache was cleared.
  const [diffCacheGen, setDiffCacheGen] = useState(0);
  const clearFileDiffCache = useCallback(() => {
    setFileDiffCache(new Map());
    setDiffCacheGen((g) => g + 1);
  }, []);
  const failedFullFilesRef = useRef<Set<string>>(new Set());
  const [displayMode, setDisplayMode] = useState<'code' | 'split' | 'preview'>(() => {
    if (initialCachedOptions && (initialCachedOptions.displayMode === 'code' || initialCachedOptions.displayMode === 'split' || initialCachedOptions.displayMode === 'preview')) {
      return initialCachedOptions.displayMode;
    }
    return 'code';
  });
  const [fromVersion, setFromVersion] = useState<string>(() => {
    if (initialCachedOptions && typeof initialCachedOptions.fromVersion === 'string') {
      return initialCachedOptions.fromVersion;
    }
    return 'target';
  });
  const [toVersion, setToVersion] = useState<string>(() => {
    if (initialCachedOptions && typeof initialCachedOptions.toVersion === 'string') {
      return initialCachedOptions.toVersion;
    }
    return 'latest';
  });

  const [fontSize, setFontSize] = useState<number>(() => {
    const saved = localStorage.getItem("grove:review.fontSize");
    return saved ? parseInt(saved, 10) : 12;
  });

  const handleZoomIn = useCallback(() => {
    setFontSize((prev) => {
      const next = Math.min(prev + 1, 30);
      localStorage.setItem("grove:review.fontSize", String(next));
      return next;
    });
  }, []);

  const handleZoomOut = useCallback(() => {
    setFontSize((prev) => {
      const next = Math.max(prev - 1, 9);
      localStorage.setItem("grove:review.fontSize", String(next));
      return next;
    });
  }, []);

  const handleZoomReset = useCallback(() => {
    setFontSize(12);
    localStorage.setItem("grove:review.fontSize", "12");
  }, []);

  const [collapsedCommentIds, setCollapsedCommentIds] = useState<Set<number>>(new Set());
  const [versions, setVersions] = useState<VersionOption[]>([]);
  const currentDiffRefs = useMemo(() => {
    const fromOpt = versions.find((v) => v.id === fromVersion);
    const toOpt = versions.find((v) => v.id === toVersion);
    return { fromRef: fromOpt?.ref, toRef: toOpt?.ref };
  }, [versions, fromVersion, toVersion]);
  const currentDiffRefsRef = useRef(currentDiffRefs);
  useEffect(() => {
    currentDiffRefsRef.current = currentDiffRefs;
  }, [currentDiffRefs]);
  // Mirror version selection into refs so the mode-switch effect can read the
  // latest values without depending on them (depending on them would re-fire
  // the entire effect — spinner flash, scroll reset, double-fetch — on every
  // dropdown click).
  const fromVersionRef = useRef(fromVersion);
  const toVersionRef = useRef(toVersion);
  useEffect(() => { fromVersionRef.current = fromVersion; }, [fromVersion]);
  useEffect(() => { toVersionRef.current = toVersion; }, [toVersion]);
  const initialCollapseRef = useRef(false);

  // Auto-persist header options when they change. Dedupe: only write when the
  // serialized payload actually differs from the last write — the effect fires
  // on every render where deps change, but other reducers may flip a dep back
  // to its prior value (initial-load reconcile, mode switch, etc.) yielding a
  // byte-identical payload that doesn't need a synchronous localStorage write.
  //
  // Initialize from the cached options snapshot the useState initializers also
  // pulled from — so the first effect run with state-equal-to-cache doesn't
  // produce a redundant rewrite of the same payload on every mount.
  const lastPersistedRef = useRef<string>(
    initialCachedOptions ? JSON.stringify(initialCachedOptions) : "",
  );
  useEffect(() => {
    const serialized = JSON.stringify({
      fromVersion,
      toVersion,
      displayMode,
      viewType: viewTypeState,
      focusMode,
    });
    if (serialized === lastPersistedRef.current) return;
    try {
      localStorage.setItem(headerOptionsStorageKey, serialized);
      lastPersistedRef.current = serialized;
    } catch (e) {
      console.error("Failed to save review options", e);
    }
  }, [headerOptionsStorageKey, fromVersion, toVersion, displayMode, viewTypeState, focusMode]);

  // Code search state (Ctrl+F)
  const [codeSearchVisible, setCodeSearchVisible] = useState(false);
  const [codeSearchFocusTrigger, setCodeSearchFocusTrigger] = useState(0);
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
    // Mode switch is staged here because navigateToFile is an external prop
    // bumped via seq; we have no event handler to respond to.
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
      // Comment-based virtual files: files that have a review comment but
      // don't appear in any of the in-repo file lists. Only surfaced in
      // "All Files" mode so they don't pollute the Changes (vN..latest) range.
      const realPaths = new Set(allFiles);
      const commentVirtualFiles: DiffFile[] = [];
      const seenVirtual = new Set<string>();
      for (const c of comments) {
        if (!c.file_path || realPaths.has(c.file_path) || seenVirtual.has(c.file_path)) continue;
        seenVirtual.add(c.file_path);
        commentVirtualFiles.push({
          old_path: '',
          new_path: c.file_path,
          change_type: 'added' as const,
          hunks: [],
          is_binary: false,
          additions: 0,
          deletions: 0,
          is_virtual: true,
        });
      }
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
      const virtualFiles = [...commentVirtualFiles, ...temporaryVirtualFiles];
      return sortTreeOrder([...allFileDiffFiles, ...virtualFiles]);
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
  }, [viewMode, allFiles, diffData, temporaryVirtualPaths, comments, sortTreeOrder]);

  const baseFiles = (viewMode === 'full' && focusMode) ? (sidebarSearch ? sortedDiffFiles : focusFiles) : sortedDiffFiles;


  const displayFiles = useMemo(() => {
    if (viewMode !== 'diff' || baseFiles.length === 0) return baseFiles;
    return baseFiles.map(f => {
      const cached = fileDiffCache.get(f.new_path);
      if (!cached) return f;
      if (cached === 'unsupported') return { ...f, hunks: [], additions: 0, deletions: 0, is_unsupported: true };
      if (cached === 'error') return { ...f, hunks: [], additions: 0, deletions: 0, load_error: true };
      return { ...f, hunks: cached.hunks, additions: cached.additions, deletions: cached.deletions, change_type: cached.change_type, is_binary: cached.is_binary };
    });
  }, [viewMode, baseFiles, fileDiffCache]);

  // Use ref to access displayFiles in callbacks without dependency issues
  const displayFilesRef = useRef(displayFiles);

  useEffect(() => {
    displayFilesRef.current = displayFiles;
  }, [displayFiles]);

  // Auto-detect iframe mode
  const isEmbedded = embedded ?? (typeof window !== 'undefined' && window !== window.parent);

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
            .then((result) => appendLazyFiles(result.entries))
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
      // Resolves a pending external nav once the lazy-loaded file appears in
      // displayFiles — this is the only place the resolution can be observed.
      setSelectedFile(resolvedPath);
      // currentFileIndex is derived from activeFilePath — auto-updates
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
  }, [displayFiles, navigateToFile, viewMode, focusMode, projectId, taskId, appendLazyFiles]);

  // Load full file content with concurrency control
  const loadFullFileContent = useCallback(async (filePath: string, forceReload = false) => {
    if ((!forceReload && fullFileContents.has(filePath)) || loadingFiles.has(filePath) || failedFullFilesRef.current.has(filePath)) return;

    if (forceReload) {
      failedFullFilesRef.current.delete(filePath);
    }

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
        }
        setLoadingFiles(prev => {
          const next = new Set(prev);
          next.delete(path);
          return next;
        });
        activeRequests.current.delete(path);
        processQueue(); // Continue processing
      }
    };

    processQueue();
  }, [projectId, taskId, fullFileContents, loadingFiles]);

  // true after initial load completes — prevents double-fetch on mount
  const modeSwitchReadyRef = useRef(false);
  // Monotonic counter — increment before each fetch; stale responses are discarded
  const fetchGenRef = useRef(0);
  // Refs so initial load closure can read the latest mode without re-running
  const viewModeRef = useRef(viewMode);
  const focusModeRef = useRef(focusMode);
  useEffect(() => {
    viewModeRef.current = viewMode;
  }, [viewMode]);
  useEffect(() => {
    focusModeRef.current = focusMode;
  }, [focusMode]);

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

  const loadFileDiff = useCallback(async (filePath: string, fromRef?: string, toRef?: string, forceReload = false) => {
    if ((!forceReload && fileDiffCacheRef.current.has(filePath)) || loadingDiffsRef.current.has(filePath)) return;
    loadingDiffsRef.current = new Set(loadingDiffsRef.current).add(filePath);
    let caught: unknown = null;
    try {
      const result = await getSingleFileDiff(projectId, taskId, filePath, fromRef, toRef);
      setFileDiffCache(prev => new Map(prev).set(filePath, result));
    } catch (e: unknown) {
      caught = e;
    }
    if (caught !== null) {
      const status = (caught as { status?: number })?.status;
      const marker: 'unsupported' | 'error' =
        status === 400 || status === 415 || status === 422 ? 'unsupported' : 'error';
      setFileDiffCache(prev => new Map(prev).set(filePath, marker));
    }
    {
      const next = new Set(loadingDiffsRef.current);
      next.delete(filePath);
      loadingDiffsRef.current = next;
    }
  }, [projectId, taskId]);



  const handleExpandDir = useCallback(async (dirPath: string): Promise<DirEntry[]> => {
    const result = await getTaskDirEntries(projectId, taskId, dirPath);
    appendLazyFiles(result.entries);
    return result.entries;
  }, [projectId, taskId, appendLazyFiles]);

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

    // In Changes mode, compute hash based on stable diff properties (path, status, additions, deletions)
    if (!diffData) return hashes;
    for (const f of diffData.files) {
      let hash = 5381;
      const hashStr = `${f.path}:${f.status}:${f.additions}:${f.deletions}`;
      for (let i = 0; i < hashStr.length; i++) {
        hash = ((hash << 5) + hash) + hashStr.charCodeAt(i);
        hash = hash & hash;
      }
      hashes.set(f.path, hash.toString(36));
    }
    return hashes;
  }, [diffData, viewMode, displayFiles]);

  const matchesRules = useCallback((path: string) => {
    let matched = false;
    for (const rule of autoViewedRules) {
      const isNegated = rule.startsWith('!');
      const pattern = isNegated ? rule.slice(1) : rule;
      // Convert glob to regex
      const regexStr = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '___DOUBLE_STAR___')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')
        .replace(/___DOUBLE_STAR___/g, '.*');
      const regex = new RegExp(`^${regexStr}$`);
      if (regex.test(path)) {
        matched = !isNegated;
      }
    }
    return matched;
  }, [autoViewedRules]);

  // Compute viewed status per file: 'none' | 'viewed' | 'updated'
  const getFileViewedStatus = useCallback((path: string): 'none' | 'viewed' | 'updated' => {
    const savedHash = viewedFiles.get(path);
    if (savedHash === 'UNVIEWED') {
      return 'none';
    }
    if (matchesRules(path)) {
      return 'viewed';
    }
    if (!savedHash) return 'none';
    const currentHash = fileHashes.get(path);
    if (currentHash && savedHash !== currentHash) return 'updated';
    return 'viewed';
  }, [viewedFiles, fileHashes, matchesRules]);

  // "Hide viewed files" toggle — lifted here (from FileTreeSidebar) so the
  // jump-to-first-unviewed fallback below re-runs reactively when it changes.
  const [hideViewed, setHideViewed] = useState<boolean>(
    () => localStorage.getItem('grove:review.hideViewed') === 'true'
  );
  const handleToggleHideViewed = useCallback(() => {
    setHideViewed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('grove:review.hideViewed', String(next));
      } catch { /* ignore localStorage issues */ }
      return next;
    });
  }, []);

  const activeFilePath = useMemo(() => {
    const found = displayFiles.find((f) => f.new_path === selectedFile && !f.new_path.endsWith('/'));
    if (found) return found.new_path;

    // Fallback: when "hide viewed" is enabled, jump to the first file that is
    // not a directory placeholder and not yet viewed.
    if (hideViewed) {
      const firstNotViewed = displayFiles.find(
        (f) => !f.new_path.endsWith('/') && getFileViewedStatus(f.new_path) !== 'viewed'
      );
      if (firstNotViewed) return firstNotViewed.new_path;
    }

    return displayFiles.find((f) => !f.new_path.endsWith('/'))?.new_path || null;
  }, [displayFiles, selectedFile, getFileViewedStatus, hideViewed]);

  // currentFileIndex derived from activeFilePath — stays in sync without setState in effect
  const currentFileIndex = useMemo(() => {
    if (!activeFilePath) return 0;
    const idx = displayFiles.findIndex((f) => f.new_path === activeFilePath);
    return idx >= 0 ? idx : 0;
  }, [displayFiles, activeFilePath]);

  // Trigger diff load whenever the active file changes in CHANGES mode.
  // Uses activeFilePath (derived) so the first file's diff loads even when selectedFile is null.
  // Note: loadFileDiff dedupes via fileDiffCacheRef + loadingDiffsRef, so it is safe to fire
  // even while a pending navigation is being resolved — without this, when the resolved
  // navigation target equals the fallback activeFilePath, neither this effect (deps unchanged)
  // nor the navigation effect (which doesn't load) ever triggers the fetch.
  // loadFileDiff sets fetch state internally; this is a legitimate fetch-on-prop-change
  // sync, not the cascading-render pattern the rule targets.
  // Also depends on diffCacheGen: a refresh/mode-switch clears fileDiffCache but often
  // resolves activeFilePath to the same string as before, so without this the effect's
  // deps would look unchanged and the now-uncached file would never be refetched —
  // leaving the diff view stuck on "Loading diff..." until the user manually clicks a file.
  useEffect(() => {
    if (!activeFilePath || viewMode !== 'diff') return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadFileDiff(activeFilePath, currentDiffRefs.fromRef, currentDiffRefs.toRef);
  }, [activeFilePath, viewMode, currentDiffRefs.fromRef, currentDiffRefs.toRef, loadFileDiff, diffCacheGen]);

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
  const refetchDiff = useCallback(async ({ fromRef, toRef, keepSelection = false, gen, silent = false }: RefetchDiffOptions = {}) => {
    // If no external gen provided, claim a new one so version-change calls also cancel stale fetches
    if (gen === undefined) {
      gen = ++fetchGenRef.current;
    }

    if (!silent) {
      setLoading(true);
      clearFileDiffCache();
      loadingDiffsRef.current = new Set();
    }

    let data: Awaited<ReturnType<typeof getDiffStats>> | null = null;
    let caught: unknown = null;
    try {
      data = await getDiffStats(projectId, taskId, fromRef, toRef);
    } catch (e) {
      caught = e;
    }
    if (caught !== null) {
      if (fetchGenRef.current !== gen) return;
      const msg = caught instanceof Error ? caught.message : 'Failed to load diff';
      setError(msg);
      if (fetchGenRef.current === gen && !silent) setLoading(false);
      return;
    }
    if (fetchGenRef.current !== gen) return; // stale — a newer fetch is running
    if (data) {
      setDiffData(data);
      if (!keepSelection) {
        setSelectedFile(null);
      } else {
        const selected = selectedFileRef.current;
        const stillPresent = selected ? data.files.some((f) => f.path === selected) : false;
        if (selected && stillPresent) {
          loadFileDiff(selected, fromRef, toRef, silent);
        }
      }
    }
    if (fetchGenRef.current === gen && !silent) setLoading(false);
  }, [projectId, taskId, loadFileDiff, clearFileDiffCache]);

  useEffect(() => {
    if (!modeSwitchReadyRef.current) return;

    const gen = ++fetchGenRef.current;
    // Reset focus list + show loading spinner before async fetch dispatches below.
    // Driven by viewMode/focusMode/projectId change — no equivalent event hook.
    setFocusFiles([]);
    setLoading(true);
    // Reset scroll position so the new mode starts at the top
    if (contentRef.current) contentRef.current.scrollTop = 0;
    if (viewMode === 'full' && focusMode) {
      getTaskDirEntries(projectId, taskId, '').then((result) => {
        if (fetchGenRef.current !== gen) return;
        lazyRootDirEntriesRef.current = result.entries;
        appendLazyFiles(result.entries);
      }).catch(console.error).finally(() => {
        if (fetchGenRef.current === gen) setLoading(false);
      });
      getTaskFiles(projectId, taskId).then((result) => {
        if (fetchGenRef.current !== gen) return;
        setAllFiles(result.files);
      }).catch(() => null);
    } else if (viewMode === 'full' && !focusMode) {
      getTaskFiles(projectId, taskId).then((result) => {
        if (fetchGenRef.current !== gen) return;
        setAllFiles(result.files);
      }).catch(() => null).finally(() => {
        if (fetchGenRef.current === gen) setLoading(false);
      });
    } else {
      // Changes mode: fetch commits first to ensure the version dropdown is up-to-date.
      // Parallel-fetch task files so allFiles is populated for file autocomplete (@) support!
      Promise.all([
        getCommits(projectId, taskId),
        getTaskFiles(projectId, taskId).catch(() => ({ files: [] as string[] }))
      ])
        .then(([commitsData, filesData]) => {
          if (fetchGenRef.current !== gen) return;

          if (filesData && filesData.files) {
            setAllFiles(filesData.files);
          }

          const opts = buildVersionOpts(commitsData);
          setVersions(opts);

          // Reconcile cached selection against the fresh opts (a commit could
          // have been rewritten by an amend/reset since we last looked).
          const { from, to, changed } = reconcileVersionSelection(
            opts,
            fromVersionRef.current,
            toVersionRef.current,
          );
          if (changed) {
            setFromVersion(from);
            setToVersion(to);
            fromVersionRef.current = from;
            toVersionRef.current = to;
          }

          // Resolve Refs using the freshly fetched Version list
          const fromOpt = opts.find((v) => v.id === from);
          const toOpt = opts.find((v) => v.id === to);
          refetchDiff({ fromRef: fromOpt?.ref, toRef: toOpt?.ref, gen });
        })
        .catch(() => {
          if (fetchGenRef.current !== gen) return;
          refetchDiff({ ...currentDiffRefsRef.current, gen });
        });
    }
  }, [viewMode, focusMode, projectId, taskId, appendLazyFiles, refetchDiff]);

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
  const doRefresh = useCallback(async (silent: boolean) => {
    // Claim a new fetch generation so the commits+versions write below doesn't
    // race against a concurrent refetch from another caller (manual click while
    // auto-refresh is in flight, etc.).
    const gen = ++fetchGenRef.current;
    if (!silent) {
      setRefreshing(true);
      requestQueue.current = [];
      activeRequests.current.clear();
      setLoadingFiles(new Set());
      setFullFileContents(new Map());
      clearFileDiffCache();
      loadingDiffsRef.current = new Set();
      lazyRootDirEntriesRef.current = [];
    }

    const selected = selectedFileRef.current;

    const commentsPromise = getReviewComments(projectId, taskId).then((result) => {
      if (fetchGenRef.current !== gen) return;
      setComments(result.comments);
      if (result.git_user_name) gitUserNameRef.current = result.git_user_name;
    }).catch(() => null);

    let caught: unknown = null;
    try {
      if (viewMode === 'diff') {
        const commitsData = await getCommits(projectId, taskId).catch(() => null);
        if (fetchGenRef.current !== gen) return;
        const opts = buildVersionOpts(commitsData);
        setVersions(opts);

        // Reconcile cached selection against the fresh opts so the selector
        // doesn't display a Version that no longer exists in the commit list.
        const { from, to, changed } = reconcileVersionSelection(
          opts,
          fromVersionRef.current,
          toVersionRef.current,
        );
        if (changed) {
          setFromVersion(from);
          setToVersion(to);
          fromVersionRef.current = from;
          toVersionRef.current = to;
        }

        const fromOpt = opts.find((v) => v.id === from);
        const toOpt = opts.find((v) => v.id === to);

        const filesPromise = getTaskFiles(projectId, taskId)
          .then((result) => {
            if (fetchGenRef.current !== gen) return;
            setAllFiles(result.files);
          })
          .catch(() => null);

        await Promise.all([
          refetchDiff({ fromRef: fromOpt?.ref, toRef: toOpt?.ref, keepSelection: true, silent, gen }),
          commentsPromise,
          filesPromise,
        ]);
      } else if (focusMode) {
        const fullContentPromise = selected ? loadFullFileContent(selected, true).catch(() => null) : Promise.resolve();
        await Promise.all([
          commentsPromise,
          fullContentPromise,
          getTaskDirEntries(projectId, taskId, '').then((result) => {
            if (fetchGenRef.current !== gen) return;
            lazyRootDirEntriesRef.current = result.entries;
            appendLazyFiles(result.entries);
          }).catch(() => null),
        ]);
      } else {
        const fullContentPromise = selected ? loadFullFileContent(selected, true).catch(() => null) : Promise.resolve();
        await Promise.all([
          commentsPromise,
          fullContentPromise,
          getTaskFiles(projectId, taskId).then((result) => {
            if (fetchGenRef.current !== gen) return;
            setAllFiles(result.files);
          }).catch(() => null),
        ]);
      }
    } catch (e) {
      caught = e;
    }
    if (!silent && fetchGenRef.current === gen) {
      setRefreshing(false);
    }
    if (caught !== null) {
      throw caught;
    }
  }, [refetchDiff, projectId, taskId, viewMode, focusMode, appendLazyFiles, loadFullFileContent, clearFileDiffCache]);

  // Two callers: the manual refresh button / hotkey-r path (loud, shows
  // spinner) and the agent-turn-finished auto-refresh path (silent). Splitting
  // them avoids the previous duck-typing of the click event vs an options object.
  const handleRefresh = useCallback(() => {
    void doRefresh(false).catch(() => {});
  }, [doRefresh]);
  const handleSilentRefresh = useCallback(() => {
    void doRefresh(true).catch(() => {});
  }, [doRefresh]);

  const previousChatBusyRef = useRef(!!isChatBusy);

  // Auto-refresh silently when Agent finishes a turn (isChatBusy transitions from true to false).
  // Only fires when a parent passes isChatBusy (TaskView embedding); the standalone
  // /review/... route doesn't supply it, so silent auto-refresh is off there.
  useEffect(() => {
    const wasBusy = previousChatBusyRef.current;
    const busy = !!isChatBusy;
    previousChatBusyRef.current = busy;

    if (wasBusy && !busy) {
      Promise.resolve().then(() => {
        handleSilentRefresh();
      });
    }
  }, [isChatBusy, handleSilentRefresh]);

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
      clearFileDiffCache();
      loadingDiffsRef.current = new Set();
      // Build per-mode promises BEFORE the try so the conditional
      // expressions don't sit inside a try/catch (React Compiler bails on
      // value blocks within try/catch).
      let commitsPromise: Promise<Awaited<ReturnType<typeof getCommits>> | null>;
      if (viewMode === 'diff') {
        commitsPromise = getCommits(projectId, taskId).catch(() => null);
      } else {
        commitsPromise = Promise.resolve(null);
      }

      let diffPromise: Promise<DiffStatsResult>;
      if (viewMode === 'diff') {
        const isDefaultVersion = fromVersion === 'target' && toVersion === 'latest';
        if (isDefaultVersion) {
          diffPromise = getDiffStats(projectId, taskId);
        } else {
          // Resolve custom version hashes from commits list
          diffPromise = commitsPromise.then(async (commitsData) => {
            let resolvedFromRef: string | undefined = undefined;
            let resolvedToRef: string | undefined = undefined;
            if (commitsData && commitsData.commits.length > 0) {
              const opts = buildVersionOpts(commitsData);

              const fromOpt = opts.find(v => v.id === fromVersion);
              const toOpt = opts.find(v => v.id === toVersion);

              let finalFrom = fromVersion;
              let finalTo = toVersion;

              if (!fromOpt) {
                finalFrom = 'target';
              } else {
                resolvedFromRef = fromOpt.ref;
              }

              if (!toOpt) {
                finalTo = 'latest';
              } else {
                resolvedToRef = toOpt.ref;
              }

              if (finalFrom !== fromVersion || finalTo !== toVersion) {
                setFromVersion(finalFrom);
                setToVersion(finalTo);
                // localStorage persistence is handled by the "Auto-persist
                // header options" effect — no need to mirror writes here.
              }
            }
            return getDiffStats(projectId, taskId, resolvedFromRef, resolvedToRef);
          }).catch(() => {
            return getDiffStats(projectId, taskId);
          });
        }
      } else {
        diffPromise = Promise.resolve({ files: [], total_additions: 0, total_deletions: 0 } as DiffStatsResult);
      }
      let filesPromise: Promise<Awaited<ReturnType<typeof getTaskFiles>> | null>;
      if (viewMode === 'full' && !focusMode) {
        filesPromise = getTaskFiles(projectId, taskId).catch(() => null);
      } else {
        filesPromise = Promise.resolve(null);
      }
      let dirEntriesPromise: Promise<Awaited<ReturnType<typeof getTaskDirEntries>> | null>;
      if (viewMode === 'full' && focusMode) {
        dirEntriesPromise = getTaskDirEntries(projectId, taskId, '').catch(() => null);
      } else {
        dirEntriesPromise = Promise.resolve(null);
      }
      const reviewPromise = getReviewComments(projectId, taskId).catch(() => null);

      type LoadResult = [
        DiffStatsResult,
        Awaited<typeof reviewPromise>,
        Awaited<typeof commitsPromise>,
        Awaited<typeof filesPromise>,
        Awaited<typeof dirEntriesPromise>,
      ];
      let loaded: LoadResult | null = null;
      let caught: unknown = null;
      try {
        loaded = await Promise.all([
          diffPromise,
          reviewPromise,
          commitsPromise,
          filesPromise,
          dirEntriesPromise,
        ]) as LoadResult;
      } catch (e) {
        caught = e;
      }
      if (caught !== null) {
        if (!cancelled) {
          const msg = caught instanceof Error ? caught.message : 'Failed to load diff';
          setError(msg);
        }
      } else if (loaded) {
        let reviewComments: ReviewCommentEntry[] = [];
        const [diffResult, reviewData, commitsData, filesData, dirEntriesData] = loaded;
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
          const opts = buildVersionOpts(commitsData);
          if (!cancelled) {
            setVersions(opts);
            const { from: finalFrom, to: finalTo, changed } = reconcileVersionSelection(
              opts,
              fromVersion,
              toVersion,
            );
            if (changed) {
              setFromVersion(finalFrom);
              setToVersion(finalTo);
              fromVersionRef.current = finalFrom;
              toVersionRef.current = finalTo;
              // localStorage persistence is handled by the "Auto-persist header
              // options" effect (line ~226) — no need to mirror writes here.
            }
          }
        }

        if (!cancelled) {
          // Store pure diff data. Virtual files (files with comments that aren't
          // in the diff range) are computed in sortedDiffFiles for "All Files"
          // mode only — adding them to diffData would leak them into "Changes"
          // mode and inflate the file count for the selected vN..latest range.
          setDiffData(data);
          if (filesData) {
            setAllFiles(filesData.files);
          }
          if (dirEntriesData) {
            lazyRootDirEntriesRef.current = dirEntriesData.entries;
            appendLazyFiles(dirEntriesData.entries);
          }
          setComments(reviewComments);
          // Auto-collapse resolved comments on first load
          if (!initialCollapseRef.current && reviewComments.length > 0) {
            initialCollapseRef.current = true;
            const ids = new Set(
              reviewComments.filter((c) => c.status === 'resolved').map((c) => c.id)
            );
            if (ids.size > 0) setCollapsedCommentIds(ids);
          }
        }
      }
      {
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
                    appendLazyFiles(result.entries);
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
            setFileDiffCache(prev => new Map(prev).set(f.path, result));
          })
          .catch((e: unknown) => {
            const status = (e as { status?: number })?.status;
            const marker = status === 400 || status === 415 || status === 422 ? 'unsupported' : 'error';
            setFileDiffCache(prev => new Map(prev).set(f.path, marker));
          })
          .finally(() => {
            const next = new Set(loadingDiffsRef.current);
            next.delete(f.path);
            loadingDiffsRef.current = next;
          });
      })).then(() => {
        loadBatch();
      });
    };
    loadBatch();
  }, [viewMode, focusMode, diffData, projectId, taskId, versions, fromVersion, toVersion]);


  // ── Keyboard scopes & commands ─────────────────────────────────────────
  // diffReview        — page-level scope, always active while mounted
  // diffReview.search — pushed when code search is visible; its Escape
  //                     command sits on top of stack and closes search
  //                     before the page-level commands run.
  useKeyboardScope('diffReview');
  useKeyboardScope('diffReview.search', codeSearchVisible);
  useContextKey('fileOpen', !!activeFilePath);

  const lightboxNotOpen = useCallback(() => !document.querySelector('[data-lightbox-active]'), []);

  useCommand('diffReview.openSearch', () => {
    setCodeSearchVisible(true);
    setCodeSearchFocusTrigger((n) => n + 1);
  }, []);

  useCommand(
    'diffReview.closeSearch',
    () => {
      setCodeSearchVisible(false);
      setCodeSearchQuery('');
    },
    { enabled: lightboxNotOpen },
    [lightboxNotOpen],
  );

  // Update match count and handle navigation. setState happens inside the timer
  // (asynchronous), so it does not cascade-render synchronously inside the effect.
  useEffect(() => {
    if (!codeSearchQuery) return;

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

  // Reset current index when the query or case-sensitive flag changes
  // (handled in the change callbacks below to avoid setState in effects).
  const handleSearchQueryChange = useCallback((q: string) => {
    setCodeSearchQuery(q);
    setCodeSearchCurrentIndex(0);
  }, []);
  const handleSearchCaseSensitiveToggle = useCallback(() => {
    setCodeSearchCaseSensitive((v) => !v);
    setCodeSearchCurrentIndex(0);
  }, []);

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
  }, [isMobile, loadFileDiff, versions, fromVersion, toVersion, focusMode, viewMode, setSidebarVisible]);

  const handleTogglePreview = useCallback((path: string) => {
    setPreviewOverrides((prev) => {
      const next = new Map(prev);
      const renderer = getPreviewRenderer(path, viewMode);
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
  }, [displayMode, viewMode]);

  const handleToggleActivePreview = useCallback(() => {
    if (!activeFilePath || !getPreviewRenderer(activeFilePath, viewMode)) return;
    handleTogglePreview(activeFilePath);
  }, [activeFilePath, handleTogglePreview, viewMode]);

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
  const currentFileIndexRef = useRef(currentFileIndex);
  useEffect(() => {
    currentFileIndexRef.current = currentFileIndex;
  }, [currentFileIndex]);

  const goToNextFile = useCallback(() => {
    const files = displayFilesRef.current;
    if (files.length === 0) return;
    const prevIndex = currentFileIndexRef.current;
    const next = Math.min(prevIndex + 1, files.length - 1);
    setSelectedFile(files[next].new_path);
    const el = document.getElementById(`diff-file-${encodeURIComponent(files[next].new_path)}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const goToPrevFile = useCallback(() => {
    const files = displayFilesRef.current;
    if (files.length === 0) return;
    const prevIndex = currentFileIndexRef.current;
    const prev = Math.max(prevIndex - 1, 0);
    setSelectedFile(files[prev].new_path);
    const el = document.getElementById(`diff-file-${encodeURIComponent(files[prev].new_path)}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  // Toggle viewed — stores current file hash and auto-collapses when marked as viewed
  const handleToggleViewed = useCallback((path: string) => {
    setViewedFiles((prev) => {
      const next = new Map(prev);
      const savedHash = prev.get(path);
      const matchesRule = matchesRules(path);

      if (matchesRule) {
        if (savedHash === 'UNVIEWED') {
          next.delete(path);
        } else {
          next.set(path, 'UNVIEWED');
        }
      } else {
        const currentHash = fileHashes.get(path) || '';
        // If already viewed and the hash matches, toggle it off (unviewed)
        if (savedHash && savedHash === currentHash) {
          next.delete(path);
          // When unmarking as viewed, keep current collapsed state
        } else {
          // If unviewed (no savedHash) OR updated (savedHash !== currentHash),
          // mark it as viewed (store the new current hash) and clear the Updated status
          next.set(path, currentHash);
          // Auto-collapse when marking as viewed
          setCollapsedFiles((prevCollapsed) => new Set(prevCollapsed).add(path));
        }
      }
      // Persist to localStorage
      try {
        localStorage.setItem(viewedStorageKey, JSON.stringify(Array.from(next.entries())));
      } catch { /* ignore quota errors */ }
      return next;
    });
  }, [fileHashes, viewedStorageKey, matchesRules]);

  // Toggle viewed status of the active file
  const handleToggleActiveViewed = useCallback(() => {
    if (activeFilePath) handleToggleViewed(activeFilePath);
  }, [activeFilePath, handleToggleViewed]);

  // Mark active file as viewed (one-way; never unmarks). Used by the
  // diffReview.markViewed command for an unambiguous "I'm done with this file"
  // intent — toggleViewed already covers the bi-directional case.
  const handleMarkActiveViewed = useCallback(() => {
    if (!activeFilePath) return;
    setViewedFiles((prev) => {
      const matchesRule = matchesRules(activeFilePath);
      if (matchesRule) {
        if (prev.get(activeFilePath) !== 'UNVIEWED') return prev;
        const next = new Map(prev);
        next.delete(activeFilePath);
        try {
          localStorage.setItem(viewedStorageKey, JSON.stringify(Array.from(next.entries())));
        } catch { /* ignore quota errors */ }
        return next;
      } else {
        const hash = fileHashes.get(activeFilePath) || '';
        // No-op if already viewed with the same hash — avoids a needless re-render
        // + localStorage write whenever the user re-fires the command.
        if (prev.get(activeFilePath) === hash) return prev;
        const next = new Map(prev);
        next.set(activeFilePath, hash);
        try {
          localStorage.setItem(viewedStorageKey, JSON.stringify(Array.from(next.entries())));
        } catch { /* ignore quota errors */ }
        return next;
      }
    });
    setCollapsedFiles((prev) => {
      if (prev.has(activeFilePath)) return prev;
      return new Set(prev).add(activeFilePath);
    });
  }, [activeFilePath, fileHashes, viewedStorageKey, matchesRules]);

  // Toggle Changes / All Files mode
  const handleToggleViewMode = useCallback(() => {
    const nextMode = viewMode === 'diff' ? 'full' : 'diff';
    void handleSetViewMode(nextMode);
  }, [viewMode, handleSetViewMode]);

  // Review panel keyboard shortcuts — all scoped to the diff review page.
  useCommand('diffReview.nextFile', goToNextFile, { enabled: () => displayFiles.length > 0 }, [goToNextFile, displayFiles.length]);
  useCommand('diffReview.prevFile', goToPrevFile, { enabled: () => displayFiles.length > 0 }, [goToPrevFile, displayFiles.length]);
  useCommand('diffReview.toggleViewed', handleToggleActiveViewed, { enabled: () => !!activeFilePath }, [handleToggleActiveViewed, activeFilePath]);
  useCommand('diffReview.refresh', handleRefresh, [handleRefresh]);
  useCommand('diffReview.toggleViewMode', handleToggleViewMode, [handleToggleViewMode]);
  useCommand('diffReview.togglePreview', handleToggleActivePreview, { enabled: () => !!activeFilePath && !!getPreviewRenderer(activeFilePath ?? '', viewMode) }, [handleToggleActivePreview, activeFilePath, viewMode]);
  useCommand('diffReview.markViewed', handleMarkActiveViewed, { enabled: () => !!activeFilePath }, [handleMarkActiveViewed, activeFilePath]);
  useCommand('diffReview.toggleSidebar', () => setSidebarVisible((v) => !v), [setSidebarVisible]);

  useCommand('view.zoom.increase', handleZoomIn, [handleZoomIn]);
  useCommand('view.zoom.decrease', handleZoomOut, [handleZoomOut]);
  useCommand('view.zoom.reset', handleZoomReset, [handleZoomReset]);

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

  // Exclude directory placeholders (new_path ending in '/') from counts — in
  // full+focus mode they appear in displayFiles and a broad auto-view rule
  // (e.g. '**') would otherwise inflate both totals.
  const countableFiles = displayFiles.filter((f) => !f.new_path.endsWith('/'));
  const viewedCount = countableFiles.filter((f) => getFileViewedStatus(f.new_path) === 'viewed').length;
  const totalFiles = countableFiles.length;
  const isEmpty = displayFiles.length === 0;

  // Ensure selectedFile is valid - if not, use first file
  const validSelectedFile = activeFilePath;

  return (
    <div
      className={`diff-review-page ${isEmbedded ? 'embedded' : ''}`}
      style={{
        '--diff-font-size': `${fontSize}px`,
        '--diff-line-height': `${fontSize + 8}px`,
      } as React.CSSProperties}
    >
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
            <span className="toolbar-label">Focus</span>
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
            <span className="toolbar-label">
              {displayMode === 'code' ? 'Code' : displayMode === 'split' ? 'Split' : 'Preview'}
            </span>
          </button>
          {viewMode === 'diff' && (
            <div className="diff-view-toggle">
              <button
                className={viewType === 'unified' ? 'active' : ''}
                onClick={() => setViewType('unified')}
              >
                <span className="toolbar-label">Unified</span>
                <span className="toolbar-label-short">Uni</span>
              </button>
              {!isMobile && (
                <button
                  className={viewType === 'split' ? 'active' : ''}
                  onClick={() => setViewType('split')}
                >
                  <span className="toolbar-label">Split</span>
                  <span className="toolbar-label-short">Spl</span>
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
            {totalFiles}
            <span className="toolbar-label"> file{totalFiles !== 1 ? 's' : ''}</span>
          </span>
          {viewMode === 'diff' && (
            <span className="diff-stats flex items-center gap-1.5">
              <span className="stat-add">+{diffData?.total_additions ?? 0}</span>
              <span className="stat-del">-{diffData?.total_deletions ?? 0}</span>
            </span>
          )}
        </div>
        <div className="diff-toolbar-right">
          <ViewedProgress viewed={viewedCount} total={totalFiles} />
          <div className="flex items-center border border-[var(--color-border)] rounded-md bg-[var(--color-bg)] h-7 p-0.5 ml-1.5 mr-1">
            <button
              onClick={handleZoomOut}
              className="px-2 h-full flex items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] rounded-[4px] cursor-pointer transition-colors"
              title="Zoom out"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={handleZoomReset}
              className="px-2.5 h-full flex items-center justify-center text-xs font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] rounded-[4px] cursor-pointer select-none transition-colors"
              title="Reset zoom (12px)"
            >
              {fontSize}px
            </button>
            <button
              onClick={handleZoomIn}
              className="px-2 h-full flex items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] rounded-[4px] cursor-pointer transition-colors"
              title="Zoom in"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="flex items-center border border-[var(--color-border)] rounded-md bg-[var(--color-bg)] h-7 p-0.5 mr-1">
            <button
              onClick={goToPrevFile}
              className="w-7 h-full flex items-center justify-center rounded-[4px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed cursor-pointer transition-colors"
              title="Previous file"
              disabled={currentFileIndex === 0}
            >
              <ChevronUp className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={goToNextFile}
              className="w-7 h-full flex items-center justify-center rounded-[4px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed cursor-pointer transition-colors"
              title="Next file"
              disabled={currentFileIndex === totalFiles - 1}
            >
              <ChevronDown className="w-3.5 h-3.5" />
            </button>
          </div>
          <button
            className={`diff-toolbar-btn ${convSidebarVisible ? 'active' : ''}`}
            onClick={() => setConvSidebarVisible((v) => !v)}
            title={convSidebarVisible ? 'Hide conversation' : 'Show conversation'}
          >
            <MessageSquare className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Layout */}
      <div
        className="diff-layout"
        style={{
          '--diff-sidebar-width': `${sidebarWidth}px`,
          '--diff-conv-sidebar-width': `${convSidebarWidth}px`,
        } as React.CSSProperties}
      >
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
              hideViewed={hideViewed}
              onToggleHideViewed={handleToggleHideViewed}
              onCreateVirtualPath={handleCreateVirtualPath}
              viewMode={viewMode}
              onExpandDir={viewMode === 'full' && focusMode ? handleExpandDir : undefined}
              onLoadFileDiff={viewMode === 'full' && focusMode ? loadFileDiff : undefined}
              taskPath={taskPath}
              projectId={projectId}
              onOpenInApp={(path) => { void openTaskFile(projectId, taskId, path); }}
              autoViewedRules={autoViewedRules}
              onUpdateAutoViewedRules={setAutoViewedRules}
            />

            {/* Resizer between file tree sidebar and diff content (desktop only) */}
            {!isMobile && sidebarVisible && (
              <div
                className="diff-resizer"
                onPointerDown={startSidebarResize}
                onDoubleClick={() => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize file tree sidebar"
                title="Drag to resize · Double-click to reset"
              />
            )}

            {/* Diff content */}
            <div className="diff-content" ref={contentRef} tabIndex={-1} style={{ outline: 'none' }}>
              {(() => {
                // Reset global match index before rendering
                resetGlobalMatchIndex();
                return (focusMode
                  ? displayFiles.filter((f) => f.new_path === validSelectedFile)
                  : displayFiles
                ).map((file) => {
                  const renderer = getPreviewRenderer(file.new_path, viewMode);
                  const defaultOpen = displayMode !== 'code' && !!renderer;
                  // Image files render the picture directly inside the code
                  // view (see DiffFileView), so the preview pane is redundant —
                  // force it closed and hide the toggle. Other renderers keep
                  // the override behavior.
                  const isImage = renderer?.id === 'image';
                  const isPreviewOpen = isImage
                    ? false
                    : previewOverrides.has(file.new_path)
                      ? previewOverrides.get(file.new_path)!
                      : defaultOpen;
                  return (
                    <DiffFileView
                      key={file.new_path}
                      file={file}
                      viewType={viewType}
                      isActive={validSelectedFile === file.new_path}
                      isPreviewOpen={isPreviewOpen}
                      onTogglePreview={renderer && !isImage ? handleTogglePreview : undefined}
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

            {/* Resizer between diff content and conversation sidebar (desktop only) */}
            {!isMobile && convSidebarVisible && (
              <div
                className="diff-resizer"
                onPointerDown={startConvSidebarResize}
                onDoubleClick={() => setConvSidebarWidth(DEFAULT_CONV_SIDEBAR_WIDTH)}
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize conversation sidebar"
                title="Drag to resize · Double-click to reset"
              />
            )}

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
        focusTrigger={codeSearchFocusTrigger}
        query={codeSearchQuery}
        caseSensitive={codeSearchCaseSensitive}
        currentIndex={codeSearchQuery ? codeSearchCurrentIndex : 0}
        totalMatches={codeSearchQuery ? codeSearchTotalMatches : 0}
        onQueryChange={handleSearchQueryChange}
        onCaseSensitiveToggle={handleSearchCaseSensitiveToggle}
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
