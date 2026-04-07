import { useState, useEffect, useRef, useCallback } from "react";

interface TranscriptDialogProps {
  text: string | null;
  onSend: (text: string) => void;
  onCancel: () => void;
}

export default function TranscriptDialog({
  text,
  onSend,
  onCancel,
}: TranscriptDialogProps) {
  if (text === null) return null;

  // key={text} resets TranscriptDialogInner state when text changes
  return (
    <TranscriptDialogInner
      key={text}
      text={text}
      onSend={onSend}
      onCancel={onCancel}
    />
  );
}

function TranscriptDialogInner({
  text,
  onSend,
  onCancel,
}: {
  text: string;
  onSend: (text: string) => void;
  onCancel: () => void;
}) {
  const [editText, setEditText] = useState(text);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setTimeout(() => textareaRef.current?.focus(), 50);
  }, []);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onCancel();
    }
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={handleBackdropClick}
    >
      <div
        className="w-full max-w-sm rounded-xl border p-4 flex flex-col gap-3"
        style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg-secondary)" }}
      >
        <span className="text-xs uppercase tracking-wider" style={{ color: "var(--color-text-muted)" }}>
          Edit before sending
        </span>
        <textarea
          ref={textareaRef}
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          rows={4}
          className="w-full rounded-lg border px-3 py-2 text-sm resize-none focus:outline-none"
          style={{
            borderColor: "var(--color-border)",
            backgroundColor: "var(--color-bg)",
            color: "var(--color-text)",
          }}
        />
        <div className="flex gap-3 justify-end">
          <button
            onClick={onCancel}
            className="text-xs px-4 py-2.5 min-h-[44px] rounded-lg border transition-colors"
            style={{
              borderColor: "var(--color-border)",
              backgroundColor: "var(--color-bg)",
              color: "var(--color-text-muted)",
            }}
          >
            Cancel
          </button>
          <button
            onClick={() => onSend(editText)}
            disabled={editText.trim().length === 0}
            className="text-xs px-4 py-2.5 min-h-[44px] rounded-lg border transition-colors disabled:opacity-30"
            style={{
              borderColor: "color-mix(in srgb, var(--color-highlight) 40%, transparent)",
              backgroundColor: "color-mix(in srgb, var(--color-highlight) 15%, transparent)",
              color: "var(--color-highlight)",
            }}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
