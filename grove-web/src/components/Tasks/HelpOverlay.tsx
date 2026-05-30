import { useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Search, X } from "lucide-react";
import { KeyBadge } from "../ui";
import { useIsMobile } from "../../hooks";
import {
  useCommand,
  useKeyboardScope,
  formatKeyDisplay,
  effectiveBindings,
  userKeymapStore,
} from "../../keyboard";
import { COMMAND_CATALOG } from "../../keyboard/catalog";
import type { CommandDef } from "../../keyboard";

interface HelpOverlayProps {
  isOpen: boolean;
  onClose: () => void;
}

interface ShortcutGroup {
  title: string;
  entries: { cmd: CommandDef; keys: string[] }[];
}

export function HelpOverlay({ isOpen, onClose }: HelpOverlayProps) {
  const { isMobile } = useIsMobile();
  const [query, setQuery] = useState("");

  useKeyboardScope("helpOverlay", isOpen);
  useCommand("help.close", onClose, [onClose]);

  // Subscribe to user keymap so displayed bindings update live as the
  // user edits Settings. The value isn't read directly — the subscription
  // re-renders the component, which re-runs the plain derivations below
  // (no useMemo: manual memoization here trips the React Compiler's
  // preserve-manual-memoization on the external Map; the compiler
  // auto-memoizes the plain consts instead).
  const keymapToken = useSyncExternalStore(
    (cb) => userKeymapStore.subscribe(cb),
    () => userKeymapStore.getVersion(),
  );
  void keymapToken;

  const overrides = userKeymapStore.getAllOverrides();
  const disabled = userKeymapStore.getDisabled();

  const groups: ShortcutGroup[] = [];
  if (isOpen) {
    const q = query.trim().toLowerCase();
    const byCategory = new Map<string, ShortcutGroup>();
    for (const cmd of COMMAND_CATALOG) {
      if (cmd.hidden) continue;
      if (disabled.has(cmd.id)) continue;
      const bindings = effectiveBindings(cmd, overrides.get(cmd.id));
      if (bindings.length === 0) continue;
      const keys = bindings.map((b) => formatKeyDisplay(b.key));
      // Match command name, category, or the rendered key text so both
      // "rebase" and "⌘⇧B" narrow the list.
      if (
        q &&
        !cmd.name.toLowerCase().includes(q) &&
        !cmd.category.toLowerCase().includes(q) &&
        !keys.some((k) => k.toLowerCase().includes(q))
      ) {
        continue;
      }
      let group = byCategory.get(cmd.category);
      if (!group) {
        group = { title: cmd.category, entries: [] };
        byCategory.set(cmd.category, group);
      }
      group.entries.push({ cmd, keys });
    }
    groups.push(...byCategory.values());
  }

  // Live key(s) for the help toggle itself — shown in the footer instead
  // of a hard-coded "?", so it tracks the user's binding for help.toggle.
  const helpToggle = COMMAND_CATALOG.find((c) => c.id === "help.toggle");
  const helpKeys = helpToggle
    ? effectiveBindings(helpToggle, overrides.get(helpToggle.id)).map((b) => formatKeyDisplay(b.key))
    : [];

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/50 z-[100]"
          />

          <motion.div
            initial={isMobile ? { y: "100%" } : { opacity: 0, scale: 0.95, y: 20 }}
            animate={isMobile ? { y: 0 } : { opacity: 1, scale: 1, y: 0 }}
            exit={isMobile ? { y: "100%" } : { opacity: 0, scale: 0.95, y: 20 }}
            transition={
              isMobile
                ? { type: "spring", damping: 30, stiffness: 300 }
                : { duration: 0.2 }
            }
            className={
              isMobile
                ? "fixed inset-x-0 bottom-0 z-[100]"
                : "fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[100] w-full max-w-2xl"
            }
          >
            {/* Card is the flex column: header + search stay pinned, only
                the body scrolls, footer stays pinned. overflow-hidden keeps
                the scrollbar inside the rounded corners. */}
            <div
              className={`flex flex-col bg-[var(--color-bg-secondary)] border border-[var(--color-border)] ${
                isMobile ? "rounded-t-2xl max-h-[85vh]" : "rounded-xl max-h-[80vh]"
              } shadow-xl overflow-hidden`}
            >
              {isMobile && (
                <div className="shrink-0 flex justify-center pt-3 pb-1">
                  <div className="w-10 h-1 rounded-full bg-[var(--color-border)]" />
                </div>
              )}

              {/* Header + search — pinned */}
              <div className="shrink-0 border-b border-[var(--color-border)]">
                <div className="flex items-center justify-between px-5 pt-3 pb-2">
                  <h2 className="text-base font-semibold text-[var(--color-text)]">
                    Keyboard Shortcuts
                  </h2>
                  <button
                    onClick={onClose}
                    className="p-1.5 rounded-lg hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                <div className="px-5 pb-3">
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)] pointer-events-none" />
                    <input
                      type="text"
                      autoFocus={!isMobile}
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search shortcuts..."
                      className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-highlight)]/40 focus:border-[var(--color-highlight)]"
                    />
                  </div>
                </div>
              </div>

              {/* Body — the only scrollable region */}
              <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
                {groups.length === 0 ? (
                  <div className="py-10 text-center text-sm text-[var(--color-text-muted)]">
                    No shortcuts match &ldquo;{query}&rdquo;.
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-5">
                    {groups.map((group) => (
                      <div key={group.title}>
                        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-2">
                          {group.title}
                        </h3>
                        <div className="space-y-1">
                          {group.entries.map(({ cmd, keys }) => (
                            <div
                              key={cmd.id}
                              className="flex items-center justify-between py-1 gap-2"
                            >
                              <span
                                className="text-xs text-[var(--color-text)] truncate"
                                title={cmd.description ?? cmd.id}
                              >
                                {cmd.name}
                              </span>
                              <div className="flex items-center gap-1 flex-shrink-0">
                                {keys.map((key, ki) => (
                                  <span key={ki} className="flex items-center gap-0.5">
                                    {ki > 0 && (
                                      <span className="text-[10px] text-[var(--color-text-muted)] mx-0.5">
                                        /
                                      </span>
                                    )}
                                    <KeyBadge>{key}</KeyBadge>
                                  </span>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Footer — pinned */}
              <div className="shrink-0 px-5 py-3 border-t border-[var(--color-border)] bg-[var(--color-bg)] flex items-center justify-between">
                <p className="text-xs text-[var(--color-text-muted)]">
                  Configure shortcuts in <span className="text-[var(--color-text)]">Settings → Keyboard Shortcuts</span>
                </p>
                <p className="text-xs text-[var(--color-text-muted)] flex items-center gap-1">
                  Press
                  {(helpKeys.length > 0 ? helpKeys : ["Esc"]).map((k, i) => (
                    <KeyBadge key={i}>{k}</KeyBadge>
                  ))}
                  or <KeyBadge>Esc</KeyBadge> to close
                </p>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  );
}
