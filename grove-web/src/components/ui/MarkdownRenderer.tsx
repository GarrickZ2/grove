import { Children, isValidElement, useState, useEffect, useRef, useId, memo, useMemo } from "react";
import { Check, Code, Copy, FileText, Hash, Loader2, Play, Terminal, WrapText } from "lucide-react";
import { renderD2 } from "../../api";
import type { RenderD2Error } from "../../api";
import ReactMarkdown, { type Components, defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import mermaid from "mermaid";
import { VSCodeIcon } from "./VSCodeIcon";
import { SketchChip } from "./SketchChip";
import { highlightLines, normalizeLanguage } from "../Review/syntaxHighlight";
import { useTheme } from "../../context/ThemeContext";
import { openExternalUrl } from "../../utils/openExternal";

/** Languages whose code blocks may be executed in the terminal. */
const RUNNABLE_SHELL_LANGS = new Set(["bash", "sh", "shell", "zsh"]);

/** Event name for command injection into an active XTerminal. */
export const TERMINAL_INJECT_EVENT = "grove:terminal-inject";

export interface TerminalInjectDetail {
  command: string;
}

// Match file paths like `path/to/file.ext` or `path/to/file.ext:123`.
// Accept Unicode and other non-ASCII characters in path segments.
const FILE_PATH_RE = /^(.+\/[^/]+?\.[A-Za-z0-9]+)(?::(\d+))?[,.]?$/;

// Match local file hrefs after decoding percent-encoded characters.
// e.g. "service/foo.go", "/abs/path/中文名.md", or ends with "#L505"
const FILE_HREF_RE = /^(.+\/[^/]+?\.[A-Za-z0-9]+)(?:[:#]L?(\d+))?$/;

// Matches `sketch-<uuid>`. Used to validate `sketch://` hrefs.
const SKETCH_ID_RE = /^sketch-[0-9a-f-]+$/i;

// Wrap bare `sketch://sketch-<uuid>` occurrences as markdown autolinks so
// react-markdown surfaces them through the link renderer, which converts
// them into <SketchChip>. The negative lookbehind avoids re-wrapping when
// the URL is already inside `[label](...)` or `[...](...)`.
const SKETCH_AUTOLINK_RE = /(?<![[(])(sketch:\/\/sketch-[0-9a-f-]+)\b/gi;

function preprocessSketchUrls(content: string): string {
  if (!content.includes("sketch://")) return content;
  // Split by fenced code blocks and inline code spans so we don't rewrite
  // URLs inside code. Odd-indexed parts are the code regions.
  // Note: an author-written `sketch://...` wrapped in inline backticks is
  // kept as a <code> span by design — authors opt out of chip rendering by
  // quoting it. Only non-code occurrences become clickable chips.
  const parts = content.split(/(```[\s\S]*?```|`[^`\n]+`)/g);
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i].replace(SKETCH_AUTOLINK_RE, (m) => `[${m}](${m})`);
  }
  return parts.join("");
}

// Match inline code spans whose content, after collapsing whitespace, is a
// bare http(s) URL. Agents (notably claude-code ACP) sometimes wrap long
// links in backticks, which would render as a non-clickable `<code>` span.
// We unwrap them so remark-gfm autolinks the URL into a normal `<a>`.
// - Single-backtick inline spans only (skip ``` fences elsewhere).
// - Allow newlines/whitespace inside the span; we strip them.
const INLINE_CODE_URL_RE = /`([^`]+?)`/g;

function preprocessInlineCodeUrls(content: string): string {
  if (!content.includes("`")) return content;
  // Don't touch fenced code blocks; only rewrite inline spans outside them.
  const parts = content.split(/(```[\s\S]*?```)/g);
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i].replace(INLINE_CODE_URL_RE, (m, inner: string) => {
      const collapsed = inner.replace(/\s+/g, "");
      return /^https?:\/\/\S+$/.test(collapsed) ? collapsed : m;
    });
  }
  return parts.join("");
}

function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function isDarkColor(color: string): boolean {
  const match = color.trim().match(/^#([0-9a-f]{6})$/i);
  if (!match) return true;
  const hex = match[1];
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance < 0.5;
}

function getMermaidConfig() {
  const bg = cssVar("--color-bg", "#0a0a0b");
  const bgSecondary = cssVar("--color-bg-secondary", "#141416");
  const bgTertiary = cssVar("--color-bg-tertiary", "#1c1c1f");
  const border = cssVar("--color-border", "#27272a");
  const text = cssVar("--color-text", "#fafafa");
  const textMuted = cssVar("--color-text-muted", "#71717a");
  const highlight = cssVar("--color-highlight", "#10b981");
  const darkMode = isDarkColor(bg);

  return {
    startOnLoad: false,
    theme: "base" as const,
    themeVariables: {
      darkMode,
      background: "transparent",
      fontFamily: "inherit",
      primaryColor: bgSecondary,
      primaryTextColor: text,
      primaryBorderColor: border,
      secondaryColor: bgTertiary,
      secondaryTextColor: text,
      secondaryBorderColor: border,
      tertiaryColor: bg,
      tertiaryTextColor: text,
      tertiaryBorderColor: border,
      lineColor: textMuted,
      textColor: text,
      mainBkg: bgSecondary,
      nodeBkg: bgSecondary,
      nodeTextColor: text,
      clusterBkg: bg,
      clusterBorder: border,
      defaultLinkColor: textMuted,
      titleColor: text,
      edgeLabelBackground: bg,
      actorBkg: bgSecondary,
      actorBorder: border,
      actorTextColor: text,
      actorLineColor: textMuted,
      signalColor: textMuted,
      signalTextColor: text,
      labelBoxBkgColor: bg,
      labelBoxBorderColor: border,
      labelTextColor: text,
      loopTextColor: text,
      noteBkgColor: `color-mix(in srgb, ${highlight} 12%, ${bg})`,
      noteBorderColor: border,
      noteTextColor: text,
      activationBorderColor: border,
      activationBkgColor: bgTertiary,
      sequenceNumberColor: text,
    },
  };
}

// Module-level SVG caches: code → rendered SVG string.
// Survive component re-mounts so cached diagrams are shown instantly.
const mermaidSvgCache = new Map<string, string>();
const d2SvgCache = new Map<string, string>();

function SourceToggleButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className="absolute top-2 right-2 z-10 p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity"
      title={active ? "Show preview" : "Show source"}
      style={{
        color: active ? "var(--color-highlight)" : "var(--color-text-muted)",
        background: active ? "color-mix(in srgb, var(--color-highlight) 12%, transparent)" : "transparent",
      }}
    >
      <Code className="w-3.5 h-3.5" />
    </button>
  );
}

