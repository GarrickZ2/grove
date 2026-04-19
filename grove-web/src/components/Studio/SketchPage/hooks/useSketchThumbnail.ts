import { useEffect, useRef } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { uploadSketchThumbnail } from "../../../../api";

const DEBOUNCE_MS = 2000;
/** Maximum dimension for the uploaded PNG. Larger than the default 1024 for
 * better vision-model legibility; below Claude's 1568 auto-scale threshold to
 * avoid wasting tokens on pixels that get downscaled anyway. */
const MAX_PX = 1536;

interface Params {
  projectId: string;
  taskId: string;
  sketchId: string | null;
  /** The current scene object — we only use its identity as a change signal,
   * not its contents. Any change (user edit or agent-driven polling update)
   * schedules a fresh 2s debounce. */
  scene: unknown | null;
  /** Set by SketchCanvas once Excalidraw is mounted. */
  excalidrawApi: ExcalidrawImperativeAPI | null;
}

/**
 * Debounced background upload of a PNG thumbnail rendered from the live
 * Excalidraw instance. Triggered 2 seconds after the latest scene change;
 * cancels any previous pending upload.
 *
 * Staleness is handled server-side by comparing the PNG's file mtime to the
 * scene's file mtime at MCP-read time: a thumb rendered from an earlier scene
 * state is simply not shown to the agent, no client-side coordination needed.
 *
 * Fire-and-forget: failures are logged but do not affect user experience.
 */
/** Content fingerprint for skip-unchanged. Mirrors useSketchSync's hash:
 * just the elements array, not appState (which carries transient zoom/pan). */
function sceneFingerprint(scene: unknown): string {
  const elements = (scene as { elements?: unknown } | null)?.elements;
  try {
    return JSON.stringify(elements ?? null);
  } catch {
    return "";
  }
}

export function useSketchThumbnail({
  projectId,
  taskId,
  sketchId,
  scene,
  excalidrawApi,
}: Params): void {
  const timerRef = useRef<number | null>(null);
  // Track the last scene fingerprint we actually uploaded for. Every sketch
  // load / WS update / poll flips `scene` identity even when the bytes match
  // what's already on disk — without this gate we'd upload an identical PNG
  // on every remount, wasting bandwidth and advancing thumb.mtime pointlessly.
  const uploadedFingerprintRef = useRef<{ sketchId: string; fp: string } | null>(null);

  useEffect(() => {
    if (!sketchId || !excalidrawApi || !scene) return;

    const fp = sceneFingerprint(scene);
    // When switching sketches, force at least one upload so the ref starts
    // tracking THIS sketch's state — `uploadedFingerprintRef` from a
    // previous sketch shouldn't suppress it.
    if (
      uploadedFingerprintRef.current &&
      uploadedFingerprintRef.current.sketchId === sketchId &&
      uploadedFingerprintRef.current.fp === fp
    ) {
      return;
    }

    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
    const timerId = window.setTimeout(async () => {
      timerRef.current = null;
      try {
        const { exportToBlob } = await import("@excalidraw/excalidraw");
        const blob = await exportToBlob({
          elements: excalidrawApi.getSceneElements(),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          appState: excalidrawApi.getAppState() as any,
          files: excalidrawApi.getFiles(),
          mimeType: "image/png",
          exportPadding: 16,
          maxWidthOrHeight: MAX_PX,
        });
        await uploadSketchThumbnail(projectId, taskId, sketchId, blob);
        uploadedFingerprintRef.current = { sketchId, fp };
      } catch (e) {
        console.warn("sketch thumbnail upload failed", e);
      }
    }, DEBOUNCE_MS);
    timerRef.current = timerId;

    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [projectId, taskId, sketchId, scene, excalidrawApi]);
}
