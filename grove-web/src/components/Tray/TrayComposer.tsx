/**
 * Inline composer for a "Done" tray chat — send a follow-up prompt back to the
 * agent.
 *
 * Desktop hosts get a plain text input + send. Voice-enabled hosts (the phone)
 * are voice-first: a large hold-to-talk bar (with live waveform + elapsed,
 * slide-up to cancel) is primary, a keyboard toggle reveals the text input, and
 * an Auto / Review segmented control decides whether a transcript auto-sends or
 * drops into the input for review (mirrors Radio's two dispatch modes).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Send, Mic, Keyboard, Loader2 } from "lucide-react";
import { useAudioRecorder } from "../../hooks/useAudioRecorder";
import { transcribeAudio } from "../../api/ai";

/** Pull a readable message out of either an Error or an ApiError-shaped
 *  plain object ({ status, message, data }) — the API client throws the
 *  latter, so `e instanceof Error` would swallow the real cause. */
function errMessage(e: unknown, fallback: string): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object") {
    const o = e as { status?: number; message?: string };
    if (o.message) return o.status ? `${o.status}: ${o.message}` : o.message;
  }
  return fallback;
}

interface TrayComposerProps {
  /** Project id (hash) — passed to transcription for project-scoped settings. */
  projectId: string;
  /** Voice-first layout with hold-to-talk + transcription (phone only). */
  enableVoice?: boolean;
  /** Send the prompt. Rejects on failure so we can surface it. */
  onSend: (text: string) => Promise<void>;
  autoFocus?: boolean;
}

/** Distance (px) to drag up past the button before a release cancels instead of sends. */
const CANCEL_THRESHOLD = 56;

