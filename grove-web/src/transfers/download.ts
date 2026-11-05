import { apiClient } from "../api/client";
import type { TauriInternals } from "../utils/tauri";
import { isAbort, startTransfer, type TransferHandle } from "./store";

interface Sink {
  write(chunk: Uint8Array): Promise<void>;
  /** Returns the saved path, when the platform tells us one. */
  commit(): Promise<string | undefined>;
  abort(): Promise<void>;
}

function tauriSink(tauri: TauriInternals, target: { id: string; path: string }): Sink {
  return {
    write: async (chunk) => {
      await tauri.invoke("save_stream_chunk", chunk, { headers: { "x-grove-save-id": target.id } });
    },
    commit: async () => {
      await tauri.invoke("save_stream_end", { id: target.id, commit: true });
      return target.path;
    },
    abort: async () => {
      await tauri.invoke("save_stream_end", { id: target.id, commit: false });
    },
  };
}

function browserSink(name: string): Sink {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  return {
    write: async (chunk) => {
      chunks.push(new Uint8Array(chunk));
    },
    commit: async () => {
      const url = URL.createObjectURL(new Blob(chunks));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = name;
      anchor.style.display = "none";
      document.body.appendChild(anchor);
      anchor.click();
      // The click has snapshotted the URL; give slower webviews a moment.
      setTimeout(() => {
        anchor.remove();
        URL.revokeObjectURL(url);
      }, 2000);
      return undefined;
    },
    abort: async () => {},
  };
}

async function pump(url: string, sink: Sink, transfer: TransferHandle) {
  const response = await apiClient.getResponse(url, transfer.signal);
  const length = Number(response.headers.get("Content-Length"));
  const total = Number.isFinite(length) && length > 0 ? length : null;
  transfer.progress(0, total);
  if (!response.body) {
    await sink.write(new Uint8Array(await response.arrayBuffer()));
    return;
  }
  const reader = response.body.getReader();
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    await sink.write(value);
    loaded += value.byteLength;
    transfer.progress(loaded);
  }
}

/** Download `url`, tracked in the transfer list. The save dialog comes first,
 *  so progress describes a file the user already placed. */
export async function trackedDownload(url: string, name: string, tauri: TauriInternals | null): Promise<void> {
  let sink: Sink;
  if (tauri) {
    const target = await tauri.invoke("save_stream_begin", { suggestedName: name }) as { id: string; path: string } | null;
    if (!target) return;
    sink = tauriSink(tauri, target);
  } else {
    sink = browserSink(name);
  }
  const transfer = startTransfer("download", name);
  try {
    await pump(url, sink, transfer);
    transfer.finish(await sink.commit());
  } catch (error) {
    await sink.abort().catch((cause) => console.error("[download] Could not discard partial file:", cause));
    if (isAbort(error)) {
      transfer.cancelled();
    } else {
      const message = (error as { message?: string })?.message;
      transfer.fail(message || "Download failed");
    }
  }
}

export async function openSavedFile(tauri: TauriInternals, path: string) {
  await tauri.invoke("open_saved_file", { path });
}

export async function revealSavedFile(tauri: TauriInternals, path: string) {
  await tauri.invoke("reveal_saved_file", { path });
}
