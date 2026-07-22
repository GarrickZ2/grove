import { useState, useEffect, useCallback, useRef } from "react";
import Editor, { type Monaco } from "@monaco-editor/react";
import { X, FileCode, Eye, Columns2, Loader2, Save, Maximize2, Minimize2, PanelLeftOpen, PanelLeftClose, RefreshCw, AlertCircle, ZoomIn, ZoomOut } from "lucide-react";
import { Button, getPreviewType, ImageLightbox } from "../../ui";
import { getPreviewRenderer } from "../../Review/previewRenderers";

function rewriteHtmlUrls(html: string, projectId: string, taskId: string, parentDir: string): string {
  const apiBase = `/api/v1/projects/${projectId}/tasks/${taskId}/file/raw?path=`;
  return html.replace(
    /(src|href)\s*=\s*(['"])([^'"]+)\2/gi,
    (match, attr, quote, url) => {
      const trimmedUrl = url.trim();
      if (
        /^(https?:\/\/|\/\/|data:|blob:|mailto:|tel:|#)/i.test(trimmedUrl) ||
        trimmedUrl.startsWith('/')
      ) {
        return match;
      }
      const resolvedPath = parentDir + trimmedUrl;
      const rewrittenUrl = apiBase + encodeURIComponent(resolvedPath);
      return `${attr}=${quote}${rewrittenUrl}${quote}`;
    }
  );
}
import { FileTree } from "./FileTree";
import type { FileTreeNode } from "../../../utils/fileTree";
import { useIsMobile } from "../../../hooks";
import { useTheme } from "../../../context";
import {
  getTaskDirEntries,
  getFileContent,
  writeFileContent,
  createFile,
  createDirectory,
  deleteFileOrDir,
  moveFileOrDir,
  openTaskFile,
  lookupSymbol,
  getTask,
  getConfig,
} from "../../../api";
import type { DirEntry } from "../../../api";
import { FileContextMenu, type ContextMenuPosition, type ContextMenuTarget } from "./FileContextMenu";
import { ConfirmDialog } from "../../Dialogs/ConfirmDialog";
import { useCommand, useDefineCommand, useContextKey } from "../../../keyboard";
import "./task-editor.css";
import { motion, AnimatePresence } from "framer-motion";

interface TaskEditorProps {
  projectId: string;
  taskId: string;
  onClose: () => void;
  /** Whether this panel is in fullscreen mode */
  fullscreen?: boolean;
  /** Toggle fullscreen mode */
  onToggleFullscreen?: () => void;
  /** Hide the editor header (for FlexLayout tabs) */
  hideHeader?: boolean;
}

/** Map file extensions to Monaco language IDs */
function getLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    rs: 'rust',
    ts: 'typescript',
    tsx: 'typescriptreact',
    js: 'javascript',
    jsx: 'javascriptreact',
    json: 'json',
    jsonl: 'json',
    toml: 'ini',
    yaml: 'yaml',
    yml: 'yaml',
    md: 'markdown',
    css: 'css',
    scss: 'scss',
    html: 'html',
    xml: 'xml',
    sql: 'sql',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    py: 'python',
    go: 'go',
    java: 'java',
    kt: 'kotlin',
    swift: 'swift',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    rb: 'ruby',
    php: 'php',
    lua: 'lua',
    r: 'r',
    dart: 'dart',
    dockerfile: 'dockerfile',
    graphql: 'graphql',
    svg: 'xml',
    kdl: 'plaintext',
    lock: 'plaintext',
    mmd: 'mermaid',
    mermaid: 'mermaid',
  };
  // Handle special filenames
  const name = filePath.split('/').pop()?.toLowerCase() || '';
  if (name === 'dockerfile') return 'dockerfile';
  if (name === 'makefile') return 'makefile';
  return map[ext] || 'plaintext';
}

/**
 * Wire up symbol navigation on a Monaco editor instance.
 *
 *  - Hold ⌘ (or Ctrl on non-mac) and move the mouse → the word under
 *    the cursor gets a blue underline. This is purely visual: no API
 *    call, no symbol-defined check. The underline is a hint that the
 *    token is clickable.
 *  - Click while still holding ⌘ → fires `lookupSymbol`; if the backend
 *    returns at least one candidate, jump to the top one (same-file
 *    reveal or cross-file load via handleSelectFile).
 *
 * The two events are deliberately decoupled — "is this clickable" and
 * "where does it go" are independent concerns.
 *
 * Multi-editor correctness: the DefinitionProvider and `openCodeEditor`
 * override are registered exactly once per process, against a global
 * `editorRegistry`. Each TaskEditor instance registers its
 * (projectId, taskId, refs) on mount under a unique session id, and
 * unregisters on unmount. The synthetic `grove-file://` URIs we hand to
 * Monaco's peek widget include the session id so cross-file jumps and
 * peek previews route back to the originating editor instance —
 * different TaskEditors with the same relative file path don't collide.
 */
// monaco-editor's surface is loosely typed across versions.
/* eslint-disable @typescript-eslint/no-explicit-any */
type EditorEntry = {
  projectId: string;
  taskId: string;
  monaco: any;
  // Latest selectedFile, captured by ref so the global provider sees
  // current React state without re-registering.
  selectedFileRef: React.MutableRefObject<string | null>;
  pendingJumpRef: React.MutableRefObject<{ file: string; line: number; col: number } | null>;
  handleSelectFileRef: React.MutableRefObject<(path: string) => Promise<void>>;
  // Live editor handle, used by the openCodeEditor override to reveal
  // / focus when the jump target is the same file.
  editor: any;
};

const editorRegistry = new Map<string, EditorEntry>();
const registeredProviderLangs = new Set<string>();
let editorServiceHooked = false;

function isGroveFileScheme(scheme: string | undefined): scheme is 'grove-file' {
  return scheme === 'grove-file';
}

/** Synthetic URI: grove-file://<sessionId>/<rel-path>.
 *
 *  Use `monaco.Uri.from({ scheme, authority, path })` rather than
 *  `Uri.parse` over a percent-encoded string. The `from` constructor
 *  takes the path as a raw value and stores it verbatim; reading
 *  `uri.path` later returns the same raw string. If we instead handed
 *  Monaco a percent-encoded path string via `Uri.parse`, Monaco
 *  decodes it once on its own — round-tripping through us would then
 *  need exactly one more decode, which is fragile (`encodeURIComponent`
 *  / `decodeURIComponent` are not strictly inverse for already-encoded
 *  inputs like a real file named `100%20.txt`).
 */
function buildGroveUri(monaco: any, sessionId: string, filePath: string): any {
  // Path must start with `/` per the URI grammar Monaco expects.
  return monaco.Uri.from({
    scheme: 'grove-file',
    authority: sessionId,
    path: `/${filePath}`,
  });
}

function parseGroveUri(uri: any): { sessionId: string; filePath: string } | null {
  if (!uri || !isGroveFileScheme(uri.scheme)) return null;
  const sessionId = (uri.authority as string) || '';
  // `uri.path` returns the raw path we stored via `Uri.from`. No
  // additional decoding is needed — and applying decodeURIComponent
  // here would corrupt file names containing literal `%XX` sequences
  // (e.g. `100%20.txt` would become `100 .txt`).
  const filePath = (uri.path as string).replace(/^\//, '');
  if (!sessionId) return null;
  return { sessionId, filePath };
}

async function ensureGlobalEditorServiceHook(editor: any) {
  if (editorServiceHooked) return;
  const editorService = (editor as any)._codeEditorService;
  if (!editorService) {
    // Monaco internals may shift across versions and not always expose
    // `_codeEditorService` synchronously on first mount. Don't latch
    // the global flag — leave it false so a later mount can retry.
    return;
  }
  if ((editorService as any)._groveSymbolHooked) {
    editorServiceHooked = true;
    return;
  }
  const openBase = editorService.openCodeEditor.bind(editorService);
  (editorService as any)._groveSymbolHooked = true;
  editorServiceHooked = true;
  editorService.openCodeEditor = async (input: any, source: any) => {
    const parsed = parseGroveUri(input?.resource);
    if (parsed) {
      const entry = editorRegistry.get(parsed.sessionId);
      if (entry) {
        const sel = input?.options?.selection;
        const targetLine = sel ? (sel.startLineNumber as number) - 1 : 0;
        const targetCol = sel ? (sel.startColumn as number) - 1 : 0;
        const target = entry.editor;
        if (parsed.filePath === entry.selectedFileRef.current) {
          target.revealLineInCenter(targetLine + 1);
          target.setPosition({ lineNumber: targetLine + 1, column: targetCol + 1 });
          target.focus();
        } else {
          entry.pendingJumpRef.current = { file: parsed.filePath, line: targetLine, col: targetCol };
          await entry.handleSelectFileRef.current(parsed.filePath);
        }
        return source;
      }
    }
    return await openBase(input, source);
  };
}

/** Map a backend language id to Monaco's language id. */
function monacoLangIdFor(langId: string): string {
  switch (langId) {
    case 'go':
      return 'go';
    default:
      return langId;
  }
}

async function ensureDefinitionProvidersRegistered(monaco: any) {
  // Register one provider per backend-supported language, filtered by
  // the user's deny-list. Idempotent at the language level so we don't
  // stack providers if the editor mounts again.
  //
  // Known limitation: `registeredProviderLangs` is process-scoped and
  // never trimmed. If the user later adds a language to
  // `disabled_languages` via Settings, the already-registered provider
  // keeps firing `lookupSymbol` for that language; the backend returns
  // an empty result so the user sees no candidates, but the RPC is
  // wasted. Acceptable today — the deny-list is rarely toggled at
  // runtime — but worth revisiting if we ship more languages.
  let langs: string[] = [];
  try {
    const cfg = await getConfig();
    const disabled = new Set(cfg.indexing?.disabled_languages ?? []);
    const supported = cfg.indexing?.supported_languages ?? [];
    langs = supported
      .map((l) => l.id)
      .filter((id) => !disabled.has(id))
      .map(monacoLangIdFor);
  } catch {
    // Config fetch failed (rare): fall back to the only language we
    // ship a backend extractor for today.
    langs = ['go'];
  }

  for (const lang of langs) {
    if (registeredProviderLangs.has(lang)) continue;
    registeredProviderLangs.add(lang);
    monaco.languages.registerDefinitionProvider(lang, {
      provideDefinition: async (model: any, position: any) => {
        // Find the editor that owns this model, then look up its
        // (projectId, taskId) in the registry. This dispatches
        // correctly across multiple TaskEditor instances.
        const editors = (monaco.editor.getEditors?.() as any[]) || [];
        const owner = editors.find((e: any) => e.getModel?.() === model);
        if (!owner) return null;
        const sessionId = owner.getId?.() as string | undefined;
        if (!sessionId) return null;
        const entry = editorRegistry.get(sessionId);
        if (!entry) return null;

        const word = model.getWordAtPosition?.(position);
        if (!word?.word) return null;
        let candidates;
        try {
          candidates = await lookupSymbol(
            entry.projectId,
            entry.taskId,
            word.word,
            entry.selectedFileRef.current ?? undefined,
            position.lineNumber - 1,
          );
        } catch {
          return null;
        }
        if (candidates.length === 0) return null;

        // Pre-fetch content for each unique candidate file so the peek
        // widget can render previews. URIs are namespaced by sessionId
        // so two TaskEditors for different tasks but same rel path
        // don't share a (potentially mismatched) model.
        const uniqueFiles = Array.from(new Set(candidates.map((c) => c.file_path)));
        await Promise.all(
          uniqueFiles.map(async (fp) => {
            const uri = buildGroveUri(monaco, sessionId, fp);
            if (monaco.editor.getModel(uri)) return;
            try {
              const res = await getFileContent(entry.projectId, entry.taskId, fp);
              if (!monaco.editor.getModel(uri)) {
                monaco.editor.createModel(res.content, getLanguage(fp), uri);
              }
            } catch {
              // Peek preview falls back to blank; click-to-navigate
              // still works.
            }
          }),
        );

        return candidates.map((c) => ({
          uri: buildGroveUri(monaco, sessionId, c.file_path),
          range: new monaco.Range(
            c.line + 1,
            c.col + 1,
            c.line + 1,
            c.col + 1 + c.name.length,
          ),
        }));
      },
    });
  }
}

/**
 * Attach mouse/keyboard hover-underline listeners to the editor.
 * Returns disposables; caller must dispose on unmount.
 */
function attachUnderlineListeners(editor: any, monaco: any): { dispose: () => void }[] {
  let underlineDecorations: string[] = [];

  const clearUnderline = () => {
    if (underlineDecorations.length === 0) return;
    underlineDecorations = editor.deltaDecorations(underlineDecorations, []);
  };

  const setUnderlineAt = (lineNumber: number, startCol: number, endCol: number) => {
    underlineDecorations = editor.deltaDecorations(underlineDecorations, [
      {
        range: new monaco.Range(lineNumber, startCol, lineNumber, endCol),
        options: { inlineClassName: 'grove-symbol-link' },
      },
    ]);
  };

  const d1 = editor.onMouseMove((e: any) => {
    const browserEvent = e?.event?.browserEvent as MouseEvent | undefined;
    const cmd = browserEvent?.metaKey || browserEvent?.ctrlKey;
    if (!cmd) {
      clearUnderline();
      return;
    }
    const position = e?.target?.position;
    if (!position) {
      clearUnderline();
      return;
    }
    const model = editor.getModel?.();
    if (!model) return;
    const word = model.getWordAtPosition?.(position);
    if (!word) {
      clearUnderline();
      return;
    }
    setUnderlineAt(position.lineNumber, word.startColumn, word.endColumn);
  });

  const d2 = editor.onMouseLeave(clearUnderline);

  const d3 = editor.onKeyUp((e: any) => {
    const ev = e?.browserEvent as KeyboardEvent | undefined;
    if (!ev) return;
    if (!ev.metaKey && !ev.ctrlKey) {
      clearUnderline();
    }
  });

  return [d1, d2, d3];
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Map a flat DirEntry list to FileTreeNode[] for the file tree */
function dirEntriesToNodes(entries: { path: string; is_dir: boolean }[]): FileTreeNode[] {
  return entries
    .sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      return a.path.localeCompare(b.path);
    })
    .map(e => {
      const name = e.path.split('/').pop() || e.path;
      return { name, path: e.path, isDir: e.is_dir, children: e.is_dir ? [] : undefined };
    });
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const registerMermaidLanguage = (monaco: any) => {
  if (!monaco) return;
  if (monaco.languages.getLanguages().some((lang: any) => lang.id === 'mermaid')) {
    return;
  }

  monaco.languages.register({ id: 'mermaid' });

  monaco.languages.setMonarchTokensProvider('mermaid', {
    keywords: [
      'graph', 'flowchart', 'sequenceDiagram', 'gantt', 'classDiagram',
      'stateDiagram', 'stateDiagram-v2', 'erDiagram', 'pie', 'journey',
      'gitGraph', 'subgraph', 'end', 'direction', 'style', 'classDef',
      'class', 'click', 'linkStyle', 'callback'
    ],
    arrows: [
      '-->', '---', '-.->', '==>', '-->|', '-.->|', '==>|',
      '<-.-', '<--', '<==', '<-->', '<==>', '<--|', '==|', '--|'
    ],
    tokenizer: {
      root: [
        // Comments
        [/%%.*$/, 'comment'],
        
        // Strings
        [/"[^"]*"/, 'string'],
        
        // Keywords
        [/[a-zA-Z-v2]+/, {
          cases: {
            '@keywords': 'keyword',
            '@default': 'identifier'
          }
        }],

        // Arrows / connectors
        [/(-{2,}>|\.-{2,}>|={2,}>|-{2,}|<-{2,}|<={2,})/, 'tag'],

        // Labels / shapes
        [/[{}()[\]]+/, 'delimiter'],
      ]
    }
  });
};
/* eslint-enable @typescript-eslint/no-explicit-any */

// 'image' and 'binary' previews must never write through Monaco — they're
// either raster data or non-text formats (xlsx, etc.) that getFileContent()
// would return as garbled text. Saving that text via writeFileContent
// would corrupt the original file.
const isReadOnlyPreview = (path: string) => {
  const t = getPreviewType(path);
  return t === 'image' || t === 'binary';
};

export function TaskEditor({ projectId, taskId, onClose, fullscreen = false, onToggleFullscreen, hideHeader = false }: TaskEditorProps) {
  const { isMobile } = useIsMobile();
  const { theme } = useTheme();
  const [fileNodes, setFileNodes] = useState<FileTreeNode[]>([]);
  // Bumped on every refresh/reload. Threaded into FileTree so expanded
  // directories re-fetch their children IN PLACE (without remounting and
  // losing expansion state), and appended to image URLs as a cache-buster so
  // a Refresh shows the latest bytes instead of the browser-cached copy.
  const [refreshSignal, setRefreshSignal] = useState(0);

  // Cache-buster for image/media preview URLs. Bumped every time a file is
  // opened and on Refresh, so the webview (WKWebView caches images
  // aggressively, even with `no-cache`) always re-fetches the current bytes
  // instead of serving a stale copy for the same path. `imageNonceFile` tracks
  // the file the nonce was last bumped for, so the render-time adjustment only
  // fires on an actual file switch.
  const [imageNonce, setImageNonce] = useState(0);
  const [imageNonceFile, setImageNonceFile] = useState<string | null>(null);
  const [monacoInstance, setMonacoInstance] = useState<Monaco | null>(null);

  // Dynamically adapt Monaco Editor background and text colors to match active theme
  useEffect(() => {
    if (!monacoInstance) return;

    // Use theme.isLight (canonical), not id-substring sniffing — custom themes
    // have ids like "custom-<uuid>" that don't contain any of these markers.
    const isLight = theme.isLight;
    
    // For light mode comments, we use a darker gray to improve readability on light backgrounds.
    // Standard comments are often too faint.
    const commentColor = isLight ? '4b5563' : '9ca3af'; 
    const commentDocColor = isLight ? '374151' : '9ca3af';

    const hex = (c: string) => c.replace('#', '');
    const colors = theme.colors;
    
    // High-contrast overrides for light mode to ensure readability
    // In light mode, theme colors like 'info' or 'accent' might be too bright/light.
    // We prefer darker, more saturated versions for the code.
    const keywordColor = isLight ? '0550ae' : hex(colors.info);      // Saturated Blue
    const typeColor = isLight ? '953800' : hex(colors.accent);       // Saturated Brown/Orange
    const stringColor = isLight ? '0a3069' : hex(colors.success);    // Deep Navy/Green
    const variableColor = isLight ? 'e36209' : hex(colors.warning);  // Darker Orange
    const numberColor = isLight ? '005cc5' : hex(colors.warning);    // Saturated Blue
    const identifierColor = isLight ? '111827' : hex(colors.text);   // Near Black
    const tagColor = isLight ? '116329' : hex(colors.highlight);    // Saturated Green
    const attributeColor = isLight ? '005cc5' : hex(colors.info);    // Saturated Blue

    monacoInstance.editor.defineTheme('grove-theme', {
      base: isLight ? 'vs' : 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: commentColor },
        { token: 'comment.doc', foreground: commentDocColor },
        // Explicit rules for better legibility using high-contrast colors
        { token: 'keyword', foreground: keywordColor, fontStyle: 'bold' },
        { token: 'type', foreground: typeColor },
        { token: 'type.identifier', foreground: typeColor },
        { token: 'string', foreground: stringColor },
        { token: 'variable', foreground: variableColor },
        { token: 'variable.parameter', foreground: variableColor },
        { token: 'number', foreground: numberColor },
        { token: 'identifier', foreground: identifierColor },
        { token: 'tag', foreground: tagColor },
        { token: 'attribute.name', foreground: attributeColor },
        { token: 'operator', foreground: identifierColor },
        { token: 'delimiter', foreground: isLight ? '374151' : hex(colors.textMuted) },
        { token: 'meta', foreground: keywordColor },
        { token: 'support', foreground: typeColor },
        { token: 'predefined', foreground: keywordColor },
        { token: 'annotation', foreground: typeColor },
        // Special case for GraphQL fields which often come as 'identifier'
        { token: 'key', foreground: identifierColor },
        { token: 'string.key', foreground: identifierColor },
      ],
      colors: {
        'editor.background': theme.colors.bg,
        'editor.foreground': theme.colors.text,
        'editor.lineHighlightBackground': isLight ? '#00000008' : '#ffffff08',
        'editorGutter.background': theme.colors.bg,
        'editorLineNumber.foreground': isLight ? '#6b7280' : '#888888',
        'editorLineNumber.activeForeground': theme.colors.text,
        'editorIndentGuide.background': isLight ? '#00000012' : '#ffffff12',
        'editorIndentGuide.activeBackground': isLight ? '#00000024' : '#ffffff24',
        'editor.selectionBackground': isLight ? '#00000015' : '#ffffff15',
      }
    });
    monacoInstance.editor.setTheme('grove-theme');
  }, [theme, monacoInstance]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileTreeVisible, setFileTreeVisible] = useState(true);

  // Resizable file tree sidebar width (desktop only — mobile uses fixed overlay).
  // Persisted per task so reopening the panel keeps the user's layout.
  const DEFAULT_FILE_TREE_WIDTH = 250;
  const SIDEBAR_MIN_WIDTH = 180;
  const SIDEBAR_MAX_RATIO = 0.5;
  const fileTreeWidthStorageKey = `grove:editor-file-tree-width:${projectId}:${taskId}`;

  const [fileTreeWidth, setFileTreeWidth] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(fileTreeWidthStorageKey);
      if (!raw) return DEFAULT_FILE_TREE_WIDTH;
      const parsed = JSON.parse(raw) as { width?: number };
      const w = parsed.width;
      return typeof w === 'number' && Number.isFinite(w) && w >= SIDEBAR_MIN_WIDTH
        ? w
        : DEFAULT_FILE_TREE_WIDTH;
    } catch {
      return DEFAULT_FILE_TREE_WIDTH;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(
        fileTreeWidthStorageKey,
        JSON.stringify({ width: Math.round(fileTreeWidth) }),
      );
    } catch {
      // ignore storage errors
    }
  }, [fileTreeWidth, fileTreeWidthStorageKey]);

  const clampFileTreeWidth = (value: number, layoutWidth: number): number => {
    const max = Math.max(SIDEBAR_MIN_WIDTH, Math.floor(layoutWidth * SIDEBAR_MAX_RATIO));
    return Math.min(max, Math.max(SIDEBAR_MIN_WIDTH, value));
  };

  const startFileTreeResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const layoutEl = event.currentTarget.parentElement;
    if (!layoutEl) return;
    const layoutWidth = layoutEl.getBoundingClientRect().width;
    if (layoutWidth <= 0) return;
    const startX = event.clientX;
    const startWidth = fileTreeWidth;

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const next = clampFileTreeWidth(
        startWidth + (moveEvent.clientX - startX),
        layoutWidth,
      );
      setFileTreeWidth(next);
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
  }, [fileTreeWidth]);
  const [fileContent, setFileContent] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [modified, setModified] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'code' | 'preview' | 'split'>('code');
  const [contentVersion, setContentVersion] = useState(0);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [lightboxSvg, setLightboxSvg] = useState<string | null>(null);
  const [editorFocused, setEditorFocused] = useState(false);
  const [fontSize, setFontSize] = useState<number>(() => {
    const saved = localStorage.getItem("grove:editor.fontSize");
    return saved ? parseInt(saved, 10) : 13;
  });

  const handleZoomIn = useCallback(() => {
    setFontSize((prev) => {
      const next = Math.min(prev + 1, 30);
      localStorage.setItem("grove:editor.fontSize", String(next));
      return next;
    });
  }, []);

  const handleZoomOut = useCallback(() => {
    setFontSize((prev) => {
      const next = Math.max(prev - 1, 9);
      localStorage.setItem("grove:editor.fontSize", String(next));
      return next;
    });
  }, []);

  const handleZoomReset = useCallback(() => {
    setFontSize(13);
    localStorage.setItem("grove:editor.fontSize", "13");
  }, []);
  const editorContentRef = useRef<string>('');

  // Symbol jump (cmd+click navigation):
  //  - editorRef:     handle to the Monaco editor instance
  //  - selectedFileRef: latest selectedFile for closure capture inside the
  //    DefinitionProvider (which is registered once on mount and otherwise
  //    can't see the React state)
  //  - pendingJumpRef: target line/col to apply after a cross-file load
  //    finishes (the new file's content loads asynchronously)
  // monaco-editor's IStandaloneCodeEditor type is heavy; loosely typed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const editorRef = useRef<any>(null);
  const selectedFileRef = useRef<string | null>(null);
  const pendingJumpRef = useRef<{ file: string; line: number; col: number } | null>(null);

  useEffect(() => {
    selectedFileRef.current = selectedFile;
  }, [selectedFile]);

  // Context menu state
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [contextMenuPosition, setContextMenuPosition] = useState<ContextMenuPosition>({ x: 0, y: 0 });
  const [contextMenuTarget, setContextMenuTarget] = useState<ContextMenuTarget | null>(null);

  // Task path (for "Copy Full Path")
  const [taskPath, setTaskPath] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    // Fetch this task by id rather than scanning the task list: `listTasks`
    // omits the Local Task (`_local`), so the old list-and-find approach left
    // `taskPath` null for it and greyed out "Copy Full Path". `getTask`
    // resolves both worktree-backed and local tasks.
    getTask(projectId, taskId, ac.signal)
      .then((task) => {
        if (!ac.signal.aborted) setTaskPath(task.path);
      })
      .catch(() => {
        // Aborted requests / transient errors — fine to swallow; the button
        // simply stays disabled until a later mount retries.
      });
    return () => ac.abort();
  }, [projectId, taskId]);

  // Inline creation state
  const [creatingPath, setCreatingPath] = useState<{ type: 'file' | 'directory'; parentPath: string; depth: number } | null>(null);

  // Delete confirmation
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  // Hide file tree by default on mobile. Tracked-prev pattern so the reset
  // happens during render — avoids a setState-in-effect cascade.
  const [prevIsMobile, setPrevIsMobile] = useState(isMobile);
  if (prevIsMobile !== isMobile) {
    setPrevIsMobile(isMobile);
    if (isMobile) setFileTreeVisible(false);
  }

  // Load file list on mount
  useEffect(() => {
    getTaskDirEntries(projectId, taskId, '')
      .then((res) => setFileNodes(dirEntriesToNodes(res.entries)))
      .catch((err) => setError(err.message || 'Failed to load files'));
  }, [projectId, taskId]);

  const handleSelectFile = useCallback(async (path: string) => {
    if (path === selectedFile) return;

    // Save any dirty content on the previously selected file BEFORE switching,
    // otherwise the ref-sync effect would capture {modified:false, content:newFile}
    // and the unmount auto-save would never save the old file's edits.
    if (modified && selectedFile && !isReadOnlyPreview(selectedFile)) {
      try {
        await writeFileContent(projectId, taskId, selectedFile, editorContentRef.current);
      } catch (err) {
        const msg = err instanceof Error ? err.message :
          (err as { message?: string })?.message || 'Failed to save file before switch';
        setError(msg);
        return; // abort the switch so the user can resolve manually
      }
    }

    setSelectedFile(path);
    setLoading(true);
    setModified(false);
    setError(null);
    setViewMode('code');

    // On mobile, close file tree after selecting
    if (isMobile) setFileTreeVisible(false);

    if (isReadOnlyPreview(path)) {
      setFileContent('');
      editorContentRef.current = '';
      setLoading(false);
      return;
    }

    try {
      const res = await getFileContent(projectId, taskId, path);
      setFileContent(res.content);
      editorContentRef.current = res.content;
    } catch (err) {
      const msg = err instanceof Error ? err.message :
        (err as { message?: string })?.message || 'Failed to load file';
      setError(msg);
      setFileContent('');
    }
    setLoading(false);
  }, [projectId, taskId, selectedFile, isMobile, modified]);

  // After cross-file jumps, position the cursor once the new file's
  // content has rendered into Monaco. We watch fileContent (not just
  // selectedFile) so the move waits until lines actually exist.
  useEffect(() => {
    const target = pendingJumpRef.current;
    const editor = editorRef.current;
    if (!target || !editor || target.file !== selectedFile) return;
    if (!fileContent) return;

    pendingJumpRef.current = null;
    // Backend uses 0-indexed line/col; Monaco wants 1-indexed.
    const line = target.line + 1;
    const column = target.col + 1;
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column });
    editor.focus();
  }, [selectedFile, fileContent]);

  // handleSelectFile is closed over by the DefinitionProvider registered
  // on Monaco mount. The provider is registered once but needs to see
  // the latest handleSelectFile, so we mirror it through a ref.
  const handleSelectFileRef = useRef(handleSelectFile);
  useEffect(() => {
    handleSelectFileRef.current = handleSelectFile;
  }, [handleSelectFile]);

  // Handle editor content change
  const handleEditorChange = useCallback((value: string | undefined) => {
    if (value !== undefined) {
      editorContentRef.current = value;
      setModified(true);
      setContentVersion(v => v + 1);
    }
  }, []);

  // Debounce preview content updates in Split View
  useEffect(() => {
    if (viewMode !== 'split') return;
    const t = setTimeout(() => {
      setFileContent(editorContentRef.current);
    }, 300);
    return () => clearTimeout(t);
  }, [contentVersion, viewMode]);

  // Save file
  const handleSave = useCallback(async () => {
    if (!selectedFile || saving || refreshing) return;
    if (isReadOnlyPreview(selectedFile)) return;

    setSaving(true);
    try {
      await writeFileContent(projectId, taskId, selectedFile, editorContentRef.current);
      setFileContent(editorContentRef.current);
      setModified(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message :
        (err as { message?: string })?.message || 'Failed to save file';
      setError(msg);
    }
    setSaving(false);
  }, [projectId, taskId, selectedFile, saving, refreshing]);

  // Cmd/Ctrl+S → save, routed through the Scoped Command Registry. There's
  // no static catalog entry for the task editor save (it isn't part of
  // Studio), so we define it inline. `editorFocus` is mirrored from Monaco's
  // focus events and gates the binding; `passThroughTextInput` is required
  // because Monaco's surface otherwise suppresses commands while it owns
  // focus (the very state in which we want Cmd+S to fire).
  useContextKey('editorFocus', editorFocused);
  useDefineCommand({
    id: 'task.editor.save',
    name: 'Save Task Editor',
    category: 'Editor',
    description: 'Save the current file open in the task editor',
    defaultBindings: [{ key: 'Mod+s' }],
    scope: 'workspace',
    defaultWhen: 'editorFocus',
    passThroughTextInput: true,
    handler: handleSave,
  }, [handleSave]);

  useCommand("view.zoom.increase", handleZoomIn, { enabled: () => editorFocused }, [handleZoomIn, editorFocused]);
  useCommand("view.zoom.decrease", handleZoomOut, { enabled: () => editorFocused }, [handleZoomOut, editorFocused]);
  useCommand("view.zoom.reset", handleZoomReset, { enabled: () => editorFocused }, [handleZoomReset, editorFocused]);

  // Auto-save on unmount when there are unsaved edits. TaskView force-remounts
  // its child layouts on task switch (TaskView.tsx key={projectId-taskId}),
  // which would otherwise silently discard typed content. Fire-and-forget
  // because unmount can't await; failures are surfaced only in the console.
  const unmountSaveRef = useRef<{ projectId: string; taskId: string; selectedFile: string | null; modified: boolean; content: string }>({
    projectId,
    taskId,
    selectedFile,
    modified: false,
    content: '',
  });
  useEffect(() => {
    unmountSaveRef.current = {
      projectId,
      taskId,
      selectedFile,
      modified,
      content: editorContentRef.current,
    };
  });
  useEffect(() => {
    return () => {
      const snap = unmountSaveRef.current;
      if (!snap.modified || !snap.selectedFile) return;
      if (isReadOnlyPreview(snap.selectedFile)) return;
      writeFileContent(snap.projectId, snap.taskId, snap.selectedFile, snap.content).catch((err) => {
        console.warn('TaskEditor: failed to auto-save on unmount', snap.selectedFile, err);
      });
    };
  }, []);

  // Internal: used by create/delete handlers
  const reloadFiles = useCallback(async () => {
    try {
      const res = await getTaskDirEntries(projectId, taskId, '');
      setFileNodes(dirEntriesToNodes(res.entries));
      // Re-fetch expanded directories in place; keeps expansion state.
      setRefreshSignal(s => s + 1);
    } catch (err) {
      console.error('Failed to reload files:', err);
    }
  }, [projectId, taskId]);

  // Refresh button: reloads file tree + current file content
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await getTaskDirEntries(projectId, taskId, '');
      setFileNodes(dirEntriesToNodes(res.entries));
      // Re-fetch expanded directories in place (preserves which folders are
      // open) and bust the image cache so previews show the latest bytes.
      setRefreshSignal(s => s + 1);
      setImageNonce(n => n + 1);

      if (selectedFile) {
        if (isReadOnlyPreview(selectedFile)) {
          setFileContent('');
          editorContentRef.current = '';
          setModified(false);
        } else {
          const fileRes = await getFileContent(projectId, taskId, selectedFile);
          setFileContent(fileRes.content);
          editorContentRef.current = fileRes.content;
          setModified(false);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    }
    setRefreshing(false);
  }, [projectId, taskId, selectedFile]);

  const handleExpandDir = useCallback(async (dirPath: string): Promise<DirEntry[]> => {
    const result = await getTaskDirEntries(projectId, taskId, dirPath);
    return result.entries;
  }, [projectId, taskId]);

  // Raw-file URL for image/media preview. `_t=${imageNonce}` busts the cache so
  // opening a file (or hitting Refresh) reloads the latest bytes for the same
  // path (the backend also sends `Cache-Control: no-cache`).
  const rawFileUrl = useCallback((path: string) => {
    return `/api/v1/projects/${projectId}/tasks/${taskId}/file/raw?path=${encodeURIComponent(path)}&_t=${imageNonce}`;
  }, [projectId, taskId, imageNonce]);

  // Bump the image cache-buster whenever the open file changes, so switching
  // away and back to the same image shows its current bytes, not a cached copy.
  // This render-time state adjustment is React's sanctioned alternative to a
  // setState-in-effect (https://react.dev/learn/you-might-not-need-an-effect).
  if (selectedFile !== imageNonceFile) {
    setImageNonceFile(selectedFile);
    setImageNonce((n) => n + 1);
  }

  const handleContextMenu = useCallback((e: React.MouseEvent, path: string, isDir: boolean) => {
    setContextMenuPosition({ x: e.clientX, y: e.clientY });
    setContextMenuTarget({ path, isDirectory: isDir });
    setContextMenuOpen(true);
  }, []);

  // Delete handler
  const handleDelete = useCallback((path: string) => {
    setDeleteTarget(path);
    setConfirmDialogOpen(true);
  }, []);

  // Copy path handlers
  const handleCopyRelativePath = useCallback((path: string) => {
    navigator.clipboard.writeText(path).catch((err) => {
      console.error('Failed to copy relative path:', err);
    });
  }, []);

  const handleCopyFullPath = useCallback((path: string) => {
    if (!taskPath) return;
    const full = `${taskPath.replace(/\/$/, '')}/${path}`;
    navigator.clipboard.writeText(full).catch((err) => {
      console.error('Failed to copy full path:', err);
    });
  }, [taskPath]);

  // Open with the OS default application (runs on the server host)
  const handleOpenInApp = useCallback((path: string) => {
    openTaskFile(projectId, taskId, path).catch((err) => {
      setError(err instanceof Error ? err.message : 'Failed to open file');
    });
  }, [projectId, taskId]);

  // Create file submit handler
  const handleCreateFile = useCallback(async (path: string) => {
    try {
      await createFile(projectId, taskId, path, "");
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create file');
      return;
    }
    await reloadFiles();
    // Optionally open the newly created file
    setSelectedFile(path);
    setLoading(true);
    setModified(false);
    setError(null);
    setViewMode('code');
    try {
      const res = await getFileContent(projectId, taskId, path);
      setFileContent(res.content);
      editorContentRef.current = res.content;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setFileContent('');
    }
    setLoading(false);
  }, [projectId, taskId, reloadFiles]);

  // Create directory submit handler
  const handleCreateDirectory = useCallback(async (path: string) => {
    try {
      await createDirectory(projectId, taskId, path);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create directory');
      return;
    }
    await reloadFiles();
  }, [projectId, taskId, reloadFiles]);

  // Move file/directory callback
  const handleMoveFile = useCallback(async (source: string, destination: string) => {
    try {
      await moveFileOrDir(projectId, taskId, source, destination);
      await reloadFiles();
      
      // If the currently selected file was moved, select the new path
      if (selectedFile === source) {
        setSelectedFile(destination);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Failed to move: ${msg}`);
    }
  }, [projectId, taskId, reloadFiles, selectedFile]);

  // Upload/dropped OS file callback
  const handleUploadFile = useCallback(async (parentPath: string, file: File) => {
    try {
      // Read the file as text
      const content = await file.text();
      const fileName = file.name;
      const fullPath = parentPath ? `${parentPath}/${fileName}` : fileName;

      await createFile(projectId, taskId, fullPath, content);
      await reloadFiles();
      
      // Select newly uploaded file
      setSelectedFile(fullPath);
      setLoading(true);
      setModified(false);
      setError(null);
      setViewMode('code');
      
      const res = await getFileContent(projectId, taskId, fullPath);
      setFileContent(res.content);
      editorContentRef.current = res.content;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Failed to upload file: ${msg}`);
    } finally {
      setLoading(false);
    }
  }, [projectId, taskId, reloadFiles]);

  // New file handler
  const handleNewFile = useCallback((parentPath?: string) => {
    const basePath = parentPath || "";
    const depth = basePath ? basePath.split('/').length : 0;
    setCreatingPath({ type: 'file', parentPath: basePath, depth: depth + 1 });
    setContextMenuOpen(false);
  }, []);

  // New directory handler
  const handleNewDirectory = useCallback((parentPath?: string) => {
    const basePath = parentPath || "";
    const depth = basePath ? basePath.split('/').length : 0;
    setCreatingPath({ type: 'directory', parentPath: basePath, depth: depth + 1 });
    setContextMenuOpen(false);
  }, []);

  // Submit inline path creation
  const handleSubmitPath = useCallback(async (name: string) => {
    if (!creatingPath) return;

    const fullPath = creatingPath.parentPath ? `${creatingPath.parentPath}/${name}` : name;

    try {
      if (creatingPath.type === 'file') {
        await handleCreateFile(fullPath);
      } else {
        await handleCreateDirectory(fullPath);
      }
    } catch (err) {
      console.error('Failed to create path:', err);
    }
    setCreatingPath(null);
  }, [creatingPath, handleCreateFile, handleCreateDirectory]);

  // Cancel inline path creation
  const handleCancelPath = useCallback(() => {
    setCreatingPath(null);
  }, []);

  // Delete confirm handler
  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget) return;

    try {
      await deleteFileOrDir(projectId, taskId, deleteTarget);
      await reloadFiles();
      // If deleted file was selected, clear selection
      if (selectedFile === deleteTarget) {
        setSelectedFile(null);
        setFileContent('');
        setModified(false);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    }
    setDeleteTarget(null);
    setConfirmDialogOpen(false);
  }, [deleteTarget, projectId, taskId, reloadFiles, selectedFile]);

  // Breadcrumb from file path
  const breadcrumb = selectedFile ? selectedFile.split('/') : [];

  const renderer = selectedFile ? getPreviewRenderer(selectedFile, 'full') : undefined;
  const isPreviewable = renderer && renderer.id !== 'source' && renderer.id !== 'image';

  // Calculate relative base path for HTML preview
  const parentDirPath = selectedFile && selectedFile.includes('/')
    ? selectedFile.substring(0, selectedFile.lastIndexOf('/')) + '/'
    : '';

  return (
    <div className={`h-full min-h-0 flex-1 flex flex-col bg-[var(--color-bg-secondary)] overflow-hidden ${fullscreen ? '' : 'rounded-lg border border-[var(--color-border)]'}`}>
      {/* Header - 只在非 hideHeader 模式下显示 */}
      {!hideHeader && (
      <div className="flex items-center justify-between px-4 py-2 bg-[var(--color-bg)] border-b border-[var(--color-border)]">
        <div className="flex items-center gap-2 text-sm text-[var(--color-text)] min-w-0">
          <button
            onClick={() => setFileTreeVisible(v => !v)}
            className="p-1 text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] rounded transition-colors flex-shrink-0"
            title={fileTreeVisible ? 'Hide file tree' : 'Show file tree'}
          >
            {fileTreeVisible ? <PanelLeftClose className="w-3.5 h-3.5" /> : <PanelLeftOpen className="w-3.5 h-3.5" />}
          </button>
          <FileCode className="w-4 h-4 flex-shrink-0" />
          <span className="font-medium flex-shrink-0">Editor</span>
          {breadcrumb.length > 0 && (
            <>
              <span className="text-[var(--color-text-muted)] flex-shrink-0">/</span>
              <span className="text-[var(--color-text-muted)] text-xs truncate">
                {breadcrumb.join(' / ')}
              </span>
            </>
          )}
          {modified && (
            <span className="text-xs text-[var(--color-warning)] flex-shrink-0">Modified</span>
          )}
          {saving && (
            <span className="text-xs text-[var(--color-text-muted)] flex-shrink-0 flex items-center gap-1">
              <Save className="w-3 h-3" />
              Saving...
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {onToggleFullscreen && (
            <button
              onClick={onToggleFullscreen}
              className="p-1.5 text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] rounded transition-colors"
              title={fullscreen ? "Exit Fullscreen" : "Fullscreen"}
            >
              {fullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            </button>
          )}
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="w-4 h-4 mr-1" />
            Close
          </Button>
        </div>
      </div>
      )}

      {/* Main content: File tree + Editor */}
      <div className="flex-1 flex min-h-0 relative">
        {/* Mobile backdrop */}
        {isMobile && fileTreeVisible && (
          <div
            className="fixed inset-0 bg-black/40 z-[15]"
            onClick={() => setFileTreeVisible(false)}
          />
        )}

        {/* Collapsed sidebar strip — shown when file tree is hidden */}
        <AnimatePresence initial={false}>
          {!fileTreeVisible && (
            <motion.div
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 36, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ type: "spring", damping: 25, stiffness: 200 }}
              className="flex-shrink-0 flex flex-col items-center pt-2 gap-1 bg-[var(--color-bg)] border-r border-[var(--color-border)] overflow-hidden"
            >
              <button
                onClick={() => setFileTreeVisible(true)}
                className="flex items-center justify-center w-7 h-7 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
                title="Show file tree"
              >
                <PanelLeftOpen className="w-4 h-4" />
              </button>
              <button
                onClick={handleRefresh}
                disabled={refreshing}
                className="flex items-center justify-center w-7 h-7 rounded-md text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                title="Refresh files"
              >
                <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* File tree sidebar */}
        <AnimatePresence initial={false}>
          {fileTreeVisible && (
            <motion.div
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: isMobile ? 280 : fileTreeWidth, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ type: "spring", damping: 25, stiffness: 200 }}
              className="flex-shrink-0 border-r border-[var(--color-border)] bg-[var(--color-bg)] overflow-hidden flex flex-col"
              style={isMobile ? {
                position: 'fixed',
                top: 0,
                left: 0,
                height: '100%',
                zIndex: 20,
                boxShadow: '4px 0 16px rgba(0,0,0,0.25)',
              } : undefined}
            >
              {/* Collapse button inside sidebar header */}
              <div className="flex items-center justify-between px-2 h-[38px] bg-[var(--color-bg)] border-b border-[var(--color-border)] select-none">
                <span className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider pl-1">Files</span>
                <div className="flex items-center gap-0.5">
                  <button
                    onClick={handleRefresh}
                    disabled={refreshing}
                    className="flex items-center justify-center w-6 h-6 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    title="Refresh files"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
                  </button>
                  <button
                    onClick={() => setFileTreeVisible(false)}
                    className="flex items-center justify-center w-6 h-6 rounded text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
                    title="Hide file tree"
                  >
                    <PanelLeftClose className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              <FileTree
                nodes={fileNodes}
                selectedFile={selectedFile}
                contextMenuPath={contextMenuOpen ? contextMenuTarget?.path ?? null : null}
                onSelectFile={handleSelectFile}
                onContextMenu={handleContextMenu}
                creatingPath={creatingPath}
                onSubmitPath={handleSubmitPath}
                onCancelPath={handleCancelPath}
                onExpandDir={handleExpandDir}
                onMoveFile={handleMoveFile}
                onUploadFile={handleUploadFile}
                refreshSignal={refreshSignal}
              />
            </motion.div>
          )}
        </AnimatePresence>

        {/* Resizer between file tree sidebar and editor area (desktop only) */}
        {!isMobile && fileTreeVisible && (
          <div
            className="editor-resizer"
            onPointerDown={startFileTreeResize}
            onDoubleClick={() => setFileTreeWidth(DEFAULT_FILE_TREE_WIDTH)}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize file tree"
            title="Drag to resize · Double-click to reset"
          />
        )}

        {/* Editor area */}
        <div className="flex-1 flex flex-col min-w-0">
          {selectedFile && (
            <div className="flex items-center justify-between px-4 h-[38px] bg-[var(--color-bg)] border-b border-[var(--color-border)] text-xs flex-shrink-0 select-none">
              <span className="text-[var(--color-text-muted)] font-medium">
                {renderer?.label || "Source File"}
              </span>
              <div className="flex items-center gap-2">
                {isPreviewable && (
                  <div className="flex items-center gap-1 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] p-0.5 rounded-md">
                    <button
                      onClick={() => setViewMode('code')}
                      className={`px-2 py-1 rounded transition-colors flex items-center gap-1 font-medium cursor-pointer ${viewMode === 'code' ? 'bg-[var(--color-bg)] text-[var(--color-text)] shadow-sm' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}`}
                    >
                      <FileCode className="w-3.5 h-3.5" />
                      Code
                    </button>
                    <button
                      onClick={() => {
                        setFileContent(editorContentRef.current);
                        setViewMode('split');
                      }}
                      className={`px-2 py-1 rounded transition-colors flex items-center gap-1 font-medium cursor-pointer ${viewMode === 'split' ? 'bg-[var(--color-bg)] text-[var(--color-text)] shadow-sm' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}`}
                    >
                      <Columns2 className="w-3.5 h-3.5" />
                      Split
                    </button>
                    <button
                      onClick={() => {
                        setFileContent(editorContentRef.current);
                        setViewMode('preview');
                      }}
                      className={`px-2 py-1 rounded transition-colors flex items-center gap-1 font-medium cursor-pointer ${viewMode === 'preview' ? 'bg-[var(--color-bg)] text-[var(--color-text)] shadow-sm' : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}`}
                    >
                      <Eye className="w-3.5 h-3.5" />
                      Preview
                    </button>
                  </div>
                )}
                <div className="flex items-center border border-[var(--color-border)] rounded-md bg-[var(--color-bg)] h-7 p-0.5 ml-1">
                  <button
                    onClick={handleZoomOut}
                    className="px-2 h-full flex items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] rounded-[4px] cursor-pointer transition-colors"
                    title="Zoom out"
                  >
                    <ZoomOut className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={handleZoomReset}
                    className="px-2 h-full flex items-center justify-center text-xs font-medium text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] rounded-[4px] cursor-pointer select-none transition-colors"
                    title="Reset zoom (13px)"
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
              </div>
            </div>
          )}

          {loading ? (
            <div className="flex-1 flex items-center justify-center">
              <Loader2 className="w-8 h-8 text-[var(--color-text-muted)] animate-spin" />
            </div>
          ) : error ? (
            <div className="flex-1 flex items-center justify-center p-6">
              <div className="flex flex-col items-center gap-3 max-w-xs text-center">
                <AlertCircle className="w-8 h-8" style={{ color: "var(--color-text-muted)" }} />
                <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>
                  {(() => {
                    const e = error.toLowerCase();
                    return e.includes('utf-8') || e.includes('utf8') || e.includes('binary') || e.includes('not valid utf') || e.includes('invalid utf')
                      ? 'Binary file — preview not supported'
                      : 'Failed to open file';
                  })()}
                </p>
              </div>
            </div>
          ) : selectedFile ? (
            isReadOnlyPreview(selectedFile) ? (
              <div 
                className="flex-1 flex flex-col items-center justify-center overflow-auto p-8 relative"
                style={{
                  backgroundColor: "var(--color-bg-secondary)",
                  backgroundImage: "radial-gradient(var(--color-border) 1px, transparent 1px)",
                  backgroundSize: "16px 16px",
                }}
              >
                <div className="max-w-full max-h-full flex flex-col items-center justify-center gap-3">
                  <div className="relative rounded-lg overflow-hidden border border-[var(--color-border)] shadow-md bg-[var(--color-bg)] transition-transform duration-200 hover:scale-[1.01]">
                    <img
                      src={rawFileUrl(selectedFile)}
                      alt={selectedFile}
                      className="max-w-full max-h-[70vh] object-contain block cursor-pointer hover:opacity-90 transition-opacity"
                      onClick={() => setLightboxUrl(rawFileUrl(selectedFile))}
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = 'none';
                        (e.target as HTMLImageElement).nextElementSibling?.classList.remove('hidden');
                      }}
                    />
                    <div className="hidden flex-col items-center gap-2 p-8 text-sm text-[var(--color-text-muted)] bg-[var(--color-bg-secondary)]">
                      <AlertCircle className="w-8 h-8" />
                      <span>Failed to load image</span>
                    </div>
                  </div>
                  <div className="flex flex-col items-center gap-1">
                    <span className="text-sm font-medium text-[var(--color-text)]">
                      {selectedFile.split('/').pop()}
                    </span>
                    <span className="text-xs text-[var(--color-text-muted)]">
                      {selectedFile}
                    </span>
                  </div>
                </div>
              </div>
            ) : viewMode === 'preview' && isPreviewable ? (
              <div className="flex-1 overflow-auto bg-[var(--color-bg)] p-6 editor-scroll-container">
                {renderer?.renderFull({
                  content: renderer.contentType === 'url'
                    ? rawFileUrl(selectedFile)
                    : (renderer.id === 'html' ? rewriteHtmlUrls(fileContent, projectId, taskId, parentDirPath) : fileContent),
                  fileName: selectedFile,
                  sketchContext: { projectId, taskId },
                  location: {
                    projectId,
                    root: { kind: "task", taskId },
                    path: selectedFile,
                  },
                  onImageClick: (url) => setLightboxUrl(url),
                  onSvgClick: (svg) => setLightboxSvg(svg),
                })}
              </div>
            ) : viewMode === 'split' && isPreviewable ? (
              <div className="flex-1 flex min-h-0 min-w-0 divide-x divide-[var(--color-border)] overflow-hidden">
                <div className="flex-1 min-w-0 h-full">
                  <Editor
                    height="100%"
                    language={getLanguage(selectedFile)}
                    value={fileContent}
                    onChange={handleEditorChange}
                    onMount={(editor, monaco) => {
                      editorRef.current = editor;
                      setMonacoInstance(monaco);
                      registerMermaidLanguage(monaco);
                      const sessionId = editor.getId?.() as string | undefined;
                      if (sessionId) {
                        editorRegistry.set(sessionId, {
                          projectId,
                          taskId,
                          monaco,
                          selectedFileRef,
                          pendingJumpRef,
                          handleSelectFileRef,
                          editor,
                        });
                        editor.onDidDispose?.(() => {
                          editorRegistry.delete(sessionId);
                        });
                      }
                      // Track Monaco focus → drives the `editorFocus` context
                      // key. The Cmd+S save command's defaultWhen gates on it
                      // so the binding only fires while the editor owns focus.
                      editor.onDidFocusEditorText?.(() => setEditorFocused(true));
                      editor.onDidBlurEditorText?.(() => setEditorFocused(false));
                      const underlineDisposables = attachUnderlineListeners(editor, monaco);
                      editor.onDidDispose?.(() => {
                        for (const d of underlineDisposables) {
                          try {
                            d.dispose();
                          } catch {
                            // Already disposed internally
                          }
                        }
                      });
                      void ensureDefinitionProvidersRegistered(monaco);
                      void ensureGlobalEditorServiceHook(editor);
                    }}
                    theme="grove-theme"
                    options={{
                      minimap: { enabled: false },
                      fontSize: fontSize,
                      lineNumbers: 'on',
                      scrollBeyondLastLine: false,
                      wordWrap: 'on',
                      automaticLayout: true,
                      padding: { top: 8 },
                      renderWhitespace: 'selection',
                      scrollbar: {
                        verticalScrollbarSize: 6,
                        horizontalScrollbarSize: 6,
                        vertical: 'visible',
                        horizontal: 'visible',
                        useShadows: false,
                      },
                    }}
                  />
                </div>
                <div className="flex-1 min-w-0 h-full overflow-auto bg-[var(--color-bg)] p-6 editor-scroll-container">
                  {renderer?.renderFull({
                    content: renderer.contentType === 'url'
                      ? rawFileUrl(selectedFile)
                      : (renderer.id === 'html' ? rewriteHtmlUrls(fileContent, projectId, taskId, parentDirPath) : fileContent),
                    fileName: selectedFile,
                    sketchContext: { projectId, taskId },
                    location: {
                      projectId,
                      root: { kind: "task", taskId },
                      path: selectedFile,
                    },
                    onImageClick: (url) => setLightboxUrl(url),
                    onSvgClick: (svg) => setLightboxSvg(svg),
                  })}
                </div>
              </div>
            ) : (
              <Editor
                height="100%"
                language={getLanguage(selectedFile)}
                value={fileContent}
                onChange={handleEditorChange}
                onMount={(editor, monaco) => {
                  editorRef.current = editor;
                  setMonacoInstance(monaco);
                  registerMermaidLanguage(monaco);
                  const sessionId = editor.getId?.() as string | undefined;
                  if (sessionId) {
                    editorRegistry.set(sessionId, {
                      projectId,
                      taskId,
                      monaco,
                      selectedFileRef,
                      pendingJumpRef,
                      handleSelectFileRef,
                      editor,
                    });
                    // Drop the registry entry when Monaco disposes the
                    // editor (panel close, tab switch, FlexLayout
                    // re-mount). Without this, late provider lookups
                    // would target a dead editor.
                    editor.onDidDispose?.(() => {
                      editorRegistry.delete(sessionId);
                    });
                  }
                  // Track Monaco focus → drives the `editorFocus` context
                  // key. The Cmd+S save command's defaultWhen gates on it
                  // so the binding only fires while the editor owns focus.
                  editor.onDidFocusEditorText?.(() => setEditorFocused(true));
                  editor.onDidBlurEditorText?.(() => setEditorFocused(false));
                  const underlineDisposables = attachUnderlineListeners(editor, monaco);
                  editor.onDidDispose?.(() => {
                    for (const d of underlineDisposables) {
                      try {
                        d.dispose();
                      } catch {
                        // Monaco disposes its own listeners on
                        // editor.dispose; this is just defensive.
                      }
                    }
                  });
                  void ensureDefinitionProvidersRegistered(monaco);
                  void ensureGlobalEditorServiceHook(editor);
                }}
                theme="grove-theme"
                options={{
                  minimap: { enabled: false },
                  fontSize: fontSize,
                  lineNumbers: 'on',
                  scrollBeyondLastLine: false,
                  wordWrap: 'on',
                  automaticLayout: true,
                  padding: { top: 8 },
                  renderWhitespace: 'selection',
                  scrollbar: {
                    verticalScrollbarSize: 6,
                    horizontalScrollbarSize: 6,
                    vertical: 'visible',
                    horizontal: 'visible',
                    useShadows: false,
                  },
                }}
              />
            )
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-sm text-[var(--color-text-muted)]">
                Select a file to edit
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Context Menu */}
      <FileContextMenu
        isOpen={contextMenuOpen}
        position={contextMenuPosition}
        target={contextMenuTarget}
        taskPath={taskPath}
        onClose={() => setContextMenuOpen(false)}
        onNewFile={handleNewFile}
        onNewDirectory={handleNewDirectory}
        onDelete={handleDelete}
        onCopyRelativePath={handleCopyRelativePath}
        onCopyFullPath={handleCopyFullPath}
        onOpenInApp={handleOpenInApp}
      />

      {/* Confirm Dialog for deletion */}
      <ConfirmDialog
        isOpen={confirmDialogOpen}
        title="Delete"
        message={`Are you sure you want to delete "${deleteTarget}"? This action cannot be undone.`}
        confirmLabel="Delete"
        onConfirm={handleConfirmDelete}
        onCancel={() => {
          setConfirmDialogOpen(false);
          setDeleteTarget(null);
        }}
      />

      {(lightboxUrl || lightboxSvg) && (
        <ImageLightbox
          imageUrl={lightboxUrl}
          svgContent={lightboxSvg}
          onClose={() => {
            setLightboxUrl(null);
            setLightboxSvg(null);
          }}
        />
      )}
    </div>
  );
}
