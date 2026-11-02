import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
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
import type { BindingDraft } from "./ShortcutEditModal";

/**
 * Keymap settings state shared by the Workbench panel and the Orbit page:
 * catalog + user overrides, conflict detection, text / key-combo filters,
 * grouping, and the edit / reset / disable / reset-all actions.
 */
export function useShortcutSettings() {
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


  const editingBindings: BindingDraft[] = (() => {
    if (!editing) return [];
    const ov = overrides.get(editing.id);
    return ov && ov.length > 0
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
  })();

  // Counts track the filtered result, not the global totals — otherwise the
  // chrome shows "0 commands · 1 customised" while the list is empty.
  const customInView = filtered.reduce((n, c) => (overrides.has(c.id) ? n + 1 : n), 0);
  const disabledInView = filtered.reduce((n, c) => (disabled.has(c.id) ? n + 1 : n), 0);

  return {
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
  };
}

export type ShortcutSettingsState = ReturnType<typeof useShortcutSettings>;
