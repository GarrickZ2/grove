import { useRef, useEffect, Fragment, useState, useMemo, useCallback, useId } from 'react';
import type { DiffFile, DiffHunk } from '../../api/review';
import { getFileContent } from '../../api/review';
import type { ReviewCommentEntry } from '../../api/tasks';
import type { CommentAnchor } from './DiffReviewPage';
import { CommentCard, CommentForm, ReplyForm } from './InlineComment';
import { ChevronRight, ChevronDown, ChevronUp, Copy, Check, MessageSquare, MessageSquarePlus, ChevronsUpDown, Eye, Maximize2, Minimize2, Trash2, X } from 'lucide-react';
import { detectLanguage, highlightLines } from './syntaxHighlight';
import { GutterAvatar } from './AgentAvatar';
import { useFileMention } from '../../hooks';
import { FileMentionDropdown } from '../ui';
import { MarkdownRenderer, MermaidBlock } from '../ui/MarkdownRenderer';
import { ImagePreview, type PreviewRenderer, type PreviewCommentMarker } from './previewRenderers';
import { PreviewCommentHost } from './PreviewCommentHost';
import { PreviewSearchBar } from './PreviewSearchBar';
import { useDomSearch } from './useDomSearch';
import { ImageLightbox } from '../ui/ImageLightbox';
import { usePreviewComments, type PreviewCommentLocator } from '../../context';

// ============================================================================
// Types for context line expansion
// ============================================================================

interface HunkGap {
  gapIndex: number;
  startLine: number;
  endLine: number;
  oldStartLine: number;
  totalLines: number;
}

interface GapExpansion {
  fromTop: number;
  fromBottom: number;
  full: boolean;
}

interface ExpandProps {
  gapsByHunkIndex: Map<number, HunkGap>;
  expansions: Map<number, GapExpansion>;
  fileLines: string[] | null;
  language: string | undefined;
  onExpandUp: (gapIndex: number) => void;
  onExpandDown: (gapIndex: number) => void;
  onExpandAll: (gapIndex: number) => void;
}

// ============================================================================
// Helper: Highlight search matches in text and HTML
// ============================================================================

// Global counter for match indexing across all renders
// Module-level match counter — always reset via resetGlobalMatchIndex() before each render pass.
// Safe in practice: DiffReviewPage resets it in the same synchronous render lambda that maps
// all DiffFileView children, so each render pass resets-then-recounts correctly.
const _matchCounter = { current: 0 };

// eslint-disable-next-line react-refresh/only-export-components
export function resetGlobalMatchIndex() {
  _matchCounter.current = 0;
}

function highlightSearchMatches(
  text: string,
  searchQuery: string,
  caseSensitive: boolean,
): React.ReactNode {
  if (!searchQuery) return text;

  const flags = caseSensitive ? 'g' : 'gi';
  const regex = new RegExp(searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    // Add text before match
    if (match.index > lastIndex) {
      parts.push(text.substring(lastIndex, match.index));
    }

    const currentIndex = _matchCounter.current++;

    // Add highlighted match
    parts.push(
      <mark
        key={`${match.index}-${match[0]}`}
        className="code-search-match"
        data-match-index={currentIndex}
        style={{
          background: 'rgba(255, 215, 0, 0.4)',
          color: 'inherit',
          padding: 0,
          borderRadius: '2px',
        }}
      >
        {match[0]}
      </mark>
    );
    lastIndex = match.index + match[0].length;
  }

  // Add remaining text
  if (lastIndex < text.length) {
    parts.push(text.substring(lastIndex));
  }

  return parts.length > 0 ? parts : text;
}