function fmtElapsed(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function Waveform({ data }: { data: Uint8Array | null }) {
  const bars = 24;
  const heights = useMemo(() => {
    const out: number[] = [];
    for (let i = 0; i < bars; i++) {
      if (data && data.length > 0) {
        const v = data[Math.floor((i / bars) * data.length)];
        out.push(3 + (v / 255) * 18);
      } else {
        out.push(3);
      }
    }
    return out;
  }, [data]);
  return (
    <div className="flex h-5 items-center gap-[2px]">
      {heights.map((h, i) => (
        <div
          key={i}
          className="rounded-full"
          style={{ width: 2, height: h, backgroundColor: "currentColor", transition: "height 0.1s ease" }}
        />
      ))}
    </div>
  );
}

export function TrayComposer({ projectId, enableVoice, onSend, autoFocus }: TrayComposerProps) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoSend, setAutoSend] = useState(true);
  // Voice hosts start in voice mode; the keyboard toggle flips to text.
  const [textMode, setTextMode] = useState(!enableVoice);
  const [cancelArmed, setCancelArmed] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const autoSendRef = useRef(autoSend);
  useEffect(() => {
    autoSendRef.current = autoSend;
  }, [autoSend]);
  const cancelArmedRef = useRef(false);
  const holdStartYRef = useRef(0);
  // True while the pointer is held down. `recorder.start()` is async (getUserMedia
  // resolves later), so a quick tap can release before recording actually begins;
  // this ref lets the start() continuation cancel an unwanted recording instead
  // of leaving it running unattended to maxDuration.
  const heldRef = useRef(false);

  const doSend = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      if (!trimmed || sending) return;
      setSending(true);
      setError(null);
      try {
        await onSend(trimmed);
        setText("");
      } catch (e) {
        setError(errMessage(e, "Send failed"));
      } finally {
        setSending(false);
      }
    },
    [onSend, sending],
  );

  const processBlob = useCallback(
    async (blob: Blob) => {
      setTranscribing(true);
      setError(null);
      try {
        const result = await transcribeAudio(blob, projectId || undefined);
        const out = (result.final || result.revised || result.raw || "").trim();
        if (!out) return;
        if (autoSendRef.current) {
          await doSend(out);
        } else {
          setText((prev) => (prev ? `${prev} ${out}` : out));
          setTextMode(true);
        }
      } catch (e) {
        setError(errMessage(e, "Transcription failed"));
      } finally {
        setTranscribing(false);
      }
    },
    [projectId, doSend],
  );

  const recorder = useAudioRecorder({
    minDuration: 0.4,
    maxDuration: 120,
    onMaxReached: (blob) => {
      void processBlob(blob);
    },
  });
  const recording = recorder.status === "recording";

  // ── Hold-to-talk gesture (pointer-captured so move/up fire even off-target) ──
  const onHoldDown = (e: React.PointerEvent) => {
    e.preventDefault();
    if (sending || transcribing) return;
    holdStartYRef.current = e.clientY;
    cancelArmedRef.current = false;
    setCancelArmed(false);
    heldRef.current = true;
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* not all browsers; degrade gracefully */
    }
    void recorder.start().then(() => {
      // Released before the mic stream came up — discard the recording instead
      // of leaving it running unattended to maxDuration / auto-sending. Rely on
      // heldRef (not recorder.status, which is stale in this captured closure);
      // cancel() reads the live MediaRecorder ref and is a no-op if idle.
      if (!heldRef.current) {
        recorder.cancel();
      }
    });
  };
  const onHoldMove = (e: React.PointerEvent) => {
    if (recorder.status !== "recording") return;
    const armed = holdStartYRef.current - e.clientY > CANCEL_THRESHOLD;
    if (armed !== cancelArmedRef.current) {
      cancelArmedRef.current = armed;
      setCancelArmed(armed);
    }
  };
  const onHoldUp = (e: React.PointerEvent) => {
    e.preventDefault();
    heldRef.current = false;
    // Start may still be resolving (status not yet "recording"); the start()
    // continuation above cancels it once it does. Nothing to stop here.
    if (recorder.status !== "recording") {
      cancelArmedRef.current = false;
      setCancelArmed(false);
      return;
    }
    if (cancelArmedRef.current) {
      recorder.cancel();
    } else {
      void recorder.stop().then((blob) => {
        if (blob) void processBlob(blob);
      });
    }
    cancelArmedRef.current = false;
    setCancelArmed(false);
  };

  const busy = sending || transcribing;

  // All controls share one height so switching voice ⇄ text never resizes the
  // row. `.compact` opts the input out of the global <768px font-size:max(16px,
  // 1em) iOS-zoom guard that the 400px desktop webview wrongly triggers; the
  // real phone (enableVoice) keeps 16px to avoid focus-zoom.
  const textRow = (
    <div className="flex items-center gap-1.5">
      {enableVoice ? (
        <button
          type="button"
          onClick={() => setTextMode(false)}
          title="Voice"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--color-border)] text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)]"
        >
          <Mic size={15} />
        </button>
      ) : null}
      <input
        ref={inputRef}
        value={text}
        autoFocus={autoFocus && !enableVoice}
        disabled={sending}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void doSend(text);
          }
        }}
        placeholder="Send a follow-up…"
        className={`h-9 min-w-0 flex-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 text-[12.5px] text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-highlight)] ${enableVoice ? "" : "compact"}`}
      />
      <button
        type="button"
        onClick={() => void doSend(text)}
        disabled={busy || !text.trim()}
        title="Send"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-highlight)] text-white transition-opacity hover:opacity-90 disabled:opacity-40"
      >
        {busy ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
      </button>
    </div>
  );

  // ── Voice row: keyboard toggle + hold-to-talk bar + Auto/Review (one row) ──
  const voiceRow = (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => {
          setTextMode(true);
          setTimeout(() => inputRef.current?.focus(), 0);
        }}
        title="Type"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--color-border)] text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)]"
      >
        <Keyboard size={15} />
      </button>
      <button
        type="button"
        disabled={busy && !recording}
        onPointerDown={onHoldDown}
        onPointerMove={onHoldMove}
        onPointerUp={onHoldUp}
        onPointerCancel={onHoldUp}
        onContextMenu={(e) => e.preventDefault()}
        style={{ touchAction: "none" }}
        className={
          "flex h-9 min-w-0 flex-1 select-none items-center justify-center gap-1.5 rounded-lg border px-2 text-[12px] font-medium transition-colors " +
          (recording
            ? cancelArmed
              ? "border-[var(--color-error)] bg-[color-mix(in_srgb,var(--color-error)_16%,transparent)] text-[var(--color-error)]"
              : "border-[var(--color-highlight)] bg-[color-mix(in_srgb,var(--color-highlight)_16%,transparent)] text-[var(--color-highlight)]"
            : "border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-muted)] active:bg-[var(--color-bg-tertiary)]")
        }
      >
        {transcribing ? <Loader2 size={15} className="shrink-0 animate-spin" /> : <Mic size={15} className="shrink-0" />}
        {transcribing ? (
          <span className="truncate">Transcribing…</span>
        ) : recording ? (
          cancelArmed ? (
            <span className="truncate">Release to cancel</span>
          ) : (
            <>
              <Waveform data={recorder.frequencyData} />
              <span className="ml-auto font-mono text-[11px] tabular-nums">
                {fmtElapsed(recorder.elapsed)}
              </span>
            </>
          )
        ) : (
          <span className="truncate">Hold to talk</span>
        )}
      </button>
      {/* Auto / Review — only meaningful for voice transcripts, so it lives on
          this row and isn't shown in text mode. */}
      <div className="flex h-9 shrink-0 items-center rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-0.5">
        {(["auto", "review"] as const).map((m) => {
          const active = (m === "auto") === autoSend;
          return (
            <button
              key={m}
              type="button"
              onClick={() => setAutoSend(m === "auto")}
              title={m === "auto" ? "Auto-send after transcription" : "Review transcript before sending"}
              className="h-full rounded-[5px] px-2 text-[10px] font-medium capitalize transition-colors"
              style={{
                color: active ? "var(--color-highlight)" : "var(--color-text-muted)",
                backgroundColor: active
                  ? "color-mix(in srgb, var(--color-highlight) 15%, transparent)"
                  : "transparent",
              }}
            >
              {m}
            </button>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-1.5 px-3 pb-2.5 pt-1.5" onClick={(e) => e.stopPropagation()}>
      {textMode ? textRow : voiceRow}
      {error ? (
        <div className="text-[10.5px] text-[var(--color-error)]" title={error}>
          {error}
        </div>
      ) : null}
    </div>
  );
}
