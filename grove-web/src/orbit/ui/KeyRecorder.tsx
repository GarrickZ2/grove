import { X } from "lucide-react";
import { keycapParts } from "./keycaps";
import { Button } from "./Button";

export function Keycaps({ hotkey, muted = false }: { hotkey: string; muted?: boolean }) {
  return (
    <span className={`oui-keys${muted ? " is-muted" : ""}`}>
      {keycapParts(hotkey).map((part, index) => <kbd key={index} className="oui-kbd">{part}</kbd>)}
    </span>
  );
}

interface KeyRecorderProps {
  value: string;
  recording: boolean;
  onToggleRecording: () => void;
  onClear: () => void;
  label: string;
  invalid?: boolean;
}

/** Shortcut field: keycaps or a pulsing "press keys" prompt, plus Clear and Record/Change. */
export function KeyRecorder({ value, recording, onToggleRecording, onClear, label, invalid = false }: KeyRecorderProps) {
  return (
    <span className={`oui-recorder${recording ? " is-recording" : ""}${invalid ? " is-invalid" : ""}`}>
      <span className="oui-recorder-value" aria-live="polite">
        {recording ? (
          <span className="oui-recorder-prompt">Press shortcut…</span>
        ) : value ? (
          <Keycaps hotkey={value} />
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
