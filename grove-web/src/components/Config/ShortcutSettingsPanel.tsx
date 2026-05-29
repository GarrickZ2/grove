import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  ChevronRight,
  EyeOff,
  Keyboard,
  Lock,
  Pencil,
  RotateCcw,
  Search,
  X,
} from "lucide-react";

import type { CommandDef, Conflict, KeymapOverride } from "../../keyboard";
import {
  commandRegistry,
  detectConflicts,
  effectiveBindings,
  formatKeyboardEvent,
  formatKeyDisplay,
  keyboardManager,
  persistOverrides,
  persistRemoveOverride,
  persistDisabled,
  persistResetAll,
  userKeymapStore,
} from "../../keyboard";
import { ShortcutEditModal, type BindingDraft } from "./ShortcutEditModal";
import { ConfirmDialog } from "../Dialogs/ConfirmDialog";
import { Checkbox } from "../ui/Checkbox";

/**
 * Settings panel for binding customisation. Reads the full catalog,
 * merges user overrides on top, surfaces conflicts inline, and lets the
 * user edit / disable / reset per command.
 *
 * Layout (matches the design in the plan):
 *   - top bar: search + filters + Reset All
 *   - sticky category headers
 *   - one row per command: name | binding | description | actions
 */
export function ShortcutSettingsPanel() {
  const [search, setSearch] = useState("");
  const [conflictsOnly, setConflictsOnly] = useState(false);
  const [customizedOnly, setCustomizedOnly] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  // Shortcut search: a separate filter that matches commands by their
  // actual key binding. The user clicks the keyboard icon to enter
  // "record mode" (suppressing the dispatcher), presses the combo, and
  // the captured key string filters the list. Independent from `search`
  // so they can be combined.
  const [keyRecording, setKeyRecording] = useState(false);
  const [keyFilter, setKeyFilter] = useState("");
  const [editing, setEditing] = useState<CommandDef | null>(null);
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());

  // Subscribe to command registry so the command list refreshes when
  // components mount/unmount and contribute new commands or remove them.
  const registryVersion = useSyncExternalStore(
    (cb) => commandRegistry.subscribe(cb),
    () => commandRegistry.listCommands().length,
  );
  void registryVersion;

  // Show every command the registry knows about — static catalog +
  // runtime-contributed (useDefineCommand). Equally configurable.
  const allCommands = useMemo(
    () => commandRegistry.listCommands(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- registry version above tracks this
    [registryVersion],
  );

  // Subscribe to user keymap. Snapshot is a monotonic counter so React
  // re-renders on ANY mutation, including in-place edits where size
  // wouldn't change (`overrides.size` stays 1 when modifying an existing
  // override).
  const keymapVersion = useSyncExternalStore(
    (cb) => userKeymapStore.subscribe(cb),
    () => userKeymapStore.getVersion(),
  );

  const overrides = userKeymapStore.getAllOverrides();
  const disabled = userKeymapStore.getDisabled();

  const conflicts = useMemo(
    () => detectConflicts(allCommands, overrides, disabled),
    // overrides / disabled are mutated in place — their reference doesn't
    // change. Use keymapVersion as the actual invalidation token.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [keymapVersion],
  );

  const conflictsByCommand = useMemo(() => {
    const map = new Map<string, Conflict[]>();
    for (const c of conflicts) {
      for (const id of c.commandIds) {
        const list = map.get(id) ?? [];
        list.push(c);
        map.set(id, list);
      }
    }
    return map;
  }, [conflicts]);

  // All distinct scope ids from the catalog (for edit modal dropdown).
  const scopeOptions = useMemo(() => {
    const set = new Set<string>();
    for (const c of allCommands) {
      if (c.scope) set.add(c.scope);
    }
    return Array.from(set).sort();
  }, [allCommands]);

  // Record-mode key filter: capture one combo and stash it in keyFilter.
  // Suspends KeyboardManager dispatch so pressing Ctrl+Shift+P doesn't
  // also open the Command Palette while we're capturing.
  useEffect(() => {
    if (!keyRecording) return;
    const releaseSuppress = keyboardManager.pushSuppress();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Meta" || e.key === "Control" || e.key === "Alt" || e.key === "Shift") {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      setKeyFilter(formatKeyboardEvent(e));
      setKeyRecording(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      releaseSuppress();
    };
  }, [keyRecording]);

  // Plain filter — React Compiler auto-memoizes; manual useMemo here
  // tripped react-hooks/preserve-manual-memoization because `overrides`
  // is an external Map whose stability the compiler can't prove.
  const q = search.trim().toLowerCase();
  const kf = keyFilter.toLowerCase();
  const filtered = allCommands.filter((c) => {
    // In "Conflicts only" mode, never hide a command that's part of a
    // conflict — otherwise a conflict whose other party is a hidden command
    // shows just one row and looks like "it conflicts with itself".
    if (!showHidden && c.hidden && !(conflictsOnly && conflictsByCommand.has(c.id)))
      return false;
    if (conflictsOnly && !conflictsByCommand.has(c.id)) return false;
    if (customizedOnly && !overrides.has(c.id)) return false;

    // Key filter: command must have a binding whose raw or display
    // form matches the recorded combo (case-insensitive).
    if (kf) {
      const bindings = effectiveBindings(c, overrides.get(c.id));
      const hit = bindings.some(
        (b) =>
          b.key.toLowerCase() === kf ||
          formatKeyDisplay(b.key).toLowerCase() === formatKeyDisplay(keyFilter).toLowerCase(),
      );
      if (!hit) return false;
    }

    if (!q) return true;
    return (
      c.id.toLowerCase().includes(q) ||
      c.name.toLowerCase().includes(q) ||
      (c.category ?? "").toLowerCase().includes(q) ||
      (c.description ?? "").toLowerCase().includes(q)
    );
  });

  // Grouping. Normally by category (catalog order). In "Conflicts only" mode,
  // group by the conflicting key instead — so commands that clash on the same
  // key sit together and you can see who fights whom. Plain expression: the
  // React Compiler memoizes; a manual useMemo here trips
  // preserve-manual-memoization since `filtered` is compiler-managed.
  const groupedMap = new Map<string, CommandDef[]>();
  if (conflictsOnly) {
    for (const c of filtered) {
      const cs = conflictsByCommand.get(c.id) ?? [];
      const keys =
        cs.length > 0 ? Array.from(new Set(cs.map((x) => x.key))) : ["(unknown)"];
      for (const k of keys) {
        const title = `Conflict: ${formatKeyDisplay(k)}`;
        const list = groupedMap.get(title) ?? [];
        list.push(c);
        groupedMap.set(title, list);
      }
    }
  } else {
    for (const c of filtered) {
      const list = groupedMap.get(c.category) ?? [];
      list.push(c);
      groupedMap.set(c.category, list);
    }
  }
  const grouped = Array.from(groupedMap.entries());

  const toggleCategory = (cat: string) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const handleResetAll = () => {
    setResetConfirmOpen(true);
  };

  const handleResetAllConfirm = async () => {
    setResetConfirmOpen(false);
    try {
      await persistResetAll();
    } catch (e) {
      console.error("Reset all failed:", e);
    }
  };

  const handleEditSave = async (drafts: BindingDraft[]) => {
    if (!editing) return;
    const cmd = editing;
    const valid = drafts.filter((d) => d.key.trim());
    // Empty list = explicit unbind: persist a single empty-key row so the
    // override shadows the catalog default. (That differs from "reset to
    // default", which removes the override entirely — the Reset button.)
    // Each surviving draft keeps its OWN when + scope (VSCode/Zed model).
    const bindings: KeymapOverride[] =
      valid.length === 0
        ? [
            {
              command_id: cmd.id,
              key: "",
              when_ctx: undefined,
              scope: undefined,
            },
          ]
        : valid.map((d) => ({
            command_id: cmd.id,
            key: d.key,
            when_ctx: d.when.trim() || undefined,
            scope: d.scope.trim() || undefined,
          }));
    try {
      await persistOverrides(cmd.id, bindings);
      setEditing(null);
    } catch (e) {
      console.error("Save override failed:", e);
      alert("Failed to save shortcut. See console.");
    }
  };

  const handleReset = async (cmd: CommandDef) => {
    try {
      await persistRemoveOverride(cmd.id);
    } catch (e) {
      // 404 = already at default; treat as success.
      console.warn(`Reset ${cmd.id}: ${e}`);
    }
  };

  const handleToggleDisabled = async (cmd: CommandDef) => {
    try {
      await persistDisabled(cmd.id, !disabled.has(cmd.id));
    } catch (e) {
      console.error("Toggle disabled failed:", e);
    }
  };

  return (
    <div
      className="flex flex-col rounded-lg border border-[var(--color-border)] overflow-hidden bg-[var(--color-bg)]"
      style={{ height: "min(640px, calc(100vh - 280px))" }}
    >
      {/* Fixed header: search + filters + conflict banner + stats. Stays
          visible while the command list scrolls beneath it. */}
      <div className="flex-shrink-0 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-3 space-y-2">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search commands..."
              className="w-full pl-9 pr-24 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-highlight)]"
            />
            {/* Key-search toggle + recorded-key chip live inside the input
                box on the right so they're visually attached to the
                search field rather than floating in the toolbar. */}
            <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-1">
              {keyFilter && !keyRecording && (
                <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--color-highlight)]/15 text-[var(--color-highlight)] text-[11px] font-mono">
                  {formatKeyDisplay(keyFilter)}
                  <button
                    onClick={() => setKeyFilter("")}
                    title="Clear shortcut filter"
                    className="hover:text-[var(--color-text)] transition-colors"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              )}
              <button
                onClick={() => {
                  if (keyRecording) {
                    setKeyRecording(false);
                  } else {
                    setKeyFilter("");
                    setKeyRecording(true);
                  }
                }}
                title={
                  keyRecording
                    ? "Press the combo to filter by (Esc to cancel)"
                    : "Search by shortcut — click then press a key combo"
                }
                className={[
                  "p-1.5 rounded transition-colors",
                  keyRecording
                    ? "bg-[var(--color-highlight)] text-white animate-pulse"
                    : "text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-secondary)]",
                ].join(" ")}
              >
                <Keyboard className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
          <Checkbox
            checked={showHidden}
            onChange={setShowHidden}
            label="Show hidden"
            className="text-xs text-[var(--color-text-muted)] whitespace-nowrap"
          />
          <Checkbox
            checked={conflictsOnly}
            onChange={setConflictsOnly}
            label="Conflicts only"
            className="text-xs text-[var(--color-text-muted)] whitespace-nowrap"
          />
          <Checkbox
            checked={customizedOnly}
            onChange={setCustomizedOnly}
            label="Customised only"
            className="text-xs text-[var(--color-text-muted)] whitespace-nowrap"
          />
          <button
            onClick={handleResetAll}
            className="px-3 py-1.5 text-xs rounded-lg border border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)] transition-colors whitespace-nowrap"
          >
            Reset All
          </button>
        </div>

        {conflicts.length > 0 && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-warning)]/10 border border-[var(--color-warning)]/30 text-xs text-[var(--color-warning)]">
            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
            <span>
              {conflicts.length} keybinding conflict{conflicts.length === 1 ? "" : "s"} detected.
              Same key + scope triggers multiple commands.
            </span>
          </div>
        )}

        <div className="text-[11px] text-[var(--color-text-muted)] select-none">
          {(() => {
            // Counts track the filtered result, not the global totals —
            // otherwise the chrome shows "0 commands · 1 customised" while
            // the user sees an empty list, which is confusing.
            const customInView = filtered.reduce(
              (n, c) => (overrides.has(c.id) ? n + 1 : n),
              0,
            );
            const disabledInView = filtered.reduce(
              (n, c) => (disabled.has(c.id) ? n + 1 : n),
              0,
            );
            return (
              <>
                {filtered.length} command{filtered.length === 1 ? "" : "s"}{" "}
                {customInView > 0 && `· ${customInView} customised`}{" "}
                {disabledInView > 0 && `· ${disabledInView} disabled`}
              </>
            );
          })()}
        </div>
      </div>

      {/* Scrollable list. Category headers sit inside this region so each
          group's collapse toggle stays close to its commands as the user
          scrolls. */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {grouped.map(([category, commands]) => {
          const collapsed = collapsedCategories.has(category);
          return (
            <div
              key={category}
              className="border border-[var(--color-border)] rounded-lg overflow-hidden"
            >
              <button
                onClick={() => toggleCategory(category)}
                className="w-full flex items-center gap-2 px-3 py-2 bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
              >
                <motion.div
                  animate={{ rotate: collapsed ? 0 : 90 }}
                  transition={{ duration: 0.15 }}
                >
                  <ChevronRight className="w-3.5 h-3.5 text-[var(--color-text-muted)]" />
                </motion.div>
                <span className="text-xs font-medium text-[var(--color-text)] select-none">
                  {category}
                </span>
                <span className="text-[11px] text-[var(--color-text-muted)] select-none">
                  ({commands.length})
                </span>
              </button>
              {!collapsed && (
                <div className="divide-y divide-[var(--color-border)]">
                  {commands.map((cmd) => (
                    <ShortcutRow
                      key={cmd.id}
                      cmd={cmd}
                      override={overrides.get(cmd.id)}
                      isDisabled={disabled.has(cmd.id)}
                      conflicts={conflictsByCommand.get(cmd.id) ?? []}
                      onEdit={() => setEditing(cmd)}
                      onReset={() => handleReset(cmd)}
                      onToggleDisabled={() => handleToggleDisabled(cmd)}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {grouped.length === 0 && (
          <div className="text-center py-8 text-sm text-[var(--color-text-muted)]">
            No commands match this filter.
          </div>
        )}
      </div>

      {/* Edit modal */}
      {editing &&
        (() => {
          const ov = overrides.get(editing.id);
          const currentBindings: BindingDraft[] =
            ov && ov.length > 0
              ? ov
                  .filter((o) => o.key)
                  .map((o) => ({
                    key: o.key,
                    when: o.when_ctx ?? "",
                    scope: o.scope ?? "",
                  }))
              : (editing.defaultBindings ?? []).map((b) => ({
                  key: b.key,
                  when: b.when ?? editing.defaultWhen ?? "",
                  scope: b.scope ?? editing.scope ?? "",
                }));
          return (
            <ShortcutEditModal
              command={editing}
              currentBindings={currentBindings}
              scopeOptions={scopeOptions}
              onSave={handleEditSave}
              onClose={() => setEditing(null)}
            />
          );
        })()}

      <ConfirmDialog
        isOpen={resetConfirmOpen}
        title="Reset all shortcuts?"
        message="All your keymap overrides and disabled flags will be cleared. Default bindings from the catalog will apply."
        confirmLabel="Reset"
        variant="danger"
        onConfirm={handleResetAllConfirm}
        onCancel={() => setResetConfirmOpen(false)}
      />
    </div>
  );
}

interface ShortcutRowProps {
  cmd: CommandDef;
  override: readonly KeymapOverride[] | undefined;
  isDisabled: boolean;
  conflicts: Conflict[];
  onEdit: () => void;
  onReset: () => void;
  onToggleDisabled: () => void;
}

function ShortcutRow({
  cmd,
  override,
  isDisabled,
  conflicts,
  onEdit,
  onReset,
  onToggleDisabled,
}: ShortcutRowProps) {
  const bindings = effectiveBindings(cmd, override);
  const isCustomized = override !== undefined && override.length > 0;
  const isReadonly = cmd.readonly === true;

  return (
    <div
      className={[
        "flex items-center gap-3 px-3 py-2 hover:bg-[var(--color-bg-secondary)] transition-colors",
        isDisabled && "opacity-50",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm text-[var(--color-text)] truncate">{cmd.name}</span>
          {isReadonly && (
            <Lock
              className="w-3 h-3 text-[var(--color-text-muted)]"
              aria-label="Readonly — cannot be rebound"
            />
          )}
          {isCustomized && !isDisabled && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-highlight)]/20 text-[var(--color-highlight)] select-none">
              Custom
            </span>
          )}
          {isDisabled && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-text-muted)]/20 text-[var(--color-text-muted)] select-none">
              Disabled
            </span>
          )}
          {conflicts.length > 0 && (
            <span
              className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-warning)]/20 text-[var(--color-warning)] select-none flex items-center gap-1"
              title={conflicts
                .map((c) => `${c.key} clashes with: ${c.commandIds.filter((id) => id !== cmd.id).join(", ")}`)
                .join("\n")}
            >
              <AlertTriangle className="w-2.5 h-2.5" />
              Conflict
            </span>
          )}
        </div>
        <div className="text-[11px] text-[var(--color-text-muted)] flex items-center gap-2 mt-0.5">
          <code className="font-mono">{cmd.id}</code>
        </div>
      </div>

      {/* Binding display — each binding shows its own condition (scope · when)
          alongside its key, so per-context bindings are distinguishable. */}
      <div className="flex flex-col items-end gap-1 min-w-[160px] flex-shrink-0">
        {bindings.length === 0 ? (
          <span className="text-[11px] text-[var(--color-text-muted)] italic select-none">
            unbound
          </span>
        ) : (
          bindings.map((b, i) => {
            const cond = [b.scope || "", b.when || ""].filter(Boolean).join(" · ");
            return (
              <div key={i} className="flex items-center gap-1.5 max-w-full">
                {cond && (
                  <span
                    className="text-[10px] text-[var(--color-text-muted)] font-mono truncate"
                    title={cond}
                  >
                    {cond}
                  </span>
                )}
                <kbd
                  className={[
                    "px-1.5 py-0.5 rounded text-[11px] font-mono border flex-shrink-0",
                    isDisabled
                      ? "border-[var(--color-text-muted)]/30 text-[var(--color-text-muted)] line-through"
                      : "border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text)]",
                  ].join(" ")}
                >
                  {formatKeyDisplay(b.key)}
                </kbd>
              </div>
            );
          })
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1">
        <button
          onClick={onEdit}
          disabled={isReadonly}
          title="Edit binding"
          className={[
            "p-1.5 rounded transition-colors",
            isReadonly
              ? "text-[var(--color-text-muted)]/40 cursor-not-allowed"
              : "text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]",
          ].join(" ")}
        >
          <Pencil className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={onReset}
          disabled={!isCustomized || isReadonly}
          title="Reset to default"
          className={[
            "p-1.5 rounded transition-colors",
            isCustomized && !isReadonly
              ? "text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]"
              : "text-[var(--color-text-muted)]/30 cursor-not-allowed",
          ].join(" ")}
        >
          <RotateCcw className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={onToggleDisabled}
          disabled={isReadonly}
          title={isDisabled ? "Enable" : "Disable"}
          className={[
            "p-1.5 rounded transition-colors",
            isReadonly
              ? "text-[var(--color-text-muted)]/40 cursor-not-allowed"
              : "text-[var(--color-text-muted)] hover:text-[var(--color-warning)] hover:bg-[var(--color-bg-tertiary)]",
          ].join(" ")}
        >
          <EyeOff className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

/** Re-export for tree shaking convenience. */
export default ShortcutSettingsPanel;
