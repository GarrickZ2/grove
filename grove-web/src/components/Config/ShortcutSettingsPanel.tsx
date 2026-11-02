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
import { effectiveBindings, formatKeyDisplay } from "../../keyboard";
import { ShortcutEditModal } from "./ShortcutEditModal";
import { useShortcutSettings } from "./useShortcutSettings";
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
  const {
    search,
    setSearch,
    conflictsOnly,
    setConflictsOnly,
    customizedOnly,
    setCustomizedOnly,
    showHidden,
    setShowHidden,
    keyRecording,
    setKeyRecording,
    keyFilter,
    setKeyFilter,
    editing,
    setEditing,
    editingBindings,
    collapsedCategories,
    toggleCategory,
    overrides,
    disabled,
    conflicts,
    conflictsByCommand,
    scopeOptions,
    filtered,
    grouped,
    customInView,
    disabledInView,
    resetConfirmOpen,
    setResetConfirmOpen,
    handleResetAll,
    handleResetAllConfirm,
    handleEditSave,
    handleReset,
    handleToggleDisabled,
  } = useShortcutSettings();

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
          {filtered.length} command{filtered.length === 1 ? "" : "s"}{" "}
          {customInView > 0 && `· ${customInView} customised`}{" "}
          {disabledInView > 0 && `· ${disabledInView} disabled`}
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
      {editing && (
        <ShortcutEditModal
          command={editing}
          currentBindings={editingBindings}
          scopeOptions={scopeOptions}
          onSave={handleEditSave}
          onClose={() => setEditing(null)}
        />
      )}

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