export const MermaidBlock = memo(function MermaidBlock({ code, onPreviewClick }: { code: string; onPreviewClick?: (svg: string) => void }): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const uniqueId = useId();
  const { theme } = useTheme();
  const cacheKey = `${theme.id}::${code}`;
  const [svg, setSvg] = useState<string | null>(() => mermaidSvgCache.get(cacheKey) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const cached = mermaidSvgCache.get(cacheKey);
    if (cached) {
      setSvg(cached);
      setError(null);
      return;
    }

    // Debounce rendering so rapidly-changing streaming code doesn't fire mermaid on every token.
    // The old svg (if any) stays visible during the debounce window — no loading flash.
    const timer = window.setTimeout(() => {
      let cancelled = false;
      const id = `mermaid-${uniqueId.replace(/:/g, "")}`;
      mermaid.initialize(getMermaidConfig());
      mermaid
        .render(id, code)
        .then(({ svg: rendered }) => {
          if (!cancelled) {
            mermaidSvgCache.set(cacheKey, rendered);
            setSvg(rendered);
            setError(null);
          }
        })
        .catch((err) => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        });
      return () => { cancelled = true; };
    }, 300);

    return () => window.clearTimeout(timer);
  }, [cacheKey, code, uniqueId, theme.id, theme.colors.bg, theme.colors.bgSecondary, theme.colors.bgTertiary, theme.colors.border, theme.colors.text, theme.colors.textMuted, theme.colors.highlight]);
  /* eslint-enable react-hooks/set-state-in-effect */

  if (error) {
    return (
      <pre className="rounded-lg bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] p-3 my-2 whitespace-pre-wrap break-words text-xs font-mono text-[var(--color-danger)]">
        Mermaid error: {error}
      </pre>
    );
  }

  if (!svg) {
    return (
      <div className="rounded-lg bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] p-4 my-2 flex items-center justify-center text-xs text-[var(--color-text-muted)]">
        Rendering diagram...
      </div>
    );
  }

  if (showSource) {
    return (
      <div className="group relative rounded-lg border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-bg-secondary)_72%,transparent)] my-2 overflow-hidden">
        <SourceToggleButton active={showSource} onClick={() => setShowSource(false)} />
        <pre className="p-3 text-xs font-mono whitespace-pre-wrap break-words leading-relaxed overflow-x-auto" style={{ color: "var(--color-text)" }}>{code}</pre>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="group relative my-2">
      <SourceToggleButton active={showSource} onClick={() => setShowSource(true)} />
      <div
        className={`rounded-lg border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-bg-secondary)_72%,transparent)] p-3 overflow-x-auto flex justify-center [&_svg]:max-w-full ${onPreviewClick ? "cursor-pointer hover:border-[var(--color-highlight)] transition-colors" : ""}`}
        dangerouslySetInnerHTML={{ __html: svg }}
        onClick={onPreviewClick ? () => {
          const responsive = svg
            .replace(/\s*width="[^"]*"/, ' width="100%"')
            .replace(/\s*height="[^"]*"/, ' height="100%"')
            .replace(/(<svg[^>]*?)(?=\s*>)/, '$1 style="max-width:90vw;max-height:85vh;width:auto;height:auto;" preserveAspectRatio="xMidYMid meet"');
          onPreviewClick(responsive);
        } : undefined}
      />
    </div>
  );
});

