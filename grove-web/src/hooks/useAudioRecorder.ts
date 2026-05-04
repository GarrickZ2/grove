/**
 * useAudioRecorder — MediaRecorder + Web Audio analyser hook
 *
 * Manages microphone recording lifecycle with real-time frequency data
 * for waveform visualisation. Supports toggle and push-to-talk modes.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type RecorderStatus = "idle" | "recording" | "error";

export interface AudioRecorderResult {
  status: RecorderStatus;
  elapsed: number;
  frequencyData: Uint8Array | null;
  error: string | null;
  start: () => Promise<void>;
  stop: () => Promise<Blob | null>;
  cancel: () => void;
}

interface AudioRecorderOptions {
  minDuration?: number;
  maxDuration?: number;
  onMaxReached?: (blob: Blob) => void;
}

export function useAudioRecorder(options: AudioRecorderOptions = {}): AudioRecorderResult {
  const { minDuration = 2, maxDuration = 60, onMaxReached } = options;

  const [status, setStatus] = useState<RecorderStatus>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [frequencyData, setFrequencyData] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startTimeRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval>>(0 as unknown as ReturnType<typeof setInterval>);
  const rafRef = useRef(0);
  const cancelledRef = useRef(false);
  const onMaxReachedRef = useRef(onMaxReached);
  useEffect(() => { onMaxReachedRef.current = onMaxReached; }, [onMaxReached]);

  // Unified resolve ref — only one consumer gets the blob
  const stopResolveRef = useRef<((blob: Blob | null) => void) | null>(null);
  const stoppedRef = useRef(false);

  const cleanupMedia = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    analyserRef.current = null;
  }, []);

  const cleanup = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (timerRef.current) clearInterval(timerRef.current);
    cancelledRef.current = true;
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    cleanupMedia();
    mediaRecorderRef.current = null;
    chunksRef.current = [];
    stopResolveRef.current = null;
    stoppedRef.current = false;
  }, [cleanupMedia]);

  useEffect(() => {
    return () => { cleanup(); };
  }, [cleanup]);

  const startFrequencyUpdates = useCallback(() => {
    const tick = () => {
      if (!analyserRef.current) return;
      const data = new Uint8Array(analyserRef.current.frequencyBinCount);
      analyserRef.current.getByteFrequencyData(data);
      setFrequencyData(data.slice(0, 32));
      rafRef.current = requestAnimationFrame(tick);
    };
    tick();
  }, []);

  const start = useCallback(async () => {
    // Clean up any previous recording session before starting a new one.
    // This prevents race conditions where the old recorder's onstop callback
    // fires after the new session is created and destroys the new stream/AudioContext.
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.onstop = null; // detach old handler
      mediaRecorderRef.current.stop();
    }
    cleanupMedia();
    mediaRecorderRef.current = null;
    chunksRef.current = [];
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (timerRef.current) clearInterval(timerRef.current);

    setError(null);
    cancelledRef.current = false;
    stoppedRef.current = false;
    stopResolveRef.current = null;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      cleanup();
      const msg = err instanceof Error ? err.message : "Microphone access denied";
      setError(msg);
      setStatus("error");
      return;
    }
    streamRef.current = stream;

    // Wrap the rest of the setup in one try/catch so a failure in
    // createMediaStreamSource / analyser config / new MediaRecorder /
    // recorder.start doesn't leak the stream + audioCtx (and silently
    // skip setStatus("error")). Whole pipeline lives or dies together.
    let recorder: MediaRecorder;
    const supportsOpus = MediaRecorder.isTypeSupported("audio/webm;codecs=opus");
    const mimeType = supportsOpus ? "audio/webm;codecs=opus" : "audio/webm";
    try {
      const audioCtx = new AudioContext();
      audioCtxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 128;
      analyser.smoothingTimeConstant = 0.7;
      source.connect(analyser);
      analyserRef.current = analyser;
      recorder = new MediaRecorder(stream, { mimeType });
    } catch (err) {
      cleanup();
      const msg = err instanceof Error ? err.message : "Audio setup failed";
      setError(msg);
      setStatus("error");
      return;
    }
    mediaRecorderRef.current = recorder;
    chunksRef.current = [];

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };

    // Unified onstop — handles both manual stop() and auto-stop
    recorder.onstop = () => {
      if (stoppedRef.current) return; // guard against double-fire
      stoppedRef.current = true;

      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (timerRef.current) clearInterval(timerRef.current);
      setFrequencyData(null);

      if (cancelledRef.current) {
        cleanupMedia();
        setStatus("idle");
        setElapsed(0);
        stopResolveRef.current?.(null);
        stopResolveRef.current = null;
        return;
      }

      const blob = new Blob(chunksRef.current, { type: mimeType });
      cleanupMedia();
      setStatus("idle");
      setElapsed(0);

      if (stopResolveRef.current) {
        // Manual stop() — resolve the promise
        stopResolveRef.current(blob);
        stopResolveRef.current = null;
      } else {
        // Auto-stop (max duration) — fire callback
        onMaxReachedRef.current?.(blob);
      }
    };

    try {
      recorder.start(250);
    } catch (err) {
      cleanup();
      const msg = err instanceof Error ? err.message : "Recorder failed to start";
      setError(msg);
      setStatus("error");
      return;
    }
    startTimeRef.current = Date.now();
    setElapsed(0);
    setStatus("recording");

    timerRef.current = setInterval(() => {
      const secs = Math.floor((Date.now() - startTimeRef.current) / 1000);
      setElapsed(secs);
      if (secs >= maxDuration) {
        const rec = mediaRecorderRef.current;
        if (rec && rec.state === "recording") {
          rec.stop();
        }
      }
    }, 200);

    startFrequencyUpdates();
  }, [maxDuration, cleanup, cleanupMedia, startFrequencyUpdates]);

  const stop = useCallback(async (): Promise<Blob | null> => {
    if (!mediaRecorderRef.current || mediaRecorderRef.current.state === "inactive") {
      return null;
    }

    const elapsedSecs = (Date.now() - startTimeRef.current) / 1000;

    // Below min duration — discard
    if (elapsedSecs < minDuration) {
      cancelledRef.current = true;
      mediaRecorderRef.current.stop();
      return null;
    }

    return new Promise<Blob | null>((resolve) => {
      stopResolveRef.current = resolve;
      mediaRecorderRef.current!.stop();
    });
  }, [minDuration]);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    } else {
      cleanup();
      setStatus("idle");
      setElapsed(0);
      setFrequencyData(null);
      setError(null);
    }
  }, [cleanup]);

  return { status, elapsed, frequencyData, error, start, stop, cancel };
}
