/**
 * useStreamingTranscription — AudioWorklet + WebSocket streaming STT hook.
 *
 * Captures microphone PCM via an AudioWorklet (16 kHz mono f32), streams it to
 * the backend over WebSocket, and surfaces a live transcript that updates as
 * the user speaks:
 *   - `finalizedSentences` — stable, frozen sentences (never rewritten).
 *   - `currentText` — the sentence being spoken; replaced wholesale on each
 *     backend update, so earlier mis-recognized words get corrected live.
 *
 * On `stop()` the backend assembles the full text (and an optional revision)
 * and returns it. Mirrors `useAudioRecorder`'s shape so callers can switch
 * between batch and streaming modes with minimal branching.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { appendHmacToUrl } from '../api/client';
import { transcribeStreamWsUrl, type StreamServerMsg, type StreamTuning } from '../api/ai';

/**
 * Hot-tunable streaming parameters. Tweak to trade off latency / cost WITHOUT
 * recompiling the backend — sent as query params, override the server defaults.
 *
 *   minChunkMs           ↑ fewer Whisper calls (cheaper, fewer 429s), slower
 *                        live refresh. default 1000
 *   intraSentenceRefresh false = transcribe only per-sentence → the fewest
 *                        calls (one per sentence), no intra-sentence live
 *                        replace. default true
 *   silenceRms           ↑ treats more as silence (splits earlier). default 0.01
 *   silenceHoldMs        ↓ splits on shorter pauses (choppier). default 700
 *   maxBufferMs          safety cap for non-stop speech. default 30000
 */
export const STREAMING_TUNING: StreamTuning = {
  // Lowered from the backend default (1000) to cut Whisper calls ~1/3 and ease
  // rate limits, while keeping live updates responsive. Raise further (2000–3000)
  // or set intraSentenceRefresh:false if you still hit 429s.
  minChunkMs: 1500,
  // intraSentenceRefresh: false,  // fewest API calls (one per sentence)
};

export type StreamStatus = 'idle' | 'recording' | 'finishing' | 'error';

export interface StreamingResult {
  full: string;
  revised?: string;
}

export interface StreamingTranscriptionResult {
  status: StreamStatus;
  elapsed: number;
  finalizedSentences: string[];
  currentText: string;
  frequencyData: Uint8Array | null;
  error: string | null;
  start: () => Promise<void>;
  stop: () => Promise<StreamingResult | null>;
  cancel: () => void;
}

interface Options {
  projectId?: string;
  /** Max seconds before the stream auto-finishes. 0 = no limit. */
  maxDuration?: number;
  onMaxReached?: (result: StreamingResult | null) => void;
  /** Algorithm tuning override; defaults to `STREAMING_TUNING`. */
  tuning?: StreamTuning;
}

