import { Children, isValidElement } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { VSCodeIcon } from "./VSCodeIcon";

// Match file paths like `path/to/file.ext` or `path/to/file.ext:123`
// Must contain at least one `/` and end with a known extension (optionally followed by `:line`)
const FILE_PATH_RE = /^([\w./-]+\/[\w./-]+\.[\w]+)(?::(\d+))?[,.]?$/;

// Match href that looks like a file path (possibly with #L<line> anchor)
// e.g. "service/foo.go", "service/foo.go:505", or ends with "#L505"
const FILE_HREF_RE = /^(?!https?:\/\/|mailto:)([\w./@-]+\/[\w./@-]+\.[\w]+)(?:[:#]L?(\d+))?$/;

interface MarkdownRendererProps {
  content: string;
  /** When provided, inline code matching file path patterns become clickable */
  onFileClick?: (filePath: string, line?: number) => void;
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

export function MarkdownRenderer({ content, onFileClick }: MarkdownRendererProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
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
          <p className="text-sm text-[var(--color-text)] mb-2 last:mb-0 [li>&]:mb-0">{children}</p>
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
            const hrefMatch = href.match(FILE_HREF_RE);
            if (hrefMatch) {
              const filePath = hrefMatch[1];
              const line = hrefMatch[2] ? parseInt(hrefMatch[2], 10) : undefined;
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
          return (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--color-highlight)] hover:underline"
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
          const isBlock = className?.startsWith("language-");
          if (isBlock) {
            return (
              <code className="block text-xs font-mono">{children}</code>
            );
          }
          // Check if inline code looks like a file path
          if (onFileClick) {
            const text = extractText(children);
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
        pre: ({ children }) => (
          <pre className="rounded-lg bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] p-3 my-2 whitespace-pre-wrap break-words text-xs font-mono text-[var(--color-text)]">
            {children}
          </pre>
        ),
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
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