export const D2Block = memo(function D2Block({
  code,
  onPreviewClick,
}: {
  code: string;
  onPreviewClick?: (svg: string) => void;
}): React.JSX.Element {
  const [state, setState] = useState<'idle' | 'loading' | 'success' | 'not_installed' | 'error'>(
    () => d2SvgCache.has(code) ? 'success' : 'idle'
  );
  const [svg, setSvg] = useState<string>(() => d2SvgCache.get(code) ?? '');
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [showSource, setShowSource] = useState(false);
  useEffect(() => {
    // If already cached, skip API call entirely
    if (d2SvgCache.has(code)) {
      const cached = d2SvgCache.get(code)!;
      setSvg(cached); // eslint-disable-line react-hooks/set-state-in-effect
      setState('success');
      return;
    }
    // Debounce: wait 800ms after code stops changing before calling API.
    // This prevents rapid re-renders while AI is streaming.
    const timer = setTimeout(() => {
      setState('loading');
      renderD2(code)
        .then((result) => { d2SvgCache.set(code, result); setSvg(result); setState('success'); })
        .catch((err: RenderD2Error) => {
          if (err.code === 'd2_not_installed') setState('not_installed');
          else { setErrorMsg(err.message || 'Render failed'); setState('error'); }
        });
    }, 800);
    return () => clearTimeout(timer);
  }, [code]);

  if (showSource) {
    return (
      <div className="group relative rounded-lg border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-bg-secondary)_72%,transparent)] my-2 overflow-hidden">
        <SourceToggleButton active={showSource} onClick={() => setShowSource(false)} />
        <pre className="p-3 text-xs font-mono whitespace-pre-wrap break-words leading-relaxed overflow-x-auto" style={{ color: "var(--color-text)" }}>{code}</pre>
      </div>
    );
  }

  // While debouncing: show last known SVG if available, otherwise spinner
  if (state === 'idle' || state === 'loading') {
    if (svg) {
      const responsive = svg
        .replace(/\s*width="[^"]*"/, ' width="100%"')
        .replace(/\s*height="[^"]*"/, ' height="100%"');
      return (
        <div className="group relative my-2 opacity-60">
          <SourceToggleButton active={false} onClick={() => setShowSource(true)} />
          <div
            className={`flex items-center justify-center [&_svg]:max-w-full${onPreviewClick ? ' cursor-pointer hover:opacity-80 transition-opacity' : ''}`}
            dangerouslySetInnerHTML={{ __html: responsive }}
            onClick={onPreviewClick ? () => onPreviewClick(responsive) : undefined}
          />
        </div>
      );
    }
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'var(--color-text-muted)' }} />
      </div>
    );
  }

  if (state === 'not_installed') {
    return (
      <div className="group relative rounded-lg px-4 py-3 my-2 text-xs"
        style={{ background: 'var(--color-bg-secondary)', border: '1px solid var(--color-border)' }}>
        <SourceToggleButton active={false} onClick={() => setShowSource(true)} />
        <p className="font-medium mb-1" style={{ color: 'var(--color-text)' }}>d2 not installed</p>
        <code className="font-mono" style={{ color: 'var(--color-text-muted)' }}>brew install d2</code>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="group relative rounded-lg px-4 py-3 my-2 text-xs"
        style={{ background: 'var(--color-bg-secondary)', border: '1px solid var(--color-border)', color: 'var(--color-error)' }}>
        <SourceToggleButton active={false} onClick={() => setShowSource(true)} />
        {errorMsg || 'Render failed'}
      </div>
    );
  }

  const responsive = svg
    .replace(/\s*width="[^"]*"/, ' width="100%"')
    .replace(/\s*height="[^"]*"/, ' height="100%"');

  return (
    <div className="group relative my-2">
      <SourceToggleButton active={showSource} onClick={() => setShowSource(true)} />
      <div
        className={`flex items-center justify-center [&_svg]:max-w-full${onPreviewClick ? ' cursor-pointer hover:opacity-80 transition-opacity' : ''}`}
        dangerouslySetInnerHTML={{ __html: responsive }}
        onClick={onPreviewClick ? () => onPreviewClick(svg) : undefined}
      />
    </div>
  );
});

