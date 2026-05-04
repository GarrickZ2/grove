/**
 * GlobalAudioRecorder — mounts at App level to provide global shortcut-triggered
 * audio recording. Renders the RecordingIndicator overlay.
 *
 * Supports two modes:
 * - Toggle: combo key (e.g. Cmd+Shift+H) toggles recording on/off
 * - Push-to-talk: hold key for 2s to activate, release to stop
 *
 * On completion the audio blob is available for transcription (TODO).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useAudioRecorder } from "../../hooks/useAudioRecorder";
import { getAudioSettings, transcribeAudio } from "../../api";
import { matchesShortcut, matchesPTTKey } from "./utils";
import { RecordingIndicator } from "./RecordingIndicator";
import type { AudioSettings } from "./types";

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

/** How long the PTT key must be held before recording starts (ms) */
const PTT_ACTIVATION_DELAY_MS = 300;

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
  const pttTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pttWarming, setPttWarming] = useState(false);
  const [pttWarmElapsed, setPttWarmElapsed] = useState(0);
  const pttWarmIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pttWarmStartRef = useRef(0);

  const recorder = useAudioRecorder({
    minDuration: settings?.minDuration ?? 2,
    maxDuration: settings?.maxDuration ?? 60,
    onMaxReached: (blob) => handleRecordingComplete(blob),
  });

  const recorderRef = useRef(recorder);
  recorderRef.current = recorder;

  // Load audio settings (on mount, projectId change, or after settings saved)
  const fetchSettings = useCallback(() => {
    getAudioSettings(projectId ?? undefined)
      .then((s) => {
        setSettings(s);
        settingsRef.current = s;
      })
      .catch(() => {});
  }, [projectId]);

  useEffect(() => { fetchSettings(); }, [fetchSettings]);

  useEffect(() => {
    const handler = () => fetchSettings();
    window.addEventListener("grove:audio-settings-changed", handler);
    return () => window.removeEventListener("grove:audio-settings-changed", handler);
  }, [fetchSettings]);

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

  // Auto-clear error after 4 seconds. Tracks BOTH our transcribe-side error
  // and the recorder's own error (mic permission etc.) — otherwise a denied
  // mic shows the pill forever because the recorder stays in "error" state
  // until the next start() call.
  const recorderErrorActive = recorder.status === "error" || !!recorder.error;
  useEffect(() => {
    if (!errorMessage && !recorderErrorActive) return;
    const t = setTimeout(() => {
      setErrorMessage(null);
      if (recorderErrorActive) recorder.cancel();
    }, 4000);
    return () => clearTimeout(t);
  }, [errorMessage, recorderErrorActive, recorder]);

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
    try {
      const result = await transcribeAudio(blob, projectId ?? undefined, controller.signal);
      if (controller.signal.aborted) return;

      const text = result.final;

      // 1. Copy to clipboard as fallback
      try { await navigator.clipboard.writeText(text); } catch { /* ignore */ }

      // 2. Insert into previously active element
      const el = activeElementRef.current;
      if (el && (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement)) {
        insertTextIntoInput(el, text);
      } else if (el && (el as HTMLElement).isContentEditable) {
        insertTextIntoContentEditable(el as HTMLElement, text);
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        // Surface as much detail as the backend gave us. Generic
        // "Transcription failed" hides whether the cause was a missing
        // provider config (400), upstream API outage (502), oversized
        // payload (413), or anything else — and that distinction is
        // exactly what the user needs to fix their setup.
        const msg = formatTranscribeError(err);
        console.error("[audio] transcribe failed:", err);
        setErrorMessage(msg);
      }
    } finally {
      // Clear transcribing even on abort so the indicator can transition
      // out of "processing" — otherwise a cancel would leave the spinner
      // stuck and block the next recording's status calculation.
      setTranscribing(false);
    }
  }, [projectId]);

  // Toggle mode: stop and process
  const handleToggleStop = useCallback(async () => {
    const blob = await recorderRef.current.stop();
    if (blob) {
      handleRecordingComplete(blob);
    }
  }, [handleRecordingComplete]);

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
    setPttWarming(false);
    setPttWarmElapsed(0);
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
    setPttWarming(false);
    setPttWarmElapsed(0);
    if (pttWarmIntervalRef.current) {
      clearInterval(pttWarmIntervalRef.current);
      pttWarmIntervalRef.current = null;
    }

    const blob = await recorderRef.current.stop();
    if (blob) {
      handleRecordingComplete(blob);
    }
  }, [handleRecordingComplete, cancelPTTWarming]);

  // Global keyboard listeners
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const s = settingsRef.current;
      if (!s?.enabled) return;

      const status = recorderRef.current.status;

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
          recorderRef.current.start();
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
          setPttWarming(true);
          setPttWarmElapsed(0);
          pttWarmStartRef.current = Date.now();

          // Tick counter for warming progress
          pttWarmIntervalRef.current = setInterval(() => {
            const ms = Date.now() - pttWarmStartRef.current;
            setPttWarmElapsed(Math.min(ms, PTT_ACTIVATION_DELAY_MS));
          }, 50);

          // After delay, actually start recording
          pttTimerRef.current = setTimeout(() => {
            pttTimerRef.current = null;
            setPttWarming(false);
            setPttWarmElapsed(0);
            if (pttWarmIntervalRef.current) {
              clearInterval(pttWarmIntervalRef.current);
              pttWarmIntervalRef.current = null;
            }
            if (pttActiveRef.current) {
              recorderRef.current.start();
            }
          }, PTT_ACTIVATION_DELAY_MS);
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
  }, [handleToggleStop, handlePTTStop, captureActiveElement]);

  if (!settings?.enabled) return null;

  // Derive combined status for the indicator
  let indicatorStatus: IndicatorStatus = recorder.status;
  if (pttWarming) indicatorStatus = "warming";
  if (transcribing) indicatorStatus = "processing";
  if (errorMessage && !transcribing) indicatorStatus = "error";

  // Prefer the recorder's own error (mic permission denied, codec missing,
  // etc.) over our generic message — Tauri webviews on macOS commonly fail
  // here when microphone permission hasn't been granted, and the user needs
  // to see the actual reason to fix it.
  const indicatorErrorMessage = errorMessage ?? recorder.error;

  return (
    <RecordingIndicator
      status={indicatorStatus}
      elapsed={recorder.elapsed}
      maxDuration={settings.maxDuration}
      frequencyData={recorder.frequencyData}
      warmingProgress={pttWarmElapsed / PTT_ACTIVATION_DELAY_MS}
      errorMessage={indicatorErrorMessage}
      onStop={handleToggleStop}
      onCancel={() => {
        cancelPTTWarming();
        recorder.cancel();
        abortRef.current?.abort();
        setTranscribing(false);
        setErrorMessage(null);
      }}
    />
  );
}
