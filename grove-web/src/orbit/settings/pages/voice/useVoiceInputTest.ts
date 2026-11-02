import { useCallback, useEffect, useRef, useState } from "react";
import { transcribeAudio } from "../../../../api";
import { formatTranscribeError } from "../../../../components/AI/utils";
import type { TranscribeMode } from "../../../../components/AI/types";
import { useAudioRecorder } from "../../../../hooks/useAudioRecorder";
import { useStreamingTranscription } from "../../../../hooks/useStreamingTranscription";

export type VoiceTestPhase = "idle" | "listening" | "processing" | "done";

export interface VoiceTestResult {
  raw: string;
  /** Present only when revision ran and changed the text. */
  revised: string | null;
}

interface VoiceInputTestOptions {
  projectId: string | null;
  mode: TranscribeMode;
  minDuration: number;
  maxDuration: number;
}

/** Bar heights (px) for the waveform from analyser bins (0–255); flat when there's no signal. */
export function waveformHeights(data: Uint8Array | null, count: number, min = 4, max = 34): number[] {
  return Array.from({ length: count }, (_, index) => {
    const value = data && data.length ? data[Math.floor((index / count) * data.length)] ?? 0 : 0;
    return Math.round(min + (value / 255) * (max - min));
  });
}

/** Only keep a revision that actually differs from what was heard. */
export function toTestResult(raw: string, revised: string | null | undefined): VoiceTestResult {
  const cleaned = revised?.trim();
  return { raw, revised: cleaned && cleaned !== raw.trim() ? cleaned : null };
}

/**
 * Hold-to-talk test of the real voice input pipeline: records with the same
 * recorder hooks as GlobalAudioRecorder and transcribes with the saved
 * provider settings, but shows the result here instead of inserting it.
 */
export function useVoiceInputTest({ projectId, mode, minDuration, maxDuration }: VoiceInputTestOptions) {
  const [phase, setPhase] = useState<VoiceTestPhase>("idle");
  const [result, setResult] = useState<VoiceTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const streamingMode = mode === "streaming";

  const transcribe = useCallback(async (blob: Blob) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase("processing");
    try {
      const response = await transcribeAudio(blob, projectId ?? undefined, controller.signal);
      if (controller.signal.aborted) return;
      setResult(toTestResult(response.raw, response.revised));
      setPhase("done");
    } catch (reason) {
      if (controller.signal.aborted) return;
      setError(formatTranscribeError(reason));
      setPhase("idle");
    }
  }, [projectId]);

  const finishStreaming = useCallback((streamed: { full: string; revised?: string } | null) => {
    if (streamed?.full.trim()) {
      setResult(toTestResult(streamed.full, streamed.revised));
      setPhase("done");
    } else {
      setNotice("Nothing was heard. Try speaking a little louder.");
      setPhase("idle");
    }
  }, []);

  const recorder = useAudioRecorder({ minDuration, maxDuration, onMaxReached: (blob) => void transcribe(blob) });
  const streaming = useStreamingTranscription({
    projectId: projectId ?? undefined,
    maxDuration,
    onMaxReached: finishStreaming,
  });

  useEffect(() => () => abortRef.current?.abort(), []);

  const active = streamingMode ? streaming : recorder;
  // Mic permission / socket failures surface from the recorder hooks themselves.
  const recorderError = active.status === "error" ? active.error ?? "The microphone could not be started." : null;
  const currentPhase: VoiceTestPhase = recorderError ? "idle" : phase;

  const start = useCallback(() => {
    if (currentPhase === "listening" || currentPhase === "processing") return;
    setResult(null);
    setError(null);
    setNotice(null);
    setPhase("listening");
    void (streamingMode ? streaming.start() : recorder.start());
  }, [currentPhase, recorder, streaming, streamingMode]);

  const stop = useCallback(async () => {
    if (currentPhase !== "listening") return;
    if (streamingMode) {
      setPhase("processing");
      finishStreaming(await streaming.stop());
      return;
    }
    const blob = await recorder.stop();
    if (blob) {
      await transcribe(blob);
    } else {
      setNotice(`Too short. Hold for at least ${minDuration} sec.`);
      setPhase("idle");
    }
  }, [currentPhase, finishStreaming, minDuration, recorder, streaming, streamingMode, transcribe]);

  const listening = currentPhase === "listening";
  const liveText = streamingMode ? [...streaming.finalizedSentences, streaming.currentText].filter(Boolean).join(" ") : "";

  return {
    phase: currentPhase,
    result,
    error: recorderError ?? error,
    notice,
    liveText,
    frequencyData: listening ? active.frequencyData : null,
    start,
    stop,
  };
}
