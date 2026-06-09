/**
 * RecordingIndicator — floating capsule overlay shown during audio recording.
 *
 * States:
 * - warming: PTT key held, waiting for activation delay
 * - recording: actively recording with waveform + timer
 * - processing: recording complete, processing audio
 * - error: transcription failed, showing error message briefly
 */

import { motion, AnimatePresence } from "framer-motion";
import { AlertCircle, Loader2, Square } from "lucide-react";
import type { IndicatorStatus } from "./GlobalAudioRecorder";

interface RecordingIndicatorProps {
  status: IndicatorStatus;
  elapsed: number;
  maxDuration: number;
  frequencyData: Uint8Array | null;
  warmingProgress?: number;
  errorMessage?: string | null;
  onStop: () => void;
  onCancel: () => void;
  /** Streaming mode: stable finalized sentences shown above the controls. */
  finalizedSentences?: string[];
  /** Streaming mode: the live, still-refining current sentence (muted). */
  currentText?: string;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function toBars(data: Uint8Array | null, count: number): number[] {
  if (!data || data.length === 0) return Array(count).fill(0);
  const step = Math.max(1, Math.floor(data.length / count));
  const bars: number[] = [];
  for (let i = 0; i < count; i++) {
    const idx = Math.min(i * step, data.length - 1);
    bars.push(data[idx] / 255);
  }
  return bars;
}

export function RecordingIndicator({
  status,
  elapsed,
  maxDuration,
  frequencyData,
  warmingProgress = 0,
  errorMessage,
  onStop,
  onCancel,
  finalizedSentences,
  currentText,
}: RecordingIndicatorProps) {
  const isVisible = status === "warming" || status === "recording" || status === "processing" || status === "error";
  const bars = toBars(frequencyData, 16);
  const transcript = finalizedSentences ?? [];
  // Keep the wide transcript view through `processing` (streaming finalize) too,
  // so the pill doesn't snap back to a small round shape mid-finalize.
  const hasTranscript =
    (status === "recording" || status === "processing") &&
    (transcript.length > 0 || !!currentText);

  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          initial={{ opacity: 0, y: 20, scale: 0.9 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 20, scale: 0.9 }}
          transition={{ type: "spring", stiffness: 400, damping: 30 }}
          role="status"
          aria-live="polite"
          className={`fixed bottom-6 right-6 z-[9999] border shadow-lg backdrop-blur-md ${
            status === "error"
              ? "border-red-500/30 bg-red-500/10"
              : "border-[var(--color-border)] bg-[var(--color-bg)]/95"
          } ${hasTranscript ? "w-[min(440px,calc(100vw-3rem))] rounded-3xl" : "rounded-full"}`}
        >
          {hasTranscript && (
            <div className="max-h-[35vh] overflow-y-auto px-4 pt-3 pb-2.5">
              <p className="text-sm leading-6 text-[var(--color-text)] break-words [overflow-wrap:anywhere]">
                {transcript.map((s, i) => (
                  <span key={i}>{s} </span>
                ))}
                {currentText && (
                  <span className="text-[var(--color-text-muted)]">{currentText}</span>
                )}
              </p>
            </div>
          )}
          {hasTranscript && (
            <div className="mx-3 border-t border-[var(--color-border)]/70" />
          )}

          <div className="flex items-center gap-3 px-4 py-2.5">
          {status === "warming" && (
            <>
              <div className="relative flex h-5 w-5 shrink-0 items-center justify-center">
                <svg className="h-5 w-5 -rotate-90" viewBox="0 0 20 20">
                  <circle cx="10" cy="10" r="8" fill="none" stroke="var(--color-border)" strokeWidth="2" />
                  <circle
                    cx="10" cy="10" r="8" fill="none"
                    stroke="var(--color-highlight)"
                    strokeWidth="2"
                    strokeDasharray={2 * Math.PI * 8}
                    strokeDashoffset={2 * Math.PI * 8 * (1 - warmingProgress)}
                    strokeLinecap="round"
                    className="transition-[stroke-dashoffset] duration-75"
                  />
                </svg>
              </div>
              <span className="text-xs font-medium text-[var(--color-text-muted)]">
                Hold to record...
              </span>
            </>
          )}

          {status === "recording" && (
            <>
              <span className="relative flex h-3 w-3 shrink-0">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
                <span className="relative inline-flex h-3 w-3 rounded-full bg-red-500" />
              </span>

              <div className="flex h-6 items-end gap-[2px]">
                {bars.map((level, i) => (
                  <motion.div
                    key={i}
                    className="w-[3px] rounded-full bg-[var(--color-highlight)]"
                    animate={{ height: Math.max(3, level * 24) }}
                    transition={{ duration: 0.08, ease: "easeOut" }}
                  />
                ))}
              </div>

              <span className="min-w-[70px] text-center text-xs font-mono font-medium text-[var(--color-text)]">
                {formatTime(elapsed)} / {formatTime(maxDuration)}
              </span>

              <button
                type="button"
                onClick={onStop}
                className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-red-500/15 text-red-500 transition-colors hover:bg-red-500/25"
                title="Stop recording"
              >
                <Square className="h-3 w-3 fill-current" />
              </button>
            </>
          )}

          {status === "processing" && (
            <>
              <Loader2 className="h-4 w-4 animate-spin text-[var(--color-highlight)]" />
              <span className="text-xs font-medium text-[var(--color-text-muted)]">
                Processing audio...
              </span>
              <button
                type="button"
                onClick={onCancel}
                className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
              >
                Cancel
              </button>
            </>
          )}

          {status === "error" && (
            <>
              <AlertCircle className="h-4 w-4 shrink-0 text-red-500" />
              <span className="text-xs font-medium text-red-400">
                {errorMessage || "Transcription failed"}
              </span>
            </>
          )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
