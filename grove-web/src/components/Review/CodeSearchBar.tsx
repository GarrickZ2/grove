import { X, Search, CaseSensitive, ChevronUp, ChevronDown } from 'lucide-react';
import { useEffect, useRef } from 'react';

interface CodeSearchBarProps {
  visible: boolean;
  query: string;
  caseSensitive: boolean;
  currentIndex: number;
  totalMatches: number;
  onQueryChange: (query: string) => void;
  onCaseSensitiveToggle: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
}

export function CodeSearchBar({
  visible,
  query,
  caseSensitive,
  currentIndex,
  totalMatches,
  onQueryChange,
  onCaseSensitiveToggle,
  onPrevious,
  onNext,
  onClose,
}: CodeSearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus input when visible
  useEffect(() => {
    if (visible && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [visible]);

  if (!visible) return null;

  const hasMatches = totalMatches > 0;
  const matchText = query && hasMatches
    ? `${currentIndex + 1}/${totalMatches}`
    : query && !hasMatches
    ? 'No matches'
    : '';

  return (
    <div
      style={{
        position: 'fixed',
        top: '60px',
        right: '20px',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        background: 'var(--color-bg-secondary)',
        border: '1px solid var(--color-border)',
        borderRadius: '8px',
        padding: '8px 12px',
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
      }}
    >
      <Search style={{ width: 14, height: 14, color: 'var(--color-text-muted)' }} />
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder="Search in code..."
        style={{
          width: '240px',
          padding: '4px 8px',
          background: 'var(--color-bg)',
          border: '1px solid var(--color-border)',
          borderRadius: '4px',
          color: 'var(--color-text)',
          fontSize: '13px',
          outline: 'none',
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            onClose();
          } else if (e.key === 'Enter') {
            if (e.shiftKey) {
              onPrevious();
            } else {
              onNext();
            }
          }
        }}
      />
      {matchText && (
        <span
          style={{
            fontSize: '12px',
            color: hasMatches ? 'var(--color-text-muted)' : 'var(--color-error)',
            minWidth: '60px',
            textAlign: 'center',
          }}
        >
          {matchText}
        </span>
      )}
      <button
        onClick={onPrevious}
        disabled={!hasMatches}
        title="Previous match (Shift+Enter)"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '4px',
          background: 'transparent',
          border: '1px solid var(--color-border)',
          borderRadius: '4px',
          color: hasMatches ? 'var(--color-text)' : 'var(--color-text-muted)',
          cursor: hasMatches ? 'pointer' : 'not-allowed',
          opacity: hasMatches ? 1 : 0.5,
        }}
      >
        <ChevronUp style={{ width: 13, height: 13 }} />
      </button>
      <button
        onClick={onNext}
        disabled={!hasMatches}
        title="Next match (Enter)"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '4px',
          background: 'transparent',
          border: '1px solid var(--color-border)',
          borderRadius: '4px',
          color: hasMatches ? 'var(--color-text)' : 'var(--color-text-muted)',
          cursor: hasMatches ? 'pointer' : 'not-allowed',
          opacity: hasMatches ? 1 : 0.5,
        }}
      >
        <ChevronDown style={{ width: 13, height: 13 }} />
      </button>
      <button
        onClick={onCaseSensitiveToggle}
        title="Case sensitive"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '4px 6px',
          background: caseSensitive ? 'var(--color-highlight)' : 'transparent',
          border: '1px solid var(--color-border)',
          borderRadius: '4px',
          color: caseSensitive ? 'var(--color-bg)' : 'var(--color-text-muted)',
          cursor: 'pointer',
          fontSize: '11px',
          fontWeight: 600,
        }}
      >
        <CaseSensitive style={{ width: 13, height: 13 }} />
      </button>
      <button
        onClick={onClose}
        title="Close (ESC)"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '2px',
          background: 'transparent',
          border: 'none',
          color: 'var(--color-text-muted)',
          cursor: 'pointer',
        }}
      >
        <X style={{ width: 14, height: 14 }} />
      </button>
    </div>
  );
}