/** Language display metadata: friendly label + icon. */
const LANG_META: Record<string, { label: string; Icon: typeof Code }> = {
  bash: { label: "bash", Icon: Terminal },
  sh: { label: "shell", Icon: Terminal },
  shell: { label: "shell", Icon: Terminal },
  zsh: { label: "zsh", Icon: Terminal },
  powershell: { label: "powershell", Icon: Terminal },
  ps1: { label: "powershell", Icon: Terminal },
  dockerfile: { label: "dockerfile", Icon: Terminal },
  makefile: { label: "makefile", Icon: Terminal },
  javascript: { label: "javascript", Icon: Code },
  js: { label: "javascript", Icon: Code },
  jsx: { label: "jsx", Icon: Code },
  typescript: { label: "typescript", Icon: Code },
  ts: { label: "typescript", Icon: Code },
  tsx: { label: "tsx", Icon: Code },
  python: { label: "python", Icon: Code },
  py: { label: "python", Icon: Code },
  rust: { label: "rust", Icon: Code },
  rs: { label: "rust", Icon: Code },
  go: { label: "go", Icon: Code },
  java: { label: "java", Icon: Code },
  kotlin: { label: "kotlin", Icon: Code },
  swift: { label: "swift", Icon: Code },
  cpp: { label: "c++", Icon: Code },
  c: { label: "c", Icon: Code },
  ruby: { label: "ruby", Icon: Code },
  rb: { label: "ruby", Icon: Code },
  php: { label: "php", Icon: Code },
  sql: { label: "sql", Icon: Code },
  json: { label: "json", Icon: Code },
  yaml: { label: "yaml", Icon: Code },
  yml: { label: "yaml", Icon: Code },
  toml: { label: "toml", Icon: Code },
  html: { label: "html", Icon: Code },
  css: { label: "css", Icon: Code },
  scss: { label: "scss", Icon: Code },
  markdown: { label: "markdown", Icon: FileText },
  md: { label: "markdown", Icon: FileText },
  diff: { label: "diff", Icon: Code },
};

function getLangMeta(lang: string | undefined): { label: string; Icon: typeof Code } {
  if (!lang) return { label: "text", Icon: FileText };
  const key = lang.toLowerCase();
  if (LANG_META[key]) return LANG_META[key];
  return { label: key, Icon: Code };
}

