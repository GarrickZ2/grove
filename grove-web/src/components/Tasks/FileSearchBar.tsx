import { useState, useEffect, useRef, useCallback } from "react";
import { Search } from "lucide-react";
import { getTaskFiles } from "../../api";

interface FileSearchBarProps {
  projectId: string;
  taskId: string;
}

interface MatchResult {
  path: string;
  score: number;
  indices: number[]; // matched character indices for highlighting
}

function fuzzyMatch(
  query: string,
  target: string
): { match: boolean; score: number; indices: number[] } {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  let score = 0;
  let lastMatchIndex = -1;
  const indices: number[] = [];

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      // Consecutive match bonus
      score += ti === lastMatchIndex + 1 ? 2 : 1;
      // Path segment start bonus
      if (ti === 0 || t[ti - 1] === "/") score += 3;
      lastMatchIndex = ti;
      indices.push(ti);
      qi++;
    }
  }

  return { match: qi === q.length, score, indices };
}

function HighlightedPath({
  path,
  indices,
}: {
  path: string;
  indices: number[];
}) {
  const indexSet = new Set(indices);
  return (
    <span>
      {Array.from(path).map((char, i) =>
        indexSet.has(i) ? (
          <span key={i} className="text-[var(--color-accent)] font-semibold">
            {char}
          </span>
        ) : (
          <span key={i}>{char}</span>
        )
      )}
    </span>
  );
}

export function FileSearchBar({ projectId, taskId }: FileSearchBarProps) {
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Load files on mount
  useEffect(() => {
    getTaskFiles(projectId, taskId)
      .then((res) => setFiles(res.files))
      .catch(() => {});
  }, [projectId, taskId]);

  // Ctrl+F / Cmd+F to focus search bar
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    document.addEventListener("keydown", handleGlobalKeyDown);
    return () => document.removeEventListener("keydown", handleGlobalKeyDown);
  }, []);

  // Filter and sort by fuzzy match
  const results: MatchResult[] = query.trim()
    ? files
        .map((path) => {
          const { match, score, indices } = fuzzyMatch(query, path);
          return { path, score, indices, match };
        })
        .filter((r) => r.match)
        .sort((a, b) => b.score - a.score)
        .slice(0, 15)
    : [];

  // Reset highlight when results change
  useEffect(() => {
    setHighlightIndex(0);
  }, [query]);

  // Scroll highlighted item into view
  useEffect(() => {
    if (listRef.current) {
      const item = listRef.current.children[highlightIndex] as HTMLElement;
      item?.scrollIntoView({ block: "nearest" });
    }
  }, [highlightIndex]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2000);
  }, []);

  const closeAndReset = useCallback(() => {
    setIsOpen(false);
    setQuery("");
    setSelected(new Set());
    inputRef.current?.blur();
  }, []);

  const copyToClipboard = useCallback(
    (text: string) => {
      navigator.clipboard.writeText(text).then(
        () => {
          showToast(`Copied: ${text.length > 60 ? text.slice(0, 57) + "..." : text}`);
          closeAndReset();
        },
        () => showToast("Failed to copy")
      );
    },
    [showToast, closeAndReset]
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen || results.length === 0) return;

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setHighlightIndex((prev) =>
          prev < results.length - 1 ? prev + 1 : prev
        );
        break;
      case "ArrowUp":
        e.preventDefault();
        setHighlightIndex((prev) => (prev > 0 ? prev - 1 : prev));
        break;
      case "Tab":
        e.preventDefault();
        {
          const path = results[highlightIndex]?.path;
          if (path) {
            setSelected((prev) => {
              const next = new Set(prev);
              if (next.has(path)) {
                next.delete(path);
              } else {
                next.add(path);
              }
              return next;
            });
          }
        }
        break;
      case "Enter":
        e.preventDefault();
        if (selected.size > 0) {
          copyToClipboard(Array.from(selected).join(" "));
        } else if (results[highlightIndex]) {
          copyToClipboard(results[highlightIndex].path);
        }
        break;
      case "Escape":
        e.preventDefault();
        closeAndReset();
        break;
    }
  };

  const toggleSelect = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  return (
    <div className="relative px-3 py-1.5">
      {/* Search Input */}
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] focus-within:border-[var(--color-accent)] transition-colors">
        <Search size={14} className="text-[var(--color-text-muted)] shrink-0" />
        <input
          ref={inputRef}
          type="text"
          placeholder="Search files... (Tab: select, Enter: copy, Ctrl+F)"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIsOpen(true);
          }}
          onFocus={() => query.trim() && setIsOpen(true)}
          onKeyDown={handleKeyDown}
          className="flex-1 bg-transparent text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] outline-none"
        />
        {selected.size > 0 && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-accent)] text-white font-medium">
            {selected.size}
          </span>
        )}
      </div>

      {/* Results Dropdown */}
      {isOpen && results.length > 0 && (
        <div
          ref={listRef}
          className="absolute left-3 right-3 mt-1 max-h-[300px] overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] shadow-lg z-50"
        >
          {results.map((result, idx) => (
            <div
              key={result.path}
              className={`flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer ${
                idx === highlightIndex
                  ? "bg-[var(--color-highlight)]/15"
                  : "hover:bg-[var(--color-bg-secondary)]"
              }`}
              onClick={() => toggleSelect(result.path)}
            >
              <span
                className={`w-3.5 h-3.5 rounded border shrink-0 flex items-center justify-center ${
                  selected.has(result.path)
                    ? "bg-[var(--color-accent)] border-[var(--color-accent)]"
                    : "border-[var(--color-border)]"
                }`}
              >
                {selected.has(result.path) && (
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 10 10"
                    fill="none"
                    className="text-white"
                  >
                    <path
                      d="M2 5L4 7L8 3"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </span>
              <span className="text-[var(--color-text)] truncate font-mono text-xs">
                <HighlightedPath path={result.path} indices={result.indices} />
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className="absolute left-1/2 -translate-x-1/2 -top-8 px-3 py-1 rounded-md bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] shadow-lg z-50 whitespace-nowrap">
          <span className="text-xs text-[var(--color-text)]">{toast}</span>
        </div>
      )}
    </div>
  );
}