// Helper to add search highlights to syntax-highlighted HTML
function highlightSearchInHTML(
  html: string,
  searchQuery: string,
  caseSensitive: boolean,
): string {
  if (!searchQuery) return html;

  // Create a temporary div to parse HTML
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = html;

  const flags = caseSensitive ? 'g' : 'gi';
  const regex = new RegExp(searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);

  // Function to process text nodes
  function processTextNode(node: Node) {
    if (node.nodeType === Node.TEXT_NODE && node.textContent) {
      const text = node.textContent;
      const matches = [...text.matchAll(regex)];

      if (matches.length > 0) {
        const fragment = document.createDocumentFragment();
        let lastIndex = 0;

        matches.forEach((match) => {
          // Add text before match
          if (match.index! > lastIndex) {
            fragment.appendChild(document.createTextNode(text.substring(lastIndex, match.index)));
          }

          // Add highlighted match
          const mark = document.createElement('mark');
          mark.className = 'code-search-match';
          mark.setAttribute('data-match-index', String(_matchCounter.current++));
          mark.style.background = 'rgba(255, 215, 0, 0.4)';
          mark.style.color = 'inherit';
          mark.style.padding = '0';
          mark.style.borderRadius = '2px';
          mark.textContent = match[0];
          fragment.appendChild(mark);

          lastIndex = match.index! + match[0].length;
        });

        // Add remaining text
        if (lastIndex < text.length) {
          fragment.appendChild(document.createTextNode(text.substring(lastIndex)));
        }

        node.parentNode?.replaceChild(fragment, node);
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      // Recursively process child nodes
      Array.from(node.childNodes).forEach(processTextNode);
    }
  }

  processTextNode(tempDiv);
  return tempDiv.innerHTML;
}

// ============================================================================
// DiffFileView
// ============================================================================

interface DiffFileViewProps {
  file: DiffFile;
  viewType: 'unified' | 'split';
  isActive: boolean;
  isPreviewOpen?: boolean;
  onTogglePreview?: (path: string) => void;
  onVisible?: () => void;
  comments?: ReviewCommentEntry[];
  commentFormAnchor?: CommentAnchor | null;
  onGutterClick?: (filePath: string, side: 'ADD' | 'DELETE', line: number, shiftKey: boolean) => void;
  onAddComment?: (anchor: CommentAnchor, content: string) => void;
  onDeleteComment?: (id: number) => void;
  onCancelComment?: () => void;
  isCollapsed?: boolean;
  onToggleCollapse?: (path: string) => void;
  viewedStatus?: 'none' | 'viewed' | 'updated';
  onToggleViewed?: (path: string) => void;
  commentCount?: { total: number; unresolved: number };
  replyFormCommentId?: number | null;
  onOpenReplyForm?: (commentId: number) => void;
  onReplyComment?: (commentId: number, status: string, message: string) => void;
  onCancelReply?: () => void;
  onResolveComment?: (id: number) => void;
  onReopenComment?: (id: number) => void;
  collapsedCommentIds?: Set<number>;
  onCollapseComment?: (id: number) => void;
  onExpandComment?: (id: number) => void;
  projectId?: string;
  taskId?: string;
  viewMode?: 'diff' | 'full';
  fullFileContent?: string;
  isLoadingFullFile?: boolean;
  onRequestFullFile?: (filePath: string) => void;
  onAddFileComment?: (filePath: string) => void;
  fileCommentFormPath?: string | null;
  onCancelFileComment?: () => void;
  onSubmitFileComment?: (filePath: string, content: string) => void;
  onEditComment?: (id: number, content: string) => void;
  onEditReply?: (commentId: number, replyId: number, content: string) => void;
  onDeleteReply?: (commentId: number, replyId: number) => void;
  codeSearchQuery?: string;
  codeSearchCaseSensitive?: boolean;
  scrollToLine?: { line: number; seq?: number }; // Line number to scroll to and expand if in collapsed gap
  mentionItems?: import('../../utils/fileMention').MentionItem[] | null;
  previewRenderer?: PreviewRenderer;
  defaultExpanded?: boolean;
}

export function DiffFileView({
  file,
  viewType,
  isActive,
  isPreviewOpen = false,
  onTogglePreview,
  onVisible,
  comments = [],
  commentFormAnchor,
  onGutterClick,
  onAddComment,
  onDeleteComment,
  onCancelComment,
  isCollapsed = false,
  onToggleCollapse,
  viewedStatus = 'none',
  onToggleViewed,
  commentCount,
  replyFormCommentId,
  onOpenReplyForm,
  onReplyComment,
  onCancelReply,
  onResolveComment,
  onReopenComment,
  collapsedCommentIds,
  onCollapseComment,
  onExpandComment,
  onAddFileComment,
  fileCommentFormPath,
  onCancelFileComment,
  onSubmitFileComment,
  onEditComment,
  onEditReply,
  onDeleteReply,
  projectId,
  taskId,
  viewMode = 'diff',
  fullFileContent,
  isLoadingFullFile,
  onRequestFullFile,
  codeSearchQuery = '',
  codeSearchCaseSensitive = false,
  scrollToLine,
  mentionItems,
  previewRenderer,
  defaultExpanded = false,
}: DiffFileViewProps) {
  const ref = useRef<HTMLDivElement>(null);
  const previewCommentId = useId().replace(/:/g, '');
  const { drafts: previewCommentDrafts, addDraft, updateDraft, removeDraft } = usePreviewComments();
  const [copied, setCopied] = useState(false);
  const [fileCommentText, setFileCommentText] = useState('');
  const fileCommentTextareaRef = useRef<HTMLTextAreaElement>(null);
  const fileCommentMention = useFileMention({ mentionItems: mentionItems ?? null, textareaRef: fileCommentTextareaRef });

  // Selection-based comment button
  const [selectionAnchor, setSelectionAnchor] = useState<{
    startLine: number;
    endLine: number;
    side: 'ADD' | 'DELETE';
    top: number;
    centerX: number;
  } | null>(null);

  // Split mode: constrain selection to one panel by disabling user-select on the other
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const splitTable = ref.current?.querySelector('.diff-split');
    if (!splitTable) return;

    // Clear previous containment
    splitTable.classList.remove('selecting-left', 'selecting-right');

    // Walk up from click target to find a data-side cell
    let el = e.target as HTMLElement | null;
    while (el && el !== ref.current) {
      if (el.hasAttribute('data-side')) {
        splitTable.classList.add(el.dataset.side === 'DELETE' ? 'selecting-left' : 'selecting-right');
        return;
      }
      el = el.parentElement;
    }
  }, []);

  const handleMouseUp = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !ref.current) {
      setSelectionAnchor(null);
      return;
    }

    const range = selection.getRangeAt(0);

    // Find nearest element (TR or TD) with data-line within this file section
    const findLineCell = (node: Node): HTMLElement | null => {
      let el = node instanceof HTMLElement ? node : node.parentElement;
      while (el && el !== ref.current) {
        if (el.hasAttribute('data-line')) {
          return el;
        }
        el = el.parentElement;
      }
      return null;
    };

    const startCell = findLineCell(range.startContainer);
    const endCell = findLineCell(range.endContainer);

    if (!startCell || !endCell) {
      setSelectionAnchor(null);
      return;
    }

    const startSide = (startCell.dataset.side || 'ADD') as 'ADD' | 'DELETE';
    const endSide = (endCell.dataset.side || 'ADD') as 'ADD' | 'DELETE';

    // In split mode, ignore selections that cross panels
    if (viewType === 'split' && startSide !== endSide) {
      setSelectionAnchor(null);
      return;
    }

    const startLine = parseInt(startCell.dataset.line || '0', 10);
    const endLine = parseInt(endCell.dataset.line || '0', 10);
    // In unified mode, prefer ADD side for cross-side selections
    const side = viewType === 'unified' && startSide !== endSide ? 'ADD' : startSide;

    if (startLine <= 0 || endLine <= 0 || startLine === endLine) {
      setSelectionAnchor(null);
      return;
    }

    // Position the button centered below the selection, relative to file section
    const sectionRect = ref.current.getBoundingClientRect();
    const startRect = startCell.getBoundingClientRect();
    const endRect = endCell.getBoundingClientRect();
    const selLeft = Math.min(startRect.left, endRect.left);
    const selRight = Math.max(startRect.right, endRect.right);
    const centerX = (selLeft + selRight) / 2 - sectionRect.left;

    setSelectionAnchor({
      startLine: Math.min(startLine, endLine),
      endLine: Math.max(startLine, endLine),
      side,
      top: endRect.bottom - sectionRect.top + 4,
      centerX,
    });
  }, [viewType]);

  // Clear selection anchor when selection changes elsewhere
  useEffect(() => {
    const handleSelectionChange = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        setSelectionAnchor(null);
      }
    };
    document.addEventListener('selectionchange', handleSelectionChange);
    return () => document.removeEventListener('selectionchange', handleSelectionChange);
  }, []);

  useEffect(() => {
    if (!ref.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          onVisible?.();
          // Trigger full file load when in full mode
          if (viewMode === 'full' && fullFileContent == null && !isLoadingFullFile && onRequestFullFile) {
            onRequestFullFile(file.new_path);
          }
        }
      },
      { threshold: 0.3 }
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [onVisible, viewMode, fullFileContent, isLoadingFullFile, onRequestFullFile, file.new_path]);

  // Load full file content when preview drawer is open in full mode
  useEffect(() => {
    if (!isPreviewOpen || viewMode !== 'full') return;
    if (file.is_binary) return;
    if (fullFileContent != null || isLoadingFullFile || !onRequestFullFile) return;
    onRequestFullFile(file.new_path);
  }, [isPreviewOpen, viewMode, file.is_binary, fullFileContent, isLoadingFullFile, onRequestFullFile, file.new_path]);

  const badgeClass = `diff-file-badge ${file.change_type}`;

  const language = useMemo(() => detectLanguage(file.new_path), [file.new_path]);

  const highlightedHunks = useMemo(() => {
    return file.hunks.map((hunk) => {
      const rawLines = hunk.lines.map((l) => l.content);
      return highlightLines(rawLines, language);
    });
  }, [file.hunks, language]);

  // Drawer expand state
  const [drawerExpanded, setDrawerExpanded] = useState(defaultExpanded);
  // Drawer width as fraction (0..1), null = default 50%
  const [drawerWidthFraction, setDrawerWidthFraction] = useState<number | null>(null);
  const [previewCommentMode, setPreviewCommentMode] = useState(false);
  const [pendingPreviewLocator, setPendingPreviewLocator] = useState<PreviewCommentLocator | null>(null);
  const [previewCommentText, setPreviewCommentText] = useState('');
  const [editingPreviewDraftId, setEditingPreviewDraftId] = useState<string | null>(null);
  const previewDrawerRef = useRef<HTMLDivElement>(null);
  const searchRootRef = useRef<HTMLDivElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const isIframePreview = previewRenderer?.id === 'html' || previewRenderer?.id === 'jsx';
  const dom = useDomSearch(searchRootRef, searchOpen && !isIframePreview ? searchQuery : '', searchOpen && !isIframePreview);
  const [iframeTotal, setIframeTotal] = useState(0);
  const [iframeCurrent, setIframeCurrent] = useState(0);
  const searchTotal = isIframePreview ? iframeTotal : dom.total;
  const searchCurrent = isIframePreview ? iframeCurrent : dom.current;
  const searchNext = () => {
    if (isIframePreview) setIframeCurrent((c) => (iframeTotal === 0 ? 0 : (c + 1) % iframeTotal));
    else dom.next();
  };
  const searchPrev = () => {
    if (isIframePreview) setIframeCurrent((c) => (iframeTotal === 0 ? 0 : (c - 1 + iframeTotal) % iframeTotal));
    else dom.prev();
  };

  // Reset iframe match cursor whenever the search query changes. Using the
  // "store previous value" idiom (https://react.dev/reference/react/useState
  // #storing-information-from-previous-renders) keeps the reset out of an
  // effect, avoiding a cascading render.
  const [prevSearchQueryForReset, setPrevSearchQueryForReset] = useState(searchQuery);
  if (isIframePreview && searchQuery !== prevSearchQueryForReset) {
    setPrevSearchQueryForReset(searchQuery);
    setIframeCurrent(0);
  }

  useEffect(() => {
    if (!isIframePreview || !searchOpen) return;
    const iframe = previewDrawerRef.current?.querySelector<HTMLIFrameElement>('iframe');
    iframe?.contentWindow?.postMessage(
      { type: 'grove-preview-search:query', previewId: previewCommentId, query: searchQuery },
      '*',
    );
  }, [searchQuery, searchOpen, isIframePreview, previewCommentId]);

  useEffect(() => {
    if (!isIframePreview || !searchOpen) return;
    const iframe = previewDrawerRef.current?.querySelector<HTMLIFrameElement>('iframe');
    iframe?.contentWindow?.postMessage(
      { type: 'grove-preview-search:goto', previewId: previewCommentId, index: iframeCurrent },
      '*',
    );
  }, [iframeCurrent, isIframePreview, searchOpen, previewCommentId]);

  useEffect(() => {
    if (!isIframePreview) return;
    const handler = (event: MessageEvent) => {
      const data = event.data as { type?: string; previewId?: string; total?: number };
      if (!data || data.previewId !== previewCommentId) return;
      if (data.type === 'grove-preview-search:result' && typeof data.total === 'number') {
        setIframeTotal(data.total);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [isIframePreview, previewCommentId]);

  // Effect updates the external iframe (legitimate "sync to external
  // system"). The state reset (setIframeTotal(0)) is handled below via the
  // store-previous-value idiom so it doesn't cascade-render from the effect.
  useEffect(() => {
    if (!searchOpen && isIframePreview) {
      const iframe = previewDrawerRef.current?.querySelector<HTMLIFrameElement>('iframe');
      iframe?.contentWindow?.postMessage(
        { type: 'grove-preview-search:clear', previewId: previewCommentId },
        '*',
      );
    }
  }, [searchOpen, isIframePreview, previewCommentId]);
  const [prevSearchOpenForTotal, setPrevSearchOpenForTotal] = useState(searchOpen);
  if (prevSearchOpenForTotal !== searchOpen) {
    setPrevSearchOpenForTotal(searchOpen);
    if (!searchOpen && isIframePreview) {
      setIframeTotal(0);
    }
  }

  // Cmd/Ctrl+F when focus is inside preview drawer
  useEffect(() => {
    if (!isPreviewOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'f' || !(e.metaKey || e.ctrlKey)) return;
      const root = previewDrawerRef.current;
      if (!root) return;
      const target = document.activeElement;
      if (!target || !root.contains(target)) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      setSearchOpen((v) => !v);
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [isPreviewOpen]);

  // Close search when drawer closes or file changes. Using the
  // store-previous-value idiom so the reset doesn't fire from inside an
  // effect (which would cascade-render).
  const [prevIsPreviewOpenForSearch, setPrevIsPreviewOpenForSearch] = useState(isPreviewOpen);
  if (prevIsPreviewOpenForSearch !== isPreviewOpen) {
    setPrevIsPreviewOpenForSearch(isPreviewOpen);
    if (!isPreviewOpen) {
      setSearchOpen(false);
      setSearchQuery('');
    }
  }
  const [prevFilePathForSearch, setPrevFilePathForSearch] = useState(file.new_path);
  if (prevFilePathForSearch !== file.new_path) {
    setPrevFilePathForSearch(file.new_path);
    setSearchOpen(false);
    setSearchQuery('');
  }
  const draggingRef = useRef(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Sync expanded state with defaultExpanded prop using the
  // store-previous-value idiom — keeps the reset out of an effect.
  const [prevDefaultExpanded, setPrevDefaultExpanded] = useState(defaultExpanded);
  if (prevDefaultExpanded !== defaultExpanded) {
    setPrevDefaultExpanded(defaultExpanded);
    setDrawerExpanded(defaultExpanded);
  }

  // Reset drawer state when preview closes — same idiom as above.
  const [prevIsPreviewOpenForDrawer, setPrevIsPreviewOpenForDrawer] = useState(isPreviewOpen);
  if (prevIsPreviewOpenForDrawer !== isPreviewOpen) {
    setPrevIsPreviewOpenForDrawer(isPreviewOpen);
    if (!isPreviewOpen) {
      setDrawerExpanded(false);
      setDrawerWidthFraction(null);
      setPreviewCommentMode(false);
      setPendingPreviewLocator(null);
      setEditingPreviewDraftId(null);
    }
  }

  // Stash drafts in a ref so the message listener doesn't re-attach every
  // time drafts change anywhere in the app.
  const draftsRef = useRef(previewCommentDrafts);
  useEffect(() => { draftsRef.current = previewCommentDrafts; }, [previewCommentDrafts]);

  useEffect(() => {
    if (!previewRenderer || previewRenderer.supportsComments === false) return;
    const handler = (event: MessageEvent) => {
      const data = event.data as { type?: string; previewId?: string; payload?: PreviewCommentLocator; markerId?: string; ids?: string[] };
      if (!data || data.previewId !== previewCommentId) return;
      if (data.type === 'grove-preview-comment:selected' && data.payload) {
        setPendingPreviewLocator(data.payload);
        setPreviewCommentText('');
        setEditingPreviewDraftId(null);
        setPreviewCommentMode(false);
      } else if (data.type === 'grove-preview-comment:cancel') {
        setPreviewCommentMode(false);
      } else if (data.type === 'grove-preview-comment:marker-click' && data.markerId) {
        const draft = draftsRef.current.find(
          (d) => d.id === data.markerId && d.projectId === projectId && d.taskId === taskId && d.filePath === file.new_path,
        );
        if (draft) {
          setPendingPreviewLocator(draft.locator);
          setPreviewCommentText(draft.comment);
          setEditingPreviewDraftId(draft.id);
          setPreviewCommentMode(false);
        }
      } else if (data.type === 'grove-preview-comment:markers-stale' && Array.isArray(data.ids)) {
        data.ids.forEach((id) => removeDraft(id));
        if (data.ids.length) {
          console.info(`[preview-comments] Removed ${data.ids.length} stale preview comment${data.ids.length > 1 ? 's' : ''} (target element no longer in DOM)`);
        }
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [previewRenderer, previewCommentId, projectId, taskId, file.new_path, removeDraft]);

  const previewCommentMarkersKey = useMemo(() => {
    if (!projectId || !taskId) return '[]';
    const path = file.new_path;
    const entries: PreviewCommentMarker[] = [];
    let n = 0;
    for (const d of previewCommentDrafts) {
      if (d.projectId !== projectId || d.taskId !== taskId || d.filePath !== path) continue;
      n++;
      entries.push({ id: d.id, label: String(n), selector: d.locator.selector, xpath: d.locator.xpath });
    }
    return JSON.stringify(entries);
  }, [previewCommentDrafts, projectId, taskId, file.new_path]);
  const previewCommentMarkers = useMemo<PreviewCommentMarker[]>(
    () => JSON.parse(previewCommentMarkersKey),
    [previewCommentMarkersKey],
  );

  const closePreviewCommentModal = useCallback(() => {
    setPendingPreviewLocator(null);
    setPreviewCommentText('');
    setEditingPreviewDraftId(null);
  }, []);

  useEffect(() => {
    if (!pendingPreviewLocator) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      closePreviewCommentModal();
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [pendingPreviewLocator, closePreviewCommentModal]);

  const submitReviewPreviewComment = useCallback(() => {
    if (!pendingPreviewLocator || !previewCommentText.trim() || !projectId || !taskId || !previewRenderer) return;
    if (editingPreviewDraftId) {
      updateDraft(editingPreviewDraftId, { comment: previewCommentText.trim() });
    } else {
      addDraft({
        source: 'review',
        projectId,
        taskId,
        filePath: file.new_path,
        fileName: file.new_path.split('/').pop() || file.new_path,
        rendererId: previewRenderer.id,
        locator: pendingPreviewLocator,
        comment: previewCommentText.trim(),
      });
    }
    closePreviewCommentModal();
  }, [addDraft, updateDraft, editingPreviewDraftId, closePreviewCommentModal, file.new_path, pendingPreviewLocator, previewCommentText, previewRenderer, projectId, taskId]);

  const deleteReviewPreviewComment = useCallback(() => {
    if (!editingPreviewDraftId) return;
    removeDraft(editingPreviewDraftId);
    closePreviewCommentModal();
  }, [editingPreviewDraftId, removeDraft, closePreviewCommentModal]);

  // Drag-to-resize handler
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    const container = bodyRef.current;
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    const containerWidth = containerRect.width;

    const onMouseMove = (ev: MouseEvent) => {
      if (!draggingRef.current) return;
      const dx = ev.clientX - containerRect.left;
      // drawer is on the right, so drawer width = container width - mouse x
      const fraction = Math.max(0.2, Math.min(0.8, (containerWidth - dx) / containerWidth));
      setDrawerWidthFraction(fraction);
      setDrawerExpanded(false);
    };

    const onMouseUp = () => {
      draggingRef.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);


  // Filter file-level comments for this file
  const fileComments = useMemo(() => {
    return comments.filter(
      (c) => c.comment_type === 'file' && c.file_path === file.new_path
    );
  }, [comments, file.new_path]);

  // Filter inline comments for line rendering
  const inlineComments = useMemo(() => {
    return comments.filter((c) => !c.comment_type || c.comment_type === 'inline');
  }, [comments]);

  const commentsByKey = useMemo(() => {
    // Calculate max line numbers for ADD and DELETE sides
    let maxAddLine = 0;
    let maxDeleteLine = 0;
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.new_line != null && line.new_line > maxAddLine) {
          maxAddLine = line.new_line;
        }
        if (line.old_line != null && line.old_line > maxDeleteLine) {
          maxDeleteLine = line.old_line;
        }
      }
    }

    const map = new Map<string, ReviewCommentEntry[]>();
    for (const c of inlineComments) {
      if (c.side && c.end_line !== undefined) {
        // Clamp line number to file length
        let lineNum = c.end_line;
        if (c.side === 'ADD' && maxAddLine > 0 && lineNum > maxAddLine) {
          lineNum = maxAddLine;
        } else if (c.side === 'DELETE' && maxDeleteLine > 0 && lineNum > maxDeleteLine) {
          lineNum = maxDeleteLine;
        }

        const key = `${c.side}:${lineNum}`;
        const existing = map.get(key) || [];
        existing.push(c);
        map.set(key, existing);
      }
    }
    return map;
  }, [inlineComments, file.hunks]);

  const highlightedLines = useMemo(() => {
    const set = new Set<string>();
    for (const c of inlineComments) {
      if (c.side && c.start_line !== undefined && c.end_line !== undefined) {
        for (let l = c.start_line; l <= c.end_line; l++) {
          set.add(`${c.side}:${l}`);
        }
      }
    }
    if (commentFormAnchor && commentFormAnchor.filePath === file.new_path) {
      for (let l = commentFormAnchor.startLine; l <= commentFormAnchor.endLine; l++) {
        set.add(`${commentFormAnchor.side}:${l}`);
      }
    }
    return set;
  }, [inlineComments, commentFormAnchor, file.new_path]);

  // ---- File content for context expansion (declared early so gaps can reference it) ----
  const [fileLines, setFileLines] = useState<string[] | null>(null);
  const fileLinesLoadingRef = useRef(false);

  // ---- Gap computation for context line expansion ----
  const gaps = useMemo(() => {
    const result: HunkGap[] = [];
    for (let i = 0; i < file.hunks.length; i++) {
      const hunk = file.hunks[i];
      if (i === 0 && hunk.new_start > 1) {
        result.push({
          gapIndex: 0,
          startLine: 1,
          endLine: hunk.new_start - 1,
          oldStartLine: 1,
          totalLines: hunk.new_start - 1,
        });
      }
      if (i > 0) {
        const prev = file.hunks[i - 1];
        const prevNewEnd = prev.new_start + prev.new_lines - 1;
        const prevOldEnd = prev.old_start + prev.old_lines - 1;
        const gapStart = prevNewEnd + 1;
        const gapEnd = hunk.new_start - 1;
        if (gapEnd >= gapStart) {
          result.push({
            gapIndex: i,
            startLine: gapStart,
            endLine: gapEnd,
            oldStartLine: prevOldEnd + 1,
            totalLines: gapEnd - gapStart + 1,
          });
        }
      }
    }
    // Trailing gap: lines after the last hunk
    if (file.hunks.length > 0 && fileLines) {
      const lastHunk = file.hunks[file.hunks.length - 1];
      const lastNewEnd = lastHunk.new_start + lastHunk.new_lines - 1;
      const lastOldEnd = lastHunk.old_start + lastHunk.old_lines - 1;
      if (lastNewEnd < fileLines.length) {
        result.push({
          gapIndex: file.hunks.length,
          startLine: lastNewEnd + 1,
          endLine: fileLines.length,
          oldStartLine: lastOldEnd + 1,
          totalLines: fileLines.length - lastNewEnd,
        });
      }
    }
    return result;
  }, [file.hunks, fileLines]);

  const gapsByHunkIndex = useMemo(() => {
    const map = new Map<number, HunkGap>();
    for (const gap of gaps) map.set(gap.gapIndex, gap);
    return map;
  }, [gaps]);

  const [expansions, setExpansions] = useState<Map<number, GapExpansion>>(new Map());
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [lightboxSvg, setLightboxSvg] = useState<string | null>(null);

  // Compute preview segments for diff mode drawer.
  // Code-fence-aware: code blocks render as single units with per-line coloring,
  // non-code content renders with MarkdownRenderer per block.
  const previewSegments = useMemo(() => {
    type LineKind = 'insert' | 'delete' | 'context';
    type PLine = { content: string; kind: LineKind };
    type MdSeg = { type: 'markdown'; id: string; kind: LineKind; content: string };
    type CodeSeg = { type: 'code'; id: string; language: string; lines: PLine[] };
    type Seg = MdSeg | CodeSeg;

    if (!isPreviewOpen || viewMode !== 'diff' || file.is_binary) return [] as Seg[];

    const allLines: PLine[] = [];

    // Helper: push expanded gap lines as context
    const pushGapLines = (gapIndex: number) => {
      const gap = gapsByHunkIndex.get(gapIndex);
      const exp = expansions.get(gapIndex);
      if (!gap || !exp || !fileLines) return;

      if (exp.full) {
        for (let ln = gap.startLine; ln <= gap.endLine; ln++) {
          allLines.push({ content: fileLines[ln - 1] ?? '', kind: 'context' });
        }
        return;
      }
      // Top portion
      for (let i = 0; i < exp.fromTop; i++) {
        const ln = gap.startLine + i;
        if (ln <= gap.endLine) {
          allLines.push({ content: fileLines[ln - 1] ?? '', kind: 'context' });
        }
      }
      // Bottom portion
      for (let i = 0; i < exp.fromBottom; i++) {
        const ln = gap.endLine - exp.fromBottom + 1 + i;
        if (ln >= gap.startLine) {
          allLines.push({ content: fileLines[ln - 1] ?? '', kind: 'context' });
        }
      }
    };

    // Gap before first hunk
    pushGapLines(0);

    // Walk hunks + gaps between them
    for (let hi = 0; hi < file.hunks.length; hi++) {
      const hunk = file.hunks[hi];
      for (const line of hunk.lines) {
        allLines.push({
          content: line.content,
          kind: line.line_type === 'insert' ? 'insert' : line.line_type === 'delete' ? 'delete' : 'context',
        });
      }
      // Gap after this hunk
      pushGapLines(hi + 1);
    }

    // Build segments with code-fence awareness
    const segments: Seg[] = [];
    let segId = 0;
    let inCodeFence = false;
    let codeFenceLang = '';
    let codeLines: PLine[] = [];
    let curKind: LineKind | null = null;
    let curLines: string[] = [];

    const flushMd = () => {
      if (!curKind || curLines.length === 0) return;
      const content = curLines.join('\n');
      if (content.trim()) {
        segments.push({ type: 'markdown', id: `seg-${segId}`, kind: curKind, content });
        segId += 1;
      }
      curKind = null;
      curLines = [];
    };

    const flushCode = () => {
      if (codeLines.length === 0) return;
      segments.push({ type: 'code', id: `seg-${segId}`, language: codeFenceLang, lines: [...codeLines] });
      segId += 1;
      codeLines = [];
      codeFenceLang = '';
    };

    for (const pl of allLines) {
      const trimmed = pl.content.trimStart();

      if (!inCodeFence && trimmed.startsWith('```')) {
        flushMd();
        inCodeFence = true;
        codeFenceLang = trimmed.slice(3).trim();
        continue;
      }

      if (inCodeFence && trimmed.startsWith('```')) {
        flushCode();
        inCodeFence = false;
        continue;
      }

      if (inCodeFence) {
        codeLines.push({ content: pl.content, kind: pl.kind });
      } else {
        if (pl.kind === curKind) {
          curLines.push(pl.content);
        } else {
          flushMd();
          curKind = pl.kind;
          curLines = [pl.content];
        }
      }
    }

    if (inCodeFence) flushCode();
    else flushMd();

    return segments;
  }, [isPreviewOpen, viewMode, file.is_binary, file.hunks, gapsByHunkIndex, expansions, fileLines]);

  const ensureFileLines = useCallback(() => {
    if (fileLines || fileLinesLoadingRef.current) return;
    fileLinesLoadingRef.current = true;
    if (projectId && taskId) {
      getFileContent(projectId, taskId, file.new_path)
        .then((content) => setFileLines(content.split('\n')))
        .catch(() => {
          const maxLine = gaps.length > 0 ? Math.max(...gaps.map((g) => g.endLine)) : 0;
          const lines: string[] = [];
          for (let i = 0; i < maxLine; i++) {
            lines.push(`    // ... (expanded context line ${i + 1})`);
          }
          setFileLines(lines);
        });
    }
  }, [fileLines, projectId, taskId, file.new_path, gaps]);

  // Pre-load fileLines when file is expanded so trailing gap can be computed immediately
  useEffect(() => {
    if (!isCollapsed && file.hunks.length > 0) {
      ensureFileLines();
    }
  }, [isCollapsed, file.hunks.length, ensureFileLines]);

  const handleExpandDown = useCallback((gapIndex: number) => {
    ensureFileLines();
    setExpansions((prev) => {
      const next = new Map(prev);
      const exp = next.get(gapIndex) || { fromTop: 0, fromBottom: 0, full: false };
      const gap = gaps.find((g) => g.gapIndex === gapIndex);
      if (!gap) {
        // Gap not computed yet (trailing gap before fileLines loaded) — queue 20 lines
        next.set(gapIndex, { ...exp, fromTop: exp.fromTop + 20 });
        return next;
      }
      const remaining = gap.totalLines - exp.fromTop - exp.fromBottom;
      const expandBy = Math.min(20, remaining);
      next.set(gapIndex, { ...exp, fromTop: exp.fromTop + expandBy });
      return next;
    });
  }, [ensureFileLines, gaps]);

  const handleExpandUp = useCallback((gapIndex: number) => {
    ensureFileLines();
    setExpansions((prev) => {
      const next = new Map(prev);
      const exp = next.get(gapIndex) || { fromTop: 0, fromBottom: 0, full: false };
      const gap = gaps.find((g) => g.gapIndex === gapIndex);
      if (!gap) {
        next.set(gapIndex, { ...exp, fromBottom: exp.fromBottom + 20 });
        return next;
      }
      const remaining = gap.totalLines - exp.fromTop - exp.fromBottom;
      const expandBy = Math.min(20, remaining);
      next.set(gapIndex, { ...exp, fromBottom: exp.fromBottom + expandBy });
      return next;
    });
  }, [ensureFileLines, gaps]);

  const handleExpandAll = useCallback((gapIndex: number) => {
    ensureFileLines();
    setExpansions((prev) => {
      const next = new Map(prev);
      next.set(gapIndex, { fromTop: 0, fromBottom: 0, full: true });
      return next;
    });
  }, [ensureFileLines]);

  const expandProps: ExpandProps = {
    gapsByHunkIndex,
    expansions,
    fileLines,
    language,
    onExpandUp: handleExpandUp,
    onExpandDown: handleExpandDown,
    onExpandAll: handleExpandAll,
  };

  // Auto-expand the gap containing scrollToLine. The state mutation
  // (setExpansions) is done via the store-previous-value idiom — at most
  // once per scrollToLine identity change, during render — so it doesn't
  // cascade-render from inside an effect. ensureFileLines() (which reads a
  // ref) is deferred to the effect below.
  const [prevScrollToLineForExpand, setPrevScrollToLineForExpand] = useState(scrollToLine);
  if (prevScrollToLineForExpand !== scrollToLine) {
    setPrevScrollToLineForExpand(scrollToLine);
    if (scrollToLine && isActive) {
      const gap = gaps.find(g => scrollToLine.line >= g.startLine && scrollToLine.line <= g.endLine);
      if (gap) {
        const expansion = expansions.get(gap.gapIndex);
        if (!expansion || !expansion.full) {
          setExpansions((prev) => {
            const next = new Map(prev);
            next.set(gap.gapIndex, { fromTop: 0, fromBottom: 0, full: true });
            return next;
          });
        }
      }
    }
  }

  // Scroll & highlight after the expanded rows render. Pure DOM side effect
  // — no setState here. Also kicks off ensureFileLines() if the gap needs it
  // (the actual expansion state was set in the prev-value block above).
  useEffect(() => {
    if (!scrollToLine || !isActive) return;
    const targetLine = scrollToLine.line;
    const gap = gaps.find(g => targetLine >= g.startLine && targetLine <= g.endLine);
    if (gap) ensureFileLines();
    requestAnimationFrame(() => {
      setTimeout(() => {
        if (!ref.current) return;
        const row = ref.current.querySelector(`tr[data-line="${targetLine}"]`) as HTMLElement;
        if (row) {
          row.scrollIntoView({ behavior: 'smooth', block: 'center' });
          // Flash highlight
          row.classList.add('diff-line-nav-highlight');
          setTimeout(() => row.classList.remove('diff-line-nav-highlight'), 2500);
        }
      }, 100);
    });
  }, [scrollToLine, isActive, gaps, ensureFileLines]);

  const handleCopyPath = () => {
    navigator.clipboard.writeText(file.new_path);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const commonCommentProps = {
    filePath: file.new_path,
    commentsByKey,
    highlightedLines,
    commentFormAnchor,
    onGutterClick,
    onAddComment,
    onDeleteComment,
    onCancelComment,
    replyFormCommentId,
    onOpenReplyForm,
    onReplyComment,
    onCancelReply,
    onResolveComment,
    onReopenComment,
    collapsedCommentIds,
    onCollapseComment,
    onExpandComment,
    onEditComment,
    onEditReply,
    onDeleteReply,
    mentionItems,
  };

  return (
    <div ref={ref} className="diff-file-section" id={`diff-file-${encodeURIComponent(file.new_path)}`} onMouseDown={handleMouseDown} onMouseUp={handleMouseUp}>
      <div className={`diff-file-header ${isActive ? 'ring-1 ring-[var(--color-highlight)]' : ''}`}>
        <div className="diff-file-header-top">
          {onToggleCollapse && (
            <button
              className="diff-file-collapse-btn"
              onClick={() => onToggleCollapse(file.new_path)}
              title={isCollapsed ? 'Expand file' : 'Collapse file'}
            >
              {isCollapsed ? (
                <ChevronRight style={{ width: 14, height: 14 }} />
              ) : (
                <ChevronDown style={{ width: 14, height: 14 }} />
              )}
            </button>
          )}
          <span className={badgeClass}>
            {file.change_type === 'added' ? 'A' : file.change_type === 'deleted' ? 'D' : file.change_type === 'renamed' ? 'R' : 'M'}
          </span>
          <span className="diff-file-path">{file.new_path}</span>
          {onTogglePreview && (
            <button
              className={`diff-file-preview-btn${isPreviewOpen ? ' active' : ''}`}
              onClick={() => onTogglePreview(file.new_path)}
              title={isPreviewOpen ? 'Close preview' : (previewRenderer?.label ?? 'Preview')}
            >
              <Eye style={{ width: 14, height: 14 }} />
            </button>
          )}
          <button className="diff-file-copy-btn" onClick={handleCopyPath} title="Copy file path">
            {copied ? (
              <Check style={{ width: 12, height: 12, color: 'var(--color-success)' }} />
            ) : (
              <Copy style={{ width: 12, height: 12 }} />
            )}
          </button>
          <span className="diff-file-header-right">
            {onAddFileComment && (
              <button
                className="diff-file-comment-btn"
                onClick={() => onAddFileComment(file.new_path)}
                title="Add comment on file"
              >
                <MessageSquare style={{ width: 14, height: 14 }} />
                <span>Comment on file</span>
              </button>
            )}
            {commentCount && commentCount.total > 0 && (
              <span className="diff-file-comment-count">
                <MessageSquare style={{ width: 12, height: 12 }} />
                {commentCount.unresolved > 0 ? (
                  <span className="diff-file-unresolved">{commentCount.unresolved} unresolved</span>
                ) : (
                  <span>{commentCount.total} resolved</span>
                )}
              </span>
            )}
            <span className="diff-sidebar-item-stats">
              {file.additions > 0 && <span className="stat-add">+{file.additions}</span>}
              {file.deletions > 0 && <span className="stat-del">-{file.deletions}</span>}
            </span>
            {onToggleViewed && (
              <label className="diff-file-viewed-label">
                <input
                  type="checkbox"
                  className="diff-file-viewed-checkbox"
                  checked={viewedStatus !== 'none'}
                  onChange={() => onToggleViewed(file.new_path)}
                />
                {viewedStatus === 'updated' ? (
                  <span className="diff-file-viewed-updated">Updated</span>
                ) : (
                  'Viewed'
                )}
              </label>
            )}
          </span>
        </div>

      </div>

      {isCollapsed ? null : (
        <>
          {/* File-level comments section */}
          {(fileComments.length > 0 || fileCommentFormPath === file.new_path || file.is_virtual) && (
            <div className="diff-file-comments">
              <div className="diff-file-comments-header">
                <MessageSquare style={{ width: 14, height: 14 }} />
                <span>Comments on file</span>
              </div>
              {fileComments.map((comment) => (
                <Fragment key={`file-comment-${comment.id}`}>
                  <CommentCard
                    comment={comment}
                    onDelete={onDeleteComment}
                    onReply={onOpenReplyForm}
                    onResolve={onResolveComment}
                    onReopen={onReopenComment}
                    onCollapse={onCollapseComment}
                    onExpand={onExpandComment}
                    isCollapsed={collapsedCommentIds?.has(comment.id)}
                    onEdit={onEditComment}
                    onEditReply={onEditReply}
                    onDeleteReply={onDeleteReply}
                    mentionItems={mentionItems}
                  />
                  {replyFormCommentId === comment.id && onReplyComment && onCancelReply && (
                    <div className="diff-comment-reply-form">
                      <ReplyForm
                        commentId={comment.id}
                        onSubmit={onReplyComment}
                        onCancel={onCancelReply}
                        mentionItems={mentionItems}
                      />
                    </div>
                  )}
                </Fragment>
              ))}

              {/* File comment form */}
              {fileCommentFormPath === file.new_path && onSubmitFileComment && onCancelFileComment && (
                <div
                  style={{
                    background: 'var(--color-bg-secondary)',
                    border: '1px solid var(--color-highlight)',
                    borderRadius: 8,
                    padding: '8px 12px',
                    margin: '8px 16px',
                    fontSize: 12,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                    <MessageSquare style={{ width: 12, height: 12, color: 'var(--color-highlight)' }} />
                    <span style={{ color: 'var(--color-text-muted)', fontSize: 11 }}>Comment on {file.new_path}</span>
                  </div>
                  <textarea
                    ref={fileCommentTextareaRef}
                    value={fileCommentText}
                    onChange={(e) => { setFileCommentText(e.target.value); fileCommentMention.handleChange(); }}
                    placeholder="Leave a comment about this file... (type @ to mention files)"
                    autoFocus
                    onKeyDown={(e) => {
                      if (fileCommentMention.handleKeyDown(e, setFileCommentText)) return;
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        if (fileCommentText.trim()) {
                          onSubmitFileComment(file.new_path, fileCommentText.trim());
                          setFileCommentText('');
                        }
                      }
                      if (e.key === 'Escape') {
                        onCancelFileComment();
                      }
                    }}
                    className="diff-reply-textarea"
                  />
                  <FileMentionDropdown
                    items={fileCommentMention.filteredItems}
                    selectedIdx={fileCommentMention.selectedIdx}
                    onSelect={(path) => { const v = fileCommentMention.handleSelect(path); if (v !== null) setFileCommentText(v); }}
                    onMouseEnter={fileCommentMention.setSelectedIdx}
                    visible={fileCommentMention.showDropdown}
                    anchorRef={fileCommentTextareaRef}
                    cursorIdx={fileCommentMention.atCharIdx}
                  />
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 6 }}>
                    <button
                      onClick={() => { onCancelFileComment(); setFileCommentText(''); }}
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
                      Cancel
                    </button>
                    <button
                      onClick={() => {
                        if (fileCommentText.trim()) {
                          onSubmitFileComment(file.new_path, fileCommentText.trim());
                          setFileCommentText('');
                        }
                      }}
                      disabled={!fileCommentText.trim()}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                        padding: '4px 10px',
                        background: 'var(--color-highlight)',
                        border: 'none',
                        borderRadius: 6,
                        color: 'white',
                        fontSize: 12,
                        fontWeight: 500,
                        cursor: 'pointer',
                      }}
                    >
                      Comment
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className={`diff-file-body${isPreviewOpen ? ' with-preview' : ''}`} ref={bodyRef}>
            {/* Main diff content (left side when drawer is open) */}
            <div className={`diff-file-body-main${isPreviewOpen && drawerExpanded ? ' hidden' : ''}`}>
              {file.is_virtual ? (
                <div className="diff-virtual-placeholder">
                  <div className="diff-virtual-icon">📝</div>
                  <div className="diff-virtual-text">
                    <strong>Planned File</strong>
                    <p>This file is planned to be created but doesn't exist yet in the current branch.</p>
                  </div>
                </div>
              ) : file.is_binary ? (
                <div className="diff-binary">
                  {viewMode === 'full'
                    ? 'Binary file — cannot display in Full Files mode'
                    : 'Binary file changed'}
                </div>
              ) : viewMode === 'full' ? (
                isLoadingFullFile ? (
                  <div className="diff-loading">Loading full file...</div>
                ) : fullFileContent != null ? (
                  <FullFileView
                    file={file}
                    content={fullFileContent}
                    language={language}
                    viewType={viewType}
                    {...commonCommentProps}
                  />
                ) : (
                  <div className="diff-error">Failed to load file content</div>
                )
              ) : file.is_unsupported ? (
                <div className="diff-binary">Diff not supported for this file type</div>
              ) : file.load_error ? (
                <div className="diff-error">Failed to load file content</div>
              ) : file.hunks.length === 0 && (file.additions > 0 || file.deletions > 0) ? (
                <div className="diff-binary" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div className="spinner" style={{ width: 14, height: 14 }} />
                  Loading diff...
                </div>
              ) : file.hunks.length === 0 ? (
                <div className="diff-binary">No content changes (mode/permissions only)</div>
              ) : viewType === 'unified' ? (
                <UnifiedView file={file} highlightedHunks={highlightedHunks} {...expandProps} {...commonCommentProps} codeSearchQuery={codeSearchQuery} codeSearchCaseSensitive={codeSearchCaseSensitive} />
              ) : (
                <SplitView file={file} highlightedHunks={highlightedHunks} {...expandProps} {...commonCommentProps} codeSearchQuery={codeSearchQuery} codeSearchCaseSensitive={codeSearchCaseSensitive} />
              )}
            </div>

            {/* Preview drawer (right side) */}
            {onTogglePreview && (
              <div
                ref={previewDrawerRef}
                tabIndex={-1}
                onPointerDown={(e) => {
                  const root = previewDrawerRef.current;
                  if (!root) return;
                  if (root === e.target || !(e.target as Element).closest?.("input,textarea,select,button,a,iframe,[contenteditable=true]")) {
                    if (!root.contains(document.activeElement)) {
                      root.focus({ preventScroll: true });
                    }
                  }
                }}
                className={`preview-drawer${isPreviewOpen ? ' open' : ''}${drawerExpanded ? ' expanded' : ''}`}
                style={{
                  outline: 'none',
                  ...(isPreviewOpen && !drawerExpanded && drawerWidthFraction != null
                    ? { width: `${drawerWidthFraction * 100}%`, minWidth: 200, transition: 'none' }
                    : {}),
                }}
              >
                {/* Resize handle */}
                {isPreviewOpen && !drawerExpanded && (
                  <div className="preview-drawer-resize" onMouseDown={handleResizeStart} />
                )}
                <div className="preview-drawer-header">
                  <Eye style={{ width: 14, height: 14, opacity: 0.6 }} />
                  <span style={{ flex: 1, fontWeight: 600 }}>Preview</span>
                  {previewRenderer && previewRenderer.supportsComments !== false && projectId && taskId && (
                    <button
                      className={`diff-file-preview-btn${previewCommentMode ? ' active' : ''}`}
                      onClick={() => setPreviewCommentMode((v) => !v)}
                      title={previewCommentMode ? 'Cancel comment selection' : 'Comment on preview'}
                    >
                      <MessageSquarePlus style={{ width: 13, height: 13 }} />
                    </button>
                  )}
                  <button
                    className="diff-file-preview-btn"
                    onClick={() => setDrawerExpanded((v) => !v)}
                    title={drawerExpanded ? 'Collapse to split view' : 'Expand to full width'}
                  >
                    {drawerExpanded ? (
                      <Minimize2 style={{ width: 13, height: 13 }} />
                    ) : (
                      <Maximize2 style={{ width: 13, height: 13 }} />
                    )}
                  </button>
                  <button
                    className="diff-file-preview-btn"
                    onClick={() => onTogglePreview(file.new_path)}
                    title="Close preview"
                  >
                    <X style={{ width: 14, height: 14 }} />
                  </button>
                </div>
                <div
                  ref={searchRootRef}
                  className="preview-drawer-content"
                  style={{
                    position: 'relative',
                    // When there's no real content to show, don't let the content area flex-stretch
                    // to fill the full viewport height — cap it so the drawer stays compact.
                    ...(isPreviewOpen && fullFileContent == null && file.hunks.length === 0
                      ? { flex: 'none' }
                      : {}),
                  }}
                >
                  {searchOpen && isPreviewOpen && (
                    <PreviewSearchBar
                      query={searchQuery}
                      onQueryChange={setSearchQuery}
                      total={searchTotal}
                      current={searchCurrent}
                      onNext={searchNext}
                      onPrev={searchPrev}
                      onClose={() => { setSearchOpen(false); setSearchQuery(''); }}
                    />
                  )}
                  {/* Only render content when the drawer is open.
                      The closed drawer has width:0 but no height limit — rendering heavy content
                      (e.g. MarkdownRenderer) would inflate the flex-row height of diff-file-body. */}
                  {isPreviewOpen && (
                    previewRenderer && previewRenderer.id === 'image' ? (
                      <ImagePreview projectId={projectId} taskId={taskId} file={file} onImageClick={setLightboxUrl} />
                    ) : previewRenderer && !previewRenderer.supportsDiffSegments ? (
                      (() => {
                        const content = viewMode === 'full' && fullFileContent != null
                          ? fullFileContent
                          : file.hunks.flatMap(h => h.lines.filter(l => l.line_type !== 'delete').map(l => l.content)).join('\n');
                        return content.trim()
                          ? previewRenderer.renderFull({
                              content,
                              onImageClick: setLightboxUrl,
                              onSvgClick: setLightboxSvg,
                              previewComment: previewRenderer.supportsComments !== false && projectId && taskId
                                ? { enabled: previewCommentMode, previewId: previewCommentId, markers: previewCommentMarkers }
                                : undefined,
                            })
                          : <div className="preview-loading">No content to render</div>;
                      })()
                    ) : viewMode === 'full' ? (
                      isLoadingFullFile ? (
                        <div className="preview-loading">Loading content...</div>
                      ) : fullFileContent != null ? (
                        previewRenderer
                          ? previewRenderer.renderFull({
                              content: fullFileContent,
                              onImageClick: setLightboxUrl,
                              onSvgClick: setLightboxSvg,
                              previewComment: previewRenderer.supportsComments !== false && projectId && taskId
                                ? { enabled: previewCommentMode, previewId: previewCommentId, markers: previewCommentMarkers }
                                : undefined,
                            })
                          : <MarkdownRenderer content={fullFileContent} onImageClick={setLightboxUrl} onMermaidClick={setLightboxSvg} />
                      ) : (
                        <div className="preview-loading">Failed to load file content</div>
                      )
                    ) : previewSegments.length > 0 ? (
                      (() => {
                        const segmentsContent = previewSegments.map((seg) =>
                          seg.type === 'markdown' ? (
                            <div key={seg.id} className={`preview-block-${seg.kind}`}>
                              <MarkdownRenderer content={seg.content} onImageClick={setLightboxUrl} onMermaidClick={setLightboxSvg} />
                            </div>
                          ) : seg.language === 'mermaid' ? (
                            <MermaidBlock key={seg.id} code={seg.lines.map(l => l.content).join('\n')} onPreviewClick={setLightboxSvg} />
                          ) : (
                            <pre key={seg.id} className="preview-code-block">
                              <code>
                                {seg.lines.map((line, i) => (
                                  <div
                                    key={i}
                                    className={`preview-code-line${line.kind !== 'context' ? ` preview-code-line-${line.kind}` : ''}`}
                                  >
                                    {line.content || ' '}
                                  </div>
                                ))}
                              </code>
                            </pre>
                          )
                        );
                        return previewRenderer && previewRenderer.supportsComments !== false && projectId && taskId ? (
                          <PreviewCommentHost
                            previewComment={{
                              enabled: previewCommentMode,
                              previewId: previewCommentId,
                              markers: previewCommentMarkers,
                            }}
                          >
                            {segmentsContent}
                          </PreviewCommentHost>
                        ) : (
                          <>{segmentsContent}</>
                        );
                      })()
                    ) : (
                      <div className="preview-loading">No previewable changes</div>
                    )
                  )}
                </div>
              </div>
            )}
          </div>
        </>
      )}

      <ImageLightbox
        imageUrl={lightboxUrl}
        svgContent={lightboxSvg}
        onClose={() => { setLightboxUrl(null); setLightboxSvg(null); }}
      />

      {pendingPreviewLocator && (
        <div
          data-hotkeys-dialog="true"
          onMouseDown={(e) => { if (e.target === e.currentTarget) closePreviewCommentModal(); }}
          style={{ position: 'fixed', inset: 0, zIndex: 1001, background: 'rgba(0,0,0,.4)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <div style={{ width: 'min(92vw,460px)', background: 'var(--color-bg)', border: '1px solid var(--color-border)', borderRadius: 12, boxShadow: '0 18px 50px rgba(0,0,0,.28)', overflow: 'hidden' }}>
            <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--color-border)', background: 'var(--color-bg-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                <MessageSquarePlus style={{ width: 13, height: 13, color: 'var(--color-highlight)', flexShrink: 0 }} />
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text)' }}>
                  {editingPreviewDraftId ? 'Edit preview comment' : 'New preview comment'}
                </span>
              </div>
              <button
                onClick={closePreviewCommentModal}
                title="Close (Esc)"
                style={{ display: 'inline-flex', padding: 4, border: 'none', background: 'transparent', borderRadius: 4, color: 'var(--color-text-muted)', cursor: 'pointer' }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-tertiary)'; e.currentTarget.style.color = 'var(--color-text)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--color-text-muted)'; }}
              >
                <X style={{ width: 13, height: 13 }} />
              </button>
            </div>
            <div style={{ padding: '12px 16px 0' }}>
              <div
                title={pendingPreviewLocator.selector || pendingPreviewLocator.tagName}
                style={{ fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace', fontSize: 10.5, color: 'var(--color-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {pendingPreviewLocator.selector || pendingPreviewLocator.tagName}
              </div>
              {pendingPreviewLocator.text && (
                <div style={{ marginTop: 8, padding: '6px 10px', border: '1px solid var(--color-border)', borderRadius: 6, background: 'var(--color-bg-secondary)', color: 'var(--color-text-muted)', fontSize: 11, lineHeight: 1.4, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                  {pendingPreviewLocator.text}
                </div>
              )}
            </div>
            <div style={{ padding: '12px 16px' }}>
              <textarea
                value={previewCommentText}
                onChange={(e) => setPreviewCommentText(e.target.value)}
                autoFocus
                rows={3}
                placeholder="What should change about this area?"
                onKeyDown={(e) => {
                  if (e.key === 'Escape') { e.preventDefault(); closePreviewCommentModal(); }
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitReviewPreviewComment();
                }}
                style={{ width: '100%', resize: 'none', border: '1px solid var(--color-border)', borderRadius: 8, background: 'var(--color-bg-secondary)', color: 'var(--color-text)', padding: '8px 10px', outline: 'none', fontSize: 13, lineHeight: 1.4 }}
              />
              <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {editingPreviewDraftId && (
                    <button
                      onClick={deleteReviewPreviewComment}
                      title="Delete comment"
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 8px', border: 'none', background: 'transparent', borderRadius: 6, fontSize: 11, color: 'var(--color-text-muted)', cursor: 'pointer' }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = 'color-mix(in srgb, var(--color-error) 12%, transparent)'; e.currentTarget.style.color = 'var(--color-error)'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--color-text-muted)'; }}
                    >
                      <Trash2 style={{ width: 12, height: 12 }} />
                      Delete
                    </button>
                  )}
                  <span style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>
                    <kbd style={{ border: '1px solid var(--color-border)', background: 'var(--color-bg-secondary)', borderRadius: 3, padding: '0 4px', fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace', fontSize: 10 }}>⌘↵</kbd> to submit
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    onClick={closePreviewCommentModal}
                    style={{ padding: '4px 10px', border: 'none', background: 'transparent', borderRadius: 6, fontSize: 11, color: 'var(--color-text-muted)', cursor: 'pointer' }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--color-bg-tertiary)'; e.currentTarget.style.color = 'var(--color-text)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--color-text-muted)'; }}
                  >
                    Cancel
                  </button>
                  <button
                    disabled={!previewCommentText.trim()}
                    onClick={submitReviewPreviewComment}
                    style={{ border: 'none', borderRadius: 6, padding: '4px 12px', background: 'var(--color-highlight)', color: 'white', fontSize: 11, fontWeight: 600, opacity: previewCommentText.trim() ? 1 : .4, boxShadow: '0 1px 2px rgba(0,0,0,.12)', cursor: previewCommentText.trim() ? 'pointer' : 'not-allowed' }}
                  >
                    {editingPreviewDraftId ? 'Save' : 'Add comment'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Floating comment button on text selection */}
      {selectionAnchor && onGutterClick && (
        <button
          className="diff-selection-comment-btn"
          style={{
            position: 'absolute',
            top: selectionAnchor.top,
            left: selectionAnchor.centerX,
            transform: 'translateX(-50%)',
          }}
          onMouseDown={(e) => {
            e.preventDefault(); // Prevent losing selection
            // Set multi-line comment anchor
            if (onGutterClick) {
              // First click sets start line, then extend to end line
              onGutterClick(file.new_path, selectionAnchor.side, selectionAnchor.startLine, false);
              // Use setTimeout to ensure state updates, then extend with shift
              setTimeout(() => {
                onGutterClick(file.new_path, selectionAnchor.side, selectionAnchor.endLine, true);
                setSelectionAnchor(null);
                window.getSelection()?.removeAllRanges();
              }, 0);
            }
          }}
          title={`Comment on lines ${selectionAnchor.startLine}-${selectionAnchor.endLine}`}
        >
          <MessageSquare style={{ width: 14, height: 14 }} />
          <span>L{selectionAnchor.startLine}-{selectionAnchor.endLine}</span>
        </button>
      )}
    </div>
  );
}

// ============================================================================
// Shared props types
// ============================================================================

interface CommentProps {
  filePath: string;
  commentsByKey: Map<string, ReviewCommentEntry[]>;
  highlightedLines: Set<string>;
  commentFormAnchor?: CommentAnchor | null;
  onGutterClick?: (filePath: string, side: 'ADD' | 'DELETE', line: number, shiftKey: boolean) => void;
  onAddComment?: (anchor: CommentAnchor, content: string) => void;
  onDeleteComment?: (id: number) => void;
  onCancelComment?: () => void;
  replyFormCommentId?: number | null;
  onOpenReplyForm?: (commentId: number) => void;
  onReplyComment?: (commentId: number, status: string, message: string) => void;
  onCancelReply?: () => void;
  onResolveComment?: (id: number) => void;
  onReopenComment?: (id: number) => void;
  collapsedCommentIds?: Set<number>;
  onCollapseComment?: (id: number) => void;
  onExpandComment?: (id: number) => void;
  onEditComment?: (id: number, content: string) => void;
  onEditReply?: (commentId: number, replyId: number, content: string) => void;
  onDeleteReply?: (commentId: number, replyId: number) => void;
  mentionItems?: import('../../utils/fileMention').MentionItem[] | null;
}

// ============================================================================
// Helper: compute expanded line ranges for a gap
// ============================================================================

function getExpandedRanges(gap: HunkGap | undefined, expansion: GapExpansion | undefined) {
  if (!gap || !expansion) return { top: null, bottom: null };
  if (expansion.full) {
    return { top: { start: gap.startLine, end: gap.endLine }, bottom: null };
  }
  // Clamp to actual gap bounds (fromTop/fromBottom may overshoot if queued before gap was computed)
  const clampedTop = Math.min(expansion.fromTop, gap.totalLines);
  const clampedBottom = Math.min(expansion.fromBottom, gap.totalLines - clampedTop);
  return {
    top: clampedTop > 0
      ? { start: gap.startLine, end: Math.min(gap.startLine + clampedTop - 1, gap.endLine) }
      : null,
    bottom: clampedBottom > 0
      ? { start: Math.max(gap.endLine - clampedBottom + 1, gap.startLine), end: gap.endLine }
      : null,
  };
}

// ============================================================================
// Inline expand buttons (rendered inside hunk header)
// ============================================================================

/// Check if a gap is fully expanded (no remaining hidden lines)
function isGapFullyExpanded(gap: HunkGap | undefined, expansion: GapExpansion | undefined): boolean {
  if (!gap || !expansion) return false;
  if (expansion.full) return true;
  return expansion.fromTop + expansion.fromBottom >= gap.totalLines;
}

function ExpandButtons({
  gap,
  expansion,
  onExpandUp,
  onExpandDown,
  onExpandAll,
}: {
  gap: HunkGap;
  expansion: GapExpansion | undefined;
  onExpandUp: (idx: number) => void;
  onExpandDown: (idx: number) => void;
  onExpandAll: (idx: number) => void;
}) {
  const fromTop = expansion?.fromTop || 0;
  const fromBottom = expansion?.fromBottom || 0;
  const remaining = expansion?.full ? 0 : gap.totalLines - fromTop - fromBottom;
  if (remaining <= 0) return null;

  const isFileHeader = gap.gapIndex === 0;
  const showUpDown = remaining > 20;

  return (
    <>
      <span className="diff-expand-buttons">
        {!isFileHeader && showUpDown && (
          <button onClick={() => onExpandDown(gap.gapIndex)} title="Expand 20 lines down">
            <ChevronDown style={{ width: 14, height: 14 }} />
          </button>
        )}
        {(isFileHeader && remaining > 20) ? (
          <button onClick={() => onExpandUp(gap.gapIndex)} title="Expand 20 lines up">
            <ChevronUp style={{ width: 14, height: 14 }} />
          </button>
        ) : null}
        <button onClick={() => onExpandAll(gap.gapIndex)} title={`Expand all ${remaining} lines`}>
          <ChevronsUpDown style={{ width: 14, height: 14 }} />
        </button>
        {!isFileHeader && showUpDown && (
          <button onClick={() => onExpandUp(gap.gapIndex)} title="Expand 20 lines up">
            <ChevronUp style={{ width: 14, height: 14 }} />
          </button>
        )}
      </span>
      <span className="diff-expand-label">{remaining} lines</span>
    </>
  );
}

// ============================================================================
// Expanded context lines
// ============================================================================

function ExpandedContextRows({
  startLine,
  endLine,
  oldStartLine,
  fileLines,
  language,
  viewType,
  filePath,
  onGutterClick,
  highlightedLines,
  commentsByKey,
  commentFormAnchor,
  onAddComment,
  onDeleteComment,
  onCancelComment,
  replyFormCommentId,
  onOpenReplyForm,
  onReplyComment,
  onCancelReply,
  onResolveComment,
  onReopenComment,
  collapsedCommentIds,
  onCollapseComment,
  onExpandComment,
  onEditComment,
  onEditReply,
  onDeleteReply,
  mentionItems,
  codeSearchQuery,
  codeSearchCaseSensitive,
}: {
  startLine: number;
  endLine: number;
  oldStartLine: number;
  fileLines: string[] | null;
  language: string | undefined;
  viewType: 'unified' | 'split';
  codeSearchQuery: string;
  codeSearchCaseSensitive: boolean;
} & CommentProps) {
  const lines = useMemo(() => {
    if (!fileLines) return null;
    const result: string[] = [];
    for (let i = startLine; i <= endLine; i++) {
      result.push(fileLines[i - 1] ?? '');
    }
    return result;
  }, [fileLines, startLine, endLine]);

  const htmlLines = useMemo(() => {
    if (!lines) return null;
    return highlightLines(lines, language);
  }, [lines, language]);

  if (!lines) return null;

  return (
    <>
      {lines.map((_, idx) => {
        const newLine = startLine + idx;
        const oldLine = oldStartLine + idx;
        const content = htmlLines?.[idx]
          ? <span dangerouslySetInnerHTML={{
              __html: codeSearchQuery
                ? highlightSearchInHTML(htmlLines[idx], codeSearchQuery, codeSearchCaseSensitive)
                : htmlLines[idx]
            }} />
          : highlightSearchMatches(lines[idx], codeSearchQuery, codeSearchCaseSensitive);

        // Expanded context lines can have comments on both sides
        const leftKey = `DELETE:${oldLine}`;
        const rightKey = `ADD:${newLine}`;
        const leftHighlighted = highlightedLines?.has(leftKey) || false;
        const rightHighlighted = highlightedLines?.has(rightKey) || false;
        const leftComments = commentsByKey?.get(leftKey) || [];
        const rightComments = commentsByKey?.get(rightKey) || [];
        const expandedLeftComments = leftComments.filter((c) => !collapsedCommentIds?.has(c.id));
        const expandedRightComments = rightComments.filter((c) => !collapsedCommentIds?.has(c.id));
        const collapsedLeftCount = leftComments.length - expandedLeftComments.length;
        const collapsedRightCount = rightComments.length - expandedRightComments.length;

        const showLeftForm = commentFormAnchor
          && commentFormAnchor.filePath === filePath
          && commentFormAnchor.side === 'DELETE'
          && commentFormAnchor.endLine === oldLine;

        const showRightForm = commentFormAnchor
          && commentFormAnchor.filePath === filePath
          && commentFormAnchor.side === 'ADD'
          && commentFormAnchor.endLine === newLine;

        if (viewType === 'split') {
          const hasLeftComments = expandedLeftComments.length > 0 || showLeftForm;
          const hasRightComments = expandedRightComments.length > 0 || showRightForm;

          return (
            <Fragment key={`exp-${newLine}`}>
              <tr className="diff-line-expanded" data-line={newLine}>
                <td
                  className={`diff-gutter ${leftHighlighted ? 'diff-line-highlighted' : ''} ${collapsedLeftCount > 0 ? 'has-collapsed-comment' : ''}`}
                  onClick={(e) => {
                    if (collapsedLeftCount > 0 && onExpandComment) {
                      leftComments.filter((c) => collapsedCommentIds?.has(c.id)).forEach((c) => onExpandComment(c.id));
                      return;
                    }
                    if (onGutterClick) {
                      onGutterClick(filePath, 'DELETE', oldLine, e.shiftKey);
                    }
                  }}
                  title={collapsedLeftCount > 0 ? `${collapsedLeftCount} hidden comment${collapsedLeftCount > 1 ? 's' : ''}` : 'Click to add comment'}
                >
                  <span className="diff-gutter-content">
                    {collapsedLeftCount > 0 && (
                      <GutterAvatar name={leftComments.find((c) => collapsedCommentIds?.has(c.id))?.author ?? '?'} />
                    )}
                    {oldLine}
                  </span>
                </td>
                <td className={`diff-code ${leftHighlighted ? 'diff-line-highlighted' : ''}`} data-line={oldLine} data-side="DELETE">{content}</td>
                <td
                  className={`diff-gutter diff-gutter-split-middle ${rightHighlighted ? 'diff-line-highlighted' : ''} ${collapsedRightCount > 0 ? 'has-collapsed-comment' : ''}`}
                  onClick={(e) => {
                    if (collapsedRightCount > 0 && onExpandComment) {
                      rightComments.filter((c) => collapsedCommentIds?.has(c.id)).forEach((c) => onExpandComment(c.id));
                      return;
                    }
                    if (onGutterClick) {
                      onGutterClick(filePath, 'ADD', newLine, e.shiftKey);
                    }
                  }}
                  title={collapsedRightCount > 0 ? `${collapsedRightCount} hidden comment${collapsedRightCount > 1 ? 's' : ''}` : 'Click to add comment'}
                >
                  <span className="diff-gutter-content">
                    {collapsedRightCount > 0 && (
                      <GutterAvatar name={rightComments.find((c) => collapsedCommentIds?.has(c.id))?.author ?? '?'} />
                    )}
                    {newLine}
                  </span>
                </td>
                <td className={`diff-code ${rightHighlighted ? 'diff-line-highlighted' : ''}`} data-line={newLine} data-side="ADD">{content}</td>
              </tr>
              {(hasLeftComments || hasRightComments) && (
                <tr className="diff-split-comment-row">
                  <td colSpan={2} style={{ padding: 0, verticalAlign: 'top' }}>
                    {expandedLeftComments.map((c) => (
                      <Fragment key={`lc-${c.id}`}>
                        <CommentCard
                          comment={c}
                          onDelete={onDeleteComment}
                          onReply={onOpenReplyForm}
                          onResolve={onResolveComment}
                          onReopen={onReopenComment}
                          onCollapse={onCollapseComment}
                          onExpand={onExpandComment}
                          isCollapsed={collapsedCommentIds?.has(c.id)}
                          onEdit={onEditComment}
                          onEditReply={onEditReply}
                          onDeleteReply={onDeleteReply}
                          mentionItems={mentionItems}
                        />
                        {replyFormCommentId === c.id && onReplyComment && onCancelReply && (
                          <div style={{ margin: '-2px 8px 6px 8px' }}>
                            <div className="diff-comment-card" style={{ marginLeft: 0, marginRight: 0 }}>
                              <ReplyForm
                                commentId={c.id}
                                onSubmit={onReplyComment}
                                onCancel={onCancelReply}
                                mentionItems={mentionItems}
                              />
                            </div>
                          </div>
                        )}
                      </Fragment>
                    ))}
                    {showLeftForm && onAddComment && onCancelComment && (
                      <CommentForm
                        anchor={commentFormAnchor!}
                        onSubmit={onAddComment}
                        onCancel={onCancelComment}
                        mentionItems={mentionItems}
                      />
                    )}
                  </td>
                  <td colSpan={2} style={{ padding: 0, verticalAlign: 'top' }}>
                    {expandedRightComments.map((c) => (
                      <Fragment key={`rc-${c.id}`}>
                        <CommentCard
                          comment={c}
                          onDelete={onDeleteComment}
                          onReply={onOpenReplyForm}
                          onResolve={onResolveComment}
                          onReopen={onReopenComment}
                          onCollapse={onCollapseComment}
                          onExpand={onExpandComment}
                          isCollapsed={collapsedCommentIds?.has(c.id)}
                          onEdit={onEditComment}
                          onEditReply={onEditReply}
                          onDeleteReply={onDeleteReply}
                          mentionItems={mentionItems}
                        />
                        {replyFormCommentId === c.id && onReplyComment && onCancelReply && (
                          <div style={{ margin: '-2px 8px 6px 8px' }}>
                            <div className="diff-comment-card" style={{ marginLeft: 0, marginRight: 0 }}>
                              <ReplyForm
                                commentId={c.id}
                                onSubmit={onReplyComment}
                                onCancel={onCancelReply}
                                mentionItems={mentionItems}
                              />
                            </div>
                          </div>
                        )}
                      </Fragment>
                    ))}
                    {showRightForm && onAddComment && onCancelComment && (
                      <CommentForm
                        anchor={commentFormAnchor!}
                        onSubmit={onAddComment}
                        onCancel={onCancelComment}
                        mentionItems={mentionItems}
                      />
                    )}
                  </td>
                </tr>
              )}
            </Fragment>
          );
        }

        // Unified view
        const hasComments = expandedLeftComments.length > 0 || expandedRightComments.length > 0 || showLeftForm || showRightForm;

        return (
          <Fragment key={`exp-${newLine}`}>
            <tr className={`diff-line-expanded ${leftHighlighted || rightHighlighted ? 'diff-line-highlighted' : ''}`} data-line={newLine}>
              <td
                className={`diff-gutter ${leftHighlighted ? 'diff-line-highlighted' : ''} ${collapsedLeftCount > 0 ? 'has-collapsed-comment' : ''}`}
                onClick={(e) => {
                  if (collapsedLeftCount > 0 && onExpandComment) {
                    leftComments.filter((c) => collapsedCommentIds?.has(c.id)).forEach((c) => onExpandComment(c.id));
                    return;
                  }
                  if (onGutterClick) {
                    onGutterClick(filePath, 'DELETE', oldLine, e.shiftKey);
                  }
                }}
                title={collapsedLeftCount > 0 ? `${collapsedLeftCount} hidden comment${collapsedLeftCount > 1 ? 's' : ''}` : 'Click to add comment (old side)'}
              >
                <span className="diff-gutter-content">
                  {collapsedLeftCount > 0 && (
                    <GutterAvatar name={leftComments.find((c) => collapsedCommentIds?.has(c.id))?.author ?? '?'} />
                  )}
                  {oldLine}
                </span>
              </td>
              <td
                className={`diff-gutter ${rightHighlighted ? 'diff-line-highlighted' : ''} ${collapsedRightCount > 0 ? 'has-collapsed-comment' : ''}`}
                onClick={(e) => {
                  if (collapsedRightCount > 0 && onExpandComment) {
                    rightComments.filter((c) => collapsedCommentIds?.has(c.id)).forEach((c) => onExpandComment(c.id));
                    return;
                  }
                  if (onGutterClick) {
                    onGutterClick(filePath, 'ADD', newLine, e.shiftKey);
                  }
                }}
                title={collapsedRightCount > 0 ? `${collapsedRightCount} hidden comment${collapsedRightCount > 1 ? 's' : ''}` : 'Click to add comment (new side)'}
              >
                <span className="diff-gutter-content">
                  {collapsedRightCount > 0 && (
                    <GutterAvatar name={rightComments.find((c) => collapsedCommentIds?.has(c.id))?.author ?? '?'} />
                  )}
                  {newLine}
                </span>
              </td>
              <td className="diff-code">
                <span className="diff-code-prefix">{' '}</span>
                {content}
              </td>
            </tr>
            {hasComments && (
              <tr>
                <td colSpan={3} style={{ padding: 0 }}>
                  {expandedLeftComments.map((c) => (
                    <Fragment key={`comment-${c.id}`}>
                      <CommentCard
                        comment={c}
                        onDelete={onDeleteComment}
                        onReply={onOpenReplyForm}
                        onResolve={onResolveComment}
                        onReopen={onReopenComment}
                        onCollapse={onCollapseComment}
                        onExpand={onExpandComment}
                        isCollapsed={collapsedCommentIds?.has(c.id)}
                        onEdit={onEditComment}
                        onEditReply={onEditReply}
                        onDeleteReply={onDeleteReply}
                        mentionItems={mentionItems}
                      />
                      {replyFormCommentId === c.id && onReplyComment && onCancelReply && (
                        <div style={{ margin: '-2px 16px 6px 60px' }}>
                          <div className="diff-comment-card" style={{ marginLeft: 0, marginRight: 0 }}>
                            <ReplyForm
                              commentId={c.id}
                              onSubmit={onReplyComment}
                              onCancel={onCancelReply}
                              mentionItems={mentionItems}
                            />
                          </div>
                        </div>
                      )}
                    </Fragment>
                  ))}
                  {expandedRightComments.map((c) => (
                    <Fragment key={`comment-${c.id}`}>
                      <CommentCard
                        comment={c}
                        onDelete={onDeleteComment}
                        onReply={onOpenReplyForm}
                        onResolve={onResolveComment}
                        onReopen={onReopenComment}
                        onCollapse={onCollapseComment}
                        onExpand={onExpandComment}
                        isCollapsed={collapsedCommentIds?.has(c.id)}
                        onEdit={onEditComment}
                        onEditReply={onEditReply}
                        onDeleteReply={onDeleteReply}
                        mentionItems={mentionItems}
                      />
                      {replyFormCommentId === c.id && onReplyComment && onCancelReply && (
                        <div style={{ margin: '-2px 16px 6px 60px' }}>
                          <div className="diff-comment-card" style={{ marginLeft: 0, marginRight: 0 }}>
                            <ReplyForm
                              commentId={c.id}
                              onSubmit={onReplyComment}
                              onCancel={onCancelReply}
                              mentionItems={mentionItems}
                            />
                          </div>
                        </div>
                      )}
                    </Fragment>
                  ))}
                  {showLeftForm && onAddComment && onCancelComment && (
                    <CommentForm
                      anchor={commentFormAnchor!}
                      onSubmit={onAddComment}
                      onCancel={onCancelComment}
                      mentionItems={mentionItems}
                    />
                  )}
                  {showRightForm && onAddComment && onCancelComment && (
                    <CommentForm
                      anchor={commentFormAnchor!}
                      onSubmit={onAddComment}
                      onCancel={onCancelComment}
                      mentionItems={mentionItems}
                    />
                  )}
                </td>
              </tr>
            )}
          </Fragment>
        );
      })}
    </>
  );
}

// ============================================================================
// Unified View
// ============================================================================

function UnifiedView({
  file,
  highlightedHunks,
  gapsByHunkIndex,
  expansions,
  fileLines,
  language,
  onExpandUp,
  onExpandDown,
  onExpandAll,
  codeSearchQuery,
  codeSearchCaseSensitive,
  ...commentProps
}: { file: DiffFile; highlightedHunks: string[][]; codeSearchQuery: string; codeSearchCaseSensitive: boolean } & ExpandProps & CommentProps) {
  return (
    <table className="diff-table">
      <tbody>
        {file.hunks.map((hunk, hunkIdx) => {
          const gap = gapsByHunkIndex.get(hunkIdx);
          const expansion = gap ? expansions.get(gap.gapIndex) : undefined;
          const ranges = getExpandedRanges(gap, expansion);
          return (
            <Fragment key={hunkIdx}>
              {/* Expanded lines from top of gap (closer to previous hunk) */}
              {ranges.top && gap && (
                <ExpandedContextRows
                  startLine={ranges.top.start}
                  endLine={ranges.top.end}
                  oldStartLine={gap.oldStartLine + (ranges.top.start - gap.startLine)}
                  fileLines={fileLines}
                  language={language}
                  viewType="unified"
                  {...commentProps}
                  codeSearchQuery={codeSearchQuery}
                  codeSearchCaseSensitive={codeSearchCaseSensitive}
                />
              )}
              {/* Hunk header (with expand buttons merged in) + lines */}
              <HunkRows
                hunk={hunk}
                highlightedCode={highlightedHunks[hunkIdx]}
                gap={gap}
                expansion={expansion}
                expandRangeBottom={ranges.bottom}
                fileLines={fileLines}
                expandLanguage={language}
                onExpandUp={onExpandUp}
                onExpandDown={onExpandDown}
                onExpandAll={onExpandAll}
                {...commentProps}
                  codeSearchQuery={codeSearchQuery}
                  codeSearchCaseSensitive={codeSearchCaseSensitive}
              />
            </Fragment>
          );
        })}
        {/* Trailing gap: remaining lines after last hunk */}
        {file.hunks.length > 0 && (() => {
          const trailingIndex = file.hunks.length;
          const trailingGap = gapsByHunkIndex.get(trailingIndex);
          const trailingExpansion = expansions.get(trailingIndex);
          const ranges = getExpandedRanges(trailingGap, trailingExpansion);
          const fullyExpanded = isGapFullyExpanded(trailingGap, trailingExpansion);

          // fileLines loaded but no trailing content → hide
          if (fileLines && !trailingGap) return null;

          return (
            <>
              {ranges.top && trailingGap && (
                <ExpandedContextRows
                  startLine={ranges.top.start}
                  endLine={ranges.top.end}
                  oldStartLine={trailingGap.oldStartLine + (ranges.top.start - trailingGap.startLine)}
                  fileLines={fileLines}
                  language={language}
                  viewType="unified"
                  {...commentProps}
                  codeSearchQuery={codeSearchQuery}
                  codeSearchCaseSensitive={codeSearchCaseSensitive}
                />
              )}
              {!fullyExpanded && (
                <tr className="diff-expand-row">
                  <td className="diff-gutter diff-hunk-gutter" />
                  <td className="diff-gutter diff-hunk-gutter" />
                  <td className="diff-hunk-header" colSpan={1}>
                    <div className="diff-hunk-header-content">
                      {trailingGap ? (
                        <ExpandButtons
                          gap={trailingGap}
                          expansion={trailingExpansion}
                          onExpandUp={onExpandUp}
                          onExpandDown={onExpandDown}
                          onExpandAll={onExpandAll}
                        />
                      ) : (
                        <>
                          <span className="diff-expand-buttons">
                            <button onClick={() => onExpandDown(trailingIndex)} title="Expand 20 lines">
                              <ChevronDown style={{ width: 14, height: 14 }} />
                            </button>
                            <button onClick={() => onExpandAll(trailingIndex)} title="Expand all remaining lines">
                              <ChevronsUpDown style={{ width: 14, height: 14 }} />
                            </button>
                          </span>
                          <span className="diff-expand-label">remaining lines</span>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              )}
              {ranges.bottom && trailingGap && (
                <ExpandedContextRows
                  startLine={ranges.bottom.start}
                  endLine={ranges.bottom.end}
                  oldStartLine={trailingGap.oldStartLine + (ranges.bottom.start - trailingGap.startLine)}
                  fileLines={fileLines}
                  language={language}
                  viewType="unified"
                  {...commentProps}
                  codeSearchQuery={codeSearchQuery}
                  codeSearchCaseSensitive={codeSearchCaseSensitive}
                />
              )}
            </>
          );
        })()}
      </tbody>
    </table>
  );
}

// ============================================================================
// Unified HunkRows — header with expand buttons + bottom expanded lines + diff lines
// ============================================================================

interface HunkExpandProps {
  gap?: HunkGap;
  expansion?: GapExpansion;
  expandRangeBottom?: { start: number; end: number } | null;
  fileLines: string[] | null;
  expandLanguage: string | undefined;
  onExpandUp: (gapIndex: number) => void;
  onExpandDown: (gapIndex: number) => void;
  onExpandAll: (gapIndex: number) => void;
}

function HunkRows({
  hunk,
  highlightedCode,
  filePath,
  commentsByKey,
  highlightedLines,
  commentFormAnchor,
  onGutterClick,
  onAddComment,
  onDeleteComment,
  onCancelComment,
  replyFormCommentId,
  onOpenReplyForm,
  onReplyComment,
  onCancelReply,
  onResolveComment,
  onReopenComment,
  collapsedCommentIds,
  onCollapseComment,
  onExpandComment,
  onEditComment,
  onEditReply,
  onDeleteReply,
  mentionItems,
  gap,
  expansion,
  expandRangeBottom,
  fileLines,
  expandLanguage,
  onExpandUp,
  onExpandDown,
  onExpandAll,
  codeSearchQuery,
  codeSearchCaseSensitive,
}: { hunk: DiffHunk; highlightedCode?: string[]; codeSearchQuery: string; codeSearchCaseSensitive: boolean } & CommentProps & HunkExpandProps) {
  const gapExpanded = isGapFullyExpanded(gap, expansion);

  return (
    <>
      {/* Hunk header with expand buttons — hidden when gap is fully expanded */}
      {!gapExpanded && (
        <tr className={gap ? 'diff-expand-row' : ''}>
          <td className="diff-gutter diff-hunk-gutter" />
          <td className="diff-gutter diff-hunk-gutter" />
          <td className="diff-hunk-header" colSpan={1}>
            <div className="diff-hunk-header-content">
              {gap && (
                <ExpandButtons
                  gap={gap}
                  expansion={expansion}
                  onExpandUp={onExpandUp}
                  onExpandDown={onExpandDown}
                  onExpandAll={onExpandAll}
                />
              )}
              <span className="diff-hunk-header-text">{hunk.header}</span>
            </div>
          </td>
        </tr>
      )}
      {/* Bottom expanded lines (closer to this hunk) */}
      {expandRangeBottom && gap && (
        <ExpandedContextRows
          startLine={expandRangeBottom.start}
          endLine={expandRangeBottom.end}
          oldStartLine={gap.oldStartLine + (expandRangeBottom.start - gap.startLine)}
          fileLines={fileLines}
          language={expandLanguage}
          viewType="unified"
          filePath={filePath}
          commentsByKey={commentsByKey}
          highlightedLines={highlightedLines}
          commentFormAnchor={commentFormAnchor}
          onGutterClick={onGutterClick}
          onAddComment={onAddComment}
          onDeleteComment={onDeleteComment}
          onCancelComment={onCancelComment}
          replyFormCommentId={replyFormCommentId}
          onOpenReplyForm={onOpenReplyForm}
          onReplyComment={onReplyComment}
          onCancelReply={onCancelReply}
          onResolveComment={onResolveComment}
          onReopenComment={onReopenComment}
          collapsedCommentIds={collapsedCommentIds}
          onCollapseComment={onCollapseComment}
          onExpandComment={onExpandComment}
          onEditComment={onEditComment}
          onEditReply={onEditReply}
          onDeleteReply={onDeleteReply}
          mentionItems={mentionItems}
          codeSearchQuery={codeSearchQuery}
          codeSearchCaseSensitive={codeSearchCaseSensitive}
        />
      )}
      {/* Diff content lines */}
      {hunk.lines.map((line, lineIdx) => {
        let side: 'ADD' | 'DELETE';
        let lineNum: number | null;
        if (line.line_type === 'delete') {
          side = 'DELETE';
          lineNum = line.old_line;
        } else {
          side = 'ADD';
          lineNum = line.new_line;
        }

        const locationKey = lineNum ? `${side}:${lineNum}` : null;
        const rowClass =
          line.line_type === 'insert'
            ? 'diff-line-insert'
            : line.line_type === 'delete'
              ? 'diff-line-delete'
              : '';
        const isHighlighted = locationKey ? highlightedLines.has(locationKey) : false;
        const lineComments = locationKey ? (commentsByKey.get(locationKey) || []) : [];
        const expandedComments = lineComments.filter((c) => !collapsedCommentIds?.has(c.id));
        const collapsedCount = lineComments.length - expandedComments.length;

        const showForm = commentFormAnchor
          && commentFormAnchor.filePath === filePath
          && commentFormAnchor.side === side
          && commentFormAnchor.endLine === lineNum;

        return (
          <Fragment key={lineIdx}>
            <tr className={`${rowClass} ${isHighlighted ? 'diff-line-highlighted' : ''}`} data-line={lineNum ?? undefined} data-side={side}>
              <td
                className="diff-gutter"
                onClick={(e) => {
                  if (line.old_line != null && onGutterClick) {
                    onGutterClick(filePath, 'DELETE', line.old_line, e.shiftKey);
                  }
                }}
                title={line.old_line != null ? 'Click to add comment (old side)' : undefined}
              >
                {line.old_line ?? ''}
              </td>
              <td
                className={`diff-gutter ${collapsedCount > 0 ? 'has-collapsed-comment' : ''}`}
                onClick={(e) => {
                  if (collapsedCount > 0 && onExpandComment) {
                    lineComments.filter((c) => collapsedCommentIds?.has(c.id)).forEach((c) => onExpandComment(c.id));
                    return;
                  }
                  if (line.new_line != null && onGutterClick) {
                    onGutterClick(filePath, 'ADD', line.new_line, e.shiftKey);
                  }
                }}
                title={collapsedCount > 0 ? `${collapsedCount} hidden comment${collapsedCount > 1 ? 's' : ''} — click to expand` : (line.new_line != null ? 'Click to add comment (new side)' : undefined)}
              >
                <span className="diff-gutter-content">
                  {collapsedCount > 0 && (
                    <GutterAvatar name={lineComments.find((c) => collapsedCommentIds?.has(c.id))?.author ?? '?'} />
                  )}
                  {line.new_line ?? ''}
                </span>
              </td>
              <td className="diff-code">
                <span className="diff-code-prefix">{line.line_type === 'insert' ? '+' : line.line_type === 'delete' ? '-' : ' '}</span>
                {highlightedCode?.[lineIdx] ? (
                  <span dangerouslySetInnerHTML={{
                    __html: codeSearchQuery
                      ? highlightSearchInHTML(highlightedCode[lineIdx], codeSearchQuery, codeSearchCaseSensitive)
                      : highlightedCode[lineIdx]
                  }} />
                ) : (
                  highlightSearchMatches(line.content, codeSearchQuery, codeSearchCaseSensitive)
                )}
              </td>
            </tr>
            {expandedComments.map((c) => (
              <Fragment key={`comment-${c.id}`}>
                <tr>
                  <td colSpan={3} style={{ padding: 0 }}>
                    <CommentCard
                      comment={c}
                      onDelete={onDeleteComment}
                      onReply={onOpenReplyForm}
                      onResolve={onResolveComment}
                      onReopen={onReopenComment}
                      onCollapse={onCollapseComment}
                      onExpand={onExpandComment}
                      isCollapsed={collapsedCommentIds?.has(c.id)}
                      onEdit={onEditComment}
                      onEditReply={onEditReply}
                      onDeleteReply={onDeleteReply}
                    />
                    {replyFormCommentId === c.id && onReplyComment && onCancelReply && (
                      <div style={{ margin: '-2px 16px 6px 60px' }}>
                        <div className="diff-comment-card" style={{ marginLeft: 0, marginRight: 0 }}>
                          <ReplyForm
                            commentId={c.id}
                            onSubmit={onReplyComment}
                            onCancel={onCancelReply}
                            mentionItems={mentionItems}
                          />
                        </div>
                      </div>
                    )}
                  </td>
                </tr>
              </Fragment>
            ))}
            {showForm && onAddComment && onCancelComment && (
              <tr>
                <td colSpan={3} style={{ padding: 0 }}>
                  <CommentForm
                    anchor={commentFormAnchor!}
                    onSubmit={onAddComment}
                    onCancel={onCancelComment}
                    mentionItems={mentionItems}
                  />
                </td>
              </tr>
            )}
          </Fragment>
        );
      })}
    </>
  );
}

// ============================================================================
// Split View
// ============================================================================

function SplitView({
  file,
  highlightedHunks,
  gapsByHunkIndex,
  expansions,
  fileLines,
  language,
  onExpandUp,
  onExpandDown,
  onExpandAll,
  codeSearchQuery,
  codeSearchCaseSensitive,
  ...commentProps
}: { file: DiffFile; highlightedHunks: string[][]; codeSearchQuery: string; codeSearchCaseSensitive: boolean } & ExpandProps & CommentProps) {
  return (
    <table className="diff-table diff-split">
      <colgroup>
        <col style={{ width: 40 }} />
        <col />
        <col style={{ width: 40 }} />
        <col />
      </colgroup>
      <tbody>
        {file.hunks.map((hunk, hunkIdx) => {
          const gap = gapsByHunkIndex.get(hunkIdx);
          const expansion = gap ? expansions.get(gap.gapIndex) : undefined;
          const ranges = getExpandedRanges(gap, expansion);
          return (
            <Fragment key={hunkIdx}>
              {ranges.top && gap && (
                <ExpandedContextRows
                  startLine={ranges.top.start}
                  endLine={ranges.top.end}
                  oldStartLine={gap.oldStartLine + (ranges.top.start - gap.startLine)}
                  fileLines={fileLines}
                  language={language}
                  viewType="split"
                  {...commentProps}
                  codeSearchQuery={codeSearchQuery}
                  codeSearchCaseSensitive={codeSearchCaseSensitive}
                />
              )}
              <SplitHunkRows
                hunk={hunk}
                highlightedCode={highlightedHunks[hunkIdx]}
                gap={gap}
                expansion={expansion}
                expandRangeBottom={ranges.bottom}
                fileLines={fileLines}
                expandLanguage={language}
                onExpandUp={onExpandUp}
                onExpandDown={onExpandDown}
                onExpandAll={onExpandAll}
                {...commentProps}
                  codeSearchQuery={codeSearchQuery}
                  codeSearchCaseSensitive={codeSearchCaseSensitive}
              />
            </Fragment>
          );
        })}
        {/* Trailing gap: remaining lines after last hunk */}
        {file.hunks.length > 0 && (() => {
          const trailingIndex = file.hunks.length;
          const trailingGap = gapsByHunkIndex.get(trailingIndex);
          const trailingExpansion = expansions.get(trailingIndex);
          const ranges = getExpandedRanges(trailingGap, trailingExpansion);
          const fullyExpanded = isGapFullyExpanded(trailingGap, trailingExpansion);

          if (fileLines && !trailingGap) return null;

          return (
            <>
              {ranges.top && trailingGap && (
                <ExpandedContextRows
                  startLine={ranges.top.start}
                  endLine={ranges.top.end}
                  oldStartLine={trailingGap.oldStartLine + (ranges.top.start - trailingGap.startLine)}
                  fileLines={fileLines}
                  language={language}
                  viewType="split"
                  {...commentProps}
                  codeSearchQuery={codeSearchQuery}
                  codeSearchCaseSensitive={codeSearchCaseSensitive}
                />
              )}
              {!fullyExpanded && (
                <tr className="diff-expand-row">
                  <td className="diff-gutter diff-hunk-gutter" />
                  <td className="diff-hunk-header" colSpan={3}>
                    <div className="diff-hunk-header-content">
                      {trailingGap ? (
                        <ExpandButtons
                          gap={trailingGap}
                          expansion={trailingExpansion}
                          onExpandUp={onExpandUp}
                          onExpandDown={onExpandDown}
                          onExpandAll={onExpandAll}
                        />
                      ) : (
                        <>
                          <span className="diff-expand-buttons">
                            <button onClick={() => onExpandDown(trailingIndex)} title="Expand 20 lines">
                              <ChevronDown style={{ width: 14, height: 14 }} />
                            </button>
                            <button onClick={() => onExpandAll(trailingIndex)} title="Expand all remaining lines">
                              <ChevronsUpDown style={{ width: 14, height: 14 }} />
                            </button>
                          </span>
                          <span className="diff-expand-label">remaining lines</span>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              )}
              {ranges.bottom && trailingGap && (
                <ExpandedContextRows
                  startLine={ranges.bottom.start}
                  endLine={ranges.bottom.end}
                  oldStartLine={trailingGap.oldStartLine + (ranges.bottom.start - trailingGap.startLine)}
                  fileLines={fileLines}
                  language={language}
                  viewType="split"
                  {...commentProps}
                  codeSearchQuery={codeSearchQuery}
                  codeSearchCaseSensitive={codeSearchCaseSensitive}
                />
              )}
            </>
          );
        })()}
      </tbody>
    </table>
  );
}

// ============================================================================
// Split HunkRows
// ============================================================================

function SplitHunkRows({
  hunk,
  highlightedCode,
  filePath,
  commentsByKey,
  highlightedLines,
  commentFormAnchor,
  onGutterClick,
  onAddComment,
  onDeleteComment,
  onCancelComment,
  replyFormCommentId,
  onOpenReplyForm,
  onReplyComment,
  onCancelReply,
  onResolveComment,
  onReopenComment,
  collapsedCommentIds,
  onCollapseComment,
  onExpandComment,
  onEditComment,
  onEditReply,
  onDeleteReply,
  mentionItems,
  gap,
  expansion,
  expandRangeBottom,
  fileLines,
  expandLanguage,
  onExpandUp,
  onExpandDown,
  onExpandAll,
  codeSearchQuery,
  codeSearchCaseSensitive,
}: { hunk: DiffHunk; highlightedCode?: string[]; codeSearchQuery: string; codeSearchCaseSensitive: boolean } & CommentProps & HunkExpandProps) {
  const pairs = buildSplitPairs(hunk.lines, highlightedCode);
  const gapExpanded = isGapFullyExpanded(gap, expansion);

  return (
    <>
      {/* Hunk header with expand buttons — hidden when gap is fully expanded */}
      {!gapExpanded && (
        <tr className={gap ? 'diff-expand-row' : ''}>
          <td className="diff-gutter diff-hunk-gutter" />
          <td className="diff-hunk-header" colSpan={3}>
            <div className="diff-hunk-header-content">
              {gap && (
                <ExpandButtons
                  gap={gap}
                  expansion={expansion}
                  onExpandUp={onExpandUp}
                  onExpandDown={onExpandDown}
                  onExpandAll={onExpandAll}
                />
              )}
              <span className="diff-hunk-header-text">{hunk.header}</span>
            </div>
          </td>
        </tr>
      )}
      {/* Bottom expanded lines */}
      {expandRangeBottom && gap && (
        <ExpandedContextRows
          startLine={expandRangeBottom.start}
          endLine={expandRangeBottom.end}
          oldStartLine={gap.oldStartLine + (expandRangeBottom.start - gap.startLine)}
          fileLines={fileLines}
          language={expandLanguage}
          viewType="split"
          filePath={filePath}
          commentsByKey={commentsByKey}
          highlightedLines={highlightedLines}
          commentFormAnchor={commentFormAnchor}
          onGutterClick={onGutterClick}
          onAddComment={onAddComment}
          onDeleteComment={onDeleteComment}
          onCancelComment={onCancelComment}
          replyFormCommentId={replyFormCommentId}
          onOpenReplyForm={onOpenReplyForm}
          onReplyComment={onReplyComment}
          onCancelReply={onCancelReply}
          onResolveComment={onResolveComment}
          onReopenComment={onReopenComment}
          collapsedCommentIds={collapsedCommentIds}
          onCollapseComment={onCollapseComment}
          onExpandComment={onExpandComment}
          onEditComment={onEditComment}
          onEditReply={onEditReply}
          onDeleteReply={onDeleteReply}
          mentionItems={mentionItems}
          codeSearchQuery={codeSearchQuery}
          codeSearchCaseSensitive={codeSearchCaseSensitive}
        />
      )}
      {pairs.map((pair, idx) => {
        const leftLineNum = pair.left?.old_line ?? null;
        const leftKey = leftLineNum != null ? `DELETE:${leftLineNum}` : null;
        const leftHighlighted = leftKey ? highlightedLines.has(leftKey) : false;
        const leftComments = leftKey ? (commentsByKey.get(leftKey) || []) : [];
        const expandedLeftComments = leftComments.filter((c) => !collapsedCommentIds?.has(c.id));
        const collapsedLeftCount = leftComments.length - expandedLeftComments.length;
        const showLeftForm = commentFormAnchor
          && commentFormAnchor.filePath === filePath
          && commentFormAnchor.side === 'DELETE'
          && leftLineNum != null
          && commentFormAnchor.endLine === leftLineNum;

        const rightLineNum = pair.right?.new_line ?? null;
        const rightKey = rightLineNum != null ? `ADD:${rightLineNum}` : null;
        const rightHighlighted = rightKey ? highlightedLines.has(rightKey) : false;
        const rightComments = rightKey ? (commentsByKey.get(rightKey) || []) : [];
        const expandedRightComments = rightComments.filter((c) => !collapsedCommentIds?.has(c.id));
        const collapsedRightCount = rightComments.length - expandedRightComments.length;
        const showRightForm = commentFormAnchor
          && commentFormAnchor.filePath === filePath
          && commentFormAnchor.side === 'ADD'
          && rightLineNum != null
          && commentFormAnchor.endLine === rightLineNum;

        const hasLeftComments = expandedLeftComments.length > 0 || showLeftForm;
        const hasRightComments = expandedRightComments.length > 0 || showRightForm;

        return (
          <Fragment key={idx}>
            <tr>
              <td
                className={`diff-gutter ${pair.left?.line_type === 'delete' ? 'diff-line-delete' : ''} ${leftHighlighted ? 'diff-line-highlighted' : ''} ${collapsedLeftCount > 0 ? 'has-collapsed-comment' : ''}`}
                onClick={(e) => {
                  if (collapsedLeftCount > 0 && onExpandComment) {
                    leftComments.filter((c) => collapsedCommentIds?.has(c.id)).forEach((c) => onExpandComment(c.id));
                    return;
                  }
                  if (leftLineNum != null && onGutterClick) {
                    onGutterClick(filePath, 'DELETE', leftLineNum, e.shiftKey);
                  }
                }}
                title={collapsedLeftCount > 0 ? `${collapsedLeftCount} hidden comment${collapsedLeftCount > 1 ? 's' : ''}` : (leftLineNum != null ? 'Click to add comment' : undefined)}
              >
                <span className="diff-gutter-content">
                  {collapsedLeftCount > 0 && (
                    <GutterAvatar name={leftComments.find((c) => collapsedCommentIds?.has(c.id))?.author ?? '?'} />
                  )}
                  {leftLineNum ?? ''}
                </span>
              </td>
              <td
                className={`diff-code ${
                  pair.left?.line_type === 'delete'
                    ? 'diff-line-delete'
                    : !pair.left
                      ? 'diff-code-empty'
                      : ''
                } ${leftHighlighted ? 'diff-line-highlighted' : ''}`}
                data-line={leftLineNum ?? undefined}
                data-side="DELETE"
              >
                {pair.left ? (
                  pair.left.html
                    ? <span dangerouslySetInnerHTML={{
                        __html: codeSearchQuery
                          ? highlightSearchInHTML(pair.left.html, codeSearchQuery, codeSearchCaseSensitive)
                          : pair.left.html
                      }} />
                    : highlightSearchMatches(pair.left.content, codeSearchQuery, codeSearchCaseSensitive)
                ) : ''}
              </td>
              <td
                className={`diff-gutter diff-gutter-split-middle ${pair.right?.line_type === 'insert' ? 'diff-line-insert' : ''} ${rightHighlighted ? 'diff-line-highlighted' : ''} ${collapsedRightCount > 0 ? 'has-collapsed-comment' : ''}`}
                onClick={(e) => {
                  if (collapsedRightCount > 0 && onExpandComment) {
                    rightComments.filter((c) => collapsedCommentIds?.has(c.id)).forEach((c) => onExpandComment(c.id));
                    return;
                  }
                  if (rightLineNum != null && onGutterClick) {
                    onGutterClick(filePath, 'ADD', rightLineNum, e.shiftKey);
                  }
                }}
                title={collapsedRightCount > 0 ? `${collapsedRightCount} hidden comment${collapsedRightCount > 1 ? 's' : ''}` : (rightLineNum != null ? 'Click to add comment' : undefined)}
              >
                <span className="diff-gutter-content">
                  {collapsedRightCount > 0 && (
                    <GutterAvatar name={rightComments.find((c) => collapsedCommentIds?.has(c.id))?.author ?? '?'} />
                  )}
                  {rightLineNum ?? ''}
                </span>
              </td>
              <td
                className={`diff-code ${
                  pair.right?.line_type === 'insert'
                    ? 'diff-line-insert'
                    : !pair.right
                      ? 'diff-code-empty'
                      : ''
                } ${rightHighlighted ? 'diff-line-highlighted' : ''}`}
                data-line={rightLineNum ?? undefined}
                data-side="ADD"
              >
                {pair.right ? (
                  pair.right.html
                    ? <span dangerouslySetInnerHTML={{
                        __html: codeSearchQuery
                          ? highlightSearchInHTML(pair.right.html, codeSearchQuery, codeSearchCaseSensitive)
                          : pair.right.html
                      }} />
                    : highlightSearchMatches(pair.right.content, codeSearchQuery, codeSearchCaseSensitive)
                ) : ''}
              </td>
            </tr>
            {(hasLeftComments || hasRightComments) && (
              <tr className="diff-split-comment-row">
                <td colSpan={2} style={{ padding: 0, verticalAlign: 'top' }}>
                  {expandedLeftComments.map((c) => (
                    <Fragment key={`lc-${c.id}`}>
                      <CommentCard
                        comment={c}
                        onDelete={onDeleteComment}
                        onReply={onOpenReplyForm}
                        onResolve={onResolveComment}
                        onReopen={onReopenComment}
                        onCollapse={onCollapseComment}
                        onExpand={onExpandComment}
                        isCollapsed={collapsedCommentIds?.has(c.id)}
                        onEdit={onEditComment}
                        onEditReply={onEditReply}
                        onDeleteReply={onDeleteReply}
                        mentionItems={mentionItems}
                      />
                      {replyFormCommentId === c.id && onReplyComment && onCancelReply && (
                        <div style={{ margin: '-2px 8px 6px 8px' }}>
                          <div className="diff-comment-card" style={{ marginLeft: 0, marginRight: 0 }}>
                            <ReplyForm
                              commentId={c.id}
                              onSubmit={onReplyComment}
                              onCancel={onCancelReply}
                              mentionItems={mentionItems}
                            />
                          </div>
                        </div>
                      )}
                    </Fragment>
                  ))}
                  {showLeftForm && onAddComment && onCancelComment && (
                    <CommentForm
                      anchor={commentFormAnchor!}
                      onSubmit={onAddComment}
                      onCancel={onCancelComment}
                      mentionItems={mentionItems}
                    />
                  )}
                </td>
                <td colSpan={2} style={{ padding: 0, verticalAlign: 'top' }}>
                  {expandedRightComments.map((c) => (
                    <Fragment key={`rc-${c.id}`}>
                      <CommentCard
                        comment={c}
                        onDelete={onDeleteComment}
                        onReply={onOpenReplyForm}
                        onResolve={onResolveComment}
                        onReopen={onReopenComment}
                        onCollapse={onCollapseComment}
                        onExpand={onExpandComment}
                        isCollapsed={collapsedCommentIds?.has(c.id)}
                        onEdit={onEditComment}
                        onEditReply={onEditReply}
                        onDeleteReply={onDeleteReply}
                        mentionItems={mentionItems}
                      />
                      {replyFormCommentId === c.id && onReplyComment && onCancelReply && (
                        <div style={{ margin: '-2px 8px 6px 8px' }}>
                          <div className="diff-comment-card" style={{ marginLeft: 0, marginRight: 0 }}>
                            <ReplyForm
                              commentId={c.id}
                              onSubmit={onReplyComment}
                              onCancel={onCancelReply}
                              mentionItems={mentionItems}
                            />
                          </div>
                        </div>
                      )}
                    </Fragment>
                  ))}
                  {showRightForm && onAddComment && onCancelComment && (
                    <CommentForm
                      anchor={commentFormAnchor!}
                      onSubmit={onAddComment}
                      onCancel={onCancelComment}
                      mentionItems={mentionItems}
                    />
                  )}
                </td>
              </tr>
            )}
          </Fragment>
        );
      })}
    </>
  );
}

// ============================================================================
// Split pair builder
// ============================================================================

interface SplitPairSide {
  old_line?: number | null;
  new_line?: number | null;
  content: string;
  html?: string;
  line_type: string;
}

interface SplitPair {
  left: SplitPairSide | null;
  right: SplitPairSide | null;
}

function buildSplitPairs(lines: DiffFile['hunks'][0]['lines'], highlightedCode?: string[]): SplitPair[] {
  const pairs: SplitPair[] = [];
  const deletes: { idx: number; line: typeof lines[0] }[] = [];
  const inserts: { idx: number; line: typeof lines[0] }[] = [];

  const getHtml = (idx: number) => highlightedCode?.[idx];

  const flushDeleteInsert = () => {
    const max = Math.max(deletes.length, inserts.length);
    for (let i = 0; i < max; i++) {
      pairs.push({
        left: deletes[i]
          ? { old_line: deletes[i].line.old_line, content: deletes[i].line.content, html: getHtml(deletes[i].idx), line_type: 'delete' }
          : null,
        right: inserts[i]
          ? { new_line: inserts[i].line.new_line, content: inserts[i].line.content, html: getHtml(inserts[i].idx), line_type: 'insert' }
          : null,
      });
    }
    deletes.length = 0;
    inserts.length = 0;
  };

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    if (line.line_type === 'delete') {
      deletes.push({ idx: lineIdx, line });
    } else if (line.line_type === 'insert') {
      inserts.push({ idx: lineIdx, line });
    } else {
      flushDeleteInsert();
      const html = getHtml(lineIdx);
      pairs.push({
        left: { old_line: line.old_line, content: line.content, html, line_type: 'context' },
        right: { new_line: line.new_line, content: line.content, html, line_type: 'context' },
      });
    }
  }
  flushDeleteInsert();

  return pairs;
}

// ============================================================================
// Full File View (for viewMode='full')
// ============================================================================

interface FullFileViewProps extends CommentProps {
  file: DiffFile;
  content: string;
  language: string | undefined;
  viewType: 'unified' | 'split';
}

function FullFileView({ content, language, ...commentProps }: FullFileViewProps) {
  const lines = useMemo(() => content.split('\n'), [content]);
  const htmlLines = useMemo(() => highlightLines(lines, language), [lines, language]);

  // Full Files mode always uses unified style with single line numbers
  return (
    <table className="diff-table">
      <tbody>
        {lines.map((line, idx) => {
          const lineNum = idx + 1;
          const lineKey = `ADD:${lineNum}`;
          const isHighlighted = commentProps.highlightedLines?.has(lineKey) || false;
          const lineComments = commentProps.commentsByKey?.get(lineKey) || [];
          const expandedComments = lineComments.filter((c) => !commentProps.collapsedCommentIds?.has(c.id));
          const collapsedCount = lineComments.length - expandedComments.length;

          const showForm = commentProps.commentFormAnchor
            && commentProps.commentFormAnchor.filePath === commentProps.filePath
            && commentProps.commentFormAnchor.side === 'ADD'
            && commentProps.commentFormAnchor.endLine === lineNum;

          const hasComments = expandedComments.length > 0 || showForm;

          const contentHtml = htmlLines?.[idx]
            ? <span dangerouslySetInnerHTML={{ __html: htmlLines[idx] }} />
            : line;

          return (
            <Fragment key={lineNum}>
              <tr className={`diff-line-full ${isHighlighted ? 'diff-line-highlighted' : ''}`} data-line={lineNum} data-side="ADD">
                <td
                  className={`diff-gutter ${isHighlighted ? 'diff-line-highlighted' : ''} ${collapsedCount > 0 ? 'has-collapsed-comment' : ''}`}
                  onClick={(e) => {
                    if (collapsedCount > 0 && commentProps.onExpandComment) {
                      lineComments.filter((c) => commentProps.collapsedCommentIds?.has(c.id)).forEach((c) => commentProps.onExpandComment!(c.id));
                      return;
                    }
                    if (commentProps.onGutterClick) {
                      commentProps.onGutterClick(commentProps.filePath, 'ADD', lineNum, e.shiftKey);
                    }
                  }}
                  title={collapsedCount > 0 ? `${collapsedCount} hidden comment${collapsedCount > 1 ? 's' : ''}` : 'Click to add comment'}
                >
                  <span className="diff-gutter-content">
                    {collapsedCount > 0 && (
                      <GutterAvatar name={lineComments.find((c) => commentProps.collapsedCommentIds?.has(c.id))?.author ?? '?'} />
                    )}
                    {lineNum}
                  </span>
                </td>
                <td className={`diff-code ${isHighlighted ? 'diff-line-highlighted' : ''}`}>
                  <span className="diff-code-prefix">{' '}</span>
                  {contentHtml}
                </td>
              </tr>
              {hasComments && (
                <tr>
                  <td colSpan={2} style={{ padding: 0 }}>
                    {expandedComments.map((c) => (
                      <Fragment key={`comment-${c.id}`}>
                        <CommentCard comment={c} onDelete={commentProps.onDeleteComment} onReply={commentProps.onOpenReplyForm} onResolve={commentProps.onResolveComment} onReopen={commentProps.onReopenComment} onCollapse={commentProps.onCollapseComment} onExpand={commentProps.onExpandComment} isCollapsed={commentProps.collapsedCommentIds?.has(c.id)} onEdit={commentProps.onEditComment} onEditReply={commentProps.onEditReply} onDeleteReply={commentProps.onDeleteReply} mentionItems={commentProps.mentionItems} />
                        {commentProps.replyFormCommentId === c.id && commentProps.onReplyComment && commentProps.onCancelReply && (
                          <div style={{ margin: '-2px 16px 6px 60px' }}>
                            <div className="diff-comment-card" style={{ marginLeft: 0, marginRight: 0 }}>
                              <ReplyForm commentId={c.id} onSubmit={commentProps.onReplyComment} onCancel={commentProps.onCancelReply} mentionItems={commentProps.mentionItems} />
                            </div>
                          </div>
                        )}
                      </Fragment>
                    ))}
                    {showForm && commentProps.onAddComment && commentProps.onCancelComment && (
                      <CommentForm anchor={commentProps.commentFormAnchor!} onSubmit={commentProps.onAddComment} onCancel={commentProps.onCancelComment} mentionItems={commentProps.mentionItems} />
                    )}
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}
