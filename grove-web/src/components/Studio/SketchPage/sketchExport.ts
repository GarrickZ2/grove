import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { saveBlobAsFile } from "../../ui/filePreview";

/** Save the sketch shown as a PNG named after it. */
export async function exportSketchPng(api: ExcalidrawImperativeAPI, name: string): Promise<void> {
  const { exportToBlob } = await import("@excalidraw/excalidraw");
  const blob = await exportToBlob({
    elements: api.getSceneElements(),
    appState: api.getAppState(),
    files: api.getFiles(),
    mimeType: "image/png",
  });
  await saveBlobAsFile(blob, `${name}.png`);
}
