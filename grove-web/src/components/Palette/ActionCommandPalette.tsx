import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Search } from "lucide-react";

import type { CommandDef, KeyBinding } from "../../keyboard";
import {
  commandRegistry,
  contextKeyService,
  effectiveBindings,
  formatKeyDisplay,
  useCommand,
  useContextKey,
  useKeyboardScope,
  parseWhen,
  userKeymapStore,
} from "../../keyboard";

/**
 * The Command Palette — Cmd+Shift+P opens a fuzzy-searchable list of
 * every registered command. Differs from grove's existing
 * `CommandPalette` (task switcher) and `TaskCommandPalette` /
 * `ProjectCommandPalette` (resource switchers): those are scoped to
 * navigation. This one shows everything in the catalog so users can
 * trigger any action, including those without a default binding.
 *
 * Mounted once at the app root. Manages its own visibility; the actual
 * trigger comes from the keymap (catalog binding for
 * `palette.command.open`).
 */
export function ActionCommandPalette() {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // While open, push a scope so palette.command.close (Escape) sits on
  // top of the stack. Also expose `paletteOpen` as a context key so
  // catalog when-expressions can gate on it.
  useKeyboardScope("palette", open);
  useContextKey("paletteOpen", open);
  useContextKey("commandSelected", open && highlightedIndex >= 0);

  // Open / close / execute commands wired through useCommand so the
  // user can rebind any of them.
  useCommand("palette.command.open", () => {
    setOpen((v) => !v);
  });

  useCommand(
    "palette.command.close",
    () => {
      setOpen(false);
    },
    { enabled: () => open },
  );

  // Trigger registry / keymap version so the filtered list invalidates
  // when commands are contributed or user bindings change.
  const registryVersion = useSyncExternalStore(
    (cb) => commandRegistry.subscribe(cb),
    () => commandRegistry.listCommands().length,
  );
  void registryVersion;

  const keymapVersion = useSyncExternalStore(
    (cb) => userKeymapStore.subscribe(cb),
    () => userKeymapStore.getVersion(),
  );
  void keymapVersion;

  const visibleCommands = useMemo<CommandDef[]>(() => {
    if (!open) return [];
    const ctx = contextKeyService.getSnapshot();
    const disabled = userKeymapStore.getDisabled();
    const out: CommandDef[] = [];
    for (const cmd of commandRegistry.listCommands()) {
      if (cmd.hidden) continue;
      if (disabled.has(cmd.id)) continue;
      // Filter by when expression (best-effort — palette shows commands
      // currently fireable in this context).
      const whenStr = cmd.defaultWhen;
      if (whenStr) {
        try {
          if (!parseWhen(whenStr)(ctx)) continue;
        } catch {
          // bad expression — leave the command visible
        }
      }
      out.push(cmd);
    }
    return out;
  }, [open]);

  const filtered = useMemo<CommandDef[]>(() => {
    const q = search.trim().toLowerCase();
    if (!q) return visibleCommands;
    return visibleCommands.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.id.toLowerCase().includes(q) ||
        c.category.toLowerCase().includes(q),
    );
  }, [visibleCommands, search]);

  // Reset state on open transition (render-phase pattern).
  const [wasOpen, setWasOpen] = useState(open);
  if (open && !wasOpen) {
    setWasOpen(true);
    setSearch("");
    setHighlightedIndex(0);
  } else if (!open && wasOpen) {
    setWasOpen(false);
  }

  // Clamp highlight when filtered list shrinks.
  if (highlightedIndex >= filtered.length && filtered.length > 0) {
    setHighlightedIndex(0);
  }

  useEffect(() => {
    if (open) {
      const raf = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(raf);
    }
  }, [open]);

  const executeAt = (index: number) => {
    const cmd = filtered[index];
    if (!cmd) return;
    setOpen(false);
    // Defer so the palette closes first; otherwise the command might
    // re-open the palette or interact with stale focus.
    requestAnimationFrame(() => commandRegistry.invoke(cmd.id));
  };

  // Execute the highlighted command. Mirrors the Enter key path so the
  // catalog command is marked implemented and rebindable. Removed from
  // the input's local onKeyDown to avoid double-firing under the
  // `palette` keyboard scope.
  useCommand(
    "palette.command.execute",
    () => {
      executeAt(highlightedIndex);
    },
    { enabled: () => open },
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Enter is handled by the `palette.command.execute` catalog command
    // (registered via useCommand). Removing the local Enter branch
    // prevents a double-fire under the active `palette` scope.
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightedIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightedIndex((i) => Math.max(i - 1, 0));
    }
  };

  // Scroll highlighted row into view.
  useEffect(() => {
    if (!listRef.current) return;
    const item = listRef.current.querySelector<HTMLElement>(
      `[data-index="${highlightedIndex}"]`,
    );
    if (item) item.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[60] flex items-start justify-center pt-[15vh] bg-black/40 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <motion.div
            initial={{ scale: 0.97, opacity: 0, y: -8 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.97, opacity: 0, y: -8 }}
            transition={{ duration: 0.15 }}
            onClick={(e) => e.stopPropagation()}
            className="w-[560px] max-w-[92vw] bg-[var(--color-bg)] border border-[var(--color-border)] rounded-2xl shadow-2xl overflow-hidden"
            data-hotkeys-dialog="true"
          >
            <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--color-border)]">
              <Search className="w-4 h-4 text-[var(--color-text-muted)] flex-shrink-0" />
              <input
                ref={inputRef}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Search commands..."
                spellCheck={false}
                className="flex-1 bg-transparent outline-none text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]"
              />
              <span className="text-[10px] text-[var(--color-text-muted)] font-mono select-none">
                Esc
              </span>
            </div>

            <div
              ref={listRef}
              className="max-h-[420px] overflow-y-auto py-1"
              style={{ scrollbarWidth: "thin" }}
            >
              {filtered.length === 0 ? (
                <div className="px-4 py-8 text-center text-sm text-[var(--color-text-muted)]">
                  No commands match "{search}"
                </div>
              ) : (
                filtered.map((cmd, i) => (
                  <PaletteRow
                    key={cmd.id}
                    index={i}
                    cmd={cmd}
                    highlighted={i === highlightedIndex}
                    onClick={() => executeAt(i)}
                    onHover={() => setHighlightedIndex(i)}
                  />
                ))
              )}
            </div>

            <div className="flex items-center justify-between px-4 py-2 border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
              <div className="text-[11px] text-[var(--color-text-muted)] select-none flex items-center gap-3">
                <span><kbd className="font-mono">↑↓</kbd> navigate</span>
                <span><kbd className="font-mono">↵</kbd> run</span>
                <span><kbd className="font-mono">Esc</kbd> close</span>
              </div>
              <div className="text-[11px] text-[var(--color-text-muted)] select-none">
                {filtered.length} of {visibleCommands.length}
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

