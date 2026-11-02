import { AlertTriangle, ChevronDown, EyeOff, Keyboard, Lock, Pencil, RotateCcw, Search, X } from "lucide-react";
import type { CommandDef, Conflict, KeymapOverride } from "../../../keyboard";
import { effectiveBindings, formatKeyDisplay } from "../../../keyboard";
import { ConfirmDialog } from "../../../components/Dialogs/ConfirmDialog";
import { ShortcutEditModal } from "../../../components/Config/ShortcutEditModal";
import { useShortcutSettings } from "../../../components/Config/useShortcutSettings";
import { Button, Group, Keycaps, Row } from "../../ui";

interface FilterChipProps {
  label: string;
  pressed: boolean;
  onChange: (pressed: boolean) => void;
}

function FilterChip({ label, pressed, onChange }: FilterChipProps) {
  return (
    <button type="button" aria-pressed={pressed} className={`ost-chip${pressed ? " is-on" : ""}`} onClick={() => onChange(!pressed)}>
      {label}
    </button>
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

function ShortcutRow({ cmd, override, isDisabled, conflicts, onEdit, onReset, onToggleDisabled }: ShortcutRowProps) {
  const bindings = effectiveBindings(cmd, override);
  const isCustomized = override !== undefined && override.length > 0;
  const isReadonly = cmd.readonly === true;
  return (
    <Row
      title={(
        <>
          <span className="ost-truncate">{cmd.name}</span>
          {isReadonly ? <Lock className="ost-badge-icon" aria-label="Readonly — cannot be rebound" /> : null}
          {isCustomized && !isDisabled ? <span className="oui-count ost-badge-accent">Custom</span> : null}
          {isDisabled ? <span className="oui-count">Disabled</span> : null}
          {conflicts.length > 0 ? (
            <span
              className="oui-count ost-badge-warn"
              title={conflicts.map((c) => `${c.key} clashes with: ${c.commandIds.filter((id) => id !== cmd.id).join(", ")}`).join("\n")}
            >
              Conflict
            </span>
          ) : null}
        </>
      )}
      description={<code className="oui-mono">{cmd.id}</code>}
    >
      <span className="ost-bindings">
        {bindings.length === 0 ? (
          <span className="oui-row-desc">Unbound</span>
        ) : bindings.map((binding, index) => {
          const condition = [binding.scope || "", binding.when || ""].filter(Boolean).join(" · ");
          return (
            <span key={index} className="ost-binding">
              {condition ? <span className="ost-binding-when oui-mono" title={condition}>{condition}</span> : null}
              <Keycaps hotkey={binding.key} muted={isDisabled} />
            </span>
          );
        })}
      </span>
      <Button variant="ghost" iconOnly disabled={isReadonly} title="Edit binding" aria-label={`Edit ${cmd.name}`} onClick={onEdit}>
        <Pencil />
      </Button>
      <Button variant="ghost" iconOnly disabled={!isCustomized || isReadonly} title="Reset to default" aria-label={`Reset ${cmd.name}`} onClick={onReset}>
        <RotateCcw />
      </Button>
      <Button
        variant="ghost"
        iconOnly
        disabled={isReadonly}
        title={isDisabled ? "Enable" : "Disable"}
        aria-label={`${isDisabled ? "Enable" : "Disable"} ${cmd.name}`}
        aria-pressed={isDisabled}
        onClick={onToggleDisabled}
      >
        <EyeOff />
      </Button>
    </Row>
  );
}

export function ShortcutsPage() {
  const s = useShortcutSettings();
  return (
    <>
      <Group
        title="Find"
        anchorId="find"
        actions={<Button variant="ghost" onClick={s.handleResetAll}>Reset all</Button>}
        footnote={(
          <>
            {s.filtered.length} command{s.filtered.length === 1 ? "" : "s"}
            {s.customInView > 0 ? ` · ${s.customInView} customised` : ""}
            {s.disabledInView > 0 ? ` · ${s.disabledInView} disabled` : ""}
          </>
        )}
      >
        <div className="ost-find">
          <label className="oui-search ost-search ost-search-inline">
            <Search aria-hidden="true" />
            <input
              value={s.search}
              onChange={(event) => s.setSearch(event.target.value)}
              placeholder="Search commands"
              aria-label="Search commands"
            />
            {s.keyFilter && !s.keyRecording ? (
              <span className="ost-keyfilter">
                {formatKeyDisplay(s.keyFilter)}
                <button type="button" aria-label="Clear shortcut filter" onClick={() => s.setKeyFilter("")}><X /></button>
              </span>
            ) : null}
            <button
              type="button"
              className={`ost-keyrec${s.keyRecording ? " is-recording" : ""}`}
              aria-pressed={s.keyRecording}
              aria-label="Search by shortcut"
              title={s.keyRecording ? "Press the combo to filter by (Esc to cancel)" : "Search by shortcut — click then press a key combo"}
              onClick={() => {
                if (s.keyRecording) {
                  s.setKeyRecording(false);
                } else {
                  s.setKeyFilter("");
                  s.setKeyRecording(true);
                }
              }}
            >
              <Keyboard />
            </button>
          </label>
          <div className="ost-chips">
            <FilterChip label="Show hidden" pressed={s.showHidden} onChange={s.setShowHidden} />
            <FilterChip label="Conflicts only" pressed={s.conflictsOnly} onChange={s.setConflictsOnly} />
            <FilterChip label="Customised only" pressed={s.customizedOnly} onChange={s.setCustomizedOnly} />
          </div>
        </div>
        {s.conflicts.length > 0 ? (
          <Row
            leading={<AlertTriangle className="ost-warn-icon" aria-hidden="true" />}
            title={`${s.conflicts.length} keybinding conflict${s.conflicts.length === 1 ? "" : "s"}`}
            description="Same key and scope trigger more than one command."
          />
        ) : null}
      </Group>

      {s.grouped.map(([category, commands]) => {
        const collapsed = s.collapsedCategories.has(category);
        return (
          <Group
            key={category}
            title={category}
            hint={String(commands.length)}
            actions={(
              <Button
                variant="ghost"
                iconOnly
                aria-expanded={!collapsed}
                aria-label={`${collapsed ? "Expand" : "Collapse"} ${category}`}
                onClick={() => s.toggleCategory(category)}
              >
                <ChevronDown className={collapsed ? "ost-chev-collapsed" : undefined} />
              </Button>
            )}
          >
            {collapsed ? (
              <Row title={`${commands.length} hidden`} description="Expand to see these shortcuts." />
            ) : commands.map((cmd) => (
              <ShortcutRow
                key={cmd.id}
                cmd={cmd}
                override={s.overrides.get(cmd.id)}
                isDisabled={s.disabled.has(cmd.id)}
                conflicts={s.conflictsByCommand.get(cmd.id) ?? []}
                onEdit={() => s.setEditing(cmd)}
                onReset={() => void s.handleReset(cmd)}
                onToggleDisabled={() => void s.handleToggleDisabled(cmd)}
              />
            ))}
          </Group>
        );
      })}
      {s.grouped.length === 0 ? (
        <div className="ost-empty">
          <b>No commands match</b>
          <span>Try another search, or clear the filters.</span>
        </div>
      ) : null}

      {s.editing ? (
        <ShortcutEditModal
          command={s.editing}
          currentBindings={s.editingBindings}
          scopeOptions={s.scopeOptions}
          onSave={s.handleEditSave}
          onClose={() => s.setEditing(null)}
        />
      ) : null}
      <ConfirmDialog
        isOpen={s.resetConfirmOpen}
        title="Reset all shortcuts?"
        message="All your keymap overrides and disabled flags will be cleared. Default bindings from the catalog will apply."
        confirmLabel="Reset"
        variant="danger"
        onConfirm={s.handleResetAllConfirm}
        onCancel={() => s.setResetConfirmOpen(false)}
      />
    </>
  );
}
