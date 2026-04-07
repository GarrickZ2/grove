import { useState, useEffect, useRef } from "react";

interface TranscriptPreviewProps {
  text: string | null;
  autoSend: boolean;
  isProcessing: boolean;
  onSend: (text: string) => void;
  onClear: () => void;
}

export default function TranscriptPreview({
  text,
  autoSend,
  isProcessing,
  onSend,
  onClear,
}: TranscriptPreviewProps) {
  const showManualSend = text !== null && !autoSend && !isProcessing;

  if (isProcessing) {
    return (
      <div className="bg-[#0e0e12] border border-[#1e1e24] rounded-lg px-4 py-3 sm:px-3">
        <span className="text-sm sm:text-xs text-[#6a6a78] animate-pulse">
          Transcribing...
        </span>
      </div>
    );
  }

  if (showManualSend) {
    // key={text} resets the editor state when a new transcript arrives
    return (
      <TranscriptEditor
        key={text}
        initialText={text}
        onSend={onSend}
        onClear={onClear}
      />
    );
  }

  return (
    <div className="bg-[#0e0e12] border border-[#1e1e24] rounded-lg px-4 py-3 sm:px-3">
      <span className="text-sm sm:text-xs text-[#3a3a44]">
        Tap to select, hold to talk
      </span>
    </div>
  );
}

function TranscriptEditor({
  initialText,
  onSend,
  onClear,
}: {
  initialText: string;
  onSend: (text: string) => void;
  onClear: () => void;
}) {
  const [editText, setEditText] = useState(initialText);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  return (
    <div className="bg-[#0e0e12] border border-[#1e1e24] rounded-lg px-4 py-3 sm:px-3 flex flex-col gap-2.5 sm:gap-2">
      <textarea
        ref={textareaRef}
        value={editText}
        onChange={(e) => setEditText(e.target.value)}
        rows={4}
        className="w-full bg-[#141418] border border-[#b49060] rounded px-3 py-2 sm:px-2 sm:py-1.5 text-sm sm:text-xs text-[#c8c8d4] resize-none focus:outline-none"
      />
      <div className="flex gap-2.5 sm:gap-2 justify-end">
        <button
          onClick={onClear}
          className="text-xs sm:text-[10px] text-[#6a6a78] hover:text-[#c8c8d4] active:text-white px-4 py-2.5 sm:px-3 sm:py-1 min-h-[44px] sm:min-h-0 rounded border border-[#2a2a32] bg-[#141418] transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={() => onSend(editText)}
          disabled={editText.trim().length === 0}
          className="text-xs sm:text-[10px] text-[#b49060] px-4 py-2.5 sm:px-3 sm:py-1 min-h-[44px] sm:min-h-0 rounded border border-[#2a2a32] bg-[#1e1c18] hover:bg-[#2a2820] active:bg-[#3a3828] disabled:opacity-30 transition-colors"
        >
          Send
        </button>
      </div>
    </div>
  );
}
