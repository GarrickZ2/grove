import { useState, useRef, useEffect, useCallback } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { VersionOption } from './DiffReviewPage';

interface VersionSelectorProps {
  options: VersionOption[];
  selected: string;
  onChange: (id: string) => void;
}

export function VersionSelector({ options, selected, onChange }: VersionSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedOption = options.find((o) => o.id === selected);

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen]);

  const handleSelect = useCallback((id: string) => {
    onChange(id);
    setIsOpen(false);
  }, [onChange]);

  const Chevron = isOpen ? ChevronUp : ChevronDown;

  return (
    <div className="diff-version-selector" ref={containerRef}>
      <button
        className={`diff-version-trigger ${isOpen ? 'open' : ''}`}
        onClick={() => setIsOpen((v) => !v)}
      >
        <span>{selectedOption?.label ?? selected}</span>
        <Chevron style={{ width: 12, height: 12, opacity: 0.6 }} />
      </button>

      {isOpen && (
        <div className="diff-version-dropdown">
          {options.map((opt) => (
            <button
              key={opt.id}
              className={`diff-version-option ${opt.id === selected ? 'selected' : ''}`}
              onClick={() => handleSelect(opt.id)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
