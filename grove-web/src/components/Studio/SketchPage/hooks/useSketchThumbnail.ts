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
  "use no memo";
  // Uses dynamic `import()` for the Excalidraw export-to-svg module —
  // Compiler 1.0 can't lower it.

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

    // Shared render+upload path. Used both by the normal 2s debounce and by
    // the unmount-flush below. Captures sketchId/api/fp by argument so the
    // flush path can't race with a stale closure after deps change.
    const runUpload = async (
      api: ExcalidrawImperativeAPI,
      pid: string,
      tid: string,
      sid: string,
      fingerprint: string,
    ) => {
      try {
        const { exportToBlob } = await import("@excalidraw/excalidraw");
        const blob = await exportToBlob({
          elements: api.getSceneElements(),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          appState: api.getAppState() as any,
          files: api.getFiles(),
          mimeType: "image/png",
          exportPadding: 16,
          maxWidthOrHeight: MAX_PX,
        });
        await uploadSketchThumbnail(pid, tid, sid, blob);
        uploadedFingerprintRef.current = { sketchId: sid, fp: fingerprint };
      } catch (e) {
        console.warn("sketch thumbnail upload failed", e);
      }
    };

    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
    const timerId = window.setTimeout(() => {
      timerRef.current = null;
      void runUpload(excalidrawApi, projectId, taskId, sketchId, fp);
    }, DEBOUNCE_MS);
    timerRef.current = timerId;

    return () => {
      // Cleanup fires on sketch switch, component unmount, or any dep change
      // that lands before the timer. If a debounced upload was scheduled but
      // never fired, run it NOW against the values this effect captured so
      // the latest edits don't end up on disk without a matching thumb (which
      // would make the server's mtime freshness check reject the thumb and
      // leave agents with no preview until the user re-opens the sketch).
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
        // Fire-and-forget — useEffect cleanup can't await. The request is a
        // normal fetch, which survives React unmount fine (the browser only
        // aborts in-flight requests on full page unload, which is covered by
        // useSketchSync's beforeunload path handling the scene save itself).
        void runUpload(excalidrawApi, projectId, taskId, sketchId, fp);
      }
    };
  }, [projectId, taskId, sketchId, scene, excalidrawApi]);
}