interface PaletteRowProps {
  index: number;
  cmd: CommandDef;
  highlighted: boolean;
  onClick: () => void;
  onHover: () => void;
}

function PaletteRow({ index, cmd, highlighted, onClick, onHover }: PaletteRowProps) {
  const override = userKeymapStore.getOverrides(cmd.id);
  const bindings: KeyBinding[] = effectiveBindings(cmd, override);

  return (
    <div
      data-index={index}
      onClick={onClick}
      onMouseMove={onHover}
      className={[
        "flex items-center gap-3 px-4 py-2 cursor-pointer transition-colors",
        highlighted
          ? "bg-[var(--color-highlight)]/10"
          : "hover:bg-[var(--color-bg-secondary)]",
      ].join(" ")}
    >
      <div className="flex-1 min-w-0">
        <div className="text-sm text-[var(--color-text)] truncate">{cmd.name}</div>
        <div className="text-[11px] text-[var(--color-text-muted)] truncate">
          <span>{cmd.category}</span>
          {cmd.description && (
            <>
              <span> · </span>
              <span>{cmd.description}</span>
            </>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        {bindings.length === 0 ? (
          <span className="text-[10px] text-[var(--color-text-muted)]/70 select-none">
            no binding
          </span>
        ) : (
          bindings.map((b, i) => (
            <kbd
              key={i}
              className="px-1.5 py-0.5 rounded text-[10px] font-mono border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)]"
            >
              {formatKeyDisplay(b.key)}
            </kbd>
          ))
        )}
      </div>
    </div>
  );
}

export default ActionCommandPalette;
