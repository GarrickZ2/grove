import { Children, isValidElement, useState, useEffect, useRef, useId, memo, useMemo } from "react";
import { Check, Copy } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import mermaid from "mermaid";
import { VSCodeIcon } from "./VSCodeIcon";
import { highlightCode, normalizeLanguage } from "../Review/syntaxHighlight";
import { useTheme } from "../../context/ThemeContext";
import { openExternalUrl } from "../../utils/openExternal";

// Match file paths like `path/to/file.ext` or `path/to/file.ext:123`.
// Accept Unicode and other non-ASCII characters in path segments.
const FILE_PATH_RE = /^(.+\/[^/]+?\.[A-Za-z0-9]+)(?::(\d+))?[,.]?$/;

// Match local file hrefs after decoding percent-encoded characters.
// e.g. "service/foo.go", "/abs/path/中文名.md", or ends with "#L505"
const FILE_HREF_RE = /^(.+\/[^/]+?\.[A-Za-z0-9]+)(?:[:#]L?(\d+))?$/;

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

// Module-level SVG cache: code → rendered SVG string.
// Survives component re-mounts so cached diagrams are shown instantly.
const mermaidSvgCache = new Map<string, string>();

export const MermaidBlock = memo(function MermaidBlock({ code, onPreviewClick }: { code: string; onPreviewClick?: (svg: string) => void }): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const uniqueId = useId();
  const { theme } = useTheme();
  const cacheKey = `${theme.id}::${code}`;
  const [svg, setSvg] = useState<string | null>(() => mermaidSvgCache.get(cacheKey) ?? null);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div
      ref={containerRef}
      className={`rounded-lg border border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-bg-secondary)_72%,transparent)] p-3 my-2 overflow-x-auto flex justify-center [&_svg]:max-w-full ${onPreviewClick ? "cursor-pointer hover:border-[var(--color-highlight)] transition-colors" : ""}`}
      dangerouslySetInnerHTML={{ __html: svg }}
      onClick={onPreviewClick ? () => {
        const responsive = svg
          .replace(/\s*width="[^"]*"/, ' width="100%"')
          .replace(/\s*height="[^"]*"/, ' height="100%"')
          .replace(/(<svg[^>]*?)(?=\s*>)/, '$1 style="max-width:90vw;max-height:85vh;width:auto;height:auto;" preserveAspectRatio="xMidYMid meet"');
        onPreviewClick(responsive);
      } : undefined}
    />
  );
});

function CodeBlock({
  code,
  language,
}: {
  code: string;
  language?: string;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const normalizedLanguage = normalizeLanguage(language);
  const highlightedHtml = highlightCode(code, normalizedLanguage);

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

  return (
    <div className="markdown-code-block group relative my-2 overflow-hidden rounded-xl border border-[color-mix(in_srgb,var(--color-border)_90%,transparent)] bg-[color-mix(in_srgb,var(--color-bg-secondary)_92%,var(--color-bg))]">
      <div className="absolute right-2 top-2 z-10">
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-transparent text-[var(--color-text-muted)] opacity-0 transition-all group-hover:opacity-100 hover:text-[var(--color-text)] focus:opacity-100 focus:outline-none"
          title="Copy code"
          aria-label={copied ? "Copied" : "Copy code"}
        >
          {copied ? <Check className="h-3.5 w-3.5 text-[var(--color-success)]" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>
      <pre className="m-0 overflow-x-auto bg-[color-mix(in_srgb,var(--color-bg-tertiary)_72%,white_18%)] p-4 text-[13px] font-mono leading-6 whitespace-pre text-[var(--color-text)]">
        <code
          className="block"
          dangerouslySetInnerHTML={{ __html: highlightedHtml }}
        />
      </pre>
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
  /** When provided, clicking an inline image triggers this callback with the resolved URL */
  onImageClick?: (url: string) => void;
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

export const MarkdownRenderer = memo(function MarkdownRenderer({ content, onFileClick, resolveImageUrl, onMermaidClick, onImageClick }: MarkdownRendererProps) {
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
          const isBlock = className?.startsWith("language-") || text.includes("\n");
          if (isBlock) {
            if (className === "language-mermaid") {
              return <MermaidBlock code={text} onPreviewClick={onMermaidClick} />;
            }
            const language = className?.replace(/^language-/, "");
            return <CodeBlock code={text.replace(/\n$/, "")} language={language} />;
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
            <code className="px-1 py-0.5 rounded bg-[var(--color-bg-tertiary)] text-[var(--color-highlight)] text-xs font-mono">
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
  }), [onFileClick, resolveImageUrl, onMermaidClick, onImageClick]);

  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {content}
    </ReactMarkdown>
  );
});
