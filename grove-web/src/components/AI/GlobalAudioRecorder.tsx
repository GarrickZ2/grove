/**
 * GlobalAudioRecorder — mounts at App level to provide global shortcut-triggered
 * audio recording. Renders the RecordingIndicator overlay.
 *
 * Supports two modes:
 * - Toggle: combo key (e.g. Cmd+Shift+H) toggles recording on/off
 * - Push-to-talk: hold key for the configured delay (default 500ms) to
 *   activate, release to stop
 *
 * On completion the audio blob is available for transcription (TODO).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAudioRecorder } from "../../hooks/useAudioRecorder";
import { useStreamingTranscription } from "../../hooks/useStreamingTranscription";
import { getAudioSettings, saveAudioGlobal, transcribeAudio } from "../../api";
import { matchesShortcut, matchesPTTKey } from "./utils";
import { RecordingIndicator } from "./RecordingIndicator";
import type { AudioSettings } from "./types";
import { useCommand, useContextKey, userKeymapStore, persistOverride } from "../../keyboard";

/** Insert text into a React-controlled input/textarea by using the native value setter */
function insertTextIntoInput(el: HTMLInputElement | HTMLTextAreaElement, text: string) {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  const before = el.value.slice(0, start);
  const after = el.value.slice(end);
  const newValue = before + text + after;

  // Use native setter to trigger React's onChange for controlled components
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (nativeSetter) {
    nativeSetter.call(el, newValue);
  } else {
    el.value = newValue;
  }
  el.selectionStart = el.selectionEnd = start + text.length;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.focus();
}