/** Header icon button — thin, always-visible, subtle hover. */
function HeaderButton({
  onClick,
  title,
  icon: Icon,
  active,
  hoverTone,
}: {
  onClick: () => void;
  title: string;
  icon: typeof Code;
  active?: boolean;
  hoverTone?: "default" | "accent" | "success";
}) {
  const toneColor =
    hoverTone === "accent"
      ? "var(--color-highlight)"
      : hoverTone === "success"
        ? "var(--color-success)"
        : "var(--color-text)";
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="inline-flex h-6 w-6 items-center justify-center rounded-md transition-colors"
      style={{
        color: active ? toneColor : "var(--color-text-muted)",
        background: active ? "color-mix(in srgb, var(--color-text-muted) 10%, transparent)" : "transparent",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = toneColor;
        e.currentTarget.style.background = "color-mix(in srgb, var(--color-text-muted) 12%, transparent)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = active ? toneColor : "var(--color-text-muted)";
        e.currentTarget.style.background = active ? "color-mix(in srgb, var(--color-text-muted) 10%, transparent)" : "transparent";
      }}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}

function CodeBlock({
  code,
  language,
  enableRunCommand,
}: {
  code: string;
  language?: string;
  enableRunCommand?: boolean;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const [isWrapped, setIsWrapped] = useState(true); // Default: soft-wrap on
  const [showLineNumbers, setShowLineNumbers] = useState(true);

  const normalizedLanguage = normalizeLanguage(language);
  const rawLines = useMemo(() => code.split("\n"), [code]);
  const highlightedLines = useMemo(
    () => highlightLines(rawLines, normalizedLanguage),
    [rawLines, normalizedLanguage],
  );

  const isRunnable =
    !!enableRunCommand &&
    RUNNABLE_SHELL_LANGS.has((normalizedLanguage || language || "").toLowerCase());
  const { label: langLabel, Icon: LangIcon } = getLangMeta(normalizedLanguage || language);
  const lineNumWidth = `${String(rawLines.length).length}ch`;

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const handleRun = () => {
    const event = new CustomEvent<TerminalInjectDetail>(TERMINAL_INJECT_EVENT, {
      detail: { command: code },
    });
    window.dispatchEvent(event);
  };

  // Solid "gutter" color used behind sticky line numbers so code doesn't
  // scroll into them. Slightly tinted from the chat bg for visible separation.
  const gutterBg = "color-mix(in srgb, var(--color-text) 4%, var(--color-bg))";

  return (
    <div
      className="markdown-code-block my-2 overflow-hidden rounded-xl border"
      style={{
        borderColor: "color-mix(in srgb, var(--color-border) 90%, transparent)",
        background: "transparent",
      }}
    >
      {/* Header bar — subtle gray tint (visible but not overpowering) */}
      <div
        className="flex items-center justify-between gap-2 px-3 py-1.5 border-b"
        style={{
          borderColor: "color-mix(in srgb, var(--color-border) 80%, transparent)",
          background: "color-mix(in srgb, var(--color-text) 6%, transparent)",
        }}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <LangIcon className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--color-text-muted)" }} />
          <span
            className="truncate font-mono text-[11px] lowercase tracking-wide"
            style={{ color: "var(--color-text-muted)" }}
          >
            {langLabel}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <HeaderButton
            onClick={() => setIsWrapped((v) => !v)}
            title={isWrapped ? "Disable word wrap" : "Enable word wrap"}
            icon={WrapText}
            active={isWrapped}
          />
          <HeaderButton
            onClick={() => setShowLineNumbers((v) => !v)}
            title={showLineNumbers ? "Hide line numbers" : "Show line numbers"}
            icon={Hash}
            active={showLineNumbers}
          />
          {isRunnable && (
            <HeaderButton
              onClick={handleRun}
              title="Run in a new Terminal tab"
              icon={Play}
              hoverTone="accent"
            />
          )}
          <HeaderButton
            onClick={handleCopy}
            title={copied ? "Copied" : "Copy code"}
            icon={copied ? Check : Copy}
            hoverTone={copied ? "success" : "default"}
          />
        </div>
      </div>

      {/* Code body — transparent so it inherits chat bg */}
      <div className={isWrapped ? "" : "overflow-x-auto"}>
        <div
          className="font-mono text-[13px] leading-6"
          style={{ color: "var(--color-text)" }}
        >
          {rawLines.map((_, i) => {
            const isFirst = i === 0;
            const isLast = i === rawLines.length - 1;
            const edgePad = `${isFirst ? "pt-3 " : ""}${isLast ? "pb-3" : ""}`.trim();
            return (
              <div key={i} className="flex items-stretch">
                {showLineNumbers && (
                  <span
                    className={`shrink-0 select-none pr-3 pl-4 text-right sticky left-0 ${edgePad}`}
                    style={{
                      color: "color-mix(in srgb, var(--color-text-muted) 60%, transparent)",
                      minWidth: `calc(${lineNumWidth} + 1.75rem)`,
                      background: gutterBg,
                    }}
                  >
                    {i + 1}
                  </span>
                )}
                <code
                  className={`block flex-1 ${showLineNumbers ? "pr-4 pl-3" : "px-4"} ${edgePad} ${isWrapped ? "whitespace-pre-wrap break-all" : "whitespace-pre"}`}
                  dangerouslySetInnerHTML={{ __html: highlightedLines[i] || "&nbsp;" }}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

interface MarkdownRendererProps {
  content: string;
  /** When provided, inline code matching file path patterns become clickable */
  onFileClick?: (filePath: string, line?: number) => void;
  /** When provided, relative image src values are resolved via this function */
  resolveImageUrl?: (src: string) => string;
  /** When provided, clicking a rendered mermaid diagram triggers this callback with the SVG */
  onMermaidClick?: (svg: string) => void;
  /** When provided, clicking a rendered D2 diagram triggers this callback with the SVG */
  onD2Click?: (svg: string) => void;
  /** When provided, clicking an inline image triggers this callback with the resolved URL */
  onImageClick?: (url: string) => void;
  /** When true, bash/sh/shell code blocks get a Run button that pastes into the active terminal */
  enableRunCommand?: boolean;
  /** When provided, `sketch://<sketch-uuid>` references render as a clickable
   * sketch chip scoped to this Studio task. Chip labels resolve uuid → name
   * from this task's sketch index; unknown uuids render as a disabled chip. */
  sketchContext?: { projectId: string; taskId: string };
}

/** Extract filename from a full file path */
function getFileName(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1];
}

/** Render an inline file chip with VSCode icon */
function FileChip({
  filePath,
  line,
  onClick,
}: {
  filePath: string;
  line?: number;
  onClick: () => void;
}) {
  const fileName = getFileName(filePath);
  const lineLabel = line ? `:${line}` : "";
  return (
    <button
      type="button"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onClick(); }}
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium cursor-pointer
        bg-[color-mix(in_srgb,var(--color-bg-secondary)_80%,var(--color-bg))]
        text-[var(--color-highlight)]
        border border-[color-mix(in_srgb,var(--color-border)_65%,transparent)]
        hover:bg-[color-mix(in_srgb,var(--color-highlight)_12%,var(--color-bg-secondary))]
        hover:border-[color-mix(in_srgb,var(--color-highlight)_30%,var(--color-border))]
        transition-colors align-middle"
      title={`Open ${filePath}${line ? ` at line ${line}` : ""}`}
    >
      <VSCodeIcon filename={fileName} size={13} />
      <span>{fileName}{lineLabel}</span>
    </button>
  );
}

/** Extract plain text from React children recursively */
function extractText(children: React.ReactNode): string {
  let text = "";
  Children.forEach(children, (child) => {
    if (typeof child === "string") {
      text += child;
    } else if (typeof child === "number") {
      text += String(child);
    } else if (isValidElement(child)) {
      const props = child.props as Record<string, unknown>;
      if (props.children) {
        text += extractText(props.children as React.ReactNode);
      }
    }
  });
  return text;
}

function parseFileHref(href: string): { filePath: string; line?: number } | null {
  if (/^(https?:\/\/|mailto:)/.test(href)) {
    return null;
  }

  let decodedHref = href;
  try {
    decodedHref = decodeURIComponent(href);
  } catch {
    // Keep the raw href when decoding fails so plain ASCII paths still work.
  }

  if (decodedHref.startsWith("file://")) {
    decodedHref = decodedHref.slice("file://".length);
  }

  const hrefMatch = decodedHref.match(FILE_HREF_RE);
  if (!hrefMatch) {
    return null;
  }

  return {
    filePath: hrefMatch[1],
    line: hrefMatch[2] ? parseInt(hrefMatch[2], 10) : undefined,
  };
}

export const MarkdownRenderer = memo(function MarkdownRenderer({ content, onFileClick, resolveImageUrl, onMermaidClick, onImageClick, onD2Click, enableRunCommand, sketchContext }: MarkdownRendererProps) {
  const processedContent = useMemo(() => {
    let out = preprocessInlineCodeUrls(content);
    if (sketchContext) out = preprocessSketchUrls(out);
    return out;
  }, [content, sketchContext]);
  const components = useMemo((): Components => ({
        h1: ({ children }) => (
          <h1 className="text-lg font-bold text-[var(--color-text)] mt-4 mb-2 first:mt-0">{children}</h1>
        ),
        h2: ({ children }) => (
          <h2 className="text-base font-semibold text-[var(--color-text)] mt-3 mb-2">{children}</h2>
        ),
        h3: ({ children }) => (
          <h3 className="text-sm font-semibold text-[var(--color-text)] mt-3 mb-1">{children}</h3>
        ),
        h4: ({ children }) => (
          <h4 className="text-sm font-medium text-[var(--color-text)] mt-2 mb-1">{children}</h4>
        ),
        h5: ({ children }) => (
          <h5 className="text-xs font-semibold text-[var(--color-text)] mt-2 mb-1">{children}</h5>
        ),
        h6: ({ children }) => (
          <h6 className="text-xs font-medium text-[var(--color-text-muted)] mt-2 mb-1">{children}</h6>
        ),
        p: ({ children }) => (
          <p className="text-sm text-[var(--color-text)] mb-2 last:mb-0 [li>&]:mb-0 break-words">{children}</p>
        ),
        ul: ({ children }) => (
          <ul className="list-disc list-inside text-sm text-[var(--color-text)] mb-2 ml-2 space-y-0.5">{children}</ul>
        ),
        ol: ({ children }) => (
          <ol className="list-decimal list-inside text-sm text-[var(--color-text)] mb-2 ml-2 space-y-0.5">{children}</ol>
        ),
        li: ({ children }) => (
          <li className="text-sm text-[var(--color-text)]">{children}</li>
        ),
        a: ({ href, children }) => {
          // sketch:// chip — render first so bare sketch URLs never fall
          // through to the file-path heuristic or the plain link renderer.
          if (sketchContext && href && href.startsWith("sketch://")) {
            const id = href.slice("sketch://".length);
            if (SKETCH_ID_RE.test(id)) {
              return (
                <SketchChip
                  projectId={sketchContext.projectId}
                  taskId={sketchContext.taskId}
                  sketchId={id}
                />
              );
            }
          }
          // Check if the link href looks like a file path (not an external URL)
          if (onFileClick && href) {
            const parsedHref = parseFileHref(href);
            if (parsedHref) {
              const { filePath, line } = parsedHref;
              // Also check the link text for "file:line" pattern
              const text = extractText(children);
              const textMatch = text.match(FILE_PATH_RE);
              const finalLine = line ?? (textMatch?.[2] ? parseInt(textMatch[2], 10) : undefined);
              return (
                <FileChip
                  filePath={filePath}
                  line={finalLine}
                  onClick={() => onFileClick(filePath, finalLine)}
                />
              );
            }
          }
          const isExternal = href && (href.startsWith("http://") || href.startsWith("https://"));
          if (isExternal) {
            return (
              <a
                href={href}
                className="text-[var(--color-highlight)] hover:underline break-words cursor-pointer"
                onClick={(e) => {
                  e.preventDefault();
                  openExternalUrl(href);
                }}
              >
                {children}
              </a>
            );
          }
          return (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--color-highlight)] hover:underline break-words"
            >
              {children}
            </a>
          );
        },
        strong: ({ children }) => (
          <strong className="font-semibold text-[var(--color-text)]">{children}</strong>
        ),
        em: ({ children }) => (
          <em className="italic">{children}</em>
        ),
        blockquote: ({ children }) => (
          <blockquote className="border-l-2 border-[var(--color-highlight)] pl-3 my-2 text-sm text-[var(--color-text-muted)]">
            {children}
          </blockquote>
        ),
        code: ({ className, children }) => {
          const text = extractText(children);
          // Auto-linkify any code span whose content is a bare http(s) URL —
          // even if the agent injected whitespace/newlines inside the
          // backticks, which would otherwise push it into the block branch
          // below. We collapse internal whitespace to reconstruct the URL.
          const collapsed = text.replace(/\s+/g, "");
          if (!className?.startsWith("language-") && /^https?:\/\/\S+$/.test(collapsed)) {
            return (
              <a
                href={collapsed}
                className="text-[var(--color-highlight)] hover:underline break-all cursor-pointer font-mono text-xs"
                onClick={(e) => {
                  e.preventDefault();
                  openExternalUrl(collapsed);
                }}
              >
                {collapsed}
              </a>
            );
          }
          const isBlock = className?.startsWith("language-") || text.includes("\n");
          if (isBlock) {
            if (className === "language-mermaid") {
              return <MermaidBlock code={text} onPreviewClick={onMermaidClick} />;
            }
            if (className === "language-d2") {
              return <D2Block code={text} onPreviewClick={onD2Click} />;
            }
            const language = className?.replace(/^language-/, "");
            return <CodeBlock code={text.replace(/\n$/, "")} language={language} enableRunCommand={enableRunCommand} />;
          }
          // Check if inline code looks like a file path
          if (onFileClick) {
            const match = text.match(FILE_PATH_RE);
            if (match) {
              const filePath = match[1];
              const line = match[2] ? parseInt(match[2], 10) : undefined;
              return (
                <FileChip
                  filePath={filePath}
                  line={line}
                  onClick={() => onFileClick(filePath, line)}
                />
              );
            }
          }
          return (
            <code className="px-1 py-0.5 rounded bg-[var(--color-bg-tertiary)] text-[var(--color-highlight)] text-xs font-mono break-all">
              {children}
            </code>
          );
        },
        pre: ({ children }) => {
          return <>{children}</>;
        },
        img: ({ src, alt }) => {
          if (!src) return null;
          const resolved = resolveImageUrl ? resolveImageUrl(src) : src;
          return (
            <img
              src={resolved}
              alt={alt ?? ""}
              className={`max-w-full rounded-lg my-2 border border-[var(--color-border)]${onImageClick ? " cursor-pointer hover:opacity-80 transition-opacity" : ""}`}
              onClick={onImageClick ? () => onImageClick(resolved) : undefined}
              onError={(e) => {
                const el = e.currentTarget;
                el.style.display = 'none';
                const placeholder = el.nextElementSibling as HTMLElement | null;
                if (placeholder) placeholder.style.display = 'inline-flex';
              }}
            />
          );
        },
        hr: () => (
          <hr className="border-[var(--color-border)] my-3" />
        ),
        table: ({ children }) => (
          <div className="overflow-x-auto my-2">
            <table className="w-full text-sm border-collapse border border-[var(--color-border)]">
              {children}
            </table>
          </div>
        ),
        thead: ({ children }) => (
          <thead className="bg-[var(--color-bg-tertiary)]">{children}</thead>
        ),
        th: ({ children }) => (
          <th className="border border-[var(--color-border)] px-3 py-1.5 text-left text-xs font-semibold text-[var(--color-text)]">
            {children}
          </th>
        ),
        td: ({ children }) => (
          <td className="border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-text)]">
            {children}
          </td>
        ),
        input: ({ checked, ...props }) => {
          if (props.type === "checkbox") {
            return (
              <span className={`inline-block mr-1.5 ${checked ? "text-[var(--color-success)]" : "text-[var(--color-text-muted)]"}`}>
                {checked ? "✓" : "○"}
              </span>
            );
          }
          return <input {...props} />;
        },
  }), [onFileClick, resolveImageUrl, onMermaidClick, onImageClick, onD2Click, enableRunCommand, sketchContext]);

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={components}
      // react-markdown's default url transform strips non-safe schemes like
      // `sketch:` to an empty href, which would hide sketch chips behind a
      // dead link. Pass sketch:// through untouched; everything else keeps
      // the default sanitization (js/vbscript/file blocked, etc.).
      urlTransform={(url) =>
        url.startsWith("sketch://") ? url : defaultUrlTransform(url)
      }
    >
      {processedContent}
    </ReactMarkdown>
  );
});
