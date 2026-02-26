import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownRendererProps {
  content: string;
}

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
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
        a: ({ href, children }) => (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--color-highlight)] hover:underline"
          >
            {children}
          </a>
        ),
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