/** Insert text into a contenteditable element using Selection/Range API */
function insertTextIntoContentEditable(el: HTMLElement, text: string) {
  el.focus();
  const selection = window.getSelection();
  if (!selection) return;
  const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : document.createRange();
  range.deleteContents();
  const textNode = document.createTextNode(text);
  range.insertNode(textNode);
  range.setStartAfter(textNode);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** Hard floor for the PTT hold delay. Settings below this are clamped to
 *  avoid nonsensical "0ms hold = no debounce at all" behavior; settings
 *  above are bounded by the AudioPanel input (max 2000ms). */
const PTT_ACTIVATION_DELAY_MIN_MS = 50;

function pttActivationDelayMs(s: AudioSettings | null): number {
  const v = s?.pttActivationDelayMs ?? 500;
  return Math.max(PTT_ACTIVATION_DELAY_MIN_MS, v);
}

const STATUS_HINTS: Record<number, string> = {
  400: "Bad request — check transcribe provider config",
  401: "Unauthorized — check API key",
  403: "Forbidden — provider rejected the request",
  413: "Recording too large",
  429: "Rate limited — slow down",
  502: "Provider unreachable",
  503: "Provider unavailable",
};

function formatTranscribeError(err: unknown): string {
  if (!err || typeof err !== "object") return "Transcription failed";
  const e = err as { status?: number; message?: string };
  const parts: string[] = [];
  if (typeof e.status === "number") {
    const hint = STATUS_HINTS[e.status];
    parts.push(hint ? `${e.status}: ${hint}` : `HTTP ${e.status}`);
  }
  if (e.message && e.message.trim()) {
    parts.push(e.message.trim().slice(0, 120));
  }
  return parts.length > 0 ? parts.join(" — ") : "Transcription failed";
}

export type IndicatorStatus = "idle" | "warming" | "recording" | "processing" | "error";

interface GlobalAudioRecorderProps {
  projectId: string | null;
}

export function GlobalAudioRecorder({ projectId }: GlobalAudioRecorderProps) {
  const [settings, setSettings] = useState<AudioSettings | null>(null);
  const settingsRef = useRef<AudioSettings | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const activeElementRef = useRef<Element | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const pttActiveRef = useRef(false);
  const [pttActive, setPttActive] = useState(false);
  const pttTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pttWarming, setPttWarming] = useState(false);
  const [pttWarmElapsed, setPttWarmElapsed] = useState(0);
  const pttWarmIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pttWarmStartRef = useRef(0);
  /** Delay captured at the moment PTT warming started, so the progress
   *  indicator and timer use a consistent value even if the user changes
   *  the setting mid-warming. Held in state (not just a ref) because the
   *  RecordingIndicator needs it during render. */
  const [pttWarmDelay, setPttWarmDelay] = useState(0);

  const recorder = useAudioRecorder({
    minDuration: settings?.minDuration ?? 2,
    maxDuration: settings?.maxDuration ?? 60,
    onMaxReached: (blob) => handleRecordingComplete(blob),
  });

  const recorderRef = useRef(recorder);
  useEffect(() => {
    recorderRef.current = recorder;
  });

  // ── Streaming mode ──────────────────────────────────────────────────────
  // A second recorder pipeline (AudioWorklet + WebSocket) used when the user
  // picks "streaming" mode. Both hooks are always mounted (hooks can't be
  // conditional); we route start/stop/status to whichever mode is active.
  const isStreaming = settings?.transcribeMode === "streaming";
  const isStreamingRef = useRef(isStreaming);
  useEffect(() => { isStreamingRef.current = isStreaming; });

  // Insert the final transcript into the previously focused element (+ clipboard).
  const insertFinalText = useCallback((text: string) => {
    if (!text) return;
    try { void navigator.clipboard.writeText(text); } catch { /* ignore */ }
    const el = activeElementRef.current;
    if (el && (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement)) {
      insertTextIntoInput(el, text);
    } else if (el && (el as HTMLElement).isContentEditable) {
      insertTextIntoContentEditable(el as HTMLElement, text);
    }
  }, []);

  const streaming = useStreamingTranscription({
    projectId: projectId ?? undefined,
    maxDuration: settings?.maxDuration ?? 0,
    onMaxReached: (r) => { if (r) insertFinalText(r.revised ?? r.full); },
  });
  const streamingRef = useRef(streaming);
  useEffect(() => { streamingRef.current = streaming; });

  // Route start / status to the active mode. (doStop/doCancel are defined
  // below, after handleRecordingComplete which they depend on.)
  const doStart = useCallback(() => {
    if (isStreamingRef.current) { void streamingRef.current.start(); }
    else { recorderRef.current.start(); }
  }, []);
  const curStatus = useCallback((): string => (
    isStreamingRef.current ? streamingRef.current.status : recorderRef.current.status
  ), []);

  // Load audio settings (on mount, projectId change, or after settings saved)
  const fetchSettings = useCallback(() => {
    getAudioSettings(projectId ?? undefined)
      .then((s) => {
        setSettings(s);
        settingsRef.current = s;
        // Seed: if audio_config has a PTT key but keymap_overrides has no
        // override for audio.ptt.start, copy it across so Settings → Keyboard
        // Shortcuts shows the binding the AudioPanel already configured.
        // Only seeds when the keymap is silent — never overwrites an existing
        // user override (the keymap → audio_config sync below handles that
        // direction).
        if (s.pushToTalkKey && !userKeymapStore.getOverrides("audio.ptt.start")?.length) {
          void persistOverride({
            command_id: "audio.ptt.start",
            key: s.pushToTalkKey,
            when_ctx: undefined,
            scope: undefined,
          }).catch((err) => console.error("[GlobalAudioRecorder] seed keymap failed:", err));
        }
      })
      .catch(() => {});
  }, [projectId]);

  useEffect(() => { fetchSettings(); }, [fetchSettings]);

  useEffect(() => {
    const handler = () => fetchSettings();
    window.addEventListener("grove:audio-settings-changed", handler);
    return () => window.removeEventListener("grove:audio-settings-changed", handler);
  }, [fetchSettings]);

  // Reverse sync: when the user edits `audio.ptt.start` in Settings →
  // Keyboard Shortcuts, the keymap store fires. Write the new key back into
  // audio_config so the raw PTT listener picks it up and the AudioPanel
  // shows the same value next time it opens.
  //
  // Guarded against loops: only writes when the keymap value actually
  // differs from settingsRef.current.pushToTalkKey. The other direction
  // (AudioPanel.tsx → keymap) is symmetric — it writes the keymap only
  // when the user touches the PTT field, so the two writes never race
  // each other in a cycle.
  useEffect(() => {
    const unsub = userKeymapStore.subscribe(() => {
      const cur = settingsRef.current;
      if (!cur) return;
      // PTT is a single key; if the user bound multiple, the first wins.
      const override = userKeymapStore.getOverrides("audio.ptt.start");
      const next = override?.[0]?.key ?? "";
      if (next === cur.pushToTalkKey) return;
      const merged: AudioSettings = { ...cur, pushToTalkKey: next };
      // Optimistically update local state so PTT listener uses new key
      // even before the server PUT resolves.
      settingsRef.current = merged;
      setSettings(merged);
      void saveAudioGlobal(merged).catch((err) =>
        console.error("[GlobalAudioRecorder] keymap → audio_config write failed:", err),
      );
    });
    return unsub;
  }, []);

  // Cleanup PTT timer on unmount
  useEffect(() => {
    return () => {
      if (pttTimerRef.current) clearTimeout(pttTimerRef.current);
      if (pttWarmIntervalRef.current) clearInterval(pttWarmIntervalRef.current);
    };
  }, []);

  // Remember active element before recording starts (for text insertion later)
  const captureActiveElement = useCallback(() => {
    activeElementRef.current = document.activeElement;
  }, []);

  // Auto-clear error after 4 seconds. Tracks the local transcribe-side
  // error, the batch recorder's own error (mic permission etc.), AND the
  // streaming recorder's error — otherwise a denied mic or a WS connection
  // error keeps the pill forever because the hook stays in "error" state
  // until the next start()/cancel() call.
  const recorderErrorActive = recorder.status === "error" || !!recorder.error;
  const streamingErrorActive = streaming.status === "error" || !!streaming.error;
  useEffect(() => {
    if (!errorMessage && !recorderErrorActive && !streamingErrorActive) return;
    const t = setTimeout(() => {
      setErrorMessage(null);
      if (recorderErrorActive) recorder.cancel();
      if (streamingErrorActive) streamingRef.current.cancel();
    }, 4000);
    return () => clearTimeout(t);
  }, [errorMessage, recorderErrorActive, streamingErrorActive, recorder]);

  const handleRecordingComplete = useCallback(async (blob: Blob) => {
    // #2: Client-side size check (25 MB, matches backend limit)
    const MAX_AUDIO_SIZE = 25 * 1024 * 1024;
    if (blob.size > MAX_AUDIO_SIZE) {
      setErrorMessage("Recording too large (max 25 MB)");
      return;
    }

    // Cancel any previous in-flight request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setErrorMessage(null);
    setTranscribing(true);
    const projectArg = projectId ?? undefined;
    let result: Awaited<ReturnType<typeof transcribeAudio>> | null = null;
    let transcribeErr: unknown = null;
    try {
      result = await transcribeAudio(blob, projectArg, controller.signal);
    } catch (err) {
      transcribeErr = err;
    }
    if (transcribeErr !== null) {
      if (!controller.signal.aborted) {
        // Surface as much detail as the backend gave us. Generic
        // "Transcription failed" hides whether the cause was a missing
        // provider config (400), upstream API outage (502), oversized
        // payload (413), or anything else — and that distinction is
        // exactly what the user needs to fix their setup.
        const msg = formatTranscribeError(transcribeErr);
        console.error("[audio] transcribe failed:", transcribeErr);
        setErrorMessage(msg);
      }
      // Clear transcribing even on abort so the indicator can transition
      // out of "processing" — otherwise a cancel would leave the spinner
      // stuck and block the next recording's status calculation.
      setTranscribing(false);
      return;
    }
    if (controller.signal.aborted || !result) {
      setTranscribing(false);
      return;
    }

    insertFinalText(result.final);
    setTranscribing(false);
  }, [projectId, insertFinalText]);

  // Toggle mode: stop and process. Routes to the active mode — streaming
  // returns assembled text directly; batch returns a blob to transcribe.
  const handleToggleStop = useCallback(async () => {
    if (isStreamingRef.current) {
      const r = await streamingRef.current.stop();
      if (r) insertFinalText(r.revised ?? r.full);
      return;
    }
    const blob = await recorderRef.current.stop();
    if (blob) {
      handleRecordingComplete(blob);
    }
  }, [handleRecordingComplete, insertFinalText]);

  // Command-style entry points. These are the handlers registered for
  // `audio.ptt.start` / `audio.ptt.stop` / `audio.recording.cancel` via
  // useCommand below — invoking them from the Command Palette or a
  // Settings-driven binding goes through the exact same code path as the
  // existing raw keydown/keyup listener. The raw listener stays for the
  // PTT hold-to-talk timing (warming delay, key-release stop), since the
  // keymap dispatcher's bare-key paths only see discrete fires.
  const startRecording = useCallback(() => {
    const s = settingsRef.current;
    if (!s?.enabled) return;
    const status = curStatus();
    if (status !== "idle" && status !== "error") return;
    captureActiveElement();
    setErrorMessage(null);
    doStart();
  }, [captureActiveElement, curStatus, doStart]);

  const stopRecording = useCallback(() => {
    void handleToggleStop();
  }, [handleToggleStop]);

  const cancelRecording = useCallback(() => {
    if (isStreamingRef.current) streamingRef.current.cancel();
    else recorder.cancel();
    abortRef.current?.abort();
    setTranscribing(false);
    setErrorMessage(null);
  }, [recorder]);

  useCommand("audio.ptt.start", startRecording, [startRecording]);
  useCommand("audio.ptt.stop", stopRecording, [stopRecording]);
  useCommand("audio.recording.cancel", cancelRecording, [cancelRecording]);

  // Context keys for when-expressions on the audio commands.
  //
  // - `micEnabled` reflects whether the user has the audio pipeline
  //   enabled AND the recorder isn't in a denied/permission-error state.
  //   Used to gate `audio.ptt.start` (catalog `defaultWhen: "micEnabled"`).
  // - `pttActive` is true while the PTT key is held — covers both the
  //   warming-delay window and the active recording phase, and clears
  //   on key release / cancel. Used to gate `audio.ptt.stop`.
  const micEnabled = !!settings?.enabled && !recorder.error && !streaming.error;
  useContextKey("micEnabled", micEnabled);
  useContextKey("pttActive", pttActive);
  // `recording` gates audio.recording.cancel — true only while actively
  // capturing (not idle / warming / processing).
  const activeRecording = isStreaming
    ? streaming.status === "recording"
    : recorder.status === "recording";
  useContextKey("recording", activeRecording);

  // Cancel PTT warming
  const cancelPTTWarming = useCallback(() => {
    if (pttTimerRef.current) {
      clearTimeout(pttTimerRef.current);
      pttTimerRef.current = null;
    }
    if (pttWarmIntervalRef.current) {
      clearInterval(pttWarmIntervalRef.current);
      pttWarmIntervalRef.current = null;
    }
    pttActiveRef.current = false;
    setPttActive(false);
    setPttWarming(false);
    setPttWarmElapsed(0);
    setPttWarmDelay(0);
  }, []);

  // PTT mode: stop on key release
  const handlePTTStop = useCallback(async () => {
    if (!pttActiveRef.current) return;

    // If still warming (delay not elapsed), just cancel
    if (pttTimerRef.current) {
      cancelPTTWarming();
      return;
    }

    pttActiveRef.current = false;
    setPttActive(false);
    setPttWarming(false);
    setPttWarmElapsed(0);
    setPttWarmDelay(0);
    if (pttWarmIntervalRef.current) {
      clearInterval(pttWarmIntervalRef.current);
      pttWarmIntervalRef.current = null;
    }

    if (isStreamingRef.current) {
      const r = await streamingRef.current.stop();
      if (r) insertFinalText(r.revised ?? r.full);
    } else {
      const blob = await recorderRef.current.stop();
      if (blob) {
        handleRecordingComplete(blob);
      }
    }
  }, [handleRecordingComplete, cancelPTTWarming, insertFinalText]);

  // Global keyboard listeners
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const s = settingsRef.current;
      if (!s?.enabled) return;

      const status = curStatus();

      // Toggle mode: combo key toggles recording
      if (s.toggleShortcut && matchesShortcut(event, s.toggleShortcut)) {
        event.preventDefault();
        event.stopPropagation();
        if (status === "idle" || status === "error") {
          captureActiveElement();
          // Clear any lingering error from a previous attempt — guarantees the
          // pill goes away as soon as the user retries, even if the 4s timer
          // hasn't fired yet for some reason.
          setErrorMessage(null);
          doStart();
        } else if (status === "recording") {
          handleToggleStop();
        }
        return;
      }

      // PTT mode: hold key to activate (with delay)
      // Don't preventDefault on initial keydown for modifier keys — avoids
      // interfering with system shortcuts (Cmd+Tab etc.) during the warming delay.
      if (s.pushToTalkKey && matchesPTTKey(event, s.pushToTalkKey)) {
        if (event.repeat) {
          // Key repeat during warming/recording — prevent default to avoid
          // key repeat side effects (e.g. character insertion)
          if (pttActiveRef.current) event.preventDefault();
          return;
        }
        if ((status === "idle" || status === "error") && !pttActiveRef.current) {
          captureActiveElement();
          setErrorMessage(null);
          pttActiveRef.current = true;
          setPttActive(true);
          setPttWarming(true);
          setPttWarmElapsed(0);
          pttWarmStartRef.current = Date.now();
          const warmDelay = pttActivationDelayMs(s);
          setPttWarmDelay(warmDelay);

          // Tick counter for warming progress
          pttWarmIntervalRef.current = setInterval(() => {
            const ms = Date.now() - pttWarmStartRef.current;
            setPttWarmElapsed(Math.min(ms, warmDelay));
          }, 50);

          // After delay, actually start recording
          pttTimerRef.current = setTimeout(() => {
            pttTimerRef.current = null;
            setPttWarming(false);
            setPttWarmElapsed(0);
            setPttWarmDelay(0);
            if (pttWarmIntervalRef.current) {
              clearInterval(pttWarmIntervalRef.current);
              pttWarmIntervalRef.current = null;
            }
            if (pttActiveRef.current) {
              doStart();
            }
          }, warmDelay);
        }
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      const s = settingsRef.current;
      if (!s?.enabled || !s.pushToTalkKey) return;

      if (pttActiveRef.current && matchesPTTKey(event, s.pushToTalkKey)) {
        event.preventDefault();
        handlePTTStop();
      }
    };

    // If user Alt-tabs or switches away while PTT key is held, stop recording
    const handleWindowBlur = () => {
      if (pttActiveRef.current) {
        handlePTTStop();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("blur", handleWindowBlur);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("blur", handleWindowBlur);
    };
  }, [handleToggleStop, handlePTTStop, captureActiveElement, doStart, curStatus]);

  if (!settings?.enabled) return null;

  // Derive combined status for the indicator (routes to the active mode).
  let indicatorStatus: IndicatorStatus;
  if (isStreaming) {
    indicatorStatus =
      streaming.status === "finishing" ? "processing"
      : streaming.status === "recording" ? "recording"
      : streaming.status === "error" ? "error"
      : "idle";
  } else {
    indicatorStatus = recorder.status;
    if (transcribing) indicatorStatus = "processing";
  }
  if (pttWarming) indicatorStatus = "warming";
  if (errorMessage && indicatorStatus !== "processing") indicatorStatus = "error";

  // Prefer the recorder's own error (mic permission denied, codec missing,
  // etc.) over our generic message — Tauri webviews on macOS commonly fail
  // here when microphone permission hasn't been granted, and the user needs
  // to see the actual reason to fix it.
  const indicatorErrorMessage =
    errorMessage ?? (isStreaming ? streaming.error : recorder.error);
  const indicatorElapsed = isStreaming ? streaming.elapsed : recorder.elapsed;
  const indicatorFrequency = isStreaming ? streaming.frequencyData : recorder.frequencyData;

  return (
    <RecordingIndicator
      status={indicatorStatus}
      elapsed={indicatorElapsed}
      maxDuration={settings.maxDuration}
      frequencyData={indicatorFrequency}
      warmingProgress={pttWarmDelay > 0 ? pttWarmElapsed / pttWarmDelay : 0}
      errorMessage={indicatorErrorMessage}
      onStop={handleToggleStop}
      onCancel={() => {
        cancelPTTWarming();
        cancelRecording();
      }}
      finalizedSentences={isStreaming ? streaming.finalizedSentences : undefined}
      currentText={isStreaming ? streaming.currentText : undefined}
    />
  );
}
