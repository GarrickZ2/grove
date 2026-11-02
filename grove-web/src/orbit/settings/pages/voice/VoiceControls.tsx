import { useState, type ReactNode } from "react";
import { Check, Plus, X } from "lucide-react";
import { Combobox } from "../../../../components/ui";
import { voiceLanguageOptions } from "../../../../components/AI/utils";
import type { ProviderProfile } from "../../../../components/AI/types";
import type { RecordingTarget } from "../../../../components/AI/useAudioSettingsEditor";
import { Block, Button, keycapParts } from "../../../ui";
import { pttKeycaps } from "./voiceFormat";

/** Provider picker. Once one is chosen, "None" clears it again (the legacy select's placeholder option). */
export function ProviderSelect({ providers, value, onChange, disabled = false, placeholder = "Choose provider" }: {
  providers: ProviderProfile[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const options = [
    ...(value ? [{ id: "none", value: "", label: "None" }] : []),
    ...providers.map((provider) => ({
      id: provider.id,
      value: provider.id,
      label: provider.name,
      description: provider.model || undefined,
    })),
  ];
  return (
    <div className="ost-picker">
      <Combobox
        options={options}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        allowCustom={false}
        disabled={disabled}
        size="compact"
      />
    </div>
  );
}

/** Known languages as toggle chips, plus any custom ones already chosen, plus an add field. */
export function LanguageChips({ value, onToggle, onAdd, dim = false }: {
  value: string[];
  onToggle: (language: string) => void;
  onAdd: (language: string) => void;
  dim?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const known = voiceLanguageOptions.map((option) => option.value);
  const languages = [...known, ...value.filter((language) => !known.includes(language))];
  const label = (language: string) => voiceLanguageOptions.find((option) => option.value === language)?.label ?? language;
  const submit = () => {
    const next = draft.trim();
    if (!next || value.includes(next)) return;
    onAdd(next);
    setDraft("");
  };
  return (
    <Block dim={dim}>
      <span className="oui-row-title">Languages</span>
      <span className="oui-row-desc">
        {value.length ? `Expecting ${value.join(", ")}.` : "Detected automatically unless you pick some."} Hints help recognition without restricting what you can say.
      </span>
      <div className="ost-chips">
        {languages.map((language) => {
          const on = value.includes(language);
          return (
            <button
              key={language}
              type="button"
              aria-pressed={on}
              className={`ost-chip${on ? " is-on" : ""}`}
              onClick={() => onToggle(language)}
            >
              {on ? (
                <span className="ost-chip-check" aria-hidden="true"><Check /></span>
              ) : (
                <Plus className="ost-chip-plus" aria-hidden="true" />
              )}
              {label(language)}
            </button>
          );
        })}
        <span className="ost-inline-form">
          <input
            className="oui-field"
            type="text"
            aria-label="Add language"
            placeholder="Other language"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              }
            }}
          />
          <Button onClick={submit} disabled={!draft.trim() || value.includes(draft.trim())}>Add</Button>
        </span>
      </div>
    </Block>
  );
}

/**
 * Shortcut field for voice triggers. Like Orbit's KeyRecorder, but push-to-talk
 * keys are single physical keys (e.g. Right Option) the shared keycaps can't name.
 */
export function TriggerRecorder({ target, value, recording, onToggleRecording, onClear, label }: {
  target: RecordingTarget;
  value: string;
  recording: boolean;
  onToggleRecording: () => void;
  onClear: () => void;
  label: string;
}) {
  const parts = value ? (target === "ptt" ? pttKeycaps(value) : keycapParts(value)) : [];
  return (
    <span className={`oui-recorder${recording ? " is-recording" : ""}`}>
      <span className="oui-recorder-value" aria-live="polite">
        {recording ? (
          <span className="oui-recorder-prompt">{target === "ptt" ? "Press a key…" : "Press shortcut…"}</span>
        ) : parts.length ? (
          <span className="oui-keys">{parts.map((part, index) => <kbd key={index} className="oui-kbd">{part}</kbd>)}</span>
        ) : (
          <span className="oui-recorder-empty">Not set</span>
        )}
      </span>
      {value && !recording ? (
        <Button variant="ghost" iconOnly aria-label={`Clear ${label}`} title="Clear shortcut" onClick={onClear}>
          <X />
        </Button>
      ) : null}
      <Button variant={recording ? "primary" : "secondary"} onClick={onToggleRecording} aria-label={recording ? `Cancel recording ${label}` : `Record ${label}`}>
        {recording ? "Cancel" : value ? "Change" : "Record"}
      </Button>
    </span>
  );
}

/** Number input with a unit; commits on blur / Enter, and Escape restores the saved value when `onReset` is given. */
export function NumberInput({ label, value, unit, min, max, step, onChange, onCommit, onReset }: {
  label: string;
  value: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  onChange: (value: string) => void;
  onCommit: () => void;
  onReset?: () => void;
}) {
  return (
    <span className="ost-v-num">
      <input
        className="oui-field"
        type="number"
        aria-label={label}
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onCommit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape" && onReset) {
            onReset();
            event.currentTarget.blur();
          }
        }}
      />
      {unit}
    </span>
  );
}

/** Inline error / warning strip inside a Group, with an optional action (e.g. Retry). */
export function Notice({ children, action, tone = "error", standalone = false }: {
  children: ReactNode;
  action?: ReactNode;
  tone?: "error" | "warn";
  standalone?: boolean;
}) {
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`ost-v-banner${tone === "warn" ? " is-warn" : ""}${standalone ? " is-standalone" : ""}`}>
      <span>{children}</span>
      {action}
    </div>
  );
}

/** Placeholder group while settings load, so nothing editable shows stale defaults. */
export function LoadingGroup({ label }: { label: string }) {
  return (
    <div className="oui-gwrap">
      <div className="oui-group" aria-busy="true" aria-label={label}>
        {[0, 1, 2].map((index) => (
          <div key={index} className="oui-row"><span className="oui-skel" style={{ width: `${60 - index * 12}%` }} /></div>
        ))}
      </div>
    </div>
  );
}