export function useStreamingTranscription(options: Options = {}): StreamingTranscriptionResult {
  const { projectId, maxDuration = 0, onMaxReached, tuning = STREAMING_TUNING } = options;

  const [status, setStatus] = useState<StreamStatus>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [finalizedSentences, setFinalizedSentences] = useState<string[]>([]);
  const [currentText, setCurrentText] = useState('');
  const [frequencyData, setFrequencyData] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const nodeRef = useRef<AudioWorkletNode | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const rafRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef(0);
  // Guards re-entrant start() (rapid double-trigger) from spinning up a second
  // AudioContext before the previous one finishes closing.
  const startingRef = useRef(false);

  // Latest assembled transcript snapshot (used as a fallback if `Done` never arrives).
  const finalizedRef = useRef<string[]>([]);
  const currentRef = useRef('');
  // Resolver for the pending stop() promise — fulfilled by the `Done` message.
  const doneResolveRef = useRef<((r: StreamingResult | null) => void) | null>(null);
  const doneTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True once a `done` was received — used to suppress the spurious onerror
  // that fires during the WS close handshake.
  const doneReceivedRef = useRef(false);

  const onMaxReachedRef = useRef(onMaxReached);
  useEffect(() => { onMaxReachedRef.current = onMaxReached; }, [onMaxReached]);

  const cleanupMedia = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (timerRef.current) clearInterval(timerRef.current);
    nodeRef.current?.disconnect();
    nodeRef.current = null;
    analyserRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
  }, []);

  const closeWs = useCallback(() => {
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      try { ws.close(); } catch { /* ignore */ }
    }
  }, []);

  const fullCleanup = useCallback(() => {
    cleanupMedia();
    closeWs();
    if (doneTimeoutRef.current) clearTimeout(doneTimeoutRef.current);
    doneTimeoutRef.current = null;
    setFrequencyData(null);
  }, [cleanupMedia, closeWs]);

  useEffect(() => {
    return () => { fullCleanup(); };
  }, [fullCleanup]);

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

  const resolveDone = useCallback((result: StreamingResult | null) => {
    if (doneTimeoutRef.current) { clearTimeout(doneTimeoutRef.current); doneTimeoutRef.current = null; }
    const resolve = doneResolveRef.current;
    doneResolveRef.current = null;
    fullCleanup();
    setStatus('idle');
    setElapsed(0);
    resolve?.(result);
  }, [fullCleanup]);

  const handleServerMsg = useCallback((msg: StreamServerMsg) => {
    switch (msg.type) {
      case 'ready':
        break;
      case 'update':
        finalizedRef.current = msg.finalized;
        currentRef.current = msg.current;
        setFinalizedSentences(msg.finalized);
        setCurrentText(msg.current);
        break;
      case 'done':
        doneReceivedRef.current = true;
        resolveDone({ full: msg.full, revised: msg.revised });
        break;
      case 'error':
        setError(msg.message);
        setStatus('error');
        // If a stop() was pending, fulfill it so the caller isn't stuck.
        if (doneResolveRef.current) resolveDone(null);
        else fullCleanup();
        break;
    }
  }, [resolveDone, fullCleanup]);

  const start = useCallback(async () => {
    if (startingRef.current) return;
    startingRef.current = true;
    fullCleanup();
    setError(null);
    setFinalizedSentences([]);
    setCurrentText('');
    finalizedRef.current = [];
    currentRef.current = '';
    doneReceivedRef.current = false;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Microphone access denied';
      setError(msg);
      setStatus('error');
      startingRef.current = false;
      return;
    }
    streamRef.current = stream;

    try {
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      await ctx.audioWorklet.addModule('/pcm-worklet.js');

      const source = ctx.createMediaStreamSource(stream);

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 128;
      analyser.smoothingTimeConstant = 0.7;
      source.connect(analyser);
      analyserRef.current = analyser;

      const node = new AudioWorkletNode(ctx, 'pcm-worklet', {
        processorOptions: { targetRate: 16000, frameSamples: 1600 },
      });
      source.connect(node);
      // Keep the node "pulled" without audible playback.
      const sink = ctx.createGain();
      sink.gain.value = 0;
      node.connect(sink);
      sink.connect(ctx.destination);
      nodeRef.current = node;

      // Open the WebSocket and wire PCM frames to it.
      const url = await appendHmacToUrl(transcribeStreamWsUrl(projectId, tuning));
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      node.port.onmessage = (e: MessageEvent<Float32Array>) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(e.data.buffer);
        }
      };

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data as string) as StreamServerMsg;
          handleServerMsg(msg);
        } catch { /* ignore malformed */ }
      };
      ws.onerror = () => {
        // The browser fires `error` during the WS close handshake (even on a
        // clean close). Ignore it once we've received `done`.
        if (doneReceivedRef.current) return;
        setError('Connection error');
        setStatus('error');
        // Resolve a pending stop; otherwise tear down so the mic isn't left on.
        if (doneResolveRef.current) resolveDone(null);
        else fullCleanup();
      };
      ws.onclose = () => {
        // If the socket dies mid-recording with a pending stop, don't hang.
        if (doneResolveRef.current) {
          const full = [...finalizedRef.current, currentRef.current]
            .filter(Boolean).join(' ').trim();
          resolveDone(full ? { full } : null);
          return;
        }
        // A clean server-side close (code 1000) mid-recording does NOT fire
        // `onerror`, so without this the UI would sit in `recording` forever
        // while `onmessage` silently drops audio. `closeWs()` nulls `wsRef`
        // before closing, so `wsRef.current === ws` means WE didn't initiate
        // this close — the session died on us. Surface it and tear down.
        if (wsRef.current === ws && !doneReceivedRef.current) {
          setError('Connection closed');
          setStatus('error');
          fullCleanup();
        }
      };
    } catch (err) {
      fullCleanup();
      const msg = err instanceof Error ? err.message : 'Audio setup failed';
      setError(msg);
      setStatus('error');
      startingRef.current = false;
      return;
    }

    startTimeRef.current = Date.now();
    setElapsed(0);
    setStatus('recording');
    timerRef.current = setInterval(() => {
      const secs = Math.floor((Date.now() - startTimeRef.current) / 1000);
      setElapsed(secs);
      if (maxDuration > 0 && secs >= maxDuration && wsRef.current?.readyState === WebSocket.OPEN) {
        // Auto-finish: flush and report via callback.
        if (timerRef.current) clearInterval(timerRef.current);
        setStatus('finishing');
        doneResolveRef.current = (r) => onMaxReachedRef.current?.(r);
        doneTimeoutRef.current = setTimeout(() => resolveDone(null), 10000);
        wsRef.current.send(JSON.stringify({ type: 'flush' }));
      }
    }, 200);

    startFrequencyUpdates();
    startingRef.current = false;
  }, [projectId, maxDuration, tuning, fullCleanup, startFrequencyUpdates, handleServerMsg, resolveDone]);

  const stop = useCallback(async (): Promise<StreamingResult | null> => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      // Nothing live — return whatever we have.
      const full = [...finalizedRef.current, currentRef.current]
        .filter(Boolean).join(' ').trim();
      fullCleanup();
      setStatus('idle');
      setElapsed(0);
      return full ? { full } : null;
    }
    setStatus('finishing');
    if (timerRef.current) clearInterval(timerRef.current);
    return new Promise<StreamingResult | null>((resolve) => {
      doneResolveRef.current = resolve;
      // Fallback so a missing `Done` can't hang the caller forever.
      doneTimeoutRef.current = setTimeout(() => {
        const full = [...finalizedRef.current, currentRef.current]
          .filter(Boolean).join(' ').trim();
        resolveDone(full ? { full } : null);
      }, 10000);
      ws.send(JSON.stringify({ type: 'flush' }));
    });
  }, [fullCleanup, resolveDone]);

  const cancel = useCallback(() => {
    doneResolveRef.current = null;
    fullCleanup();
    setStatus('idle');
    setElapsed(0);
    setFinalizedSentences([]);
    setCurrentText('');
    setError(null);
    finalizedRef.current = [];
    currentRef.current = '';
  }, [fullCleanup]);

  return {
    status,
    elapsed,
    finalizedSentences,
    currentText,
    frequencyData,
    error,
    start,
    stop,
    cancel,
  };
}
