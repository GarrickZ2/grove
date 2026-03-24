import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Search } from "lucide-react";
import { useCommandPalette } from "../../context/CommandPaletteContext";
import type { Command } from "../../context/CommandPaletteContext";
import { KeyBadge } from "./KeyBadge";

interface CommandGroup {
  category: string;
  commands: Command[];
}

export function CommandPalette() {
  const { isOpen, close, getCommands } = useCommandPalette();
  const [searchQuery, setSearchQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Build commands lazily — only when palette is open
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const allCommands = useMemo(() => isOpen ? getCommands() : [], [isOpen]);

  // Filter commands by search query
  const filteredCommands = useMemo(() => {
    if (!searchQuery) return allCommands;
    const q = searchQuery.toLowerCase();
    return allCommands.filter(
      (cmd) =>
        cmd.name.toLowerCase().includes(q) ||
        cmd.keywords?.some((kw) => kw.toLowerCase().includes(q))
    );
  }, [allCommands, searchQuery]);

  // Group filtered commands by category
  const groups = useMemo(() => {
    const map = new Map<string, typeof filteredCommands>();
    for (const cmd of filteredCommands) {
      const existing = map.get(cmd.category);
      if (existing) {
        existing.push(cmd);
      } else {
        map.set(cmd.category, [cmd]);
      }
    }
    return Array.from(map.entries()).map(([category, commands]) => ({
      category,
      commands,
    })) as CommandGroup[];
  }, [filteredCommands]);

  // Flat list for keyboard navigation
  const flatCommands = useMemo(
    () => groups.flatMap((g) => g.commands),
    [groups]
  );

  // Reset state when opening
  useEffect(() => {
    if (isOpen) {
      setSearchQuery("");
      setHighlightedIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isOpen]);

  // Reset highlight on search change
  useEffect(() => {
    setHighlightedIndex(0);
  }, [searchQuery]);

  // Scroll highlighted item into view
  useEffect(() => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll("[data-cmd-item]");
    const item = items[highlightedIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex]);

  const handleSelect = useCallback(
    (cmd: Command) => {
      close();
      // Defer handler to allow dialog to close first
      requestAnimationFrame(() => cmd.handler());
    },
    [close]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Skip during IME composition (e.g. Chinese/Japanese input)
      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setHighlightedIndex((prev) =>
            prev < flatCommands.length - 1 ? prev + 1 : 0
          );
          break;
        case "ArrowUp":
          e.preventDefault();
          setHighlightedIndex((prev) =>
            prev > 0 ? prev - 1 : flatCommands.length - 1
          );
          break;
        case "Enter":
          e.preventDefault();
          if (flatCommands[highlightedIndex]) {
            handleSelect(flatCommands[highlightedIndex]);
          }
          break;
        case "Escape":
          e.preventDefault();
          close();
          break;
      }
    },
    [flatCommands, highlightedIndex, handleSelect, close]
  );

  // Track flat index across groups for highlighting
  let flatIndex = -1;

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={close}
            className="fixed inset-0 bg-black/50 z-50"
            data-hotkeys-dialog
          />

          {/* Palette */}
          <motion.div
            initial={{ opacity: 0, y: -20, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20, scale: 0.98 }}
            transition={{ duration: 0.15 }}
            className="fixed left-1/2 top-[15%] -translate-x-1/2 z-50 w-full max-w-lg"
            onKeyDown={handleKeyDown}
          >
            <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl shadow-2xl overflow-hidden">
              {/* Search Input */}
              <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--color-border)]">
                <Search className="w-4 h-4 text-[var(--color-text-muted)] flex-shrink-0" />
                <input
                  ref={inputRef}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Type a command..."
                  className="flex-1 bg-transparent text-sm text-[var(--color-text)] placeholder-[var(--color-text-muted)] outline-none"
                />
                <kbd className="hidden sm:inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-text-muted)] bg-[var(--color-bg)] border border-[var(--color-border)] rounded">
                  ESC
                </kbd>
              </div>

              {/* Command List */}
              <div ref={listRef} className="max-h-80 overflow-y-auto py-1">
                {flatCommands.length === 0 ? (
                  <div className="px-4 py-8 text-center text-sm text-[var(--color-text-muted)]">
                    No commands found
                  </div>
                ) : (
                  groups.map((group) => (
                    <div key={group.category}>
                      {/* Category Header */}
                      <div className="px-4 pt-2 pb-1">
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
                          {group.category}
                        </span>
                      </div>
                      {/* Commands */}
                      {group.commands.map((cmd) => {
                        flatIndex++;
                        const idx = flatIndex;
                        const Icon = cmd.icon;
                        return (
                          <button
                            key={cmd.id}
                            data-cmd-item
                            onClick={() => handleSelect(cmd)}
                            onMouseEnter={() => setHighlightedIndex(idx)}
                            className={`w-full flex items-center gap-3 px-4 py-2 transition-colors ${
                              idx === highlightedIndex
                                ? "bg-[var(--color-highlight)]/10"
                                : "hover:bg-[var(--color-bg-tertiary)]"
                            }`}
                          >
                            {Icon && (
                              <Icon className="w-4 h-4 text-[var(--color-text-muted)] flex-shrink-0" />
                            )}
                            <span className="flex-1 text-left text-sm text-[var(--color-text)]">
                              {cmd.name}
                            </span>
                            {cmd.shortcut && (
                              <KeyBadge>{cmd.shortcut}</KeyBadge>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  ))
                )}
              </div>

              {/* Footer */}
              <div className="flex items-center gap-3 px-4 py-2 border-t border-[var(--color-border)] text-[10px] text-[var(--color-text-muted)]">
                <span className="flex items-center gap-1">
                  <kbd className="inline-flex items-center px-1 py-0.5 font-medium bg-[var(--color-bg)] border border-[var(--color-border)] rounded">
                    &uarr;&darr;
                  </kbd>
                  navigate
                </span>
                <span className="flex items-center gap-1">
                  <kbd className="inline-flex items-center px-1 py-0.5 font-medium bg-[var(--color-bg)] border border-[var(--color-border)] rounded">
                    &crarr;
                  </kbd>
                  select
                </span>
                <span className="flex items-center gap-1">
                  <kbd className="inline-flex items-center px-1 py-0.5 font-medium bg-[var(--color-bg)] border border-[var(--color-border)] rounded">
                    esc
                  </kbd>
                  close
                </span>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
